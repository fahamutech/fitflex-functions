// Security activity (S3): the member's own list of security events, first kind 'web_checkin' (a gym check-in made from
// a web browser). Dormant: 404 { error: 'not_found' } unless WEB_QR_CHECKIN is set. Only the caller's own rows.
// Never returned or stored: IP, user agent, client metadata, session or intent ids.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { securityEventService, securityIncidentService } from '../src/bootstrap/services.mjs';
import { webQrCheckinOn, securityIncidentReportsOn } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();
const guard = requireAuth('member', 'trainer');

export const securityActivity = {
  created, method: 'get', path: '/me/security-activity',
  description: 'Member or trainer (404 not_found while WEB_QR_CHECKIN is off): GET ?limit=&before= → { events: [{ id, kind: "web_checkin", occurredAt, gym: { id, name }, channel: "web", status: "inbox" | "recorded", report: null | { incidentId, status: "open"|"acknowledged"|"resolved", reportedAt, protectionPending: boolean, protectionRetryable?: false } }], reportEnabled, next? }. report.protectionPending is true when "secure my account" was asked for but is not in place (reporting the event again retries it); report.protectionRetryable is present only as false (a retry cannot help; contact support). Newest first; only your own events; limit default 20, max 50; pass `next` back as `before` for the following page. gym.id is the same gym id the member gym APIs return. Cache-Control: no-store.',
  onGuard: (req, res, next) => {
    if (!webQrCheckinOn()) { res.set?.('Cache-Control', 'no-store'); return res.status(404).json({ error: 'not_found' }); }
    return guard(req, res, next);
  },
  onRequest: async (req, res) => {
    res.set?.('Cache-Control', 'no-store');
    try {
      const out = await securityEventService.list({ userId: req.user.sub, limit: req.query?.limit, before: req.query?.before });
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json(out);
    } catch {
      res.status(500).json({ error: 'server_error' });
    }
  },
};

export const securityEventRetention = {
  created, rule: '55 2 * * *', // every day 02:55 UTC
  description: 'Security events older than 13 months are deleted. Runs regardless of WEB_QR_CHECKIN and WEB_CHECKIN_ALERTS (purge is data hygiene, not feature behaviour). Idempotent.',
  onJob: async () => {
    const n = await securityEventService.purgeExpired();
    if (n) console.log(`[security-event] retention: deleted ${n} event(s) older than 13 months`);
  },
};

// ── S4b: report an unrecognised web check-in ────────────────────────────────

const sendJson = (res, status, body) => { res.set?.('Cache-Control', 'no-store'); return res.status(status).json(body); };
const reportsOff = (res) => sendJson(res, 404, { error: 'not_found' });
const adminOff = (res) => sendJson(res, 404, { error: 'feature_disabled' });
function send(res, result) {
  if (result.error) { const { error, status, ...extra } = result; return sendJson(res, status, { error, ...extra }); }
  return sendJson(res, 200, result);
}
export const reportSecurityEvent = {
  created, method: 'post', path: '/me/security-activity/:eventId/report',
  description: 'Member or trainer (404 not_found while WEB_QR_CHECKIN or SECURITY_INCIDENT_REPORTS is off): "this check-in was not me". Body { secureAccount?: boolean } (default true). → { ok, idempotent, incident: { id, status, reportedAt }, protection: { requested, sessionsEnded, pinResetRequired: true | false | "not_applicable", limited?, failed?, retryable? }, signedOut }. protection.failed: true = protection was asked for but is not in place (reporting the same event again retries it); protection.retryable is present only as false (the account has no Person record, a retry cannot help). secureAccount true ends every session of the account (signedOut: true: the app must sign out and show sign-in) and, when FitFlex holds a PIN, requires a PIN reset (PIN sign-in answers 403 pin_reset_required until "forgot PIN" is done). After 2 such actions in 24 hours the report is still recorded but nothing is locked again (protection.limited: true). Reporting the same event again returns the same incident (idempotent: true); a repeat ignores secureAccount, so a report-only cannot later be upgraded. It never voids the check-in or changes visits or payouts. Errors: 400 invalid_secure_account; 404 not_found (also another member\'s event); 429 report_limit_reached { retryAfterSeconds } (more than SECURITY_REPORT_MAX_PER_DAY, default 3, new reports in a rolling 24 hours; retryAfterSeconds is the real wait until the oldest counted report is 24 hours old, at least 1). Cache-Control: no-store.',
  requestSample: { secureAccount: true },
  onGuard: (req, res, next) => {
    if (!securityIncidentReportsOn()) return reportsOff(res);
    return guard(req, res, next);
  },
  onRequest: async (req, res) => {
    try {
      send(res, await securityIncidentService.report({ userId: req.user.sub, eventId: req.params?.eventId, secureAccount: req.body?.secureAccount }));
    } catch {
      sendJson(res, 500, { error: 'server_error' });
    }
  },
};

// Order matters: who you are is checked BEFORE the flag, so only authorised staff can learn whether the feature is on.
// No token -> 401; staff without the scope -> 403; authorised staff with the flag off -> 404 feature_disabled.
const adminGuard = [
  requireAuth('admin'), requireAcl('security_incidents'),
  (req, res, next) => (securityIncidentReportsOn() ? next() : adminOff(res)),
];
const adminRun = fn => async (req, res) => {
  try { send(res, await fn(req)); } catch { sendJson(res, 500, { error: 'server_error' }); }
};

export const adminSecurityIncidents = {
  created, method: 'get', path: '/admin/security-incidents',
  description: 'Admin (scope security_incidents; checked in this order on every /admin/security-incidents route: 401 without a valid admin token, 403 acl_forbidden without the scope, then 404 feature_disabled while SECURITY_INCIDENT_REPORTS is off): GET ?status=open|acknowledged|resolved|all (default open + acknowledged)&limit=&before= → { incidents: [{ id, userId, eventId, status, outcome, snapshot, protection, opsExceptionId, reportedAt, acknowledgedAt, acknowledgedBy, resolvedAt, resolvedBy, resolutionReason }], next? }. Newest first; `next` is opaque, pass it back as `before`.',
  onGuard: adminGuard,
  onRequest: adminRun(req => securityIncidentService.list({ status: req.query?.status, limit: req.query?.limit, before: req.query?.before })),
};

export const adminSecurityIncident = {
  created, method: 'get', path: '/admin/security-incidents/:id',
  description: 'Admin (scope security_incidents): one incident with its append-only trail { incident, events: [{ id, kind, actor, detail, at }] }. 404 not_found.',
  onGuard: adminGuard,
  onRequest: adminRun(req => securityIncidentService.get({ id: req.params?.id })),
};

export const adminAcknowledgeSecurityIncident = {
  created, method: 'post', path: '/admin/security-incidents/:id/acknowledge',
  description: 'Admin (scope security_incidents): open -> acknowledged. 404 not_found; 409 invalid_state. Audited.',
  onGuard: adminGuard,
  onRequest: adminRun(req => securityIncidentService.acknowledge({ id: req.params?.id, actorId: req.user.sub })),
};

export const adminResolveSecurityIncident = {
  created, method: 'post', path: '/admin/security-incidents/:id/resolve',
  description: 'Admin (scope security_incidents): open or acknowledged -> resolved. Body { outcome: "unauthorised_confirmed" | "authorised_by_member" | "inconclusive", reason: string 10-500 chars }. The member gets the same neutral message whatever the outcome. 400 invalid_outcome / invalid_reason; 404 not_found; 409 invalid_state. Audited.',
  requestSample: { outcome: 'inconclusive', reason: 'Called the member; could not confirm either way.' },
  onGuard: adminGuard,
  onRequest: adminRun(req => securityIncidentService.resolve({ id: req.params?.id, actorId: req.user.sub, outcome: req.body?.outcome, reason: req.body?.reason })),
};

export const securityIncidentRetention = {
  created, rule: '05 3 * * *', // every day 03:05 UTC
  description: 'Resolved security incident reports older than 24 months are deleted (with their trail). Runs regardless of the flags (data hygiene). Idempotent.',
  onJob: async () => {
    const n = await securityIncidentService.purgeExpired();
    if (n) console.log(`[security-incident] retention: deleted ${n} incident(s) older than 24 months`);
  },
};
