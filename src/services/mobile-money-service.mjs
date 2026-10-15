// Mobile-money payment of a payment request (Malipo by Tunzaa).
//
// A payment request is created as before (pass, upgrade, gym plan). "Pay now"
// asks the member's phone to approve exactly that request's amount; when the
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

const PROVIDER = 'tunzaa';
const MANUAL = 'admin_approved';
/** Products paid this way for now: FitFlex Pass (incl. upgrades) and a gym's own plans. */
const PAYABLE = new Set([PRODUCT_TYPES.FITFLEX_PASS, PRODUCT_TYPES.GYM_SUBSCRIPTION]);
const ACTOR = 'tunzaa';
const PLACEHOLDER = 'pending:';
/** A claim whose call never came back is given up after this long. */
const CLAIM_TTL_MS = 2 * 60_000;
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

  /** What the app needs to know before showing "Pay now". */
  function options() {
    const on = Boolean(enabled() && client && canSettle());
    return { enabled: on, provider: PROVIDER, environment: on ? client.environment : null };
  }

  async function productOf(request) {
    const sub = request.subscriptionId ? await subscriptions.findByIdAsync(request.subscriptionId) : null;
    return productTypeOfPayment(request, sub);
  }

  const isPlaceholder = (ref) => typeof ref === 'string' && ref.startsWith(PLACEHOLDER);
  const placeholderAge = (ref) => now() - Number(String(ref).slice(PLACEHOLDER.length) || 0);
  /** A prompt is out, or a call to send one is under way and recent. */
  const inFlight = (r) => r.provider === PROVIDER && Boolean(r.reference)
    && (!isPlaceholder(r.reference) || placeholderAge(r.reference) < CLAIM_TTL_MS);

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

  /** Ask the member's phone to approve the request's amount. */
  async function pay({ memberId, paymentRequestId, phone }) {
    if (!enabled() || !client || !canSettle()) return fail('feature_disabled', 404);
    const own = await ownRequest(memberId, paymentRequestId);
    if (own.error) return own.error;
    const { request } = own;
    if (request.status !== 'pending') return fail('payment_not_pending', 409);
    if (!PAYABLE.has(await productOf(request))) return fail('not_payable_this_way', 409);
    if (!(request.amountTzs > 0)) return fail('invalid_amount', 409);
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
        return { state: 'held', reason: 'amount_mismatch', paymentRequest: view(request) };
      }
      if (!canSettle()) {
        await audit('payment_mobile_money_held', request.id, null, { error: 'sandbox_not_settled', transactionId: txn });
        return { state: 'held', reason: 'sandbox_not_settled', paymentRequest: view(request) };
      }
      const out = await adminPaymentService.decide({
        id: request.id, decision: 'approve', reference: txn, actorId: ACTOR, amountTzs: request.amountTzs,
      });
      if (out.error === 'already_decided') {
        const latest = await paymentRequests.findByIdAsync(request.id);
        if (latest?.status !== 'approved') {
          // Money arrived for a request that was cancelled or rejected meanwhile: staff must look.
          await audit('payment_mobile_money_orphaned', request.id, { status: latest?.status }, { transactionId: txn, amountTzs: remote.amountTzs });
          return { state: 'held', reason: 'request_closed', paymentRequest: view(latest ?? request) };
        }
        return { state: 'completed', paymentRequest: view(latest) };
      }
      if (out.error) {
        // e.g. the plan being upgraded ended meanwhile: money is in, staff must look.
        await audit('payment_mobile_money_held', request.id, null, { error: out.error, transactionId: txn });
        return { state: 'held', reason: out.error, paymentRequest: view(request) };
      }
      return { state: 'completed', paymentRequest: view(out.paymentRequest) };
    }
    if (remote.status === 'FAILED') {
      // Only an attempt we still hold is released; a late FAILED for an old one changes nothing.
      if (request.reference === txn) await release(request, remote.remark || 'failed');
      return { state: 'failed', paymentRequest: view({ ...request, provider: MANUAL, reference: null }), remark: remote.remark };
    }
    return { state: 'in_progress', paymentRequest: view(request) };
  }

  /** The member's app asking "has it gone through?" while the prompt is on their phone. */
  async function refresh({ memberId, paymentRequestId }) {
    if (!client) return fail('feature_disabled', 404);
    const own = await ownRequest(memberId, paymentRequestId);
    if (own.error) return own.error;
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
    const out = await settle(request, { transactionId });
    return { status: 200, ok: true, state: out.state };
  }

  return { options, pay, refresh, handleCallback };
}
