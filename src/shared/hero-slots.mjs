// Places in the apps where an admin-managed photo can replace the bundled one
// (plan docs/plans/photo-hero-sections-footer-admin-plan.md, slice 4).
//
// Mobile ids are the names of the app's FFHeroPhoto enum
// (fitflexmobile lib/shared/components/ff_photo_hero.dart), plus the section heroes
// (gyms, trainers, shop) and the footer band pool. `portalLogin` is the portal's login panel.
//
// - surface:    'mobile' | 'portal'
// - variant:    the layout the slot is mostly drawn in on a phone (full | compact | band) or
//               on desktop (panel). It decides which text zone the brightness check reads:
//               the bottom 55% for full/compact/band, the left 50% for panel (spec §8.3, crops table).
// - aspectHint: width / height of the bundled photo, for the admin's crop previews.
// - maxImages:  how many photos the slot rotates through (rotation is per day, D-5).
//
// An empty slot is allowed: it means "use the bundled photo".

const slot = (id, surface, variant, aspectHint, maxImages = 3) => Object.freeze({ id, surface, variant, aspectHint, maxImages });

export const HERO_SLOTS = Object.freeze([
  slot('language', 'mobile', 'full', 4 / 5),
  slot('signIn', 'mobile', 'full', 4 / 5),
  slot('signUp', 'mobile', 'full', 4 / 5),
  slot('role', 'mobile', 'compact', 16 / 9),
  slot('homeStart', 'mobile', 'full', 4 / 5),
  slot('homePass', 'mobile', 'compact', 3 / 2),
  slot('profile', 'mobile', 'compact', 3 / 2),
  slot('pin', 'mobile', 'compact', 1005 / 670),
  slot('upgrade', 'mobile', 'compact', 3 / 2),
  slot('activityToday', 'mobile', 'compact', 3 / 2),
  slot('activityTraining', 'mobile', 'compact', 800 / 533),
  slot('activityChallenges', 'mobile', 'compact', 900 / 580),
  slot('activityProgress', 'mobile', 'compact', 3 / 2),
  slot('trainer', 'mobile', 'compact', 840 / 530),
  slot('vendor', 'mobile', 'compact', 880 / 587),
  slot('owner', 'mobile', 'compact', 3 / 2),
  // Section heroes (slice 1).
  slot('gyms', 'mobile', 'compact', 3 / 2),
  slot('trainers', 'mobile', 'compact', 3 / 2),
  slot('shop', 'mobile', 'compact', 3 / 2),
  // Footer band (slice 2): a pool the app picks from, never the same photo as the screen's top hero.
  slot('footerPool', 'mobile', 'band', 3 / 1, 8),
  // Portal login panel (slice 5).
  slot('portalLogin', 'portal', 'panel', 3 / 2, 1),
]);

const BY_ID = new Map(HERO_SLOTS.map(s => [s.id, s]));

export const heroSlot = id => BY_ID.get(String(id ?? '')) ?? null;
export const heroSlotIds = () => HERO_SLOTS.map(s => s.id);

/** Which text zone a slot's brightness warning reads. */
export const textZoneFor = slotOrId => {
  const s = typeof slotOrId === 'string' ? heroSlot(slotOrId) : slotOrId;
  return s?.variant === 'panel' ? 'horizontal' : 'vertical';
};
