// Selcom webhook — activation rules and idempotency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookService } from '../src/services/webhook-service.mjs';

function store(seed = []) {
  const rows = [...seed];
  return {
    rows,
    findAsync: async pred => rows.find(pred) || null,
    findByIdAsync: async id => rows.find(r => r.id === id) || null,
    insertAsync: async row => { rows.push(row); return row; },
    updateByIdAsync: async (id, patch) => { Object.assign(rows.find(r => r.id === id), patch); },
  };
}

function setup(subs) {
  const subscriptions = store(subs);
  const webhookSeen = store();
  return { subscriptions, svc: createWebhookService({ subscriptions, webhookSeen }) };
}

test('success activates a payment_pending subscription once', async () => {
  const { svc, subscriptions } = setup([{ id: 's1', status: 'payment_pending' }]);
  assert.deepEqual(await svc.handleSelcom({ payment_id: 'p1', status: 'success', subscription_id: 's1' }), { ok: true });
  assert.equal(subscriptions.rows[0].status, 'active');
  assert.deepEqual(await svc.handleSelcom({ payment_id: 'p1', status: 'success', subscription_id: 's1' }), { ok: true, idempotent: true });
});

test('success does not resurrect a cancelled subscription', async () => {
  const { svc, subscriptions } = setup([{ id: 's1', status: 'cancelled' }]);
  const result = await svc.handleSelcom({ payment_id: 'p2', status: 'success', subscription_id: 's1' });
  assert.equal(result.ignored, 'not_payment_pending');
  assert.equal(subscriptions.rows[0].status, 'cancelled');
});

test('unknown subscription is a 404 and is not marked as seen', async () => {
  const { svc } = setup([]);
  assert.equal((await svc.handleSelcom({ payment_id: 'p3', status: 'success', subscription_id: 'nope' })).status, 404);
  assert.equal((await svc.handleSelcom({ payment_id: 'p3', status: 'success', subscription_id: 'nope' })).status, 404);
});
