// Pay a payment request by mobile money through AzamPay, the only payment method (owner decision 2026-11-17).
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { mobileMoneyService } from '../src/bootstrap/services.mjs';
import { azampayTrainerProductsOn, eventsPaymentsAzampayOn, azampayShopOrdersOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { appReturnPage } from '../src/shared/azampay-return.mjs';

const created = new Date().toISOString();

/** One log line per pay / refresh: who, which request, the outcome. Never the phone number. */
function logPay(event, req, result) {
  console.info(`[azampay] ${event}`, JSON.stringify({
    paymentRequestId: req.params?.id ?? null, user: req.user?.sub ?? null, role: req.user?.userType ?? null,
    network: typeof req.body?.network === 'string' ? req.body.network : null,
    httpStatus: result.error ? result.status : (result.status || 200),
    outcome: result.error ?? result.state ?? null, ...(result.reason ? { reason: result.reason } : {}),
  }));
}

function send(res, result) {
  // Extra error details (e.g. bookingIds for group_slot_rebooked, tier for tier_not_available) go back too.
  if (result.error) {
    const { status, error, ...details } = result;
    return res.status(status).json({ error, ...details });
  }
  const { status, ...body } = result;
  return res.status(status || 200).json(body);
}

// B6a: with AZAMPAY_TRAINER_PRODUCTS on (and AZAMPAY_PAYMENTS), trainers may start a
// payment for their own trainer gym pass (the service checks the product). Off: paying is
// members only, exactly as before (403 forbidden for any other role).
// Refresh always admits members and trainers: a trainer whose own pass prompt is out when
// the flag is turned off may still ask how it went; for anything else the service answers
// a trainer exactly as the member-only guard did (403 forbidden, requiredRoles ['member']).
// Each guard is scoped to its own route (routeGuard): the prefix mount would otherwise run
// the pay guard on /mobile-money/refresh too.
const memberGuard = requireAuth('member');
const memberOrTrainerGuard = requireAuth('member', 'trainer');
const payerGuard = (req, res, next) => (azampayTrainerProductsOn() ? memberOrTrainerGuard : memberGuard)(req, res, next);
const payerRole = req => (req.user?.userType === 'trainer' ? 'trainer' : 'member');

/** Does the answer carry `mobileMoney.products`? With the trainer switch, or while a member may pay an event / shop order this way. */
const listsProducts = (role) => azampayTrainerProductsOn()
  || ((eventsPaymentsAzampayOn() || azampayShopOrdersOn()) && mobileMoneyService.payableProducts(role).some(p => ['EVENT_ORDER', 'SHOP_ORDER'].includes(p)));

export const paymentOptions = {
  created, method: 'get', path: '/payments/options',
  description: 'Whether paying through AzamPay (the only payment method) is available, and in which environment (sandbox shows a test-mode notice in the app) → { enabled, provider: "azampay", environment, methods }. `methods` (additive) lists the ways a request can be paid now: "mobile_money" (POST /me/payments/:id/mobile-money), "bank" (AZAMPAY_BANK_CHECKOUT; POST /me/payments/:id/bank; then also `bank` { providers: ["CRDB","NMB"], maxAmountTzs }) and "page" (AZAMPAY_CHECKOUT_PAGE; POST /me/payments/:id/checkout-page; then also `page` { returnTo: ["app","web"] as configured, languages: ["en","sw"] }); [] while paying is off. There is no `manual` block any more (members do not pay by hand). While AZAMPAY_TRAINER_PRODUCTS is on (with AZAMPAY_PAYMENTS), or while a member may pay an event order (EVENTS_PAYMENTS_AZAMPAY) or a shop order (AZAMPAY_SHOP_ORDERS) this way, also `mobileMoney` { products }: the product kinds the caller may pay by mobile money (member: FITFLEX_PASS, GYM_SUBSCRIPTION, TRAINER_SERVICE, EVENT_ORDER, SHOP_ORDER as switched on; trainer: TRAINER_GYM_PASS; empty while paying is not offered).',
  onGuard: requireAuth(),
  onRequest: async (req, res) => res.json({
    ...mobileMoneyService.options(),
    // Switches off: no `mobileMoney` key (members: FITFLEX_PASS + GYM_SUBSCRIPTION).
    ...(listsProducts(req?.user?.userType) ? { mobileMoney: { products: mobileMoneyService.payableProducts(req?.user?.userType) } } : {}),
  })
};

export const payByMobileMoney = {
  created, method: 'post', path: '/me/payments/:id/mobile-money',
  description: 'Ask the payer\'s phone to approve one of their own pending payment requests (member: pass, upgrade, gym plan, custom gym pass and, with AZAMPAY_TRAINER_PRODUCTS, trainer sessions; with EVENTS_PAYMENTS_AZAMPAY an event order; with AZAMPAY_SHOP_ORDERS their own shop order; trainer, with AZAMPAY_TRAINER_PRODUCTS: their own trainer gym pass). Body {phone, network?}: network is the wallet (Mpesa | Tigo | Airtel | Halopesa | Azampesa); without it the network is taken from the number (400 network_required when it cannot be). The amount is always the request\'s own. 404 feature_disabled while off; 404 not_found for someone else\'s request; 403 not_payable_by_role (an EVENT_ORDER or SHOP_ORDER is a member\'s purchase only); 409 hold_expired | event_not_open | order_amount_mismatch | payment_row_mismatch (EVENT_ORDER pre-checks); 409 order_not_found | order_buyer_mismatch | order_amount_mismatch | order_not_payable (SHOP_ORDER pre-checks); A prompt that is out answers 200 { state: in_progress, alreadyRequested: true }; ten minutes after a prompt whose answer never came, a new one may be asked for. 409 payment_not_pending / manual_payment_submitted / not_payable_this_way / tier_not_available / invalid_amount / unsupported_currency / group_slot_rebooked {bookingIds}; 400 invalid_phone; 429 too_many_attempts.',
  requestSample: { phone: '0712345678', network: 'Mpesa' },
  onGuard: routeGuard('post', payerGuard),
  onRequest: async (req, res) => {
    const result = await mobileMoneyService.pay({
      memberId: req.user.sub, role: payerRole(req), paymentRequestId: req.params.id, phone: req.body?.phone,
      // The wallet paid from (Mpesa | Tigo | Airtel | Halopesa | Azampesa); optional, else taken from the number.
      network: typeof req.body?.network === 'string' ? req.body.network : null,
    });
    logPay('pay', req, result);
    return send(res, result);
  }
};

export const payByBank = {
  created, method: 'post', path: '/me/payments/:id/bank',
  description: 'AZAMPAY_BANK_CHECKOUT (with AZAMPAY_PAYMENTS; else 404 feature_disabled): pay one of the caller\'s own pending payment requests by AzamPay bank checkout. Body { bank: CRDB | NMB, accountNumber (the payer\'s bank account, 5–30 letters/digits/-/ /), phone (the mobile number registered with the bank), otp (the one-time password the bank gave the payer: 4–12 letters/digits) }. The OTP is passed to AzamPay and nowhere else: never stored, logged or audited. The amount is always the request\'s own. Same roles, products and ownership as paying by mobile money. → 202 { state: "in_progress", paymentRequest { id, status, amountTzs, provider, reference }, method: "bank" }; settled only by AzamPay\'s callback (poll POST /me/payments/:id/refresh). 200 { state: "in_progress", alreadyRequested: true } while an attempt is out. 400 invalid_bank { allowed } | invalid_account_number | invalid_phone | invalid_otp; 404 not_found (someone else\'s request); 403 not_payable_by_role; 409 payment_not_pending | manual_payment_submitted | not_payable_this_way | tier_not_available | invalid_amount | unsupported_currency | amount_over_bank_limit { maxTzs } | bank_attempts_exhausted { max } (the bank refused this request 5 times: the bank method is closed for it) | the EVENT_ORDER / SHOP_ORDER / trainer pre-checks of the mobile-money route; 422 provider_rejected (AzamPay refused it, e.g. a wrong OTP: the request is free again); 429 too_many_attempts (5 per member, 3 per phone in 10 minutes); 503 provider_unavailable.',
  requestSample: { bank: 'CRDB', accountNumber: '0150123456789', phone: '0712345678', otp: '123456' },
  onGuard: routeGuard('post', payerGuard),
  onRequest: async (req, res) => {
    const result = await mobileMoneyService.payByBank({
      memberId: req.user.sub, role: payerRole(req), paymentRequestId: req.params.id,
      bank: req.body?.bank, accountNumber: req.body?.accountNumber, phone: req.body?.phone, otp: req.body?.otp,
    });
    logPay('pay_bank', req, result);
    return send(res, result);
  }
};

export const payByCheckoutPage = {
  created, method: 'post', path: '/me/payments/:id/checkout-page',
  description: 'AZAMPAY_CHECKOUT_PAGE (with AZAMPAY_PAYMENTS, AZAMPAY_VENDOR_ID / AZAMPAY_VENDOR_NAME and a configured return address; else 404 feature_disabled): open AzamPay\'s hosted payment page for one of the caller\'s own pending payment requests. Body { returnTo?: "app" | "web" (default: the first configured), language?: "en" | "sw" (default en) }. The client NEVER sends an address: "app" returns to <PUBLIC_API_URL>/payments/azampay/return, "web" to <PORTAL_PUBLIC_URL>/m/payment-return/?paymentRequestId=…&result=success|failed. → 202 { state: "in_progress", paymentRequest, method: "page", checkoutUrl } — open checkoutUrl in the external browser / a new window. Arriving back proves nothing: the request is settled only by AzamPay\'s callback, so refresh (POST /me/payments/:id/refresh) after returning. While the page is open (30 minutes) the same call answers 200 { state: "in_progress", alreadyRequested: true, method: "page", checkoutUrl } with the SAME page. Same roles, products and ownership as paying by mobile money. 400 invalid_return_to { allowed } | invalid_language { allowed }; 404 not_found; 403 not_payable_by_role; 409 payment_not_pending | manual_payment_submitted | not_payable_this_way | return_not_configured | tier_not_available | invalid_amount | unsupported_currency | the EVENT_ORDER / SHOP_ORDER / trainer pre-checks; 422 provider_rejected; 429 too_many_attempts; 503 provider_unavailable.',
  requestSample: { returnTo: 'app', language: 'en' },
  onGuard: routeGuard('post', payerGuard),
  onRequest: async (req, res) => {
    const result = await mobileMoneyService.payByPage({
      memberId: req.user.sub, role: payerRole(req), paymentRequestId: req.params.id,
      // Enumerated values only; an address in the body is never read.
      returnTo: typeof req.body?.returnTo === 'string' ? req.body.returnTo : null,
      language: typeof req.body?.language === 'string' ? req.body.language : null,
    });
    logPay('pay_page', req, result);
    return send(res, result);
  }
};

export const azampayReturn = {
  created, method: 'get', path: '/payments/azampay/return',
  description: 'Where AzamPay\'s payment page sends a payer who paid from the mobile app (returnTo "app"). Public, static HTML ("go back to the app"), English + Swahili; reads only ?result=success|failed to choose the sentence. It changes nothing and proves nothing: a payment is settled only by AzamPay\'s callback.',
  onRequest: async (req, res) => res.status(200).type('text/html; charset=utf-8').send(appReturnPage(req.query?.result === 'success' ? 'success' : 'failed'))
};

const refreshNow = async (req, res) => {
  const result = await mobileMoneyService.refresh({
    memberId: req.user.sub, role: payerRole(req), paymentRequestId: req.params.id,
  });
  logPay('refresh', req, result);
  return send(res, result);
};

export const refreshPayment = {
  created, method: 'post', path: '/me/payments/:id/refresh',
  description: 'Has the payment gone through — for every method (mobile money, bank, checkout page)? The same answer as POST /me/payments/:id/mobile-money/refresh (kept for current apps): { state: in_progress | completed | failed | held | none, reason?, paymentRequest, remark?, checkoutUrl? }. `checkoutUrl` is present while a payment page is open, so it can be opened again. AzamPay has no status query: the request settles when its signed callback arrives; this only reports where it stands.',
  onGuard: routeGuard('post', memberOrTrainerGuard),
  onRequest: refreshNow
};

export const refreshMobileMoneyPayment = {
  created, method: 'post', path: '/me/payments/:id/mobile-money/refresh',
  description: 'Has the mobile-money payment gone through? AzamPay has no status query: the request settles when AzamPay\'s signed callback arrives, and refresh reports where it stands (it settles nothing on its own; a prompt unanswered for ten minutes is given up: state none, the member may pay again). state: in_progress | completed | failed | held | none. Same roles as paying (a trainer only for their own trainer gym pass); with AZAMPAY_TRAINER_PRODUCTS off, a trainer may still refresh their own trainer pass while its prompt is out (anything else: 403 forbidden as before). state held comes with reason (e.g. amount_mismatch, transaction_mismatch, reference_already_used, no_open_attempt, group_slot_rebooked).',
  onGuard: routeGuard('post', memberOrTrainerGuard),
  onRequest: async (req, res) => {
    const result = await mobileMoneyService.refresh({
      memberId: req.user.sub, role: payerRole(req), paymentRequestId: req.params.id,
    });
    logPay('refresh', req, result);
    return send(res, result);
  }
};
