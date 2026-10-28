// Marathon & running events · S3 — the participant rules (spec §3.3, §3.11; D20). Pure: no I/O, nothing thrown.
//
//   effectiveFields(event, categories)        the §3.3 field policy with the defaults filled in
//   checkParticipant(p, ctx)                  one wire participant → { ok, problems, warnings, participant (normalised) }
//   findDuplicatesInRequest(participants)     same normalised phone / email twice in one request, per category
//   ageOnEventDay(dob, startsAt, timezone)    whole years on the event start day in the event's timezone
//   consentTextFor(version)                   the three consent texts (draft pending Tanzanian counsel)
//   maskName / maskContactShort               what an organizer, a claim preview or a matched member may see
//   canonicalFingerprint(body)                sha256 of the body with sorted keys (idempotency)
//   newJoinCode / normaliseJoinCode / formatJoinCode   team codes (spec §3.9)
//   newClaimToken / hashToken / isClaimTokenShape      claim links (spec §3.7)
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { normalizeEmail, normalizePhone } from './identifiers.mjs';
import { isValidDateOfBirth, ageOnDay } from './date-of-birth.mjs';

export const FIELD_POLICIES = Object.freeze(['required', 'optional', 'off']);
export const PARTICIPANT_FIELD_KEYS = Object.freeze(['phone', 'email', 'dateOfBirth', 'gender', 'emergencyContact', 'kitSize']);
export const KIT_SIZES = Object.freeze(['xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl']);
export const GENDERS = Object.freeze(['male', 'female', 'other']);
export const CONSENT_BASES = Object.freeze(['self', 'purchaser_authorised', 'organisation']);
export const DUPLICATE_POLICIES = Object.freeze(['one_per_category', 'allow']);
export const MEMBER_CANCEL_REASONS = Object.freeze(['changed_mind', 'wrong_details', 'duplicate', 'other']);
export const TEAM_TYPES_MEMBER = Object.freeze(['club', 'community']);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NAME_BAD = /[\d@]/;

const isStr = v => typeof v === 'string';
const trimmed = v => (isStr(v) ? v.trim() : '');
const filled = v => trimmed(v).length > 0;

/** The §3.3 policy with defaults: DOB required when any live category has minAge; kit size optional when a kit is handed out. */
export function effectiveFields(event = {}, categories = []) {
  const stored = event?.participantFields && typeof event.participantFields === 'object' ? event.participantFields : {};
  const anyMinAge = (categories || []).some(c => c && c.status !== 'inactive' && Number.isInteger(c.minAge) && c.minAge > 0);
  const defaults = {
    phone: 'required',
    email: 'optional',
    dateOfBirth: anyMinAge ? 'required' : 'off',
    gender: 'off',
    emergencyContact: 'optional',
    kitSize: event?.kitProvided === true ? 'optional' : 'off',
  };
  const out = {};
  for (const key of PARTICIPANT_FIELD_KEYS) out[key] = FIELD_POLICIES.includes(stored[key]) ? stored[key] : defaults[key];
  // DOB cannot be off while an age rule exists: the rule could not be checked (§3.3).
  if (anyMinAge && out.dateOfBirth === 'off') out.dateOfBirth = 'required';
  return out;
}

/** The wire value of participantFields as an organizer may store it: only known keys and values. */
export function parseParticipantFields(value) {
  if (value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const key of PARTICIPANT_FIELD_KEYS) if (FIELD_POLICIES.includes(value[key])) out[key] = value[key];
  return out;
}

/** "YYYY-MM-DD" of instant `at` in `timezone` (Intl; falls back to UTC for an unknown zone). */
export function localDateIn(timezone, at) {
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(+when)) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
  } catch {
    return when.toISOString().slice(0, 10);
  }
}

/** "HH:mm" of instant `at` in `timezone` (for "held until {time}"). */
export function localTimeIn(timezone, at) {
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(+when)) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(when);
  } catch {
    return when.toISOString().slice(11, 16);
  }
}

/** { h, min } of instant `at` in `timezone` (24-hour), for the Swahili 12-hour clock. */
export function localHourMinuteIn(timezone, at) {
  const t = localTimeIn(timezone, at);
  const m = /^(\d{2}):(\d{2})$/.exec(t || '');
  return m ? { h: Number(m[1]), min: Number(m[2]) } : null;
}

/** Input caps, applied BEFORE any regex or normaliser runs (security review M4). */
export const FIELD_CAPS = Object.freeze({
  firstName: 80, lastName: 80, phone: 20, email: 254, dateOfBirth: 10, gender: 20, kitSize: 10, groupLabel: 100,
  ticketTypeId: 64, category: 120, ticketType: 120, costCentre: 80, purchaserReference: 80, consentBasis: 30,
});
export const EMERGENCY_CAPS = Object.freeze({ name: 80, phone: 20 });
export const ROSTER_TEXT_MAX_CHARS = 1_000_000;
export const CELL_MAX_CHARS = 200;

/** The first participant field whose string is over its cap → { field } | null. Non-strings are left to the checks. */
export function oversizedField(p) {
  if (!p || typeof p !== 'object') return null;
  for (const [key, max] of Object.entries(FIELD_CAPS)) if (typeof p[key] === 'string' && p[key].length > max) return { field: key, max };
  const ec = p.emergencyContact;
  if (ec && typeof ec === 'object') for (const [key, max] of Object.entries(EMERGENCY_CAPS)) if (typeof ec[key] === 'string' && ec[key].length > max) return { field: `emergencyContact.${key}`, max };
  return null;
}

/** Spreadsheet formula starters: =, +, -, @ at the start of a free-text value (security review L2). */
export const startsLikeFormula = v => typeof v === 'string' && /^[=+\-@]/.test(v.trim());

/** Whole years from `dateOfBirth` to the event start day in the event's timezone; a birthday on event day counts. null when unreadable. */
export function ageOnEventDay(dateOfBirth, startsAt, timezone) {
  const day = localDateIn(timezone, startsAt);
  return day ? ageOnDay(dateOfBirth, day) : null;
}

const problem = (field, code, extra = {}) => ({ field, code, ...extra });

/**
 * Check and normalise one participant (§3.11). ctx:
 *   fields            effectiveFields(...)
 *   category          { id, minAge } the participant's ticket type belongs to (null → ticket_type problem)
 *   event             { startsAt, timezone }
 *   mode              'member' | 'corporate' (consent basis rule)
 *   purchaserContacts [{ type, value }] the purchaser's verified contacts (self_contact_mismatch)
 *   now               for the DOB sanity rule
 * → { ok, problems: [{ field, code, ... }], warnings: [{ field, code }], participant: normalised wire object + phoneNormalized / emailNormalized }
 */
export function checkParticipant(p, { fields, category, event, mode = 'member', purchaserContacts = [], now = new Date() }) {
  const problems = [];
  const warnings = [];
  const src = p && typeof p === 'object' ? p : {};
  const out = { ticketTypeId: isStr(src.ticketTypeId) ? src.ticketTypeId : null };

  const consentBasis = src.consentBasis;
  if (!CONSENT_BASES.includes(consentBasis) || (mode === 'corporate' ? consentBasis !== 'organisation' : consentBasis === 'organisation')) {
    problems.push(problem('consentBasis', 'consent_basis_invalid'));
  }
  out.consentBasis = consentBasis;
  // A corporate row is never "self" (its consent basis is already refused above); the self-contact rule is a member rule.
  const isSelf = consentBasis === 'self' && mode !== 'corporate';

  for (const key of ['firstName', 'lastName']) {
    const v = trimmed(src[key]);
    if (!v) problems.push(problem(key, 'required'));
    else if (v.length > FIELD_CAPS[key] || NAME_BAD.test(v)) problems.push(problem(key, 'name_invalid'));
    else if (startsLikeFormula(v)) problems.push(problem(key, 'invalid_text'));
    out[key] = v || null;
  }

  // phone / email: policy, format, at least one contact for anyone but a self row
  const policy = fields || effectiveFields(event, []);
  const sent = key => src[key] !== undefined && src[key] !== null && !(isStr(src[key]) && src[key].trim() === '');
  const dropped = key => { if (sent(key)) warnings.push(problem(key, 'not_collected')); };

  let phone = null;
  if (policy.phone === 'off') dropped('phone');
  else if (sent('phone')) {
    phone = isStr(src.phone) && src.phone.length > FIELD_CAPS.phone ? null : normalizePhone(src.phone);
    if (!phone) problems.push(problem('phone', 'phone_invalid'));
  } else if (policy.phone === 'required') problems.push(problem('phone', 'required'));
  out.phone = phone;
  out.phoneNormalized = phone;

  let email = null;
  if (policy.email === 'off') dropped('email');
  else if (sent('email')) {
    email = isStr(src.email) && src.email.length > FIELD_CAPS.email ? null : normalizeEmail(src.email);
    if (!email || email.length > FIELD_CAPS.email || !EMAIL_RE.test(email)) { problems.push(problem('email', 'email_invalid')); email = null; }
  } else if (policy.email === 'required') problems.push(problem('email', 'required'));
  out.email = email;
  out.emailNormalized = email;

  if (!isSelf && !phone && !email && !problems.some(x => ['phone', 'email'].includes(x.field))) problems.push(problem('phone', 'contact_required'));

  if (isSelf && (phone || email)) {
    const mine = new Set((purchaserContacts || []).map(c => `${c.type}:${c.value}`));
    const ok = (phone && mine.has(`phone:${phone}`)) || (email && mine.has(`email:${email}`));
    const strange = (phone && !mine.has(`phone:${phone}`)) || (email && !mine.has(`email:${email}`));
    if (!ok || strange) problems.push(problem(phone && !mine.has(`phone:${phone}`) ? 'phone' : 'email', 'self_contact_mismatch'));
  }

  // date of birth and age
  let dob = null;
  if (policy.dateOfBirth === 'off') dropped('dateOfBirth');
  else if (sent('dateOfBirth')) {
    dob = trimmed(src.dateOfBirth);
    if (dob.length > FIELD_CAPS.dateOfBirth || !isValidDateOfBirth(dob, now)) { problems.push(problem('dateOfBirth', 'dob_invalid')); dob = null; }
  } else if (policy.dateOfBirth === 'required') problems.push(problem('dateOfBirth', 'required'));
  out.dateOfBirth = dob;
  const minAge = Number.isInteger(category?.minAge) && category.minAge > 0 ? category.minAge : null;
  if (minAge) {
    if (!dob) { if (!problems.some(x => x.field === 'dateOfBirth')) problems.push(problem('dateOfBirth', 'dob_required', { minAge })); }
    else {
      const age = ageOnEventDay(dob, event?.startsAt, event?.timezone);
      if (age === null || age < minAge) problems.push(problem('dateOfBirth', 'age_not_eligible', { minAge, ageOnEventDay: age }));
    }
  }

  let gender = null;
  if (policy.gender === 'off') dropped('gender');
  else if (sent('gender')) {
    gender = trimmed(src.gender).toLowerCase();
    if (!GENDERS.includes(gender)) { problems.push(problem('gender', 'gender_invalid')); gender = null; }
  } else if (policy.gender === 'required') problems.push(problem('gender', 'required'));
  out.gender = gender;

  let kitSize = null;
  if (policy.kitSize === 'off') dropped('kitSize');
  else if (sent('kitSize')) {
    kitSize = trimmed(src.kitSize).toLowerCase();
    if (!KIT_SIZES.includes(kitSize)) { problems.push(problem('kitSize', 'kit_size_invalid')); kitSize = null; }
  } else if (policy.kitSize === 'required') problems.push(problem('kitSize', 'required'));
  out.kitSize = kitSize;

  let emergencyContact = null;
  const ecSent = src.emergencyContact && typeof src.emergencyContact === 'object';
  if (policy.emergencyContact === 'off') { if (ecSent) warnings.push(problem('emergencyContact', 'not_collected')); }
  else if (ecSent) {
    const name = trimmed(src.emergencyContact.name);
    const rawEc = src.emergencyContact.phone;
    const ecPhone = isStr(rawEc) && rawEc.length > EMERGENCY_CAPS.phone ? null : normalizePhone(rawEc);
    if (!name || name.length > EMERGENCY_CAPS.name || !ecPhone) problems.push(problem('emergencyContact', 'emergency_contact_invalid'));
    else emergencyContact = { name, phone: ecPhone };
  } else if (policy.emergencyContact === 'required') {
    // A roster has no emergency-contact column, so a corporate row cannot supply it: a warning, not a blocker (review L1).
    if (mode === 'corporate') warnings.push(problem('emergencyContact', 'not_collected'));
    else problems.push(problem('emergencyContact', 'required'));
  }
  out.emergencyContact = emergencyContact;

  if (mode === 'corporate') {
    const g = trimmed(src.groupLabel);
    if (g.length > FIELD_CAPS.groupLabel) problems.push(problem('groupLabel', 'invalid_text'));
    else if (startsLikeFormula(g)) problems.push(problem('groupLabel', 'invalid_text'));
    out.groupLabel = g && !problems.some(x => x.field === 'groupLabel') ? g : null;
  }

  return { ok: problems.length === 0, problems, warnings, participant: out };
}

/**
 * Participants (already normalised) listed twice in one request, per category (D20). → [{ index, otherIndex, key }]
 * Only the later occurrence is flagged, so one row of a pair stays usable.
 */
export function findDuplicatesInRequest(participants, categoryOf = p => p.categoryId ?? p.ticketTypeId) {
  const seen = new Map();
  const out = [];
  participants.forEach((p, index) => {
    const cat = categoryOf(p);
    for (const [kind, value] of [['phone', p.phoneNormalized], ['email', p.emailNormalized]]) {
      if (!value) continue;
      const key = `${cat}:${kind}:${value}`;
      if (seen.has(key)) { out.push({ index, otherIndex: seen.get(key), key: kind }); break; }
      seen.set(key, index);
    }
  });
  return out;
}

// ── Consent texts (spec §3.11; drafts pending Tanzanian counsel) ─────────────

const CONSENT = Object.freeze({
  self: {
    en: 'I agree to the event terms and refund policy and to FitFlex sharing my registration details (name, contact, date of birth, kit size) with the organizer for this event.',
    sw: 'Nakubali masharti ya tukio na sera ya marejesho, na FitFlex kushirikisha taarifa zangu za usajili (jina, mawasiliano, tarehe ya kuzaliwa, saizi ya vifaa vya mbio) na mwandaaji wa tukio hili.',
  },
  purchaser_authorised: {
    en: 'I confirm I have each listed person\'s permission to register them and to share their details with FitFlex and the organizer. They will be invited to claim their place.',
    sw: 'Nathibitisha nina ruhusa ya kila mtu aliyeorodheshwa kumsajili na kushirikisha taarifa zake na FitFlex na mwandaaji. Wataalikwa kuchukua tiketi yao.',
  },
  organisation: {
    en: 'We confirm our organisation has each listed person\'s permission to register them for this event and to share their details with FitFlex and the organizer.',
    sw: 'Tunathibitisha shirika letu lina ruhusa ya kila mtu aliyeorodheshwa kumsajili kwenye tukio hili na kushirikisha taarifa zake na FitFlex na mwandaaji.',
  },
});

/** { version, self: { en, sw }, purchaser_authorised: { en, sw }, organisation: { en, sw } } */
export function consentTextFor(version) {
  // versionLabel: what a screen may show (the "-draft" suffix is internal; the identifier `version` stays as is).
  return { version, versionLabel: String(version).replace(/-draft$/i, ''), self: { ...CONSENT.self }, purchaser_authorised: { ...CONSENT.purchaser_authorised }, organisation: { ...CONSENT.organisation } };
}

// ── Masking ──────────────────────────────────────────────────────────────────

/** "Neema Abdallah" → "N**** A*******" (the friend-invitation rule). */
export function maskName(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean)
    .map(part => part[0].toUpperCase() + '*'.repeat(Math.max(part.length - 1, 1))).join(' ') || null;
}

/** "Asha" → "A***"; the last initial separately. */
export const maskFirstName = name => maskName(String(name || '').trim().split(/\s+/)[0] || '');
export const lastInitial = name => { const v = String(name || '').trim(); return v ? `${v[0].toUpperCase()}.` : null; };

/** { type, masked }: phone → "••• 678", email → "a•••@example.com"; null without a contact. */
export function maskContactShort({ phone, email } = {}) {
  if (phone) return { type: 'phone', masked: `••• ${String(phone).slice(-3)}` };
  if (email) {
    const [local, domain] = String(email).split('@');
    return { type: 'email', masked: domain ? `${local.slice(0, 1)}•••@${domain}` : '•••' };
  }
  return null;
}

// ── Idempotency, codes and tokens ────────────────────────────────────────────

const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
/** sha256 (hex) of the body with keys sorted at every level: the same request in any key order gives the same fingerprint. */
export const canonicalFingerprint = body => createHash('sha256').update(JSON.stringify(sortKeys(body ?? {}))).digest('hex');

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,100}$/;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 8 characters from the unambiguous alphabet (no 0/O, 1/I). */
export function newJoinCode() {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
/** "ab12-cd34" / "AB12 CD34" → "AB12CD34"; null when not 8 alphabet characters. */
export function normaliseJoinCode(value) {
  const v = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-9]{8}$/.test(v) && [...v].every(ch => CODE_ALPHABET.includes(ch)) ? v : null;
}
/** "AB12CD34" → "AB12-CD34" (how the apps show it). */
export const formatJoinCode = code => (code ? `${code.slice(0, 4)}-${code.slice(4)}` : null);

export const hashToken = value => createHash('sha256').update(String(value)).digest('hex');
/** 32 random bytes, base64url (43 chars). The hash is stored; the token is only ever in a link. */
export const newClaimToken = () => randomBytes(32).toString('base64url');
export const isClaimTokenShape = t => typeof t === 'string' && /^[A-Za-z0-9_-]{40,48}$/.test(t);
