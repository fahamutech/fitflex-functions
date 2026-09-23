// Gym review REST surface — members rate gyms they've visited or hold a direct
// subscription to; public read; admin moderation + tier-ranking signals.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { gymReviewService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// ── Public read ──
export const listGymReviews = {
  created, method: 'get', path: '/gyms/:id/reviews',
  description: 'Public: published reviews for a gym. ?sortBy=recent|highest|lowest&limit=50',
  onRequest: async (req, res) => {
    const list = await gymReviewService.listForGym(req.params.id, {
      sortBy: req.query?.sortBy || 'recent',
      limit: req.query?.limit ? Number(req.query.limit) : 50,
    });
    res.json(list);
  },
};

export const gymRatingSummary = {
  created, method: 'get', path: '/gyms/:id/rating',
  description: 'Public: gym rating summary — average, distribution, admin tier signal.',
  onRequest: async (req, res) => res.json(await gymReviewService.summary(req.params.id)),
};

// ── Member ──
export const submitGymReview = {
  created, method: 'post', path: '/me/gyms/:id/review',
  description: 'Member: submit or update a 1-5 star review (optional text). Requires a check-in or active direct subscription to the gym.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const { rating, text } = req.body || {};
    if (rating == null) return res.status(400).json({ error: 'rating_required' });
    const result = await gymReviewService.submit({
      memberId: req.user.sub, gymId: req.params.id, rating: Number(rating), text: text || null,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(result.updated ? 200 : 201).json(result);
  },
};

export const myGymReview = {
  created, method: 'get', path: '/me/gyms/:id/review',
  description: 'Member: get own review for a gym (if any).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const review = await gymReviewService.myReview(req.user.sub, req.params.id);
    if (!review) return res.status(404).json({ error: 'no_review' });
    res.json(review);
  },
};

export const deleteGymReview = {
  created, method: 'delete', path: '/me/gyms/:id/review',
  description: 'Member: delete own review for a gym.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await gymReviewService.remove({ memberId: req.user.sub, gymId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const canReviewGym = {
  created, method: 'get', path: '/me/gyms/:id/can-review',
  description: 'Member: eligibility to review a gym (visited or direct subscriber) + existing review flag.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const eligibility = await gymReviewService.isEligible(req.user.sub, req.params.id);
    const existing = await gymReviewService.myReview(req.user.sub, req.params.id);
    res.json({ ...eligibility, hasExistingReview: Boolean(existing), existingReviewId: existing?.id || null });
  },
};

// ── Gym operator (read-only) ──
export const operatorGymReviews = {
  created, method: 'get', path: '/operator/gym-reviews',
  description: 'Gym operator: read-only reviews + summary for the assigned gym.',
  onGuard: requireAuth('gym_operator'),
  onRequest: async (req, res) => {
    const gymId = req.user?.gymId;
    if (!gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const [summary, reviews] = await Promise.all([
      gymReviewService.summary(gymId),
      gymReviewService.listForGym(gymId, { limit: 100 }),
    ]);
    res.json({ gymId, summary, reviews });
  },
};

// ── Admin ──
export const adminModerateGymReview = {
  created, method: 'post', path: '/admin/gym-reviews/:id/moderate',
  description: 'Admin: moderate a gym review — { action: hide | flag | restore }.',
  onGuard: [requireAuth('admin'), requireAcl('gyms')],
  onRequest: async (req, res) => {
    const result = await gymReviewService.moderate({ reviewId: req.params.id, action: req.body?.action, adminId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const adminFlaggedGymReviews = {
  created, method: 'get', path: '/admin/gym-reviews/flagged',
  description: 'Admin: flagged gym reviews moderation queue.',
  onGuard: [requireAuth('admin'), requireAcl('gyms')],
  onRequest: async (_req, res) => res.json(await gymReviewService.flagged()),
};

export const adminGymTierSignals = {
  created, method: 'get', path: '/admin/gyms/tier-signals',
  description: 'Admin: gyms whose average rating suggests a tier re-evaluation (advisory).',
  onGuard: [requireAuth('admin'), requireAcl('gyms')],
  onRequest: async (_req, res) => res.json(await gymReviewService.tierSignals()),
};
