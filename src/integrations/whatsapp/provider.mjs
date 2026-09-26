// WhatsApp provider seam. Everything that sends WhatsApp messages (the
// communication dispatcher, the admin test send) talks to a provider through
// this contract, so going live is configuration: pick the provider with
// WHATSAPP_PROVIDER and give it its credentials in the environment.
//
// There is no WhatsApp Business account yet (decision D2), so the only
// providers are:
//   - not_configured (the default): nothing is sent; messages are skipped
//     with `whatsapp_not_configured`.
//   - fake: for tests and development; never in production.
// A real adapter is added with registerWhatsAppProvider() once the account
// and provider are confirmed, and checked against the provider's API with a
// sandbox send.
//
// ── The contract ───────────────────────────────────────────────────────────
// A provider is an object with:
//   name: string                    — what the registry rows are stored under
//   configured: boolean             — false: nothing can be sent
//   validateRecipient(phone)        → { ok: true, to: '+255…' }
//                                   | { ok: false, reason: 'no_phone' | 'invalid_phone' }
//   sendTemplate({ to, templateName, language, parameters, category, reference })
//                                   → SendResult. Business-initiated messages
//                                     must use a provider-approved template.
//                                     `reference` is our ledger id, passed on
//                                     so a provider that supports it can drop
//                                     a repeat.
//   sendMessage({ to, text, reference })
//                                   → SendResult. Free text, only allowed in
//                                     the 24 hours after the member wrote to us.
//   getDeliveryStatus(providerMessageId)
//                                   → { status: 'sent'|'delivered'|'read'|'failed', error? } | { error }
//   listTemplates()                 → { templates: [{ name, language, category, status, variables? }] } | { error }
//   parseWebhook({ body, headers, query })
//                                   → { statuses: [{ providerMessageId, status, at, error? }],
//                                       inbound: [{ from, text, providerMessageId, at }] }
//   verifyWebhook(query)            (optional) → the answer to a provider's
//                                     GET check of the webhook URL, if it
//                                     does one
//
// SendResult is { ok: true, providerMessageId } or
// { ok: false, error, retryable, detail? } where error is one of
// ERRORS below. `retryable` failures are tried again later; the rest fail
// the message for good.
//
// Credentials only ever come from the environment, never from code or the
// database.
import { toE164 } from '../../shared/phone.mjs';
import { createNotConfiguredWhatsAppProvider } from './not-configured-provider.mjs';
import { createFakeWhatsAppProvider } from './fake-provider.mjs';

export const ERRORS = {
  notConfigured: 'whatsapp_not_configured',
  invalidRecipient: 'invalid_recipient',
  optedOut: 'recipient_opted_out',
  templateNotApproved: 'template_not_approved',
  rateLimited: 'rate_limited',
  unavailable: 'provider_unavailable',
};

export const DELIVERY_STATUSES = ['sent', 'delivered', 'read', 'failed'];

/** Shared recipient check: a phone that normalises to E.164. */
export function validateRecipient(phone) {
  if (!phone || !String(phone).trim()) return { ok: false, reason: 'no_phone' };
  const to = toE164(phone);
  return to ? { ok: true, to } : { ok: false, reason: 'invalid_phone' };
}

const asDate = (t) => {
  if (t == null || t === '') return new Date();
  const n = Number(t);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(t);
  return Number.isNaN(+d) ? new Date() : d;
};

/**
 * FitFlex's own webhook shape, used by the fake provider and by tests:
 * { statuses: [{ id, status, timestamp?, error? }], messages: [{ from, text, id?, timestamp? }] }.
 * A real adapter parses its provider's format into the same result.
 */
export function parseStandardWebhook({ body } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const statuses = (Array.isArray(b.statuses) ? b.statuses : [])
    .filter(s => s && typeof s.id === 'string' && DELIVERY_STATUSES.includes(s.status))
    .map(s => ({
      providerMessageId: s.id, status: s.status, at: asDate(s.timestamp),
      ...(s.error ? { error: String(s.error).slice(0, 200) } : {}),
    }));
  const inbound = (Array.isArray(b.messages) ? b.messages : [])
    .filter(m => m && typeof m.from === 'string' && typeof m.text === 'string')
    .map(m => ({ from: m.from, text: m.text.slice(0, 1000), providerMessageId: m.id || null, at: asDate(m.timestamp) }));
  return { statuses, inbound };
}

// ── registry ───────────────────────────────────────────────────────────────

const factories = new Map([
  ['fake', { create: createFakeWhatsAppProvider, requiredEnv: [], devOnly: true }],
]);

/**
 * Adds a provider adapter. `requiredEnv` lists the environment variables it
 * needs (e.g. an API key); if any is unset the provider stays "not
 * configured" and says which ones are missing — never their values.
 */
export function registerWhatsAppProvider(name, create, { requiredEnv = [], devOnly = false } = {}) {
  factories.set(name, { create, requiredEnv, devOnly });
}

export const knownWhatsAppProviders = () => [...factories.keys()];

/**
 * The provider chosen by WHATSAPP_PROVIDER. Anything unknown, incomplete or
 * not allowed here falls back to "not configured" with the reason, so a
 * typo in the environment never sends — or crashes the server.
 */
export function createWhatsAppProvider({ env = process.env, logger = console } = {}) {
  const wanted = String(env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
  if (!wanted || wanted === 'none' || wanted === 'not_configured') {
    return createNotConfiguredWhatsAppProvider({ reason: 'no_provider' });
  }
  const entry = factories.get(wanted);
  if (!entry) {
    logger.warn?.(`[whatsapp] Unknown WHATSAPP_PROVIDER "${wanted}" — WhatsApp stays off. Known: ${knownWhatsAppProviders().join(', ')}.`);
    return createNotConfiguredWhatsAppProvider({ reason: 'unknown_provider', wanted });
  }
  if (entry.devOnly && env.NODE_ENV === 'production') {
    logger.warn?.(`[whatsapp] The ${wanted} provider is for development only — WhatsApp stays off in production.`);
    return createNotConfiguredWhatsAppProvider({ reason: 'dev_only_provider', wanted });
  }
  const missing = entry.requiredEnv.filter(k => !env[k]);
  if (missing.length) {
    logger.warn?.(`[whatsapp] ${wanted} needs ${missing.join(', ')} — WhatsApp stays off.`);
    return createNotConfiguredWhatsAppProvider({ reason: 'missing_credentials', wanted, missing });
  }
  return entry.create({ env, logger });
}
