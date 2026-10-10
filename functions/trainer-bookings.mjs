// Trainer booking REST surface — member creation, admin oversight, trainer session mgmt.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { trainerBookingService, moderationGate } from '../src/bootstrap/services.mjs';

/** A trainer who is hidden or suspended in moderation cannot be newly booked. Existing bookings carry on. */
const trainerUnavailable = async req => !!req.body?.trainerId && await moderationGate.isBlocked('trainer', req.body.trainerId);

const created = new Date().toISOString();

export const quoteTrainerBooking = {
  created, method: 'post', path: '/me/trainer-bookings/quote',
  description: 'Member: price one or more slots before booking. POST { trainerId, gymId, slots:[{date,slot}] } → summary (Pass discount applied).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    if (await trainerUnavailable(req)) return res.status(409).json({ error: 'trainer_unavailable' });
    const result = await trainerBookingService.quoteBooking({ memberId: req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error, slot: result.slot });
    res.json(result);
  }
};

export const createTrainerBooking = {
  created, method: 'post', path: '/me/trainer-bookings',
  description: 'Member: book one or more trainer slots. POST { trainerId, gymId, slots:[{date,slot}] } (legacy { date, slot } still accepted). Bookings stay payment_pending until the payment request is approved.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    if (await trainerUnavailable(req)) return res.status(409).json({ error: 'trainer_unavailable' });
    const result = await trainerBookingService.createBooking({ memberId: req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error, slot: result.slot });
    res.status(201).json(result);
  }
};

export const adminListTrainerBookings = {
  created, method: 'get', path: '/admin/trainer-bookings',
  description: 'Admin: list trainer sessions and booking status.',
  onGuard: [requireAuth('admin'), requireAcl('trainers')],
  onRequest: async (_, res) => res.json(await trainerBookingService.adminList())
};

export const adminUpdateTrainerBooking = {
  created, method: 'post', path: '/admin/trainer-bookings/:id',
  description: 'Admin: update trainer booking status.',
  onGuard: [requireAuth('admin'), requireAcl('trainers')],
  onRequest: async (req, res) => {
    const result = await trainerBookingService.adminUpdateStatus({ id: req.params.id, status: req.body?.status, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.booking);
  }
};

export const trainerMyBookings = {
  created, method: 'get', path: '/trainer/bookings',
  description: 'Trainer: list bookings assigned to this trainer.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerBookingService.trainerMyBookings(req.user.sub);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.bookings);
  }
};

export const trainerCompleteBooking = {
  created, method: 'post', path: '/trainer/bookings/:id/complete',
  description: 'Trainer: mark a booking as completed.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerBookingService.trainerCompleteBooking({ userId: req.user.sub, bookingId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.booking);
  }
};

export const memberMyBookings = {
  created, method: 'get', path: '/me/trainer-bookings',
  description: 'Member: list own trainer bookings.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => res.json(await trainerBookingService.memberMyBookings(req.user.sub))
};

export const trainerPublicSchedule = {
  created, method: 'get', path: '/trainers/:id/schedule',
  description: 'Public: a trainer\'s bookable calendar. Query: ?from=YYYY-MM-DD&days=21&gymId= → { days:[{ date, weekday, slots:[{ slot, status: available|booked|past, gymIds }] }] } (EAT; no member details).',
  onRequest: async (req, res) => {
    const { from, days, gymId } = req.query || {};
    const result = await trainerBookingService.publicSchedule({ trainerId: req.params.id, from, days, gymId });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const trainerMySchedule = {
  created, method: 'get', path: '/trainer/schedule',
  description: 'Trainer: own calendar with who booked each taken slot. Query: ?from=YYYY-MM-DD&days=21&gymId=',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const { from, days, gymId } = req.query || {};
    const result = await trainerBookingService.trainerSchedule({ userId: req.user.sub, from, days, gymId });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};
