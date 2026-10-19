// Journey-audit Phase A follow-ups (2026-10-19):
//   1. PUT /admin/settings refuses a tier list that would stop every sale (empty, or every row switched off).
//   2. Admin payment-request and refund rows carry staff display names for the actors on them.
//   3. An approved plan records the payment request's final reference (verified / member transaction ID),
//      not ADMIN_<id>, on every approval path.
//   4. The operator check-in response says whether the scan repeated today's visit (idempotent: boolean).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createRefundService } from '../src/services/refund-service.mjs';
import { createCheckInService } from '../src/services/check-in-service.mjs';
import { createOperatorService } from '../src/services/operator-service.mjs';
import { staffName } from '../src/shared/staff-names.mjs';
import { issue as issueQr } from '../src/auth/qr-token.mjs';
import { settingsWithTiers, TEST_TIERS } from './fixtures/tier-settings.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { ensureInit } from '../functions/index.mjs';
import { adminUpdateSettings } from '../functions/admin-settings.mjs';
import { adminPaymentRequests } from '../functions/admin-payments.mjs';
import { adminListRefunds } from '../functions/refunds.mjs';

await ensureInit();

function memStore(rows = []) {
  return {
    rows,
    async allAsync() { return [...rows]; },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async filterByColumnAsync(col, value) { return rows.filter(r => r[col] === value); },
    async filterAsync(fn) { return rows.filter(fn); },
    async filterByColumnInAsync(col, ids) { return rows.filter(r => ids.includes(r[col])); },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

async function call(endpoint, { params = {}, body = {}, query = {}, sub }) {
  let code = 200; let payload;
  const res = { status(c) { code = c; return res; }, json(b) { payload = b; return res; } };
  await endpoint.onRequest({ params, body, query, user: { sub } }, res);
  return { code, body: payload };
}

// ── 1. Settings: no save may leave nothing on sale ───────────────────────────

test('settings: an empty tier list is refused (400 invalid_subscription_tier, field subscriptionTiers); nothing is saved', async () => {
  const s = settingsWithTiers(TEST_TIERS);
  const out = await s.adminUpdate({ body: { subscriptionTiers: [] }, actorId: 'adm' });
  assert.deepEqual(out, { error: 'invalid_subscription_tier', status: 400, tier: null, field: 'subscriptionTiers', reason: 'empty' });
  assert.deepEqual(s.sellableTierKeys(), ['basic', 'pro', 'premium', 'executive']);
});

test('settings: null or a non-list is refused too; leaving subscriptionTiers out keeps the tiers', async () => {
  const s = settingsWithTiers(TEST_TIERS);
  for (const bad of [null, 'none', {}, 0]) {
    const out = await s.adminUpdate({ body: { subscriptionTiers: bad }, actorId: 'adm' });
    assert.deepEqual([out.error, out.status, out.field], ['invalid_subscription_tier', 400, 'subscriptionTiers'], JSON.stringify(bad));
  }
  const ok = await s.adminUpdate({ body: { paymentPeriodDays: 7 }, actorId: 'adm' });
  assert.equal(ok.error, undefined);
  assert.deepEqual(s.sellableTierKeys(), ['basic', 'pro', 'premium', 'executive']);
});

test('settings: a list where every tier is switched off is refused (reason none_on_sale); one on is enough', async () => {
  const s = settingsWithTiers(TEST_TIERS);
  const allOff = TEST_TIERS.map((t, i) => ({ ...t, ...(i % 2 ? { active: false } : { enabled: false }) }));
  const out = await s.adminUpdate({ body: { subscriptionTiers: allOff }, actorId: 'adm' });
  assert.deepEqual(out, { error: 'invalid_subscription_tier', status: 400, tier: null, field: 'subscriptionTiers', reason: 'none_on_sale' });
  assert.deepEqual(s.sellableTierKeys(), ['basic', 'pro', 'premium', 'executive']);
  const oneOn = allOff.map((t, i) => (i === 0 ? { ...TEST_TIERS[0] } : t));
  assert.equal((await s.adminUpdate({ body: { subscriptionTiers: oneOn }, actorId: 'adm' })).error, undefined);
  assert.deepEqual(s.sellableTierKeys(), ['basic']);
});

test('PUT /admin/settings route: [] answers 400 with error + field, without saving', async () => {
  const before = await db('PlatformSettings').where({ id: 'platform' }).first();
  const out = await call(adminUpdateSettings, { body: { subscriptionTiers: [] }, sub: 'adm' });
  assert.equal(out.code, 400);
  assert.deepEqual([out.body.error, out.body.field, out.body.reason], ['invalid_subscription_tier', 'subscriptionTiers', 'empty']);
  assert.equal(out.body.status, undefined);
  const afterRow = await db('PlatformSettings').where({ id: 'platform' }).first();
  assert.deepEqual(afterRow?.subscriptionTiers, before?.subscriptionTiers);
});

// ── 2. Staff names on admin money rows ───────────────────────────────────────

const STAFF = [
  { id: 'a1', userType: 'admin', displayName: 'Neema Admin', email: 'neema@fitflex.test' },
  { id: 'a2', userType: 'member', portalUser: true, displayName: '  ', email: 'juma@fitflex.test' },
  { id: 'a3', userType: 'admin', portalUser: true, displayName: 'Baraka' },
  { id: 'm1', userType: 'member', displayName: 'Asha' },
];

test('staffName: portal/admin users only; display name, else email; otherwise null', () => {
  assert.equal(staffName(STAFF[0]), 'Neema Admin');
  assert.equal(staffName(STAFF[1]), 'juma@fitflex.test');
  assert.equal(staffName(STAFF[3]), null, 'a member is not staff');
  assert.equal(staffName(null), null);
  assert.equal(staffName({ id: 'x', userType: 'admin' }), null);
});

test('payment-request list: verifiedByName, changeRequestedByName, decidedByName (null when unknown / not staff)', async () => {
  const paymentRequests = memStore([
    { id: 'p1', memberId: 'm1', status: 'approved', verifiedBy: 'a1', decidedBy: 'a2', changeRequestedBy: 'a3', requestedAt: '2026-10-19T10:00:00Z' },
    { id: 'p2', memberId: 'm1', status: 'approved', decidedBy: 'mobile_money', requestedAt: '2026-10-19T09:00:00Z' },
    { id: 'p3', memberId: 'm1', status: 'pending', verifiedBy: 'gone_user', requestedAt: '2026-10-19T08:00:00Z' },
    { id: 'p4', memberId: 'm1', status: 'approved', decidedBy: 'm1', requestedAt: '2026-10-19T07:00:00Z' },
  ]);
  const svc = createAdminPaymentService({ paymentRequests, subscriptions: memStore(), users: memStore(STAFF), auditLog: memStore(), secondApprover: () => false });
  const rows = await svc.list();
  const pick = r => [r.id, r.verifiedByName, r.changeRequestedByName, r.decidedByName];
  assert.deepEqual(rows.map(pick), [
    ['p1', 'Neema Admin', 'Baraka', 'juma@fitflex.test'],
    ['p2', null, null, null],
    ['p3', null, null, null],
    ['p4', null, null, null],
  ]);
  assert.equal(rows[0].verifiedBy, 'a1', 'ids are unchanged');
});

test('refund list: requestedByName, decidedByName, paidByName (members and policy give null)', async () => {
  const refunds = memStore([
    { id: 'r1', memberId: 'm1', status: 'paid', requestedBy: 'a1', requestedRole: 'admin', decidedBy: 'a3', paidBy: 'a2', createdAt: '2026-10-19T10:00:00Z' },
    { id: 'r2', memberId: 'm1', status: 'approved', requestedBy: 'm1', requestedRole: 'member', decidedBy: 'policy', paidBy: null, createdAt: '2026-10-19T09:00:00Z' },
  ]);
  const svc = createRefundService({
    refunds, paymentRequests: memStore(), subscriptions: memStore(), users: memStore(STAFF), auditLog: memStore(),
    secondApprover: () => false, notify: async () => {},
  });
  const { refunds: rows } = await svc.adminList();
  assert.deepEqual(rows.map(r => [r.id, r.requestedByName, r.decidedByName, r.paidByName]), [
    ['r1', 'Neema Admin', 'Baraka', 'juma@fitflex.test'],
    ['r2', null, null, null],
  ]);
  assert.equal(rows[1].member.displayName, 'Asha');
});

// ── 3. The plan records the payment's final reference ────────────────────────

const DAY = 86_400_000;
function payments({ flag = true, manual = false, row = {} } = {}) {
  const paymentRequests = memStore([{
    id: 'pr1', memberId: 'm1', subscriptionId: 'sub1', tier: 'basic', amountTzs: 60_000, status: 'pending',
    provider: 'admin_approved', reference: null, requestedAt: new Date().toISOString(), ...row,
  }]);
  const subscriptions = memStore([{
    id: 'sub1', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending',
    startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
  }]);
  const svc = createAdminPaymentService({
    paymentRequests, subscriptions, users: memStore(STAFF), auditLog: memStore(),
    secondApprover: () => flag, manualReferenceChecks: () => manual,
  });
  return { svc, sub: () => subscriptions.rows[0], req: () => paymentRequests.rows[0] };
}

test('flag on: approving a verified payment without retyping records the verified reference on the plan', async () => {
  const p = payments();
  await p.svc.verify({ id: 'pr1', reference: 'MPESA-XYZ', actorId: 'a1' });
  const ok = await p.svc.decide({ id: 'pr1', decision: 'approve', actorId: 'a2' });
  assert.equal(ok.paymentRequest.reference, 'MPESA-XYZ');
  assert.equal(p.sub().status, 'active');
  assert.equal(p.sub().paymentRef, 'MPESA-XYZ');
});

test('flag on: verified from the member transaction ID, then approved without retyping: plan has the member ID', async () => {
  const p = payments({ manual: true, row: { memberReference: 'QGH7XK2L9P' } });
  assert.equal((await p.svc.verify({ id: 'pr1', actorId: 'a1' })).paymentRequest.reference, 'QGH7XK2L9P');
  await p.svc.decide({ id: 'pr1', decision: 'approve', actorId: 'a2' });
  assert.equal(p.sub().paymentRef, 'QGH7XK2L9P');
  // the same through update()
  const u = payments({ manual: true, row: { memberReference: 'QGH7XK2L9Q' } });
  await u.svc.verify({ id: 'pr1', actorId: 'a1' });
  await u.svc.update({ id: 'pr1', status: 'approved', actorId: 'a2' });
  assert.equal(u.sub().paymentRef, 'QGH7XK2L9Q');
});

test('flag off (manual pay): a recorded reference or the member ID is what the plan records', async () => {
  const recorded = payments({ flag: false, row: { reference: 'BANK-77' } });
  await recorded.svc.decide({ id: 'pr1', decision: 'approve', actorId: 'a1' });
  assert.equal(recorded.sub().paymentRef, 'BANK-77');
  const member = payments({ flag: false, manual: true, row: { memberReference: 'TX-MEMBER-1' } });
  await member.svc.decide({ id: 'pr1', decision: 'approve', actorId: 'a1' });
  assert.equal(member.req().reference, 'TX-MEMBER-1');
  assert.equal(member.sub().paymentRef, 'TX-MEMBER-1');
  const typed = payments({ flag: false, row: { reference: 'OLD', memberReference: 'TX-2' } });
  await typed.svc.decide({ id: 'pr1', decision: 'approve', reference: 'TYPED-9', actorId: 'a1' });
  assert.equal(typed.sub().paymentRef, 'TYPED-9');
});

test('no reference anywhere: the plan still gets ADMIN_<id> (unchanged)', async () => {
  const p = payments({ flag: false });
  await p.svc.decide({ id: 'pr1', decision: 'approve', actorId: 'a1' });
  assert.equal(p.req().reference, null);
  assert.equal(p.sub().paymentRef, 'ADMIN_pr1');
});

test('change-request confirm → approved: records the member ID on the payment and the plan; a recorded reference wins', async () => {
  const p = payments({ manual: true, row: { status: 'rejected', decidedBy: 'a2', memberReference: 'TX-CONFIRM-1' } });
  await p.svc.requestChange({ id: 'pr1', status: 'approved', reason: 'money found', actorId: 'a1' });
  const ok = await p.svc.confirmChange({ id: 'pr1', actorId: 'a2' });
  assert.equal(ok.paymentRequest.status, 'approved');
  assert.equal(ok.paymentRequest.reference, 'TX-CONFIRM-1');
  assert.equal(p.sub().paymentRef, 'TX-CONFIRM-1');

  const r = payments({ row: { status: 'rejected', decidedBy: 'a2', reference: 'BANK-5', memberReference: 'TX-OTHER' } });
  await r.svc.requestChange({ id: 'pr1', status: 'approved', reason: 'money found', actorId: 'a1' });
  await r.svc.confirmChange({ id: 'pr1', actorId: 'a3' });
  assert.equal(r.req().reference, 'BANK-5');
  assert.equal(r.sub().paymentRef, 'BANK-5');
});

// ── 4. Operator check-in: repeat scan is flagged ─────────────────────────────

test('operator check-in: idempotent is false on the first scan and true on a same-day repeat (no new visit)', async () => {
  const col = (rows = []) => ({
    rows,
    find: fn => rows.find(fn),
    findByIdAsync: async id => rows.find(r => r.id === id) ?? null,
    filterAsync: async fn => rows.filter(fn),
    insertAsync: async row => { rows.push(row); return row; },
  });
  const TIERS = { pro: { price: 60_000, visitCap: 30, gymAccess: 'midtier', multiGymPerDay: true } };
  const START = '2026-01-01T00:00:00Z';
  const users = col([{ id: 'pass_m' }]);
  const gyms = col([{ id: 'g1', name: 'Gym', tier: 'standard' }]);
  const subscriptions = col([{ id: 's1', memberId: 'pass_m', type: 'platform_pass', tier: 'pro', status: 'active', startedAt: START, cycleStartedAt: START, expiresAt: '2099-01-01T00:00:00Z' }]);
  const checkins = col();
  const getTierConfig = t => TIERS[t] ?? null;
  const gymOpenToPass = async () => true;
  const checkInService = createCheckInService({ users, gyms, subscriptions, checkins, trainers: col(), getTierConfig, gymOpenToPass });
  const operator = createOperatorService({
    users, gyms, subscriptions, checkins, checkInService,
    publicUserId: async u => `FF-${typeof u === 'string' ? u : u.id}`,
    settingsService: { getTierConfig, visitCapForTier: t => TIERS[t]?.visitCap ?? null },
    gymOpenToPass,
  });
  const scan = () => operator.checkIn({ operator: { gymIds: ['g1'] }, gymId: 'g1', qrToken: issueQr('pass_m').token });
  const first = await scan();
  assert.equal(first.status, 200);
  assert.equal(first.body.idempotent, false);
  const again = await scan();
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.checkin.id, first.body.checkin.id);
  assert.equal(again.body.visitNumberInCycle, first.body.visitNumberInCycle);
  assert.equal(checkins.rows.length, 1);
});

// ── Database + endpoints (isolated CI DB): names on the real list endpoints ──

const made = { users: [], payments: [], refunds: [] };
after(async () => {
  await db('Refund').whereIn('id', made.refunds).del();
  await db('PaymentRequest').whereIn('id', made.payments).del();
  await db('User').whereIn('id', made.users).del();
});

test('db + endpoints: GET /admin/payment-requests and /admin/refunds carry the staff names', async () => {
  const tag = randomUUID().slice(0, 8);
  const admin = `u_paf_adm_${tag}`; const member = `u_paf_mem_${tag}`;
  const prId = `pr_paf_${tag}`; const rfId = `rf_paf_${tag}`;
  const now = new Date();
  await db('User').insert([
    { id: admin, userType: 'admin', portalUser: true, displayName: `Staff ${tag}`, updatedAt: now },
    { id: member, userType: 'member', displayName: 'PAF member', updatedAt: now },
  ]);
  made.users.push(admin, member);
  await db('PaymentRequest').insert({ id: prId, memberId: member, tier: 'basic', amountTzs: 60_000, status: 'approved', provider: 'admin_approved', reference: `PAF-${tag}`, decidedBy: admin, verifiedBy: member, decidedAt: now });
  made.payments.push(prId);
  await db('Refund').insert({ id: rfId, memberId: member, kind: 'subscription', paymentRequestId: prId, amountTzs: 1_000, currency: 'TZS', reasonCode: 'other', status: 'paid', requestedBy: member, requestedRole: 'member', decidedBy: 'policy', paidBy: admin, paidAt: now, paymentReference: `RF-${tag}`, createdAt: now, updatedAt: now });
  made.refunds.push(rfId);

  const list = await call(adminPaymentRequests, { sub: admin });
  const row = list.body.find(r => r.id === prId);
  assert.ok(row);
  assert.deepEqual([row.decidedByName, row.verifiedByName, row.changeRequestedByName], [`Staff ${tag}`, null, null]);

  const refunds = await call(adminListRefunds, { query: { status: 'paid' }, sub: admin });
  const rf = refunds.body.refunds.find(r => r.id === rfId);
  assert.ok(rf);
  assert.deepEqual([rf.requestedByName, rf.decidedByName, rf.paidByName], [null, null, `Staff ${tag}`]);
});
