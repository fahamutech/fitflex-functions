import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adminUpsertGym, listGyms } from '../functions/gyms.mjs';
import { adminUpsertTrainer, listTrainers } from '../functions/trainers.mjs';
import {
  adminListProducts,
  adminUpdateProductListing,
  listShopProducts,
  vendorCreateProduct,
} from '../functions/shop.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const admin = { sub: 'usr_admin_1', userType: 'admin' };

test('UAT 55: admin priority and visibility control public gym listings', async () => {
  const suffix = randomUUID();
  const create = async (name, priority, visible = true) => {
    const out = res();
    await adminUpsertGym.onRequest({
      user: admin,
      body: {
        name: `${name} ${suffix}`,
        tier: 'standard',
        location: 'Dar es Salaam',
        status: 'active',
        homepageVisible: visible,
        homepagePriority: priority,
      },
    }, out);
    assert.equal(out.statusCode, 200);
    return out.body;
  };

  const low = await create('Low priority gym', 10);
  const high = await create('High priority gym', 900);
  const hidden = await create('Hidden gym', 1000, false);
  const publicList = res();
  await listGyms.onRequest({}, publicList);
  const ids = publicList.body.map((gym) => gym.id);
  assert.ok(ids.indexOf(high.id) < ids.indexOf(low.id));
  assert.equal(ids.includes(hidden.id), false);
});

test('UAT 55: admin priority and visibility control public trainer listings', async () => {
  const suffix = randomUUID();
  const create = async (name, priority, visible = true) => {
    const out = res();
    await adminUpsertTrainer.onRequest({
      user: admin,
      body: {
        displayName: `${name} ${suffix}`,
        email: `${name.toLowerCase().replaceAll(' ', '-')}-${suffix}@example.com`,
        specialties: ['Strength'],
        hourlyRateTzs: 15000,
        status: 'active',
        homepageVisible: visible,
        homepagePriority: priority,
      },
    }, out);
    assert.equal(out.statusCode, 201);
    return out.body;
  };

  const low = await create('Low priority trainer', 10);
  const high = await create('High priority trainer', 900);
  const hidden = await create('Hidden trainer', 1000, false);
  const publicList = res();
  await listTrainers.onRequest({ query: {} }, publicList);
  const ids = publicList.body.map((trainer) => trainer.id);
  assert.ok(ids.indexOf(high.id) < ids.indexOf(low.id));
  assert.equal(ids.includes(hidden.id), false);
});

test('UAT 55: admin priority and visibility control public product listings', async () => {
  const suffix = randomUUID();
  const vendor = { sub: `usr_vendor_${suffix}`, userType: 'vendor' };
  const create = async (name) => {
    const out = res();
    await vendorCreateProduct.onRequest({
      user: vendor,
      body: { name: `${name} ${suffix}`, priceTzs: 10000, stock: 10 },
    }, out);
    assert.equal(out.statusCode, 201);
    return out.body;
  };

  const low = await create('Low priority product');
  const high = await create('High priority product');
  const hidden = await create('Hidden product');
  for (const [product, homepagePriority, homepageVisible] of [
    [low, 10, true],
    [high, 900, true],
    [hidden, 1000, false],
  ]) {
    const updated = res();
    await adminUpdateProductListing.onRequest({
      user: admin,
      params: { id: product.id },
      body: { homepagePriority, homepageVisible, approvalStatus: 'approved' },
    }, updated);
    assert.equal(updated.statusCode, 200);
  }

  const adminList = res();
  await adminListProducts.onRequest({ user: admin }, adminList);
  assert.equal(adminList.body.find((product) => product.id === hidden.id).homepageVisible, false);

  const publicList = res();
  await listShopProducts.onRequest({ user: vendor, query: {} }, publicList);
  const ids = publicList.body.map((product) => product.id);
  assert.ok(ids.indexOf(high.id) < ids.indexOf(low.id));
  assert.equal(ids.includes(hidden.id), false);
});
