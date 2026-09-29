// Notifications — one entry point, three channels (US139–147):
//   1. In-app inbox (always; the record of what was sent).
//   2. Push via Firebase Cloud Messaging to every registered device.
//   3. WhatsApp via Africa's Talking, when configured and the event warrants it.
//
// Delivery is best-effort: a failed push must never fail the member-facing
// action that triggered it, so nothing here throws.
//
// Campaigns and automations (communication engine) reuse the same inbox and
// push: `writeInbox` and `sendPush` are the channel primitives the
// dispatcher calls, and `onOpened` / `onClicked` let it record opens and
// taps against its delivery ledger.
import { randomUUID } from 'node:crypto';

// FCM error codes meaning the token will never work again.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export function createNotificationService({
  users, deviceTokens, notifications,
  getMessaging = null,       // () => firebase-admin Messaging, or null to disable push
  whatsApp = null,           // whatsAppService (optional)
  logger = console,
  onOpened = async () => {},  // (notifications[]) → after a member reads them
  onClicked = async () => {}, // (notification, { via }) → after a member taps its button
}) {
  async function registerDevice({ userId, token, platform }) {
    if (!token || typeof token !== 'string' || token.length > 4096) return { error: 'token_required', status: 400 };
    const now = new Date().toISOString();
    const existing = await deviceTokens.findAsync(d => d.token === token);
    if (existing) {
      // A token moves with the device: re-point it at whoever signed in last.
      await deviceTokens.updateByIdAsync(existing.id, { userId, platform: platform || existing.platform, lastSeenAt: now });
      return { ok: true };
    }
    await deviceTokens.insertAsync({ id: `dvt_${randomUUID().slice(0, 8)}`, userId, token, platform: platform || null, createdAt: now, lastSeenAt: now });
    return { ok: true };
  }

  async function unregisterDevice({ userId, token }) {
    if (!token) return { error: 'token_required', status: 400 };
    await deviceTokens.removeAsync(d => d.token === token && d.userId === userId);
    return { ok: true };
  }

  async function sendPush(userId, { title, body, data }) {
    if (!getMessaging) return { sent: 0, skipped: 'push_disabled' };
    const tokens = (await deviceTokens.filterAsync(d => d.userId === userId)).map(d => d.token);
    if (!tokens.length) return { sent: 0 };
    let messaging;
    try {
      messaging = getMessaging();
    } catch (err) {
      logger.warn?.(`[notify] push unavailable: ${err.message}`);
      return { sent: 0, skipped: 'push_unavailable' };
    }
    // FCM data values must be strings.
    const stringData = Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v ?? '')]));
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringData,
      android: { priority: 'high' },
    });
    const dead = [];
    res.responses.forEach((r, i) => { if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) dead.push(tokens[i]); });
    if (dead.length) await deviceTokens.removeAsync(d => dead.includes(d.token));
    // FCM's id for each accepted push, and the error code of each refused
    // one — kept in the communications ledger as provider references.
    const messageIds = res.responses.filter(r => r.success && r.messageId).map(r => r.messageId);
    const errors = [...new Set(res.responses.filter(r => !r.success).map(r => r.error?.code || 'unknown'))];
    return { sent: res.successCount, failed: res.failureCount, messageIds, errors };
  }

  /**
   * Adds one message to a user's inbox. A caller-chosen `id` makes the write
   * idempotent: writing the same id again returns the existing row with
   * `created: false` instead of a duplicate. Throws on other failures.
   */
  async function writeInbox(userId, { id, type, title, body, data = {}, category = null, gymId = null, campaignId = null }) {
    const row = {
      id: id || `ntf_${randomUUID().slice(0, 8)}`, userId, type, title, body,
      data: { ...data, type }, category, gymId, campaignId, readAt: null, createdAt: new Date().toISOString(),
    };
    try {
      await notifications.insertAsync(row);
      return { notification: row, created: true };
    } catch (err) {
      const existing = id ? await notifications.findByIdAsync(id) : null;
      if (existing && existing.userId === userId) return { notification: existing, created: false };
      throw err;
    }
  }

  /**
   * Notify one user. Always writes the inbox row; push and WhatsApp are
   * attempted after and their failures are logged, not raised.
   * @param {string} userId
   * An `id` makes the call idempotent: notifying again with the same id
   * finds the inbox row already there and sends nothing more.
   * @param {{ id?:string, type:string, title:string, body:string, data?:object, whatsapp?:(user)=>Promise<any> }} message
   */
  async function notify(userId, { id = null, type, title, body, data = {}, whatsapp }) {
    if (!userId) return { ok: false, skipped: 'no_user' };
    let row = {
      id: id || `ntf_${randomUUID().slice(0, 8)}`, userId, type, title, body,
      data: { ...data, type }, readAt: null, createdAt: new Date().toISOString(),
    };
    try {
      const written = await writeInbox(userId, { id: row.id, type, title, body, data });
      row = written.notification;
      if (id && !written.created) return { ok: true, notification: row, duplicate: true };
    } catch (err) {
      logger.warn?.(`[notify] inbox write failed for ${userId}/${type}: ${err.message}`);
    }
    let push = null;
    try {
      push = await sendPush(userId, { title, body, data: { ...data, type, notificationId: row.id } });
    } catch (err) {
      logger.warn?.(`[notify] push failed for ${userId}/${type}: ${err.message}`);
    }
    if (whatsapp && whatsApp?.enabled) {
      try {
        await whatsapp(await users.findByIdAsync(userId));
      } catch (err) {
        logger.warn?.(`[notify] whatsapp failed for ${userId}/${type}: ${err.message}`);
      }
    }
    return { ok: true, notification: row, push };
  }

  // One member's rows only (indexed on userId), never the whole table.
  const rowsOf = (userId) => notifications.filterByColumnAsync('userId', userId);

  async function inbox({ userId, limit = 50 }) {
    const rows = await rowsOf(userId);
    rows.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    const capped = rows.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200));
    return { notifications: capped, unread: rows.filter(n => !n.readAt).length };
  }

  async function markRead({ userId, id }) {
    const now = new Date().toISOString();
    if (id === 'all') {
      const unread = (await rowsOf(userId)).filter(n => !n.readAt);
      for (const n of unread) await notifications.updateByIdAsync(n.id, { readAt: now });
      await hook(onOpened, unread);
      return { ok: true, updated: unread.length };
    }
    const row = await ownRow(userId, id);
    if (!row) return { error: 'not_found', status: 404 };
    if (!row.readAt) {
      await notifications.updateByIdAsync(row.id, { readAt: now });
      await hook(onOpened, [row]);
    }
    return { ok: true };
  }

  async function ownRow(userId, id) {
    const row = await notifications.findByIdAsync(id);
    return row && row.userId === userId ? row : null;
  }

  /**
   * A member tapped the message's button (in the inbox, or a push). Marks it
   * read and clicked. `via: 'push'` says the tap came from a notification.
   */
  async function markClicked({ userId, id, via = 'inbox' }) {
    const row = await ownRow(userId, id);
    if (!row) return { error: 'not_found', status: 404 };
    const now = new Date().toISOString();
    const patch = {};
    if (!row.readAt) patch.readAt = now;
    if (!row.clickedAt) patch.clickedAt = now;
    if (Object.keys(patch).length) await notifications.updateByIdAsync(row.id, patch);
    if (!row.readAt) await hook(onOpened, [row]);
    await hook(onClicked, row, { via: via === 'push' ? 'push' : 'inbox' });
    return { ok: true };
  }

  // Ledger bookkeeping must never break reading the inbox.
  async function hook(fn, ...args) {
    try {
      await fn(...args);
    } catch (err) {
      logger.warn?.(`[notify] open/click tracking failed: ${err.message}`);
    }
  }

  // ── Domain events ──────────────────────────────────────────────────────

  const fmtSlots = (bookings) => bookings.map(b => `${b.date} ${b.slot}`).join(', ');

  /** Trainer booking lifecycle (UAT #58: trainer notified on booking and payment). */
  async function notifyTrainerBooking(event, { trainer, memberId, bookings = [] }) {
    try {
      const member = await users.findByIdAsync(memberId);
      const memberName = member?.displayName || 'A member';
      const data = { bookingGroupId: bookings[0]?.groupId || '', trainerId: trainer?.id || '' };
      if (event === 'trainer_booking_requested') {
        await notify(trainer?.userId, {
          type: event, data,
          title: 'New booking request',
          body: `${memberName} booked ${bookings.length} session(s): ${fmtSlots(bookings)}. Awaiting payment confirmation.`,
        });
      } else if (event === 'trainer_booking_confirmed') {
        await notify(trainer?.userId, {
          type: event, data,
          title: 'Booking paid and confirmed',
          body: `${memberName}'s ${bookings.length} session(s) are confirmed: ${fmtSlots(bookings)}.`,
          whatsapp: () => whatsApp.sendBookingConfirmed(trainer.userId, memberName, bookings[0]?.date, bookings[0]?.slot),
        });
        await notify(memberId, {
          type: event, data,
          title: 'Trainer session confirmed',
          body: `Your ${bookings.length} session(s) with ${trainer?.displayName || 'your trainer'} are confirmed: ${fmtSlots(bookings)}.`,
        });
      }
    } catch (err) {
      logger.warn?.(`[notify] ${event} failed: ${err.message}`);
    }
  }

  /** BL-008 renewal sequence: T-3, T-1 and T-0 before renewsAt. */
  async function notifyRenewal(sub, daysLeft) {
    const tier = sub.tier ? sub.tier[0].toUpperCase() + sub.tier.slice(1) : 'membership';
    const when = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
    // One reminder per subscription, renewal date and day — a rerun of the
    // job the same day finds it already sent.
    const day = new Date(sub.renewsAt).toISOString().slice(0, 10);
    return notify(sub.memberId, {
      id: `ntf_renew_${sub.id}_${day}_${daysLeft}`,
      type: 'subscription_renewal',
      // Passes are prepaid and never charged automatically (Member Terms 3.4).
      title: `Your ${tier} pass ends ${when}`,
      body: 'To keep training, renew it from the Passes screen. You can also choose a different tier.',
      data: { subscriptionId: sub.id, daysLeft },
    });
  }

  /** US030: activation confirmation once payment is approved. */
  async function notifySubscriptionActivated(sub) {
    if (sub.type === 'trainer_pass') {
      const period = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' }[sub.plan] || '';
      return notify(sub.memberId, {
        type: 'trainer_pass_activated',
        title: 'Trainer pass active',
        body: `Your ${period ? `${period} ` : ''}trainer pass is active. Show your check-in QR at reception to train your clients.`,
        data: { subscriptionId: sub.id, gymId: sub.homeGymId || '' },
      });
    }
    const tier = sub.tier ? `${sub.tier[0].toUpperCase()}${sub.tier.slice(1)} pass` : 'gym membership';
    return notify(sub.memberId, {
      type: 'subscription_activated',
      title: 'Payment confirmed',
      body: `Your ${tier} is active. Show your QR code at the gym to check in.`,
      data: { subscriptionId: sub.id },
    });
  }

  return {
    registerDevice, unregisterDevice, notify, inbox, markRead, markClicked, writeInbox, sendPush,
    notifyTrainerBooking, notifyRenewal, notifySubscriptionActivated,
  };
}
