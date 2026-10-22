// "Personalised shop" — one switch per Person (all their roles share it). No row = on (owner
// decision 2026-10-20). Contract: docs/shop-personalisation-api.md.
//
// `available` = SHOP_PERSONALISATION on and the person holds an adult member persona (see
// shop-personalisation.personalisationEligibility). The switch may be saved either way; it is
// simply never applied while unavailable.
import { personalisationEligibility, historyDaysFromEnv } from './shop-personalisation.mjs';
import { buildNeeds } from './shop-recommendations.mjs';
import { shopPersonalisationOn } from '../shared/feature-flags.mjs';

export const PREFERENCE_SOURCES = Object.freeze(['privacy_page', 'why_sheet']);
const usable = p => !p.portalOnly && p.accountStatus !== 'suspended' && p.approvalStatus !== 'rejected';

/** The order `uses` lists signals in (GET /shop/preferences). Location joins in slice 3. */
export const USE_ORDER = Object.freeze(['purchase_history', 'profile_gender', 'profile_age', 'goal', 'specialty']);

export function createShopPreferenceService({
  store, users, identityLink, flagOn = shopPersonalisationOn, now = () => new Date(),
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
   * Which signals this account's shop actually uses right now, so the app's privacy text can be exact.
   * Switched off (flag on): none. Flag off or not available: only what Phase 1 uses (declared goal, specialty).
   */
  async function usesOf(s, claims) {
    const out = new Set();
    if (s.flagOn && !s.personalised) return [];
    if (s.enabled) {
      out.add('purchase_history');
      if (s.audienceAllowed && ['female', 'male'].includes(s.memberProfile?.gender)) out.add('profile_gender');
      if (s.audienceAllowed) out.add('profile_age');
    }
    if (s.memberProfile && buildNeeds({ mode: 'member', memberProfile: s.memberProfile }).goalCategories.length) out.add('goal');
    const trainerId = claims.userType === 'trainer' ? claims.sub : s.personas.find(p => p.userType === 'trainer')?.id;
    const trainerProfile = trainerId ? await trainerProfileOf(trainerId) : null;
    if (trainerProfile && buildNeeds({ mode: 'trainer', trainerProfile }).specialtyCategories.length) out.add('specialty');
    return USE_ORDER.filter(k => out.has(k));
  }

  async function get({ claims }) {
    const s = await stateFor({ claims });
    return { body: { personalised: s.personalised, available: s.available, historyDays: historyDays(), uses: await usesOf(s, claims) } };
  }

  async function set({ claims, body = {} }) {
    if (!flagOn()) return { error: 'feature_disabled', status: 404 };
    if (typeof body.personalised !== 'boolean') return { error: 'invalid_field', status: 400, field: 'personalised' };
    if (!PREFERENCE_SOURCES.includes(body.source)) return { error: 'invalid_field', status: 400, field: 'source', allowed: [...PREFERENCE_SOURCES] };
    const user = await users.findByIdAsync(claims.sub);
    const subject = subjectOf(user, claims);
    await store.save({ ...subject, personalised: body.personalised, source: body.source, actorId: claims.sub, at: now().toISOString() });
    return get({ claims });
  }

  return { get, set, stateFor };
}
