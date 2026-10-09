// Moderation & Promotion — the vocabulary: entity types, moderation states,
// promotion types and lifecycle, placements. Pure data and tiny helpers; no I/O.
//
// A new promotable entity is one entry in ENTITY_TYPES (plus a resolver in the
// service). A new placement is one entry in PLACEMENTS. Nothing else changes.

export const ENTITY_TYPES = Object.freeze({
  gym: { label: 'Gym' },
  trainer: { label: 'Trainer' },
  vendor: { label: 'Vendor' },
  product: { label: 'Product' },
});

// ── Moderation ──────────────────────────────────────────────────────────────

export const MODERATION_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'suspended', 'hidden']);
/** An entity with no ModerationState row is approved: existing listings and onboarding are unaffected. */
export const IMPLICIT_MODERATION_STATUS = 'approved';
/** Statuses that keep an entity out of public discovery and out of promotion. */
export const BLOCKING_MODERATION_STATUSES = Object.freeze(['pending', 'rejected', 'suspended', 'hidden']);

// action -> { from: [statuses it can start from], to, reason: required? }
export const MODERATION_ACTIONS = Object.freeze({
  approve:        { from: ['pending'], to: 'approved', reason: false },
  reject:         { from: ['pending'], to: 'rejected', reason: true },
  suspend:        { from: ['approved', 'hidden'], to: 'suspended', reason: true },
  hide:           { from: ['approved', 'suspended'], to: 'hidden', reason: true },
  restore:        { from: ['suspended', 'hidden'], to: 'approved', reason: false },
  // A rejected entity goes back for another look; an approved one can be held for a fresh review.
  reopen:         { from: ['rejected'], to: 'pending', reason: false },
  require_review: { from: ['approved'], to: 'pending', reason: true },
});

// ── Promotions ──────────────────────────────────────────────────────────────

export const PROMOTION_TYPES = Object.freeze({
  featured:    { label: 'Featured', disclosure: 'Featured', commercial: 'either' },
  promoted:    { label: 'Promoted', disclosure: 'Promoted', commercial: 'either' },
  // Sponsored is paid placement and must say so; Recommended is FitFlex's own editorial pick.
  sponsored:   { label: 'Sponsored', disclosure: 'Sponsored', commercial: 'required' },
  recommended: { label: 'Recommended', disclosure: 'Recommended by FitFlex', commercial: 'forbidden' },
  campaign:    { label: 'Campaign', disclosure: 'Campaign', commercial: 'either' },
});

export const RELATIONSHIP_TYPES = Object.freeze({
  paid_advertising: 'Paid advertising',
  strategic_partner: 'Strategic partner',
  sponsor: 'Sponsor',
  founding_partner: 'Founding partner',
  barter: 'Barter / in kind',
  editorial: 'FitFlex editorial',
  campaign: 'FitFlex campaign',
});
/** Relationship types that are not a commercial arrangement. */
export const NON_COMMERCIAL_RELATIONSHIPS = Object.freeze(['editorial', 'campaign']);

export const PROMOTION_STATUSES = Object.freeze([
  'draft', 'pending_approval', 'approved', 'scheduled', 'active', 'paused', 'expired', 'completed', 'rejected', 'cancelled',
]);
/** Where a promotion can go next; the service adds the rules about when. */
export const PROMOTION_TRANSITIONS = Object.freeze({
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'draft', 'cancelled'],
  approved: ['scheduled', 'active', 'expired', 'cancelled'],
  scheduled: ['active', 'paused', 'expired', 'cancelled'],
  active: ['paused', 'expired', 'completed', 'cancelled'],
  paused: ['scheduled', 'active', 'expired', 'cancelled'],
  expired: ['completed'],
  rejected: ['draft'],
  completed: [],
  cancelled: [],
});
export const TERMINAL_PROMOTION_STATUSES = Object.freeze(['completed', 'cancelled']);
/** A promotion in one of these holds a slot in its placement(s) for its period. */
export const SLOT_HOLDING_STATUSES = Object.freeze(['approved', 'scheduled', 'active', 'paused']);
/** Fields that can still be edited once a promotion is approved. */
export const LIVE_EDITABLE_FIELDS = Object.freeze(['priority', 'boostWeight', 'endsAt', 'commercialRef', 'notes']);

export const CAMPAIGN_STATUSES = Object.freeze(['draft', 'active', 'ended', 'cancelled']);
export const CAMPAIGN_TRANSITIONS = Object.freeze({
  draft: ['active', 'cancelled'],
  active: ['ended', 'cancelled'],
  ended: [],
  cancelled: [],
});

// ── Placements ──────────────────────────────────────────────────────────────
// Where a promotion can show. `entityTypes` says which entities may occupy it.
export const PLACEMENTS = Object.freeze({
  gym_discovery:     { label: 'Gym discovery', entityTypes: ['gym'] },
  trainer_discovery: { label: 'Trainer discovery', entityTypes: ['trainer'] },
  vendor_discovery:  { label: 'Vendor discovery', entityTypes: ['vendor'] },
  marketplace:       { label: 'Marketplace', entityTypes: ['product', 'vendor'] },
  search_results:    { label: 'Search results', entityTypes: ['gym', 'trainer', 'vendor', 'product'] },
  home:              { label: 'Home / discovery page', entityTypes: ['gym', 'trainer', 'vendor', 'product'] },
  campaign_page:     { label: 'Campaign page', entityTypes: ['gym', 'trainer', 'vendor', 'product'] },
});

/**
 * Defaults used where no PlacementConfig row exists. Configurable per
 * placement and type in the database; these are only the starting point.
 */
export const DEFAULT_PLACEMENT_LIMITS = Object.freeze({
  featured: 5, promoted: 10, sponsored: 5, recommended: 5, campaign: 10,
});
/** The most a promotion may add to a result, as a share of the score range. */
export const DEFAULT_MAX_BOOST_FRACTION = 0.25;
export const ROTATION_MODES = Object.freeze(['none', 'time_slice']);
export const DEFAULT_ROTATION = Object.freeze({ mode: 'time_slice', windowMinutes: 60 });

export const MAX_PRIORITY = 100;
