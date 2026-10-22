// Trainer booking service — member booking creation + trainer/admin session management.
import { randomUUID } from 'node:crypto';
import { priceBooking, passDiscountPct, trainerCommissionPct } from '../shared/trainer-pricing.mjs';
import { effectiveSubscriptionStatus } from '../shared/subscription-status.mjs';
import {
  normalizeAvailability, normalizeSlot, weekdayOf, addDays, isPastSlot, buildTrainerSchedule, hideTrainerPass,
  memberCancellation, slotStartMs,
} from '../shared/trainer-access.mjs';
import { OPEN_GATE } from './partner-gate.mjs';
import { publicGym } from './gym-service.mjs';
import { publicTrainer } from './trainer-service.mjs';

// A booking holds its slots from the moment it is requested; one that was
// rejected or cancelled frees them again.
const SLOT_RELEASING = new Set(['cancelled', 'payment_rejected']);
const MAX_SLOTS_PER_BOOKING = 12;

// Phase B · B1a: a session that took place, or one the member missed. Both are
// paid to the trainer in full and both use a sponsor benefit as if they happened.
export const OUTCOME_STATUSES = Object.freeze(['completed', 'no_show']);
const HAPPENED = new Set(OUTCOME_STATUSES);
/** A trainer may record a no-show from the session's start until this many hours after it. */
export const NO_SHOW_WINDOW_HOURS = 48;
// What an admin may move to confirmed / completed / no_show from: a paid session, never an unpaid one.
const ADMIN_OUTCOME_FROM = new Set(['confirmed', 'completed', 'no_show']);
// Statement states after which a session's outcome is frozen (the line has left draft).
const LOCKING_STATEMENT_STATUSES = ['submitted', 'approved', 'payable', 'paid'];

/**
 * What the caller may do with a booking's outcome now (TRAINER_SESSION_OUTCOMES).
 *   trainer: Complete — confirmed and started; No-show — confirmed, started, within 48h of the start.
 *   admin:   Complete — confirmed or no_show; No-show — confirmed or completed and started;
 *            neither once the session is on a submitted/approved/payable/paid statement.
 *   member:  never (members do not record outcomes).
 */
export function sessionActions(booking, { viewer = 'trainer', now = new Date(), locked = false } = {}) {
  // An unreadable date/slot is never "started" (review L5).
  const start = slotStartMs(booking?.date, booking?.slot);
  const started = !Number.isNaN(start) && start <= +now;
  if (viewer === 'member') return { canComplete: false, canMarkNoShow: false };
  if (viewer === 'admin') {
    if (locked) return { canComplete: false, canMarkNoShow: false };
    return {
      canComplete: ['confirmed', 'no_show'].includes(booking.status),
      canMarkNoShow: ['confirmed', 'completed'].includes(booking.status) && started,
    };
  }
  const confirmed = booking?.status === 'confirmed';
  return {
    canComplete: confirmed && started,
    canMarkNoShow: confirmed && started && +now <= start + NO_SHOW_WINDOW_HOURS * 3_600_000,
  };
}

/**
 * What a trainer may see of the member who booked them (and what the member's
 * own booking carries back): a name and a face. A list of what is shown, so a
 * new account column stays private until it is added here.
 */
export function memberCard(user) {
  if (!user) return null;
  return { id: user.id, displayName: user.displayName || null, photoUrl: user.photoUrl || null };
}

/** The same, with the contact details FitFlex staff need to reach the member. Never the rest of the account. */
export function adminMemberCard(user) {
  if (!user) return null;
  return { ...memberCard(user), email: user.email || null, phone: user.phone || null };
}

/**
 * C1: does the trainer's configured availability cover this date+slot (+gym)?
 * Trainers with NO configured availability accept any slot (legacy profiles).
 */
export function slotIsAvailable(availability, { date, slot, gymId }) {
  if (!Array.isArray(availability) || availability.length === 0) return true;
  const entries = normalizeAvailability(availability);
  const wanted = normalizeSlot(slot);
  const dayName = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? weekdayOf(date) : null;
  return entries.some((entry) => {
    if (entry.day !== dayName && entry.day !== date) return false; // weekday or exact-date entries
    if (entry.gymId && gymId && entry.gymId !== gymId) return false;
    return entry.slots.includes(wanted);
  });
}

export function createTrainerBookingService({
  trainerBookings, trainerSessions, trainers, gyms, users, auditLog, trainerService,
  subscriptions, paymentRequests, notify = async () => {},
  partnerGate = OPEN_GATE,
  onStatusChanged = null,
  // A booking request counts, or stops counting, as a conversion for the promotion that led to it: ({ action, groupId, bookings }).
  onBookingConversion = null,
  // A paid session was cancelled and the money is owed back: ({ booking, reasonCode, actorId, role }) → refund.
  onRefundDue = async () => null,
  // (tierKey) → the tier's Settings config or null. The Pass trainer discount
  // applies only to a tier configured in Settings (none when not wired).
  getTierConfig = () => null,
  // TRAINER_SESSION_OUTCOMES: no-show, admin no_show, `actions` on each booking. Read on every call.
  outcomesOn = () => false,
  // (bookingIds[]) → Map(bookingId → { statementId, status }) for sessions on a live trainer statement line.
  statementLines = async () => new Map(),
  now: clock = () => new Date(),
  // Locked, conditional status changes that keep draft statement lines in step (src/infra/trainer-outcome-store-pg.mjs).
  // Without one (unit specs on in-memory stores) a conditional update on the collection is used instead.
  outcomeStore: injectedOutcomeStore = null,
  // Writes that make a booking hold a slot, serialised per trainer slot (src/infra/trainer-slot-store-pg.mjs).
  // Without one (unit specs on in-memory stores) the collections are used, unserialised.
  slotStore = null,
}) {
  /** The fallback: same decisions and audit, a conditional update, no statement-line upkeep. */
  function collectionOutcomeStore() {
    return {
      async transition({ bookingId, trainerId = null, decide, actorId, action }) {
        const prior = await trainerBookings.findAsync(b => b.id === bookingId && (!trainerId || b.trainerId === trainerId));
        if (!prior) return { notFound: true };
        const line = (await statementLines([prior.id])).get(prior.id) || null;
        const d = await decide(prior, line);
        if (d.error) return d;
        const at = new Date().toISOString();
        const patch = { status: d.to, updatedAt: at, ...(d.patch || {}) };
        const updated = typeof trainerBookings.updateByIdWhereAsync === 'function'
          ? await trainerBookings.updateByIdWhereAsync(prior.id, { status: prior.status }, patch)
          : await trainerBookings.updateByIdAsync(prior.id, patch);
        if (!updated) return { error: 'booking_changed', status: 409 };
        await auditLog.insertAsync({ id: randomUUID(), at, actor: actorId, action: action(prior, d.to), target: prior.id, before: prior, after: updated });
        return { prior, updated, draftLine: null };
      },
    };
  }
  const outcomeStore = injectedOutcomeStore || collectionOutcomeStore();

  /** Live statement lines that freeze a booking's outcome (statement past draft). */
  async function lockedLines(ids) {
    if (!ids.length) return new Map();
    const lines = await statementLines(ids);
    return new Map([...lines].filter(([, l]) => LOCKING_STATEMENT_STATUSES.includes(l.status)));
  }

  /** Adds `actions` when the flag is on; the booking is untouched otherwise. */
  async function withActions(rows, viewer) {
    if (!outcomesOn()) return rows;
    const at = clock();
    const locks = viewer === 'admin' ? await lockedLines(rows.map(r => r.id)) : new Map();
    return rows.map(r => ({ ...r, actions: sessionActions(r, { viewer, now: at, locked: locks.has(r.id) }) }));
  }

  /**
   * Keep promotion analytics in step with a booking request: while any session in it is confirmed or done it counts
   * as a conversion; when none is (rejected, cancelled, refunded) the conversion is taken back. Never throws.
   */
  async function syncConversion(groupId) {
    if (!groupId || !onBookingConversion) return;
    try {
      const group = await trainerBookings.filterAsync(b => b.groupId === groupId);
      const live = group.filter(b => ['confirmed', ...OUTCOME_STATUSES].includes(b.status));
      await onBookingConversion(live.length ? { action: 'credit', groupId, bookings: live } : { action: 'reverse', groupId, bookings: group });
    } catch (err) {
      console.warn('[trainer-booking] conversion not synced:', err?.message);
    }
  }

  // Side effects of a status change (B2B benefit consumption). The change has
  // already happened; a failing hook must never undo or fail it.
  async function statusChanged(booking, from, actorId) {
    if (!onStatusChanged || booking.status === from) return;
    try {
      await onStatusChanged({ booking, from, actorId });
    } catch (err) {
      console.warn('[trainer-booking] onStatusChanged failed:', err?.message);
    }
  }

  /** The trainer as members see them anywhere else: the public card, badged from their own KYC. */
  async function publicTrainerCard(row) {
    const [shown] = await partnerGate.badgeTrainers([trainerService.hydrateTrainer(row)]);
    return publicTrainer(shown);
  }

  /**
   * A booking as the member or the trainer reads it: the other party is a
   * card, never their account or their full profile.
   */
  async function hydrateBooking(row) {
    return {
      ...row,
      member: memberCard(await users.findByIdAsync(row.memberId)),
      trainer: row.trainerId ? await publicTrainerCard(trainers.find(t => t.id === row.trainerId) || {}) : null,
      gym: hideTrainerPass(publicGym(gyms.find(g => g.id === row.gymId) || null))
    };
  }

  /** A booking as FitFlex staff read it: the trainer's full profile, and how to reach the member. */
  async function adminHydrateBooking(row) {
    return {
      ...row,
      member: adminMemberCard(await users.findByIdAsync(row.memberId)),
      trainer: row.trainerId ? trainerService.hydrateTrainer(trainers.find(t => t.id === row.trainerId) || {}) : null,
      gym: hideTrainerPass(publicGym(gyms.find(g => g.id === row.gymId) || null))
    };
  }

  /** Same account, or two accounts of one person (Identity V2 personId). */
  async function sameHolder(memberId, trainerUserId) {
    if (!memberId || !trainerUserId) return false;
    if (memberId === trainerUserId) return true;
    const [member, coach] = await Promise.all([users.findByIdAsync(memberId), users.findByIdAsync(trainerUserId)]);
    return Boolean(member?.personId && coach?.personId && member.personId === coach.personId);
  }

  /** The member's active Platform Pass tier, if any (drives the trainer discount). */
  async function activePassTier(memberId) {
    if (!subscriptions) return null;
    const subs = await subscriptions.filterAsync(s => s.memberId === memberId && s.type === 'platform_pass');
    const active = subs.find(s => effectiveSubscriptionStatus(s) === 'active');
    return active?.tier || null;
  }

  /** Accept { slots:[{date,slot}] } or the legacy single { date, slot }. */
  function requestedSlots(body) {
    const raw = Array.isArray(body?.slots) && body.slots.length
      ? body.slots
      : (body?.date || body?.slot ? [{ date: body.date, slot: body.slot }] : []);
    const seen = new Set();
    const out = [];
    for (const s of raw) {
      const slot = normalizeSlot(s?.slot) || s?.slot;
      const key = `${s?.date}|${slot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date: s?.date, slot });
    }
    return out.sort((a, b) => `${a.date} ${a.slot}`.localeCompare(`${b.date} ${b.slot}`));
  }

  /**
   * Validate the request and price it. Shared by quote (no writes) and
   * createBooking. Returns { error, status } or the priced plan.
   */
  async function planBooking({ memberId, body }) {
    const { trainerId, gymId } = body || {};
    const trainer = trainers.find(t => t.id === trainerId && t.status === 'active');
    if (!trainer) return { error: 'trainer_not_found', status: 404 };
    // A trainer can't book (and so be paid for) their own sessions, from this account or another of theirs.
    if (await sameHolder(memberId, trainer.userId)) return { error: 'cannot_book_own_sessions', status: 403 };
    // An unverified trainer is listed but cannot be booked yet.
    if (!(await partnerGate.isOperational(trainer.userId))) return { error: 'trainer_not_verified', status: 403 };
    if (!trainer.gymIds?.includes(gymId)) return { error: 'trainer_not_available_at_gym', status: 400 };
    const slots = requestedSlots(body);
    if (!slots.length || slots.some(s => !s.date || !s.slot)) return { error: 'date_and_slot_required', status: 400 };
    if (slots.length > MAX_SLOTS_PER_BOOKING) return { error: 'too_many_slots', status: 400 };

    const now = new Date();
    for (const s of slots) {
      if (isPastSlot(s.date, s.slot, now)) return { error: 'slot_in_past', status: 400, slot: s };
      // C1: the slot must be inside the trainer's configured availability.
      if (!slotIsAvailable(trainer.availability, { date: s.date, slot: s.slot, gymId })) {
        return { error: 'slot_not_available', status: 409, slot: s };
      }
      // C1: reject double booking — same trainer/date/slot still held.
      const clash = await trainerBookings.findAsync(
        b => b.trainerId === trainerId && b.date === s.date && b.slot === s.slot && !SLOT_RELEASING.has(b.status),
      );
      if (clash) return { error: 'slot_already_booked', status: 409, slot: s };
    }

    const passTier = await activePassTier(memberId);
    const pricing = priceBooking({
      listPrice: trainer.hourlyRateTzs,
      slotCount: slots.length,
      discountPct: passDiscountPct(passTier, passTier ? getTierConfig(passTier) : null),
      commissionPct: trainerCommissionPct(trainer),
    });
    const summary = {
      trainerId, gymId, slots,
      currency: trainer.sessionRateCurrency || 'TZS',
      passTier,
      pricePerSession: pricing.perSession.listPrice,
      discountPct: pricing.perSession.discountPct,
      subtotal: pricing.listTotal,
      discount: pricing.discountTotal,
      total: pricing.memberTotal,
    };
    return { trainer, slots, pricing, summary };
  }

  /** Price a booking without creating it (the "Book Slots" summary screen). */
  async function quoteBooking({ memberId, body }) {
    const plan = await planBooking({ memberId, body });
    if (plan.error) return plan;
    return { summary: plan.summary };
  }

  /**
   * Create one booking per slot, all sharing a groupId, held as
   * payment_pending until the payment request is approved.
   */
  async function createBooking({ memberId, body }) {
    const plan = await planBooking({ memberId, body });
    if (plan.error) return plan;
    const { trainer, slots, pricing, summary } = plan;
    const now = new Date().toISOString();
    const groupId = `tbg_${randomUUID().slice(0, 8)}`;
    // Free sessions (no rate set) have nothing to pay, so confirm them
    // straight away; paid ones wait for the payment request.
    const needsPayment = Boolean(paymentRequests) && summary.total > 0;
    const paymentRequestId = needsPayment ? `pay_${randomUUID().slice(0, 8)}` : null;
    const per = pricing.perSession;

    const bookings = slots.map(s => ({
      id: `tbk_${randomUUID().slice(0, 8)}`,
      groupId,
      memberId,
      trainerId: trainer.id,
      gymId: summary.gymId,
      date: s.date,
      slot: s.slot,
      currency: summary.currency,
      listPriceTzs: per.listPrice,
      discountPct: per.discountPct,
      amountTzs: per.memberPrice,
      commissionPct: per.commissionPct,
      commissionTzs: per.commission,
      trainerPayoutTzs: per.trainerPayout,
      discountFundedBy: per.discountFundedBy,
      paymentRequestId,
      status: needsPayment ? 'payment_pending' : 'confirmed',
      createdAt: now,
      updatedAt: now,
    }));
    const paymentRequest = needsPayment ? {
      id: paymentRequestId,
      memberId,
      subscriptionId: null,
      bookingGroupId: groupId,
      tier: null,
      plan: 'trainer_session',
      gymId: summary.gymId,
      currency: summary.currency,
      amountTzs: summary.total,
      status: 'pending',
      provider: 'admin_approved',
      reference: null,
      requestedAt: now,
      decidedAt: null,
      decidedBy: null,
      note: `${slots.length} session(s) with ${trainer.displayName || trainer.id}`,
    } : null;

    if (slotStore) {
      // The free-slot check above is re-done under the slot locks, with the inserts (security review of #231, race 3).
      const out = await slotStore.insertGroup({ bookings, paymentRequest });
      if (out.error) return out;
    } else {
      for (const b of bookings) await trainerBookings.insertAsync(b);
      if (paymentRequest) await paymentRequests.insertAsync(paymentRequest);
    }

    // A session that needs no payment is confirmed at once, and that is when the booking counts.
    if (!needsPayment) await syncConversion(groupId);

    await auditLog.insertAsync({
      id: randomUUID(), at: now,
      actor: memberId, action: 'trainer_booking_created',
      target: groupId, before: null, after: { bookings: bookings.map(b => b.id), paymentRequestId },
    });
    await notify('trainer_booking_requested', { trainer, memberId, bookings, summary });
    return {
      bookingGroupId: groupId,
      booking: bookings[0],
      bookings,
      summary,
      paymentRequest,
      trainer: await publicTrainerCard(trainer),
    };
  }

  /** The group's payment_rejected sessions whose slot someone else holds now. */
  async function rebookedRejected(groupId) {
    const group = await trainerBookings.filterAsync(b => b.groupId === groupId && b.status === 'payment_rejected');
    const out = [];
    for (const b of group) {
      const taken = await trainerBookings.findAsync(o => o.id !== b.id && o.groupId !== groupId && o.trainerId === b.trainerId
        && o.date === b.date && o.slot === b.slot && !SLOT_RELEASING.has(o.status));
      if (taken) out.push(b.id);
    }
    return out;
  }

  /**
   * Before a group's payment is approved (owner decision 2026-10-20): a rejected session whose slot
   * has been booked by someone else since cannot come back, so a payment covering it is refused —
   * staff adjust or reject it instead. → null | { error: 'group_slot_rebooked', status: 409, bookingIds }.
   */
  async function checkGroupPayment(groupId, paymentStatus) {
    if (!groupId || paymentStatus !== 'approved') return null;
    const bookingIds = await rebookedRejected(groupId);
    return bookingIds.length ? { error: 'group_slot_rebooked', status: 409, bookingIds } : null;
  }

  /**
   * Which of a group's sessions follow its payment to `next`, under the slot locks when there are any.
   * A rejected session whose slot someone else holds now cannot come back: an approval is then refused
   * as a whole (nothing moves); any other decision leaves that session payment_rejected.
   */
  function planGroupMove(group, taken, next) {
    const moves = [];
    const kept = [];
    const blocked = [];
    for (const b of group) {
      if (HAPPENED.has(b.status)) { kept.push(b); continue; }
      // A cancelled slot was dropped from the group and its payment shrunk (releaseUnpaidSlot): approving
      // the rest must not bring it back as confirmed and later payable (re-review finding 3).
      if (b.status === 'cancelled') continue;
      if (b.status === 'payment_rejected' && !SLOT_RELEASING.has(next) && taken.has(b.id)) {
        blocked.push({ id: b.id, heldBy: taken.get(b.id) });
        continue;
      }
      moves.push({ id: b.id, from: b.status, to: next });
    }
    if (next === 'confirmed' && blocked.length) {
      return { error: 'group_slot_rebooked', status: 409, bookingIds: blocked.map(x => x.id) };
    }
    return { moves, kept, blocked };
  }

  /** Without a slot store: the same decision on the collections (no locks). */
  async function moveGroupOnCollections(groupId, next) {
    const group = await trainerBookings.filterAsync(b => b.groupId === groupId);
    const taken = new Map();
    for (const b of group) {
      if (!SLOT_RELEASING.has(b.status)) continue;
      const holder = await trainerBookings.findAsync(o => o.id !== b.id && o.groupId !== groupId && o.trainerId === b.trainerId
        && o.date === b.date && o.slot === b.slot && !SLOT_RELEASING.has(o.status));
      if (holder) taken.set(b.id, holder.id);
    }
    const plan = planGroupMove(group, taken, next);
    if (plan.error) return plan;
    const now = new Date().toISOString();
    const updated = [];
    for (const m of plan.moves) updated.push(await trainerBookings.updateByIdAsync(m.id, { status: m.to, updatedAt: now }));
    return { plan, updated };
  }

  /**
   * Payment decided by an admin: move every booking in the group with it. → the group's sessions that
   * follow the payment, or { error: 'group_slot_rebooked', status: 409, bookingIds } when an approval
   * would bring back a rejected session whose slot someone else booked after the check (nothing moved;
   * the caller undoes its payment decision — security review of #231, race 1).
   */
  async function applyPaymentToGroup(groupId, paymentStatus, { actorId = 'system' } = {}) {
    const next = {
      approved: 'confirmed',
      rejected: 'payment_rejected',
      cancelled: 'cancelled',
      pending: 'payment_pending',
    }[paymentStatus];
    if (!next || !groupId) return [];
    let plan;
    let moved;
    if (slotStore) {
      const out = await slotStore.moveGroup({
        groupId,
        decide: (group, taken) => {
          plan = planGroupMove(group, taken, next);
          return plan;
        },
      });
      if (out.error) return out;
      moved = out.updated;
    } else {
      const out = await moveGroupOnCollections(groupId, next);
      if (out.error) return out;
      ({ plan } = out);
      moved = out.updated;
    }
    const at = new Date().toISOString();
    // Not an approval (e.g. back to pending): the session stays payment_rejected, on the record.
    for (const b of plan.blocked) {
      await auditLog.insertAsync({
        id: randomUUID(), at, actor: actorId, action: 'trainer_booking_kept_rejected', target: b.id,
        before: { status: 'payment_rejected' }, after: { status: 'payment_rejected', paymentStatus, slotHeldBy: b.heldBy },
      });
    }
    const updated = [...plan.kept, ...moved].sort((x, y) => `${x.date} ${x.slot}`.localeCompare(`${y.date} ${y.slot}`));
    if (next === 'confirmed' && updated.length) {
      const trainer = trainers.find(t => t.id === updated[0].trainerId);
      await notify('trainer_booking_confirmed', { trainer, memberId: updated[0].memberId, bookings: updated });
    }
    await syncConversion(groupId);
    return updated;
  }

  async function adminList() {
    const allBookings = await trainerBookings.allAsync();
    const rows = await Promise.all(
      allBookings
        .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
        .map(b => adminHydrateBooking(b))
    );
    return withActions(rows, 'admin');
  }

  /**
   * Admin: set a booking's status. A cancelled session is final (review HIGH 1:
   * moving it on would leave its refund live while the trainer is paid and the
   * slot may be booked again) — 409 booking_cancelled, flag or not.
   */
  async function adminUpdateStatus({ id, status, actorId }) {
    const outcomes = outcomesOn();
    const allowed = outcomes ? ['confirmed', 'completed', 'cancelled', 'no_show'] : ['confirmed', 'completed', 'cancelled'];
    if (!allowed.includes(status)) return { error: 'invalid_status', status: 400 };
    const at = new Date().toISOString();
    const out = await outcomeStore.transition({
      bookingId: id, actorId,
      action: (_, to) => `trainer_booking_${to}`,
      decide: (prior, line) => {
        if (prior.status === 'cancelled' && status !== 'cancelled') return { error: 'booking_cancelled', status: 409 };
        // Once a statement carrying this session has left draft, its outcome is what was (or will be) paid.
        // Not behind the flag: freezing a money-bearing outcome does not depend on it (re-review finding 2).
        if (status !== prior.status && line && LOCKING_STATEMENT_STATUSES.includes(line.status)) {
          return { error: 'booking_on_trainer_statement', status: 409, statementId: line.statementId, statementStatus: line.status };
        }
        // Owner decision 2026-10-20, flag or not (money safety): a session that was never paid for
        // (payment_pending / payment_rejected) is only ever confirmed by the payment approval flow, and
        // only a session that has started can be marked completed or no-show.
        if (['confirmed', 'completed', 'no_show'].includes(status) && status !== prior.status) {
          if (!ADMIN_OUTCOME_FROM.has(prior.status)) return { error: 'invalid_transition', status: 409, from: prior.status };
          if (status !== 'confirmed') {
            const start = startOf(prior);
            if (Number.isNaN(start)) return { error: 'invalid_booking_time', status: 400 };
            if (start > +clock()) return { error: 'session_not_started', status: 409, startsAt: new Date(start).toISOString() };
          }
        }
        const cancelling = status === 'cancelled' && prior.status !== 'cancelled';
        return { to: status, patch: cancelling ? { cancelledAt: at, cancelledBy: 'admin' } : {} };
      },
    });
    if (out.notFound) return { error: 'not_found', status: 404 };
    if (out.error) return out;
    const { prior } = out;
    const updated = await trainerBookings.findByIdAsync(prior.id) || out.updated;
    const cancelling = status === 'cancelled' && prior.status !== 'cancelled';
    await statusChanged(updated, prior.status, actorId);
    await syncConversion(prior.groupId);
    // FitFlex cancelling a session the member paid for owes them the money back.
    const refund = cancelling && wasPaid(prior)
      ? await refundFor(updated, 'cancelled_by_fitflex', actorId, 'admin') : null;
    // The member hears of a no-show however it was recorded (review L6).
    if (status === 'no_show' && prior.status !== 'no_show') await notifyNoShow(updated);
    const [booking] = await withActions([await adminHydrateBooking(updated)], 'admin');
    return { booking, refund, ...(out.draftLine ? { draftLine: out.draftLine } : {}) };
  }

  async function trainerMyBookings(userId) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const allBookings = await trainerBookings.filterAsync(b => b.trainerId === profile.id);
    const bookings = await Promise.all(
      allBookings
        .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
        .map(b => hydrateBooking(b))
    );
    return { bookings: await withActions(bookings, 'trainer') };
  }

  /** When the slot starts (epoch ms), NaN when date/slot cannot be read — never "already started". */
  const startOf = b => slotStartMs(b?.date, b?.slot);

  const lockedBy = line => (line && LOCKING_STATEMENT_STATUSES.includes(line.status)
    ? { error: 'booking_on_trainer_statement', status: 409, statementId: line.statementId, statementStatus: line.status } : null);

  /** A trainer's outcome on their own confirmed booking, decided and written in one locked step. */
  async function trainerOutcome({ userId, bookingId, to, action, check }) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const out = await outcomeStore.transition({
      bookingId, trainerId: profile.id, actorId: userId, action: () => action,
      decide: (prior, line) => check(prior) || lockedBy(line) || { to },
    });
    if (out.notFound) return { error: 'booking_not_found', status: 404 };
    if (out.error) return out;
    const updated = await trainerBookings.findByIdAsync(out.prior.id) || out.updated;
    await statusChanged(updated, out.prior.status, userId);
    return { prior: out.prior, updated };
  }

  /**
   * Trainer: the session took place. Only a confirmed session, and only once it
   * has started — completing makes it payable at once, so a future session can
   * never be completed (this check is not behind TRAINER_SESSION_OUTCOMES).
   */
  async function trainerCompleteBooking({ userId, bookingId }) {
    const out = await trainerOutcome({
      userId, bookingId, to: 'completed', action: 'trainer_booking_completed_by_trainer',
      check: (b) => {
        if (b.status !== 'confirmed') return { error: 'booking_not_confirmable', status: 409 };
        const start = startOf(b);
        if (Number.isNaN(start)) return { error: 'invalid_booking_time', status: 400 };
        if (start > +clock()) return { error: 'session_not_started', status: 409, startsAt: new Date(start).toISOString() };
        return null;
      },
    });
    if (out.error) return out;
    await syncConversion(out.prior.groupId);
    const [shown] = await withActions([await hydrateBooking(out.updated)], 'trainer');
    return { booking: shown };
  }

  async function notifyNoShow(booking) {
    const trainer = trainers.find(t => t.id === booking.trainerId);
    await notify('trainer_booking_no_show', { trainer, memberId: booking.memberId, bookings: [booking] });
  }

  /**
   * Trainer (TRAINER_SESSION_OUTCOMES): the member did not come. Confirmed
   * sessions only, from the start until 48 hours after it. The trainer is paid
   * in full, the member is not refunded, and a sponsor benefit is used as if
   * the session took place. The member is told.
   */
  async function trainerMarkNoShow({ userId, bookingId }) {
    if (!outcomesOn()) return { error: 'feature_disabled', status: 404 };
    const out = await trainerOutcome({
      userId, bookingId, to: 'no_show', action: 'trainer_booking_no_show',
      check: (b) => {
        if (b.status !== 'confirmed') return { error: 'booking_not_confirmed', status: 409 };
        const start = startOf(b);
        if (Number.isNaN(start)) return { error: 'invalid_booking_time', status: 400 };
        const now = +clock();
        if (start > now) return { error: 'session_not_started', status: 409, startsAt: new Date(start).toISOString() };
        const closes = start + NO_SHOW_WINDOW_HOURS * 3_600_000;
        if (now > closes) return { error: 'no_show_window_passed', status: 409, closedAt: new Date(closes).toISOString() };
        return null;
      },
    });
    if (out.error) return out;
    await syncConversion(out.prior.groupId);
    await notifyNoShow(out.updated);
    const [shown] = await withActions([await hydrateBooking(out.updated)], 'trainer');
    return { booking: shown };
  }

  async function memberMyBookings(memberId) {
    const allBookings = await trainerBookings.filterAsync(b => b.memberId === memberId);
    const now = new Date();
    const rows = await Promise.all(
      allBookings
        .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
        // What the member can still do with each booking, so the app needn't guess.
        .map(async b => ({ ...(await hydrateBooking(b)), cancellation: memberCancellation(b, now) }))
    );
    return withActions(rows, 'member');
  }

  // ── Cancellations ───────────────────────────────────────────────────

  /** The member paid for this session (it was confirmed by a payment, not free). */
  const wasPaid = b => ['confirmed', ...OUTCOME_STATUSES].includes(b.status) && Number(b.amountTzs) > 0;

  async function refundFor(booking, reasonCode, actorId, role) {
    try {
      return await onRefundDue({ booking, reasonCode, actorId, role });
    } catch (err) {
      console.warn('[trainer-booking] refund not raised:', err?.message);
      return null;
    }
  }

  /** A slot still waiting on payment was dropped: shrink or withdraw the group's payment request. */
  async function releaseUnpaidSlot(booking, at, actorId) {
    if (!paymentRequests || !booking.paymentRequestId) return;
    const request = await paymentRequests.findByIdAsync(booking.paymentRequestId);
    if (!request || request.status !== 'pending') return;
    const left = (await trainerBookings.filterAsync(b => b.groupId === booking.groupId && b.status === 'payment_pending'));
    if (!left.length) {
      await paymentRequests.updateByIdAsync(request.id, { status: 'cancelled', decidedAt: at, decidedBy: actorId });
    } else {
      await paymentRequests.updateByIdAsync(request.id, {
        amountTzs: left.reduce((sum, b) => sum + Number(b.amountTzs || 0), 0),
        note: `${left.length} session(s) (one cancelled before payment)`,
      });
    }
  }

  async function cancel(booking, { by, actorId, reasonCode }) {
    const at = new Date().toISOString();
    const paid = wasPaid(booking);
    const updated = await trainerBookings.updateByIdAsync(booking.id, { status: 'cancelled', cancelledAt: at, cancelledBy: by, updatedAt: at });
    if (booking.status === 'payment_pending') await releaseUnpaidSlot(booking, at, actorId);
    await auditLog.insertAsync({
      id: randomUUID(), at, actor: actorId, action: `trainer_booking_cancelled_by_${by}`,
      target: booking.id, before: booking, after: updated,
    });
    await statusChanged(updated, booking.status, actorId);
    await syncConversion(booking.groupId);
    const refund = paid ? await refundFor(updated, reasonCode, actorId, by) : null;
    const trainer = trainers.find(t => t.id === booking.trainerId);
    await notify(`trainer_booking_cancelled_by_${by}`, { trainer, memberId: booking.memberId, bookings: [updated] });
    const [shown] = await withActions([{ ...(await hydrateBooking(updated)), cancellation: memberCancellation(updated) }], by === 'member' ? 'member' : 'trainer');
    return { booking: shown, refund };
  }

  /**
   * Member: cancel one session. Unpaid: any time before it starts. Paid: up
   * to the notice period before it, with a full refund; after that the
   * session stands.
   */
  async function memberCancelBooking({ memberId, bookingId }) {
    const booking = await trainerBookings.findAsync(b => b.id === bookingId && b.memberId === memberId);
    if (!booking) return { error: 'booking_not_found', status: 404 };
    if (!['payment_pending', 'confirmed'].includes(booking.status)) return { error: 'booking_not_cancellable', status: 409 };
    if (isPastSlot(booking.date, booking.slot)) return { error: 'session_already_started', status: 409 };
    const rule = memberCancellation(booking);
    if (!rule.canCancel) return { error: 'cancellation_window_passed', status: 409, cancelBy: rule.cancelBy };
    return cancel(booking, { by: 'member', actorId: memberId, reasonCode: 'member_cancelled' });
  }

  /** Trainer: cancel a session they can't take, any time before it starts. A paid one is refunded in full. */
  async function trainerCancelBooking({ userId, bookingId }) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const booking = await trainerBookings.findAsync(b => b.id === bookingId && b.trainerId === profile.id);
    if (!booking) return { error: 'booking_not_found', status: 404 };
    if (!['payment_pending', 'confirmed'].includes(booking.status)) return { error: 'booking_not_cancellable', status: 409 };
    if (isPastSlot(booking.date, booking.slot)) return { error: 'session_already_started', status: 409 };
    return cancel(booking, { by: 'trainer', actorId: userId, reasonCode: 'trainer_cancelled' });
  }

  // ── C3: sessions (bookings + manual entries) ────────────────────────

  async function createManualSession({ userId, body }) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const { customerName, customerEmail, customerPhone, gymId, date, slot, amountTzs, memberId } = body || {};
    const locationType = body?.locationType || 'my_gym';
    const locationLabel = body?.locationLabel?.trim() || null;
    if (!date) return { error: 'date_required', status: 400 };
    if (!memberId && !customerEmail?.trim() && !customerPhone?.trim() && !customerName?.trim()) {
      return { error: 'customer_contact_required', status: 400 };
    }
    if (!['my_gym', 'other_gym', 'other_location'].includes(locationType)) {
      return { error: 'invalid_location_type', status: 400 };
    }
    if (locationType !== 'my_gym' && !locationLabel) {
      return { error: 'location_required', status: 400 };
    }
    const resolvedGymId = locationType === 'my_gym'
      ? (gymId || profile.gymIds?.[0] || null)
      : (gymId || null);
    if (locationType === 'my_gym' && !resolvedGymId) {
      return { error: 'my_gym_required', status: 400 };
    }
    if (locationType === 'my_gym' && !profile.gymIds?.includes(resolvedGymId)) {
      return { error: 'gym_not_linked', status: 403 };
    }
    if (locationType === 'my_gym' && !gyms.find(g => g.id === resolvedGymId)) {
      return { error: 'gym_not_found', status: 404 };
    }
    const session = await trainerSessions.insertAsync({
      id: `tss_${randomUUID().slice(0, 8)}`,
      trainerId: profile.id,
      memberId: memberId || null,
      customerName: customerName?.trim() || null,
      customerEmail: customerEmail?.trim() || null,
      customerPhone: customerPhone?.trim() || null,
      gymId: resolvedGymId,
      locationType,
      locationLabel,
      date,
      slot: slot || null,
      source: 'manual',
      status: 'scheduled',
      amountTzs: Number(amountTzs || 0),
      createdAt: new Date().toISOString(),
    });
    return { session };
  }

  /** C3: bookings + manual sessions for one date (defaults to today). */
  async function trainerSessionsForDate({ userId, date }) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const day = date || new Date().toISOString().slice(0, 10);

    const dayBookings = await trainerBookings.filterAsync(
      b => b.trainerId === profile.id && b.date === day && !SLOT_RELEASING.has(b.status),
    );
    const manualSessions = await trainerSessions.filterAsync(
      s => s.trainerId === profile.id && s.date === day && s.status !== 'cancelled',
    );

    // TRAINER_SESSION_OUTCOMES: what the trainer may do with each booking (manual sessions have none).
    const showActions = outcomesOn();
    const at = clock();
    const sessions = [
      ...await Promise.all(dayBookings.map(async (b) => ({
        id: b.id,
        source: 'booking',
        date: b.date,
        slot: b.slot,
        gymId: b.gymId,
        gym: publicGym(gyms.find(g => g.id === b.gymId) || null),
        amountTzs: b.trainerPayoutTzs ?? b.amountTzs ?? 0,
        status: b.status,
        member: memberCard(await users.findByIdAsync(b.memberId)),
        customerName: null,
        ...(showActions ? { actions: sessionActions(b, { viewer: 'trainer', now: at }) } : {}),
      }))),
      ...manualSessions.map((s) => ({
        id: s.id,
        source: 'manual',
        date: s.date,
        slot: s.slot,
        gymId: s.gymId,
        gym: publicGym(gyms.find(g => g.id === s.gymId) || null),
        locationType: s.locationType || 'my_gym',
        locationLabel: s.locationLabel || null,
        amountTzs: s.amountTzs || 0,
        status: s.status,
        member: null,
        customerName: s.customerName || s.customerEmail || s.customerPhone,
      })),
    ].sort((a, b) => String(a.slot || '').localeCompare(String(b.slot || '')));

    return { date: day, sessions };
  }

  // ── C2: earnings auto-calculated from bookings + manual sessions ───────

  async function trainerEarnings({ userId, from, to }) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };

    const inRange = (dateStr) => {
      if (!dateStr) return false;
      if (from && dateStr < from) return false;
      if (to && dateStr > to) return false;
      return true;
    };
    const noRange = !from && !to;

    // Only paid bookings earn; the trainer is owed the payout after commission.
    const bookings = await trainerBookings.filterAsync(
      b => b.trainerId === profile.id && ['confirmed', ...OUTCOME_STATUSES].includes(b.status) && (noRange || inRange(b.date)),
    );
    const manualSessions = await trainerSessions.filterAsync(
      s => s.trainerId === profile.id && s.status !== 'cancelled' && (noRange || inRange(s.date)),
    );

    const bookingTotal = bookings.reduce((sum, b) => sum + Number(b.trainerPayoutTzs ?? b.amountTzs ?? 0), 0);
    const manualTotal = manualSessions.reduce((sum, s) => sum + Number(s.amountTzs || 0), 0);

    return {
      earnings: {
        totalTzs: bookingTotal + manualTotal,
        bookingTzs: bookingTotal,
        manualTzs: manualTotal,
        bookingCount: bookings.length,
        manualSessionCount: manualSessions.length,
        from: from || null,
        to: to || null,
      },
    };
  }

  /** Bookings that still hold their slot, in [from, from + days). */
  async function heldBookings(trainerId, from, days) {
    const until = addDays(from, days);
    return trainerBookings.filterAsync(b =>
      b.trainerId === trainerId && !SLOT_RELEASING.has(b.status) && b.date >= from && b.date < until);
  }

  /**
   * Public calendar for members: offered slots for the next `days` days with
   * taken ones marked booked — no member details.
   */
  async function publicSchedule({ trainerId, from, days, gymId }) {
    const trainer = trainers.find(t => t.id === trainerId && t.status === 'active');
    if (!trainer) return { error: 'trainer_not_found', status: 404 };
    if (!(await partnerGate.isOperational(trainer.userId))) return { error: 'trainer_not_verified', status: 403 };
    const base = buildTrainerSchedule({ availability: trainer.availability, from, days, gymId });
    const start = base[0]?.date;
    const bookings = start ? await heldBookings(trainer.id, start, base.length) : [];
    return {
      trainerId: trainer.id,
      days: buildTrainerSchedule({ availability: trainer.availability, bookings, from: start, days: base.length, gymId }),
    };
  }

  /** The trainer's own calendar, with who booked each taken slot. */
  async function trainerSchedule({ userId, from, days, gymId }) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const base = buildTrainerSchedule({ availability: profile.availability, from, days, gymId });
    const start = base[0]?.date;
    const bookings = start ? await heldBookings(profile.id, start, base.length) : [];
    const members = new Map();
    for (const b of bookings) {
      if (!members.has(b.memberId)) members.set(b.memberId, await users.findByIdAsync(b.memberId));
    }
    const describeBooking = (b) => {
      const m = members.get(b.memberId);
      return {
        id: b.id, status: b.status, gymId: b.gymId,
        member: memberCard(m),
      };
    };
    return {
      trainerId: profile.id,
      days: buildTrainerSchedule({
        availability: profile.availability, bookings, from: start, days: base.length, gymId, describeBooking,
      }),
    };
  }

  return {
    publicSchedule, trainerSchedule,
    hydrateBooking, quoteBooking, createBooking, applyPaymentToGroup, adminList, adminUpdateStatus,
    trainerMyBookings, trainerCompleteBooking, trainerMarkNoShow, memberMyBookings, checkGroupPayment,
    memberCancelBooking, trainerCancelBooking,
    createManualSession, trainerSessionsForDate, trainerEarnings,
  };
}
