// Custom gym passes, phase 5B: owner analytics (GYM_CUSTOM_PASSES). Additive fields on GET /owner/gyms/:id/pass-summary,
// GET /operator/dashboard, GET /operator/checkins and GET /owner/gyms/:id/checkins. Against the CI database; channels are fakes,
// money is staff approval of a manual payment through the real payment service.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import * as routes from '../functions/gym-passes.mjs';
import { ownerGymCheckins } from '../functions/owner-gyms.mjs';
import { operatorRecentCheckIns, operatorDashboard } from '../functions/checkins.mjs';
import { gyms, users, subscriptions, paymentRequests, auditLog } from '../src/bootstrap/collections.mjs';
import { verifiedContacts, gymPassStore, checkInService, operatorService } from '../src/bootstrap/services.mjs';
import { createGymPassService } from '../src/services/gym-pass-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { EXPIRING_SOON_DAYS } from '../src/shared/member-status.mjs';
import { verifyContacts } from './fixtures/verified-contacts.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], gyms: [] };
const DAY = 86_400_000;
let seq = 0;
const phoneNo = () => `+2557${String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8)}`;

afterEach(() => { delete process.env.GYM_CUSTOM_PASSES; });

async function member() {
  const id = uid('usr'); const phone = phoneNo();
  seq += 1;
  await db('User').insert({ id, userType: 'member', displayName: `Analytics Member ${seq}`, phone: null, updatedAt: new Date() });
  made.users.push(id);
  await verifyContacts(db, id, { phone, email: null });
  return { id, phone };
}
async function gym() {
  const id = uid('gym');
  await gyms.insertAsync({ id, name: 'Analytics Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active' });
  made.gyms.push(id);
  return id;
}
async function owner(gymIds) {
  const id = uid('own');
  await db('User').insert({ id, userType: 'gym_operator', displayName: 'Analytics Owner', gymIds, gymId: gymIds[0], updatedAt: new Date() });
  made.users.push(id);
  return { id, gymIds, userType: 'gym_operator' };
}
function kit() {
  const svc = createGymPassService({
    store: gymPassStore, gyms, users, auditLog,
    contacts: { findMember: verifiedContacts.findMember, contactsFor: verifiedContacts.contactsFor },
    notify: async () => ({}),
    channels: { whatsapp: async () => ({ status: 'skipped:whatsapp_not_available' }), sms: async () => ({ status: 'sent' }) },
    baseLink: () => 'https://app.test',
  });
  const pay = createAdminPaymentService({
    paymentRequests, subscriptions, users, auditLog, gyms,
    onPassPayment: (request, status, opts) => svc.onPaymentStatus(request, status, opts),
  });
  return { svc, pay };
}
async function plan(k, own, gymId, body = {}) {
  const out = await k.svc.createPlan({ owner: own, gymId, actorId: own.id, body: { name: 'Pass', category: 'individual', durationValue: 30, durationUnit: 'days', priceTzs: 50_000, ...body } });
  assert.equal(out.status, 201, JSON.stringify(out));
  return out.plan;
}
async function buy(k, buyer, planId, extra = {}) {
  const out = await k.svc.purchase({ memberId: buyer.id, planId, ...extra });
  assert.equal(out.status, 202, JSON.stringify(out));
  return out;
}
const approve = (k, out) => k.pay.decide({ id: out.paymentRequest.id, decision: 'approve', actorId: 'adm_pass', reference: `AN${randomUUID().slice(0, 8).toUpperCase()}` });
const visit = async (m, g) => { const r = await checkInService.perform({ memberId: m.id, gymId: g }); assert.equal(r.ok, true, JSON.stringify(r)); return r.checkin; };

after(async () => {
  const purchaseIds = await db('GymPassPurchase').whereIn('gymId', made.gyms).pluck('id');
  const paymentIds = await db('PaymentRequest').whereIn('gymId', made.gyms).pluck('id');
  await db('Checkin').whereIn('gymId', made.gyms).del();
  await db('Subscription').whereIn('memberId', made.users).del();
  await db('GymPassBeneficiary').whereIn('purchaseId', purchaseIds).del();
  await db('GymPassPurchase').whereIn('id', purchaseIds).del();
  await db('PaymentRequest').whereIn('id', paymentIds).del();
  await db('GymPassPlan').whereIn('gymId', made.gyms).del();
  await db('Gym').whereIn('id', made.gyms).del();
  await db('AuditLog').whereIn('actor', [...made.users, 'adm_pass']).del().catch(() => {});
  await db('User').whereIn('id', made.users).del();
});

/** One gym with: solo (visited, then voided), a 5-slot group with 4 people (2 visited), a couples pass left unpaid, a rejected solo. */
async function world() {
  const k = kit();
  const g = await gym();
  const o = await owner([g]);
  const solo = await plan(k, o, g, { name: 'Solo 30', priceTzs: 40_000 });
  const squad = await plan(k, o, g, { name: 'Squad', category: 'group', beneficiaryLimit: 5, durationValue: 1, durationUnit: 'months', priceTzs: 150_000 });
  const pair = await plan(k, o, g, { name: 'Pair', category: 'couples', durationValue: 1, durationUnit: 'months', priceTzs: 70_000 });
  const b1 = await member(); const b3 = await member(); const f2 = await member(); const f3 = await member(); const b4 = await member(); const b5 = await member(); const f4 = await member();
  const s1 = await buy(k, b1, solo.id);
  const s3 = await buy(k, b3, squad.id, { beneficiaries: [{ phone: f2.phone }, { phone: f3.phone }, { phone: phoneNo() }] });
  const unpaid = await buy(k, b4, pair.id, { beneficiaries: [{ phone: f4.phone }] });
  const rejected = await buy(k, b5, solo.id);
  await approve(k, s1); await approve(k, s3);
  await k.pay.decide({ id: rejected.paymentRequest.id, decision: 'reject', actorId: 'adm_pass', reason: 'no payment' });
  const v1 = await visit(b1, g); const v3 = await visit(b3, g); await visit(f2, g);
  await db('Checkin').where({ id: v1.id }).update({ status: 'voided', statusReason: 'spec: duplicate scan', voidedAt: new Date(), voidReason: 'spec: duplicate scan' });
  return { k, g, o, solo, squad, pair, s1, s3, unpaid, rejected, b1, b3, f2, f3, v1, v3 };
}

test('summary analytics: a group is ONE sale with N people, revenue once; voided visit excluded; never-visited; byPlan sums equal the totals', async () => {
  const w = await world();
  const sum = await w.k.svc.summary({ owner: w.o, gymId: w.g });
  // existing fields unchanged
  assert.equal(sum.sales.count, 2);
  assert.equal(sum.sales.revenueTzs, 190_000);
  assert.equal(sum.sales.pendingPayment, 1, 'the unpaid pair; the rejected purchase is cancelled, not pending');
  assert.deepEqual(sum.byCategory.group, { sales: 1, revenueTzs: 150_000, beneficiaries: 4 });
  // byPlan
  assert.deepEqual(sum.byPlan.map(p => [p.planId, p.name, p.sales, p.revenueTzs, p.people]),
    [[w.squad.id, 'Squad', 1, 150_000, 4], [w.solo.id, 'Solo 30', 1, 40_000, 1]].sort((a, b) => b[2] - a[2] || b[3] - a[3]));
  assert.equal(sum.byPlan.reduce((n, p) => n + p.sales, 0), sum.sales.count);
  assert.equal(sum.byPlan.reduce((n, p) => n + p.revenueTzs, 0), sum.sales.revenueTzs);
  assert.equal(sum.byPlan.reduce((n, p) => n + p.people, 0), Object.values(sum.byCategory).reduce((n, c) => n + c.beneficiaries, 0));
  assert.ok(!sum.byPlan.some(p => p.planId === w.pair.id), 'an unpaid purchase is not a sale');
  // groups: 5 slots sold once, 4 filled (buyer + 2 accounts + 1 waiting for sign-up)
  assert.deepEqual(sum.groups, { slots: 5, filled: 4, fillRate: 0.8 });
  // utilisation: attached people b1, b3, f2, f3 = 4; visits b3 + f2 = 2 (b1's was voided); f3 and b1 never visited
  assert.deepEqual(sum.utilisation, { visits: 2, peopleWithVisit: 2, peopleNeverVisited: 2, activePeople: 4, visitsPerActivePerson: 0.5 });
  assert.equal(sum.utilisation.peopleWithVisit + sum.utilisation.peopleNeverVisited, sum.utilisation.activePeople);
  // nothing is about to expire (30 days and a month)
  assert.deepEqual(sum.expiring, { withinDays: EXPIRING_SOON_DAYS, purchases: 0, people: 0 });
});

test('expiring: running passes ending inside EXPIRING_SOON_DAYS, with their people; later, ended and unpaid ones are not', async () => {
  const w = await world();
  await db('GymPassPurchase').where({ id: w.s1.purchase.id }).update({ expiresAt: new Date(Date.now() + (EXPIRING_SOON_DAYS - 1) * DAY) });
  let sum = await w.k.svc.summary({ owner: w.o, gymId: w.g });
  assert.deepEqual(sum.expiring, { withinDays: 7, purchases: 1, people: 1 });
  await db('GymPassPurchase').where({ id: w.s3.purchase.id }).update({ expiresAt: new Date(Date.now() + 2 * DAY) });
  sum = await w.k.svc.summary({ owner: w.o, gymId: w.g });
  assert.deepEqual(sum.expiring, { withinDays: 7, purchases: 2, people: 5 }, 'solo 1 + group 4');
  await db('GymPassPurchase').where({ id: w.s1.purchase.id }).update({ expiresAt: new Date(Date.now() + (EXPIRING_SOON_DAYS + 1) * DAY) });
  await db('GymPassPurchase').where({ id: w.s3.purchase.id }).update({ expiresAt: new Date(Date.now() - DAY) });
  sum = await w.k.svc.summary({ owner: w.o, gymId: w.g });
  assert.deepEqual(sum.expiring, { withinDays: 7, purchases: 0, people: 0 }, 'beyond the window, and already expired');
  assert.deepEqual(sum.memberships, { active: 1, expired: 1 });
});

test('from / to filter sales by approval date (PaymentRequest.decidedAt): from inclusive, to exclusive', async () => {
  const w = await world();
  const d1 = new Date('2026-03-10T09:00:00Z'); const d2 = new Date('2026-04-20T09:00:00Z');
  await db('PaymentRequest').where({ id: w.s1.paymentRequest.id }).update({ decidedAt: d1 });
  await db('PaymentRequest').where({ id: w.s3.paymentRequest.id }).update({ decidedAt: d2 });
  const q = async (query) => w.k.svc.summary({ owner: w.o, gymId: w.g, query });
  const all = await q({});
  assert.equal(all.sales.count, 2);
  const march = await q({ from: '2026-03-01', to: '2026-04-01' });
  assert.deepEqual([march.sales.count, march.sales.revenueTzs, march.byPlan.map(p => p.planId)], [1, 40_000, [w.solo.id]]);
  assert.deepEqual(march.groups, { slots: 0, filled: 0, fillRate: 0 });
  assert.equal(march.sales.pendingPayment, 1, 'an unpaid purchase has no approval date and is still reported');
  const april = await q({ from: '2026-04-20T09:00:00Z', to: '2026-05-01' });
  assert.deepEqual([april.sales.count, april.sales.revenueTzs, april.groups.slots], [1, 150_000, 5]);
  assert.equal(april.byPlan.reduce((n, p) => n + p.revenueTzs, 0), april.sales.revenueTzs);
  assert.equal((await q({ from: '2026-03-10T09:00:00Z', to: '2026-04-20T09:00:00Z' })).sales.count, 1, 'to is exclusive');
  assert.equal((await q({ from: '2027-01-01' })).sales.count, 0);
  assert.equal((await q({ from: 'not a date' })).sales.count, 2, 'an unreadable date is ignored, as on the sales list');
});

test('empty gym: zeros and empty lists, no division by zero', async () => {
  const k = kit(); const g = await gym(); const o = await owner([g]);
  const sum = await k.svc.summary({ owner: o, gymId: g });
  assert.deepEqual(sum.byPlan, []);
  assert.deepEqual(sum.expiring, { withinDays: 7, purchases: 0, people: 0 });
  assert.deepEqual(sum.utilisation, { visits: 0, peopleWithVisit: 0, peopleNeverVisited: 0, activePeople: 0, visitsPerActivePerson: 0 });
  assert.deepEqual(sum.groups, { slots: 0, filled: 0, fillRate: 0 });
  assert.deepEqual(sum.sales, { count: 0, revenueTzs: 0, pendingPayment: 0 });
});

test('pass-summary route: flag off 404 feature_disabled; scope payments; another owner refused; ?from / ?to reach the service', async () => {
  const w = await world();
  const OWN = { sub: w.o.id, userType: 'gym_operator' };
  const params = { gymId: w.g };
  const off = await call(routes.ownerGymPassSummary, OWN, { params });
  assert.deepEqual([off.status, off.body], [404, { error: 'feature_disabled' }]);
  process.env.GYM_CUSTOM_PASSES = '1';
  const on = await call(routes.ownerGymPassSummary, OWN, { params });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(Object.keys(on.body.byPlan[0]).sort(), ['category', 'name', 'people', 'planId', 'revenueTzs', 'sales']);
  assert.equal(on.body.utilisation.activePeople, 4);
  const future = await call(routes.ownerGymPassSummary, OWN, { params, query: { from: '2099-01-01' } });
  assert.equal(future.body.sales.count, 0);

  const staffId = uid('stf');
  await db('User').insert({ id: staffId, userType: 'gym_staff', displayName: 'Analytics Staff', gymIds: [w.g], gymId: w.g, aclPermissions: ['payments'], updatedAt: new Date() });
  made.users.push(staffId);
  assert.equal((await call(routes.ownerGymPassSummary, { sub: staffId, userType: 'gym_staff', aclPermissions: ['payments'] }, { params })).status, 200);
  assert.equal((await call(routes.ownerGymPassSummary, { sub: staffId, userType: 'gym_staff', aclPermissions: ['members'] }, { params })).status, 403, 'members scope is not payments');

  const stranger = await owner([await gym()]);
  const refused = await call(routes.ownerGymPassSummary, { sub: stranger.id, userType: 'gym_operator' }, { params });
  assert.deepEqual([refused.status, refused.body.error], [403, 'not_your_gym']);
});

test('dashboard: passVisits / passMembers per gym and overall; legacy fields unchanged; off = no new keys', async () => {
  const w = await world();
  // a legacy FitFlex-pass visit in the same gym, no pass columns
  const m = await member();
  await db('Checkin').insert({ id: uid('chk'), memberId: m.id, gymId: w.g, timestamp: new Date(), subscriptionType: 'platform_pass', passTier: 'pro', visitNumberInCycle: 1,
    gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', method: 'member_scanned', source: 'gym_qr_by_member', businessDate: new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10) });
  const operator = { id: w.o.id, gymIds: [w.g], gymId: w.g };
  // A fixed period end (today, whole day): with the default 'now' the chart buckets move between two calls.
  const periodEnd = new Date().toISOString().slice(0, 10);
  const dash = () => operatorService.dashboard({ operator, query: { gymId: w.g, periodEnd }, includeSettlement: false });
  const NEW = ['passVisits', 'passMembers'];
  const strip = (d) => {
    const c = JSON.parse(JSON.stringify(d));
    for (const k of NEW) { delete c[k]; delete c.overall[k]; for (const s of c.gymSummaries) delete s[k]; }
    return c;
  };
  const offBody = await dash();
  for (const k of NEW) assert.equal(Object.hasOwn(offBody, k), false, `${k} absent while the flag is off`);
  assert.equal(Object.hasOwn(offBody.overall, 'passVisits'), false);
  process.env.GYM_CUSTOM_PASSES = '1';
  const onBody = await dash();
  assert.deepEqual(strip(onBody), JSON.parse(JSON.stringify(offBody)), 'every legacy field is identical with the flag on');
  // b1 (voided) is excluded; b3 and f2 count; the platform-pass visit is not a pass visit
  assert.equal(onBody.periodVisits, 4, 'legacy total still counts every visit (voided included, as before)');
  assert.deepEqual([onBody.passVisits, onBody.passMembers], [2, 2]);
  assert.deepEqual([onBody.overall.passVisits, onBody.overall.passMembers], [2, 2]);
  assert.deepEqual([onBody.gymSummaries[0].passVisits, onBody.gymSummaries[0].passMembers], [2, 2]);
  assert.equal(onBody.directVisits, 3); assert.equal(onBody.fitflexVisits, 1);
  // through the route (any gym_operator)
  const viaRoute = await call(operatorDashboard, { sub: w.o.id, userType: 'gym_operator' }, { query: { gymId: w.g } });
  assert.equal(viaRoute.status, 200);
  assert.equal(viaRoute.body.passVisits, 2);
});

test('check-in lists: pass { name, category } from ONE batched lookup; null for non-pass rows; nothing else exposed', async () => {
  const w = await world();
  const m = await member();
  const plain = uid('chk');
  await db('Checkin').insert({ id: plain, memberId: m.id, gymId: w.g, timestamp: new Date(Date.now() - 1000), subscriptionType: 'platform_pass', passTier: 'pro', visitNumberInCycle: 1,
    gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', method: 'member_scanned', source: 'gym_qr_by_member', businessDate: new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10) });
  const OWN = { sub: w.o.id, userType: 'gym_operator' };
  const lists = async () => [
    (await call(ownerGymCheckins, OWN, { params: { gymId: w.g } })).body,
    (await call(operatorRecentCheckIns, OWN)).body,
  ];
  // off: no `pass` key at all, bodies as before
  for (const list of await lists()) {
    assert.equal(list.length, 4);
    assert.ok(list.every(c => !Object.hasOwn(c, 'pass')));
  }
  process.env.GYM_CUSTOM_PASSES = '1';
  let lookups = 0;
  const count = (q) => { if (/"GymPassPurchase"/.test(q.sql) && /^select/i.test(q.sql)) lookups += 1; };
  db.on('query', count);
  const [owned, operator] = await lists();
  db.off('query', count);
  assert.equal(lookups, 2, 'one lookup per list (two lists), not one per row');
  for (const list of [owned, operator]) {
    const byId = new Map(list.map(c => [c.id, c]));
    assert.deepEqual(byId.get(w.v3.id).pass, { name: 'Squad', category: 'group' });
    assert.deepEqual(byId.get(w.v1.id).pass, { name: 'Solo 30', category: 'individual' });
    assert.equal(byId.get(plain).pass, null);
    assert.ok(list.every(c => c.pass === null || Object.keys(c.pass).sort().join() === 'category,name'));
    const text = JSON.stringify(list);
    for (const leak of ['purchaserId', 'contactHash', 'contactValue', 'priceTzs', 'terms']) assert.ok(!text.includes(`"${leak}"`), `${leak} is not exposed`);
  }
  // a list with no pass rows triggers no lookup at all
  const g2 = await gym(); const o2 = await owner([g2]); const m2 = await member();
  await db('Checkin').insert({ id: uid('chk'), memberId: m2.id, gymId: g2, timestamp: new Date(), subscriptionType: 'platform_pass', passTier: 'pro', visitNumberInCycle: 1,
    gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', method: 'member_scanned', source: 'gym_qr_by_member', businessDate: new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10) });
  lookups = 0; db.on('query', count);
  const none = await call(ownerGymCheckins, { sub: o2.id, userType: 'gym_operator' }, { params: { gymId: g2 } });
  db.off('query', count);
  assert.deepEqual([none.body.length, none.body[0].pass, lookups], [1, null, 0]);
  // another owner cannot list this gym
  const stranger = await owner([await gym()]);
  assert.equal((await call(ownerGymCheckins, { sub: stranger.id, userType: 'gym_operator' }, { params: { gymId: w.g } })).status, 403);
});

// ── helpers ─────────────────────────────────────────────────────────────────

function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; },
  };
}
async function call(route, claims, { params = {}, query = {}, body = {} } = {}) {
  const headers = claims ? { authorization: `Bearer ${sign(claims)}` } : {};
  const req = { headers, params, query, body, user: claims ? { ...claims } : undefined, get: name => headers[String(name).toLowerCase()] ?? null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return { status: out.statusCode, body: out.body };
  }
  await route.onRequest(req, out);
  return { status: out.statusCode, body: out.body };
}
