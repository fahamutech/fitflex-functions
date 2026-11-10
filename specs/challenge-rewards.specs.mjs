// Challenge rewards: structured rewards, earning (finishers / top N /
// winning team), settling, the fulfilment queues and the status trail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChallengeService } from '../src/services/challenge-service.mjs';
import { createChallengeRewardService } from '../src/services/challenge-reward-service.mjs';
import { deliveredTo } from './fixtures/notification-language.mjs';

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
let NOW;
const now = () => NOW;
const at = d => `${d}T05:00:00.000Z`;

const FITFLEX = { creatorType: 'fitflex', creatorId: null, createdBy: 'admin' };
const CORP = { creatorType: 'corporate', creatorId: 'corp_1', createdBy: 'hr_1' };
const TRAINER = { creatorType: 'trainer', creatorId: 'tr_1', createdBy: 'u_tr' };
const base = { name: 'FitFlex 50K Steps', type: 'steps', target: 50000, startDate: '2026-09-20', endDate: '2026-09-30' };
const PASS = { type: 'gym_pass', label: '7-day FitFlex Gym Pass', value: '7 days' };

function setup() {
  NOW = new Date('2026-09-24T06:00:00.000Z');
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  const s = {
    challenges: store(),
    participants: store(),
    teams: store(),
    awards: store(),
    auditLog: store(),
    sent: [], messages: [],
    users: store(ids.map(id => ({ id, userType: 'member', displayName: `${id.toUpperCase()} Person`, corporateId: 'corp_1' }))),
    corporateEmployees: store(ids.map(id => ({ id: `e_${id}`, userId: id, corporateId: 'corp_1', displayName: `${id.toUpperCase()} Staff`, department: 'Finance', status: 'active' }))),
    subscriptions: store([]),
    trainers: store([]),
    gyms: store([]),
    relationships: store([{ id: 'r1', trainerId: 'tr_1', memberId: 'm1', status: 'active', permissions: {} }, { id: 'r3', trainerId: 'tr_1', memberId: 'm3', status: 'active', permissions: {} }]),
    gymMemberSharing: store([]),
    activities: store([
      { id: 'a1', userId: 'm1', type: 'walking', source: 'manual', startedAt: at('2026-09-21'), steps: 60000 },
      { id: 'a2', userId: 'm2', type: 'walking', source: 'manual', startedAt: at('2026-09-22'), steps: 20000 },
      { id: 'a3', userId: 'm3', type: 'walking', source: 'manual', startedAt: at('2026-09-22'), steps: 50000 },
      { id: 'a4', userId: 'm4', type: 'walking', source: 'manual', startedAt: at('2026-09-22'), steps: 10000 },
    ]),
    checkins: store([]),
  };
  s.svc = createChallengeService({ ...s, rewardAwards: s.awards, gymMemberIds: async () => new Map(), now });
  s.rw = createChallengeRewardService({
    challenges: s.challenges, participants: s.participants, awards: s.awards, users: s.users,
    corporateEmployees: s.corporateEmployees, challengeService: s.svc, auditLog: s.auditLog,
    notify: async (userId, m) => { s.messages.push(m); s.sent.push({ userId, type: m.type }); }, now,
  });
  return s;
}

const statuses = async (s, m) => (await s.rw.memberRewards(m)).rewards.map(r => `${r.reward.label}:${r.status}`);

test('rewards are structured; older clients can still send labels', async () => {
  const s = setup();
  const c = (await s.svc.create(FITFLEX, { ...base, rewardItems: [PASS, { type: 'points', label: 'FitFlex points', value: 500 }] })).challenge;
  assert.equal(c.rewardItems.length, 2);
  assert.deepEqual(c.rewards, ['7-day FitFlex Gym Pass', 'FitFlex points'], 'labels kept for older app builds');
  assert.equal(c.rewardItems[0].rule, 'finishers');
  assert.equal(c.rewardItems[1].value, '500');

  const legacy = (await s.svc.create(TRAINER, { ...base, rewards: ['Finisher badge'] })).challenge;
  assert.deepEqual(legacy.rewardItems.map(i => [i.type, i.label, i.rule]), [['other', 'Finisher badge', 'finishers']]);

  const bad = async items => (await s.svc.create(FITFLEX, { ...base, rewardItems: items })).error;
  assert.equal(await bad([{ type: 'car', label: 'X' }]), 'invalid_reward_type');
  assert.equal(await bad([{ label: 'X', rule: 'top' }]), 'invalid_reward_top_n');
  assert.equal(await bad([{ label: 'X', rule: 'team' }]), 'team_reward_needs_teams');
  assert.equal(await bad([{ type: 'badge' }]), 'invalid_rewards');
  assert.equal(await bad(Array.from({ length: 6 }, (_, i) => ({ label: `R${i}` }))), 'invalid_rewards');

  // Ids survive edits, including a label-only edit from an older client.
  const upd = (await s.svc.update(FITFLEX, c.id, { rewards: ['7-day FitFlex Gym Pass'] })).challenge;
  assert.equal(upd.rewardItems[0].id, c.rewardItems[0].id);
  assert.equal(upd.rewardItems[0].type, 'gym_pass', 'keeps its type');
});

test('finishers earn as soon as they hit the target, once', async () => {
  const s = setup();
  const c = (await s.svc.create(FITFLEX, { ...base, rewardItems: [PASS] })).challenge;
  for (const m of ['m1', 'm2']) await s.svc.join(m, c.id);
  assert.deepEqual(await statuses(s, 'm1'), ['7-day FitFlex Gym Pass:pending'], 'earned mid-challenge');
  assert.deepEqual(await statuses(s, 'm1'), ['7-day FitFlex Gym Pass:pending'], 'not twice');
  assert.deepEqual(await statuses(s, 'm2'), [], 'not there yet');
  assert.deepEqual(s.sent, [{ userId: 'm1', type: 'challenge_reward_earned' }]);
  // Swahili for a member who chose it; the challenge and reward names stay as written.
  const sw = await deliveredTo(s.messages[0], 'sw');
  assert.equal(sw.title, 'Umepata zawadi');
  assert.match(sw.body, /: 7-day FitFlex Gym Pass\. Inasubiri kutolewa\.$/);
  const en = await deliveredTo(s.messages[0], null);
  assert.equal(en.title, 'Reward earned');
  assert.match(en.body, /: 7-day FitFlex Gym Pass\. Pending fulfilment\.$/);
  const r = (await s.rw.memberRewards('m1')).rewards[0];
  assert.equal(r.challenge.name, 'FitFlex 50K Steps');
  assert.equal(r.reward.value, '7 days');

  // Once someone has earned it, the reward can't be redefined or dropped.
  assert.equal((await s.svc.update(FITFLEX, c.id, { rewardItems: [{ ...c.rewardItems[0], value: '30 days' }] })).error, 'reward_locked');
  assert.equal((await s.svc.update(FITFLEX, c.id, { rewardItems: [] })).error, 'reward_locked');
  assert.ok((await s.svc.update(FITFLEX, c.id, { rewardItems: [{ ...c.rewardItems[0], label: '7-day Gym Pass' }] })).challenge, 'relabel is fine');
});

test('top N and winning team are decided when it ends; then it settles', async () => {
  const s = setup();
  const c = (await s.svc.create(FITFLEX, {
    ...base, mode: 'teams', teams: ['Simba', 'Tembo'],
    rewardItems: [
      { type: 'trainer_session', label: 'Free PT session', rule: 'top', topN: 2 },
      { type: 'vendor_voucher', label: 'Team smoothie voucher', rule: 'team' },
      { type: 'badge', label: 'Finisher badge' },
    ],
  })).challenge;
  const [simba, tembo] = c.teams.sort((a, b) => a.name.localeCompare(b.name));
  for (const m of ['m1', 'm2', 'm3']) await s.svc.join(m, c.id, { teamId: simba.id });
  for (const m of ['m4', 'm5', 'm6']) await s.svc.join(m, c.id, { teamId: tembo.id });

  assert.deepEqual(await s.rw.settleDue(), { earned: 2, settled: 0 }, 'running: finisher badges only');
  NOW = new Date('2026-10-01T06:00:00.000Z');
  assert.deepEqual(await s.rw.settleDue(), { earned: 5, settled: 1 });
  const by = label => s.awards.rows.filter(a => a.label === label).map(a => a.memberId).sort();
  assert.deepEqual(by('Free PT session'), ['m1', 'm3'], 'top 2 by progress');
  assert.deepEqual(s.awards.rows.filter(a => a.rule === 'top').map(a => [a.memberId, a.rank]).sort(), [['m1', 1], ['m3', 2]]);
  assert.deepEqual(by('Team smoothie voucher'), ['m1', 'm2', 'm3'], 'whole winning team');
  assert.deepEqual(by('Finisher badge'), ['m1', 'm3']);
  assert.ok(s.challenges.rows[0].rewardsSettledAt);

  // Nothing is earned after settling, even with late data.
  s.activities.rows.push({ id: 'a9', userId: 'm2', type: 'walking', source: 'manual', startedAt: at('2026-09-29'), steps: 40000 });
  assert.deepEqual(await s.rw.settleDue(), { earned: 0, settled: 0 });
  assert.deepEqual(await statuses(s, 'm2'), ['Team smoothie voucher:pending']);
});

test('cancelled and upcoming challenges earn nothing', async () => {
  const s = setup();
  const c = (await s.svc.create(FITFLEX, { ...base, rewardItems: [PASS] })).challenge;
  await s.svc.join('m1', c.id);
  await s.svc.cancel(FITFLEX, c.id);
  const later = (await s.svc.create(FITFLEX, { ...base, startDate: '2026-10-01', endDate: '2026-10-30', rewardItems: [PASS] })).challenge;
  await s.svc.join('m1', later.id);
  assert.deepEqual(await statuses(s, 'm1'), []);
});

test('queues go to whoever funds the reward; HR sees names, never activity', async () => {
  const s = setup();
  const ff = (await s.svc.create(FITFLEX, { ...base, rewardItems: [PASS] })).challenge;
  const partner = (await s.svc.create(FITFLEX, { ...base, name: 'Partner', rewardFunding: 'partner', rewardItems: [{ type: 'discount', label: '20% off shoes', value: '20%' }] })).challenge;
  const company = (await s.svc.create(CORP, { ...base, name: 'Kilimo', rewardItems: [{ type: 'corporate_reward', label: 'Extra leave day' }] })).challenge;
  const companyFf = (await s.svc.create(CORP, { ...base, name: 'Kilimo x FitFlex', rewardFunding: 'fitflex', rewardItems: [PASS] })).challenge;
  const trainer = (await s.svc.create(TRAINER, { ...base, name: 'PT', rewards: ['Free session'] })).challenge;
  for (const c of [ff, partner, company, companyFf, trainer]) for (const m of ['m1', 'm2']) await s.svc.join(m, c.id);

  const admin = await s.rw.queue({ kind: 'admin' });
  assert.deepEqual(admin.rewards.map(r => r.challenge.name).sort(), ['FitFlex 50K Steps', 'Kilimo x FitFlex', 'PT', 'Partner']);
  assert.deepEqual(admin.counts, { pending: 4, approved: 0, issued: 0, rejected: 0 });

  const hr = await s.rw.queue({ kind: 'corporate', corporateId: 'corp_1' });
  assert.deepEqual(hr.rewards.map(r => r.reward.label), ['Extra leave day']);
  const row = hr.rewards[0];
  assert.deepEqual(row.member, { id: 'm1', displayName: 'M1 Staff', department: 'Finance' });
  for (const k of ['progress', 'fraction', 'activities', 'steps']) assert.ok(!(k in row), `no ${k}`);
  assert.equal((await s.rw.queue({ kind: 'corporate', corporateId: 'corp_2' })).rewards.length, 0);
  assert.equal((await s.rw.queue({ kind: 'admin' }, { status: 'issued' })).rewards.length, 0);
  assert.equal((await s.rw.queue({ kind: 'admin' }, { status: 'nope' })).error, 'invalid_status');
});

test('pending → approved → issued, with a reason to reject and a full trail', async () => {
  const s = setup();
  const c = (await s.svc.create(FITFLEX, { ...base, rewardItems: [PASS] })).challenge;
  const corp = (await s.svc.create(CORP, { ...base, name: 'Kilimo', rewardItems: [{ type: 'certificate', label: 'Wellness certificate' }] })).challenge;
  for (const x of [c, corp]) { await s.svc.join('m1', x.id); await s.svc.join('m3', x.id); }
  const q = await s.rw.queue({ kind: 'admin' });
  const [a1, a3] = ['m1', 'm3'].map(m => q.rewards.find(r => r.member.id === m));
  const ADMIN = { kind: 'admin' };

  assert.equal((await s.rw.setStatus(ADMIN, 'adm', a1.id, { status: 'issued' })).error, 'invalid_transition', 'approve first');
  assert.equal((await s.rw.setStatus(ADMIN, 'adm', a1.id, { status: 'approved' })).reward.status, 'approved');
  const issued = (await s.rw.setStatus(ADMIN, 'adm', a1.id, { status: 'issued', reference: 'PASS-7D-0192', note: 'Sent by SMS' })).reward;
  assert.equal(issued.status, 'issued');
  assert.equal(issued.reference, 'PASS-7D-0192');
  assert.deepEqual(issued.history.map(h => h.status), ['pending', 'approved', 'issued']);
  assert.equal(issued.history[2].by, 'adm');
  assert.equal(issued.history[2].byName, null, 'unknown user has no name');
  assert.equal((await s.rw.setStatus(ADMIN, 'm2', a3.id, { status: 'approved' })).reward.history[1].byName, 'M2 Person', 'named by display name');
  assert.equal((await s.rw.setStatus(ADMIN, 'adm', a1.id, { status: 'rejected', note: 'x' })).error, 'invalid_transition', 'issued is final');

  assert.equal((await s.rw.setStatus(ADMIN, 'adm', a3.id, { status: 'rejected' })).error, 'reason_required');
  assert.equal((await s.rw.setStatus(ADMIN, 'adm', a3.id, { status: 'rejected', note: 'Steps logged after the end date' })).reward.status, 'rejected');
  assert.equal((await s.rw.setStatus(ADMIN, 'adm', a3.id, { status: 'pending' })).reward.status, 'pending', 'reopened');

  // The member sees where it stands; the audit log has every step.
  const mine = (await s.rw.memberRewards('m1')).rewards.find(r => r.id === a1.id);
  assert.equal(mine.status, 'issued');
  assert.equal(mine.reference, 'PASS-7D-0192');
  assert.deepEqual(s.auditLog.rows.map(r => r.action), [
    'challenge_reward.approved', 'challenge_reward.issued', 'challenge_reward.approved', 'challenge_reward.rejected', 'challenge_reward.pending',
  ]);
  assert.deepEqual(s.sent.filter(m => m.type !== 'challenge_reward_earned').map(m => m.type), ['challenge_reward_issued', 'challenge_reward_rejected']);

  // Each queue can only move its own rewards.
  const hrRow = (await s.rw.queue({ kind: 'corporate', corporateId: 'corp_1' })).rewards[0];
  assert.equal((await s.rw.setStatus(ADMIN, 'adm', hrRow.id, { status: 'approved' })).status, 404);
  assert.equal((await s.rw.setStatus({ kind: 'corporate', corporateId: 'corp_2' }, 'hr2', hrRow.id, { status: 'approved' })).status, 404);
  assert.equal((await s.rw.setStatus({ kind: 'corporate', corporateId: 'corp_1' }, 'hr1', hrRow.id, { status: 'approved' })).reward.status, 'approved');
  assert.equal((await s.rw.setStatus({ kind: 'corporate', corporateId: 'corp_1' }, 'hr1', a1.id, { status: 'approved' })).status, 404);
});
