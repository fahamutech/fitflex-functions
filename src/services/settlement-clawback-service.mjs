// Automatic clawbacks (settlement Phase 6, DR-20): what happens when a
// check-in is voided after its member cycle was settled.
//
// A line pays a group of visits by bracket (four visits earn one weekly
// rate), so a voided visit has no amount of its own. The whole member cycle
// is calculated again by the same engine with the visit voided, and each
// gym's difference is raised as an adjustment on that gym's draft statement:
//
//   difference = recalculated final − what the gym's line paid − already raised
//
// - Negative: a clawback. Positive (the member's network cap is shared, so
//   another gym's share can grow): a correction.
// - Raised as a proposal by the person who voided the check-in, so somebody
//   else has to apply it (DR-09). Nothing changes until then, and a statement
//   with a proposal waiting can't be submitted.
// - A gym with no draft statement keeps the difference pending: it is raised
//   by the next sweep that finds one (after each live run, void or reject).
// - If the line's own statement is frozen but not yet paid, it is put on
//   hold so it isn't paid unseen.
// - Lines on a voided statement were never paid: nothing is raised for them.
// - Safe to repeat: "already raised" counts proposed, applied and rejected
//   adjustments for the member cycle at that gym, so a second sweep finds no
//   difference. Adjustments cancelled with a voided statement don't count.
// - The stored calculation must be reproducible first. If today's engine no
//   longer gives the stored amounts for the stored inputs, nothing is raised
//   and the cycle is reported for a manual adjustment.
import { randomUUID } from 'node:crypto';
import { db as defaultDb } from '../infra/knex-store.mjs';
import { calculateMemberSettlement } from '../shared/settlement-engine.mjs';
import { resolveGymRateSnapshot, resolutionDateForCycle } from '../shared/settlement-config.mjs';
import { CHECKIN_STATUS } from '../shared/checkin-status.mjs';

const SYSTEM_ACTOR = 'system:clawback';
const B2B = 'b2b_benefit';
const COUNTED = ['proposed', 'applied', 'rejected'];
const FROZEN_UNPAID = ['submitted', 'approved', 'payable'];
const iso = (v) => new Date(v).toISOString();

export function createSettlementClawbackService({ db = defaultDb, configService, workflow, now = () => new Date(), logger = console } = {}) {
  /**
   * Find settled member cycles with a check-in voided since, and raise each
   * gym's difference.
   * @param {{ checkinId?: string, actorId?: string, dryRun?: boolean }} [args]
   *   checkinId limits the sweep to that check-in's cycle; dryRun reports
   *   without writing.
   * @returns {{ raised: Object[], pending: Object[], held: string[], skipped: Object[] }}
   */
  async function sweep({ checkinId = null, actorId = null, dryRun = false } = {}, { trx } = {}) {
    return (trx || db).transaction(async (q) => {
      const affected = q('SettlementVisit as v').join('Checkin as c', 'c.id', 'v.checkinId')
        .where({ 'v.mode': 'live', 'v.active': true, 'c.status': CHECKIN_STATUS.VOIDED }).whereNot('v.eligibility', 'voided');
      if (checkinId) affected.where('c.id', checkinId);
      const cycleIds = (await affected.distinct('v.memberCycleSettlementId as id')).map((r) => r.id).sort();

      const out = { raised: [], pending: [], held: [], skipped: [] };
      let rateCards = null;
      for (const cycleId of cycleIds) {
        const cycle = await q('MemberCycleSettlement').where({ id: cycleId }).forUpdate().first();
        if (!cycle?.active) continue;
        const skip = (reason, extra = {}) => out.skipped.push({ memberCycleSettlementId: cycleId, memberId: cycle.memberId, reason, ...extra });

        const stored = await q('SettlementVisit').where({ memberCycleSettlementId: cycleId, active: true });
        const checkins = new Map((await q('Checkin').whereIn('id', stored.map((v) => v.checkinId))).map((c) => [c.id, c]));
        const lines = await q('GymSettlementLine').where({ memberCycleSettlementId: cycleId });
        const statements = new Map((await q('GymSettlement').whereIn('id', lines.map((l) => l.gymSettlementId))).map((s) => [s.id, s]));
        const lineByGym = new Map(lines.map((l) => [l.gymId, l]));

        // The gym's rates as they were settled; a gym that had no line then
        // is resolved from the configuration for the same date.
        const gymRates = [];
        for (const gymId of [...new Set(stored.map((v) => v.gymId))].sort()) {
          let snapshot = lineByGym.get(gymId)?.rateCardSnapshot ?? null;
          if (!snapshot) {
            rateCards ??= (await configService.activeConfiguration({ trx: q })).rateCards;
            snapshot = resolveGymRateSnapshot({ rateCards, gymId, date: resolutionDateForCycle(iso(cycle.cycleStart)) }).snapshot ?? null;
          }
          if (snapshot) gymRates.push(snapshot);
        }

        const b2b = cycle.fundingType === B2B;
        const base = {
          memberId: cycle.memberId, cycleId: cycle.subscriptionId, subscriptionId: cycle.subscriptionId,
          subscriptionType: cycle.fundingType, passTier: cycle.passTier,
          cycleStart: iso(cycle.cycleStart), cycleEnd: iso(cycle.cycleEnd),
          collectedApprovedAmountTzs: cycle.collectedApprovedAmountTzs, networkPayoutBps: cycle.networkPayoutBps, visitAllowance: cycle.visitAllowance,
        };
        const visit = (v, status) => {
          const c = checkins.get(v.checkinId);
          return {
            checkinId: c.id, memberId: cycle.memberId, cycleId: cycle.subscriptionId, gymId: c.gymId, timestamp: iso(c.timestamp),
            status, visitConsumed: b2b ? true : c.visitConsumed, subscriptionType: c.subscriptionType, gymTier: c.gymTier,
          };
        };
        const known = stored.filter((v) => checkins.has(v.checkinId));
        const finals = (result) => new Map(result.gyms.map((g) => [g.gymId, g.finalTzs]));

        // 1. As it was settled: the stored amounts must come out again.
        let settled;
        try {
          settled = finals(calculateMemberSettlement({ cycle: base, visits: known.map((v) => visit(v, v.eligibility === 'voided' ? CHECKIN_STATUS.VOIDED : CHECKIN_STATUS.VALID)), gymRates }));
        } catch (err) {
          skip('cannot_reproduce', { message: err.message });
          continue;
        }
        if (known.length !== stored.length || lines.some((l) => (settled.get(l.gymId) ?? 0) !== l.finalTzs) || [...settled.keys()].some((g) => !lineByGym.has(g))) {
          skip('cannot_reproduce');
          continue;
        }

        // 2. As it stands now.
        let current = { ...base };
        let currentVisits = known;
        if (b2b) {
          // A reversed consumption is no longer charged to the sponsor: it
          // leaves the visits, the allowance and the cap basis.
          const charged = await q('B2BBenefitConsumption').where({ sourceType: 'gym_checkin', status: 'approved' }).whereIn('sourceId', known.map((v) => v.checkinId));
          const chargedIds = new Set(charged.map((c) => c.sourceId));
          currentVisits = known.filter((v) => chargedIds.has(v.checkinId));
          current = { ...base, collectedApprovedAmountTzs: charged.reduce((t, c) => t + c.grossTzs, 0), visitAllowance: currentVisits.length };
        }
        let result;
        try {
          result = calculateMemberSettlement({ cycle: current, visits: currentVisits.map((v) => visit(v, checkins.get(v.checkinId).status)), gymRates });
        } catch (err) {
          skip('cannot_recalculate', { message: err.message });
          continue;
        }
        if (result.member.heldVisitCount > 0) {
          skip('held_visits');   // a disputed or flagged visit has to be resolved first
          continue;
        }
        const recalculated = finals(result);

        const voidedSince = known.filter((v) => v.eligibility !== 'voided' && checkins.get(v.checkinId).status === CHECKIN_STATUS.VOIDED)
          .map((v) => checkins.get(v.checkinId)).sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));
        const voider = [...voidedSince].sort((a, b) => +new Date(b.voidedAt ?? 0) - +new Date(a.voidedAt ?? 0))[0]?.voidedBy;

        // 3. Each gym's difference.
        for (const gymId of [...new Set([...lineByGym.keys(), ...recalculated.keys()])].sort()) {
          const line = lineByGym.get(gymId) ?? null;
          const source = line ? statements.get(line.gymSettlementId) : null;
          if (source?.status === 'voided') continue;   // never paid
          const [{ total }] = await q('SettlementAdjustment as a').join('GymSettlement as s', 's.id', 'a.gymSettlementId')
            .where({ 'a.sourceMemberCycleSettlementId': cycleId, 's.gymId': gymId }).whereIn('a.status', COUNTED).sum({ total: 'a.amountTzs' });
          const amountTzs = (recalculated.get(gymId) ?? 0) - (line?.finalTzs ?? 0) - (Number(total) || 0);
          if (amountTzs === 0) continue;

          const here = voidedSince.filter((c) => c.gymId === gymId);
          const days = [...new Set(here.map((c) => c.businessDate).filter(Boolean))];
          const item = {
            gymId, memberCycleSettlementId: cycleId, memberId: cycle.memberId, amountTzs,
            type: amountTzs < 0 ? 'clawback' : 'correction',
            reason: here.length
              ? `${here.length === 1 ? 'Visit' : 'Visits'}${days.length ? ` on ${days.join(', ')}` : ''} voided after settlement`
              : 'Share recalculated after the member\'s visit at another gym was voided',
            sourceCheckinId: (here.at(-1) ?? voidedSince.at(-1))?.id ?? null,
            sourceSettlementId: source?.id ?? null,
          };

          // A frozen, unpaid statement that would now overpay is not paid unseen.
          if (!dryRun && amountTzs < 0 && source && FROZEN_UNPAID.includes(source.status) && !source.holdReason) {
            const held = await workflow.hold({ id: source.id, reason: 'A visit on this statement was voided after it was submitted', actorId: actorId || voider || SYSTEM_ACTOR }, { trx: q });
            if (!held.error) out.held.push(source.id);
          }

          const target = await q('GymSettlement').where({ gymId, mode: 'live', status: 'draft' }).orderBy('periodStartDate').first();
          if (!target) { out.pending.push(item); continue; }
          if (dryRun) { out.raised.push({ ...item, gymSettlementId: target.id }); continue; }

          const at = now();
          const adjustment = {
            id: randomUUID(), gymSettlementId: target.id, amountTzs, type: item.type, reason: item.reason, status: 'proposed',
            sourceSettlementId: item.sourceSettlementId, sourceCheckinId: item.sourceCheckinId, sourceMemberCycleSettlementId: cycleId,
            createdBy: voider || actorId || SYSTEM_ACTOR, createdAt: at, updatedAt: at,
          };
          await q('SettlementAdjustment').insert(adjustment);
          await q('AuditLog').insert({ id: randomUUID(), at, actor: actorId || voider || SYSTEM_ACTOR, action: 'settlement_clawback_raised', target: adjustment.id, before: null,
            after: JSON.stringify({ gymSettlementId: target.id, amountTzs, type: item.type, memberCycleSettlementId: cycleId, checkinIds: voidedSince.map((c) => c.id) }) });
          out.raised.push({ ...item, gymSettlementId: target.id, adjustmentId: adjustment.id });
        }
      }
      return out;
    });
  }

  /** sweep() for callers that must not fail because of it (hooks, jobs). */
  async function sweepQuietly(args) {
    try {
      return await sweep(args);
    } catch (err) {
      logger.warn('[settlement] clawback sweep failed:', err?.message);
      return { error: 'sweep_failed', message: err?.message };
    }
  }

  return { sweep, sweepQuietly };
}
