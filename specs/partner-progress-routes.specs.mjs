// Partner progress (Phase B · B4a) through GET /me/kyc, against the database:
// the flag, each partner type, a gym owner with several gyms, and that
// nothing admin-only or payout-sensitive comes back.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { trainers, gyms, gymService } from '../src/bootstrap/services.mjs';
import { myKyc, adminKycPartner } from '../functions/partner-kyc.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const created = { users: [], gyms: [], trainers: [], cases: [] };
const ENV_KEYS = ['PARTNER_PROGRESS', 'KYC_ENFORCEMENT', 'KYC_ENFORCEMENT_FROM'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

after(async () => {
  if (created.cases.length) {
    await db('PartnerSettlementAccount').whereIn('caseId', created.cases).del();
    await db('PartnerKycEvent').whereIn('caseId', created.cases).del();
    await db('PartnerKycCase').whereIn('id', created.cases).del();
  }
  for (const id of created.trainers) await trainers.removeAsync(t => t.id === id);
  for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  if (created.users.length) {
    await db('AuditLog').whereIn('actor', created.users).del();
    await db('User').whereIn('id', created.users).del();
  }
});

async function makeUser(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Progress ${userType}`, approvalStatus: 'approved', createdAt: new Date(), updatedAt: new Date(), ...extra });
  created.users.push(id);
  return id;
}

async function makeGym() {
  const id = uid('gym');
  await gyms.upsertAsync(g => g.id === id, gymService.normalizeGymPayload({ id, name: `Progress Gym ${id}`, tier: 'standard', location: 'Masaki', status: 'active' }, {}));
  created.gyms.push(id);
  return id;
}

async function makeCase(userId, partnerType, status, extra = {}) {
  const id = uid('kyc');
  await db('PartnerKycCase').insert({ id, partnerType, userId, status, tier: 2, updatedAt: new Date(), ...extra });
  created.cases.push(id);
  return id;
}

async function addAccount(caseId, { status = 'verified', cooldownUntil = new Date(Date.now() - 3_600_000), isPrimary = true } = {}) {
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'mobile_money', provider: 'mpesa', accountName: 'Progress Partner', accountNumber: '0754123987',
    status, isPrimary, verifiedAt: status === 'verified' ? new Date() : null, cooldownUntil: status === 'verified' ? cooldownUntil : null, updatedAt: new Date(),
  });
}

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function call(route, { claims, params = {} }) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body: {}, query: {} };
  const out = res();
  for (const guard of [route.onGuard].flat()) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

const read = async (id, userType) => {
  const r = await call(myKyc, { claims: { sub: id, userType } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return r.body;
};
const states = p => Object.fromEntries(p.steps.map(s => [s.key, s.state]));

test('flag off: /me/kyc has no progress field', async () => {
  delete process.env.PARTNER_PROGRESS;
  const id = await makeUser('trainer');
  const body = await read(id, 'trainer');
  assert.equal(body.partnerType, 'trainer');
  assert.equal('progress' in body, false);
  process.env.PARTNER_PROGRESS = 'false';
  assert.equal('progress' in await read(id, 'trainer'), false);
});

test('trainer with no case: approved, verification current, the missing checklist items', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  const id = await makeUser('trainer');
  const body = await read(id, 'trainer');
  const p = body.progress;
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'current', payoutReady: 'todo' });
  assert.equal(p.current, 'verified');
  assert.equal(p.nextAction.code, 'complete_kyc_items');
  assert.deepEqual(p.nextAction.missing, body.checklist.missing);
  assert.ok(p.nextAction.missing.length > 0);
  assert.match(p.steps[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('trainer asked for changes: reason code only, the note stays out of progress', async () => {
  process.env.PARTNER_PROGRESS = '1';
  const id = await makeUser('trainer');
  await makeCase(id, 'trainer', 'info_requested', { reasonCode: 'document_unreadable', reasonNote: 'PRIVATE-NOTE-123' });
  const p = (await read(id, 'trainer')).progress;
  assert.equal(p.current, 'verified');
  assert.equal(p.nextAction.code, 'kyc_changes_requested');
  assert.equal(p.nextAction.reasonCode, 'document_unreadable');
  assert.ok(!JSON.stringify(p).includes('PRIVATE-NOTE-123'));
});

test('verified trainer with a payable account: ready to be paid, no account details in progress', async () => {
  process.env.PARTNER_PROGRESS = 'true';
  const id = await makeUser('trainer');
  const trainerId = uid('trn');
  created.trainers.push(trainerId);
  await trainers.insertAsync({ id: trainerId, userId: id, displayName: 'Progress Trainer', status: 'active', approvalStatus: 'approved', specialties: ['strength'], gymIds: [] });
  const caseId = await makeCase(id, 'trainer', 'approved', { decidedAt: new Date('2026-10-05T10:00:00Z') });
  await addAccount(caseId);
  const p = (await read(id, 'trainer')).progress;
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'done', payoutReady: 'done' });
  assert.equal(p.steps[2].at, '2026-10-05T10:00:00.000Z');
  assert.deepEqual(p.nextAction, { code: 'none' });
  assert.ok(!JSON.stringify(p).includes('0754123987') && !JSON.stringify(p).includes('3987'));
});

test('suspended trainer: verification and payout blocked', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  const id = await makeUser('trainer');
  const trainerId = uid('trn');
  created.trainers.push(trainerId);
  await trainers.insertAsync({ id: trainerId, userId: id, displayName: 'Suspended Trainer', status: 'active', approvalStatus: 'approved', specialties: [], gymIds: [] });
  const caseId = await makeCase(id, 'trainer', 'suspended', { reasonCode: 'document_expired' });
  await addAccount(caseId);
  const p = (await read(id, 'trainer')).progress;
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'blocked', payoutReady: 'blocked' });
  assert.deepEqual(p.nextAction, { code: 'contact_support', reason: 'kyc_suspended' });
});

test('new vendor waiting for approval: approval is current and points at the KYC', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  process.env.KYC_ENFORCEMENT = 'on';
  process.env.KYC_ENFORCEMENT_FROM = '2026-01-01T00:00:00.000Z';
  const id = await makeUser('vendor', { approvalStatus: 'pending_approval' });
  const p = (await read(id, 'vendor')).progress;
  assert.deepEqual(states(p), { registered: 'done', approved: 'current', verified: 'todo', payoutReady: 'todo' });
  assert.equal(p.nextAction.code, 'complete_kyc_items');
});

test('legacy vendor waiting with no case: wait for approval', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  process.env.KYC_ENFORCEMENT = 'off'; // everyone counts as existing
  const id = await makeUser('vendor', { approvalStatus: 'pending_approval' });
  const p = (await read(id, 'vendor')).progress;
  assert.equal(p.current, 'approved');
  assert.deepEqual(p.nextAction, { code: 'wait_for_approval' });
});

test('vendor submitted: under review', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  const id = await makeUser('vendor', { approvalStatus: 'pending_approval' });
  await makeCase(id, 'vendor', 'submitted', { submittedAt: new Date() });
  const p = (await read(id, 'vendor')).progress;
  assert.equal(p.current, 'approved');
  assert.deepEqual(p.nextAction, { code: 'kyc_under_review' });
});

test('verified vendor whose payout account is waiting: payout account under review', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  const id = await makeUser('vendor');
  const caseId = await makeCase(id, 'vendor', 'approved', { decidedAt: new Date() });
  await addAccount(caseId, { status: 'pending_verification', isPrimary: false });
  const p = (await read(id, 'vendor')).progress;
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'done', payoutReady: 'current' });
  assert.deepEqual(p.nextAction, { code: 'payout_account_under_review' });
});

test('rejected vendor: blocked with the KYC rejection', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  const id = await makeUser('vendor', { approvalStatus: 'rejected', approvalNote: 'PRIVATE-REJECTION' });
  await makeCase(id, 'vendor', 'rejected', { reasonCode: 'suspected_fraud', reasonNote: 'PRIVATE-REJECTION' });
  const p = (await read(id, 'vendor')).progress;
  assert.equal(p.current, 'approved');
  assert.deepEqual(p.steps[1], { key: 'approved', state: 'blocked', reason: 'kyc_rejected' });
  assert.deepEqual(p.nextAction, { code: 'contact_support', reason: 'kyc_rejected' });
  assert.ok(!JSON.stringify(p).includes('PRIVATE-REJECTION'));
});

test('gym owner with two gyms: one tracker per gym plus an overall one', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  const g1 = await makeGym();
  const g2 = await makeGym();
  const id = await makeUser('gym_operator', { gymId: g1, gymIds: [g1, g2] });

  // Still in KYC: every gym is waiting on the one owner case.
  let body = await read(id, 'gym_operator');
  let p = body.progress;
  assert.equal(p.current, 'verified');
  assert.equal(p.nextAction.code, 'complete_kyc_items');
  assert.deepEqual(p.nextAction.missing, body.checklist.missing);
  assert.deepEqual(p.gyms.map(g => g.gymId), [g1, g2]);
  for (const g of p.gyms) {
    assert.match(g.name, /^Progress Gym /);
    assert.equal(g.progress.current, 'verified');
    assert.ok(g.progress.nextAction.missing.every(m => !m.includes('@') || m.endsWith(`@${g.gymId}`)), 'only this gym\'s items');
  }

  // Verified, account in its cooling-off: every gym waits, overall names the first.
  const caseId = await makeCase(id, 'gym_owner', 'approved', { decidedAt: new Date() });
  await addAccount(caseId, { cooldownUntil: new Date(Date.now() + 24 * 3_600_000) });
  body = await read(id, 'gym_operator');
  p = body.progress;
  assert.equal(p.current, 'payoutReady');
  assert.equal(p.nextAction.code, 'payout_account_cooling_off');
  assert.equal(p.nextAction.gymId, g1);
  assert.match(p.nextAction.until, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(p.gyms.map(g => g.progress.steps[3].state), ['current', 'current']);

  // Past the cooling-off: every gym ready.
  await db('PartnerSettlementAccount').where({ caseId }).update({ cooldownUntil: new Date(Date.now() - 3_600_000) });
  p = (await read(id, 'gym_operator')).progress;
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'done', payoutReady: 'done' });
  assert.deepEqual(p.nextAction, { code: 'none' });
  assert.deepEqual(p.gyms.map(g => g.progress.nextAction.code), ['none', 'none']);
});

test('gym owner with no gym: add a gym once verified', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  const id = await makeUser('gym_operator');
  const caseId = await makeCase(id, 'gym_owner', 'approved');
  await addAccount(caseId);
  const p = (await read(id, 'gym_operator')).progress;
  assert.deepEqual(p.gyms, []);
  assert.equal(p.current, 'payoutReady');
  assert.deepEqual(p.nextAction, { code: 'add_gym' });
});

test('the admin view of a partner is unchanged with the flag on', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  const admin = await makeUser('admin');
  const vendorId = await makeUser('vendor');
  const r = await call(adminKycPartner, { claims: { sub: admin, userType: 'admin' }, params: { partnerType: 'vendor', subjectId: vendorId } });
  assert.equal(r.statusCode, 200);
  assert.equal('progress' in r.body, false);
});
