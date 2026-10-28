// Marathon & running events · S2 — FitFlex admin moderation (spec §8, §14.4). Portal ACL scope `events`
// (KYC decisions on the organizer still need `kyc`). Every route answers 404 feature_disabled while
// EVENTS_MODULE is off. Routes with fixed sub-paths (summary, audit) are declared before /:id so they
// are mounted first.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsModule, requireEventsRegistration } from '../src/shared/feature-flags.mjs';
import { eventsAdminService as svc, eventsRegistrationService as registration } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const guard = method => routeGuard(method, [requireEventsModule, requireAuth('admin'), requireAcl('events')]);
// S3: order and registration views need EVENTS_REGISTRATION too (404 feature_disabled otherwise).
const registrationGuard = method => routeGuard(method, [requireEventsRegistration, requireAuth('admin'), requireAcl('events')]);

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
  description: 'Admin (scope events): cancel a published / registration-closed / in-progress event, registrations or not. Body { reason: weather | permit | safety | low_turnout | organizer_decision | other, note { en, sw }? } → { status: "cancelled" }. 400 reason_code_required, 409 invalid_transition.',
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
  description: 'Admin (scope events): one order with lines and registrations (full names; no emergency contact) + purchaser { type, id, label }, createdBy, team, allowedActions: ["cancel"] while awaiting payment. 404 order_not_found (also when the order belongs to another event).',
  onGuard: registrationGuard('get'),
  onRequest: async (req, res) => send(res, await registration.adminGetOrder({ eventId: req.params.id, orderId: req.params.orderId })),
};

export const adminCancelEventOrder = {
  created, method: 'post', path: '/admin/events/:id/orders/:orderId/cancel',
  description: 'Admin (scope events): cancel an unpaid order (releaseOrder with reason admin). Body { note? (≤500) } → { order, registrations, changed }. Writes AuditLog events.order_cancelled with the note and tells the purchaser. 409 invalid_transition for confirmed orders (refunds are S4), 404 order_not_found.',
  onGuard: registrationGuard('post'),
  onRequest: async (req, res) => send(res, await registration.adminCancelOrder({ eventId: req.params.id, orderId: req.params.orderId, body: req.body || {}, actorId: req.user.sub })),
};

export const adminListEventRegistrations = {
  created, method: 'get', path: '/admin/events/:id/registrations',
  description: 'Admin (scope events): the roster with full names and kit sizes (never phone, email, DOB, gender or emergency contact in the list). ?status&categoryId&q&cursor&limit → { items [{ id, participant { name }, categoryName, ticketTypeName, status, orderReference, orderStatus, teamName, kitSize, createdAt, claimed, consentBasis, groupLabel }], nextCursor, total }. 404 event_not_found.',
  onGuard: registrationGuard('get'),
  onRequest: async (req, res) => send(res, await registration.adminListRegistrations({ eventId: req.params.id, query: req.query || {} })),
};
