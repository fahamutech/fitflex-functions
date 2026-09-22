// FitFlex Af — Trainer Review Service (clean architecture + DI)
//
// Capabilities:
//   - Members submit reviews (star rating + optional free text) for trainers
//   - Only members who have had a completed (or no-show) booking with the
//     trainer can review them
//   - One review per member per trainer (re-reviewing replaces the previous)
//   - Rolling average rating is calculated and stored on the trainer record
//   - Trainer can see reviews for themselves (read-only, cannot delete)
//   - Admin can hide/flag reviews for moderation
//
// Business rules:
//   - Rating: 1-5 stars (integers only)
//   - Text: optional, 3-1000 chars if provided
//   - Eligibility: completed or no-show booking with the trainer
//   - One per member per trainer (upsert)
//   - Average rating = simple mean of all published reviews

import { randomUUID } from 'node:crypto';
import {
  MIN_RATING,
  MAX_RATING,
  MIN_REVIEW_TEXT_LENGTH,
  MAX_REVIEW_TEXT_LENGTH,
  QUALIFYING_BOOKING_STATUSES,
  REVIEW_ONE_PER_MEMBER_PER_TRAINER,
  MIN_REVIEWS_FOR_ACTION,
  REVIEW_STATUS
} from '../shared/trainer-review-constants.mjs';

export function createTrainerReviewService({ users, trainers, bookings, trainerReviews }) {

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

  // ─── Eligibility: can this member review this trainer? ───────────────────

  function isEligibleToReview(memberId, trainerId) {
    // Must have at least one completed or no-show booking with this trainer
    const qualifyingBookings = bookings.some(b =>
      b.memberId === memberId &&
      b.trainerId === trainerId &&
      QUALIFYING_BOOKING_STATUSES.includes(b.status)
    );

    if (qualifyingBookings) {
      return { eligible: true, reason: 'completed_booking' };
    }

    return {
      eligible: false,
      reason: 'no_completed_booking',
      detail: 'You must have completed a session with this trainer to review them.'
    };
  }

  // ─── Submit / Update Review ──────────────────────────────────────────────

  function submitReview({ memberId, trainerId, rating, text }) {
    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return { ok: false, error: 'trainer_not_found' };

    const ratingCheck = validateRating(rating);
    if (!ratingCheck.valid) return { ok: false, error: ratingCheck.error };

    const textCheck = validateText(text);
    if (!textCheck.valid) return { ok: false, error: textCheck.error };

    const eligibility = isEligibleToReview(memberId, trainerId);
    if (!eligibility.eligible) return { ok: false, error: eligibility.reason };

    const now = new Date().toISOString();
    const reviewId = `trev_${randomUUID().slice(0, 8)}`;

    const existing = trainerReviews.find(r =>
      r.memberId === memberId && r.trainerId === trainerId
    );

    let review;
    if (existing && REVIEW_ONE_PER_MEMBER_PER_TRAINER) {
      review = trainerReviews.update(r => r.id === existing.id, {
        rating,
        text: textCheck.text,
        status: REVIEW_STATUS.PUBLISHED,
        updatedAt: now
      });
      review.id = existing.id;
      review.createdAt = existing.createdAt;
    } else {
      review = {
        id: reviewId,
        memberId,
        trainerId,
        rating,
        text: textCheck.text,
        status: REVIEW_STATUS.PUBLISHED,
        createdAt: now,
        updatedAt: now
      };
      trainerReviews.insert(review);
    }

    const updatedRating = recalculateTrainerRating(trainerId);

    return { ok: true, review, trainerRating: updatedRating };
  }

  // ─── Recalculate Trainer Rating ──────────────────────────────────────────

  function recalculateTrainerRating(trainerId) {
    const published = trainerReviews.filter(r =>
      r.trainerId === trainerId && r.status === REVIEW_STATUS.PUBLISHED
    );

    const count = published.length;
    let average = null;
    if (count > 0) {
      const sum = published.reduce((acc, r) => acc + r.rating, 0);
      average = Math.round((sum / count) * 10) / 10;
    }

    trainers.update(t => t.id === trainerId, {
      rating: average,
      reviewCount: count
    });

    return { trainerId, averageRating: average, reviewCount: count };
  }

  // ─── Get Reviews for a Trainer ───────────────────────────────────────────

  function getTrainerReviews(trainerId, { sortBy = 'recent', limit = 50 } = {}) {
    let list = trainerReviews.filter(r =>
      r.trainerId === trainerId && r.status === REVIEW_STATUS.PUBLISHED
    );

    if (sortBy === 'recent') {
      list.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    } else if (sortBy === 'highest') {
      list.sort((a, b) => b.rating - a.rating);
    } else if (sortBy === 'lowest') {
      list.sort((a, b) => a.rating - b.rating);
    }

    if (limit) list = list.slice(0, limit);

    return list.map(r => {
      const user = users.find(u => u.id === r.memberId);
      return {
        ...r,
        memberName: user?.displayName || null,
        memberPhotoUrl: user?.photoUrl || null
      };
    });
  }

  // ─── Get Trainer Rating Summary ──────────────────────────────────────────

  function getTrainerRatingSummary(trainerId) {
    const allReviews = trainerReviews.filter(r => r.trainerId === trainerId);
    const publishedReviews = allReviews.filter(r => r.status === REVIEW_STATUS.PUBLISHED);

    if (publishedReviews.length === 0) {
      return {
        trainerId,
        averageRating: null,
        reviewCount: 0,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        actionable: false
      };
    }

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of publishedReviews) {
      distribution[r.rating] = (distribution[r.rating] || 0) + 1;
    }

    const sum = publishedReviews.reduce((acc, r) => acc + r.rating, 0);
    const average = Math.round((sum / publishedReviews.length) * 10) / 10;

    return {
      trainerId,
      averageRating: average,
      reviewCount: publishedReviews.length,
      distribution,
      actionable: publishedReviews.length >= MIN_REVIEWS_FOR_ACTION
    };
  }

  // ─── Get My Review for a Trainer ─────────────────────────────────────────

  function getMyReview(memberId, trainerId) {
    const review = trainerReviews.find(r =>
      r.memberId === memberId && r.trainerId === trainerId
    );
    return review || null;
  }

  // ─── Delete My Review ───────────────────────────────────────────────────

  function deleteMyReview(memberId, trainerId) {
    const review = trainerReviews.find(r =>
      r.memberId === memberId && r.trainerId === trainerId
    );
    if (!review) return { ok: false, error: 'review_not_found' };

    trainerReviews.remove(r => r.id === review.id);
    const updatedRating = recalculateTrainerRating(trainerId);

    return { ok: true, trainerRating: updatedRating };
  }

  // ─── Admin: Moderate Review ──────────────────────────────────────────────

  function moderateReview(reviewId, action, adminId) {
    const validActions = ['hide', 'flag', 'restore'];
    if (!validActions.includes(action))
      return { ok: false, error: 'invalid_action' };

    const review = trainerReviews.find(r => r.id === reviewId);
    if (!review) return { ok: false, error: 'review_not_found' };

    const statusMap = {
      hide: REVIEW_STATUS.HIDDEN,
      flag: REVIEW_STATUS.FLAGGED,
      restore: REVIEW_STATUS.PUBLISHED
    };

    const updated = trainerReviews.update(r => r.id === reviewId, {
      status: statusMap[action],
      moderatedAt: new Date().toISOString(),
      moderatedBy: adminId
    });

    recalculateTrainerRating(review.trainerId);

    return { ok: true, review: updated };
  }

  // ─── Admin: Get Flagged Reviews ─────────────────────────────────────────

  function getFlaggedReviews() {
    return trainerReviews
      .filter(r => r.status === REVIEW_STATUS.FLAGGED)
      .map(r => {
        const user = users.find(u => u.id === r.memberId);
        const trainer = trainers.find(t => t.id === r.trainerId);
        return {
          ...r,
          memberName: user?.displayName || null,
          trainerName: trainer?.name || null
        };
      });
  }

  return {
    submitReview,
    getTrainerReviews,
    getTrainerRatingSummary,
    getMyReview,
    deleteMyReview,
    moderateReview,
    getFlaggedReviews,
    isEligibleToReview,
    recalculateTrainerRating,
    _constants: {
      MIN_RATING,
      MAX_RATING,
      MIN_REVIEW_TEXT_LENGTH,
      MAX_REVIEW_TEXT_LENGTH,
      QUALIFYING_BOOKING_STATUSES,
      REVIEW_ONE_PER_MEMBER_PER_TRAINER,
      MIN_REVIEWS_FOR_ACTION,
      REVIEW_STATUS
    }
  };
}
