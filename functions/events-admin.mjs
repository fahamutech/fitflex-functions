// Marathon & running events · S2 — FitFlex admin moderation (spec §8, §14.4). Portal ACL scope `events`
// (KYC decisions on the organizer still need `kyc`). Every route answers 404 feature_disabled while
// EVENTS_MODULE is off. Routes with fixed sub-paths (summary, audit) are declared before /:id so they
// are mounted first.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsModule, requireEventsRegistration } from '../src/shared/feature-flags.mjs';
import { eventsAdminService as svc, eventsRegistrationService as registration, eventsPaymentsService as payments, eventsRefundsService as refunds } from '../src/bootstrap/services.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();
const guard = method => routeGuard(method, [requireEventsModule, requireAuth('admin'), requireAcl('events')]);
// S3: order and registration views need EVENTS_REGISTRATION too (404 feature_disabled otherwise).
const registrationGuard = method => routeGuard(method, [requireEventsRegistration, requireAuth('admin'), requireAcl('events')]);
// S4: money steps (repair, refund batch) are `payments`-scope work, not `events`.
const paymentsGuard = method => routeGuard(method, [requireEventsModule, requireAuth('admin'), requireAcl('payments')]);
const financeLimiter = createVendorLimiter({ perMinute: 60, windowMs: 3_600_000 });
/** For specs: clear the finance window. */
export const resetEventsAdminLimits = () => financeLimiter.reset();
/** The payments scope (or a super-admin) sees the payer's phone in full; `events` alone sees it masked. */
const hasPaymentsScope = req => !req.user?.portalUser || (Array.isArray(req.user?.aclPermissions) && req.user.aclPermissions.includes('payments'));

function send(res, result, okStatus = 200) {
  if (result?.error) {
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  res.status(okStatus).json(result);
}

export const adminListEvents = {
  created, method: 'get', path: '/admin/events',
  description: 'Admin (scope events): the moderation queue. ?status=submitted|published|cancelled|…|all (default all; submitted first)&cursor&limit (≤50) → { items: [summary + status, categoriesCount, allowedActions[], submittedAt, organizer { id, name, status, kycCaseId, permitOnFile }, permitOnFile], nextCursor, total }.',
  onGuard: guard('get'),
  onRequest: async (req, res) => send(res, await svc.list({ query: req.query || {} })),
};

export const adminEventsSummary = {
  created, method: 'get', path: '/admin/events/summary',
  description: 'Admin (scope events): nav count → { submitted: n }.',
  onGuard: guard('get'),
  onRequest: async (_req, res) => send(res, await svc.summary()),
};

export const adminEventsAudit = {
  created, method: 'get', path: '/admin/events/audit',
  description: 'Admin (scope events): every events.* audit row, newest first. ?action=<events.published | published | …>&cursor&limit → { items: [{ id, at, actor { id, name }, action, target, reason, note, before, after }], nextCursor, total }.',
  onGuard: guard('get'),
  onRequest: async (req, res) => send(res, await svc.audit({ query: req.query || {} })),
};

export const adminGetEvent = {
  created, method: 'get', path: '/admin/events/:id',
  description: 'Admin (scope events): the full document (as the organizer sees it, both languages) + organizer { id, name, status, kycCaseId, permitOnFile }, permitOnFile and the admin allowedActions (approve | reject | edit | cancel | complete | archive). 404 event_not_found.',
  onGuard: guard('get'),
  onRequest: async (req, res) => send(res, await svc.detail({ eventId: req.params.id })),
};

export const adminDecideEvent = {
  created, method: 'post', path: '/admin/events/:id/decision',
  description: 'Admin (scope events): decide a submitted event. Body { decision: approve | reject, reason? (reject: incomplete_details | permit_missing | pricing_unclear | terms_unclear | duplicate_event | policy_violation | other), note? (reject: required, ≤500) }. approve → published with publishedAt (needs an active organizer with an approved KYC case: 409 organizer_not_active); reject → draft with rejection { reason, note, at } on the event. → { status, publishedAt? }. 409 invalid_transition, 400 reason_code_required | note_required | invalid_decision. Writes AuditLog (before/after status) and, for published events, EventChangeLog.',
  onGuard: guard('post'),
  onRequest: async (req, res) => send(res, await svc.decision({ eventId: req.params.id, body: req.body || {}, actorId: req.user.sub })),
};

export const adminCancelEvent = {
  created, method: 'post', path: '/admin/events/:id/cancel',
  description: 'Admin (scope events): cancel a published / registration-closed / in-progress event, registrations or not. Body { reason: weather | permit | safety | low_turnout | organizer_decision | other, note { en, sw }?, refundPaidOrders? (default true), expectedRefundableTzs? } → { status: "cancelled", batch? { batchId, created, existing, remaining, amountTzs, released } }. S4: unpaid orders are released; every paid order\'s places are cancelled, tickets revoked and ONE refund request (the full amount paid, fees included) is created per order, in chunks of 200 (re-run POST …/refund-batch while remaining > 0). expectedRefundableTzs is checked BEFORE anything changes (409 refundable_changed { refundableTzs }). 400 reason_code_required, 409 invalid_transition.',
  onGuard: guard('post'),
  onRequest: async (req, res) => send(res, await svc.cancel({ eventId: req.params.id, body: req.body || {}, actorId: req.user.sub })),
};

export const adminCompleteEvent = {
  created, method: 'post', path: '/admin/events/:id/complete',
  description: 'Admin (scope events): mark an in-progress event completed → { status: "completed" }. 409 invalid_transition.',
  onGuard: guard('post'),
  onRequest: async (req, res) => send(res, await svc.complete({ eventId: req.params.id, actorId: req.user.sub })),
};

export const adminArchiveEvent = {
  created, method: 'post', path: '/admin/events/:id/archive',
  description: 'Admin (scope events): archive a completed or cancelled event → { status: "archived" }. 409 invalid_transition.',
  onGuard: guard('post'),
  onRequest: async (req, res) => send(res, await svc.archive({ eventId: req.params.id, actorId: req.user.sub })),
};

export const adminEventAudit = {
  created, method: 'get', path: '/admin/events/:id/audit',
  description: 'Admin (scope events): the audit rows of one event (events.* actions targeting it), newest first. ?cursor&limit → { items: [{ id, at, actor { id, name }, action, target, reason, note, before, after }], nextCursor, total }. 404 event_not_found.',
  onGuard: guard('get'),
  onRequest: async (req, res) => send(res, await svc.eventAudit({ eventId: req.params.id, query: req.query || {} })),
};

// ── S3: orders and registrations of any event (spec §3.8, §3.13) ──────────

export const adminListEventOrders = {
  created, method: 'get', path: '/admin/events/:id/orders',
  description: 'Admin (scope events; EVENTS_REGISTRATION on): orders of an event, newest first, full purchaser names. ?status&cursor&limit → { items [{ id, reference, status, purchaser { type, label }, placesCount, totalTzs, feesTzs, discountTzs, currency, createdAt, holdExpiresAt, closedAt, closeReason, allowedActions, costCentre, purchaserReference }], nextCursor, total }. 404 event_not_found.',
  onGuard: registrationGuard('get'),
  onRequest: async (req, res) => send(res, await registration.adminListOrders({ eventId: req.params.id, query: req.query || {} })),
};

export const adminGetEventOrder = {
  created, method: 'get', path: '/admin/events/:id/orders/:orderId',
  description: 'Admin (scope events): one order with lines and registrations (full names; no emergency contact) + purchaser { type, id, label }, createdBy, team, allowedActions: ["cancel"] while awaiting payment or paid with live places. S4 adds payment (PaymentView), next, refunds[], per-place ticket { state, displayCode } (never a token) and paymentPanel { payments [{ id, status, method, amountTzs, reference, payerPhone (full with the payments scope, masked without), rejectCode, failureReason, late, refundId, organizationId, payerMethod, paidOn }], tickets { issued, cancelled, rows }, refunds[] }. 404 order_not_found (also when the order belongs to another event).',
  onGuard: registrationGuard('get'),
  onRequest: async (req, res) => send(res, await registration.adminGetOrder({ eventId: req.params.id, orderId: req.params.orderId, withPayments: hasPaymentsScope(req) })),
};

export const adminCancelEventOrder = {
  created, method: 'post', path: '/admin/events/:id/orders/:orderId/cancel',
  description: 'Admin (scope events): cancel an unpaid order (releaseOrder with reason admin; a pending payment on it is cancelled with it) or, S4, a PAID order. Paid: body { note (≥5 chars), refundMode: full | policy | none } (full = 100% of what was paid for the live places, policy = as the member would get, 409 policy_not_evaluable on a custom policy, none = no refund and needs the payments scope: 403 payments_scope_required) → { order, registrations, refund: RefundView | null, changed }; the refund is created as REQUESTED for a second admin (payments scope). Writes AuditLog events.order_cancelled with the note and tells the purchaser. 400 note_required | refund_mode_required, 409 refund_in_progress | event_cancelled, 404 order_not_found.',
  onGuard: registrationGuard('post'),
  onRequest: async (req, res) => send(res, await registration.adminCancelOrder({ eventId: req.params.id, orderId: req.params.orderId, body: req.body || {}, actorId: req.user.sub, withPayments: hasPaymentsScope(req) })),
};

export const adminEventOrderCancelPreview = {
  created, method: 'get', path: '/admin/events/:id/orders/:orderId/cancel-preview',
  description: 'Admin (scope events; EVENTS_REGISTRATION on): what cancelling a PAID order would refund under each refundMode, before the dialog confirms → { eligible, blocked: null | event_cancelled | refund_in_progress, paidTzs, currency, releaseInventory, modes { full { refundTzs }, policy { evaluable, mode, percent, refundTzs | null, error? policy_not_evaluable }, none { refundTzs: 0, requiresScope: "payments" } }, policy { preset, text, days?, tiers?, generated { en, sw } }, places [{ registrationId, name, paidTzs, refundTzs }] }. 409 nothing_to_cancel, 404 order_not_found.',
  onGuard: registrationGuard('get'),
  onRequest: async (req, res) => send(res, await refunds.adminOrderCancelPreview({ eventId: req.params.id, orderId: req.params.orderId })),
};

export const adminListEventRegistrations = {
  created, method: 'get', path: '/admin/events/:id/registrations',
  description: 'Admin (scope events): the roster with full names and kit sizes (never phone, email, DOB, gender or emergency contact in the list). ?status&categoryId&q&cursor&limit → { items [{ id, participant { name }, categoryName, ticketTypeName, status, orderReference, orderStatus, teamName, kitSize, createdAt, claimed, consentBasis, groupLabel }], nextCursor, total }. 404 event_not_found.',
  onGuard: registrationGuard('get'),
  onRequest: async (req, res) => send(res, await registration.adminListRegistrations({ eventId: req.params.id, query: req.query || {} })),
};

// ── S4: money steps of events ─────────────────────────────────────────────

export const adminEventCancelPreview = {
  created, method: 'get', path: '/admin/events/:id/cancel-preview',
  description: 'Admin (scope events): what cancelling the event would do to money, before the dialog confirms → { awaitingOrders, awaitingWithSubmittedPayment, paidOrders, paidPlaces, totalPaidTzs, alreadyRefundedTzs, refundableTzs, openRefunds }. Send refundableTzs back as expectedRefundableTzs on the cancel. 404 event_not_found.',
  onGuard: guard('get'),
  onRequest: async (req, res) => send(res, await svc.cancelPreview({ eventId: req.params.id })),
};

export const adminRepairEventPayment = {
  created, method: 'post', path: '/admin/events/:id/orders/:orderId/repair-payment',
  description: 'Admin (scope payments): re-apply an APPROVED event payment whose order is not confirmed (tickets, confirmation). Idempotent; it can never confirm a payment nobody approved. → { repaired, outcome: confirmed | reheld | refund_raised, … }. 409 nothing_to_repair | payment_row_mismatch, 404 order_not_found. Audits events.order_repaired.',
  onGuard: paymentsGuard('post'),
  onRequest: async (req, res) => send(res, await payments.repairOrder({ orderId: req.params.orderId, eventId: req.params.id, actorId: req.user.sub })),
};

export const adminRunEventRefundBatch = {
  created, method: 'post', path: '/admin/events/:id/refund-batch',
  description: 'Admin (scope payments): run or RESUME the refund batch of a cancelled event: unpaid orders released, paid places cancelled with tickets revoked, one `event_cancelled` refund request per paid order (full amount paid), orders refund_pending. Idempotent (a live-unique index per order). Body { note?, expectedRefundableTzs? } → { batchId, created, existing, remaining, amountTzs, released }. 409 event_not_cancelled | refundable_changed { refundableTzs }; 404 event_not_found.',
  onGuard: paymentsGuard('post'),
  onRequest: async (req, res) => send(res, await refunds.runEventBatch({ eventId: req.params.id, actorId: req.user.sub, note: typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null, expectedRefundableTzs: req.body?.expectedRefundableTzs ?? null })),
};

export const adminEventFinance = {
  created, method: 'get', path: '/admin/events/:id/finance',
  description: 'Admin (scope events): the organizer finance totals of one event plus unfulfilledTzs and openReconciliations → { eventId, currency, asOf, paidTzs, refundedTzs, refundPendingTzs, awaitingPaymentTzs, commissionPct, commissionTzs, expectedNetTzs, orders { paid, refunded, partlyRefunded }, byTicketType [{ ticketTypeId, name, sold, grossTzs }], settlement { state: "not_started" }, unfulfilledTzs, openReconciliations }. 60 per hour. 404 event_not_found.',
  onGuard: registrationGuard('get'),
  onRequest: async (req, res) => {
    if (limitOrNull(financeLimiter, `f:${req.user.sub}`, res)) return undefined;
    return send(res, await payments.adminFinance({ eventId: req.params.id }));
  },
};
