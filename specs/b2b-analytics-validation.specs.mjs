// Analytics validation: every screen is checked against figures worked out
// independently of the analytics service, on a mixed dataset (two groups of
// people, two gyms, visits over six weeks, reversals, holds, a second
// sponsor). Also: a company mirrored from Corporate with its HR login, the
// East Africa Time day boundary, and a sweep of every response for fields an
// organisation must never receive.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { purgeB2BBilling } from './fixtures/ledger-cleanup.mjs';
import {
  gyms, b2bService, b2bProgramService, b2bConsumptionService as usage, b2bAnalyticsService as analytics, corporateService, signJwt as sign,
} from '../src/bootstrap/services.mjs';
import { localDay, addDays } from '../src/shared/member-progress.mjs';
import { createB2BAnalyticsService } from '../src/services/b2b-analytics-service.mjs';
import { b2bPrograms, b2bBenefits, trainers } from '../src/bootstrap/collections.mjs';
import { b2bFinanceService } from '../src/bootstrap/services.mjs';
import { getB2BOrganizationDashboard, listB2BOrganizationPeopleAnalytics, getB2BOrganizationPersonAnalytics, exportB2BOrganizationReport } from '../functions/b2b.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], gyms: [], checkins: [], activities: [], corporates: [] };
const TODAY = localDay(new Date());
// A fixed sequence, so a failure can be reproduced.
let seed = 20261007;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };   // the high bits; the low ones repeat

async function user(userType = 'member', name = null) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: name ?? `Validation ${id.slice(-4)}`, email: `${id}@validation.test`, phone: `+2557${String(rnd(100000000)).padStart(8, '0')}`, updatedAt: new Date(), memberProfile: JSON.stringify({ weightKg: 80, heightCm: 175 }) });
  made.users.push(id);
  return id;
}
const BILLER = await user('admin');
const ADMIN = { userType: 'admin', userId: BILLER };
const access = (organizationId, who = ADMIN) => b2bService.resolveAccess({ organizationId, ...who });
async function sponsor(name) {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Validation ${name} ${uid('o')}` }, actorId: BILLER });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: BILLER });
  return organization.id;
}
async function programme(orgId, benefit) {
  const a = await access(orgId);
  const { program } = await b2bProgramService.createProgram({ access: a, body: { name: 'Validation programme', startDate: '2026-01-01' }, actorId: BILLER });
  const created = await b2bProgramService.createBenefit({ access: a, programId: program.id, body: benefit, actorId: BILLER });
  assert.ok(created.benefit, JSON.stringify(created));
  await b2bProgramService.setBenefitStatus({ access: a, programId: program.id, benefitId: created.benefit.id, status: 'active', actorId: BILLER });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'pending', actorId: BILLER });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'active', actorId: BILLER });
  return { programId: program.id, benefitId: created.benefit.id };
}
async function gym(name, rate) {
  const id = uid('gym');
  await gyms.insertAsync({ id, name, tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: rate });
  made.gyms.push(id);
  return id;
}
async function checkin(userId, gymId, at) {
  const id = uid('chk');
  await db('Checkin').insert({ id, memberId: userId, gymId, timestamp: at, method: 'qr', subscriptionType: 'ppv', gymTier: 'standard', visitConsumed: false, status: 'valid', businessDate: localDay(at) });
  made.checkins.push(id);
  return id;
}
const VISITS = { name: 'Gym visits', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'unlimited' };
const sum = (rows, key) => rows.reduce((t, r) => t + (Number(typeof key === 'function' ? key(r) : r[key]) || 0), 0);

function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(route, { claims, params = {}, query = {} }) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body: {}, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
/** A CSV body as rows of cells (the reports here have no quoted commas). */
const csvRows = csv => csv.trim().split('\r\n').slice(1).map(l => l.split(','));

after(async () => {
  if (made.activities.length) await db('Activity').whereIn('id', made.activities).del();
  if (made.checkins.length) await db('Checkin').whereIn('id', made.checkins).del();
  const orgIds = [...made.orgs, ...(made.corporates.length ? await db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).pluck('id') : [])];
  await purgeB2BBilling(db, orgIds);
  await db('Notification').whereIn('userId', made.users).del().catch(() => {});
  if (orgIds.length) {
    await db('B2BOrganizationUser').whereIn('organizationId', orgIds).del().catch(() => {});
    await db('B2BOrganization').whereIn('id', orgIds).del();
  }
  if (made.corporates.length) {
    await db('CorporateBill').whereIn('corporateId', made.corporates).del();
    await db('CorporateEmployee').whereIn('corporateId', made.corporates).del();
    await db('User').whereIn('corporateId', made.corporates).del();
    await db('CorporateAccount').whereIn('id', made.corporates).del();
  }
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('User').whereIn('id', made.users).del();
});

test('every screen agrees with figures worked out independently, and with every other screen', async () => {
  const gymA = await gym('Validation Gym A', 5000);
  const gymB = await gym('Validation Gym B', 7000);
  const price = { [gymA]: 5000, [gymB]: 7000 };
  const orgId = await sponsor('main');
  const other = await sponsor('other');
  const { benefitId } = await programme(orgId, VISITS);
  await programme(other, VISITS);
  const people = [];
  for (let i = 0; i < 12; i += 1) {
    const userId = await user('member', `Person ${String(i).padStart(2, '0')}`);
    const r = await b2bService.enrollBeneficiary({ access: await access(orgId), body: { userId, status: 'active', groupName: i % 3 === 0 ? 'North' : 'South' }, actorId: BILLER });
    people.push({ userId, id: r.beneficiary.id, group: i % 3 === 0 ? 'North' : 'South' });
  }
  // Someone else's organisation uses the same gyms on the same days.
  const stranger = await user('member', 'Stranger');
  await b2bService.enrollBeneficiary({ access: await access(other), body: { userId: stranger, status: 'active' }, actorId: BILLER });

  // The expected figures are kept by hand as the data is written.
  const kept = [];              // { person, gym, day, tzs } for each visit that should count
  for (let n = 0; n < 90; n += 1) {
    const person = people[rnd(10)];                    // two people never visit
    const gymId = rnd(3) === 0 ? gymB : gymA;
    const day = addDays(TODAY, -rnd(40));
    const fate = rnd(10);                              // 0 = reversed, 1 = left on hold, else counts
    const out = await usage.consume({ userId: person.userId, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: gymId, tier: 'standard' }, grossTzs: price[gymId], at: new Date(`${day}T08:00:00.000Z`), hold: fate === 1 });
    assert.ok(out.consumption, JSON.stringify(out));
    if (fate === 0) await usage.reverse({ consumptionId: out.consumption.id, reason: 'validation', actorId: BILLER, mayVoidCheckin: false });
    if (fate > 1) kept.push({ person, gym: gymId, day, tzs: price[gymId] });
  }
  for (let n = 0; n < 6; n += 1) await usage.consume({ userId: stranger, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: gymA, tier: 'standard' }, grossTzs: 5000, at: new Date(`${addDays(TODAY, -n)}T08:00:00.000Z`) });

  const range = { from: addDays(TODAY, -39), to: TODAY };
  const a = await access(orgId);
  const [d, list, prov, ben, prog] = await Promise.all([
    analytics.dashboard({ access: a, query: range }),
    analytics.people({ access: a, query: { ...range, limit: 200 } }),
    analytics.providerAnalytics({ access: a, query: range }),
    analytics.benefitAnalytics({ access: a, query: range }),
    analytics.programAnalytics({ access: a, query: range }),
  ]);
  const expected = { uses: kept.length, tzs: sum(kept, 'tzs'), active: new Set(kept.map(k => k.person.id)).size };
  assert.ok(expected.uses > 50 && expected.active >= 8, `the dataset is big enough to mean something: ${JSON.stringify(expected)}`);

  // 1. Against the hand-kept figures.
  assert.deepEqual([d.usage.uses, d.usage.sponsorTzs, d.usage.grossTzs, d.usage.beneficiaryTzs, d.participation.activeBeneficiaries], [expected.uses, expected.tzs, expected.tzs, 0, expected.active]);
  assert.deepEqual([d.beneficiaries.total, d.beneficiaries.enrolled, d.participation.inactiveBeneficiaries], [12, 12, 12 - expected.active]);
  assert.equal(d.participation.utilisationRatePct, Math.round((expected.active / 12) * 1000) / 10);
  assert.equal(d.spend.costPerSponsoredVisitTzs, Math.round(expected.tzs / expected.uses));
  assert.equal(d.spend.costPerActiveBeneficiaryTzs, Math.round(expected.tzs / expected.active));

  // 2. Against the ledger read directly.
  const [raw] = await db('B2BBenefitConsumption').where({ organizationId: orgId, status: 'approved' }).where('businessDate', '>=', range.from).where('businessDate', '<=', range.to)
    .select(db.raw('COALESCE(SUM("quantity"), 0) AS uses, COALESCE(SUM("sponsorTzs"), 0) AS tzs, COUNT(DISTINCT "beneficiaryId") AS people'));
  assert.deepEqual([Number(raw.uses), Number(raw.tzs), Number(raw.people)], [expected.uses, expected.tzs, expected.active]);

  // 3. Every other screen adds up to the same totals.
  assert.deepEqual([sum(list.items, 'sponsoredUses'), sum(list.items, 'sponsorTzs'), list.items.filter(r => r.active).length, list.total], [expected.uses, expected.tzs, expected.active, 12]);
  assert.deepEqual([sum(prov.items, 'uses'), sum(prov.items, 'sponsorTzs'), prov.totals.visits, prov.totals.serviceValueTzs], [expected.uses, expected.tzs, expected.uses, expected.tzs]);
  assert.deepEqual(ben.items.map(b => [b.benefitId, b.uses, b.sponsorTzs, b.users, b.eligible]), [[benefitId, expected.uses, expected.tzs, expected.active, 12]]);
  assert.deepEqual(prog.items.map(p => [p.uses, p.sponsorTotalTzs, p.activeBeneficiaries, p.eligible]), [[expected.uses, expected.tzs, expected.active, 12]]);
  assert.deepEqual([sum(d.trend, 'uses'), sum(d.trend, 'sponsorTzs')], [expected.uses, expected.tzs]);
  assert.deepEqual([d.providers.used, sum(d.providers.top, 'visits')], [prov.items.length, expected.uses]);

  // 4. Per gym and per person, against the hand-kept figures.
  for (const gymId of [gymA, gymB]) {
    const mine = kept.filter(k => k.gym === gymId);
    const row = prov.items.find(r => r.providerId === gymId);
    const perPerson = new Map();
    for (const k of mine) perPerson.set(k.person.id, (perPerson.get(k.person.id) ?? 0) + 1);
    assert.deepEqual([row.uses, row.sponsorTzs, row.people, row.repeatPeople], [mine.length, sum(mine, 'tzs'), perPerson.size, [...perPerson.values()].filter(c => c >= 2).length], gymId);
  }
  for (const person of people) {
    const mine = kept.filter(k => k.person.id === person.id);
    const row = list.items.find(r => r.beneficiaryId === person.id);
    assert.deepEqual([row.sponsoredUses, row.sponsorTzs, row.active, row.lastActiveDay], [mine.length, sum(mine, 'tzs'), mine.length > 0, mine.map(k => k.day).sort().pop() ?? null], person.id);
  }
  const busiest = list.items.slice().sort((x, y) => y.sponsoredUses - x.sponsoredUses)[0];
  const detail = await analytics.person({ access: a, beneficiaryId: busiest.beneficiaryId, query: range });
  assert.deepEqual([detail.sponsoredUsage.length, sum(detail.sponsoredUsage, 'sponsorTzs'), detail.totals.uses], [busiest.sponsoredUses, busiest.sponsorTzs, busiest.sponsoredUses]);

  // 5. Filters and periods partition the total: nothing counted twice, nothing dropped.
  const north = await analytics.dashboard({ access: a, query: { ...range, group: 'North' } });
  const south = await analytics.dashboard({ access: a, query: { ...range, group: 'South' } });
  assert.deepEqual([north.usage.uses + south.usage.uses, north.usage.sponsorTzs + south.usage.sponsorTzs, north.participation.activeBeneficiaries + south.participation.activeBeneficiaries, north.beneficiaries.total + south.beneficiaries.total],
    [expected.uses, expected.tzs, expected.active, 12]);
  assert.equal(north.usage.uses, kept.filter(k => k.person.group === 'North').length);
  const atA = await analytics.dashboard({ access: a, query: { ...range, providerId: gymA } });
  const atB = await analytics.dashboard({ access: a, query: { ...range, providerId: gymB } });
  assert.deepEqual([atA.usage.uses + atB.usage.uses, atA.usage.sponsorTzs + atB.usage.sponsorTzs], [expected.uses, expected.tzs]);
  const mid = addDays(TODAY, -20);
  const first = await analytics.dashboard({ access: a, query: { from: range.from, to: mid } });
  const second = await analytics.dashboard({ access: a, query: { from: addDays(mid, 1), to: range.to } });
  assert.deepEqual([first.usage.uses + second.usage.uses, first.usage.sponsorTzs + second.usage.sponsorTzs], [expected.uses, expected.tzs]);
  assert.equal(first.usage.uses, kept.filter(k => k.day <= mid).length);
  // The comparison period of the second half is the first half, day for day.
  assert.deepEqual([second.period.previous.to, second.usage.previous.uses], [mid, kept.filter(k => k.day <= mid && k.day >= second.period.previous.from).length]);

  // 6. The exports carry the same rows.
  const usageCsv = await analytics.exportCsv({ access: a, report: 'usage', query: range, actorId: BILLER });
  const rows = csvRows(usageCsv.csv);
  assert.deepEqual([usageCsv.rows, rows.length, sum(rows, r => r[8])], [expected.uses, expected.uses, expected.tzs]);
  const peopleCsv = csvRows((await analytics.exportCsv({ access: a, report: 'beneficiaries', query: range, actorId: BILLER })).csv);
  assert.deepEqual([peopleCsv.length, sum(peopleCsv, r => r[7]), peopleCsv.filter(r => r[6] === 'yes').length], [12, expected.uses, expected.active]);
  const provCsv = csvRows((await analytics.exportCsv({ access: a, report: 'providers', query: range, actorId: BILLER })).csv);
  assert.equal(sum(provCsv, r => r[3]), expected.uses);

  // A report too big to give whole is refused, never cut short.
  const small = createB2BAnalyticsService({ db, b2bService, finance: b2bFinanceService, programs: b2bPrograms, benefits: b2bBenefits, gyms, trainers, maxExportRows: expected.uses - 1 });
  const refused = await small.exportCsv({ access: a, report: 'usage', query: range, actorId: BILLER });
  assert.deepEqual([refused.error, refused.status, refused.maxRows, 'csv' in refused], ['report_too_large', 422, expected.uses - 1, false]);
  assert.equal((await small.exportCsv({ access: a, report: 'usage', query: { from: addDays(mid, 1), to: range.to }, actorId: BILLER })).rows, second.usage.uses);

  // 7. The other organisation's six visits are in none of it, and it sees none of this.
  const theirs = await analytics.dashboard({ access: await access(other), query: range });
  assert.deepEqual([theirs.usage.uses, theirs.participation.activeBeneficiaries, theirs.beneficiaries.total], [6, 1, 1]);
  const all = await analytics.overview({ query: range });
  const top = id => all.topOrganizations.find(o => o.organizationId === id);
  assert.deepEqual([top(orgId).uses, top(orgId).activeBeneficiaries, top(other).uses], [expected.uses, expected.active, 6]);
});

test('a company set up under Companies: employees are its people, departments its groups, and its HR login sees them', async () => {
  const g = await gym('Validation Company Gym', 5000);
  const { account } = await corporateService.onboard({ body: { companyName: `Validation Co ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'copay_70_30', passTier: 'pro', seatLimit: 10 }, actorId: BILLER });
  made.corporates.push(account.id);
  await corporateService.setStatus({ corporateId: account.id, status: 'active', actorId: BILLER });
  const staff = [];
  for (const [name, department] of [['Company Asha', 'Finance'], ['Company Juma', 'Finance'], ['Company Neema', 'Sales']]) {
    const { employee } = await corporateService.provisionStaff({ corporateId: account.id, body: { displayName: name, department }, actorId: BILLER });
    await corporateService.setEmployeeStatus({ corporateId: account.id, employeeId: employee.id, status: 'active', actorId: BILLER });
    staff.push({ id: employee.id, name, department });
  }
  // Two of the three have joined FitFlex.
  for (const s of staff.slice(0, 2)) {
    s.userId = await user('member', s.name);
    const linked = await corporateService.linkEmployeeUser({ corporateId: account.id, employeeId: s.id, userId: s.userId, actorId: BILLER });
    assert.ok(!linked.error, JSON.stringify(linked));
  }
  const orgId = (await b2bService.organizationForCorporate({ corporateId: account.id })).organization.id;
  await programme(orgId, VISITS);
  for (const day of [TODAY, addDays(TODAY, -1)]) {
    const out = await usage.consume({ userId: staff[0].userId, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: g, tier: 'standard' }, grossTzs: 5000, at: new Date(`${day}T08:00:00.000Z`) });
    assert.equal(out.consumed, true, JSON.stringify(out));
  }
  const range = { from: addDays(TODAY, -6), to: TODAY };

  const hr = (await corporateService.createHrUser({ corporateId: account.id, body: { displayName: 'Validation HR', email: `${uid('hr')}@validation.test`, password: 'validation-password-1' }, actorId: BILLER })).hrUser;
  const claims = { sub: hr.id, userType: 'corporate_hr', corporateId: account.id };
  const d = await call(getB2BOrganizationDashboard, { claims, params: { id: orgId }, query: range });
  assert.equal(d.statusCode, 200, JSON.stringify(d.body));
  assert.deepEqual([d.body.beneficiaries.total, d.body.beneficiaries.enrolled, d.body.beneficiaries.linkedToAccount, d.body.beneficiaries.groups], [3, 3, 2, ['Finance', 'Sales']]);
  assert.deepEqual([d.body.participation.activeBeneficiaries, d.body.participation.utilisationRatePct, d.body.usage.uses, d.body.usage.sponsorTzs], [1, 33.3, 2, 10000]);
  assert.equal('billing' in d.body, false);                                    // HR does not see billing
  const finance = await call(getB2BOrganizationDashboard, { claims, params: { id: orgId }, query: { ...range, group: 'Finance' } });
  assert.deepEqual([finance.body.beneficiaries.total, finance.body.usage.uses], [2, 2]);

  const list = await call(listB2BOrganizationPeopleAnalytics, { claims, params: { id: orgId }, query: { ...range, sort: 'uses' } });
  assert.deepEqual(list.body.items[0].name, 'Company Asha');                   // most visits first
  assert.deepEqual(list.body.items.map(r => [r.name, r.group, r.linkedToAccount, r.active, r.sponsoredUses]).sort((x, y) => x[0].localeCompare(y[0])),
    [['Company Asha', 'Finance', true, true, 2], ['Company Juma', 'Finance', true, false, 0], ['Company Neema', 'Sales', false, false, 0]]);
  const one = await call(getB2BOrganizationPersonAnalytics, { claims, params: { id: orgId, beneficiaryId: staff[0].id }, query: range });
  assert.deepEqual([one.statusCode, one.body.sponsoredUsage.length, one.body.beneficiary.group], [200, 2, 'Finance']);
  const unlinked = await call(getB2BOrganizationPersonAnalytics, { claims, params: { id: orgId, beneficiaryId: staff[2].id }, query: range });
  assert.deepEqual([unlinked.statusCode, unlinked.body.beneficiary.linkedToAccount, unlinked.body.activities, unlinked.body.sponsoredUsage], [200, false, [], []]);
  assert.equal((await call(exportB2BOrganizationReport, { claims, params: { id: orgId, report: 'beneficiaries' }, query: range })).body.rows, 3);

  // Another company's HR login gets nothing of this one.
  const { account: rival } = await corporateService.onboard({ body: { companyName: `Validation Rival ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'copay_70_30', passTier: 'pro', seatLimit: 10 }, actorId: BILLER });
  made.corporates.push(rival.id);
  await corporateService.setStatus({ corporateId: rival.id, status: 'active', actorId: BILLER });
  const rivalHr = (await corporateService.createHrUser({ corporateId: rival.id, body: { displayName: 'Rival HR', email: `${uid('hr')}@validation.test`, password: 'validation-password-2' }, actorId: BILLER })).hrUser;
  for (const route of [getB2BOrganizationDashboard, listB2BOrganizationPeopleAnalytics]) {
    assert.equal((await call(route, { claims: { sub: rivalHr.id, userType: 'corporate_hr', corporateId: rival.id }, params: { id: orgId }, query: range })).statusCode, 404, route.path);
  }
});

test('a day is an East Africa Time day: 23:30 and 00:30 land on different days everywhere', async () => {
  const g = await gym('Validation Midnight Gym', 5000);
  const orgId = await sponsor('midnight');
  const userId = await user('member', 'Night Owl');
  const { beneficiary } = await b2bService.enrollBeneficiary({ access: await access(orgId), body: { userId, status: 'active' }, actorId: BILLER });
  await programme(orgId, VISITS);
  const day = addDays(TODAY, -3);
  const next = addDays(day, 1);
  const late = new Date(`${day}T20:30:00.000Z`);       // 23:30 EAT on `day`
  const early = new Date(`${day}T21:30:00.000Z`);      // 00:30 EAT on the next day
  for (const at of [late, early]) {
    const id = await checkin(userId, g, at);
    const out = await usage.consume({ userId, sourceType: 'gym_checkin', sourceId: id, provider: { type: 'gym', id: g, tier: 'standard' }, grossTzs: 5000, at });
    assert.equal(out.consumed, true, JSON.stringify(out));
    const act = uid('act');
    await db('Activity').insert({ id: act, userId, type: 'running', source: 'manual', startedAt: at, durationMinutes: 20, steps: 1000 });
    made.activities.push(act);
  }
  const a = await access(orgId);
  const on = async d => analytics.dashboard({ access: a, query: { from: d, to: d } });
  const [first, second] = [await on(day), await on(next)];
  assert.deepEqual([first.usage.uses, first.engagement.activities, first.engagement.gymCheckins, first.engagement.steps], [1, 1, 1, 1000]);
  assert.deepEqual([second.usage.uses, second.engagement.activities, second.engagement.gymCheckins, second.engagement.steps], [1, 1, 1, 1000]);
  const both = await analytics.dashboard({ access: a, query: { from: day, to: next } });
  assert.deepEqual(both.trend.map(t => [t.bucket, t.uses, t.activities, t.activeBeneficiaries]), [[day, 1, 1, 1], [next, 1, 1, 1]]);
  const p = await analytics.person({ access: a, beneficiaryId: beneficiary.id, query: { from: day, to: day } });
  assert.deepEqual([p.sponsoredUsage.map(r => r.day), p.activities.map(r => r.day), p.otherGymVisits], [[day], [day], []]);
  const row = (await analytics.people({ access: a, query: { from: next, to: next } })).items[0];
  assert.deepEqual([row.sponsoredUses, row.activities, row.gymCheckins, row.lastActiveDay], [1, 1, 1, next]);
});

test('no analytics response carries a field an organisation must never receive', async () => {
  const g = await gym('Validation Privacy Gym', 5000);
  const orgId = await sponsor('privacy');
  const userId = await user('member', 'Private Person');
  const { beneficiary } = await b2bService.enrollBeneficiary({ access: await access(orgId), body: { userId, status: 'active', groupName: 'Ops' }, actorId: BILLER });
  await programme(orgId, VISITS);
  const id = await checkin(userId, g, new Date());
  await usage.consume({ userId, sourceType: 'gym_checkin', sourceId: id, provider: { type: 'gym', id: g, tier: 'standard' }, grossTzs: 5000 });
  const act = uid('act');
  await db('Activity').insert({ id: act, userId, type: 'running', source: 'manual', startedAt: new Date(), durationMinutes: 20, calories: 411, notes: 'secret-note', hasRoute: true, splits: JSON.stringify([{ km: 1 }]), elevationGainM: 12 });
  made.activities.push(act);
  const me = await db('User').where({ id: userId }).first();

  const owner = await user('member', 'Owner');
  await b2bService.addOrganizationUser({ access: await access(orgId), body: { userId: owner, role: 'owner' }, actorId: BILLER });
  const a = await access(orgId, { userType: 'member', userId: owner });
  const q = { period: 'last_7_days' };
  const responses = {
    dashboard: await analytics.dashboard({ access: a, query: q }), people: await analytics.people({ access: a, query: q }),
    person: await analytics.person({ access: a, beneficiaryId: beneficiary.id, query: q }), programs: await analytics.programAnalytics({ access: a, query: q }),
    benefits: await analytics.benefitAnalytics({ access: a, query: q }), providers: await analytics.providerAnalytics({ access: a, query: q }), finance: await analytics.financeAnalytics({ access: a, query: q }),
  };
  for (const report of ['beneficiaries', 'usage', 'activity', 'benefits', 'programs', 'providers', 'invoices', 'payments']) responses[`csv:${report}`] = await analytics.exportCsv({ access: a, report, query: q, actorId: owner });

  const forbiddenKeys = /weight|height|calorie|^notes$|route|split|elevation|email|phone|^pin|pinhash|password|memberprofile|devicename|externalid|settlement|payout/i;
  const walk = (value, path, hits) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, hits));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (forbiddenKeys.test(k)) hits.push(`${path}.${k}`); walk(v, `${path}.${k}`, hits); }
  };
  for (const [name, body] of Object.entries(responses)) {
    assert.ok(!body.error, `${name}: ${JSON.stringify(body).slice(0, 200)}`);
    const hits = [];
    walk(name === 'person' ? { ...body, notShown: undefined } : body, name, hits);
    assert.deepEqual(hits, [], name);
    // And none of the values themselves, whatever key they sit under.
    const text = JSON.stringify(name === 'person' ? { ...body, notShown: [] } : body);
    for (const secret of ['secret-note', '411', me.email, me.phone, '"weightKg"', '175']) assert.equal(text.includes(secret), false, `${name} contains ${secret}`);
  }
  assert.equal(responses.person.activities.length, 1);
  assert.equal(responses['csv:activity'].rows, 1);
});
