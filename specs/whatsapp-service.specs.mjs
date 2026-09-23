// WhatsApp service tests — Africa's Talking integration, phone normalization,
// template sending, inbound message handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppService } from '../src/services/whatsapp-service.mjs';

function mockFetch(responses = {}) {
  return async (url, opts) => {
    const key = `${opts.method}:${url}`;
    const resp = responses[key] || { ok: true, data: { message: [{ id: 'msg_123', cost: '0.08' }] } };
    return {
      ok: resp.ok !== false,
      status: resp.status || (resp.ok ? 200 : 400),
      json: async () => resp,
    };
  };
}

function store(seed = []) {
  let rows = [...seed];
  return {
    filterAsync: async pred => rows.filter(pred),
    findByIdAsync: async id => rows.find(r => r.id === id) || null,
    insertAsync: async row => { rows.push(row); return row; },
  };
}

function setup({ mockResponses = {}, userRows = [] } = {}) {
  global.fetch = mockFetch(mockResponses);
  const users = store(userRows.length ? userRows : [
    { id: 'u1', displayName: 'Aisha', phoneNumber: '+255712345678' },
    { id: 'u2', displayName: 'Trainer Mike', phoneNumber: '+256701234567' },
  ]);
  const svc = createWhatsAppService({
    apiKey: 'test_key_123',
    users,
    auditLog: { insertAsync: () => {} },
  });
  return { svc, users };
}

test('normalizePhone: +255 format', () => {
  const { svc } = setup();
  assert.equal(svc.normalizePhone('+255712345678'), '+255712345678');
});

test('normalizePhone: 0xxx format (Tanzania)', () => {
  const { svc } = setup();
  assert.equal(svc.normalizePhone('0712345678'), '+255712345678');
});

test('normalizePhone: raw digits', () => {
  const { svc } = setup();
  assert.equal(svc.normalizePhone('255712345678'), '+255712345678');
});

test('normalizePhone: +256 format (Uganda)', () => {
  const { svc } = setup();
  assert.equal(svc.normalizePhone('+256701234567'), '+256701234567');
});

test('normalizePhone: invalid returns null', () => {
  const { svc } = setup();
  assert.equal(svc.normalizePhone('123'), null);
  assert.equal(svc.normalizePhone(''), null);
  assert.equal(svc.normalizePhone(null), null);
});

test('sendOtp: success', async () => {
  const { svc } = setup();
  const result = await svc.sendOtp('u1', '123456', 'Aisha');
  assert.ok(!result.error);
  assert.equal(result.status, 'sent');
  assert.ok(result.messageId);
});

test('sendOtp: user has no phone', async () => {
  const { svc, users } = setup({ userRows: [{ id: 'u_nophone', displayName: 'NoPhone' }] });
  const result = await svc.sendOtp('u_nophone', '123456');
  assert.equal(result.error, 'user_no_phone');
  assert.equal(result.status, 400);
});

test('sendOtp: user not found', async () => {
  const { svc } = setup();
  const result = await svc.sendOtp('ghost', '123456');
  assert.equal(result.error, 'user_no_phone');
});

test('sendBookingConfirmed: success', async () => {
  const { svc } = setup();
  const result = await svc.sendBookingConfirmed('u2', 'Aisha', '2026-09-25', '10:00 AM');
  assert.ok(!result.error);
  assert.equal(result.status, 'sent');
});

test('sendBookingReminder: success', async () => {
  const { svc } = setup();
  const result = await svc.sendBookingReminder('u1', 'Coach Mike', 60);
  assert.ok(!result.error);
  assert.equal(result.status, 'sent');
});

test('sendTrainerMessage: success', async () => {
  const { svc } = setup();
  const result = await svc.sendTrainerMessage('u1', 'Coach Mike', 'Great session today!');
  assert.ok(!result.error);
  assert.equal(result.status, 'sent');
});

test('sendTrainerMessage: message too long (>100 chars)', async () => {
  const { svc } = setup();
  const longMsg = 'x'.repeat(101);
  const result = await svc.sendTrainerMessage('u1', 'Coach Mike', longMsg);
  assert.equal(result.error, 'message_too_long');
  assert.equal(result.status, 400);
});

test('sendOrderPlaced: success', async () => {
  const { svc } = setup();
  const result = await svc.sendOrderPlaced('u1', 'ord_123', 45000.50);
  assert.ok(!result.error);
  assert.equal(result.status, 'sent');
});

test('sendOrderReady: success', async () => {
  const { svc } = setup();
  const result = await svc.sendOrderReady('u1', 'ord_123', 'Power Gym', '2026-09-25 17:00');
  assert.ok(!result.error);
  assert.equal(result.status, 'sent');
});

test('sendPaymentReceived: success', async () => {
  const { svc } = setup();
  const result = await svc.sendPaymentReceived('u1', 15000, 'ord_123');
  assert.ok(!result.error);
  assert.equal(result.status, 'sent');
});

test('sendVendorReengagement: success', async () => {
  const { svc } = setup();
  const result = await svc.sendVendorReengagement('u1');
  assert.ok(!result.error);
  assert.equal(result.status, 'sent');
});

test('sendMemberReengagement: success', async () => {
  const { svc } = setup();
  const result = await svc.sendMemberReengagement('u1');
  assert.ok(!result.error);
  assert.equal(result.status, 'sent');
});

test('handleInboundMessage: success', async () => {
  const { svc } = setup();
  const result = await svc.handleInboundMessage({
    from: '+255712345678',
    text: 'Hi, I want to book a session',
    messageId: 'msg_456',
    timestamp: Math.floor(Date.now() / 1000),
  });
  assert.ok(!result.error);
  assert.equal(result.message.userId, 'u1');
  assert.equal(result.message.type, 'inbound');
  assert.equal(result.message.text, 'Hi, I want to book a session');
});

test('handleInboundMessage: user not found by phone', async () => {
  const { svc } = setup();
  const result = await svc.handleInboundMessage({
    from: '+255999999999',
    text: 'Hello',
    messageId: 'msg_456',
    timestamp: Math.floor(Date.now() / 1000),
  });
  assert.equal(result.error, 'user_not_found');
  assert.equal(result.status, 404);
});

test('handleInboundMessage: invalid from', async () => {
  const { svc } = setup();
  const result = await svc.handleInboundMessage({
    from: '123',
    text: 'Hello',
    messageId: 'msg_456',
    timestamp: Math.floor(Date.now() / 1000),
  });
  assert.equal(result.error, 'invalid_from');
  assert.equal(result.status, 400);
});

test('TEMPLATES constant defined', () => {
  const { svc } = setup();
  assert.ok(svc.TEMPLATES.otp);
  assert.ok(svc.TEMPLATES.booking_confirmed);
  assert.ok(svc.TEMPLATES.order_placed);
  assert.ok(svc.TEMPLATES.vendor_reengagement);
  assert.ok(svc.TEMPLATES.member_reengagement);
});
