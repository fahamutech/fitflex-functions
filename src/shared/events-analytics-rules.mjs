// Marathon & running events · S7 — the analytics allowlist and the pure rules around it (spec §5.1 to §5.3). No database, no clock.
//
// A counter is (day, name, eventId | none, dimensions) -> count. Everything that reaches a counter passes through `shapeEvent`:
//   - the NAME must be in ANALYTICS_EVENTS (and, for the member endpoint, have src 'app');
//   - only the dimension keys listed for that name survive; a value outside the closed set becomes 'other'
//     (counts are bucketed: 1 / 2-5 / 6+); nothing else is kept, so a name, phone, bib, order id, amount or free text can never be stored;
//   - `eventId` is kept as a public event id (shape-checked here, existence-checked by the service);
//   - categoryId is NOT a dimension (a small under-18 category would reveal a group, §5.2 rule 2).
const PLATFORM = ['android', 'ios', 'web'];
const BOOL = ['true', 'false'];
const OTHER = 'other';

const bucketPlaces = v => { const n = Number(v); if (!Number.isFinite(n) || n < 1) return OTHER; return n === 1 ? '1' : n <= 5 ? '2-5' : '6+'; };
const bucketFilters = v => { const n = Number(v); if (!Number.isFinite(n) || n < 0) return OTHER; return n === 0 ? '0' : n === 1 ? '1' : '2+'; };
const bucketResults = v => { const n = Number(v); if (!Number.isFinite(n) || n < 0) return OTHER; return n === 0 ? '0' : n <= 5 ? '1-5' : n <= 20 ? '6-20' : '21+'; };

/** A dimension: { values: [closed set] } for an enum, or { bucket: fn, values: [the buckets] }, or { bool: true }. */
const dim = {
  enum: values => ({ values }),
  bool: () => ({ values: BOOL, bool: true }),
  places: () => ({ values: ['1', '2-5', '6+'], bucket: bucketPlaces }),
  filters: () => ({ values: ['0', '1', '2+'], bucket: bucketFilters }),
  results: () => ({ values: ['0', '1-5', '6-20', '21+'], bucket: bucketResults }),
};
const platform = dim.enum(PLATFORM);
const METHOD = dim.enum(['manual', 'mobile_money']);
const MODE = dim.enum(['self', 'others', 'group', 'team', 'member', 'corporate']);
const SCOPE = dim.enum(['place', 'order', 'registration', 'event_cancelled', 'unfulfilled_payment']);
const CANCEL_MODE = dim.enum(['policy', 'none', 'full']);
const REASON = dim.enum(['cancelled', 'expired', 'payment_failed', 'admin', 'changed_mind', 'wrong_details', 'duplicate']);

const app = (dims = {}, { event = false } = {}) => ({ src: 'app', event, dims });
const server = (dims = {}, { event = true } = {}) => ({ src: 'server', event, dims });

export const ANALYTICS_EVENTS = Object.freeze({
  // ── app (client) events: what the server cannot see, before an order exists (§5.3) ──
  event_list_viewed: app({ filters: dim.filters(), results: dim.results(), platform }),
  event_detail_viewed: app({ availability: dim.enum(['open', 'closing_soon', 'sold_out', 'closed', 'not_yet_open', 'cancelled', 'in_progress', 'completed']), platform }, { event: true }),
  event_saved: app({ saved: dim.bool() }, { event: true }),
  registration_started: app({ source: dim.enum(['cta', 'ticket_row', 'deep_link']) }, { event: true }),
  checkout_quote_created: app({ mode: MODE, places: dim.places() }, { event: true }),
  payment_started: app({ method: METHOD, late: dim.bool() }, { event: true }),
  payment_submitted: app({ method: METHOD, late: dim.bool() }, { event: true }),
  payment_state_seen: app({ state: dim.enum(['pending', 'confirmed', 'rejected', 'expired', 'unknown', 'refunded']), method: METHOD, late: dim.bool() }, { event: true }),
  ticket_opened: app({}, { event: true }),
  ticket_rotated: app({}, { event: true }),
  invitation_resent: app({}, { event: true }),
  // The cancel screens are opened from a ticket or an order, where the app may not carry an event id: it is optional here, counted when valid.
  cancel_preview_viewed: app({ scope: SCOPE }, { event: false }),
  cancel_confirmed: app({ scope: SCOPE, mode: CANCEL_MODE }, { event: false }),
  run_started: app({ platform }, { event: true }),
  waitlist_cta_viewed: app({}, { event: true }),
  waitlist_join_started: app({}, { event: true }),
  waitlist_offer_opened: app({}, { event: true }),

  // ── server events rolled up from the existing S3 to S6 `analytics.%` audit rows ──
  order_created: server({ mode: MODE }),
  order_expired: server(),
  order_cancelled: server({ reason: REASON }),
  registration_cancelled: server({ reason: REASON }),
  registration_claimed: server(),
  payment_initiated: server({ method: METHOD, late: dim.bool() }),
  payment_confirmed: server({ method: METHOD }),
  payment_failed: server({ method: METHOD }),
  ticket_issued: server(),
  refund_requested: server({ scope: SCOPE }),
  refund_completed: server({ scope: SCOPE }),
  cancel_no_refund: server({ scope: SCOPE }),
  kit_collected: server({ method: dim.enum(['scan', 'manual', 'api', 'offline']) }),
  bib_assigned: server(),
  organizer_event_submitted: server(),
  event_published: server(),
  result_submitted: server({ source: dim.enum(['csv', 'manual', 'api', 'run']) }),
  result_verified: server(),
  events_results_released: server({ stage: dim.enum(['provisional', 'official']) }),
  events_result_corrected: server(),
  events_dispute_raised: server(),

  // ── server events new in S7 ──
  run_saved: server({ linkType: dim.enum(['evidence', 'virtual']) }),
  medal_awarded: server({ tier: dim.enum(['finisher', 'podium']) }),
  reward_earned: server({ rewardType: dim.enum(['certificate', 'perk']) }),
  reward_redeemed: server({ rewardType: dim.enum(['certificate', 'perk']) }),
  reward_duplicate_blocked: server({ where: dim.enum(['ledger', 'redemption', 'award']) }),
  webhook_delivery_failed: server({ class: dim.enum(['timeout', 'dns', 'tls', 'blocked', 'http_4xx', 'http_5xx']) }, { event: false }),
  webhook_delivery_gave_up: server({ class: dim.enum(['timeout', 'dns', 'tls', 'blocked', 'http_4xx', 'http_5xx']) }, { event: false }),
  waitlist_joined: server(),
  waitlist_offer_made: server(),
  waitlist_offer_converted: server(),
  waitlist_offer_expired: server(),
  waitlist_left: server(),
  waitlist_closed: server({ reason: dim.enum(['sale_closed', 'event_cancelled', 'organizer_closed', 'admin']) }),
  kit_offline_device_prepared: server(),
  kit_offline_accepted: server(),
  kit_offline_duplicate: server(),
  kit_offline_review: server(),
  kit_offline_rejected: server(),
  kit_offline_invalid_burst: server(),
  kit_offline_bib_assigned: server(),
  kit_offline_bib_exception: server({ reason: dim.enum(['format_invalid', 'out_of_range', 'no_range', 'taken', 'registration_has_other', 'not_applied']) }),
  api_error: server({ group: dim.enum(['registration', 'payment', 'kit', 'results', 'rewards', 'webhook', 'admin']), class: dim.enum(['5xx', '429', '4xx_unexpected']) }, { event: false }),
});

export const APP_EVENT_NAMES = Object.freeze(Object.keys(ANALYTICS_EVENTS).filter(n => ANALYTICS_EVENTS[n].src === 'app'));
const EVENT_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
export const MAX_INCREMENT = 100_000;

/** The value of one dimension as it will be stored: its bucket, a member of the closed set, or 'other'. */
export function shapeValue(spec, raw) {
  if (raw === undefined || raw === null) return null;
  const typed = spec.bool ? (raw === true || raw === 'true' ? 'true' : raw === false || raw === 'false' ? 'false' : null) : null;
  if (spec.bool) return typed ?? OTHER;
  const value = spec.bucket ? spec.bucket(raw) : (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') ? String(raw).slice(0, 40) : OTHER;
  return spec.values.includes(value) ? value : OTHER;
}

/**
 * One analytics event → { name, eventId, dims, n } or null when the name is unknown (or not allowed from this source).
 * `from` is 'app' (the member endpoint: app names only) or 'server' (any name).
 */
export function shapeEvent(input, { from = 'server' } = {}) {
  const name = typeof input?.name === 'string' ? input.name : null;
  const def = name ? ANALYTICS_EVENTS[name] : null;
  if (!def) return null;
  if (from === 'app' && def.src !== 'app') return null;
  const props = input.props && typeof input.props === 'object' && !Array.isArray(input.props) ? input.props : {};
  const dims = {};
  for (const [key, spec] of Object.entries(def.dims)) {
    const v = shapeValue(spec, props[key]);
    if (v !== null) dims[key] = v;
  }
  let eventId = null;
  if (def.event) {
    const raw = input.eventId ?? props.eventId;
    if (typeof raw !== 'string' || !EVENT_ID_RE.test(raw)) return null;
    eventId = raw;
  } else {
    const raw = input.eventId ?? props.eventId;
    if (typeof raw === 'string' && EVENT_ID_RE.test(raw)) eventId = raw;
  }
  const n = Number.isInteger(input.n) && input.n >= 1 ? Math.min(input.n, MAX_INCREMENT) : 1;
  return { name, eventId, dims, n };
}

/** A stable key for a dimension set: sorted `k=v` joined by `&` (≤ 200 characters by the table CHECK). */
export const dimsKeyOf = dims => Object.keys(dims).sort().map(k => `${k}=${dims[k]}`).join('&').slice(0, 200);

/** The day (YYYY-MM-DD) in Africa/Dar_es_Salaam (UTC+3, no DST) of an instant. */
export const darDay = at => new Date(+new Date(at) + 3 * 3_600_000).toISOString().slice(0, 10);

// ── Mapping the existing S3 to S6 `analytics.<name>` audit rows to counters (the roll-up) ──

const REASON_SET = new Set(REASON.values);
const mapMethod = m => (m === 'manual' ? 'manual' : m === 'provider' || m === 'mobile_money' ? 'mobile_money' : null);

/**
 * An audit row's `after` payload → a counter input for the roll-up, or null when the row has nothing to count.
 * Only the keys the allowlist keeps are copied; ids, amounts and counts of places never reach a counter.
 */
export function counterFromAudit(action, after) {
  const raw = String(action ?? '').replace(/^analytics\./, '');
  const payload = after && typeof after === 'object' ? after : {};
  const aliases = { events_results_imported: 'result_submitted', refund_requested: 'refund_requested' };
  const name = aliases[raw] ?? raw;
  const def = ANALYTICS_EVENTS[name];
  if (!def || def.src !== 'server') return null;
  const props = { ...payload };
  if ('method' in props) props.method = mapMethod(props.method) ?? OTHER;
  if (name === 'order_created') props.mode = props.mode === 'corporate' ? 'corporate' : 'member';
  if (name === 'order_cancelled' || name === 'registration_cancelled') props.reason = REASON_SET.has(props.reason) ? props.reason : OTHER;
  if (name === 'result_submitted') props.source = 'csv';
  if (name === 'events_results_released') props.stage = payload.stage === 'official' ? 'official' : 'provisional';
  if (name === 'kit_collected') props.method = ['scan', 'manual', 'api', 'offline'].includes(payload.method) ? payload.method : OTHER;
  const shaped = shapeEvent({ name, eventId: typeof payload.eventId === 'string' ? payload.eventId : null, props, n: name === 'ticket_issued' && Number.isInteger(payload.count) ? payload.count : 1 }, { from: 'server' });
  return shaped;
}
