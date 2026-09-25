// A member's choices about messages from gyms and FitFlex.
// Service messages (renewals, payments, announcements) in the app and by
// push can't be switched off; offers can. WhatsApp offers are opt-in, and
// turning them on records when and where the member agreed.
import { effectivePreferences, LOCALES } from '../shared/communications.mjs';

const SWITCHES = ['inAppMarketing', 'pushMarketing', 'whatsappTransactional', 'whatsappMarketing'];

export function createCommunicationPreferenceService({ preferences, now = () => new Date(), whatsappAvailable = () => false }) {
  function view(row) {
    const p = effectivePreferences(row);
    return {
      inAppMarketing: p.inAppMarketing,
      pushMarketing: p.pushMarketing,
      whatsappTransactional: p.whatsappTransactional,
      whatsappMarketing: p.whatsappMarketing,
      whatsappOptedOut: Boolean(p.whatsappOptedOutAt),
      locale: p.locale,
      // What can never be switched off, so the app can say so.
      alwaysOn: ['in_app_transactional', 'push_transactional'],
      whatsappAvailable: Boolean(whatsappAvailable()),
    };
  }

  async function get(userId) {
    return { preferences: view(await preferences.findByIdAsync(userId)) };
  }

  async function update(userId, body = {}) {
    const patch = {};
    for (const key of SWITCHES) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') return { error: 'invalid_preference', status: 400, detail: key };
      patch[key] = body[key];
    }
    if (body.locale !== undefined) {
      if (body.locale !== null && !LOCALES.includes(body.locale)) return { error: 'invalid_locale', status: 400 };
      patch.locale = body.locale;
    }
    const current = await preferences.findByIdAsync(userId);
    const at = now().toISOString();
    if (patch.whatsappMarketing === true && !effectivePreferences(current).whatsappMarketing) {
      patch.whatsappMarketingConsentAt = at;
      patch.whatsappMarketingConsentSource = body.consentSource === 'portal' ? 'portal' : 'app_settings';
    }
    // Choosing to hear from WhatsApp again lifts an earlier STOP.
    if ((patch.whatsappMarketing === true || patch.whatsappTransactional === true) && current?.whatsappOptedOutAt) {
      patch.whatsappOptedOutAt = null;
    }
    if (!Object.keys(patch).length) return { preferences: view(current) };
    const row = current
      ? await preferences.updateByIdAsync(userId, patch)
      : await preferences.insertAsync({ id: userId, ...patch, createdAt: at });
    return { preferences: view(current ? row : await preferences.findByIdAsync(userId)) };
  }

  return { get, update };
}
