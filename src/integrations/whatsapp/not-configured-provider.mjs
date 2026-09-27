// The default WhatsApp provider while there is no WhatsApp Business account:
// it sends nothing. The dispatcher skips WhatsApp messages with
// `whatsapp_not_configured` rather than failing them.
import { ERRORS, parseStandardWebhook, validateRecipient } from './provider.mjs';

export function createNotConfiguredWhatsAppProvider({ reason = 'no_provider', wanted = null, missing = [] } = {}) {
  const notConfigured = async () => ({ ok: false, error: ERRORS.notConfigured, retryable: false });
  return {
    name: 'not_configured',
    configured: false,
    // Why it isn't configured, for the admin status page. Names of missing
    // variables only — never values.
    setup: { reason, wanted, missing },
    validateRecipient,
    sendTemplate: notConfigured,
    sendMessage: notConfigured,
    getDeliveryStatus: async () => ({ error: ERRORS.notConfigured }),
    listTemplates: async () => ({ error: ERRORS.notConfigured }),
    parseWebhook: parseStandardWebhook,
  };
}
