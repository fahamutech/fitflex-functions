// Marathon & running events · S5 — bfast mounts every `onGuard` with a METHOD-BLIND PREFIX match (app.use(path, guard)); every S5 guard must be
// wrapped in routeGuard so it applies only to its own route (spec §5.2), and no /v1/organizer route may be reachable without requireApiClient
// other than `token` and `openapi.json`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import * as ops from '../functions/events-ops.mjs';
import * as integrations from '../functions/events-integrations.mjs';
import * as api from '../functions/events-organizer-api.mjs';
import * as adminS5 from '../functions/events-admin-s5.mjs';
import { harness, s5On, s5Off, db } from './fixtures/events-s5.mjs';

await ensureInit();
const h = harness();
after(async () => { await h.cleanup(); await db.destroy(); });

const routesOf = mod => Object.entries(mod).filter(([, r]) => r && typeof r === 'object' && typeof r.path === 'string' && typeof r.onRequest === 'function');
const ALL = [...routesOf(ops), ...routesOf(integrations), ...routesOf(api), ...routesOf(adminS5)].map(([name, r]) => ({ name, ...r, guards: [r.onGuard].flat().filter(Boolean) }));
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } });
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

test('there are S5 routes to check, none is declared twice, and every one has a description', () => {
  assert.ok(ALL.length >= 55, `${ALL.length} routes`);
  assert.equal(new Set(ALL.map(r => `${r.method} ${r.path}`)).size, ALL.length);
  assert.ok(ALL.every(r => typeof r.description === 'string' && r.description.length > 40), 'documented');
});

test('every guard of every S5 route is routeGuard-wrapped for exactly that route\'s method', () => {
  for (const r of ALL) {
    assert.ok(r.guards.length >= 1 || r.path === '/v1/organizer/openapi.json', `${r.name} has a guard`);
    for (const g of r.guards) {
      assert.ok(Array.isArray(g.routeMethods), `${r.name}: an unwrapped guard would apply to every method and sub-path`);
      assert.ok(g.routeMethods.includes(r.method.toUpperCase()), `${r.name}: guard method ${g.routeMethods} vs ${r.method}`);
    }
  }
});

test('a guard lets through (calls next) any request for ANOTHER method or a SUB-PATH of its mount — it never decides for a route it does not own', async () => {
  s5On();
  for (const r of ALL) {
    for (const g of r.guards) {
      for (const other of METHODS.filter(m => !g.routeMethods.includes(m))) {
        let passed = false;
        await g({ method: other, baseUrl: r.path, path: '/', headers: {} }, res(), () => { passed = true; });
        assert.ok(passed, `${r.name}: ${other} on ${r.path} must pass through`);
      }
      let passed = false;
      await g({ method: r.method.toUpperCase(), baseUrl: r.path, path: '/deeper/route', headers: {} }, res(), () => { passed = true; });
      assert.ok(passed, `${r.name}: a sub-path must pass through`);
    }
  }
});

test('NO /v1/organizer route is reachable without a valid API token, except `token` and `openapi.json`; each refuses a request with no credentials (flags on) and with a JWT session', async () => {
  s5On();
  const f = await h.kitEvent({ n: 0 });
  const open = new Set(['/v1/organizer/token', '/v1/organizer/openapi.json']);
  for (const r of ALL.filter(x => x.path.startsWith('/v1/organizer'))) {
    const params = Object.fromEntries([...r.path.matchAll(/:([A-Za-z]+)/g)].map(m => [m[1], 'x']));
    const out = res();
    let reached = false;
    const req = { method: r.method.toUpperCase(), headers: {}, params, query: {}, body: {}, ip: '10.0.0.5', baseUrl: '', path: r.path, get: () => null };
    for (const g of r.guards) { let ok = false; await g(req, out, () => { ok = true; }); if (!ok) break; reached = true; }
    const passedAll = r.guards.length === 0 || reached && out.statusCode === 200 && out.body === null;
    if (open.has(r.path)) assert.ok(passedAll, `${r.path} is open by design`);
    else { assert.equal(passedAll, false, `${r.name} must not run without a token`); assert.ok([401, 403, 404].includes(out.statusCode), `${r.name}: ${out.statusCode}`); }
    // and with a staff JWT
    const jwtOut = res();
    const jwtReq = { ...req, headers: { authorization: `Bearer ${(await import('../src/auth/jwt.mjs')).sign(f.organizer.owner)}` } };
    let jwtReached = true;
    for (const g of r.guards) { let ok = false; await g(jwtReq, jwtOut, () => { ok = true; }); if (!ok) { jwtReached = false; break; } }
    if (!open.has(r.path)) assert.equal(jwtReached, false, `${r.name} must refuse a staff session`);
  }
});

test('flag off: every S5 route\'s first guard answers 404 feature_disabled (and the S5 admin routes too, when their module flag is off)', async () => {
  s5Off();
  for (const r of ALL.filter(x => !x.path.startsWith('/admin'))) {
    const out = res();
    const params = Object.fromEntries([...r.path.matchAll(/:([A-Za-z]+)/g)].map(m => [m[1], 'x']));
    let passed = false;
    for (const g of r.guards) { await g({ method: r.method.toUpperCase(), headers: {}, params, query: {}, body: {}, path: '/', get: () => null }, out, () => { passed = true; }); if (!passed) break; passed = false; }
    if (r.path !== '/v1/organizer/openapi.json') assert.deepEqual([r.name, out.statusCode, out.body], [r.name, 404, { error: 'feature_disabled' }]);
  }
});
