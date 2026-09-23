// Gym ↔ member activity sharing and membership engagement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGymSharingService, engagementFrom, normalizeGymPermissions } from '../src/services/gym-sharing-service.mjs';

function store(rows = []) {
  const clone = (r) => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) { rows.push(clone(row)); return row; },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
  };
}

// Thursday 24 Sep 2026, 09:00 EAT.
const NOW = new Date('2026-09-24T06:00:00.000Z');
const now = () => NOW;
const at = (day, hour = 7) => `${day}T${String(hour - 3).padStart(2, '0')}:00:00.000Z`; // EAT → UTC

function setup() {
  const s = {
    sharing: store(),
    gyms: store([
      { id: 'g1', name: 'Mikocheni Fitness', location: 'Mikocheni' },
      { id: 'g2', name: 'Oyster Bay Gym', location: 'Oyster Bay' },
      { id: 'g3', name: 'Elsewhere Gym' },
    ]),
    subscriptions: store([{ id: 's1', memberId: 'm1', homeGymId: 'g1', status: 'active' }]),
    checkins: store([
      { id: 'c1', memberId: 'm1', gymId: 'g1', timestamp: at('2026-09-22') },
      { id: 'c2', memberId: 'm1', gymId: 'g1', timestamp: at('2026-09-15') },
      { id: 'c3', memberId: 'm1', gymId: 'g1', timestamp: at('2026-09-08') },
      { id: 'c4', memberId: 'm1', gymId: 'g2', timestamp: at('2026-09-01') },
      { id: 'c5', memberId: 'm2', gymId: 'g1', timestamp: at('2026-09-05') },
      { id: 'c6', memberId: 'm3', gymId: 'g1', timestamp: at('2026-09-23') },
    ]),
    activities: store([
      { id: 'a1', userId: 'm1', type: 'group_class', source: 'manual', gymId: 'g1', startedAt: at('2026-09-20', 9), durationMinutes: 50, notes: 'private note' },
      { id: 'a2', userId: 'm1', type: 'strength', source: 'fitflex', gymId: 'g1', startedAt: at('2026-09-22', 18), durationMinutes: 45, steps: 0 },
      { id: 'a3', userId: 'm1', type: 'running', source: 'fitflex', gymId: null, startedAt: at('2026-09-23', 6), durationMinutes: 30, distanceKm: 5 },
      { id: 'a4', userId: 'm1', type: 'walking', source: 'device', gymId: null, startedAt: at('2026-09-23', 8), steps: 9000 },
    ]),
    users: store([{ id: 'm1', displayName: 'Amina' }, { id: 'm2', displayName: 'Baraka' }, { id: 'm3', displayName: 'Chausiku' }]),
  };
  s.svc = createGymSharingService({ ...s, now });
  return s;
}

const owner = { id: 'o1', gymIds: ['g1'] };

test('permissions: known keys only, all off by default', () => {
  assert.deepEqual(normalizeGymPermissions({ classAttendance: true, steps: true }), {
    classAttendance: true, gymWorkouts: false, challenges: false,
  });
  assert.deepEqual(normalizeGymPermissions(undefined), { classAttendance: false, gymWorkouts: false, challenges: false });
});

test('member sees their gyms — home and visited — with nothing extra shared', async () => {
  const s = setup();
  const { gyms } = await s.svc.memberSharing('m1');
  assert.deepEqual(gyms.map(g => [g.gym.id, g.reasons]), [['g1', ['member', 'visited']], ['g2', ['visited']]]);
  assert.ok(gyms.every(g => Object.values(g.permissions).every(v => v === false)));
});

test('members can only set sharing for their own gyms', async () => {
  const s = setup();
  assert.equal((await s.svc.updateMemberSharing('m1', 'g3', { permissions: { classAttendance: true } })).status, 404);
  assert.equal((await s.svc.updateMemberSharing('m1', 'g1', {})).error, 'invalid_permissions');
  const r = await s.svc.updateMemberSharing('m1', 'g1', { permissions: { classAttendance: true } });
  assert.equal(r.permissions.classAttendance, true);
  const again = await s.svc.updateMemberSharing('m1', 'g1', { permissions: { gymWorkouts: true } });
  assert.deepEqual(again.permissions, { classAttendance: true, gymWorkouts: true, challenges: false }, 'omitted keys kept');
  assert.equal(s.sharing.rows.length, 1, 'one row per member per gym');
});

test('by default a gym sees visit patterns only — no activity', async () => {
  const s = setup();
  const { gyms } = await s.svc.ownerMemberActivity(owner, 'm1');
  assert.equal(gyms.length, 1, 'only the gyms this owner manages');
  const [g] = gyms;
  assert.equal(g.gym.id, 'g1');
  assert.equal(g.engagement.visits30, 3);
  assert.equal(g.engagement.lastVisit, '2026-09-22');
  assert.equal(g.engagement.status, 'active');
  assert.equal(g.engagement.weekStreak, 3, 'weeks of 8, 15 and 22 Sep');
  for (const key of ['classAttendance', 'gymWorkouts', 'challenges']) assert.equal(key in g, false, key);
  const json = JSON.stringify(gyms);
  for (const leak of ['running', '9000', 'private note', 'distanceKm']) assert.equal(json.includes(leak), false, leak);
});

test('shared items show when, what and how long — only at this gym', async () => {
  const s = setup();
  await s.svc.updateMemberSharing('m1', 'g1', { permissions: { classAttendance: true, gymWorkouts: true, challenges: true } });
  const [g] = (await s.svc.ownerMemberActivity(owner, 'm1')).gyms;
  assert.deepEqual(g.classAttendance, [{ date: '2026-09-20', type: 'group_class', durationMinutes: 50 }]);
  assert.deepEqual(g.gymWorkouts, [{ date: '2026-09-22', type: 'strength', durationMinutes: 45 }]);
  assert.deepEqual(g.challenges, { available: false });
  const json = JSON.stringify(g);
  assert.equal(json.includes('running'), false, 'activity elsewhere never shows');
  assert.equal(json.includes('private note'), false);

  // Revoking is immediate.
  await s.svc.updateMemberSharing('m1', 'g1', { permissions: { classAttendance: false, gymWorkouts: false } });
  const [after] = (await s.svc.ownerMemberActivity(owner, 'm1')).gyms;
  assert.equal('classAttendance' in after, false);
  assert.equal('gymWorkouts' in after, false);
});

test('owners only see members connected to their gyms', async () => {
  const s = setup();
  assert.equal((await s.svc.ownerMemberActivity({ gymIds: ['g3'] }, 'm1')).status, 404);
  assert.equal((await s.svc.ownerMemberActivity({ gymId: 'g2' }, 'm1')).gyms[0].gym.id, 'g2', 'staff with a single gymId');
});

test('engagement bands and week streak rules', () => {
  const e = (days) => engagementFrom(days.map(d => at(d)), NOW);
  assert.equal(e([]).status, 'none');
  assert.equal(e(['2026-09-12']).status, 'slipping', '12 days');
  assert.equal(e(['2026-09-01']).status, 'at_risk', '23 days');
  assert.equal(e(['2026-08-01']).status, 'lapsed');
  // No visit yet this week doesn't break the streak.
  assert.equal(e(['2026-09-14', '2026-09-07']).weekStreak, 2);
  assert.equal(e(['2026-09-07']).weekStreak, 0, 'missed last week');
  assert.equal(e(['2026-09-22', '2026-09-23']).visits30, 2, 'distinct days');
});

test('gym dashboard: bands, new members and who to check in with', async () => {
  const s = setup();
  const r = await s.svc.ownerEngagement(owner, null);
  assert.equal(r.members, 3);
  assert.equal(r.active, 2, 'm1 and m3');
  assert.equal(r.at_risk, 1, 'm2 last came on 5 Sep');
  assert.equal(r.newThisMonth, 3);
  assert.deepEqual(r.checkIn.map(c => c.member.displayName), ['Baraka']);
  assert.equal(r.checkIn[0].daysSinceLastVisit, 19);
  assert.equal((await s.svc.ownerEngagement(owner, 'g2')).status, 403);
  assert.equal((await s.svc.ownerEngagement({}, null)).error, 'owner_has_no_gyms');
});
