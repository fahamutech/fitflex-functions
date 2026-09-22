// FitFlex Af — Trainer Service (clean architecture + DI)
// Implements: trainer CRUD, availability management, booking flow,
// payout calculation, trainer dashboard, and client management.
//
// Business rules enforced:
//   - Trainer commission 15-20%, negotiated at onboarding (TR)
//   - FitFlex absorbs member discount, NOT the trainer
//   - Payout = discountedPrice - commission on discountedPrice
//   - 12-hour cancellation window for full refund
//   - 24-hour auto-confirm window (unconfirmed bookings expire)
//   - Trainer availability is a Mon-Sun time slot grid

import { randomUUID } from 'node:crypto';
import {
  TRAINER_COMMISSION_RANGE,
  SESSION_TYPES,
  BOOKING_STATUS,
  CANCELLATION_WINDOW_HOURS,
  CONFIRMATION_WINDOW_HOURS,
  TRAINER_SPECIALIZATIONS,
  calculateTrainerPayout
} from '../shared/trainer-constants.mjs';

export function createTrainerService({ users, gyms, subscriptions, checkins, trainers, bookings }) {
  // ─── Validation helpers ───────────────────────────────────────────────────

  function validateCommissionRate(rate) {
    if (typeof rate !== 'number' || rate < TRAINER_COMMISSION_RANGE.min || rate > TRAINER_COMMISSION_RANGE.max) {
      return { valid: false, error: `commissionRate must be between ${TRAINER_COMMISSION_RANGE.min} and ${TRAINER_COMMISSION_RANGE.max}` };
    }
    return { valid: true };
  }

  function validateSpecializations(specs) {
    if (!Array.isArray(specs) || specs.length === 0)
      return { valid: false, error: 'at_least_one_specialization_required' };
    const invalid = specs.filter(s => !TRAINER_SPECIALIZATIONS.includes(s));
    if (invalid.length)
      return { valid: false, error: `invalid_specializations: ${invalid.join(', ')}` };
    return { valid: true };
  }

  function generateDefaultAvailability() {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const defaultTimes = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
    const availability = {};
    for (const day of days) {
      availability[day] = defaultTimes.map(time => ({ time, status: 'available' }));
    }
    return availability;
  }

  // ─── Trainer Profile Management ──────────────────────────────────────────

  function getTrainerProfile(trainerId) {
    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return null;
    const user = users.find(u => u.id === trainer.userId);
    return {
      ...trainer,
      name: user?.displayName || trainer.name,
      photoUrl: user?.photoUrl || null,
      phone: user?.phone || null,
      email: user?.email || null
    };
  }

  function listTrainers({ specialization, isMobile, sortBy } = {}) {
    let list = trainers.filter(t => t.status === 'active');

    if (specialization) {
      list = list.filter(t => t.specializations.includes(specialization));
    }
    if (typeof isMobile === 'boolean') {
      list = list.filter(t => t.isMobile === isMobile);
    }

    // Attach user info
    list = list.map(t => {
      const user = users.find(u => u.id === t.userId);
      return {
        ...t,
        name: user?.displayName || t.name,
        photoUrl: user?.photoUrl || null,
        rating: t.rating || 0,
        totalSessions: bookings.filter(b => b.trainerId === t.id && b.status === BOOKING_STATUS.COMPLETED).length
      };
    });

    if (sortBy === 'rating') {
      list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else if (sortBy === 'price_low') {
      list.sort((a, b) => (a.sessionPrice || 0) - (b.sessionPrice || 0));
    } else if (sortBy === 'price_high') {
      list.sort((a, b) => (b.sessionPrice || 0) - (a.sessionPrice || 0));
    }

    return list;
  }

  // ─── Trainer Onboarding / Profile Update ──────────────────────────────────

  function upsertTrainerProfile(trainerId, userId, data) {
    const { name, specializations, bio, isMobile, sessionPrice, commissionRate, affiliatedGyms, certifications, yearsExperience, imageUrls } = data;

    if (!name) return { ok: false, error: 'name_required' };
    if (commissionRate !== undefined) {
      const v = validateCommissionRate(commissionRate);
      if (!v.valid) return { ok: false, error: v.error };
    }
    if (specializations) {
      const v = validateSpecializations(specializations);
      if (!v.valid) return { ok: false, error: v.error };
    }

    const existing = trainers.find(t => t.id === trainerId);
    const now = new Date().toISOString();

    const payload = {
      id: trainerId,
      userId,
      name,
      specializations: specializations || existing?.specializations || [],
      bio: bio || existing?.bio || null,
      isMobile: typeof isMobile === 'boolean' ? isMobile : (existing?.isMobile ?? true),
      sessionPrice: sessionPrice !== undefined ? Number(sessionPrice) : (existing?.sessionPrice ?? SESSION_TYPES.personal_training.defaultPrice),
      commissionRate: commissionRate !== undefined ? Number(commissionRate) : (existing?.commissionRate ?? TRAINER_COMMISSION_RANGE.default),
      affiliatedGyms: affiliatedGyms || existing?.affiliatedGyms || [],
      certifications: certifications || existing?.certifications || [],
      yearsExperience: yearsExperience !== undefined ? Number(yearsExperience) : (existing?.yearsExperience ?? 0),
      imageUrls: imageUrls || existing?.imageUrls || [],
      status: existing?.status || 'active',
      rating: existing?.rating || 0,
      reviewCount: existing?.reviewCount || 0,
      availability: existing?.availability || generateDefaultAvailability(),
      updatedAt: now,
      createdAt: existing?.createdAt || now
    };

    trainers.upsert(t => t.id === trainerId, payload);
    return { ok: true, trainer: payload };
  }

  // ─── Availability Management ─────────────────────────────────────────────

  function getAvailability(trainerId) {
    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return null;
    return trainer.availability || generateDefaultAvailability();
  }

  function setAvailability(trainerId, availability) {
    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return { ok: false, error: 'trainer_not_found' };

    // Validate structure: { Mon: [{ time: '09:00', status: 'available'|'booked' }], ... }
    const validDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (const day of validDays) {
      if (!availability[day]) continue;
      if (!Array.isArray(availability[day]))
        return { ok: false, error: `invalid_availability_format_for_${day}` };
      for (const slot of availability[day]) {
        if (!slot.time || !['available', 'booked'].includes(slot.status))
          return { ok: false, error: 'invalid_slot_format' };
      }
    }

    const updated = trainers.update(t => t.id === trainerId, { availability });
    return { ok: true, availability: updated.availability };
  }

  // ─── Booking Flow ─────────────────────────────────────────────────────────

  function createBooking({ memberId, trainerId, sessionType, sessionDate, sessionTime, sessionPrice }) {
    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return { ok: false, error: 'trainer_not_found' };
    if (trainer.status !== 'active') return { ok: false, error: 'trainer_not_available' };

    // Validate session type
    if (sessionType && !SESSION_TYPES[sessionType])
      return { ok: false, error: 'invalid_session_type' };

    // Use trainer's default price if not specified
    const price = sessionPrice !== undefined ? Number(sessionPrice) : trainer.sessionPrice;
    if (typeof price !== 'number' || price < 0)
      return { ok: false, error: 'invalid_session_price' };

    // Check if the time slot is available
    const dayName = new Date(sessionDate).toLocaleDateString('en-US', { weekday: 'short' });
    const dayAvail = trainer.availability?.[dayName] || [];
    const slot = dayAvail.find(s => s.time === sessionTime);
    if (slot && slot.status === 'booked')
      return { ok: false, error: 'slot_already_booked' };

    // Calculate payout (straight commission — no tier discount at this time)
    const payout = calculateTrainerPayout({
      sessionPrice: price,
      commissionRate: trainer.commissionRate
    });

    const now = new Date();
    const sessionDateTime = new Date(`${sessionDate}T${sessionTime}:00`);
    const confirmDeadline = new Date(+now + CONFIRMATION_WINDOW_HOURS * 60 * 60 * 1000);

    const booking = {
      id: `bk_${randomUUID().slice(0, 8)}`,
      memberId,
      trainerId,
      sessionType: sessionType || 'personal_training',
      sessionDate,
      sessionTime,
      sessionPrice: price,
      status: BOOKING_STATUS.PENDING,
      // Payout breakdown (frozen at booking time — not recalculated on confirm)
      payout: {
        ...payout,
        trainerCommissionRate: trainer.commissionRate
      },
      // Payment
      paymentStatus: 'pending', // pending | paid | refunded
      paymentRef: null,
      // Timestamps
      createdAt: now.toISOString(),
      confirmedAt: null,
      completedAt: null,
      cancelledAt: null,
      cancelReason: null,
      // Auto-expire if trainer doesn't confirm within 24h
      confirmDeadline: confirmDeadline.toISOString()
    };

    bookings.insert(booking);

    // Mark the slot as booked in trainer availability
    if (slot) {
      const newAvail = { ...trainer.availability };
      newAvail[dayName] = newAvail[dayName].map(s =>
        s.time === sessionTime ? { ...s, status: 'booked' } : s
      );
      trainers.update(t => t.id === trainerId, { availability: newAvail });
    }

    return { ok: true, booking };
  }

  function confirmBooking(bookingId, trainerId) {
    const booking = bookings.find(b => b.id === bookingId);
    if (!booking) return { ok: false, error: 'booking_not_found' };
    if (booking.trainerId !== trainerId)
      return { ok: false, error: 'not_authorized' };
    if (booking.status !== BOOKING_STATUS.PENDING)
      return { ok: false, error: 'booking_not_pending' };

    const now = new Date().toISOString();
    const updated = bookings.update(b => b.id === bookingId, {
      status: BOOKING_STATUS.CONFIRMED,
      confirmedAt: now
    });

    return { ok: true, booking: updated };
  }

  function cancelBooking(bookingId, cancelledBy, reason) {
    const booking = bookings.find(b => b.id === bookingId);
    if (!booking) return { ok: false, error: 'booking_not_found' };

    const isMember = cancelledBy === booking.memberId;
    const isTrainer = cancelledBy === booking.trainerId;
    if (!isMember && !isTrainer)
      return { ok: false, error: 'not_authorized' };

    if (![BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED].includes(booking.status))
      return { ok: false, error: 'booking_not_cancellable' };

    // Check cancellation window (12 hours before session for full refund)
    const sessionDateTime = new Date(`${booking.sessionDate}T${booking.sessionTime}:00`);
    const hoursUntilSession = (+sessionDateTime - Date.now()) / (60 * 60 * 1000);
    const withinWindow = hoursUntilSession >= CANCELLATION_WINDOW_HOURS;

    const status = isMember ? BOOKING_STATUS.CANCELLED_MEMBER : BOOKING_STATUS.CANCELLED_TRAINER;
    const now = new Date().toISOString();

    const updated = bookings.update(b => b.id === bookingId, {
      status,
      cancelledAt: now,
      cancelReason: reason || null,
      // Refund logic: if within 12h window, full refund.
      // If trainer cancelled, member always gets full refund.
      paymentStatus: (isTrainer || withinWindow) ? 'refunded' : booking.paymentStatus
    });

    // Free up the trainer's availability slot
    const trainer = trainers.find(t => t.id === booking.trainerId);
    if (trainer) {
      const dayName = new Date(booking.sessionDate).toLocaleDateString('en-US', { weekday: 'short' });
      if (trainer.availability?.[dayName]) {
        const newAvail = { ...trainer.availability };
        newAvail[dayName] = newAvail[dayName].map(s =>
          s.time === booking.sessionTime ? { ...s, status: 'available' } : s
        );
        trainers.update(t => t.id === trainerId, { availability: newAvail });
      }
    }

    return { ok: true, booking: updated, refundIssued: isTrainer || withinWindow };
  }

  function completeBooking(bookingId, trainerId) {
    const booking = bookings.find(b => b.id === bookingId);
    if (!booking) return { ok: false, error: 'booking_not_found' };
    if (booking.trainerId !== trainerId)
      return { ok: false, error: 'not_authorized' };
    if (booking.status !== BOOKING_STATUS.CONFIRMED)
      return { ok: false, error: 'booking_not_confirmed' };

    const now = new Date().toISOString();
    const updated = bookings.update(b => b.id === bookingId, {
      status: BOOKING_STATUS.COMPLETED,
      completedAt: now,
      paymentStatus: 'paid',
      payoutRef: `pyr_${randomUUID().slice(0, 8)}`
    });

    return { ok: true, booking: updated };
  }

  function markNoShow(bookingId, trainerId) {
    const booking = bookings.find(b => b.id === bookingId);
    if (!booking) return { ok: false, error: 'booking_not_found' };
    if (booking.trainerId !== trainerId)
      return { ok: false, error: 'not_authorized' };
    if (booking.status !== BOOKING_STATUS.CONFIRMED)
      return { ok: false, error: 'booking_not_confirmed' };

    // Trainer still gets paid on no-show (per standard policy)
    const now = new Date().toISOString();
    const updated = bookings.update(b => b.id === bookingId, {
      status: BOOKING_STATUS.NO_SHOW,
      completedAt: now,
      paymentStatus: 'paid',
      payoutRef: `pyr_${randomUUID().slice(0, 8)}`
    });

    return { ok: true, booking: updated };
  }

  // ─── Trainer Dashboard ────────────────────────────────────────────────────

  function getTrainerDashboard(trainerId) {
    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return null;

    const trainerBookings = bookings.filter(b => b.trainerId === trainerId);

    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);

    const monthBookings = trainerBookings.filter(b => +new Date(b.createdAt) >= +startOfMonth);
    const todayBookings = trainerBookings.filter(b => +new Date(b.sessionDate) >= +startOfDay);

    const completedBookings = trainerBookings.filter(b => b.status === BOOKING_STATUS.COMPLETED || b.status === BOOKING_STATUS.NO_SHOW);
    const totalEarnings = completedBookings.reduce((sum, b) => sum + (b.payout?.trainerPayout || 0), 0);
    const monthEarnings = monthBookings.filter(b => b.status === BOOKING_STATUS.COMPLETED || b.status === BOOKING_STATUS.NO_SHOW)
      .reduce((sum, b) => sum + (b.payout?.trainerPayout || 0), 0);

    const pendingBookings = trainerBookings.filter(b => b.status === BOOKING_STATUS.PENDING);
    const upcomingBookings = trainerBookings
      .filter(b => [BOOKING_STATUS.CONFIRMED].includes(b.status) && new Date(`${b.sessionDate}T${b.sessionTime}:00`) >= startOfDay)
      .sort((a, b2) => +new Date(`${a.sessionDate}T${a.sessionTime}:00`) - +new Date(`${b2.sessionDate}T${b2.sessionTime}:00`));

    // Client roster
    const clientIds = [...new Set(trainerBookings.map(b => b.memberId))];
    const clients = clientIds.map(id => {
      const user = users.find(u => u.id === id);
      const clientBookings = trainerBookings.filter(b => b.memberId === id);
      return {
        id,
        name: user?.displayName || null,
        photoUrl: user?.photoUrl || null,
        totalSessions: clientBookings.length,
        completedSessions: clientBookings.filter(b => b.status === BOOKING_STATUS.COMPLETED).length,
        lastSessionDate: clientBookings
          .filter(b => b.completedAt)
          .sort((a, b2) => +new Date(b2.completedAt) - +new Date(a.completedAt))[0]?.completedAt || null
      };
    });

    return {
      trainer,
      stats: {
        totalSessions: completedBookings.length,
        totalEarnings,
        monthEarnings,
        pendingBookings: pendingBookings.length,
        upcomingBookings: upcomingBookings.length,
        activeClients: clients.filter(c => c.completedSessions > 0).length,
        rating: trainer.rating || 0,
        reviewCount: trainer.reviewCount || 0
      },
      upcomingBookings: upcomingBookings.slice(0, 10),
      pendingBookings: pendingBookings.slice(0, 10),
      clients,
      availability: trainer.availability
    };
  }

  // ─── Member-facing: Get Trainer Detail ───────────────────────────────────

  function getTrainerDetail(trainerId, viewerMemberId) {
    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return null;

    // Don't expose commission rate to members
    const { commissionRate, ...publicData } = trainer;

    // Show available slots only
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const availableSlots = {};
    for (const day of days) {
      if (trainer.availability?.[day]) {
        availableSlots[day] = trainer.availability[day].filter(s => s.status === 'available');
      }
    }

    return {
      ...publicData,
      sessionPrice: trainer.sessionPrice,
      availableSlots,
      affiliatedGymDetails: (trainer.affiliatedGyms || [])
        .map(id => gyms.find(g => g.id === id))
        .filter(Boolean)
        .map(g => ({ id: g.id, name: g.name, location: g.location, tier: g.tier }))
    };
  }

  // ─── Nutrition Plan Assignment ────────────────────────────────────────────

  function assignNutritionPlan(trainerId, clientId, plan) {
    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return { ok: false, error: 'trainer_not_found' };

    // Verify the client has booked this trainer
    const hasBooking = bookings.some(b => b.trainerId === trainerId && b.memberId === clientId);
    if (!hasBooking) return { ok: false, error: 'client_has_no_booking_with_trainer' };

    const nutritionPlan = {
      id: `np_${randomUUID().slice(0, 8)}`,
      trainerId,
      clientId,
      dailyCaloricTarget: plan.dailyCaloricTarget || null,
      macroSplit: plan.macroSplit || null,  // { protein: %, carbs: %, fat: % }
      mealPlan: plan.mealPlan || null,      // array of meal objects
      workoutPlan: plan.workoutPlan || null, // array of workout objects
      notes: plan.notes || null,
      createdAt: new Date().toISOString()
    };

    // Store in a nutrition_plans collection (would need to be passed in)
    // For now, we return it — the caller can persist it
    return { ok: true, nutritionPlan };
  }

  // ─── Auto-expire stale bookings ──────────────────────────────────────────

  function expireStaleBookings() {
    const now = Date.now();
    const stale = bookings.filter(b =>
      b.status === BOOKING_STATUS.PENDING &&
      b.confirmDeadline &&
      new Date(b.confirmDeadline).getTime() < now
    );

    for (const booking of stale) {
      bookings.update(b => b.id === booking.id, {
        status: BOOKING_STATUS.EXPIRED,
        cancelledAt: new Date().toISOString(),
        cancelReason: 'auto_expired_no_trainer_confirmation'
      });

      // Free up the availability slot
      const trainer = trainers.find(t => t.id === booking.trainerId);
      if (trainer?.availability) {
        const dayName = new Date(booking.sessionDate).toLocaleDateString('en-US', { weekday: 'short' });
        if (trainer.availability[dayName]) {
          const newAvail = { ...trainer.availability };
          newAvail[dayName] = newAvail[dayName].map(s =>
            s.time === booking.sessionTime ? { ...s, status: 'available' } : s
          );
          trainers.update(t => t.id === booking.id, { availability: newAvail });
        }
      }
    }

    return { expired: stale.length };
  }

  return {
    // Trainer profile
    getTrainerProfile,
    listTrainers,
    upsertTrainerProfile,
    getTrainerDetail,
    // Availability
    getAvailability,
    setAvailability,
    // Bookings
    createBooking,
    confirmBooking,
    cancelBooking,
    completeBooking,
    markNoShow,
    expireStaleBookings,
    // Dashboard
    getTrainerDashboard,
    // Nutrition
    assignNutritionPlan,
    // Constants (re-exported for tests)
    _constants: {
      TRAINER_COMMISSION_RANGE,
      TRAINER_DISCOUNT_BY_TIER,
      SESSION_TYPES,
      BOOKING_STATUS,
      CANCELLATION_WINDOW_HOURS,
      CONFIRMATION_WINDOW_HOURS,
      TRAINER_SPECIALIZATIONS
    }
  };
}
