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
