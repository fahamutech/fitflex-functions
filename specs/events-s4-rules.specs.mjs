// Marathon & running events · S4 — the pure rules and the schema (spec §3.2, §3.3, §3.12.1, §3.13, §3.15, §3.19 items 1, 2, 14, 15):
// the refund policy math (every preset at its boundary instants, whole TZS), apportionment, the order status derivation,
// the widened state machines and nothing wider, the redactor against hostile payloads, the config defaults, the document
// validation of the new presets, the migration (constraints, partial uniques, `down` failing closed and restoring S3 exactly),
// and that no route can reach `commitOrder`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { ensureInit } from '../functions/index.mjs';
import { evaluateRefund, apportion, refundFor, validatePolicy, describePolicy, normalisePolicy, POLICY_PRESETS } from '../src/shared/events-refund-policy.mjs';
import { deriveOrderStatus, canTransition, allowedTransitions } from '../src/shared/events-lifecycle.mjs';
import { redactProviderPayload } from '../src/shared/events-payment-redact.mjs';
import { paymentStateOf, maskPayerPhone, refundView } from '../src/shared/events-money-views.mjs';
import { validateEvent, parseEventPatch, REFUND_PRESETS, policyView } from '../src/shared/events-document.mjs';
import * as cfg from '../src/shared/events-config.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { harness, uid } from './fixtures/events-s4.mjs';

await ensureInit();
const h = harness();
after(async () => { await h.cleanup(); await db.destroy(); });
const D = 86_400_000;
const T = Date.parse('2027-03-01T06:00:00Z');   // the event start
const ev = (over = {}) => ({ status: 'published', startsAt: new Date(T).toISOString(), registrationClosesAt: new Date(T - D).toISOString(), ...over });
const at = ms => new Date(ms);

test('evaluateRefund: no_refund, refund_until_close (category deadline first, 1 ms either side), full_until_days, tiered (first tier whose time has not passed), custom → manual review, closed at/after the start', () => {
  const paid = 20001;
  assert.deepEqual(evaluateRefund({ policy: { preset: 'no_refund' }, event: ev(), now: at(T - 10 * D), paidTzs: paid }), { mode: 'none', percent: 0, refundTzs: 0, deadlineAt: null, tierIndex: null, reason: 'no_refund' });
  const close = T - D;
  const until = now => evaluateRefund({ policy: { preset: 'refund_until_close' }, event: ev(), now: at(now), paidTzs: paid });
  assert.deepEqual([until(close - 1).mode, until(close - 1).percent, until(close - 1).refundTzs], ['auto', 100, 20001]);
  assert.deepEqual([until(close).mode, until(close).percent], ['none', 0], 'at the deadline instant the window is shut (now < deadline)');
  assert.deepEqual([until(close + 1).mode, until(close + 1).reason], ['none', 'deadline_passed']);
  // the category deadline wins over the event's
  const cat = { registrationClosesAt: new Date(T - 5 * D).toISOString() };
  assert.equal(evaluateRefund({ policy: { preset: 'refund_until_close' }, event: ev(), category: cat, now: at(T - 4 * D), paidTzs: paid }).percent, 0);
  // neither deadline: behaves as no_refund and says why
  assert.deepEqual(evaluateRefund({ policy: { preset: 'refund_until_close' }, event: ev({ registrationClosesAt: null }), now: at(T - 4 * D), paidTzs: paid }).reason, 'no_deadline');
  // full_until_days: 100% while now <= start − N days (inclusive)
  const days = now => evaluateRefund({ policy: { preset: 'full_until_days', days: 7 }, event: ev(), now: at(now), paidTzs: paid });
  const dl = T - 7 * D;
  assert.deepEqual([days(dl - 1).percent, days(dl).percent, days(dl + 1).percent], [100, 100, 0]);
  assert.equal(days(dl).deadlineAt, new Date(dl).toISOString());
  // tiered 100% until 30d, 50% until 14d, then nothing; floor on odd amounts
  const tiered = { preset: 'tiered', tiers: [{ daysBefore: 14, percent: 50 }, { daysBefore: 30, percent: 100 }].reverse() };
  const t = now => evaluateRefund({ policy: tiered, event: ev(), now: at(now), paidTzs: paid });
  assert.deepEqual([t(T - 31 * D).percent, t(T - 30 * D).percent, t(T - 30 * D + 1).percent, t(T - 14 * D).percent, t(T - 14 * D + 1).percent], [100, 100, 50, 50, 0]);
  assert.deepEqual([t(T - 20 * D).tierIndex, t(T - 20 * D).refundTzs, t(T - 1 * D).tierIndex, t(T - 1 * D).mode], [1, 10000, null, 'none']);
  // custom: manual review, the most that can be granted is what was paid
  assert.deepEqual(evaluateRefund({ policy: { preset: 'custom', text: { en: 'a', sw: 'b' } }, event: ev(), now: at(T - 10 * D), paidTzs: paid }), { mode: 'manual_review', percent: null, refundTzs: paid, deadlineAt: null, tierIndex: null, reason: 'custom_policy' });
  // closed: at the start, after it, and while the event runs
  for (const [status, now] of [['published', T], ['published', T + 1], ['in_progress', T - D], ['completed', T - D]]) assert.equal(evaluateRefund({ policy: { preset: 'full_until_days', days: 1 }, event: ev({ status }), now: at(now), paidTzs: paid }).mode, 'closed', `${status} @ ${now - T}`);
  // no policy at all: nothing is invented
  assert.equal(evaluateRefund({ policy: null, event: ev(), now: at(T - D), paidTzs: paid }).mode, 'none');
});

test('whole-shilling arithmetic: the percent step never rounds up; apportionment sums to the line total for many (T, q); refunds per place never exceed what was paid', () => {
  for (let paid = 0; paid <= 400; paid += 1) for (const pct of [1, 7, 33, 50, 66, 99, 100]) {
    const r = refundFor(paid, pct);
    assert.ok(Number.isInteger(r) && r <= (paid * pct) / 100 && r >= 0 && r <= paid, `${paid} × ${pct}%`);
  }
  assert.equal(refundFor(2 ** 31 - 1, 99), Math.floor(((2 ** 31 - 1) * 99) / 100), 'exact up to 2^31');
  for (const [total, q] of [[100, 3], [1, 5], [0, 4], [20000, 1], [59999, 7], [1_000_001, 13], [2 ** 31 - 1, 10]]) {
    const parts = apportion(total, q);
    assert.equal(parts.length, q);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, `${total}/${q}`);
    assert.ok(parts.every(p => Number.isInteger(p) && p >= Math.floor(total / q) && p <= Math.floor(total / q) + 1));
    assert.deepEqual(parts, [...parts].sort((a, b) => b - a), 'the first T mod q places carry the extra shilling');
  }
  for (let total = 0; total < 60; total += 1) for (let q = 1; q < 9; q += 1) assert.equal(apportion(total, q).reduce((a, b) => a + b, 0), total);
  assert.deepEqual(apportion(10, 0), []); assert.deepEqual(apportion(-1, 2), []);
});

test('policy validation and the generated line: days 1..365, 1..3 tiers strictly decreasing in days and non-increasing in percent; unknown presets are refused', () => {
  assert.deepEqual(POLICY_PRESETS, ['no_refund', 'refund_until_close', 'full_until_days', 'tiered', 'custom']);
  assert.deepEqual(REFUND_PRESETS, POLICY_PRESETS);
  assert.deepEqual(validatePolicy({ preset: 'full_until_days', days: 7 }), []);
  assert.equal(validatePolicy({ preset: 'full_until_days', days: 0 })[0].code, 'range');
  assert.equal(validatePolicy({ preset: 'full_until_days', days: 366 })[0].code, 'range');
  assert.equal(validatePolicy({ preset: 'full_until_days' })[0].code, 'required');
  assert.equal(validatePolicy({ preset: 'full_until_days', days: 1.5 })[0].code, 'required');
  const ok = { preset: 'tiered', tiers: [{ daysBefore: 30, percent: 100 }, { daysBefore: 14, percent: 50 }, { daysBefore: 3, percent: 10 }] };
  assert.deepEqual(validatePolicy(ok), []);
  assert.equal(validatePolicy({ preset: 'tiered', tiers: [] })[0].code, 'required');
  assert.equal(validatePolicy({ preset: 'tiered', tiers: [...ok.tiers, { daysBefore: 1, percent: 5 }] })[0].code, 'range');
  assert.equal(validatePolicy({ preset: 'tiered', tiers: [{ daysBefore: 14, percent: 50 }, { daysBefore: 14, percent: 40 }] }).some(p => p.code === 'order'), true, 'days strictly decreasing');
  assert.equal(validatePolicy({ preset: 'tiered', tiers: [{ daysBefore: 30, percent: 50 }, { daysBefore: 14, percent: 60 }] }).some(p => p.code === 'order'), true, 'percent non-increasing');
  assert.equal(validatePolicy({ preset: 'tiered', tiers: [{ daysBefore: 30, percent: 0 }] })[0].code, 'range');
  assert.equal(validatePolicy({ preset: 'tiered', tiers: [{ daysBefore: 30, percent: 101 }] })[0].code, 'range');
  assert.equal(validatePolicy({ preset: 'bogus' })[0].code, 'required');
  assert.deepEqual(describePolicy({ preset: 'full_until_days', days: 7 }), { en: 'Full refund until 7 days before the event.', sw: 'Marejesho kamili hadi siku 7 kabla ya tukio.' });
  assert.match(describePolicy(ok).en, /^100% until 30 days before, then 50% until 14 days before, then 10% until 3 days before, then no refund\.$/);
  assert.equal(describePolicy({ preset: 'custom', text: { en: 'x', sw: 'y' } }), null);
  assert.deepEqual(normalisePolicy({ preset: 'no_refund', days: 9, tiers: [1] }), { preset: 'no_refund', text: { en: null, sw: null } }, 'fields of other presets are dropped');
  const v = policyView({ preset: 'tiered', tiers: ok.tiers, text: { en: 'a', sw: 'b' } });
  assert.deepEqual([v.preset, v.tiers.length, v.generated.sw.length > 10], ['tiered', 3, true]);
});

test('the event document: the wizard patch keeps days / tiers for their preset only; submit validation refuses a bad structured policy and accepts the five presets; the snapshot carries the fields', () => {
  const patch = parseEventPatch({ refundPolicy: { preset: 'tiered', tiers: [{ daysBefore: 30, percent: 100 }, { daysBefore: 14.5, percent: 50 }], days: 5, text: { en: 'x' } } }).patch;
  assert.deepEqual(patch.refundPolicy.tiers, [{ daysBefore: 30, percent: 100 }, { daysBefore: null, percent: 50 }]);
  assert.ok(!('days' in patch.refundPolicy));
  assert.equal(parseEventPatch({ refundPolicy: { preset: 'full_until_days', days: '7' } }).patch.refundPolicy.days, 7);
  assert.ok(!('tiers' in parseEventPatch({ refundPolicy: { preset: 'no_refund', tiers: [{}] } }).patch.refundPolicy));
  const base = { title: 'x', refundPolicy: { preset: 'full_until_days', days: 500, text: { en: null, sw: null } } };
  const fields = validateEvent(base, { mode: 'submit', now: new Date() }).filter(f => f.path.startsWith('refundPolicy'));
  assert.deepEqual(fields.map(f => [f.path, f.code]), [['refundPolicy.days', 'range']]);
  assert.equal(validateEvent({ ...base, refundPolicy: { preset: 'full_until_days', days: 7 } }, { mode: 'submit', now: new Date() }).filter(f => f.path.startsWith('refundPolicy')).length, 0);
  assert.equal(validateEvent({ ...base, refundPolicy: { preset: 'nonsense' } }, { mode: 'submit', now: new Date() }).some(f => f.path === 'refundPolicy.preset'), true);
  // a draft may be incomplete (no structured checks yet)
  assert.equal(validateEvent(base, { mode: 'draft', now: new Date() }).some(f => f.path.startsWith('refundPolicy.days')), false);
});

test('deriveOrderStatus: live places → confirmed / partially_cancelled; none live and a refund owed → refund_pending; refund paid and none open → refunded; nothing owed → cancelled; rejected and unfulfilled refunds do not count', () => {
  const reg = status => ({ status });
  const refund = (status, scope = 'order') => ({ status, scope });
  const cases = [
    [[reg('confirmed'), reg('confirmed')], [], 'confirmed'],
    [[reg('confirmed'), reg('cancelled')], [refund('approved', 'registration')], 'partially_cancelled'],
    [[reg('confirmed'), reg('refunded')], [refund('paid', 'registration')], 'partially_cancelled'],
    [[reg('cancelled'), reg('cancelled')], [refund('requested')], 'refund_pending'],
    [[reg('cancelled')], [refund('approved')], 'refund_pending'],
    [[reg('refunded'), reg('cancelled')], [refund('paid', 'registration'), refund('requested', 'registration')], 'refund_pending'],
    [[reg('refunded'), reg('refunded')], [refund('paid'), refund('paid')], 'refunded'],
    [[reg('cancelled')], [], 'cancelled'],
    [[reg('cancelled')], [refund('rejected')], 'cancelled'],
    [[reg('cancelled')], [refund('requested', 'unfulfilled_payment')], 'cancelled'],
    [[reg('reserved')], [], 'cancelled'],
  ];
  for (const [regs, refunds, want] of cases) assert.equal(deriveOrderStatus({}, regs, refunds), want, JSON.stringify([regs, refunds]));
});

test('the widened state machines allow exactly the S4 moves and nothing else', () => {
  // order: expired → confirmed (rehold only), refund_pending → cancelled, partially_cancelled → refunded
  assert.deepEqual(allowedTransitions('order', 'expired'), ['confirmed']);
  assert.equal(canTransition('order', 'refund_pending', 'cancelled'), true);
  assert.equal(canTransition('order', 'partially_cancelled', 'refunded'), true);
  for (const [from, to] of [['expired', 'awaiting_payment'], ['expired', 'cancelled'], ['cancelled', 'confirmed'], ['refunded', 'confirmed'], ['confirmed', 'expired'], ['awaiting_payment', 'refunded']]) assert.equal(canTransition('order', from, to), false, `${from} → ${to}`);
  // registration: cancelled → reserved (rehold only); revoked tickets are never reactivated
  assert.deepEqual(allowedTransitions('registration', 'cancelled'), ['refunded', 'reserved']);
  assert.equal(canTransition('ticket', 'revoked', 'active'), false);
  assert.deepEqual(allowedTransitions('ticket', 'revoked'), []);
  // payment attempt: failed → succeeded (manual change) and → reconciliation_required; succeeded never goes back
  assert.deepEqual(allowedTransitions('paymentAttempt', 'failed'), ['succeeded', 'reconciliation_required']);
  for (const to of ['pending', 'created', 'failed', 'cancelled']) assert.equal(canTransition('paymentAttempt', 'succeeded', to), false);
  assert.deepEqual(allowedTransitions('paymentAttempt', 'cancelled'), []);
  assert.deepEqual(allowedTransitions('paymentAttempt', 'expired'), []);
});

test('the redactor: allowlist only; hostile payloads (nested objects, long strings, phone numbers, __proto__, huge values) never reach rawRedacted; manual and free store null', () => {
  assert.equal(redactProviderPayload('manual', { status: 'x' }), null);
  assert.equal(redactProviderPayload('free', {}), null);
  assert.equal(redactProviderPayload('tunzaa', null), null);
  assert.equal(redactProviderPayload('tunzaa', []), null);
  assert.equal(redactProviderPayload('tunzaa', { signature: 'x', customer_msisdn: '255712345678' }), null, 'nothing allowlisted → nothing stored');
  const hostile = JSON.parse('{"transaction_id":"TXN1","status":"COMPLETED","amount":"20000.00","remark":"call +255 712 345 678 or 0712345678 or 255712345678","reference_id":{"a":1},"payment_date":["x"],"timestamp":null,"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}},"x-signature":"abc","msisdn":"255712345678","token":"t"}');
  const out = redactProviderPayload('tunzaa', hostile);
  assert.deepEqual(Object.keys(out).sort(), ['amount', 'provider', 'remark', 'status', 'transaction_id']);
  assert.equal(out.remark, 'call ***678 or ***678 or ***678');
  assert.equal(({}).polluted, undefined);
  assert.equal(redactProviderPayload('tunzaa', { transactionID: 'TXN9', status: 'COMPLETED' }).transaction_id, 'TXN9', 'the status read spells it transactionID');
  assert.equal(redactProviderPayload('tunzaa', { status: 'COMPLETED', remark: 'x'.repeat(5000) }).remark.length, 200);
  assert.equal(redactProviderPayload('tunzaa', { status: 'x'.repeat(5000), remark: 'y' }), null, 'over 2 KB: dropped entirely');
  assert.equal(redactProviderPayload('tunzaa', { status: 'COMPLETED', amount: Infinity }).amount, undefined);
  assert.equal(redactProviderPayload('tunzaa', { status: 'COMPLETED', amount: 20000 }).amount, 20000);
  assert.equal(redactProviderPayload('tunzaa', { status: 'COMPLETED', payment_date: '2026-10-14 10:00:00' }).payment_date, '2026-10-14 10:00:00', 'dates survive');
  // random fuzz: no digit run of 9+ ever survives in any value
  for (let i = 0; i < 200; i += 1) {
    const junk = Array.from({ length: 30 }, () => String.fromCharCode(32 + Math.floor(Math.random() * 90))).join('') + String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
    const r = redactProviderPayload('tunzaa', { status: 'COMPLETED', remark: junk, transaction_id: junk });
    assert.ok(!/\d{9,}/.test(JSON.stringify(r)), JSON.stringify(r));
  }
});

test('views and config: payment state vocabulary, masked phone, refund view hides the payout reference until paid; config defaults and bounds', () => {
  const state = (status, extra = {}) => paymentStateOf({ status, method: 'manual', provider: 'manual', ...extra });
  assert.deepEqual(['succeeded', 'pending', 'created', 'expired', 'reconciliation_required', 'cancelled', 'failed'].map(s => state(s)), ['confirmed', 'submitted', 'none', 'expired', 'needs_attention', 'failed', 'failed']);
  assert.equal(state('pending', { method: 'provider', provider: 'tunzaa' }), 'processing');
  assert.equal(state('failed', { rejectCode: 'wrong_account' }), 'rejected');
  assert.equal(state('failed', { failureReason: 'rejected:other' }), 'rejected');
  assert.equal(state('failed', { failureReason: 'refunded_after_late_payment' }), 'needs_attention');
  assert.equal(paymentStateOf(null), 'none');
  assert.equal(maskPayerPhone('+255712345678'), '+255 7•• ••• 678');
  assert.equal(maskPayerPhone('12'), null);
  const r = refundView({ id: 'r', status: 'approved', scope: 'order', amountTzs: 5, paymentReference: 'SECRET', paidTo: '+255712345678', decisionNote: 'internal', createdAt: new Date() });
  assert.deepEqual([r.paymentReference, r.paidTo, r.rejectionNote], [null, null, null]);
  const paid = refundView({ id: 'r', status: 'paid', scope: 'order', amountTzs: 5, paymentReference: 'REF1', paidTo: '+255712345678', createdAt: new Date() });
  assert.deepEqual([paid.paymentReference, paid.paidTo], ['REF1', '••• 678']);
  const env = (vars, fn) => { const prior = {}; for (const k of Object.keys(vars)) { prior[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } try { return fn(); } finally { for (const k of Object.keys(vars)) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; } } };
  assert.deepEqual(env({ EVENTS_MANUAL_CONFIRM_SLA_HOURS: undefined, EVENTS_REFUND_TARGET_DAYS: undefined, EVENT_MANUAL_HOLD_EXTEND_HOURS: undefined, EVENT_MANUAL_HOLD_MAX_HOURS: undefined, EVENTS_ORG_HOLD_MAX_HOURS: undefined, EVENTS_PROVIDER_HOLD_EXTEND_MINUTES: undefined, EVENTS_REJECTED_RETRY_MINUTES: undefined, EVENTS_LATE_PAYMENT_GRACE_HOURS: undefined },
    () => [cfg.eventsManualConfirmSlaHours(), cfg.eventsRefundTargetDays(), cfg.eventManualHoldExtendHours(), cfg.eventManualHoldMaxHours(), cfg.eventsOrgHoldMaxHours(), cfg.eventsProviderHoldExtendMinutes(), cfg.eventsRejectedRetryMinutes(), cfg.eventsLatePaymentGraceHours()]), [24, 5, 24, 48, 120, 10, 60, 24]);
  assert.equal(env({ EVENTS_MANUAL_CONFIRM_SLA_HOURS: '48' }, () => cfg.eventsManualConfirmSlaHours()), 48);
  assert.equal(env({ EVENTS_MANUAL_CONFIRM_SLA_HOURS: 'abc' }, () => cfg.eventsManualConfirmSlaHours()), 24, 'malformed → the default');
  assert.equal(env({ EVENT_TICKET_SECRET: undefined }, () => cfg.eventTicketKeyRing()), null);
});

test('no route can reach commitOrder, and S4 never writes a price: grep the route and service layers', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mjs')) files.push(p); } };
  walk(path.join(root, 'functions')); walk(path.join(root, 'src'));
  const offenders = files.filter(f => /\.commitOrder\(|\bcommitOrder\b\s*[,}]/.test(fs.readFileSync(f, 'utf8')) && !f.endsWith('event-store-pg.mjs'));
  assert.deepEqual(offenders.map(f => path.relative(root, f)), [], 'only the S1 store defines / exports it; no route or service calls it');
  const pricing = files.filter(f => /events-pricing/.test(fs.readFileSync(f, 'utf8')) && /(writeFile|insert\(|update\()/.test(fs.readFileSync(f, 'utf8')) && f.endsWith('events-payment-service.mjs'));
  assert.deepEqual(pricing, []);
});

// ── The schema ───────────────────────────────────────────────────────────

test('migration: constraints and partial uniques exist; `uncommit` and `event_order` are accepted; the one-success and one-live indexes hold', async () => {
  const defs = async sql => (await db.raw(sql)).rows;
  const refundCk = (await defs(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'refund_ck'`))[0].d;
  for (const kind of ['subscription', 'trainer_booking', 'shop_order', 'event_order']) assert.ok(refundCk.includes(`'${kind}'`), kind);
  assert.ok(refundCk.includes('"amountTzs" > 0') && refundCk.includes("'rejected'"), 'the S1-era predicates are kept');
  const kindCk = (await defs(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'eventinventorymovement_kind_check'`))[0].d;
  assert.ok(kindCk.includes("'uncommit'"));
  const idx = (await defs(`select indexname, indexdef from pg_indexes where indexname in ('eventpayment_one_live_per_order','eventpayment_one_succeeded_per_order','refund_live_event_registration_ux','refund_live_event_cancelled_order_ux','refund_live_event_unfulfilled_order_ux')`));
  assert.equal(idx.length, 5);
  assert.ok(idx.find(i => i.indexname === 'eventpayment_one_succeeded_per_order').indexdef.includes("status = 'succeeded'"));
  assert.ok(idx.find(i => i.indexname === 'eventpayment_one_live_per_order').indexdef.includes('reconciliation_required'));
  const cols = async t => (await defs(`select column_name from information_schema.columns where table_name = '${t}'`)).map(r => r.column_name);
  for (const [t, want] of [['EventPayment', ['eventId', 'organizerId', 'submittedAt', 'method', 'rejectCode', 'lateOrder', 'refundId', 'settledNote', 'organizationId', 'payerMethod', 'paidOn', 'idempotencyFingerprint']],
    ['EventOrder', ['organizerId', 'commissionPctSnapshot', 'holdCapAt', 'holdExtendedAt', 'holdExtensions', 'refundedTzs', 'paymentMethod', 'settlementStatementId']],
    ['EventRegistration', ['paidAmountTzs', 'paidAt', 'refundedTzs', 'refundId']], ['EventTicket', ['tokenVersion', 'tokenKeyId', 'displayCode', 'rotatedAt', 'issuedForUserId']],
    ['Refund', ['eventId', 'eventOrderId', 'eventRegistrationId', 'organizerId', 'organizationId', 'scope', 'policySnapshot', 'batchId', 'eventPaymentId']]]) {
    const have = await cols(t);
    for (const c of want) assert.ok(have.includes(c), `${t}.${c}`);
  }
  // the CHECKs bite
  await assert.rejects(() => db.raw(`insert into "Refund" (id, "memberId", kind, "amountTzs", "reasonCode", status) values ('rfd_chk', 'nobody', 'event_order', 5, 'x', 'requested')`), /violates|foreign key/);
});

test('migration down FAILS CLOSED over real rows, and restores the S3 schema exactly on an empty database (separate throwaway database)', async () => {
  // 1. with a real money row present, down refuses and changes nothing
  const migration = createRequire(import.meta.url)('../db/migrations/20270110091100-events-payments-tickets.cjs');
  const f = await h.sellingEvent({});
  const buyerSub = await h.user({});
  const o = await (await import('../src/bootstrap/services.mjs')).eventStore.createOrderWithHolds({
    eventId: f.event.id, purchaserUserId: buyerSub, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }],
    participants: [{ ticketTypeId: f.ticket.id, firstName: 'A', lastName: 'B', consentBasis: 'self' }],
  });
  assert.equal(o.error, undefined, JSON.stringify(o));
  const payId = `evp_${uid('').slice(1)}`;
  await db('EventPayment').insert({ id: payId, orderId: o.order.id, provider: 'manual', merchantReference: payId, amountTzs: 20000, currency: 'TZS', status: 'pending', method: 'manual' });
  await assert.rejects(() => migration.down(db), /EventPayment row\(s\) exist|event PaymentRequest|cannot be dropped/);
  assert.ok((await db.raw(`select 1 from information_schema.columns where table_name = 'EventPayment' and column_name = 'method'`)).rows.length, 'nothing was dropped');
  await db('EventPayment').where({ id: payId }).del();
  // each class of S4 row blocks it on its own
  const blocks = [
    [() => db('EventOrder').where({ id: o.order.id }).update({ holdExtensions: 1 }), () => db('EventOrder').where({ id: o.order.id }).update({ holdExtensions: 0 }), /EventOrder row/],
    [() => db('EventRegistration').where({ orderId: o.order.id }).update({ paidAmountTzs: 20000 }), () => db('EventRegistration').where({ orderId: o.order.id }).update({ paidAmountTzs: null }), /EventRegistration row/],
  ];
  for (const [set, unset, re] of blocks) { await set(); await assert.rejects(() => migration.down(db), re); await unset(); }
  // 2. on an empty database: down restores S3 exactly, and up applies again
  const url = new URL(process.env.DATABASE_URL_CI);
  const name = `${url.pathname.slice(1)}_mig_${uid('').slice(1, 7)}`;
  const admin = new URL(process.env.DATABASE_URL_CI); admin.pathname = '/postgres';
  let created = false;
  try { execSync(`psql "${admin.toString()}" -c 'CREATE DATABASE "${name}"'`, { stdio: 'pipe' }); created = true; } catch { /* no CREATE DATABASE privilege here: the real-row checks above still ran */ }
  if (!created) return;
  const knexFactory = (await import('knex')).default;
  const temp = new URL(process.env.DATABASE_URL_CI); temp.pathname = `/${name}`;
  const k = knexFactory({ client: 'pg', connection: temp.toString(), migrations: { directory: path.resolve(import.meta.dirname, '../db/migrations'), tableName: 'knex_migrations', loadExtensions: ['.cjs'] } });
  try {
    await k.migrate.latest();
    const ck = async () => (await k.raw(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'refund_ck'`)).rows[0].d;
    assert.ok((await ck()).includes('event_order'));
    const NAME = '20270110091100-events-payments-tickets.cjs';
    await k.migrate.down({ name: NAME });
    assert.ok(!(await ck()).includes('event_order'), 'the refund kind check is back to three kinds');
    const colsOf = async t => (await k.raw(`select column_name from information_schema.columns where table_name = '${t}'`)).rows.map(r => r.column_name);
    for (const [t, gone] of [['EventPayment', ['method', 'idempotencyFingerprint']], ['EventTicket', ['tokenVersion', 'displayCode']], ['Refund', ['scope', 'batchId']], ['EventOrder', ['holdExtensions']], ['EventRegistration', ['paidAmountTzs']]]) {
      const have = await colsOf(t);
      for (const c of gone) assert.ok(!have.includes(c), `${t}.${c} dropped`);
    }
    assert.ok((await k.raw(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'eventinventorymovement_kind_check'`)).rows[0].d.includes("'commit'") && !(await k.raw(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'eventinventorymovement_kind_check'`)).rows[0].d.includes('uncommit'));
    await k.migrate.up({ name: NAME });   // and up again
    assert.ok((await ck()).includes('event_order'));
    const [, pending] = await k.migrate.list();
    assert.equal(pending.length, 0);
  } finally {
    await k.destroy();
    try { execSync(`psql "${admin.toString()}" -c 'DROP DATABASE "${name}"'`, { stdio: 'pipe' }); } catch { /* left for the operator */ }
  }
});

test('the refund policy is frozen at submission WITH its structured fields; the member-facing detail reads the snapshot and adds the generated line', async () => {
  const { eventStore: store, eventsOrganizerService, eventsDiscoveryService } = await import('../src/bootstrap/services.mjs');
  const f = await h.publishedEvent({ publish: false, categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early', priceTzs: 20000, capacity: 10 }] }] });
  const policy = { preset: 'tiered', tiers: [{ daysBefore: 30, percent: 100 }, { daysBefore: 14, percent: 50 }], text: { en: null, sw: null } };
  const saved = await store.updateEvent(f.event.id, { refundPolicy: policy }, { expectedVersion: f.event.version });
  assert.equal(saved.error, undefined, JSON.stringify(saved));
  const moved = await eventsOrganizerService.moveEvent(f.event.id, 'submitted', { actor: { id: f.organizer.ownerUserId, kind: 'organizer', role: 'owner' } });
  assert.equal(moved.error, undefined, JSON.stringify(moved));
  const snap = (await db('Event').where({ id: f.event.id }).first()).refundPolicySnapshot;
  assert.deepEqual(snap.tiers, policy.tiers);
  assert.equal(snap.preset, 'tiered');
  const published = await store.transitionEvent(f.event.id, 'published');
  // once published, the snapshot participants agreed to is frozen
  const later = await store.updateEvent(f.event.id, { refundPolicySnapshot: { preset: 'no_refund' } }, { expectedVersion: published.event.version });
  assert.deepEqual([later.error, later.field], ['event_frozen_field', 'refundPolicySnapshot']);
  const detail = await eventsDiscoveryService.detail({ idOrSlug: f.event.id });
  const view = detail.refundPolicy ?? detail.event?.refundPolicy;
  assert.deepEqual(view.tiers, policy.tiers);
  assert.match(view.generated.en, /^100% until 30 days before, then 50% until 14 days before, then no refund\.$/);
});
