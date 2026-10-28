// Marathon & running events · S3 — corporate bulk registration under /b2b/organizations/:id (spec §3.10; D18, D19).
// Guard = the existing B2B organisation guard (any signed-in user with the `b2b` ACL scope, then the caller's
// membership of :id resolved by b2bService.resolveAccess — non-members get 404) plus EVENTS_MODULE and
// EVENTS_REGISTRATION (either off → 404 feature_disabled). The coordinator is bound to the organisation
// before the (organizationId, Idempotency-Key) scope is used (follow-ups S3). Permissions: validating and
// reading need beneficiaries.manage; placing and cancelling need an ORG_BILLING role (owner | admin | finance).
// Existing B2B routes are untouched.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsRegistration, requireEventsPaymentIntake } from '../src/shared/feature-flags.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { b2bService, eventsRosterService as svc, eventsPaymentsService as payments, eventsRefundsService as refunds } from '../src/bootstrap/services.mjs';

// roster/validate is the heaviest read here (review M1): limited per organisation, in memory per server.
const validateLimiter = createVendorLimiter({ perMinute: 20 });
// S4: payment notices, 10 per hour per organisation; status polls and previews, 120 / 60 per hour per user; resend 3 per day per place.
const HOUR = 3_600_000;
const paymentLimiter = createVendorLimiter({ perMinute: 10, windowMs: HOUR });
const statusLimiter = createVendorLimiter({ perMinute: 120, windowMs: HOUR });
const previewLimiter = createVendorLimiter({ perMinute: 60, windowMs: HOUR });
const resendLimiter = createVendorLimiter({ perMinute: 3, windowMs: 24 * HOUR });
export const resetEventsCorporateLimits = () => [validateLimiter, paymentLimiter, statusLimiter, previewLimiter, resendLimiter].forEach(l => l.reset());

const created = new Date().toISOString();
const guard = method => routeGuard(method, [requireEventsRegistration, requireAuth(), requireAcl('b2b')]);
const headerOf = (req, name) => req.headers?.[name] ?? req.headers?.[name.toLowerCase()] ?? (typeof req.get === 'function' ? req.get(name) : undefined) ?? null;

function send(res, result, okStatus = 200) {
  if (result?.error) {
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  if (Number.isInteger(result?.status)) { const { status, ...body } = result; return res.status(status).json(body); }
  res.status(okStatus).json(result);
}

/** Resolve the caller's access to :id (membership, role, permissions; organisation status), then run the handler. */
async function inOrganization(req, res, handler, okStatus = 200) {
  const access = await b2bService.resolveAccess({ organizationId: req.params.id, userId: req.user.sub, userType: req.user.userType });
  if (access.error) return send(res, access);
  return send(res, await handler(access), okStatus);
}

export const validateB2BEventRoster = {
  created, method: 'post', path: '/b2b/organizations/:id/event-orders/roster/validate',
  description: 'Organisation user (beneficiaries.manage; 20/min per organisation, else 429 rate_limited): check a roster without writing anything. Body { eventId, rows?: [{ firstName | name, lastName?, phone?, email?, category, ticketType?, dateOfBirth? (YYYY-MM-DD or DD/MM/YYYY), gender?, kitSize?, group? }], rawText?: CSV (header aliases in any order; without a header: first name, last name, phone, email, category, date of birth, gender, kit size, group), team?: { create: { name } } } → { rows [{ index, ok, participant, categoryId, ticketTypeId, problems [{ field, code }] }], duplicates [{ index, kind: in_list | already_registered, otherIndex?, registrationStatus? }], summary { total, ok, problems, duplicates }, lines, quote (ok rows only; null when none), availability, fields, consentText, refundPolicy, capacityShort [{ ticketTypeId, requested, remaining }] }. Problem codes: the participant codes + category_unknown | category_closed | ticket_type_unknown | name_incomplete | duplicate_participant. 413 too_many_rows (EVENTS_CORPORATE_MAX_ROWS, 500), 409 organization_not_active | event_not_open, 404 event_not_found | organization_not_found, 403 forbidden.',
  onGuard: guard('post'),
  onRequest: (req, res) => inOrganization(req, res, async (access) => {
    const allowed = validateLimiter.allow(`validate:${access.org.id}`);
    if (!allowed.ok) { res.set?.('Retry-After', String(allowed.retryAfterSeconds)); return { error: 'rate_limited', status: 429, retryAfterSeconds: allowed.retryAfterSeconds }; }
    return svc.validate({ access, body: req.body || {} });
  }),
};

export const createB2BEventOrder = {
  created, method: 'post', path: '/b2b/organizations/:id/event-orders',
  description: 'Organisation user with an ORG_BILLING role (owner | admin | finance; D18): place a corporate order. Header Idempotency-Key (scoped to the organisation). Body { eventId, rows (as validated), costCentre?, purchaserReference?, team?: { create: { name } }, acceptedTerms: true, consentTextVersion, expectedTotalTzs }. Every row is re-validated; consentBasis is organisation on every place; discounts come from EVENTS_ORG_DISCOUNTS only; maxPerOrder is lifted for this call. → 201 as POST /me/event-orders + organizationId. 422 participant_invalid { participants [{ index, problems }], duplicates } (nothing written), 409 capacity_unavailable { ticketTypeId } | price_changed | consent_version_stale | idempotency_key_reused | organization_not_active, 403 forbidden { requiredRole }.',
  onGuard: guard('post'),
  onRequest: (req, res) => inOrganization(req, res, access => svc.placeOrder({ access, body: req.body || {}, idempotencyKey: headerOf(req, 'Idempotency-Key'), actorId: req.user.sub }), 201),
};

export const listB2BEventOrders = {
  created, method: 'get', path: '/b2b/organizations/:id/event-orders',
  description: 'Organisation user (beneficiaries.manage or a billing role): the organisation\'s event orders, newest first. ?status&cursor&limit → { items [{ id, reference, status, event, placesCount, totalTzs, discountTzs, feesTzs, currency, holdExpiresAt, createdAt, closedAt, closeReason, createdBy { id, name }, costCentre, purchaserReference, allowedActions }], nextCursor }.',
  onGuard: guard('get'),
  onRequest: (req, res) => inOrganization(req, res, access => svc.listOrders({ access, query: req.query || {} })),
};

export const getB2BEventOrder = {
  created, method: 'get', path: '/b2b/organizations/:id/event-orders/:orderId',
  description: 'Organisation user: one corporate order → as GET /me/event-orders/:id (full participant list: the organisation typed it) + organizationId, createdBy { id, name }, costCentre, purchaserReference, allowedActions. 404 order_not_found for another organisation\'s order.',
  onGuard: guard('get'),
  onRequest: (req, res) => inOrganization(req, res, access => svc.getOrder({ access, orderId: req.params.orderId })),
};

export const cancelB2BEventOrder = {
  created, method: 'post', path: '/b2b/organizations/:id/event-orders/:orderId/cancel',
  description: 'Organisation user with an ORG_BILLING role: cancel an unpaid corporate order (order-level only: fix the list and place a new order), or (S4) a PAID one with its refund — the whole order, to the organisation. Body { reason: changed_mind | wrong_details | duplicate | other, expectedRefundTzs (REQUIRED for a paid order) } → { order, registrations, refund: RefundView | null, changed, requested? }. 400 invalid_reason | expected_refund_required, 404 order_not_found, 409 payment_submitted | refund_changed { refundTzs } | refund_in_progress | cancellation_window_closed | event_cancelled | invalid_transition.',
  onGuard: guard('post'),
  onRequest: (req, res) => inOrganization(req, res, access => svc.cancelOrder({ access, orderId: req.params.orderId, body: req.body || {}, actorId: req.user.sub })),
};

// ── S4: paying a corporate order, its status, the paid-order cancel preview and the claim resend ─────────────────

const paymentGuard = method => routeGuard(method, [requireEventsPaymentIntake, requireAuth(), requireAcl('b2b')]);

export const payB2BEventOrder = {
  created, method: 'post', path: '/b2b/organizations/:id/event-orders/:orderId/payment',
  description: 'Organisation user with billing.pay (owner | admin | finance; EVENTS_PAYMENTS_MANUAL or EVENTS_PAYMENTS_TUNZAA on, organisation active): record that the organisation paid an awaiting order by bank transfer or mobile money; FitFlex finance then checks it against the statement. Header Idempotency-Key REQUIRED (scoped to the organisation, order and key). Body { method: bank_transfer | mobile_money, reference (bank reference or transaction ID), paidOn (YYYY-MM-DD, not in the future), note? (≤300) }; provider (mobile-prompt) mode is never offered to an organisation. Amount and currency come from the order. → 201 { payment (PaymentView), order, next { payment: "manual", paymentRequestId, instructions: null }, late, replayed }. Same errors as POST /me/event-orders/:id/payment plus 400 invalid_method | invalid_paid_on, 403 forbidden { requiredRole }, 409 organization_not_active. 10 per hour per organisation.',
  onGuard: paymentGuard('post'),
  onRequest: (req, res) => inOrganization(req, res, async (access) => {
    const allowed = paymentLimiter.allow(`pay:${access.org.id}`);
    if (!allowed.ok) { res.set?.('Retry-After', String(allowed.retryAfterSeconds)); return { error: 'rate_limited', status: 429, retryAfterSeconds: allowed.retryAfterSeconds }; }
    return payments.initiateCorporate({ access, orderId: req.params.orderId, body: req.body || {}, idempotencyKey: headerOf(req, 'Idempotency-Key'), actorId: req.user.sub });
  }, 201),
};

export const b2bEventOrderPaymentStatus = {
  created, method: 'get', path: '/b2b/organizations/:id/event-orders/:orderId/payment-status',
  description: 'Organisation user with a billing role: where the payment of one corporate order stands (as GET /me/event-orders/:id/payment-status; 120 per hour per user) → { order, payment: PaymentView | null, refund: RefundView | null }. Reads need only EVENTS_REGISTRATION.',
  onGuard: guard('get'),
  onRequest: (req, res) => inOrganization(req, res, async (access) => {
    const allowed = statusLimiter.allow(`status:${req.user.sub}`);
    if (!allowed.ok) { res.set?.('Retry-After', String(allowed.retryAfterSeconds)); return { error: 'rate_limited', status: 429, retryAfterSeconds: allowed.retryAfterSeconds }; }
    return payments.paymentStatus({ access, orderId: req.params.orderId });
  }),
};

export const b2bEventOrderCancelPreview = {
  created, method: 'get', path: '/b2b/organizations/:id/event-orders/:orderId/cancel-preview',
  description: 'Organisation user with a billing role: what cancelling the whole PAID corporate order would refund (read-only; same shape as GET /me/event-orders/:id/cancel-preview; 60 per hour).',
  onGuard: guard('get'),
  onRequest: (req, res) => inOrganization(req, res, async (access) => {
    const allowed = previewLimiter.allow(`preview:${req.user.sub}`);
    if (!allowed.ok) { res.set?.('Retry-After', String(allowed.retryAfterSeconds)); return { error: 'rate_limited', status: 429, retryAfterSeconds: allowed.retryAfterSeconds }; }
    return refunds.previewOrder({ access, orderId: req.params.orderId });
  }),
};

export const resendB2BEventClaimInvitation = {
  created, method: 'post', path: '/b2b/organizations/:id/event-orders/:orderId/claim-invitations',
  description: 'Organisation user with a billing role: send the claim invitation for one unclaimed place of a PAID corporate order again. Body { registrationId } → { sent, channel, nextAllowedAt, invalidatesPreviousLink } (the previous link stops working). 3 per day per place and at most 5 sends: 409 resend_limit_reached.',
  onGuard: guard('post'),
  onRequest: (req, res) => inOrganization(req, res, async (access) => {
    const allowed = resendLimiter.allow(`resend:${req.body?.registrationId}`);
    if (!allowed.ok) { res.set?.('Retry-After', String(allowed.retryAfterSeconds)); return { error: 'rate_limited', status: 429, retryAfterSeconds: allowed.retryAfterSeconds }; }
    return payments.resendClaim({ access, orderId: req.params.orderId, registrationId: req.body?.registrationId });
  }),
};
