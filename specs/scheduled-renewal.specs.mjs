// A renewal paid before the member's current plan ends starts when that plan ends
// (owner decision 2026-11-15): stored 'scheduled', promoted to 'active' at its start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activationDates, renewalStartFor, paidPlanPatch, promoteStartedSubscriptions, scheduledHasStarted, currentSubscription, SCHEDULED,
} from '../src/shared/subscription-status.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';
import { settingsWithTiers } from './fixtures/tier-settings.mjs';

const DAY = 86_400_000;
const NOW = new Date('2026-11-15T09:00:00Z');
const at = (days) => new Date(+NOW + days * DAY).toISOString();
// The service tests below hit paths that read the real clock (createAdminPaymentService
// has no `now` injection; /me computes status with the default clock), so their fixtures
// are built from the real time; a fixed date stops being 'early' / 'active' once it passes.
const REAL_NOW = new Date();
const atReal = (days) => new Date(+REAL_NOW + days * DAY).toISOString();

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async allAsync() { return [...rows]; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}
const running = (over = {}, t = at) => ({ id: 'sub_old', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'active', startedAt: t(-27), cycleStartedAt: t(-27), expiresAt: t(3), renewsAt: t(3), ...over });
const pending = (over = {}, t = at) => ({ id: 'sub_new', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending', startedAt: t(0), expiresAt: t(30), ...over });

test('activation dates: from now, or from notBefore when it is later; length kept', () => {
  const d = activationDates(pending(), NOW);
  assert.deepEqual([d.startedAt, d.expiresAt], [NOW.toISOString(), at(30)]);
  const r = activationDates(pending(), NOW, new Date(at(3)));
  assert.deepEqual([r.startedAt, r.cycleStartedAt, r.expiresAt, r.renewsAt], [at(3), at(3), at(33), at(33)]);
  assert.equal(activationDates(pending(), NOW, new Date(at(-1))).startedAt, NOW.toISOString(), 'a past date never back-dates');
});

test('renewal start: the end of the running plan of the same product only', () => {
  const sub = pending();
  assert.equal(renewalStartFor(sub, [running()], NOW).toISOString(), at(3));
  assert.equal(renewalStartFor(sub, [running({ tier: 'pro' })], NOW).toISOString(), at(3), 'any FitFlex Pass tier');
  assert.equal(renewalStartFor(sub, [running({ expiresAt: at(-1) })], NOW), null, 'expired: start now');
  assert.equal(renewalStartFor(sub, [running({ status: 'suspended' })], NOW), null, 'suspended: start now');
  assert.equal(renewalStartFor(sub, [running({ type: 'direct_sub', homeGymId: 'g1' })], NOW), null, 'a gym plan is not a pass');
  assert.equal(renewalStartFor(sub, [running({ memberId: 'm2' })], NOW), null);
  const gym = pending({ type: 'direct_sub', homeGymId: 'g1' });
  assert.equal(renewalStartFor(gym, [running({ type: 'direct_sub', homeGymId: 'g1' })], NOW).toISOString(), at(3));
  assert.equal(renewalStartFor(gym, [running({ type: 'direct_sub', homeGymId: 'g2' })], NOW), null, 'another gym\'s plan');
  // chained after a renewal already scheduled
  assert.equal(renewalStartFor(sub, [running(), running({ id: 's2', status: SCHEDULED, startedAt: at(3), expiresAt: at(33) })], NOW).toISOString(), at(33));
});

test('paid plan patch: active now, or scheduled', () => {
  assert.equal(paidPlanPatch(pending(), [], NOW).status, 'active');
  const p = paidPlanPatch(pending(), [running()], NOW);
  assert.deepEqual([p.status, p.startedAt, p.expiresAt], [SCHEDULED, at(3), at(33)]);
});

test('a scheduled plan is not the current one until it starts; then it is promoted once', async () => {
  const sched = { ...pending(), status: SCHEDULED, startedAt: at(3), cycleStartedAt: at(3), expiresAt: at(33) };
  assert.equal(currentSubscription([running(), sched]).id, 'sub_old');
  const store = memStore([running(), sched]);
  const started = [];
  let out = await promoteStartedSubscriptions(store, store.rows, { now: NOW, onStarted: (s) => started.push(s.id) });
  assert.equal(out.find((s) => s.id === 'sub_new').status, SCHEDULED, 'not yet');
  const later = new Date(at(3.01));
  assert.equal(scheduledHasStarted(sched, later), true);
  out = await promoteStartedSubscriptions(store, [...store.rows], { now: later, onStarted: (s) => started.push(s.id) });
  assert.equal(out.find((s) => s.id === 'sub_new').status, 'active');
  assert.equal(store.rows[1].status, 'active');
  assert.deepEqual(started, ['sub_new']);
  // a second promoter that read the old row does not report it again
  await promoteStartedSubscriptions(store, [sched], { now: later, onStarted: (s) => started.push(s.id) });
  assert.deepEqual(started, ['sub_new']);
  assert.equal(currentSubscription(store.rows).id, 'sub_new');
});

test('admin approval of an early renewal schedules it; the activation events wait for its start', async () => {
  const subscriptions = memStore([running({}, atReal), pending({}, atReal)]);
  const paymentRequests = memStore([{ id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_new', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, requestedAt: atReal(0) }]);
  const events = [];
  const svc = createAdminPaymentService({
    paymentRequests, subscriptions, users: memStore(), auditLog: { async insertAsync() {} },
    onSubscriptionActivated: async (s) => events.push(['activated', s.id]),
    onSubscriptionScheduled: async (s) => events.push(['scheduled', s.id]),
    scheduleRenewals: () => true,
  });
  const out = await svc.decide({ id: 'pay_1', decision: 'approve', reference: 'TXN', actorId: 'azampay', amountTzs: 60_000, automated: true });
  assert.equal(out.error, undefined);
  const row = subscriptions.rows.find((s) => s.id === 'sub_new');
  assert.equal(row.status, SCHEDULED);
  assert.equal(+new Date(row.startedAt), +new Date(subscriptions.rows[0].expiresAt), 'starts when the current pass ends');
  assert.deepEqual(events, [['scheduled', 'sub_new']]);
  assert.equal(subscriptions.rows[0].status, 'active', 'the current pass is untouched');
});

test('with SCHEDULED_RENEWALS off, an early renewal starts at payment as before', async () => {
  const subscriptions = memStore([running({}, atReal), pending({}, atReal)]);
  const paymentRequests = memStore([{ id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_new', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, requestedAt: atReal(0) }]);
  const svc = createAdminPaymentService({ paymentRequests, subscriptions, users: memStore(), auditLog: { async insertAsync() {} } });
  await svc.decide({ id: 'pay_1', decision: 'approve', reference: 'TXN', actorId: 'adm', amountTzs: 60_000, automated: true });
  assert.equal(subscriptions.rows[1].status, 'active');
  assert.ok(Math.abs(Date.now() - +new Date(subscriptions.rows[1].startedAt)) < 60_000);
  assert.equal(paidPlanPatch(pending(), [running()], NOW, { scheduleRenewals: false }).status, 'active');
});

test('with no running plan, approval activates as before', async () => {
  const subscriptions = memStore([pending({}, atReal)]);
  const paymentRequests = memStore([{ id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_new', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, requestedAt: atReal(0) }]);
  const events = [];
  const svc = createAdminPaymentService({
    paymentRequests, subscriptions, users: memStore(), auditLog: { async insertAsync() {} },
    onSubscriptionActivated: async (s) => events.push(['activated', s.id]),
    onSubscriptionScheduled: async (s) => events.push(['scheduled', s.id]),
    scheduleRenewals: () => true,
  });
  await svc.decide({ id: 'pay_1', decision: 'approve', reference: 'TXN', actorId: 'azampay', amountTzs: 60_000, automated: true });
  assert.equal(subscriptions.rows[0].status, 'active');
  assert.deepEqual(events, [['activated', 'sub_new']]);
});

test('one renewal may wait at a time; /me lists it and promotes it when it starts', async () => {
  const sched = { ...pending({ id: 'sub_sched' }, atReal), status: SCHEDULED, startedAt: atReal(3), cycleStartedAt: atReal(3), expiresAt: atReal(33), renewsAt: atReal(33) };
  const subscriptions = memStore([running({}, atReal), sched]);
  const tiers = [{ key: 'basic', label: 'basic', monthlyPrice: 60_000, visits: 20, gymAccess: 'standard' }];
  let clock = +REAL_NOW;
  const svc = createSubscriptionService({
    subscriptions, paymentRequests: memStore(), checkins: memStore(), gyms: [],
    settingsService: settingsWithTiers(tiers), publicUserId: async () => 'FF-1',
    promoteStarted: (subs, now) => promoteStartedSubscriptions(subscriptions, subs, { now }),
    now: () => clock,
  });
  assert.equal((await svc.subscribe({ memberId: 'm1', tier: 'basic' })).error, 'renewal_already_scheduled');
  let me = await svc.me({ id: 'm1', userType: 'member' });
  assert.equal(me.subscription.id, 'sub_old');
  assert.deepEqual(me.scheduledRenewals.map((r) => [r.id, r.startsAt]), [['sub_sched', atReal(3)]]);
  clock = +REAL_NOW + 3.5 * DAY;
  me = await svc.me({ id: 'm1', userType: 'member' });
  assert.equal(me.subscription.id, 'sub_sched');
  assert.equal(me.subscription.status, 'active');
  assert.deepEqual(me.scheduledRenewals, []);
});

// Found on a live account 2026-11-25: a gym day plan bought (and ended) during a 30-day pass
// became "the current plan", so the app said the pass payment was still being confirmed.
const dayPlanEnded = (t = at) => ({ id: 'sub_day', memberId: 'm1', type: 'direct_sub', plan: 'daily', homeGymId: 'g1', status: 'active', startedAt: t(-9), cycleStartedAt: t(-9), expiresAt: t(-8), renewsAt: t(-8) });

test('the current plan is one still running, not a later-started plan that has ended', () => {
  const pass = running({ id: 'sub_pass', tier: 'executive', startedAt: at(-23), cycleStartedAt: at(-23), expiresAt: at(7) });
  assert.equal(currentSubscription([pass, dayPlanEnded()], NOW).id, 'sub_pass');
  // stored status already flipped to expired: same answer
  assert.equal(currentSubscription([pass, { ...dayPlanEnded(), status: 'expired' }], NOW).id, 'sub_pass');
  // two plans running: the later-started one, as before
  const gymWeek = { ...dayPlanEnded(), id: 'sub_week', startedAt: at(-2), expiresAt: at(5) };
  assert.equal(currentSubscription([pass, gymWeek], NOW).id, 'sub_week');
  // everything ended: the newest, so the member sees what ended last
  assert.equal(currentSubscription([pass, dayPlanEnded()], new Date(at(8))).id, 'sub_day');
  // a suspended newest plan is still the current one (suspension is not hidden by an older plan)
  assert.equal(currentSubscription([pass, { ...gymWeek, status: 'suspended' }], NOW).id, 'sub_week');
  // unpaid or queued plans never count
  assert.equal(currentSubscription([pending(), { ...pending({ id: 'q' }), status: SCHEDULED }], NOW), null);
});

test('/me: a running pass stays current after a day plan ended, while the renewal waits and an old request is open', async () => {
  const pass = running({ id: 'sub_pass', tier: 'basic', startedAt: atReal(-23), cycleStartedAt: atReal(-23), expiresAt: atReal(7), renewsAt: atReal(7) }, atReal);
  const sched = { ...pending({ id: 'sub_sched' }, atReal), status: SCHEDULED, startedAt: atReal(7), cycleStartedAt: atReal(7), expiresAt: atReal(37), renewsAt: atReal(37) };
  const unpaidDay = { id: 'sub_unpaid', memberId: 'm1', type: 'direct_sub', plan: 'daily', homeGymId: 'g1', status: 'payment_pending', startedAt: atReal(-8), expiresAt: atReal(-7) };
  const subscriptions = memStore([pass, dayPlanEnded(atReal), sched, unpaidDay]);
  const paymentRequests = memStore([{ id: 'pay_old', memberId: 'm1', subscriptionId: 'sub_unpaid', gymId: 'g1', plan: 'daily', amountTzs: 10_000, status: 'pending', provider: 'admin_approved', requestedAt: atReal(-8) }]);
  const tiers = [{ key: 'basic', label: 'basic', monthlyPrice: 60_000, visits: 20, gymAccess: 'standard' }];
  const svc = createSubscriptionService({
    subscriptions, paymentRequests, checkins: memStore(), gyms: [],
    settingsService: settingsWithTiers(tiers), publicUserId: async () => 'FF-1',
    promoteStarted: (subs, now) => promoteStartedSubscriptions(subscriptions, subs, { now }),
    now: () => +REAL_NOW,
  });
  const me = await svc.me({ id: 'm1', userType: 'member' });
  assert.equal(me.subscription.id, 'sub_pass');
  assert.equal(me.subscription.status, 'active');
  assert.equal(me.visitCap, 20, 'visits are counted against the running pass');
  assert.equal(me.entitlements.fitflexPass.id, 'sub_pass');
  assert.deepEqual(me.scheduledRenewals.map((r) => r.id), ['sub_sched']);
  assert.equal(me.pendingPayment.id, 'pay_old', 'the open request is still reported; it no longer decides the pass state');
});
