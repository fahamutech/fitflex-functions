// The challenge leaderboard shows a member's username in place of "Aisha M."
// and says it in its own field, so the app can write @username.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChallengeService } from '../src/services/challenge-service.mjs';

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

const NOW = new Date('2026-09-24T06:00:00.000Z');
let tick = 0;
const now = () => new Date(+NOW + (tick++) * 1000);

function setup(handles) {
  const people = [['m1', 'Aisha Mollel', 40000], ['m2', 'Baraka Juma', 25000]];
  const s = {
    challenges: store(), participants: store(), teams: store(),
    users: store(people.map(([id, displayName]) => ({ id, displayName }))),
    corporateEmployees: store([]), trainers: store([]), gyms: store([]),
    relationships: store([]), gymMemberSharing: store([]),
    activities: store(people.map(([id, , steps]) => ({ id: `a_${id}`, userId: id, type: 'walking', source: 'device', startedAt: '2026-09-22T05:00:00.000Z', steps, heightCm: 180, weightKg: 90 }))),
    checkins: store([]),
  };
  s.svc = createChallengeService({
    ...s, gymMemberIds: async () => new Map(), now,
    usernames: { handleOf: async (id) => handles[id] ?? null },
  });
  return s;
}

test('leaderboard rows show the username and carry a username field', async () => {
  const s = setup({ m1: 'aisha_m' });
  const { challenge: c } = await s.svc.create({ creatorType: 'fitflex', creatorId: null, createdBy: 'admin' },
    { name: '50K Steps', type: 'steps', target: 50000, startDate: '2026-09-20', endDate: '2026-09-28' });
  await s.svc.join('m1', c.id, { leaderboardOptIn: true });
  await s.svc.join('m2', c.id, { leaderboardOptIn: true });
  const lb = await s.svc.leaderboard({ memberId: 'm1' }, c.id);
  const a = lb.individuals.find((r) => r.username === 'aisha_m');
  assert.ok(a, 'username row');
  assert.equal(a.name, 'aisha_m');
  const b = lb.individuals.find((r) => r.name === 'Baraka J.');
  assert.ok(b && !('username' in b), 'no field without a username');
  assert.ok(!JSON.stringify(lb).includes('Mollel'), 'real surname never listed for a username holder');
});
