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

test('support page is a public bilingual HTML endpoint for the App Store listing', async () => {
  const { support } = await import('../functions/health.mjs');

  assert.equal(support.method, 'get');
  assert.equal(support.path, '/support');
  assert.equal(support.onGuard, undefined);

  const out = res();
  support.onRequest({}, out);

  assert.equal(out.statusCode, 200);
  assert.match(out.headers['content-type'], /html/);
  assert.match(out.body, /FitFlex Support/);
  assert.match(out.body, /Msaada wa FitFlex/);
  assert.match(out.body, /https:\/\/wa\.me\/255786670499/);
  assert.match(out.body, /href="\/privacy-policy"/);
  assert.match(out.body, /href="\/delete-account"/);
});
