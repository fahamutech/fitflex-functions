// Admin-portal audit (2026-10-29) Phase 0: every registered /admin route must carry requireAcl.
//
// Runtime sweep, not a text scan: many routes build their guard from shared helpers, so the
// text of the route alone does not show whether requireAcl is in the chain. Instead every
// exported route object under /admin has its real guard chain run with the token of a restricted
// portal staff member who holds NO scopes. A scoped route answers 403 acl_forbidden and never
// reaches the handler; a route without requireAcl lets that person through and fails here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { users } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';

const FUNCTIONS_DIR = new URL('../functions/', import.meta.url).pathname;

// `METHOD /path` entries allowed without requireAcl. Each needs a reason.
const ALLOWLIST = {
  // Any admin may read it: the Trainers page (scope 'trainers') needs it too, and the same list
  // is public at GET /settings/specialties. Its writes (POST/DELETE) are scoped to 'settings'.
  'GET /admin/settings/specialties': 'functions/admin-settings.mjs adminGetSpecialties',
};

const RECORDED_ADMIN_ROUTES = 365; // recorded 2026-10-29
const TOLERANCE = 5;

const staffId = `usr_sweep_${randomUUID().slice(0, 8)}`;
after(async () => { await db('User').where({ id: staffId }).del(); });

async function adminRoutes() {
  const routes = [];
  for (const file of readdirSync(FUNCTIONS_DIR).filter(f => f.endsWith('.mjs'))) {
    const mod = await import(new URL(file, new URL('../functions/', import.meta.url)).href);
    for (const [name, ep] of Object.entries(mod)) {
      if (!ep || typeof ep !== 'object' || typeof ep.path !== 'string' || !ep.path.startsWith('/admin')) continue;
      routes.push({ ep, name, file, key: `${String(ep.method || 'get').toUpperCase()} ${ep.path}` });
    }
  }
  return routes;
}

// Module gates (events, hero images...) answer 404 feature_disabled BEFORE the ACL check while their
// flag is off, which would hide a missing requireAcl. So while the guards run, every boolean flag
// named in feature-flags.mjs is switched on in this process only, then restored.
function allFlagNames() {
  const src = readFileSync(new URL('../src/shared/feature-flags.mjs', import.meta.url), 'utf8');
  return [...new Set([...src.matchAll(/\bon\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g)].map(m => m[1]))];
}

// Runs the route's guard chain as express would; true when the request got through to the handler.
async function reachesHandler(ep, token) {
  const chain = [ep.onGuard].flat().filter(Boolean);
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.sent = true; return this; } };
  const req = { method: String(ep.method || 'get').toUpperCase(), headers: { authorization: `Bearer ${token}` }, params: {}, query: {}, body: {} };
  for (const guard of chain) {
    let advanced = false;
    await guard(req, res, () => { advanced = true; });
    if (!advanced) return { passed: false, status: res.statusCode, body: res.body };
  }
  return { passed: true };
}

test('every /admin route requires an ACL scope, except the allowlist', async () => {
  await users.upsertAsync(u => u.id === staffId, {
    id: staffId, userType: 'admin', email: `${staffId}@example.com`, displayName: staffId, accountStatus: 'active',
    approvalStatus: 'approved', onboardingCompleted: true, portalUser: true, aclPermissions: [], createdAt: new Date().toISOString(),
  });
  const token = sign({ sub: staffId, userType: 'admin', portalUser: true, aclPermissions: [] });
  const routes = await adminRoutes();
  // Floor: the recorded route count (RECORDED_ADMIN_ROUTES) less a small tolerance. A drop means
  // routes were deleted or the sweep stopped finding them. To update: when you add/remove /admin
  // routes on purpose, set RECORDED_ADMIN_ROUTES to the count printed in the failure message.
  assert.ok(routes.length >= RECORDED_ADMIN_ROUTES - TOLERANCE,
    `found ${routes.length} /admin routes, recorded ${RECORDED_ADMIN_ROUTES} (tolerance ${TOLERANCE}); update RECORDED_ADMIN_ROUTES if this is intentional`);

  const open = [];
  const wrongRefusal = [];
  const flags = allFlagNames();
  assert.ok(flags.length > 10, 'flag scan found too few flags');
  const saved = Object.fromEntries(flags.map(f => [f, process.env[f]]));
  for (const f of flags) process.env[f] = 'on';
  const results = [];
  try {
    for (const r of routes) results.push([r, await reachesHandler(r.ep, token)]);
  } finally {
    for (const f of flags) { if (saved[f] === undefined) delete process.env[f]; else process.env[f] = saved[f]; }
  }
  for (const [r, out] of results) {
    if (out.passed) { if (!(r.key in ALLOWLIST)) open.push(`${r.key} (${r.file}:${r.name})`); continue; }
    if (out.body?.error !== 'acl_forbidden') wrongRefusal.push(`${r.key} (${r.file}:${r.name}) -> ${out.status} ${out.body?.error}`);
  }
  assert.deepEqual(open, [], `admin routes without requireAcl: ${open.join(', ')}`);
  assert.deepEqual(wrongRefusal, [], `admin routes refused for another reason (check the guard chain): ${wrongRefusal.join(', ')}`);

  const stale = Object.keys(ALLOWLIST).filter(k => !routes.some(r => r.key === k));
  assert.deepEqual(stale, [], `allowlist entries no longer needed: ${stale.join(', ')}`);
});
