// Route guards as bfast-function really mounts them: app.use(path, onGuard) for every guard (method
// ignored, path matched as a prefix), then app[method](path, onRequest). A guard on one route also
// ran on its siblings and sub-paths, so callers its own guard lets in were refused (lockouts listed
// in #193's audit, items 1 and 5-11). Each route now admits exactly who its own guard admits.
// Against the CI database (gym staff rows and gym memberships are read from it).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { gyms, gymService } from '../src/bootstrap/services.mjs';
import { ensureInit } from '../functions/index.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

await ensureInit();

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
// Modules whose guards leaked onto other routes (now wrapped with routeGuard).
const WRAPPED = ['admin-settings.mjs', 'promotions.mjs', 'refunds.mjs', 'subscriptions.mjs', 'admin-members.mjs', 'owner-members.mjs', 'owner-gyms.mjs'];
// Modules whose routes were locked out by those guards (unchanged themselves).
const AFFECTED = [...WRAPPED, 'promotion-events.mjs', 'checkins.mjs', 'communications.mjs', 'gym-sharing.mjs'];

const functionsDir = path.join(root, 'functions');
const functions = {};
for (const file of fs.readdirSync(functionsDir).filter(f => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
  const mod = await import(path.join(functionsDir, file));
  for (const [name, d] of Object.entries(mod)) if (d && typeof d === 'object' && (d.onRequest || d.onGuard)) functions[`${file}:${name}`] = d;
}
const guarded = Object.keys(functions).filter(k => functions[k].onGuard);
const http = Object.keys(functions).filter(k => functions[k].onRequest);
const fileOf = k => k.split(':')[0];

/** The real server: every guard and every real handler. */
const real = express();
real.use(express.json());
mountGuards(guarded, functions, real);
mountHttpRoutes(http, functions, real);
/** Same guards, but each handler only says which route it is (no side effects). */
const stubbed = express();
mountGuards(guarded, functions, stubbed);
for (const k of http) {
  const d = functions[k];
  if (d.path) stubbed[(d.method || 'all').toLowerCase()](d.path, (_req, res) => res.status(200).json({ route: k }));
}
/** Reference: the same routes with nothing but their own guards, mounted per route and method. */
const own = express();
for (const k of http) {
  const d = functions[k];
  if (d.path) own[(d.method || 'all').toLowerCase()](d.path, ...[d.onGuard].flat().filter(Boolean), (_req, res) => res.status(200).json({ route: k }));
}
const servers = [];
function listen(app) {
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const realUrl = listen(real);
const stubUrl = listen(stubbed);
const ownUrl = listen(own);

async function hit(base, method, url, claims, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const made = { users: [], gyms: [] };
async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Guard ${userType}`, updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function gym() {
  const id = uid('gym');
  await gyms.upsertAsync(g => g.id === id, gymService.normalizeGymPayload({ id, name: `Guard Gym ${id}`, tier: 'standard', location: 'Masaki' }, {}));
  made.gyms.push(id);
  return id;
}
/** An active gym membership (what org-authz reads when V2_ORG_AUTHZ is on). */
async function membership(personaId, gymId, role, acl) {
  await db('Person').insert({ id: personaId, updatedAt: new Date() }).onConflict('id').ignore();
  await db('OrgMembership').insert({ id: uid('om'), personId: personaId, personaId, orgType: 'gym', gymId, role, status: 'active', aclPermissions: acl, source: 'sync', updatedAt: new Date() });
}
const staffClaims = (id, acl) => ({ sub: id, userType: 'gym_staff', aclPermissions: acl });
const portal = scopes => ({ sub: uid('adm'), userType: 'admin', portalUser: true, aclPermissions: scopes });
const acl = scope => ({ error: 'acl_forbidden', requiredScope: scope });

async function withAuthzMode(mode, fn) {
  const saved = { IDENTITY_V2: process.env.IDENTITY_V2, V2_ORG_AUTHZ: process.env.V2_ORG_AUTHZ };
  Object.assign(process.env, mode === 'enforce' ? { IDENTITY_V2: '1', V2_ORG_AUTHZ: '1' } : { IDENTITY_V2: '', V2_ORG_AUTHZ: '' });
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

after(async () => {
  for (const s of servers) s.close();
  await db('OrgMembership').whereIn('personaId', made.users).del();
  await db('Person').whereIn('id', made.users).del();
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  if (made.users.length) {
    await db('AuditLog').whereIn('actor', made.users).del();
    await db('User').whereIn('id', made.users).del();
  }
  await db.destroy();
});

test('every guard in the wrapped modules runs only for its own route\'s method', () => {
  const routes = http.filter(k => WRAPPED.includes(fileOf(k)) && functions[k].path);
  assert.ok(routes.length >= 60, `found ${routes.length} routes`);
  for (const k of routes) {
    const d = functions[k];
    for (const g of [d.onGuard].flat().filter(Boolean)) {
      assert.ok(Array.isArray(g.routeMethods), `${k}: guard not wrapped with routeGuard`);
      assert.ok(g.routeMethods.includes(d.method.toUpperCase()), `${k}: guard scoped to ${g.routeMethods} not ${d.method}`);
    }
  }
});

test('every affected route: as mounted by bfast-function it lets in exactly who its own guard lets in (org-authz off and enforce; token and DB-backed gym staff)', async () => {
  const gymId = await gym();
  const ownerId = await user('gym_operator', { gymIds: [gymId] });
  await membership(ownerId, gymId, 'owner', []);
  const principals = [
    ['anon', null],
    ...['member', 'trainer', 'gym_operator', 'vendor', 'vendor_staff', 'corporate_hr', 'admin'].map(t => [t, { sub: uid(t), userType: t }]),
    ['db:gym_operator+owner-membership', { sub: ownerId, userType: 'gym_operator' }],
    ['admin[]', portal([])],
    ...['settings', 'members', 'communications', 'payments', 'promotions', 'promotions_approve', 'campaigns', 'promotion_analytics', 'gyms'].map(s => [`admin[${s}]`, portal([s])]),
    ['gym_staff[]', staffClaims(uid('gs'), [])],
  ];
  for (const s of ['checkins', 'members', 'gyms', 'payments', 'trainers', 'communications']) {
    principals.push([`gym_staff[${s}]`, staffClaims(uid('gs'), [s])]);
    const withRow = await user('gym_staff', { gymId, gymIds: [gymId], aclPermissions: [s] });
    await membership(withRow, gymId, 'staff', [s]);
    principals.push([`db:gym_staff[${s}]+membership[${s}]`, staffClaims(withRow, [s])]);
    const lateToken = await user('gym_staff', { gymId, gymIds: [gymId], aclPermissions: [s] });
    await membership(lateToken, gymId, 'staff', [s]);
    principals.push([`db:gym_staff[]+membership[${s}]`, staffClaims(lateToken, [])]);
  }
  const routes = http.filter(k => AFFECTED.includes(fileOf(k)) && functions[k].path);
  const mismatches = [];
  for (const mode of ['off', 'enforce']) {
    await withAuthzMode(mode, async () => {
      for (const k of routes) {
        const d = functions[k];
        const method = (d.method || 'get').toUpperCase();
        const url = d.path.replace(/:[A-Za-z0-9_]+/g, 'p1');
        const body = ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : {};
        for (const [name, claims] of principals) {
          const [mounted, alone] = await Promise.all([hit(stubUrl, method, url, claims, body), hit(ownUrl, method, url, claims, body)]);
          if ((mounted.status === 200) !== (alone.status === 200)) mismatches.push(`${mode} ${method} ${d.path} as ${name}: mounted ${mounted.status} ${JSON.stringify(mounted.body)} / own ${alone.status}`);
        }
      }
    });
  }
  assert.deepEqual(mismatches, []);
});

// 1
test('GET /admin/settings/specialties: any admin reads it (was also `settings`); adding and removing still need `settings`', async () => {
  const members = portal(['members']);
  const got = await hit(realUrl, 'GET', '/admin/settings/specialties', members);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.deepEqual(await hit(realUrl, 'POST', '/admin/settings/specialties', members, { name: 'x' }), { status: 403, body: acl('settings') });
  assert.deepEqual(await hit(realUrl, 'DELETE', '/admin/settings/specialties/x', members), { status: 403, body: acl('settings') });
  assert.deepEqual(await hit(realUrl, 'GET', '/admin/settings', members), { status: 403, body: acl('settings') });
  assert.equal((await hit(realUrl, 'GET', '/admin/settings/specialties', { sub: uid('m'), userType: 'member' })).status, 403);
});

// 5, 6
test('promotions: lists and /:id open to promotions, promotions_approve or campaigns; approve/reject/schedule/activate need promotions_approve only; analytics need promotion_analytics only; GET /admin/geo-areas any viewer', async () => {
  for (const scope of ['promotions', 'promotions_approve', 'campaigns']) {
    for (const url of ['/admin/promotions', '/admin/promotion-campaigns', '/admin/geo-areas']) {
      const got = await hit(realUrl, 'GET', url, portal([scope]));
      assert.equal(got.status, 200, `${url} as ${scope}: ${JSON.stringify(got.body)}`);
    }
    for (const url of [`/admin/promotions/${uid('none')}`, `/admin/promotion-campaigns/${uid('none')}`]) {
      const got = await hit(realUrl, 'GET', url, portal([scope]));
      assert.equal(got.status, 404, `${url} as ${scope} reaches the handler: ${JSON.stringify(got.body)}`);
    }
  }
  const approver = portal(['promotions_approve']);
  for (const action of ['approve', 'reject', 'schedule', 'activate']) {
    const got = await hit(realUrl, 'POST', `/admin/promotions/${uid('none')}/${action}`, approver, { reason: 'spec' });
    assert.equal(got.status, 404, `${action} reaches the handler: ${JSON.stringify(got.body)}`);
    assert.deepEqual(await hit(realUrl, 'POST', `/admin/promotions/${uid('none')}/${action}`, portal(['promotions']), { reason: 'spec' }), { status: 403, body: acl('promotions_approve') });
  }
  // Writes keep their own scopes.
  assert.deepEqual(await hit(realUrl, 'POST', '/admin/promotions', approver, {}), { status: 403, body: acl('promotions') });
  assert.deepEqual(await hit(realUrl, 'PATCH', `/admin/promotions/${uid('none')}`, approver, {}), { status: 403, body: acl('promotions') });
  assert.deepEqual(await hit(realUrl, 'POST', `/admin/promotions/${uid('none')}/submit`, approver, {}), { status: 403, body: acl('promotions') });
  assert.deepEqual(await hit(realUrl, 'POST', '/admin/geo-areas', portal(['promotions']), {}), { status: 403, body: acl('campaigns') });
  assert.deepEqual(await hit(realUrl, 'POST', '/admin/promotion-campaigns', portal(['promotions']), {}), { status: 403, body: acl('campaigns') });
  // Analytics.
  const analyst = portal(['promotion_analytics']);
  for (const url of [`/admin/promotions/${uid('none')}/analytics`, `/admin/promotion-campaigns/${uid('none')}/analytics`]) {
    const got = await hit(realUrl, 'GET', url, analyst);
    assert.notEqual(got.status, 403, `${url}: ${JSON.stringify(got.body)}`);
    assert.notEqual(got.status, 401);
  }
  assert.deepEqual(await hit(realUrl, 'GET', `/admin/promotions/${uid('none')}`, analyst), { status: 403, body: acl('promotions') });
  assert.deepEqual(await hit(realUrl, 'GET', `/admin/promotions/${uid('none')}/analytics`, portal(['promotions'])), { status: 403, body: acl('promotion_analytics') });
});

// 7
test('GET /me/refunds: any signed-in user reads their own refunds (was members only); asking for a refund stays member-only', async () => {
  for (const userType of ['member', 'trainer', 'gym_operator', 'gym_staff', 'vendor', 'admin', 'corporate_hr']) {
    const id = await user(userType);
    const got = await hit(realUrl, 'GET', '/me/refunds', { sub: id, userType });
    assert.equal(got.status, 200, `${userType}: ${JSON.stringify(got.body)}`);
    if (userType !== 'member') {
      const ask = await hit(realUrl, 'POST', '/me/refunds', { sub: id, userType }, {});
      assert.deepEqual([ask.status, ask.body.error], [403, 'forbidden'], userType);
    }
  }
  assert.equal((await hit(realUrl, 'GET', '/me/refunds', null)).status, 401);
});

// 8
test('POST /me/checkins/scan: trainers reach the scan (was refused by the member-only GET /me/checkins guard); GET /me/checkins stays member-only', async () => {
  const trainerId = await user('trainer');
  const scan = await hit(realUrl, 'POST', '/me/checkins/scan', { sub: trainerId, userType: 'trainer' }, {});
  assert.notEqual(scan.status, 403, JSON.stringify(scan.body));
  assert.notDeepEqual(scan.body, { error: 'forbidden', requiredRoles: ['member'] });
  assert.equal((await hit(stubUrl, 'POST', '/me/checkins/scan', { sub: trainerId, userType: 'trainer' }, {})).status, 200);
  assert.deepEqual(await hit(realUrl, 'GET', '/me/checkins', { sub: trainerId, userType: 'trainer' }), { status: 403, body: { error: 'forbidden', requiredRoles: ['member'] } });
  for (const userType of ['gym_operator', 'vendor', 'admin']) {
    assert.equal((await hit(realUrl, 'POST', '/me/checkins/scan', { sub: uid('x'), userType }, {})).status, 403, userType);
  }
});

// 9
test('member communications: admin needs `communications` only (not `members`); gym staff need `communications` only, and still see only members their gyms know', async () => {
  // The handler re-reads the admin's account and scopes, so this one is a real row.
  const adminId = await user('admin', { portalUser: true, aclPermissions: ['communications'] });
  const comms = { sub: adminId, userType: 'admin', portalUser: true, aclPermissions: ['communications'] };
  const got = await hit(realUrl, 'GET', `/admin/members/${uid('m')}/communications`, comms);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.deepEqual(await hit(realUrl, 'GET', `/admin/members/${uid('m')}/payments`, comms), { status: 403, body: acl('members') });

  const gymId = await gym();
  const staffId = await user('gym_staff', { gymId, gymIds: [gymId], aclPermissions: ['communications'] });
  const stranger = await hit(realUrl, 'GET', `/owner/members/${uid('m')}/communications`, staffClaims(staffId, ['communications']));
  assert.deepEqual([stranger.status, stranger.body.error], [403, 'not_your_member'], 'reaches the handler, which still scopes to the gym\'s members');
  assert.deepEqual(await hit(realUrl, 'GET', `/owner/members/${uid('m')}`, staffClaims(staffId, ['communications'])), { status: 403, body: acl('members') });
  const membersOnly = await user('gym_staff', { gymId, gymIds: [gymId], aclPermissions: ['members'] });
  assert.deepEqual(await hit(realUrl, 'GET', `/owner/members/${uid('m')}/communications`, staffClaims(membersOnly, ['members'])), { status: 403, body: acl('communications') });
});

// 10
test('owner gyms: any gym staff lists their gyms (no `gyms` needed); check-ins of a gym need `checkins` only and still only for their own gym; gym writes keep `gyms`', async () => {
  const gymId = await gym();
  const otherGym = await gym();
  const plain = await user('gym_staff', { gymId, gymIds: [gymId], aclPermissions: [] });
  const list = await hit(realUrl, 'GET', '/owner/gyms', staffClaims(plain, []));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(await hit(realUrl, 'POST', '/owner/gyms', staffClaims(plain, []), {}), { status: 403, body: acl('gyms') });
  assert.deepEqual(await hit(realUrl, 'PUT', `/owner/gyms/${gymId}`, staffClaims(plain, []), {}), { status: 403, body: acl('gyms') });

  const desk = await user('gym_staff', { gymId, gymIds: [gymId], aclPermissions: ['checkins'] });
  const mine = await hit(realUrl, 'GET', `/owner/gyms/${gymId}/checkins`, staffClaims(desk, ['checkins']));
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.ok(Array.isArray(mine.body));
  assert.deepEqual(await hit(realUrl, 'GET', `/owner/gyms/${otherGym}/checkins`, staffClaims(desk, ['checkins'])), { status: 403, body: { error: 'not_your_gym' } });
  assert.deepEqual(await hit(realUrl, 'GET', `/owner/gyms/${gymId}/checkins`, staffClaims(plain, [])), { status: 403, body: acl('checkins') });
});

// 11
test('POST /owner/members/:memberId/checkin: `checkins` staff reach it without `members` (off: token scope; enforce: membership scope); other member routes keep `members`', async () => {
  const gymId = await gym();
  const desk = await user('gym_staff', { gymId, gymIds: [gymId], aclPermissions: ['checkins'] });
  await membership(desk, gymId, 'staff', ['checkins']);
  const lateToken = await user('gym_staff', { gymId, gymIds: [gymId], aclPermissions: ['checkins'] });
  await membership(lateToken, gymId, 'staff', ['checkins']);
  const url = `/owner/members/${uid('m')}/checkin`;

  await withAuthzMode('off', async () => {
    const got = await hit(realUrl, 'POST', url, staffClaims(desk, ['checkins']), { gymId });
    assert.notEqual(got.status, 403, JSON.stringify(got.body));
    assert.deepEqual(await hit(realUrl, 'POST', url, staffClaims(lateToken, []), { gymId }), { status: 403, body: acl('checkins') });
    assert.deepEqual(await hit(realUrl, 'GET', `/owner/members/${uid('m')}`, staffClaims(desk, ['checkins'])), { status: 403, body: acl('members') });
  });
  await withAuthzMode('enforce', async () => {
    for (const [id, claims] of [[desk, ['checkins']], [lateToken, []]]) {
      const got = await hit(realUrl, 'POST', url, staffClaims(id, claims), { gymId });
      assert.notEqual(got.status, 403, JSON.stringify(got.body));
    }
    // A token claiming `checkins` without an active membership is still refused under enforce.
    assert.deepEqual(await hit(realUrl, 'POST', url, staffClaims(uid('gs'), ['checkins']), { gymId }), { status: 403, body: acl('checkins') });
  });
  assert.deepEqual(await hit(realUrl, 'POST', url, staffClaims(desk, ['members']), { gymId }), { status: 403, body: acl('checkins') });
});

test('GET /owner/members/:memberId/activity follows its own (legacy, token) guard in every org-authz mode; owner-members\' membership check no longer runs on it', async () => {
  // Under V2_ORG_AUTHZ enforce it used to need an active `members` membership too (borrowed from
  // GET /owner/members/:memberId). IDENTITY_AUTHZ_MIGRATION.md lists gym sharing as not migrated.
  const tokenOnly = staffClaims(uid('gs'), ['members']);
  for (const mode of ['off', 'enforce']) {
    await withAuthzMode(mode, async () => {
      assert.equal((await hit(stubUrl, 'GET', `/owner/members/${uid('m')}/activity`, tokenOnly)).status, 200, mode);
      assert.deepEqual(await hit(stubUrl, 'GET', `/owner/members/${uid('m')}/activity`, staffClaims(uid('gs'), ['checkins'])), { status: 403, body: acl('members') }, mode);
    });
  }
});
