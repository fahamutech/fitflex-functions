// Unit tests for the WhatsApp notifier client.
// Run with: node --test specs/whatsapp-hooks.specs.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppNotifier, NOTIFICATION_TEMPLATES } from '../src/integrations/whatsapp-hooks.mjs';

const otpParams = { code: '123456' };

function stubFetch(impl) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return impl ? impl() : { ok: true, json: async () => ({ messageId: 'wam_1' }) };
  };
  return { fetchImpl, calls };
}

function notifier(overrides = {}) {
  const { fetchImpl, calls } = stubFetch(overrides.impl);
  return {
    calls,
    instance: createWhatsAppNotifier({
      apiBase: 'http://whatsapp.test', internalToken: 'tok', isProd: false, fetchImpl, ...overrides,
    }),
  };
}

test('posts to the service with the internal bearer token', async () => {
  const { instance, calls } = notifier();
  const result = await instance.notify({ to: '+255700000001', templateKey: 'otp', params: otpParams });

  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'wam_1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://whatsapp.test/internal/notify');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].body.templateKey, 'otp');
  assert.equal(calls[0].body.to, '+255700000001');
});

test('params are stringified for template interpolation', async () => {
  const { instance, calls } = notifier();
  await instance.notify({
    to: '+255700000001', templateKey: 'streak_nudge', params: { streakDays: 7 },
  });
  assert.deepEqual(calls[0].body.params, { streakDays: '7' });
});

test('only declared params are forwarded', async () => {
  const { instance, calls } = notifier();
  await instance.notify({
    to: '+255700000001', templateKey: 'otp', params: { ...otpParams, secret: 'leak-me' },
  });
  assert.deepEqual(Object.keys(calls[0].body.params), ['code']);
});

test('skips unknown templates without calling the service', async () => {
  const { instance, calls } = notifier();
  const result = await instance.notify({ to: '+255700000001', templateKey: 'nope', params: {} });
  assert.deepEqual(result, { ok: false, skipped: 'unknown_template', templateKey: 'nope' });
  assert.equal(calls.length, 0);
});

test('skips when a declared param is missing', async () => {
  const { instance, calls } = notifier();
  const result = await instance.notify({ to: '+255700000001', templateKey: 'checkin_failed', params: { gymName: 'Zen' } });
  assert.equal(result.skipped, 'missing_params');
  assert.deepEqual(result.missing, ['reason']);
  assert.equal(calls.length, 0);
});

test('skips when there is no recipient', async () => {
  const { instance, calls } = notifier();
  const result = await instance.notify({ to: null, templateKey: 'otp', params: otpParams });
  assert.equal(result.skipped, 'no_recipient');
  assert.equal(calls.length, 0);
});

test('disabled without an apiBase — never calls out', async () => {
  const { fetchImpl, calls } = stubFetch();
  const instance = createWhatsAppNotifier({ apiBase: undefined, internalToken: 'tok', isProd: false, fetchImpl });
  assert.equal(instance.enabled, false);
  const result = await instance.notify({ to: '+255700000001', templateKey: 'otp', params: otpParams });
  assert.equal(result.skipped, 'notifier_disabled');
  assert.equal(calls.length, 0);
});

test('delivery failure is swallowed, never thrown', async () => {
  const { instance } = notifier({ impl: () => { throw new Error('ECONNREFUSED'); } });
  const result = await instance.notify({ to: '+255700000001', templateKey: 'otp', params: otpParams });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ECONNREFUSED');
});

test('non-2xx from the service is reported, not thrown', async () => {
  const { instance } = notifier({ impl: () => ({ ok: false, status: 503, json: async () => ({}) }) });
  const result = await instance.notify({ to: '+255700000001', templateKey: 'otp', params: otpParams });
  assert.deepEqual(result, { ok: false, status: 503 });
});

test('refuses to run in production without an internal token', () => {
  assert.throws(
    () => createWhatsAppNotifier({ apiBase: 'http://whatsapp.test', internalToken: undefined, isProd: true }),
    /FITFLEX_INTERNAL_TOKEN/,
  );
});

test('every template declares its params as a string array', () => {
  for (const [key, params] of Object.entries(NOTIFICATION_TEMPLATES)) {
    assert.ok(Array.isArray(params), `${key} params must be an array`);
    assert.ok(params.every(p => typeof p === 'string'), `${key} params must be strings`);
  }
});
