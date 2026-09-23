// Opt-in challenge leaderboards and team challenges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChallengeService, MIN_TEAM_SIZE } from '../src/services/challenge-service.mjs';

function store(rows = []) {
  const clone = (r) => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
  };
}

// Thursday 24 Sep 2026, 09:00 EAT.
const NOW = new Date('2026-09-24T06:00:00.000Z');
let tick = 0;
const now = () => new Date(+NOW + (tick++) * 1000); // distinct join times
const at = (day) => `${day}T05:00:00.000Z`;

const people = [
  ['m1', 'Aisha Mollel', 40000, 'corp_1', 'Finance'],
  ['m2', 'Baraka Juma', 25000, 'corp_1', 'Finance'],
  ['m3', 'Chausiku Ally', 50000, 'corp_1', 'Finance'],
  ['m4', 'Daudi', 10000, 'corp_1', 'Operations'],
  ['m5', 'Eliya Kweka', 30000, null, null],
];

function setup() {
  const s = {
    challenges: store(),
    participants: store(),
    teams: store(),
    users: store(people.map(([id, displayName, , corporateId]) => ({ id, displayName, corporateId }))),
    corporateEmployees: store(people.filter(p => p[3]).map(([id, , , corporateId, department], i) => ({ id: `e${i}`, userId: id, corporateId, department }))),
    trainers: store([]),
    gyms: store([{ id: 'g1', name: 'Mikocheni Fitness' }, { id: 'g2', name: 'Oyster Bay Gym' }]),
    relationships: store([]),
    gymMemberSharing: store([]),
    activities: store(people.map(([id, , steps]) => ({ id: `a_${id}`, userId: id, type: 'walking', source: 'device', startedAt: at('2026-09-22'), steps, heightCm: 180, weightKg: 90 }))),
    checkins: store([]),
    gymMap: {
      m1: new Map([['g1', ['member']]]),
      m2: new Map([['g1', ['member']]]),
      m3: new Map([['g1', ['member']], ['g2', ['visited']]]),
      m4: new Map([['g2', ['member']]]),
      m5: new Map([['g1', ['visited']], ['g2', ['visited']]]),
    },
  };
  s.svc = createChallengeService({ ...s, gymMemberIds: async m => s.gymMap[m] ?? new Map(), now });
  return s;
}

const FITFLEX = { creatorType: 'fitflex', creatorId: null, createdBy: 'admin' };
const CORP = { creatorType: 'corporate', creatorId: 'corp_1', createdBy: 'hr' };
const GYM = { creatorType: 'gym', creatorId: 'g1', createdBy: 'o1' };
const base = { name: '50K Step Challenge', type: 'steps', target: 50000, startDate: '2026-09-20', endDate: '2026-09-28' };

test('joining leaves you off the leaderboard unless you opt in', async () => {
  const s = setup();
  const { challenge } = await s.svc.create(FITFLEX, base);
  const joined = await s.svc.join('m1', challenge.id);
  assert.equal(joined.challenge.leaderboardOptIn, false);
  assert.equal(s.participants.rows[0].leaderboardOptIn, false);
  const lb = await s.svc.leaderboard({ memberId: 'm1' }, challenge.id);
  assert.deepEqual(lb.individuals, []);
  assert.deepEqual(lb.you, { optedIn: false, rank: 1, of: 1, progress: 40000, teamId: null });
});

test('ranking lists only people who opted in, by first name and initial', async () => {
  const s = setup();
  const { challenge: c } = await s.svc.create(FITFLEX, base);
  await s.svc.join('m1', c.id, { leaderboardOptIn: true });
  await s.svc.join('m2', c.id); // not opted in
  await s.svc.join('m3', c.id, { leaderboardOptIn: true });
  await s.svc.join('m4', c.id, { leaderboardOptIn: true });

  const lb = await s.svc.leaderboard({ memberId: 'm2' }, c.id);
  assert.deepEqual(lb.individuals.map(i => [i.rank, i.name, i.progress, i.completed]), [
    [1, 'Chausiku A.', 50000, true],
    [2, 'Aisha M.', 40000, false],
    [3, 'Daudi', 10000, false],
  ]);
  assert.equal(lb.participants, 4);
  // Baraka isn't listed, but sees where he'd place among those who are.
  assert.deepEqual(lb.you, { optedIn: false, rank: 3, of: 4, progress: 25000, teamId: null });
  const json = JSON.stringify(lb);
  for (const leak of ['Baraka', 'Juma', 'Mollel', 'm1', 'm3', 'weightKg', 'heightCm', '90']) {
    assert.equal(json.includes(leak), false, leak);
  }
});

test('opting in and out takes effect immediately', async () => {
  const s = setup();
  const { challenge: c } = await s.svc.create(FITFLEX, base);
  await s.svc.join('m1', c.id);
  assert.deepEqual(await s.svc.setLeaderboardOptIn('m1', c.id, { optIn: true }), { leaderboardOptIn: true });
  assert.equal((await s.svc.leaderboard({ memberId: 'm1' }, c.id)).individuals[0].you, true);
  await s.svc.setLeaderboardOptIn('m1', c.id, { optIn: false });
  assert.deepEqual((await s.svc.leaderboard({ memberId: 'm1' }, c.id)).individuals, []);
  assert.equal((await s.svc.setLeaderboardOptIn('m1', c.id, { optIn: 'yes' })).error, 'invalid_opt_in');
  assert.equal((await s.svc.setLeaderboardOptIn('m2', c.id, { optIn: true })).error, 'not_joined');
});

test('only participants and the creator can see a leaderboard', async () => {
  const s = setup();
  const { challenge: c } = await s.svc.create(FITFLEX, base);
  await s.svc.join('m1', c.id, { leaderboardOptIn: true });
  assert.equal((await s.svc.leaderboard({ memberId: 'm2' }, c.id)).status, 403);
  const creatorView = await s.svc.leaderboard(FITFLEX, c.id);
  assert.equal(creatorView.individuals.length, 1);
  assert.equal('you' in creatorView, false);
  assert.equal((await s.svc.leaderboard(GYM, c.id)).status, 404, 'not their challenge');
});

test('teams: creator-named teams; members must pick one', async () => {
  const s = setup();
  const bad = await s.svc.create(GYM, { ...base, mode: 'teams', teams: ['Red'] });
  assert.equal(bad.error, 'invalid_teams');
  assert.equal((await s.svc.create(GYM, { ...base, mode: 'teams', teams: ['Red', 'red'] })).error, 'invalid_teams');
  const { challenge: c } = await s.svc.create(GYM, { ...base, mode: 'teams', teams: ['Red', 'Blue'] });
  assert.deepEqual(c.teams.map(t => t.name), ['Blue', 'Red']);
  const red = c.teams.find(t => t.name === 'Red').id;
  const blue = c.teams.find(t => t.name === 'Blue').id;
  assert.equal((await s.svc.join('m1', c.id)).error, 'team_required');
  assert.equal((await s.svc.join('m1', c.id, { teamId: 'nope' })).error, 'invalid_team');
  for (const m of ['m1', 'm2', 'm3']) await s.svc.join(m, c.id, { teamId: red });
  await s.svc.join('m5', c.id, { teamId: blue });
  const lb = await s.svc.leaderboard({ memberId: 'm1' }, c.id);
  assert.equal(lb.you.teamId, red);
  // Red has 3 members: (40k + 25k + 50k capped at 1) / 3.
  assert.deepEqual(lb.teams, [{ rank: 1, teamId: red, name: 'Red', members: 3, averageCompletion: 0.767, total: 115000 }]);
  assert.equal(lb.hiddenTeams, 1, `Blue has fewer than ${MIN_TEAM_SIZE} members, so its numbers stay hidden`);
  assert.deepEqual(lb.individuals, [], 'team scores never list individuals');
});

test('gym vs gym: your team is your gym; FitFlex only', async () => {
  const s = setup();
  assert.equal((await s.svc.create(GYM, { ...base, mode: 'gym_vs_gym' })).error, 'mode_not_allowed');
  const { challenge: c } = await s.svc.create(FITFLEX, { ...base, mode: 'gym_vs_gym' });
  await s.svc.join('m1', c.id); // single home gym → g1
  await s.svc.join('m2', c.id);
  assert.equal((await s.svc.join('m5', c.id)).error, 'gym_required', 'no home gym and none chosen');
  assert.equal((await s.svc.join('m5', c.id, { gymId: 'g9' })).error, 'not_your_gym');
  await s.svc.join('m5', c.id, { gymId: 'g1' });
  await s.svc.join('m4', c.id);
  assert.deepEqual(s.teams.rows.map(t => [t.name, t.gymId]).sort(), [['Mikocheni Fitness', 'g1'], ['Oyster Bay Gym', 'g2']]);
  const lb = await s.svc.leaderboard(FITFLEX, c.id);
  assert.deepEqual(lb.teams.map(t => [t.name, t.members]), [['Mikocheni Fitness', 3]]);
  assert.equal(lb.hiddenTeams, 1);
});

test('corporate department teams come from the employee record', async () => {
  const s = setup();
  assert.equal((await s.svc.create(FITFLEX, { ...base, mode: 'department' })).error, 'mode_not_allowed');
  const { challenge: c } = await s.svc.create(CORP, { ...base, mode: 'department' });
  for (const m of ['m1', 'm2', 'm3', 'm4']) await s.svc.join(m, c.id);
  assert.equal((await s.svc.join('m5', c.id)).status, 404, 'not an employee');
  const lb = await s.svc.leaderboard(CORP, c.id);
  assert.deepEqual(lb.teams.map(t => [t.name, t.members]), [['Finance', 3]]);
  assert.equal(lb.hiddenTeams, 1, 'Operations has one member');
  const detail = await s.svc.memberChallenge('m4', c.id);
  assert.equal(detail.challenge.teams.find(t => t.id === detail.challenge.myTeamId).name, 'Operations');
});
