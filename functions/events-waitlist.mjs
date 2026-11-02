// Marathon & running events · S7 — the waitlist (docs/design/events-s7-hardening-and-pilot.md §4.9). RULE 6 AREA (owner reviews, D35).
// Every route answers 404 feature_disabled unless EVENTS_MODULE, EVENTS_REGISTRATION and EVENTS_WAITLIST are on (before sign-in is checked).
// Members join, leave and read their own entries; organizers see COUNTS only (no names, no positions, no promote button, D75); FitFlex admin
// (scope events) sees a masked list and may remove an entry with a reason. Paths with a fixed sub-path are declared before /:id siblings.
import '../src/bootstrap/init.mjs';
import { noteApiError } from '../src/shared/events-api-error.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { requireActiveOrganizer, requireOpenOrganizer, organizerOf } from '../src/auth/events-authz.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsWaitlist } from '../src/shared/feature-flags.mjs';
import { eventsWaitlistService as svc } from '../src/bootstrap/services.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();
const joinLimiter = createVendorLimiter({ perMinute: 10, windowMs: 3_600_000 });
const writeLimiter = createVendorLimiter({ perMinute: 60 });
/** For specs: clear the windows. */
export const resetEventsWaitlistLimits = () => { joinLimiter.reset(); writeLimiter.reset(); };
const ORGANIZER_TYPES = ['event_organizer', 'organizer_staff'];

function send(res, result, okStatus = 200) {
  if (result?.error) { noteApiError('registration', result.status || 400); const { error, status, ...extra } = result; return res.status(status || 400).json({ error, ...extra }); }
  const { status, ...body } = result ?? {};
  return res.status(Number.isInteger(status) ? status : okStatus).json(body);
}
const member = method => routeGuard(method, [requireEventsWaitlist, requireAuth('member')]);
const orgRead = method => routeGuard(method, [requireEventsWaitlist, requireAuth(...ORGANIZER_TYPES), requireOpenOrganizer('owner', 'admin', 'ops', 'finance')]);
const orgWrite = method => routeGuard(method, [requireEventsWaitlist, requireAuth(...ORGANIZER_TYPES), requireActiveOrganizer('owner', 'admin')]);
const admin = method => routeGuard(method, [requireEventsWaitlist, requireAuth('admin'), requireAcl('events')]);
const headerOf = (req, name) => req.headers?.[name] ?? req.headers?.[name.toLowerCase()] ?? null;

export const joinEventWaitlist = {
  created, method: 'post', path: '/me/events/:id/waitlist',
  description: 'Member (EVENTS_WAITLIST on): join the waitlist of a SOLD-OUT ticket type, for yourself only (D70). Body { ticketTypeId, participants: [one self participant exactly as the checkout takes it], consent: { accepted: true, textVersion }, locale? } → 201 { entry { id, status: "waiting", position, ticketTypeId, ticketTypeName, categoryName, priceTzs, currency, joinedAt } }. Waiting costs nothing; nothing is held. 404 event_not_found; 409 not_sold_out | waitlist_unavailable { reason } | already_registered | waitlist_full | waitlist_limit_reached { max } | waitlist_lapse_limit; 403 verification_required; 422 validation_failed { fields } | consent_required { current }; 429 rate_limited (10 an hour).',
  onGuard: member('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(joinLimiter, `j:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.join({ userId: req.user.sub, eventId: req.params.id, body: req.body || {} }), 201);
  },
};

export const listMyEventWaitlist = {
  created, method: 'get', path: '/me/event-waitlist',
  description: 'Member (EVENTS_WAITLIST on): my waitlist entries, live first-class and recently ended → { items [{ id, eventId, eventTitle, startsAt, timezone, ticketTypeName, categoryName, status: waiting | offered | converted | expired | declined | left | removed | closed, position? (waiting only), joinedAt, blockedReason? ("reconsent"), offer? { orderId, expiresAt, amountTzs, currency } (offered), endedAt?, endedReason? }], serverTime }. The queue length is never shown. Count down from serverTime, never the phone clock.',
  onGuard: member('get'),
  onRequest: async (req, res) => send(res, await svc.list({ userId: req.user.sub })),
};

export const leaveMyEventWaitlist = {
  created, method: 'delete', path: '/me/event-waitlist/:id',
  description: 'Member: leave the waitlist. A waiting entry becomes left; an offered one cancels the held order (declined). → 200 { entry { id, status } }. 404 entry_not_found; 409 already_ended | payment_pending (a manual payment is waiting for a decision: use the order cancel and refund flow).',
  onGuard: member('delete'),
  onRequest: async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.leave({ userId: req.user.sub, entryId: req.params.id }));
  },
};

export const reconfirmMyEventWaitlist = {
  created, method: 'post', path: '/me/event-waitlist/:id/reconfirm',
  description: 'Member: accept the new consent text after it changed while waiting (the entry keeps its place). Body { consent: { accepted: true, textVersion } } → 200 { entry { id, status, position } }. 409 not_blocked; 422 consent_required { current }.',
  onGuard: member('post'),
  onRequest: async (req, res) => send(res, await svc.reconfirm({ userId: req.user.sub, entryId: req.params.id, body: req.body || {} })),
};

export const organizerWaitlistCounts = {
  created, method: 'get', path: '/organizer/events/:id/waitlist',
  description: 'Organizer owner / admin / ops / finance (EVENTS_WAITLIST; a suspended organizer may read): COUNTS only → { enabled, closedAt, byTicketType [{ ticketTypeId, name, waiting, offered, converted, expired, left }], totals }. No names, no positions, no way to reorder, skip or promote (D75).',
  onGuard: orgRead('get'),
  onRequest: async (req, res) => send(res, await svc.organizerCounts({ organizerId: organizerOf(req).organizer.id, eventId: req.params.id })),
};

export const organizerWaitlistToggle = {
  created, method: 'patch', path: '/organizer/events/:id/waitlist',
  description: 'Organizer owner / admin (EVENTS_WAITLIST; active organizer): stop or resume NEW sign-ups. Body { enabled: boolean } → { enabled, closedAt: null }. Allowed after publish (not a material change). 409 waitlist_closed; 422 validation_failed.',
  onGuard: orgWrite('patch'),
  onRequest: async (req, res) => send(res, await svc.organizerToggle({ actorId: req.user.sub, organizerId: organizerOf(req).organizer.id, eventId: req.params.id, body: req.body || {} })),
};

export const organizerWaitlistClose = {
  created, method: 'post', path: '/organizer/events/:id/waitlist/close',
  description: 'Organizer owner / admin (EVENTS_WAITLIST; active organizer): end the line for good. Everyone still waiting is told; offers already made run to their end. Irreversible. Body {} → { enabled: false, closedAt, closed }. Closing twice answers the first close time with closed: 0.',
  onGuard: orgWrite('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(writeLimiter, `w:${req.user.sub}`, res)) return undefined;
    return send(res, await svc.organizerClose({ actorId: req.user.sub, organizerId: organizerOf(req).organizer.id, eventId: req.params.id }));
  },
};

export const adminEventWaitlist = {
  created, method: 'get', path: '/admin/events/:id/waitlist',
  description: 'Admin (scope events; EVENTS_WAITLIST): a masked list of the entries of an event, in line order. ?ticketTypeId&status&cursor&limit (≤200) → { items [{ id, seq, status, ticketTypeId, joinedAt, name ("Amina M.") }], nextCursor }. No contact data.',
  onGuard: admin('get'),
  onRequest: async (req, res) => send(res, await svc.adminList({ eventId: req.params.id, query: req.query || {} })),
};

export const adminRemoveWaitlistEntry = {
  created, method: 'post', path: '/admin/events/:id/waitlist/:entryId/remove',
  description: 'Admin (scope events; EVENTS_WAITLIST): remove an entry. Body { reason (10-300), reasonSw? (10-300) } → { entry { id, status: "removed" } }. An offered entry cancels its unpaid held order. The member is told (Swahili text: reasonSw, else the English reason marked "(kwa Kiingereza)"). Audited as events.waitlist_removed. 404 entry_not_found; 409 already_ended | payment_pending; 422 reason_required.',
  onGuard: admin('post'),
  onRequest: async (req, res) => send(res, await svc.adminRemove({ actorId: req.user.sub, eventId: req.params.id, entryId: req.params.entryId, body: req.body || {} })),
};

void headerOf;
