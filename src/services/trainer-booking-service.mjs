// Trainer booking service — member booking creation + trainer/admin session management.
import { randomUUID } from 'node:crypto';

export function createTrainerBookingService({ trainerBookings, trainers, gyms, users, auditLog, trainerService }) {
  async function hydrateBooking(row) {
    return {
      ...row,
      member: await users.findByIdAsync(row.memberId),
      trainer: row.trainerId ? trainerService.hydrateTrainer(trainers.find(t => t.id === row.trainerId) || {}) : null,
      gym: gyms.find(g => g.id === row.gymId) || null
    };
  }

  async function createBooking({ memberId, body }) {
    const { trainerId, gymId, date, slot } = body || {};
    const trainer = trainers.find(t => t.id === trainerId && t.status === 'active');
    if (!trainer) return { error: 'trainer_not_found', status: 404 };
    if (!trainer.gymIds?.includes(gymId)) return { error: 'trainer_not_available_at_gym', status: 400 };
    if (!date || !slot) return { error: 'date_and_slot_required', status: 400 };
    const booking = await trainerBookings.insertAsync({
      id: `tbk_${randomUUID().slice(0, 8)}`,
      memberId,
      trainerId,
      gymId,
      date,
      slot,
      amountTzs: trainer.hourlyRateTzs,
      status: 'confirmed',
      createdAt: new Date().toISOString()
    });
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: memberId, action: 'trainer_booking_created',
      target: booking.id, before: null, after: booking
    });
    return { booking, trainer: trainerService.hydrateTrainer(trainer) };
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
    auditLog.insert({
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

  return { hydrateBooking, createBooking, adminList, adminUpdateStatus, trainerMyBookings, trainerCompleteBooking, memberMyBookings };
}
