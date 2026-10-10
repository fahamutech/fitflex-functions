// Trainer payouts — a weekly statement per trainer, on the same path as a
// gym statement:
//
//   draft ──submit──► submitted ──approve──► approved ──payable──► payable ──pay──► paid
//     ▲                  │                      ▲                     │
//     └──── reject ──────┘                      └────── hold ─────────┘
//
//   draft | submitted | approved ──void──► voided
//
// What a trainer is paid for: a session they marked completed, or a paid
// session that was never cancelled and whose time passed more than 48 hours
// ago (it took place, or the member did not show — which is not refunded).
// Each session's payout was fixed when it was booked (trainerPayoutTzs).
//
// - A week runs Monday to Sunday, East Africa Time. A statement is prepared
//   once its week has ended, and also picks up earlier sessions that only
//   became payable since (a late "completed", or the 48 hours running out).
// - A session is paid once: it sits on one live statement line. Voiding a
//   statement releases its sessions, so the next statement picks them up.
// - Maker-checker: whoever submitted a statement can't approve it.
// - A hold blocks "payable" and "paid", and pulls a payable statement back
//   to approved.
// - The payout check runs when a statement is marked payable and again when
//   it is paid: the trainer needs approved KYC and a verified payout account.
//
// Each step is one transaction with the row locked, and is audited.
import { randomUUID } from 'node:crypto';
import { db as defaultDb } from '../infra/knex-store.mjs';

/** Hours after a session's start before an unmarked session counts as having taken place. */
export const TOOK_PLACE_AFTER_HOURS = 48;

const fail = (error, status = 409, extra = {}) => ({ error, status, ...extra });
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const DAY_MS = 86_400_000;
const EAT_MS = 3 * 3_600_000;
const HOLDABLE = ['draft', 'submitted', 'approved', 'payable'];
const VOIDABLE = ['draft', 'submitted', 'approved'];
const STATUSES = ['draft', 'submitted', 'approved', 'payable', 'paid', 'voided'];
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayOf = (v) => (v instanceof Date ? iso(+v + EAT_MS) : String(v).slice(0, 10));

/** Today's date in East Africa Time (YYYY-MM-DD). */
export const eatToday = (now = new Date()) => iso(+now + EAT_MS);

/** The Monday–Sunday week containing a date (YYYY-MM-DD). */
export function weekOf(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const mondayOffset = (new Date(ms).getUTCDay() + 6) % 7;
  const start = ms - mondayOffset * DAY_MS;
  return { periodStartDate: iso(start), periodEndDate: iso(start + 6 * DAY_MS) };
}

/** The last week that has fully ended (EAT). */
export function lastEndedWeek(now = new Date()) {
  const thisWeek = weekOf(eatToday(now));
  return weekOf(iso(Date.parse(`${thisWeek.periodStartDate}T00:00:00Z`) - DAY_MS));
}

/**
 * Why a booking is payable now, or null. `completed`: the trainer marked it.
 * `took_place`: paid, never cancelled, and its time passed long enough ago.
 */
export function payableBasis(booking, now = new Date()) {
  if (!(Number(booking.trainerPayoutTzs) > 0)) return null;
  if (booking.status === 'completed') return 'completed';
  if (booking.status !== 'confirmed') return null;
  const start = Date.parse(`${booking.date}T${booking.slot || '00:00'}:00.000+03:00`);
  if (Number.isNaN(start)) return null;
  return start + TOOK_PLACE_AFTER_HOURS * 3_600_000 <= +now ? 'took_place' : null;
}

export function createTrainerSettlementService({
  db = defaultDb, trainers, users = null, payoutEligibility,
  notify = async () => {},   // (userId, { type, title, body, data })
  now = () => new Date(),
} = {}) {
  const trainerOf = (id) => trainers?.find((t) => t.id === id) || null;
  const money = (n) => `TZS ${Number(n || 0).toLocaleString('en-US')}`;
  const shape = (s) => (s ? { ...s, periodStartDate: dayOf(s.periodStartDate), periodEndDate: dayOf(s.periodEndDate) } : s);

  async function audit(q, action, actorId, target, before, after) {
    await q('AuditLog').insert({ id: randomUUID(), at: now(), actor: actorId, action: `trainer_settlement_${action}`, target, before: before ? JSON.stringify(before) : null, after: JSON.stringify(after) });
  }

  // ── preparing ───────────────────────────────────────────────────────────────

  /**
   * Prepare draft statements for a week that has ended (default: the last
   * one). A trainer with nothing payable gets none. An existing draft for
   * the same week is rebuilt; a statement already submitted is left alone
   * and anything new waits for the next week's statement.
   */
  async function prepare({ periodStart = null, actorId } = {}) {
    if (!actorId) return fail('actor_required', 403);
    const at = now();
    const week = periodStart ? weekOf(periodStart) : lastEndedWeek(at);
    if (periodStart && week.periodStartDate !== periodStart) return fail('period_must_start_on_monday', 400, { monday: week.periodStartDate });
    if (week.periodEndDate >= eatToday(at)) return fail('week_not_ended', 400, { periodEndDate: week.periodEndDate });

    return db.transaction(async (q) => {
      // Sessions already on a live line are settled; a draft for this week is rebuilt below.
      const drafts = await q('TrainerSettlement').where({ periodStartDate: week.periodStartDate, status: 'draft' }).forUpdate();
      const draftIds = drafts.map((d) => d.id);
      if (draftIds.length) await q('TrainerSettlementLine').whereIn('trainerSettlementId', draftIds).del();

      const candidates = await q('TrainerBooking as b')
        .whereIn('b.status', ['completed', 'confirmed']).where('b.date', '<=', week.periodEndDate).where('b.trainerPayoutTzs', '>', 0)
        .whereNotExists(q('TrainerSettlementLine as l').whereRaw('l."bookingId" = b."id"').where('l.voided', false).select(1))
        .select('b.*').orderBy(['b.date', 'b.slot']);

      const byTrainer = new Map();
      for (const b of candidates) {
        const basis = payableBasis(b, at);
        if (!basis) continue;
        if (!byTrainer.has(b.trainerId)) byTrainer.set(b.trainerId, []);
        byTrainer.get(b.trainerId).push({ booking: b, basis });
      }

      const locked = new Set((await q('TrainerSettlement').where({ periodStartDate: week.periodStartDate }).whereNotIn('status', ['draft', 'voided'])).map((s) => s.trainerId));
      const draftByTrainer = new Map(drafts.map((d) => [d.trainerId, d]));
      const out = { ...week, prepared: 0, rebuilt: 0, skipped: 0, removed: 0, statements: [] };

      for (const [trainerId, sessions] of byTrainer) {
        if (locked.has(trainerId)) { out.skipped += 1; continue; }
        const totals = sessions.reduce((t, { booking: b }) => ({
          listTzs: t.listTzs + Number(b.listPriceTzs ?? b.amountTzs ?? 0),
          commissionTzs: t.commissionTzs + Number(b.commissionTzs || 0),
          finalNetTzs: t.finalNetTzs + Number(b.trainerPayoutTzs || 0),
        }), { listTzs: 0, commissionTzs: 0, finalNetTzs: 0 });
        const existing = draftByTrainer.get(trainerId);
        const id = existing?.id || `tst_${randomUUID().slice(0, 12)}`;
        const fields = { sessionCount: sessions.length, ...totals, preparedBy: actorId, updatedAt: at };
        if (existing) {
          await q('TrainerSettlement').where({ id }).update(fields);
          draftByTrainer.delete(trainerId);
          out.rebuilt += 1;
        } else {
          await q('TrainerSettlement').insert({ id, trainerId, periodStartDate: week.periodStartDate, periodEndDate: week.periodEndDate, status: 'draft', ...fields, createdAt: at });
          out.prepared += 1;
        }
        await q('TrainerSettlementLine').insert(sessions.map(({ booking: b, basis }) => ({
          id: randomUUID(), trainerSettlementId: id, bookingId: b.id, memberId: b.memberId, gymId: b.gymId, date: b.date, slot: b.slot, basis,
          listPriceTzs: Number(b.listPriceTzs ?? b.amountTzs ?? 0), memberPaidTzs: Number(b.amountTzs || 0),
          commissionTzs: Number(b.commissionTzs || 0), payoutTzs: Number(b.trainerPayoutTzs || 0), createdAt: at,
        })));
        out.statements.push({ id, trainerId, sessionCount: sessions.length, finalNetTzs: totals.finalNetTzs });
      }
      // A draft whose sessions have all gone (cancelled since) has nothing left to pay.
      for (const stale of draftByTrainer.values()) {
        await q('TrainerSettlement').where({ id: stale.id }).del();
        out.removed += 1;
      }
      await audit(q, 'prepared', actorId, week.periodStartDate, null, { ...week, prepared: out.prepared, rebuilt: out.rebuilt, skipped: out.skipped, removed: out.removed });
      return out;
    });
  }

  // ── workflow ────────────────────────────────────────────────────────────────

  /** Lock the statement, run `fn`, apply its patch, audit. */
  async function step(id, action, actorId, fn) {
    if (!actorId) return fail('actor_required', 403);
    const result = await db.transaction(async (q) => {
      const statement = await q('TrainerSettlement').where({ id }).forUpdate().first();
      if (!statement) return fail('statement_not_found', 404);
      const out = await fn(statement, q);
      if (out.error) return out;
      await q('TrainerSettlement').where({ id }).update({ ...out.patch, updatedAt: now() });
      const updated = await q('TrainerSettlement').where({ id }).first();
      await audit(q, action, actorId, id, { status: statement.status, holdReason: statement.holdReason }, { status: updated.status, holdReason: updated.holdReason, ...(out.audit || {}) });
      return { statement: shape(updated) };
    });
    return result;
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

  /** approved → payable, when nothing holds it and the trainer can be paid. */
  const markPayable = ({ id, actorId }) => step(id, 'payable', actorId, async (s) => {
    if (s.status !== 'approved') return wrongStatus(s, 'approved');
    if (s.holdReason) return fail('on_hold', 409, { holdReason: s.holdReason });
    const check = await payoutEligibility.forTrainer(s.trainerId, { at: now() });
    if (!check.ok) return notPayable(check);
    return { patch: { status: 'payable', payableAt: now(), destinationSnapshot: JSON.stringify(check.destination) }, audit: { destination: check.destination } };
  });

  /** payable → paid: record that the money went, and tell the trainer. */
  async function pay({ id, paymentReference, receiptUrl, actorId }) {
    const out = await step(id, 'paid', actorId, async (s) => {
      if (s.status !== 'payable') return wrongStatus(s, 'payable');
      if (!text(paymentReference)) return fail('payment_reference_required', 400);
      // The trainer's standing may have changed since the statement was cleared.
      const check = await payoutEligibility.forTrainer(s.trainerId, { at: now() });
      if (!check.ok) return notPayable(check);
      return {
        patch: { status: 'paid', paidBy: actorId, paidAt: now(), paymentReference: text(paymentReference), receiptUrl: receiptUrl || null, destinationSnapshot: JSON.stringify(check.destination) },
        audit: { amountTzs: s.finalNetTzs, paymentReference: text(paymentReference), destination: check.destination },
      };
    });
    if (out.statement) {
      const trainer = trainerOf(out.statement.trainerId);
      try {
        await notify(trainer?.userId, {
          id: `ntf_trainer_payout_${out.statement.id}`, type: 'trainer_payout_paid', title: 'Payout sent',
          body: `FitFlex sent you ${money(out.statement.finalNetTzs)} for ${out.statement.sessionCount} session(s), ${out.statement.periodStartDate} to ${out.statement.periodEndDate}. Reference: ${out.statement.paymentReference}.`,
          data: { statementId: out.statement.id },
        });
      } catch { /* the payment itself is recorded */ }
    }
    return out;
  }

  /**
   * draft | submitted | approved → voided: this statement will not be paid.
   * Its sessions are released, so the next statement prepared picks them up.
   */
  const voidStatement = ({ id, reason, actorId }) => step(id, 'voided', actorId, async (s, q) => {
    if (!VOIDABLE.includes(s.status)) return wrongStatus(s, VOIDABLE.join('|'));
    if (!text(reason)) return fail('reason_required', 400);
    const released = await q('TrainerSettlementLine').where({ trainerSettlementId: id, voided: false }).update({ voided: true });
    return { patch: { status: 'voided', voidedBy: actorId, voidedAt: now(), voidReason: text(reason) }, audit: { reason: text(reason), finalNetTzs: s.finalNetTzs, releasedSessions: released } };
  });

  // ── reading ─────────────────────────────────────────────────────────────────

  const withTrainer = (s) => {
    const t = trainerOf(s.trainerId);
    // A statement is paid to a person: it carries the trainer's own name as
    // well as the name clients see (the nickname, when there is one).
    return {
      ...shape(s),
      trainer: t ? {
        id: t.id, displayName: t.displayName || null, fullName: t.fullName || t.displayName || null,
        nickname: t.nickname || null, userId: t.userId || null,
      } : null,
    };
  };

  /** Admin: statements, newest week first. */
  async function list({ status, trainerId, limit = 200 } = {}) {
    if (status && !STATUSES.includes(status)) return fail('invalid_status', 400, { allowed: STATUSES });
    const query = db('TrainerSettlement').orderBy([{ column: 'periodStartDate', order: 'desc' }, { column: 'trainerId' }]).limit(Math.min(Number(limit) || 200, 500));
    if (status) query.where({ status });
    if (trainerId) query.where({ trainerId });
    return { statements: (await query).map(withTrainer) };
  }

  async function linesOf(id, { includeVoided = false } = {}) {
    const query = db('TrainerSettlementLine').where({ trainerSettlementId: id }).orderBy(['date', 'slot']);
    if (!includeVoided) query.where({ voided: false });
    const lines = await query;
    const people = users ? await users.filterByColumnInAsync('id', [...new Set(lines.map((l) => l.memberId).filter(Boolean))]) : [];
    const names = new Map(people.map((u) => [u.id, u.displayName || null]));
    return lines.map((l) => ({ ...l, memberName: names.get(l.memberId) ?? null }));
  }

  /** Admin: one statement with its sessions and whether the trainer can be paid now. */
  async function get(id) {
    const statement = await db('TrainerSettlement').where({ id }).first();
    if (!statement) return fail('statement_not_found', 404);
    const payout = await payoutEligibility.forTrainer(statement.trainerId, { at: now() });
    return { statement: withTrainer(statement), lines: await linesOf(id, { includeVoided: statement.status === 'voided' }), payout };
  }

  // A trainer sees a statement once it has been sent for approval.
  const VISIBLE_TO_TRAINER = ['submitted', 'approved', 'payable', 'paid'];
  const forTrainerView = (s) => {
    const { preparedBy, submittedBy, approvedBy, rejectedBy, heldBy, paidBy, voidedBy, destinationSnapshot, ...rest } = shape(s);
    const dest = typeof destinationSnapshot === 'string' ? JSON.parse(destinationSnapshot) : destinationSnapshot;
    return { ...rest, onHold: Boolean(s.holdReason), paidTo: dest ? { method: dest.method ?? null, provider: dest.provider ?? null, accountLast4: dest.accountLast4 ?? null } : null };
  };

  /** Trainer: my statements, and whether my payout account is ready. */
  async function listMine({ trainerId }) {
    const rows = await db('TrainerSettlement').where({ trainerId }).whereIn('status', VISIBLE_TO_TRAINER).orderBy('periodStartDate', 'desc').limit(100);
    const payout = await payoutEligibility.forTrainer(trainerId, { at: now() });
    return { statements: rows.map(forTrainerView), payoutReady: payout.ok, payoutBlockedBy: payout.ok ? null : payout.reason };
  }

  /** Trainer: one of my statements with its sessions. */
  async function getMine({ trainerId, id }) {
    const statement = await db('TrainerSettlement').where({ id, trainerId }).whereIn('status', VISIBLE_TO_TRAINER).first();
    if (!statement) return fail('statement_not_found', 404);
    return { statement: forTrainerView(statement), lines: await linesOf(id) };
  }

  return { prepare, submit, reject, approve, hold, release, markPayable, pay, voidStatement, list, get, listMine, getMine };
}
