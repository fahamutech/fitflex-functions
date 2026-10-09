// Signed "this was served" tokens: what they prove and what they refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signServedToken, verifyServedToken, isTokenSession, tokenMode, TOKEN_TTL_MS, SERVED_SLACK_MS } from '../src/auth/promotion-token.mjs';

const NOW = new Date('2026-10-10T09:00:00.000Z');
const card = { promotionId: 'promo_1', entityType: 'gym', entityId: 'gym_1', sessionId: 'session-abc-123' };
const at = ms => new Date(NOW.getTime() + ms);
const check = (token, over = {}) => verifyServedToken(token, { ...card, at: NOW, now: NOW, ...over });

/** Run `fn` with some environment variables set, then put them back. */
function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  try { return fn(); } finally { Object.entries(before).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v))); }
}

test('a token proves its own card was served to its own session', () => {
  const token = signServedToken({ ...card, now: NOW });
  assert.deepEqual(check(token), { ok: true, iat: NOW.getTime(), exp: NOW.getTime() + TOKEN_TTL_MS });
  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(token.length < 300, `short enough to ride on every card (${token.length})`);
});

test('it is useless for any other promotion, listing, kind of listing or session', () => {
  const token = signServedToken({ ...card, now: NOW });
  for (const over of [{ promotionId: 'promo_2' }, { entityId: 'gym_2' }, { entityType: 'trainer' }, { sessionId: 'session-other-9' }]) {
    assert.deepEqual(check(token, over), { ok: false, reason: 'mismatch' }, JSON.stringify(over));
  }
});

test('it cannot be changed or made up without the key', () => {
  const token = signServedToken({ ...card, now: NOW });
  const [v, body, sig] = token.split('.');
  // Edit the payload to name another promotion, keeping the old signature.
  const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), p: 'promo_victim' })).toString('base64url');
  assert.equal(check(`${v}.${forgedBody}.${sig}`, { promotionId: 'promo_victim' }).reason, 'bad_signature');
  // Flip a byte of the signature.
  const flipped = Buffer.from(sig, 'base64url'); flipped[0] ^= 1;
  assert.equal(check(`${v}.${body}.${flipped.toString('base64url')}`).reason, 'bad_signature');
  // Extend the lifetime.
  const longer = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), exp: NOW.getTime() + 365 * 86_400_000 })).toString('base64url');
  assert.equal(check(`${v}.${longer}.${sig}`).reason, 'bad_signature');
  // A signature made with some other key.
  const other = withEnv({ PROMOTION_EVENT_SECRET: 'an-attacker-guess' }, () => signServedToken({ ...card, now: NOW }));
  assert.equal(check(other).reason, 'bad_signature');
});

test('rubbish is refused as malformed, never thrown on', () => {
  for (const t of [undefined, null, 42, '', 'x', 'v1.x', 'v1.a.b.c', 'v2.aaaa.bbbb', `v1.${'a'.repeat(800)}.b`, 'v1..', {}, ['v1.a.b']]) {
    const out = check(t);
    assert.equal(out.ok, false, String(t).slice(0, 30));
    assert.ok(['malformed', 'bad_signature'].includes(out.reason), `${String(t).slice(0, 30)} -> ${out.reason}`);
  }
  // A correct signature over something that is not JSON is malformed too.
  assert.equal(check('v1.bm90LWpzb24.AAAA').ok, false);
});

test('it expires after a day', () => {
  const token = signServedToken({ ...card, now: NOW });
  assert.equal(check(token, { now: at(TOKEN_TTL_MS - 1000) }).ok, true);
  assert.equal(check(token, { now: at(TOKEN_TTL_MS + 1000) }).reason, 'expired');
  assert.equal(check(signServedToken({ ...card, now: at(-2 * TOKEN_TTL_MS) })).reason, 'expired');
});

test('an event cannot be about a card before it was served', () => {
  const token = signServedToken({ ...card, now: NOW });
  assert.equal(check(token, { at: at(-SERVED_SLACK_MS + 1000) }).ok, true);          // a little clock skew is fine
  assert.equal(check(token, { at: at(-SERVED_SLACK_MS - 1000) }).reason, 'early');
  assert.equal(check(token, { at: undefined }).ok, true);
});

test('keys can be rotated without refusing the cards already out', () => {
  const oldToken = withEnv({ PROMOTION_EVENT_SECRET: 'old-secret', PROMOTION_EVENT_SECRET_PREVIOUS: undefined }, () => signServedToken({ ...card, now: NOW }));
  withEnv({ PROMOTION_EVENT_SECRET: 'new-secret', PROMOTION_EVENT_SECRET_PREVIOUS: undefined }, () => assert.equal(check(oldToken).reason, 'bad_signature'));
  withEnv({ PROMOTION_EVENT_SECRET: 'new-secret', PROMOTION_EVENT_SECRET_PREVIOUS: 'old-secret' }, () => {
    assert.equal(check(oldToken).ok, true);                                              // still good during the rotation
    const fresh = signServedToken({ ...card, now: NOW });
    withEnv({ PROMOTION_EVENT_SECRET: 'new-secret', PROMOTION_EVENT_SECRET_PREVIOUS: undefined }, () => assert.equal(check(fresh).ok, true));   // new ones use the new key
  });
});

test('the key is not the login secret, and no key material is in a token', () => {
  withEnv({ PROMOTION_EVENT_SECRET: undefined, PROMOTION_EVENT_SECRET_PREVIOUS: undefined, JWT_SECRET: 'login-secret-1' }, () => {
    const token = signServedToken({ ...card, now: NOW });
    assert.equal(check(token).ok, true);
    assert.ok(!token.includes('login-secret-1'));
    withEnv({ JWT_SECRET: 'login-secret-2' }, () => assert.equal(check(token).reason, 'bad_signature'));   // with no own secret, it follows the login secret
  });
});

test('only a well-formed session id gets a token', () => {
  for (const ok of ['abcdefgh', 'a1b2c3d4e5f60718', 'sess_ABC-123', 'x'.repeat(64)]) assert.equal(isTokenSession(ok), true, ok);
  for (const bad of ['short', 'x'.repeat(65), 'has space!', 'ünïcode-session', '', undefined, null, 12345678, 'a;b;c;d;e;f', ['abcdefgh']]) assert.equal(isTokenSession(bad), false, String(bad));
});

test('the server asks for tokens when told to, and is lenient until then', () => {
  withEnv({ PROMOTION_EVENT_TOKENS: undefined }, () => assert.equal(tokenMode(), 'optional'));
  withEnv({ PROMOTION_EVENT_TOKENS: 'required' }, () => assert.equal(tokenMode(), 'required'));
  withEnv({ PROMOTION_EVENT_TOKENS: 'REQUIRED ' }, () => assert.equal(tokenMode(), 'optional'));    // anything unclear is not "required"
  withEnv({ PROMOTION_EVENT_TOKENS: 'optional' }, () => assert.equal(tokenMode(), 'optional'));
});
