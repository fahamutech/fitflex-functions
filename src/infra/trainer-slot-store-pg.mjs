// Trainer slots held by bookings (security review of #231, races 1 and 3).
//
// A booking that is not cancelled or payment_rejected holds its trainer's
// date+slot. Every write that makes a booking hold a slot — a new booking, or a
// payment_rejected session brought back when its payment is decided again —
// runs in one transaction that takes a Postgres advisory lock per trainer slot,
// checks under it that nobody else holds the slot, and only then writes. Two
// such writes for one slot run one after the other and the second sees the first.
//
// Advisory locks rather than a unique index: TrainerBooking.status is free text
// and live data may already hold two live bookings for one slot, which a
// status-filtered unique index would fail to build on. Keys are locked in
// sorted order, so two groups sharing slots cannot deadlock.
import { prepareForKnex } from './knex-store.mjs';

export const SLOT_RELEASING = Object.freeze(['cancelled', 'payment_rejected']);
export const slotLockKey = b => `trainer_slot:${b.trainerId}|${b.date}|${b.slot}`;

const plain = row => (row ? JSON.parse(JSON.stringify(row)) : row);

async function lockSlots(q, rows) {
  for (const key of [...new Set(rows.map(slotLockKey))].sort()) {
    await q.raw('select pg_advisory_xact_lock(hashtext(?))', [key]);
  }
}

/** A live booking (not one of `exceptIds`) holding the same trainer slot as `b`. */
function holderOf(q, b, exceptIds = []) {
  const found = q('TrainerBooking').where({ trainerId: b.trainerId, date: b.date, slot: b.slot })
    .whereNotIn('status', SLOT_RELEASING);
  if (exceptIds.length) found.whereNotIn('id', exceptIds);
  return found.first('id');
}

/**
 * @param {object} deps
 * @param {() => Promise<void>} [deps.whileLocked]  test seam: runs while a move holds its slot locks, before it decides
 */
export function createPgTrainerSlotStore({ db, whileLocked = async () => {} }) {
  /**
   * Insert a new booking group (and its payment request) if every slot is still free.
   * → { bookings, paymentRequest } | { error: 'slot_already_booked', status: 409, slot }
   */
  async function insertGroup({ bookings, paymentRequest = null }) {
    return db.transaction(async (q) => {
      await lockSlots(q, bookings);
      for (const b of bookings) {
        if (await holderOf(q, b)) return { error: 'slot_already_booked', status: 409, slot: { date: b.date, slot: b.slot } };
      }
      await q('TrainerBooking').insert(bookings.map(b => prepareForKnex('trainer_bookings', b)));
      if (paymentRequest) await q('PaymentRequest').insert(prepareForKnex('payment_requests', paymentRequest));
      return { bookings, paymentRequest };
    });
  }

  /**
   * Move a booking group's sessions with its payment, deciding and writing under the slot locks.
   * `decide(group, taken)` — taken: Map(bookingId → id of the live booking now holding its slot),
   * for the group's sessions that do not hold their slot — returns { error, ... } (nothing is written)
   * or { moves: [{ id, from, to }] }.
   * → { error, ... } | { group, updated }
   */
  async function moveGroup({ groupId, decide }) {
    return db.transaction(async (q) => {
      // A group's sessions never change trainer, date or slot, so their slots can be read before locking.
      const slots = await q('TrainerBooking').where({ groupId }).select('trainerId', 'date', 'slot');
      await lockSlots(q, slots);
      await whileLocked();
      const group = (await q('TrainerBooking').where({ groupId }).orderBy('id').forUpdate()).map(plain);
      const ids = group.map(b => b.id);
      const taken = new Map();
      for (const b of group) {
        if (!SLOT_RELEASING.includes(b.status)) continue;
        const holder = await holderOf(q, b, ids);
        if (holder) taken.set(b.id, holder.id);
      }
      const d = await decide(group, taken);
      if (d.error) return d;
      const at = new Date();
      const updated = [];
      for (const m of d.moves) {
        // The rows are locked: the status read above is still the status.
        const [row] = await q('TrainerBooking').where({ id: m.id, status: m.from })
          .update({ status: m.to, updatedAt: at }).returning('*');
        updated.push(plain(row));
      }
      return { group, updated };
    });
  }

  return { insertGroup, moveGroup };
}
