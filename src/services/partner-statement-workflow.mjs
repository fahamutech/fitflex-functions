// The path a trainer or vendor payout statement takes from draft to paid,
// shared by both:
//
//   draft ──submit──► submitted ──approve──► approved ──payable──► payable ──pay──► paid
//     ▲                  │                      ▲                     │
//     └──── reject ──────┘                      └────── hold ─────────┘
//
//   draft | submitted | approved ──void──► voided
//
// - Maker-checker: whoever submitted a statement can't approve it.
// - A hold blocks "payable" and "paid", and pulls a payable statement back
//   to approved. Releasing it doesn't make the statement payable by itself.
// - The payout check runs when a statement is marked payable and again when
//   it is paid.
// - Voiding an unpaid statement releases its lines, so the next statement
//   prepared picks them up.
//
// Each step is one transaction with the row locked, and is audited.
import { randomUUID } from 'node:crypto';

export const STATEMENT_STATUSES = ['draft', 'submitted', 'approved', 'payable', 'paid', 'voided'];
const HOLDABLE = ['draft', 'submitted', 'approved', 'payable'];
const VOIDABLE = ['draft', 'submitted', 'approved'];

export const fail = (error, status = 409, extra = {}) => ({ error, status, ...extra });
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * @param {object} deps
 * @param {import('knex').Knex} deps.db
 * @param {string} deps.table        statement table, e.g. 'TrainerSettlement'
 * @param {string} deps.lineTable    its lines, e.g. 'TrainerSettlementLine'
 * @param {string} deps.lineKey      the lines' reference to the statement
 * @param {string} deps.auditPrefix  e.g. 'trainer_settlement'
 * @param {(statement: object, at: Date) => Promise<{ok: boolean, reason?: string, until?: string, destination?: object}>} deps.payoutCheck
 * @param {(statement: object, q: import('knex').Knex) => Promise<void>} [deps.onPaid]  inside the paying transaction
 * @param {() => Date} [deps.now]
 */
export function createStatementWorkflow({ db, table, lineTable, lineKey, auditPrefix, payoutCheck, onPaid = async () => {}, now = () => new Date() }) {
  async function audit(q, action, actorId, target, before, after) {
    await q('AuditLog').insert({ id: randomUUID(), at: now(), actor: actorId, action: `${auditPrefix}_${action}`, target, before: before ? JSON.stringify(before) : null, after: JSON.stringify(after) });
  }

  /** Lock the statement, run `fn`, apply its patch, audit. */
  async function step(id, action, actorId, fn) {
    if (!actorId) return fail('actor_required', 403);
    return db.transaction(async (q) => {
      const statement = await q(table).where({ id }).forUpdate().first();
      if (!statement) return fail('statement_not_found', 404);
      const out = await fn(statement, q);
      if (out.error) return out;
      await q(table).where({ id }).update({ ...out.patch, updatedAt: now() });
      const updated = await q(table).where({ id }).first();
      if (out.after) await out.after(updated, q);
      await audit(q, action, actorId, id, { status: statement.status, holdReason: statement.holdReason }, { status: updated.status, holdReason: updated.holdReason, ...(out.audit || {}) });
      return { statement: updated };
    });
  }

  const wrongStatus = (s, expected) => fail('invalid_status', 409, { currentStatus: s.status, expected });
  const notPayable = (check) => fail('not_payable', 409, { reason: check.reason, ...(check.until ? { until: check.until } : {}) });

  /** draft → submitted: the amounts are frozen. */
  const submit = ({ id, actorId }) => step(id, 'submitted', actorId, async (s) => {
    if (s.status !== 'draft') return wrongStatus(s, 'draft');
    if (!(s.finalNetTzs > 0)) return fail('nothing_to_pay');
    return { patch: { status: 'submitted', submittedBy: actorId, submittedAt: now(), rejectedBy: null, rejectedAt: null, rejectReason: null } };
  });

  /** submitted → draft, with a reason. */
  const reject = ({ id, reason, actorId }) => step(id, 'rejected', actorId, async (s) => {
    if (s.status !== 'submitted') return wrongStatus(s, 'submitted');
    if (!text(reason)) return fail('reason_required', 400);
    return { patch: { status: 'draft', submittedBy: null, submittedAt: null, rejectedBy: actorId, rejectedAt: now(), rejectReason: text(reason) }, audit: { reason: text(reason) } };
  });

  /** submitted → approved, by someone other than the submitter. */
  const approve = ({ id, actorId }) => step(id, 'approved', actorId, async (s) => {
    if (s.status !== 'submitted') return wrongStatus(s, 'submitted');
    if (s.submittedBy === actorId) return fail('cannot_approve_own_submission', 403);
    return { patch: { status: 'approved', approvedBy: actorId, approvedAt: now() } };
  });

  /** Put a statement on hold. A payable one goes back to approved. */
  const hold = ({ id, reason, actorId }) => step(id, 'held', actorId, async (s) => {
    if (!HOLDABLE.includes(s.status)) return wrongStatus(s, HOLDABLE.join('|'));
    if (!text(reason)) return fail('reason_required', 400);
    const patch = { holdReason: text(reason), heldBy: actorId, heldAt: now() };
    if (s.status === 'payable') Object.assign(patch, { status: 'approved', payableAt: null, destinationSnapshot: null });
    return { patch, audit: { reason: text(reason) } };
  });

  /** Lift a hold. The statement keeps its status. */
  const release = ({ id, actorId }) => step(id, 'released', actorId, async (s) => {
    if (!s.holdReason) return fail('not_on_hold');
    return { patch: { holdReason: null, heldBy: null, heldAt: null } };
  });

  /** approved → payable, when nothing holds it and the partner can be paid. */
  const markPayable = ({ id, actorId }) => step(id, 'payable', actorId, async (s) => {
    if (s.status !== 'approved') return wrongStatus(s, 'approved');
    if (s.holdReason) return fail('on_hold', 409, { holdReason: s.holdReason });
    const check = await payoutCheck(s, now());
    if (!check.ok) return notPayable(check);
    return { patch: { status: 'payable', payableAt: now(), destinationSnapshot: JSON.stringify(check.destination) }, audit: { destination: check.destination } };
  });

  /** payable → paid: record that the money went. */
  const pay = ({ id, paymentReference, receiptUrl, actorId }) => step(id, 'paid', actorId, async (s) => {
    if (s.status !== 'payable') return wrongStatus(s, 'payable');
    if (!text(paymentReference)) return fail('payment_reference_required', 400);
    // The partner's standing may have changed since the statement was cleared.
    const check = await payoutCheck(s, now());
    if (!check.ok) return notPayable(check);
    return {
      patch: { status: 'paid', paidBy: actorId, paidAt: now(), paymentReference: text(paymentReference), receiptUrl: receiptUrl || null, destinationSnapshot: JSON.stringify(check.destination) },
      audit: { amountTzs: s.finalNetTzs, paymentReference: text(paymentReference), destination: check.destination },
      after: onPaid,
    };
  });

  /** draft | submitted | approved → voided: this statement will not be paid; its lines are released. */
  const voidStatement = ({ id, reason, actorId }) => step(id, 'voided', actorId, async (s, q) => {
    if (!VOIDABLE.includes(s.status)) return wrongStatus(s, VOIDABLE.join('|'));
    if (!text(reason)) return fail('reason_required', 400);
    const released = await q(lineTable).where({ [lineKey]: id, voided: false }).update({ voided: true });
    return { patch: { status: 'voided', voidedBy: actorId, voidedAt: now(), voidReason: text(reason) }, audit: { reason: text(reason), finalNetTzs: s.finalNetTzs, released } };
  });

  return { audit, submit, reject, approve, hold, release, markPayable, pay, voidStatement };
}

// ── Weeks (East Africa Time) ──────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const EAT_MS = 3 * 3_600_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A moment's date in East Africa Time (YYYY-MM-DD). */
export const eatDate = (at = new Date()) => iso(+new Date(at) + EAT_MS);

/** The Monday–Sunday week containing a date (YYYY-MM-DD). */
export function weekOf(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const mondayOffset = (new Date(ms).getUTCDay() + 6) % 7;
  const start = ms - mondayOffset * DAY_MS;
  return { periodStartDate: iso(start), periodEndDate: iso(start + 6 * DAY_MS) };
}

/** The last week that has fully ended (EAT). */
export function lastEndedWeek(now = new Date()) {
  const thisWeek = weekOf(eatDate(now));
  return weekOf(iso(Date.parse(`${thisWeek.periodStartDate}T00:00:00Z`) - DAY_MS));
}

/** The week to prepare: `periodStart` (a Monday, already ended) or the last ended one. */
export function weekToPrepare(periodStart, at) {
  const week = periodStart ? weekOf(periodStart) : lastEndedWeek(at);
  if (periodStart && week.periodStartDate !== periodStart) return fail('period_must_start_on_monday', 400, { monday: week.periodStartDate });
  if (week.periodEndDate >= eatDate(at)) return fail('week_not_ended', 400, { periodEndDate: week.periodEndDate });
  return week;
}

/** What a partner may see of their own statement: no staff ids, and only where it was paid. */
export function partnerView(statement) {
  const { preparedBy, submittedBy, approvedBy, rejectedBy, heldBy, paidBy, voidedBy, destinationSnapshot, ...rest } = statement;
  const dest = typeof destinationSnapshot === 'string' ? JSON.parse(destinationSnapshot) : destinationSnapshot;
  return { ...rest, onHold: Boolean(statement.holdReason), paidTo: dest ? { method: dest.method ?? null, provider: dest.provider ?? null, accountLast4: dest.accountLast4 ?? null } : null };
}

/** Statuses a partner sees: from the moment a statement is sent for approval. */
export const VISIBLE_TO_PARTNER = ['submitted', 'approved', 'payable', 'paid'];
