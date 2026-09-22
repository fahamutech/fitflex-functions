// FitFlex Af — Trainer Review Constants
// Defines rating rules for trainer reviews and ranking signals.

// ─────────────────────────────────────────────────────────────────────────────
// Star Rating Range
// ─────────────────────────────────────────────────────────────────────────────
export const MIN_RATING = 1;
export const MAX_RATING = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Review Text Limits
// ─────────────────────────────────────────────────────────────────────────────
export const MIN_REVIEW_TEXT_LENGTH = 3;
export const MAX_REVIEW_TEXT_LENGTH = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Review Eligibility
// A member can review a trainer if they have had at least one completed
// (or no-show) booking with that trainer. Pending, cancelled, or expired
// bookings do NOT qualify.
// ─────────────────────────────────────────────────────────────────────────────
export const QUALIFYING_BOOKING_STATUSES = ['completed', 'no_show'];

// ─────────────────────────────────────────────────────────────────────────────
// One review per member per trainer (re-reviewing replaces the previous)
// ─────────────────────────────────────────────────────────────────────────────
export const REVIEW_ONE_PER_MEMBER_PER_TRAINER = true;

// ─────────────────────────────────────────────────────────────────────────────
// Minimum reviews before rating is actionable
// ─────────────────────────────────────────────────────────────────────────────
export const MIN_REVIEWS_FOR_ACTION = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Review Status (for moderation)
// ─────────────────────────────────────────────────────────────────────────────
export const REVIEW_STATUS = {
  PUBLISHED: 'published',
  FLAGGED: 'flagged',
  HIDDEN: 'hidden'
};
