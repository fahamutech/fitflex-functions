// Settlement workflow (settlement Phase 4): a gym statement's path from the
// engine's draft to a recorded payout.
//
//   draft ──submit──► submitted ──approve──► approved ──payable──► payable ──pay──► paid
//     ▲                  │                      ▲                     │
//     └──── reject ──────┘                      └────── hold ─────────┘
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
// Each step is one transaction with the row locked, and is audited.
import { randomUUID } from 'node:crypto';
import { db as defaultDb } from '../infra/knex-store.mjs';

const fail = (error, status = 409, extra = {}) => ({ error, status, ...extra });
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const HOLDABLE = ['draft', 'submitted', 'approved', 'payable'];

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

  const wrongStatus = (statement, expected) => fail('invalid_status', 409, { status: statement.status, expected });

  /** draft → submitted. Freezes the amounts. */
  const submit = ({ id, actorId }, opts) => step(id, 'submitted', actorId, async (s, q) => {
    if (s.status !== 'draft') return wrongStatus(s, 'draft');
    const run = await q('SettlementRun').where({ id: s.runId }).first('status');
    if (run?.status !== 'locked') return fail('run_not_locked');
    return { patch: { status: 'submitted', submittedBy: actorId, submittedAt: now(), rejectedBy: null, rejectedAt: null, rejectReason: null } };
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

  /** Statements, newest period first. Live by default. */
  async function list({ status, gymId, mode = 'live', limit = 100 } = {}) {
    const query = db('GymSettlement').where({ mode }).orderBy([{ column: 'periodStartDate', order: 'desc' }, { column: 'gymId' }]).limit(Math.min(Number(limit) || 100, 500));
    if (status) query.where({ status });
    if (gymId) query.where({ gymId });
    return query;
  }

  return { submit, reject, approve, hold, release, markPayable, pay, list };
}
