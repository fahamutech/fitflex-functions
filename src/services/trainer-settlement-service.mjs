// Trainer payouts — a weekly statement per trainer, on the shared statement
// path (partner-statement-workflow): draft → submitted → approved → payable
// → paid, or voided.
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
// - The payout check: the trainer needs approved KYC and a verified payout
//   account past its 48-hour hold.
import { randomUUID } from 'node:crypto';
import { db as defaultDb } from '../infra/knex-store.mjs';
import {
  createStatementWorkflow, fail, weekOf, lastEndedWeek, weekToPrepare, eatDate, partnerView, STATEMENT_STATUSES, VISIBLE_TO_PARTNER,
} from './partner-statement-workflow.mjs';

export { weekOf, lastEndedWeek };
/** Today's date in East Africa Time (YYYY-MM-DD). */
export const eatToday = (now = new Date()) => eatDate(now);

/** Hours after a session's start before an unmarked session counts as having taken place. */
export const TOOK_PLACE_AFTER_HOURS = 48;

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

  const workflow = createStatementWorkflow({
    db, now, table: 'TrainerSettlement', lineTable: 'TrainerSettlementLine', lineKey: 'trainerSettlementId', auditPrefix: 'trainer_settlement',
    payoutCheck: (s, at) => payoutEligibility.forTrainer(s.trainerId, { at }),
  });

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
    const week = weekToPrepare(periodStart, at);
    if (week.error) return week;

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
      await workflow.audit(q, 'prepared', actorId, week.periodStartDate, null, { ...week, prepared: out.prepared, rebuilt: out.rebuilt, skipped: out.skipped, removed: out.removed });
      return out;
    });
  }

  /** payable → paid: record that the money went, and tell the trainer. */
  async function pay(args) {
    const out = await workflow.pay(args);
    if (out.statement) {
      const s = out.statement;
      try {
        await notify(trainerOf(s.trainerId)?.userId, {
          id: `ntf_trainer_payout_${s.id}`, type: 'trainer_payout_paid', title: 'Payout sent',
          body: `FitFlex sent you ${money(s.finalNetTzs)} for ${s.sessionCount} session(s), ${s.periodStartDate} to ${s.periodEndDate}. Reference: ${s.paymentReference}.`,
          data: { statementId: s.id },
        });
      } catch { /* the payment itself is recorded */ }
    }
    return out;
  }

  // ── reading ─────────────────────────────────────────────────────────────────

  const withTrainer = (s) => {
    const t = trainerOf(s.trainerId);
    // A statement is paid to a person: it carries the trainer's own name as
    // well as the name clients see (the nickname, when there is one).
    return {
      ...s,
      trainer: t ? {
        id: t.id, displayName: t.displayName || null, fullName: t.fullName || t.displayName || null,
        nickname: t.nickname || null, userId: t.userId || null,
      } : null,
    };
  };

  /** Admin: statements, newest week first. */
  async function list({ status, trainerId, limit = 200 } = {}) {
    if (status && !STATEMENT_STATUSES.includes(status)) return fail('invalid_status', 400, { allowed: STATEMENT_STATUSES });
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

  /** Trainer: my statements, and whether my payout account is ready. */
  async function listMine({ trainerId }) {
    const rows = await db('TrainerSettlement').where({ trainerId }).whereIn('status', VISIBLE_TO_PARTNER).orderBy('periodStartDate', 'desc').limit(100);
    const payout = await payoutEligibility.forTrainer(trainerId, { at: now() });
    return { statements: rows.map(partnerView), payoutReady: payout.ok, payoutBlockedBy: payout.ok ? null : payout.reason };
  }

  /** Trainer: one of my statements with its sessions. */
  async function getMine({ trainerId, id }) {
    const statement = await db('TrainerSettlement').where({ id, trainerId }).whereIn('status', VISIBLE_TO_PARTNER).first();
    if (!statement) return fail('statement_not_found', 404);
    return { statement: partnerView(statement), lines: await linesOf(id) };
  }

  const { submit, reject, approve, hold, release, markPayable, voidStatement } = workflow;
  return { prepare, submit, reject, approve, hold, release, markPayable, pay, voidStatement, list, get, listMine, getMine };
}
