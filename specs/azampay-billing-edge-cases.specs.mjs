// AzamPay is the only payment method (owner decision 2026-11-17): the billing edge
// cases of a payment request (pass, renewal, upgrade, gym plan), service-level on
// in-memory stores with the real admin payment and subscription services. AzamPay
// has no status query, so its verified callback is the only confirmation; the
// event-order cases are in events-s4-azampay.specs.mjs (CI database).
//
// Rule of thumb checked throughout: money that does not match exactly one open
// attempt is never approved and never dropped — it is written to the audit log
// for staff (held / orphaned), and nothing is activated twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCallback, AzamPayError } from '../src/integrations/payments/azampay.mjs';
import { createMobileMoneyService } from '../src/services/mobile-money-service.mjs';
import { createAdminPaymentService } from '../src/services/admin-payment-service.mjs';
import { createSubscriptionService } from '../src/services/subscription-service.mjs';
import { PROMPT_TTL_MS, CLAIM_TTL_MS, mobileMoneyInFlight } from '../src/shared/mobile-money-claim.mjs';
import { SCHEDULED } from '../src/shared/subscription-status.mjs';
import { settingsWithTiers } from './fixtures/tier-settings.mjs';

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find((r) => r.id === id) || null; },
    async allAsync() { return [...rows]; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
    // As the database store does it: compare and write in one step, so two racing writers cannot both win.
    async updateByIdWhereAsync(id, where, patch) {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return null;
      for (const [column, expected] of Object.entries(where || {})) {
        const current = rows[i][column] ?? null;
        if (Array.isArray(expected) ? !expected.includes(current) : current !== expected) return null;
      }
      rows[i] = { ...rows[i], ...patch };
      return rows[i];
    },
  };
}
const DAY = 86_400_000;
const MIN = 60_000;
const T0 = 1_800_000_000_000;
const iso = (ms) => new Date(ms).toISOString();
const PRICES = { basic: 60_000, pro: 120_000 };
const tiers = Object.entries(PRICES).map(([key, monthlyPrice]) => ({ key, label: key, monthlyPrice, visits: 20, gymAccess: 'standard' }));

const pendingPass = () => ({
  subs: [{ id: 'sub_new', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'payment_pending', startedAt: iso(Date.now()), expiresAt: iso(Date.now() + 30 * DAY) }],
  requests: [{ id: 'pay_1', memberId: 'm1', subscriptionId: 'sub_new', tier: 'basic', amountTzs: 60_000, status: 'pending', provider: 'admin_approved', reference: null, note: null, requestedAt: iso(Date.now()) }],
});

function world({ subs, requests, scheduleRenewals = false, canSettle = true, onHeldThrows = false } = {}) {
  const base = pendingPass();
  const subscriptions = memStore(subs ?? base.subs);
  const paymentRequests = memStore(requests ?? base.requests);
  const audit = [];
  const auditLog = { async insertAsync(e) { audit.push(e); } };
  const events = [];
  const adminPaymentService = createAdminPaymentService({
    paymentRequests, subscriptions, users: memStore(), auditLog,
    onSubscriptionActivated: async (s) => { events.push(['activated', s.id]); },
    onSubscriptionScheduled: async (s) => { events.push(['scheduled', s.id]); },
    onPassUpgraded: async (s) => { events.push(['upgraded', s.id]); },
    scheduleRenewals: () => scheduleRenewals,
  });
  const remote = { initiated: [], failInitiate: null, slow: null };
  const clock = { t: T0 };
  const client = {
    environment: 'sandbox', confirmsByCallback: true, parseCallback,
    async initiatePayment(args) {
      if (remote.slow) await remote.slow;
      if (remote.failInitiate) throw new AzamPayError('no', { code: remote.failInitiate, status: remote.failInitiate === 'provider_error' ? 500 : 400 });
      remote.initiated.push(args);
      return { transactionId: `TXN_${remote.initiated.length}` };
    },
  };
  // What bootstrap wires to an ops exception: staff are told about confirmed money that was not applied.
  const held = [];
  const service = createMobileMoneyService({
    paymentRequests, subscriptions, adminPaymentService, auditLog, client,
    enabled: () => true, canSettle: () => canSettle, now: () => clock.t,
    onHeld: async (request, reason, detail) => { held.push([request.id, reason, detail.transactionId, detail.amountTzs]); if (onHeldThrows) throw new Error('ops down'); },
  });
  const subscriptionService = createSubscriptionService({
    subscriptions, paymentRequests, checkins: memStore(), gyms: [],
    settingsService: settingsWithTiers(tiers), publicUserId: async () => 'FF-1', now: () => clock.t,
  });
  const req = (id = 'pay_1') => paymentRequests.rows.find((r) => r.id === id);
  const sub = (id = 'sub_new') => subscriptions.rows.find((s) => s.id === id);
  const audited = (action) => audit.filter((a) => a.action === action);
  return { subscriptions, paymentRequests, audit, audited, events, held, service, subscriptionService, adminPaymentService, remote, clock, req, sub };
}
const PAY = { memberId: 'm1', paymentRequestId: 'pay_1', phone: '0754123456' };
/** AzamPay's callback as the route hands it over once the signature is verified. */
const cb = (over = {}) => ({
  message: 'ok', clientId: 'cid', transactionstatus: 'success', operator: 'Mpesa', reference: null, externalreference: null,
  utilityref: 'pay_1.a1', amount: '60000', transid: 'TXN_1', msisdn: '255754123456', mnoreference: 'MNO1', ...over,
});
const activations = (w) => w.events.filter((e) => e[0] === 'activated').length;

// ── the amount ──────────────────────────────────────────────────────────────

test('the exact amount settles the request once: plan active, one activation, the audit names AzamPay', async () => {
  const w = world();
  assert.equal((await w.service.pay(PAY)).status, 202);
  assert.ok(w.req().promptedAt, 'the time the prompt went out is recorded');
  const out = await w.service.handleCallback(cb());
  assert.deepEqual([out.status, out.state], [200, 'completed']);
  assert.deepEqual([w.req().status, w.req().reference, w.req().decidedBy, w.sub().status], ['approved', 'TXN_1', 'azampay', 'active']);
  assert.equal(activations(w), 1);
});

test('less than asked (partial), more than asked (over), a missing or a non-numeric amount: held, nothing activated, what was received is in the audit', async () => {
  for (const [amount, received] of [['59999', 59_999], ['1000', 1000], ['60001', 60_001], ['120000', 120_000], ['', null], [undefined, null], ['abc', null], ['0', null], ['-60000', null], ['59999.5', null], ['60000.4', null]]) {
    const w = world();
    await w.service.pay(PAY);
    const out = await w.service.handleCallback(cb({ amount }));
    assert.deepEqual([out.state, out.reason], ['held', 'amount_mismatch'], `amount ${amount}`);
    assert.deepEqual([w.req().status, w.req().provider, w.req().reference, w.sub().status], ['pending', 'azampay', 'TXN_1', 'payment_pending'], `amount ${amount}`);
    assert.equal(activations(w), 0);
    const [row] = w.audited('payment_mobile_money_amount_mismatch');
    assert.deepEqual([row.target, row.actor, row.before.amountTzs, row.after.received, row.after.transactionId], ['pay_1', 'azampay', 60_000, received, 'TXN_1'], `amount ${amount}`);
    // No credit and no part-plan: staff settle it (here: the member was refunded and the request rejected).
    const rejected = await w.adminPaymentService.decide({ id: 'pay_1', decision: 'reject', actorId: 'admin_1' });
    assert.equal(rejected.error, undefined);
    assert.equal(w.sub().status === 'active', false);
  }
});

// ── repeats and requests that are no longer open ────────────────────────────

test('a duplicate callback does not activate twice', async () => {
  const w = world();
  await w.service.pay(PAY);
  await w.service.handleCallback(cb());
  const decidedAt = w.req().decidedAt;
  for (let i = 0; i < 3; i += 1) assert.equal((await w.service.handleCallback(cb())).state, 'completed');
  // the same transaction under another of AzamPay's ids is still the same payment
  assert.equal((await w.service.handleCallback(cb({ transid: 'MNO_X', reference: 'TXN_1' }))).state, 'completed');
  assert.equal(activations(w), 1);
  assert.equal(w.req().decidedAt, decidedAt);
  assert.equal(w.audited('payment_mobile_money_orphaned').length, 0, 'a repeat is not a second payment');
});

test('two callbacks for the same payment racing each other activate once', async () => {
  const w = world();
  await w.service.pay(PAY);
  const out = await Promise.all([w.service.handleCallback(cb()), w.service.handleCallback(cb())]);
  assert.deepEqual(out.map((o) => o.state), ['completed', 'completed']);
  assert.equal(activations(w), 1);
});

test('a DIFFERENT transaction confirmed for an already approved request is recorded as orphaned (paid twice); nothing changes', async () => {
  const w = world();
  await w.service.pay(PAY);
  await w.service.handleCallback(cb());
  const before = { ...w.req() };
  const out = await w.service.handleCallback(cb({ transid: 'TXN_SECOND', utilityref: 'pay_1.zz' }));
  assert.equal(out.state, 'completed');
  assert.deepEqual(w.req(), before);
  assert.equal(activations(w), 1);
  const [row] = w.audited('payment_mobile_money_orphaned');
  assert.deepEqual([row.target, row.before.status, row.before.reference, row.after.transactionId, row.after.amountTzs, row.after.error], ['pay_1', 'approved', 'TXN_1', 'TXN_SECOND', 60_000, 'already_settled']);
});

test('a success for a request staff already approved by hand is recorded as orphaned', async () => {
  const w = world();
  await w.adminPaymentService.decide({ id: 'pay_1', decision: 'approve', reference: 'BANK_REF_77', actorId: 'admin_1', amountTzs: 60_000 });
  assert.equal(w.sub().status, 'active');
  const out = await w.service.handleCallback(cb());
  assert.equal(out.state, 'completed');
  assert.equal(w.audited('payment_mobile_money_orphaned')[0].after.error, 'already_settled');
  assert.equal(w.req().reference, 'BANK_REF_77');
});

test('a success for a rejected, a cancelled or an expired request is recorded as orphaned; nothing is activated', async () => {
  for (const status of ['rejected', 'cancelled', 'expired']) {
    const w = world();
    await w.service.pay(PAY);
    Object.assign(w.req(), { status, decidedAt: iso(w.clock.t), decidedBy: 'admin_1' });
    w.sub().status = 'payment_cancelled';
    const out = await w.service.handleCallback(cb());
    assert.equal(out.state, 'failed', status);
    assert.deepEqual([w.req().status, w.sub().status], [status, 'payment_cancelled'], status);
    assert.equal(activations(w), 0);
    const [row] = w.audited('payment_mobile_money_orphaned');
    assert.deepEqual([row.before.status, row.after.transactionId, row.after.amountTzs, row.after.error], [status, 'TXN_1', 60_000, 'request_closed'], status);
    // a FAILED answer for a closed request is nothing to report
    const w2 = world();
    await w2.service.pay(PAY);
    Object.assign(w2.req(), { status });
    await w2.service.handleCallback(cb({ transactionstatus: 'failure' }));
    assert.equal(w2.audited('payment_mobile_money_orphaned').length, 0, status);
  }
});

test('a request rejected between the callback\'s read and its approval: the money is orphaned, not approved', async () => {
  const w = world();
  await w.service.pay(PAY);
  const racing = createMobileMoneyService({
    paymentRequests: w.paymentRequests, subscriptions: w.subscriptions, auditLog: { async insertAsync(e) { w.audit.push(e); } },
    client: { environment: 'sandbox', confirmsByCallback: true, parseCallback }, enabled: () => true, now: () => w.clock.t,
    adminPaymentService: { decide: async () => { Object.assign(w.req(), { status: 'rejected' }); return { error: 'already_decided', status: 409 }; } },
  });
  const out = await racing.handleCallback(cb());
  assert.deepEqual([out.state, out.reason], ['held', 'request_closed']);
  assert.equal(w.audited('payment_mobile_money_orphaned')[0].after.error, 'request_closed');
  assert.equal(w.sub().status, 'payment_pending');
});

// ── failure, retry, and answers that come in the wrong order ────────────────

test('failure releases the request for a retry; the retry is a new attempt with its own reference', async () => {
  const w = world();
  await w.service.pay(PAY);
  const failed = await w.service.handleCallback(cb({ transactionstatus: 'failure', message: 'Insufficient funds' }));
  assert.deepEqual([failed.state], ['failed']);
  assert.deepEqual([w.req().status, w.req().provider, w.req().reference, w.req().promptedAt], ['pending', 'admin_approved', null, null]);
  assert.equal(w.audited('payment_mobile_money_failed')[0].after.why, 'Insufficient funds');
  w.clock.t += 1000;
  assert.equal((await w.service.pay(PAY)).status, 202);
  assert.notEqual(w.remote.initiated[0].reference, w.remote.initiated[1].reference);
  assert.equal((await w.service.handleCallback(cb({ transid: 'TXN_2' }))).state, 'completed');
  assert.equal(activations(w), 1);
});

test('success after failure for the same attempt (the request was released): held for staff as orphaned, nothing activated', async () => {
  const w = world();
  await w.service.pay(PAY);
  await w.service.handleCallback(cb({ transactionstatus: 'failure' }));
  const out = await w.service.handleCallback(cb());
  assert.deepEqual([out.state, out.reason], ['held', 'no_open_attempt']);
  assert.deepEqual([w.req().status, w.req().provider, w.sub().status], ['pending', 'admin_approved', 'payment_pending']);
  assert.equal(activations(w), 0);
  const [row] = w.audited('payment_mobile_money_orphaned');
  assert.deepEqual([row.before.status, row.after.transactionId, row.after.amountTzs, row.after.error], ['pending', 'TXN_1', 60_000, 'no_open_attempt']);
  // Staff find the money in AzamPay's statement and approve the request with that transaction: activated once.
  const ok = await w.adminPaymentService.decide({ id: 'pay_1', decision: 'approve', reference: 'TXN_1', actorId: 'admin_1', amountTzs: 60_000 });
  assert.equal(ok.error, undefined);
  assert.equal(activations(w), 1);
});

test('a late failure for an older attempt changes nothing about the prompt that is out', async () => {
  const w = world();
  await w.service.pay(PAY);
  await w.service.handleCallback(cb({ transactionstatus: 'failure' }));
  w.clock.t += 1000;
  await w.service.pay(PAY);                                   // TXN_2 is out
  const before = { ...w.req() };
  const out = await w.service.handleCallback(cb({ transactionstatus: 'failure' }));   // TXN_1 again
  assert.equal(out.state, 'failed');
  assert.deepEqual(w.req(), before);
});

test('double tap: two prompts asked at once send one; a third tap while it is out sends none', async () => {
  const w = world();
  let go;
  w.remote.slow = new Promise((r) => { go = r; });
  const both = Promise.all([w.service.pay(PAY), w.service.pay(PAY)]);
  go();
  const out = await both;
  assert.deepEqual(out.map((o) => o.status).sort(), [200, 202]);
  assert.equal(out.filter((o) => o.alreadyRequested).length, 1);
  assert.equal(w.remote.initiated.length, 1);
  const third = await w.service.pay({ ...PAY, phone: '0754999888' });
  assert.deepEqual([third.status, third.alreadyRequested], [200, true]);
  assert.equal(w.remote.initiated.length, 1);
  assert.equal(w.audited('payment_mobile_money_requested').length, 1);
});

test('AzamPay answering before its own checkout call returns: the request it settled is not written over', async () => {
  const w = world();
  let go;
  w.remote.slow = new Promise((r) => { go = r; });
  const paying = w.service.pay(PAY);
  await new Promise((r) => setImmediate(r));
  assert.match(w.req().reference, /^pending:/);
  assert.equal((await w.service.handleCallback(cb())).state, 'completed');   // found by our reference
  go();
  const out = await paying;
  assert.deepEqual([out.status, out.state], [200, 'completed']);
  assert.deepEqual([w.req().status, w.req().reference], ['approved', 'TXN_1']);
  assert.equal(activations(w), 1);
});

// ── a prompt whose callback never arrives ───────────────────────────────────

test('a prompt whose answer never comes stays in flight for PROMPT_TTL_MS, then the member may ask for a new one', async () => {
  const w = world();
  await w.service.pay(PAY);
  w.clock.t += PROMPT_TTL_MS - 1000;
  assert.equal(mobileMoneyInFlight(w.req(), w.clock.t), true);
  assert.equal((await w.service.pay(PAY)).alreadyRequested, true);
  assert.equal((await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_1' })).state, 'in_progress');
  w.clock.t += 2000;
  assert.equal(mobileMoneyInFlight(w.req(), w.clock.t), false);
  const again = await w.service.pay(PAY);
  assert.equal(again.status, 202);
  assert.equal(w.remote.initiated.length, 2);
  assert.deepEqual([w.req().provider, w.req().reference, w.req().promptedAt], ['azampay', 'TXN_2', iso(w.clock.t)]);
  // the audit names the prompt that was given up, so a late success for it can be traced
  assert.deepEqual(w.audited('payment_mobile_money_prompt_expired')[0].before.reference, 'TXN_1');
});

test('a callback for the OLDER attempt after a retry is held (not approved); the new attempt settles; the old money stays on record', async () => {
  const w = world();
  await w.service.pay(PAY);
  const first = w.remote.initiated[0].reference;
  w.clock.t += PROMPT_TTL_MS + 1000;
  await w.service.pay(PAY);
  // the member approved the first prompt after all: its success arrives late, for the old attempt reference
  const late = await w.service.handleCallback(cb({ utilityref: first, transid: 'TXN_1' }));
  assert.deepEqual([late.state, late.reason], ['held', 'transaction_mismatch']);
  assert.deepEqual([w.req().status, w.req().reference, w.sub().status], ['pending', 'TXN_2', 'payment_pending']);
  const held = w.audited('payment_mobile_money_held')[0];
  assert.deepEqual([held.before.reference, held.after.error, held.after.transactionId, held.after.amountTzs], ['TXN_2', 'transaction_mismatch', 'TXN_1', 60_000]);
  // the new prompt is paid too: the request settles once, on the transaction it was waiting for
  assert.equal((await w.service.handleCallback(cb({ utilityref: w.remote.initiated[1].reference, transid: 'TXN_2' }))).state, 'completed');
  assert.deepEqual([w.req().status, w.req().reference], ['approved', 'TXN_2']);
  assert.equal(activations(w), 1);
  // AzamPay repeats the old success: now it is a second payment on a settled request
  await w.service.handleCallback(cb({ utilityref: first, transid: 'TXN_1' }));
  assert.equal(w.audited('payment_mobile_money_orphaned')[0].after.error, 'already_settled');
  assert.equal(activations(w), 1);
});

test('refresh after the window gives the request back; a success that still arrives is held as orphaned, never lost and never auto-approved', async () => {
  const w = world();
  await w.service.pay(PAY);
  w.clock.t += PROMPT_TTL_MS + 1000;
  const out = await w.service.refresh({ memberId: 'm1', paymentRequestId: 'pay_1' });
  assert.equal(out.state, 'none');
  assert.deepEqual([w.req().status, w.req().provider, w.req().reference, w.req().promptedAt], ['pending', 'admin_approved', null, null]);
  const released = w.audited('payment_mobile_money_failed')[0];
  assert.deepEqual([released.before.reference, released.after.why], ['TXN_1', 'prompt_expired']);
  const late = await w.service.handleCallback(cb());
  assert.deepEqual([late.state, late.reason], ['held', 'no_open_attempt']);
  assert.equal(w.sub().status, 'payment_pending');
  assert.equal(w.audited('payment_mobile_money_orphaned')[0].after.transactionId, 'TXN_1');
});

test('a prompt sent before promptedAt existed keeps waiting (staff or its callback decide it); a stale claim is still taken over', async () => {
  const base = pendingPass();
  const w = world({ requests: [{ ...base.requests[0], provider: 'azampay', reference: 'TXN_OLD' }] });
  w.clock.t += 30 * DAY;
  assert.equal((await w.service.pay(PAY)).alreadyRequested, true);
  assert.equal(w.remote.initiated.length, 0);
  assert.equal((await w.service.handleCallback(cb({ transid: 'TXN_OLD' }))).state, 'completed');

  const c = world();
  c.remote.failInitiate = 'unreachable';            // the prompt may be out: the claim is kept
  assert.equal((await c.service.pay(PAY)).error, 'provider_unavailable');
  c.remote.failInitiate = null;
  assert.equal((await c.service.pay(PAY)).alreadyRequested, true);
  c.clock.t += CLAIM_TTL_MS + 1000;
  assert.equal((await c.service.pay(PAY)).status, 202);
  assert.equal(c.audited('payment_mobile_money_prompt_expired').length, 0, 'a claim is not a prompt');
});

test('a request left with another provider\'s prompt (before 2026-11-17) is not prompted again: staff decide it', async () => {
  const base = pendingPass();
  const w = world({ requests: [{ ...base.requests[0], provider: 'tunzaa', reference: 'TZ_1' }] });
  const out = await w.service.pay(PAY);
  assert.deepEqual([out.status, out.alreadyRequested], [200, true]);
  assert.equal(w.remote.initiated.length, 0);
  assert.equal((await w.adminPaymentService.decide({ id: 'pay_1', decision: 'reject', actorId: 'admin_1' })).error, undefined);
});

// ── security review of functions#360 ────────────────────────────────────────

test('a late success for the OLD prompt arriving while the retry is being sent (reference is only a claim) is held, not approved; the second prompt still goes out and settles once', async () => {
  for (const how of ['expired', 'failed']) {
    const w = world();
    await w.service.pay(PAY);                                              // TXN_1
    if (how === 'expired') w.clock.t += PROMPT_TTL_MS + 1000;
    else { await w.service.handleCallback(cb({ transactionstatus: 'failure' })); w.clock.t += 1000; }
    let go;
    w.remote.slow = new Promise((r) => { go = r; });
    const retrying = w.service.pay(PAY);                                   // claimed, AzamPay not answered yet
    await new Promise((r) => setImmediate(r));
    assert.match(w.req().reference, /^pending:/, how);
    assert.deepEqual(w.req().supersededReferences, ['TXN_1'], `${how}: the given-up prompt is remembered`);
    // the old prompt's success lands in that window — by any of AzamPay's names for the transaction
    const late = await w.service.handleCallback(cb({ transid: 'MNO_7', reference: 'TXN_1' }));
    assert.deepEqual([late.state, late.reason], ['held', 'transaction_mismatch'], how);
    assert.deepEqual([w.req().status, w.sub().status, activations(w)], ['pending', 'payment_pending', 0], how);
    const row = w.audited('payment_mobile_money_held')[0];
    assert.deepEqual([row.after.error, row.after.superseded, row.after.transactionId, row.after.amountTzs], ['transaction_mismatch', true, 'TXN_1', 60_000], how);
    assert.deepEqual(w.held, [['pay_1', 'transaction_mismatch', 'TXN_1', 60_000]], `${how}: staff are told`);
    go();
    assert.equal((await retrying).status, 202, how);
    assert.deepEqual([w.remote.initiated.length, w.req().reference], [2, 'TXN_2'], how);
    assert.equal((await w.service.handleCallback(cb({ transid: 'TXN_2' }))).state, 'completed', how);
    assert.equal(activations(w), 1, how);
  }
});

test('a lost-record claim (no transaction id recorded) still settles by our reference when the transaction is not one the request gave up', async () => {
  const w = world();
  w.remote.failInitiate = 'unreachable';                                  // the prompt may be out; no transaction id recorded
  await w.service.pay(PAY);
  assert.match(w.req().reference, /^pending:/);
  assert.equal((await w.service.handleCallback(cb({ transid: 'TXN_LOST' }))).state, 'completed');
  assert.equal(activations(w), 1);
});

test('the request is read again after the claim: one that was settled in between is not sent to a phone', async () => {
  const w = world();
  const original = w.paymentRequests.updateByIdWhereAsync.bind(w.paymentRequests);
  let once = true;
  // A callback lands right after the claim is written (here: staff approved it by hand at that moment).
  w.paymentRequests.updateByIdWhereAsync = async (id, where, patch) => {
    const out = await original(id, where, patch);
    if (out && once && String(patch.reference ?? '').startsWith('pending:')) {
      once = false;
      Object.assign(w.req(), { status: 'approved', reference: 'BANK_1', decidedBy: 'admin_1' });
    }
    return out;
  };
  const out = await w.service.pay(PAY);
  assert.deepEqual([out.status, out.state, out.alreadyRequested], [200, 'completed', true]);
  assert.equal(w.remote.initiated.length, 0, 'no prompt for a settled request');
  assert.deepEqual([w.req().status, w.req().reference], ['approved', 'BANK_1']);
});

test('held money on a pass / plan is raised for staff (as events do), once per request and transaction; a failing raise never changes the outcome', async () => {
  // amount mismatch
  const a = world();
  await a.service.pay(PAY);
  await a.service.handleCallback(cb({ amount: '1000' }));
  assert.deepEqual(a.held, [['pay_1', 'amount_mismatch', 'TXN_1', 1000]]);
  // no attempt open, then paid twice
  const b = world();
  await b.service.pay(PAY);
  await b.service.handleCallback(cb({ transactionstatus: 'failure' }));
  await b.service.handleCallback(cb());
  assert.deepEqual(b.held, [['pay_1', 'no_open_attempt', 'TXN_1', 60_000]]);
  const c = world();
  await c.service.pay(PAY);
  await c.service.handleCallback(cb());
  assert.deepEqual(c.held, [], 'a clean payment raises nothing');
  await c.service.handleCallback(cb({ transid: 'TXN_SECOND' }));
  assert.deepEqual(c.held, [['pay_1', 'duplicate_payment', 'TXN_SECOND', 60_000]]);
  // a closed request, another transaction than the prompt, an upgrade whose plan ended
  const d = world();
  await d.service.pay(PAY);
  Object.assign(d.req(), { status: 'rejected' });
  await d.service.handleCallback(cb());
  assert.deepEqual(d.held, [['pay_1', 'request_closed', 'TXN_1', 60_000]]);
  const e = world();
  await e.service.pay(PAY);
  await e.service.handleCallback(cb({ transid: 'OTHER' }));
  assert.deepEqual(e.held, [['pay_1', 'transaction_mismatch', 'OTHER', 60_000]]);
  // a failure answer, a duplicate of a settled payment and a sandbox hold raise nothing
  const f = world();
  await f.service.pay(PAY);
  await f.service.handleCallback(cb({ transactionstatus: 'failure' }));
  assert.deepEqual(f.held, []);
  // the raise failing (ops store down) does not turn a held payment into an error, and nothing is approved
  const g = world({ onHeldThrows: true });
  await g.service.pay(PAY);
  const out = await g.service.handleCallback(cb({ amount: '1000' }));
  assert.deepEqual([out.status, out.state, g.req().status], [200, 'held', 'pending']);
  assert.equal(g.audited('payment_mobile_money_amount_mismatch').length, 1, 'the audit row is there whatever happens to the raise');
});

// ── one transaction, one request ────────────────────────────────────────────

test('the same AzamPay transaction used for two requests: the second is held', async () => {
  const base = pendingPass();
  const w = world({
    subs: [...base.subs, { ...base.subs[0], id: 'sub_2', memberId: 'm2' }],
    requests: [...base.requests, { ...base.requests[0], id: 'pay_2', memberId: 'm2', subscriptionId: 'sub_2' }],
  });
  await w.service.pay(PAY);
  assert.equal((await w.service.handleCallback(cb())).state, 'completed');
  // pay_2's prompt was lost (claim kept, no transaction recorded); a callback names it with pay_1's transaction
  w.remote.failInitiate = 'unreachable';
  await w.service.pay({ memberId: 'm2', paymentRequestId: 'pay_2', phone: '0754555666' });
  const out = await w.service.handleCallback(cb({ utilityref: 'pay_2.b1' }));
  assert.deepEqual([out.state, out.reason], ['held', 'reference_already_used']);
  assert.deepEqual([w.req('pay_2').status, w.sub('sub_2').status], ['pending', 'payment_pending']);
  assert.equal(w.audited('payment_mobile_money_held')[0].after.error, 'reference_already_used');
  assert.deepEqual(w.held, [['pay_2', 'reference_already_used', 'TXN_1', 60_000]]);
  assert.equal(activations(w), 1);
});

// ── renewals and upgrades ───────────────────────────────────────────────────

test('a scheduled renewal paid through AzamPay starts when the current plan ends; a repeat changes nothing', async () => {
  const end = iso(Date.now() + 5 * DAY);
  const start = iso(Date.now() - 25 * DAY);
  const base = pendingPass();
  const w = world({
    scheduleRenewals: true,
    subs: [{ id: 'sub_cur', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'active', startedAt: start, cycleStartedAt: start, expiresAt: end, renewsAt: end }, ...base.subs],
  });
  await w.service.pay(PAY);
  assert.equal((await w.service.handleCallback(cb())).state, 'completed');
  assert.deepEqual([w.req().status, w.req().decidedBy], ['approved', 'azampay']);
  assert.equal(w.sub().status, SCHEDULED);
  assert.equal(+new Date(w.sub().startedAt), +new Date(end), 'starts when the current pass ends');
  assert.equal(w.sub('sub_cur').status, 'active');
  assert.deepEqual(w.events, [['scheduled', 'sub_new']]);
  await w.service.handleCallback(cb());
  assert.deepEqual(w.events, [['scheduled', 'sub_new']]);
  // the wrong amount for a renewal is held like any other
  const p = world({ scheduleRenewals: true, subs: [{ id: 'sub_cur', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'active', startedAt: start, cycleStartedAt: start, expiresAt: end, renewsAt: end }, ...pendingPass().subs] });
  await p.service.pay(PAY);
  assert.equal((await p.service.handleCallback(cb({ amount: '30000' }))).state, 'held');
  assert.equal(p.sub().status, 'payment_pending');
});

test('an upgrade (the price difference) paid through AzamPay upgrades the plan in place, once', async () => {
  const start = iso(Date.now() - 25 * DAY);
  const end = iso(Date.now() + 5 * DAY);
  const w = world({ requests: [], subs: [{ id: 'sub_old', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'active', startedAt: start, cycleStartedAt: start, expiresAt: end, renewsAt: end }] });
  w.clock.t = Date.now();
  const up = await w.subscriptionService.upgradePass({ memberId: 'm1', tier: 'pro', reference: 'QGH7XK2L9P', payerPhone: '0712345678' });
  assert.equal(up.paymentRequest.amountTzs, 60_000, 'the difference, never the full price');
  assert.equal(up.paymentRequest.memberReference, undefined, 'a transaction ID typed by the member is no longer taken');
  const id = up.paymentRequest.id;
  assert.equal((await w.service.pay({ ...PAY, paymentRequestId: id })).status, 202);
  assert.equal(w.remote.initiated[0].amountTzs, 60_000);
  // the full price instead of the difference is held: no credit, no part-plan
  assert.equal((await w.service.handleCallback(cb({ utilityref: `${id}.a`, amount: '120000' }))).state, 'held');
  assert.equal(w.sub('sub_old').tier, 'basic');
  assert.equal((await w.service.handleCallback(cb({ utilityref: `${id}.a` }))).state, 'completed');
  const sub = w.sub('sub_old');
  assert.deepEqual([sub.tier, sub.status, sub.expiresAt, sub.cycleStartedAt], ['pro', 'active', end, start]);
  assert.equal(w.subscriptions.rows.length, 1);
  await w.service.handleCallback(cb({ utilityref: `${id}.a` }));
  assert.deepEqual(w.events, [['upgraded', 'sub_old']]);
});

test('an upgrade whose plan ended before the money arrived is held, not approved', async () => {
  const start = iso(Date.now() - 25 * DAY);
  const w = world({ requests: [], subs: [{ id: 'sub_old', memberId: 'm1', type: 'platform_pass', tier: 'basic', status: 'active', startedAt: start, cycleStartedAt: start, expiresAt: iso(Date.now() + DAY) }] });
  w.clock.t = Date.now();
  const up = await w.subscriptionService.upgradePass({ memberId: 'm1', tier: 'pro' });
  await w.service.pay({ ...PAY, paymentRequestId: up.paymentRequest.id });
  w.subscriptions.rows[0].expiresAt = iso(Date.now() - DAY);
  const out = await w.service.handleCallback(cb({ utilityref: `${up.paymentRequest.id}.a` }));
  assert.deepEqual([out.state, out.reason], ['held', 'upgrade_plan_not_active']);
  assert.equal(w.paymentRequests.rows[0].status, 'pending');
  assert.equal(w.audited('payment_mobile_money_held')[0].after.error, 'upgrade_plan_not_active');
});

test('a gym plan is paid the same way; while its prompt is out the plan cannot be cancelled, after the window it can', async () => {
  const w = world({
    subs: [{ id: 'sub_g', memberId: 'm1', type: 'direct_sub', plan: 'monthly', homeGymId: 'gym_1', status: 'payment_pending', startedAt: iso(Date.now()), expiresAt: iso(Date.now() + 30 * DAY) }],
    requests: [{ id: 'pay_g', memberId: 'm1', subscriptionId: 'sub_g', plan: 'monthly', gymId: 'gym_1', amountTzs: 80_000, status: 'pending', provider: 'admin_approved', reference: null }],
  });
  await w.service.pay({ ...PAY, paymentRequestId: 'pay_g' });
  assert.equal((await w.subscriptionService.cancelTrainerPass({ trainerUserId: 'm1', subscriptionId: 'sub_g' })).error, 'payment_in_progress');
  assert.equal((await w.service.handleCallback(cb({ utilityref: 'pay_g.a', amount: '80000' }))).state, 'completed');
  assert.equal(w.sub('sub_g').status, 'active');

  const c = world({
    subs: [{ id: 'sub_g', memberId: 'm1', type: 'direct_sub', plan: 'monthly', homeGymId: 'gym_1', status: 'payment_pending', startedAt: iso(Date.now()), expiresAt: iso(Date.now() + 30 * DAY) }],
    requests: [{ id: 'pay_g', memberId: 'm1', subscriptionId: 'sub_g', plan: 'monthly', gymId: 'gym_1', amountTzs: 80_000, status: 'pending', provider: 'admin_approved', reference: null }],
  });
  await c.service.pay({ ...PAY, paymentRequestId: 'pay_g' });
  c.clock.t += PROMPT_TTL_MS + 1000;
  assert.equal((await c.subscriptionService.cancelTrainerPass({ trainerUserId: 'm1', subscriptionId: 'sub_g' })).error, undefined);
  // the money for the cancelled plan still turns up: orphaned for staff, nothing activated
  assert.equal((await c.service.handleCallback(cb({ utilityref: 'pay_g.a', amount: '80000' }))).state, 'failed');
  assert.equal(c.audited('payment_mobile_money_orphaned')[0].after.error, 'request_closed');
  assert.equal(c.sub('sub_g').status, 'payment_cancelled');
});

// ── shop orders (AZAMPAY_SHOP_ORDERS) ───────────────────────────────────────

test('a member\'s shop order is payable only with its switch, only by the member, and only while the order still waits for the payment', async () => {
  const order = { id: 'pay_o', memberId: 'm1', orderId: 'ord_1', amountTzs: 25_000, currency: 'TZS', status: 'pending', provider: 'admin_approved', reference: null };
  const make = ({ on, problem = null }) => {
    const paymentRequests = memStore([{ ...order }]);
    const decided = [];
    const service = createMobileMoneyService({
      paymentRequests, subscriptions: memStore(), auditLog: { async insertAsync() {} },
      adminPaymentService: { decide: async (d) => { decided.push(d); const r = paymentRequests.rows[0]; Object.assign(r, { status: 'approved', reference: d.reference }); return { paymentRequest: r }; } },
      client: { environment: 'sandbox', confirmsByCallback: true, parseCallback, initiatePayment: async () => ({ transactionId: 'TXN_O' }) },
      enabled: () => true, now: () => T0,
      shopOrders: { enabled: () => on, beforePrompt: async () => problem },
    });
    return { service, paymentRequests, decided };
  };
  const off = make({ on: false });
  assert.equal((await off.service.pay({ ...PAY, paymentRequestId: 'pay_o' })).error, 'not_payable_this_way');
  assert.deepEqual(off.service.payableProducts('member'), ['FITFLEX_PASS', 'GYM_SUBSCRIPTION']);
  const gone = make({ on: true, problem: { error: 'order_not_payable', status: 409 } });
  assert.equal((await gone.service.pay({ ...PAY, paymentRequestId: 'pay_o' })).error, 'order_not_payable');
  const on = make({ on: true });
  assert.deepEqual(on.service.payableProducts('member'), ['FITFLEX_PASS', 'GYM_SUBSCRIPTION', 'SHOP_ORDER']);
  assert.equal((await on.service.pay({ ...PAY, paymentRequestId: 'pay_o', role: 'trainer' })).error, 'feature_disabled');
  assert.equal((await on.service.pay({ ...PAY, paymentRequestId: 'pay_o' })).status, 202);
  assert.equal((await on.service.handleCallback(cb({ utilityref: 'pay_o.a', transid: 'TXN_O', amount: '24000' }))).state, 'held');
  assert.equal((await on.service.handleCallback(cb({ utilityref: 'pay_o.a', transid: 'TXN_O', amount: '25000' }))).state, 'completed');
  assert.deepEqual([on.decided.length, on.decided[0].reference, on.decided[0].amountTzs, on.decided[0].automated], [1, 'TXN_O', 25_000, true]);
});
