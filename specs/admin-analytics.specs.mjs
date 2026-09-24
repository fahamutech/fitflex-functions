// Internal product analytics: aggregate definitions and privacy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsService, originOf, periodEnds } from '../src/services/analytics-service.mjs';

function store(rows = []) {
  return {
    rows,
    async allAsync() { return rows.map(r => ({ ...r })); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(r => ({ ...r })); },
  };
}

// Friday 25 Sep 2026, 12:00 EAT. Window: Mon 14 – Thu 24 Sep (11 days).
const NOW = new Date('2026-09-25T09:00:00Z');
const at = (day, hour = 8) => new Date(Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00+03:00`)).toISOString();
const run = (id, userId, day, extra = {}) => ({ id, userId, type: 'running', source: 'fitflex', startedAt: at(day), durationMinutes: 40, activeMinutes: 40, ...extra });

function setup() {
  const s = {
    users: store([
      { id: 'm1', userType: 'member', displayName: 'Aisha Mollel', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'm2', userType: 'member', displayName: 'Baraka Juma', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'm3', userType: 'member', displayName: 'Chausiku Ally', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'm4', userType: 'member', displayName: 'Late Joiner', createdAt: '2026-09-30T00:00:00Z' },
      { id: 't1', userType: 'trainer', displayName: 'Coach Sarah' },
    ]),
    activities: store([
      // m1: every day 10–24 Sep → a streak that runs through the window.
      ...Array.from({ length: 15 }, (_, i) => run(`a1_${i}`, 'm1', `2026-09-${String(10 + i).padStart(2, '0')}`)),
      // m2: two logs, one device-with-platform and one bare "device".
      { id: 'a2', userId: 'm2', type: 'walking', source: 'device', devicePlatform: 'health_connect', externalId: 'hc1', startedAt: at('2026-09-15'), steps: 9000, activeMinutes: 20 },
      { id: 'a3', userId: 'm2', type: 'walking', source: 'device', startedAt: at('2026-09-16'), steps: 90000 },
      { id: 'a4', userId: 'm2', type: 'strength', source: 'manual', startedAt: at('2026-09-22'), activeMinutes: 30 },
      // Outside the window.
      run('old', 'm3', '2026-09-01'),
      // Not a member.
      run('tr', 't1', '2026-09-20'),
    ]),
    workouts: store([
      { id: 'w1', userId: 'm1', trainerId: 't1', scheduledDate: '2026-09-15', status: 'completed', completedAt: at('2026-09-15', 18), createdAt: at('2026-09-14') },
      { id: 'w2', userId: 'm2', trainerId: 't1', scheduledDate: '2026-09-16', status: 'planned', createdAt: at('2026-09-14') },
      { id: 'w3', userId: 'm2', trainerId: null, scheduledDate: '2026-09-17', status: 'skipped', createdAt: at('2026-09-16') },
      { id: 'w4', userId: 'm3', trainerId: null, scheduledDate: '2026-09-18', status: 'completed', completedAt: at('2026-09-18', 7), createdAt: at('2026-09-17') },
      // Today: not due yet.
      { id: 'w5', userId: 'm3', trainerId: null, scheduledDate: '2026-09-25', status: 'planned', createdAt: at('2026-09-24') },
    ]),
    goals: store([
      // m1 daily 30 active minutes from 20 Sep: met every day 20–24.
      { id: 'g1', userId: 'm1', type: 'active_minutes', period: 'day', target: 30, startDate: '2026-09-20', status: 'active' },
      // m2 weekly 3 workouts: week of 14 Sep had 1 → missed.
      { id: 'g2', userId: 'm2', type: 'workouts', period: 'week', target: 3, startDate: '2026-09-01', status: 'active' },
      { id: 'g3', userId: 'm3', type: 'steps', period: 'day', target: 1, startDate: '2026-09-01', status: 'archived' },
    ]),
    checkins: store([
      { id: 'c1', memberId: 'm3', gymId: 'g1', timestamp: at('2026-09-18', 6) },
      { id: 'c2', memberId: 'm3', gymId: 'g1', timestamp: at('2026-09-21', 6) },
      { id: 'c3', memberId: 'm2', gymId: 'g2', timestamp: at('2026-09-21', 6) },
    ]),
    challenges: store([
      { id: 'ch1', name: 'Workout week', type: 'workouts', target: 5, startDate: '2026-09-14', endDate: '2026-09-20', creatorType: 'gym', creatorId: 'g1', status: 'active' },
      { id: 'ch2', name: 'Old', type: 'steps', target: 1, startDate: '2026-08-01', endDate: '2026-08-10', creatorType: 'fitflex', status: 'active' },
    ]),
    participants: store([
      { id: 'p1', challengeId: 'ch1', memberId: 'm1', status: 'joined', joinedAt: at('2026-09-14'), leaderboardOptIn: true },
      { id: 'p2', challengeId: 'ch1', memberId: 'm2', status: 'joined', joinedAt: at('2026-09-14'), leaderboardOptIn: false },
      { id: 'p3', challengeId: 'ch2', memberId: 'm3', status: 'joined', joinedAt: at('2026-08-01') },
    ]),
    relationships: store([
      { id: 'r1', trainerId: 't1', memberId: 'm1', status: 'active', requestedAt: at('2026-09-14'), connectedAt: at('2026-09-14', 9), permissions: { goals: true } },
      { id: 'r2', trainerId: 't1', memberId: 'm2', status: 'declined', requestedAt: at('2026-09-15'), connectedAt: null, permissions: {} },
      { id: 'r3', trainerId: 't2', memberId: 'm3', status: 'pending', requestedAt: at('2026-09-20'), connectedAt: null, permissions: {} },
    ]),
    gymSharing: store([{ id: 's1', gymId: 'g1', memberId: 'm3', permissions: { classAttendance: true } }]),
    gyms: store([{ id: 'g1', name: 'Mikocheni Fitness' }, { id: 'g2', name: 'Oyster Bay Gym' }]),
  };
  s.svc = createAnalyticsService({ ...s, now: () => NOW });
  return s;
}

const WINDOW = { from: '2026-09-14', to: '2026-09-24' };

test('daily active members and logging', async () => {
  const r = await setup().svc.overview(WINDOW);
  assert.deepEqual(r.period, { from: '2026-09-14', to: '2026-09-24', days: 11 });
  assert.equal(r.members, 3, 'members who joined after the window and trainers are excluded');
  const day = d => r.dailyActive.series.find(s => s.day === d).members;
  assert.equal(day('2026-09-14'), 1);
  assert.equal(day('2026-09-15'), 2, 'm1 run + m2 walk (m1 counted once despite a workout too)');
  assert.equal(day('2026-09-18'), 2, 'm1 run + m3 completed workout and check-in');
  assert.equal(day('2026-09-21'), 3, 'check-ins count');
  assert.equal(r.dailyActive.activeInPeriod, 3);
  assert.equal(r.activityLogging.activities, 11 + 3);
  assert.equal(r.activityLogging.membersLogging, 2);
  assert.equal(r.activityLogging.loggingRate, 0.667);
  assert.deepEqual(r.activityLogging.byOrigin, { device: 1, fitflex: 11, manual: 2 }, 'a "device" row with no platform is manual');
});

test('workout completion counts only due workouts', async () => {
  const { workouts: w } = await setup().svc.overview(WINDOW);
  assert.deepEqual(
    { due: w.due, completed: w.completed, skipped: w.skipped, missed: w.missed, rate: w.completionRate },
    { due: 4, completed: 2, skipped: 1, missed: 1, rate: 0.5 },
  );
  assert.equal(w.trainerAssigned.completionRate, 0.5);
  assert.equal(w.selfPlanned.completionRate, 0.5);
});

test('challenges: participation, completion and opt-in', async () => {
  const { challenges: c } = await setup().svc.overview(WINDOW);
  assert.equal(c.running, 1, 'the August challenge is outside the window');
  assert.equal(c.participants, 2);
  assert.equal(c.participationRate, 0.667);
  assert.equal(c.finishedEntries, 2);
  assert.equal(c.completionRate, 0.5, 'm1 did 7 workouts ≥ 5; m2 did 1');
  assert.equal(c.leaderboardOptInRate, 0.5);
});

test('streaks: distribution, unbroken streaks and weekly retention', async () => {
  const { streaks: s } = await setup().svc.overview(WINDOW);
  const bucket = lo => s.distributionAtEnd.find(b => b.from === lo).members;
  assert.equal(bucket(14), 1, 'm1 is on a 15-day streak');
  assert.equal(bucket(0), 2);
  assert.equal(s.onStreakAtStart, 1);
  assert.equal(s.unbrokenThroughPeriod, 1);
  assert.equal(s.streakRetention, 1);
  assert.deepEqual(s.weeklyRetention, [], 'the week after 14 Sep isn\'t complete inside the window');
});

test('weekly retention compares whole weeks', async () => {
  const r = await setup().svc.overview({ from: '2026-09-07', to: '2026-09-20' });
  // Week of 7 Sep: only m1 (from the 10th). Week of 14 Sep: m1 again.
  assert.deepEqual(
    r.streaks.weeklyRetention.map(w => [w.week, w.active, w.activeNextWeek, w.retention]),
    [['2026-09-07', 1, 1, 1]],
  );
});

test('goals: whole periods only, archived goals ignored', async () => {
  const { goals: g } = await setup().svc.overview(WINDOW);
  // g1: days 20–24 (5, all met). g2: week of 14 Sep (1, missed); the week
  // of 21 Sep hasn't ended inside the window.
  assert.equal(g.periodsEvaluated, 6);
  assert.equal(g.periodsMet, 5);
  assert.equal(g.byPeriod.week.completionRate, 0);
  assert.equal(g.byType.active_minutes.completionRate, 1);
  assert.equal(g.membersWithGoals, 2);
});

test('trainers and gyms', async () => {
  const { trainers: t, gyms: g } = await setup().svc.overview(WINDOW);
  assert.deepEqual(
    [t.activeConnections, t.trainersWithClients, t.requests, t.accepted, t.declined, t.pending, t.acceptanceRate],
    [1, 1, 3, 1, 1, 1, 0.5],
  );
  assert.equal(t.clientsSharingData, 1);
  assert.equal(t.workoutsAssigned, 2);
  assert.equal(g.checkins, 3);
  assert.equal(g.membersVisiting, 2);
  assert.deepEqual(g.topGyms, [
    { gymId: 'g1', name: 'Mikocheni Fitness', checkins: 2, members: 1 },
    { gymId: 'g2', name: 'Oyster Bay Gym', checkins: 1, members: 1 },
  ]);
  assert.equal(g.gymChallenges, 1);
  assert.equal(g.gymChallengeParticipants, 2);
  assert.equal(g.membersSharingWithGyms, 1);
});

test('aggregates only: no member names, ids or raw activity', async () => {
  const json = JSON.stringify(await setup().svc.overview(WINDOW));
  for (const leak of ['Aisha', 'Mollel', 'Baraka', 'Chausiku', '"m1"', '"m2"', '"m3"', 'hc1', 'startedAt', 'displayName']) {
    assert.equal(json.includes(leak), false, leak);
  }
});

test('validates the window', async () => {
  const { svc } = setup();
  for (const [q, error] of [
    [{ from: 'last week' }, 'invalid_date'],
    [{ from: '2026-09-20', to: '2026-09-10' }, 'invalid_range'],
    [{ to: '2026-09-26' }, 'future_range'],
    [{ from: '2026-01-01', to: '2026-09-24' }, 'range_too_long'],
  ]) {
    const r = await svc.overview(q);
    assert.equal(r.status, 400); assert.equal(r.error, error);
  }
  const d = await svc.overview();
  assert.deepEqual(d.period, { from: '2026-08-27', to: '2026-09-25', days: 30 });
});

test('helpers', () => {
  assert.equal(originOf({ source: 'device', devicePlatform: 'apple_health' }), 'device');
  assert.equal(originOf({ source: 'device' }), 'manual');
  assert.equal(originOf({ source: 'trainer' }), 'manual');
  assert.deepEqual(
    periodEnds({ period: 'month', startDate: '2026-01-01' }, '2026-08-15', '2026-10-05', '2026-10-06'),
    ['2026-08-31', '2026-09-30'],
  );
});
