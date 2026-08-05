// Trainer booking REST surface — member creation, admin oversight, trainer session mgmt.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { trainerBookingService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const createTrainerBooking = {
  created, method: 'post', path: '/me/trainer-bookings',
  description: 'Member: book a trainer session. Pilot status is confirmed immediately.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await trainerBookingService.createBooking({ memberId: req.user.sub, body: req.body || {} });
    if (result.error) return res.status(result.status).json({ error: result.error });
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
