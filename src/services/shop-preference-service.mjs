// "Personalised shop" — one switch per Person (all their roles share it). No row = on (owner
// decision 2026-10-20). Contract: docs/shop-personalisation-api.md.
//
// `available` = SHOP_PERSONALISATION on and the person holds an adult member persona (see
// shop-personalisation.personalisationEligibility). The switch may be saved either way; it is
// simply never applied while unavailable.
import { personalisationEligibility, historyDaysFromEnv } from './shop-personalisation.mjs';
import { buildNeeds, resolveShoppingMode } from './shop-recommendations.mjs';
import { shopPersonalisationOn, shopNearYouOn } from '../shared/feature-flags.mjs';

export const PREFERENCE_SOURCES = Object.freeze(['privacy_page', 'why_sheet']);
const usable = p => !p.portalOnly && p.accountStatus !== 'suspended' && p.approvalStatus !== 'rejected';

/**
 * The order `uses` lists signals in (GET /shop/preferences). `location` (slice 3, SHOP_NEAR_YOU): the
 * current area is used if the person allows location on the device (the server cannot know that choice).
 */
export const USE_ORDER = Object.freeze(['purchase_history', 'profile_gender', 'profile_age', 'location', 'goal', 'specialty']);

export function createShopPreferenceService({
  store, users, identityLink, flagOn = shopPersonalisationOn, now = () => new Date(),
  nearYouOn = shopNearYouOn,
  // (userId) → the trainer profile (declared specialties), for `uses`. Optional.
  trainerProfileOf = () => null,
  historyDays = () => historyDaysFromEnv(),
}) {
  /** Whose setting this is: the Person, else (an account without a Person) the user itself. */
  const subjectOf = (user, claims) => (user?.personId
    ? { personId: user.personId, subjectType: 'person' }
    : { personId: user?.id || claims.sub, subjectType: 'user' });

  async function personasOf(user) {
    if (!user?.personId || !identityLink) return [];
    return (await identityLink.personasOf(user.personId)).filter(usable);
  }

  /** The member persona's declared profile (the signed-in member, else a usable member persona of the Person). */
  async function memberOf({ user, claims, personas }) {
    if (claims.userType === 'member' && user) return { has: true, profile: user.memberProfile || null };
    const persona = personas.find(p => p.userType === 'member');
    if (!persona) return { has: false, profile: null };
    const row = persona.memberProfile !== undefined ? persona : await users.findByIdAsync(persona.id);
    return { has: true, profile: row?.memberProfile || null };
  }

  /**
   * Everything personalisation needs about this account, read now (never cached).
   * Pass `user` / `personas` / `memberProfile` when the caller already has them.
   * → { flagOn, available, reason, age, personalised, enabled, subject, buyerIds }
   */
  async function stateFor({ claims, user = undefined, personas = undefined, memberProfile = undefined }) {
    const u = user === undefined ? await users.findByIdAsync(claims.sub) : user;
    const ps = personas === undefined ? await personasOf(u) : personas;
    const member = memberProfile === undefined ? await memberOf({ user: u, claims, personas: ps })
      : { has: claims.userType === 'member' || ps.some(p => p.userType === 'member'), profile: memberProfile };
    const on = flagOn();
    const eligibility = personalisationEligibility({ flagOn: on, hasMember: member.has, memberProfile: member.profile, now: now() });
    const subject = subjectOf(u, claims);
    const stored = await store.get(subject.personId);
    const personalised = stored ? stored.personalised : true;
    const buyerIds = [...new Set([claims.sub, u?.id, ...ps.map(p => p.id)].filter(Boolean))];
    return { flagOn: on, ...eligibility, personalised, enabled: eligibility.available && personalised, subject, buyerIds, memberProfile: member.profile, personas: ps, user: u };
  }

  /**
   * Which signals the shop uses right now **in this shopping mode**, so the app's privacy text can be
   * exact (QA 2026-10-22). Flag on: switched off or not available (no member persona, invalid date of
   * birth, under 18) → none at all. Member mode: purchase_history, profile_gender, profile_age, goal;
   * trainer mode: purchase_history, specialty (never gender/age); owner and vendor_personal:
   * purchase_history. Flag off: what the Phase 1 page uses (goal in member mode, specialty in trainer mode).
   */
  async function usesOf(s, claims, mode) {
    if (s.flagOn && (!s.personalised || !s.available)) return [];
    const out = new Set();
    if (s.enabled) out.add('purchase_history');
    if (mode === 'member') {
      if (s.enabled && s.audienceAllowed && ['female', 'male'].includes(s.memberProfile?.gender)) out.add('profile_gender');
      if (s.enabled && s.audienceAllowed) out.add('profile_age');
      if (s.memberProfile && buildNeeds({ mode: 'member', memberProfile: s.memberProfile }).goalCategories.length) out.add('goal');
    }
    if (mode === 'trainer') {
      const trainerId = claims.userType === 'trainer' ? claims.sub : s.personas.find(p => p.userType === 'trainer')?.id;
      const trainerProfile = trainerId ? await trainerProfileOf(trainerId) : null;
      if (trainerProfile && buildNeeds({ mode: 'trainer', trainerProfile }).specialtyCategories.length) out.add('specialty');
    }
    // Slice 3: the current area, in every mode (listed between profile_age and goal by USE_ORDER).
    if (s.enabled && nearYouOn()) out.add('location');
    return USE_ORDER.filter(k => out.has(k));
  }

  /**
   * GET /shop/preferences?mode=… → { body } | { error: 'mode_not_allowed', status: 403 }.
   * `mode` is checked as on GET /shop/home: a role this person holds; default the signed-in role.
   */
  async function get({ claims, mode = undefined }) {
    const s = await stateFor({ claims });
    const resolved = resolveShoppingMode({ requested: mode, sessionUserType: claims.userType, heldUserTypes: s.personas.map(p => p.userType) });
    if (resolved.error) return { error: resolved.error, status: 403 };
    return { body: { personalised: s.personalised, available: s.available, historyDays: historyDays(), mode: resolved.mode, uses: await usesOf(s, claims, resolved.mode) } };
  }

  async function set({ claims, body = {}, mode = undefined }) {
    if (!flagOn()) return { error: 'feature_disabled', status: 404 };
    if (typeof body.personalised !== 'boolean') return { error: 'invalid_field', status: 400, field: 'personalised' };
    if (!PREFERENCE_SOURCES.includes(body.source)) return { error: 'invalid_field', status: 400, field: 'source', allowed: [...PREFERENCE_SOURCES] };
    const user = await users.findByIdAsync(claims.sub);
    const subject = subjectOf(user, claims);
    // The mode is checked before anything is saved, so a refused mode changes nothing.
    const check = await get({ claims, mode });
    if (check.error) return check;
    await store.save({ ...subject, personalised: body.personalised, source: body.source, actorId: claims.sub, at: now().toISOString() });
    return get({ claims, mode });
  }

  return { get, set, stateFor };
}
