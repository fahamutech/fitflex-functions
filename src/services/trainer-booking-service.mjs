// Trainer booking service — member booking creation + trainer/admin session management.
import { randomUUID } from 'node:crypto';
import { priceBooking, passDiscountPct, trainerCommissionPct } from '../shared/trainer-pricing.mjs';
import { effectiveSubscriptionStatus } from '../shared/subscription-status.mjs';

// A booking holds its slots from the moment it is requested; one that was
// rejected or cancelled frees them again.
const SLOT_RELEASING = new Set(['cancelled', 'payment_rejected']);
const MAX_SLOTS_PER_BOOKING = 12;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * C1: does the trainer's configured availability cover this date+slot (+gym)?
 * Trainers with NO configured availability accept any slot (legacy profiles).
 */
export function slotIsAvailable(availability, { date, slot, gymId }) {
  const entries = Array.isArray(availability) ? availability : [];
  if (entries.length === 0) return true;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const dayName = Number.isNaN(+parsed) ? null : WEEKDAYS[parsed.getUTCDay()];
  return entries.some((entry) => {
    const day = String(entry.day || '').toLowerCase();
    const dayMatches = day === dayName || day === date; // weekday or legacy exact-date entries
    if (!dayMatches) return false;
    if (entry.gymId && gymId && entry.gymId !== gymId) return false;
    return (entry.slots || []).includes(slot);
  });
}

export function createTrainerBookingService({
  trainerBookings, trainerSessions, trainers, gyms, users, auditLog, trainerService,
  subscriptions, paymentRequests, notify = async () => {},
}) {
  async function hydrateBooking(row) {
    return {
      ...row,
      member: await users.findByIdAsync(row.memberId),
      trainer: row.trainerId ? trainerService.hydrateTrainer(trainers.find(t => t.id === row.trainerId) || {}) : null,
      gym: gyms.find(g => g.id === row.gymId) || null
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
      const key = `${s?.date}|${s?.slot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ date: s?.date, slot: s?.slot });
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
    if (!trainer.gymIds?.includes(gymId)) return { error: 'trainer_not_available_at_gym', status: 400 };
    const slots = requestedSlots(body);
    if (!slots.length || slots.some(s => !s.date || !s.slot)) return { error: 'date_and_slot_required', status: 400 };
    if (slots.length > MAX_SLOTS_PER_BOOKING) return { error: 'too_many_slots', status: 400 };

    for (const s of slots) {
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
        paymentRequestId,
        status: needsPayment ? 'payment_pending' : 'confirmed',
        createdAt: now,
        updatedAt: now,
      }));
    }

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
    const updated = await trainerBookings.updateByIdAsync(prior.id, { status, updatedAt: new Date().toISOString() });
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: `trainer_booking_${status}`,
      target: prior.id, before: prior, after: updated
    });
    return { booking: await hydrateBooking(updated) };
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
    return { booking: await hydrateBooking(updated) };
  }

  async function memberMyBookings(memberId) {
    const allBookings = await trainerBookings.filterAsync(b => b.memberId === memberId);
    return Promise.all(
      allBookings
        .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
        .map(b => hydrateBooking(b))
    );
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
        gym: gyms.find(g => g.id === b.gymId) || null,
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
        gym: gyms.find(g => g.id === s.gymId) || null,
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

  return {
    hydrateBooking, quoteBooking, createBooking, applyPaymentToGroup, adminList, adminUpdateStatus,
    trainerMyBookings, trainerCompleteBooking, memberMyBookings,
    createManualSession, trainerSessionsForDate, trainerEarnings,
  };
}
