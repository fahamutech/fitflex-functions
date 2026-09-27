// FitFlex system message templates — ready-made messages owners (and
// FitFlex admins) can send as they are, or copy and adapt. Defined here in
// code so they're reviewed and versioned like the rest of the app; the
// template service syncs them into CommunicationTemplate (gymId null) so
// campaigns can refer to them.
//
// Every template has an English and a Swahili version. Variables are the
// campaign variables (see TEMPLATE_VARIABLES): member values are filled in
// per member; {{offer_name}}, {{discount}} and {{amount}} are typed in once
// by the sender.
//
// `whatsapp` names the provider template each one is meant to map to. It
// can be sent on WhatsApp only once that template is registered and
// approved in WhatsAppTemplate (M7) — a FitFlex template alone never is.

export const TEMPLATE_GROUPS = ['membership', 'payment', 'marketing', 'engagement', 'general'];

const t = (key, group, purpose, deepLink, en, sw) => ({
  key, group, purpose, deepLink,
  bodies: {
    en: { title: en[0], body: en[1], ...(en[2] ? { ctaLabel: en[2] } : {}) },
    sw: { title: sw[0], body: sw[1], ...(sw[2] ? { ctaLabel: sw[2] } : {}) },
  },
  whatsapp: { name: `fitflex_${key}`, category: purpose === 'promotion' || purpose === 'engagement' || purpose === 'general' ? 'marketing' : 'utility' },
});

export const SYSTEM_TEMPLATES = Object.freeze([
  // ── Membership ─────────────────────────────────────────────────────────
  t('welcome_member', 'membership', 'announcement', 'membership',
    ['Welcome to {{gym_name}}!', 'Hi {{member_name}}, welcome to {{gym_name}}. Your {{plan_name}} plan is ready — show your QR code at the front desk to check in. We\'re glad you\'re here!', 'View membership'],
    ['Karibu {{gym_name}}!', 'Habari {{member_name}}, karibu {{gym_name}}. Mpango wako wa {{plan_name}} uko tayari — onyesha msimbo wako wa QR mapokezi ili kuingia. Tunafurahi kuwa nawe!', 'Angalia uanachama']),
  t('membership_activated', 'membership', 'announcement', 'membership',
    ['Your membership is active', 'Hi {{member_name}}, your {{plan_name}} plan at {{gym_name}} is now active until {{expiry_date}}. See you at the gym!', 'View membership'],
    ['Uanachama wako uko hai', 'Habari {{member_name}}, mpango wako wa {{plan_name}} katika {{gym_name}} sasa uko hai hadi {{expiry_date}}. Tuonane jimu!', 'Angalia uanachama']),
  t('membership_expiring', 'membership', 'renewal', 'renewal',
    ['Your plan ends soon', 'Hi {{member_name}}, your {{plan_name}} plan at {{gym_name}} ends on {{expiry_date}}. Renew now so your training doesn\'t stop.', 'Renew now'],
    ['Mpango wako unakaribia kuisha', 'Habari {{member_name}}, mpango wako wa {{plan_name}} katika {{gym_name}} unaisha tarehe {{expiry_date}}. Huisha sasa ili mazoezi yako yasikatike.', 'Huisha sasa']),
  t('membership_final_reminder', 'membership', 'renewal', 'renewal',
    ['Your plan ends tomorrow', 'Hi {{member_name}}, your {{plan_name}} plan at {{gym_name}} ends tomorrow, {{expiry_date}}. Renew today so your training doesn\'t stop.', 'Renew now'],
    ['Mpango wako unaisha kesho', 'Habari {{member_name}}, mpango wako wa {{plan_name}} katika {{gym_name}} unaisha kesho, tarehe {{expiry_date}}. Huisha leo ili mazoezi yako yasikatike.', 'Huisha sasa']),
  t('membership_expired', 'membership', 'renewal', 'renewal',
    ['Your membership has ended', 'Hi {{member_name}}, your {{plan_name}} plan at {{gym_name}} ended on {{expiry_date}}. We\'d love to have you back — renew any time.', 'Renew membership'],
    ['Uanachama wako umeisha', 'Habari {{member_name}}, mpango wako wa {{plan_name}} katika {{gym_name}} uliisha tarehe {{expiry_date}}. Tungependa urudi — unaweza kuhuisha wakati wowote.', 'Huisha uanachama']),
  t('renewal_reminder', 'membership', 'renewal', 'renewal',
    ['Time to renew', 'Hi {{member_name}}, a reminder from {{gym_name}}: your membership ends on {{expiry_date}}. Renew at the front desk or in the app.', 'Renew now'],
    ['Wakati wa kuhuisha', 'Habari {{member_name}}, kikumbusho kutoka {{gym_name}}: uanachama wako unaisha tarehe {{expiry_date}}. Huisha mapokezi au kwenye programu.', 'Huisha sasa']),

  // ── Payment ────────────────────────────────────────────────────────────
  t('payment_successful', 'payment', 'payment', 'membership',
    ['Payment received', 'Hi {{member_name}}, we\'ve received your payment of {{amount}} for your {{plan_name}} plan at {{gym_name}}. Thank you!', 'View membership'],
    ['Malipo yamepokelewa', 'Habari {{member_name}}, tumepokea malipo yako ya {{amount}} kwa mpango wako wa {{plan_name}} katika {{gym_name}}. Asante!', 'Angalia uanachama']),
  t('payment_failed', 'payment', 'payment', 'payment',
    ['Payment didn\'t go through', 'Hi {{member_name}}, your payment of {{amount}} to {{gym_name}} didn\'t go through. Please try again so your membership stays active.', 'Try again'],
    ['Malipo hayakufanikiwa', 'Habari {{member_name}}, malipo yako ya {{amount}} kwa {{gym_name}} hayakufanikiwa. Tafadhali jaribu tena ili uanachama wako uendelee.', 'Jaribu tena']),
  t('payment_pending', 'payment', 'payment', 'payment',
    ['We\'re checking your payment', 'Hi {{member_name}}, your payment of {{amount}} to {{gym_name}} is being confirmed. We\'ll let you know as soon as it\'s done.', 'View payments'],
    ['Tunathibitisha malipo yako', 'Habari {{member_name}}, malipo yako ya {{amount}} kwa {{gym_name}} yanathibitishwa. Tutakujulisha mara yatakapokamilika.', 'Angalia malipo']),
  t('payment_reminder', 'payment', 'payment', 'payment',
    ['Payment reminder', 'Hi {{member_name}}, a friendly reminder that {{amount}} is due for your {{plan_name}} plan at {{gym_name}} by {{expiry_date}}.', 'Pay now'],
    ['Kikumbusho cha malipo', 'Habari {{member_name}}, tunakukumbusha kuwa {{amount}} inadaiwa kwa mpango wako wa {{plan_name}} katika {{gym_name}} kabla ya {{expiry_date}}.', 'Lipa sasa']),

  // ── Marketing ──────────────────────────────────────────────────────────
  t('new_promotion', 'marketing', 'promotion', 'gym',
    ['{{offer_name}} at {{gym_name}}', 'Hi {{member_name}}, {{gym_name}} has a new offer: {{offer_name}}. Ask at the front desk or tap below to learn more.', 'See the offer'],
    ['{{offer_name}} katika {{gym_name}}', 'Habari {{member_name}}, {{gym_name}} ina ofa mpya: {{offer_name}}. Uliza mapokezi au gusa hapa chini kujua zaidi.', 'Angalia ofa']),
  t('discount_offer', 'marketing', 'promotion', 'gym',
    ['{{discount}} off: {{offer_name}}', 'Hi {{member_name}}, get {{discount}} off with {{offer_name}} at {{gym_name}}. Don\'t miss it!', 'Get the offer'],
    ['Punguzo la {{discount}}: {{offer_name}}', 'Habari {{member_name}}, pata punguzo la {{discount}} kupitia {{offer_name}} katika {{gym_name}}. Usikose!', 'Pata ofa']),
  t('new_class', 'marketing', 'general', 'gym',
    ['New class at {{gym_name}}', 'Hi {{member_name}}, we\'ve added a new class at {{gym_name}}. Check the gym page for days and times — come and try it!', 'See the gym'],
    ['Darasa jipya katika {{gym_name}}', 'Habari {{member_name}}, tumeongeza darasa jipya katika {{gym_name}}. Angalia ukurasa wa jimu kwa siku na saa — njoo ujaribu!', 'Angalia jimu']),
  t('new_trainer', 'marketing', 'general', 'gym',
    ['Meet our new trainer', 'Hi {{member_name}}, a new trainer has joined {{gym_name}}. Book a session and get extra help with your goals.', 'See the gym'],
    ['Kutana na mkufunzi wetu mpya', 'Habari {{member_name}}, mkufunzi mpya amejiunga na {{gym_name}}. Weka miadi ya kipindi upate msaada zaidi kufikia malengo yako.', 'Angalia jimu']),
  t('new_equipment', 'marketing', 'general', 'gym',
    ['New equipment at {{gym_name}}', 'Hi {{member_name}}, we\'ve added new equipment at {{gym_name}}. Come in and give it a try!', 'See the gym'],
    ['Vifaa vipya katika {{gym_name}}', 'Habari {{member_name}}, tumeongeza vifaa vipya katika {{gym_name}}. Karibu uvijaribu!', 'Angalia jimu']),

  // ── Engagement ─────────────────────────────────────────────────────────
  t('we_miss_you', 'engagement', 'engagement', 'gym',
    ['We miss you, {{member_name}}', 'It\'s been a while since your last visit to {{gym_name}}. Your {{plan_name}} plan is still active — we\'d love to see you back this week!', 'See the gym'],
    ['Tumekukumbuka, {{member_name}}', 'Muda umepita tangu ulipotembelea {{gym_name}} mara ya mwisho. Mpango wako wa {{plan_name}} bado uko hai — tungependa kukuona tena wiki hii!', 'Angalia jimu']),
  t('welcome_back', 'engagement', 'engagement', 'message',
    ['Welcome back, {{member_name}}!', 'Great to see you back at {{gym_name}}. Keep it going — every visit counts.'],
    ['Karibu tena, {{member_name}}!', 'Tunafurahi kukuona tena {{gym_name}}. Endelea hivyo — kila ziara ina maana.']),
  t('congratulations', 'engagement', 'engagement', 'message',
    ['Congratulations, {{member_name}}!', 'Everyone at {{gym_name}} is proud of your progress. Keep up the great work!'],
    ['Hongera, {{member_name}}!', 'Sote hapa {{gym_name}} tunajivunia maendeleo yako. Endelea na juhudi hizo!']),
  t('member_milestone', 'engagement', 'engagement', 'message',
    ['You\'ve reached a milestone!', 'Hi {{member_name}}, you\'ve hit a new milestone at {{gym_name}}. Thank you for training with us — here\'s to the next one!'],
    ['Umefikia hatua mpya!', 'Habari {{member_name}}, umefikia hatua mpya katika {{gym_name}}. Asante kwa kufanya mazoezi nasi — tuelekee hatua inayofuata!']),
]);

/** The stable id a system template is stored under. */
export const systemTemplateId = (key) => `tpl_sys_${key}`;

// The member a template preview is shown for, before any real member is chosen.
export const SAMPLE_MEMBER = Object.freeze({ displayName: 'Amina', plan: 'monthly' });

// Push notifications show a short title and about two lines of body.
export const PUSH_TITLE_MAX = 65;
export const PUSH_BODY_PREVIEW = 178;
