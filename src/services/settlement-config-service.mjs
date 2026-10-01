// Settlement configuration service (settlement Phase 2, PR 2): pass tier
// versions, settlement rules and gym rate cards.
//
// Every change is a new draft; activating one gives it an EAT start date,
// closes the open-ended version it replaces, and (for a rate card) copies in
// the discounts and ceilings of the rules in force on that date (DR-23).
// Active rows are history and the database keeps them read-only. The person
// who activates a draft can't be the person who created it.
//
// Writes go straight to PostgreSQL in one transaction per call (never the
// in-memory cache). Pass { trx } to run inside a caller's transaction.
import { randomUUID } from 'node:crypto';
import { db as defaultDb } from '../infra/knex-store.mjs';
import { localDay } from '../shared/member-progress.mjs';
import { deriveRateCardRuleValues, REIMBURSEMENT_FIELDS, RULE_SCOPE } from '../shared/settlement-config.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RULE_VALUE_FIELDS = ['networkPayoutBps', ...REIMBURSEMENT_FIELDS];

// What makes two rows versions of the same thing.
const KINDS = Object.freeze({
  pass_tier: { table: 'PassTierVersion', key: (r) => ({ tierKey: r.tierKey }) },
  rule:      { table: 'SettlementRule', key: (r) => ({ scopeType: r.scopeType, scopeId: r.scopeId ?? null }) },
  rate_card: { table: 'GymRateCard', key: (r) => ({ gymId: r.gymId }) },
});

const isTzs = (v) => Number.isSafeInteger(v) && v >= 0;
const isBps = (v) => Number.isInteger(v) && v >= 0 && v <= 10_000;
const fail = (error, status = 400, extra = {}) => ({ error, status, ...extra });

export function createSettlementConfigService({ db = defaultDb, now = () => new Date() } = {}) {
  const run = (trx, fn) => (trx ? trx.transaction(fn) : db.transaction(fn));

  async function nextVersion(q, table, key) {
    const where = Object.fromEntries(Object.entries(key).filter(([, v]) => v !== null));
    let query = q(table).where(where).max('version as v');
    for (const [k, v] of Object.entries(key)) if (v === null) query = query.whereNull(k);
    const [{ v }] = await query;
    return (v || 0) + 1;
  }

  async function audit(q, { actorId, action, target, before, after }) {
    await q('AuditLog').insert({
      id: randomUUID(), at: now(), actor: actorId, action, target,
      before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
    });
  }

  async function insertDraft(q, table, key, row, actorId) {
    const version = await nextVersion(q, table, key);
    const draft = { id: randomUUID(), version, ...row, status: 'draft', createdBy: actorId, createdAt: now(), updatedAt: now() };
    await q(table).insert(draft);
    await audit(q, { actorId, action: 'settlement_config_drafted', target: draft.id, after: { table, ...draft } });
    return draft;
  }

  // ── drafts ─────────────────────────────────────────────────────────────────

  async function createPassTierVersion({ tierKey, priceTzs, visitAllowance, reason, actorId }, { trx } = {}) {
    if (typeof tierKey !== 'string' || !tierKey) return fail('tier_key_required');
    if (!isTzs(priceTzs)) return fail('price_must_be_whole_tzs');
    if (!Number.isInteger(visitAllowance) || visitAllowance < 0) return fail('allowance_must_be_whole_number');
    return run(trx, async (q) => ({
      passTierVersion: await insertDraft(q, 'PassTierVersion', { tierKey }, { tierKey, priceTzs, visitAllowance, reason: reason ?? null }, actorId),
    }));
  }

  async function createRule({ name, scopeType, scopeId = null, reason, actorId, ...values }, { trx } = {}) {
    if (!Object.values(RULE_SCOPE).includes(scopeType)) return fail('invalid_scope');
    if ((scopeType === RULE_SCOPE.GLOBAL) !== (scopeId == null)) return fail('scope_id_mismatch');
    const fields = Object.fromEntries(RULE_VALUE_FIELDS.filter((f) => values[f] != null).map((f) => [f, values[f]]));
    if (!Object.keys(fields).length) return fail('rule_has_no_values');
    for (const [f, v] of Object.entries(fields)) {
      if (f.endsWith('Bps') ? !isBps(v) : !isTzs(v)) return fail('invalid_rule_value', 400, { field: f });
    }
    if (fields.networkPayoutBps != null && ![RULE_SCOPE.GLOBAL, RULE_SCOPE.PASS_TIER].includes(scopeType)) return fail('network_rule_scope');
    if (scopeType === RULE_SCOPE.PASS_TIER && REIMBURSEMENT_FIELDS.some((f) => fields[f] != null)) return fail('reimbursement_rule_scope');
    return run(trx, async (q) => ({
      rule: await insertDraft(q, 'SettlementRule', { scopeType, scopeId }, { name: name ?? null, scopeType, scopeId, ...fields, reason: reason ?? null }, actorId),
    }));
  }

  async function createRateCard({ gymId, gymTier, retailDailyTzs, retailWeeklyTzs, retailMonthlyTzs, reason, actorId }, { trx } = {}) {
    for (const [f, v] of Object.entries({ retailDailyTzs, retailWeeklyTzs, retailMonthlyTzs })) {
      if (!isTzs(v)) return fail('retail_must_be_whole_tzs', 400, { field: f });
    }
    return run(trx, async (q) => {
      const gym = await q('Gym').where({ id: gymId }).first('id', 'tier');
      if (!gym) return fail('gym_not_found', 404);
      const tier = gymTier ?? gym.tier;
      return {
        rateCard: await insertDraft(q, 'GymRateCard', { gymId }, { gymId, gymTier: tier, retailDailyTzs, retailWeeklyTzs, retailMonthlyTzs, reason: reason ?? null }, actorId),
      };
    });
  }

  // ── activation ─────────────────────────────────────────────────────────────

  /**
   * Activate a draft from `effectiveFrom` (an EAT day). The start date may
   * not be in the past once the target already has an active version, so an
   * activation can never change a period that may have been settled.
   */
  async function activate({ kind, id, effectiveFrom, actorId }, { trx } = {}) {
    const meta = KINDS[kind];
    if (!meta) return fail('invalid_kind');
    if (typeof effectiveFrom !== 'string' || !DATE_RE.test(effectiveFrom)) return fail('invalid_effective_from');
    return run(trx, async (q) => {
      const row = await q(meta.table).where({ id }).forUpdate().first();
      if (!row) return fail('not_found', 404);
      if (row.status !== 'draft') return fail('not_a_draft', 409);
      if (!actorId) return fail('approver_required', 403);
      if (row.createdBy === actorId) return fail('cannot_approve_own_draft', 403);
      if (kind === 'rule' && row.scopeType === RULE_SCOPE.SPECIAL_CONTRACT) return fail('special_contract_reserved', 409);

      const key = meta.key(row);
      const sameTarget = (query) => {
        for (const [k, v] of Object.entries(key)) query = v === null ? query.whereNull(k) : query.where(k, v);
        return query;
      };
      const active = await sameTarget(q(meta.table).where({ status: 'active' })).forUpdate();
      const today = localDay(now());
      if (active.length && effectiveFrom < today) return fail('effective_from_in_past', 409, { today });
      const later = active.find((r) => r.effectiveFrom >= effectiveFrom);
      if (later) return fail('overlaps_later_version', 409, { versionId: later.id, effectiveFrom: later.effectiveFrom });

      const patch = { status: 'active', effectiveFrom, approvedBy: actorId, approvedAt: now(), updatedAt: now() };
      if (kind === 'rate_card') {
        const rules = await q('SettlementRule').where({ status: 'active' });
        const { values, sources, missing } = deriveRateCardRuleValues({ rules, effectiveFrom, gymTier: row.gymTier, gymId: row.gymId });
        if (missing.length) return fail('rule_missing', 409, { missing });
        Object.assign(patch, values, { ruleSources: JSON.stringify(sources) });
      }

      // Close the open-ended version this one replaces, then activate.
      const open = active.find((r) => r.effectiveTo == null);
      if (open) await q(meta.table).where({ id: open.id }).update({ effectiveTo: effectiveFrom, updatedAt: now() });
      await q(meta.table).where({ id }).update(patch);
      const activated = await q(meta.table).where({ id }).first();
      await audit(q, {
        actorId, action: 'settlement_config_activated', target: id,
        before: { table: meta.table, status: 'draft', replaces: open?.id ?? null },
        after: { table: meta.table, status: 'active', effectiveFrom, ...(kind === 'rate_card' ? Object.fromEntries(REIMBURSEMENT_FIELDS.map((f) => [f, patch[f]])) : {}) },
      });
      return { [kind === 'pass_tier' ? 'passTierVersion' : kind === 'rule' ? 'rule' : 'rateCard']: activated, closed: open?.id ?? null };
    });
  }

  async function reject({ kind, id, reason, actorId }, { trx } = {}) {
    const meta = KINDS[kind];
    if (!meta) return fail('invalid_kind');
    return run(trx, async (q) => {
      const row = await q(meta.table).where({ id }).forUpdate().first();
      if (!row) return fail('not_found', 404);
      if (row.status !== 'draft') return fail('not_a_draft', 409);
      await q(meta.table).where({ id }).update({ status: 'rejected', reason: reason ?? row.reason, updatedAt: now() });
      await audit(q, { actorId, action: 'settlement_config_rejected', target: id, before: { status: 'draft' }, after: { status: 'rejected', reason: reason ?? null } });
      return { rejected: id };
    });
  }

  /**
   * Every active row, in the shape the Phase 1 resolvers read
   * (resolvePassTierVersion, resolveNetworkPayoutBps, resolveGymRateSnapshot).
   */
  async function activeConfiguration({ trx } = {}) {
    const q = trx || db;
    const [passTierVersions, rules, rateCards] = await Promise.all([
      q('PassTierVersion').where({ status: 'active' }).orderBy(['tierKey', 'effectiveFrom']),
      q('SettlementRule').where({ status: 'active' }).orderBy(['scopeType', 'scopeId', 'effectiveFrom']),
      q('GymRateCard').where({ status: 'active' }).orderBy(['gymId', 'effectiveFrom']),
    ]);
    return { passTierVersions, rules, rateCards };
  }

  /** Everything, for the admin screens: drafts, active (including closed) and rejected. */
  async function listConfiguration({ status } = {}) {
    const where = status && status !== 'all' ? { status } : {};
    const [passTierVersions, rules, rateCards] = await Promise.all([
      db('PassTierVersion').where(where).orderBy([{ column: 'tierKey' }, { column: 'version', order: 'desc' }]),
      db('SettlementRule').where(where).orderBy([{ column: 'scopeType' }, { column: 'scopeId' }, { column: 'version', order: 'desc' }]),
      db('GymRateCard').where(where).orderBy([{ column: 'gymId' }, { column: 'version', order: 'desc' }]),
    ]);
    return { passTierVersions, rules, rateCards };
  }

  /**
   * Draft a rate card, from the gym's own retail rates, for every gym that
   * has no card at all (a new gym). Drafts only: each still needs approving
   * by someone else. Gyms missing a rate are reported, not guessed.
   */
  async function draftRateCardsForGyms({ actorId }, { trx } = {}) {
    return run(trx, async (q) => {
      const gyms = await q('Gym').whereNotIn('id', q('GymRateCard').select('gymId')).select('id', 'name', 'tier', 'ratePerDay', 'ratePerWeek', 'ratePerMonth').orderBy('id');
      const drafted = [];
      const skipped = [];
      for (const g of gyms) {
        if (g.tier === 'online') { skipped.push({ gymId: g.id, reason: 'online_gym' }); continue; }
        if (!(g.ratePerDay > 0 && g.ratePerWeek > 0 && g.ratePerMonth > 0)) { skipped.push({ gymId: g.id, reason: 'retail_rates_missing' }); continue; }
        drafted.push(await insertDraft(q, 'GymRateCard', { gymId: g.id },
          { gymId: g.id, gymTier: g.tier, retailDailyTzs: g.ratePerDay, retailWeeklyTzs: g.ratePerWeek, retailMonthlyTzs: g.ratePerMonth, reason: 'Drafted from the gym\'s retail rates' }, actorId));
      }
      return { drafted, skipped };
    });
  }

  return { createPassTierVersion, createRule, createRateCard, activate, reject, activeConfiguration, listConfiguration, draftRateCardsForGyms };
}
