// Challenge engine — creation, audiences, joining, progress and privacy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChallengeService, challengePhase } from '../src/services/challenge-service.mjs';
import { challengeProgress } from '../src/shared/member-progress.mjs';

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
const now = () => NOW;
const at = (day, hour = 8) => `${day}T${String(hour - 3).padStart(2, '0')}:00:00.000Z`;

function setup() {
  const s = {
    challenges: store(),
    participants: store(),
    users: store([
      { id: 'm1', displayName: 'Amina', corporateId: 'corp_1' },
      { id: 'm2', displayName: 'Baraka' },
      { id: 'm3', displayName: 'Chausiku' },
    ]),
    trainers: store([{ id: 'trn_1', userId: 'usr_t1', displayName: 'Coach Sarah' }]),
    gyms: store([{ id: 'g1', name: 'Mikocheni Fitness' }]),
    relationships: store([
      { id: 'r1', trainerId: 'trn_1', memberId: 'm1', status: 'active', permissions: { challenges: true } },
      { id: 'r2', trainerId: 'trn_1', memberId: 'm2', status: 'active', permissions: {} },
    ]),
    gymMemberSharing: store([{ id: 'gs1', gymId: 'g1', memberId: 'm1', permissions: { challenges: true } }]),
    activities: store([
      { id: 'a1', userId: 'm1', type: 'walking', source: 'device', startedAt: at('2026-09-21'), steps: 20000, activeMinutes: 60 },
      { id: 'a2', userId: 'm1', type: 'walking', source: 'device', startedAt: at('2026-09-23'), steps: 12450, activeMinutes: 40 },
      { id: 'a3', userId: 'm1', type: 'running', source: 'fitflex', startedAt: at('2026-09-22'), durationMinutes: 30, distanceKm: 5 },
      { id: 'a4', userId: 'm1', type: 'walking', source: 'device', startedAt: at('2026-09-10'), steps: 99999 },
      { id: 'a5', userId: 'm2', type: 'walking', source: 'device', startedAt: at('2026-09-22'), steps: 60000 },
    ]),
    checkins: store([
      { id: 'c1', memberId: 'm1', gymId: 'g1', timestamp: at('2026-09-22') },
      { id: 'c2', memberId: 'm1', gymId: 'g1', timestamp: at('2026-09-22', 18) },
      { id: 'c3', memberId: 'm1', gymId: 'g9', timestamp: at('2026-09-23') },
    ]),
    // Gyms each member is connected to.
    gymMap: { m1: new Map([['g1', ['member']]]), m2: new Map(), m3: new Map() },
  };
  s.svc = createChallengeService({ ...s, gymMemberIds: async m => s.gymMap[m] ?? new Map(), now });
  return s;
}

const FITFLEX = { creatorType: 'fitflex', creatorId: null, createdBy: 'admin' };
const TRAINER = { creatorType: 'trainer', creatorId: 'trn_1', createdBy: 'usr_t1' };
const GYM = { creatorType: 'gym', creatorId: 'g1', createdBy: 'usr_o1' };
const CORP = { creatorType: 'corporate', creatorId: 'corp_1', createdBy: 'usr_hr' };
const base = { name: '50K Step Challenge', type: 'steps', target: 50000, startDate: '2026-09-20', endDate: '2026-09-28' };

test('progress rules for every challenge type', () => {
  const s = setup();
  const acts = s.activities.rows.filter(a => a.userId === 'm1');
  const c = (type) => ({ type, startDate: '2026-09-20', endDate: '2026-09-28' });
  assert.equal(challengeProgress(c('steps'), acts), 32450, 'the 10 Sep walk is outside the dates');
  assert.equal(challengeProgress(c('distance_km'), acts), 5);
  assert.equal(challengeProgress(c('workouts'), acts), 1);
  assert.equal(challengeProgress(c('active_minutes'), acts), 130);
  assert.equal(challengeProgress(c('consistency'), acts), 3, '21st (60 min), 22nd (run), 23rd (40 min)');
  assert.equal(challengeProgress(c('gym_attendance'), [], s.checkins.rows), 2, 'distinct days, any gym');
  assert.equal(challengeProgress(c('gym_attendance'), [], s.checkins.rows, 'g1'), 1, 'only this gym');
});

test('phases follow the member local date; cancelled wins', () => {
  const c = { startDate: '2026-09-24', endDate: '2026-09-24', status: 'active' };
  assert.equal(challengePhase(c, NOW), 'active');
  assert.equal(challengePhase({ ...c, startDate: '2026-09-25', endDate: '2026-09-30' }, NOW), 'upcoming');
  assert.equal(challengePhase({ ...c, startDate: '2026-09-01', endDate: '2026-09-23' }, NOW), 'ended');
  assert.equal(challengePhase({ ...c, status: 'cancelled' }, NOW), 'cancelled');
});

test('creation validates and FitFlex challenges are always public', async () => {
  const s = setup();
  const { challenge } = await s.svc.create(FITFLEX, { ...base, visibility: 'audience', rewards: ['Finisher badge'] });
  assert.equal(challenge.visibility, 'public');
  assert.equal(challenge.phase, 'active');
  assert.deepEqual(challenge.rewards, ['Finisher badge']);
  const bad = [
    [{ ...base, name: '' }, 'invalid_name'],
    [{ ...base, type: 'pushups' }, 'invalid_type'],
    [{ ...base, endDate: '2026-09-19' }, 'invalid_dates'],
    [{ ...base, startDate: '2026-01-01', endDate: '2026-09-30' }, 'too_long'],
    [{ ...base, startDate: '2026-09-01', endDate: '2026-09-10' }, 'ends_in_past'],
    [{ ...base, target: 0 }, 'invalid_target'],
    [{ ...base, type: 'consistency', target: 30 }, 'invalid_target'],
    [{ ...base, rewards: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'invalid_rewards'],
    [{ ...base, visibility: 'secret' }, 'invalid_visibility'],
  ];
  for (const [body, error] of bad) assert.equal((await s.svc.create(TRAINER, body)).error, error, error);
  assert.equal((await s.svc.create({ creatorType: 'partner' }, base)).error, 'invalid_creator');
});

test('audiences: trainer clients, gym members, company employees', async () => {
  const s = setup();
  const t = (await s.svc.create(TRAINER, { ...base, name: 'Coach challenge' })).challenge;
  const g = (await s.svc.create(GYM, { ...base, name: 'Gym challenge', type: 'gym_attendance', target: 8 })).challenge;
  const k = (await s.svc.create(CORP, { ...base, name: 'Company challenge' })).challenge;
  const f = (await s.svc.create(FITFLEX, { ...base, name: 'FitFlex challenge' })).challenge;
  const names = async m => (await s.svc.memberChallenges(m)).challenges.map(c => c.name).sort();
  assert.deepEqual(await names('m1'), ['Coach challenge', 'Company challenge', 'FitFlex challenge', 'Gym challenge']);
  assert.deepEqual(await names('m2'), ['Coach challenge', 'FitFlex challenge']);
  assert.deepEqual(await names('m3'), ['FitFlex challenge']);
  assert.equal((await s.svc.join('m3', t.id)).status, 404, 'not a client');
  assert.equal((await s.svc.join('m3', g.id)).status, 404);
  assert.equal((await s.svc.join('m3', k.id)).status, 404);
  assert.equal((await s.svc.join('m3', f.id)).challenge.joined, true);
  const detail = await s.svc.memberChallenge('m1', t.id);
  assert.deepEqual(detail.challenge.creator, { type: 'trainer', id: 'trn_1', name: 'Coach Sarah' });
});

test('public challenges from any creator reach everyone', async () => {
  const s = setup();
  await s.svc.create(GYM, { ...base, name: 'Open gym challenge', visibility: 'public' });
  assert.deepEqual((await s.svc.memberChallenges('m3')).challenges.map(c => c.name), ['Open gym challenge']);
});

test('join, leave, rejoin; closed challenges stay closed', async () => {
  const s = setup();
  const c = (await s.svc.create(FITFLEX, base)).challenge;
  assert.equal((await s.svc.join('m1', c.id)).challenge.participantCount, 1);
  assert.equal((await s.svc.join('m1', c.id)).error, 'already_joined');
  assert.deepEqual(await s.svc.leave('m1', c.id), { left: true });
  assert.equal((await s.svc.leave('m1', c.id)).error, 'not_joined');
  assert.equal((await s.svc.join('m1', c.id)).challenge.joined, true);
  assert.equal(s.participants.rows.length, 1, 'rejoin reuses the row');

  s.challenges.rows[0].endDate = '2026-09-23';
  assert.equal((await s.svc.join('m2', c.id)).error, 'challenge_closed');
  const list = (await s.svc.memberChallenges('m1')).challenges;
  assert.equal(list[0].phase, 'ended', 'joined challenges stay listed after they end');
  assert.equal((await s.svc.memberChallenges('m2')).challenges.length, 0, 'ended ones are not offered');

  await s.svc.cancel(FITFLEX, c.id);
  assert.equal((await s.svc.join('m2', c.id)).status, 404);
});

test('trainer participants: progress only for members who share challenge data', async () => {
  const s = setup();
  const c = (await s.svc.create(TRAINER, base)).challenge;
  await s.svc.join('m1', c.id);
  await s.svc.join('m2', c.id);
  const r = await s.svc.creatorParticipants(TRAINER, c.id);
  assert.equal(r.target, 50000);
  const [first, second] = r.participants;
  assert.equal(first.member.displayName, 'Amina');
  assert.equal(first.progress, 32450);
  assert.equal(first.completed, false);
  assert.equal(second.member.displayName, 'Baraka');
  assert.equal('progress' in second, false, 'Baraka does not share challenge data');
  assert.equal((await s.svc.creatorParticipants({ ...TRAINER, creatorId: 'trn_x' }, c.id)).status, 404);
});

test('gym participants use the gym sharing switch and gym-only check-ins', async () => {
  const s = setup();
  const c = (await s.svc.create(GYM, { ...base, type: 'gym_attendance', target: 5 })).challenge;
  await s.svc.join('m1', c.id);
  const [p] = (await s.svc.creatorParticipants(GYM, c.id)).participants;
  assert.equal(p.progress, 1, 'the check-in at another gym does not count');
});

test('FitFlex and employers only ever see totals', async () => {
  const s = setup();
  for (const creator of [FITFLEX, CORP]) {
    const c = (await s.svc.create(creator, { ...base, target: 40000 })).challenge;
    await s.svc.join('m1', c.id);
    if (creator === FITFLEX) await s.svc.join('m2', c.id);
    const r = await s.svc.creatorParticipants(creator, c.id);
    assert.equal('participants' in r, false);
    const expected = creator === FITFLEX
      ? { joined: 2, completed: 1, averageProgress: 0.91 }
      : { joined: 1, completed: 0, averageProgress: 0.81 };
    assert.deepEqual(r.summary, expected, creator.creatorType);
    assert.equal(JSON.stringify(r).includes('Amina'), false);
  }
});

test('creator views of one member list progress on that creator\'s challenges', async () => {
  const s = setup();
  const mine = (await s.svc.create(TRAINER, base)).challenge;
  const other = (await s.svc.create(FITFLEX, { ...base, name: 'Not yours' })).challenge;
  await s.svc.join('m1', mine.id);
  await s.svc.join('m1', other.id);
  const rows = await s.svc.memberProgressForCreator('trainer', 'trn_1', 'm1');
  assert.deepEqual(rows.map(r => [r.name, r.progress, r.completed, r.phase]), [['50K Step Challenge', 32450, false, 'active']]);
});
