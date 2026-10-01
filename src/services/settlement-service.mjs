// Settlement service (settlement Phase 3): turns finished Platform Pass
// cycles into stored settlements, using the Phase 1 engine. It calculates
// and records; it never approves or pays.
//
// One run covers one EAT period (a calendar month). It takes every member
// cycle that is final by the period end — cycle end + the 24 h grace + the
// 7-day dispute window (DR-14, DR-15) — and has no live settlement yet, so a
// cycle missed by one run is picked up by the next. For each it resolves the
// configuration in force at the cycle start (DR-10), runs the engine and
// stores the result. A cycle that can't be settled cleanly is skipped with a
// reason and retried by a later run; it is never part-settled:
//
//   no_approved_payment   nothing collected and approved for the cycle (DR-05)
//   no_pass_tier_version  no pass version in force at the cycle start
//   rule_missing          no network % rule in force
//   held_visits           a disputed or flagged visit, or a gym with no rate card
//
// Safety: an advisory lock (one server at a time), everything in one
// transaction (a failure stores nothing), the run locked at the end with a
// hash of its inputs. LIVE: one run per period. SHADOW: stored the same way
// but never payable, and any number of runs.
import { createHash, randomUUID } from 'node:crypto';
import { db as defaultDb } from '../infra/knex-store.mjs';
import { SUBSCRIPTION_GRACE_HOURS } from '../shared/constants.mjs';
import { localDay } from '../shared/member-progress.mjs';
import { resolveMemberCycleTerms, resolveGymRateSnapshot, resolutionDateForCycle } from '../shared/settlement-config.mjs';
import { calculateMemberSettlement, SETTLEMENT_ENGINE_VERSION, SETTLEMENT_DISPUTE_WINDOW_DAYS, SETTLEABLE_SUBSCRIPTION_TYPES } from '../shared/settlement-engine.mjs';
import { settlementRowsFromResult, gymStatementTotals } from '../shared/settlement-rows.mjs';

export const SETTLEMENT_LOCK_KEY = 7_203_915; // one settlement run at a time, across servers
export const SETTLEMENT_MODES = Object.freeze(['live', 'shadow']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const EAT_OFFSET_MS = 3 * 3_600_000;
const FINAL_AFTER_MS = SUBSCRIPTION_GRACE_HOURS * 3_600_000 + SETTLEMENT_DISPUTE_WINDOW_DAYS * 86_400_000;
const CYCLE_STATUSES = ['active', 'expired', 'suspended'];   // a cycle that was paid for and ran

const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const fail = (error, status = 400, extra = {}) => ({ error, status, ...extra });
/** The instant an EAT calendar day starts. */
const eatDayStart = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - EAT_OFFSET_MS);

/** "2026-10" → the EAT month as [start, end) days. */
export function periodForMonth(month) {
  if (typeof month !== 'string' || !MONTH_RE.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { periodStartDate: `${month}-01`, periodEndDate: end };
}

/** The EAT month before the one `at` falls in. */
export function previousMonth(at) {
  const [y, m] = localDay(at).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function createSettlementService({ db = defaultDb, configService, now = () => new Date(), logger = console } = {}) {
  const jsonb = (v) => (v == null ? null : JSON.stringify(v));

  /**
   * Calculate and store one period.
   * @param {{ periodStartDate: string, periodEndDate: string, mode: 'live'|'shadow', actorId?: string, jobRunId?: string }} args
   * @returns {{ run, stats, exceptions } | { alreadyRun: true, run } | { skipped: 'locked' } | { error, status }}
   */
  async function run({ periodStartDate, periodEndDate, mode, actorId = 'system', jobRunId = null }, { trx } = {}) {
    if (!SETTLEMENT_MODES.includes(mode)) return fail('invalid_mode');
    if (![periodStartDate, periodEndDate].every((d) => typeof d === 'string' && DATE_RE.test(d)) || periodEndDate <= periodStartDate) {
      return fail('invalid_period');
    }
    const periodEnd = eatDayStart(periodEndDate);
    if (mode === 'live' && periodEnd > now()) return fail('period_not_finished', 409);

    return (trx || db).transaction(async (q) => {
      const { rows: [{ ok }] } = await q.raw('select pg_try_advisory_xact_lock(?) as ok', [SETTLEMENT_LOCK_KEY]);
      if (!ok) return { skipped: 'locked' };

      if (mode === 'live') {
        const existing = await q('SettlementRun').where({ mode: 'live', periodStartDate, periodEndDate }).whereNot({ status: 'failed' }).first();
        if (existing) return { alreadyRun: true, run: existing };
      }

      // ── inputs ───────────────────────────────────────────────────────────
      const config = await configService.activeConfiguration({ trx: q });
      const settled = q('MemberCycleSettlement').where({ mode: 'live', active: true }).select('subscriptionId');
      const cycles = await q('Subscription')
        .whereIn('type', SETTLEABLE_SUBSCRIPTION_TYPES).whereIn('status', CYCLE_STATUSES)
        .whereNot({ tier: 'online_free' })
        .where('expiresAt', '<=', new Date(+periodEnd - FINAL_AFTER_MS))
        .whereNotIn('id', settled)
        .orderBy('id');
      const ids = cycles.map((c) => c.id);
      const payments = ids.length ? await q('PaymentRequest').whereIn('subscriptionId', ids).where({ status: 'approved' }) : [];
      const checkins = ids.length ? await q('Checkin').whereIn('subscriptionId', ids).orderBy(['timestamp', 'id']) : [];
      const collectedBy = new Map();
      for (const p of payments) collectedBy.set(p.subscriptionId, (collectedBy.get(p.subscriptionId) || 0) + p.amountTzs);
      const visitsBy = new Map();
      for (const c of checkins) (visitsBy.get(c.subscriptionId) || visitsBy.set(c.subscriptionId, []).get(c.subscriptionId)).push(c);

      // ── calculate (pure) ─────────────────────────────────────────────────
      const exceptions = [];
      const settledCycles = [];
      const inputs = [];
      for (const sub of cycles) {
        const skip = (reason, extra = {}) => exceptions.push({ subscriptionId: sub.id, memberId: sub.memberId, reason, ...extra });
        if (!collectedBy.has(sub.id)) { skip('no_approved_payment'); continue; }
        const cycleStart = iso(sub.cycleStartedAt || sub.startedAt);
        const collectedApprovedAmountTzs = collectedBy.get(sub.id);
        const terms = resolveMemberCycleTerms({ passTierVersions: config.passTierVersions, rules: config.rules, passTier: sub.tier, cycleStart, collectedApprovedAmountTzs });
        if (terms.error) { skip(terms.error, { missing: terms.missing }); continue; }

        const date = resolutionDateForCycle(cycleStart);
        const subVisits = visitsBy.get(sub.id) || [];
        const gymRates = [];
        for (const gymId of [...new Set(subVisits.map((v) => v.gymId))].sort()) {
          const r = resolveGymRateSnapshot({ rateCards: config.rateCards, gymId, date });
          if (r.snapshot) gymRates.push(r.snapshot);   // a gym without one is held by the engine (no_rate_card)
        }
        const input = {
          cycle: {
            memberId: sub.memberId, cycleId: sub.id, subscriptionId: sub.id, subscriptionType: sub.type, passTier: sub.tier,
            cycleStart, cycleEnd: iso(sub.expiresAt), collectedApprovedAmountTzs,
            networkPayoutBps: terms.terms.networkPayoutBps, visitAllowance: terms.terms.visitAllowance,
          },
          visits: subVisits.map((c) => ({
            checkinId: c.id, memberId: c.memberId, cycleId: c.subscriptionId, gymId: c.gymId, timestamp: iso(c.timestamp),
            status: c.status, visitConsumed: c.visitConsumed, subscriptionType: c.subscriptionType, gymTier: c.gymTier,
          })),
          gymRates,
        };
        const result = calculateMemberSettlement(input);
        if (result.member.heldVisitCount > 0) {
          const held = result.visits.filter((v) => v.outcome === 'held');
          skip('held_visits', { held: Object.fromEntries([...new Set(held.map((v) => v.eligibility))].map((e) => [e, held.filter((v) => v.eligibility === e).length])) });
          continue;
        }
        inputs.push(input);
        settledCycles.push({ result, terms: terms.terms });
      }

      // ── store ────────────────────────────────────────────────────────────
      const at = now();
      const runRow = {
        id: `srun_${randomUUID().slice(0, 12)}`, mode, periodStartDate, periodEndDate, status: 'draft',
        engineVersion: SETTLEMENT_ENGINE_VERSION, jobRunId, createdBy: actorId, createdAt: at, updatedAt: at,
      };
      await q('SettlementRun').insert(runRow);

      const statementIds = new Map();
      const gymIds = [...new Set(settledCycles.flatMap((c) => c.result.gyms.map((g) => g.gymId)))].sort();
      for (const gymId of gymIds) statementIds.set(gymId, `gst_${randomUUID().slice(0, 12)}`);
      if (gymIds.length) {
        await q('GymSettlement').insert(gymIds.map((gymId) => ({
          id: statementIds.get(gymId), runId: runRow.id, mode, gymId, periodStartDate, periodEndDate, createdAt: at, updatedAt: at,
        })));
      }

      const allLines = [];
      for (const { result, terms } of settledCycles) {
        const rows = settlementRowsFromResult(result, {
          runId: runRow.id, mode, newId: () => `srow_${randomUUID().slice(0, 16)}`,
          gymSettlementIdFor: (gymId) => statementIds.get(gymId),
          terms: { passTierVersion: terms.passTierVersion, catalogPriceTzs: terms.catalogPriceTzs },
        });
        await q('MemberCycleSettlement').insert({ ...rows.memberCycle, explanation: jsonb(rows.memberCycle.explanation), createdAt: at });
        if (rows.lines.length) {
          await q('GymSettlementLine').insert(rows.lines.map((l) => ({ ...l, rateCardSnapshot: jsonb(l.rateCardSnapshot), calculationBasis: jsonb(l.calculationBasis), createdAt: at })));
        }
        if (rows.visits.length) await q('SettlementVisit').insert(rows.visits.map((v) => ({ ...v, createdAt: at })));
        allLines.push(...rows.lines);
      }
      for (const gymId of gymIds) {
        const totals = gymStatementTotals(allLines.filter((l) => l.gymId === gymId));
        await q('GymSettlement').where({ id: statementIds.get(gymId) }).update({ ...totals, updatedAt: at });
      }

      const sum = (f) => settledCycles.reduce((s, c) => s + c.result.member[f], 0);
      const stats = {
        candidateCycles: cycles.length, settledCycles: settledCycles.length, skippedCycles: exceptions.length, statements: gymIds.length,
        payableVisits: sum('payableVisitCount'), totalPreliminaryTzs: sum('totalPreliminaryTzs'), totalFinalTzs: sum('totalFinalTzs'),
      };
      const inputsHash = `sha256:${createHash('sha256').update(JSON.stringify(inputs)).digest('hex')}`;
      await q('SettlementRun').where({ id: runRow.id }).update({
        status: 'locked', lockedAt: at, lockedBy: actorId, inputsHash, updatedAt: at,
        configurationSnapshot: jsonb({
          passTierVersions: config.passTierVersions.map((v) => v.id), rules: config.rules.map((r) => r.id),
          rateCards: config.rateCards.map((c) => c.id), stats, exceptions,
        }),
      });
      const stored = await q('SettlementRun').where({ id: runRow.id }).first();
      return { run: stored, stats, exceptions };
    });
  }

  /**
   * The scheduled entry point: settle the EAT month before `now` in
   * SETTLEMENT_MODE (shadow unless told otherwise; off = do nothing).
   * Never throws; records a JobRun.
   */
  async function runDue({ mode = (process.env.SETTLEMENT_MODE || 'shadow').toLowerCase() } = {}) {
    if (mode === 'off') return { skipped: 'off' };
    if (!SETTLEMENT_MODES.includes(mode)) return { skipped: 'invalid_mode' };
    const period = periodForMonth(previousMonth(now()));
    // Shadow runs aren't limited to one per period, so only run a month once.
    const existing = await db('SettlementRun').where({ mode, ...period }).whereNot({ status: 'failed' }).first();
    if (existing) return { alreadyRun: true, run: existing };

    const jobRunId = `job_${randomUUID().slice(0, 12)}`;
    await db('JobRun').insert({ id: jobRunId, job: 'settlement_closer', status: 'running', startedAt: now() }).catch(() => {});
    try {
      const out = await run({ ...period, mode, actorId: 'system', jobRunId });
      await db('JobRun').where({ id: jobRunId })
        .update({ status: out.error ? 'failed' : 'ok', finishedAt: now(), stats: jsonb(out.stats || { skipped: out.skipped || null, alreadyRun: !!out.alreadyRun }), error: out.error || null })
        .catch(() => {});
      return out;
    } catch (err) {
      logger.error?.(`[settlement] ${mode} run for ${period.periodStartDate} failed: ${err.message}`);
      await db('JobRun').where({ id: jobRunId }).update({ status: 'failed', finishedAt: now(), error: err.message }).catch(() => {});
      return { error: 'settlement_run_failed', status: 500, message: err.message };
    }
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async function listRuns({ mode, limit = 50 } = {}) {
    const query = db('SettlementRun').orderBy('createdAt', 'desc').limit(Math.min(Number(limit) || 50, 200));
    if (mode) query.where({ mode });
    return query;
  }

  async function getRun(id) {
    const runRow = await db('SettlementRun').where({ id }).first();
    if (!runRow) return fail('run_not_found', 404);
    const statements = await db('GymSettlement').where({ runId: id }).orderBy('gymId');
    return { run: runRow, statements };
  }

  async function getStatement(id) {
    const statement = await db('GymSettlement').where({ id }).first();
    if (!statement) return fail('statement_not_found', 404);
    const lines = await db('GymSettlementLine').where({ gymSettlementId: id }).orderBy('memberId');
    const visits = lines.length ? await db('SettlementVisit').whereIn('lineId', lines.map((l) => l.id)).orderBy(['businessDate', 'checkinId']) : [];
    const adjustments = await db('SettlementAdjustment').where({ gymSettlementId: id }).orderBy('createdAt');
    return { statement, lines, visits, adjustments };
  }

  return { run, runDue, listRuns, getRun, getStatement };
}
