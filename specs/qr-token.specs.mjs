import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issue, verify } from '../src/auth/qr-token.mjs';

test('verifies signed rotating QR tokens', () => {
  const now = Date.UTC(2026, 4, 21, 7, 0, 0);
  const qr = issue('usr_signed_qr', now);

  assert.deepEqual(verify(qr.token, now), { userId: 'usr_signed_qr' });
});

test('verifies fresh portal member QR payloads', () => {
  const now = Date.UTC(2026, 4, 21, 7, 0, 0);
  const token = `fitflex:member:usr_portal_qr:${now}`;

  assert.deepEqual(verify(token, now + 30_000), { userId: 'usr_portal_qr' });
});

test('rejects stale portal member QR payloads', () => {
  const now = Date.UTC(2026, 4, 21, 7, 0, 0);
  const token = `fitflex:member:usr_portal_qr:${now - 180_000}`;

  assert.equal(verify(token, now), null);
});
