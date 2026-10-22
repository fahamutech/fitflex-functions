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
import { requireEventsRegistration } from '../src/shared/feature-flags.mjs';
import { b2bService, eventsRosterService as svc } from '../src/bootstrap/services.mjs';

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
  description: 'Organisation user (beneficiaries.manage): check a roster without writing anything. Body { eventId, rows?: [{ firstName | name, lastName?, phone?, email?, category, ticketType?, dateOfBirth? (YYYY-MM-DD or DD/MM/YYYY), gender?, kitSize?, group? }], rawText?: CSV (header aliases in any order; without a header: first name, last name, phone, email, category, date of birth, gender, kit size, group), team?: { create: { name } } } → { rows [{ index, ok, participant, categoryId, ticketTypeId, problems [{ field, code }] }], duplicates [{ index, kind: in_list | already_registered, otherIndex?, registrationStatus? }], summary { total, ok, problems, duplicates }, lines, quote (ok rows only; null when none), availability, fields, consentText, refundPolicy, capacityShort [{ ticketTypeId, requested, remaining }] }. Problem codes: the participant codes + category_unknown | category_closed | ticket_type_unknown | name_incomplete | duplicate_participant. 413 too_many_rows (EVENTS_CORPORATE_MAX_ROWS, 500), 409 organization_not_active | event_not_open, 404 event_not_found | organization_not_found, 403 forbidden.',
  onGuard: guard('post'),
  onRequest: (req, res) => inOrganization(req, res, access => svc.validate({ access, body: req.body || {} })),
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
  description: 'Organisation user with an ORG_BILLING role: cancel an unpaid corporate order (order-level only: fix the list and place a new order). Body { reason: changed_mind | wrong_details | duplicate | other } → { order, registrations, changed }. 400 invalid_reason, 404 order_not_found, 409 invalid_transition.',
  onGuard: guard('post'),
  onRequest: (req, res) => inOrganization(req, res, access => svc.cancelOrder({ access, orderId: req.params.orderId, body: req.body || {}, actorId: req.user.sub })),
};
