// SMS provider seam. Everything that sends an SMS for reminders and
// campaigns (src/services/sms-service.mjs) talks to a provider through this
// contract, so going live is configuration: name the provider in
// SMS_PROVIDER and give it its credentials in the environment.
//   - not_configured (the default): nothing is sent, so a deploy on its own
//     never starts sending (or paying for) messages.
//   - beem: Beem Africa. Needs BEEM_API_KEY and BEEM_SECRET_KEY; the sender
//     name registered with Beem goes in BEEM_SENDER_ID ("INFO", Beem's
//     shared name, until FitFlex's own is approved).
//   - fake: for tests and development; never in production.
// Verification codes choose their sender separately
// (VERIFICATION_SMS_PROVIDER, src/infra/verification-senders.mjs) and use
// the same Beem client and credentials.
//
// ── The contract ───────────────────────────────────────────────────────────
// A provider is an object with:
//   name: string            — stored on each SmsLog row
//   configured: boolean     — false: nothing can be sent
//   sender: string|null     — the sender name members see
//   maxRecipients: number   — how many numbers one send() may carry
//   send({ to: ['+255…'], text })
//       → { ok: true, providerMessageId }
//       | { ok: false, error, retryable, code?, message? }
import { toE164 } from '../../shared/phone.mjs';
import { beemSend, beemSettings, BEEM_MAX_RECIPIENTS } from './beem.mjs';

export const ERRORS = {
  notConfigured: 'sms_not_configured',
  rejected: 'provider_rejected',
  unreachable: 'provider_unreachable',
};

/** Shared recipient check: a phone that normalises to E.164. */
export function validateRecipient(phone) {
  if (!phone || !String(phone).trim()) return { ok: false, reason: 'no_phone' };
  const to = toE164(phone);
  return to ? { ok: true, to } : { ok: false, reason: 'invalid_phone' };
}

export function createNotConfiguredSmsProvider({ reason = 'no_provider', wanted = null, missing = [] } = {}) {
  return {
    name: 'not_configured',
    configured: false,
    sender: null,
    maxRecipients: BEEM_MAX_RECIPIENTS,
    // Why it isn't configured, for the admin status route. Names of missing
    // variables only — never values.
    setup: { reason, wanted, missing },
    send: async () => ({ ok: false, error: ERRORS.notConfigured, retryable: false }),
  };
}

/** The sender name for Beem: FitFlex's own once approved, Beem's shared "INFO" until then. */
export const beemSenderName = (env = process.env) => env.BEEM_SENDER_ID || env.VERIFICATION_SMS_SENDER_ID || 'INFO';

export function createBeemSmsProvider({ env = process.env, fetchImpl = fetch } = {}) {
  const settings = beemSettings(env);
  const sender = beemSenderName(env);
  return {
    name: 'beem',
    configured: Boolean(settings),
    sender,
    maxRecipients: BEEM_MAX_RECIPIENTS,
    send: async ({ to, text }) => {
      const r = await beemSend({ ...settings, sender, text, to, fetchImpl });
      return r.ok ? { ok: true, providerMessageId: r.requestId } : r;
    },
  };
}

/** Keeps what it "sent" in `sent`; `failWith` makes the next sends fail that way. */
export function createFakeSmsProvider() {
  const provider = {
    name: 'fake',
    configured: true,
    sender: 'FAKE',
    maxRecipients: BEEM_MAX_RECIPIENTS,
    sent: [],
    failWith: null,
    send: async ({ to, text }) => {
      if (provider.failWith) return { ok: false, ...provider.failWith };
      provider.sent.push({ to: [...to], text });
      return { ok: true, providerMessageId: `fake_${provider.sent.length}` };
    },
  };
  return provider;
}

const factories = new Map([
  ['beem', { create: createBeemSmsProvider, requiredEnv: ['BEEM_API_KEY', 'BEEM_SECRET_KEY'] }],
  ['fake', { create: createFakeSmsProvider, requiredEnv: [], devOnly: true }],
]);

export const knownSmsProviders = () => [...factories.keys()];

/**
 * The provider chosen by SMS_PROVIDER. Anything unknown, incomplete or not
 * allowed here falls back to "not configured" with the reason, so a typo in
 * the environment never sends — or crashes the server.
 */
export function createSmsProvider({ env = process.env, logger = console } = {}) {
  const wanted = String(env.SMS_PROVIDER || '').trim().toLowerCase();
  if (!wanted || wanted === 'none' || wanted === 'not_configured') {
    return createNotConfiguredSmsProvider({ reason: 'no_provider' });
  }
  const entry = factories.get(wanted);
  if (!entry) {
    logger.warn?.(`[sms] Unknown SMS_PROVIDER "${wanted}" — SMS stays off. Known: ${knownSmsProviders().join(', ')}.`);
    return createNotConfiguredSmsProvider({ reason: 'unknown_provider', wanted });
  }
  if (entry.devOnly && env.NODE_ENV === 'production') {
    logger.warn?.(`[sms] The ${wanted} provider is for development only — SMS stays off in production.`);
    return createNotConfiguredSmsProvider({ reason: 'dev_only_provider', wanted });
  }
  const missing = entry.requiredEnv.filter(k => !env[k]);
  if (missing.length) {
    logger.warn?.(`[sms] ${wanted} needs ${missing.join(', ')} — SMS stays off.`);
    return createNotConfiguredSmsProvider({ reason: 'missing_credentials', wanted, missing });
  }
  return entry.create({ env, logger });
}
