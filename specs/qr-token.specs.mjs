import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issue, verify, issueGymQr, verifyGymQr } from '../src/auth/qr-token.mjs';

test('verifies signed rotating QR tokens', () => {
  const now = Date.UTC(2026, 4, 21, 7, 0, 0);
  const qr = issue('usr_signed_qr', now);

  assert.deepEqual(verify(qr.token, now), { userId: 'usr_signed_qr' });
});

test('rejects unsigned member QR payloads (anyone could forge them)', () => {
  const now = Date.UTC(2026, 4, 21, 7, 0, 0);
  assert.equal(verify(`fitflex:member:usr_portal_qr:${now}`, now + 30_000), null);
});

test('gym QR round-trips and cannot be minted for another gym', () => {
  const qr = issueGymQr('gym_001');
  assert.deepEqual(verifyGymQr(qr), { gymId: 'gym_001' });
  const forged = qr.replace('gym_001', 'gym_002');
  assert.equal(verifyGymQr(forged), null);
  assert.equal(verifyGymQr('fitflex:gym:gym_001:nope'), null);
  assert.equal(verifyGymQr('gym_001'), null);
});
