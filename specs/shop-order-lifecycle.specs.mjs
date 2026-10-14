// The order lifecycle matrix. The expected tables below are written out by hand,
// deliberately NOT derived from the module under test: every (from, to) pair for
// both delivery methods is checked against them, so a change to the rules shows
// up here as a conscious edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTransition, nextStatuses, combinedStatus, fulfilmentsOf, canonicalStatus, STATUSES } from '../src/shared/order-lifecycle.mjs';

// What may follow each status (cancelling and repeating the same status are covered separately).
const HOME = {
  pending: ['accepted'],
  accepted: ['processing', 'packed', 'dispatched'],
  processing: ['packed', 'dispatched'],
  packed: ['dispatched'],
  dispatched: ['delivered'],
  ready_for_pickup: ['delivered'], // not reachable for home delivery; only a legacy row could be here
  delivered: [],
  cancelled: [],
};
const PICKUP = {
  pending: ['accepted'],
  accepted: ['processing', 'packed', 'dispatched', 'ready_for_pickup'],
  processing: ['packed', 'dispatched', 'ready_for_pickup'],
  packed: ['dispatched', 'ready_for_pickup'],
  dispatched: ['ready_for_pickup'],
  ready_for_pickup: ['delivered'],
  delivered: [],
  cancelled: [],
};

for (const [method, table] of [['home_delivery', HOME], ['gym_pickup', PICKUP]]) {
  test(`${method}: every status pair is permitted or rejected exactly as the matrix says`, () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const out = decideTransition({ from, to, deliveryMethod: method });
        const live = !['delivered', 'cancelled'].includes(from);
        const expectedOk = from === to
          ? true // repeating is a no-op, even for terminal states
          : to === 'cancelled' ? live : table[from].includes(to);
        assert.equal(out.ok, expectedOk, `${from} → ${to} (${method}): ${JSON.stringify(out)}`);
        if (out.ok && from === to) assert.equal(out.noop, true, `${from} → ${from} is a no-op`);
        if (!out.ok) assert.ok(out.error, `${from} → ${to} says why`);
        // The error always tells the caller what would have been possible.
        if (!out.ok && to !== 'cancelled') assert.deepEqual(out.allowed, table[from] ?? [], `${from} → ${to} allowed`);
      }
    }
  });

  test(`${method}: nextStatuses matches the matrix`, () => {
    for (const from of STATUSES) assert.deepEqual(nextStatuses(from, method), table[from], from);
  });
}

test('terminal states cannot be left, only repeated', () => {
  for (const method of ['home_delivery', 'gym_pickup']) {
    for (const from of ['delivered', 'cancelled']) {
      for (const to of ['pending', 'accepted', 'processing', 'packed', 'dispatched', 'ready_for_pickup']) {
        assert.equal(decideTransition({ from, to, deliveryMethod: method }).ok, false, `${from} → ${to}`);
      }
      assert.equal(decideTransition({ from, to: 'cancelled', deliveryMethod: method }).ok, from === 'cancelled');
    }
  }
  assert.equal(decideTransition({ from: 'delivered', to: 'cancelled' }).error, 'status_is_final');
});

test('nothing goes backwards and nothing skips acceptance, hand-over or delivery', () => {
  const rejected = [
    ['pending', 'dispatched'], ['pending', 'delivered'], ['pending', 'processing'], ['pending', 'packed'], ['pending', 'ready_for_pickup'],
    ['accepted', 'pending'], ['accepted', 'delivered'], ['packed', 'delivered'], ['packed', 'processing'],
    ['dispatched', 'packed'], ['dispatched', 'accepted'], ['ready_for_pickup', 'packed'],
  ];
  for (const [from, to] of rejected) {
    for (const method of ['home_delivery', 'gym_pickup']) {
      assert.equal(decideTransition({ from, to, deliveryMethod: method }).ok, false, `${from} → ${to} (${method})`);
    }
  }
});

test('legacy: confirmed means accepted, fulfilled means delivered, and a stored confirmed is accepted', () => {
  assert.deepEqual(decideTransition({ from: 'pending', to: 'confirmed' }), { ok: true, store: 'confirmed' });
  assert.equal(canonicalStatus('confirmed'), 'accepted');
  assert.equal(canonicalStatus('fulfilled'), 'delivered');
  // A stored 'confirmed' moves like 'accepted'.
  assert.deepEqual(decideTransition({ from: 'confirmed', to: 'processing' }), { ok: true, store: 'processing' });
  assert.equal(decideTransition({ from: 'confirmed', to: 'accepted' }).noop, true);
  assert.equal(decideTransition({ from: 'accepted', to: 'confirmed' }).noop, true);
  // The documented two-step contract: confirmed → fulfilled.
  assert.deepEqual(decideTransition({ from: 'confirmed', to: 'fulfilled' }), { ok: true, store: 'delivered' });
  assert.deepEqual(decideTransition({ from: 'packed', to: 'fulfilled', deliveryMethod: 'gym_pickup' }), { ok: true, store: 'delivered' });
  // …but acceptance still cannot be skipped, and a final order stays final.
  assert.equal(decideTransition({ from: 'pending', to: 'fulfilled' }).ok, false);
  assert.equal(decideTransition({ from: 'cancelled', to: 'fulfilled' }).ok, false);
  assert.equal(decideTransition({ from: 'delivered', to: 'fulfilled' }).noop, true);
  assert.equal(decideTransition({ from: 'accepted', to: 'nonsense' }).error, 'invalid_status');
});

test('combined status: the least advanced live fulfilment, delivered only when all are', () => {
  const f = (...statuses) => statuses.map((status, i) => ({ vendorId: `v${i}`, status }));
  assert.equal(combinedStatus(f('delivered')), 'delivered');
  assert.equal(combinedStatus(f('dispatched', 'pending')), 'pending');
  assert.equal(combinedStatus(f('dispatched', 'packed')), 'packed');
  assert.equal(combinedStatus(f('delivered', 'dispatched')), 'dispatched');
  assert.equal(combinedStatus(f('delivered', 'delivered')), 'delivered');
  assert.equal(combinedStatus(f('cancelled', 'cancelled')), 'cancelled');
  assert.equal(combinedStatus(f('cancelled', 'accepted')), 'accepted');
  assert.equal(combinedStatus(f('confirmed', 'accepted')), 'confirmed');
  assert.equal(combinedStatus([]), null);
});

test('orders made before fulfilments existed get one fulfilment per vendor at the order\'s status', () => {
  const order = { status: 'packed', updatedAt: 't', items: [{ vendorId: 'a' }, { vendorId: 'a' }, { vendorId: 'b' }] };
  assert.deepEqual(fulfilmentsOf(order).map(f => [f.vendorId, f.status]), [['a', 'packed'], ['b', 'packed']]);
  assert.deepEqual(fulfilmentsOf({ status: 'pending', items: [{ productId: 'p' }] }, ['v']).map(f => f.vendorId), ['v']);
  const stored = { fulfilments: [{ vendorId: 'a', status: 'accepted' }], items: [{ vendorId: 'a' }] };
  assert.equal(fulfilmentsOf(stored), stored.fulfilments);
});
