// Gym payout owner (owner decision 2026-10-22, flag GYM_PAYOUT_OWNER): a gym
// shared by several owners has ONE named payout owner. Flag off = the first
// owner account found, as before. Flag on: the named payout owner; the only
// owner when there is one; payout_owner_required when 2+ owners and none is
// named. Covers payout eligibility, settlement payout gating and the
// statement payee, invoice payouts, the admin endpoints, removal clearing,
// what an owner sees, and partner progress.
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { createGymPayoutOwner } from '../src/services/gym-payout-owner.mjs';
import { createSettlementWorkflowService } from '../src/services/settlement-workflow-service.mjs';
import {
  gyms, gymService, gymPayoutOwner, payoutEligibility, adminOwnerService, ownerGymService,
  invoiceService, settlementViewService,
} from '../src/bootstrap/services.mjs';
import { adminListGyms, adminUpsertGym, adminGymPayoutOwner, adminSetGymPayoutOwner } from '../functions/gyms.mjs';
import { ownerUpdateGym } from '../functions/owner-gyms.mjs';
import { myKyc } from '../functions/partner-kyc.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const ENV_KEYS = ['GYM_PAYOUT_OWNER', 'PARTNER_PROGRESS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const flag = (v) => { if (v) process.env.GYM_PAYOUT_OWNER = v; else delete process.env.GYM_PAYOUT_OWNER; };
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// ── payout eligibility, stubbed (no database) ──────────────────────────────

describe('payout eligibility with a payout owner', () => {
  const AT = new Date('2026-12-05T09:00:00.000Z');
  const ownerA = { id: 'owner-a', userType: 'gym_operator', displayName: 'A', gymIds: ['gym-x'] };
  const ownerB = { id: 'owner-b', userType: 'gym_operator', displayName: 'B', gymIds: ['gym-x', 'gym-y'] };
  const solo = { id: 'owner-s', userType: 'gym_operator', displayName: 'S', gymId: 'gym-s' };
  const cases = { 'owner-a': { id: 'kyc-a', status: 'approved' }, 'owner-b': { id: 'kyc-b', status: 'approved' }, 'owner-s': { id: 'kyc-s', status: 'approved' } };
  const acct = (id, caseId, last4) => ({ id, caseId, status: 'verified', isPrimary: true, method: 'bank', accountNumber: `015000${last4}`, cooldownUntil: '2026-12-01T00:00:00.000Z' });
  const accounts = { 'kyc-a': [acct('acc-a', 'kyc-a', '1111')], 'kyc-b': [], 'kyc-s': [acct('acc-s', 'kyc-s', '3333')] };

  function build({ gymRows = [{ id: 'gym-x', payoutOwnerId: null }, { id: 'gym-y' }, { id: 'gym-s' }], owners = [ownerA, ownerB, solo], kyc = cases } = {}) {
    const users = {
      findAsync: async f => owners.find(f) ?? null,
      filterByColumnAsync: async (col, v) => owners.filter(u => u[col] === v),
    };
    const g = { find: f => gymRows.find(f) };
    return createPayoutEligibility({
      users, gyms: g,
      partnerGate: { kycCaseFor: async userId => kyc[userId] ?? null, exempt: () => false },
      partnerSettlementAccounts: { filterByColumnAsync: async (_c, caseId) => accounts[caseId] ?? [] },
      payoutOwner: createGymPayoutOwner({ users, gyms: g }),
    });
  }

  test('flag off: unchanged — the first owner found decides, even with a payout owner stored', async () => {
    flag(null);
    const e = build({ gymRows: [{ id: 'gym-x', payoutOwnerId: 'owner-b' }] });
    const r = await e.forGym('gym-x', { at: AT });
    assert.equal(r.ok, true);
    assert.equal(r.destination.ownerId, 'owner-a');
    // With ownerId, still that owner's own case only.
    assert.equal((await e.forGym('gym-x', { at: AT, ownerId: 'owner-b' })).reason, 'payout_account_not_verified');
  });

  test('flag on, one owner, none named: that owner is used with no admin step', async () => {
    flag('on');
    const r = await build().forGym('gym-s', { at: AT });
    assert.equal(r.ok, true);
    assert.equal(r.destination.ownerId, 'owner-s');
    assert.equal(r.destination.accountLast4, '3333');
    assert.equal((await build().forGym('gym-s', { at: AT, ownerId: 'owner-s' })).ok, true);
  });

  test('flag on, two owners, none named: not payable — payout_owner_required (also for each owner asking)', async () => {
    flag('1');
    const e = build();
    assert.deepEqual(await e.forGym('gym-x', { at: AT }), { ok: false, reason: 'payout_owner_required' });
    assert.deepEqual(await e.forGym('gym-x', { at: AT, ownerId: 'owner-a' }), { ok: false, reason: 'payout_owner_required' });
    assert.deepEqual(await e.forGym('gym-x', { at: AT, ownerId: 'owner-b' }), { ok: false, reason: 'payout_owner_required' });
    assert.deepEqual(await e.forGym('gym-x', { at: AT, ownerId: 'stranger' }), { ok: false, reason: 'no_owner_account' });
    assert.deepEqual(await e.forGym('gym-none', { at: AT }), { ok: false, reason: 'no_owner_account' });
  });

  test('flag on, named: that owner\'s KYC and account decide; a co-owner asking hears not_payout_owner', async () => {
    flag('true');
    const toB = build({ gymRows: [{ id: 'gym-x', payoutOwnerId: 'owner-b' }] });
    // B is approved but has no verified account, though A has one: A's account is never used.
    assert.deepEqual(await toB.forGym('gym-x', { at: AT }), { ok: false, reason: 'payout_account_not_verified' });
    assert.deepEqual(await toB.forGym('gym-x', { at: AT, ownerId: 'owner-a' }), { ok: false, reason: 'not_payout_owner' });
    const draftB = build({ gymRows: [{ id: 'gym-x', payoutOwnerId: 'owner-b' }], kyc: { ...cases, 'owner-b': { id: 'kyc-b', status: 'draft' } } });
    assert.deepEqual(await draftB.forGym('gym-x', { at: AT }), { ok: false, reason: 'kyc_draft' });

    const toA = build({ gymRows: [{ id: 'gym-x', payoutOwnerId: 'owner-a' }] });
    const r = await toA.forGym('gym-x', { at: AT });
    assert.equal(r.ok, true);
    assert.deepEqual([r.destination.ownerId, r.destination.accountId], ['owner-a', 'acc-a']);
    assert.deepEqual(await toA.forGym('gym-x', { at: AT, ownerId: 'owner-b' }), { ok: false, reason: 'not_payout_owner' });
  });

  test('flag on, a stored payout owner who no longer owns the gym does not count', async () => {
    flag('on');
    const stale = build({ gymRows: [{ id: 'gym-x', payoutOwnerId: 'owner-gone' }] });
    assert.deepEqual(await stale.forGym('gym-x', { at: AT }), { ok: false, reason: 'payout_owner_required' });
    const staleSolo = build({ gymRows: [{ id: 'gym-s', payoutOwnerId: 'owner-gone' }] });
    assert.equal((await staleSolo.forGym('gym-s', { at: AT })).destination.ownerId, 'owner-s');
  });
});

// ── against the database ────────────────────────────────────────────────────

const created = { users: [], gyms: [], cases: [], invoices: [] };
after(async () => {
  if (created.invoices.length) {
    await db('GymPayout').whereIn('invoiceId', created.invoices).del();
    await db('Invoice').whereIn('id', created.invoices).del();
  }
  if (created.cases.length) {
    await db('PartnerSettlementAccount').whereIn('caseId', created.cases).del();
    await db('PartnerKycEvent').whereIn('caseId', created.cases).del();
    await db('PartnerKycCase').whereIn('id', created.cases).del();
  }
  if (created.gyms.length) await db('AuditLog').whereIn('target', created.gyms).del();
  for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  if (created.users.length) {
    await db('AuditLog').whereIn('actor', created.users).del();
    await db('AuditLog').whereIn('target', created.users).del();
    await db('User').whereIn('id', created.users).del();
  }
});

async function makeUser(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Payout ${userType} ${id.slice(-4)}`, email: `${id}@example.com`, approvalStatus: 'approved', createdAt: new Date(), updatedAt: new Date(), ...extra });
  created.users.push(id);
  return id;
}
async function makeGym() {
  const id = uid('gym');
  await gyms.upsertAsync(g => g.id === id, gymService.normalizeGymPayload({ id, name: `Payout Gym ${id}`, tier: 'standard', location: 'Masaki', status: 'active' }, {}));
  created.gyms.push(id);
  return id;
}
const makeOwner = gymIds => makeUser('gym_operator', { gymId: gymIds[0], gymIds });
/** An approved owner with a verified payout account past its cooling-off. */
async function payable(ownerId, last4) {
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'gym_owner', userId: ownerId, status: 'approved', tier: 2, decidedAt: new Date(), updatedAt: new Date() });
  created.cases.push(caseId);
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'mobile_money', provider: 'mpesa', accountName: 'Owner', accountNumber: `0754000${last4}`,
    status: 'verified', isPrimary: true, verifiedAt: new Date(), cooldownUntil: new Date(Date.now() - 3_600_000), updatedAt: new Date(),
  });
  return caseId;
}

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body, query, user: undefined };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
const superAdmin = async () => ({ sub: await makeUser('admin'), userType: 'admin' });
const storedPayoutOwner = async gymId => (await db('Gym').where('id', gymId).first()).payoutOwnerId;
const auditFor = (gymId, action) => db('AuditLog').where({ target: gymId, action }).orderBy('at');

test('admin sets a payout owner: must be one of the gym\'s owners; audited; clearing too', async () => {
  const gymId = await makeGym();
  const a = await makeOwner([gymId]);
  const b = await makeOwner([gymId]);
  const stranger = await makeOwner([await makeGym()]);
  const admin = await superAdmin();

  const refused = await call(adminSetGymPayoutOwner, { claims: admin, params: { id: gymId }, body: { ownerId: stranger } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.error, 'not_a_gym_owner');
  assert.deepEqual(refused.body.owners.map(o => o.id).sort(), [a, b].sort());
  assert.equal(await storedPayoutOwner(gymId), null);

  assert.equal((await call(adminSetGymPayoutOwner, { claims: admin, params: { id: gymId }, body: {} })).statusCode, 400);
  assert.equal((await call(adminSetGymPayoutOwner, { claims: admin, params: { id: 'gym_missing' }, body: { ownerId: a } })).statusCode, 404);

  const set = await call(adminSetGymPayoutOwner, { claims: admin, params: { id: gymId }, body: { ownerId: b } });
  assert.equal(set.statusCode, 200, JSON.stringify(set.body));
  assert.equal(set.body.payoutOwnerId, b);
  assert.equal(set.body.owners.length, 2);
  assert.equal(await storedPayoutOwner(gymId), b);
  const [setAudit] = await auditFor(gymId, 'gym_payout_owner_set');
  assert.equal(setAudit.actor, admin.sub);
  assert.deepEqual([setAudit.before.payoutOwnerId, setAudit.after.payoutOwnerId], [null, b]);

  const cleared = await call(adminSetGymPayoutOwner, { claims: admin, params: { id: gymId }, body: { ownerId: null } });
  assert.equal(cleared.body.payoutOwnerId, null);
  assert.equal(await storedPayoutOwner(gymId), null);
  assert.equal((await auditFor(gymId, 'gym_payout_owner_cleared')).length, 1);

  const read = await call(adminGymPayoutOwner, { claims: admin, params: { id: gymId } });
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.gymId, gymId);
});

test('admin endpoint ACL: gyms or owners scope; members and owners refused', async () => {
  const gymId = await makeGym();
  const a = await makeOwner([gymId]);
  const staffId = await makeUser('admin', { portalUser: true });
  const deny = await call(adminSetGymPayoutOwner, { claims: { sub: staffId, userType: 'admin', portalUser: true, aclPermissions: ['members'] }, params: { id: gymId }, body: { ownerId: a } });
  assert.equal(deny.statusCode, 403);
  for (const scope of ['gyms', 'owners']) {
    const ok = await call(adminSetGymPayoutOwner, { claims: { sub: staffId, userType: 'admin', portalUser: true, aclPermissions: [scope] }, params: { id: gymId }, body: { ownerId: a } });
    assert.equal(ok.statusCode, 200, scope);
  }
  const asOwner = await call(adminSetGymPayoutOwner, { claims: { sub: a, userType: 'gym_operator' }, params: { id: gymId }, body: { ownerId: a } });
  assert.notEqual(asOwner.statusCode, 200);
});

test('admin gym list and upsert answers carry payoutOwnerId, owners and payoutOwner', async () => {
  flag('on');
  const gymId = await makeGym();
  const a = await makeOwner([gymId]);
  const b = await makeOwner([gymId]);
  const admin = await superAdmin();
  for (const query of [{}, { full: 'true' }]) {
    const list = await call(adminListGyms, { claims: admin, query });
    const row = list.body.find(g => g.id === gymId);
    assert.equal(row.payoutOwnerId, null);
    assert.deepEqual(row.owners.map(o => o.id).sort(), [a, b].sort());
    assert.deepEqual(row.payoutOwner, { mode: 'named', ownerId: null, source: null, reason: 'payout_owner_required' });
  }
  await gymPayoutOwner.setPayoutOwner({ gymId, ownerId: a, actorId: admin.sub });
  const slim = (await call(adminListGyms, { claims: admin })).body.find(g => g.id === gymId);
  assert.equal(slim.payoutOwnerId, a, 'slim table rows read the stored payout owner');
  assert.deepEqual(slim.payoutOwner, { mode: 'named', ownerId: a, source: 'named', reason: null });

  // An admin gym edit keeps the payout owner, and can't set it through the gym body.
  const gym = gymService.findById(gymId);
  const edited = await call(adminUpsertGym, { claims: admin, body: { ...gym, name: 'Renamed', payoutOwnerId: b } });
  assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.payoutOwnerId, a);
  assert.equal(await storedPayoutOwner(gymId), a);
});

test('flag off: admin rows say mode first_owner; reasons only appear with the flag on', async () => {
  flag(null);
  const gymId = await makeGym();
  await makeOwner([gymId]);
  await makeOwner([gymId]);
  const view = await gymPayoutOwner.adminView(gymId);
  assert.deepEqual(view.payoutOwner, { mode: 'first_owner', ownerId: null, source: 'first_owner', reason: null });
});

test('taking the payout owner off the gym (or deleting them) clears it, with an audit row', async () => {
  flag('on');
  const gymId = await makeGym();
  const other = await makeGym();
  const a = await makeOwner([gymId, other]);
  const b = await makeOwner([gymId]);
  await gymPayoutOwner.setPayoutOwner({ gymId, ownerId: a, actorId: 'admin-x' });
  await gymPayoutOwner.setPayoutOwner({ gymId: other, ownerId: a, actorId: 'admin-x' });

  // Editing A without the gym: cleared for that gym only.
  const r = await adminOwnerService.upsert({ body: { id: a, gymIds: [other] }, actorId: 'admin-x' });
  assert.equal(r.error, undefined, r.error);
  assert.equal(await storedPayoutOwner(gymId), null);
  assert.equal(await storedPayoutOwner(other), a);
  const [audit] = await auditFor(gymId, 'gym_payout_owner_cleared');
  assert.deepEqual([audit.before.payoutOwnerId, audit.after.reason], [a, 'owner_removed_from_gym']);
  // B is now the only owner: payable to B with no admin step.
  assert.equal((await gymPayoutOwner.resolve(gymId)).owner.id, b);

  // Deleting an owner account clears the gyms they were payout owner of.
  await gymPayoutOwner.setPayoutOwner({ gymId, ownerId: b, actorId: 'admin-x' });
  const del = await adminOwnerService.remove({ id: b, actorId: 'admin-x' });
  assert.equal(del.error, undefined, del.error);
  assert.equal(await storedPayoutOwner(gymId), null);
  const deletedAudit = (await auditFor(gymId, 'gym_payout_owner_cleared')).at(-1);
  assert.equal(deletedAudit.after.reason, 'owner_deleted');
});

test('adding a second owner to a gym with none named: the owner answer lists it (flag on only)', async () => {
  const gymId = await makeGym();
  await makeOwner([gymId]);
  const b = await makeOwner([]);
  flag(null);
  const off = await adminOwnerService.upsert({ body: { id: b, gymIds: [gymId] }, actorId: 'admin-x' });
  assert.equal('payoutOwnerRequiredGymIds' in off.owner, false);
  flag('on');
  const on = await adminOwnerService.upsert({ body: { id: b, gymIds: [gymId] }, actorId: 'admin-x' });
  assert.deepEqual(on.owner.payoutOwnerRequiredGymIds, [gymId]);
});

test('owners see only whether they are the payout owner (boolean, flag on); never the id; cannot set it', async () => {
  const gymId = await makeGym();
  const a = await makeOwner([gymId]);
  const b = await makeOwner([gymId]);
  await gymPayoutOwner.setPayoutOwner({ gymId, ownerId: a, actorId: 'admin-x' });
  const ownerRow = async id => (await db('User').where('id', id).first());

  flag(null);
  const off = (await ownerGymService.myGyms(await ownerRow(a))).find(g => g.id === gymId);
  assert.equal('payoutOwnerId' in off, false);
  assert.equal('isPayoutOwner' in off, false);

  flag('on');
  assert.equal((await ownerGymService.myGyms(await ownerRow(a))).find(g => g.id === gymId).isPayoutOwner, true);
  const theirs = (await ownerGymService.myGyms(await ownerRow(b))).find(g => g.id === gymId);
  assert.equal(theirs.isPayoutOwner, false);
  assert.ok(!JSON.stringify(theirs).includes(a), 'the co-owner id is not in B\'s gym');

  // PUT /owner/gyms/:id ignores payoutOwnerId.
  const put = await call(ownerUpdateGym, { claims: { sub: b, userType: 'gym_operator' }, params: { gymId }, body: { name: 'Owner edit', payoutOwnerId: b } });
  assert.equal(put.statusCode, 200, JSON.stringify(put.body));
  assert.equal(await storedPayoutOwner(gymId), a);
});

test('partner progress: two owners, none named → payout_not_ready reason payout_owner_required; named → co-owner hears not_payout_owner', async () => {
  process.env.PARTNER_PROGRESS = 'on';
  flag('on');
  const gymId = await makeGym();
  const a = await makeOwner([gymId]);
  const b = await makeOwner([gymId]);
  await payable(a, '0101');
  await payable(b, '0202');
  const progressOf = async id => (await call(myKyc, { claims: { sub: id, userType: 'gym_operator' } })).body.progress;

  const pa = await progressOf(a);
  assert.equal(pa.current, 'payoutReady');
  assert.deepEqual(pa.nextAction, { code: 'payout_not_ready', reason: 'payout_owner_required', gymId });
  assert.deepEqual((await progressOf(b)).nextAction, { code: 'payout_not_ready', reason: 'payout_owner_required', gymId });

  await gymPayoutOwner.setPayoutOwner({ gymId, ownerId: a, actorId: 'admin-x' });
  assert.deepEqual((await progressOf(a)).nextAction, { code: 'none' });
  assert.deepEqual((await progressOf(b)).nextAction, { code: 'payout_not_ready', reason: 'not_payout_owner', gymId });

  flag(null); // unchanged with the flag off: each owner by their own KYC
  assert.deepEqual((await progressOf(b)).nextAction, { code: 'none' });
});

// ── settlement: payout gating and the statement payee ──────────────────────

const ROLLBACK = Symbol('rollback');
async function inRollback(fn) {
  try { await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; }); } catch (err) { if (err !== ROLLBACK) throw err; }
}
async function approvedStatement(trx, gymId) {
  const run = { id: uid('run'), mode: 'live', periodStartDate: '2026-11-01', periodEndDate: '2026-12-01', status: 'draft', engineVersion: 'settlement-engine/1', createdBy: 'system' };
  await trx('SettlementRun').insert(run);
  const id = uid('gs');
  await trx('GymSettlement').insert({ id, runId: run.id, mode: 'live', gymId, periodStartDate: run.periodStartDate, periodEndDate: run.periodEndDate,
    memberCycleCount: 1, qualifyingVisitCount: 3, preliminaryTzs: 30000, networkAdjustmentTzs: 0, finalNetTzs: 30000 });
  await trx('SettlementRun').where({ id: run.id }).update({ status: 'locked', lockedAt: new Date(), lockedBy: 'system', inputsHash: 'sha256:test' });
  const workflow = createSettlementWorkflowService({ db: trx, payoutEligibility });
  await workflow.submit({ id, actorId: 'maker' });
  await workflow.approve({ id, actorId: 'checker' });
  return { id, workflow };
}

test('settlement: two owners unset → not payable (payout_owner_required); named → paid to that owner, statement payee says so', async () => {
  flag('on');
  const gymId = await makeGym();
  const a = await makeOwner([gymId]);
  const b = await makeOwner([gymId]);
  await payable(a, '1001');
  await payable(b, '2002');
  await inRollback(async (trx) => {
    const { id, workflow } = await approvedStatement(trx, gymId);
    const held = await workflow.markPayable({ id, actorId: 'payer' });
    assert.deepEqual([held.error, held.reason], ['not_payable', 'payout_owner_required']);

    await gymPayoutOwner.setPayoutOwner({ gymId, ownerId: b, actorId: 'admin-x' });
    const ok = await workflow.markPayable({ id, actorId: 'payer' });
    assert.equal(ok.error, undefined, JSON.stringify(ok));
    assert.equal(ok.statement.destinationSnapshot.ownerId, b);
    assert.equal(ok.statement.destinationSnapshot.accountLast4, '2002');
    const paid = await workflow.pay({ id, paymentReference: 'MPESA-PAYOWNER', actorId: 'payer' });
    assert.equal(paid.statement.destinationSnapshot.ownerId, b);
  });
  await gymPayoutOwner.setPayoutOwner({ gymId, ownerId: null, actorId: 'admin-x' });
});

test('admin statement view: payee (flag on) from the snapshot once payable, else who would be paid or why not', async () => {
  const gymId = await makeGym();
  const a = await makeOwner([gymId]);
  await makeOwner([gymId]);
  await payable(a, '3003');
  // The view reads committed rows: create, read, then remove.
  const run = { id: uid('run'), mode: 'live', periodStartDate: '2026-10-01', periodEndDate: '2026-11-01', status: 'locked', engineVersion: 'settlement-engine/1', createdBy: 'system', lockedAt: new Date(), lockedBy: 'system', inputsHash: 'sha256:t' };
  const sid = uid('gs');
  await db('SettlementRun').insert({ ...run, status: 'draft', lockedAt: null, lockedBy: null, inputsHash: null });
  await db('GymSettlement').insert({ id: sid, runId: run.id, mode: 'live', gymId, periodStartDate: run.periodStartDate, periodEndDate: run.periodEndDate,
    memberCycleCount: 1, qualifyingVisitCount: 1, preliminaryTzs: 5000, networkAdjustmentTzs: 0, finalNetTzs: 5000 });
  try {
    flag(null);
    assert.equal('payee' in await settlementViewService.adminStatement(sid), false, 'flag off: no payee field');
    flag('on');
    assert.deepEqual((await settlementViewService.adminStatement(sid)).payee, { ownerId: null, displayName: null, source: null, reason: 'payout_owner_required' });
    await gymPayoutOwner.setPayoutOwner({ gymId, ownerId: a, actorId: 'admin-x' });
    const named = (await settlementViewService.adminStatement(sid)).payee;
    assert.deepEqual([named.ownerId, named.source], [a, 'named']);
    await db('GymSettlement').where({ id: sid }).update({ destinationSnapshot: JSON.stringify({ kind: 'verified_account', ownerId: a, accountLast4: '3003' }) });
    const snap = (await settlementViewService.adminStatement(sid)).payee;
    assert.deepEqual([snap.ownerId, snap.source], [a, 'destination_snapshot']);
  } finally {
    await db('GymSettlement').where({ id: sid }).del().catch(() => {});
    await db('SettlementRun').where({ id: run.id }).del().catch(() => {});
    await db('AuditLog').where({ target: sid }).del().catch(() => {});
  }
});

test('invoices: flag on, 2 owners none named → paying is held (payout_owner_required); the invoice owner is the payout owner', async () => {
  flag('on');
  const gymId = await makeGym();
  const a = await makeOwner([gymId]);
  const b = await makeOwner([gymId]);
  const inv = await invoiceService.create({ gymId, amount: 1000, actorId: 'admin-x' });
  created.invoices.push(inv.invoice.id);
  assert.equal(inv.invoice.ownerId, null);
  const held = await invoiceService.update({ id: inv.invoice.id, status: 'paid', actorId: 'admin-x' });
  assert.deepEqual([held.error, held.status, held.reason], ['payout_on_hold', 409, 'payout_owner_required']);

  await gymPayoutOwner.setPayoutOwner({ gymId, ownerId: b, actorId: 'admin-x' });
  const named = await invoiceService.create({ gymId, amount: 2000, actorId: 'admin-x' });
  created.invoices.push(named.invoice.id);
  assert.equal(named.invoice.ownerId, b);

  flag(null); // flag off: the first owner found, as before
  const before = await invoiceService.create({ gymId, amount: 3000, actorId: 'admin-x' });
  created.invoices.push(before.invoice.id);
  assert.ok([a, b].includes(before.invoice.ownerId));
});
