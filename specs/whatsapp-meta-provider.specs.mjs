// WhatsApp through Meta's Cloud API — the adapter against a fake of Meta's
// Graph API: what it sends, how Meta's errors are read, template approvals,
// the webhook (receipts, replies, the URL check), and that it stays off
// until all its settings are present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetaWhatsAppProvider, META_DEFAULT_API_VERSION } from '../src/integrations/whatsapp/meta-provider.mjs';
import { createWhatsAppProvider, ERRORS } from '../src/integrations/whatsapp/provider.mjs';

const ENV = {
  WHATSAPP_PROVIDER: 'meta',
  WHATSAPP_META_ACCESS_TOKEN: 'test-token',
  WHATSAPP_META_PHONE_NUMBER_ID: '1111',
  WHATSAPP_META_BUSINESS_ACCOUNT_ID: '2222',
  WHATSAPP_WEBHOOK_SECRET: 'hook-secret',
};

/** A fake fetch that records calls and answers from a list (or a function). */
function fakeMeta(answers) {
  const calls = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    const a = queue ? queue.shift() : answers(url, opts);
    if (a instanceof Error) throw a;
    return { ok: a.status < 400, status: a.status, json: async () => a.json };
  };
  return { calls, fetchImpl };
}
const meta = (answers, env = ENV) => {
  const f = fakeMeta(answers);
  return { p: createMetaWhatsAppProvider({ env, fetchImpl: f.fetchImpl }), calls: f.calls };
};
const sent = (id = 'wamid.ABC') => ({ status: 200, json: { messaging_product: 'whatsapp', messages: [{ id }] } });
const metaError = (status, code, extra = {}) => ({ status, json: { error: { code, message: 'nope', ...extra } } });

test('is chosen by WHATSAPP_PROVIDER=meta, and stays off until all three settings are set', () => {
  const quiet = { warn() {} };
  const off = createWhatsAppProvider({ env: { WHATSAPP_PROVIDER: 'meta', WHATSAPP_META_ACCESS_TOKEN: 'x' }, logger: quiet });
  assert.equal(off.configured, false);
  assert.deepEqual(off.setup.missing, ['WHATSAPP_META_PHONE_NUMBER_ID', 'WHATSAPP_META_BUSINESS_ACCOUNT_ID']);
  assert.ok(!JSON.stringify(off.setup).includes('"x"'), 'never shows a value');
  const on = createWhatsAppProvider({ env: ENV, logger: quiet });
  assert.deepEqual([on.name, on.configured], ['meta', true]);
  const prod = createWhatsAppProvider({ env: { ...ENV, NODE_ENV: 'production' }, logger: quiet });
  assert.equal(prod.configured, true, 'meta is allowed in production');
});

test('a template goes to the sending number with named values, our reference, and the number without "+"', async () => {
  const { p, calls } = meta([sent('wamid.1')]);
  const r = await p.sendTemplate({
    to: '0722 710 695', templateName: 'fitflex_renewal_reminder', language: 'sw',
    parameters: ['Amina', 'Kilele Gym'], parameterNames: ['member_name', 'gym_name'], reference: 'cmm_123',
  });
  assert.deepEqual(r, { ok: true, providerMessageId: 'wamid.1' });
  const [c] = calls;
  assert.equal(c.method, 'POST');
  assert.equal(c.url, `https://graph.facebook.com/${META_DEFAULT_API_VERSION}/1111/messages`);
  assert.equal(c.headers.authorization, 'Bearer test-token');
  assert.deepEqual(c.body, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '255722710695', type: 'template',
    biz_opaque_callback_data: 'cmm_123',
    template: {
      name: 'fitflex_renewal_reminder', language: { code: 'sw' },
      components: [{ type: 'body', parameters: [
        { type: 'text', text: 'Amina', parameter_name: 'member_name' },
        { type: 'text', text: 'Kilele Gym', parameter_name: 'gym_name' },
      ] }],
    },
  });
});

test('without names (or a mismatch) the values are numbered; a template with no values has no components', async () => {
  const { p, calls } = meta([sent(), sent(), sent()]);
  await p.sendTemplate({ to: '+255722710695', templateName: 't', language: 'en', parameters: ['a', 'b'] });
  assert.deepEqual(calls[0].body.template.components[0].parameters, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  await p.sendTemplate({ to: '+255722710695', templateName: 't', language: 'en', parameters: ['a', 'b'], parameterNames: ['member_name'] });
  assert.ok(!('parameter_name' in calls[1].body.template.components[0].parameters[0]));
  await p.sendTemplate({ to: '+255722710695', templateName: 'hello', language: 'en' });
  assert.equal(calls[2].body.template.components, undefined);
});

test("Meta's errors become the contract's: bad numbers and opt-outs fail for good, limits and outages are retried", async () => {
  const cases = [
    [metaError(400, 131026), ERRORS.invalidRecipient, false],
    [metaError(400, 131050), ERRORS.optedOut, false],
    [metaError(400, 132001), ERRORS.templateNotApproved, false],
    [metaError(400, 132015), ERRORS.templateNotApproved, false],
    [metaError(400, 132000), 'bad_parameters', false],
    [metaError(429, 130429), ERRORS.rateLimited, true],
    [metaError(400, 131056), ERRORS.rateLimited, true],
    [metaError(500, 131000), ERRORS.unavailable, true],
    [metaError(401, 190, { error_subcode: 463 }), 'auth_failed', false],
    [metaError(400, 999999), 'provider_error', false],
    [metaError(503, 999999), ERRORS.unavailable, true],
    [{ status: 200, json: {} }, 'provider_error', false],
  ];
  for (const [answer, error, retryable] of cases) {
    const { p } = meta([answer]);
    const r = await p.sendTemplate({ to: '+255722710695', templateName: 't', language: 'en', parameters: [] });
    assert.equal(r.ok, false);
    assert.deepEqual([r.error, r.retryable], [error, retryable], JSON.stringify(answer));
  }
  const { p } = meta([new Error('socket hang up')]);
  const net = await p.sendTemplate({ to: '+255722710695', templateName: 't', language: 'en' });
  assert.deepEqual([net.error, net.retryable], [ERRORS.unavailable, true]);
  const bad = await p.sendTemplate({ to: '12', templateName: 't', language: 'en' });
  assert.deepEqual([bad.error, bad.retryable], [ERRORS.invalidRecipient, false], 'never sent');
});

test('free text (the STOP / START confirmations) and no status lookup', async () => {
  const { p, calls } = meta([sent('wamid.t'), metaError(400, 131047)]);
  assert.deepEqual(await p.sendMessage({ to: '+255722710695', text: 'Umeondolewa.' }), { ok: true, providerMessageId: 'wamid.t' });
  assert.deepEqual(calls[0].body.text, { body: 'Umeondolewa.', preview_url: false });
  const late = await p.sendMessage({ to: '+255722710695', text: 'hi' });
  assert.deepEqual([late.error, late.retryable], ['outside_reply_window', false]);
  assert.deepEqual(await p.getDeliveryStatus('wamid.t'), { error: 'not_supported' });
});

test('template approvals: every page, en/sw as Meta names them, named variables in order', async () => {
  const { p, calls } = meta([
    { status: 200, json: {
      data: [
        { name: 'fitflex_renewal_reminder', language: 'en', status: 'APPROVED', category: 'UTILITY',
          components: [{ type: 'HEADER', text: 'x' }, { type: 'BODY', text: 'Hi {{member_name}}, your plan at {{gym_name}} ends {{expiry_date}}. {{member_name}}' }] },
        { name: 'fitflex_offer', language: 'sw', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Habari {{1}}' }] },
      ],
      paging: { next: 'https://graph.facebook.com/next-page' },
    } },
    { status: 200, json: { data: [{ name: 'fitflex_offer', language: 'en', status: 'REJECTED', category: 'MARKETING', components: [] }] } },
  ]);
  const r = await p.listTemplates();
  assert.equal(calls[0].url, `https://graph.facebook.com/${META_DEFAULT_API_VERSION}/2222/message_templates?fields=name,language,status,category,components&limit=100`);
  assert.equal(calls[1].url, 'https://graph.facebook.com/next-page');
  assert.deepEqual(r.templates, [
    { name: 'fitflex_renewal_reminder', language: 'en', status: 'approved', category: 'utility', variables: ['member_name', 'gym_name', 'expiry_date'] },
    { name: 'fitflex_offer', language: 'sw', status: 'pending', category: 'marketing' },
    { name: 'fitflex_offer', language: 'en', status: 'rejected', category: 'marketing' },
  ]);
  const { p: denied } = meta([metaError(401, 190)]);
  assert.deepEqual(await denied.listTemplates(), { error: 'auth_failed' });
});

test("the webhook: Meta's receipts and replies, button taps as text, other numbers ignored", () => {
  const { p } = meta([]);
  const value = (extra) => ({ object: 'whatsapp_business_account', entry: [{ id: '2222', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1111' }, ...extra } }] }] });
  const r = p.parseWebhook({ body: value({
    statuses: [
      { id: 'wamid.1', status: 'delivered', timestamp: '1790000000', recipient_id: '255722710695' },
      { id: 'wamid.2', status: 'failed', timestamp: '1790000001', errors: [{ code: 131026, title: 'Message undeliverable' }] },
      { id: 'wamid.3', status: 'deleted' },
    ],
    messages: [
      { from: '255722710695', id: 'wamid.in1', timestamp: '1790000002', type: 'text', text: { body: 'STOP' } },
      { from: '255722710696', id: 'wamid.in2', timestamp: '1790000003', type: 'button', button: { text: 'ACHA' } },
      { from: '255722710697', id: 'wamid.in3', type: 'interactive', interactive: { button_reply: { title: 'ANZA' } } },
      { from: '255722710698', id: 'wamid.in4', type: 'image', image: {} },
    ],
  }) });
  assert.deepEqual(r.statuses.map(s => [s.providerMessageId, s.status, s.error ?? null]), [
    ['wamid.1', 'delivered', null], ['wamid.2', 'failed', '131026: Message undeliverable'],
  ]);
  assert.equal(+r.statuses[0].at, 1790000000 * 1000);
  assert.deepEqual(r.inbound.map(m => [m.from, m.text]), [['+255722710695', 'STOP'], ['+255722710696', 'ACHA'], ['+255722710697', 'ANZA']]);

  const otherNumber = value({ statuses: [{ id: 'wamid.x', status: 'read', timestamp: '1' }] });
  otherNumber.entry[0].changes[0].value.metadata.phone_number_id = '9999';
  assert.deepEqual(p.parseWebhook({ body: otherNumber }), { statuses: [], inbound: [] });
  assert.deepEqual(p.parseWebhook({ body: { object: 'page' } }), { statuses: [], inbound: [] });
  assert.deepEqual(p.parseWebhook({ body: null }), { statuses: [], inbound: [] });
});

test("Meta's URL check is answered only with our secret", () => {
  const { p } = meta([]);
  assert.equal(p.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'hook-secret', 'hub.challenge': '12345' }), '12345');
  assert.equal(p.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '12345' }), null);
  assert.equal(p.verifyWebhook({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'hook-secret', 'hub.challenge': '1' }), null);
  const { p: noSecret } = meta([], { ...ENV, WHATSAPP_WEBHOOK_SECRET: '' });
  assert.equal(noSecret.verifyWebhook({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }), null);
});
