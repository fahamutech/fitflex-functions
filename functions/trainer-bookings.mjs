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
  description: 'Member: book one or more trainer slots. POST { trainerId, gymId, slots:[{date,slot}] } (legacy { date, slot } still accepted). Bookings stay payment_pending until the payment request is approved. A trainer cannot book their own sessions (same account or same person): 403 cannot_book_own_sessions.',
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
  description: 'Admin: update trainer booking status. POST { status: confirmed|completed|cancelled }. A cancelled booking is final: 409 booking_cancelled (always). (With TRAINER_SESSION_OUTCOMES on, also no_show: after the session started, from confirmed|completed|cancelled; and any change to a booking on a submitted/approved/payable/paid trainer statement is refused with 409 booking_on_trainer_statement { statementId, statementStatus }). Flag on, the booking carries actions { canComplete, canMarkNoShow }.',
  onGuard: [requireAuth('admin'), requireAcl('trainers')],
  onRequest: async (req, res) => {
    const result = await trainerBookingService.adminUpdateStatus({ id: req.params.id, status: req.body?.status, actorId: req.user?.sub });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
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
  description: 'Trainer: mark a confirmed booking as completed, once the session has started (409 booking_not_confirmable if not confirmed; 409 session_not_started { startsAt } before its start — always, not behind a flag). Writes an audit row. → the booking (with actions { canComplete, canMarkNoShow } when TRAINER_SESSION_OUTCOMES is on).',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerBookingService.trainerCompleteBooking({ userId: req.user.sub, bookingId: req.params.id });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
    res.json(result.booking);
  }
};

export const trainerNoShowBooking = {
  created, method: 'post', path: '/trainer/bookings/:id/no-show',
  description: 'Trainer (TRAINER_SESSION_OUTCOMES; off: 404 feature_disabled): the member did not come. Confirmed sessions only (409 booking_not_confirmed), from the start (409 session_not_started { startsAt }) until 48 hours after it (409 no_show_window_passed { closedAt }). The trainer is paid in full, the member is not refunded, a sponsor benefit is used as if the session happened, and the member is notified. → the booking with status no_show and actions.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerBookingService.trainerMarkNoShow({ userId: req.user.sub, bookingId: req.params.id });
    if (result.error) {
      const { error, status, ...extra } = result;
      return res.status(status).json({ error, ...extra });
    }
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
