// FitFlex Af — Trainer REST endpoints
// Export these from index.mjs by importing and re-exporting.
// They follow the exact same patterns as the existing endpoints:
//   { created, method, path, description, onGuard?, onRequest|onJob }
//
// To wire into the existing backend, add these lines to the top of index.mjs:
//
//   import { createTrainerService } from '../src/services/trainer-service.mjs';
//   import * as trainerEndpoints from './trainer-endpoints.mjs';
//
// Then at the bottom:
//   export * from './trainer-endpoints.mjs';
//
// And initialize the service:
//   const trainers = collection('trainers');
//   const bookings = collection('bookings');
//   const trainerService = createTrainerService({ users, gyms, subscriptions, checkins, trainers, bookings });

import { randomUUID } from 'node:crypto';
import { createTrainerService } from '../src/services/trainer-service.mjs';
import { BOOKING_STATUS, TRAINER_SPECIALIZATIONS, SESSION_TYPES } from '../src/shared/trainer-constants.mjs';

// These will be initialized by the host module — see wiring instructions above.
let trainerService = null;
let trainers = null;
let bookings = null;
let auditLog = null;
let requireAuth = null;
let users = null;
let gyms = null;
let subscriptions = null;

export function initTrainerEndpoints({ collection, requireAuth: ra, users: u, gyms: g, subscriptions: s, checkins: c, auditLog: al }) {
  trainers = collection('trainers');
  bookings = collection('bookings');
  auditLog = al;
  requireAuth = ra;
  users = u;
  gyms = g;
  subscriptions = s;
  trainerService = createTrainerService({ users, gyms, subscriptions, checkins, trainers, bookings });
}

const created = new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Public: List Trainers (no auth required — public marketplace browse)
// ─────────────────────────────────────────────────────────────────────────────
export const listTrainers = {
  created, method: 'get', path: '/trainers',
  description: 'Public list of active trainers. Supports ?specialization= and ?isMobile= filters.',
  requestSample: {},
  responseSample: [{ id: 'tr_abc', name: 'John Doe', specializations: ['CrossFit'], rating: 4.9 }],
  onRequest: (req, res) => {
    const { specialization, isMobile, sortBy } = req.query || {};
    const list = trainerService.listTrainers({
      specialization,
      isMobile: isMobile === 'true' ? true : isMobile === 'false' ? false : undefined,
      sortBy
    });
    res.json(list);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Public: Get Trainer Detail (auth optional — shows discounted price if logged in)
// ─────────────────────────────────────────────────────────────────────────────
export const getTrainerDetail = {
  created, method: 'get', path: '/trainers/:id',
  description: 'Public trainer detail. If authenticated as member, shows discounted price based on pass tier.',
  requestSample: {},
  responseSample: { id: 'tr_abc', name: 'John Doe', sessionPrice: 50000, discountedPrice: 45000 },
  onRequest: (req, res) => {
    // Try to extract member ID from auth token (optional auth)
    let viewerMemberId = null;
    const authHeader = req.headers?.authorization;
    if (authHeader && requireAuth) {
      try {
        // requireAuth middleware may have already set req.user
        if (req.user?.sub) viewerMemberId = req.user.sub;
      } catch (_) { /* ignore — public endpoint */ }
    }

    const detail = trainerService.getTrainerDetail(req.params.id, viewerMemberId);
    if (!detail) return res.status(404).json({ error: 'trainer_not_found' });
    res.json(detail);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Trainer: Onboard / Update Profile (trainer self-service)
// ─────────────────────────────────────────────────────────────────────────────
export const trainerUpsertProfile = {
  created, method: 'post', path: '/trainer/profile',
  description: 'Trainer: create or update own profile. Commission rate set at onboarding (15-20%).',
  requestSample: {
    name: 'John Doe',
    specializations: ['CrossFit', 'Strength Training'],
    bio: 'Certified PT with 10 years experience.',
    isMobile: true,
    sessionPrice: 50000,
    commissionRate: 0.15,
    affiliatedGyms: ['gym_001', 'gym_002'],
    certifications: ['NASM-CPT', 'CrossFit Level 2'],
    yearsExperience: 10
  },
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    const trainerId = `tr_${randomUUID().slice(0, 8)}`;
    const result = trainerService.upsertTrainerProfile(trainerId, req.user.sub, req.body || {});
    if (!result.ok) return res.status(400).json(result);

    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: 'trainer_profile_updated',
      target: trainerId, before: null, after: result.trainer
    });
    res.status(201).json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Trainer: Get/Set Availability
// ─────────────────────────────────────────────────────────────────────────────
export const trainerGetAvailability = {
  created, method: 'get', path: '/trainer/availability',
  description: 'Trainer: get current availability grid (Mon-Sun time slots).',
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    // Find trainer by userId
    const trainer = trainers.find(t => t.userId === req.user.sub);
    if (!trainer) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const availability = trainerService.getAvailability(trainer.id);
    res.json({ availability });
  }
};

export const trainerSetAvailability = {
  created, method: 'post', path: '/trainer/availability',
  description: 'Trainer: update availability grid. Each day has an array of { time, status } slots.',
  requestSample: {
    Mon: [{ time: '09:00', status: 'available' }, { time: '10:00', status: 'booked' }],
    Tue: [{ time: '09:00', status: 'available' }]
  },
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.userId === req.user.sub);
    if (!trainer) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const result = trainerService.setAvailability(trainer.id, req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: Book a Trainer Session
// ─────────────────────────────────────────────────────────────────────────────
export const bookTrainer = {
  created, method: 'post', path: '/me/book-trainer',
  description: 'Member: book a trainer session. Payout calculated at booking time (frozen). Payment pending until session completion.',
  requestSample: {
    trainerId: 'tr_abc',
    sessionType: 'personal_training',
    sessionDate: '2026-09-20',
    sessionTime: '09:00'
  },
  responseSample: {
    ok: true,
    booking: {
      id: 'bk_xyz', status: 'pending',
      payout: { sessionPrice: 50000, discountedPrice: 45000, trainerPayout: 38250 }
    }
  },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { trainerId, sessionType, sessionDate, sessionTime, sessionPrice } = req.body || {};
    if (!trainerId) return res.status(400).json({ error: 'trainerId_required' });
    if (!sessionDate || !sessionTime) return res.status(400).json({ error: 'session_date_and_time_required' });

    const result = trainerService.createBooking({
      memberId: req.user.sub,
      trainerId,
      sessionType,
      sessionDate,
      sessionTime,
      sessionPrice
    });

    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Trainer: Confirm / Cancel / Complete / No-Show bookings
// ─────────────────────────────────────────────────────────────────────────────
export const trainerConfirmBooking = {
  created, method: 'post', path: '/trainer/bookings/:id/confirm',
  description: 'Trainer: confirm a pending booking.',
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.userId === req.user.sub);
    if (!trainer) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const result = trainerService.confirmBooking(req.params.id, trainer.id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const trainerCancelBooking = {
  created, method: 'post', path: '/trainer/bookings/:id/cancel',
  description: 'Trainer: cancel a booking. Member receives full refund when trainer cancels.',
  requestSample: { reason: 'Schedule conflict' },
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.userId === req.user.sub);
    if (!trainer) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const result = trainerService.cancelBooking(req.params.id, trainer.id, req.body?.reason);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const trainerCompleteBooking = {
  created, method: 'post', path: '/trainer/bookings/:id/complete',
  description: 'Trainer: mark a confirmed booking as completed. Triggers payout.',
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.userId === req.user.sub);
    if (!trainer) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const result = trainerService.completeBooking(req.params.id, trainer.id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const trainerMarkNoShow = {
  created, method: 'post', path: '/trainer/bookings/:id/no-show',
  description: 'Trainer: mark a confirmed booking as no-show. Trainer still gets paid.',
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.userId === req.user.sub);
    if (!trainer) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const result = trainerService.markNoShow(req.params.id, trainer.id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: Cancel Own Booking (12-hour window for full refund)
// ─────────────────────────────────────────────────────────────────────────────
export const memberCancelBooking = {
  created, method: 'post', path: '/me/bookings/:id/cancel',
  description: 'Member: cancel own booking. Full refund if >= 12 hours before session.',
  requestSample: { reason: 'Schedule conflict' },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = trainerService.cancelBooking(req.params.id, req.user.sub, req.body?.reason);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: List Own Bookings
// ─────────────────────────────────────────────────────────────────────────────
export const memberBookings = {
  created, method: 'get', path: '/me/bookings',
  description: 'Member: list own trainer bookings (all statuses).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const list = bookings
      .filter(b => b.memberId === req.user.sub)
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .map(b => {
        const trainer = trainers.find(t => t.id === b.trainerId);
        return {
          ...b,
          trainerName: trainer?.name || null,
          trainerPhotoUrl: trainer?.imageUrls?.[0] || null,
          // Don't expose internal payout details to members
          payout: undefined
        };
      });
    res.json(list);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Trainer: Dashboard
// ─────────────────────────────────────────────────────────────────────────────
export const trainerDashboard = {
  created, method: 'get', path: '/trainer/dashboard',
  description: 'Trainer: dashboard with earnings, upcoming sessions, client roster, availability.',
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.userId === req.user.sub);
    if (!trainer) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const dashboard = trainerService.getTrainerDashboard(trainer.id);
    res.json(dashboard);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Trainer: List Own Bookings
// ─────────────────────────────────────────────────────────────────────────────
export const trainerBookings = {
  created, method: 'get', path: '/trainer/bookings',
  description: 'Trainer: list own bookings (all statuses, includes payout details).',
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.userId === req.user.sub);
    if (!trainer) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const list = bookings
      .filter(b => b.trainerId === trainer.id)
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .map(b => {
        const user = users.find(u => u.id === b.memberId);
        return {
          ...b,
          memberName: user?.displayName || null,
          memberPhotoUrl: user?.photoUrl || null
        };
      });
    res.json(list);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Trainer: Assign Nutrition Plan to Client
// ─────────────────────────────────────────────────────────────────────────────
export const trainerAssignNutritionPlan = {
  created, method: 'post', path: '/trainer/clients/:id/nutrition-plan',
  description: 'Trainer: assign a custom nutrition and/or workout plan to a client.',
  requestSample: {
    dailyCaloricTarget: 2200,
    macroSplit: { protein: 30, carbs: 40, fat: 30 },
    mealPlan: [{ meal: 'Breakfast', items: ['Oats', 'Banana', 'Whey protein'] }],
    workoutPlan: [{ day: 'Mon', focus: 'Push', exercises: ['Bench Press', 'Shoulder Press'] }]
  },
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.userId === req.user.sub);
    if (!trainer) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const result = trainerService.assignNutritionPlan(trainer.id, req.params.id, req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled: Auto-expire stale unconfirmed bookings
// ─────────────────────────────────────────────────────────────────────────────
export const expireStaleBookingsJob = {
  created, rule: '0 * * * *', // every hour
  description: 'Auto-expire trainer bookings that were not confirmed within 24 hours.',
  onJob: () => {
    const result = trainerService.expireStaleBookings();
    if (result.expired > 0) {
      console.log(`[trainer] expired ${result.expired} stale bookings`);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Verify/Approve Trainer
// ─────────────────────────────────────────────────────────────────────────────
export const adminVerifyTrainer = {
  created, method: 'post', path: '/admin/trainers/:id/verify',
  description: 'Admin: verify a trainer (marks them as isVerified=true). Audit logged.',
  requestSample: { isVerified: true },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.id === req.params.id);
    if (!trainer) return res.status(404).json({ error: 'trainer_not_found' });
    const { isVerified } = req.body || {};
    const updated = trainers.update(t => t.id === req.params.id, {
      isVerified: isVerified !== false,
      verifiedAt: new Date().toISOString()
    });
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: 'trainer_verified',
      target: req.params.id, before: trainer, after: updated
    });
    res.json(updated);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Meta: List available session types and specializations
// ─────────────────────────────────────────────────────────────────────────────
export const trainerMeta = {
  created, method: 'get', path: '/trainers/meta',
  description: 'Public: list available session types and specializations for UI dropdowns.',
  onRequest: (_, res) => {
    res.json({
      sessionTypes: Object.entries(SESSION_TYPES).map(([id, cfg]) => ({ id, ...cfg })),
      specializations: TRAINER_SPECIALIZATIONS
    });
  }
};
