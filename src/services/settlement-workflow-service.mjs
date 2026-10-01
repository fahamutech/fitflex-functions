// Settlement workflow (settlement Phase 4): a gym statement's path from the
// engine's draft to a recorded payout.
//
//   draft ──submit──► submitted ──approve──► approved ──payable──► payable ──pay──► paid
//     ▲                  │                      ▲                     │
//     └──── reject ──────┘                      └────── hold ─────────┘
//
//   draft | submitted | approved ──void──► voided   (final: never paid)
//
// Four things stay separate (the spec's N): calculated (the run), approved
// (a second person agreed), payable (the payout check passed and nothing
// holds it) and paid (the money went, with a reference).
//
// - Maker-checker (DR-09): whoever submitted a statement can't approve it.
//   This is checked on the user id, so a super admin is not exempt; the
//   database refuses it too.
// - A hold blocks "payable" and "paid" and pulls a payable statement back to
//   approved. Releasing it doesn't make the statement payable by itself.
// - The payout check (payout-eligibility) runs when a statement is marked
//   payable and again when it is paid.
// - Only live statements of a locked run enter the workflow: a shadow
//   statement can never be submitted, approved or paid.
// - Paying records one GymPayout. The amounts were frozen at submit.
//
// Adjustments (DR-20) correct a statement while it is still a draft: a
// signed amount with a reason, proposed by one person and applied by
// another. The net is never negative: a shortfall stays on the statement as
// carryForwardTzs, and is pulled into the gym's next statement as a
// carry_forward adjustment when that one is submitted — once.
//
// Voiding cancels an unpaid statement for good, with a reason. Its
// adjustments are cancelled with it, so a carried-forward shortfall or a
// clawback that sat on it is raised again on the gym's next statement. Its
// visits stay settled: they are never paid by a later run. To pay later
// rather than never, hold the statement instead.
//
// Each step is one transaction with the row locked, and is audited.
import { randomUUID } from 'node:crypto';
import { db as defaultDb } from '../infra/knex-store.mjs';
import { statementNet } from '../shared/settlement-rows.mjs';

const fail = (error, status = 409, extra = {}) => ({ error, status, ...extra });
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const HOLDABLE = ['draft', 'submitted', 'approved', 'payable'];
const VOIDABLE = ['draft', 'submitted', 'approved'];
const MANUAL_ADJUSTMENT_TYPES = ['correction', 'clawback', 'manual'];
const CARRY_FORWARD_ACTOR = 'system:carry-forward';

export function createSettlementWorkflowService({ db = defaultDb, payoutEligibility, now = () => new Date() } = {}) {
  /** Lock the statement, run `fn`, apply its patch, audit. */
  async function step(id, action, actorId, fn, { trx } = {}) {
    if (!actorId) return fail('actor_required', 403);
    return (trx || db).transaction(async (q) => {
      const statement = await q('GymSettlement').where({ id }).forUpdate().first();
      if (!statement) return fail('statement_not_found', 404);
      if (statement.mode !== 'live') return fail('shadow_statement');
      const out = await fn(statement, q);
      if (out.error) return out;
      const at = now();
      await q('GymSettlement').where({ id }).update({ ...out.patch, updatedAt: at });
      const updated = await q('GymSettlement').where({ id }).first();
      await q('AuditLog').insert({
        id: randomUUID(), at, actor: actorId, action: `settlement_${action}`, target: id,
        before: JSON.stringify({ status: statement.status, holdReason: statement.holdReason }),
        after: JSON.stringify({ status: updated.status, holdReason: updated.holdReason, ...(out.audit || {}) }),
      });
      return { statement: updated, ...(out.extra || {}) };
    });
  }

  const wrongStatus = (statement, expected) => fail('invalid_status', 409, { currentStatus: statement.status, expected });

  /** Recompute a draft statement's adjustment total and net from its applied adjustments. */
  async function retotal(q, statement) {
    const [{ total }] = await q('SettlementAdjustment').where({ gymSettlementId: statement.id, status: 'applied' }).sum({ total: 'amountTzs' });
    const adjustmentsTzs = Number(total) || 0;
    return { adjustmentsTzs, ...statementNet({ preliminaryTzs: statement.preliminaryTzs, networkAdjustmentTzs: statement.networkAdjustmentTzs, adjustmentsTzs }) };
  }

  /**
   * Pull in the shortfall of the gym's earlier statements (DR-20). A
   * statement that has left draft with carryForwardTzs < 0 still owes that
   * amount back; it is taken off this one, once.
   */
  async function pullCarryForward(q, statement, actorId) {
    const carried = q('SettlementAdjustment').where({ type: 'carry_forward', status: 'applied' }).whereNotNull('sourceSettlementId').select('sourceSettlementId');
    const sources = await q('GymSettlement')
      .where({ gymId: statement.gymId, mode: 'live' }).whereNot({ id: statement.id })
      .whereIn('status', ['submitted', 'approved', 'payable', 'paid']).where('carryForwardTzs', '<', 0)
      .where('periodStartDate', '<', statement.periodStartDate)
      .whereNotIn('id', carried).orderBy('periodStartDate');
    const at = now();
    for (const source of sources) {
      await q('SettlementAdjustment').insert({
        id: randomUUID(), gymSettlementId: statement.id, amountTzs: source.carryForwardTzs, type: 'carry_forward',
        reason: `Shortfall carried forward from ${source.periodStartDate} – ${source.periodEndDate}`, status: 'applied',
        sourceSettlementId: source.id, createdBy: CARRY_FORWARD_ACTOR, approvedBy: actorId, approvedAt: at, appliedAt: at, createdAt: at, updatedAt: at,
      });
    }
    return sources.map((x) => ({ fromStatementId: x.id, amountTzs: x.carryForwardTzs }));
  }

  /** draft → submitted. Pulls in any shortfall carried forward, then freezes the amounts. */
  const submit = ({ id, actorId }, opts) => step(id, 'submitted', actorId, async (s, q) => {
    if (s.status !== 'draft') return wrongStatus(s, 'draft');
    const run = await q('SettlementRun').where({ id: s.runId }).first('status');
    if (run?.status !== 'locked') return fail('run_not_locked');
    const pending = await q('SettlementAdjustment').where({ gymSettlementId: id, status: 'proposed' }).first('id');
    if (pending) return fail('pending_adjustments');
    const carriedForward = await pullCarryForward(q, s, actorId);
    return {
      patch: { ...(await retotal(q, s)), status: 'submitted', submittedBy: actorId, submittedAt: now(), rejectedBy: null, rejectedAt: null, rejectReason: null },
      audit: carriedForward.length ? { carriedForward } : {},
    };
  }, opts);

  /** submitted → draft, with a reason. */
  const reject = ({ id, reason, actorId }, opts) => step(id, 'rejected', actorId, async (s) => {
    if (s.status !== 'submitted') return wrongStatus(s, 'submitted');
    if (!text(reason)) return fail('reason_required', 400);
    return {
      patch: { status: 'draft', submittedBy: null, submittedAt: null, rejectedBy: actorId, rejectedAt: now(), rejectReason: text(reason) },
      audit: { reason: text(reason) },
    };
  }, opts);

  /** submitted → approved, by someone other than the submitter. */
  const approve = ({ id, actorId }, opts) => step(id, 'approved', actorId, async (s) => {
    if (s.status !== 'submitted') return wrongStatus(s, 'submitted');
    if (s.submittedBy === actorId) return fail('cannot_approve_own_submission', 403);
    return { patch: { status: 'approved', approvedBy: actorId, approvedAt: now() } };
  }, opts);

  /** Put a statement on hold. A payable one goes back to approved. */
  const hold = ({ id, reason, actorId }, opts) => step(id, 'held', actorId, async (s) => {
    if (!HOLDABLE.includes(s.status)) return wrongStatus(s, HOLDABLE.join('|'));
    if (!text(reason)) return fail('reason_required', 400);
    const patch = { holdReason: text(reason), heldBy: actorId, heldAt: now() };
    if (s.status === 'payable') Object.assign(patch, { status: 'approved', payableAt: null, destinationSnapshot: null });
    return { patch, audit: { reason: text(reason) } };
  }, opts);

  /** Lift a hold. The statement keeps its status. */
  const release = ({ id, actorId }, opts) => step(id, 'released', actorId, async (s) => {
    if (!s.holdReason) return fail('not_on_hold');
    return { patch: { holdReason: null, heldBy: null, heldAt: null } };
  }, opts);

  /** approved → payable, when nothing holds it and the gym can be paid. */
  const markPayable = ({ id, actorId }, opts) => step(id, 'payable', actorId, async (s) => {
    if (s.status !== 'approved') return wrongStatus(s, 'approved');
    if (s.holdReason) return fail('on_hold', 409, { holdReason: s.holdReason });
    if (!(s.finalNetTzs > 0)) return fail('nothing_to_pay');
    const check = await payoutEligibility.forGym(s.gymId, { at: now() });
    if (!check.ok) return fail('not_payable', 409, { reason: check.reason, ...(check.until ? { until: check.until } : {}) });
    return { patch: { status: 'payable', payableAt: now(), destinationSnapshot: JSON.stringify(check.destination) }, audit: { destination: check.destination } };
  }, opts);

  /** payable → paid: record that the money went, and the payout. */
  const pay = ({ id, paymentReference, receiptUrl, actorId }, opts) => step(id, 'paid', actorId, async (s, q) => {
    if (s.status !== 'payable') return wrongStatus(s, 'payable');
    if (!text(paymentReference)) return fail('payment_reference_required', 400);
    // The gym's standing may have changed since it was cleared.
    const check = await payoutEligibility.forGym(s.gymId, { at: now() });
    if (!check.ok) return fail('not_payable', 409, { reason: check.reason, ...(check.until ? { until: check.until } : {}) });
    const at = now();
    const payout = {
      id: randomUUID(), gymId: s.gymId, gymSettlementId: s.id, gymSettlementMode: 'live', amount: s.finalNetTzs, status: 'paid',
      periodStart: s.periodStartDate, periodEnd: s.periodEndDate, paidAt: at, reference: text(paymentReference),
    };
    await q('GymPayout').insert(payout);
    return {
      patch: { status: 'paid', paidBy: actorId, paidAt: at, paymentReference: text(paymentReference), receiptUrl: receiptUrl || null, destinationSnapshot: JSON.stringify(check.destination) },
      audit: { amountTzs: s.finalNetTzs, paymentReference: text(paymentReference), payoutId: payout.id, destination: check.destination },
      extra: { payout },
    };
  }, opts);

  /**
   * draft | submitted | approved → voided: the statement will never be paid.
   * A payable statement has to be put on hold first (back to approved); a
   * paid one is final.
   */
  const voidStatement = ({ id, reason, actorId }, opts) => step(id, 'voided', actorId, async (s, q) => {
    if (!VOIDABLE.includes(s.status)) return wrongStatus(s, VOIDABLE.join('|'));
    if (!text(reason)) return fail('reason_required', 400);
    const at = now();
    const cancelledAdjustments = await q('SettlementAdjustment').where({ gymSettlementId: id }).whereIn('status', ['proposed', 'applied'])
      .update({ status: 'voided', updatedAt: at });
    return {
      patch: { status: 'voided', voidedBy: actorId, voidedAt: at, voidReason: text(reason) },
      audit: { reason: text(reason), finalNetTzs: s.finalNetTzs, cancelledAdjustments },
      extra: { cancelledAdjustments },
    };
  }, opts);

  // ── adjustments (DR-20) ─────────────────────────────────────────────────────

  /** Propose a signed correction or clawback on a draft statement. */
  async function proposeAdjustment({ statementId, amountTzs, type = 'correction', reason, sourceCheckinId = null, sourceSettlementId = null, actorId }, { trx } = {}) {
    if (!actorId) return fail('actor_required', 403);
    if (!MANUAL_ADJUSTMENT_TYPES.includes(type)) return fail('invalid_adjustment_type', 400);
    if (!Number.isSafeInteger(amountTzs) || amountTzs === 0) return fail('amount_must_be_whole_nonzero_tzs', 400);
    if (type === 'clawback' && amountTzs > 0) return fail('clawback_must_be_negative', 400);
    if (!text(reason)) return fail('reason_required', 400);
    return (trx || db).transaction(async (q) => {
      const statement = await q('GymSettlement').where({ id: statementId }).forUpdate().first();
      if (!statement) return fail('statement_not_found', 404);
      if (statement.mode !== 'live') return fail('shadow_statement');
      if (statement.status !== 'draft') return wrongStatus(statement, 'draft');
      const at = now();
      const adjustment = {
        id: randomUUID(), gymSettlementId: statementId, amountTzs, type, reason: text(reason), status: 'proposed',
        sourceSettlementId, sourceCheckinId, createdBy: actorId, createdAt: at, updatedAt: at,
      };
      await q('SettlementAdjustment').insert(adjustment);
      await q('AuditLog').insert({ id: randomUUID(), at, actor: actorId, action: 'settlement_adjustment_proposed', target: adjustment.id, before: null,
        after: JSON.stringify({ gymSettlementId: statementId, amountTzs, type, reason: text(reason) }) });
      return { adjustment };
    });
  }

  /** Apply (approve) or reject a proposed adjustment. The approver must not be the proposer. */
  async function decideAdjustment({ id, decision, reason, actorId }, { trx } = {}) {
    if (!actorId) return fail('actor_required', 403);
    if (!['apply', 'reject'].includes(decision)) return fail('invalid_decision', 400);
    return (trx || db).transaction(async (q) => {
      const adjustment = await q('SettlementAdjustment').where({ id }).forUpdate().first();
      if (!adjustment) return fail('adjustment_not_found', 404);
      if (adjustment.status !== 'proposed') return fail('invalid_status', 409, { currentStatus: adjustment.status, expected: 'proposed' });
      const statement = await q('GymSettlement').where({ id: adjustment.gymSettlementId }).forUpdate().first();
      const at = now();
      if (decision === 'reject') {
        if (!text(reason)) return fail('reason_required', 400);
        await q('SettlementAdjustment').where({ id }).update({ status: 'rejected', rejectedBy: actorId, rejectReason: text(reason), updatedAt: at });
      } else {
        if (adjustment.createdBy === actorId) return fail('cannot_approve_own_adjustment', 403);
        if (statement.status !== 'draft') return wrongStatus(statement, 'draft');
        await q('SettlementAdjustment').where({ id }).update({ status: 'applied', approvedBy: actorId, approvedAt: at, appliedAt: at, updatedAt: at });
        await q('GymSettlement').where({ id: statement.id }).update({ ...(await retotal(q, statement)), updatedAt: at });
      }
      const updated = await q('SettlementAdjustment').where({ id }).first();
      const after = await q('GymSettlement').where({ id: statement.id }).first();
      await q('AuditLog').insert({ id: randomUUID(), at, actor: actorId, action: `settlement_adjustment_${decision === 'apply' ? 'applied' : 'rejected'}`, target: id,
        before: JSON.stringify({ status: 'proposed', finalNetTzs: statement.finalNetTzs }),
        after: JSON.stringify({ status: updated.status, amountTzs: updated.amountTzs, finalNetTzs: after.finalNetTzs, carryForwardTzs: after.carryForwardTzs, ...(decision === 'reject' ? { reason: text(reason) } : {}) }) });
      return { adjustment: updated, statement: after };
    });
  }

  /** Statements, newest period first. Live by default. */
  async function list({ status, gymId, mode = 'live', limit = 100 } = {}) {
    const query = db('GymSettlement').where({ mode }).orderBy([{ column: 'periodStartDate', order: 'desc' }, { column: 'gymId' }]).limit(Math.min(Number(limit) || 100, 500));
    if (status) query.where({ status });
    if (gymId) query.where({ gymId });
    return query;
  }

  return { submit, reject, approve, hold, release, markPayable, pay, voidStatement, list, proposeAdjustment, decideAdjustment };
}
