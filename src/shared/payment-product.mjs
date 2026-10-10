// Which commercial product a payment request or subscription is for.
// Derived from the references the row already carries (no stored column), so
// existing records keep their meaning:
//   FITFLEX_PASS      a platform pass tier (Basic / Pro / Premium / Executive)
//   GYM_SUBSCRIPTION  one gym's own daily / weekly / monthly plan
//   TRAINER_SERVICE   trainer session booking (bookingGroupId)
//   TRAINER_GYM_PASS  a trainer's pass to train at a gym
//   SHOP_ORDER        marketplace order (orderId)

export const PRODUCT_TYPES = Object.freeze({
  FITFLEX_PASS: 'FITFLEX_PASS',
  GYM_SUBSCRIPTION: 'GYM_SUBSCRIPTION',
  TRAINER_SERVICE: 'TRAINER_SERVICE',
  TRAINER_GYM_PASS: 'TRAINER_GYM_PASS',
  SHOP_ORDER: 'SHOP_ORDER',
});

const BY_SUBSCRIPTION_TYPE = Object.freeze({
  platform_pass: PRODUCT_TYPES.FITFLEX_PASS,
  direct_sub: PRODUCT_TYPES.GYM_SUBSCRIPTION,
  trainer_pass: PRODUCT_TYPES.TRAINER_GYM_PASS,
});

export const productTypeOfSubscription = (sub) => BY_SUBSCRIPTION_TYPE[sub?.type] || null;

/** @param request a PaymentRequest row; @param sub its subscription, when it has one */
export function productTypeOfPayment(request, sub = null) {
  if (!request) return null;
  if (request.bookingGroupId) return PRODUCT_TYPES.TRAINER_SERVICE;
  if (request.orderId) return PRODUCT_TYPES.SHOP_ORDER;
  const fromSub = productTypeOfSubscription(sub);
  if (fromSub) return fromSub;
  // Subscription row missing: fall back to what the request itself says.
  if (request.note === 'trainer_pass') return PRODUCT_TYPES.TRAINER_GYM_PASS;
  if (request.gymId && request.plan) return PRODUCT_TYPES.GYM_SUBSCRIPTION;
  if (request.tier) return PRODUCT_TYPES.FITFLEX_PASS;
  return null;
}

/** The products that give a member gym access — the ones that compete for the one "pending payment" slot. */
export const MEMBER_ACCESS_PRODUCTS = Object.freeze([PRODUCT_TYPES.FITFLEX_PASS, PRODUCT_TYPES.GYM_SUBSCRIPTION]);
