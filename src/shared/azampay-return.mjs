// Where AzamPay's hosted payment page sends the payer when they finish or give up.
//
// The addresses are built HERE, from the server's own configuration, and from nothing else: a client only
// names a target ('app' | 'web'). Nothing a client sends becomes part of a redirect address, so the page can
// never be used to bounce someone to another site (open redirect).
//
//   app   <PUBLIC_API_URL>/payments/azampay/return?result=success|failed
//         a small page of this server ("go back to the app"); the mobile app opened AzamPay's page in the
//         external browser and refreshes the payment when the member comes back.
//   web   <PORTAL_PUBLIC_URL>/m/payment-return/?paymentRequestId=<id>&result=success|failed
//         a page of the member web portal, which refreshes the payment.
//
// Arriving at either address proves NOTHING about the payment: it is settled only by AzamPay's signed callback.
import { publicBaseUrl } from './vendor-documents.mjs';

export const RETURN_TARGETS = Object.freeze(['app', 'web']);
export const RETURN_RESULTS = Object.freeze(['success', 'failed']);
export const APP_RETURN_PATH = '/payments/azampay/return';
// Trailing slash: the portal is a static export (/m/payment-return/index.html); a redirect to add it may drop the query.
export const WEB_RETURN_PATH = '/m/payment-return/';

/** The base of a target (https; http only under NODE_ENV=test), or null while it is not configured. */
const baseOf = (target, env) => (target === 'app' ? publicBaseUrl(env.PUBLIC_API_URL, { nodeEnv: env.NODE_ENV })
  : target === 'web' ? publicBaseUrl(env.PORTAL_PUBLIC_URL, { nodeEnv: env.NODE_ENV }) : null);

/** The targets that are configured on this server, 'app' first. */
export const pageReturnTargets = (env = process.env) => RETURN_TARGETS.filter((t) => baseOf(t, env) !== null);

/** { successUrl, failUrl, origin } for a target and a payment request, or null when the target is not configured. */
export function pageReturnUrls(target, request, env = process.env) {
  const base = baseOf(target, env);
  if (!base || !request?.id) return null;
  const origin = new URL(base).origin;
  if (target === 'app') {
    return { origin, successUrl: `${base}${APP_RETURN_PATH}?result=success`, failUrl: `${base}${APP_RETURN_PATH}?result=failed` };
  }
  const id = encodeURIComponent(String(request.id));
  return { origin, successUrl: `${base}${WEB_RETURN_PATH}?paymentRequestId=${id}&result=success`, failUrl: `${base}${WEB_RETURN_PATH}?paymentRequestId=${id}&result=failed` };
}

/**
 * The page a payer lands on after AzamPay's page when they paid from the mobile app. Static text only: the
 * one thing read from the address is `result`, and only to pick one of two fixed sentences (anything else is
 * 'failed'). English with Swahili placeholders, pending native review.
 */
export function appReturnPage(result) {
  const ok = result === 'success';
  const en = ok
    ? 'Thank you. Go back to the FitFlex app: your payment will show there once AzamPay confirms it.'
    : 'The payment was not completed. Go back to the FitFlex app to try again.';
  const sw = ok
    ? '[SW-PENDING] Thank you. Go back to the FitFlex app: your payment will show there once AzamPay confirms it.'
    : '[SW-PENDING] The payment was not completed. Go back to the FitFlex app to try again.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>FitFlex</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:32px 20px;color:#14261a;background:#f6f8f6}main{max-width:480px;margin:0 auto}h1{font-size:20px;color:#1F7A3A}p{font-size:16px;line-height:1.5}</style>
</head><body><main>
<h1>FitFlex</h1>
<p lang="en">${en}</p>
<p lang="sw">${sw}</p>
</main></body></html>`;
}
