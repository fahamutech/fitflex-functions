// B2B analytics against the CI database: the golden scenarios (new
// organisation, sponsored visit, split funding, several providers, a benefit
// used up, a reversal, an invoice, a payment, the provider side, tenant
// isolation), what an organisation may see of a person, periods, exports and
// data-quality checks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { purgeB2BBilling } from './fixtures/ledger-cleanup.mjs';
import {
  gyms, b2bService, b2bProgramService, b2bConsumptionService as usage, b2bBillingService as billing, b2bFinanceService as finance,
  b2bAnalyticsService as analytics, settingsService, signJwt as sign,
} from '../src/bootstrap/services.mjs';
import { createB2BAnalyticsService } from '../src/services/b2b-analytics-service.mjs';
import { b2bPrograms, b2bBenefits, trainers } from '../src/bootstrap/collections.mjs';
import { resolvePeriod, bucketsBetween, changePct, ratePct, toCsv } from '../src/shared/b2b-analytics.mjs';
import { ROLE_PERMISSIONS } from '../src/shared/b2b.mjs';
import { monthBounds } from '../src/shared/b2b-programs.mjs';
import { localDay, addDays } from '../src/shared/member-progress.mjs';
import {
  getB2BOrganizationDashboard, listB2BOrganizationPeopleAnalytics, getB2BOrganizationPersonAnalytics, getB2BOrganizationFinanceAnalytics,
  getB2BOrganizationBenefitAnalytics, exportB2BOrganizationReport, adminB2BAnalyticsOverview, adminB2BDataQuality,
} from '../functions/b2b.mjs';
import { deliveredTo } from './fixtures/notification-language.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], gyms: [], checkins: [], activities: [] };
const TODAY = localDay(new Date());
const PERIOD = TODAY.slice(0, 7);
const LAST = (() => { const [y, m] = PERIOD.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
const NOW = { from: TODAY, to: TODAY };
const PRO = settingsService.priceForTier('pro');

async function user(userType = 'member', name = null) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: name ?? `Analytics ${userType} ${id.slice(-4)}`, updatedAt: new Date(), memberProfile: JSON.stringify({ weightKg: 71, heightCm: 168 }) });
  made.users.push(id);
  return id;
}
const BILLER = await user('admin');
const CASHIER = await user('admin');
const ADMIN = { userType: 'admin', userId: BILLER };
const access = (organizationId, who = ADMIN) => b2bService.resolveAccess({ organizationId, ...who });
const as = (orgId, claims) => access(orgId, { userType: claims.userType, userId: claims.sub });

async function sponsor(name = 'employer') {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Analytics ${name} ${uid('o')}`, email: 'office@analytics.test' }, actorId: BILLER });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: BILLER });
  return organization.id;
}
async function enrol(orgId, groupName = null, name = null) {
  const userId = await user('member', name);
  const r = await b2bService.enrollBeneficiary({ access: await access(orgId), body: { userId, status: 'active', groupName }, actorId: BILLER });
  assert.ok(r.beneficiary, JSON.stringify(r));
  return { userId, id: r.beneficiary.id };
}
async function programme(orgId, benefitBodies, extra = {}) {
  const a = await access(orgId);
  const { program } = await b2bProgramService.createProgram({ access: a, body: { name: 'Analytics programme', startDate: '2026-01-01', ...extra }, actorId: BILLER });
  const ids = [];
  for (const body of benefitBodies) {
    const created = await b2bProgramService.createBenefit({ access: a, programId: program.id, body, actorId: BILLER });
    assert.ok(created.benefit, JSON.stringify(created));
    await b2bProgramService.setBenefitStatus({ access: a, programId: program.id, benefitId: created.benefit.id, status: 'active', actorId: BILLER });
    ids.push(created.benefit.id);
  }
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'pending', actorId: BILLER });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'active', actorId: BILLER });
  return { programId: program.id, benefitIds: ids };
}
async function gym(name) {
  const id = uid('gym');
  await gyms.insertAsync({ id, name, tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000 });
  made.gyms.push(id);
  return id;
}
const VISITS = { name: 'Gym visits', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'unlimited' };
const visit = (userId, gymId, day = TODAY, extra = {}) => usage.consume({
  userId, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: gymId, tier: 'standard' }, grossTzs: 5000, at: new Date(`${day}T09:00:00.000Z`), ...extra,
});
async function orgUser(orgId, role) {
  const sub = await user('member');
  const out = await b2bService.addOrganizationUser({ access: await access(orgId), body: { userId: sub, role }, actorId: BILLER });
  assert.ok(!out.error, JSON.stringify(out));
  return { sub, userType: 'member' };
}
const dash = async (orgId, query = NOW, who = ADMIN) => analytics.dashboard({ access: await access(orgId, who), query });

function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

after(async () => {
  if (made.activities.length) await db('Activity').whereIn('id', made.activities).del();
  if (made.checkins.length) await db('Checkin').whereIn('id', made.checkins).del();
  await purgeB2BBilling(db, made.orgs);
  await db('Notification').whereIn('userId', made.users).del().catch(() => {});
  if (made.orgs.length) {
    await db('B2BOrganizationUser').whereIn('organizationId', made.orgs).del().catch(() => {});
    await db('B2BOrganization').whereIn('id', made.orgs).del();
  }
  await db('PaymentRequest').whereIn('memberId', made.users).del();
  await db('Subscription').whereIn('memberId', made.users).del();
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('AuditLog').whereIn('actor', [...made.users, 'system:b2b-billing']).del();
  await db('User').whereIn('id', made.users).del();
});

// ── Rules ────────────────────────────────────────────────────────────────────

test('rules: periods, what each is compared with, buckets, rates and CSV', () => {
  const p = (query, today = '2026-10-12') => resolvePeriod(query, today);
  const span = x => [x.from, x.to, x.previous.from, x.previous.to];
  assert.deepEqual(span(p({})), ['2026-10-01', '2026-10-12', '2026-09-01', '2026-09-12']);                       // default: this month so far, beside the same days last month
  assert.deepEqual(span(p({ period: 'today' })), ['2026-10-12', '2026-10-12', '2026-10-11', '2026-10-11']);
  assert.deepEqual(span(p({ period: 'yesterday' })), ['2026-10-11', '2026-10-11', '2026-10-10', '2026-10-10']);
  assert.deepEqual(span(p({ period: 'last_7_days' })), ['2026-10-06', '2026-10-12', '2026-09-29', '2026-10-05']);
  assert.deepEqual(span(p({ period: 'last_30_days' })), ['2026-09-13', '2026-10-12', '2026-08-14', '2026-09-12']);
  assert.deepEqual(span(p({ period: 'last_month' })), ['2026-09-01', '2026-09-30', '2026-08-01', '2026-08-31']);
  assert.deepEqual(span(p({ period: 'this_quarter' })), ['2026-10-01', '2026-10-12', '2026-07-01', '2026-07-12']);
  assert.deepEqual(span(p({ period: 'last_quarter' })), ['2026-07-01', '2026-09-30', '2026-04-01', '2026-06-30']);
  assert.deepEqual(span(p({ period: 'year_to_date' })), ['2026-01-01', '2026-10-12', '2025-01-01', '2025-10-12']);
  assert.deepEqual(span(p({ period: 'last_year' })), ['2025-01-01', '2025-12-31', '2024-01-01', '2024-12-31']);
  assert.deepEqual(span(p({ from: '2026-10-03', to: '2026-10-09' })), ['2026-10-03', '2026-10-09', '2026-09-26', '2026-10-02']);
  // Year and month boundaries, and a month longer than the one before it.
  assert.deepEqual(span(p({ period: 'last_month' }, '2026-01-15')), ['2025-12-01', '2025-12-31', '2025-11-01', '2025-11-30']);
  assert.deepEqual(span(p({ period: 'last_quarter' }, '2026-02-01')), ['2025-10-01', '2025-12-31', '2025-07-01', '2025-09-30']);
  assert.deepEqual(span(p({}, '2026-03-31')), ['2026-03-01', '2026-03-31', '2026-02-01', '2026-02-28']);
  assert.deepEqual([p({ period: 'today' }).bucket, p({ period: 'last_quarter' }).bucket, p({ period: 'last_year' }).bucket, p({}).timezone], ['day', 'week', 'month', 'Africa/Dar_es_Salaam']);
  assert.equal(p({ period: 'forever' }).error, 'invalid_period');
  assert.equal(p({ from: '2026-10-09', to: '2026-10-03' }).error, 'invalid_date_range');
  assert.equal(p({ from: '2026-10-09' }).error, 'invalid_date_range');
  assert.equal(p({ from: '2020-01-01', to: '2026-10-03' }).error, 'date_range_too_long');
  assert.deepEqual(bucketsBetween('2026-09-29', '2026-10-13', 'week'), ['2026-09-28', '2026-10-05', '2026-10-12']);
  assert.deepEqual(bucketsBetween('2025-11-20', '2026-01-05', 'month'), ['2025-11-01', '2025-12-01', '2026-01-01']);
  assert.deepEqual([changePct(12, 10), changePct(5, 0), ratePct(1, 3), ratePct(1, 0)], [20, null, 33.3, null]);
  assert.equal(toCsv([{ key: 'a', label: 'Name' }, { key: 'b', label: 'TZS' }], [{ a: 'Asha, "Ash"', b: 5000 }, { a: '=cmd()', b: -3 }, { a: null, b: 0 }]),
    'Name,TZS\r\n"Asha, ""Ash""",5000\r\n\'=cmd(),-3\r\n,0\r\n');
  // Who sees what.
  const roles = permission => Object.entries(ROLE_PERMISSIONS).filter(([, p2]) => p2.includes(permission)).map(([r]) => r).sort();
  assert.deepEqual(roles('analytics.read'), ['admin', 'analyst', 'finance', 'hr', 'manager', 'owner']);
  assert.deepEqual(roles('analytics.people'), ['admin', 'hr', 'manager', 'owner']);
});

// ── Golden scenarios ─────────────────────────────────────────────────────────

test('scenario 1 — a new organisation with people and a benefit but no usage shows zeros, not blanks or errors', async () => {
  const orgId = await sponsor();
  for (const g of ['Gold', 'Gold', 'Silver']) await enrol(orgId, g);
  await programme(orgId, [VISITS]);
  const d = await dash(orgId);
  assert.deepEqual([d.beneficiaries.total, d.beneficiaries.enrolled, d.beneficiaries.linkedToAccount, d.beneficiaries.groups], [3, 3, 3, ['Gold', 'Silver']]);
  assert.deepEqual([d.participation.activeBeneficiaries, d.participation.utilisationRatePct, d.participation.inactiveBeneficiaries, d.participation.changePct], [0, 0, 3, null]);
  assert.deepEqual([d.usage.uses, d.usage.sponsorTzs, d.usage.sponsoredVisits, d.usage.averagePerActiveBeneficiary], [0, 0, 0, null]);
  assert.deepEqual([d.spend.sponsorTotalTzs, d.spend.costPerActiveBeneficiaryTzs, d.spend.costPerSponsoredVisitTzs], [0, null, null]);
  assert.deepEqual([d.benefits.active, d.benefits.usedInPeriod, d.providers.used, d.providers.top], [1, 0, 0, []]);
  assert.deepEqual(d.trend.map(t => [t.bucket, t.uses, t.activeBeneficiaries]), [[TODAY, 0, 0]]);
  assert.deepEqual([d.billing.invoicedTzs, d.billing.outstandingTzs, d.freshness, d.currency], [0, 0, 'live', 'TZS']);
  const b = await analytics.benefitAnalytics({ access: await access(orgId), query: NOW });
  assert.deepEqual(b.items.map(x => [x.eligible, x.users, x.uses, x.reachPct, x.averageUsesPerUser, x.allowance]), [[3, 0, 0, 0, null, null]]);
});

test('scenarios 2, 4, 5, 6 — sponsored visits across providers, a benefit used up, and a reversal', async () => {
  const [g1, g2] = [await gym('Analytics Gym One'), await gym('Analytics Gym Two')];
  const orgId = await sponsor();
  const [asha, baraka, neema] = [await enrol(orgId, 'Gold', 'Asha'), await enrol(orgId, 'Gold', 'Baraka'), await enrol(orgId, 'Silver', 'Neema')];
  const { programId, benefitIds: [benefitId] } = await programme(orgId, [{ ...VISITS, usagePeriod: 'month', usageLimit: 2 }], { budgetTzs: 100000 });

  // Scenario 2: one verified visit.
  assert.equal((await visit(asha.userId, g1)).consumed, true);
  let d = await dash(orgId);
  assert.deepEqual([d.participation.activeBeneficiaries, d.participation.utilisationRatePct, d.usage.uses, d.usage.sponsorTzs, d.usage.beneficiaryTzs, d.usage.grossTzs], [1, 33.3, 1, 5000, 0, 5000]);
  assert.deepEqual([d.spend.sponsorTotalTzs, d.spend.costPerActiveBeneficiaryTzs, d.spend.costPerSponsoredVisitTzs, d.benefits.usedInPeriod], [5000, 5000, 5000, 1]);
  assert.deepEqual(d.providers.top.map(x => [x.name, x.visits]), [['Analytics Gym One', 1]]);

  // Scenario 4: usage spread over two providers and two people.
  await visit(asha.userId, g2);
  await visit(baraka.userId, g2);
  const prov = await analytics.providerAnalytics({ access: await as(orgId, await orgUser(orgId, 'analyst')), query: NOW });
  assert.deepEqual(prov.items.map(x => [x.name, x.visits, x.people, x.repeatPeople, x.serviceValueTzs, 'settlement' in x]), [['Analytics Gym Two', 2, 2, 0, 10000, false], ['Analytics Gym One', 1, 1, 0, 5000, false]]);
  assert.deepEqual([prov.totals.providers, prov.totals.visits], [2, 3]);

  // Scenario 5: Asha has used both visits; a third is refused and is not usage.
  const third = await visit(asha.userId, g1);
  assert.equal(third.consumed, false);
  d = await dash(orgId);
  assert.deepEqual([d.usage.uses, d.participation.activeBeneficiaries, d.participation.utilisationRatePct], [3, 2, 66.7]);
  let [b] = (await analytics.benefitAnalytics({ access: await access(orgId), query: NOW })).items;
  assert.deepEqual([b.eligible, b.users, b.uses, b.reachPct, b.averageUsesPerUser, b.sponsorTzs], [3, 2, 3, 66.7, 1.5, 15000]);
  assert.deepEqual([b.allowance.consumedUnits, b.allowance.availableUnits, b.allowance.usedPct, b.allowance.peopleAtLimit, b.allowance.peopleNearLimit], [3, 6, 50, 1, 0]);
  // Filters narrow every figure the same way.
  const gold = await dash(orgId, { ...NOW, group: 'Gold' });
  const silver = await dash(orgId, { ...NOW, group: 'Silver' });
  assert.deepEqual([gold.beneficiaries.enrolled, gold.usage.uses, gold.participation.activeBeneficiaries, gold.trend[0].uses], [2, 3, 2, 3]);
  assert.deepEqual([silver.beneficiaries.enrolled, silver.usage.uses, silver.participation.activeBeneficiaries, silver.providers.used], [1, 0, 0, 0]);
  const atOne = await dash(orgId, { ...NOW, providerId: g1 });
  assert.deepEqual([atOne.usage.uses, atOne.participation.activeBeneficiaries, atOne.providers.used], [1, 1, 1]);
  assert.equal((await dash(orgId, { ...NOW, programId: 'nope' })).error, 'program_not_found');

  // Scenario 6: a reversal leaves the final valid state, not an extra row.
  const row = await db('B2BBenefitConsumption').where({ organizationId: orgId, userId: baraka.userId, status: 'approved' }).first();
  const undone = await usage.reverse({ consumptionId: row.id, reason: 'Wrong member scanned', actorId: BILLER, mayVoidCheckin: false });
  assert.ok(!undone.error, JSON.stringify(undone));
  d = await dash(orgId);
  assert.deepEqual([d.usage.uses, d.usage.sponsorTzs, d.participation.activeBeneficiaries, d.providers.used], [2, 10000, 1, 2]);
  [b] = (await analytics.benefitAnalytics({ access: await access(orgId), query: NOW })).items;
  assert.deepEqual([b.users, b.uses, b.allowance.consumedUnits], [1, 2, 2]);
  // A hold that was never confirmed is not usage either.
  await visit(neema.userId, g1, TODAY, { hold: true });
  assert.equal((await dash(orgId)).usage.uses, 2);

  const [prog] = (await analytics.programAnalytics({ access: await access(orgId), query: NOW })).items;
  assert.deepEqual([prog.programId, prog.eligible, prog.activeBeneficiaries, prog.participationPct, prog.uses, prog.sponsorTotalTzs, prog.benefits], [programId, 3, 1, 33.3, 2, 10000, 1]);
  assert.deepEqual([prog.budget.budgetTzs, prog.budget.committedTzs, prog.budget.remainingTzs, prog.budget.usedPct], [100000, 15000, 85000, 15]);   // the hold counts against the budget, as the engine counts it
  assert.equal(benefitId, b.benefitId);
});

test('scenario 3 — a split pass: the sponsor\'s share, the member\'s share and the service value are kept apart', async () => {
  const orgId = await sponsor();
  await enrol(orgId, 'Ops');
  await enrol(orgId, 'Ops');
  const { programId } = await programme(orgId, [{ name: 'Pro pass', benefitType: 'sponsored_pass', passTier: 'pro', fundingType: 'sponsor_percentage', sponsorShareBps: 6000 }]);
  const prepared = await billing.preparePrepaid({ programId, period: PERIOD, actorId: BILLER });
  assert.ok(prepared.invoice, JSON.stringify(prepared));
  const sponsorShare = Math.round(PRO * 0.6);
  const month = { from: `${PERIOD}-01`, to: monthBounds(PERIOD).endDate };
  const d = await dash(orgId, month);
  assert.deepEqual([d.spend.passes, d.spend.passesStarted, d.spend.sponsorPassFeesTzs, d.spend.memberPassSharesTzs], [2, 0, sponsorShare * 2, (PRO - sponsorShare) * 2]);
  assert.deepEqual([d.spend.sponsorPerUseTzs, d.spend.sponsorTotalTzs, d.usage.uses, d.participation.activeBeneficiaries], [0, sponsorShare * 2, 0, 0]);   // paid for, not yet used
  const [b] = (await analytics.benefitAnalytics({ access: await access(orgId), query: month })).items;
  assert.deepEqual([b.benefitType, b.passes, b.sponsorTzs, b.memberTzs, b.users, b.allowance], ['sponsored_pass', 2, sponsorShare * 2, (PRO - sponsorShare) * 2, 0, null]);
});

test('scenarios 7, 8, 9 — invoice and payment figures come from the ledgers; the provider side stays separate and with FitFlex', async () => {
  const g = await gym('Analytics Billing Gym');
  const orgId = await sponsor();
  const m = await enrol(orgId, 'Ops');
  const { programId } = await programme(orgId, [VISITS]);
  const { startDate, endDate } = monthBounds(LAST);
  for (const day of [startDate, addDays(startDate, 1), endDate]) assert.equal((await visit(m.userId, g, day)).consumed, true);
  const range = { from: startDate, to: TODAY };

  // Scenario 7: usage → sponsor responsibility → invoice.
  const drafted = await billing.prepareUsage({ programId, period: LAST, actorId: BILLER });
  assert.ok(drafted.invoice, JSON.stringify(drafted));
  let f = await analytics.financeAnalytics({ access: await access(orgId), query: range });
  assert.deepEqual([f.billing.invoicedTzs, f.billing.outstandingTzs], [0, 0]);                                   // a draft is not invoiced
  const issued = await billing.issueInvoice({ invoiceId: drafted.invoice.id, vatRateBps: 0, actorId: BILLER });
  assert.equal(issued.invoice.status, 'issued');
  f = await analytics.financeAnalytics({ access: await access(orgId), query: range });
  const usageMonth = f.months.find(x => x.month === LAST);
  assert.deepEqual([usageMonth.sponsorPerUseTzs, usageMonth.serviceValueTzs, f.billing.invoicedTzs, f.billing.invoices, f.billing.outstandingTzs], [15000, 15000, 15000, 1, 15000]);
  assert.equal(f.months.reduce((t, x) => t + x.invoicedTzs, 0), issued.invoice.totalTzs);

  // Scenario 8: invoice → payment → balance.
  const paid = await finance.recordPayment({ organizationId: orgId, body: { amountTzs: 10000, method: 'bank_transfer', reference: uid('AN'), allocations: [{ invoiceId: issued.invoice.id, amountTzs: 10000 }] }, actorId: CASHIER });
  assert.ok(paid.payment, JSON.stringify(paid));
  f = await analytics.financeAnalytics({ access: await access(orgId), query: range });
  assert.deepEqual([f.billing.paidTzs, f.billing.payments, f.billing.outstandingTzs, f.months.reduce((t, x) => t + x.collectedTzs, 0)], [10000, 1, 5000, 10000]);
  const statement = await finance.statement({ organizationId: orgId });
  assert.equal(f.billing.outstandingTzs, statement.outstandingTzs);                                              // the same figure the statement shows
  const d = await dash(orgId, { from: startDate, to: endDate });
  assert.deepEqual([d.usage.uses, d.usage.sponsorTzs, d.participation.activeBeneficiaries, d.trend.reduce((t, x) => t + x.uses, 0)], [3, 15000, 1, 3]);

  // Scenario 9: FitFlex sees how far settlement of the same visits has got; the organisation does not.
  const staffView = await analytics.providerAnalytics({ access: await access(orgId), query: { from: startDate, to: endDate } });
  assert.deepEqual(staffView.items.map(x => [x.visits, x.settlement.perUseVisits, x.settlement.inLiveSettlement, x.settlement.notYetSettled]), [[3, 3, 0, 3]]);
  const theirs = await analytics.providerAnalytics({ access: await as(orgId, await orgUser(orgId, 'owner')), query: { from: startDate, to: endDate } });
  assert.deepEqual(theirs.items.map(x => [x.visits, 'settlement' in x]), [[3, false]]);
  // Billing is for the roles that see billing; HR gets the dashboard without it.
  const hr = await orgUser(orgId, 'hr');
  assert.equal('billing' in (await analytics.dashboard({ access: await as(orgId, hr), query: range })), false);
  assert.equal((await analytics.financeAnalytics({ access: await as(orgId, hr), query: range })).requiredPermission, 'billing.read');
});

// ── What an organisation sees of a person ────────────────────────────────────

test('people: each person with what they used and did; another sponsor\'s visits, and weight and height, never appear', async () => {
  const [g1, g2] = [await gym('Analytics People One'), await gym('Analytics People Two')];
  const orgId = await sponsor('A');
  const other = await sponsor('B');
  const asha = await enrol(orgId, 'Gold', 'Asha Mollel');
  const juma = await enrol(orgId, 'Silver', 'Juma Omari');
  await programme(orgId, [{ ...VISITS, providerRules: { scope: 'selected', gymIds: [g1] } }]);
  // Asha is also covered by another organisation, at another gym.
  const there = await b2bService.enrollBeneficiary({ access: await access(other), body: { userId: asha.userId, status: 'active' }, actorId: BILLER });
  const { benefitIds: [otherBenefit] } = await programme(other, [{ ...VISITS, providerRules: { scope: 'selected', gymIds: [g2] } }]);

  const checkin = async (userId, gymId, day) => {
    const id = uid('chk');
    await db('Checkin').insert({ id, memberId: userId, gymId, timestamp: new Date(`${day}T07:00:00.000Z`), method: 'qr', subscriptionType: 'ppv', gymTier: 'standard', visitConsumed: false, status: 'valid', businessDate: day });
    made.checkins.push(id);
    return id;
  };
  const d1 = addDays(TODAY, -1);
  const d2 = addDays(TODAY, -2);
  const range = { from: addDays(TODAY, -6), to: TODAY };
  const fundedHere = await checkin(asha.userId, g1, TODAY);
  const fundedThere = await checkin(asha.userId, g2, d1);
  const selfPaid = await checkin(asha.userId, g1, d2);
  const consumeAt = (sourceId, gymId, day) => usage.consume({ userId: asha.userId, sourceType: 'gym_checkin', sourceId, provider: { type: 'gym', id: gymId, tier: 'standard' }, grossTzs: 5000, at: new Date(`${day}T07:00:00.000Z`) });
  const here = await consumeAt(fundedHere, g1, TODAY);
  const elsewhere = await consumeAt(fundedThere, g2, d1);
  assert.deepEqual([here.consumption.organizationId, elsewhere.consumption.organizationId, elsewhere.consumption.benefitId], [orgId, other, otherBenefit]);
  for (const [day, extra] of [[TODAY, { type: 'running', source: 'manual', durationMinutes: 30, distanceKm: 5.2, steps: 6100 }], [d1, { type: 'walking', source: 'device', steps: 4000 }]]) {
    const id = uid('act');
    await db('Activity').insert({ id, userId: asha.userId, startedAt: new Date(`${day}T15:00:00.000Z`), calories: 320, notes: 'felt tired', hasRoute: true, ...extra });
    made.activities.push(id);
  }

  const owner = await orgUser(orgId, 'owner');
  const list = await analytics.people({ access: await as(orgId, owner), query: { ...range, sort: 'uses' } });
  assert.deepEqual(list.items.map(r => [r.name, r.group, r.active, r.sponsoredUses, r.sponsorTzs, r.gymCheckins, r.activities, r.workouts, r.steps, r.lastActiveDay]),
    [['Asha Mollel', 'Gold', true, 1, 5000, 3, 2, 1, 10100, TODAY], ['Juma Omari', 'Silver', false, 0, 0, 0, 0, 0, 0, null]]);
  assert.deepEqual((await analytics.people({ access: await as(orgId, owner), query: { ...range, activity: 'inactive' } })).items.map(r => r.name), ['Juma Omari']);
  assert.deepEqual((await analytics.people({ access: await as(orgId, owner), query: { ...range, search: 'asha', limit: 1 } })).total, 1);

  const p = await analytics.person({ access: await as(orgId, owner), beneficiaryId: asha.id, query: range });
  assert.deepEqual(p.sponsoredUsage.map(r => [r.day, r.provider, r.sponsorTzs, r.benefitName]), [[TODAY, 'Analytics People One', 5000, 'Gym visits']]);
  // The visit she paid for herself is shown; the one another sponsor funded is not, anywhere.
  assert.deepEqual(p.otherGymVisits.map(r => [r.day, r.gym]), [[d2, 'Analytics People One']]);
  assert.equal(JSON.stringify(p).includes('Analytics People Two'), false);
  assert.deepEqual(p.activities.map(a => [a.day, a.type, a.steps, a.distanceKm]), [[TODAY, 'running', 6100, 5.2], [d1, 'walking', 4000, null]]);
  for (const hidden of ['weight', 'height', 'calories', 'notes', 'felt tired', 'hasRoute', 'memberProfile']) assert.equal(JSON.stringify({ ...p, notShown: [] }).toLowerCase().includes(hidden.toLowerCase()), false, hidden);
  assert.deepEqual(p.notShown.slice(0, 2), ['weight', 'height']);
  assert.deepEqual([p.totals.uses, p.totals.sponsorTzs, p.totals.activities, p.totals.otherGymVisits], [1, 5000, 2, 1]);
  assert.equal(here.consumption.organizationId, orgId);

  // The other organisation sees its own visit and nothing of this one's.
  const theirs = await analytics.person({ access: await access(other), beneficiaryId: there.beneficiary.id, query: range });
  assert.deepEqual(theirs.sponsoredUsage.map(r => r.provider), ['Analytics People Two']);
  assert.deepEqual(theirs.otherGymVisits.map(r => r.day), [d2]);
  // A person is looked up inside the organisation only.
  assert.equal((await analytics.person({ access: await access(other), beneficiaryId: asha.id, query: range })).error, 'beneficiary_not_found');
  assert.equal(selfPaid.length > 0, true);

  // Totals without names for the roles that do not see people.
  for (const role of ['finance', 'analyst']) {
    const claims = await orgUser(orgId, role);
    assert.equal((await analytics.people({ access: await as(orgId, claims), query: range })).requiredPermission, 'analytics.people', role);
    assert.equal((await analytics.person({ access: await as(orgId, claims), beneficiaryId: asha.id, query: range })).requiredPermission, 'analytics.people', role);
    assert.equal((await analytics.dashboard({ access: await as(orgId, claims), query: range })).engagement.activities, 2, role);
  }
  const eng = (await dash(orgId, range)).engagement;
  assert.deepEqual([eng.peopleWithActivity, eng.activities, eng.workouts, eng.steps, eng.gymCheckins], [1, 2, 1, 10100, 3]);
});

// ── Exports, security, staff views ───────────────────────────────────────────

test('scenario 10 — isolation, roles, exports and the staff views', async () => {
  const g = await gym('Analytics Isolation Gym');
  const orgA = await sponsor('A');
  const orgB = await sponsor('B');
  const a1 = await enrol(orgA, 'Ops', 'Amina A');
  const b1 = await enrol(orgB, 'Ops', 'Bakari B');
  await programme(orgA, [VISITS]);
  await programme(orgB, [VISITS]);
  await visit(a1.userId, g);
  await visit(b1.userId, g);
  await visit(b1.userId, g, addDays(TODAY, -1));
  const ownerA = await orgUser(orgA, 'owner');
  const viewerA = await orgUser(orgA, 'viewer');
  const financeA = await orgUser(orgA, 'finance');

  const mine = await call(getB2BOrganizationDashboard, { claims: ownerA, params: { id: orgA }, query: { period: 'last_7_days' } });
  assert.deepEqual([mine.statusCode, mine.body.usage.uses, mine.body.beneficiaries.total, mine.body.organization.id], [200, 1, 1, orgA]);
  // Not another organisation's: by its id, or by naming its people, programmes or benefits under one's own.
  for (const route of [getB2BOrganizationDashboard, listB2BOrganizationPeopleAnalytics, getB2BOrganizationFinanceAnalytics, getB2BOrganizationBenefitAnalytics]) {
    assert.equal((await call(route, { claims: ownerA, params: { id: orgB } })).statusCode, 404, route.path);
  }
  assert.equal((await call(getB2BOrganizationPersonAnalytics, { claims: ownerA, params: { id: orgA, beneficiaryId: b1.id } })).body.error, 'beneficiary_not_found');
  const theirProgram = (await b2bPrograms.filterByColumnAsync('organizationId', orgB))[0];
  const theirBenefit = (await b2bBenefits.filterByColumnAsync('programId', theirProgram.id))[0];
  assert.equal((await call(getB2BOrganizationDashboard, { claims: ownerA, params: { id: orgA }, query: { programId: theirProgram.id } })).body.error, 'program_not_found');
  assert.equal((await call(getB2BOrganizationDashboard, { claims: ownerA, params: { id: orgA }, query: { benefitId: theirBenefit.id } })).body.error, 'benefit_not_found');
  // A viewer has no analytics; finance has totals and money but no people.
  assert.deepEqual((await call(getB2BOrganizationDashboard, { claims: viewerA, params: { id: orgA } })).body.requiredPermission, 'analytics.read');
  assert.equal((await call(listB2BOrganizationPeopleAnalytics, { claims: financeA, params: { id: orgA } })).body.requiredPermission, 'analytics.people');
  assert.equal((await call(getB2BOrganizationFinanceAnalytics, { claims: financeA, params: { id: orgA } })).statusCode, 200);
  assert.equal((await call(getB2BOrganizationDashboard, { claims: ownerA, params: { id: orgA }, query: { period: 'all_time' } })).body.error, 'invalid_period');

  // Exports: the organisation's own rows, permission per report, audited.
  const csv = await call(exportB2BOrganizationReport, { claims: ownerA, params: { id: orgA, report: 'usage' }, query: { period: 'last_7_days' } });
  assert.deepEqual([csv.statusCode, csv.body.rows, csv.body.csv.includes('Amina A'), csv.body.csv.includes('Bakari B')], [200, 1, true, false]);
  assert.match(csv.body.filename, /^fitflex-usage-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const peopleCsv = await call(exportB2BOrganizationReport, { claims: ownerA, params: { id: orgA, report: 'beneficiaries' }, query: { period: 'last_7_days' } });
  assert.deepEqual([peopleCsv.body.rows, /weight|height/i.test(peopleCsv.body.csv)], [1, false]);
  for (const report of ['benefits', 'programs', 'providers', 'invoices', 'payments', 'activity']) {
    assert.equal((await call(exportB2BOrganizationReport, { claims: ownerA, params: { id: orgA, report } })).statusCode, 200, report);
  }
  assert.equal((await call(exportB2BOrganizationReport, { claims: financeA, params: { id: orgA, report: 'usage' } })).body.requiredPermission, 'analytics.people');
  assert.equal((await call(exportB2BOrganizationReport, { claims: await orgUser(orgA, 'hr'), params: { id: orgA, report: 'invoices' } })).body.requiredPermission, 'billing.read');
  assert.equal((await call(exportB2BOrganizationReport, { claims: ownerA, params: { id: orgA, report: 'secrets' } })).statusCode, 404);
  assert.equal((await call(exportB2BOrganizationReport, { claims: ownerA, params: { id: orgB, report: 'usage' } })).statusCode, 404);
  const logged = await db('AuditLog').where({ action: 'b2b.analytics.export', actor: ownerA.sub, target: orgA });
  assert.equal(logged.length, 8);

  // Cross-organisation figures are for FitFlex staff.
  assert.equal((await call(adminB2BAnalyticsOverview, { claims: ownerA })).statusCode, 403);
  assert.equal((await call(adminB2BDataQuality, { claims: ownerA })).statusCode, 403);
  const staff = scopes => ({ sub: CASHIER, userType: 'admin', portalUser: true, aclPermissions: scopes });
  assert.equal((await call(adminB2BAnalyticsOverview, { claims: staff(['payments']) })).statusCode, 403);
  const all = await call(adminB2BAnalyticsOverview, { claims: staff(['b2b']), query: { period: 'last_7_days' } });
  assert.equal(all.statusCode, 200);
  const top = id => all.body.topOrganizations.find(o => o.organizationId === id);
  assert.deepEqual([top(orgA)?.uses, top(orgA)?.activeBeneficiaries, top(orgB)?.uses, top(orgB)?.activeBeneficiaries], [1, 1, 2, 1]);
  assert.ok(all.body.usage.uses >= 3 && all.body.organizations.active >= 2 && all.body.beneficiaries.active >= 2);
  const here = all.body.topProviders.find(x => x.providerId === g);
  assert.deepEqual([here.uses, here.people, here.organizations], [3, 2, 2]);
  // Staff open one organisation through the same routes.
  assert.equal((await call(getB2BOrganizationDashboard, { claims: staff(['b2b']), params: { id: orgB }, query: { period: 'last_7_days' } })).body.usage.uses, 2);
});

test('data quality: problems are reported with a count and examples, and nothing is changed', async () => {
  const g = await gym('Analytics Quality Gym');
  const orgId = await sponsor();
  const m = await enrol(orgId);
  await programme(orgId, [VISITS]);
  const old = addDays(TODAY, -5);
  const held = await visit(m.userId, g, old, { hold: true });
  assert.equal(held.consumption.status, 'pending');
  const ok = await visit(m.userId, g, TODAY);        // no check-in row behind it in this fixture

  const q = await analytics.dataQuality();
  const check = key => q.checks.find(c => c.key === key);
  assert.ok(check('stale_holds').count >= 1);
  assert.ok(check('gym_usage_without_checkin').count >= 1);
  assert.deepEqual([check('usage_shares_do_not_add_up').count, check('invoice_lines_do_not_add_up').count, check('payment_over_allocated').count], [0, 0, 0]);
  assert.ok(q.checks.every(c => ['low', 'medium', 'high'].includes(c.severity) && c.examples.length <= 5 && c.examples.length <= c.count));
  assert.equal(q.issues, q.checks.filter(c => c.count > 0).length);
  // Reported, not repaired.
  assert.deepEqual(await db('B2BBenefitConsumption').whereIn('id', [held.consumption.id, ok.consumption.id]).orderBy('consumedAt').pluck('status'), ['pending', 'approved']);
  await usage.cancel({ consumptionId: held.consumption.id, reason: 'test over' });
});

test('the visibility notice reaches each covered person once', async () => {
  const orgId = await sponsor();
  const m1 = await enrol(orgId);
  const m2 = await enrol(orgId);
  const sent = [];
  const svc = createB2BAnalyticsService({
    db, b2bService, finance, programs: b2bPrograms, benefits: b2bBenefits, gyms, trainers,
    notify: async (userId, message) => { sent.push({ userId, ...message }); await db('Notification').insert({ id: message.id, userId, type: message.type, title: message.title, body: message.body, data: JSON.stringify(message.data), createdAt: new Date() }); },
  });
  await svc.notifyVisibility({ limit: 100000 });
  const mine = () => sent.filter(s => [m1.userId, m2.userId].includes(s.userId));
  assert.deepEqual(mine().map(s => s.type), ['b2b_sponsor_visibility', 'b2b_sponsor_visibility']);
  assert.match(mine()[0].body, /can see your FitFlex activity.*cannot see your weight, height/);
  // A covered person who reads Swahili is told in Swahili.
  const sw = await deliveredTo(mine()[0], 'sw');
  assert.match(sw.title, /^Kile .+ inaweza kuona$/);
  assert.match(sw.body, /inaweza kuona shughuli zako za FitFlex: ziara za gym, mazoezi, hatua na maendeleo ya challenge\. Haiwezi kuona uzito wako, urefu wako/);
  const en = await deliveredTo(mine()[0], null);
  assert.deepEqual([en.title, en.body], [mine()[0].title, mine()[0].body]);
  assert.match(en.title, /^What .+ can see$/);
  const m3 = await enrol(orgId);
  await svc.notifyVisibility({ limit: 100000 });
  assert.deepEqual(mine().length, 2);
  assert.equal(sent.filter(s => s.userId === m3.userId).length, 1);
  await db('Notification').whereIn('userId', sent.map(s => s.userId)).where({ type: 'b2b_sponsor_visibility' }).del();
});
