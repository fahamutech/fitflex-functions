// Pay a payment request by mobile money (Malipo by Tunzaa).
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { mobileMoneyService, manualPayment } from '../src/bootstrap/services.mjs';
import { tunzaaTrainerProductsOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';

const created = new Date().toISOString();

function send(res, result) {
  // Extra error details (e.g. bookingIds for group_slot_rebooked, tier for tier_not_available) go back too.
  if (result.error) {
    const { status, error, ...details } = result;
    return res.status(status).json({ error, ...details });
  }
  const { status, ...body } = result;
  return res.status(status || 200).json(body);
}

// B6a: with TUNZAA_TRAINER_PRODUCTS on (and TUNZAA_PAYMENTS), trainers may start a
// payment for their own trainer gym pass (the service checks the product). Off: paying is
// members only, exactly as before (403 forbidden for any other role).
// Refresh always admits members and trainers: a trainer whose own pass prompt is out when
// the flag is turned off may still ask how it went; for anything else the service answers
// a trainer exactly as the member-only guard did (403 forbidden, requiredRoles ['member']).
// Each guard is scoped to its own route (routeGuard): the prefix mount would otherwise run
// the pay guard on /mobile-money/refresh too.
const memberGuard = requireAuth('member');
const memberOrTrainerGuard = requireAuth('member', 'trainer');
const payerGuard = (req, res, next) => (tunzaaTrainerProductsOn() ? memberOrTrainerGuard : memberGuard)(req, res, next);
const payerRole = req => (req.user?.userType === 'trainer' ? 'trainer' : 'member');

export const paymentOptions = {
  created, method: 'get', path: '/payments/options',
  description: 'Whether paying by mobile money is available, and in which environment (sandbox shows a test-mode notice in the app). While MANUAL_PAY_INSTRUCTIONS is on, also `manual` { enabled, lipaNamba, accountName, network, instructions, referenceRequired, payerPhoneRequired }: enabled only when the Lipa Namba and account name are configured. While TUNZAA_TRAINER_PRODUCTS is on (with TUNZAA_PAYMENTS), also `mobileMoney` { products }: the product kinds the caller may pay by mobile money (member: FITFLEX_PASS, GYM_SUBSCRIPTION, TRAINER_SERVICE; trainer: TRAINER_GYM_PASS; empty while paying is not offered).',
  onGuard: requireAuth(),
  onRequest: async (req, res) => res.json({
    ...mobileMoneyService.options(),
    // Flag off: the response is exactly as before (no `manual` key).
    ...(manualPayment.flagOn() ? { manual: manualPayment.options() } : {}),
    // B6a flag off: no `mobileMoney` key (members: FITFLEX_PASS + GYM_SUBSCRIPTION, as before).
    ...(tunzaaTrainerProductsOn() ? { mobileMoney: { products: mobileMoneyService.payableProducts(req?.user?.userType) } } : {}),
  })
};

export const payByMobileMoney = {
  created, method: 'post', path: '/me/payments/:id/mobile-money',
  description: 'Ask the payer\'s phone to approve one of their own pending payment requests (member: pass, upgrade, gym plan and, with TUNZAA_TRAINER_PRODUCTS, trainer sessions; trainer, with TUNZAA_TRAINER_PRODUCTS: their own trainer gym pass). Body {phone}. The amount is always the request\'s own. 404 feature_disabled while off; 404 not_found for someone else\'s request; 403 not_payable_by_role; 409 payment_not_pending / manual_payment_submitted / not_payable_this_way / tier_not_available / invalid_amount / unsupported_currency / group_slot_rebooked {bookingIds}; 400 invalid_phone; 429 too_many_attempts.',
  requestSample: { phone: '0712345678' },
  onGuard: routeGuard('post', payerGuard),
  onRequest: async (req, res) => send(res, await mobileMoneyService.pay({
    memberId: req.user.sub, role: payerRole(req), paymentRequestId: req.params.id, phone: req.body?.phone,
  }))
};

export const refreshMobileMoneyPayment = {
  created, method: 'post', path: '/me/payments/:id/mobile-money/refresh',
  description: 'Has the mobile-money payment gone through? Reads the transaction back from Tunzaa and settles the request when it is complete. state: in_progress | completed | failed | held | none. Same roles as paying (a trainer only for their own trainer gym pass); with TUNZAA_TRAINER_PRODUCTS off, a trainer may still refresh their own trainer pass while its prompt is out (anything else: 403 forbidden as before). state held comes with reason (e.g. amount_mismatch, transaction_mismatch, reference_already_used, group_slot_rebooked).',
  onGuard: routeGuard('post', memberOrTrainerGuard),
  onRequest: async (req, res) => send(res, await mobileMoneyService.refresh({
    memberId: req.user.sub, role: payerRole(req), paymentRequestId: req.params.id,
  }))
};
