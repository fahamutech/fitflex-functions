// Every ACL scope an admin endpoint guards with must be grantable to portal staff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PORTAL_ACL_SCOPES, createPortalUserService } from '../src/services/portal-user-service.mjs';

const FUNCTIONS_DIR = new URL('../functions/', import.meta.url).pathname;

function requireAclScopes() {
  const scopes = new Map();
  for (const file of readdirSync(FUNCTIONS_DIR).filter(f => f.endsWith('.mjs'))) {
    const src = readFileSync(join(FUNCTIONS_DIR, file), 'utf8');
    for (const [, scope] of src.matchAll(/requireAcl\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
      if (!scopes.has(scope)) scopes.set(scope, file);
    }
    // A non-literal scope can't be checked statically — fail loudly rather than skip it.
    assert.doesNotMatch(src, /requireAcl\(\s*[^'"`\s)]/, `${file}: requireAcl() must take a string literal scope`);
  }
  return scopes;
}

test('every requireAcl scope in functions/ is in PORTAL_ACL_SCOPES', () => {
  const scopes = requireAclScopes();
  assert.ok(scopes.size > 0, 'expected to find requireAcl usages');
  const missing = [...scopes].filter(([s]) => !PORTAL_ACL_SCOPES.includes(s)).map(([s, f]) => `${s} (${f})`);
  assert.deepEqual(missing, [], `scopes guarded but not grantable: ${missing.join(', ')}`);
});

test('create() accepts every guarded scope and still rejects unknown ones', async () => {
  const svc = createPortalUserService({
    users: { findAsync: async () => ({ id: 'exists' }) },
    auditLog: {}, initFirebaseAdmin() {}, getAdminAuth() {}, isConfiguredAdminEmail: () => false,
  });
  const base = { email: 'a@b.co', password: 'x' };
  // Passing validation reaches the duplicate-email check.
  const ok = await svc.create({ ...base, aclPermissions: [...requireAclScopes().keys()] });
  assert.equal(ok.error, 'email_already_exists');
  const bad = await svc.create({ ...base, aclPermissions: ['gyms', 'nope'] });
  assert.equal(bad.error, 'invalid_acl_scopes');
  assert.deepEqual(bad.invalid, ['nope']);
});

// Guards that admit admins without a requireAcl, keyed `file:export`. Each needs a reason:
// a missing scope lets restricted portal staff reach the route whatever they were granted.
const ADMIN_GUARD_ALLOWLIST = {
  'admin-settings.mjs:adminGetSpecialties': 'read by the Trainers page too; same list is public at /settings/specialties',
};

// Admin guards (any requireAuth admitting 'admin') with no requireAcl in the same expression.
// Vendor routes are skipped: an admin there only acts on its own req.user.sub as vendorId.
function unscopedAdminGuards() {
  const found = [];
  for (const file of readdirSync(FUNCTIONS_DIR).filter(f => f.endsWith('.mjs'))) {
    let owner = '(top)';
    readFileSync(join(FUNCTIONS_DIR, file), 'utf8').split('\n').forEach((line, i) => {
      const decl = line.match(/^(?:export\s+)?const\s+(\w+)/);
      if (decl) owner = decl[1];
      for (const [, args] of line.matchAll(/requireAuth\(([^)]*)\)/g)) {
        const roles = [...args.matchAll(/['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
        if (!roles.includes('admin') || roles.some(r => r.startsWith('vendor'))) continue;
        if (/requireAcl\(/.test(line)) continue;
        found.push({ key: `${file}:${owner}`, where: `${file}:${i + 1}` });
      }
    });
  }
  return found;
}

test('every admin guard in functions/ also requires an ACL scope (or is allowlisted)', () => {
  const found = unscopedAdminGuards();
  const unscoped = found.filter(g => !(g.key in ADMIN_GUARD_ALLOWLIST)).map(g => `${g.key} (${g.where})`);
  assert.deepEqual(unscoped, [], `admin guards without requireAcl: ${unscoped.join(', ')}`);
  const stale = Object.keys(ADMIN_GUARD_ALLOWLIST).filter(k => !found.some(g => g.key === k));
  assert.deepEqual(stale, [], `allowlist entries no longer needed: ${stale.join(', ')}`);
});
