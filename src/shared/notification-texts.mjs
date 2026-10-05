// Texts of the notifications the server builds itself (inbox + push), in
// English and Tanzanian Swahili.
//
// Each entry has an `en` and an `sw` builder taking the same named
// parameters and returning { title, body }. A caller describes what happened
// with `notificationText(key, params)`; the notification service renders it
// in the recipient's language (their stored `locale`, English when unknown).
//
// What people typed themselves — names, an admin's note, a message preview,
// a challenge or goal title — is passed through as it is, in both languages.
// Fallback words ("your trainer", "A member"…) live here so they follow the
// language too: pass null and the builder picks the word.
//
// Swahili follows docs/localization/fitflex-terminology-glossary.md: gym,
// trainer (ma-trainer), challenge and benefits stay English; session is
// kipindi, time slot muda, pass pasi, renew "lipia tena", approval idhini,
// verification uthibitisho, refund marejesho, reward zawadi.
//
// Dates and times inside bodies are numeric (2026-10-05, 09:00) in both
// languages, so no English month or weekday name reaches a Swahili reader.
import { LOCALES } from './communications.mjs';

export const DEFAULT_LOCALE = 'en';

/** 'sw' stays 'sw'; anything else (null, unknown) is English. */
export const notificationLocale = locale => (LOCALES.includes(locale) ? locale : DEFAULT_LOCALE);

const cap = s => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);

/** Booked slots, e.g. "2026-10-05 09:00, 2026-10-06 09:00". Numeric in both languages. */
export const formatSlots = (bookings = []) => bookings.map(b => `${b.date} ${b.slot}`).join(', ');

// Words used when a name is missing.
const WORDS = {
  en: {
    aMember: 'A member', someone: 'Someone', yourTrainer: 'your trainer', YourTrainer: 'Your trainer',
    TheTrainer: 'The trainer', aGym: 'A gym', aShop: 'A shop', yourChallenge: 'your challenge',
  },
  sw: {
    aMember: 'Mwanachama', someone: 'Mtu', yourTrainer: 'trainer wako', YourTrainer: 'Trainer wako',
    TheTrainer: 'Trainer huyu', aGym: 'Gym', aShop: 'Duka', yourChallenge: 'challenge yako',
  },
};

// The role someone is invited to. English prints the stored value as it is.
const ROLE_SW = { staff: 'mfanyakazi', trainer: 'trainer', member: 'mwanachama' };

// Trainer pass periods.
const PERIOD_EN = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };
const PERIOD_SW = { daily: 'siku', weekly: 'wiki', monthly: 'mwezi' };

// Partner verification documents, as named in an expiry reminder.
const DOCUMENT_EN = {
  owner_id: 'ID', trainer_id: 'ID', representative_id: 'representative ID',
  business_registration: 'business registration certificate', tin_certificate: 'TIN certificate',
  business_licence: 'business licence', certification: 'certification', liability_insurance: 'liability cover',
  representative_authority: 'proof of authority',
};
const DOCUMENT_SW = {
  owner_id: 'kitambulisho', trainer_id: 'kitambulisho', representative_id: 'kitambulisho cha mwakilishi',
  business_registration: 'cheti cha usajili wa biashara', tin_certificate: 'cheti cha TIN',
  business_licence: 'leseni ya biashara', certification: 'cheti cha taaluma', liability_insurance: 'bima ya dhima',
  representative_authority: 'uthibitisho wa mamlaka ya mwakilishi',
};
/** English name of a verification document (also used in the case history). */
export const documentName = key => DOCUMENT_EN[key] || 'document';

const en = WORDS.en;
const sw = WORDS.sw;
// Swahili counts sessions after the noun and agrees with one or many.
const vipindi = n => (Number(n) === 1 ? 'kipindi 1' : `vipindi ${n}`);
const Vipindi = n => cap(vipindi(n));
const one = n => Number(n) === 1;

export const NOTIFICATION_TEXTS = Object.freeze({
  // ── Trainer bookings ─────────────────────────────────────────────────────
  trainer_booking_requested: {
    en: ({ memberName, count, slots }) => ({
      title: 'New booking request',
      body: `${memberName || en.aMember} booked ${count} session(s): ${slots}. Awaiting payment confirmation.`,
    }),
    sw: ({ memberName, count, slots }) => ({
      title: 'Ombi jipya la kipindi',
      body: `${memberName || sw.aMember} ameweka ${vipindi(count)}: ${slots}. ${one(count) ? 'Kinasubiri' : 'Vinasubiri'} uthibitisho wa malipo.`,
    }),
  },
  trainer_booking_confirmed_trainer: {
    en: ({ memberName, count, slots }) => ({
      title: 'Booking paid and confirmed',
      body: `${memberName || en.aMember}'s ${count} session(s) are confirmed: ${slots}.`,
    }),
    sw: ({ memberName, count, slots }) => ({
      title: 'Kipindi kimelipiwa na kuthibitishwa',
      body: `${Vipindi(count)} ${one(count) ? 'cha' : 'vya'} ${memberName || sw.aMember} ${one(count) ? 'kimethibitishwa' : 'vimethibitishwa'}: ${slots}.`,
    }),
  },
  trainer_booking_confirmed_member: {
    en: ({ trainerName, count, slots }) => ({
      title: 'Trainer session confirmed',
      body: `Your ${count} session(s) with ${trainerName || en.yourTrainer} are confirmed: ${slots}.`,
    }),
    sw: ({ trainerName, count, slots }) => ({
      title: 'Kipindi na trainer kimethibitishwa',
      body: one(count)
        ? `Kipindi chako 1 na ${trainerName || sw.yourTrainer} kimethibitishwa: ${slots}.`
        : `Vipindi vyako ${count} na ${trainerName || sw.yourTrainer} vimethibitishwa: ${slots}.`,
    }),
  },
  trainer_booking_cancelled_by_member: {
    en: ({ memberName, slots }) => ({
      title: 'Session cancelled',
      body: `${memberName || en.aMember} cancelled: ${slots}. The slot is free again.`,
    }),
    sw: ({ memberName, slots }) => ({
      title: 'Kipindi kimeghairiwa',
      body: `${memberName || sw.aMember} ameghairi: ${slots}. Muda huo uko wazi tena.`,
    }),
  },
  trainer_booking_cancelled_by_trainer: {
    en: ({ trainerName, slots }) => ({
      title: 'Trainer session cancelled',
      body: `${trainerName || en.YourTrainer} cancelled your session: ${slots}. Anything you paid for it will be refunded.`,
    }),
    sw: ({ trainerName, slots }) => ({
      title: 'Kipindi na trainer kimeghairiwa',
      body: `${trainerName || sw.YourTrainer} ameghairi kipindi chako: ${slots}. Kiasi ulicholipa kitarejeshwa.`,
    }),
  },

  // ── Passes ───────────────────────────────────────────────────────────────
  subscription_renewal: {
    en: ({ tier, daysLeft }) => ({
      title: `Your ${tier ? cap(tier) : 'membership'} pass ends ${daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`}`,
      body: 'To keep training, renew it from the Passes screen. You can also choose a different tier.',
    }),
    sw: ({ tier, daysLeft }) => ({
      title: `Pasi yako${tier ? ` ya ${cap(tier)}` : ''} inaisha ${daysLeft === 0 ? 'leo' : daysLeft === 1 ? 'kesho' : `baada ya siku ${daysLeft}`}`,
      body: 'Ili uendelee na mazoezi, lipia tena kwenye ukurasa wa Pasi. Unaweza pia kuchagua daraja lingine.',
    }),
  },
  trainer_pass_activated: {
    en: ({ plan }) => ({
      title: 'Trainer pass active',
      body: `Your ${PERIOD_EN[plan] ? `${PERIOD_EN[plan]} ` : ''}trainer pass is active. Show your check-in QR at reception to train your clients.`,
    }),
    sw: ({ plan }) => ({
      title: 'Pasi ya trainer inatumika',
      body: `Pasi yako ya trainer${PERIOD_SW[plan] ? ` ya ${PERIOD_SW[plan]}` : ''} inatumika. Onyesha QR yako ya kuingia mapokezi ili uwafundishe wateja wako.`,
    }),
  },
  subscription_activated: {
    en: ({ tier }) => ({
      title: 'Payment confirmed',
      body: `Your ${tier ? `${cap(tier)} pass` : 'gym membership'} is active. Show your QR code at the gym to check in.`,
    }),
    sw: ({ tier }) => ({
      title: 'Malipo yamethibitishwa',
      body: `${tier ? `Pasi yako ya ${cap(tier)} inatumika` : 'Uanachama wako wa gym uko hai'}. Onyesha msimbo wako wa QR gym ili kuingia.`,
    }),
  },

  // ── Partner verification (KYC). `note` is the reviewer's own words. ──────
  kyc_submitted: {
    en: () => ({ title: 'Verification details received', body: 'Thank you. FitFlex will review your details and let you know the outcome.' }),
    sw: () => ({ title: 'Taarifa za uthibitisho zimepokelewa', body: 'Asante. FitFlex itakagua taarifa zako na kukujulisha matokeo.' }),
  },
  kyc_info_requested: {
    en: ({ note }) => ({ title: 'More information needed', body: note || 'FitFlex needs more information to finish verifying you. Open your verification to see what to update.' }),
    sw: ({ note }) => ({ title: 'Taarifa zaidi zinahitajika', body: note || 'FitFlex inahitaji taarifa zaidi ili kukamilisha uthibitisho wako. Fungua uthibitisho wako uone cha kurekebisha.' }),
  },
  kyc_approved: {
    en: () => ({ title: 'You are verified', body: 'Your FitFlex partner verification is approved.' }),
    sw: () => ({ title: 'Umethibitishwa', body: 'Uthibitisho wako wa mshirika wa FitFlex umeidhinishwa.' }),
  },
  kyc_rejected: {
    en: ({ note }) => ({ title: 'Verification not approved', body: note || 'Your FitFlex partner verification was not approved.' }),
    sw: ({ note }) => ({ title: 'Uthibitisho haujaidhinishwa', body: note || 'Uthibitisho wako wa mshirika wa FitFlex haujaidhinishwa.' }),
  },
  kyc_suspended: {
    en: ({ note }) => ({ title: 'Verification suspended', body: note || 'Your FitFlex partner verification has been suspended.' }),
    sw: ({ note }) => ({ title: 'Uthibitisho umesimamishwa', body: note || 'Uthibitisho wako wa mshirika wa FitFlex umesimamishwa.' }),
  },
  kyc_reinstated: {
    en: () => ({ title: 'Verification restored', body: 'Your FitFlex partner verification is active again.' }),
    sw: () => ({ title: 'Uthibitisho umerejeshwa', body: 'Uthibitisho wako wa mshirika wa FitFlex unatumika tena.' }),
  },
  kyc_reopened: {
    en: () => ({ title: 'Verification reopened', body: 'You can update your details and submit them again.' }),
    sw: () => ({ title: 'Uthibitisho umefunguliwa tena', body: 'Unaweza kurekebisha taarifa zako na kuzituma tena.' }),
  },
  kyc_document_expiring: {
    en: ({ requirementKey, daysLeft, expiresOn }) => {
      const name = documentName(requirementKey);
      return daysLeft > 0
        ? { title: `Your ${name} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`, body: `Your ${name} expires on ${expiresOn}. Upload the renewed one in Verification.` }
        : { title: `Your ${name} has expired`, body: `Your ${name} expired on ${expiresOn}. Upload the renewed one in Verification.` };
    },
    // Worded around "muda" so the sentence agrees whatever the document is.
    sw: ({ requirementKey, daysLeft, expiresOn }) => {
      const name = DOCUMENT_SW[requirementKey] || 'hati';
      return daysLeft > 0
        ? { title: `${cap(name)}: muda wake unaisha baada ya siku ${daysLeft}`, body: `Muda wa ${name} unaisha tarehe ${expiresOn}. Pakia hati mpya kwenye Uthibitisho.` }
        : { title: `${cap(name)}: muda wake umeisha`, body: `Muda wa ${name} uliisha tarehe ${expiresOn}. Pakia hati mpya kwenye Uthibitisho.` };
    },
  },

  // ── Social ───────────────────────────────────────────────────────────────
  social_friends: {
    en: ({ name }) => ({ title: 'You\'re friends', body: `${name ?? en.someone} followed you back.` }),
    sw: ({ name }) => ({ title: 'Sasa ni marafiki', body: `${name ?? sw.someone} amekufuata pia.` }),
  },
  social_follow: {
    en: ({ name }) => ({ title: 'New follower', body: `${name ?? en.someone} started following you.` }),
    sw: ({ name }) => ({ title: 'Mfuasi mpya', body: `${name ?? sw.someone} ameanza kukufuata.` }),
  },
  social_kudos: {
    en: ({ name }) => ({ title: 'Kudos', body: `${name ?? en.someone} gave you kudos.` }),
    sw: ({ name }) => ({ title: 'Pongezi', body: `${name ?? sw.someone} amekupongeza.` }),
  },
  social_comment: {
    en: ({ name, preview }) => ({ title: 'New comment', body: `${name ?? en.someone}: ${preview}` }),
    sw: ({ name, preview }) => ({ title: 'Maoni mapya', body: `${name ?? sw.someone}: ${preview}` }),
  },

  // ── Invitations ──────────────────────────────────────────────────────────
  org_invitation: {
    en: ({ orgName, orgType, role }) => ({
      title: 'You have an invitation',
      body: `${orgName || (orgType === 'vendor' ? en.aShop : en.aGym)} invited you to join as ${role}.`,
    }),
    sw: ({ orgName, orgType, role }) => ({
      title: 'Una mwaliko',
      body: `${orgName || (orgType === 'vendor' ? sw.aShop : sw.aGym)} imekualika kujiunga kama ${ROLE_SW[role] || role}.`,
    }),
  },

  // ── Trainer enquiries. `preview` is the person's own message. ────────────
  trainer_enquiry: {
    en: ({ memberName, preview }) => ({ title: `New enquiry from ${memberName || en.aMember}`, body: preview }),
    sw: ({ memberName, preview }) => ({ title: `Ulizo jipya kutoka kwa ${memberName || sw.aMember}`, body: preview }),
  },
  trainer_interest: {
    en: ({ memberName }) => ({ title: `${memberName || en.aMember} is interested in training with you`, body: 'Say hello and tell them how you work.' }),
    sw: ({ memberName }) => ({ title: `${memberName || sw.aMember} angependa kufanya mazoezi nawe`, body: 'Msalimie na umweleze unavyofanya kazi.' }),
  },
  trainer_enquiry_reply: {
    en: ({ trainerName, preview }) => ({ title: `${trainerName || en.YourTrainer} replied`, body: preview }),
    sw: ({ trainerName, preview }) => ({ title: `${trainerName || sw.YourTrainer} amejibu`, body: preview }),
  },
  trainer_enquiry_member_reply: {
    en: ({ memberName, preview }) => ({ title: `${memberName || en.aMember} replied`, body: preview }),
    sw: ({ memberName, preview }) => ({ title: `${memberName || sw.aMember} amejibu`, body: preview }),
  },

  // ── Trainer and client ───────────────────────────────────────────────────
  trainer_client_request: {
    en: ({ memberName }) => ({ title: 'New client request', body: `${memberName || en.aMember} would like to train with you.` }),
    sw: ({ memberName }) => ({ title: 'Ombi jipya la mteja', body: `${memberName || sw.aMember} angependa kufanya mazoezi nawe.` }),
  },
  trainer_connected: {
    en: ({ trainerName }) => ({ title: 'Trainer connected', body: `${trainerName || en.YourTrainer} accepted your request.` }),
    sw: ({ trainerName }) => ({ title: 'Umeunganishwa na trainer', body: `${trainerName || sw.YourTrainer} amekubali ombi lako.` }),
  },
  trainer_declined: {
    en: ({ trainerName }) => ({ title: 'Trainer request', body: `${trainerName || en.TheTrainer} isn't taking new clients right now.` }),
    sw: ({ trainerName }) => ({ title: 'Ombi kwa trainer', body: `${trainerName || sw.TheTrainer} hapokei wateja wapya kwa sasa.` }),
  },
  trainer_goal_assigned: {
    en: ({ trainerName, goalTitle }) => ({ title: 'New goal from your trainer', body: `${trainerName || en.YourTrainer} set you a goal${goalTitle ? `: ${goalTitle}` : ''}.` }),
    sw: ({ trainerName, goalTitle }) => ({ title: 'Lengo jipya kutoka kwa trainer wako', body: `${trainerName || sw.YourTrainer} amekuwekea lengo${goalTitle ? `: ${goalTitle}` : ''}.` }),
  },
  trainer_workout_assigned: {
    en: ({ trainerName, workoutName, days }) => ({
      title: 'New workout from your trainer',
      body: `${trainerName || en.YourTrainer} planned "${workoutName}" for you${days > 1 ? ` on ${days} days` : ''}.`,
    }),
    sw: ({ trainerName, workoutName, days }) => ({
      title: 'Mazoezi mapya kutoka kwa trainer wako',
      body: `${trainerName || sw.YourTrainer} amekupangia "${workoutName}"${days > 1 ? ` kwa siku ${days}` : ''}.`,
    }),
  },

  // ── Challenge rewards. `label`, `challengeName` and `note` pass through. ─
  challenge_reward_earned: {
    en: ({ challengeName, label }) => ({ title: 'Reward earned', body: `${challengeName}: ${label}. Pending fulfilment.` }),
    sw: ({ challengeName, label }) => ({ title: 'Umepata zawadi', body: `${challengeName}: ${label}. Inasubiri kutolewa.` }),
  },
  challenge_reward_issued: {
    en: ({ label, challengeName, reference }) => ({
      title: 'Reward on its way',
      body: `${label} from ${challengeName ?? en.yourChallenge} has been handed out.${reference ? ` Reference: ${reference}` : ''}`,
    }),
    sw: ({ label, challengeName, reference }) => ({
      title: 'Zawadi yako inakuja',
      body: `${label} kutoka ${challengeName ?? sw.yourChallenge} imetolewa.${reference ? ` Kumbukumbu: ${reference}` : ''}`,
    }),
  },
  challenge_reward_rejected: {
    en: ({ label, challengeName, note }) => ({ title: 'Reward not approved', body: `${label} from ${challengeName ?? en.yourChallenge}: ${note}` }),
    sw: ({ label, challengeName, note }) => ({ title: 'Zawadi haijaidhinishwa', body: `${label} kutoka ${challengeName ?? sw.yourChallenge}: ${note}` }),
  },

  // ── Refunds. `amount` arrives formatted ("TZS 10,000"). ──────────────────
  refund_on_its_way: {
    en: ({ amount }) => ({ title: 'Refund on its way', body: `Your refund of ${amount} is approved. FitFlex will send it to the account you paid from.` }),
    sw: ({ amount }) => ({ title: 'Marejesho yako yanakuja', body: `Marejesho yako ya ${amount} yameidhinishwa. FitFlex itayatuma kwenye akaunti uliyolipia.` }),
  },
  refund_requested: {
    en: ({ amount }) => ({ title: 'Refund request received', body: `We have your request for ${amount} and will reply soon.` }),
    sw: ({ amount }) => ({ title: 'Ombi la marejesho limepokelewa', body: `Tumepokea ombi lako la ${amount} na tutakujibu hivi karibuni.` }),
  },
  refund_approved: {
    en: ({ amount }) => ({ title: 'Refund approved', body: `Your refund of ${amount} is approved. FitFlex will send it to the account you paid from.` }),
    sw: ({ amount }) => ({ title: 'Marejesho yameidhinishwa', body: `Marejesho yako ya ${amount} yameidhinishwa. FitFlex itayatuma kwenye akaunti uliyolipia.` }),
  },
  refund_rejected: {
    en: ({ note }) => ({ title: 'Refund not approved', body: note }),
    sw: ({ note }) => ({ title: 'Marejesho hayajaidhinishwa', body: note }),
  },
  refund_withdrawn: {
    en: ({ note }) => ({ title: 'Refund withdrawn', body: note }),
    sw: ({ note }) => ({ title: 'Marejesho yameondolewa', body: note }),
  },
  refund_paid: {
    en: ({ amount, reference }) => ({ title: 'Refund sent', body: `We sent ${amount} back to you. Reference: ${reference}.` }),
    sw: ({ amount, reference }) => ({ title: 'Marejesho yametumwa', body: `Tumekurejeshea ${amount}. Kumbukumbu: ${reference}.` }),
  },

  // ── Trainer payouts ──────────────────────────────────────────────────────
  trainer_payout_paid: {
    en: ({ amount, sessionCount, from, to, reference }) => ({
      title: 'Payout sent',
      body: `FitFlex sent you ${amount} for ${sessionCount} session(s), ${from} to ${to}. Reference: ${reference}.`,
    }),
    sw: ({ amount, sessionCount, from, to, reference }) => ({
      title: 'Malipo yako yametumwa',
      body: `FitFlex imekutumia ${amount} kwa ${vipindi(sessionCount)}, ${from} hadi ${to}. Kumbukumbu: ${reference}.`,
    }),
  },

  // ── Sponsors (B2B) ───────────────────────────────────────────────────────
  b2b_sponsor_visibility: {
    en: ({ name }) => ({
      title: `What ${name} can see`,
      body: `${name} gives you benefits through FitFlex and can see your FitFlex activity: gym visits, workouts, steps and challenge progress. It cannot see your weight, height or anything from another sponsor. See Benefits for details.`,
    }),
    sw: ({ name }) => ({
      title: `Kile ${name} inaweza kuona`,
      body: `${name} inakupa benefits kupitia FitFlex na inaweza kuona shughuli zako za FitFlex: ziara za gym, mazoezi, hatua na maendeleo ya challenge. Haiwezi kuona uzito wako, urefu wako wala chochote kutoka kwa mdhamini mwingine. Angalia Benefits kwa maelezo zaidi.`,
    }),
  },
  b2b_payment_confirmed: {
    en: ({ amount, reference, receiptNumber }) => ({ title: 'Payment received', body: `FitFlex has confirmed your payment of ${amount} (${reference}). Receipt ${receiptNumber}.` }),
    sw: ({ amount, reference, receiptNumber }) => ({ title: 'Malipo yamepokelewa', body: `FitFlex imethibitisha malipo yako ya ${amount} (${reference}). Risiti ${receiptNumber}.` }),
  },
  b2b_payment_not_found: {
    en: ({ amount, reference, reason }) => ({ title: 'Payment not confirmed', body: `FitFlex could not confirm your payment of ${amount} (${reference}): ${reason}` }),
    sw: ({ amount, reference, reason }) => ({ title: 'Malipo hayajathibitishwa', body: `FitFlex haikuweza kuthibitisha malipo yako ya ${amount} (${reference}): ${reason}` }),
  },
  // `daysLate` is 0 on the due day; `soon` is the reminder three days before.
  b2b_invoice_reminder: {
    en: ({ soon, invoiceNumber, amount, dueDate, daysLate }) => {
      const what = `Invoice ${invoiceNumber} (${amount})`;
      if (soon) return { title: 'Invoice due soon', body: `${what} is due on ${dueDate}.` };
      if (daysLate === 0) return { title: 'Invoice due today', body: `${what} is due today.` };
      return { title: 'Invoice overdue', body: `${what} was due on ${dueDate} and is ${daysLate} day${daysLate === 1 ? '' : 's'} overdue.` };
    },
    sw: ({ soon, invoiceNumber, amount, dueDate, daysLate }) => {
      const what = `Ankara ${invoiceNumber} (${amount})`;
      if (soon) return { title: 'Ankara inakaribia kulipwa', body: `${what} inapaswa kulipwa tarehe ${dueDate}.` };
      if (daysLate === 0) return { title: 'Ankara inapaswa kulipwa leo', body: `${what} inapaswa kulipwa leo.` };
      return { title: 'Ankara imechelewa kulipwa', body: `${what} ilipaswa kulipwa tarehe ${dueDate} na imechelewa kwa siku ${daysLate}.` };
    },
  },
});

/**
 * One notification's { title, body } in `locale` (English when the locale is
 * unknown). Returns null for a key that is not defined.
 */
export function renderNotificationText(key, params = {}, locale = DEFAULT_LOCALE) {
  const entry = NOTIFICATION_TEXTS[key];
  if (!entry) return null;
  const { title, body } = entry[notificationLocale(locale)](params || {});
  return { title, body };
}

/**
 * What a caller hands to notify(): the text key and its parameters, plus the
 * English title and body. The notification service renders the key in the
 * recipient's language; the English text is what goes out if it cannot.
 * Spread it into the message: `notify(userId, { type, data, ...notificationText(key, params) })`.
 */
export function notificationText(key, params = {}) {
  const english = renderNotificationText(key, params, DEFAULT_LOCALE);
  if (!english) throw new Error(`unknown notification text: ${key}`);
  return { text: { key, params }, title: english.title, body: english.body };
}
