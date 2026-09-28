// Trainer review REST surface — members rate trainers they've had a completed
// session with; public read; admin moderation.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { trainerReviewService, trainerService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// ── Public read ──
export const listTrainerReviews = {
  created, method: 'get', path: '/trainers/:id/reviews',
  description: 'Public: published reviews for a trainer. ?sortBy=recent|highest|lowest&limit=50',
  onRequest: async (req, res) => {
    const list = await trainerReviewService.listForTrainer(req.params.id, {
      sortBy: req.query?.sortBy || 'recent',
      limit: req.query?.limit ? Number(req.query.limit) : 50,
    });
    res.json(list);
  },
};

export const trainerRatingSummary = {
  created, method: 'get', path: '/trainers/:id/rating',
  description: 'Public: trainer rating summary — average, distribution, count.',
  onRequest: async (req, res) => res.json(await trainerReviewService.summary(req.params.id)),
};

// ── Member ──
export const submitTrainerReview = {
  created, method: 'post', path: '/me/trainers/:id/review',
  description: 'Member: submit or update a 1-5 star review (optional text). Requires a completed session with the trainer.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const { rating, text } = req.body || {};
    if (rating == null) return res.status(400).json({ error: 'rating_required' });
    const result = await trainerReviewService.submit({
      memberId: req.user.sub, trainerId: req.params.id, rating: Number(rating), text: text || null,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.updated ? 200 : 201).json(result);
  },
};

export const myTrainerReview = {
  created, method: 'get', path: '/me/trainers/:id/review',
  description: 'Member: get own review for a trainer (if any).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const review = await trainerReviewService.myReview(req.user.sub, req.params.id);
    if (!review) return res.status(404).json({ error: 'no_review' });
    res.json(review);
  },
};

export const deleteTrainerReview = {
  created, method: 'delete', path: '/me/trainers/:id/review',
  description: 'Member: delete own review for a trainer.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await trainerReviewService.remove({ memberId: req.user.sub, trainerId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const canReviewTrainer = {
  created, method: 'get', path: '/me/trainers/:id/can-review',
  description: 'Member: eligibility to review a trainer (completed session) + existing review flag.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const eligibility = await trainerReviewService.isEligible(req.user.sub, req.params.id);
    const existing = await trainerReviewService.myReview(req.user.sub, req.params.id);
    res.json({ ...eligibility, hasExistingReview: Boolean(existing), existingReviewId: existing?.id || null });
  },
};

// ── Trainer (read-only) ──
export const trainerOwnReviews = {
  created, method: 'get', path: '/trainer/reviews',
  description: 'Trainer: read-only reviews + summary for own profile.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    // Reviews are keyed by TrainerProfile.id, which is not the user id in the token.
    const profile = trainerService.findProfileByUser(req.user.sub);
    if (!profile) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const trainerId = profile.id;
    const [summary, reviews] = await Promise.all([
      trainerReviewService.summary(trainerId),
      trainerReviewService.listForTrainer(trainerId, { limit: 100 }),
    ]);
    res.json({ trainerId, summary, reviews });
  },
};

// ── Admin ── review moderation sits under the 'social' (community moderation) scope.
const adminGuard = [requireAuth('admin'), requireAcl('social')];

export const adminListTrainerReviews = {
  created, method: 'get', path: '/admin/trainer-reviews',
  description: 'Admin: all trainer reviews, newest first (max 200). ?status=published|flagged|hidden',
  onGuard: adminGuard,
  onRequest: async (req, res) => {
    const result = await trainerReviewService.adminList({ status: req.query?.status || null });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const adminModerateTrainerReview = {
  created, method: 'post', path: '/admin/trainer-reviews/:id/moderate',
  description: 'Admin: moderate a trainer review — { action: hide | flag | restore }.',
  onGuard: adminGuard,
  onRequest: async (req, res) => {
    const result = await trainerReviewService.moderate({ reviewId: req.params.id, action: req.body?.action, adminId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const adminFlaggedTrainerReviews = {
  created, method: 'get', path: '/admin/trainer-reviews/flagged',
  description: 'Admin: flagged trainer reviews moderation queue.',
  onGuard: adminGuard,
  onRequest: async (_req, res) => res.json(await trainerReviewService.flagged()),
};
