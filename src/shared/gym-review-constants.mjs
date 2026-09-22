// FitFlex Af — Gym Review Constants
// Defines rating rules, tier ranking thresholds, and review eligibility.

// ─────────────────────────────────────────────────────────────────────────────
// Star Rating Range
// ─────────────────────────────────────────────────────────────────────────────
export const MIN_RATING = 1;
export const MAX_RATING = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Review Text Limits
// ─────────────────────────────────────────────────────────────────────────────
export const MIN_REVIEW_TEXT_LENGTH = 3;    // at least 3 chars if text is provided
export const MAX_REVIEW_TEXT_LENGTH = 1000; // cap at 1000 chars

// ─────────────────────────────────────────────────────────────────────────────
// Review Eligibility Rules
// A member can review a gym if they have EITHER:
//   1. An active direct subscription to that gym (home_gym_id matches), OR
//   2. At least one completed check-in at that gym
// Reviews are limited to one per member per gym (upsert — re-reviewing
// replaces the previous review).
// ─────────────────────────────────────────────────────────────────────────────
export const REVIEW_ONE_PER_MEMBER_PER_GYM = true;

// ─────────────────────────────────────────────────────────────────────────────
// Tier Ranking Thresholds (based on average rating)
// These are advisory signals — they do NOT auto-change the tier.
// Admins review gyms whose rating crosses these thresholds and decide
// whether to uplift (upgrade) or downlift (downgrade) the tier.
//
// The rubric score (set by admin at onboarding) is the PRIMARY tier
// determinant. Average rating is a SECONDARY signal that can trigger
// a re-evaluation.
// ─────────────────────────────────────────────────────────────────────────────
export const TIER_RATING_THRESHOLDS = {
  // If average rating drops below this, admin should consider downlifting
  standard: {
    downliftBelow: 2.5,    // < 2.5 → consider re-evaluating
    upliftAbove: null      // no uplift from reviews (rubric-driven)
  },
  midtier: {
    downliftBelow: 3.0,    // < 3.0 → consider downlifting to standard
    upliftAbove: null
  },
  premium: {
    downliftBelow: 3.5,   // < 3.5 → consider downlifting to mid-tier
    upliftAbove: null
  },
  luxury_executive: {
    downliftBelow: 4.0,   // < 4.0 → consider downlifting to premium
    upliftAbove: null
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Minimum Reviews For Rating To Be Actionable
// A gym with fewer than this number of reviews won't trigger tier review
// — too few data points to act on.
// ─────────────────────────────────────────────────────────────────────────────
export const MIN_REVIEWS_FOR_TIER_ACTION = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Review Status (for moderation)
// ─────────────────────────────────────────────────────────────────────────────
export const REVIEW_STATUS = {
  PUBLISHED: 'published',
  FLAGGED: 'flagged',    // reported by gym owner or automated filter
  HIDDEN: 'hidden'       // hidden by admin
};
