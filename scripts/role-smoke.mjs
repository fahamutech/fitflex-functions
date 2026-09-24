#!/usr/bin/env node
// Role-by-role regression smoke test against a LOCAL backend.
//
//   FITFLEX_USE_CI_DB=1 bfast fs serve --port 3000     # in one terminal
//   node scripts/role-smoke.mjs                         # in another
//
// Signs in with the dev mock login (member, trainer, owner, vendor) and a
// locally signed admin or corporate-HR token for the corporate routes (a
// test company is onboarded if the database has none), then walks each
// role's core journeys, including the cross-role ones (member QR → owner
// check-in, member ↔ trainer connection and assignment, owner challenge →
// member join, member enquiry → vendor reply). It writes test data, so it
// refuses to run against anything but localhost. No payments are made.
// Same JWT secret as the local server.
import 'dotenv/config';
import { sign } from '../src/auth/jwt.mjs';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local backends only.`);
  process.exit(2);
}

const results = [];
let current = 'setup';
const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

async function call(method, path, { token, body, expect = [200, 201] } = {}) {
  const res = await fetch(BASE + path, {
    method: method.toUpperCase(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, ok: expect.includes(res.status), json };
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ area: current, name, ok: true, detail });
  } catch (e) {
    results.push({ area: current, name, ok: false, detail: e.message });
  }
}

function must(r, what) {
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 160)}`);
  return r.json;
}

async function devLogin(role) {
  const r = await call('post', '/auth/dev/login', { body: { role } });
  return must(r, `dev login ${role}`);
}

// ── Sessions ────────────────────────────────────────────────────────────
current = 'login';
const sessions = {};
for (const role of ['member', 'trainer', 'owner', 'vendor']) {
  await check(`dev login as ${role}`, async () => {
    const s = await devLogin(role);
    sessions[role] = s;
    return s.user?.userType;
  });
}
const M = sessions.member?.token, T = sessions.trainer?.token, O = sessions.owner?.token, V = sessions.vendor?.token;
const memberId = sessions.member?.user?.id;
const ownerGymId = sessions.owner?.user?.gymId;

// ── Member ──────────────────────────────────────────────────────────────
current = 'member';
await check('dashboard: /me', async () => must(await call('get', '/me', { token: M }), '/me').user?.id);
let gyms = [];
await check('gym discovery: /gyms + detail', async () => {
  gyms = must(await call('get', '/gyms'), '/gyms');
  const one = gyms.find(g => g.id === ownerGymId) || gyms[0];
  must(await call('get', `/gyms/${one.id}`), 'gym detail');
  return `${gyms.length} gyms`;
});
let trainers = [];
await check('trainer discovery: /trainers + detail', async () => {
  trainers = must(await call('get', '/trainers'), '/trainers');
  const t = trainers.find(x => x.id === 'trn_dev') || trainers[0];
  must(await call('get', `/trainers/${t.id}`), 'trainer detail');
  return `${trainers.length} trainers`;
});
await check('booking: quote + my bookings', async () => {
  const q = await call('post', '/me/trainer-bookings/quote', { token: M, body: { trainerId: 'trn_dev', gymId: 'gym_dev_demo', date: today, slot: '09:00' }, expect: [200, 201, 400, 409] });
  must(await call('get', '/me/trainer-bookings', { token: M }), 'bookings');
  return `quote HTTP ${q.status}${q.status >= 400 ? ` (${q.json?.error})` : ''}`;
});
await check('subscription: tiers + passes + payments', async () => {
  must(await call('get', '/subscription-tiers'), 'tiers');
  must(await call('get', '/passes'), 'passes');
  must(await call('get', '/me/payments', { token: M }), 'payments');
  return 'ok';
});
let qr;
await check('passport: rotating QR', async () => {
  qr = must(await call('get', '/me/qr', { token: M }), '/me/qr');
  if (!(qr.token || qr.qrToken)) throw new Error('no QR token');
  return 'token issued';
});
await check('marketplace: products + my orders', async () => {
  const p = must(await call('get', '/shop/products', { token: M }), 'products');
  must(await call('get', '/me/shop-orders', { token: M }), 'orders');
  return `${(p.products ?? p).length ?? '?'} products`;
});
await check('messages: notifications + marketplace notifications', async () => {
  must(await call('get', '/me/notifications', { token: M }), 'notifications');
  must(await call('get', '/me/marketplace-notifications', { token: M }), 'marketplace notifications');
  return 'ok';
});
await check('profile: update and restore name', async () => {
  const before = must(await call('get', '/me', { token: M }), '/me').user?.displayName;
  must(await call('post', '/me/profile', { token: M, body: { displayName: 'Dev Member Smoke' } }), 'update');
  const after = must(await call('get', '/me', { token: M }), '/me').user?.displayName;
  must(await call('post', '/me/profile', { token: M, body: { displayName: before } }), 'restore');
  if (after !== 'Dev Member Smoke') throw new Error(`name not saved (${after})`);
  return 'saved and restored';
});
await check('activity: log manual, device refused, list, delete', async () => {
  const a = must(await call('post', '/me/activities', { token: M, body: { type: 'walking', startedAt: new Date(Date.now() - 3600_000).toISOString(), steps: 4321 } }), 'log');
  const fake = await call('post', '/me/activities', { token: M, body: { type: 'walking', source: 'device', startedAt: new Date().toISOString(), steps: 99999 }, expect: [400] });
  if (!fake.ok) throw new Error(`device source accepted (HTTP ${fake.status})`);
  const list = must(await call('get', '/me/activities', { token: M }), 'list');
  must(await call('delete', `/me/activities/${a.activity.id}`, { token: M }), 'delete');
  return `${list.activities.length} listed; device refused`;
});
let workoutId;
await check('workouts: templates, plan, start, complete', async () => {
  const tpl = must(await call('get', '/workouts/templates', { token: M }), 'templates');
  const first = (tpl.templates ?? tpl)[0];
  const w = must(await call('post', '/me/workouts', { token: M, body: { templateId: first.id, scheduledDate: today } }), 'create');
  workoutId = (w.workout ?? w).id;
  const started = must(await call('post', `/me/workouts/${workoutId}/start`, { token: M }), 'start');
  // Log the first set, as the session screen does.
  const ex = (started.workout ?? started).exercises[0];
  const set = ex.workoutSets[0];
  must(await call('post', `/me/workouts/${workoutId}/complete`, { token: M, body: {
    exercises: [{ id: ex.id, workoutSets: [{ id: set.id, completed: true, ...(set.reps != null ? { reps: set.reps } : {}) }] }],
  } }), 'complete');
  // Completing with nothing logged is refused.
  const empty = must(await call('post', '/me/workouts', { token: M, body: { templateId: first.id, scheduledDate: today } }), 'create 2');
  const emptyId = (empty.workout ?? empty).id;
  const refused = await call('post', `/me/workouts/${emptyId}/complete`, { token: M, body: {}, expect: [400] });
  must(await call('post', `/me/workouts/${emptyId}/skip`, { token: M }), 'skip');
  if (!refused.ok) throw new Error(`empty completion accepted (HTTP ${refused.status})`);
  return `completed ${first.id}`;
});
let goalId;
await check('goals: create, list, archive', async () => {
  const g = must(await call('post', '/me/goals', { token: M, body: { type: 'workouts', period: 'week', target: 4 } }), 'create');
  goalId = (g.goal ?? g).id;
  const list = must(await call('get', '/me/goals', { token: M }), 'list');
  must(await call('patch', `/me/goals/${goalId}`, { token: M, body: { status: 'archived' } }), 'archive');
  return `${(list.goals ?? list).length} goals`;
});
await check('progress: completed workout shows in activity history', async () => {
  const list = must(await call('get', '/me/activities', { token: M }), 'list');
  if (!list.activities.some(a => a.workoutId === workoutId)) throw new Error('workout activity missing');
  return 'workout counted';
});

// ── Gym owner ───────────────────────────────────────────────────────────
current = 'gym owner';
await check('dashboard: /operator/dashboard + /owner/gyms', async () => {
  must(await call('get', '/operator/dashboard', { token: O }), 'dashboard');
  must(await call('get', '/owner/gyms', { token: O }), 'gyms');
  return `gym ${ownerGymId}`;
});
await check('membership: members list + earnings', async () => {
  const m = must(await call('get', '/owner/members', { token: O }), 'members');
  must(await call('get', '/owner/earnings', { token: O }), 'earnings');
  return `${(m.members ?? m).length} members`;
});
await check('check-ins: verify QR, check in, same-day repeat free, listed', async () => {
  const token = qr?.token ?? qr?.qrToken;
  const verify = () => call('post', '/operator/verify-qr', { token: O, body: { qrToken: token, gymId: ownerGymId } });
  const v = must(await verify(), 'verify');
  // verify-qr only answers eligibility; POST /operator/checkins records it.
  const first = await call('post', '/operator/checkins', { token: O, body: { qrToken: token, gymId: ownerGymId }, expect: [200, 201, 400, 409] });
  if (v.eligible && first.status >= 300) throw new Error(`eligible but check-in failed: HTTP ${first.status} ${JSON.stringify(first.json)}`);
  const used = must(await verify(), 'verify 2').visitsUsed;
  // Same gym, same day: allowed and free (check-in-rules sameDaySameGym).
  must(await call('post', '/operator/checkins', { token: O, body: { qrToken: token, gymId: ownerGymId } }), 'repeat');
  const usedAfter = must(await verify(), 'verify 3').visitsUsed;
  if (usedAfter !== used) throw new Error(`same-day repeat consumed a visit (${used} → ${usedAfter})`);
  const list = must(await call('get', '/operator/checkins', { token: O }), 'list');
  return `eligible: ${v.eligible}; visits used ${used}, unchanged by repeat; ${(list.checkins ?? list).length ?? '?'} listed`;
});
let challengeId;
await check('challenges: create, member sees + joins, participants', async () => {
  const end = new Date(Date.now() + 6 * 86400_000).toISOString().slice(0, 10);
  const c = must(await call('post', `/owner/challenges?gymId=${ownerGymId}`, { token: O, body: { name: `Smoke ${Date.now()}`, type: 'gym_attendance', target: 3, startDate: today, endDate: end, rewards: [], visibility: 'public' } }), 'create');
  challengeId = (c.challenge ?? c).id;
  const mine = must(await call('get', '/me/challenges', { token: M }), 'member list');
  const seen = (mine.challenges ?? mine).some(x => x.id === challengeId);
  must(await call('post', `/challenges/${challengeId}/join`, { token: M, body: {} }), 'join');
  const p = must(await call('get', `/owner/challenges/${challengeId}/participants?gymId=${ownerGymId}`, { token: O }), 'participants');
  must(await call('post', `/owner/challenges/${challengeId}/cancel?gymId=${ownerGymId}`, { token: O }), 'cancel');
  return `visible to member: ${seen}; participants: ${(p.participants ?? []).length}`;
});
await check('member engagement: /owner/engagement', async () => {
  must(await call('get', `/owner/engagement?gymId=${ownerGymId}`, { token: O }), 'engagement');
  return 'ok';
});

// ── Trainer ─────────────────────────────────────────────────────────────
current = 'trainer';
await check('dashboard: profile, sessions, earnings', async () => {
  must(await call('get', '/trainer/me', { token: T }), 'me');
  must(await call('get', '/trainer/sessions', { token: T }), 'sessions');
  must(await call('get', '/trainer/earnings', { token: T }), 'earnings');
  return 'ok';
});
let relId;
await check('member relationships: request → accept', async () => {
  const existing = must(await call('get', '/me/trainer-connections', { token: M }), 'member connections');
  const open = (existing.connections ?? existing).find(c => c.trainerId === 'trn_dev' && ['pending', 'active'].includes(c.status));
  if (open) relId = open.id;
  else {
    const r = must(await call('post', '/trainers/trn_dev/connect', { token: M, body: { permissions: {} } }), 'connect');
    relId = (r.connection ?? r.relationship ?? r).id;
  }
  const clients = must(await call('get', '/trainer/clients', { token: T }), 'clients');
  const rel = (clients.clients ?? clients).find(c => c.id === relId);
  if (rel?.status === 'pending') must(await call('post', `/trainer/clients/${relId}/accept`, { token: T }), 'accept');
  return `relationship ${relId}`;
});
let planId;
await check('workout creation: trainer plan', async () => {
  const p = must(await call('post', '/trainer/plans', { token: T, body: { name: 'Smoke plan', activityType: 'strength', estimatedDuration: 40, exercises: [{ exerciseName: 'Goblet squat', muscleGroup: 'legs', sets: 3, reps: 10 }] } }), 'create plan');
  planId = (p.plan ?? p).id;
  return `plan ${planId}`;
});
await check('workout assignment: member receives it', async () => {
  must(await call('post', `/trainer/clients/${relId}/workouts`, { token: T, body: { planId, dates: [today] } }), 'assign');
  const w = must(await call('get', '/me/workouts', { token: M }), 'member workouts');
  const got = (w.workouts ?? w).some(x => x.trainerId && x.name === 'Smoke plan');
  if (!got) throw new Error('assigned workout not visible to member');
  return 'visible to member';
});
await check('authorized activity visibility: nothing shared, then steps only', async () => {
  // Updates merge, so revoking means sending every permission as false.
  const NONE = { steps: false, distance: false, activeMinutes: false, workoutHistory: false, workoutDetails: false, goals: false, streaks: false, challenges: false };
  must(await call('patch', `/me/trainer-connections/${relId}`, { token: M, body: { permissions: NONE } }), 'revoke');
  const off = must(await call('get', `/trainer/clients/${relId}`, { token: T }), 'client');
  const leaked = ['steps', 'distanceKm', 'activeMinutes', 'workouts'].filter(k => off.summary?.week?.[k] !== undefined);
  if (leaked.length || off.activity || off.goals) throw new Error(`visible without consent: ${[...leaked, off.activity && 'activity', off.goals && 'goals'].filter(Boolean)}`);
  must(await call('patch', `/me/trainer-connections/${relId}`, { token: M, body: { permissions: { steps: true } } }), 'share steps');
  const on = must(await call('get', `/trainer/clients/${relId}`, { token: T }), 'client');
  if (on.summary?.week?.steps === undefined) throw new Error('steps not visible after sharing');
  const extra = Object.keys(on.summary.week).filter(k => k !== 'steps');
  if (extra.length) throw new Error(`more than steps shared: ${extra}`);
  must(await call('patch', `/me/trainer-connections/${relId}`, { token: M, body: { permissions: NONE } }), 'reset');
  return 'nothing without consent; steps only once shared';
});
await check('messaging: send reminder route answers', async () => {
  const r = await call('post', `/trainer/send-message/${memberId}`, { token: T, body: { message: 'Smoke test' }, expect: [200, 201, 400, 403, 404, 503] });
  if (r.status >= 500 && r.status !== 503) throw new Error(`HTTP ${r.status}`);
  return `HTTP ${r.status}${r.json?.error ? ` (${r.json.error})` : ''}`;
});

// ── Vendor (marketplace messaging) ──────────────────────────────────────
current = 'vendor';
await check('member enquiry → vendor reply → member notified', async () => {
  const prods = must(await call('get', '/vendor/products', { token: V }), 'vendor products');
  const prod = (prods.products ?? prods)[0];
  const e = must(await call('post', '/me/marketplace-enquiries', { token: M, body: { productId: prod?.id, vendorId: sessions.vendor.user.id, message: 'Smoke: is this in stock?' } }), 'enquiry');
  const id = (e.enquiry ?? e).id;
  must(await call('post', `/vendor/enquiries/${id}/reply`, { token: V, body: { message: 'Yes, in stock.' } }), 'reply');
  const n = must(await call('get', '/me/marketplace-notifications', { token: M }), 'notifications');
  must(await call('post', `/vendor/enquiries/${id}/resolve`, { token: V }), 'resolve');
  return `${(n.notifications ?? n).length} notifications`;
});

// ── Corporate ───────────────────────────────────────────────────────────
current = 'corporate';
// An HR user if one exists ("userId:corporateId"), otherwise a super-admin
// acting for a company (?corporateId=), which the corporate routes allow.
const hr = process.env.SMOKE_CORPORATE_HR;
let corpId = hr ? hr.split(':')[1] : process.env.SMOKE_CORPORATE_ID;
const ADMIN = sign({ sub: process.env.SMOKE_ADMIN_ID || 'usr_admin_1', userType: 'admin' });
if (!corpId) {
  // No company in this database: onboard a throwaway one (local only).
  await check('onboard a test company (admin)', async () => {
    const a = must(await call('post', '/admin/corporate', { token: ADMIN, body: {
      companyName: `Smoke Co ${Date.now()}`, industrySector: 'banking', workforceBracket: '50-100',
      subsidyModel: 'copay_70_30', passTier: 'pro', billingCycle: 'monthly', seatLimit: 20,
      domainWhitelist: ['smoke.example'], objectives: ['reduce_absenteeism'],
    } }), 'onboard');
    corpId = a.id;
    return corpId;
  });
}
if (!corpId) {
  results.push({ area: current, name: 'corporate checks skipped: no company', ok: false, detail: '' });
} else {
  const C = hr
    ? sign({ sub: hr.split(':')[0], userType: 'corporate_hr', corporateId: corpId })
    : ADMIN;
  const q = hr ? '' : `?corporateId=${encodeURIComponent(corpId)}`;
  await check(`dashboard, staff, billing, reference (${hr ? 'HR user' : 'admin for company'})`, async () => {
    must(await call('get', `/corporate/dashboard${q}`, { token: C }), 'dashboard');
    const s = must(await call('get', `/corporate/staff${q}`, { token: C }), 'staff');
    must(await call('get', `/corporate/billing${q}`, { token: C }), 'billing');
    must(await call('get', `/corporate/reference${q}`, { token: C }), 'reference');
    return `${(s.staff ?? s.employees ?? s).length ?? '?'} staff`;
  });
  await check('corporate challenges list', async () => {
    must(await call('get', `/corporate/challenges${q}`, { token: C }), 'challenges');
    return 'ok';
  });
  await check('member is refused corporate routes', async () => {
    const r = await call('get', '/corporate/dashboard', { token: M, expect: [401, 403] });
    if (!r.ok) throw new Error(`member got HTTP ${r.status}`);
    return `HTTP ${r.status}`;
  });
}

// ── Report ──────────────────────────────────────────────────────────────
let area = '';
for (const r of results) {
  if (r.area !== area) { area = r.area; console.log(`\n${area.toUpperCase()}`); }
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
