// FitFlex Terms and Conditions for members — the text a member agrees to when
// they set up their account. Same shape as the partner agreements
// (shared/partner-agreements.mjs) so one screen shows either.
//
// DRAFT: to be reviewed by Tanzanian counsel, like the partner agreements.
// Changing the wording means a new `version`; members are asked again.

const SECTIONS = {
  en: [
    { heading: 'Use of service', text: 'By creating an account you agree to use FitFlex in accordance with applicable laws and these Terms.' },
    { heading: 'Membership', text: 'Your gym membership pass is personal and non-transferable. Each check-in is verified via QR code.' },
    { heading: 'Payments', text: 'Payments are processed in accordance with the selected subscription plan. Refunds are subject to the gym owner policy.' },
    { heading: 'Privacy', text: 'We collect personal information to deliver gym access services. Your data will not be sold to third parties. See our Privacy Policy for full details.' },
    { heading: 'Account termination', text: 'FitFlex reserves the right to suspend accounts that violate these Terms.' },
    { heading: 'Changes', text: 'We may update these Terms from time to time. Continued use after changes constitutes acceptance.' },
    { heading: 'Questions', text: 'For questions contact: support@fitflexaf.co.tz' },
  ],
  sw: [
    { heading: 'Matumizi ya huduma', text: 'Kwa kuunda akaunti unakubali kutumia FitFlex kwa mujibu wa sheria husika na Masharti haya.' },
    { heading: 'Uanachama', text: 'Pasi yako ya uanachama wa gym ni ya kibinafsi na haiwezi kuhamishiwa mtu mwingine. Kila kuingia kunathibitishwa kwa msimbo wa QR.' },
    { heading: 'Malipo', text: 'Malipo yanafanywa kulingana na mpango wa usajili uliochaguliwa. Marejesho yanategemea sera ya mmiliki wa gym.' },
    { heading: 'Faragha', text: 'Tunakusanya taarifa binafsi ili kutoa huduma za ufikiaji wa gym. Taarifa zako hazitauzwa kwa watu wengine. Angalia Sera yetu ya Faragha kwa maelezo kamili.' },
    { heading: 'Kusimamishwa kwa akaunti', text: 'FitFlex ina haki ya kusimamisha akaunti zinazokiuka Masharti haya.' },
    { heading: 'Mabadiliko', text: 'Tunaweza kusasisha Masharti haya mara kwa mara. Kuendelea kutumia baada ya mabadiliko kunamaanisha umeyakubali.' },
    { heading: 'Maswali', text: 'Kwa maswali wasiliana: support@fitflexaf.co.tz' },
  ],
};

export const MEMBER_TERMS = Object.freeze({
  version: '2026-10-09',
  reference: 'FFA-MTC-001 (online) v1.0',
  title: { en: 'FitFlex Terms and Conditions', sw: 'Vigezo na Masharti ya FitFlex' },
  sections: lang => SECTIONS[lang === 'sw' ? 'sw' : 'en'],
});
