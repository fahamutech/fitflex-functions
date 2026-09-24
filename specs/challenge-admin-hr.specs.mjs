// Admin and HR challenge management: eligibility, editing, close/archive,
// totals-only monitoring, reward funding and HR logins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChallengeService } from '../src/services/challenge-service.mjs';
import { createCorporateService } from '../src/services/corporate-service.mjs';
import { normalizeRequestedRole } from '../src/services/auth-service.mjs';
import { verifyPassword } from '../src/auth/password-credentials.mjs';

function store(rows = []) {
  const clone = (r) => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterAsync(pred) { return rows.filter(pred).map(clone); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
  };
}

// Thursday 24 Sep 2026, 09:00 EAT.
let NOW = new Date('2026-09-24T06:00:00.000Z');
const now = () => NOW;
const at = d => `${d}T05:00:00.000Z`;

const FITFLEX = { creatorType: 'fitflex', creatorId: null, createdBy: 'admin' };
const CORP = { creatorType: 'corporate', creatorId: 'corp_1', createdBy: 'hr_1' };
const OTHER_CORP = { creatorType: 'corporate', creatorId: 'corp_2', createdBy: 'hr_2' };
const base = { name: 'FitFlex 50K Steps', type: 'steps', target: 50000, startDate: '2026-09-20', endDate: '2026-09-30' };

function setup() {
  NOW = new Date('2026-09-24T06:00:00.000Z');
  const people = [
    // id, dept, tier, company
    ['m1', 'Finance', 'pro', 'corp_1'],
    ['m2', 'Finance', 'basic', 'corp_1'],
    ['m3', 'Finance', null, 'corp_1'],
    ['m4', 'Operations', 'pro', 'corp_1'],
    ['m5', null, 'premium', null],
    ['m6', 'Sales', null, 'corp_2'],
  ];
  const s = {
    challenges: store(),
    participants: store(),
    teams: store(),
    users: store(people.map(([id, , , corp]) => ({ id, userType: 'member', displayName: id.toUpperCase(), corporateId: corp }))),
    corporateEmployees: store(people.filter(p => p[3]).map(([id, dept, , corp], i) => ({ id: `e_${id}`, userId: id, corporateId: corp, department: dept, status: 'active' }))),
    subscriptions: store(people.filter(p => p[2]).map(([id, , tier]) => ({ id: `s_${id}`, memberId: id, tier, status: 'active', expiresAt: '2099-01-01T00:00:00Z' }))),
    trainers: store([]),
    gyms: store([]),
    relationships: store([]),
    gymMemberSharing: store([]),
    activities: store([
      { id: 'a1', userId: 'm1', type: 'walking', source: 'manual', startedAt: at('2026-09-21'), steps: 60000 },
      { id: 'a2', userId: 'm2', type: 'walking', source: 'manual', startedAt: at('2026-09-22'), steps: 20000 },
      { id: 'a3', userId: 'm3', type: 'walking', source: 'manual', startedAt: at('2026-09-22'), steps: 50000 },
      { id: 'a4', userId: 'm4', type: 'walking', source: 'manual', startedAt: at('2026-09-22'), steps: 10000 },
    ]),
    checkins: store([]),
  };
  s.svc = createChallengeService({ ...s, gymMemberIds: async () => new Map(), now });
  return s;
}

const visibleIds = async (s, m) => (await s.svc.memberChallenges(m)).challenges.map(c => c.id);

test('FitFlex eligibility: all members, or chosen pass tiers', async () => {
  const s = setup();
  const all = (await s.svc.create(FITFLEX, base)).challenge;
  assert.equal(all.eligibility, null);
  assert.equal(all.rewardFunding, 'fitflex', 'default funder');
  const tiered = (await s.svc.create(FITFLEX, { ...base, name: 'Pro+', eligibility: { kind: 'tiers', tiers: ['pro', 'premium'] } })).challenge;
  assert.deepEqual(tiered.eligibility, { kind: 'tiers', tiers: ['pro', 'premium'] });

  assert.deepEqual((await visibleIds(s, 'm1')).sort(), [all.id, tiered.id].sort(), 'pro');
  assert.deepEqual(await visibleIds(s, 'm2'), [all.id], 'basic sees only the open one');
  assert.equal((await s.svc.join('m2', tiered.id)).status, 404);
  assert.equal((await s.svc.join('m5', tiered.id)).challenge.joined, true, 'premium');

  assert.equal((await s.svc.create(FITFLEX, { ...base, eligibility: { kind: 'tiers', tiers: ['gold'] } })).error, 'invalid_eligibility');
  assert.equal((await s.svc.create(FITFLEX, { ...base, eligibility: { kind: 'departments', departments: ['Finance'] } })).error, 'invalid_eligibility');
});

test('company eligibility: all employees, departments or chosen people', async () => {
  const s = setup();
  const dept = (await s.svc.create(CORP, { ...base, name: 'Finance steps', eligibility: { kind: 'departments', departments: ['finance'] } })).challenge;
  assert.deepEqual(dept.eligibility, { kind: 'departments', departments: ['Finance'] }, "normalised to the company's spelling");
  assert.equal(dept.rewardFunding, 'company');
  assert.ok((await visibleIds(s, 'm1')).includes(dept.id));
  assert.ok(!(await visibleIds(s, 'm4')).includes(dept.id), 'Operations');
  assert.ok(!(await visibleIds(s, 'm6')).includes(dept.id), 'other company');

  const picked = (await s.svc.create(CORP, { ...base, name: 'Pilot', eligibility: { kind: 'employees', employeeIds: ['e_m4'] } })).challenge;
  assert.ok((await visibleIds(s, 'm4')).includes(picked.id));
  assert.ok(!(await visibleIds(s, 'm1')).includes(picked.id));

  for (const eligibility of [
    { kind: 'departments', departments: ['Marketing'] },
    { kind: 'employees', employeeIds: ['e_m6'] }, // another company's
    { kind: 'tiers', tiers: ['pro'] },
  ]) {
    assert.equal((await s.svc.create(CORP, { ...base, eligibility })).error, 'invalid_eligibility', JSON.stringify(eligibility));
  }
  assert.equal((await s.svc.create(CORP, { ...base, rewardFunding: 'trainer' })).error, 'invalid_reward_funding');
  assert.equal((await s.svc.create(CORP, { ...base, rewardFunding: 'partner' })).challenge.rewardFunding, 'partner');
});

test('editing: free before it starts, measure and start locked after', async () => {
  const s = setup();
  const soon = (await s.svc.create(FITFLEX, { ...base, startDate: '2026-10-01', endDate: '2026-10-30' })).challenge;
  const e = await s.svc.update(FITFLEX, soon.id, { name: 'FitFlex 50K Steps — October', target: 60000, type: 'distance_km', rewards: ['Finisher badge'] });
  assert.equal(e.error, 'invalid_target', 'distance target is capped per day');
  const ok = await s.svc.update(FITFLEX, soon.id, { name: 'FitFlex 50K Steps — October', target: 60000, rewards: ['Finisher badge'], eligibility: { kind: 'tiers', tiers: ['pro'] } });
  assert.equal(ok.challenge.name, 'FitFlex 50K Steps — October');
  assert.equal(ok.challenge.target, 60000);
  assert.deepEqual(ok.challenge.eligibility, { kind: 'tiers', tiers: ['pro'] });

  const running = (await s.svc.create(FITFLEX, base)).challenge;
  await s.svc.join('m1', running.id);
  assert.equal((await s.svc.update(FITFLEX, running.id, { type: 'workouts' })).error, 'measure_locked');
  assert.equal((await s.svc.update(FITFLEX, running.id, { startDate: '2026-09-22' })).error, 'start_locked');
  assert.equal((await s.svc.update(FITFLEX, running.id, { endDate: '2026-10-05' })).challenge.endDate, '2026-10-05', 'extend');
  assert.equal((await s.svc.update(CORP, running.id, { name: 'x' })).status, 404, 'not theirs');
  await s.svc.cancel(FITFLEX, running.id);
  assert.equal((await s.svc.update(FITFLEX, running.id, { name: 'x' })).error, 'not_editable');
});

test('close ends it now; archive only once it is over', async () => {
  const s = setup();
  const c = (await s.svc.create(FITFLEX, base)).challenge;
  await s.svc.join('m1', c.id);
  assert.equal((await s.svc.archive(FITFLEX, c.id)).error, 'still_running');
  const closed = (await s.svc.close(FITFLEX, c.id)).challenge;
  assert.equal(closed.endDate, '2026-09-24');
  // Over at once, not at midnight: no more joining, and it can't close twice.
  assert.equal(closed.phase, 'ended');
  assert.equal((await s.svc.join('m2', c.id)).error, 'challenge_closed');
  assert.equal((await s.svc.close(FITFLEX, c.id)).error, 'not_running');
  assert.equal((await s.svc.memberChallenges('m1')).challenges.find(x => x.id === c.id).phase, 'ended');
  assert.equal((await s.svc.archive(FITFLEX, c.id)).challenge.status, 'archived');
  assert.equal((await s.svc.archive(FITFLEX, c.id)).error, 'already_archived');
  // Hidden from discovery, kept in the history of those who took part.
  assert.ok(!(await visibleIds(s, 'm2')).includes(c.id));
  const mine = (await s.svc.memberChallenges('m1')).challenges.find(x => x.id === c.id);
  assert.equal(mine.phase, 'ended');
  const future = (await s.svc.create(FITFLEX, { ...base, startDate: '2026-10-01', endDate: '2026-10-30' })).challenge;
  assert.equal((await s.svc.close(FITFLEX, future.id)).error, 'not_started_cancel_instead');
});

test('admin monitoring: participation and completion, totals only', async () => {
  const s = setup();
  const c = (await s.svc.create(FITFLEX, base)).challenge;
  for (const m of ['m1', 'm2', 'm3']) await s.svc.join(m, c.id);
  const r = await s.svc.creatorParticipants(FITFLEX, c.id);
  assert.deepEqual(r.summary, {
    eligible: 6, joined: 3, participationRate: 0.5,
    completed: 2, completionRate: 0.667, averageProgress: 0.8,
  });
  assert.equal('participants' in r, false);
  assert.equal(JSON.stringify(r).includes('M1'), false, 'no names');

  const tiered = (await s.svc.create(FITFLEX, { ...base, eligibility: { kind: 'tiers', tiers: ['pro'] } })).challenge;
  assert.equal((await s.svc.creatorParticipants(FITFLEX, tiered.id)).summary.eligible, 2, 'm1 and m4 are on Pro');
});

test('HR sees aggregate progress by department; small groups folded', async () => {
  const s = setup();
  const c = (await s.svc.create(CORP, base)).challenge;
  for (const m of ['m1', 'm2', 'm3', 'm4']) await s.svc.join(m, c.id);
  const r = await s.svc.creatorParticipants(CORP, c.id);
  assert.deepEqual(r.summary, { eligible: 4, joined: 4, participationRate: 1, completed: 2, completionRate: 0.5, averageProgress: 0.65 });
  assert.deepEqual(r.byDepartment, [
    { department: 'Finance', other: false, eligible: 3, joined: 3, participationRate: 1, completed: 2, averageProgress: 0.8 },
    // Operations has one person: folded, and no progress shown for it.
    { department: null, other: true, eligible: 1, joined: 1, participationRate: 1 },
  ]);
  const json = JSON.stringify(r);
  for (const leak of ['m1', 'M1', 'e_m1', 'steps', '60000']) assert.equal(json.includes(leak), false, leak);
  assert.equal((await s.svc.creatorParticipants(OTHER_CORP, c.id)).status, 404, 'another company');
});

test('HR logins: created by admin, password hashed, can be suspended', async () => {
  const users = store([]);
  const corp = createCorporateService({
    users,
    checkins: store(), corporateAccounts: store([{ id: 'corp_1', companyName: 'NMB' }]),
    corporateEmployees: store(), corporateBills: store(), auditLog: store(), settingsService: {},
  });
  assert.equal((await corp.createHrUser({ corporateId: 'corp_9', body: {} })).status, 404);
  assert.equal((await corp.createHrUser({ corporateId: 'corp_1', body: { email: 'bad', displayName: 'N', password: 'x'.repeat(12) } })).error, 'invalid_email');
  assert.equal((await corp.createHrUser({ corporateId: 'corp_1', body: { email: 'hr@nmb.co.tz', displayName: 'Neema', password: 'short' } })).error, 'password_too_short');
  const { hrUser } = await corp.createHrUser({ corporateId: 'corp_1', body: { email: ' HR@nmb.co.tz ', displayName: 'Neema', password: 'a-long-initial-password' }, actorId: 'admin' });
  assert.equal(hrUser.email, 'hr@nmb.co.tz');
  assert.equal('passwordHash' in hrUser, false);
  const row = users.rows[0];
  assert.deepEqual([row.userType, row.corporateId], ['corporate_hr', 'corp_1']);
  assert.ok(await verifyPassword('a-long-initial-password', row.passwordHash));
  assert.equal((await corp.createHrUser({ corporateId: 'corp_1', body: { email: 'hr@nmb.co.tz', displayName: 'Again', password: 'a-long-initial-password' } })).error, 'email_in_use');
  assert.equal((await corp.listHrUsers({ corporateId: 'corp_1' })).hrUsers.length, 1);
  assert.equal((await corp.setHrUserStatus({ corporateId: 'corp_1', userId: row.id, status: 'suspended' })).hrUser.accountStatus, 'suspended');
  assert.equal((await corp.setHrUserStatus({ corporateId: 'corp_2', userId: row.id, status: 'active' })).status, 404);
  assert.equal(normalizeRequestedRole('corporate_hr'), 'corporate_hr');
});
