// Phase B · B2: switches for the weekly trainer and vendor statement-draft
// jobs. Both are ON unless explicitly turned off (owner decision 2026-10-20),
// so a deploy changes nothing. Paused, a job logs one line and does no work;
// turned back on, its next run picks up everything the paused weeks missed.
// Staff preparing a week by hand (POST /admin/*-settlements/prepare) is not
// affected by either switch.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import {
  trainers, gyms, users, partnerGate, gymService, trainerSettlementService, vendorSettlementService,
} from '../src/bootstrap/services.mjs';
import { partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { ensureInit } from '../functions/index.mjs';
import { trainerStatementDraftsOn, vendorStatementDraftsOn } from '../src/shared/feature-flags.mjs';
import { trainerSettlementDrafts, vendorSettlementDrafts } from '../functions/jobs.mjs';
import { adminPrepareTrainerSettlements } from '../functions/trainer-settlements.mjs';
import { adminPrepareVendorSettlements } from '../functions/vendor-settlements.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { createTrainerSettlementService } from '../src/services/trainer-settlement-service.mjs';
import { createVendorSettlementService } from '../src/services/vendor-settlement-service.mjs';
import { priceOrderLine } from '../src/shared/marketplace-pricing.mjs';

await ensureInit();

const FLAGS = ['TRAINER_STATEMENT_DRAFTS', 'VENDOR_STATEMENT_DRAFTS'];
const saved = Object.fromEntries(FLAGS.map(f => [f, process.env[f]]));
const realPrepare = { trainer: trainerSettlementService.prepare, vendor: vendorSettlementService.prepare };
const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], trainers: [], gyms: [], orders: [] };
const started = new Date();

afterEach(() => {
  for (const f of FLAGS) { if (saved[f] === undefined) delete process.env[f]; else process.env[f] = saved[f]; }
  trainerSettlementService.prepare = realPrepare.trainer;
  vendorSettlementService.prepare = realPrepare.vendor;
});

after(async () => {
  await db('TrainerSettlement').whereIn('trainerId', made.trainers).where({ status: 'draft' }).del();
  await db('VendorSettlement').whereIn('vendorId', made.users).where({ status: 'draft' }).del();
  if (made.orders.length) await db('ShopOrder').whereIn('id', made.orders).del();
  for (const id of made.trainers) await trainers.removeAsync(t => t.id === id);
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('AuditLog').whereIn('actor', ['system:weekly-trainer-statements', 'system:weekly-vendor-statements', 'adm_switch_spec']).where('at', '>=', started).del();
  if (made.users.length) {
    await db('AuditLog').whereIn('actor', made.users).del();
    await db('User').whereIn('id', made.users).del();
  }
});

/** Run fn with console.log captured; returns the lines logged. */
async function logsOf(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

/** Replace a bootstrap service's prepare with a recorder (optionally delegating). */
function spy(service, delegate = async () => ({ periodStartDate: '2026-10-05', prepared: 0, rebuilt: 0, skipped: 0 })) {
  const calls = [];
  service.prepare = async (args) => { calls.push(args); return delegate(args); };
  return calls;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

test('both switches are on unless explicitly off (the default-on exception)', () => {
  for (const [name, isOn] of [['TRAINER_STATEMENT_DRAFTS', trainerStatementDraftsOn], ['VENDOR_STATEMENT_DRAFTS', vendorStatementDraftsOn]]) {
    delete process.env[name];
    assert.equal(isOn(), true, `${name} unset → on`);
    for (const v of ['', 'on', 'true', '1', 'yes', 'ON', 'anything-else']) {
      process.env[name] = v;
      assert.equal(isOn(), true, `${name}=${JSON.stringify(v)} → on`);
    }
    for (const v of ['off', 'false', '0', 'no', ' OFF ', 'False']) {
      process.env[name] = v;
      assert.equal(isOn(), false, `${name}=${JSON.stringify(v)} → off`);
    }
  }
});

test('the two switches are independent', () => {
  process.env.TRAINER_STATEMENT_DRAFTS = 'off';
  delete process.env.VENDOR_STATEMENT_DRAFTS;
  assert.equal(trainerStatementDraftsOn(), false);
  assert.equal(vendorStatementDraftsOn(), true);
  delete process.env.TRAINER_STATEMENT_DRAFTS;
  process.env.VENDOR_STATEMENT_DRAFTS = 'false';
  assert.equal(trainerStatementDraftsOn(), true);
  assert.equal(vendorStatementDraftsOn(), false);
});

// ── The jobs: on (default), off, back on ────────────────────────────────────

for (const [kind, job, service, flag, actorId] of [
  ['trainer', trainerSettlementDrafts, trainerSettlementService, 'TRAINER_STATEMENT_DRAFTS', 'system:weekly-trainer-statements'],
  ['vendor', vendorSettlementDrafts, vendorSettlementService, 'VENDOR_STATEMENT_DRAFTS', 'system:weekly-vendor-statements'],
]) {
  test(`${kind} statement job: runs by default, pauses when ${flag}=off, runs again when back on`, async () => {
    const calls = spy(service);

    delete process.env[flag];
    let lines = await logsOf(() => job.onJob());
    assert.equal(calls.length, 1, 'default: the job prepares');
    assert.deepEqual(calls[0], { actorId });
    assert.ok(!lines.some(l => l.includes('paused')));

    for (const v of ['off', 'false', '0']) {
      process.env[flag] = v;
      lines = await logsOf(async () => assert.deepEqual(await job.onJob(), { paused: true }));
      assert.equal(calls.length, 1, `${flag}=${v}: nothing is prepared`);
      assert.deepEqual(lines, [`[${kind}-statements] paused by ${flag}`]);
    }

    process.env[flag] = 'on';
    await logsOf(() => job.onJob());
    assert.equal(calls.length, 2, 'back on: the job prepares again');
    delete process.env[flag];
    await logsOf(() => job.onJob());
    assert.equal(calls.length, 3, 'unset again: still on');
  });

  test(`${kind} statement job off leaves the other job running`, async () => {
    const other = kind === 'trainer' ? vendorSettlementService : trainerSettlementService;
    const otherJob = kind === 'trainer' ? vendorSettlementDrafts : trainerSettlementDrafts;
    const mineCalls = spy(service);
    const otherCalls = spy(other);
    process.env[flag] = 'off';
    await logsOf(async () => { await job.onJob(); await otherJob.onJob(); });
    assert.equal(mineCalls.length, 0);
    assert.equal(otherCalls.length, 1);
  });
}

// ── Manual preparation is not gated ─────────────────────────────────────────

test('staff can still prepare a week by hand while either job is paused', async () => {
  process.env.TRAINER_STATEMENT_DRAFTS = 'off';
  process.env.VENDOR_STATEMENT_DRAFTS = 'off';
  const t = spy(trainerSettlementService);
  const v = spy(vendorSettlementService);
  const res = () => ({ code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const req = { body: { periodStart: '2026-10-05' }, user: { sub: 'adm_switch_spec' } };
  const r1 = res(); await adminPrepareTrainerSettlements.onRequest(req, r1);
  const r2 = res(); await adminPrepareVendorSettlements.onRequest(req, r2);
  assert.equal(r1.code, 201);
  assert.equal(r2.code, 201);
  assert.deepEqual(t, [{ periodStart: '2026-10-05', actorId: 'adm_switch_spec' }]);
  assert.deepEqual(v, [{ periodStart: '2026-10-05', actorId: 'adm_switch_spec' }]);
});

// ── Catch-up after a pause (real database) ──────────────────────────────────

const eligibility = createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers });

async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Switch ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}

test('trainer: a week missed while paused is picked up by the first run after turning it back on', async () => {
  let clock = new Date('2026-10-14T09:00:00Z'); // Wed; last ended week 5–11 Oct
  const svc = createTrainerSettlementService({ trainers, users, payoutEligibility: eligibility, now: () => clock, notify: async () => {} });
  const calls = spy(trainerSettlementService, (args) => svc.prepare(args));

  const gymId = uid('gym');
  await gyms.upsertAsync(g => g.id === gymId, gymService.normalizeGymPayload({ id: gymId, name: `Switch Gym ${gymId}`, tier: 'standard', location: 'Masaki' }, {}));
  made.gyms.push(gymId);
  const trainerId = uid('trn');
  await trainers.insertAsync({ id: trainerId, userId: await user('trainer'), displayName: 'Coach Switch', status: 'active', approvalStatus: 'approved', gymIds: [gymId], hourlyRateTzs: 20000 });
  made.trainers.push(trainerId);
  const memberId = await user('member');
  const bookingId = uid('tbk');
  await db('TrainerBooking').insert({
    id: bookingId, memberId, trainerId, gymId, date: '2026-10-07', slot: '10:00', status: 'completed',
    listPriceTzs: 20000, amountTzs: 18000, commissionTzs: 3000, trainerPayoutTzs: 17000, discountPct: 10, discountFundedBy: 'fitflex',
  });

  // Week of 5–11 Oct: paused, nothing prepared.
  process.env.TRAINER_STATEMENT_DRAFTS = 'off';
  await logsOf(() => trainerSettlementDrafts.onJob());
  assert.equal(calls.length, 0);
  assert.equal(await db('TrainerSettlement').where({ trainerId }).first(), undefined);

  // Next Wednesday, back on: the next ended week's draft carries the missed session.
  delete process.env.TRAINER_STATEMENT_DRAFTS;
  clock = new Date('2026-10-21T09:00:00Z'); // last ended week 12–18 Oct
  await logsOf(() => trainerSettlementDrafts.onJob());
  assert.equal(calls.length, 1);
  const s = await db('TrainerSettlement').where({ trainerId, status: 'draft' }).first();
  assert.equal(s.periodStartDate, '2026-10-12', 'catch-up lands on the next ended week, not a back-dated one');
  assert.equal(s.sessionCount, 1);
  assert.equal(Number(s.finalNetTzs), 17000);
  const lines = await db('TrainerSettlementLine').where({ trainerSettlementId: s.id });
  assert.deepEqual(lines.map(l => l.bookingId), [bookingId]);

  // Rerunning is idempotent: the draft is rebuilt, the session is not doubled.
  await logsOf(() => trainerSettlementDrafts.onJob());
  const again = await db('TrainerSettlement').where({ trainerId }).whereNot({ status: 'voided' });
  assert.equal(again.length, 1);
  assert.equal((await db('TrainerSettlementLine').where({ bookingId })).length, 1);
});

test('vendor: a week missed while paused is picked up by the first run after turning it back on', async () => {
  let clock = new Date('2026-10-12T09:00:00Z'); // Mon; last ended week 5–11 Oct
  const svc = createVendorSettlementService({ users, payoutEligibility: eligibility, now: () => clock, notify: async () => {} });
  const calls = spy(vendorSettlementService, (args) => svc.prepare(args));

  const vendorId = await user('vendor', { vendorProfile: JSON.stringify({ businessName: 'Switch Shop', status: 'published' }) });
  const buyerId = await user('member');
  const orderId = uid('ord');
  const items = [{ productId: uid('prd'), vendorId, name: 'Item', qty: 1, priceTzs: 30000, ...priceOrderLine({ priceTzs: 30000, qty: 1, commissionPct: 10 }) }];
  await db('ShopOrder').insert({
    id: orderId, buyerId, buyerRole: 'member', items: JSON.stringify(items), totalTzs: 30000,
    status: 'delivered', paymentStatus: 'paid', paymentMethod: 'mpesa', deliveryMethod: 'home_delivery', deliveryAddress: 'Sinza',
    timeline: JSON.stringify([{ status: 'pending', at: '2026-10-05T08:00:00Z' }, { status: 'delivered', at: '2026-10-07T10:00:00Z' }]),
    settlementStatus: 'pending', createdAt: new Date('2026-10-05T08:00:00Z'), updatedAt: new Date('2026-10-07T10:00:00Z'),
  });
  made.orders.push(orderId);

  process.env.VENDOR_STATEMENT_DRAFTS = '0';
  await logsOf(() => vendorSettlementDrafts.onJob());
  assert.equal(calls.length, 0);
  assert.equal(await db('VendorSettlement').where({ vendorId }).first(), undefined);

  process.env.VENDOR_STATEMENT_DRAFTS = 'on';
  clock = new Date('2026-10-19T09:00:00Z'); // last ended week 12–18 Oct
  await logsOf(() => vendorSettlementDrafts.onJob());
  assert.equal(calls.length, 1);
  const s = await db('VendorSettlement').where({ vendorId, status: 'draft' }).first();
  assert.equal(s.periodStartDate, '2026-10-12', 'catch-up lands on the next ended week, not a back-dated one');
  assert.equal(s.orderCount, 1);
  assert.equal(Number(s.finalNetTzs), 27000);
  assert.deepEqual((await db('VendorSettlementLine').where({ vendorSettlementId: s.id })).map(l => l.orderId), [orderId]);

  await logsOf(() => vendorSettlementDrafts.onJob());
  assert.equal((await db('VendorSettlement').where({ vendorId }).whereNot({ status: 'voided' })).length, 1);
  assert.equal((await db('VendorSettlementLine').where({ orderId, vendorId, voided: false })).length, 1);
});
