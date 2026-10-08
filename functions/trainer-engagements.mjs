// A4/C2/C3 — trainer engagement + sessions + earnings REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { trainerEngagementService, trainerBookingService, subscriptionService, trainerService, moderationGate } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// ── A4: member → trainer enquiries / interest ──────────────────────────────

export const memberEngageTrainer = {
  created, method: 'post', path: '/trainers/:id/engage',
  description: 'Member: send an enquiry (message required) or show interest (idempotent) in a trainer.',
  requestSample: { type: 'enquiry', message: 'Do you offer morning sessions?' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    // A trainer who is hidden or suspended in moderation cannot be newly engaged.
    if (await moderationGate.isBlocked('trainer', req.params.id)) return res.status(409).json({ error: 'trainer_unavailable' });
    const { type, message, gymId } = req.body || {};
    const result = await trainerEngagementService.create({
      memberId: req.user.sub, trainerId: req.params.id, type, message, gymId,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.idempotent ? 200 : 201).json(result);
  }
};

export const memberMyTrainerEngagements = {
  created, method: 'get', path: '/me/trainer-engagements',
  description: 'Member: own trainer enquiries and interests, most recent activity first, each with its conversation (messages) and whether the trainer replied since the member last read (unread).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await trainerEngagementService.listForMember({ memberId: req.user.sub });
    res.json(result.engagements);
  }
};

export const trainerMyEngagements = {
  created, method: 'get', path: '/trainer/engagements',
  description: 'Trainer: member enquiries and interests, most recent activity first, each with its conversation (messages), status (new | read | replied | closed) and unread.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerEngagementService.listForTrainer({ userId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.engagements);
  }
};

const sendResult = (res, result) => (result.error
  ? res.status(result.status).json({ error: result.error })
  : res.json(result.engagement));

export const trainerReplyEngagement = {
  created, method: 'post', path: '/trainer/engagements/:id/reply',
  description: 'Trainer: reply to a member enquiry or interest. POST { message } (1–1000 chars). The member is notified (inbox + push).',
  requestSample: { message: 'Yes — I have 6am slots at Gym Tu on weekdays.' },
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => sendResult(res, await trainerEngagementService.replyAsTrainer({
    userId: req.user.sub, id: req.params.id, message: req.body?.message,
  })),
};

export const trainerReadEngagement = {
  created, method: 'post', path: '/trainer/engagements/:id/read',
  description: 'Trainer: mark a conversation as read (a new enquiry becomes "read").',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => sendResult(res, await trainerEngagementService.markReadByTrainer({ userId: req.user.sub, id: req.params.id })),
};

export const trainerCloseEngagement = {
  created, method: 'post', path: '/trainer/engagements/:id/close',
  description: 'Trainer: close a conversation. A member follow-up reopens it.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => sendResult(res, await trainerEngagementService.closeByTrainer({ userId: req.user.sub, id: req.params.id })),
};

export const memberReplyEngagement = {
  created, method: 'post', path: '/me/trainer-engagements/:id/reply',
  description: 'Member: follow up on an enquiry with the trainer. POST { message }. The trainer is notified.',
  requestSample: { message: 'Great — can I start Monday?' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => sendResult(res, await trainerEngagementService.replyAsMember({
    memberId: req.user.sub, id: req.params.id, message: req.body?.message,
  })),
};

export const memberReadEngagement = {
  created, method: 'post', path: '/me/trainer-engagements/:id/read',
  description: "Member: mark the trainer's replies as read.",
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => sendResult(res, await trainerEngagementService.markReadByMember({ memberId: req.user.sub, id: req.params.id })),
};

// ── C3: trainer sessions (bookings + manual) ───────────────────────────────

export const trainerSessionsForDate = {
  created, method: 'get', path: '/trainer/sessions',
  description: "Trainer: sessions for a date (defaults to today) — bookings plus manually recorded sessions. Query: ?date=YYYY-MM-DD.",
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerBookingService.trainerSessionsForDate({
      userId: req.user.sub, date: req.query?.date,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const trainerCreateManualSession = {
  created, method: 'post', path: '/trainer/sessions',
  description: 'Trainer: record a manual session (walk-in client) with customer email/phone and gym.',
  requestSample: { customerName: 'Walk-in', customerPhone: '+2557XXXXXXXX', gymId: 'gym_1', date: '2026-08-07', slot: '10:00', amountTzs: 15000 },
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerBookingService.createManualSession({
      userId: req.user.sub, body: req.body || {},
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result);
  }
};

// ── C4/B12: trainer pass purchase ──────────────────────────────────────────

export const trainerPurchaseTrainerPass = {
  created, method: 'post', path: '/trainer/gyms/:gymId/trainer-pass',
  description: "Trainer: buy one of the gym's trainer passes. POST { period: 'daily'|'weekly'|'monthly' } (optional when the gym sells one period). Pending until an admin approves the payment.",
  requestSample: { period: 'weekly' },
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await subscriptionService.trainerPassPurchase({
      trainerUserId: req.user.sub,
      gymId: req.params.gymId,
      period: req.body?.period,
      trainer: trainerService.findProfileByUser(req.user.sub),
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.status).json({ subscription: result.subscription, paymentRequest: result.paymentRequest });
  }
};

// ── C2: trainer earnings ───────────────────────────────────────────────────

export const trainerEarnings = {
  created, method: 'get', path: '/trainer/earnings',
  description: 'Trainer: earnings auto-calculated from non-cancelled bookings + manual sessions. Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerBookingService.trainerEarnings({
      userId: req.user.sub, from: req.query?.from, to: req.query?.to,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.earnings);
  }
};
