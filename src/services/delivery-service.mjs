// Delivery — turns queued CommunicationMessage rows into real messages
// through the existing notification service: in-app via its inbox,
// push via its FCM fan-out, WhatsApp through the WhatsApp channel service
// (and its provider).
//
// Each run (a cron tick, every minute):
//   1. releases scheduled campaigns whose time has come (campaign service);
//   2. claims a batch of due messages with FOR UPDATE SKIP LOCKED, so two
//      servers — or a slow tick overlapping the next — never take the same
//      row; rows stuck in `sending` after a crash are taken back;
//   3. delivers each one and records the outcome, retrying temporary
//      failures with back-off and giving up on permanent ones;
//   4. closes campaigns with nothing left to send (sent / partly sent /
//      failed);
//   5. writes a JobRun row with the numbers.
//
// In-app delivery is idempotent: the inbox row's id is derived from the
// ledger row's id, so a retry after a crash finds the row instead of adding
// a second one. Push and WhatsApp are at-least-once: a crash between the
// provider accepting a message and the ledger update can repeat that one
// message (WhatsApp passes the ledger id on, for providers that drop
// repeats).
//
// A channel can also decide at the last moment not to send — WhatsApp
// switched off, the member opted out since the campaign was sent — and the
// row is then `skipped` with the reason, not failed.
import { randomUUID } from 'node:crypto';
import { contentFor } from '../shared/communications.mjs';

export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const STUCK_AFTER_MS = 10 * 60_000;

export function createDeliveryService({
  db,
  notificationService,
  campaignService,
  whatsappChannel = null,
  now = () => new Date(),
  batchSize = 200,
  logger = console,
}) {
  const inboxIdFor = (messageId) => `ntf_${messageId}`;

  /** Claims up to `limit` due rows and marks them `sending`. */
  async function claim(limit) {
    const at = now();
    const stuck = new Date(+at - STUCK_AFTER_MS);
    const { rows } = await db.raw(`
      UPDATE "CommunicationMessage" m
         SET status = 'sending', attempts = m.attempts + 1, "updatedAt" = ?
       WHERE m.id IN (
         SELECT id FROM "CommunicationMessage"
          WHERE (status = 'queued' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ?))
             OR (status = 'sending' AND "updatedAt" < ?)
          ORDER BY "nextAttemptAt" NULLS FIRST
          LIMIT ?
          FOR UPDATE SKIP LOCKED)
      RETURNING m.*`, [at, at, stuck, limit]);
    return rows;
  }

  // Button label and sender name, looked up once per campaign — a sent
  // campaign's content no longer changes.
  const campaignInfo = new Map();
  async function infoFor(msg) {
    if (!msg.campaignId) return { ctaLabel: null, senderName: null };
    if (!campaignInfo.has(msg.campaignId)) {
      const c = await db('CommunicationCampaign as c').leftJoin('Gym as g', 'g.id', 'c.gymId')
        .where('c.id', msg.campaignId).first('c.content', 'g.name as gymName');
      campaignInfo.set(msg.campaignId, {
        content: c?.content ?? null,
        senderName: msg.senderType === 'platform' ? 'FitFlex' : c?.gymName ?? null,
      });
    }
    const info = campaignInfo.get(msg.campaignId);
    // The button in the same language as the member's copy of the message.
    const ctaLabel = info.content ? contentFor(info.content, msg.locale).ctaLabel : null;
    return { ctaLabel, senderName: info.senderName };
  }

  async function payload(msg) {
    const { ctaLabel, senderName } = await infoFor(msg);
    return {
      source: 'communication',
      messageId: msg.id,
      campaignId: msg.campaignId || '',
      deepLink: msg.deepLink || 'message',
      gymId: msg.gymId || '',
      category: msg.category,
      ctaLabel: ctaLabel || '',
      senderName: senderName || '',
    };
  }

  async function deliverInApp(msg) {
    const { notification } = await notificationService.writeInbox(msg.memberId, {
      id: inboxIdFor(msg.id),
      type: msg.campaignId ? 'campaign' : 'automation',
      title: msg.title,
      body: msg.body,
      data: await payload(msg),
      category: msg.category,
      gymId: msg.gymId,
      campaignId: msg.campaignId,
    });
    return { status: 'delivered', notificationId: notification.id };
  }

  async function deliverPush(msg) {
    // Opening the push opens the in-app copy when the campaign has one.
    const hasInbox = await db('CommunicationMessage')
      .where({ campaignId: msg.campaignId, memberId: msg.memberId, channel: 'in_app' })
      .whereNotNull('campaignId').whereNotIn('status', ['skipped', 'failed']).first('id');
    const data = { ...(await payload(msg)), notificationId: hasInbox ? inboxIdFor(hasInbox.id) : '' };
    const r = await notificationService.sendPush(msg.memberId, { title: msg.title, body: msg.body, data });
    if (r?.skipped === 'push_disabled' || r?.skipped === 'push_unavailable') return { permanent: true, reason: r.skipped };
    // FCM's references, for the history: one id per phone it went to.
    const fcm = { messageIds: r?.messageIds || [], failed: r?.failed || 0, errors: r?.errors || [] };
    if (r?.sent > 0) return { status: 'sent', providerMessageId: fcm.messageIds[0] || null, payload: { fcm } };
    if (!r?.failed) return { permanent: true, reason: 'no_device' }; // no (live) tokens left
    return { temporary: true, reason: 'push_failed', payload: { fcm } };
  }

  const channels = {
    in_app: deliverInApp,
    push: deliverPush,
    whatsapp: (msg) => whatsappChannel ? whatsappChannel.deliver(msg) : { skipped: 'whatsapp_not_configured' },
  };

  async function deliver(msg) {
    const at = now();
    const deliverTo = channels[msg.channel];
    let outcome;
    try {
      outcome = deliverTo ? await deliverTo(msg) : { permanent: true, reason: 'channel_not_supported' };
    } catch (err) {
      outcome = { temporary: true, reason: String(err?.message || err).slice(0, 200) };
    }
    if (outcome.skipped) {
      await db('CommunicationMessage').where({ id: msg.id }).update({
        status: 'skipped', skipReason: outcome.skipped, updatedAt: at, nextAttemptAt: null,
      });
      return 'skipped';
    }
    if (outcome.status) {
      await db('CommunicationMessage').where({ id: msg.id }).update({
        status: outcome.status, sentAt: at, updatedAt: at, nextAttemptAt: null, failureReason: null,
        ...(outcome.status === 'delivered' ? { deliveredAt: at } : {}),
        ...(outcome.notificationId ? { notificationId: outcome.notificationId } : {}),
        ...(outcome.providerMessageId ? { providerMessageId: outcome.providerMessageId } : {}),
        ...(outcome.payload ? { payload: outcome.payload } : {}),
      });
      return 'sent';
    }
    const retry = outcome.temporary && msg.attempts < MAX_ATTEMPTS;
    // Failures are kept, never dropped: status, reason, time and whatever
    // the provider said.
    const extra = outcome.payload ? { payload: outcome.payload } : {};
    await db('CommunicationMessage').where({ id: msg.id }).update(retry
      ? { status: 'queued', failureReason: outcome.reason, nextAttemptAt: new Date(+at + RETRY_DELAYS_MS[msg.attempts - 1]), updatedAt: at, ...extra }
      : { status: 'failed', failureReason: outcome.reason, failurePermanent: Boolean(outcome.permanent), failedAt: at, nextAttemptAt: null, updatedAt: at, ...extra });
    return retry ? 'retry' : 'failed';
  }

  /** Campaigns still `sending` with nothing left in flight get their final status. */
  async function closeFinished() {
    const open = await db('CommunicationCampaign as c').where('c.status', 'sending')
      .whereNotExists(db('CommunicationMessage as m').whereRaw('m."campaignId" = c.id').whereIn('m.status', ['queued', 'sending']))
      .select('c.id');
    let closed = 0;
    for (const { id } of open) {
      const byStatus = Object.fromEntries((await db('CommunicationMessage').where('campaignId', id)
        .groupBy('status').select('status').count({ n: '*' })).map(r => [r.status, Number(r.n)]));
      const reached = ['sent', 'delivered', 'read', 'clicked'].reduce((sum, s) => sum + (byStatus[s] || 0), 0);
      const failed = byStatus.failed || 0;
      const status = !reached ? 'failed' : failed ? 'partially_failed' : 'sent';
      closed += await db('CommunicationCampaign').where({ id, status: 'sending' })
        .update({ status, sentAt: now(), updatedAt: now() });
    }
    return closed;
  }

  /** One dispatcher tick. Never throws — a failed tick is logged and recorded. */
  async function runOnce() {
    const runId = `job_${randomUUID().slice(0, 8)}`;
    const startedAt = now();
    const stats = { released: 0, claimed: 0, sent: 0, retry: 0, failed: 0, skipped: 0, closed: 0 };
    await db('JobRun').insert({ id: runId, job: 'communication_dispatcher', status: 'running', startedAt }).catch(() => {});
    try {
      stats.released = (await campaignService.releaseDue()).released;
      // In-app first, so a push in the same batch can open its inbox copy.
      const batch = (await claim(batchSize)).sort((a, b) => (a.channel === 'in_app' ? 0 : 1) - (b.channel === 'in_app' ? 0 : 1));
      stats.claimed = batch.length;
      for (const msg of batch) stats[await deliver(msg)] += 1;
      stats.closed = await closeFinished();
      await db('JobRun').where({ id: runId }).update({ status: 'ok', finishedAt: now(), stats: JSON.stringify(stats) }).catch(() => {});
    } catch (err) {
      logger.error?.(`[comms] dispatcher run failed: ${err.message}`);
      await db('JobRun').where({ id: runId })
        .update({ status: 'failed', finishedAt: now(), stats: JSON.stringify(stats), error: String(err.message).slice(0, 500) }).catch(() => {});
    }
    return stats;
  }

  // ── opens and taps (from the member's inbox) ─────────────────────────────

  const RANK = { queued: 0, sending: 0, sent: 1, delivered: 2, read: 3, clicked: 4 };
  const ledgerIdOf = (n) => n?.data?.source === 'communication' ? n.data.messageId : null;

  // Moves a ledger row forward to `status`, never backwards.
  async function advance(where, status, stamp) {
    const at = now();
    const rows = await db('CommunicationMessage').where(where).select('id', 'status', 'openedAt', 'clickedAt');
    for (const r of rows) {
      const patch = { updatedAt: at };
      if (stamp === 'openedAt' && !r.openedAt) patch.openedAt = at;
      if (stamp === 'clickedAt') {
        if (!r.clickedAt) patch.clickedAt = at;
        if (!r.openedAt) patch.openedAt = at;
      }
      if ((RANK[r.status] ?? -1) >= 0 && RANK[status] > RANK[r.status]) patch.status = status;
      if (Object.keys(patch).length > 1) await db('CommunicationMessage').where({ id: r.id }).update(patch);
    }
  }

  async function onOpened(notifications) {
    for (const n of notifications) {
      const id = ledgerIdOf(n);
      if (id) await advance({ id }, 'read', 'openedAt');
    }
  }

  async function onClicked(notification, { via }) {
    const id = ledgerIdOf(notification);
    if (!id) return;
    await advance({ id }, 'clicked', 'clickedAt');
    // A tap on the push also counts as that push being opened.
    if (via === 'push' && notification.campaignId) {
      await advance({ campaignId: notification.campaignId, memberId: notification.userId, channel: 'push' }, 'clicked', 'clickedAt');
    }
  }

  /** A push with no inbox copy was opened on the member's phone. */
  async function pushOpened({ userId, messageId }) {
    const row = await db('CommunicationMessage').where({ id: messageId, memberId: userId, channel: 'push' }).first('id');
    if (!row) return { error: 'not_found', status: 404 };
    await advance({ id: row.id }, 'read', 'openedAt');
    return { ok: true };
  }

  return { runOnce, claim, deliver, closeFinished, onOpened, onClicked, pushOpened, inboxIdFor };
}
