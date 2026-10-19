// Platform settings service — subscription tiers, payout bands, trainer
// specialties. Seeds sane defaults on first read.
//
// Settings is the ONLY runtime source of FitFlex Pass tier prices and visit
// caps (owner decision 2026-10-19: no tier may be sold unless it is configured
// in Settings; fail closed). There is no fallback to built-in constants.
import { randomUUID } from 'node:crypto';
import { defaultSubscriptionTiers } from '../shared/default-subscription-tiers.mjs';

const DEFAULT_SPECIALTIES = [
  'Yoga', 'Cardio', 'Aerobics', 'Weight Loss', 'Muscle Gain', 'Dance',
  'Physiotherapy', 'Women Only', 'Weight Training', 'Boxing', 'Pilates',
  'CrossFit', 'Swimming', 'Nutrition', 'HIIT', 'Stretching', 'Zumba',
  'Kickboxing', 'Calisthenics', 'Martial Arts',
];

export function createSettingsService({ platformSettings, auditLog }) {
  function ensureDefaultSettings() {
    const existing = platformSettings.find(s => s.id === 'platform');
    if (existing) return existing;
    const defaults = {
      id: 'platform',
      // Same tiers as the start-up seed (seed-db): one default list, so the
      // first writer never decides the prices. Only used when no row exists.
      subscriptionTiers: defaultSubscriptionTiers(),
      payoutBands: [
        { key: 'band1', label: 'Band 1', minVisits: 1,  maxVisits: 2,  payoutTiming: 'daily',     commissionPct: 15 },
        { key: 'band2', label: 'Band 2', minVisits: 3,  maxVisits: 7,  payoutTiming: 'weekly',    commissionPct: 10 },
        { key: 'band3', label: 'Band 3', minVisits: 8,  maxVisits: 14, payoutTiming: 'biweekly',  commissionPct: 10 },
        { key: 'band4', label: 'Band 4', minVisits: 15, maxVisits: -1, payoutTiming: 'monthly',   commissionPct: 8  },
      ],
      paymentPeriodDays: 14,
      payoutModel: 'commission',
      currency: 'TZS',
      updatedAt: new Date().toISOString(),
    };
    // First-boot seed only: the primed cache already holds the row, so sync
    // readers are unaffected if the background write lands a moment later.
    platformSettings.insert(defaults);
    return defaults;
  }

  /**
   * A tier's visit allowance from its settings row: -1 = unlimited, a whole
   * number above zero = that many visits a cycle. Anything else (missing,
   * zero, text, fractions) is not a usable setting and gives null.
   */
  function visitCapOf(row) {
    if (row?.visits === undefined || row?.visits === null || row?.visits === '') return null;
    const v = Number(row.visits);
    if (v === -1) return Infinity;
    return Number.isInteger(v) && v > 0 ? v : null;
  }

  /** Switched off in Settings (only when the row carries such a field). */
  const switchedOff = (row) => row?.active === false || row?.enabled === false;

  function tierRow(tierKey) {
    if (!tierKey) return null;
    const settings = ensureDefaultSettings();
    return (settings.subscriptionTiers || []).find(t => t?.key === tierKey) ?? null;
  }

  function normalise(row, tierKey, visitCap) {
    const price = Number(row.monthlyPrice);
    return {
      key: tierKey,
      label: row.label ?? null,
      price: Number.isFinite(price) ? price : 0,
      visitCap,
      gymAccess: row.gymAccess,
      multiGymPerDay: tierKey !== 'basic',
    };
  }

  /**
   * The tier as configured in Settings, for using a pass already held
   * (check-in, visit counts): present, not switched off, with an explicit
   * visits value. Otherwise null — never a built-in fallback.
   */
  function getTierConfig(tierKey) {
    const row = tierRow(tierKey);
    if (!row || switchedOff(row)) return null;
    const visitCap = visitCapOf(row);
    if (visitCap === null) return null;
    return normalise(row, tierKey, visitCap);
  }

  /**
   * The tier if it may be SOLD today: configured (see getTierConfig) and with
   * a positive whole price. Otherwise null.
   */
  function sellableTier(tierKey) {
    const cfg = getTierConfig(tierKey);
    if (!cfg) return null;
    return Number.isInteger(cfg.price) && cfg.price > 0 ? cfg : null;
  }

  const isTierSellable = (tierKey) => sellableTier(tierKey) !== null;

  /** The keys of every tier that may be sold today, in Settings order. */
  function sellableTierKeys() {
    const settings = ensureDefaultSettings();
    return (settings.subscriptionTiers || []).map(t => t?.key).filter(k => k && isTierSellable(k));
  }

  function visitCapForTier(tierKey) {
    const cap = getTierConfig(tierKey)?.visitCap;
    return Number.isFinite(cap) ? cap : null;
  }

  /** The tier's price in Settings; 0 when the tier is not configured (never a built-in price). */
  function priceForTier(tierKey) {
    return Number(getTierConfig(tierKey)?.price ?? 0);
  }

  /** The member-facing catalogue: only tiers that may be sold today. */
  function publicTiers() {
    const settings = ensureDefaultSettings();
    return (settings.subscriptionTiers || []).filter(t => t?.key && isTierSellable(t.key)).map(t => ({
      key: t.key,
      label: t.label,
      monthlyPrice: t.monthlyPrice,
      visits: t.visits,
      gymAccess: t.gymAccess,
    }));
  }

  function adminGet() {
    return ensureDefaultSettings();
  }

  async function adminUpdate({ body, actorId }) {
    const current = ensureDefaultSettings();
    const before = { ...current };
    const allowed = ['subscriptionTiers', 'payoutBands', 'paymentPeriodDays', 'payoutModel', 'currency', 'trainerSpecialties'];
    const updates = {};
    for (const k of allowed) {
      if (body[k] !== undefined) updates[k] = body[k];
    }
    updates.updatedAt = new Date().toISOString();
    const updated = await platformSettings.updateAsync(s => s.id === 'platform', updates);
    await auditLog.insertAsync({
      id: randomUUID(), at: updates.updatedAt,
      actor: actorId, action: 'settings_updated',
      target: 'platform', before, after: updated
    });
    return updated;
  }

  function getSpecialtiesList() {
    const settings = ensureDefaultSettings();
    return settings.trainerSpecialties || DEFAULT_SPECIALTIES;
  }

  async function addSpecialty(name) {
    if (!name?.trim()) return { error: 'name_required', status: 400 };
    const list = getSpecialtiesList();
    const trimmed = name.trim();
    if (list.some(s => s.toLowerCase() === trimmed.toLowerCase())) return { error: 'specialty_exists', status: 409 };
    const updated = [...list, trimmed];
    await platformSettings.updateAsync(s => s.id === 'platform', { trainerSpecialties: updated, updatedAt: new Date().toISOString() });
    return { specialties: updated };
  }

  async function deleteSpecialty(name) {
    const list = getSpecialtiesList();
    const updated = list.filter(s => s.toLowerCase() !== String(name).toLowerCase());
    await platformSettings.updateAsync(s => s.id === 'platform', { trainerSpecialties: updated, updatedAt: new Date().toISOString() });
    return { specialties: updated };
  }

  return {
    ensureDefaultSettings, getTierConfig, sellableTier, isTierSellable, sellableTierKeys, visitCapForTier, priceForTier,
    publicTiers, adminGet, adminUpdate, getSpecialtiesList, addSpecialty, deleteSpecialty,
  };
}
