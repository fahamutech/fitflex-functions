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
  assert.match(out.body, /Futa Akaunti Yako ya FitFlex/);
  assert.match(out.body, /Last updated: October 30, 2026/);
  assert.match(out.body, /Ilisasishwa mwisho: Oktoba 30, 2026/);
  // The in-app steps, in both languages, for every role that has them.
  assert.match(out.body, /<strong>Delete account<\/strong>/);
  assert.match(out.body, /<strong>Futa akaunti<\/strong>/);
  assert.match(out.body, /<strong>DELETE<\/strong>/);
  assert.match(out.body, /<strong>FUTA<\/strong>/);
  assert.match(out.body, /vendors/);
  assert.match(out.body, /wauzaji/);
  // What goes, what stays anonymised, and why.
  assert.match(out.body, /What Gets Deleted/);
  assert.match(out.body, /Push notification tokens/);
  assert.match(out.body, /What Is Kept, in Anonymised Form/);
  assert.match(out.body, /Kinachohifadhiwa Bila Kukutambulisha/);
  assert.match(out.body, /gyms, trainers and vendors are paid from them/);
  assert.match(out.body, /Deleted member/);
  assert.match(out.body, /Mwanachama aliyefutwa/);
  // The old promise is gone: check-in and membership history are kept, not deleted.
  assert.doesNotMatch(out.body, /Membership, subscription, and check-in history linked to your account/);
  // fitflex.af has no mail server: WhatsApp is the contact, and no email address is offered here.
  assert.match(out.body, /https:\/\/wa\.me\/255786670499/);
  assert.match(out.body, /\+255 786 670 499/);
  assert.doesNotMatch(out.body, /@fitflex\.af/);
});

test('the privacy policy agrees with the delete account page', async () => {
  const { privacyPolicy } = await import('../functions/health.mjs');
  const out = res();
  privacyPolicy.onRequest({}, out);
  const section = out.body.slice(out.body.indexOf('<h2>Data Deletion</h2>'), out.body.indexOf('<h2>Security</h2>'));
  assert.match(section, /anonymised form/);
  assert.match(section, /https:\/\/wa\.me\/255786670499/);
  assert.doesNotMatch(section, /@fitflex\.af/);
  assert.match(out.body, /Maelezo kamili yapo kwenye/);
});
