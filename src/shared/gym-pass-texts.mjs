// Custom gym passes — the wording sent to the people a pass covers and to its buyer (GYM_CUSTOM_PASSES): in-app
// notices (title + body) and the SMS / WhatsApp text. They are kept here, not in NOTIFICATION_TEXTS, because that table
// is held to real Swahili by specs/notification-languages.specs.mjs and these Swahili texts are placeholders.
//
// SW: PLACEHOLDER, pending native-speaker review. Per the project rules no Swahili is invented here: the Swahili
// variant is the English wording behind the SW_PENDING marker, so it is obvious in a log or a handset what still
// needs a translator. Replace the `sw` builders (and nothing else) once the reviewed text arrives.
import { SW_PENDING } from './notification-texts.mjs';

const en = {
  added: ({ buyerName, planName, gymName, until }) =>
    `FitFlex: ${buyerName} added you to "${planName}" at ${gymName}. Valid until ${until}. Show your FitFlex QR at the gym.`,
  invite: ({ buyerName, planName, gymName, link }) =>
    `FitFlex: ${buyerName} added you to "${planName}" at ${gymName}. Sign up on FitFlex with this number to start using it: ${link}`,
};

const sw = {
  added: (p) => `${SW_PENDING} ${en.added(p)}`,
  invite: (p) => `${SW_PENDING} ${en.invite(p)}`,
};

const notice = {
  added: {
    en: ({ buyerName, planName, gymName, until }) => ({
      title: 'You have a gym pass',
      body: `${buyerName || 'A member'} added you to "${planName}" at ${gymName}. It is valid until ${until}. Show your FitFlex QR at the gym.`,
    }),
  },
  active: {
    en: ({ planName, gymName, until }) => ({
      title: 'Your gym pass is active',
      body: `Your payment for "${planName}" at ${gymName} is confirmed. It is valid until ${until}.`,
    }),
  },
};
for (const key of Object.keys(notice)) {
  notice[key].sw = (p) => { const t = notice[key].en(p); return { title: `${SW_PENDING} ${t.title}`, body: `${SW_PENDING} ${t.body}` }; };
}

/** The in-app notice { title, body } for 'added' (a person the pass covers) or 'active' (the buyer). */
export const gymPassNotice = (kind, params, locale = 'en') => notice[kind][locale === 'sw' ? 'sw' : 'en'](params);

/** @param {'added'|'invite'} kind  @param {'en'|'sw'} locale */
export function gymPassMessage(kind, params, locale = 'en') {
  return (locale === 'sw' ? sw : en)[kind](params);
}

/** True while the Swahili wording is still a placeholder (for the i18n audit and the specs). */
export const GYM_PASS_SW_PENDING = true;
