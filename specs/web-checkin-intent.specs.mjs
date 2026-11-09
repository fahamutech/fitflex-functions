// Browser check-in intent token (S2): HMAC-signed, 10 minutes, bound to one gym reference, tamper-evident.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { signIntent, verifyIntent, INTENT_TTL_SECONDS } from '../src/shared/web-checkin-intent.mjs';

const before = process.env.QR_HMAC_SECRET;
beforeEach(() => { process.env.QR_HMAC_SECRET = 'intent-spec-secret'; });
after(() => { if (before === undefined) delete process.env.QR_HMAC_SECRET; else process.env.QR_HMAC_SECRET = before; });

const decode = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
const NOW = Date.UTC(2027, 0, 29, 8, 0, 0);

test('a signed intent verifies and carries only v, gymRef, jti, iat, exp', () => {
  const { token, expiresAt, jti } = signIntent({ gymRef: 'ref123', now: NOW });
  assert.deepEqual(Object.keys(decode(token)).sort(), ['exp', 'gymRef', 'iat', 'jti', 'v']);
  assert.equal(expiresAt, new Date(NOW + INTENT_TTL_SECONDS * 1000).toISOString());
  assert.equal(INTENT_TTL_SECONDS, 600);
  const v = verifyIntent(token, { now: NOW + 1000 });
  assert.equal(v.ok, true);
  assert.equal(v.claims.gymRef, 'ref123');
  assert.equal(v.claims.jti, jti);
});

test('expiry: valid just before 10 minutes, intent_expired at and after', () => {
  const { token } = signIntent({ gymRef: 'ref123', now: NOW });
  assert.equal(verifyIntent(token, { now: NOW + 599_000 }).ok, true);
  assert.deepEqual(verifyIntent(token, { now: NOW + 600_000 }), { ok: false, failure: 'intent_expired' });
  assert.equal(verifyIntent(token, { now: NOW + 3_600_000 }).failure, 'intent_expired');
});

test('wrong gym: a token minted for one gym reference does not verify for another', () => {
  const { token } = signIntent({ gymRef: 'gymA-ref', now: NOW });
  assert.equal(verifyIntent(token, { now: NOW, gymRef: 'gymA-ref' }).ok, true);
  assert.deepEqual(verifyIntent(token, { now: NOW, gymRef: 'gymB-ref' }), { ok: false, failure: 'invalid_intent' });
});

test('tampered reference, expiry or signature is invalid_intent', () => {
  const { token } = signIntent({ gymRef: 'gymA-ref', now: NOW });
  const [part, sig] = token.split('.');
  const forge = patch => Buffer.from(JSON.stringify({ ...decode(token), ...patch })).toString('base64url');
  assert.equal(verifyIntent(`${forge({ gymRef: 'gymB-ref' })}.${sig}`, { now: NOW }).failure, 'invalid_intent');
  assert.equal(verifyIntent(`${forge({ exp: decode(token).exp + 86_400 })}.${sig}`, { now: NOW }).failure, 'invalid_intent');
  assert.equal(verifyIntent(`${part}.${sig.slice(0, -2)}AA`, { now: NOW }).failure, 'invalid_intent');
  assert.equal(verifyIntent(`${part}.`, { now: NOW }).failure, 'invalid_intent');
});

test('garbage never throws: non-strings, wrong shape, oversized, other secret', () => {
  for (const bad of [undefined, null, 42, {}, '', 'abc', 'a.b.c', '.', 'x'.repeat(5000)]) {
    assert.equal(verifyIntent(bad, { now: NOW }).failure, 'invalid_intent', String(bad).slice(0, 20));
  }
  const { token } = signIntent({ gymRef: 'ref', now: NOW });
  process.env.QR_HMAC_SECRET = 'a-different-secret';
  assert.equal(verifyIntent(token, { now: NOW }).failure, 'invalid_intent');
  delete process.env.QR_HMAC_SECRET;
  assert.equal(verifyIntent(token, { now: NOW }).failure, 'invalid_intent', 'no secret: nothing verifies');
  assert.throws(() => signIntent({ gymRef: 'ref', now: NOW }), /QR_HMAC_SECRET/);
});

test('reuse: the token is stateless, every mint has its own jti (single use is the database intentId)', () => {
  const a = signIntent({ gymRef: 'ref', now: NOW });
  const b = signIntent({ gymRef: 'ref', now: NOW });
  assert.notEqual(a.jti, b.jti);
  assert.notEqual(a.token, b.token);
  // Verifying twice is fine and stable; the one-visit-per-intent rule is spec'd in web-checkin-flow.
  assert.equal(verifyIntent(a.token, { now: NOW }).claims.jti, verifyIntent(a.token, { now: NOW }).claims.jti);
});

test('the key is not the QR signing key: a gym-QR style signature over the same bytes does not verify', async () => {
  const { createHmac } = await import('node:crypto');
  const { token } = signIntent({ gymRef: 'ref', now: NOW });
  const part = token.split('.')[0];
  const rawKeySig = createHmac('sha256', process.env.QR_HMAC_SECRET).update(part).digest('base64url');
  assert.equal(verifyIntent(`${part}.${rawKeySig}`, { now: NOW }).failure, 'invalid_intent');
});
