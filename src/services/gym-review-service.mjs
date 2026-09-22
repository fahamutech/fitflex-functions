// FitFlex Af — Gym Review Service (clean architecture + DI)
//
// Capabilities:
//   - Members submit reviews (star rating + optional free text) for gyms
//   - Only members who have visited (check-in) or have a direct subscription
//     to the gym can review it
//   - One review per member per gym (re-reviewing replaces the previous one)
//   - Rolling average rating is calculated and stored on the gym record
//   - Admin can see tier ranking signals (rating crosses thresholds → review)
//   - Gym owner can see reviews for their gym but cannot delete them
//   - Admin can hide/flag reviews for moderation
//
// Business rules:
//   - Rating: 1-5 stars (integers only)
//   - Text: optional, 3-1000 chars if provided
//   - Eligibility: check-in at gym OR active direct subscription to gym
//   - One per member per gym (upsert)
//   - Average rating = simple mean of all published reviews
//   - Tier ranking: rating is advisory signal, not auto-change (admin decides)

import { randomUUID } from 'node:crypto';
import {
  MIN_RATING,
  MAX_RATING,
  MIN_REVIEW_TEXT_LENGTH,
  MAX_REVIEW_TEXT_LENGTH,
  REVIEW_ONE_PER_MEMBER_PER_GYM,
  TIER_RATING_THRESHOLDS,
  MIN_REVIEWS_FOR_TIER_ACTION,
  REVIEW_STATUS
} from '../shared/gym-review-constants.mjs';

export function createGymReviewService({ users, gyms, subscriptions, checkins, reviews }) {

  // ─── Validation ──────────────────────────────────────────────────────────

  function validateRating(rating) {
    if (typeof rating !== 'number' || !Number.isInteger(rating))
      return { valid: false, error: 'rating_must_be_integer' };
    if (rating < MIN_RATING || rating > MAX_RATING)
      return { valid: false, error: `rating_must_be_between_${MIN_RATING}_and_${MAX_RATING}` };
    return { valid: true };
  }

  function validateText(text) {
    if (text === null || text === undefined || text === '')
      return { valid: true, text: null };
    if (typeof text !== 'string')
      return { valid: false, error: 'text_must_be_string' };
    if (text.trim().length < MIN_REVIEW_TEXT_LENGTH)
      return { valid: false, error: 'text_too_short' };
    if (text.length > MAX_REVIEW_TEXT_LENGTH)
      return { valid: false, error: 'text_too_long' };
    return { valid: true, text: text.trim() };
  }

  // ─── Eligibility: can this member review this gym? ───────────────────────

  function isEligibleToReview(memberId, gymId) {
    // Check 1: Has the member checked in at this gym?
    const hasCheckin = checkins.some(c =>
      c.memberId === memberId && c.gymId === gymId
    );

    // Check 2: Does the member have an active direct subscription to this gym?
    const hasDirectSub = subscriptions.some(s =>
      s.memberId === memberId &&
      s.type === 'direct_sub' &&
      s.homeGymId === gymId &&
      s.status === 'active'
    );

    if (hasCheckin || hasDirectSub) {
      return {
        eligible: true,
        reason: hasDirectSub ? 'direct_subscription' : 'check_in_history'
      };
    }

    return {
      eligible: false,
      reason: 'no_checkin_or_direct_subscription',
      detail: 'You must have visited this gym or have an active direct subscription to review it.'
    };
  }

  // ─── Submit / Update Review ──────────────────────────────────────────────

  function submitReview({ memberId, gymId, rating, text }) {
    // Validate gym exists
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { ok: false, error: 'gym_not_found' };

    // Validate rating
    const ratingCheck = validateRating(rating);
    if (!ratingCheck.valid) return { ok: false, error: ratingCheck.error };

    // Validate text
    const textCheck = validateText(text);
    if (!textCheck.valid) return { ok: false, error: textCheck.error };

    // Check eligibility
    const eligibility = isEligibleToReview(memberId, gymId);
    if (!eligibility.eligible) return { ok: false, error: eligibility.reason };

    const now = new Date().toISOString();
    const reviewId = `rev_${randomUUID().slice(0, 8)}`;

    // Check for existing review by this member for this gym
    const existing = reviews.find(r =>
      r.memberId === memberId && r.gymId === gymId
    );

    let review;
    if (existing && REVIEW_ONE_PER_MEMBER_PER_GYM) {
      // Update existing review (upsert)
      review = reviews.update(r => r.id === existing.id, {
        rating: rating,
        text: textCheck.text,
        status: REVIEW_STATUS.PUBLISHED,
        updatedAt: now
      });
      review.id = existing.id; // preserve original ID
      review.createdAt = existing.createdAt; // preserve original creation
    } else {
      // Create new review
      review = {
        id: reviewId,
        memberId,
        gymId,
        rating,
        text: textCheck.text,
        status: REVIEW_STATUS.PUBLISHED,
        createdAt: now,
        updatedAt: now
      };
      reviews.insert(review);
    }

    // Recalculate gym's average rating
    const updatedRating = recalculateGymRating(gymId);

    return {
      ok: true,
      review,
      gymRating: updatedRating
    };
  }

  // ─── Recalculate Gym Rating ──────────────────────────────────────────────

  function recalculateGymRating(gymId) {
    const publishedReviews = reviews.filter(r =>
      r.gymId === gymId && r.status === REVIEW_STATUS.PUBLISHED
    );

    const count = publishedReviews.length;
    let average = null;

    if (count > 0) {
      const sum = publishedReviews.reduce((acc, r) => acc + r.rating, 0);
      average = Math.round((sum / count) * 10) / 10; // 1 decimal place
    }

    // Update gym record
    gyms.update(g => g.id === gymId, {
      rating: average,
      reviewCount: count
    });

    return {
      gymId,
      averageRating: average,
      reviewCount: count
    };
  }

  // ─── Get Reviews for a Gym ───────────────────────────────────────────────

  function getGymReviews(gymId, { sortBy = 'recent', limit = 50 } = {}) {
    let list = reviews.filter(r =>
      r.gymId === gymId && r.status === REVIEW_STATUS.PUBLISHED
    );

    if (sortBy === 'recent') {
      list.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    } else if (sortBy === 'highest') {
      list.sort((a, b) => b.rating - a.rating);
    } else if (sortBy === 'lowest') {
      list.sort((a, b) => a.rating - b.rating);
    }

    if (limit) list = list.slice(0, limit);

    // Attach member display names
    return list.map(r => {
      const user = users.find(u => u.id === r.memberId);
      return {
        ...r,
        memberName: user?.displayName || null,
        memberPhotoUrl: user?.photoUrl || null
      };
    });
  }

  // ─── Get Gym Rating Summary ──────────────────────────────────────────────

  function getGymRatingSummary(gymId) {
    const allReviews = reviews.filter(r => r.gymId === gymId);
    const publishedReviews = allReviews.filter(r => r.status === REVIEW_STATUS.PUBLISHED);

    if (publishedReviews.length === 0) {
      return {
        gymId,
        averageRating: null,
        reviewCount: 0,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        tierSignal: null
      };
    }

    // Rating distribution (how many 1s, 2s, 3s, 4s, 5s)
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of publishedReviews) {
      distribution[r.rating] = (distribution[r.rating] || 0) + 1;
    }

    const sum = publishedReviews.reduce((acc, r) => acc + r.rating, 0);
    const average = Math.round((sum / publishedReviews.length) * 10) / 10;

    return {
      gymId,
      averageRating: average,
      reviewCount: publishedReviews.length,
      distribution,
      tierSignal: getTierRankingSignal(gymId, average, publishedReviews.length)
    };
  }

  // ─── Tier Ranking Signal (advisory — admin decides) ─────────────────────

  function getTierRankingSignal(gymId, averageRating, reviewCount) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return null;

    // Not enough reviews to act on
    if (reviewCount < MIN_REVIEWS_FOR_TIER_ACTION) {
      return {
        action: 'insufficient_data',
        message: `Needs ${MIN_REVIEWS_FOR_TIER_ACTION - reviewCount} more reviews to trigger tier review`,
        currentTier: gym.tier,
        averageRating,
        reviewCount
      };
    }

    const thresholds = TIER_RATING_THRESHOLDS[gym.tier] || TIER_RATING_THRESHOLDS.standard;
    const downliftBelow = thresholds.downliftBelow;

    if (downliftBelow !== null && averageRating < downliftBelow) {
      // Determine which tier to downlift to
      let suggestedTier = 'standard';
      if (gym.tier === 'luxury_executive') suggestedTier = 'premium';
      else if (gym.tier === 'premium') suggestedTier = 'midtier';
      else if (gym.tier === 'midtier') suggestedTier = 'standard';

      return {
        action: 'consider_downlift',
        suggestedTier,
        message: `Average rating ${averageRating} is below threshold ${downliftBelow} for tier '${gym.tier}'. Admin should review.`,
        currentTier: gym.tier,
        averageRating,
        reviewCount,
        threshold: downliftBelow
      };
    }

    return {
      action: 'no_action',
      message: 'Rating is within acceptable range for current tier',
      currentTier: gym.tier,
      averageRating,
      reviewCount
    };
  }

  // ─── Get All Tier Signals (for admin dashboard) ──────────────────────────

  function getAllTierSignals() {
    return gyms.all()
      .filter(g => g.status === 'active')
      .map(g => {
        const summary = getGymRatingSummary(g.id);
        return {
          gymId: g.id,
          gymName: g.name,
          currentTier: g.tier,
          averageRating: summary.averageRating,
          reviewCount: summary.reviewCount,
          tierSignal: summary.tierSignal
        };
      })
      .filter(g => g.tierSignal && g.tierSignal.action !== 'no_action' && g.tierSignal.action !== 'insufficient_data')
      .sort((a, b) => (a.averageRating || 5) - (b.averageRating || 5));
  }

  // ─── Member: Get Own Review for a Gym ───────────────────────────────────

  function getMyReview(memberId, gymId) {
    const review = reviews.find(r =>
      r.memberId === memberId && r.gymId === gymId
    );
    return review || null;
  }

  // ─── Member: Delete Own Review ───────────────────────────────────────────

  function deleteMyReview(memberId, gymId) {
    const review = reviews.find(r =>
      r.memberId === memberId && r.gymId === gymId
    );
    if (!review) return { ok: false, error: 'review_not_found' };

    reviews.remove(r => r.id === review.id);
    const updatedRating = recalculateGymRating(gymId);

    return { ok: true, gymRating: updatedRating };
  }

  // ─── Admin: Moderate Review (hide/flag/restore) ──────────────────────────

  function moderateReview(reviewId, action, adminId) {
    const validActions = ['hide', 'flag', 'restore'];
    if (!validActions.includes(action))
      return { ok: false, error: 'invalid_action' };

    const review = reviews.find(r => r.id === reviewId);
    if (!review) return { ok: false, error: 'review_not_found' };

    const statusMap = {
      hide: REVIEW_STATUS.HIDDEN,
      flag: REVIEW_STATUS.FLAGGED,
      restore: REVIEW_STATUS.PUBLISHED
    };

    const updated = reviews.update(r => r.id === reviewId, {
      status: statusMap[action],
      moderatedAt: new Date().toISOString(),
      moderatedBy: adminId
    });

    // Recalculate gym rating (hidden reviews don't count)
    recalculateGymRating(review.gymId);

    return { ok: true, review: updated };
  }

  // ─── Admin: Get All Flagged Reviews ──────────────────────────────────────

  function getFlaggedReviews() {
    return reviews
      .filter(r => r.status === REVIEW_STATUS.FLAGGED)
      .map(r => {
        const user = users.find(u => u.id === r.memberId);
        const gym = gyms.find(g => g.id === r.gymId);
        return {
          ...r,
          memberName: user?.displayName || null,
          gymName: gym?.name || null
        };
      });
  }

  return {
    submitReview,
    getGymReviews,
    getGymRatingSummary,
    getTierRankingSignal,
    getAllTierSignals,
    getMyReview,
    deleteMyReview,
    moderateReview,
    getFlaggedReviews,
    isEligibleToReview,
    recalculateGymRating,
    _constants: {
      MIN_RATING,
      MAX_RATING,
      MIN_REVIEW_TEXT_LENGTH,
      MAX_REVIEW_TEXT_LENGTH,
      REVIEW_ONE_PER_MEMBER_PER_GYM,
      TIER_RATING_THRESHOLDS,
      MIN_REVIEWS_FOR_TIER_ACTION,
      REVIEW_STATUS
    }
  };
}
