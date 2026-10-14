// Mobile-money payment of a payment request (Malipo by Tunzaa).
//
// A payment request is created as before (pass, upgrade, gym plan). "Pay now"
// asks the member's phone to approve exactly that request's amount; when the
// provider confirms, the request is approved through the SAME path an admin
// uses (adminPaymentService.decide), so every product, including pass
// upgrades, is settled by one piece of code.
//
//   pending (provider admin_approved)
//      ── pay ──▶ pending (provider tunzaa, reference = transaction id)   "in flight"
//      ── COMPLETED ──▶ approved          ── FAILED ──▶ pending again (member may retry)
//
// Nothing the callback says is taken on trust: a COMPLETED callback is only a
// trigger, and the transaction's status and amount are read back from Tunzaa
// before the request is approved.
import { randomUUID } from 'node:crypto';
import { toMsisdn } from '../integrations/payments/tunzaa.mjs';
import { productTypeOfPayment, PRODUCT_TYPES } from '../shared/payment-product.mjs';
import { updateIf } from '../shared/conditional-update.mjs';

const PROVIDER = 'tunzaa';
const MANUAL = 'admin_approved';
/** Products paid this way for now: FitFlex Pass (incl. upgrades) and a gym's own plans. */
const PAYABLE = new Set([PRODUCT_TYPES.FITFLEX_PASS, PRODUCT_TYPES.GYM_SUBSCRIPTION]);
const ACTOR = 'tunzaa';

export function createMobileMoneyService({
  paymentRequests, subscriptions, adminPaymentService, auditLog,
  client = null,           // null while Tunzaa's credentials are not set
  enabled = () => false,   // the TUNZAA_PAYMENTS flag
  scenario = null,         // sandbox only: 'success' | 'failure'
}) {
  const fail = (error, status, extra = {}) => ({ error, status, ...extra });
  const audit = (action, target, before, after) => auditLog?.insertAsync?.({
    id: randomUUID(), at: new Date().toISOString(), actor: ACTOR, action, target, before, after,
  });

  /** What the app needs to know before showing "Pay now". */
  function options() {
    const on = Boolean(enabled() && client);
    return { enabled: on, provider: PROVIDER, environment: on ? client.environment : null };
  }

  async function productOf(request) {
    const sub = request.subscriptionId ? await subscriptions.findByIdAsync(request.subscriptionId) : null;
    return productTypeOfPayment(request, sub);
  }

  const inFlight = (request) => request.provider === PROVIDER && Boolean(request.reference);

  /** The member's own request, or an error. */
  async function ownRequest(memberId, id) {
    const request = await paymentRequests.findByIdAsync(id);
    if (!request || request.memberId !== memberId) return { error: fail('not_found', 404) };
    return { request };
  }

  /** Ask the member's phone to approve the request's amount. */
  async function pay({ memberId, paymentRequestId, phone }) {
    if (!enabled() || !client) return fail('feature_disabled', 404);
    const own = await ownRequest(memberId, paymentRequestId);
    if (own.error) return own.error;
    const { request } = own;
    if (request.status !== 'pending') return fail('payment_not_pending', 409);
    if (!PAYABLE.has(await productOf(request))) return fail('not_payable_this_way', 409);
    if (!(request.amountTzs > 0)) return fail('invalid_amount', 409);
    const msisdn = toMsisdn(phone);
    if (!msisdn) return fail('invalid_phone', 400);

    // A prompt is already on the phone: do not send a second one for the same request.
    if (inFlight(request)) return { status: 200, state: 'in_progress', paymentRequest: request, alreadyRequested: true };

    // Claim the request before calling out, so a double tap sends one prompt.
    const claimed = await updateIf(paymentRequests, request.id, { status: 'pending', provider: MANUAL }, { provider: PROVIDER, reference: null });
    if (!claimed) return { status: 200, state: 'in_progress', paymentRequest: (await paymentRequests.findByIdAsync(request.id)) ?? request, alreadyRequested: true };

    try {
      // The amount is the request's own, never one the app sent.
      const { transactionId } = await client.initiatePayment({
        msisdn, amountTzs: request.amountTzs, reference: request.id, scenario,
      });
      const updated = await paymentRequests.updateByIdAsync(request.id, { provider: PROVIDER, reference: transactionId });
      await audit('payment_mobile_money_requested', request.id, null, { transactionId, amountTzs: request.amountTzs });
      return { status: 202, state: 'in_progress', paymentRequest: updated };
    } catch (err) {
      await updateIf(paymentRequests, request.id, { provider: PROVIDER }, { provider: MANUAL, reference: null });
      await audit('payment_mobile_money_failed_to_start', request.id, null, { code: err?.code || 'error' });
      if (err?.code === 'rejected') return fail('provider_rejected', 422);
      return fail('provider_unavailable', 503);
    }
  }

  /** Put an attempt back so the member can try again (or pay another way). */
  async function release(request, transactionId, why) {
    const back = await updateIf(paymentRequests, request.id, { status: 'pending', provider: PROVIDER, reference: transactionId }, { provider: MANUAL, reference: null });
    if (back) await audit('payment_mobile_money_failed', request.id, { transactionId }, { why });
    return Boolean(back);
  }

  /**
   * Settle one request from what Tunzaa says about its transaction. Idempotent:
   * a repeat callback or a refresh finds the request already decided.
   * Returns { state: 'completed' | 'failed' | 'in_progress' | 'held', ... }.
   */
  async function settle(request) {
    if (request.status === 'approved') return { state: 'completed', paymentRequest: request };
    if (request.status !== 'pending') return { state: 'failed', paymentRequest: request };
    if (!inFlight(request)) return { state: 'none', paymentRequest: request };
    const transactionId = request.reference;

    let remote;
    try {
      remote = await client.checkStatus(transactionId);
    } catch {
      return { state: 'in_progress', paymentRequest: request, unconfirmed: true };
    }
    if (remote.status === 'COMPLETED') {
      // Money received must be what was asked, for this very request.
      if (remote.amountTzs != null && remote.amountTzs !== Number(request.amountTzs)) {
        await audit('payment_mobile_money_amount_mismatch', request.id, { amountTzs: request.amountTzs }, { received: remote.amountTzs, transactionId });
        return { state: 'held', reason: 'amount_mismatch', paymentRequest: request };
      }
      const out = await adminPaymentService.decide({
        id: request.id, decision: 'approve', reference: transactionId, actorId: ACTOR, amountTzs: request.amountTzs,
      });
      if (out.error === 'already_decided') {
        const now = await paymentRequests.findByIdAsync(request.id);
        return { state: now?.status === 'approved' ? 'completed' : 'failed', paymentRequest: now ?? request };
      }
      if (out.error) {
        // e.g. the plan being upgraded ended meanwhile: money is in, staff must look.
        await audit('payment_mobile_money_held', request.id, null, { error: out.error, transactionId });
        return { state: 'held', reason: out.error, paymentRequest: request };
      }
      return { state: 'completed', paymentRequest: out.paymentRequest };
    }
    if (remote.status === 'FAILED') {
      await release(request, transactionId, remote.remark || 'failed');
      return { state: 'failed', paymentRequest: { ...request, provider: MANUAL, reference: null }, remark: remote.remark };
    }
    return { state: 'in_progress', paymentRequest: request };
  }

  /** The member's app asking "has it gone through?" while the prompt is on their phone. */
  async function refresh({ memberId, paymentRequestId }) {
    if (!client) return fail('feature_disabled', 404);
    const own = await ownRequest(memberId, paymentRequestId);
    if (own.error) return own.error;
    return { status: 200, ...(await settle(own.request)) };
  }

  /**
   * A signed callback from Tunzaa. The signature is checked by the route; here
   * the request is found by our own reference and then confirmed with Tunzaa.
   * Always answers 200-class so Tunzaa stops retrying, except for a malformed body.
   */
  async function handleCallback(payload) {
    if (!client) return fail('feature_disabled', 404);
    const requestId = payload?.reference_id;
    const transactionId = payload?.transaction_id;
    if (!requestId || !transactionId) return fail('invalid_payload', 400);
    const request = await paymentRequests.findByIdAsync(String(requestId));
    if (!request) return { status: 200, ok: true, ignored: 'unknown_reference' };
    // A callback may only act on the transaction we started for this request.
    if (request.status === 'pending' && request.reference !== String(transactionId)) {
      await audit('payment_mobile_money_unexpected_callback', request.id, { reference: request.reference }, { transactionId });
      return { status: 200, ok: true, ignored: 'transaction_mismatch' };
    }
    const out = await settle(request);
    return { status: 200, ok: true, state: out.state };
  }

  return { options, pay, refresh, handleCallback };
}
