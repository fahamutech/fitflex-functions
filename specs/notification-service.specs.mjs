// Notification service — inbox, push fan-out, dead-token cleanup, never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationService } from '../src/services/notification-service.mjs';

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async filterByColumnAsync(col, value) { return rows.filter(r => r[col] === value); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, patch); return r; },
    async removeAsync(fn) { for (let i = rows.length - 1; i >= 0; i--) if (fn(rows[i])) rows.splice(i, 1); },
  };
}

const quiet = { warn: () => {} };

function setup({ messaging = null } = {}) {
  const deviceTokens = memStore();
  const notifications = memStore();
  const svc = createNotificationService({
    users: memStore([{ id: 'u1', displayName: 'Aisha' }]),
    deviceTokens, notifications,
    getMessaging: messaging ? () => messaging : null,
    logger: quiet,
  });
  return { svc, deviceTokens, notifications };
}

test('notify writes the inbox even with push disabled', async () => {
  const { svc, notifications } = setup();
  const out = await svc.notify('u1', { type: 't', title: 'Hi', body: 'There' });
  assert.equal(out.ok, true);
  assert.equal(notifications.rows.length, 1);
  assert.equal(out.push.skipped, 'push_disabled');
});

test('registering the same token twice keeps one row and follows the latest user', async () => {
  const { svc, deviceTokens } = setup();
  await svc.registerDevice({ userId: 'u1', token: 'tok', platform: 'android' });
  await svc.registerDevice({ userId: 'u2', token: 'tok', platform: 'android' });
  assert.equal(deviceTokens.rows.length, 1);
  assert.equal(deviceTokens.rows[0].userId, 'u2');
});

test('push goes to every device and dead tokens are dropped', async () => {
  const sent = [];
  const messaging = {
    async sendEachForMulticast(msg) {
      sent.push(msg);
      return {
        successCount: 1, failureCount: 1,
        responses: [{ success: true }, { success: false, error: { code: 'messaging/registration-token-not-registered' } }],
      };
    },
  };
  const { svc, deviceTokens } = setup({ messaging });
  await svc.registerDevice({ userId: 'u1', token: 'good' });
  await svc.registerDevice({ userId: 'u1', token: 'dead' });
  const out = await svc.notify('u1', { type: 'x', title: 'T', body: 'B', data: { n: 3 } });
  assert.equal(out.push.sent, 1);
  assert.deepEqual(sent[0].tokens, ['good', 'dead']);
  assert.equal(sent[0].data.n, '3');
  assert.deepEqual(deviceTokens.rows.map(d => d.token), ['good']);
});

test('a push failure never propagates', async () => {
  const messaging = { async sendEachForMulticast() { throw new Error('fcm down'); } };
  const { svc } = setup({ messaging });
  await svc.registerDevice({ userId: 'u1', token: 'good' });
  const out = await svc.notify('u1', { type: 'x', title: 'T', body: 'B' });
  assert.equal(out.ok, true);
});

test('inbox is newest first with an unread count; markRead all clears it', async () => {
  const { svc } = setup();
  await svc.notify('u1', { type: 'a', title: '1', body: '1' });
  await new Promise(r => setTimeout(r, 5));
  await svc.notify('u1', { type: 'b', title: '2', body: '2' });
  let box = await svc.inbox({ userId: 'u1' });
  assert.equal(box.notifications[0].title, '2');
  assert.equal(box.unread, 2);
  await svc.markRead({ userId: 'u1', id: 'all' });
  box = await svc.inbox({ userId: 'u1' });
  assert.equal(box.unread, 0);
});

test('markRead cannot touch a notification of another user', async () => {
  const { svc } = setup();
  const { notification } = await svc.notify('u1', { type: 'a', title: '1', body: '1' });
  const out = await svc.markRead({ userId: 'u2', id: notification.id });
  assert.equal(out.status, 404);
});
