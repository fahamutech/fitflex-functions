// Trainer booking service — member booking creation + trainer/admin session management.
import { randomUUID } from 'node:crypto';
import { priceBooking, passDiscountPct, trainerCommissionPct } from '../shared/trainer-pricing.mjs';
import { effectiveSubscriptionStatus } from '../shared/subscription-status.mjs';
import {
  normalizeAvailability, normalizeSlot, weekdayOf, addDays, isPastSlot, buildTrainerSchedule, hideTrainerPass,
  memberCancellation,
} from '../shared/trainer-access.mjs';
import { OPEN_GATE } from './partner-gate.mjs';
import { publicGym } from './gym-service.mjs';

// A booking holds its slots from the moment it is requested; one that was
// rejected or cancelled frees them again.
const SLOT_RELEASING = new Set(['cancelled', 'payment_rejected']);
const MAX_SLOTS_PER_BOOKING = 12;

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
}) {
  /**
   * Keep promotion analytics in step with a booking request: while any session in it is confirmed or done it counts
   * as a conversion; when none is (rejected, cancelled, refunded) the conversion is taken back. Never throws.
   */
  async function syncConversion(groupId) {
    if (!groupId || !onBookingConversion) return;
    try {
      const group = await trainerBookings.filterAsync(b => b.groupId === groupId);
      const live = group.filter(b => ['confirmed', 'completed'].includes(b.status));
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

  async function hydrateBooking(row) {
    return {
      ...row,
      member: await users.findByIdAsync(row.memberId),
      trainer: row.trainerId ? trainerService.hydrateTrainer(trainers.find(t => t.id === row.trainerId) || {}) : null,
      gym: hideTrainerPass(publicGym(gyms.find(g => g.id === row.gymId) || null))
    };
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
      discountPct: passDiscountPct(passTier),
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

    const bookings = [];
    for (const s of slots) {
      bookings.push(await trainerBookings.insertAsync({
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
    }

    // A session that needs no payment is confirmed at once, and that is when the booking counts.
    if (!needsPayment) await syncConversion(groupId);

    let paymentRequest = null;
    if (needsPayment) {
      paymentRequest = await paymentRequests.insertAsync({
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
      });
    }

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
      trainer: trainerService.hydrateTrainer(trainer),
    };
  }

  /** Payment decided by an admin: move every booking in the group with it. */
  async function applyPaymentToGroup(groupId, paymentStatus) {
    const next = {
      approved: 'confirmed',
      rejected: 'payment_rejected',
      cancelled: 'cancelled',
      pending: 'payment_pending',
    }[paymentStatus];
    if (!next || !groupId) return [];
    const group = await trainerBookings.filterAsync(b => b.groupId === groupId);
    const now = new Date().toISOString();
    const updated = [];
    for (const b of group) {
      if (b.status === 'completed') { updated.push(b); continue; }
      updated.push(await trainerBookings.updateByIdAsync(b.id, { status: next, updatedAt: now }));
    }
    if (next === 'confirmed' && updated.length) {
      const trainer = trainers.find(t => t.id === updated[0].trainerId);
      await notify('trainer_booking_confirmed', { trainer, memberId: updated[0].memberId, bookings: updated });
    }
    await syncConversion(groupId);
    return updated;
  }

  async function adminList() {
    const allBookings = await trainerBookings.allAsync();
    return Promise.all(
      allBookings
        .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
        .map(b => hydrateBooking(b))
    );
  }

  async function adminUpdateStatus({ id, status, actorId }) {
    if (!['confirmed', 'completed', 'cancelled'].includes(status)) return { error: 'invalid_status', status: 400 };
    const prior = await trainerBookings.findAsync(b => b.id === id);
    if (!prior) return { error: 'not_found', status: 404 };
    const at = new Date().toISOString();
    const cancelling = status === 'cancelled' && prior.status !== 'cancelled';
    const updated = await trainerBookings.updateByIdAsync(prior.id, {
      status, updatedAt: at, ...(cancelling ? { cancelledAt: at, cancelledBy: 'admin' } : {}),
    });
    await auditLog.insertAsync({
      id: randomUUID(), at,
      actor: actorId, action: `trainer_booking_${status}`,
      target: prior.id, before: prior, after: updated
    });
    await statusChanged(updated, prior.status, actorId);
    await syncConversion(prior.groupId);
    // FitFlex cancelling a session the member paid for owes them the money back.
    const refund = cancelling && wasPaid(prior)
      ? await refundFor(updated, 'cancelled_by_fitflex', actorId, 'admin') : null;
    return { booking: await hydrateBooking(updated), refund };
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
    return { bookings };
  }

  async function trainerCompleteBooking({ userId, bookingId }) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const booking = await trainerBookings.findAsync(b => b.id === bookingId && b.trainerId === profile.id);
    if (!booking) return { error: 'booking_not_found', status: 404 };
    if (booking.status !== 'confirmed') return { error: 'booking_not_confirmable', status: 409 };
    const updated = await trainerBookings.updateByIdAsync(booking.id, { status: 'completed', updatedAt: new Date().toISOString() });
    await statusChanged(updated, booking.status, userId);
    return { booking: await hydrateBooking(updated) };
  }

  async function memberMyBookings(memberId) {
    const allBookings = await trainerBookings.filterAsync(b => b.memberId === memberId);
    const now = new Date();
    return Promise.all(
      allBookings
        .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
        // What the member can still do with each booking, so the app needn't guess.
        .map(async b => ({ ...(await hydrateBooking(b)), cancellation: memberCancellation(b, now) }))
    );
  }

  // ── Cancellations ───────────────────────────────────────────────────

  /** The member paid for this session (it was confirmed by a payment, not free). */
  const wasPaid = b => ['confirmed', 'completed'].includes(b.status) && Number(b.amountTzs) > 0;

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
    return { booking: { ...(await hydrateBooking(updated)), cancellation: memberCancellation(updated) }, refund };
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
        member: await users.findByIdAsync(b.memberId),
        customerName: null,
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
      b => b.trainerId === profile.id && ['confirmed', 'completed'].includes(b.status) && (noRange || inRange(b.date)),
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
        member: m ? { id: m.id, displayName: m.displayName || null, photoUrl: m.photoUrl || null } : null,
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
    trainerMyBookings, trainerCompleteBooking, memberMyBookings,
    memberCancelBooking, trainerCancelBooking,
    createManualSession, trainerSessionsForDate, trainerEarnings,
  };
}
