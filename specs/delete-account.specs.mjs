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

test('delete account instructions are exposed as a public Play Store HTML endpoint', async () => {
  const { deleteAccount } = await import('../functions/health.mjs');

  assert.equal(deleteAccount.method, 'get');
  assert.equal(deleteAccount.path, '/delete-account');

  const out = res();
  deleteAccount.onRequest({}, out);

  assert.equal(out.statusCode, 200);
  assert.match(out.headers['content-type'], /html/);
  assert.match(out.body, /Delete Your FitFlex Account/);
  assert.match(out.body, /Account Settings/);
  assert.match(out.body, /What Gets Deleted/);
  assert.match(out.body, /Futa Akaunti Yako ya FitFlex/);
});
