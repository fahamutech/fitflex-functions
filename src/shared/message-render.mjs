// One member's copy of a message — shared by campaigns and automations so
// both render exactly the same way.
import { contentFor, messageValues, renderText } from './communications.mjs';

/** The message in the member's language when it has it, with their values. */
export function renderMessage(content, member, { gymName = '', renewalLink = '', locale = null } = {}) {
  const text = contentFor(content, locale);
  const values = messageValues(content, member, { gymName, renewalLink: renewalLink || '', locale: text.locale });
  return {
    title: renderText(text.title, values),
    body: renderText(text.body, values),
    ctaLabel: text.ctaLabel,
    deepLink: content.deepLink || 'message',
    locale: text.locale,
    values,
  };
}

/**
 * A member's WhatsApp copy. WhatsApp only carries the provider-approved
 * wording, so this is the template's own text — in the member's language
 * when that version is approved, otherwise in one that is — not the
 * sender's edits. Its parameters are the member's values in the order the
 * provider template numbers them ({{1}}, {{2}}, …). Null when no version is
 * approved.
 */
export function whatsappMessage(content, member, { gymName = '', renewalLink = '', locale = null, mapping }) {
  const wa = mapping.get(locale) || [...mapping.values()][0];
  if (!wa) return null;
  const text = { ...content, title: wa.text.title, body: wa.text.body, ctaLabel: wa.text.ctaLabel, locale: wa.language, translations: undefined };
  const copy = renderMessage(text, member, { gymName, renewalLink, locale: wa.language });
  return {
    copy,
    payload: { templateName: wa.templateName, language: wa.language, parameters: wa.variables.map(v => String(copy.values[v] ?? '')) },
  };
}
