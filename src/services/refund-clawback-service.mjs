// Refund-to-statement clawback (Phase 1 · Slice D; flag REFUND_STATEMENT_CLAWBACK).
//
// When a refund on a pass is PAID after the pass's cycle was settled to a gym, the refunded share of what the
// gym's line paid is taken back through the existing settlement-adjustment mechanics (DR-20/DR-09):
//
//   clawback = -round(line.finalTzs x refund / collected)     (never more than the line still holds)
//
// - Same adjustment table, type 'clawback', status 'proposed' on the gym's oldest draft statement: the person who
//   paid the refund proposes it, somebody else applies it. Nothing changes until then.
// - Linked to the refund (SettlementAdjustment.refundId). One refund claws back once from each source statement
//   (unique index), so retries, double clicks and sweeps never take the money twice.
// - A gym with no draft statement keeps it pending; sweepPending() raises it once one exists.
// - A line on a voided statement was never paid: nothing is raised. A frozen, unpaid source statement is put on
//   hold so it is not paid unseen (same as the check-in void clawback).
// - Used visits are NOT voided (owner decision 3, 2026-11-10): the visits stand; only the money is adjusted.
// - Deliberately NOT linked to the member cycle (sourceMemberCycleSettlementId stays empty) so the check-in void
//   sweep, which recalculates from visits, does not count it as a visit correction.
// - Only gym statements have adjustments today. Trainer and vendor statements have no adjustment mechanism, so
//   pass refunds touch gyms only (trainer-session and shop refunds are not handled here).
import { randomUUID } from 'node:crypto';
import { db as defaultDb } from '../infra/knex-store.mjs';

const SYSTEM_ACTOR = 'system:refund-clawback';
const FROZEN_UNPAID = ['submitted', 'approved', 'payable'];
const COUNTED = ['proposed', 'applied', 'rejected'];

export function createRefundClawbackService({ db = defaultDb, workflow = null, now = () => new Date(), logger = console } = {}) {
  /**
   * Raise (or find already raised) the clawback of one paid pass refund. Idempotent.
   * @param {{ refund: Object, actorId?: string, dryRun?: boolean }} args
   * @returns {{ status: string, raised: Object[], existing: Object[], pending: Object[], skipped: Object[], held: string[] }}
   *   status: not_applicable | unsettled | nothing_to_claw_back | raised | pending | already_raised
   */
  async function raiseForRefund({ refund, actorId = null, dryRun = false }, { trx } = {}) {
    const out = { status: 'not_applicable', refundId: refund?.id ?? null, raised: [], existing: [], pending: [], skipped: [], held: [] };
    if (!refund || refund.kind !== 'subscription' || refund.status !== 'paid' || !refund.subscriptionId) return out;
    return (trx || db).transaction(async (q) => {
      // One refund at a time: a retry waits for the first attempt to finish, then finds its adjustments.
      await q.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`refund-clawback:${refund.id}`]);
      const cycle = await q('MemberCycleSettlement').where({ subscriptionId: refund.subscriptionId, mode: 'live', active: true }).first();
      if (!cycle) return { ...out, status: 'unsettled' };
      const lines = await q('GymSettlementLine').where({ memberCycleSettlementId: cycle.id });
      if (!lines.length) return { ...out, status: 'unsettled' };

      const payment = refund.paymentRequestId ? await q('PaymentRequest').where({ id: refund.paymentRequestId }).first('amountTzs') : null;
      const basis = Number(cycle.collectedApprovedAmountTzs) > 0 ? Number(cycle.collectedApprovedAmountTzs) : Number(payment?.amountTzs) || 0;
      if (!(basis > 0) || !(Number(refund.amountTzs) > 0)) return { ...out, status: 'nothing_to_claw_back' };
      const ratio = Math.min(1, Number(refund.amountTzs) / basis);
      const actor = actorId || refund.paidBy || SYSTEM_ACTOR;

      for (const line of [...lines].sort((a, b) => (a.gymId < b.gymId ? -1 : 1))) {
        const source = await q('GymSettlement').where({ id: line.gymSettlementId }).first();
        const skip = (reason) => out.skipped.push({ gymId: line.gymId, gymSettlementId: line.gymSettlementId, reason });
        if (!source || source.mode !== 'live') { skip('not_live'); continue; }
        if (source.status === 'voided') { skip('statement_voided'); continue; }   // never paid

        const prior = await q('SettlementAdjustment').where({ refundId: refund.id, sourceSettlementId: source.id }).whereNot('status', 'voided').first();
        if (prior) { out.existing.push({ gymId: line.gymId, adjustmentId: prior.id, amountTzs: prior.amountTzs, status: prior.status, gymSettlementId: prior.gymSettlementId }); continue; }

        // Never take back more than the line still holds after visit corrections already raised for this cycle.
        const [{ total }] = await q('SettlementAdjustment as a').join('GymSettlement as s', 's.id', 'a.gymSettlementId')
          .where({ 'a.sourceMemberCycleSettlementId': cycle.id, 's.gymId': line.gymId }).whereIn('a.status', COUNTED).sum({ total: 'a.amountTzs' });
        const room = Math.max(0, line.finalTzs + (Number(total) || 0));
        const take = Math.min(Math.round(line.finalTzs * ratio), room);
        if (take <= 0) { skip('nothing_to_claw_back'); continue; }

        const item = {
          gymId: line.gymId, amountTzs: -take, type: 'clawback', refundId: refund.id, sourceSettlementId: source.id,
          reason: `Pass refund ${refund.id} paid after settlement (${ratio >= 1 ? 'full' : 'partial'} refund)`,
        };
        const target = await q('GymSettlement').where({ gymId: line.gymId, mode: 'live', status: 'draft' }).orderBy('periodStartDate').first();
        if (!target) { out.pending.push(item); continue; }
        if (dryRun) { out.raised.push({ ...item, gymSettlementId: target.id }); continue; }

        if (workflow && FROZEN_UNPAID.includes(source.status) && !source.holdReason) {
          const held = await workflow.hold({ id: source.id, reason: 'A pass refund on this statement was paid after it was submitted', actorId: actor }, { trx: q });
          if (!held.error) out.held.push(source.id);
        }
        const at = now();
        const adjustment = {
          id: randomUUID(), gymSettlementId: target.id, amountTzs: item.amountTzs, type: 'clawback', reason: item.reason, status: 'proposed',
          sourceSettlementId: source.id, refundId: refund.id, createdBy: actor, createdAt: at, updatedAt: at,
        };
        await q('SettlementAdjustment').insert(adjustment);
        await q('AuditLog').insert({ id: randomUUID(), at, actor, action: 'refund_clawback_raised', target: adjustment.id, before: null,
          after: JSON.stringify({ refundId: refund.id, gymId: line.gymId, gymSettlementId: target.id, sourceSettlementId: source.id, amountTzs: item.amountTzs, memberCycleSettlementId: cycle.id, subscriptionId: refund.subscriptionId }) });
        out.raised.push({ ...item, gymSettlementId: target.id, adjustmentId: adjustment.id });
      }
      out.status = out.raised.length ? 'raised' : out.pending.length ? 'pending' : out.existing.length ? 'already_raised' : 'nothing_to_claw_back';
      return out;
    });
  }

  /** Paid pass refunds whose clawback is still waiting for a draft statement (or was never attempted). */
  async function sweepPending({ actorId = null, sinceDays = 180 } = {}) {
    const since = new Date(now().getTime() - sinceDays * 86_400_000);
    const refunds = await db('Refund').where({ kind: 'subscription', status: 'paid' }).where('paidAt', '>=', since).whereNotNull('subscriptionId').orderBy('paidAt');
    const results = [];
    for (const refund of refunds) {
      const r = await raiseForRefund({ refund, actorId });
      if (r.raised.length || r.pending.length) results.push(r);
    }
    return { results };
  }

  async function sweepPendingQuietly(args) {
    try {
      return await sweepPending(args);
    } catch (err) {
      logger.warn('[settlement] refund clawback sweep failed:', err?.message);
      return { error: 'sweep_failed', message: err?.message };
    }
  }

  /** The adjustments raised for one refund, oldest first, with the gym each belongs to. */
  async function listForRefund(refundId) {
    return db('SettlementAdjustment as a').join('GymSettlement as s', 's.id', 'a.gymSettlementId').where('a.refundId', refundId).orderBy('a.createdAt')
      .select('a.id', 'a.gymSettlementId', 'a.sourceSettlementId', 's.gymId', 'a.amountTzs', 'a.status', 'a.reason', 'a.createdBy', 'a.createdAt');
  }

  /** Admin retry by refund id. */
  async function retryForRefundId({ id, actorId }) {
    const refund = await db('Refund').where({ id }).first();
    if (!refund) return { error: 'refund_not_found', status: 404 };
    if (refund.status !== 'paid') return { error: 'refund_not_paid', status: 409 };
    return raiseForRefund({ refund, actorId });
  }

  return { raiseForRefund, sweepPending, sweepPendingQuietly, listForRefund, retryForRefundId };
}
