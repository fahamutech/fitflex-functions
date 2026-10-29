// Marathon & running events · S2 — organizer REST surface (spec §14.3). Every route answers 404
// feature_disabled while EVENTS_MODULE is off. Guards are wrapped in routeGuard (bfast mounts guards
// method-blind). The caller's organizer and role come from EventOrganizerStaff via events-authz, never
// from the token's copy.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { requireOrganizer, requireActiveOrganizer, requireOpenOrganizer, loadOrganizer, organizerOf } from '../src/auth/events-authz.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsModule, requireEventsRegistration } from '../src/shared/feature-flags.mjs';
import { eventsOrganizerService as svc, eventsRegistrationService as registration, eventsPaymentsService as payments } from '../src/bootstrap/services.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();
const ORGANIZER_TYPES = ['event_organizer', 'organizer_staff'];

function send(res, result, okStatus = 200) {
  if (result?.error) {
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  // A numeric `status` is the HTTP code (201 on creation); a string one (an event status) is payload.
  if (Number.isInteger(result?.status)) { const { status, ...body } = result; return res.status(status).json(body); }
  res.status(okStatus).json(result);
}

// Reads of events and staff need an active or suspended organizer (L2); the overview is open to every status.
const anyOrganizer = method => routeGuard(method, [requireEventsModule, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer()]);
const overview = method => routeGuard(method, [requireEventsModule, requireAuth(...ORGANIZER_TYPES), requireOrganizer()]);
const editors = method => routeGuard(method, [requireEventsModule, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer('owner', 'admin')]);
const staffManagers = method => routeGuard(method, [requireEventsModule, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer('owner', 'admin')]);

// ── Capability ────────────────────────────────────────────────────────────

export const createOrganizer = {
  created, method: 'post', path: '/me/organizer',
  description: 'Signed-in member, trainer, gym owner or vendor: request the event-organizer capability. Body { name (2–80), timezone? (IANA, default Africa/Dar_es_Salaam), contactPhone (TZ), contactEmail? }. Creates the event_organizer persona under the caller\'s Person, the EventOrganizer (draft), its owner staff row, the partner KYC case (partnerType event_organizer) and the organizer membership. → 201 { organizer, kycCaseId, personaId }. 409 organizer_exists, 400 invalid_name | invalid_phone | invalid_email | invalid_timezone, 403 persona_not_allowed (staff, HR, admin, portal users, or no Person). EVENTS_MODULE off → 404 feature_disabled.',
  onGuard: routeGuard('post', [requireEventsModule, requireAuth()]),
  onRequest: async (req, res) => send(res, await svc.createOrganizer({ claims: req.user, body: req.body || {} }), 201),
};

export const organizerMe = {
  created, method: 'get', path: '/organizer/me',
  description: 'Organizer owner / staff: who I am for the organizer portal → { organizer: { id, name, status, timezone, kycCaseId, kycStatus, statusReasonCode, statusReason }, role, permissions[] }. status is derived from the KYC case (draft | pending_review | active | rejected | suspended). statusReasonCode is the KYC case reasonCode as a partner may see it: a sensitive code (suspected_fraud, duplicate_partner) is sent as under_review, and then statusReason (the reviewer\'s note) is null; statusReason is also null when the case has no reason code. 404 no_organizer when this persona holds no active organizer role.',
  onGuard: routeGuard('get', [requireEventsModule, requireAuth(...ORGANIZER_TYPES), loadOrganizer]),
  onRequest: async (req, res) => {
    const ctx = organizerOf(req);
    if (!ctx) return res.status(404).json({ error: 'no_organizer' });
    send(res, await svc.me({ ctx }));
  },
};

export const organizerSummary = {
  created, method: 'get', path: '/organizer/summary',
  description: 'Organizer owner / staff: overview numbers → { eventsTotal, publishedTotal, registrationsTotal, awaitingPaymentTotal, confirmedTotal, nextEvents[≤3] }. The three registration totals are 0 until S3.',
  onGuard: overview('get'),
  onRequest: async (req, res) => send(res, await svc.summary({ ctx: organizerOf(req) })),
};

// ── Events ────────────────────────────────────────────────────────────────

export const organizerListEvents = {
  created, method: 'get', path: '/organizer/events',
  description: 'Organizer owner / staff (read-only for ops, finance, timing): my events. ?status=<event status>&type=<road|trail|fun|charity|virtual>&cursor&limit (≤50). → { items: [summary + status, categoriesCount, distancesM, updatedAt, allowedActions[]], nextCursor, total }. Visible while suspended (no actions).',
  onGuard: anyOrganizer('get'),
  onRequest: async (req, res) => send(res, await svc.listEvents({ ctx: organizerOf(req), query: req.query || {} })),
};

export const organizerCreateEvent = {
  created, method: 'post', path: '/organizer/events',
  description: 'Organizer owner / admin (organizer active): create a draft. Body { title (3–80) } → 201 { id, version }. 403 organizer_not_active | organizer_suspended | forbidden_role; 422 event_invalid.',
  onGuard: editors('post'),
  onRequest: async (req, res) => send(res, await svc.createEvent({ ctx: organizerOf(req), body: req.body || {}, actorId: req.user.sub }), 201),
};

export const organizerGetEvent = {
  created, method: 'get', path: '/organizer/events/:id',
  description: 'Organizer owner / staff: the full editable document (both languages always) + status, version, allowedActions, submittedAt, rejection { reason, note, at } | null, changeLogCount. 403 not_your_organizer for another organizer\'s event (existence is never revealed).',
  onGuard: anyOrganizer('get'),
  onRequest: async (req, res) => send(res, await svc.getEvent({ ctx: organizerOf(req), eventId: req.params.id })),
};

export const organizerPatchEvent = {
  created, method: 'patch', path: '/organizer/events/:id',
  description: 'Organizer owner / admin: save part of the document. Body { version (required, compare-and-set), ...partial fields: title, type, description { en, sw }, timezone, startsAt, endsAt, registrationOpensAt, registrationClosesAt, heroImageUrl, heroThumbUrl, heroImageAlt (alias coverAlt), venue { name, address, city, region, lat, lng }, routeUrl, routeImageUrl, routeImageAlt, accessibility { en, sw }, kitProvided, inclusions { en, sw }, categories [ { id?, name, distanceM, startsAt, capacity|null, eligibility { en, sw }, minAge, ticketTypes [ { id?, name, priceTzs, capacity|null, saleOpensAt, saleClosesAt, minPerOrder, maxPerOrder } ] } ] (full list: rows with id are updated, without id created, missing rows removed or made inactive when they carry inventory), collectionPoints [ { id?, name, address, lat, lng, windows [ { opensAt, closesAt } ], instructions { en, sw } } ], schedule [ { at, label { en, sw } } ], sponsors [ { name, logoUrl, url } ], contact { email, phone, whatsapp }, terms { en, sw }, refundPolicy { preset, text { en, sw } }, changeNote { en, sw }? }. status, slug, version bumps, publishedAt, cancelledAt and the frozen snapshots are never taken from the body. → { version, updatedAt, material }. 409 version_conflict, 422 event_invalid { fields: [{ path, code }] } (codes: required, length, wholeShillings, range, endAfterStart, closeBeforeStart, withinEvent, withinRegistration, beforeEvent, startsTooSoon, tooLong, unique, bothLanguages, httpsOnly, phone, email, minCategory, minTicket, maxGteMin, pinRequired, altRequired, frozen), 409 change_note_required { fields } for a material edit of a published event without changeNote, 409 invalid_transition when the status is not editable (submitted, in_progress, completed, cancelled, archived), 403 not_your_organizer | organizer_not_active | organizer_suspended | forbidden_role. Every save of a published event writes an EventChangeLog row.',
  onGuard: editors('patch'),
  onRequest: async (req, res) => send(res, await svc.patchEvent({ ctx: organizerOf(req), eventId: req.params.id, body: req.body || {}, actorId: req.user.sub })),
};

export const organizerDeleteEvent = {
  created, method: 'delete', path: '/organizer/events/:id',
  description: 'Organizer owner / admin: delete a draft (only a draft, and only one without a change-log history). → { deleted: true }. 409 invalid_transition otherwise.',
  onGuard: editors('delete'),
  onRequest: async (req, res) => send(res, await svc.deleteEvent({ ctx: organizerOf(req), eventId: req.params.id, actorId: req.user.sub })),
};

const transitionRoute = (action, description) => ({
  created, method: 'post', path: `/organizer/events/:id/${action}`,
  description,
  onGuard: editors('post'),
  onRequest: async (req, res) => send(res, await svc.transition({ ctx: organizerOf(req), eventId: req.params.id, action, body: req.body || {}, actorId: req.user.sub })),
});

export const organizerSubmitEvent = transitionRoute('submit', 'Organizer owner / admin: submit a draft for FitFlex review (D11). Runs the full validation checklist (422 event_invalid { fields }) and freezes the terms and refund-policy snapshots. → { status: "submitted" }. 409 invalid_transition.');
export const organizerWithdrawEvent = transitionRoute('withdraw', 'Organizer owner / admin: take a submitted event back to draft. → { status: "draft" }. 409 invalid_transition.');
export const organizerCancelEvent = transitionRoute('cancel', 'Organizer owner / admin: cancel a published / registration-closed / in-progress event. Body { reason: weather | permit | safety | low_turnout | organizer_decision | other, note { en, sw }? }. → { status: "cancelled" }. 400 reason_code_required; 409 has_registrations once any confirmed registration exists (D12: ask FitFlex to cancel); 409 invalid_transition.');
export const organizerCompleteEvent = transitionRoute('complete', 'Organizer owner / admin: mark an in-progress event completed. → { status: "completed" }. 409 invalid_transition.');
export const organizerArchiveEvent = transitionRoute('archive', 'Organizer owner / admin: archive a completed or cancelled event. → { status: "archived" }. 409 invalid_transition.');

export const organizerEventChanges = {
  created, method: 'get', path: '/organizer/events/:id/changes',
  description: 'Organizer owner / staff: the change log of an event, newest first. ?cursor&limit → { items: [{ id, at, actor { name, role }, fields[], material, note { en, sw } | null, before, after }], nextCursor, total }.',
  onGuard: anyOrganizer('get'),
  onRequest: async (req, res) => send(res, await svc.changes({ ctx: organizerOf(req), eventId: req.params.id, query: req.query || {} })),
};

// ── Registrations and orders (S3 spec §3.13; EVENTS_REGISTRATION on, else 404 feature_disabled) ──
// Reads only (D12: no organizer cancel). Another organizer's event → 404 event_not_found (existence not revealed).
const rosterReaders = method => routeGuard(method, [requireEventsRegistration, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer('owner', 'admin', 'ops', 'timing')]);
const orderReaders = method => routeGuard(method, [requireEventsRegistration, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer('owner', 'admin', 'finance')]);

export const organizerRegistrationsSummary = {
  created, method: 'get', path: '/organizer/events/:id/registrations/summary',
  description: 'Organizer owner / admin / ops / timing (EVENTS_REGISTRATION on): counts → { byStatus { reserved, confirmed, cancelled }, byCategory [{ categoryId, name, capacity, sold, held }] }. 404 event_not_found for another organizer\'s event.',
  onGuard: rosterReaders('get'),
  onRequest: async (req, res) => send(res, await registration.organizerRegistrationsSummary({ ctx: organizerOf(req), eventId: req.params.id })),
};

export const organizerListRegistrations = {
  created, method: 'get', path: '/organizer/events/:id/registrations',
  description: 'Organizer owner / admin / ops / timing (EVENTS_REGISTRATION on): the roster, created desc. ?status=reserved|confirmed|cancelled&categoryId&q (full name, confirmed rows only)&cursor&limit → { items [{ id, participant { name }, categoryName, ticketTypeName, status, orderReference, teamName, kitSize, createdAt, claimed }], nextCursor, total }. Before payment names are masked ("A*** M*****") and kitSize is null; never phone, email, DOB, gender or emergency contact. 404 event_not_found for another organizer\'s event.',
  onGuard: rosterReaders('get'),
  onRequest: async (req, res) => send(res, await registration.organizerListRegistrations({ ctx: organizerOf(req), eventId: req.params.id, query: req.query || {} })),
};

export const organizerListOrders = {
  created, method: 'get', path: '/organizer/events/:id/orders',
  description: 'Organizer owner / admin / finance (EVENTS_REGISTRATION on): orders of my event, newest first. ?status&cursor&limit → { items [{ id, reference, status, purchaser { type: member | organization, label (masked member name or organisation name) }, placesCount, totalTzs, feesTzs, currency, createdAt, holdExpiresAt, closedAt, closeReason }], nextCursor, total }. 404 event_not_found for another organizer\'s event.',
  onGuard: orderReaders('get'),
  onRequest: async (req, res) => send(res, await registration.organizerListOrders({ ctx: organizerOf(req), eventId: req.params.id, query: req.query || {} })),
};

// ── Staff ─────────────────────────────────────────────────────────────────

export const organizerListStaff = {
  created, method: 'get', path: '/organizer/staff',
  description: 'Organizer owner / admin: the staff list → { items: [{ id, userId, displayName, maskedContact, role, status: active | invited, addedAt }] } (open invitations appear as status invited with the invitation id). 403 forbidden_role for ops / finance / timing.',
  onGuard: staffManagers('get'),
  onRequest: async (req, res) => send(res, await svc.listStaff({ ctx: organizerOf(req) })),
};

export const organizerInviteStaff = {
  created, method: 'post', path: '/organizer/staff',
  description: 'Organizer owner / admin (organizer active): invite a staff member through the start-PIN invitation flow (org type organizer). Body { email | phone, role: admin | ops | finance | timing, locale? } (a userId is not accepted: 400 invalid_contact). → 201 { invitation: { id, role, status: "invited", maskedContact, expiresAt, delivery } }. 409 already_staff, 400 invalid_contact | invalid_role, 422 cannot_invite_self, 403 forbidden_role | organizer_not_active | organizer_suspended. Accepting needs the invited person\'s own session (V2_INVITES on).',
  onGuard: routeGuard('post', [requireEventsModule, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer('owner', 'admin')]),
  onRequest: async (req, res) => send(res, await svc.inviteStaff({ ctx: organizerOf(req), body: req.body || {}, actorId: req.user.sub }), 201),
};

export const organizerChangeStaffRole = {
  created, method: 'patch', path: '/organizer/staff/:id',
  description: 'Organizer owner / admin: change a staff member\'s role. Body { role: admin | ops | finance | timing } → { id, role }. The owner cannot be changed (409 cannot_remove_owner); an admin cannot change another admin (403 forbidden_role).',
  onGuard: routeGuard('patch', [requireEventsModule, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer('owner', 'admin')]),
  onRequest: async (req, res) => send(res, await svc.changeStaffRole({ ctx: organizerOf(req), staffId: req.params.id, body: req.body || {}, actorId: req.user.sub })),
};

export const organizerRemoveStaff = {
  created, method: 'delete', path: '/organizer/staff/:id',
  description: 'Organizer owner / admin: remove a staff member (or withdraw an open invitation by its id). → { removed: true }. 409 cannot_remove_owner | cannot_remove_self; 403 forbidden_role (an admin removing another admin); 404 staff_not_found.',
  onGuard: routeGuard('delete', [requireEventsModule, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer('owner', 'admin')]),
  onRequest: async (req, res) => send(res, await svc.removeStaff({ ctx: organizerOf(req), staffId: req.params.id, actorId: req.user.sub })),
};

// ── S4: finance (totals only; never payer details) ────────────────────────

const financeLimiter = createVendorLimiter({ perMinute: 60, windowMs: 3_600_000 });
/** For specs: clear the finance window. */
export const resetEventsOrganizerLimits = () => financeLimiter.reset();

export const organizerEventFinance = {
  created, method: 'get', path: '/organizer/events/:id/finance',
  description: 'Organizer finance / owner / admin (EVENTS_REGISTRATION on; suspended organizers may read; other roles 403 forbidden_role): the money of one of MY events, totals only → { eventId, currency: "TZS", asOf, paidTzs (collected), refundedTzs, refundPendingTzs, awaitingPaymentTzs (held, not income), commissionPct, commissionTzs (on money kept, from the rate stamped at confirmation), expectedNetTzs, orders { paid, refunded, partlyRefunded }, byTicketType [{ ticketTypeId, name, sold, grossTzs }], settlement { state: "not_started" } }. Never a payer name, phone, transaction ID, payment method or refund destination, and no per-order rows. 404 event_not_found for another organizer\'s event; 429 rate_limited (60/h).',
  onGuard: routeGuard('get', [requireEventsRegistration, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer('finance', 'owner', 'admin')]),
  onRequest: async (req, res) => {
    if (limitOrNull(financeLimiter, `f:${req.user.sub}`, res)) return undefined;
    return send(res, await payments.organizerFinance({ ctx: organizerOf(req), eventId: req.params.id }));
  },
};
