// B2B golden scenarios: the financial chain from organisation to paid gym
// statement, through the real services, against the CI database.
//
//   organisation → programme → benefit → beneficiary → gym check-in
//   → consumption → gym settlement → statement → approval → payment
//   → reconciliation
//
// Check-ins and consumptions are written by the real check-in and consumption
// services (committed, cleaned up afterwards). Settlement, the statement
// workflow and sponsor invoicing then run inside one transaction that is
// rolled back, the way the settlement suites do.
//
// These must keep passing whatever is built on top of the B2B layer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { withLedgerDelete } from './fixtures/ledger-cleanup.mjs';
import {
  gyms, trainers, b2bService, b2bProgramService, b2bConsumptionService as usage,
  checkInService, checkinStatusService, settingsService,
} from '../src/bootstrap/services.mjs';
import { b2bPrograms, b2bBenefits, users, subscriptions, paymentRequests, corporateAccounts, auditLog, checkins, trainerBookings } from '../src/bootstrap/collections.mjs';
import { createB2BConsumptionService } from '../src/services/b2b-consumption-service.mjs';
import { createB2BBillingService } from '../src/services/b2b-billing-service.mjs';
import { createSettlementConfigService } from '../src/services/settlement-config-service.mjs';
import { createSettlementService, periodForMonth, b2bCycleKey } from '../src/services/settlement-service.mjs';
import { createSettlementWorkflowService } from '../src/services/settlement-workflow-service.mjs';
import { createSettlementClawbackService } from '../src/services/settlement-clawback-service.mjs';
import { calculateMemberSettlement } from '../src/shared/settlement-engine.mjs';
import { ceilingSnapshot } from './fixtures/settlement-dar.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], gyms: [] };
const ADMIN = { userType: 'admin' };

/** Noon EAT on a day of October 2026: the month every scenario happens in. */
const oct = (day, hour = 9) => new Date(Date.UTC(2026, 9, day, hour));
const OCTOBER = '2026-10';
const NOVEMBER = periodForMonth('2026-11');   // the run in which October becomes final

// A Standard gym charging 5,000 a visit is paid 3,500 / 12,000 / 40,000 (day /
// week / month). Gym B has its own, cheaper agreement: 4,000 a visit, paid
// 3,000 / 9,600 / 32,000.
const RATES_A = { retailDailyTzs: 5000, retailWeeklyTzs: 15000, retailMonthlyTzs: 50000 };
const RATES_B = { retailDailyTzs: 4000, retailWeeklyTzs: 12000, retailMonthlyTzs: 40000 };

async function user(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Golden ${userType} ${id.slice(-4)}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
async function gym(ratePerDay) {
  const id = uid('gym');
  await gyms.insertAsync({ id, name: `Golden Gym ${id.slice(-4)}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay, perVisitRate: ratePerDay });
  made.gyms.push(id);
  return gyms.find(g => g.id === id);
}
const access = organizationId => b2bService.resolveAccess({ organizationId, ...ADMIN });

/** A member covered by a new, active sponsor with one active benefit. */
async function covered(benefitBody, { programBody = {} } = {}) {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Golden Employer ${uid('o')}` }, actorId: ADMIN.userId });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: ADMIN.userId });
  const memberId = await user('member');
  const a = await access(organization.id);
  const { beneficiary } = await b2bService.enrollBeneficiary({ access: a, body: { userId: memberId, status: 'active' }, actorId: ADMIN.userId });
  const { program } = await b2bProgramService.createProgram({ access: a, body: { name: 'Golden programme', startDate: '2026-01-01', ...programBody }, actorId: ADMIN.userId });
  const { benefit } = await b2bProgramService.createBenefit({ access: a, programId: program.id, body: { name: 'Gym visits', benefitType: 'gym_access', usagePeriod: 'month', ...benefitBody }, actorId: ADMIN.userId });
  await b2bProgramService.setBenefitStatus({ access: a, programId: program.id, benefitId: benefit.id, status: 'active', actorId: ADMIN.userId });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'pending', actorId: ADMIN.userId });
  const live = await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'active', actorId: ADMIN.userId });
  assert.equal(live.program?.status, 'active', JSON.stringify(live));
  return { orgId: organization.id, memberId, beneficiaryId: beneficiary.id, programId: program.id, benefitId: benefit.id };
}

/** The member's own Pro pass for October, paid and approved. */
async function ownPass(memberId, amountTzs = 150000) {
  const id = uid('sub');
  await db('Subscription').insert({
    id, memberId, type: 'platform_pass', tier: 'pro', status: 'active',
    startedAt: oct(1, 4), cycleStartedAt: oct(1, 4), renewsAt: oct(31, 4), expiresAt: oct(31, 4),
  });
  await db('PaymentRequest').insert({ id: uid('pay'), memberId, subscriptionId: id, tier: 'pro', amountTzs, status: 'approved', provider: 'admin_approved', requestedAt: oct(1, 3) });
  return id;
}

const checkIn = (memberId, g, day, hour = 9) => checkInService.perform({ memberId, gymId: g.id, method: 'member_scanned', now: oct(day, hour) });
const ledger = where => db('B2BBenefitConsumption').where(where).orderBy('createdAt');

// ── the world: every scenario's usage, written by the real services ─────────

const w = {};

before(async () => {
  ADMIN.userId = await user('admin');
  w.gymA = await gym(5000);
  w.gymB = await gym(4000);

  // 1. Employer-sponsored visit: the sponsor covers all of it.
  w.sponsored = await covered({ fundingType: 'full', usageLimit: 8 });
  w.sponsored.first = await checkIn(w.sponsored.memberId, w.gymA, 5);
  // 5. The same check-in submitted again.
  w.sponsored.again = await checkIn(w.sponsored.memberId, w.gymA, 5, 10);
  // 8. A different gym, with a different agreement.
  w.sponsored.atB = await checkIn(w.sponsored.memberId, w.gymB, 7);

  // 2. Subsidised: the sponsor pays 3,000 of the visit, the member the rest.
  w.subsidised = await covered({ fundingType: 'sponsor_fixed', sponsorAmountTzs: 3000, usageLimit: 8 });
  w.subsidised.first = await checkIn(w.subsidised.memberId, w.gymA, 5);

  // 3 + 4. One visit a month, then the member's own pass carries on.
  w.exhausted = await covered({ fundingType: 'full', usageLimit: 1 });
  w.exhausted.passId = await ownPass(w.exhausted.memberId);
  w.exhausted.first = await checkIn(w.exhausted.memberId, w.gymA, 5);
  w.exhausted.second = await checkIn(w.exhausted.memberId, w.gymA, 6);

  // 6. Two check-ins at once with one visit left, and no pass to fall back on.
  w.racing = await covered({ fundingType: 'full', usageLimit: 1 });
  w.racing.results = await Promise.all([checkIn(w.racing.memberId, w.gymA, 5), checkIn(w.racing.memberId, w.gymB, 5)]);

  // 7. A visit reversed before settlement.
  w.reversed = await covered({ fundingType: 'full', usageLimit: 2 });
  w.reversed.kept = await checkIn(w.reversed.memberId, w.gymA, 5);
  w.reversed.voided = await checkIn(w.reversed.memberId, w.gymA, 6);
  w.reversed.void = await checkinStatusService.setStatus({ checkinId: w.reversed.voided.checkin.id, status: 'voided', reason: 'Scanned the wrong person', actorId: ADMIN.userId, now: oct(6, 11) });

  // A personal member: no sponsor anywhere.
  w.personal = { memberId: await user('member') };
  w.personal.passId = await ownPass(w.personal.memberId);
  w.personal.first = await checkIn(w.personal.memberId, w.gymA, 5);

  // A heavy month on a benefit: 15 visits at one gym.
  w.heavy = await covered({ fundingType: 'full', usageLimit: null, usagePeriod: 'unlimited' });
  w.heavy.visits = [];
  for (let d = 5; d < 20; d++) w.heavy.visits.push(await checkIn(w.heavy.memberId, w.gymA, d));
});

after(async () => {
  if (made.orgs.length) {
    const ids = await db('B2BBenefitConsumption').whereIn('organizationId', made.orgs).pluck('id');
    await db('AuditLog').whereIn('target', ids).del();
    await withLedgerDelete(db, trx => trx('B2BBenefitConsumption').whereIn('organizationId', made.orgs).del());
    await db('B2BOrganization').whereIn('id', made.orgs).del();
  }
  const checkinIds = await db('Checkin').whereIn('memberId', made.users).pluck('id');
  await db('AuditLog').whereIn('target', checkinIds).del();
  await db('Checkin').whereIn('memberId', made.users).del();
  await db('PaymentRequest').whereIn('memberId', made.users).del();
  await db('Subscription').whereIn('memberId', made.users).del();
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('User').whereIn('id', made.users).del();
});

// ── settlement, in a transaction that is rolled back ────────────────────────

const ROLLBACK = Symbol('rollback');
async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}
async function rejects(trx, fn, code) {
  await assert.rejects(trx.transaction(fn), err => err.code === code, `expected Postgres error ${code}`);
}

/** Approve both gyms' rate cards, settle October (the November run), and return the services. */
async function settled(trx, at = '2026-12-02T09:00:00.000Z') {
  const configService = createSettlementConfigService({ db: trx, now: () => new Date('2026-09-01T09:00:00.000Z') });
  for (const [g, rates] of [[w.gymA, RATES_A], [w.gymB, RATES_B]]) {
    const { rateCard } = await configService.createRateCard({ gymId: g.id, ...rates, actorId: 'maker' }, { trx });
    assert.ok((await configService.activate({ kind: 'rate_card', id: rateCard.id, effectiveFrom: '2026-10-01', actorId: 'checker' }, { trx })).rateCard);
  }
  const settlement = createSettlementService({ db: trx, configService, now: () => new Date(at), logger: { error() {} } });
  const workflow = createSettlementWorkflowService({
    db: trx, now: () => new Date(at),
    payoutEligibility: { forGym: async () => ({ ok: true, destination: { kind: 'verified_account', accountLast4: '5678' } }) },
  });
  const clawback = createSettlementClawbackService({ db: trx, configService, workflow, now: () => new Date(at), logger: { warn() {} } });
  const out = await settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.ok(out.run, JSON.stringify(out));
  const statement = async g => trx('GymSettlement').where({ runId: out.run.id, gymId: g.id }).first();
  /** What one member's cycle earned at one gym. */
  const line = async (cycleKey, g) => trx('GymSettlementLine as l').join('MemberCycleSettlement as m', 'm.id', 'l.memberCycleSettlementId')
    .where({ 'l.runId': out.run.id, 'm.subscriptionId': cycleKey, 'l.gymId': g.id }).first('l.*');
  const cycle = async cycleKey => trx('MemberCycleSettlement').where({ runId: out.run.id, subscriptionId: cycleKey }).first();
  return { configService, settlement, workflow, clawback, out, statement, line, cycle };
}
const b2bKey = c => b2bCycleKey(c.beneficiaryId, OCTOBER);

// ── 1. Sponsored gym visit ───────────────────────────────────────────────────

test('golden 1 — sponsored gym visit: the sponsor covers it, and the gym is paid at its own rate', () => inRollback(async (trx) => {
  const c = w.sponsored;
  assert.deepEqual([c.first.ok, c.first.checkin.subscriptionType, c.first.checkin.visitConsumed], [true, 'b2b_benefit', false]);
  const [row] = await ledger({ sourceType: 'gym_checkin', sourceId: c.first.checkin.id });
  assert.deepEqual([row.status, row.organizationId, row.programId, row.benefitId, row.beneficiaryId, row.providerId, row.grossTzs, row.sponsorTzs, row.beneficiaryTzs],
    ['approved', c.orgId, c.programId, c.benefitId, c.beneficiaryId, w.gymA.id, 5000, 5000, 0]);

  const s = await settled(trx);
  const cyc = await s.cycle(b2bKey(c));
  // Charged 5,000 at gym A and 4,000 at gym B; the gyms may share at most 75% of that.
  assert.deepEqual([cyc.fundingType, cyc.collectedApprovedAmountTzs, cyc.networkCapTzs], ['b2b_benefit', 9000, 6750]);
  assert.equal((await s.line(b2bKey(c), w.gymA)).finalTzs, 3500);
}));

// ── 2. Subsidised gym visit ──────────────────────────────────────────────────

test('golden 2 — subsidised visit: sponsor share + member share = the visit\'s value, and the gym\'s payout is its own agreed rate', () => inRollback(async (trx) => {
  const c = w.subsidised;
  const [row] = await ledger({ sourceId: c.first.checkin.id });
  assert.deepEqual([row.grossTzs, row.sponsorTzs, row.beneficiaryTzs], [5000, 3000, 2000]);
  assert.equal(row.sponsorTzs + row.beneficiaryTzs, row.grossTzs);

  const s = await settled(trx);
  const l = await s.line(b2bKey(c), w.gymA);
  assert.equal(l.finalTzs, 3500);                       // the gym's rate, whoever paid
  const cyc = await s.cycle(b2bKey(c));
  assert.deepEqual(cyc.explanation.b2b, { beneficiaryId: c.beneficiaryId, month: OCTOBER, organizationIds: [c.orgId], sponsorTzs: 3000, beneficiaryTzs: 2000 });
  // What is left for FitFlex if both shares are collected.
  assert.equal(row.grossTzs - l.finalTzs, 1500);
}));

// ── 3 + 4. Benefit exhausted, then the personal pass ─────────────────────────

test('golden 3 — benefit exhausted: the sponsor is not charged again, and the refusal is on the ledger', async () => {
  const c = w.exhausted;
  const rows = await ledger({ benefitId: c.benefitId });
  assert.deepEqual(rows.map(r => [r.status, r.rejectionReason, r.sponsorTzs]), [['approved', null, 5000], ['rejected', 'usage_limit_reached', 0]]);
  const evaluation = await usage.evaluate({ userId: c.memberId, serviceType: 'gym_access', provider: { type: 'gym', id: w.gymA.id, tier: 'standard' }, grossTzs: 5000, at: oct(8) });
  assert.equal(evaluation.covered, false);
});

test('golden 4 — personal membership after exhaustion: the member\'s own pass carries on, and each visit is settled from its own money', () => inRollback(async (trx) => {
  const c = w.exhausted;
  assert.deepEqual([c.first.checkin.subscriptionType, c.first.checkin.subscriptionId], ['b2b_benefit', null]);
  assert.deepEqual([c.second.ok, c.second.checkin.subscriptionType, c.second.checkin.subscriptionId, c.second.checkin.visitConsumed, c.second.checkin.visitNumberInCycle],
    [true, 'platform_pass', c.passId, true, 1]);   // the sponsored visit used no pass visit

  const s = await settled(trx);
  const sponsor = await s.cycle(b2bKey(c));
  const own = await s.cycle(c.passId);
  assert.deepEqual([sponsor.fundingType, sponsor.collectedApprovedAmountTzs, sponsor.totalFinalTzs], ['b2b_benefit', 5000, 3500]);
  assert.deepEqual([own.fundingType, own.collectedApprovedAmountTzs, own.totalFinalTzs], ['platform_pass', 150000, 3500]);
}));

test('golden 4b — a personal member with no sponsor is untouched by any of this', () => inRollback(async (trx) => {
  const p = w.personal;
  assert.deepEqual([p.first.ok, p.first.checkin.subscriptionType, p.first.checkin.subscriptionId, p.first.b2b], [true, 'platform_pass', p.passId, undefined]);
  assert.equal((await ledger({ userId: p.memberId })).length, 0);
  const s = await settled(trx);
  assert.deepEqual([(await s.cycle(p.passId)).fundingType, (await s.line(p.passId, w.gymA)).finalTzs], ['platform_pass', 3500]);
}));

// ── 5. Duplicate check-in ────────────────────────────────────────────────────

test('golden 5 — duplicate check-in: one visit, one consumption, one payable', () => inRollback(async (trx) => {
  const c = w.sponsored;
  assert.deepEqual([c.again.idempotent, c.again.checkin.id], [true, c.first.checkin.id]);
  assert.equal((await ledger({ benefitId: c.benefitId, providerId: w.gymA.id })).length, 1);
  assert.equal((await db('Checkin').where({ memberId: c.memberId, gymId: w.gymA.id })).length, 1);
  // The database refuses a second live consumption for the same check-in.
  const [row] = await ledger({ sourceId: c.first.checkin.id });
  const { createdAt, updatedAt, ...copy } = row;
  await assert.rejects(db('B2BBenefitConsumption').insert({ ...copy, id: uid('b2bc'), rulesSnapshot: null, metadata: null }), err => err.code === '23505');

  const s = await settled(trx);
  assert.equal((await trx('SettlementVisit').where({ runId: s.out.run.id, checkinId: c.first.checkin.id, outcome: 'payable' })).length, 1);
}));

// ── 6. Concurrent check-ins ──────────────────────────────────────────────────

test('golden 6 — two check-ins at once with one visit left: exactly one is covered', async () => {
  const c = w.racing;
  const ok = c.results.filter(r => r.ok);
  assert.equal(ok.length, 1, JSON.stringify(c.results));
  assert.equal(ok[0].checkin.subscriptionType, 'b2b_benefit');
  assert.deepEqual(c.results.find(r => !r.ok), { ok: false, failure: 'subscription_inactive' });
  assert.equal((await ledger({ benefitId: c.benefitId, status: 'approved' })).length, 1);
  assert.equal((await ledger({ benefitId: c.benefitId, status: 'pending' })).length, 0);     // no hold left behind
  assert.equal((await db('Checkin').where({ memberId: c.memberId })).length, 1);             // and no visit without a payer
});

// ── 7. Reversed usage ────────────────────────────────────────────────────────

test('golden 7 — reversed usage: the row and its audit stay, the allowance comes back, and the gym is not paid for it', () => inRollback(async (trx) => {
  const c = w.reversed;
  assert.equal(c.void.checkin.status, 'voided');
  const [row] = await ledger({ sourceId: c.voided.checkin.id });
  assert.deepEqual([row.status, row.reversedBy, row.grossTzs, row.sponsorTzs], ['reversed', ADMIN.userId, 5000, 5000]);   // amounts kept as recorded
  assert.match(row.reversalReason, /Scanned the wrong person/);
  assert.ok(await db('AuditLog').where({ target: c.voided.checkin.id, action: 'checkin_voided' }).first());
  assert.ok(await db('AuditLog').where({ target: row.id, action: 'b2b.consumption.reverse' }).first());
  await assert.rejects(db('B2BBenefitConsumption').where({ id: row.id }).update({ sponsorTzs: 0 }), /immutable/);
  // One of two visits is free again.
  const evaluation = await usage.evaluate({ userId: c.memberId, serviceType: 'gym_access', provider: { type: 'gym', id: w.gymA.id, tier: 'standard' }, grossTzs: 5000, at: oct(8) });
  assert.equal(evaluation.covered, true);

  const s = await settled(trx);
  const cyc = await s.cycle(b2bKey(c));
  assert.deepEqual([cyc.collectedApprovedAmountTzs, cyc.totalFinalTzs], [5000, 3500]);       // the reversed charge is out of the cap too
  assert.equal((await trx('SettlementVisit').where({ runId: s.out.run.id, checkinId: c.voided.checkin.id, outcome: 'payable' })).length, 0);
}));

// ── 8. Different gym agreement ───────────────────────────────────────────────

test('golden 8 — different gym agreement: each gym is paid on its own rate card', () => inRollback(async (trx) => {
  const c = w.sponsored;
  const [row] = await ledger({ sourceId: c.atB.checkin.id });
  assert.deepEqual([row.providerId, row.grossTzs, row.sponsorTzs], [w.gymB.id, 4000, 4000]);
  const s = await settled(trx);
  const [a, b] = [await s.line(b2bKey(c), w.gymA), await s.line(b2bKey(c), w.gymB)];
  assert.deepEqual([a.finalTzs, b.finalTzs], [3500, 3000]);
  assert.deepEqual([a.rateCardSnapshot.retailDailyTzs, b.rateCardSnapshot.retailDailyTzs], [5000, 4000]);   // the rates used are kept with the line
}));

test('golden 8b — a rate card changed after the visits does not re-price them', () => inRollback(async (trx) => {
  const s = await settled(trx);
  const before = (await s.line(b2bKey(w.sponsored), w.gymB)).finalTzs;
  // A new card for gym B from 1 December, approved after October was settled.
  const config = createSettlementConfigService({ db: trx, now: () => new Date('2026-11-20T09:00:00.000Z') });
  const { rateCard } = await config.createRateCard({ gymId: w.gymB.id, retailDailyTzs: 9000, retailWeeklyTzs: 27000, retailMonthlyTzs: 90000, actorId: 'maker' }, { trx });
  assert.ok((await config.activate({ kind: 'rate_card', id: rateCard.id, effectiveFrom: '2026-12-01', actorId: 'checker' }, { trx })).rateCard);
  assert.equal((await s.line(b2bKey(w.sponsored), w.gymB)).finalTzs, before);
  // The card in force can't be edited in place.
  const active = await trx('GymRateCard').where({ gymId: w.gymB.id, status: 'active' }).orderBy('effectiveFrom').first();
  await rejects(trx, t => t('GymRateCard').where({ id: active.id }).update({ retailDailyTzs: 9000 }), 'P0001');
}));

// ── the brackets, through real check-ins and at every boundary ──────────────

test('golden — 15 sponsored visits in a month earn the gym one monthly rate', () => inRollback(async (trx) => {
  const c = w.heavy;
  assert.equal(c.visits.filter(v => v.ok && v.checkin.subscriptionType === 'b2b_benefit').length, 15);
  const s = await settled(trx);
  const l = await s.line(b2bKey(c), w.gymA);
  assert.deepEqual([l.qualifyingVisitCount, l.bracket, l.finalTzs], [15, 'monthly', 40000]);
  const cyc = await s.cycle(b2bKey(c));
  assert.deepEqual([cyc.collectedApprovedAmountTzs, cyc.networkCapTzs, cyc.capApplied], [75000, 56250, false]);
}));

test('golden — the payout at every visit boundary, for a sponsored month at one Standard gym', () => {
  const visit = d => ({ checkinId: `v${d}`, memberId: 'm', cycleId: 'b2b:ben:2026-10', gymId: 'gym-A', status: 'valid', visitConsumed: true, subscriptionType: 'b2b_benefit',
    timestamp: new Date(Date.UTC(2026, 9, d, 9)).toISOString() });
  const payout = (n) => {
    const r = calculateMemberSettlement({
      cycle: { memberId: 'm', cycleId: 'b2b:ben:2026-10', subscriptionType: 'b2b_benefit', passTier: 'b2b_benefit', cycleStart: '2026-09-30T21:00:00.000Z', cycleEnd: '2026-10-31T21:00:00.000Z',
        collectedApprovedAmountTzs: n * 5000, networkPayoutBps: 7500, visitAllowance: 100 },
      visits: Array.from({ length: n }, (_, i) => visit(i + 1)), gymRates: [ceilingSnapshot('gym-A', 'standard')],
    });
    return r.member.totalFinalTzs;
  };
  assert.deepEqual([0, 1, 3, 4, 7, 8, 14, 15, 16, 31].map(n => [n, payout(n)]),
    [[0, 0], [1, 3500], [3, 10500], [4, 12000], [7, 12000], [8, 24000], [14, 24000], [15, 42000], [16, 42000], [31, 42000]]);   // Standard ceilings: 3,500 / 12,000 / 42,000
});

// ── 9. Settlement generated twice ────────────────────────────────────────────

test('golden 9 — settlement generated twice: no second run, statement or payable', () => inRollback(async (trx) => {
  const s = await settled(trx);
  const count = async () => [
    (await trx('GymSettlement').where({ mode: 'live' }).whereIn('gymId', made.gyms)).length,
    (await trx('SettlementVisit').where({ mode: 'live', outcome: 'payable' }).whereIn('gymId', made.gyms)).length,
  ];
  const first = await count();
  const again = await s.settlement.run({ ...NOVEMBER, mode: 'live' });
  assert.deepEqual([again.alreadyRun, again.run.id], [true, s.out.run.id]);
  // The following month doesn't take October again either.
  const later = createSettlementService({ db: trx, configService: s.configService, now: () => new Date('2027-01-05T09:00:00.000Z'), logger: { error() {} } });
  const december = await later.run({ ...periodForMonth('2026-12'), mode: 'live' });
  assert.equal((await trx('MemberCycleSettlement').where({ runId: december.run.id }).whereIn('memberId', made.users)).length, 0);
  assert.deepEqual(await count(), first);
  // And the database refuses a check-in that is payable twice.
  const paid = await trx('SettlementVisit').where({ runId: s.out.run.id, outcome: 'payable', gymId: w.gymA.id }).first();
  const { id, ...copy } = paid;
  await assert.rejects(trx.transaction(t => t('SettlementVisit').insert({ ...copy, id: uid('sv') })), err => ['23505', 'P0001'].includes(err.code));
}));

// ── 10. Approval, payment, and a paid statement ──────────────────────────────

test('golden 10 — a statement is approved by a second person, paid once, and afterwards only an adjustment can change what the gym is owed', () => inRollback(async (trx) => {
  const s = await settled(trx);
  const { id } = await s.statement(w.gymA);
  await s.workflow.submit({ id, actorId: 'maker' });
  assert.equal((await s.workflow.approve({ id, actorId: 'maker' })).error, 'cannot_approve_own_submission');
  await s.workflow.approve({ id, actorId: 'checker' });
  await s.workflow.markPayable({ id, actorId: 'payer' });
  const paid = await s.workflow.pay({ id, paymentReference: 'MPESA-GOLDEN-1', actorId: 'payer' });
  assert.equal(paid.statement.status, 'paid');

  // Paid twice: refused, and still one payout.
  assert.equal((await s.workflow.pay({ id, paymentReference: 'MPESA-GOLDEN-2', actorId: 'payer' })).error, 'invalid_status');
  const payouts = await trx('GymPayout').where({ gymSettlementId: id });
  assert.deepEqual(payouts.map(p => [p.amount, p.reference, p.status]), [[paid.statement.finalNetTzs, 'MPESA-GOLDEN-1', 'paid']]);

  // A paid statement can't be edited, adjusted, voided or deleted.
  await rejects(trx, t => t('GymSettlement').where({ id }).update({ finalNetTzs: 1 }), 'P0001');
  assert.equal((await s.workflow.proposeAdjustment({ statementId: id, amountTzs: -3500, type: 'clawback', reason: 'late void', actorId: 'maker' })).error, 'invalid_status');
  assert.equal((await s.workflow.voidStatement({ id, reason: 'mistake', actorId: 'checker' })).error, 'invalid_status');

  // The sponsor's charge for a visit on it is reversed afterwards. That voids
  // the visit: the sponsor is credited, the paid statement is untouched, and
  // what the gym was overpaid waits as a clawback for its next statement.
  const c = w.sponsored;
  let sweep = null;
  const usageInTrx = createB2BConsumptionService({
    db: trx, programs: b2bPrograms, benefits: b2bBenefits, users, gyms, trainers, checkins, trainerBookings, auditLog, b2bService,
    // What checkinStatusService does on a void, inside this transaction.
    voidCheckin: async ({ checkinId, reason, actorId }) => {
      await trx('Checkin').where({ id: checkinId }).update({ status: 'voided', statusReason: reason, voidedAt: new Date(), voidedBy: actorId, voidReason: reason });
      await usageInTrx.releaseForSource({ sourceType: 'gym_checkin', sourceId: checkinId, reason: `check-in voided: ${reason}`, actorId });
      sweep = await s.clawback.sweep({ checkinId, actorId });
      return { checkin: { id: checkinId } };
    },
  });
  const [charge] = await trx('B2BBenefitConsumption').where({ sourceId: c.first.checkin.id });
  const reversed = await usageInTrx.reverse({ consumptionId: charge.id, reason: 'Sponsor disputes the visit', actorId: 'voider' });
  assert.deepEqual([reversed.consumption.status, reversed.checkinVoided], ['reversed', true]);
  assert.equal((await trx('Checkin').where({ id: c.first.checkin.id }).first()).status, 'voided');
  assert.deepEqual(sweep.pending.filter(p => p.gymId === w.gymA.id).map(p => p.amountTzs), [-3500]);
  assert.deepEqual([(await trx('GymSettlement').where({ id }).first()).finalNetTzs, (await trx('GymPayout').where({ gymSettlementId: id })).length], [paid.statement.finalNetTzs, 1]);

  const audit = (await trx('AuditLog').where({ target: id })).map(a => a.action).sort();
  assert.deepEqual(audit, ['settlement_approved', 'settlement_paid', 'settlement_payable', 'settlement_submitted']);
}));

// ── reconciliation ───────────────────────────────────────────────────────────

test('golden — reconciliation: every shilling on a paid statement traces back to check-ins, and to who was charged for them', () => inRollback(async (trx) => {
  const s = await settled(trx);
  const st = await s.statement(w.gymA);

  // Statement = its lines; line = its visits.
  const lines = await trx('GymSettlementLine').where({ gymSettlementId: st.id });
  const sum = (rows, k) => rows.reduce((n, r) => n + Number(r[k] || 0), 0);
  assert.equal(sum(lines, 'preliminaryTzs'), st.preliminaryTzs);
  assert.equal(sum(lines, 'finalTzs'), st.preliminaryTzs + st.networkAdjustmentTzs);
  assert.equal(st.finalNetTzs, st.preliminaryTzs + st.networkAdjustmentTzs + st.adjustmentsTzs);
  const visits = await trx('SettlementVisit').whereIn('lineId', lines.map(l => l.id)).where({ outcome: 'payable' });
  assert.equal(visits.length, st.qualifyingVisitCount);

  // Gym A in October: sponsored 1, subsidised 1, exhausted 1 + own pass 1,
  // reversed 1 (the voided one is out), personal 1, heavy 15, and the racing
  // member's single visit if it landed here.
  const racedAtA = w.racing.results.some(r => r.ok && r.checkin.gymId === w.gymA.id);
  assert.equal(st.finalNetTzs, 6 * 3500 + 40000 + (racedAtA ? 3500 : 0));
  assert.equal(visits.length, 6 + 15 + (racedAtA ? 1 : 0));

  // Every sponsored visit has exactly one approved consumption, and its shares add up.
  const checkins = await trx('Checkin').whereIn('id', visits.map(v => v.checkinId));
  const sponsoredIds = checkins.filter(c => c.subscriptionType === 'b2b_benefit').map(c => c.id);
  const usageRows = await trx('B2BBenefitConsumption').whereIn('sourceId', sponsoredIds).where({ status: 'approved' });
  assert.equal(usageRows.length, sponsoredIds.length);
  for (const r of usageRows) assert.equal(r.sponsorTzs + r.beneficiaryTzs, r.grossTzs);
  const gross = sum(usageRows, 'grossTzs');
  const sponsor = sum(usageRows, 'sponsorTzs');
  const member = sum(usageRows, 'beneficiaryTzs');
  assert.equal(sponsor + member, gross);
  assert.equal(member, 2000);                                   // only the subsidised visit has a member share

  // The gyms never get more than 75% of what was charged for a sponsored member's month.
  for (const m of await trx('MemberCycleSettlement').where({ runId: s.out.run.id, fundingType: 'b2b_benefit' }).whereIn('memberId', made.users)) {
    assert.ok(m.totalFinalTzs <= m.networkCapTzs, `${m.subscriptionId}: ${m.totalFinalTzs} > ${m.networkCapTzs}`);
    assert.equal(m.networkCapTzs, Math.floor(m.collectedApprovedAmountTzs * 0.75));
  }

  // Pay it: net settlement = amount paid, nothing outstanding.
  await s.workflow.submit({ id: st.id, actorId: 'maker' });
  await s.workflow.approve({ id: st.id, actorId: 'checker' });
  await s.workflow.markPayable({ id: st.id, actorId: 'payer' });
  await s.workflow.pay({ id: st.id, paymentReference: 'MPESA-GOLDEN-R', actorId: 'payer' });
  const paid = sum(await trx('GymPayout').where({ gymSettlementId: st.id, status: 'paid' }), 'amount');
  assert.equal(st.finalNetTzs - paid, 0);

  // The sponsor's side: the invoice for October is exactly the sponsor shares on the ledger.
  const billing = createB2BBillingService({
    db: trx, programs: b2bPrograms, benefits: b2bBenefits, users, subscriptions, paymentRequests, corporateAccounts, auditLog,
    b2bService, b2bProgramService, settingsService, now: () => new Date('2026-11-02T09:00:00.000Z'),
  });
  for (const c of [w.sponsored, w.subsidised, w.heavy]) {
    const prepared = await billing.prepareUsage({ programId: c.programId, period: OCTOBER, actorId: ADMIN.userId });
    const charged = sum(await trx('B2BBenefitConsumption').where({ programId: c.programId, status: 'approved' }), 'sponsorTzs');
    assert.equal(prepared.invoice.totalTzs, charged);
    // Prepared twice: nothing is invoiced twice.
    assert.deepEqual([(await billing.prepareUsage({ programId: c.programId, period: OCTOBER, actorId: ADMIN.userId })).added], [0]);
  }
  assert.equal((await trx('B2BSponsorInvoice').where({ programId: w.subsidised.programId }).first()).totalTzs, 3000);
}));

// ── the sponsor stops paying when it should ──────────────────────────────────

test('golden — a suspended organisation or an inactive beneficiary is no longer covered; what was already used stays on the books', async () => {
  const c = await covered({ fundingType: 'full', usageLimit: 8 });
  const first = await checkIn(c.memberId, w.gymA, 20);
  assert.equal(first.checkin.subscriptionType, 'b2b_benefit');

  await b2bService.setBeneficiaryStatus({ access: await access(c.orgId), beneficiaryId: c.beneficiaryId, status: 'suspended', actorId: ADMIN.userId });
  assert.deepEqual(await checkIn(c.memberId, w.gymA, 21), { ok: false, failure: 'subscription_inactive' });
  await b2bService.setBeneficiaryStatus({ access: await access(c.orgId), beneficiaryId: c.beneficiaryId, status: 'active', actorId: ADMIN.userId });
  assert.equal((await checkIn(c.memberId, w.gymA, 21)).checkin.subscriptionType, 'b2b_benefit');

  await b2bService.setOrganizationStatus({ organizationId: c.orgId, status: 'suspended', actorId: ADMIN.userId });
  assert.deepEqual(await checkIn(c.memberId, w.gymA, 22), { ok: false, failure: 'subscription_inactive' });
  assert.deepEqual((await ledger({ benefitId: c.benefitId, status: 'approved' })).map(r => r.sponsorTzs), [5000, 5000]);
});

// ── a scan that arrives twice ────────────────────────────────────────────────

test('golden — the same scan arriving twice a few milliseconds apart is one visit and one charge', async () => {
  // A double tap, or two desks scanning the same code.
  const scan = (memberId, day, ms) => checkInService.perform({ memberId, gymId: w.gymA.id, method: 'member_scanned', now: new Date(+oct(day) + ms) });
  const c = await covered({ fundingType: 'full', usageLimit: 8 });
  const results = await Promise.all([scan(c.memberId, 23, 0), scan(c.memberId, 23, 7), scan(c.memberId, 23, 11)]);
  assert.deepEqual(results.map(r => r.ok), [true, true, true]);
  assert.equal(new Set(results.map(r => r.checkin.id)).size, 1);
  assert.equal((await db('Checkin').where({ memberId: c.memberId })).length, 1);
  assert.deepEqual((await ledger({ benefitId: c.benefitId })).map(r => r.status).sort(), ['approved', 'cancelled', 'cancelled']);   // the losers' holds were released
  // A member on their own pass: one visit, one pass visit used.
  const memberId = await user('member');
  await ownPass(memberId);
  const own = await Promise.all([scan(memberId, 23, 0), scan(memberId, 23, 7)]);
  assert.equal(new Set(own.map(r => r.checkin.id)).size, 1);
  assert.deepEqual((await db('Checkin').where({ memberId })).map(r => [r.visitConsumed, r.visitNumberInCycle]), [[true, 1]]);
  // The database refuses a second live visit for the same member, gym and day.
  const [row] = await db('Checkin').where({ memberId });
  await assert.rejects(db('Checkin').insert({ ...row, id: randomUUID(), timestamp: new Date(+new Date(row.timestamp) + 60_000) }), err => err.code === '23505');
});

// ── a check-in interrupted half-way ──────────────────────────────────────────

test('golden — a hold left behind by an interrupted check-in is settled: approved if the visit exists, cancelled if not', async () => {
  const c = await covered({ fundingType: 'full', usageLimit: 2 });
  const hold = (checkinId, day) => usage.holdGymVisit({ memberId: c.memberId, gym: w.gymA, checkinId, now: oct(day), method: 'member_scanned' });
  // The visit was recorded but never confirmed (the process stopped after the insert).
  const recorded = randomUUID();
  const first = await hold(recorded, 24);
  await db('Checkin').insert({ id: recorded, memberId: c.memberId, gymId: w.gymA.id, timestamp: oct(24), method: 'member_scanned', subscriptionType: 'b2b_benefit',
    gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: false, status: 'valid', businessDate: '2026-10-24', source: 'gym_qr_by_member' });
  // The visit was never recorded at all.
  const second = await hold(randomUUID(), 25);
  assert.deepEqual([first.consumption.status, second.consumption.status], ['pending', 'pending']);
  // Both holds count against the allowance until they are settled.
  assert.equal((await usage.evaluate({ userId: c.memberId, serviceType: 'gym_access', provider: { type: 'gym', id: w.gymA.id, tier: 'standard' }, grossTzs: 5000, at: oct(26) })).covered, false);

  // Too recent to touch.
  await usage.reconcileHolds();
  assert.equal((await ledger({ benefitId: c.benefitId, status: 'pending' })).length, 2);
  const stats = await usage.reconcileHolds({ olderThanMs: -60_000 });
  assert.ok(stats.approved >= 1 && stats.cancelled >= 1, JSON.stringify(stats));
  const rows = Object.fromEntries((await ledger({ benefitId: c.benefitId })).map(r => [r.id, r]));
  assert.deepEqual([rows[first.consumption.id].status, rows[second.consumption.id].status], ['approved', 'cancelled']);
  assert.ok(rows[first.consumption.id].verifiedAt);
  assert.equal(rows[second.consumption.id].metadata.cancelReason, 'checkin_not_recorded');
  assert.ok(await db('AuditLog').where({ target: first.consumption.id, action: 'b2b.consumption.approve', actor: 'system:b2b-reconciler' }).first());
  // The cancelled hold's visit is free again.
  assert.equal((await usage.evaluate({ userId: c.memberId, serviceType: 'gym_access', provider: { type: 'gym', id: w.gymA.id, tier: 'standard' }, grossTzs: 5000, at: oct(26) })).covered, true);
  assert.equal((await usage.reconcileHolds({ olderThanMs: -60_000 })).found, 0);   // nothing left; safe to repeat
});

// ── reversing a gym visit ────────────────────────────────────────────────────

test('golden — reversing a gym visit\'s charge voids the visit, with one audit trail; without the payments permission it is refused', async () => {
  const c = await covered({ fundingType: 'full', usageLimit: 8 });
  const { checkin } = await checkIn(c.memberId, w.gymA, 26);
  const [charge] = await ledger({ sourceId: checkin.id });

  const refused = await usage.reverse({ consumptionId: charge.id, reason: 'Sponsor disputes the visit', actorId: ADMIN.userId, mayVoidCheckin: false });
  assert.deepEqual([refused.error, refused.status, refused.requiredScope], ['acl_forbidden', 403, 'payments']);
  assert.deepEqual([(await db('Checkin').where({ id: checkin.id }).first()).status, (await ledger({ id: charge.id }))[0].status], ['valid', 'approved']);

  const done = await usage.reverse({ consumptionId: charge.id, reason: 'Sponsor disputes the visit', actorId: ADMIN.userId });
  assert.deepEqual([done.consumption.status, done.checkinVoided, done.consumption.reversedBy], ['reversed', true, ADMIN.userId]);
  const voided = await db('Checkin').where({ id: checkin.id }).first();
  assert.deepEqual([voided.status, voided.voidedBy, voided.voidReason], ['voided', ADMIN.userId, 'Sponsor disputes the visit']);
  assert.ok(await db('AuditLog').where({ target: checkin.id, action: 'checkin_voided' }).first());
  assert.ok(await db('AuditLog').where({ target: charge.id, action: 'b2b.consumption.reverse' }).first());
  assert.equal((await usage.reverse({ consumptionId: charge.id, reason: 'again', actorId: ADMIN.userId })).unchanged, true);
});

// ── the ledgers are append-only ──────────────────────────────────────────────

test('golden — ledger rows cannot be deleted, even directly in the database; maintenance has to opt in', async () => {
  const [row] = await ledger({ sourceId: w.sponsored.first.checkin.id });
  await assert.rejects(db('B2BBenefitConsumption').where({ id: row.id }).del(), err => err.code === 'P0001' && /never deleted/.test(err.message));
  assert.equal((await ledger({ id: row.id })).length, 1);
  await inRollback(async (trx) => {
    const billing = createB2BBillingService({
      db: trx, programs: b2bPrograms, benefits: b2bBenefits, users, subscriptions, paymentRequests, corporateAccounts, auditLog,
      b2bService, b2bProgramService, settingsService, now: () => new Date('2026-11-02T09:00:00.000Z'),
    });
    const { invoice } = await billing.prepareUsage({ programId: w.sponsored.programId, period: OCTOBER, actorId: ADMIN.userId });
    await rejects(trx, t => t('B2BSponsorInvoiceLine').where({ invoiceId: invoice.id }).del(), 'P0001');
    await rejects(trx, t => t('B2BSponsorInvoice').where({ id: invoice.id }).del(), 'P0001');
    // Maintenance opts in, for the transaction it is in.
    await trx.raw("SET LOCAL fitflex.allow_ledger_delete = 'on'");
    await trx('B2BSponsorInvoiceLine').where({ invoiceId: invoice.id }).del();
    await trx('B2BSponsorInvoice').where({ id: invoice.id }).del();
  });
  // The opt-in ended with that transaction: the next one is refused again.
  await db.transaction(trx => trx.raw("SET LOCAL fitflex.allow_ledger_delete = 'on'"));
  await assert.rejects(db('B2BBenefitConsumption').where({ id: row.id }).del(), err => err.code === 'P0001');
});
