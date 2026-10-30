// Marathon & running events · S6 — pure result rules (spec §3, §5.5, §6): times, stages, ranks, visibility, board names,
// settings validation, CSV columns. No database, no clock (callers pass `now`), nothing here sends or stores anything.
import { createHash } from 'node:crypto';
import { ageOnEventDay, lastInitial } from './events-participants.mjs';

export const SOURCE_TYPES = Object.freeze(['timing_provider', 'organizer_verified', 'fitflex_gps', 'manual_unverified']);
export const IMPORT_SOURCES = Object.freeze(['timing_provider', 'organizer_verified']);
export const FINISH_STATUSES = Object.freeze(['finished', 'dnf', 'dns', 'dq']);
export const SETTLED_VERIFICATIONS = Object.freeze(['verified', 'corrected']);
/** Closed reason lists (spec §6.3, §6.6); the union is the EventResult.reasonCode CHECK (migration 20270131090000). */
export const REJECT_REASONS = Object.freeze(['not_a_valid_run', 'data_error', 'duplicate', 'other']);
export const CORRECT_REASONS = Object.freeze(['timing_error', 'wrong_bib', 'late_finish_data', 'other']);
export const DQ_REASONS = Object.freeze(['rule_violation', 'course_cut', 'wrong_category', 'equipment', 'identity', 'virtual_evidence', 'other']);
export const SYSTEM_REASONS = Object.freeze(['replaced_by_participant']);
export const ALL_REASONS = Object.freeze([...new Set([...REJECT_REASONS, ...CORRECT_REASONS, ...DQ_REASONS, ...SYSTEM_REASONS])]);
export const DISPUTE_REASONS = Object.freeze(['time_wrong', 'not_my_result', 'wrong_category', 'missing_split', 'dq_challenge', 'other']);
export const VISIBILITIES = Object.freeze(['standard', 'bib_only', 'hidden']);
export const BUILT_IN_ART = Object.freeze(['finisher_green', 'finisher_gold', 'podium_gold', 'podium_silver', 'podium_bronze', 'time_blue', 'charity_red', 'virtual_teal']);
export const MEDAL_TIERS = Object.freeze(['finisher', 'gold', 'silver', 'bronze', 'time', 'other']);
export const sha256hex = v => createHash('sha256').update(String(v)).digest('hex');

const DAY = 86_400_000;

// ── Times ────────────────────────────────────────────────────────────────

/** "1:52:08", "01:52:08.250", "52:08" → milliseconds, or { error: 'time_invalid' | 'time_out_of_range' }. Zero and 24 h or more are out of range. */
export function parseTime(raw) {
  if (raw === null || raw === undefined) return { error: 'time_invalid' };
  const s = String(raw).trim();
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return { error: 'time_invalid' };
  const h = m[1] === undefined ? 0 : Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (sec > 59 || (m[1] !== undefined && min > 59)) return { error: 'time_invalid' };
  const ms = m[4] === undefined ? 0 : Number(m[4].padEnd(3, '0'));
  const total = (((h * 60) + min) * 60 + sec) * 1000 + ms;
  if (total <= 0 || total >= DAY) return { error: 'time_out_of_range' };
  return { ms: total };
}

/** "H:MM:SS" for a time (no milliseconds). */
export function formatTime(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  const total = Math.floor(Number(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Which of net / gun is the ranking time for a category (`basis`), falling back to the other when the chosen one is absent. */
export function rankingTime({ netMs = null, gunMs = null }, basis = 'net') {
  const first = basis === 'gun' ? gunMs : netMs;
  const second = basis === 'gun' ? netMs : gunMs;
  return first ?? second ?? null;
}

// ── Stages (spec §3.1) ───────────────────────────────────────────────────

/**
 * The presentation state of a registration's result, derived on the server only.
 * `row`: the current EventResult (or null); `release`: 'none' | 'provisional' | 'official' for the registration's category;
 * `disputeOpen`: an open dispute exists for it. → 'none' | 'provisional' | 'official' | 'corrected' | 'disputed' | 'disqualified' | 'rejected'.
 */
export function deriveStage({ row, release = 'none', disputeOpen = false }) {
  if (!row) return 'none';
  const v = row.verificationStatus;
  let stage;
  if (v === 'rejected') stage = 'rejected';
  else if (release === 'none') stage = 'none';
  else if (v === 'disqualified' || row.finishStatus === 'dq') stage = v === 'pending_verification' ? 'provisional' : 'disqualified';
  else if (v === 'corrected') stage = 'corrected';
  else if (release === 'provisional') stage = 'provisional';
  else stage = v === 'verified' ? 'official' : 'none'; // official release: a pending row is an "unsettled" row left out
  if (disputeOpen && stage !== 'none' && stage !== 'rejected') return 'disputed';
  return stage;
}

/** The registration.resultStatus a result row stands for (EventRegistration view, spec §1). */
export function registrationStatusOf(row) {
  if (!row) return 'not_submitted';
  const v = row.verificationStatus;
  if (v === 'pending_verification') return 'pending_verification';
  if (v === 'rejected') return 'rejected';
  if (v === 'disqualified') return 'disqualified';
  if (v === 'corrected') return 'corrected';
  if (row.finishStatus === 'dnf') return 'dnf';
  if (row.finishStatus === 'dns') return 'dns';
  return 'verified';
}

/**
 * The stage of one scope from its release rows (oldest first). Official is permanent (it cannot be withdrawn);
 * otherwise the last row decides: a provisional release stands until a withdraw row follows it.
 */
export function scopeStage(rows) {
  if (rows.some(r => r.stage === 'official' && r.action === 'release')) return 'official';
  const last = rows[rows.length - 1];
  return last && last.action === 'release' && last.stage === 'provisional' ? 'provisional' : 'none';
}

/** The release of a category: its own rows decide; with none of its own, the whole-event rows (categoryId null) apply. Official anywhere in scope wins. */
export function categoryStage(releaseRows, categoryId) {
  const own = releaseRows.filter(r => r.categoryId === categoryId);
  const wide = releaseRows.filter(r => r.categoryId === null || r.categoryId === undefined);
  if (scopeStage(own) === 'official' || scopeStage(wide) === 'official') return 'official';
  if (own.length) return scopeStage(own);
  return scopeStage(wide);
}

// ── Ranks (spec §6.5, D52) ───────────────────────────────────────────────

/** Competition ranking with shared ties: [10,12,12,15] → [1,2,2,4]. Input must be sorted ascending. */
export function competitionRanks(sortedTimes) {
  const out = [];
  sortedTimes.forEach((t, i) => { out.push(i > 0 && t === sortedTimes[i - 1] ? out[i - 1] : i + 1); });
  return out;
}

/**
 * Ranks for a list of current rows: { id, categoryId, distanceMeters (category), verificationStatus, finishStatus, elapsedMs, withinCutoff }.
 * Only finished, verified|corrected, non-DQ results within the cut-off are ranked. Overall = across categories of the same
 * distance, category = within the category. `official` is the Set of category ids that have an official release (others get null).
 * → Map id → { overallRank, categoryRank }.
 */
export function computeRanks(rows, official) {
  const out = new Map(rows.map(r => [r.id, { overallRank: null, categoryRank: null }]));
  const eligible = rows.filter(r => official.has(r.categoryId) && r.finishStatus === 'finished' && SETTLED_VERIFICATIONS.includes(r.verificationStatus)
    && r.withinCutoff !== false && r.elapsedMs !== null && r.elapsedMs !== undefined);
  const rankBy = (keyOf, field) => {
    const groups = new Map();
    for (const r of eligible) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    for (const g of groups.values()) {
      g.sort((a, b) => Number(a.elapsedMs) - Number(b.elapsedMs) || String(a.id).localeCompare(String(b.id)));
      const ranks = competitionRanks(g.map(r => Number(r.elapsedMs)));
      g.forEach((r, i) => { out.get(r.id)[field] = ranks[i]; });
    }
  };
  rankBy(r => `d:${r.distanceMeters}`, 'overallRank');
  rankBy(r => `c:${r.categoryId}`, 'categoryRank');
  return out;
}

// ── Visibility and names (spec §5.5, D48) ────────────────────────────────

/** Whole years on the event's start day, or null when the date of birth is unknown. */
export const dobString = v => {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(+v) ? null : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`; // pg builds a DATE at local midnight
  return String(v).slice(0, 10);
};
export const ageOf = (reg, event) => { const d = dobString(reg?.dateOfBirth); return d ? ageOnEventDay(d, event.startsAt, event.timezone) : null; };

/** True for someone under 18 on the event start day. */
export const isMinor = (reg, event) => { const a = ageOf(reg, event); return a !== null && a < 18; };

/** An unknown date of birth in a category that allows under-18s is treated as a minor for the board. */
export function boardTreatedAsMinor(reg, event, category) {
  const a = ageOf(reg, event);
  if (a !== null) return a < 18;
  return Number.isInteger(category?.minAge) && category.minAge < 18;
}

/**
 * The visibility that applies to a registration now.
 * `clauseVersions`: the consent versions whose text carries the public-results clause (EVENTS_RESULTS_CONSENT_VERSIONS).
 * → { current: 'standard'|'bib_only'|'hidden', canChange, allowed[], reason: 'minor'|'ask'|null }
 */
export function visibilityOf(reg, event, category, clauseVersions = []) {
  if (boardTreatedAsMinor(reg, event, category)) {
    return { current: reg.resultsVisibility === 'hidden' && reg.resultsVisibilitySetAt ? 'hidden' : 'bib_only', canChange: false, allowed: ['bib_only', 'hidden'], reason: 'minor' };
  }
  const chosen = Boolean(reg.resultsVisibilitySetAt);
  if (chosen) return { current: reg.resultsVisibility, canChange: true, allowed: [...VISIBILITIES], reason: null };
  // Default visibility (M2): the full name only when the participant THEMSELF registered / claimed with a consent text that carries the clause
  // (consentBasis self); a place bought by someone else, or by an organisation, starts bib-only until the participant chooses.
  const carries = clauseVersions.includes(reg.consentTextVersion) && reg.consentBasis === 'self' && Boolean(reg.participantUserId);
  return { current: carries ? 'standard' : 'bib_only', canChange: true, allowed: [...VISIBILITIES], reason: carries ? null : 'ask' };
}

/** What a board shows for a name, per visibility and the organizer's publicNames policy. null = the row is omitted. */
export const ANONYMOUS = Symbol('anonymous');
export function boardName({ firstName, lastName }, visibility, publicNames = 'initial') {
  if (visibility === 'hidden') return null;
  if (visibility === 'bib_only' || publicNames === 'bib_only') return ANONYMOUS;
  const first = String(firstName ?? '').trim();
  if (!first) return ANONYMOUS;
  const initial = lastInitial(lastName);
  return initial ? `${first} ${initial}` : first;
}

// ── Settings (spec §4.1.7, §4.1.8) ───────────────────────────────────────

export const POLICY_DEFAULTS = Object.freeze({ disputeWindowHours: 168, publicNames: 'initial' });

/** The resultsPolicy stored on the event with defaults applied. */
export function policyOf(event, defaultDisputeHours = POLICY_DEFAULTS.disputeWindowHours) {
  const p = event?.resultsPolicy && typeof event.resultsPolicy === 'object' ? event.resultsPolicy : {};
  return {
    disputeWindowHours: Number.isInteger(p.disputeWindowHours) ? p.disputeWindowHours : defaultDisputeHours,
    publicNames: p.publicNames === 'bib_only' ? 'bib_only' : 'initial',
    virtual: { allowedEvidence: ['fitflex_gps'] },
  };
}

/** The resultRules of a category: { timeBasis, cutoffMinutes, virtualDistanceToleranceBps } with defaults. */
export function rulesOf(category) {
  const r = category?.resultRules && typeof category.resultRules === 'object' ? category.resultRules : {};
  return {
    timeBasis: r.timeBasis === 'gun' ? 'gun' : 'net',
    cutoffMinutes: Number.isInteger(r.cutoffMinutes) ? r.cutoffMinutes : null,
    virtualDistanceToleranceBps: Number.isInteger(r.virtualDistanceToleranceBps) ? r.virtualDistanceToleranceBps : null,
  };
}

const field = (path, code) => ({ path, code });

/** Validate a PATCH …/results-settings body. → { policy, categories: [{ id, rules }] } or { fields: [...] }. Unknown keys are refused. */
export function validateSettings(body) {
  const fields = [];
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const known = ['timeBasis', 'cutoffMinutes', 'disputeWindowHours', 'publicNames', 'categories'];
  for (const k of Object.keys(b)) if (!known.includes(k)) fields.push(field(k, 'unknown'));
  const policy = {};
  if ('disputeWindowHours' in b) {
    if (!Number.isInteger(b.disputeWindowHours) || b.disputeWindowHours < 24 || b.disputeWindowHours > 720) fields.push(field('disputeWindowHours', 'out_of_range'));
    else policy.disputeWindowHours = b.disputeWindowHours;
  }
  if ('publicNames' in b) {
    if (!['initial', 'bib_only'].includes(b.publicNames)) fields.push(field('publicNames', 'invalid'));
    else policy.publicNames = b.publicNames;
  }
  const ruleOf = (src, prefix) => {
    const r = {};
    if ('timeBasis' in src) { if (!['net', 'gun'].includes(src.timeBasis)) fields.push(field(`${prefix}timeBasis`, 'invalid')); else r.timeBasis = src.timeBasis; }
    if ('cutoffMinutes' in src) {
      if (src.cutoffMinutes === null) r.cutoffMinutes = null;
      else if (!Number.isInteger(src.cutoffMinutes) || src.cutoffMinutes < 1 || src.cutoffMinutes > 1440) fields.push(field(`${prefix}cutoffMinutes`, 'out_of_range'));
      else r.cutoffMinutes = src.cutoffMinutes;
    }
    if ('virtualDistanceToleranceBps' in src) {
      if (src.virtualDistanceToleranceBps === null) r.virtualDistanceToleranceBps = null;
      else if (!Number.isInteger(src.virtualDistanceToleranceBps) || src.virtualDistanceToleranceBps < 0 || src.virtualDistanceToleranceBps > 500) fields.push(field(`${prefix}virtualDistanceToleranceBps`, 'out_of_range'));
      else r.virtualDistanceToleranceBps = src.virtualDistanceToleranceBps;
    }
    return r;
  };
  let categories = null;
  if ('categories' in b) {
    if (!Array.isArray(b.categories) || b.categories.length > 100) fields.push(field('categories', 'invalid'));
    else {
      categories = [];
      b.categories.forEach((c, i) => {
        if (!c || typeof c.id !== 'string') { fields.push(field(`categories[${i}].id`, 'required')); return; }
        const unknown = Object.keys(c).filter(k => !['id', 'timeBasis', 'cutoffMinutes', 'virtualDistanceToleranceBps'].includes(k));
        for (const k of unknown) fields.push(field(`categories[${i}].${k}`, 'unknown'));
        categories.push({ id: c.id, rules: ruleOf(c, `categories[${i}].`) });
      });
    }
  }
  // top-level timeBasis / cutoffMinutes are a shorthand for "every category"
  const all = ruleOf(b, '');
  if (fields.length) return { fields };
  if (!Object.keys(policy).length && !categories && !Object.keys(all).length) return { fields: [field('body', 'empty')] };
  return { policy, categories, all };
}

// ── Medal rules (spec §7.1) ──────────────────────────────────────────────

/** Validate a medal rule. → { rule } normalised, or { fields }. Closed vocabulary, unknown keys refused. */
export function validateMedalRule(raw) {
  const fields = [];
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!r) return { fields: [field('rule', 'required')] };
  const keysOk = allowed => { for (const k of Object.keys(r)) if (!allowed.includes(k)) fields.push(field(`rule.${k}`, 'unknown')); };
  if (r.type === 'finish') { keysOk(['type']); return fields.length ? { fields } : { rule: { type: 'finish' } }; }
  if (r.type === 'placing') {
    keysOk(['type', 'scope', 'top']);
    if (!['category', 'overall'].includes(r.scope)) fields.push(field('rule.scope', 'invalid'));
    if (!Number.isInteger(r.top) || r.top < 1 || r.top > 10) fields.push(field('rule.top', 'out_of_range'));
    return fields.length ? { fields } : { rule: { type: 'placing', scope: r.scope, top: r.top } };
  }
  if (r.type === 'time_under') {
    keysOk(['type', 'maxElapsedMs']);
    if (!Number.isInteger(r.maxElapsedMs) || r.maxElapsedMs < 60_000 || r.maxElapsedMs >= DAY) fields.push(field('rule.maxElapsedMs', 'out_of_range'));
    return fields.length ? { fields } : { rule: { type: 'time_under', maxElapsedMs: r.maxElapsedMs } };
  }
  return { fields: [field('rule.type', 'invalid')] };
}

/** Does `ctx` earn a medal with this rule? ctx: { base: boolean, categoryRank, overallRank, elapsedMs }. `base` = confirmed, event not cancelled, official, settled, finished, within cut-off. */
export function medalQualifies(rule, ctx) {
  if (!ctx.base) return false;
  if (rule.type === 'finish') return true;
  if (rule.type === 'placing') { const rank = rule.scope === 'overall' ? ctx.overallRank : ctx.categoryRank; return Number.isInteger(rank) && rank <= rule.top; }
  if (rule.type === 'time_under') return ctx.elapsedMs !== null && ctx.elapsedMs !== undefined && Number(ctx.elapsedMs) <= rule.maxElapsedMs;
  return false;
}

/** The built-in design a tier defaults to (a virtual event defaults to virtual_teal). */
export function defaultArtKey(tier, eventType) {
  if (eventType === 'virtual') return 'virtual_teal';
  return ({ finisher: 'finisher_green', gold: 'podium_gold', silver: 'podium_silver', bronze: 'podium_bronze', time: 'time_blue' })[tier] ?? 'finisher_gold';
}

/** {en, sw} text with a length cap. → { value } | { error }. The Swahili text may be blank (the app then shows English). */
export function bilingual(raw, { max, requireEn = true, requireSw = false } = {}) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clean = v => (typeof v === 'string' ? v.trim() : '');
  const en = clean(o.en);
  const sw = clean(o.sw);
  if ((requireEn && !en) || (requireSw && !sw)) return { error: 'required' };
  if (en.length > max || sw.length > max) return { error: 'too_long' };
  return { value: { en, sw } };
}
