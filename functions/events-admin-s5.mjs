// Marathon & running events · S5 — FitFlex admin routes for the payout schedule and the integrations of an organizer (spec §3.1, §5.8).
// Portal ACL scope `events`. Every route answers 404 feature_disabled while EVENTS_MODULE is off. The payout schedule is a label for the
// later settlement slice: nothing here promises a date or an amount. Guards are wrapped in routeGuard.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsModule, requireEventsOrganizerApi, requireEventsWebhooks, eventsOrganizerApiOn, eventsWebhooksOn } from '../src/shared/feature-flags.mjs';
import { eventsAdminService as svc, eventsIntegrationsService as clients, eventsWebhookService as hooks } from '../src/bootstrap/services.mjs';
import { eventCatalogueStore } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const guard = (method, flag = requireEventsModule) => routeGuard(method, [flag, requireAuth('admin'), requireAcl('events')]);
function send(res, result, okStatus = 200) {
  if (result?.error) { const { error, status, ...extra } = result; return res.status(status || 400).json({ error, ...extra }); }
  return res.status(okStatus).json(result);
}
const organizerOfEvent = async eventId => (await eventCatalogueStore.loadJoined(eventId))?.event?.organizerId ?? null;

export const adminChangePayoutSchedule = {
  created, method: 'post', path: '/admin/events/:id/payout-schedule',
  description: 'Admin (scope events): change the payout schedule of a PUBLISHED (or later) event — the only way it changes after the organizer submitted (D33). Body { payoutSchedule: biweekly | monthly, reason (10–300, saved in the audit log) } → { payoutSchedule, changed }. Writes AuditLog events.payout_schedule_changed { before, after, reason }, an EventChangeLog row (not material) and a bilingual notice to the organizer\'s owner and admins. 404 event_not_found; 409 invalid_transition (draft / submitted / cancelled / archived); 422 event_invalid { fields [{ path: payoutSchedule, code: invalid }] } | reason_required.',
  onGuard: guard('post'),
  onRequest: async (req, res) => send(res, await svc.changePayoutSchedule({ eventId: req.params.id, body: req.body || {}, actorId: req.user.sub })),
};

export const adminEventIntegrations = {
  created, method: 'get', path: '/admin/events/:id/integrations',
  description: 'Admin (scope events): the organizer\'s integrations at a glance for incident response → { organizerId, apiAccessEnabled, activeClients, activeEndpoints, lastDeliveryFailureAt }. Counts only; no secrets, no client ids.',
  onGuard: guard('get'),
  onRequest: async (req, res) => {
    const organizerId = await organizerOfEvent(req.params.id);
    if (!organizerId) return res.status(404).json({ error: 'event_not_found' });
    return send(res, { organizerId, ...(await clients.adminSummary({ organizerId })), ...(await hooks.adminSummary({ organizerId })) });
  },
};

export const adminOrganizerApiAccess = {
  created, method: 'post', path: '/admin/events/organizers/:organizerId/api-access',
  description: 'Admin (scope events; EVENTS_ORGANIZER_API): the D39 pilot gate — enable or disable organizer API access for ONE organizer. Body { enabled: true | false, reason (10–300) } → { organizerId, apiAccessEnabled }. Audited as events.api_access_changed. Until enabled (or listed in EVENTS_API_ORGANIZER_ALLOWLIST) an organizer cannot create API clients and existing clients are refused (403 api_access_not_enabled).',
  onGuard: guard('post', requireEventsOrganizerApi),
  onRequest: async (req, res) => send(res, await clients.adminSetApiAccess({ organizerId: req.params.organizerId, enabled: req.body?.enabled === true, reason: req.body?.reason, actorId: req.user.sub })),
};

export const adminRevokeOrganizerApiClients = {
  created, method: 'post', path: '/admin/events/organizers/:organizerId/api-clients/revoke-all',
  description: 'Admin (scope events; EVENTS_ORGANIZER_API): revoke ALL of an organizer\'s API clients at once. Body { reason (10–300) } → { revoked }. Audited as events.admin_api_clients_revoked.',
  onGuard: guard('post', requireEventsOrganizerApi),
  onRequest: async (req, res) => send(res, await clients.adminRevokeAll({ organizerId: req.params.organizerId, reason: req.body?.reason, actorId: req.user.sub })),
};

export const adminDisableOrganizerWebhooks = {
  created, method: 'post', path: '/admin/events/organizers/:organizerId/webhook-endpoints/disable-all',
  description: 'Admin (scope events; EVENTS_WEBHOOKS): disable ALL of an organizer\'s webhook endpoints at once. Body { reason (10–300) } → { disabled }. Audited as events.admin_webhooks_disabled.',
  onGuard: guard('post', requireEventsWebhooks),
  onRequest: async (req, res) => send(res, await hooks.adminDisableAll({ organizerId: req.params.organizerId, reason: req.body?.reason, actorId: req.user.sub })),
};

export const adminSetApiClientRate = {
  created, method: 'patch', path: '/admin/events/api-clients/:id',
  description: 'Admin (scope events; EVENTS_ORGANIZER_API): raise (or lower) one client\'s rate limit. Body { rateLimitPerMinute (1–600) } → { id, rateLimitPerMinute }. Organizers cannot do this.',
  onGuard: guard('patch', requireEventsOrganizerApi),
  onRequest: async (req, res) => send(res, await clients.adminSetRate({ clientId: req.params.id, rateLimitPerMinute: req.body?.rateLimitPerMinute, actorId: req.user.sub })),
};

void eventsOrganizerApiOn; void eventsWebhooksOn;
