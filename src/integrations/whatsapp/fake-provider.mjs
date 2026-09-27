// A WhatsApp provider that sends nothing but behaves like one, for tests and
// local development (WHATSAPP_PROVIDER=fake; refused in production).
//
// - It "approves" every FitFlex template in English and Swahili, so the
//   whole flow — registry sync, campaign, dispatcher, webhook — can be tried
//   without a WhatsApp account.
// - The recipient's number picks the outcome:
//     …0000  invalid recipient (fails for good)
//     …0001  provider unavailable (tried again later)
//     …0002  recipient opted out at the provider
//   Anything else is accepted.
// - `sent` keeps what would have gone out; `failNext()` forces the next
//   result.
import { randomUUID } from 'node:crypto';
import { SYSTEM_TEMPLATES } from '../../shared/communication-templates.mjs';
import { variablesIn } from '../../shared/communications.mjs';
import { ERRORS, parseStandardWebhook, validateRecipient } from './provider.mjs';

export function fakeApprovedTemplates() {
  return SYSTEM_TEMPLATES.flatMap(t => Object.entries(t.bodies).map(([language, b]) => ({
    name: t.whatsapp.name, language, category: t.whatsapp.category, status: 'approved',
    variables: variablesIn(b.body),
  })));
}

export function createFakeWhatsAppProvider({ templates = fakeApprovedTemplates() } = {}) {
  const sent = [];
  const statuses = new Map();
  let forced = null;

  function outcomeFor(to) {
    if (forced) { const r = forced; forced = null; return r; }
    if (to.endsWith('0000')) return { ok: false, error: ERRORS.invalidRecipient, retryable: false };
    if (to.endsWith('0001')) return { ok: false, error: ERRORS.unavailable, retryable: true };
    if (to.endsWith('0002')) return { ok: false, error: ERRORS.optedOut, retryable: false };
    return null;
  }

  function accept(entry) {
    const providerMessageId = `fake_${randomUUID()}`;
    sent.push({ ...entry, providerMessageId });
    statuses.set(providerMessageId, 'sent');
    return { ok: true, providerMessageId };
  }

  return {
    name: 'fake',
    configured: true,
    sent,
    templates,
    failNext(result) { forced = { ok: false, retryable: false, ...result }; },
    validateRecipient,
    async sendTemplate({ to, templateName, language, parameters = [], category, reference = null }) {
      const check = validateRecipient(to);
      if (!check.ok) return { ok: false, error: ERRORS.invalidRecipient, retryable: false };
      const early = outcomeFor(check.to);
      if (early) return early;
      const tpl = templates.find(t => t.name === templateName && t.language === language);
      if (!tpl || tpl.status !== 'approved') return { ok: false, error: ERRORS.templateNotApproved, retryable: false };
      if (tpl.variables && parameters.length !== tpl.variables.length) {
        return { ok: false, error: 'bad_parameters', retryable: false, detail: `expected ${tpl.variables.length}` };
      }
      return accept({ kind: 'template', to: check.to, templateName, language, parameters, category, reference });
    },
    async sendMessage({ to, text, reference = null }) {
      const check = validateRecipient(to);
      if (!check.ok) return { ok: false, error: ERRORS.invalidRecipient, retryable: false };
      const early = outcomeFor(check.to);
      if (early) return early;
      return accept({ kind: 'text', to: check.to, text, reference });
    },
    async getDeliveryStatus(providerMessageId) {
      return statuses.has(providerMessageId) ? { status: 'delivered' } : { error: 'not_found' };
    },
    async listTemplates() {
      return { templates: templates.map(t => ({ ...t })) };
    },
    parseWebhook: parseStandardWebhook,
  };
}
