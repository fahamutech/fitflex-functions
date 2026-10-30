// Security activity (S3): the member's own list of security events, first kind 'web_checkin' (a gym check-in made from
// a web browser). Dormant: 404 { error: 'not_found' } unless WEB_QR_CHECKIN is set. Only the caller's own rows.
// Never returned or stored: IP, user agent, client metadata, session or intent ids.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { securityEventService } from '../src/bootstrap/services.mjs';
import { webQrCheckinOn } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();
const guard = requireAuth('member', 'trainer');

export const securityActivity = {
  created, method: 'get', path: '/me/security-activity',
  description: 'Member or trainer (404 not_found while WEB_QR_CHECKIN is off): GET ?limit=&before= → { events: [{ id, kind: "web_checkin", occurredAt, gym: { id, name }, channel: "web", status: "notified" | "recorded" }], next? }. Newest first; only your own events; limit default 20, max 50; pass `next` back as `before` for the following page. gym.id is the same gym id the member gym APIs return. Cache-Control: no-store.',
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
  description: 'Security events older than 13 months are deleted. Runs only while WEB_QR_CHECKIN is on (events are written then, with or without WEB_CHECKIN_ALERTS). Idempotent.',
  onJob: async () => {
    if (!webQrCheckinOn()) return;
    const n = await securityEventService.purgeExpired();
    if (n) console.log(`[security-event] retention: deleted ${n} event(s) older than 13 months`);
  },
};
