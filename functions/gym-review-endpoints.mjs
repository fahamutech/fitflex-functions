// FitFlex Af — Gym Review REST Endpoints
//
// Endpoints for the gym review system:
//   - Members submit/update/delete their own reviews
//   - Public: view gym reviews + rating summaries
//   - Admin: moderate reviews + view tier ranking signals
//   - Gym owner: view reviews for their gym (read-only)
//
// To wire into index.mjs:
//   import { createGymReviewService } from '../src/services/gym-review-service.mjs';
//   import { initGymReviewEndpoints } from './gym-review-endpoints.mjs';
//
//   const reviews = collection('reviews');
//   const gymReviewService = createGymReviewService({ users, gyms, subscriptions, checkins, reviews });
//   initGymReviewEndpoints({ gymReviewService, requireAuth, auditLog, users });

import { randomUUID } from 'node:crypto';
import { createGymReviewService } from '../src/services/gym-review-service.mjs';

let gymReviewService = null;
let requireAuth = null;
let auditLog = null;
let users = null;

export function initGymReviewEndpoints({ collection, requireAuth: ra, auditLog: al, users: u }) {
  const reviews = collection('reviews');
  gymReviewService = createGymReviewService({
    users: u,
    gyms: collection('gyms'),
    subscriptions: collection('subscriptions'),
    checkins: collection('checkins'),
    reviews
  });
  requireAuth = ra;
  auditLog = al;
  users = u;
}

const created = new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Public: Get Gym Reviews (no auth — public listing)
// ─────────────────────────────────────────────────────────────────────────────
export const getGymReviews = {
  created, method: 'get', path: '/gyms/:id/reviews',
  description: 'Public: list published reviews for a gym. ?sortBy=recent|highest|lowest&limit=50',
  onRequest: (req, res) => {
    const { sortBy, limit } = req.query || {};
    const list = gymReviewService.getGymReviews(req.params.id, {
      sortBy: sortBy || 'recent',
      limit: limit ? parseInt(limit, 10) : 50
    });
    res.json(list);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Public: Get Gym Rating Summary (includes tier ranking signal)
// ─────────────────────────────────────────────────────────────────────────────
export const getGymRatingSummary = {
  created, method: 'get', path: '/gyms/:id/rating',
  description: 'Public: gym rating summary — average, distribution, tier signal.',
  onRequest: (req, res) => {
    const summary = gymReviewService.getGymRatingSummary(req.params.id);
    res.json(summary);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: Submit or Update a Review (1-5 stars + optional text)
// ─────────────────────────────────────────────────────────────────────────────
export const submitGymReview = {
  created, method: 'post', path: '/me/gyms/:id/review',
  description: 'Member: submit or update a review for a gym. Must have checked in or have a direct subscription. One review per member per gym.',
  requestSample: {
    rating: 4,
    text: 'Great equipment and clean facilities. AC was a lifesiver during the afternoon.'
  },
  responseSample: {
    ok: true,
    review: { id: 'rev_abc', rating: 4, text: 'Great equipment...', status: 'published' },
    gymRating: { gymId: 'gym_001', averageRating: 4.5, reviewCount: 12 }
  },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { rating, text } = req.body || {};
    if (rating === undefined || rating === null)
      return res.status(400).json({ error: 'rating_required' });

    const result = gymReviewService.submitReview({
      memberId: req.user.sub,
      gymId: req.params.id,
      rating: Number(rating),
      text: text || null
    });

    if (!result.ok)
      return res.status(400).json(result);

    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub,
      action: result.review.updatedAt === result.review.createdAt ? 'review_submitted' : 'review_updated',
      target: req.params.id,
      before: null,
      after: result.review
    });

    res.status(201).json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: Get My Review for a Gym
// ─────────────────────────────────────────────────────────────────────────────
export const getMyGymReview = {
  created, method: 'get', path: '/me/gyms/:id/review',
  description: 'Member: get your own review for a specific gym (if you have one).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const review = gymReviewService.getMyReview(req.user.sub, req.params.id);
    if (!review) return res.status(404).json({ ok: false, error: 'no_review' });
    res.json(review);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: Delete My Review
// ─────────────────────────────────────────────────────────────────────────────
export const deleteMyGymReview = {
  created, method: 'delete', path: '/me/gyms/:id/review',
  description: 'Member: delete your own review for a gym.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = gymReviewService.deleteMyReview(req.user.sub, req.params.id);
    if (!result.ok) return res.status(400).json(result);

    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: 'review_deleted',
      target: req.params.id, before: null, after: null
    });

    res.json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: Check Eligibility to Review
// ─────────────────────────────────────────────────────────────────────────────
export const checkReviewEligibility = {
  created, method: 'get', path: '/me/gyms/:id/can-review',
  description: 'Member: check if you are eligible to review this gym (visited or direct subscriber).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = gymReviewService.isEligibleToReview(req.user.sub, req.params.id);
    const existing = gymReviewService.getMyReview(req.user.sub, req.params.id);
    res.json({
      eligible: result.eligible,
      reason: result.reason,
      detail: result.detail || null,
      hasExistingReview: Boolean(existing),
      existingReviewId: existing?.id || null
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Gym Owner: View Reviews for Their Gym (read-only)
// ─────────────────────────────────────────────────────────────────────────────
export const operatorGymReviews = {
  created, method: 'get', path: '/operator/reviews',
  description: 'Gym owner: view all reviews for your gym (read-only). Cannot delete or modify.',
  onGuard: requireAuth ? requireAuth('gym_operator') : undefined,
  onRequest: (req, res) => {
    const operator = users.find(u => u.id === req.user.sub);
    if (!operator?.gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });

    const gymReviews = gymReviewService.getGymReviews(operator.gymId, { limit: 100 });
    const summary = gymReviewService.getGymRatingSummary(operator.gymId);

    res.json({
      gymId: operator.gymId,
      summary,
      reviews: gymReviews
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Moderate a Review (hide / flag / restore)
// ─────────────────────────────────────────────────────────────────────────────
export const adminModerateReview = {
  created, method: 'post', path: '/admin/reviews/:id/moderate',
  description: "Admin: moderate a review — hide, flag, or restore it. Hidden reviews don't count toward gym rating.",
  requestSample: { action: 'hide' },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { action } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action_required' });

    const result = gymReviewService.moderateReview(req.params.id, action, req.user?.sub);
    if (!result.ok) return res.status(400).json(result);

    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: `review_${action}ed`,
      target: req.params.id, before: null, after: result.review
    });

    res.json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Get All Flagged Reviews
// ─────────────────────────────────────────────────────────────────────────────
export const adminFlaggedReviews = {
  created, method: 'get', path: '/admin/reviews/flagged',
  description: 'Admin: list all flagged reviews for moderation queue.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => {
    const list = gymReviewService.getFlaggedReviews();
    res.json(list);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Tier Ranking Signals (gyms that may need tier re-evaluation)
// ─────────────────────────────────────────────────────────────────────────────
export const adminTierSignals = {
  created, method: 'get', path: '/admin/gyms/tier-signals',
  description: 'Admin: list gyms whose average rating suggests a tier re-evaluation (downlift or uplift).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => {
    const signals = gymReviewService.getAllTierSignals();
    res.json(signals);
  }
};
