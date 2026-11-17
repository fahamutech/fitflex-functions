// Is a mobile-money prompt (AzamPay) out for a payment request?
// Shared by the mobile-money service and the services that must not change a
// request under a live prompt (e.g. cancelling a trainer session, which would
// shrink or cancel the payment the member is approving on their phone).
//
//   provider 'azampay' + reference '<transaction id>'   a prompt is on the phone;
//                                                       given up after PROMPT_TTL_MS
//   provider 'azampay' + reference 'pending:<ms>'       a call to send one is under way;
//                                                       given up after CLAIM_TTL_MS

export const MOBILE_MONEY_PROVIDER = 'azampay';
export const isMobileMoneyProvider = (provider) => provider === MOBILE_MONEY_PROVIDER;
export const CLAIM_PLACEHOLDER = 'pending:';
/** A claim whose call never came back is given up after this long. */
export const CLAIM_TTL_MS = 2 * 60_000;
/**
 * A prompt whose answer never came is given up after this long, so the member
 * can ask for a new one. AzamPay has no status query for collections, so a lost
 * callback would otherwise leave the request "in flight" for ever. ASSUMPTION:
 * a USSD push is answered or times out on the handset within a couple of
 * minutes; ten leaves room for a slow callback. A success that still arrives
 * for the old prompt is never approved on its own: it is held for staff
 * (see mobile-money-service). A request with no `promptedAt` (sent before the
 * column existed) keeps its prompt until staff or a callback decide it.
 */
export const PROMPT_TTL_MS = 10 * 60_000;

export const isClaimPlaceholder = (ref) => typeof ref === 'string' && ref.startsWith(CLAIM_PLACEHOLDER);
export const claimAge = (ref, nowMs) => nowMs - Number(String(ref).slice(CLAIM_PLACEHOLDER.length) || 0);

/** A prompt sent at `promptedAt` that has waited longer than PROMPT_TTL_MS for its answer. */
export function promptExpired(request, nowMs = Date.now()) {
  if (!request?.promptedAt) return false;
  const at = +new Date(request.promptedAt);
  return Number.isFinite(at) && nowMs - at >= PROMPT_TTL_MS;
}

/** A prompt is out and recent, or a call to send one is under way and recent. */
export function mobileMoneyInFlight(request, nowMs = Date.now()) {
  if (!request || !isMobileMoneyProvider(request.provider) || !request.reference) return false;
  if (isClaimPlaceholder(request.reference)) return claimAge(request.reference, nowMs) < CLAIM_TTL_MS;
  return !promptExpired(request, nowMs);
}

/** The same, for a request that is still pending (a decided request has no live prompt to protect). */
export const pendingMobileMoneyInFlight = (request, nowMs = Date.now()) =>
  request?.status === 'pending' && mobileMoneyInFlight(request, nowMs);
