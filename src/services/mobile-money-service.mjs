// Mobile-money payment of a payment request through AzamPay, the only payment
// provider (owner decision 2026-11-17).
//
// A payment request is created as before (pass, upgrade, gym plan, custom gym
// pass; with AZAMPAY_TRAINER_PRODUCTS also trainer sessions and a trainer's gym
// pass; with EVENTS_PAYMENTS_AZAMPAY an event order; with AZAMPAY_SHOP_ORDERS a
// member's shop order). "Pay now" asks the payer's phone to approve exactly that
// request's amount; when AzamPay confirms, the request is approved through the
// SAME path an admin uses (adminPaymentService.decide), so every product,
// including pass upgrades, is settled by one piece of code.
//
//   pending (provider admin_approved)
//      ── pay ──▶ pending (provider azampay, reference = 'pending:<ms>')   claimed, call going out
//      ── sent ──▶ pending (provider azampay, reference = transaction id, promptedAt)  prompt on the phone
//      ── success ──▶ approved       ── failure ──▶ pending again (member may retry)
//      ── no answer for PROMPT_TTL_MS ──▶ the member may ask for a new prompt
//
// AzamPay offers no status query for collections: its callback is verified by
// RSA signature against AzamPay's own public key (by the route), and nothing
// else the callback says is taken on trust: the amount, the transaction and its
// single use are checked here before anything is approved. A callback is tied
// to its request by OUR reference ("<request id>.<attempt>", sent as externalId
// and signed back as utilityref), so a prompt whose answer was lost (timeout)
// still settles the right request.
//
// Money that cannot be matched is never approved and never dropped: it is
// written to the audit log (`payment_mobile_money_held`,
// `payment_mobile_money_amount_mismatch`, `payment_mobile_money_orphaned`) and
// raised as an ops exception (`onHeld`; event orders raise their own), and staff
// settle it with the usual approve / reject / refund tools.
//
// A prompt that was given up (failed, or unanswered and retried) leaves its
// transaction id in `supersededReferences`: a success that names it later is
// held, even in the moment a new prompt is being sent and `reference` is only
// a claim placeholder.
import { randomUUID } from 'node:crypto';
import { toMsisdn, maybeSent } from '../integrations/payments/azampay.mjs';
import { productTypeOfPayment, PRODUCT_TYPES } from '../shared/payment-product.mjs';
import { updateIf } from '../shared/conditional-update.mjs';
import {
  MOBILE_MONEY_PROVIDER, CLAIM_PLACEHOLDER, isClaimPlaceholder, mobileMoneyInFlight,
} from '../shared/mobile-money-claim.mjs';

const MANUAL = 'admin_approved';
/** Products paid this way: FitFlex Pass (incl. upgrades) and a gym's own plans. */
const BASE_PAYABLE = Object.freeze([PRODUCT_TYPES.FITFLEX_PASS, PRODUCT_TYPES.GYM_SUBSCRIPTION]);
/** B6a (AZAMPAY_TRAINER_PRODUCTS): trainer products too. */
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
/** Products that are a member's own purchase whatever the trainer flag says (each behind its own switch). */
const MEMBER_ONLY = Object.freeze([PRODUCT_TYPES.EVENT_ORDER, PRODUCT_TYPES.SHOP_ORDER]);
/** Mobile money is in Tanzanian shillings only. */
const CURRENCY = 'TZS';
const PLACEHOLDER = CLAIM_PLACEHOLDER;
/** At most this many prompts per member / per phone in the window. */
const LIMITS = { member: 5, phone: 3, windowMs: 10 * 60_000 };

/** At most this many given-up transaction ids are remembered per request (the newest). */
const SUPERSEDED_MAX = 10;

/** Our reference for one attempt: "<request id>.<attempt>" (unique per prompt). */
const referenceFor = (requestId, now) => `${requestId}.${now.toString(36)}`;
/** The request id inside a reference (or the id itself). */
export const requestIdOf = (referenceId) => String(referenceId ?? '').split('.')[0];

export function createMobileMoneyService({
  paymentRequests, subscriptions, adminPaymentService, auditLog,
  client = null,           // null while AzamPay's credentials are not set
  provider = MOBILE_MONEY_PROVIDER, // 'azampay': written on the request and the audit actor
  enabled = () => false,   // the AZAMPAY_PAYMENTS flag
  canSettle = () => true,  // false against the sandbox unless opted into
  now = () => Date.now(),
  // (tierKey) → boolean: may this FitFlex Pass tier be sold today (Settings)?
  // A pass or upgrade request for a tier that is no longer sold is not sent
  // to the phone. Wired to settingsService.isTierSellable in bootstrap.
  tierSellable = null,
  // B6a: the AZAMPAY_TRAINER_PRODUCTS flag (effective only with AZAMPAY_PAYMENTS). Read on every call.
  trainerProducts = () => false,
  // B6a (B1 security review): (request) → null | { error, status, bookingIds } before a
  // prompt goes out for a trainer booking group (trainerBookingService.checkGroupPayment).
  // Not wired: trainer sessions are not payable this way (fail closed).
  beforeBookingPayment = null,
  // Marathon & Events S4 (EVENTS_PAYMENTS_AZAMPAY). Absent / disabled: EVENT_ORDER is not payable this way and
  // every other branch is untouched. { enabled(), beforePrompt(request), afterPrompt(request, txn), onHeld(request, reason, detail), onFailed(request, remark) }
  eventOrders = null,
  // Shop orders (AZAMPAY_SHOP_ORDERS). Absent / disabled: SHOP_ORDER is not payable this way.
  // { enabled(), beforePrompt(request) → null | { error, status, … } }
  shopOrders = null,
  // Callbacks already fully processed: { has(id) → bool, mark(id) } (WebhookSeen). Used for event requests only.
  webhookSeen = null,
  // Confirmed money that was not approved, for a request that is NOT an event order (those go to eventOrders.onHeld):
  // (request, reason, { transactionId, amountTzs }) → void. Wired to an ops exception in bootstrap. Best-effort.
  onHeld = null,
}) {
  const PROVIDER = provider;
  const ACTOR = provider;
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

  /** Tell staff about confirmed money that was not approved. `eventDetail` goes to the event hook only. */
  async function tellStaff(request, reason, detail, eventDetail = {}) {
    // An event order's hook also moves its payment to reconciliation: a failure there must surface (AzamPay retries).
    if (request.eventOrderId) return eventOrders?.onHeld?.(request, reason, { transactionId: detail.transactionId, ...eventDetail });
    try {
      await onHeld?.(request, reason, detail);
    } catch (err) {
      console.warn('[mobile-money] staff were not told about held money:', request.id, reason, err?.message);
    }
  }

  /** The transaction ids of this request's earlier prompts that were given up. */
  const supersededOf = (r) => (Array.isArray(r?.supersededReferences) ? r.supersededReferences.filter((x) => typeof x === 'string') : []);
  /** The same list with `ref` added when it is a real transaction id (never a claim placeholder). */
  const supersededWith = (r, ref) => {
    const list = supersededOf(r);
    if (!ref || isClaimPlaceholder(ref) || list.includes(ref)) return list;
    return [...list, ref].slice(-SUPERSEDED_MAX);
  };

  const isOn = () => Boolean(enabled() && client && canSettle());
  const roleOf = (role) => (role === 'trainer' ? 'trainer' : 'member');

  const eventsOn = () => Boolean(eventOrders?.enabled?.());
  const shopOn = () => Boolean(shopOrders?.enabled?.());

  /** The products payable this way right now, whoever pays. */
  function payable() {
    const set = new Set(BASE_PAYABLE);
    if (eventsOn()) set.add(PRODUCT_TYPES.EVENT_ORDER);
    if (shopOn()) set.add(PRODUCT_TYPES.SHOP_ORDER);
    if (trainerProducts()) {
      for (const p of TRAINER_PAYABLE) if (p !== PRODUCT_TYPES.TRAINER_SERVICE || beforeBookingPayment) set.add(p);
    }
    return set;
  }

  /** May this caller role pay this product this way? Without B6a only members reach here. */
  const roleMayPay = (role, product) => {
    // An event order or a shop order is a member's purchase here, never a trainer's or an organisation's.
    if (MEMBER_ONLY.includes(product)) return roleOf(role) === 'member';
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
    // Members may also pay an event order / a shop order while that switch is effective.
    return role === 'member' ? [...list, ...MEMBER_ONLY.filter((p) => set.has(p))] : list;
  }

  async function productOf(request) {
    const sub = request.subscriptionId ? await subscriptions.findByIdAsync(request.subscriptionId) : null;
    return productTypeOfPayment(request, sub);
  }

  const isPlaceholder = isClaimPlaceholder;
  /** A prompt is out and recent, or a call to send one is under way and recent. */
  const inFlight = (r) => r?.provider === PROVIDER && mobileMoneyInFlight(r, now());

  /**
   * Has this transaction already confirmed another approved payment? Checked on every
   * settlement, whatever MONEY_SECOND_APPROVER says (B6a review).
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
  async function pay({ memberId, paymentRequestId, phone, role = 'member', network = null }) {
    if (!enabled() || !client || !canSettle()) return fail('feature_disabled', 404);
    if (roleOf(role) === 'trainer' && !trainerProducts()) return fail('feature_disabled', 404);
    const own = await ownRequest(memberId, paymentRequestId);
    if (own.error) return own.error;
    const { request } = own;
    if (request.status !== 'pending') return fail('payment_not_pending', 409);
    // A request that carries a transaction ID someone typed (an organisation's payment notice, or a
    // payment made by hand before 2026-11-17) is checked by staff: a prompt now would charge twice.
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
    // A shop order is prompted only while it still waits for this payment, in this amount, by this buyer.
    if (product === PRODUCT_TYPES.SHOP_ORDER) {
      const problem = await shopOrders.beforePrompt(request);
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
    // A claim that never came back (stale placeholder), or a prompt whose answer never
    // came (PROMPT_TTL_MS), is taken over: only one of two racing takers wins.
    const claim = `${PLACEHOLDER}${now()}`;
    const stale = request.provider === PROVIDER && request.reference ? request.reference : null;
    // The prompt that is given up keeps its transaction id on the request (supersededReferences), so its late
    // success is recognised even while `reference` is only this claim.
    const claimed = stale
      ? await updateIf(paymentRequests, request.id, { status: 'pending', provider: PROVIDER, reference: stale }, { reference: claim, promptedAt: null, supersededReferences: supersededWith(request, stale) })
      : await updateIf(paymentRequests, request.id, { status: 'pending', provider: MANUAL }, { provider: PROVIDER, reference: claim, promptedAt: null });
    if (!claimed) {
      const now_ = (await paymentRequests.findByIdAsync(request.id)) ?? request;
      return { status: 200, state: 'in_progress', paymentRequest: view(now_), alreadyRequested: true };
    }
    // Read again after the claim: a callback may have settled or closed the request between the first read
    // and the claim. Nothing is sent to a phone unless the request is still pending on THIS claim.
    const fresh = await paymentRequests.findByIdAsync(request.id);
    if (!fresh || fresh.status !== 'pending' || fresh.provider !== PROVIDER || fresh.reference !== claim) {
      const settled = fresh?.status === 'approved';
      return { status: 200, state: settled ? 'completed' : 'in_progress', paymentRequest: view(fresh ?? request), alreadyRequested: true };
    }
    // The old prompt is named in the audit: a success that still arrives for it is held for staff, who find it here.
    if (stale && !isPlaceholder(stale)) {
      await audit('payment_mobile_money_prompt_expired', request.id, { reference: stale, promptedAt: request.promptedAt ?? null }, { retried: true });
    }

    let transactionId;
    try {
      // The amount is the request's own, never one the app sent.
      ({ transactionId } = await client.initiatePayment({
        msisdn, amountTzs: request.amountTzs, reference: referenceFor(request.id, now()),
        // The wallet paid from (Mpesa, Tigo, Airtel, Halopesa, Azampesa); else taken from the number.
        network,
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
      if (err?.code === 'unknown_network') return fail('network_required', 400);
      return fail('provider_unavailable', 503);
    }
    try {
      // Recorded only on the claim this call made: a callback that already settled the request
      // (AzamPay can answer before its own checkout call returns) is never written over.
      const updated = await updateIf(paymentRequests, request.id, { status: 'pending', provider: PROVIDER, reference: claim }, { reference: transactionId, promptedAt: new Date(now()).toISOString() });
      if (!updated) {
        const latest = (await paymentRequests.findByIdAsync(request.id)) ?? request;
        const settled = latest.status === 'approved';
        if (!(settled && latest.reference === transactionId)) {
          await audit('payment_mobile_money_unrecorded', request.id, null, { transactionId, error: 'request_changed', status: latest.status });
        }
        return { status: settled ? 200 : 202, state: settled ? 'completed' : 'in_progress', paymentRequest: view(latest) };
      }
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

  /** Put an attempt back so the member can try again. */
  async function release(request, why) {
    const back = await updateIf(paymentRequests, request.id, { status: 'pending', provider: PROVIDER, reference: request.reference ?? null }, { provider: MANUAL, reference: null, promptedAt: null, supersededReferences: supersededWith(request, request.reference) });
    if (back) await audit('payment_mobile_money_failed', request.id, { reference: request.reference }, { why });
    return Boolean(back);
  }

  /** Money AzamPay confirmed that no open attempt of ours accounts for: recorded for staff, nothing approved. */
  async function orphaned(request, txn, remote, error) {
    await audit('payment_mobile_money_orphaned', request.id, { status: request.status, reference: request.reference ?? null }, { transactionId: txn, amountTzs: remote?.amountTzs ?? null, ...(error ? { error } : {}) });
  }

  /**
   * Settle one request. `confirmed` is what AzamPay's verified callback said about
   * `transactionId` ({ status: 'COMPLETED' | 'FAILED' | 'UNKNOWN', amountTzs, remark, raw });
   * without it (a refresh, the sweep) there is nothing to ask AzamPay, so the request only
   * reports where it stands. Idempotent: a repeat callback finds the request already decided.
   * Returns { state: 'completed' | 'failed' | 'in_progress' | 'held' | 'none', ... }.
   */
  async function settle(request, { transactionId = null, confirmed = null } = {}) {
    const paid = Boolean(transactionId) && confirmed?.status === 'COMPLETED';
    if (request.status === 'approved') {
      // Settled already. The same transaction again is a repeat; a DIFFERENT one means money came in twice.
      if (paid && request.reference !== transactionId) {
        await orphaned(request, transactionId, confirmed, 'already_settled');
        await tellStaff(request, 'duplicate_payment', { transactionId, amountTzs: confirmed.amountTzs });
        return { state: 'completed', paymentRequest: view(request), duplicatePayment: true };
      }
      return { state: 'completed', paymentRequest: view(request) };
    }
    if (request.status !== 'pending') {
      // Cancelled, rejected or expired: if the money turned up anyway, staff must hear of it.
      if (paid) {
        await orphaned(request, transactionId, confirmed, 'request_closed');
        await tellStaff(request, 'request_closed', { transactionId, amountTzs: confirmed.amountTzs });
      }
      return { state: 'failed', paymentRequest: view(request) };
    }
    const txn = transactionId || (!isPlaceholder(request.reference) && inFlight(request) ? request.reference : null);
    if (!txn) {
      // A claim that never produced a prompt, or a prompt whose answer never came: give it back once it has expired.
      if (request.provider === PROVIDER && request.reference && !inFlight(request)) {
        await release(request, isPlaceholder(request.reference) ? 'claim_expired' : 'prompt_expired');
      }
      return { state: request.provider === PROVIDER && inFlight(request) ? 'in_progress' : 'none', paymentRequest: view(request) };
    }

    // No callback yet and nothing to ask AzamPay: the prompt is still out.
    const remote = txn === transactionId ? confirmed : null;
    if (!remote) return { state: 'in_progress', paymentRequest: view(request) };
    if (remote.status === 'COMPLETED') {
      // The request has no attempt of ours open (it was released after a failure or an expired
      // prompt, or never prompted): this money is not matched to a prompt. Staff look; nothing is approved.
      if (request.provider !== PROVIDER) {
        await orphaned(request, txn, remote, 'no_open_attempt');
        await tellStaff(request, 'no_open_attempt', { transactionId: txn, amountTzs: remote.amountTzs });
        return { state: 'held', reason: 'no_open_attempt', paymentRequest: view(request) };
      }
      // Money for a prompt of this request that was given up (failed, or unanswered and retried). It is held
      // BEFORE anything else is looked at — in particular while a new prompt is being sent and `reference` is
      // only a claim — and the attempt that is open now stays payable: the event payment is left as it is
      // (keepPayable), so the new prompt can still settle and staff refund or apply the old money.
      if (supersededOf(request).includes(txn) && request.reference !== txn) {
        await audit('payment_mobile_money_held', request.id, { reference: request.reference ?? null }, { error: 'transaction_mismatch', superseded: true, transactionId: txn, amountTzs: remote.amountTzs });
        await tellStaff(request, 'transaction_mismatch', { transactionId: txn, amountTzs: remote.amountTzs, superseded: true }, { keepPayable: true });
        return { state: 'held', reason: 'transaction_mismatch', paymentRequest: view(request) };
      }
      // Money received must be what was asked: less, more, or an amount we cannot read is not good enough.
      if (remote.amountTzs == null || remote.amountTzs !== Number(request.amountTzs)) {
        await audit('payment_mobile_money_amount_mismatch', request.id, { amountTzs: request.amountTzs }, { received: remote.amountTzs, transactionId: txn });
        await tellStaff(request, 'amount_mismatch', { transactionId: txn, amountTzs: remote.amountTzs });
        return { state: 'held', reason: 'amount_mismatch', paymentRequest: view(request) };
      }
      // The request records the prompt it is waiting on: money confirmed for a different
      // transaction (e.g. an older prompt, after a retry) is not this attempt's (B6a review).
      // Staff look; nothing is approved.
      if (request.reference && !isPlaceholder(request.reference) && request.reference !== txn) {
        await audit('payment_mobile_money_held', request.id, { reference: request.reference }, { error: 'transaction_mismatch', transactionId: txn, amountTzs: remote.amountTzs });
        // A transaction we never sent (not one of this request's given-up prompts): an event payment goes to reconciliation.
        await tellStaff(request, 'transaction_mismatch', { transactionId: txn, amountTzs: remote.amountTzs });
        return { state: 'held', reason: 'transaction_mismatch', paymentRequest: view(request) };
      }
      // One transaction confirms one payment, flags or not.
      if (await transactionUsedElsewhere(request, txn)) {
        await audit('payment_mobile_money_held', request.id, null, { error: 'reference_already_used', transactionId: txn });
        if (!request.eventOrderId) await tellStaff(request, 'reference_already_used', { transactionId: txn, amountTzs: remote.amountTzs });
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
          await orphaned(latest ?? request, txn, remote, 'request_closed');
          await tellStaff(request, 'request_closed', { transactionId: txn, amountTzs: remote.amountTzs });
          return { state: 'held', reason: 'request_closed', paymentRequest: view(latest ?? request) };
        }
        return { state: 'completed', paymentRequest: view(latest) };
      }
      if (out.error) {
        // e.g. the plan being upgraded ended meanwhile: money is in, staff must look.
        await audit('payment_mobile_money_held', request.id, null, { error: out.error, transactionId: txn });
        await tellStaff(request, out.error, { transactionId: txn, amountTzs: remote.amountTzs });
        return { state: 'held', reason: out.error, paymentRequest: view(request) };
      }
      return { state: 'completed', paymentRequest: view(out.paymentRequest) };
    }
    if (remote.status === 'FAILED') {
      // Only an attempt we still hold is released; a late FAILED for an old one changes nothing.
      if (request.provider === PROVIDER && request.reference === txn) {
        await release(request, remote.remark || 'failed');
        // S4: the event attempt is over (EventPayment failed, request cancelled); the hold keeps running and the member can retry.
        if (request.eventOrderId) await eventOrders.onFailed(request, remote.remark || null);
        return { state: 'failed', paymentRequest: view({ ...request, provider: MANUAL, reference: null }), remark: remote.remark };
      }
      return { state: 'failed', paymentRequest: view(request), remark: remote.remark };
    }
    return { state: 'in_progress', paymentRequest: view(request) };
  }

  /** The payer's app asking "has it gone through?" while the prompt is on their phone. */
  async function refresh({ memberId, paymentRequestId, role = 'member' }) {
    if (roleOf(role) === 'trainer' && !trainerProducts()) {
      if (!client) return fail('forbidden', 403, { requiredRoles: ['member'] });
      // B6a review: AZAMPAY_TRAINER_PRODUCTS turned off while the trainer's own pass prompt is
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
   * AzamPay's callback. The RSA signature (and clientId) is checked by the route;
   * here the request is found by our own reference and the amount, the transaction
   * and its single use are checked. Answers 200-class so AzamPay stops retrying,
   * except for a malformed body.
   */
  async function handleCallback(payload, { signed = true } = {}) {
    if (!client || typeof client.parseCallback !== 'function') return fail('feature_disabled', 404);
    const parsed = client.parseCallback(payload);
    const requestId = requestIdOf(parsed.referenceId);
    if (!requestId || !parsed.transactionId) return fail('invalid_payload', 400);
    const request = await paymentRequests.findByIdAsync(requestId);
    const ids = parsed.transactionIds || [];
    // A callback whose signature could not be checked (sandbox only; the route decides) is believed only for
    // the attempt that is open right now: our reference, the transaction id AzamPay gave us for that prompt,
    // and (in settle) the exact amount. Anything else changes nothing.
    if (!signed) {
      const matches = Boolean(request) && request.status === 'pending' && inFlight(request)
        && !isPlaceholder(request.reference) && ids.includes(request.reference);
      if (!matches) {
        if (request) await audit('payment_mobile_money_unsigned_refused', request.id, null, { transactionIds: ids, recorded: request.reference ?? null, status: request.status });
        return fail('unsigned_unmatched', 403);
      }
    }
    if (!request) return { status: 200, ok: true, ignored: 'unknown_reference' };
    // AzamPay names a transaction more than one way: use the one the request recorded, if any.
    // Failing that, one it gave up earlier (a late answer for an old prompt); else the callback's own.
    const given = supersededOf(request);
    const transactionId = ids.includes(request.reference) ? request.reference : (ids.find((id) => given.includes(id)) ?? parsed.transactionId);
    const confirmed = parsed.confirmed ?? null;
    // S4 (event requests only): a callback that was fully processed once is a no-op the second time.
    // It is recorded AFTER processing, so a crash midway does not swallow AzamPay's retry. The state machine, the database's
    // one-success-per-order index and the idempotent confirmation are the guarantees; this is the belt.
    const seenKey = request.eventOrderId && webhookSeen ? `${PROVIDER}:${transactionId}:${String(payload?.transactionstatus ?? '').toUpperCase()}` : null;
    if (seenKey && await webhookSeen.has(seenKey)) return { status: 200, ok: true, duplicate: true };
    const out = await settle(request, { transactionId, confirmed });
    if (seenKey && ['completed', 'failed'].includes(out.state)) await webhookSeen.mark(seenKey);
    return { status: 200, ok: true, state: out.state, ...(out.reason ? { reason: out.reason } : {}) };
  }

  /** The sweep (eventPaymentReconciliation): where one request stands, as the refresh route reports it. */
  async function settleById(paymentRequestId) {
    if (!client) return { state: 'none' };
    const request = await paymentRequests.findByIdAsync(paymentRequestId);
    if (!request) return { state: 'none' };
    return settle(request);
  }

  return { options, payableProducts, pay, refresh, handleCallback, settleById };
}
