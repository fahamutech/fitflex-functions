// Marathon & running events · S2 — the event document as the apps see it (spec §6.2, §7, §11, §12, §14, §16).
// Pure: no I/O, nothing thrown for a business refusal.
//
//   parseEventPatch(body)                         → { patch, nested } normalised from the wire shape (unknown keys dropped)
//   validateEvent(doc, { mode, now })             → [{ path, code }]  codes = spec §10 events.validation.* suffixes
//   materialChanges(before, after)                → the §7.4 paths that differ between two documents
//   changedPaths(before, after)                   → every path that differs (for the change log)
//   availabilityOf(event, ticketTypes, now, opts) → open | closing_soon | sold_out | closed | not_yet_open | cancelled | in_progress | completed
//   tzInfo(timezone, at)                          → { utcOffsetMinutes, timezoneAbbr } from the IANA zone (Intl only)
//   allowedActionsFor({ status, actor, role, organizerStatus }) → §7.2 action names
//   summaryView / detailView / organizerView      → the §14 shapes
import { normalizePhone } from './identifiers.mjs';
import { parseParticipantFields, effectiveFields, DUPLICATE_POLICIES, FIELD_POLICIES, PARTICIPANT_FIELD_KEYS } from './events-participants.mjs';

export const EVENT_TYPES = Object.freeze(['road', 'trail', 'fun', 'charity', 'virtual']);
export const REFUND_PRESETS = Object.freeze(['no_refund', 'refund_until_close', 'custom']);
export const CANCEL_REASONS = Object.freeze(['weather', 'permit', 'safety', 'low_turnout', 'organizer_decision', 'other']);
export const REJECT_REASONS = Object.freeze(['incomplete_details', 'permit_missing', 'pricing_unclear', 'terms_unclear', 'duplicate_event', 'policy_violation', 'other']);
export const EVENT_ACTIONS = Object.freeze(['edit', 'submit', 'withdraw', 'approve', 'reject', 'cancel', 'complete', 'archive', 'delete']);
export const PUBLIC_STATUSES = Object.freeze(['published', 'registration_closed', 'in_progress']);
export const DISTANCE_BUCKETS = Object.freeze(['5k', '10k', '21k', '42k', 'other']);
export const PRICE_BUCKETS = Object.freeze(['free', 'under_20k', 'under_50k', 'any']);
export const SORTS = Object.freeze(['soonest', 'price_low', 'newest']);
/** A ticket type with no limit is stored at the spec's maximum (the S1 column is NOT NULL and bounds the inventory CHECK). */
export const UNLIMITED_CAPACITY = 100000;
export const DEFAULT_CLOSING_SOON_HOURS = 72;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/**
 * Tanzania's regions. The code (kebab-case of the English name) is what venue.region stores. Mainland
 * region names are the same word in both languages; the four Zanzibar regions have Swahili names.
 */
const REGION_NAMES_SW = Object.freeze({ 'Pemba North': 'Kaskazini Pemba', 'Pemba South': 'Kusini Pemba', 'Unguja North': 'Kaskazini Unguja', 'Unguja South': 'Kusini Unguja' });
export const REGIONS = Object.freeze([
  'Arusha', 'Dar es Salaam', 'Dodoma', 'Geita', 'Iringa', 'Kagera', 'Katavi', 'Kigoma', 'Kilimanjaro', 'Lindi', 'Manyara', 'Mara',
  'Mbeya', 'Morogoro', 'Mtwara', 'Mwanza', 'Njombe', 'Pemba North', 'Pemba South', 'Pwani', 'Rukwa', 'Ruvuma', 'Shinyanga', 'Simiyu',
  'Singida', 'Songwe', 'Tabora', 'Tanga', 'Unguja North', 'Unguja South', 'Mjini Magharibi',
].map(name => Object.freeze({ code: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: Object.freeze({ en: name, sw: REGION_NAMES_SW[name] ?? name }) })));
export const REGION_CODES = Object.freeze(REGIONS.map(r => r.code));

/** Zones an organizer may schedule in (East Africa first; the apps show them from GET /events/options). */
export const TIMEZONES = Object.freeze([
  'Africa/Dar_es_Salaam', 'Africa/Nairobi', 'Africa/Kampala', 'Africa/Kigali', 'Africa/Bujumbura', 'Africa/Addis_Ababa', 'Africa/Lusaka',
  'Africa/Maputo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Cairo', 'Europe/London', 'UTC',
]);
const TZ_ABBREVIATIONS = Object.freeze({
  'Africa/Dar_es_Salaam': 'EAT', 'Africa/Nairobi': 'EAT', 'Africa/Kampala': 'EAT', 'Africa/Addis_Ababa': 'EAT', 'Africa/Mogadishu': 'EAT',
  'Africa/Kigali': 'CAT', 'Africa/Bujumbura': 'CAT', 'Africa/Lusaka': 'CAT', 'Africa/Maputo': 'CAT', 'Africa/Harare': 'CAT', 'Africa/Lubumbashi': 'CAT',
  'Africa/Johannesburg': 'SAST', 'Africa/Lagos': 'WAT', 'Africa/Cairo': 'EET', UTC: 'UTC',
});

// ── Small helpers ───────────────────────────────────────────────────────────

const isStr = v => typeof v === 'string';
const trimmed = v => (isStr(v) ? v.trim() : '');
const filled = v => trimmed(v).length > 0;
const isInt = v => Number.isInteger(v);
const toDate = v => { if (v === null || v === undefined || v === '') return null; const d = new Date(v); return Number.isNaN(+d) ? undefined : d; };
const ms = v => (v ? +new Date(v) : null);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const HTTPS = /^https:\/\/[^\s]+$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const URL_MAX = 2048;
export const NOTE_MAX = 500;

const hostOf = value => { try { return new URL(String(value)).host.toLowerCase() || null; } catch { return null; } };
/**
 * Hosts an event image may be served from (security review #249): EVENTS_IMAGE_HOSTS (comma-separated)
 * or, by default, the hosts of PUBLIC_API_URL and ZEBRA_BASE_URL — where /storage/upload files live.
 * A relative `/storage/<cid>/<file>` path (what /storage/upload returns) is always accepted.
 */
export function imageHostsAllowed(env = process.env) {
  const configured = String(env.EVENTS_IMAGE_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (configured.length) return configured;
  return [env.PUBLIC_API_URL, env.ZEBRA_BASE_URL].map(hostOf).filter(Boolean);
}
const STORAGE_PATH = /^\/storage\/[A-Za-z0-9._-]+\/[^\s/?#]+$/;
/** null when fine, else the §10 code: invalid_url (not https / not an allowed image host) or too_long. */
export function urlProblem(value, { image = false, hosts = imageHostsAllowed() } = {}) {
  const v = String(value);
  if (v.length > URL_MAX) return 'too_long';
  if (image && STORAGE_PATH.test(v)) return null;
  if (!HTTPS.test(v)) return 'invalid_url';
  const host = hostOf(v);
  if (!host) return 'invalid_url';
  if (image && !hosts.includes(host)) return 'invalid_url';
  return null;
}

/** A valid IANA zone name (Intl is the only timezone database the server has). */
export function validTimezone(tz) {
  if (!filled(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** { utcOffsetMinutes, timezoneAbbr } for `timezone` at instant `at` (spec §12; mobile has no tz database). */
export function tzInfo(timezone, at = new Date()) {
  const when = at instanceof Date ? at : new Date(at);
  if (!validTimezone(timezone) || Number.isNaN(+when)) return { utcOffsetMinutes: 0, timezoneAbbr: 'UTC' };
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).formatToParts(when);
  const get = type => parts.find(p => p.type === type)?.value;
  const local = Date.UTC(+get('year'), +get('month') - 1, +get('day'), +get('hour') % 24, +get('minute'), +get('second'));
  const utcOffsetMinutes = Math.round((local - Math.floor(when.getTime() / 1000) * 1000) / 60000);
  return { utcOffsetMinutes, timezoneAbbr: TZ_ABBREVIATIONS[timezone] || get('timeZoneName') || 'UTC' };
}

/** "Dar Half Marathon 2027" → "dar-half-marathon-2027" (the S1 slug CHECK: lower-case kebab, 3–80). */
export function slugify(title) {
  const base = String(title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return base.length >= 3 ? base : `event-${base}`.replace(/-+$/g, '');
}

const bilingual = v => (v && typeof v === 'object' && !Array.isArray(v) ? { en: isStr(v.en) ? v.en : v.en == null ? null : String(v.en), sw: isStr(v.sw) ? v.sw : v.sw == null ? null : String(v.sw) } : null);
/** { en, sw } of strings ≤ NOTE_MAX (anything else coerced to string), or null when empty. Over-long → { error } (L1). */
export function parseNote(value) {
  const v = bilingual(value);
  if (!v || emptyBilingual(v)) return { note: null };
  const fields = ['en', 'sw'].filter(l => filled(v[l]) && v[l].length > NOTE_MAX).map(l => ({ path: `note.${l}`, code: 'too_long', max: NOTE_MAX }));
  return fields.length ? { error: 'event_invalid', status: 422, fields } : { note: { en: filled(v.en) ? v.en.trim() : null, sw: filled(v.sw) ? v.sw.trim() : null } };
}
const emptyBilingual = v => !v || (!filled(v.en) && !filled(v.sw));

/** Distance bucket for a filter chip: 5k | 10k | 21k | 42k | other (spec §14.1). */
export function distanceBucket(distanceM) {
  const m = Number(distanceM);
  if (m >= 4500 && m <= 5500) return '5k';
  if (m >= 9500 && m <= 10500) return '10k';
  if (m >= 20000 && m <= 21500) return '21k';
  if (m >= 41000 && m <= 43000) return '42k';
  return 'other';
}

// ── Wire shape → columns ────────────────────────────────────────────────────

/** Event columns a PATCH may set (the S1 frozen fields and every status/version column are never here). */
const PATCHABLE = {
  title: v => (isStr(v) ? v.trim() : undefined),
  type: v => (isStr(v) ? v : undefined),
  timezone: v => (isStr(v) ? v : undefined),
  startsAt: toDate, endsAt: toDate, registrationOpensAt: toDate, registrationClosesAt: toDate,
  heroImageUrl: v => (v === null || isStr(v) ? v : undefined),
  heroThumbUrl: v => (v === null || isStr(v) ? v : undefined),
  heroImageAlt: v => (v === null || isStr(v) ? v : undefined),
  routeUrl: v => (v === null || isStr(v) ? v : undefined),
  routeImageUrl: v => (v === null || isStr(v) ? v : undefined),
  routeImageAlt: v => (v === null || isStr(v) ? v : undefined),
  kitProvided: v => (typeof v === 'boolean' ? v : undefined),
  // S3 (§3.3, D20): which participant fields are collected and the duplicate rule — material (ORG-007).
  participantFields: parseParticipantFields,
  duplicatePolicy: v => (isStr(v) ? v : undefined),
};
const BILINGUAL_FIELDS = ['description', 'accessibility', 'inclusions', 'terms'];

/**
 * The wire document (§14.3 PATCH body) → { patch (Event columns), nested { categories, collectionPoints } | undefined,
 * changeNote }. Unknown keys and the frozen/status fields are dropped, never forwarded (follow-ups.md S2).
 * `coverAlt` is accepted as an alias of heroImageAlt (§14.2 names both).
 */
export function parseEventPatch(body = {}) {
  const patch = {};
  for (const [key, norm] of Object.entries(PATCHABLE)) {
    if (!(key in body)) continue;
    const v = norm(body[key]);
    if (v !== undefined) patch[key === 'type' ? 'eventType' : key] = v;
  }
  if ('coverAlt' in body && !('heroImageAlt' in body) && (body.coverAlt === null || isStr(body.coverAlt))) patch.heroImageAlt = body.coverAlt;
  for (const key of BILINGUAL_FIELDS) {
    if (!(key in body)) continue;
    const v = body[key] === null ? { en: null, sw: null } : bilingual(body[key]);
    if (!v) continue;
    if (key === 'description') { patch.description = v.en; patch.descriptionSw = v.sw; } else patch[key] = v;
  }
  if ('venue' in body && body.venue && typeof body.venue === 'object') {
    const v = body.venue;
    if ('name' in v) patch.venueName = v.name === null ? null : trimmed(v.name);
    if ('address' in v) patch.venueAddress = v.address === null ? null : trimmed(v.address);
    if ('city' in v) patch.venueCity = v.city === null ? null : trimmed(v.city);
    if ('region' in v) patch.venueRegion = v.region === null ? null : trimmed(v.region);
    if ('lat' in v) patch.lat = num(v.lat);
    if ('lng' in v) patch.lng = num(v.lng);
  }
  if ('contact' in body) {
    const c = body.contact && typeof body.contact === 'object' ? body.contact : {};
    patch.contact = { email: isStr(c.email) ? c.email.trim() : null, phone: isStr(c.phone) ? c.phone.trim() : null, whatsapp: isStr(c.whatsapp) ? c.whatsapp.trim() : null };
  }
  if ('refundPolicy' in body) {
    const r = body.refundPolicy && typeof body.refundPolicy === 'object' ? body.refundPolicy : {};
    patch.refundPolicy = { preset: isStr(r.preset) ? r.preset : null, text: bilingual(r.text) || { en: null, sw: null } };
  }
  if ('schedule' in body) {
    patch.schedule = Array.isArray(body.schedule)
      ? body.schedule.filter(s => s && typeof s === 'object').map(s => ({ at: toDate(s.at)?.toISOString() ?? null, label: bilingual(s.label) || { en: null, sw: null } }))
      : [];
  }
  if ('sponsors' in body) {
    patch.sponsors = Array.isArray(body.sponsors)
      ? body.sponsors.filter(s => s && typeof s === 'object').map(s => ({ name: trimmed(s.name), logoUrl: isStr(s.logoUrl) ? s.logoUrl : null, url: isStr(s.url) ? s.url.trim() : null }))
      : [];
  }
  const nested = {};
  if ('categories' in body) {
    nested.categories = (Array.isArray(body.categories) ? body.categories : []).filter(c => c && typeof c === 'object').map(c => ({
      id: isStr(c.id) ? c.id : null,
      name: trimmed(c.name),
      distanceM: num(c.distanceM),
      startsAt: toDate(c.startsAt),
      capacity: c.capacity === null || c.capacity === undefined || c.capacity === '' ? null : num(c.capacity),
      eligibility: bilingual(c.eligibility) || { en: null, sw: null },
      minAge: c.minAge === null || c.minAge === undefined || c.minAge === '' ? null : num(c.minAge),
      ticketTypes: (Array.isArray(c.ticketTypes) ? c.ticketTypes : []).filter(t => t && typeof t === 'object').map(t => ({
        id: isStr(t.id) ? t.id : null,
        name: trimmed(t.name),
        priceTzs: num(t.priceTzs),
        capacity: t.capacity === null || t.capacity === undefined || t.capacity === '' ? null : num(t.capacity),
        saleOpensAt: toDate(t.saleOpensAt),
        saleClosesAt: toDate(t.saleClosesAt),
        minPerOrder: t.minPerOrder === undefined ? 1 : num(t.minPerOrder),
        maxPerOrder: t.maxPerOrder === undefined ? 10 : num(t.maxPerOrder),
      })),
    }));
  }
  if ('collectionPoints' in body) {
    nested.collectionPoints = (Array.isArray(body.collectionPoints) ? body.collectionPoints : []).filter(p => p && typeof p === 'object').map(p => ({
      id: isStr(p.id) ? p.id : null,
      name: trimmed(p.name),
      address: trimmed(p.address),
      lat: num(p.lat), lng: num(p.lng),
      windows: (Array.isArray(p.windows) ? p.windows : []).filter(w => w && typeof w === 'object').map(w => ({ opensAt: toDate(w.opensAt), closesAt: toDate(w.closesAt) })),
      instructions: bilingual(p.instructions) || { en: null, sw: null },
    }));
  }
  const changeNote = bilingual(body.changeNote);
  return { patch, nested: Object.keys(nested).length ? nested : undefined, changeNote: changeNote && !emptyBilingual(changeNote) ? changeNote : null };
}

// ── Validation (spec §6.2 rules; codes = §10 events.validation.* suffixes) ──

/**
 * `doc` is the document as stored, joined: event columns plus `categories` (each with `ticketTypes`) and
 * `collectionPoints` (store rows: distanceMeters, startTime, openingWindows …).
 * mode 'patch'  — only what is present is checked (shape, ranges, order, formats); a draft may be incomplete.
 * mode 'submit' — the full checklist: required fields, at least one category, one ticket type per category,
 *                 the 24-hour rule, kit points when a kit is handed out.
 */
export function validateEvent(doc, { mode = 'patch', now = new Date(), imageHosts = imageHostsAllowed() } = {}) {
  const full = mode === 'submit';
  const fields = [];
  const add = (path, code, extra) => { fields.push(extra ? { path, code, ...extra } : { path, code }); };
  const url = (path, value, image) => { if (filled(value)) { const p = urlProblem(value.trim(), { image, hosts: imageHosts }); if (p) add(path, p, p === 'too_long' ? { max: URL_MAX } : undefined); } };
  const cap = (path, value, max) => { if (isStr(value) && value.length > max) add(path, 'too_long', { max }); };
  const required = (path, value, test = filled) => { if (full && !test(value)) { add(path, 'required'); return false; } return true; };
  const length = (path, value, min, max) => { if (filled(value) && (value.trim().length < min || value.trim().length > max)) add(path, 'length', { min, max }); };
  const range = (path, value, min, max) => { if (value !== null && value !== undefined && (!Number.isFinite(value) || value < min || value > max)) add(path, 'range', { min, max }); };
  const both = (path, value, max) => {
    if (!value || emptyBilingual(value)) return;
    if (!filled(value.en) || !filled(value.sw)) add(path, 'bothLanguages');
    length(`${path}.en`, value.en, 1, max); length(`${path}.sw`, value.sw, 1, max);
  };
  const virtual = doc.eventType === 'virtual';

  // 1 Basics
  if (required('title', doc.title)) length('title', doc.title, 3, 80);
  // S3: registration settings (optional; defaults apply when absent)
  if (doc.duplicatePolicy !== undefined && doc.duplicatePolicy !== null && !DUPLICATE_POLICIES.includes(doc.duplicatePolicy)) add('duplicatePolicy', 'required');
  if (doc.participantFields !== undefined && doc.participantFields !== null) {
    if (typeof doc.participantFields !== 'object' || Array.isArray(doc.participantFields)) add('participantFields', 'required');
    else for (const [k, v] of Object.entries(doc.participantFields)) if (!PARTICIPANT_FIELD_KEYS.includes(k) || !FIELD_POLICIES.includes(v)) add(`participantFields.${k}`, 'required');
  }
  if (required('type', doc.eventType) && filled(doc.eventType) && !EVENT_TYPES.includes(doc.eventType)) add('type', 'required');
  for (const lang of ['en', 'sw']) {
    const v = lang === 'en' ? doc.description : doc.descriptionSw;
    if (required(`description.${lang}`, v)) length(`description.${lang}`, v, 40, 4000);
  }
  if (required('timezone', doc.timezone) && filled(doc.timezone) && !validTimezone(doc.timezone)) add('timezone', 'required');
  const starts = ms(doc.startsAt); const ends = ms(doc.endsAt);
  const regOpens = ms(doc.registrationOpensAt); const regCloses = ms(doc.registrationClosesAt);
  required('startsAt', doc.startsAt, Boolean);
  required('endsAt', doc.endsAt, Boolean);
  if (full && starts && starts < +now + DAY_MS) add('startsAt', 'startsTooSoon');
  if (starts && ends && ends <= starts) add('endsAt', 'endAfterStart');
  if (starts && ends && ends > starts + 7 * DAY_MS) add('endsAt', 'tooLong');
  required('registrationClosesAt', doc.registrationClosesAt, Boolean);
  if (regOpens && regCloses && regCloses <= regOpens) add('registrationClosesAt', 'endAfterStart');
  if (regCloses && starts && regCloses > starts) add('registrationClosesAt', 'closeBeforeStart');
  if (filled(doc.heroImageUrl)) { if (!filled(doc.heroImageAlt)) add('heroImageAlt', 'altRequired'); else length('heroImageAlt', doc.heroImageAlt, 1, 120); }
  url('heroImageUrl', doc.heroImageUrl, true); url('heroThumbUrl', doc.heroThumbUrl, true);

  // 2 Venue & route
  if (!virtual) {
    required('venue.name', doc.venueName);
    required('venue.address', doc.venueAddress);
    if (required('venue.region', doc.venueRegion) && filled(doc.venueRegion) && !REGION_CODES.includes(doc.venueRegion)) add('venue.region', 'required');
    if (full && (doc.lat === null || doc.lat === undefined || doc.lng === null || doc.lng === undefined)) add('venue.lat', 'pinRequired');
  } else if (filled(doc.venueRegion) && !REGION_CODES.includes(doc.venueRegion)) add('venue.region', 'required');
  length('venue.name', doc.venueName, 1, 120);
  length('venue.address', doc.venueAddress, 1, 200);
  cap('venue.city', doc.venueCity, 80);
  range('venue.lat', num(doc.lat), -90, 90); range('venue.lng', num(doc.lng), -180, 180);
  if (filled(doc.routeUrl) && !HTTPS.test(doc.routeUrl.trim())) add('routeUrl', 'httpsOnly'); else url('routeUrl', doc.routeUrl, false);
  if (filled(doc.routeImageUrl)) { if (!filled(doc.routeImageAlt)) add('routeImageAlt', 'altRequired'); else length('routeImageAlt', doc.routeImageAlt, 1, 120); }
  url('routeImageUrl', doc.routeImageUrl, true);
  both('accessibility', doc.accessibility, 1000);

  // 3 Categories, 4 Ticket types
  const categories = Array.isArray(doc.categories) ? doc.categories : [];
  if (full && !categories.length) add('categories', 'minCategory');
  if (categories.length > 12) add('categories', 'range', { min: 1, max: 12 });
  const names = new Set();
  categories.forEach((c, i) => {
    const p = `categories[${i}]`;
    if (required(`${p}.name`, c.name)) length(`${p}.name`, c.name, 1, 60);
    if (filled(c.name)) { const k = c.name.trim().toLowerCase(); if (names.has(k)) add(`${p}.name`, 'unique'); names.add(k); }
    const distance = c.distanceMeters ?? c.distanceM;
    if (required(`${p}.distanceM`, distance, v => Number.isFinite(Number(v)) && Number(v) > 0)) range(`${p}.distanceM`, num(distance), 500, 250000);
    const cs = ms(c.startTime ?? c.startsAt);
    if (cs && starts && ends && (cs < starts || cs > ends)) add(`${p}.startsAt`, 'withinEvent');
    range(`${p}.capacity`, num(c.capacity), 1, 100000);
    both(`${p}.eligibility`, c.eligibility, 500);
    range(`${p}.minAge`, num(c.minAge), 5, 99);
    const tickets = Array.isArray(c.ticketTypes) ? c.ticketTypes : [];
    if (full && !tickets.length) add(`${p}.ticketTypes`, 'minTicket');
    if (tickets.length > 6) add(`${p}.ticketTypes`, 'range', { min: 1, max: 6 });
    const tnames = new Set();
    tickets.forEach((t, j) => {
      const q = `${p}.ticketTypes[${j}]`;
      if (required(`${q}.name`, t.name)) length(`${q}.name`, t.name, 1, 40);
      if (filled(t.name)) { const k = t.name.trim().toLowerCase(); if (tnames.has(k)) add(`${q}.name`, 'unique'); tnames.add(k); }
      if (t.priceTzs === null || t.priceTzs === undefined) { if (full) add(`${q}.priceTzs`, 'required'); } else if (!isInt(t.priceTzs) || t.priceTzs < 0) add(`${q}.priceTzs`, 'wholeShillings');
      range(`${q}.capacity`, num(t.capacity), 1, 100000);
      const so = ms(t.saleOpensAt); const sc = ms(t.saleClosesAt);
      if (so && sc && sc <= so) add(`${q}.saleClosesAt`, 'endAfterStart');
      if ((so && regOpens && so < regOpens) || (so && regCloses && so > regCloses)) add(`${q}.saleOpensAt`, 'withinRegistration');
      if ((sc && regCloses && sc > regCloses) || (sc && regOpens && sc < regOpens)) add(`${q}.saleClosesAt`, 'withinRegistration');
      range(`${q}.minPerOrder`, num(t.minPerOrder), 1, 50);
      range(`${q}.maxPerOrder`, num(t.maxPerOrder), 1, 50);
      if (isInt(t.minPerOrder) && isInt(t.maxPerOrder) && t.maxPerOrder < t.minPerOrder) add(`${q}.maxPerOrder`, 'maxGteMin');
    });
  });

  // 5 Kit & collection points
  const points = Array.isArray(doc.collectionPoints) ? doc.collectionPoints : [];
  if (full && doc.kitProvided === true && !points.length) add('collectionPoints', 'required');
  if (points.length > 10) add('collectionPoints', 'range', { min: 0, max: 10 });
  points.forEach((pt, i) => {
    const p = `collectionPoints[${i}]`;
    if (required(`${p}.name`, pt.name)) length(`${p}.name`, pt.name, 1, 60);
    if (required(`${p}.address`, pt.address)) length(`${p}.address`, pt.address, 1, 200);
    const windows = Array.isArray(pt.openingWindows ?? pt.windows) ? (pt.openingWindows ?? pt.windows) : [];
    if (full && !windows.length) add(`${p}.windows`, 'required');
    if (windows.length > 5) add(`${p}.windows`, 'range', { min: 1, max: 5 });
    windows.forEach((w, j) => {
      const o = ms(w.opensAt); const c = ms(w.closesAt);
      if (full && (!o || !c)) add(`${p}.windows[${j}]`, 'required');
      if (o && c && c <= o) add(`${p}.windows[${j}].closesAt`, 'endAfterStart');
      if (o && starts && o >= starts) add(`${p}.windows[${j}].opensAt`, 'beforeEvent');
    });
    for (const lang of ['en', 'sw']) if (required(`${p}.instructions.${lang}`, pt.instructions?.[lang])) length(`${p}.instructions.${lang}`, pt.instructions?.[lang], 1, 600);
  });
  both('inclusions', doc.inclusions, 600);

  // 6 Terms & refund policy, contacts, sponsors, schedule
  for (const lang of ['en', 'sw']) if (required(`terms.${lang}`, doc.terms?.[lang])) length(`terms.${lang}`, doc.terms?.[lang], 100, 20000);
  const preset = doc.refundPolicy?.preset;
  if (required('refundPolicy.preset', preset) && filled(preset) && !REFUND_PRESETS.includes(preset)) add('refundPolicy.preset', 'required');
  if (preset === 'custom') {
    for (const lang of ['en', 'sw']) if (required(`refundPolicy.text.${lang}`, doc.refundPolicy?.text?.[lang])) length(`refundPolicy.text.${lang}`, doc.refundPolicy?.text?.[lang], 50, 5000);
  } else {
    for (const lang of ['en', 'sw']) cap(`refundPolicy.text.${lang}`, doc.refundPolicy?.text?.[lang], 5000);
  }
  const contact = doc.contact || {};
  cap('contact.email', contact.email, 254);
  if (required('contact.email', contact.email) && filled(contact.email) && !EMAIL.test(contact.email.trim())) add('contact.email', 'email');
  if (filled(contact.phone) && !normalizePhone(contact.phone)) add('contact.phone', 'phone');
  if (filled(contact.whatsapp) && !normalizePhone(contact.whatsapp)) add('contact.whatsapp', 'phone');
  const sponsors = Array.isArray(doc.sponsors) ? doc.sponsors : [];
  if (sponsors.length > 10) add('sponsors', 'range', { min: 0, max: 10 });
  sponsors.forEach((s, i) => {
    if (!filled(s.name)) add(`sponsors[${i}].name`, 'required'); else length(`sponsors[${i}].name`, s.name, 1, 60);
    if (filled(s.url) && !HTTPS.test(s.url.trim())) add(`sponsors[${i}].url`, 'httpsOnly'); else url(`sponsors[${i}].url`, s.url, false);
    url(`sponsors[${i}].logoUrl`, s.logoUrl, true);
  });
  const schedule = Array.isArray(doc.schedule) ? doc.schedule : [];
  if (schedule.length > 20) add('schedule', 'range', { min: 0, max: 20 });
  schedule.forEach((s, i) => {
    const at = ms(s.at);
    if (!at) add(`schedule[${i}].at`, 'required');
    else if (starts && ends && (at < starts || at > ends)) add(`schedule[${i}].at`, 'withinEvent');
    if (!filled(s.label?.en) || !filled(s.label?.sw)) add(`schedule[${i}].label`, 'bothLanguages');
    length(`schedule[${i}].label.en`, s.label?.en, 1, 80); length(`schedule[${i}].label.sw`, s.label?.sw, 1, 80);
  });
  return fields;
}

// ── Change detection (§7.4) ─────────────────────────────────────────────────

const MATERIAL_EVENT_FIELDS = ['startsAt', 'endsAt', 'timezone', 'venue.name', 'venue.address', 'venue.lat', 'venue.lng', 'routeUrl', 'routeImageUrl', 'registrationClosesAt', 'refundPolicy', 'participantFields', 'duplicatePolicy'];
const MATERIAL_CATEGORY_FIELDS = ['distanceM', 'startsAt'];
const MATERIAL_TICKET_FIELDS = ['priceTzs'];

/**
 * Flatten a wire document (organizerView shape) to comparable leaves. Nested rows are keyed by id so a
 * reorder is not a change; new rows (no id yet) are keyed by name.
 */
export function flattenDocument(doc = {}) {
  const out = {};
  const scalar = v => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);
  for (const k of ['title', 'type', 'timezone', 'startsAt', 'endsAt', 'registrationOpensAt', 'registrationClosesAt', 'heroImageUrl', 'heroThumbUrl', 'heroImageAlt', 'routeUrl', 'routeImageUrl', 'routeImageAlt', 'kitProvided']) out[k] = scalar(doc[k]);
  for (const k of ['description', 'accessibility', 'inclusions', 'terms']) { out[`${k}.en`] = doc[k]?.en ?? null; out[`${k}.sw`] = doc[k]?.sw ?? null; }
  for (const k of ['name', 'address', 'city', 'region', 'lat', 'lng']) out[`venue.${k}`] = scalar(doc.venue?.[k] ?? null);
  for (const k of ['email', 'phone', 'whatsapp']) out[`contact.${k}`] = doc.contact?.[k] ?? null;
  out.refundPolicy = JSON.stringify(doc.refundPolicy ?? null);
  out.participantFields = JSON.stringify(doc.participantFields ?? null);
  out.duplicatePolicy = doc.duplicatePolicy ?? null;
  out.schedule = JSON.stringify(doc.schedule ?? []);
  out.sponsors = JSON.stringify(doc.sponsors ?? []);
  for (const c of doc.categories || []) {
    const ck = `categories[${c.id || `new:${c.name}`}]`;
    for (const k of ['name', 'distanceM', 'startsAt', 'capacity', 'minAge']) out[`${ck}.${k}`] = scalar(c[k] ?? null);
    out[`${ck}.eligibility.en`] = c.eligibility?.en ?? null; out[`${ck}.eligibility.sw`] = c.eligibility?.sw ?? null;
    for (const t of c.ticketTypes || []) {
      const tk = `${ck}.ticketTypes[${t.id || `new:${t.name}`}]`;
      for (const k of ['name', 'priceTzs', 'capacity', 'saleOpensAt', 'saleClosesAt', 'minPerOrder', 'maxPerOrder']) out[`${tk}.${k}`] = scalar(t[k] ?? null);
    }
  }
  for (const p of doc.collectionPoints || []) {
    const pk = `collectionPoints[${p.id || `new:${p.name}`}]`;
    for (const k of ['name', 'address', 'lat', 'lng']) out[`${pk}.${k}`] = scalar(p[k] ?? null);
    out[`${pk}.windows`] = JSON.stringify(p.windows ?? []);
    out[`${pk}.instructions.en`] = p.instructions?.en ?? null; out[`${pk}.instructions.sw`] = p.instructions?.sw ?? null;
  }
  return out;
}

const same = (a, b) => (a === b) || (a == null && b == null) || (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && String(a) !== '' && String(b) !== '' && Number(a) === Number(b));

/** Every flattened path whose value differs between two wire documents. */
export function changedPaths(before, after) {
  const a = flattenDocument(before); const b = flattenDocument(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !same(a[k], b[k])).sort();
}

/** Spec §7.4: a path is material when participants' plans depend on it. */
export function isMaterialPath(path) {
  if (MATERIAL_EVENT_FIELDS.includes(path)) return true;
  const cat = path.match(/^categories\[[^\]]+\]\.(\w+)$/);
  if (cat) return MATERIAL_CATEGORY_FIELDS.includes(cat[1]);
  const tt = path.match(/^categories\[[^\]]+\]\.ticketTypes\[[^\]]+\]\.(\w+)$/);
  if (tt) return MATERIAL_TICKET_FIELDS.includes(tt[1]);
  return false;
}

/** The changed paths that are material (§7.4), for the change-note rule and the change log. */
export const materialChanges = (before, after) => changedPaths(before, after).filter(isMaterialPath);

/** before/after values of the given paths (for EventChangeLog). */
export function diffOf(before, after, paths) {
  const a = flattenDocument(before); const b = flattenDocument(after);
  const pick = (src) => Object.fromEntries(paths.map(p => [p, src[p] ?? null]));
  return { before: pick(a), after: pick(b) };
}

// ── Availability (§11.3, §16.1) ─────────────────────────────────────────────

const exhausted = t => (t.sold ?? 0) + (t.held ?? 0) >= (t.capacity ?? 0);
const saleNotOpen = (t, at) => Boolean(t.saleOpensAt) && +new Date(t.saleOpensAt) > at;
const saleOver = (t, at) => Boolean(t.saleClosesAt) && +new Date(t.saleClosesAt) <= at;

/** One ticket type's own availability inside an event that is open for registration. */
export function ticketAvailability(t, { now = new Date(), closingSoonHours = DEFAULT_CLOSING_SOON_HOURS, registrationClosesAt = null } = {}) {
  const at = +now;
  if (t.status === 'inactive') return 'closed';
  if (saleNotOpen(t, at)) return 'not_yet_open';
  if (saleOver(t, at)) return 'closed';
  if (exhausted(t)) return 'sold_out';
  const closes = t.saleClosesAt ? +new Date(t.saleClosesAt) : registrationClosesAt ? +new Date(registrationClosesAt) : null;
  if (closes && closes - at <= closingSoonHours * HOUR_MS) return 'closing_soon';
  return 'open';
}

/**
 * The event's availability from its status, registration window and every active ticket type:
 * sold_out when every ticket type is exhausted or past its sale window (§16.1). `ticketTypes` are the
 * rows of all its categories.
 */
export function availabilityOf(event, ticketTypes = [], { now = new Date(), closingSoonHours = DEFAULT_CLOSING_SOON_HOURS } = {}) {
  const at = +now;
  switch (event.status) {
    case 'cancelled': return 'cancelled';
    case 'in_progress': return 'in_progress';
    case 'completed': case 'archived': return 'completed';
    case 'registration_closed': return 'closed';
    case 'published': break;
    default: return 'closed';
  }
  if (event.registrationOpensAt && +new Date(event.registrationOpensAt) > at) return 'not_yet_open';
  if (event.registrationClosesAt && +new Date(event.registrationClosesAt) <= at) return 'closed';
  const live = ticketTypes.filter(t => t.status !== 'inactive');
  if (live.length && live.every(t => exhausted(t) || saleOver(t, at))) return 'sold_out';
  if (event.registrationClosesAt && +new Date(event.registrationClosesAt) - at <= closingSoonHours * HOUR_MS) return 'closing_soon';
  return 'open';
}

/** A category's availability: the best of its ticket types (open beats closing_soon beats the rest). */
export function categoryAvailability(eventAvailability, ticketTypes, opts) {
  if (!['open', 'closing_soon'].includes(eventAvailability)) return eventAvailability;
  const states = ticketTypes.filter(t => t.status !== 'inactive').map(t => ticketAvailability(t, opts));
  if (!states.length) return 'closed';
  for (const s of ['open', 'closing_soon', 'not_yet_open', 'sold_out']) if (states.includes(s)) return s === 'open' && eventAvailability === 'closing_soon' ? 'closing_soon' : s;
  return 'closed';
}

// ── Allowed actions (§7.2) ──────────────────────────────────────────────────

/**
 * What `actor` ('organizer' | 'admin') may do with an event in `status`. Organizer actions need an active
 * organizer and an owner/admin role (ops/finance/timing and a suspended organizer see nothing).
 */
export function allowedActionsFor({ status, actor, role = null, organizerStatus = 'active' }) {
  if (actor === 'admin') {
    // No admin edit route exists (security review #249): the vocabulary says only what is possible.
    switch (status) {
      case 'submitted': return ['approve', 'reject'];
      case 'published': case 'registration_closed': return ['cancel'];
      case 'in_progress': return ['complete', 'cancel'];
      case 'completed': case 'cancelled': return ['archive'];
      default: return [];
    }
  }
  if (organizerStatus !== 'active' || !['owner', 'admin'].includes(role)) return [];
  switch (status) {
    case 'draft': return ['edit', 'submit', 'delete'];
    case 'submitted': return ['withdraw'];
    case 'published': case 'registration_closed': return ['edit', 'cancel'];
    case 'in_progress': return ['complete', 'cancel'];
    case 'completed': case 'cancelled': return ['archive'];
    default: return [];
  }
}

// ── Views (§14) ─────────────────────────────────────────────────────────────

const iso = v => (v ? new Date(v).toISOString() : null);
const capacityOut = c => (c === null || c === undefined || Number(c) >= UNLIMITED_CAPACITY ? null : Number(c));
const numOrNull = v => (v === null || v === undefined ? null : Number(v));

/** The ticket types of all categories (rows), for availability and prices. */
const allTickets = categories => categories.flatMap(c => c.ticketTypes || []);

function fromPriceOf(categories) {
  const prices = allTickets(categories).filter(t => t.status !== 'inactive').map(t => Number(t.priceTzs)).filter(Number.isFinite);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * EventSummary (§14.1). `joined` = { event, categories: [{ ...row, ticketTypes: [rows] }], organizer }.
 * `isSaved` is added only when `saved` is a boolean (an authenticated caller).
 */
export function summaryView(joined, { now = new Date(), closingSoonHours = DEFAULT_CLOSING_SOON_HOURS, saved = null } = {}) {
  const { event: e, categories = [], organizer } = joined;
  const tz = tzInfo(e.timezone, e.startsAt);
  const live = categories.filter(c => c.status !== 'inactive');
  return {
    id: e.id, slug: e.slug, title: e.title, type: e.eventType, status: e.status,
    startsAt: iso(e.startsAt), endsAt: iso(e.endsAt), timezone: e.timezone, utcOffsetMinutes: tz.utcOffsetMinutes, timezoneAbbr: tz.timezoneAbbr,
    registrationOpensAt: iso(e.registrationOpensAt), registrationClosesAt: iso(e.registrationClosesAt),
    availability: availabilityOf(e, allTickets(live), { now, closingSoonHours }),
    venue: { name: e.venueName ?? null, city: e.venueCity ?? null, region: e.venueRegion ?? null },
    heroThumbUrl: e.heroThumbUrl ?? e.heroImageUrl ?? null, heroImageAlt: e.heroImageAlt ?? null,
    distancesM: [...new Set(live.map(c => Number(c.distanceMeters)))].sort((a, b) => a - b),
    fromPriceTzs: fromPriceOf(live), currency: 'TZS',
    organizer: organizer ? { id: organizer.id, name: organizer.name, verified: organizer.status === 'active' } : null,
    ...(typeof saved === 'boolean' ? { isSaved: saved } : {}),
    updatedAt: iso(e.updatedAt),
  };
}

function ticketView(t, opts) {
  return {
    id: t.id, name: t.name, priceTzs: Number(t.priceTzs), currency: t.currency || 'TZS', capacity: capacityOut(t.capacity),
    saleOpensAt: iso(t.saleOpensAt), saleClosesAt: iso(t.saleClosesAt), minPerOrder: t.minPerOrder, maxPerOrder: t.maxPerOrder,
    availability: ticketAvailability(t, opts), status: t.status,
  };
}

function categoryView(c, eventAvailability, opts) {
  const tickets = (c.ticketTypes || []).filter(t => t.status !== 'inactive');
  const capacity = capacityOut(c.capacity);
  const sold = tickets.reduce((n, t) => n + (t.sold ?? 0) + (t.held ?? 0), 0);
  const remaining = capacity === null ? null : Math.max(capacity - sold, 0);
  return {
    id: c.id, name: c.name, distanceM: Number(c.distanceMeters), startsAt: iso(c.startTime), capacity,
    availability: categoryAvailability(eventAvailability, tickets, opts),
    remaining: remaining !== null && remaining <= 10 ? remaining : null,
    eligibility: { en: c.eligibility?.en ?? null, sw: c.eligibility?.sw ?? null }, minAge: c.minAge ?? null,
    ticketTypes: tickets.map(t => ticketView(t, opts)),
  };
}

const pointView = p => ({
  id: p.id, name: p.name, address: p.address ?? null, lat: numOrNull(p.lat), lng: numOrNull(p.lng),
  windows: (p.openingWindows || []).map(w => ({ opensAt: iso(w.opensAt), closesAt: iso(w.closesAt) })),
  instructions: { en: p.instructions?.en ?? null, sw: p.instructions?.sw ?? null },
});

/** EventDetail (§14.2): summary + the full public document. `shareUrl` is built by the caller. */
export function detailView(joined, { now = new Date(), closingSoonHours = DEFAULT_CLOSING_SOON_HOURS, saved = null, shareUrl = null } = {}) {
  const { event: e, categories = [], collectionPoints = [] } = joined;
  const summary = summaryView(joined, { now, closingSoonHours, saved });
  const opts = { now, closingSoonHours, registrationClosesAt: e.registrationClosesAt };
  return {
    ...summary,
    description: { en: e.description ?? null, sw: e.descriptionSw ?? null },
    heroImageUrl: e.heroImageUrl ?? null, coverAlt: e.heroImageAlt ?? null,
    routeUrl: e.routeUrl ?? null, routeImageUrl: e.routeImageUrl ?? null, routeImageAlt: e.routeImageAlt ?? null,
    venue: { ...summary.venue, address: e.venueAddress ?? null, lat: numOrNull(e.lat), lng: numOrNull(e.lng) },
    accessibility: { en: e.accessibility?.en ?? null, sw: e.accessibility?.sw ?? null },
    inclusions: { en: e.inclusions?.en ?? null, sw: e.inclusions?.sw ?? null },
    kitProvided: e.kitProvided === true,
    // S3 (§8.2): the effective participant field policy, so the registration form and the quote agree.
    participantFields: effectiveFields(e, categories),
    duplicatePolicy: DUPLICATE_POLICIES.includes(e.duplicatePolicy) ? e.duplicatePolicy : 'one_per_category',
    categories: categories.filter(c => c.status !== 'inactive').map(c => categoryView(c, summary.availability, opts)),
    collectionPoints: collectionPoints.filter(p => p.status !== 'inactive').map(pointView),
    schedule: (e.schedule || []).map(s => ({ at: iso(s.at), label: { en: s.label?.en ?? null, sw: s.label?.sw ?? null } })),
    sponsors: (e.sponsors || []).map(s => ({ name: s.name, logoUrl: s.logoUrl ?? null, url: s.url ?? null })),
    contact: { email: e.contact?.email ?? null, phone: e.contact?.phone ?? null, whatsapp: e.contact?.whatsapp ?? null },
    // Participants see the frozen texts once there are any; before submission the working copy is all there is.
    terms: { en: e.termsSnapshot?.en ?? e.terms?.en ?? null, sw: e.termsSnapshot?.sw ?? e.terms?.sw ?? null },
    refundPolicy: {
      preset: e.refundPolicySnapshot?.preset ?? e.refundPolicy?.preset ?? null,
      text: { en: e.refundPolicySnapshot?.text?.en ?? e.refundPolicy?.text?.en ?? null, sw: e.refundPolicySnapshot?.text?.sw ?? e.refundPolicy?.text?.sw ?? null },
    },
    cancellation: e.cancellation ? { reason: e.cancellation.reason ?? null, note: { en: e.cancellation.note?.en ?? null, sw: e.cancellation.note?.sw ?? null } } : null,
    shareUrl, publishedAt: iso(e.publishedAt), updatedAt: iso(e.updatedAt), version: e.version,
  };
}

/**
 * The organizer's editable document (§14.3 GET /organizer/events/:id): the detail (working texts, not
 * the snapshots; inactive rows left out) plus status fields. The admin document is the same + organizer.
 */
export function organizerView(joined, { now, closingSoonHours, allowedActions = [], changeLogCount = 0 } = {}) {
  const { event: e } = joined;
  const view = detailView(joined, { now, closingSoonHours });
  return {
    ...view,
    terms: { en: e.terms?.en ?? null, sw: e.terms?.sw ?? null },
    refundPolicy: { preset: e.refundPolicy?.preset ?? null, text: { en: e.refundPolicy?.text?.en ?? null, sw: e.refundPolicy?.text?.sw ?? null } },
    heroImageAlt: e.heroImageAlt ?? null,
    participantFields: e.participantFields && typeof e.participantFields === 'object' ? { ...e.participantFields } : {},
    effectiveParticipantFields: view.participantFields,
    status: e.status, version: e.version, allowedActions,
    submittedAt: iso(e.submittedAt),
    rejection: e.rejection ? { reason: e.rejection.reason ?? null, note: e.rejection.note ?? null, at: iso(e.rejection.at) } : null,
    changeLogCount,
  };
}

/** A row of the organizer / admin lists (§14.3): summary fields + status, counts and actions. */
export function rowView(joined, { now, closingSoonHours, allowedActions = [] } = {}) {
  const s = summaryView(joined, { now, closingSoonHours });
  const live = (joined.categories || []).filter(c => c.status !== 'inactive');
  return { ...s, categoriesCount: live.length, allowedActions, submittedAt: iso(joined.event.submittedAt), publishedAt: iso(joined.event.publishedAt) };
}
