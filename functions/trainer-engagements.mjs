// A4/C2/C3 — trainer engagement + sessions + earnings REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { trainerEngagementService, trainerBookingService, subscriptionService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// ── A4: member → trainer enquiries / interest ──────────────────────────────

export const memberEngageTrainer = {
  created, method: 'post', path: '/trainers/:id/engage',
  description: 'Member: send an enquiry (message required) or show interest (idempotent) in a trainer.',
  requestSample: { type: 'enquiry', message: 'Do you offer morning sessions?' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
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
  description: 'Member: list own trainer enquiries and interests.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await trainerEngagementService.listForMember({ memberId: req.user.sub });
    res.json(result.engagements);
  }
};

export const trainerMyEngagements = {
  created, method: 'get', path: '/trainer/engagements',
  description: 'Trainer: list member enquiries and interests, newest first.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await trainerEngagementService.listForTrainer({ userId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.engagements);
  }
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
  description: "Trainer: pay a gym's trainer-pass fee (pending admin payment approval) to train clients there.",
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const result = await subscriptionService.trainerPassPurchase({
      trainerUserId: req.user.sub, gymId: req.params.gymId,
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
