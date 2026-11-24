// Is a mobile-money prompt (AzamPay) out for a payment request?
// Shared by the mobile-money service and the services that must not change a
// request under a live prompt (e.g. cancelling a trainer session, which would
// shrink or cancel the payment the member is approving on their phone).
//
//   provider 'azampay' + reference '<transaction id>'   a prompt is on the phone (or a bank checkout was sent);
//                                                       given up after PROMPT_TTL_MS
//   provider 'azampay' + reference '<page reference>' + checkoutUrl   AzamPay's payment page is open;
//                                                       given up after PAGE_TTL_MS
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

/**
 * AzamPay's hosted payment page stays open longer than a phone prompt: the member picks a wallet or bank and
 * pays inside it. ASSUMPTION (the page's own session length is not documented): half an hour.
 */
export const PAGE_TTL_MS = 30 * 60_000;

/**
 * Our reference for one checkout-page attempt. AzamPay asks for an `externalId` that is a "30 characters long
 * unique string", so "<request id>.<attempt>" does not fit. The 30 characters are, all lower-case letters and digits:
 *
 *   f | L | <request id without "pay_"> (L characters) | <attempt: the time in base 36, left-padded with 0>
 *
 * L is one base-36 digit (1–19), so the reference parses back to exactly one request and one attempt, and two
 * attempts of one request never share a reference. A request whose id is not "pay_" + 1–19 letters/digits has
 * no page reference (null): it cannot be paid on the page.
 */
export function pageReferenceFor(requestId, nowMs) {
  const m = /^pay_([0-9a-z]{1,19})$/.exec(String(requestId ?? ''));
  if (!m) return null;
  const head = `f${m[1].length.toString(36)}${m[1]}`;
  const attempt = Math.floor(nowMs).toString(36);
  if (!/^[0-9a-z]+$/.test(attempt) || head.length + attempt.length > 30) return null;
  return head + attempt.padStart(30 - head.length, '0');
}

/** The request and attempt inside a checkout-page reference, or null when it is not one. */
export function parsePageReference(ref) {
  const text = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
  if (text.length !== 30 || text[0] !== 'f' || !/^[0-9a-z]+$/.test(text)) return null;
  const length = parseInt(text[1], 36);
  if (!(length >= 1 && length <= 19)) return null;
  const attempt = parseInt(text.slice(2 + length), 36);
  if (!Number.isFinite(attempt)) return null;
  return { requestId: `pay_${text.slice(2, 2 + length)}`, attempt };
}

export const isClaimPlaceholder = (ref) => typeof ref === 'string' && ref.startsWith(CLAIM_PLACEHOLDER);
export const claimAge = (ref, nowMs) => nowMs - Number(String(ref).slice(CLAIM_PLACEHOLDER.length) || 0);

/** A prompt sent at `promptedAt` that has waited longer than PROMPT_TTL_MS for its answer. */
export function promptExpired(request, nowMs = Date.now()) {
  if (!request?.promptedAt) return false;
  const at = +new Date(request.promptedAt);
  // A checkout page (the request carries its address) is given longer than a phone prompt or a bank checkout.
  return Number.isFinite(at) && nowMs - at >= (request.checkoutUrl ? PAGE_TTL_MS : PROMPT_TTL_MS);
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
