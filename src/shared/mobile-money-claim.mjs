// Is a mobile-money prompt (Malipo by Tunzaa or AzamPay) out for a payment request?
// Shared by the mobile-money service and the services that must not change a
// request under a live prompt (e.g. cancelling a trainer session, which would
// shrink or cancel the payment the member is approving on their phone).
//
//   provider 'tunzaa'|'azampay' + reference '<transaction id>'   a prompt is on the phone
//   provider 'tunzaa'|'azampay' + reference 'pending:<ms>'       a call to send one is under way;
//                                                                given up after CLAIM_TTL_MS

export const MOBILE_MONEY_PROVIDER = 'tunzaa';
export const AZAMPAY_PROVIDER = 'azampay';
/** Every provider whose prompt can be on a member's phone. */
export const MOBILE_MONEY_PROVIDERS = Object.freeze([MOBILE_MONEY_PROVIDER, AZAMPAY_PROVIDER]);
export const isMobileMoneyProvider = (provider) => MOBILE_MONEY_PROVIDERS.includes(provider);
export const CLAIM_PLACEHOLDER = 'pending:';
/** A claim whose call never came back is given up after this long. */
export const CLAIM_TTL_MS = 2 * 60_000;

export const isClaimPlaceholder = (ref) => typeof ref === 'string' && ref.startsWith(CLAIM_PLACEHOLDER);
export const claimAge = (ref, nowMs) => nowMs - Number(String(ref).slice(CLAIM_PLACEHOLDER.length) || 0);

/** A prompt is out, or a call to send one is under way and recent. */
export function mobileMoneyInFlight(request, nowMs = Date.now()) {
  if (!request || !isMobileMoneyProvider(request.provider) || !request.reference) return false;
  return !isClaimPlaceholder(request.reference) || claimAge(request.reference, nowMs) < CLAIM_TTL_MS;
}

/** The same, for a request that is still pending (a decided request has no live prompt to protect). */
export const pendingMobileMoneyInFlight = (request, nowMs = Date.now()) =>
  request?.status === 'pending' && mobileMoneyInFlight(request, nowMs);
