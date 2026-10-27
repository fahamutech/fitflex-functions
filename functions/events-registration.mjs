// Marathon & running events · S3 — member registration, orders, claims and teams (spec §3.4–§3.9).
// Every route is wrapped in routeGuard (bfast mounts guards method-blind), needs EVENTS_MODULE and
// EVENTS_REGISTRATION (either off → 404 feature_disabled), then requireAuth('member'); the public claim preview
// is flag-gated and rate-limited per IP. Routes with fixed sub-paths (claimable, claim, lookup) are declared
// before their /:id siblings so they are mounted first. Rate limits (spec §8.9) are in-memory per server.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsRegistration } from '../src/shared/feature-flags.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { eventsRegistrationService as svc } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const HOUR = 3_600_000;
const limiters = {
  quote: createVendorLimiter({ perMinute: 60 }),
  order: createVendorLimiter({ perMinute: 20 }),
  claim: createVendorLimiter({ perMinute: 20, windowMs: HOUR }),
  lookup: createVendorLimiter({ perMinute: 30, windowMs: HOUR }),
  teamCreate: createVendorLimiter({ perMinute: 10, windowMs: 24 * HOUR }),
  preview: createVendorLimiter({ perMinute: 40, windowMs: HOUR }),
};
/** For specs: clear every window. */
export const resetEventsRegistrationLimits = () => Object.values(limiters).forEach(l => l.reset());
// The client-supplied left end of X-Forwarded-For can be forged; the rightmost entry is the one the nearest proxy appended (review L4).
const addressOf = req => String(req.headers?.['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean).pop() || req.ip || req.socket?.remoteAddress || 'anon';
const headerOf = (req, name) => req.headers?.[name] ?? req.headers?.[name.toLowerCase()] ?? (typeof req.get === 'function' ? req.get(name) : undefined) ?? null;

function send(res, result, okStatus = 200) {
  if (result?.error) {
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  // A numeric `status` is the HTTP code (201 on creation, 200 on an idempotent replay).
  if (Number.isInteger(result?.status)) { const { status, ...body } = result; return res.status(status).json(body); }
  res.status(okStatus).json(result);
}

const member = method => routeGuard(method, [requireEventsRegistration, requireAuth('member')]);

// ── Quote and orders (§3.4, §3.5, §3.6, §3.8) ─────────────────────────────

export const quoteEventOrder = {
  created, method: 'post', path: '/me/event-orders/quote',
  description: 'Member (EVENTS_REGISTRATION on): price and check an order without holding anything. Body { eventId, lines: [{ ticketTypeId, quantity }], participants: [{ ticketTypeId, firstName, lastName, phone?, email?, dateOfBirth?, gender?, emergencyContact? { name, phone }, kitSize?, consentBasis: self | purchaser_authorised }], team?: { create: { name, teamType: club | community } } | { joinCode } } → { valid, quote { currency, lines[], subtotalTzs, discountTzs, feesTzs, totalTzs, feeLabel }, quoteExpiresAt, holdTtlMinutes, availability { [ticketTypeId]: { availability, remaining } }, participants [{ index, ok, problems [{ field, code }] }], problems [{ code }], team, fields, refundPolicy, termsVersion, consentText { version, self, purchaser_authorised, organisation } }. 404 event_not_found | feature_disabled; 409 event_not_open | registration_closed; 400 invalid_lines | participants_mismatch | organization_not_allowed; 429 rate_limited (60/min).',
  onGuard: member('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.quote, `quote:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.quote({ userId: req.user.sub, body: req.body || {} }));
  },
};

export const createEventOrder = {
  created, method: 'post', path: '/me/event-orders',
  description: 'Member: place an order and hold its places (30 min, EVENT_HOLD_TTL_MINUTES). Header Idempotency-Key (required, 8–100 chars [A-Za-z0-9._:-]); same key + same body → 200 { …, replayed: true }, same key + different body → 409 idempotency_key_reused. Body = quote body + { acceptedTerms: true, consentTextVersion, expectedTotalTzs (REQUIRED: 400 expected_total_required) }. Rate 20/min; one live unpaid order per event (409 hold_limit_reached). → 201 { order { id, reference, status: awaiting_payment, currency, subtotalTzs, discountTzs, feesTzs, totalTzs, holdExpiresAt, holdCycle, createdAt, teamId }, lines[], registrations [{ id, ticketTypeId, categoryId, firstName, lastName, status: reserved, consentBasis, isSelf, claimState }], holdExpiresAt, next { payment: "none", instructions: null }, event, team, replayed: false }. 422 participant_invalid { participants [{ index, problems }] } (every row), 400 idempotency_key_required | terms_not_accepted | too_many_participants { max } | quantity_out_of_range | invalid_lines | participants_mismatch | multiple_self_participants, 409 consent_version_stale | price_changed { quotedTotalTzs, totalTzs } | capacity_unavailable { ticketTypeId } | event_not_open | registration_closed | sale_not_open | sale_closed | ticket_type_inactive | category_inactive | team_full | team_disbanded | team_name_taken, 404 event_not_found | ticket_type_not_found | team_not_found. The route never forwards holdTtlMinutes, feeRule, discounts or participantUserId.',
  onGuard: member('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.order, `order:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.createOrder({ userId: req.user.sub, body: req.body || {}, idempotencyKey: headerOf(req, 'Idempotency-Key') }), 201);
  },
};

export const listMyEventOrders = {
  created, method: 'get', path: '/me/event-orders',
  description: 'Member: my orders, newest first. ?status=awaiting_payment|confirmed|cancelled|expired&cursor&limit (≤50) → { items [{ id, reference, status, event { id, slug, title, startsAt, timezone, utcOffsetMinutes, timezoneAbbr, heroThumbUrl }, placesCount, totalTzs, currency, holdExpiresAt, createdAt, closedAt, closeReason }], nextCursor }.',
  onGuard: member('get'),
  onRequest: async (req, res) => send(res, await svc.listOrders({ userId: req.user.sub, query: req.query || {} })),
};

export const getMyEventOrder = {
  created, method: 'get', path: '/me/event-orders/:id',
  description: 'Member (purchaser only; anyone else 404 order_not_found): one order → { order, lines, registrations [full participant fields, claimState, cancelReason], event (summary + refundPolicy, contact, terms), team { …, joinCode (captain only) } | null, next { payment, instructions }, allowedActions: ["cancel"] | [] }.',
  onGuard: member('get'),
  onRequest: async (req, res) => send(res, await svc.getOrder({ userId: req.user.sub, orderId: req.params.id })),
};

export const cancelMyEventOrder = {
  created, method: 'post', path: '/me/event-orders/:id/cancel',
  description: 'Member (purchaser): cancel an unpaid order and release its places. Body { reason: changed_mind | wrong_details | duplicate | other } → { order (cancelled), registrations (cancelled), changed }. Already closed → 200 with the current order (idempotent). 400 invalid_reason, 404 order_not_found, 409 invalid_transition (confirmed orders: refunds arrive with S4).',
  onGuard: member('post'),
  onRequest: async (req, res) => send(res, await svc.cancelOrder({ userId: req.user.sub, orderId: req.params.id, body: req.body || {} })),
};

// ── Registrations and claims (§3.6, §3.7, §3.8) ───────────────────────────

export const claimableEventRegistrations = {
  created, method: 'get', path: '/me/event-registrations/claimable',
  description: 'Member: unclaimed live places whose phone / email equals one of MY VERIFIED contacts (never matched by name) → { items [{ id, event, category { id, name }, participant { firstNameMasked, lastInitial }, purchaser { nameMasked }, matchedContact { type, masked }, status }] }.',
  onGuard: member('get'),
  onRequest: async (req, res) => send(res, await svc.claimable({ userId: req.user.sub })),
};

export const claimEventRegistrationByToken = {
  created, method: 'post', path: '/me/event-registrations/claim',
  description: 'Member: claim the place behind a claim link. Body { token } → { registration, changed }. Same rules as POST /me/event-registrations/:id/claim; 400 claim_token_invalid, 410 claim_token_expired. Rate 20/h.',
  onGuard: member('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.claim, `claim:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.claimByToken({ userId: req.user.sub, token: req.body?.token }));
  },
};

export const listMyEventRegistrations = {
  created, method: 'get', path: '/me/event-registrations',
  description: 'Member: places where I am the participant or the purchaser, soonest event first, cancelled / expired after. ?cursor&limit → { items [{ id, relation: self | purchased | claimed, participant { firstName, lastName }, event, category { id, name, distanceM, startsAt }, ticketType { name }, status, orderId, orderReference, orderStatus, holdExpiresAt, claimState, team { id, name } | null }], nextCursor }.',
  onGuard: member('get'),
  onRequest: async (req, res) => send(res, await svc.listRegistrations({ userId: req.user.sub, query: req.query || {} })),
};

export const getMyEventRegistration = {
  created, method: 'get', path: '/me/event-registrations/:id',
  description: 'Member (purchaser or claimed participant; else 404 registration_not_found): one place → list row + kitSize, dateOfBirth, gender, phone, email, emergencyContact, consentBasis, consentAt, purchaser { nameMasked } (when I am not the purchaser), allowedActions: ["cancel"] | [], ticket: null (S5).',
  onGuard: member('get'),
  onRequest: async (req, res) => send(res, await svc.getRegistration({ userId: req.user.sub, registrationId: req.params.id })),
};

export const claimEventRegistration = {
  created, method: 'post', path: '/me/event-registrations/:id/claim',
  description: 'Member: claim a place registered for me by someone else. Body { token? }. The registration\'s phone or email MUST equal one of my verified contacts (token or not); with a token its hash must match and not be expired. → { registration (participantUserId = me, claimedAt), changed }. 403 claim_not_verified (no hints about the place or its contact), 409 already_claimed | claim_own_contact | registration_closed_state, 400 claim_token_invalid, 410 claim_token_expired, 404 registration_not_found. Rate 20/h.',
  onGuard: member('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.claim, `claim:${req.user.sub}`, res)) return undefined;
    const token = typeof req.body?.token === 'string' && req.body.token.trim() ? req.body.token.trim() : null;
    return send(res, await svc.claim({ userId: req.user.sub, registrationId: req.params.id, token, via: token ? 'link' : 'in_app' }));
  },
};

export const cancelMyEventRegistration = {
  created, method: 'post', path: '/me/event-registrations/:id/cancel',
  description: 'Member (purchaser only): remove one place from an unpaid order. Body { reason: changed_mind | wrong_details | duplicate | other }. The only live place → the whole order is cancelled. → { order, registrations, registration, changed }. 409 remove_whole_line (the last place of a ticket line while other lines remain: cancel the whole order), 409 invalid_transition, 400 invalid_reason, 404 registration_not_found.',
  onGuard: member('post'),
  onRequest: async (req, res) => send(res, await svc.cancelRegistration({ userId: req.user.sub, registrationId: req.params.id, body: req.body || {} })),
};

export const previewEventClaim = {
  created, method: 'get', path: '/event-claims/preview/:token',
  description: 'Public (EVENTS_REGISTRATION on; 40/h per IP): what a claim link is for, masked only → { event { id, slug, title, startsAt, timezone, … }, category { name }, participant { firstNameMasked, lastInitial }, purchaser { nameMasked }, contact { type, masked }, status, claimState }. 404 claim_token_invalid, 410 claim_token_expired. The token is redacted from the request log.',
  onGuard: routeGuard('get', [requireEventsRegistration]),
  onRequest: async (req, res) => {
    if (typeof req.originalUrl === 'string') req.originalUrl = '/event-claims/preview/[redacted]';
    if (limitOrNull(limiters.preview, `preview:${addressOf(req)}`, res)) return undefined;
    return send(res, await svc.claimPreview({ token: req.params?.token }));
  },
};

// ── Teams (§3.9) ──────────────────────────────────────────────────────────

export const createEventTeam = {
  created, method: 'post', path: '/me/event-teams',
  description: 'Member: create a team for a published event. Body { eventId, name (1–120, unique per event), teamType: club | community } → 201 { team { id, eventId, name, teamType, joinCode "AB12-CD34", memberCount: 0, maxMembers, captainRegistrationId: null, createdByUserId } }. 409 team_name_taken | event_not_open, 400 team_name_invalid | team_type_invalid, 404 event_not_found. Rate 10/day.',
  onGuard: member('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.teamCreate, `team:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.createTeam({ userId: req.user.sub, body: req.body || {} }), 201);
  },
};

export const lookupEventTeam = {
  created, method: 'post', path: '/me/event-teams/lookup',
  description: 'Member: find a team by join code. Body { eventId, joinCode } (case-insensitive, dash optional) → { team { id, name, teamType, memberCount, maxMembers, captain { firstName, lastInitial } | null } }. 404 team_not_found (also for a wrong event), 409 team_full | team_disbanded. Rate 30/h.',
  onGuard: member('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.lookup, `lookup:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.lookupTeam({ body: req.body || {} }));
  },
};

export const getEventTeam = {
  created, method: 'get', path: '/me/event-teams/:id',
  description: 'Member (a member of the team through a registration, or its creator; else 404 team_not_found): → { team { …, joinCode (captain or creator only) }, members [{ registrationId, participant { firstName, lastInitial }, role, status }], isCaptain }.',
  onGuard: member('get'),
  onRequest: async (req, res) => send(res, await svc.getTeam({ userId: req.user.sub, teamId: req.params.id })),
};
