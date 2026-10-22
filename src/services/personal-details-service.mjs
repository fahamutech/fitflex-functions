// Partner date of birth · slice 2 (docs/partner-dob-api.md). A person's own declared date of birth
// and gender, kept on their Person (one per human, across member / trainer / gym owner personas):
//   GET/PUT /me/personal-details, the optional fields on /trainer/register and /gym-owner/register,
//   and the admin view-only read.
// Owner decisions 2026-10-22: never read KYC for this (the KYC date of birth stays KYC-only);
// new trainers and gym owners must be 18 or older (checked whenever a date of birth is sent); trainer
// mode reuses TrainerProfile.gender; gender NULL = "prefer not to say"; admins may view, never edit.
// Values are never written to the audit log or to server logs.
import { randomUUID } from 'node:crypto';
import { parseDateOfBirthInput, readDateOfBirth, ageOnDay, eatToday } from '../shared/date-of-birth.mjs';
import { PERSON_GENDERS, readPersonDetails, personDetailsColumnsExist } from '../infra/person-details-store-pg.mjs';
import { partnerDobRequiredOn } from '../shared/feature-flags.mjs';

export const PARTNER_TYPES = Object.freeze(['trainer', 'gym_operator']);
export const PARTNER_MIN_AGE = 18;

/**
 * A gender in a write body. → { skip: true } (not sent: keep) | { value: null } (null or '': not given,
 * "prefer not to say") | { value } | { error: 'invalid_field', status: 400, field: 'gender' }
 */
export function parseGenderInput(value) {
  if (value === undefined) return { skip: true };
  if (value === null || (typeof value === 'string' && value.trim() === '')) return { value: null };
  if (typeof value !== 'string' || !PERSON_GENDERS.includes(value)) return { error: 'invalid_field', status: 400, field: 'gender' };
  return { value };
}

export function createPersonalDetailsService({ db, auditLog, trainers, now = () => new Date() }) {
  const live = q => q.where(b => b.whereNull('accountStatus').orWhereNot('accountStatus', 'closed'));

  async function personIdOf(userId) {
    if (!userId) return null;
    const row = await db('User').where({ id: userId }).first('personId');
    return row?.personId || null;
  }

  async function partnerPersonas(personId) {
    if (!personId) return [];
    return live(db('User').where({ personId }).whereIn('userType', PARTNER_TYPES)).select('id', 'userType');
  }

  /** A valid member date of birth of the same Person (the asking member's own first). */
  async function memberDateOfBirth(personId, preferUserId) {
    if (!personId) return null;
    const rows = await db('User').where({ personId, userType: 'member' }).select('id', 'memberProfile');
    rows.sort((a, b) => (a.id === preferUserId ? -1 : b.id === preferUserId ? 1 : 0));
    for (const r of rows) {
      const profile = typeof r.memberProfile === 'string' ? safeJson(r.memberProfile) : r.memberProfile;
      const dob = profile?.dateOfBirth;
      if (readDateOfBirth(dob, now()).status === 'valid') return dob;
    }
    return null;
  }

  /** The gender a trainer already gave on their trainer profile (shown to clients). */
  async function trainerProfileGender(personas) {
    for (const p of personas.filter(x => x.userType === 'trainer')) {
      const profile = await trainers.findAsync(t => t.userId === p.id);
      if (profile && PERSON_GENDERS.includes(profile.gender)) return profile.gender;
    }
    return null;
  }

  /** What GET /me/personal-details and the admin view show, from a Person. */
  async function details({ userId, personId, flagOn }) {
    const person = await readPersonDetails(db, personId);
    const personas = await partnerPersonas(personId);
    const holdsPartnerRole = personas.length > 0;
    let dateOfBirth = null;
    let source = null;
    if (person?.dateOfBirth && readDateOfBirth(person.dateOfBirth, now()).status === 'valid') {
      dateOfBirth = person.dateOfBirth; source = 'person';
    } else {
      const fromMember = await memberDateOfBirth(personId, userId);
      if (fromMember) { dateOfBirth = fromMember; source = 'member'; }
    }
    let gender = await trainerProfileGender(personas);
    let genderFrom = gender ? 'trainer_profile' : null;
    if (!gender && person?.gender && PERSON_GENDERS.includes(person.gender)) { gender = person.gender; genderFrom = 'person'; }
    return {
      dateOfBirth, gender, source,
      ask: Boolean(flagOn && holdsPartnerRole && !dateOfBirth),
      required: Boolean(flagOn && holdsPartnerRole),
      genderFrom,
    };
  }

  /** GET /me/personal-details (flag already checked by the route). */
  async function mine(user) {
    return details({ userId: user.id, personId: await personIdOf(user.id), flagOn: true });
  }

  /**
   * Checks the fields of a write body. `partner`: the person is (or is becoming) a trainer or gym
   * owner, so a date of birth under 18 is refused.
   * → { error, status, field? } | { changes: { dateOfBirth?, gender? } } (only the keys to write)
   */
  function check(body = {}, { fields, partner }) {
    const changes = {};
    if (fields.includes('dateOfBirth')) {
      const dob = parseDateOfBirthInput(body.dateOfBirth, now());
      if (dob.error) return { error: 'invalid_field', status: 400, field: 'dateOfBirth' };
      if (!dob.skip) {
        if (dob.value && partner && ageOnDay(dob.value, eatToday(now())) < PARTNER_MIN_AGE) {
          return { error: 'partner_under_18', status: 400 };
        }
        changes.dateOfBirth = dob.value;
      }
    }
    if (fields.includes('gender')) {
      const g = parseGenderInput(body.gender);
      if (g.error) return g;
      if (!g.skip) changes.gender = g.value;
    }
    return { changes };
  }

  const UNAVAILABLE = Object.freeze({ error: 'personal_details_unavailable', status: 503 });
  const underAge = dob => ageOnDay(dob, eatToday(now())) < PARTNER_MIN_AGE;

  /**
   * Security review M1: the date of birth that counts for the 18+ rule. A value being sent wins; ""
   * (clearing it) falls back past the Person to the member profile; otherwise the Person's, else a
   * valid member-profile one. Flag on only. → null (fine, or no date of birth at all) |
   * { error: 'partner_under_18', status: 400 }
   */
  async function assertPartnerAge({ user, changes = {} }) {
    if (!partnerDobRequiredOn()) return null;
    const personId = await personIdOf(user?.id);
    let dob = null;
    if (changes.dateOfBirth) dob = changes.dateOfBirth;
    else {
      if (!('dateOfBirth' in changes)) {
        const person = await readPersonDetails(db, personId);
        if (person?.dateOfBirth && readDateOfBirth(person.dateOfBirth, now()).status === 'valid') dob = person.dateOfBirth;
      }
      if (!dob) dob = await memberDateOfBirth(personId, user?.id);
    }
    return dob && readDateOfBirth(dob, now()).status === 'valid' && underAge(dob)
      ? { error: 'partner_under_18', status: 400 } : null;
  }

  /**
   * Security review M1 variant 3: POST /me/profile saving a member date of birth under 18 for a
   * person who holds a trainer or gym-owner role. Flag on only. → null | { error, status }
   */
  async function assertMemberProfileAge({ user, dateOfBirth }) {
    if (!partnerDobRequiredOn() || !dateOfBirth) return null;
    if (readDateOfBirth(dateOfBirth, now()).status !== 'valid' || !underAge(dateOfBirth)) return null;
    const partner = (await partnerPersonas(await personIdOf(user?.id))).length > 0;
    return partner ? { error: 'partner_under_18', status: 400 } : null;
  }

  async function write({ personId, actorId, changes, via }) {
    const fields = Object.keys(changes);
    if (!personId || !fields.length) return;
    // Security review L2: before the migration has run there is nowhere to write; callers check
    // ready() first so nothing else is saved either. This is the last stop.
    if (!(await personDetailsColumnsExist(db))) return;
    const before = await readPersonDetails(db, personId);
    await db('Person').where({ id: personId })
      .update({ ...changes, declaredProfileUpdatedAt: db.fn.now(), updatedAt: db.fn.now() });
    // Which fields changed and whether each was set before/after — never the values.
    const state = row => Object.fromEntries(fields.map(f => [f, row?.[f] ? 'set' : 'none']));
    await auditLog.insertAsync({
      id: randomUUID(), at: now().toISOString(), actor: actorId, action: 'personal_details_updated',
      target: personId, before: state(before), after: { ...state(changes), via },
    });
  }

  /** PUT /me/personal-details (flag already checked by the route). */
  async function update({ user, body }) {
    const personId = await personIdOf(user.id);
    if (!personId) return { error: 'person_not_found', status: 404 };
    const partner = (await partnerPersonas(personId)).length > 0;
    const checked = check(body || {}, { fields: ['dateOfBirth', 'gender'], partner });
    if (checked.error) return checked;
    if (partner) {
      const age = await assertPartnerAge({ user, changes: checked.changes });
      if (age) return age;
    }
    if (Object.keys(checked.changes).length && !(await personDetailsColumnsExist(db))) return UNAVAILABLE;
    await write({ personId, actorId: user.id, changes: checked.changes, via: 'me' });
    return details({ userId: user.id, personId, flagOn: true });
  }

  /**
   * /trainer/register (fields ['dateOfBirth']) and /gym-owner/register (['dateOfBirth', 'gender']):
   * check before registering, save after. Leaving the fields out is always accepted; the 18+ rule
   * then still applies to a date of birth already stored (security review M1).
   * → { error, status, field? } | { changes }
   */
  async function checkRegistration({ user, body, fields }) {
    const checked = check(body || {}, { fields, partner: true });
    if (checked.error) return checked;
    const age = await assertPartnerAge({ user, changes: checked.changes });
    if (age) return age;
    if (Object.keys(checked.changes).length && !(await personDetailsColumnsExist(db))) return UNAVAILABLE;
    return checked;
  }
  async function saveRegistration({ user, changes, via }) {
    if (!changes || !Object.keys(changes).length) return;
    await write({ personId: await personIdOf(user.id), actorId: user.id, changes, via });
  }

  /**
   * Admin, view only: { dateOfBirth, age, gender, genderFrom, source } of a persona's Person.
   * Security review L1: the member-profile fallback (source 'member') only for a caller who may also
   * see members (`withMemberFallback`); otherwise only the date the partner declared.
   */
  async function adminView({ userId, actorId, subject, withMemberFallback = false }) {
    const personId = await personIdOf(userId);
    const d = personId ? await details({ userId, personId, flagOn: true })
      : { dateOfBirth: null, gender: null, source: null, genderFrom: null };
    if (d.source === 'member' && !withMemberFallback) { d.dateOfBirth = null; d.source = null; }
    await auditLog.insertAsync({
      id: randomUUID(), at: now().toISOString(), actor: actorId, action: 'personal_details_viewed',
      target: userId || subject?.id || null, before: null, after: { subject },
    });
    return {
      dateOfBirth: d.dateOfBirth,
      age: d.dateOfBirth ? ageOnDay(d.dateOfBirth, eatToday(now())) : null,
      gender: d.gender, genderFrom: d.genderFrom, source: d.source,
    };
  }

  return { mine, update, checkRegistration, saveRegistration, adminView, assertPartnerAge, assertMemberProfileAge };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
