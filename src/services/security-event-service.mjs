// Security events (S3): when a gym check-in is made from a web browser, record a SecurityEvent for the member and
// (flag WEB_CHECKIN_ALERTS) tell them by inbox message + push, so a check-in they did not make is noticed.
// The inbox row carries gym name and time; the phone push (lock screen) is a GENERIC title/body with no gym or time.
//
// Rules: nothing here may fail or slow the check-in (handleCheckin never throws); the handler is idempotent (the event
// id and the notification id are derived from the check-in id, so calling it twice leaves one of each); only
// source 'web_gym_qr_by_member' check-ins are handled (in-app scans never create an event). Stored: who, gym,
// when and a gym-name snapshot. Inbox text: gym name and Tanzania time. Push text: generic only. NEVER stored or sent: IP, user agent, clientMeta,
// session id, intent id, PIN or any token.
import { CHECKIN_SOURCE } from '../shared/checkin-status.mjs';
import { eatDate } from '../shared/eat-time.mjs';

export const KIND_WEB_CHECKIN = 'web_checkin';
export const NOTIFICATION_TYPE = 'web_checkin_recorded';
export const RETENTION_MONTHS = 13;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

const safeId = s => String(s).replace(/[^A-Za-z0-9_]/g, '').slice(0, 60);
export const eventIdFor = checkinId => `sev_wchk_${safeId(checkinId)}`;
export const notificationIdFor = checkinId => `ntf_wchk_${safeId(checkinId)}`;

/** EN + SW text. Swahili is a DRAFT for native review. */
export function alertText({ gymName, when }) {
  const gym = gymName || 'FitFlex gym';
  return {
    en: {
      title: 'Gym check-in from a web browser',
      body: `You checked in at ${gym} on ${eatDate(when, 'en')} (Dar es Salaam time) using a web browser. Not you? Open to review.`,
    },
    sw: {
      title: 'Umejiandikisha gym kupitia kivinjari',
      body: `Umejiandikisha ${gym} tarehe ${eatDate(when, 'sw')} (saa za Dar es Salaam) kupitia kivinjari. Si wewe? Fungua kukagua.`,
    },
  };
}

/** Generic lock-screen text: no gym, no time. Swahili is a DRAFT for native review. */
export const PUSH_TEXT = {
  en: { title: 'Security alert', body: 'New activity on your FitFlex account. Open the app to review.' },
  sw: { title: 'Tahadhari ya usalama', body: 'Kuna shughuli mpya kwenye akaunti yako ya FitFlex. Fungua programu kukagua.' },
};

export function createSecurityEventService({
  db, gyms, deviceTokens, notify, localeOf = async () => null, alertsOn = () => false, reportsOn = () => false, reportsFor = async () => ({}), logger = console,
  now = () => new Date(),
}) {
  /** Would a new alert reach this member's phone? Needs the flags and at least one registered device. */
  async function alertWillQueue(userId) {
    try {
      if (!alertsOn() || !userId) return false;
      return (await db('DeviceToken').where({ userId }).first('id')) != null;
    } catch {
      return false;
    }
  }

  async function handleCheckin(row) {
    try {
      if (!row || row.source !== CHECKIN_SOURCE.WEB_GYM_QR_BY_MEMBER || !row.id || !row.memberId) return { skipped: true };
      const gym = row.gymId ? await gyms.findByIdAsync(row.gymId) : null;
      const gymName = gym?.name || null;
      const occurredAt = new Date(row.timestamp);
      if (Number.isNaN(occurredAt.getTime())) return { skipped: true };
      const on = alertsOn();
      const id = eventIdFor(row.id);
      await db('SecurityEvent').insert({
        id, userId: row.memberId, kind: KIND_WEB_CHECKIN, checkinId: row.id, gymId: row.gymId || null,
        occurredAt, businessDate: row.businessDate || null, channel: 'web',
        notifiedAt: null, notifyState: on ? 'queued' : 'none', details: JSON.stringify({ gymName }),
      }).onConflict().ignore();
      if (!on) return { eventId: id, notified: false };
      const event = await db('SecurityEvent').where({ id }).first('notifiedAt', 'userId');
      if (!event || event.userId !== row.memberId) return { eventId: id, notified: false };
      if (event.notifiedAt) return { eventId: id, notified: true, duplicate: true };
      let locale = null;
      try { locale = await localeOf(row.memberId); } catch { locale = null; }
      const text = alertText({ gymName, when: occurredAt });
      const chosen = locale === 'sw' ? text.sw : text.en;
      const nid = notificationIdFor(row.id);
      const data = { eventId: id, gymId: row.gymId || '', open: 'security_activity' };
      await notify(row.memberId, {
        id: nid, type: NOTIFICATION_TYPE, title: chosen.title, body: chosen.body,
        data: { ...data, locale: locale === 'sw' ? 'sw' : 'en', titleEn: text.en.title, bodyEn: text.en.body, titleSw: text.sw.title, bodySw: text.sw.body },
        // The phone push shows a generic title/body (no gym, no time) and ids only; the inbox row has the details.
        pushTitle: (locale === 'sw' ? PUSH_TEXT.sw : PUSH_TEXT.en).title,
        pushBody: (locale === 'sw' ? PUSH_TEXT.sw : PUSH_TEXT.en).body,
        pushData: data,
      });
      await db('SecurityEvent').where({ id }).whereNull('notifiedAt').update({ notifiedAt: now() });
      return { eventId: id, notified: true };
    } catch (err) {
      logger.warn?.(`[security-event] web check-in ${row?.id} failed: ${err?.message}`);
      return { error: true };
    }
  }

  /** The caller's own events, newest first. `before` is the `next` cursor of the previous page. */
  async function list({ userId, limit, before }) {
    const n = Math.min(Math.max(Math.floor(Number(limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const q = db('SecurityEvent').where({ userId });
    if (before) {
      const [iso, bid] = String(before).split('~');
      const t = new Date(iso);
      if (Number.isNaN(t.getTime())) return { error: 'invalid_before', status: 400 };
      if (bid) q.where(b => b.where('occurredAt', '<', t).orWhere(c => c.where('occurredAt', t).andWhere('id', '<', bid)));
      else q.where('occurredAt', '<', t);
    }
    const rows = await q.orderBy([{ column: 'occurredAt', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(n + 1);
    const page = rows.slice(0, n);
    // S4b: with SECURITY_INCIDENT_REPORTS on, each event says whether the member has reported it (report: null = not yet).
    // A report carries protectionPending (true = "secure my account" was asked for but is not in place; reporting the
    // event again retries it) and, only when a retry cannot help, protectionRetryable: false.
    const reportEnabled = Boolean(reportsOn());
    let reports = {};
    if (reportEnabled) { try { reports = await reportsFor(userId, page.map(r => r.id)); } catch { reports = {}; } }
    const events = page.map(r => ({
      id: r.id, kind: r.kind, occurredAt: new Date(r.occurredAt).toISOString(),
      gym: { id: r.gymId, name: r.details?.gymName || null },
      channel: r.channel || 'web',
      status: r.notifiedAt ? 'inbox' : 'recorded',
      report: reports[r.id] || null,
    }));
    const last = page[page.length - 1];
    return { events, reportEnabled, ...(rows.length > n && last ? { next: `${new Date(last.occurredAt).toISOString()}~${last.id}` } : {}) };
  }

  /** Retention: events older than RETENTION_MONTHS go. → rows deleted. */
  async function purgeExpired({ months = RETENTION_MONTHS } = {}) {
    const cutoff = now();
    const c = new Date(cutoff);
    c.setUTCMonth(c.getUTCMonth() - months);
    return db('SecurityEvent').where('occurredAt', '<', c).del();
  }

  return { handleCheckin, alertWillQueue, list, purgeExpired };
}
