// Shared fixture for the S7 specs (CI database only). It wraps the S5 harness (organizer with staff of every role, published kit event with
// confirmed registrations and active tickets) and adds the three S7 flags and the cleanup of every S7 table before the S5 cleanup runs.
import { harness as harness5, s5On, s5Off, uid, phone, D, H, db, eventually } from './events-s5.mjs';

export { uid, phone, D, H, db, eventually };
export const S7_ENV = [
  'EVENTS_KIT_OFFLINE', 'EVENTS_WAITLIST', 'EVENTS_ANALYTICS', 'OPS_ALERT_EMAILS',
  'EVENTS_OFFLINE_SESSION_HOURS', 'EVENTS_OFFLINE_MAX_DEVICES', 'EVENTS_OFFLINE_MAX_PER_USER', 'EVENTS_OFFLINE_MAX_ROWS', 'EVENTS_OFFLINE_SYNC_BATCH',
  'EVENTS_OFFLINE_MAX_PENDING', 'EVENTS_OFFLINE_CLOCK_TOLERANCE_SECONDS', 'EVENTS_OFFLINE_MIN_DESK_BUILD', 'EVENTS_OFFLINE_SCAN_KEEP_DAYS', 'EVENTS_OFFLINE_MAX_BIB_RANGE',
  'EVENTS_WAITLIST_OFFER_HOURS', 'EVENTS_WAITLIST_MIN_OFFER_MINUTES', 'EVENTS_WAITLIST_MAX_ACTIVE_PER_USER', 'EVENTS_WAITLIST_MAX_QUEUE', 'EVENTS_WAITLIST_MAX_LAPSES',
  'EVENTS_WAITLIST_QUIET_HOURS', 'EVENTS_WAITLIST_KEEP_DAYS', 'EVENTS_ANALYTICS_KEEP_DAYS', 'EVENTS_ALERT_RULES',
  'EVENTS_WEBHOOK_PER_HOST_BATCH', 'EVENTS_MAX_UNPAID_PLACES_PER_USER', 'EVENTS_RETENTION_MONTHS', 'EVENTS_DELETED_USER_ANONYMISE_DAYS',
];

/** The S5 environment (module, registration, payments, ticket secret, kit ops) plus whichever S7 flags are asked for. */
export function s7On({ analytics = false, offline = false, waitlist = false } = {}) {
  s5On();
  if (analytics) process.env.EVENTS_ANALYTICS = '1';
  if (offline) process.env.EVENTS_KIT_OFFLINE = '1';
  if (waitlist) process.env.EVENTS_WAITLIST = '1';
  // Quiet hours would make the waitlist specs depend on the wall clock.
  process.env.EVENTS_WAITLIST_QUIET_HOURS = 'off';
}
export function s7Off() {
  for (const k of S7_ENV) delete process.env[k];
  s5Off();
}

async function tableExists(name) {
  return (await db.raw('SELECT to_regclass(?) AS t', [`public."${name}"`])).rows[0].t !== null;
}

export function harness() {
  const base = harness5();

  async function cleanup() {
    const events = base.made.events;
    if (events.length) {
      if (await tableExists('EventKitOfflineScan')) {
        await db('EventBibAssignment').whereIn('eventId', events).update({ sourceScanId: null }).catch(() => {});
        await db('EventKitOfflineScan').whereIn('eventId', events).del();
      }
      if (await tableExists('EventKitOfflineDevice')) await db('EventKitOfflineDevice').whereIn('eventId', events).del();
      if (await tableExists('EventWaitlistEntry')) await db('EventWaitlistEntry').whereIn('eventId', events).del();
    }
    await db('EventAnalyticsDaily').del();
    await db('AnalyticsRollupCursor').del();
    await db('AuditLog').where('action', 'like', 'analytics.%').del();
    await db('AuditLog').whereIn('action', ['events.alerts_sent']).del();
    await db('JobRun').whereIn('job', ['event-analytics-rollup', 'event-health-alert', 'event-waitlist-promote', 'event-waitlist-purge', 'event-kit-offline-purge', 'event-organizer-status-sweep', 'event-registration-anonymise']).del();
    await base.cleanup();
    s7Off();
  }
  return { ...base, cleanup };
}
