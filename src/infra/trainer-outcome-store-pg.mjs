// Trainer booking status changes that touch money (Phase B · B1a review M2/M3):
// one transaction that locks the trainer statement carrying the session (if
// any), then the booking, decides, writes the new status only if it is still
// the one decided on, keeps a draft statement line in step, and audits.
//
// Lock order is statement → booking, the same as submitting a statement
// (partner-statement-workflow → trainer beforeSubmit), so the two serialise
// instead of deadlocking.
import { randomUUID } from 'node:crypto';
import { payableBasis } from '../services/trainer-settlement-service.mjs';

const json = v => (v == null ? null : JSON.stringify(v));

/** The live line for a booking and its statement's status (statement not voided). */
function liveLine(q, bookingId) {
  return q('TrainerSettlementLine as l').join('TrainerSettlement as s', 's.id', 'l.trainerSettlementId')
    .where('l.bookingId', bookingId).where('l.voided', false).whereNot('s.status', 'voided')
    .first('l.id as lineId', 'l.basis', 's.id as statementId', 's.status');
}

/** Recompute a draft's totals from its lines; a draft left with none is removed. */
async function refreshDraft(q, statementId, at) {
  const lines = await q('TrainerSettlementLine').where({ trainerSettlementId: statementId, voided: false });
  if (!lines.length) {
    await q('TrainerSettlement').where({ id: statementId, status: 'draft' }).del();
    return { removed: true };
  }
  const sum = k => lines.reduce((t, l) => t + Number(l[k] || 0), 0);
  await q('TrainerSettlement').where({ id: statementId, status: 'draft' }).update({
    sessionCount: lines.length, listTzs: sum('listPriceTzs'), commissionTzs: sum('commissionTzs'), finalNetTzs: sum('payoutTzs'), updatedAt: at,
  });
  return { removed: false };
}

// Postgres: deadlock detected / serialization failure. Another writer got in the way; nothing was written.
const CONFLICT_CODES = new Set(['40P01', '40001']);
const CHANGED = Object.freeze({ error: 'booking_changed', status: 409 });

/**
 * @param {object} deps
 * @param {() => Promise<void>} [deps.beforeBookingLock]  test seam: runs between the first line read and the booking lock
 */
export function createPgTrainerOutcomeStore({ db, now = () => new Date(), beforeBookingLock = async () => {} }) {
  /**
   * @param {object} a
   * @param {string} a.bookingId
   * @param {string|null} a.trainerId   only this trainer's booking (trainer endpoints)
   * @param {(prior, line) => object} a.decide  → { error, status, ... } or { to, patch? }
   *        `line` is { statementId, status (the statement's), basis } or null.
   * @param {string} a.actorId
   * @param {(prior, to) => string} a.action  audit action
   * @returns {{ notFound: true } | { error, status } | { prior, updated, draftLine }}
   */
  async function transition(args) {
    try {
      return await locked(args);
    } catch (err) {
      if (CONFLICT_CODES.has(err?.code)) return { ...CHANGED };
      throw err;
    }
  }

  async function locked({ bookingId, trainerId = null, decide, actorId, action }) {
    return db.transaction(async (q) => {
      const at = now();
      // Statement first (see the lock order above), then the booking.
      const seen = await liveLine(q, bookingId);
      if (seen) await q('TrainerSettlement').where({ id: seen.statementId }).forUpdate().first();
      await beforeBookingLock();
      const booked = q('TrainerBooking').where({ id: bookingId });
      if (trainerId) booked.where({ trainerId });
      const prior = await booked.forUpdate().first();
      if (!prior) return { notFound: true };
      const line = await liveLine(q, bookingId);
      // A prepare put the session on a statement (or another one) between the two reads: that statement
      // is not locked here, so stop rather than decide on it (re-review finding 4). Nothing is written.
      if ((line?.statementId ?? null) !== (seen?.statementId ?? null)) return { ...CHANGED };

      const d = await decide(prior, line ? { statementId: line.statementId, status: line.status, basis: line.basis } : null);
      if (d.error) return d;

      const [updated] = await q('TrainerBooking').where({ id: prior.id, status: prior.status })
        .update({ status: d.to, updatedAt: at, ...(d.patch || {}) }).returning('*');
      if (!updated) return { error: 'booking_changed', status: 409 };

      // A draft line follows the session: re-based, or removed when it is no longer payable.
      let draftLine = null;
      if (line && line.status === 'draft') {
        const basis = payableBasis(updated, at);
        if (!basis) {
          await q('TrainerSettlementLine').where({ id: line.lineId }).del();
          const refreshed = await refreshDraft(q, line.statementId, at);
          draftLine = { statementId: line.statementId, removed: true, statementRemoved: refreshed.removed };
        } else if (basis !== line.basis) {
          await q('TrainerSettlementLine').where({ id: line.lineId }).update({ basis });
          draftLine = { statementId: line.statementId, basis };
        }
      }

      await q('AuditLog').insert({
        id: randomUUID(), at, actor: actorId, action: action(prior, d.to), target: prior.id,
        before: json(prior), after: json({ ...updated, ...(draftLine ? { draftLine } : {}) }),
      });
      return { prior, updated, draftLine };
    });
  }

  /**
   * Inside a statement's submit transaction (statement already locked): lines
   * whose session no longer pays on the basis they were prepared on.
   */
  async function staleLines(q, statementId, at = now()) {
    const lines = await q('TrainerSettlementLine').where({ trainerSettlementId: statementId, voided: false }).select('bookingId', 'basis');
    if (!lines.length) return [];
    const bookings = await q('TrainerBooking').whereIn('id', lines.map(l => l.bookingId)).forShare();
    const byId = new Map(bookings.map(b => [b.id, b]));
    return lines.flatMap((l) => {
      const b = byId.get(l.bookingId);
      const basisNow = b ? payableBasis(b, at) : null;
      return basisNow === l.basis ? [] : [{ bookingId: l.bookingId, basis: l.basis, bookingStatus: b ? b.status : null, payableBasis: basisNow }];
    });
  }

  return { transition, staleLines };
}
