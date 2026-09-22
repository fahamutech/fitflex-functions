// FitFlex Af — Trainer Review REST Endpoints
//
//   - Members submit/update/delete their own trainer reviews
//   - Public: view trainer reviews + rating summaries
//   - Trainer: view own reviews (read-only)
//   - Admin: moderate reviews + view flagged queue
//
// To wire into index.mjs:
//   import { initTrainerReviewEndpoints } from './trainer-review-endpoints.mjs';
//   initTrainerReviewEndpoints({ collection, requireAuth, auditLog, users, trainers, bookings });

import { randomUUID } from 'node:crypto';
import { createTrainerReviewService } from '../src/services/trainer-review-service.mjs';

let trainerReviewService = null;
let requireAuth = null;
let auditLog = null;
let users = null;
let trainers = null;

export function initTrainerReviewEndpoints({ collection, requireAuth: ra, auditLog: al, users: u, trainers: tr, bookings: b }) {
  trainerReviewService = createTrainerReviewService({
    users: u,
    trainers: tr,
    bookings: b,
    trainerReviews: collection('trainer_reviews')
  });
  requireAuth = ra;
  auditLog = al;
  users = u;
  trainers = tr;
}

const created = new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Public: Get Trainer Reviews
// ─────────────────────────────────────────────────────────────────────────────
export const getTrainerReviews = {
  created, method: 'get', path: '/trainers/:id/reviews',
  description: 'Public: list published reviews for a trainer. ?sortBy=recent|highest|lowest&limit=50',
  onRequest: (req, res) => {
    const { sortBy, limit } = req.query || {};
    const list = trainerReviewService.getTrainerReviews(req.params.id, {
      sortBy: sortBy || 'recent',
      limit: limit ? parseInt(limit, 10) : 50
    });
    res.json(list);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Public: Get Trainer Rating Summary
// ─────────────────────────────────────────────────────────────────────────────
export const getTrainerRatingSummary = {
  created, method: 'get', path: '/trainers/:id/rating',
  description: 'Public: trainer rating summary — average, distribution, review count.',
  onRequest: (req, res) => {
    const summary = trainerReviewService.getTrainerRatingSummary(req.params.id);
    res.json(summary);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: Submit or Update a Trainer Review
// ─────────────────────────────────────────────────────────────────────────────
export const submitTrainerReview = {
  created, method: 'post', path: '/me/trainers/:id/review',
  description: 'Member: submit or update a review for a trainer. Must have a completed session with them. One review per member per trainer.',
  requestSample: {
    rating: 5,
    text: 'John was an excellent trainer — very knowledgeable and patient.'
  },
  responseSample: {
    ok: true,
    review: { id: 'trev_abc', rating: 5, text: 'John was...', status: 'published' },
    trainerRating: { trainerId: 'tr_001', averageRating: 4.8, reviewCount: 15 }
  },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { rating, text } = req.body || {};
    if (rating === undefined || rating === null)
      return res.status(400).json({ error: 'rating_required' });

    const result = trainerReviewService.submitReview({
      memberId: req.user.sub,
      trainerId: req.params.id,
      rating: Number(rating),
      text: text || null
    });

    if (!result.ok)
      return res.status(400).json(result);

    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub,
      action: result.review.updatedAt === result.review.createdAt ? 'trainer_review_submitted' : 'trainer_review_updated',
      target: req.params.id,
      before: null,
      after: result.review
    });

    res.status(201).json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: Get My Review for a Trainer
// ─────────────────────────────────────────────────────────────────────────────
export const getMyTrainerReview = {
  created, method: 'get', path: '/me/trainers/:id/review',
  description: 'Member: get your own review for a specific trainer (if you have one).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const review = trainerReviewService.getMyReview(req.user.sub, req.params.id);
    if (!review) return res.status(404).json({ ok: false, error: 'no_review' });
    res.json(review);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: Delete My Trainer Review
// ─────────────────────────────────────────────────────────────────────────────
export const deleteMyTrainerReview = {
  created, method: 'delete', path: '/me/trainers/:id/review',
  description: 'Member: delete your own review for a trainer.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = trainerReviewService.deleteMyReview(req.user.sub, req.params.id);
    if (!result.ok) return res.status(400).json(result);

    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: 'trainer_review_deleted',
      target: req.params.id, before: null, after: null
    });

    res.json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Member: Check Eligibility to Review a Trainer
// ─────────────────────────────────────────────────────────────────────────────
export const checkTrainerReviewEligibility = {
  created, method: 'get', path: '/me/trainers/:id/can-review',
  description: 'Member: check if you are eligible to review this trainer (must have a completed session).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = trainerReviewService.isEligibleToReview(req.user.sub, req.params.id);
    const existing = trainerReviewService.getMyReview(req.user.sub, req.params.id);
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
// Trainer: View Own Reviews (read-only)
// ─────────────────────────────────────────────────────────────────────────────
export const trainerMyReviews = {
  created, method: 'get', path: '/trainer/reviews',
  description: 'Trainer: view all reviews for yourself (read-only). Cannot delete or modify.',
  onGuard: requireAuth ? requireAuth('trainer') : undefined,
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.userId === req.user.sub);
    if (!trainer) return res.status(404).json({ error: 'trainer_profile_not_found' });

    const list = trainerReviewService.getTrainerReviews(trainer.id, { limit: 100 });
    const summary = trainerReviewService.getTrainerRatingSummary(trainer.id);

    res.json({
      trainerId: trainer.id,
      summary,
      reviews: list
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Moderate a Trainer Review
// ─────────────────────────────────────────────────────────────────────────────
export const adminModerateTrainerReview = {
  created, method: 'post', path: '/admin/trainer-reviews/:id/moderate',
  description: 'Admin: moderate a trainer review — hide, flag, or restore it.',
  requestSample: { action: 'hide' },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { action } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action_required' });

    const result = trainerReviewService.moderateReview(req.params.id, action, req.user?.sub);
    if (!result.ok) return res.status(400).json(result);

    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: `trainer_review_${action}ed`,
      target: req.params.id, before: null, after: result.review
    });

    res.json(result);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Get All Flagged Trainer Reviews
// ─────────────────────────────────────────────────────────────────────────────
export const adminFlaggedTrainerReviews = {
  created, method: 'get', path: '/admin/trainer-reviews/flagged',
  description: 'Admin: list all flagged trainer reviews for moderation queue.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => {
    const list = trainerReviewService.getFlaggedReviews();
    res.json(list);
  }
};
