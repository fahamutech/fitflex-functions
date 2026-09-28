// Partner KYC enforcement: partners created from the enforcement start go live
// only once their KYC is approved; partners who already existed are exempt and
// keep working as before. The rest of the suite runs with enforcement off
// (package.json), so this file switches it on for itself.
process.env.KYC_ENFORCEMENT = 'on';
process.env.KYC_ENFORCEMENT_FROM = '2026-01-01T00:00:00.000Z';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import {
  partnerGate, trainerService, trainerBookingService, ownerGymService, gymService, shopService,
  checkInService, adminApprovalService, partnerKycService, trainers, gyms,
} from '../src/bootstrap/services.mjs';
import { createPartnerGate, OPEN_GATE, ENFORCEMENT_START } from '../src/services/partner-gate.mjs';
import { getGym } from '../functions/gyms.mjs';
import { sign } from '../src/auth/jwt.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const created = { users: [], gyms: [], products: [], trainers: [] };
const EXISTING = new Date('2025-06-01T00:00:00Z'); // before the enforcement start
const superAdmin = { id: null, role: 'admin', superAdmin: true };

async function makeUser(userType, { existing = false, ...extra } = {}) {
  const id = uid('usr');
  await db('User').insert({
    id, userType, displayName: `KYC gate ${userType}`, approvalStatus: 'pending_approval',
    createdAt: existing ? EXISTING : new Date(), updatedAt: new Date(), ...extra,
  });
  created.users.push(id);
  return id;
}

async function makeTrainer(opts = {}) {
  const userId = await makeUser('trainer', opts);
  const gymId = await makeGym();
  const id = uid('trn');
  created.trainers.push(id);
  await trainers.insertAsync({
    id, userId, displayName: `Gate Trainer ${id}`, status: 'active', approvalStatus: 'pending_approval',
    specialties: ['strength'], gymIds: [gymId], availability: [{ day: 'monday', gymId, slots: ['09:00'] }],
  });
  return { userId, trainerId: id, gymId };
}

async function makeGym(status = 'active') {
  const id = uid('gym');
  await gyms.upsertAsync(g => g.id === id, gymService.normalizeGymPayload({ id, name: `Gate Gym ${id}`, tier: 'standard', location: 'Masaki', status }, {}));
  await gyms.updateAsync(g => g.id === id, { status });
  created.gyms.push(id);
  return id;
}

async function approveCase(userId, partnerType, status = 'approved') {
  await db('PartnerKycCase').insert({
    id: uid('kyc'), partnerType, userId, status, tier: 2, updatedAt: new Date(),
    ...(status === 'suspended' ? { reasonCode: 'document_expired' } : {}),
  });
}

async function makeProduct(vendorId) {
  const id = uid('prd');
  await db('Product').insert({
    id, vendorId, name: `Gate Product ${id}`, priceTzs: 10000, stock: 5, status: 'active',
    approvalStatus: 'approved', visibility: 'visible', updatedAt: new Date(),
  });
  created.products.push(id);
  return id;
}

after(async () => {
  if (created.products.length) await db('Product').whereIn('id', created.products).del();
  for (const id of created.trainers) await trainers.removeAsync(t => t.id === id);
  for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  if (created.users.length) {
    await db('AuditLog').whereIn('actor', created.users).del();
    await db('User').whereIn('id', created.users).del();
  }
});

// ── The gate ────────────────────────────────────────────────────────────────

test('existing partners are exempt; new ones need an approved or suspended case', async () => {
  const gate = createPartnerGate({ users: { filterByColumnInAsync: async () => [] }, partnerKycCases: {}, env: {} });
  assert.equal(gate.enabled(), true);
  assert.equal(gate.start().toISOString(), ENFORCEMENT_START);
  assert.equal(gate.exempt({ createdAt: '2026-09-27T12:00:00Z' }), true);
  assert.equal(gate.exempt({ createdAt: '2026-09-28T09:00:00Z' }), false);
  assert.equal(gate.exempt({}), true); // no creation date: treated as existing
  assert.equal(createPartnerGate({ users: {}, partnerKycCases: {}, env: { KYC_ENFORCEMENT: 'OFF' } }).exempt({ createdAt: '2030-01-01' }), true);
  assert.equal(await OPEN_GATE.isOperational('anyone'), true);

  const newbie = await makeUser('trainer');
  const old = await makeUser('trainer', { existing: true });
  const approved = await makeUser('vendor');
  const suspended = await makeUser('vendor');
  const drafting = await makeUser('vendor');
  await approveCase(approved, 'vendor');
  await approveCase(suspended, 'vendor', 'suspended');
  await approveCase(drafting, 'vendor', 'submitted');
  const ok = await partnerGate.operationalUserIds([newbie, old, approved, suspended, drafting, 'usr_unknown', null]);
  assert.deepEqual([...ok].sort(), [old, approved, suspended, 'usr_unknown'].sort());
});

// ── Trainers ────────────────────────────────────────────────────────────────

test('a new trainer is hidden, unbookable and can\'t apply to gyms until verified', async () => {
  const t = await makeTrainer();
  const listed = async () => (await trainerService.listPublic({})).some(r => r.id === t.trainerId);
  assert.equal(await listed(), false);
  assert.equal(await trainerService.getPublic(t.trainerId), null);
  assert.equal((await trainerBookingService.publicSchedule({ trainerId: t.trainerId, days: 7 })).error, 'trainer_not_found');
  const apply = await trainerService.applyToGym({ userId: t.userId, gymId: await makeGym() });
  assert.deepEqual([apply.error, apply.status], ['verification_required', 403]);

  await approveCase(t.userId, 'trainer');
  assert.equal(await listed(), true);
  assert.ok(await trainerService.getPublic(t.trainerId));
  assert.ok(!(await trainerBookingService.publicSchedule({ trainerId: t.trainerId, days: 7 })).error);
  assert.ok(!(await trainerService.applyToGym({ userId: t.userId, gymId: await makeGym() })).error);
});

test('an existing trainer keeps working even while still pending approval', async () => {
  const t = await makeTrainer({ existing: true });
  assert.ok((await trainerService.listPublic({})).some(r => r.id === t.trainerId));
  assert.ok(await trainerService.getPublic(t.trainerId));
  assert.ok(!(await trainerService.applyToGym({ userId: t.userId, gymId: await makeGym() })).error);
});

// ── Gym owners ──────────────────────────────────────────────────────────────

test('a new owner\'s gyms wait for KYC: hidden, no check-ins, then open on approval', async () => {
  const ownerId = await makeUser('gym_operator');
  const owner = await db('User').where('id', ownerId).first();
  const reg = await ownerGymService.registerOwner({ user: owner, body: { gyms: [{ name: 'Waiting Gym', tier: 'standard', location: 'Sinza' }] } });
  const gymId = reg.gymIds[0];
  created.gyms.push(gymId);
  assert.equal(reg.gyms[0].status, 'pending_verification');

  assert.equal((await gymService.listActiveAsync()).some(g => g.id === gymId), false);
  const call = async (claims) => {
    const out = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await getGym.onRequest({ params: { id: gymId }, headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {} }, out);
    return out.statusCode;
  };
  assert.equal(await call(null), 404);
  assert.equal(await call({ sub: 'm', userType: 'member' }), 404);
  assert.equal(await call({ sub: 'a', userType: 'admin' }), 200);

  const memberId = await makeUser('member', { approvalStatus: 'approved' });
  assert.deepEqual(await checkInService.perform({ memberId, gymId }), { ok: false, failure: 'gym_not_verified' });

  // Approval (here by a super-admin override) opens the gym.
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'gym_owner', userId: ownerId, status: 'in_review', tier: 3, updatedAt: new Date() });
  const approved = await partnerKycService.decide(caseId, { decision: 'approve', override: true, reasonNote: 'Pilot gym seen in person.' }, superAdmin);
  assert.equal(approved.case.status, 'approved');
  assert.equal((await gyms.findByIdAsync(gymId)).status, 'active');
  assert.equal((await gymService.listActiveAsync()).some(g => g.id === gymId), true);
  assert.equal(await call(null), 200);

  // A verified owner's next gym opens at once.
  const again = await db('User').where('id', ownerId).first();
  await ownerGymService.createGym({ owner: again, body: { name: 'Second Gym', tier: 'standard', location: 'Mbezi' } });
  const second = (await db('User').where('id', ownerId).first()).gymIds.find(id => id !== gymId);
  created.gyms.push(second);
  assert.equal((await gyms.findByIdAsync(second)).status, 'active');
});

test('an existing owner\'s new gym opens at once', async () => {
  const ownerId = await makeUser('gym_operator', { existing: true });
  const owner = await db('User').where('id', ownerId).first();
  const reg = await ownerGymService.registerOwner({ user: owner, body: { gyms: [{ name: 'Old Owner Gym', tier: 'standard', location: 'Kinondoni' }] } });
  created.gyms.push(reg.gymIds[0]);
  assert.equal(reg.gyms[0].status, 'active');
});

// ── Vendors ─────────────────────────────────────────────────────────────────

test('a new vendor\'s products and store stay hidden until verified; the vendor still sees their own', async () => {
  const vendorId = await makeUser('vendor', { vendorProfile: JSON.stringify({ businessName: 'Gate Store', status: 'published' }) });
  const productId = await makeProduct(vendorId);
  const visible = async () => (await shopService.listProducts({})).some(p => p.id === productId);
  assert.equal(await visible(), false);
  assert.equal(await shopService.getVendorStore(vendorId), null);
  assert.ok((await shopService.listProducts({ vendorId, includeArchived: true })).some(p => p.id === productId));
  const buyerId = await makeUser('member', { approvalStatus: 'approved' });
  const order = await shopService.createOrder({ buyerId, body: { items: [{ productId, qty: 1 }], deliveryMethod: 'home_delivery', deliveryAddress: 'Sinza', paymentMethod: 'mpesa', paymentOutcome: 'success' } });
  assert.equal(order.error, 'product_not_found');

  await approveCase(vendorId, 'vendor');
  assert.equal(await visible(), true);
  assert.ok(await shopService.getVendorStore(vendorId));
});

test('an existing vendor\'s products stay on sale', async () => {
  const vendorId = await makeUser('vendor', { existing: true });
  const productId = await makeProduct(vendorId);
  assert.ok((await shopService.listProducts({})).some(p => p.id === productId));
});

// ── Role approvals ──────────────────────────────────────────────────────────

test('new partners are approved through KYC, not the old role-approval screen', async () => {
  const fresh = await makeUser('trainer');
  assert.deepEqual(await adminApprovalService.decide({ id: fresh, decision: 'approve', actorId: 'usr_admin' }), { error: 'use_kyc_review', status: 409 });
  const old = await makeUser('trainer', { existing: true });
  assert.equal((await adminApprovalService.decide({ id: old, decision: 'approve', actorId: 'usr_admin' })).user.approvalStatus, 'approved');
});

test('a new vendor is approved through KYC, not the vendor admin page; the admin list shows KYC status', async () => {
  const fresh = await makeUser('vendor');
  assert.deepEqual(
    await shopService.adminUpdateVendor({ vendorId: fresh, body: { approvalStatus: 'approved' }, actorId: 'usr_admin' }),
    { error: 'use_kyc_review', status: 409 },
  );
  // Suspending an account is still an admin action.
  assert.equal((await shopService.adminUpdateVendor({ vendorId: fresh, body: { accountStatus: 'suspended' }, actorId: 'usr_admin' })).vendor.accountStatus, 'suspended');
  await approveCase(fresh, 'vendor');
  const old = await makeUser('vendor', { existing: true });
  const rows = await shopService.adminListVendors();
  const row = id => rows.find(v => v.id === id);
  assert.deepEqual([row(fresh).kycStatus, row(fresh).kycExempt], ['approved', false]);
  assert.deepEqual([row(old).kycStatus, row(old).kycExempt], [null, true]);
  assert.equal((await shopService.adminUpdateVendor({ vendorId: old, body: { approvalStatus: 'approved' }, actorId: 'usr_admin' })).vendor.approvalStatus, 'approved');
});

test('F5: an owner can edit their gym but not its badge, commission, placement, status or payout details', async () => {
  const ownerId = await makeUser('gym_operator', { existing: true });
  const owner = await db('User').where('id', ownerId).first();
  const reg = await ownerGymService.registerOwner({ user: owner, body: { gyms: [{
    name: 'Honest Gym', tier: 'standard', location: 'Sinza', verified: true, commissionRate: 0, homepagePriority: 9999,
    paymentBank: 'Sneaky Bank', paymentNumber: '000', tinNumber: '999', status: 'active',
  }] } });
  const gymId = reg.gymIds[0];
  created.gyms.push(gymId);
  const fresh = await gyms.findByIdAsync(gymId);
  assert.deepEqual([fresh.commissionRate, Number(fresh.homepagePriority), fresh.paymentBank, fresh.tinNumber], [12, 0, null, null]);
  assert.equal(fresh.verified, false); // incomplete profile; the owner's "true" is ignored

  // FitFlex sets the commercial fields; the owner then edits the name.
  await gyms.updateAsync(g => g.id === gymId, { commissionRate: 15, paymentBank: 'CRDB', paymentNumber: '0150', verified: true, status: 'active' });
  const again = await db('User').where('id', ownerId).first();
  const edit = await ownerGymService.updateGym({ owner: again, gymId, body: {
    name: 'Honest Gym Masaki', commissionRate: 0, paymentBank: 'Sneaky Bank', paymentNumber: '111', verified: false,
    homepageVisible: false, homepagePriority: 9999, status: 'suspended',
  } });
  const g = edit.gym;
  assert.equal(g.name, 'Honest Gym Masaki');
  assert.deepEqual([g.commissionRate, g.paymentBank, g.paymentNumber, g.verified, g.homepageVisible, Number(g.homepagePriority), g.status],
    [15, 'CRDB', '0150', true, true, 0, 'active']);
});
