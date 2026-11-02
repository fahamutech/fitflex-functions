// Marathon & running events · S7 — FitFlex admin routes added by the hardening slice (docs/design/events-s7-hardening-and-pilot.md §3.13, §6.1).
// Portal ACL scope `events`. Each route answers 404 feature_disabled while its own flag is off. Every path here has a fixed second or third
// segment, so none of them is swallowed by GET /admin/events/:id.
import '../src/bootstrap/init.mjs';
import { noteApiError } from '../src/shared/events-api-error.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsKitOffline, requireEventsModule, requireEventsRewards } from '../src/shared/feature-flags.mjs';
import { eventsKitOfflineService as offline, eventsAdminService as admin } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const guard = (method, flag) => routeGuard(method, [flag, requireAuth('admin'), requireAcl('events')]);
function send(res, result, okStatus = 200) {
  if (result?.error) { noteApiError('admin', result.status || 400); const { error, status, ...extra } = result; return res.status(status || 400).json({ error, ...extra }); }
  const { status, ...body } = result ?? {};
  return res.status(Number.isInteger(status) ? status : okStatus).json(body);
}

export const adminOfflineKit = {
  created, method: 'get', path: '/admin/events/:id/kit-offline',
  description: 'Admin (scope events; EVENTS_KIT_OFFLINE): the offline desks of an event and the review counts, read only → { items [desk as the organizer list], counts { needsReview, checked } }. 404 event_not_found.',
  onGuard: guard('get', requireEventsKitOffline),
  onRequest: async (req, res) => send(res, await offline.adminOverview({ eventId: req.params.id })),
};

export const adminRevokeOfflineDesk = {
  created, method: 'post', path: '/admin/events/:id/kit-offline/devices/:deviceId/revoke',
  description: 'Admin (scope events; EVENTS_KIT_OFFLINE): remove a desk. Body { reason (10-300), reasonSw? (10-300) } → 200 { device }. The desk can still send its unsent scans. Audited as events.kit_offline_device_revoked.',
  onGuard: guard('post', requireEventsKitOffline),
  onRequest: async (req, res) => send(res, await offline.adminRevoke({ eventId: req.params.id, deviceId: req.params.deviceId, body: req.body || {}, actorId: req.user.sub })),
};

export const adminSetRegistrationState = {
  created, method: 'post', path: '/admin/events/:id/registration-state',
  description: 'Admin (scope events): pause or resume ONE event\'s registrations for incident response (D85). Body { state: "closed" | "open", reason (10-300), reasonSw? (10-300) } → { eventStatus: "registration_closed" | "published", from }. closed moves published → registration_closed; open moves registration_closed → published (409 registration_window_over when the registration close time has passed). The organizer\'s owners and admins are told (essential). Audited as events.admin_registration_state_changed. 404 event_not_found; 409 invalid_transition; 422 reason_required | validation_failed.',
  onGuard: guard('post', requireEventsModule),
  onRequest: async (req, res) => send(res, await admin.setRegistrationState({ eventId: req.params.id, body: req.body || {}, actorId: req.user.sub })),
};

export const adminSetRewardsEligible = {
  created, method: 'post', path: '/admin/events/:id/rewards-eligible',
  description: 'Admin (scope events; EVENTS_REWARDS): set whether an event may earn rewards (D80; default false, so no event can farm rewards until FitFlex says so). Medals are unaffected. Body { eligible: boolean, reason (10-300), reasonSw? } → { rewardsEligible, changed }. The organizer is told. Audited as events.rewards_eligible_changed.',
  onGuard: guard('post', requireEventsRewards),
  onRequest: async (req, res) => send(res, await admin.setRewardsEligible({ eventId: req.params.id, body: req.body || {}, actorId: req.user.sub })),
};
