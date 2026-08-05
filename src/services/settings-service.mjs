// Platform settings service — subscription tiers, payout bands, trainer
// specialties. Seeds sane defaults on first read.
import { randomUUID } from 'node:crypto';
import { PASS_TIERS } from '../shared/constants.mjs';

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
      subscriptionTiers: [
        { key: 'basic',     label: 'Basic',     monthlyPrice: 60000,  visits: 8,  gymAccess: 'standard' },
        { key: 'pro',       label: 'Pro',       monthlyPrice: 120000, visits: 12, gymAccess: 'midtier' },
        { key: 'premium',   label: 'Premium',   monthlyPrice: 200000, visits: 20, gymAccess: 'premium' },
        { key: 'executive', label: 'Executive', monthlyPrice: 350000, visits: -1, gymAccess: 'luxury_executive' },
      ],
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
    platformSettings.insert(defaults);
    return defaults;
  }

  function getTierConfig(tierKey) {
    const settings = ensureDefaultSettings();
    const configured = (settings.subscriptionTiers || []).find(t => t.key === tierKey);
    if (!configured) return PASS_TIERS[tierKey] ?? null;
    const visitCap = Number(configured.visits) === -1 ? Infinity : Number(configured.visits ?? 0);
    return {
      price: Number(configured.monthlyPrice ?? 0),
      visitCap,
      gymAccess: configured.gymAccess,
      multiGymPerDay: tierKey !== 'basic',
    };
  }

  function visitCapForTier(tierKey) {
    const cap = getTierConfig(tierKey)?.visitCap;
    return Number.isFinite(cap) ? cap : null;
  }

  function priceForTier(tierKey) {
    return Number(getTierConfig(tierKey)?.price ?? PASS_TIERS[tierKey]?.price ?? 0);
  }

  function publicTiers() {
    const settings = ensureDefaultSettings();
    return (settings.subscriptionTiers || []).map(t => ({
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

  function adminUpdate({ body, actorId }) {
    const current = ensureDefaultSettings();
    const before = { ...current };
    const allowed = ['subscriptionTiers', 'payoutBands', 'paymentPeriodDays', 'payoutModel', 'currency', 'trainerSpecialties'];
    const updates = {};
    for (const k of allowed) {
      if (body[k] !== undefined) updates[k] = body[k];
    }
    updates.updatedAt = new Date().toISOString();
    const updated = platformSettings.update(s => s.id === 'platform', updates);
    auditLog.insert({
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

  function addSpecialty(name) {
    if (!name?.trim()) return { error: 'name_required', status: 400 };
    const list = getSpecialtiesList();
    const trimmed = name.trim();
    if (list.some(s => s.toLowerCase() === trimmed.toLowerCase())) return { error: 'specialty_exists', status: 409 };
    const updated = [...list, trimmed];
    platformSettings.update(s => s.id === 'platform', { trainerSpecialties: updated, updatedAt: new Date().toISOString() });
    return { specialties: updated };
  }

  function deleteSpecialty(name) {
    const list = getSpecialtiesList();
    const updated = list.filter(s => s.toLowerCase() !== String(name).toLowerCase());
    platformSettings.update(s => s.id === 'platform', { trainerSpecialties: updated, updatedAt: new Date().toISOString() });
    return { specialties: updated };
  }

  return {
    ensureDefaultSettings, getTierConfig, visitCapForTier, priceForTier,
    publicTiers, adminGet, adminUpdate, getSpecialtiesList, addSpecialty, deleteSpecialty,
  };
}
