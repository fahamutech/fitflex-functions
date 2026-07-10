import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgresql://fitflex:fitflex@localhost:5432/fitflex_test';

function res() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    type(value) { this.headers['content-type'] = value; return this; },
    send(body) { this.body = body; return this; },
  };
}

test('privacy policy is exposed as a public Play Store HTML endpoint', async () => {
  const { privacyPolicy } = await import('../functions/index.mjs');

  assert.equal(privacyPolicy.method, 'get');
  assert.equal(privacyPolicy.path, '/privacy-policy');

  const out = res();
  privacyPolicy.onRequest({}, out);

  assert.equal(out.statusCode, 200);
  assert.match(out.headers['content-type'], /html/);
  assert.match(out.body, /FitFlex Privacy Policy/);
  assert.match(out.body, /Information We Collect/);
  assert.match(out.body, /Data Deletion/);
  assert.match(out.body, /Sera ya Faragha ya FitFlex/);
});
