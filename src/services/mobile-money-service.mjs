// Mobile-money payment of a payment request (Malipo by Tunzaa).
//
// A payment request is created as before (pass, upgrade, gym plan; with
// TUNZAA_TRAINER_PRODUCTS also trainer sessions and a trainer's gym pass). "Pay now"
// asks the payer's phone to approve exactly that request's amount; when the
// provider confirms, the request is approved through the SAME path an admin
// uses (adminPaymentService.decide), so every product, including pass
// upgrades, is settled by one piece of code.
//
//   pending (provider admin_approved)
//      ── pay ──▶ pending (provider tunzaa, reference = 'pending:<ms>')   claimed, call going out
//      ── sent ──▶ pending (provider tunzaa, reference = transaction id)  prompt on the phone
//      ── COMPLETED ──▶ approved       ── FAILED ──▶ pending again (member may retry)
//
// Nothing the callback says is taken on trust: a COMPLETED callback is only a
// trigger, and the transaction's status and amount are read back from Tunzaa
// before the request is approved. A callback is tied to its request by OUR
// reference (reference_id = "<request id>.<attempt>"), which only a signed
// callback from Tunzaa can carry, so a prompt whose answer was lost (timeout)
// still settles the right request.
import { randomUUID } from 'node:crypto';
import { toMsisdn, maybeSent } from '../integrations/payments/tunzaa.mjs';
import { productTypeOfPayment, PRODUCT_TYPES } from '../shared/payment-product.mjs';
import { updateIf } from '../shared/conditional-update.mjs';
import {
  MOBILE_MONEY_PROVIDER, CLAIM_PLACEHOLDER, isClaimPlaceholder, claimAge, mobileMoneyInFlight,
} from '../shared/mobile-money-claim.mjs';

const PROVIDER = MOBILE_MONEY_PROVIDER;
const MANUAL = 'admin_approved';
/** Products paid this way: FitFlex Pass (incl. upgrades) and a gym's own plans. */
const BASE_PAYABLE = Object.freeze([PRODUCT_TYPES.FITFLEX_PASS, PRODUCT_TYPES.GYM_SUBSCRIPTION]);
/**
 * B6a (TUNZAA_TRAINER_PRODUCTS): trainer products too. SHOP_ORDER is never paid
 * this way (marketplace D-9: manual only).
 */
const TRAINER_PAYABLE = Object.freeze([PRODUCT_TYPES.TRAINER_SERVICE, PRODUCT_TYPES.TRAINER_GYM_PASS]);
/**
 * Which caller role pays which product (B6a). A trainer pays only their own
 * trainer gym pass; a member pays everything else that is payable, never a
 * trainer pass (that is the trainer persona's purchase).
 */
const ROLE_PRODUCTS = Object.freeze({
  member: Object.freeze([...BASE_PAYABLE, PRODUCT_TYPES.TRAINER_SERVICE]),
  trainer: Object.freeze([PRODUCT_TYPES.TRAINER_GYM_PASS]),
});
/** Mobile money is in Tanzanian shillings only. */
const CURRENCY = 'TZS';
const ACTOR = 'tunzaa';
const PLACEHOLDER = CLAIM_PLACEHOLDER;
/** At most this many prompts per member / per phone in the window. */
const LIMITS = { member: 5, phone: 3, windowMs: 10 * 60_000 };

/** Our reference for one attempt: "<request id>.<attempt>" (Tunzaa may require it to be unique). */
const referenceFor = (requestId, now) => `${requestId}.${now.toString(36)}`;
/** The request id inside a reference (or the id itself). */
export const requestIdOf = (referenceId) => String(referenceId ?? '').split('.')[0];

export function createMobileMoneyService({
  paymentRequests, subscriptions, adminPaymentService, auditLog,
  client = null,           // null while Tunzaa's credentials are not set
  enabled = () => false,   // the TUNZAA_PAYMENTS flag
  canSettle = () => true,  // false against the sandbox unless opted into
  scenario = null,         // sandbox only: 'success' | 'failure'
  now = () => Date.now(),
  // (tierKey) → boolean: may this FitFlex Pass tier be sold today (Settings)?
  // A pass or upgrade request for a tier that is no longer sold is not sent
  // to the phone. Wired to settingsService.isTierSellable in bootstrap.
  tierSellable = null,
  // B6a: the TUNZAA_TRAINER_PRODUCTS flag (effective only with TUNZAA_PAYMENTS). Read on every call.
  trainerProducts = () => false,
  // B6a (B1 security review): (request) → null | { error, status, bookingIds } before a
  // prompt goes out for a trainer booking group (trainerBookingService.checkGroupPayment).
  // Not wired: trainer sessions are not payable this way (fail closed).
  beforeBookingPayment = null,
  // Marathon & Events S4 (EVENTS_PAYMENTS_TUNZAA; built dormant). Absent / disabled: EVENT_ORDER is not payable this way and
  // every other branch is untouched. { enabled(), beforePrompt(request), afterPrompt(request, txn), onHeld(request, reason, detail), onFailed(request, remark) }
  eventOrders = null,
  // Callbacks already fully processed: { has(id) → bool, mark(id) } (WebhookSeen). Used for event requests only.
  webhookSeen = null,
}) {
  const fail = (error, status, extra = {}) => ({ error, status, ...extra });
  const audit = (action, target, before, after) => auditLog?.insertAsync?.({
    id: randomUUID(), at: new Date(now()).toISOString(), actor: ACTOR, action, target, before, after,
  });

  // Attempts in the window, per member and per phone (per process: enough to
  // stop a handset being flooded; the provider is the real limit).
  const attempts = new Map();
  function allowAttempt(key, limit) {
    const t = now();
    const recent = (attempts.get(key) || []).filter((x) => t - x < LIMITS.windowMs);
    if (recent.length >= limit) { attempts.set(key, recent); return false; }
    recent.push(t);
    attempts.set(key, recent);
    return true;
  }

  const isOn = () => Boolean(enabled() && client && canSettle());
  const roleOf = (role) => (role === 'trainer' ? 'trainer' : 'member');

  const eventsOn = () => Boolean(eventOrders?.enabled?.());

  /** The products payable this way right now, whoever pays. */
  function payable() {
    const set = new Set(BASE_PAYABLE);
    if (eventsOn()) set.add(PRODUCT_TYPES.EVENT_ORDER);
    if (trainerProducts()) {
      for (const p of TRAINER_PAYABLE) if (p !== PRODUCT_TYPES.TRAINER_SERVICE || beforeBookingPayment) set.add(p);
    }
    return set;
  }

  /** May this caller role pay this product this way? Without B6a only members reach here. */
  const roleMayPay = (role, product) => {
    // An event order is a member's purchase, never a trainer's or an organisation's.
    if (product === PRODUCT_TYPES.EVENT_ORDER) return roleOf(role) === 'member';
    return !trainerProducts() || ROLE_PRODUCTS[roleOf(role)].includes(product);
  };

  /** What the app needs to know before showing "Pay now". */
  function options() {
    const on = isOn();
    return { enabled: on, provider: PROVIDER, environment: on ? client.environment : null };
  }

  /**
   * B6a: the product kinds the caller may pay by mobile money now (empty when paying is off,
   * or for any role but member / trainer).
   */
  function payableProducts(role) {
    if (!isOn() || !['member', 'trainer'].includes(role)) return [];
    if (role === 'trainer' && !trainerProducts()) return [];
    const set = payable();
    const list = (trainerProducts() ? ROLE_PRODUCTS[role] : BASE_PAYABLE).filter((p) => set.has(p));
    // S4: members may also pay an event order while the Tunzaa event flag is effective.
    return role === 'member' && eventsOn() ? [...list, PRODUCT_TYPES.EVENT_ORDER] : list;
  }

  async function productOf(request) {
    const sub = request.subscriptionId ? await subscriptions.findByIdAsync(request.subscriptionId) : null;
    return productTypeOfPayment(request, sub);
  }

  const isPlaceholder = isClaimPlaceholder;
  const placeholderAge = (ref) => claimAge(ref, now());
  /** A prompt is out, or a call to send one is under way and recent. */
  const inFlight = (r) => mobileMoneyInFlight(r, now());

  /**
   * Has this transaction already confirmed another approved payment? Checked on every
   * settlement, whatever MONEY_SECOND_APPROVER / MANUAL_PAY_INSTRUCTIONS say (B6a review).
   */
  async function transactionUsedElsewhere(request, txn) {
    const same = typeof paymentRequests.filterByColumnAsync === 'function'
      ? await paymentRequests.filterByColumnAsync('reference', txn)
      : await paymentRequests.filterAsync((p) => p.reference === txn);
    return same.some((p) => p.id !== request.id && p.status === 'approved');
  }

  /** The member's own request, or an error. */
  async function ownRequest(memberId, id) {
    const request = await paymentRequests.findByIdAsync(id);
    if (!request || request.memberId !== memberId) return { error: fail('not_found', 404) };
    return { request };
  }

  /** The trimmed view of a request that goes back to the app. */
  const view = (r) => r && ({
    id: r.id, status: r.status, amountTzs: r.amountTzs, provider: r.provider, reference: r.reference ?? null,
  });

  /**
   * Ask the payer's phone to approve the request's amount. `role` is the caller's
   * session role: 'member' (default) or, with B6a, 'trainer' for their own trainer pass.
   */
  async function pay({ memberId, paymentRequestId, phone, role = 'member' }) {
    if (!enabled() || !client || !canSettle()) return fail('feature_disabled', 404);
    if (roleOf(role) === 'trainer' && !trainerProducts()) return fail('feature_disabled', 404);
    const own = await ownRequest(memberId, paymentRequestId);
    if (own.error) return own.error;
    const { request } = own;
    if (request.status !== 'pending') return fail('payment_not_pending', 409);
    // The member says they paid the Lipa Namba already (slice A3): a prompt now would charge twice.
    if (request.memberReference) return fail('manual_payment_submitted', 409);
    const product = await productOf(request);
    if (!payable().has(product)) return fail('not_payable_this_way', 409);
    // B6a: a trainer pays only their own trainer pass; a member never pays a trainer pass.
    if (!roleMayPay(role, product)) return fail('not_payable_by_role', 403, { product });
    if (request.currency && String(request.currency).toUpperCase() !== CURRENCY) return fail('unsupported_currency', 409);
    // S4: an event order is prompted only while its hold stands, the event is open and every amount agrees (the order's own).
    if (product === PRODUCT_TYPES.EVENT_ORDER) {
      const problem = await eventOrders.beforePrompt(request);
      if (problem?.error) return fail(problem.error, problem.status || 409, problem.expectedTzs != null ? { expectedTzs: problem.expectedTzs } : {});
    }
    // Owner decision 2026-10-19: a tier not configured in Settings is not sold,
    // even on a request raised before it was taken off (fail closed).
    if (product === PRODUCT_TYPES.FITFLEX_PASS && tierSellable && !tierSellable(request.tier)) {
      return fail('tier_not_available', 409, { tier: request.tier ?? null });
    }
    if (!(request.amountTzs > 0)) return fail('invalid_amount', 409);
    // B1 security review: a rejected session whose slot was booked by someone else since
    // cannot come back, so no money is asked for it (an approval would be refused anyway).
    if (product === PRODUCT_TYPES.TRAINER_SERVICE) {
      const problem = await beforeBookingPayment(request);
      if (problem?.error) return fail(problem.error, problem.status || 409, problem.bookingIds ? { bookingIds: problem.bookingIds } : {});
    }
    const msisdn = toMsisdn(phone);
    if (!msisdn) return fail('invalid_phone', 400);

    // A prompt is already on the phone: do not send a second one for the same request.
    if (inFlight(request)) return { status: 200, state: 'in_progress', paymentRequest: view(request), alreadyRequested: true };

    if (!allowAttempt(`m:${memberId}`, LIMITS.member) || !allowAttempt(`p:${msisdn}`, LIMITS.phone)) {
      return fail('too_many_attempts', 429);
    }

    // Claim the request before calling out, so a double tap sends one prompt.
    // A claim that never came back (stale placeholder) is taken over.
    const claim = `${PLACEHOLDER}${now()}`;
    const stale = request.provider === PROVIDER && isPlaceholder(request.reference) ? request.reference : null;
    const claimed = stale
      ? await updateIf(paymentRequests, request.id, { status: 'pending', provider: PROVIDER, reference: stale }, { reference: claim })
      : await updateIf(paymentRequests, request.id, { status: 'pending', provider: MANUAL }, { provider: PROVIDER, reference: claim });
    if (!claimed) {
      const now_ = (await paymentRequests.findByIdAsync(request.id)) ?? request;
      return { status: 200, state: 'in_progress', paymentRequest: view(now_), alreadyRequested: true };
    }

    let transactionId;
    try {
      // The amount is the request's own, never one the app sent.
      ({ transactionId } = await client.initiatePayment({
        msisdn, amountTzs: request.amountTzs, reference: referenceFor(request.id, now()), scenario,
      }));
    } catch (err) {
      if (maybeSent(err)) {
        // The prompt may be on the phone already: keep the claim (no second prompt, the
        // callback still finds the request by its reference), and let it expire.
        await audit('payment_mobile_money_uncertain', request.id, null, { code: err?.code || 'error' });
        return fail('provider_unavailable', 503);
      }
      await updateIf(paymentRequests, request.id, { provider: PROVIDER, reference: claim }, { provider: MANUAL, reference: null });
      await audit('payment_mobile_money_failed_to_start', request.id, null, { code: err?.code || 'error' });
      if (err?.code === 'rejected') return fail('provider_rejected', 422);
      return fail('provider_unavailable', 503);
    }
    try {
      const updated = await paymentRequests.updateByIdAsync(request.id, { provider: PROVIDER, reference: transactionId });
      await audit('payment_mobile_money_requested', request.id, null, { transactionId, amountTzs: request.amountTzs });
      // S4: the event payment becomes pending with the provider's transaction, and the hold is extended a little.
      if (request.eventOrderId) {
        try { await eventOrders.afterPrompt(request, transactionId); } catch (err) { await audit('payment_mobile_money_unrecorded', request.id, null, { transactionId, error: String(err?.message || err) }); }
      }
      return { status: 202, state: 'in_progress', paymentRequest: view(updated) };
    } catch (err) {
      // The prompt is out but we could not record it: keep the claim; the callback settles it.
      await audit('payment_mobile_money_unrecorded', request.id, null, { transactionId, error: String(err?.message || err) });
      return fail('provider_unavailable', 503);
    }
  }

  /** Put an attempt back so the member can try again (or pay another way). */
  async function release(request, why) {
    const back = await updateIf(paymentRequests, request.id, { status: 'pending', provider: PROVIDER, reference: request.reference ?? null }, { provider: MANUAL, reference: null });
    if (back) await audit('payment_mobile_money_failed', request.id, { reference: request.reference }, { why });
    return Boolean(back);
  }

  /**
   * Settle one request from what Tunzaa says about a transaction. Idempotent:
   * a repeat callback or a refresh finds the request already decided.
   * Returns { state: 'completed' | 'failed' | 'in_progress' | 'held' | 'none', ... }.
   */
  async function settle(request, { transactionId = null } = {}) {
    if (request.status === 'approved') return { state: 'completed', paymentRequest: view(request) };
    if (request.status !== 'pending') {
      // Cancelled or rejected: if the money turned up anyway, staff must hear of it.
      const late = transactionId || (request.provider === PROVIDER && !isPlaceholder(request.reference) ? request.reference : null);
      if (late) {
        try {
          const remote = await client.checkStatus(late);
          if (remote.status === 'COMPLETED') {
            await audit('payment_mobile_money_orphaned', request.id, { status: request.status }, { transactionId: late, amountTzs: remote.amountTzs });
            if (request.eventOrderId) await eventOrders.onHeld(request, 'request_closed', { transactionId: late });
          }
        } catch { /* the next callback retry looks again */ }
      }
      return { state: 'failed', paymentRequest: view(request) };
    }
    const txn = transactionId || (!isPlaceholder(request.reference) && inFlight(request) ? request.reference : null);
    if (!txn) {
      // A claim that never produced a prompt: give it back once it has expired.
      if (request.provider === PROVIDER && isPlaceholder(request.reference) && !inFlight(request)) await release(request, 'claim_expired');
      return { state: request.provider === PROVIDER && inFlight(request) ? 'in_progress' : 'none', paymentRequest: view(request) };
    }

    let remote;
    try {
      remote = await client.checkStatus(txn);
    } catch {
      return { state: 'in_progress', paymentRequest: view(request), unconfirmed: true };
    }
    if (remote.status === 'COMPLETED') {
      // Money received must be what was asked: an amount we cannot read is not good enough.
      if (remote.amountTzs == null || remote.amountTzs !== Number(request.amountTzs)) {
        await audit('payment_mobile_money_amount_mismatch', request.id, { amountTzs: request.amountTzs }, { received: remote.amountTzs, transactionId: txn });
        if (request.eventOrderId) await eventOrders.onHeld(request, 'amount_mismatch', { transactionId: txn });
        return { state: 'held', reason: 'amount_mismatch', paymentRequest: view(request) };
      }
      // The request records the prompt it is waiting on: money confirmed for a different
      // transaction is not this request's (B6a review). Staff look; nothing is approved.
      if (request.provider === PROVIDER && request.reference && !isPlaceholder(request.reference) && request.reference !== txn) {
        await audit('payment_mobile_money_held', request.id, { reference: request.reference }, { error: 'transaction_mismatch', transactionId: txn, amountTzs: remote.amountTzs });
        if (request.eventOrderId) await eventOrders.onHeld(request, 'transaction_mismatch', { transactionId: txn });
        return { state: 'held', reason: 'transaction_mismatch', paymentRequest: view(request) };
      }
      // One transaction confirms one payment, flags or not.
      if (await transactionUsedElsewhere(request, txn)) {
        await audit('payment_mobile_money_held', request.id, null, { error: 'reference_already_used', transactionId: txn });
        return { state: 'held', reason: 'reference_already_used', paymentRequest: view(request) };
      }
      if (!canSettle()) {
        await audit('payment_mobile_money_held', request.id, null, { error: 'sandbox_not_settled', transactionId: txn });
        return { state: 'held', reason: 'sandbox_not_settled', paymentRequest: view(request) };
      }
      const out = await adminPaymentService.decide({
        id: request.id, decision: 'approve', reference: txn, actorId: ACTOR, amountTzs: request.amountTzs,
        // The provider confirmed the money: that is the verification (MONEY_SECOND_APPROVER does not apply).
        automated: true,
        // Event payments keep an allowlist-redacted copy of what the provider said (never the signature or a phone number).
        ...(request.eventOrderId ? { providerPayload: remote.raw } : {}),
      });
      if (out.error === 'already_decided') {
        const latest = await paymentRequests.findByIdAsync(request.id);
        if (latest?.status !== 'approved') {
          // Money arrived for a request that was cancelled or rejected meanwhile: staff must look.
          await audit('payment_mobile_money_orphaned', request.id, { status: latest?.status }, { transactionId: txn, amountTzs: remote.amountTzs });
          if (request.eventOrderId) await eventOrders.onHeld(request, 'request_closed', { transactionId: txn });
          return { state: 'held', reason: 'request_closed', paymentRequest: view(latest ?? request) };
        }
        return { state: 'completed', paymentRequest: view(latest) };
      }
      if (out.error) {
        // e.g. the plan being upgraded ended meanwhile: money is in, staff must look.
        await audit('payment_mobile_money_held', request.id, null, { error: out.error, transactionId: txn });
        if (request.eventOrderId) await eventOrders.onHeld(request, out.error, { transactionId: txn });
        return { state: 'held', reason: out.error, paymentRequest: view(request) };
      }
      return { state: 'completed', paymentRequest: view(out.paymentRequest) };
    }
    if (remote.status === 'FAILED') {
      // Only an attempt we still hold is released; a late FAILED for an old one changes nothing.
      if (request.reference === txn) {
        await release(request, remote.remark || 'failed');
        // S4: the event attempt is over (EventPayment failed, request cancelled); the hold keeps running and the member can retry.
        if (request.eventOrderId) await eventOrders.onFailed(request, remote.remark || null);
      }
      return { state: 'failed', paymentRequest: view({ ...request, provider: MANUAL, reference: null }), remark: remote.remark };
    }
    return { state: 'in_progress', paymentRequest: view(request) };
  }

  /** The payer's app asking "has it gone through?" while the prompt is on their phone. */
  async function refresh({ memberId, paymentRequestId, role = 'member' }) {
    if (roleOf(role) === 'trainer' && !trainerProducts()) {
      if (!client) return fail('forbidden', 403, { requiredRoles: ['member'] });
      // B6a review: TUNZAA_TRAINER_PRODUCTS turned off while the trainer's own pass prompt is
      // out — they may still ask how it went (not start a new one). Anything else answers as
      // the member-only route did before (403 forbidden).
      const request = await paymentRequests.findByIdAsync(paymentRequestId);
      const ownLive = request && request.memberId === memberId && request.status === 'pending'
        && request.provider === PROVIDER && Boolean(request.reference)
        && (await productOf(request)) === PRODUCT_TYPES.TRAINER_GYM_PASS;
      if (!ownLive) return fail('forbidden', 403, { requiredRoles: ['member'] });
      const { state, reason, paymentRequest, remark } = await settle(request);
      return { status: 200, state, reason, paymentRequest, remark };
    }
    if (!client) return fail('feature_disabled', 404);
    const own = await ownRequest(memberId, paymentRequestId);
    if (own.error) return own.error;
    // B6a: the same role rule as paying (a trainer looks at their own trainer pass only).
    if (trainerProducts() && !roleMayPay(role, await productOf(own.request))) return fail('not_payable_by_role', 403);
    const { state, reason, paymentRequest, remark } = await settle(own.request);
    return { status: 200, state, reason, paymentRequest, remark };
  }

  /**
   * A signed callback from Tunzaa. The signature is checked by the route; here
   * the request is found by our own reference and the transaction is confirmed
   * with Tunzaa. Answers 200-class so Tunzaa stops retrying, except for a
   * malformed body.
   */
  async function handleCallback(payload) {
    if (!client) return fail('feature_disabled', 404);
    const requestId = requestIdOf(payload?.reference_id);
    const transactionId = payload?.transaction_id ? String(payload.transaction_id) : null;
    if (!requestId || !transactionId) return fail('invalid_payload', 400);
    const request = await paymentRequests.findByIdAsync(requestId);
    if (!request) return { status: 200, ok: true, ignored: 'unknown_reference' };
    // S4 (event requests only): a callback that was fully processed once is a no-op the second time, without calling Tunzaa.
    // It is recorded AFTER processing, so a crash midway does not swallow Tunzaa's retry. The state machine, the database's
    // one-success-per-order index and the idempotent confirmation are the guarantees; this is the belt.
    const seenKey = request.eventOrderId && webhookSeen ? `tunzaa:${transactionId}:${String(payload?.status ?? '').toUpperCase()}` : null;
    if (seenKey && await webhookSeen.has(seenKey)) return { status: 200, ok: true, duplicate: true };
    const out = await settle(request, { transactionId });
    if (seenKey && ['completed', 'failed'].includes(out.state)) await webhookSeen.mark(seenKey);
    return { status: 200, ok: true, state: out.state };
  }

  /** The sweep (eventPaymentReconciliation): settle one request by id as the refresh route does. */
  async function settleById(paymentRequestId) {
    if (!client) return { state: 'none' };
    const request = await paymentRequests.findByIdAsync(paymentRequestId);
    if (!request) return { state: 'none' };
    return settle(request);
  }

  return { options, payableProducts, pay, refresh, handleCallback, settleById };
}
