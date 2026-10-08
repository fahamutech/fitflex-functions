// What the sign-in screens may offer: flags, the PIN key, and which codes can be sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signInOptions } from '../functions/pin-auth.mjs';

const KEYS = ['IDENTITY_V2', 'V2_PIN_LOGIN', 'V2_RECOVERY', 'VERIFICATION_SMS_PROVIDER', 'VERIFICATION_EMAIL_PROVIDER', 'PIN_PEPPER'];
async function options(env) {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    let body = null;
    await signInOptions.onRequest({ headers: {} }, { json: b => { body = b; } });
    return body;
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('everything off by default', async () => {
  assert.deepEqual(await options({}), { pinLogin: false, pinReset: false, recovery: false, smsCodes: false, emailCodes: false });
});

test('flags on, SMS ready, email not configured: the app keeps email on Firebase', async () => {
  const body = await options({ IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', V2_RECOVERY: 'true', VERIFICATION_SMS_PROVIDER: 'fake' });
  assert.deepEqual(body, { pinLogin: true, pinReset: true, recovery: true, smsCodes: true, emailCodes: false });
});

test('both kinds of code ready', async () => {
  const body = await options({ IDENTITY_V2: 'true', V2_PIN_LOGIN: 'true', VERIFICATION_SMS_PROVIDER: 'fake', VERIFICATION_EMAIL_PROVIDER: 'fake' });
  assert.deepEqual(body, { pinLogin: true, pinReset: false, recovery: false, smsCodes: true, emailCodes: true });
});
