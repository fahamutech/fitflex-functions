// Admin-portal audit S4: the hardcoded FITFLEX_ADMIN_EMAILS fallback. ADMIN_EMAILS_STRICT (dormant) removes it in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdminEmails, _resetAdminEmailWarning } from '../src/services/auth-service.mjs';

const prod = extra => ({ NODE_ENV: 'production', ...extra });

test('env var set: only those emails, no warning, flag irrelevant', () => {
  const warns = [];
  _resetAdminEmailWarning();
  const set = resolveAdminEmails(prod({ FITFLEX_ADMIN_EMAILS: ' A@x.co, b@x.co ', ADMIN_EMAILS_STRICT: 'on' }), m => warns.push(m));
  assert.deepEqual([...set].sort(), ['a@x.co', 'b@x.co']);
  assert.equal(warns.length, 0);
});

test('flag off, env unset in production: fallback still trusted, one warning only (no address in it)', () => {
  const warns = [];
  _resetAdminEmailWarning();
  const a = resolveAdminEmails(prod({}), m => warns.push(m));
  const b = resolveAdminEmails(prod({ FITFLEX_ADMIN_EMAILS: '  ' }), m => warns.push(m));
  assert.equal(a.size, 1);
  assert.equal(b.size, 1);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /FITFLEX_ADMIN_EMAILS is not set/);
  assert.doesNotMatch(warns[0], /@/);
});

test('flag on, env unset in production: nobody is trusted, no warning', () => {
  const warns = [];
  _resetAdminEmailWarning();
  assert.equal(resolveAdminEmails(prod({ ADMIN_EMAILS_STRICT: 'true' }), m => warns.push(m)).size, 0);
  assert.equal(resolveAdminEmails(prod({ ADMIN_EMAILS_STRICT: '1', FITFLEX_ADMIN_EMAILS: '' }), m => warns.push(m)).size, 0);
  assert.equal(warns.length, 0);
});

test('flag on outside production keeps the fallback (dev/test sign-in unchanged), without a warning', () => {
  const warns = [];
  _resetAdminEmailWarning();
  assert.equal(resolveAdminEmails({ ADMIN_EMAILS_STRICT: 'on' }, m => warns.push(m)).size, 1);
  assert.equal(warns.length, 0);
});
