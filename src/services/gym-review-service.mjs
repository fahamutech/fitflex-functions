// Gym review domain service. All persistence is dependency-injected and async
// (Knex/PostgreSQL). Members who have visited a gym (check-in) OR hold an
// active direct subscription to it may leave one 1-5 star review with optional
// free text. Rolling average rating + reviewCount are denormalized onto the Gym
// row. Ratings feed the admin tier-ranking signal (advisory — never auto-changes
// the tier, which stays admin/rubric-driven).
import { randomUUID } from 'node:crypto';

const MIN_RATING = 1;
const MAX_RATING = 5;
const MIN_TEXT = 3;
const MAX_TEXT = 1000;
const MIN_REVIEWS_FOR_TIER_ACTION = 5;
const REVIEW_STATUS = new Set(['published', 'flagged', 'hidden']);

// Below these average ratings, a gym at the given tier should be reviewed for a
// possible downlift. Advisory only — the admin decides.
const TIER_DOWNLIFT_BELOW = {
  standard: null,
  midtier: 3.0,
  premium: 3.5,
  luxury_executive: 4.0,
};

const makeId = () => `grev_${randomUUID().slice(0, 8)}`;
const nowIso = () => new Date().toISOString();

export function createGymReviewService({ gymReviews, gyms, checkins, subscriptions, users, auditLog }) {
  function validate(rating, text) {
    if (!Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) {
      return { error: 'rating_must_be_integer_1_to_5', status: 400 };
    }
    if (text != null && text !== '') {
      if (typeof text !== 'string') return { error: 'text_must_be_string', status: 400 };
      if (text.trim().length < MIN_TEXT) return { error: 'text_too_short', status: 400 };
      if (text.length > MAX_TEXT) return { error: 'text_too_long', status: 400 };
    }
    return { ok: true, text: text ? text.trim() : null };
  }

  // Eligibility: has this member checked in at the gym OR does the member hold
  // an active direct subscription with this gym as home gym?
  async function isEligible(memberId, gymId) {
    const hasCheckin = (await checkins.filterAsync(c => c.memberId === memberId && c.gymId === gymId)).length > 0;
    if (hasCheckin) return { eligible: true, reason: 'check_in_history' };
    const hasDirectSub = (await subscriptions.filterAsync(s =>
      s.memberId === memberId && s.type === 'direct_sub' && s.homeGymId === gymId && s.status === 'active',
    )).length > 0;
    if (hasDirectSub) return { eligible: true, reason: 'direct_subscription' };
    return { eligible: false, reason: 'no_checkin_or_direct_subscription' };
  }

  async function recalcRating(gymId) {
    const published = await gymReviews.filterAsync(r => r.gymId === gymId && r.status === 'published');
    const count = published.length;
    const average = count ? Math.round((published.reduce((s, r) => s + Number(r.rating), 0) / count) * 10) / 10 : 0;
    await gyms.updateAsync(g => g.id === gymId, { rating: average, reviewCount: count });
    return { gymId, averageRating: average, reviewCount: count };
  }

  // Submit or update (upsert) the caller's review for a gym.
  async function submit({ memberId, gymId, rating, text }) {
    const gym = await gyms.findByIdAsync(gymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    const v = validate(rating, text);
    if (v.error) return v;
    const eligibility = await isEligible(memberId, gymId);
    if (!eligibility.eligible) return { error: eligibility.reason, status: 403 };

    const existing = (await gymReviews.filterAsync(r => r.gymId === gymId && r.memberId === memberId))[0] || null;
    const now = nowIso();
    let review;
    if (existing) {
      await gymReviews.updateByIdAsync(existing.id, {
        rating, text: v.text, status: 'published', updatedAt: now,
      });
      review = { ...existing, rating, text: v.text, status: 'published', updatedAt: now };
    } else {
      review = {
        id: makeId(), gymId, memberId, rating, text: v.text,
        status: 'published', createdAt: now, updatedAt: now,
      };
      await gymReviews.insertAsync(review);
    }
    const gymRating = await recalcRating(gymId);
    return { review, gymRating, updated: Boolean(existing) };
  }

  async function myReview(memberId, gymId) {
    return (await gymReviews.filterAsync(r => r.gymId === gymId && r.memberId === memberId))[0] || null;
  }

  async function remove({ memberId, gymId }) {
    const existing = (await gymReviews.filterAsync(r => r.gymId === gymId && r.memberId === memberId))[0];
    if (!existing) return { error: 'review_not_found', status: 404 };
    await gymReviews.removeAsync(r => r.id === existing.id);
    const gymRating = await recalcRating(gymId);
    return { ok: true, gymRating };
  }

  async function listForGym(gymId, { sortBy = 'recent', limit = 50 } = {}) {
    let rows = await gymReviews.filterAsync(r => r.gymId === gymId && r.status === 'published');
    if (sortBy === 'highest') rows.sort((a, b) => b.rating - a.rating);
    else if (sortBy === 'lowest') rows.sort((a, b) => a.rating - b.rating);
    else rows.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    rows = rows.slice(0, limit);
    return Promise.all(rows.map(async r => {
      const u = await users.findByIdAsync(r.memberId);
      return { ...r, memberName: u?.displayName || null, memberPhotoUrl: u?.photoUrl || null };
    }));
  }

  async function summary(gymId) {
    const published = await gymReviews.filterAsync(r => r.gymId === gymId && r.status === 'published');
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of published) distribution[r.rating] = (distribution[r.rating] || 0) + 1;
    const count = published.length;
    const average = count ? Math.round((published.reduce((s, r) => s + Number(r.rating), 0) / count) * 10) / 10 : null;
    const gym = await gyms.findByIdAsync(gymId);
    return { gymId, averageRating: average, reviewCount: count, distribution, tierSignal: tierSignal(gym, average, count) };
  }

  function tierSignal(gym, average, count) {
    if (!gym) return null;
    const tier = gym.tier || 'standard';
    if (count < MIN_REVIEWS_FOR_TIER_ACTION) {
      return { action: 'insufficient_data', currentTier: tier, averageRating: average, reviewCount: count,
        message: `Needs ${MIN_REVIEWS_FOR_TIER_ACTION - count} more reviews to trigger a tier review.` };
    }
    const threshold = TIER_DOWNLIFT_BELOW[tier];
    if (threshold != null && average < threshold) {
      const suggested = tier === 'luxury_executive' ? 'premium' : tier === 'premium' ? 'midtier' : 'standard';
      return { action: 'consider_downlift', currentTier: tier, suggestedTier: suggested, threshold,
        averageRating: average, reviewCount: count,
        message: `Average rating ${average} is below ${threshold} for tier '${tier}'. Admin should review.` };
    }
    return { action: 'no_action', currentTier: tier, averageRating: average, reviewCount: count };
  }

  // Admin: list gyms whose rating suggests a tier re-evaluation.
  async function tierSignals() {
    const activeGyms = await gyms.filterAsync(g => g.status === 'active');
    const out = [];
    for (const gym of activeGyms) {
      const s = await summary(gym.id);
      if (s.tierSignal && !['no_action', 'insufficient_data'].includes(s.tierSignal.action)) {
        out.push({ gymId: gym.id, gymName: gym.name, ...s.tierSignal });
      }
    }
    return out.sort((a, b) => (a.averageRating || 5) - (b.averageRating || 5));
  }

  // Admin moderation: hide | flag | restore.
  async function moderate({ reviewId, action, adminId }) {
    const map = { hide: 'hidden', flag: 'flagged', restore: 'published' };
    if (!map[action]) return { error: 'invalid_action', status: 400 };
    const review = (await gymReviews.filterAsync(r => r.id === reviewId))[0];
    if (!review) return { error: 'review_not_found', status: 404 };
    await gymReviews.updateByIdAsync(reviewId, {
      status: map[action], moderatedBy: adminId, moderatedAt: nowIso(),
    });
    await recalcRating(review.gymId);
    auditLog?.insert?.({ id: randomUUID(), at: nowIso(), actor: adminId, action: `gym_review_${action}`, target: reviewId });
    return { ok: true, reviewId, status: map[action] };
  }

  async function flagged() {
    const rows = await gymReviews.filterAsync(r => r.status === 'flagged');
    return Promise.all(rows.map(async r => {
      const u = await users.findByIdAsync(r.memberId);
      const g = await gyms.findByIdAsync(r.gymId);
      return { ...r, memberName: u?.displayName || null, gymName: g?.name || null };
    }));
  }

  return { submit, myReview, remove, listForGym, summary, tierSignals, moderate, flagged, isEligible, recalcRating };
}
