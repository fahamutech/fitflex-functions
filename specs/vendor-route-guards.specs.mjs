// Route guards as bfast-function really mounts them: app.use(path, onGuard) for every guard (method
// ignored, path matched as a prefix), then app[method](path, onRequest). UAT 2026-10-19: vendor staff
// got 403 {"requiredRoles":["vendor","admin"]} on GET /vendor/profile because the PUT guard ran on GET.
// Against the CI database (staff permissions are read from the User row).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

await ensureInit();

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = [];

// ── routeGuard, unit ─────────────────────────────────────────────────────────

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const deny = (req, res) => { res.status(403).json({ error: 'denied' }); };
const pass = (req, res, next) => next();
async function run(guard, req) {
  const res = fakeRes();
  let passed = true;
  for (const g of [guard].flat()) {
    let next = false;
    await g(req, res, () => { next = true; });
    if (!next) { passed = false; break; }
  }
  return { passed, status: res.statusCode, body: res.body };
}

test('routeGuard: runs only for its own method (GET also covers HEAD); other methods pass through untouched', async () => {
  const g = routeGuard('put', deny);
  assert.equal((await run(g, { method: 'GET', baseUrl: '/vendor/profile', path: '/' })).passed, true);
  assert.equal((await run(g, { method: 'POST', baseUrl: '/vendor/profile', path: '/' })).passed, true);
  assert.deepEqual(await run(g, { method: 'PUT', baseUrl: '/vendor/profile', path: '/' }), { passed: false, status: 403, body: { error: 'denied' } });
  const r = routeGuard('get', deny);
  assert.equal((await run(r, { method: 'HEAD', baseUrl: '/x', path: '/' })).passed, false, 'HEAD is answered by the GET route');
  assert.equal((await run(r, { method: 'get', baseUrl: '/x', path: '/' })).passed, false, 'method case does not matter');
});

test('routeGuard: under app.use(path) it skips sub-paths (they have their own route and guard)', async () => {
  const g = routeGuard('get', deny);
  assert.equal((await run(g, { method: 'GET', baseUrl: '/vendor/payments', path: '/statement' })).passed, true);
  assert.equal((await run(g, { method: 'GET', baseUrl: '/vendor/payments', path: '/' })).passed, false);
});

test('routeGuard: fails closed — no method, or not mounted under a path prefix, runs the guard', async () => {
  const g = routeGuard('put', deny);
  assert.equal((await run(g, {})).passed, false, 'no method (a spec calling the guard directly)');
  assert.equal((await run(g, { method: 'PUT', baseUrl: '', path: '/vendor/profile/anything' })).passed, false, 'mounted per route: path is the full path');
  assert.throws(() => routeGuard('', pass), /method is required/);
  assert.throws(() => routeGuard('get'), /guards must be functions/);
  assert.throws(() => routeGuard('get', [pass, 'nope']), /guards must be functions/);
});

test('routeGuard: keeps the shape it is given (a function stays a function, an array stays an array in order) and returns what the guard returns', async () => {
  assert.equal(typeof routeGuard('get', pass), 'function');
  const arr = routeGuard('post', [pass, deny]);
  assert.ok(Array.isArray(arr));
  assert.deepEqual(arr.map(g => g.guard), [pass, deny]);
  assert.deepEqual(arr[0].routeMethods, ['POST']);
  let finished = false;
  const slow = async (req, res, next) => { await new Promise(r => setTimeout(r, 5)); finished = true; next(); };
  await routeGuard('get', slow)({ method: 'GET' }, fakeRes(), () => {});
  assert.equal(finished, true, 'an async guard is awaited by whoever awaits the wrapper');
  await assert.rejects(routeGuard('get', async () => { throw new Error('boom'); })({ method: 'GET' }, fakeRes(), () => {}), /boom/);
});

// ── every function module mounted as bfast-function mounts it ────────────────

const functionsDir = path.join(root, 'functions');
const functions = {};
for (const file of fs.readdirSync(functionsDir).filter(f => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
  const mod = await import(path.join(functionsDir, file));
  for (const [name, d] of Object.entries(mod)) if (d && typeof d === 'object' && (d.onRequest || d.onGuard)) functions[`${file}:${name}`] = d;
}
const guarded = Object.keys(functions).filter(k => functions[k].onGuard);
const http = Object.keys(functions).filter(k => functions[k].onRequest);

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
const servers = [];
function listen(app) {
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const realUrl = listen(real);
const stubUrl = listen(stubbed);

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

async function user(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Guard ${userType}`, updatedAt: new Date(), ...extra });
  made.push(id);
  return id;
}
const PERMS = ['products', 'orders', 'customers', 'reports', 'payments', 'staff'];
const staff = (vendorId, permissions, accountStatus = 'active') => user('vendor_staff', { vendorId, vendorPermissions: permissions, accountStatus, vendorRole: 'staff' });
const vendorClaims = id => ({ sub: id, userType: 'vendor' });
const staffClaims = (id, vendorId) => ({ sub: id, userType: 'vendor_staff', vendorId });

after(async () => {
  for (const s of servers) s.close();
  if (made.length) await db('User').whereIn('id', made).del();
  await db.destroy();
});

test('GET /vendor/profile: any active staff member of the vendor reads the profile (no permission needed); PUT stays vendor/admin only', async () => {
  const vendorId = await user('vendor', { vendorProfile: JSON.stringify({ businessName: 'Guarded Gear', status: 'published' }) });
  const noPerms = await staff(vendorId, []);
  const ordersOnly = await staff(vendorId, ['orders']);

  for (const id of [noPerms, ordersOnly]) {
    const got = await hit(realUrl, 'GET', '/vendor/profile', staffClaims(id, vendorId));
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.businessName, 'Guarded Gear', 'staff see their vendor\'s profile, not their own record');
  }
  // PUT: staff still refused, by the PUT guard.
  const put = await hit(realUrl, 'PUT', '/vendor/profile', staffClaims(noPerms, vendorId), { businessName: 'Hijacked' });
  assert.deepEqual([put.status, put.body], [403, { error: 'forbidden', requiredRoles: ['vendor', 'admin'] }]);
  const allPerms = await staff(vendorId, PERMS);
  assert.equal((await hit(realUrl, 'PUT', '/vendor/profile', staffClaims(allPerms, vendorId), { businessName: 'Hijacked' })).status, 403, 'not even with every permission');
  assert.equal(JSON.parse(JSON.stringify((await db('User').where({ id: vendorId }).first()).vendorProfile)).businessName, 'Guarded Gear');
  // The vendor reads and writes as before.
  assert.equal((await hit(realUrl, 'GET', '/vendor/profile', vendorClaims(vendorId))).body.businessName, 'Guarded Gear');
  const saved = await hit(realUrl, 'PUT', '/vendor/profile', vendorClaims(vendorId), { businessName: 'Guarded Gear 2' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await hit(realUrl, 'GET', '/vendor/profile', staffClaims(noPerms, vendorId))).body.businessName, 'Guarded Gear 2');
  // Members and anonymous callers: as before.
  assert.equal((await hit(realUrl, 'GET', '/vendor/profile', { sub: uid('m'), userType: 'member' })).status, 403);
  assert.equal((await hit(realUrl, 'GET', '/vendor/profile', null)).status, 401);
});

test('GET /vendor/profile: suspended staff, staff whose token names another vendor, and unknown staff are refused', async () => {
  const vendorId = await user('vendor', { vendorProfile: JSON.stringify({ businessName: 'Secret Shop' }) });
  const otherVendor = await user('vendor');
  const suspended = await staff(vendorId, PERMS, 'suspended');
  const moved = await staff(otherVendor, PERMS);
  const s = await hit(realUrl, 'GET', '/vendor/profile', staffClaims(suspended, vendorId));
  assert.equal(s.status, 403);
  assert.ok(['account_suspended', 'vendor_staff_inactive'].includes(s.body.error), JSON.stringify(s.body));
  const m = await hit(realUrl, 'GET', '/vendor/profile', staffClaims(moved, vendorId));
  assert.deepEqual([m.status, m.body], [403, { error: 'vendor_staff_inactive' }]);
  const ghost = await hit(realUrl, 'GET', '/vendor/profile', staffClaims(uid('ghost'), vendorId));
  assert.deepEqual([ghost.status, ghost.body], [403, { error: 'vendor_staff_inactive' }]);
});

test('GET /vendor/staff: staff with the `staff` permission may list (was blocked by the POST guard); creating and disabling staff stays vendor/admin only', async () => {
  const vendorId = await user('vendor');
  const lead = await staff(vendorId, ['staff']);
  const clerk = await staff(vendorId, ['orders']);
  const list = await hit(realUrl, 'GET', '/vendor/staff', staffClaims(lead, vendorId));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.map(s => s.id).sort(), [lead, clerk].sort());
  assert.ok(list.body.every(s => !('passwordHash' in s)));
  const noPerm = await hit(realUrl, 'GET', '/vendor/staff', staffClaims(clerk, vendorId));
  assert.deepEqual([noPerm.status, noPerm.body], [403, { error: 'vendor_permission_forbidden', requiredPermission: 'staff' }]);
  const create = await hit(realUrl, 'POST', '/vendor/staff', staffClaims(lead, vendorId), { name: 'X', email: 'x@example.com', phone: '+255700000001', password: 'secret123', role: 'staff' });
  assert.deepEqual([create.status, create.body], [403, { error: 'forbidden', requiredRoles: ['vendor', 'admin'] }]);
  const disable = await hit(realUrl, 'POST', `/vendor/staff/${clerk}/disable`, staffClaims(lead, vendorId));
  assert.equal(disable.status, 403);
  assert.equal((await db('User').where({ id: clerk }).first()).accountStatus, 'active');
});

test('GET /vendor/payments/statement: staff with `reports` only may read it (was blocked by the /vendor/payments guard); /vendor/payments still needs `payments`', async () => {
  const vendorId = await user('vendor');
  const analyst = await staff(vendorId, ['reports']);
  const statement = await hit(stubUrl, 'GET', '/vendor/payments/statement', staffClaims(analyst, vendorId));
  assert.equal(statement.status, 200, JSON.stringify(statement.body));
  const payments = await hit(stubUrl, 'GET', '/vendor/payments', staffClaims(analyst, vendorId));
  assert.deepEqual([payments.status, payments.body], [403, { error: 'vendor_permission_forbidden', requiredPermission: 'payments' }]);
});

test('vendor product writes keep the admin `shop` scope they had (now on their own guard, not borrowed from GET /vendor/products)', async () => {
  const noScope = { sub: uid('adm'), userType: 'admin', portalUser: true, aclPermissions: ['members'] };
  const shop = { sub: uid('adm'), userType: 'admin', portalUser: true, aclPermissions: ['shop'] };
  for (const [method, url] of [['POST', '/vendor/products'], ['PUT', '/vendor/products/p1'], ['DELETE', '/vendor/products/p1'], ['POST', '/vendor/products/p1/duplicate']]) {
    const denied = await hit(stubUrl, method, url, noScope, method === 'DELETE' ? undefined : {});
    assert.deepEqual([denied.status, denied.body], [403, { error: 'acl_forbidden', requiredScope: 'shop' }], `${method} ${url}`);
    assert.equal((await hit(stubUrl, method, url, shop, method === 'DELETE' ? undefined : {})).status, 200, `${method} ${url}`);
  }
});

test('every shop.mjs route: as mounted by bfast-function, it lets in exactly who its own guard lets in', async () => {
  const vendorId = await user('vendor');
  const staffIds = {};
  for (const p of PERMS) staffIds[p] = await staff(vendorId, [p]);
  staffIds.none = await staff(vendorId, []);
  staffIds.all = await staff(vendorId, PERMS);
  const principals = [
    ['anon', null],
    ['member', { sub: uid('m'), userType: 'member' }],
    ['trainer', { sub: uid('t'), userType: 'trainer' }],
    ['gym_operator', { sub: uid('g'), userType: 'gym_operator' }],
    ['vendor', vendorClaims(vendorId)],
    ['admin', { sub: uid('a'), userType: 'admin' }],
    ['admin[shop]', { sub: uid('a'), userType: 'admin', portalUser: true, aclPermissions: ['shop'] }],
    ['admin[payments]', { sub: uid('a'), userType: 'admin', portalUser: true, aclPermissions: ['payments'] }],
    ['admin[members]', { sub: uid('a'), userType: 'admin', portalUser: true, aclPermissions: ['members'] }],
    ...Object.entries(staffIds).map(([p, id]) => [`vendor_staff[${p}]`, staffClaims(id, vendorId)]),
  ];
  // Reference: the same routes with nothing but their own guards, mounted per route and method.
  const own = express();
  for (const k of http) {
    const d = functions[k];
    if (d.path) own[(d.method || 'all').toLowerCase()](d.path, ...[d.onGuard].flat().filter(Boolean), (_req, res) => res.status(200).json({ route: k }));
  }
  const ownUrl = listen(own);
  const shopRoutes = http.filter(k => k.startsWith('shop.mjs:') && functions[k].path);
  assert.ok(shopRoutes.length >= 40, `found ${shopRoutes.length} shop routes`);
  const mismatches = [];
  for (const k of shopRoutes) {
    const d = functions[k];
    const method = (d.method || 'get').toUpperCase();
    const url = d.path.replace(/:[A-Za-z0-9_]+/g, 'p1');
    for (const [name, claims] of principals) {
      const body = ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : {};
      const [mounted, alone] = await Promise.all([hit(stubUrl, method, url, claims, body), hit(ownUrl, method, url, claims, body)]);
      if ((mounted.status === 200) !== (alone.status === 200)) mismatches.push(`${method} ${d.path} as ${name}: mounted ${mounted.status} ${JSON.stringify(mounted.body)} / own ${alone.status}`);
    }
  }
  assert.deepEqual(mismatches, []);
});
