import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password-credentials.mjs';

test('password credentials use unique salts and verify only the correct password', async () => {
  const first = await hashPassword('Staff123');
  const second = await hashPassword('Staff123');
  assert.notEqual(first, second);
  assert.ok(!first.includes('Staff123'));
  assert.equal(await verifyPassword('Staff123', first), true);
  assert.equal(await verifyPassword('Wrong123', first), false);
  assert.equal(await verifyPassword('Staff123', 'demo:Staff123'), false);
  assert.equal(await verifyPassword('Staff123', 'scrypt:broken'), false);
});
