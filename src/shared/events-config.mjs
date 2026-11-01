// Marathon & running events · S3 — configuration read from the environment (spec §7.1: config, not flags).
// Every value has a default so an unset server behaves as the spec describes; a malformed JSON value is
// reported, never silently turned into "nothing" (same rule as normaliseFeeRule).
//
//   EVENTS_MAX_PARTICIPANTS_PER_ORDER  10     places one member order may hold (bounded below by ticket maxPerOrder)
//   EVENTS_CORPORATE_MAX_ROWS          500    roster rows one corporate order may hold (413 too_many_rows above)
//   EVENTS_TEAM_MAX_MEMBERS            50     default team size when EventTeam.maxMembers is null
//   EVENTS_CLAIM_TOKEN_DAYS            90     claim link lifetime
//   EVENTS_CONSENT_TEXT_VERSION        2026-10-draft
//   EVENTS_FEE_RULE                    (none) JSON fee rule for src/shared/events-pricing.mjs (D21: no member fee unless set)
//   EVENTS_ORG_DISCOUNTS               {}     JSON { "<organizationId>": { "pct": 10 } } — server-side only (follow-ups S3)
//   EVENT_HOLD_TTL_MINUTES             30     S1 (read through the store's holdTtlMinutes)
// S4 (payments; spec §3.18):
//   EVENT_TICKET_SECRET (>= 32 chars), EVENT_TICKET_KEY_ID (k1), EVENT_TICKET_SECRET_PREVIOUS (JSON)  ticket tokens (events-ticket-token.mjs)
//   EVENT_MANUAL_HOLD_EXTEND_HOURS     24     hold extension while a manual payment waits
//   EVENT_MANUAL_HOLD_MAX_HOURS        48     cap from the order's creation (organisation orders: EVENTS_ORG_HOLD_MAX_HOURS 120)
//   EVENTS_PROVIDER_HOLD_EXTEND_MINUTES 10, EVENTS_REJECTED_RETRY_MINUTES 60, EVENTS_LATE_PAYMENT_GRACE_HOURS 24
//   EVENTS_MANUAL_CONFIRM_SLA_HOURS    24     quoted to members in app copy only; no code enforces it
//   EVENTS_REFUND_TARGET_DAYS          5      working days FitFlex quotes for sending a refund; copy only
import { normaliseFeeRule, NO_FEE } from './events-pricing.mjs';
import { ticketKeyRing } from './events-ticket-token.mjs';

const intOr = (name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export const DEFAULT_MAX_PARTICIPANTS_PER_ORDER = 10;
export const DEFAULT_CORPORATE_MAX_ROWS = 500;
export const DEFAULT_TEAM_MAX_MEMBERS = 50;
export const DEFAULT_CLAIM_TOKEN_DAYS = 90;
export const DEFAULT_CONSENT_TEXT_VERSION = '2026-10-draft';

export const eventsMaxParticipantsPerOrder = () => intOr('EVENTS_MAX_PARTICIPANTS_PER_ORDER', DEFAULT_MAX_PARTICIPANTS_PER_ORDER, { max: 1000 });
export const eventsCorporateMaxRows = () => intOr('EVENTS_CORPORATE_MAX_ROWS', DEFAULT_CORPORATE_MAX_ROWS, { max: 5000 });
export const eventsTeamMaxMembers = () => intOr('EVENTS_TEAM_MAX_MEMBERS', DEFAULT_TEAM_MAX_MEMBERS, { max: 10000 });
export const eventsClaimTokenDays = () => intOr('EVENTS_CLAIM_TOKEN_DAYS', DEFAULT_CLAIM_TOKEN_DAYS, { max: 3650 });
export const eventsConsentTextVersion = () => {
  const v = String(process.env.EVENTS_CONSENT_TEXT_VERSION ?? '').trim();
  return v || DEFAULT_CONSENT_TEXT_VERSION;
};

// A bad value reports only { error: 'invalid_config' } — never the variable name or the organisation id (review L8).
function parseJsonEnv(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return { value: null };
  try { return { value: JSON.parse(raw) }; } catch { return { error: 'invalid_config', status: 500 }; }
}

/**
 * The fee rule as the pricing module will apply it: NO_FEE when unset; { error: 'invalid_fee_rule' | 'invalid_config' }
 * when the JSON is malformed or the rule is not well formed (the quote and the order then refuse rather than guess).
 */
export function eventsFeeRule() {
  const parsed = parseJsonEnv('EVENTS_FEE_RULE');
  if (parsed.error) return parsed;
  return parsed.value == null ? NO_FEE : normaliseFeeRule(parsed.value);
}

/** { [organizationId]: { pct } } with pct 0–100, or {} when unset; malformed → { error }. */
export function eventsOrgDiscounts() {
  const parsed = parseJsonEnv('EVENTS_ORG_DISCOUNTS');
  if (parsed.error) return parsed;
  if (parsed.value == null) return {};
  if (typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return { error: 'invalid_config', status: 500 };
  const out = {};
  for (const [orgId, rule] of Object.entries(parsed.value)) {
    const pct = Number(rule?.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { error: 'invalid_config', status: 500 };
    out[orgId] = { pct };
  }
  return out;
}

/** The fee line label the apps show when feesTzs > 0 (spec §5.6); null without a fee rule. */
export const feeLabelFor = rule => (rule && rule.type && rule.type !== 'none' ? { en: 'Service fee', sw: 'Ada ya huduma' } : null);
/** The discount line label for an approved organisation discount (spec §3.10). */
export const ORG_DISCOUNT_LABEL = Object.freeze({ en: 'Approved organisation discount', sw: 'Punguzo lililoidhinishwa la shirika' });

// ── S4: payments and refunds ──────────────────────────────────────────────────

export const eventsManualConfirmSlaHours = () => intOr('EVENTS_MANUAL_CONFIRM_SLA_HOURS', 24, { max: 720 });
export const eventsRefundTargetDays = () => intOr('EVENTS_REFUND_TARGET_DAYS', 5, { max: 90 });
export const eventManualHoldExtendHours = () => intOr('EVENT_MANUAL_HOLD_EXTEND_HOURS', 24, { max: 168 });
export const eventManualHoldMaxHours = () => intOr('EVENT_MANUAL_HOLD_MAX_HOURS', 48, { max: 720 });
export const eventsOrgHoldMaxHours = () => intOr('EVENTS_ORG_HOLD_MAX_HOURS', 120, { max: 720 });
export const eventsProviderHoldExtendMinutes = () => intOr('EVENTS_PROVIDER_HOLD_EXTEND_MINUTES', 10, { max: 240 });
export const eventsRejectedRetryMinutes = () => intOr('EVENTS_REJECTED_RETRY_MINUTES', 60, { max: 1440 });
export const eventsLatePaymentGraceHours = () => intOr('EVENTS_LATE_PAYMENT_GRACE_HOURS', 24, { max: 168 });

/** The ticket key ring, or null when EVENT_TICKET_SECRET is missing or shorter than 32 characters (fail closed: no payment is taken). */
export const eventTicketKeyRing = () => ticketKeyRing(process.env);

// ── S5: venue operations, the organizer API and webhooks (docs/design/events-s5-venue-api-and-webhooks.md §11.3) ──
//   EVENTS_API_TOKEN_TTL_SECONDS 900   EVENTS_API_MAX_CLIENTS 10   EVENTS_API_DEFAULT_RATE 120
//   EVENTS_WEBHOOK_MAX_ENDPOINTS 5     EVENTS_WEBHOOK_TIMEOUT_MS 10000   EVENTS_WEBHOOK_MAX_ATTEMPTS 10   EVENTS_WEBHOOK_BATCH 50
//   EVENTS_FEED_LAG_SECONDS 5          EVENTS_EXPORT_MAX_ROWS 20000
//   EVENTS_API_ORGANIZER_ALLOWLIST     optional comma list of organizer ids (the D39 pilot gate, besides the admin switch)
//   EVENTS_WEBHOOK_SECRET_KEY (32 bytes, base64), EVENTS_WEBHOOK_SECRET_KEY_ID (k1), EVENTS_WEBHOOK_SECRET_KEY_PREVIOUS (JSON): see webhook-signing.mjs
export const eventsApiTokenTtlSeconds = () => intOr('EVENTS_API_TOKEN_TTL_SECONDS', 900, { min: 60, max: 3600 });
export const eventsApiMaxClients = () => intOr('EVENTS_API_MAX_CLIENTS', 10, { max: 100 });
export const eventsApiDefaultRate = () => intOr('EVENTS_API_DEFAULT_RATE', 120, { max: 600 });
export const eventsWebhookMaxEndpoints = () => intOr('EVENTS_WEBHOOK_MAX_ENDPOINTS', 5, { max: 50 });
export const eventsWebhookTimeoutMs = () => intOr('EVENTS_WEBHOOK_TIMEOUT_MS', 10_000, { min: 1000, max: 30_000 });
export const eventsWebhookMaxAttempts = () => intOr('EVENTS_WEBHOOK_MAX_ATTEMPTS', 10, { max: 20 });
export const eventsWebhookBatch = () => intOr('EVENTS_WEBHOOK_BATCH', 50, { max: 200 });
export const eventsFeedLagSeconds = () => intOr('EVENTS_FEED_LAG_SECONDS', 5, { min: 0, max: 300 });
export const eventsExportMaxRows = () => intOr('EVENTS_EXPORT_MAX_ROWS', 20_000, { max: 200_000 });
/** The env part of the D39 pilot gate: a Set of organizer ids (empty when unset). The admin switch (EventOrganizer.apiAccessEnabledAt) is the other part. */
export const eventsApiAllowlist = () => new Set(String(process.env.EVENTS_API_ORGANIZER_ALLOWLIST ?? '').split(',').map(s => s.trim()).filter(Boolean));

// ── S6: runs, results, medals and rewards (docs/design/events-s6-runs-results-medals-rewards.md §13.2) ──
//   EVENTS_RUN_DISTANCE_TOLERANCE_BPS 200      EVENTS_RUN_LINK_MAX_DAYS_AFTER 7       EVENTS_RESULTS_IMPORT_MAX_ROWS 5000
//   EVENTS_RESULTS_DISPUTE_DEFAULT_HOURS 168   EVENTS_AWARD_BATCH 200                 EVENTS_RESULTS_PUSH_MAX 500
//   EVENTS_MEDAL_ART_MAX_BYTES 2097152         EVENTS_MEDAL_ART_MAX_PIXELS 16000000   EVENTS_MEDAL_ART_UPLOADS_PER_DAY 20
//   EVENTS_RESULTS_CONSENT_VERSIONS            comma list of consent-text versions that carry the public-results clause (unset = none: everyone starts bib-only)
// Reward codes reuse EVENT_TICKET_SECRET through a derived key (events-reward-code.mjs); there is no new secret.
export const eventsRunDistanceToleranceBps = () => intOr('EVENTS_RUN_DISTANCE_TOLERANCE_BPS', 200, { min: 0, max: 500 });
export const eventsRunLinkMaxDaysAfter = () => intOr('EVENTS_RUN_LINK_MAX_DAYS_AFTER', 7, { min: 0, max: 60 });
export const eventsResultsImportMaxRows = () => intOr('EVENTS_RESULTS_IMPORT_MAX_ROWS', 5000, { max: 20_000 });
export const eventsResultsDisputeDefaultHours = () => intOr('EVENTS_RESULTS_DISPUTE_DEFAULT_HOURS', 168, { min: 24, max: 720 });
export const eventsAwardBatch = () => intOr('EVENTS_AWARD_BATCH', 200, { max: 2000 });
export const eventsResultsPushMax = () => intOr('EVENTS_RESULTS_PUSH_MAX', 500, { min: 0, max: 100_000 });
export const eventsMedalArtMaxBytes = () => intOr('EVENTS_MEDAL_ART_MAX_BYTES', 2_097_152, { min: 65_536, max: 2_097_152 });
export const eventsMedalArtMaxPixels = () => intOr('EVENTS_MEDAL_ART_MAX_PIXELS', 16_000_000, { min: 262_144, max: 16_000_000 });
export const eventsMedalArtUploadsPerDay = () => intOr('EVENTS_MEDAL_ART_UPLOADS_PER_DAY', 20, { max: 200 });
export const eventsResultsConsentVersions = () => String(process.env.EVENTS_RESULTS_CONSENT_VERSIONS ?? '').split(',').map(s => s.trim()).filter(Boolean);
