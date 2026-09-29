// Partner agreements accepted in the app during KYC.
//
// Each partner (gym owner, trainer, vendor) accepts two texts before they can
// submit their verification:
//   partner_agreement  their partner terms (gym owners: adapted from the Gym
//                      Partner Agreement FFA-GPA-001 for online acceptance)
//   kyc_consent        consent to collect and verify their identity and
//                      business details (Personal Data Protection Act, 2022)
// Corporate partners sign a contract offline instead (corporate_contract).
//
// Texts are versioned: changing a text means a new version, and partners
// accept the new version the next time they open their verification.
// English prevails over the Swahili translation.
//
// DRAFT: to be reviewed by Tanzanian counsel before real partners sign up.

const COMPANY = {
  en: 'FitFlex Africa Limited, a company incorporated in the United Republic of Tanzania, with its principal place of business in Dar es Salaam ("FitFlex")',
  sw: 'FitFlex Africa Limited, kampuni iliyosajiliwa katika Jamhuri ya Muungano wa Tanzania, yenye ofisi kuu Dar es Salaam ("FitFlex")',
};
const CONTACT = 'fitflex.africa@gmail.com';

const LAW = {
  en: { heading: 'Governing law and disputes', text: 'These terms are governed by the laws of the United Republic of Tanzania. Any dispute that is not resolved by good-faith negotiation within thirty (30) days will be referred to binding arbitration in Dar es Salaam under the Arbitration Act. The English version of these terms prevails over any translation.' },
  sw: { heading: 'Sheria inayotumika na migogoro', text: 'Masharti haya yanaongozwa na sheria za Jamhuri ya Muungano wa Tanzania. Mgogoro wowote usiotatuliwa kwa mazungumzo ya nia njema ndani ya siku thelathini (30) utapelekwa kwenye usuluhishi wa lazima jijini Dar es Salaam chini ya Sheria ya Usuluhishi. Toleo la Kiingereza la masharti haya ndilo linalotumika pale linapotofautiana na tafsiri yoyote.' },
};

const CHANGES = {
  en: { heading: 'Changes and ending the relationship', text: 'FitFlex will give you at least thirty (30) days\' notice in the app of any material change to these terms or to how you are paid. Either party may end the relationship with thirty (30) days\' written notice. FitFlex may suspend or end it immediately for fraud, serious misrepresentation or a breach of the law. Amounts already earned for verified activity are still paid after the relationship ends.' },
  sw: { heading: 'Mabadiliko na kusitisha ushirikiano', text: 'FitFlex itakupa taarifa ya angalau siku thelathini (30) ndani ya programu kuhusu mabadiliko yoyote makubwa ya masharti haya au ya jinsi unavyolipwa. Upande wowote unaweza kusitisha ushirikiano kwa taarifa ya maandishi ya siku thelathini (30). FitFlex inaweza kusimamisha au kusitisha mara moja kwa sababu ya udanganyifu, uwasilishaji wa taarifa za uongo kwa kiasi kikubwa au kuvunja sheria. Kiasi ulichokwisha kukipata kwa shughuli zilizothibitishwa bado kitalipwa baada ya ushirikiano kuisha.' },
};

const PAYOUT_ACCOUNT = {
  en: { heading: 'Payout account', text: 'You are paid only to a payout account (bank or mobile money) in your name or your business\'s name that FitFlex has verified. When you add or change a payout account, payouts to it wait forty-eight (48) hours as a security measure. You must keep your payout details up to date.' },
  sw: { heading: 'Akaunti ya malipo', text: 'Unalipwa tu kupitia akaunti ya malipo (benki au pesa za simu) iliyo kwa jina lako au la biashara yako ambayo FitFlex imeithibitisha. Unapoongeza au kubadilisha akaunti ya malipo, malipo kwenda akaunti hiyo yanasubiri saa arobaini na nane (48) kwa sababu za usalama. Unapaswa kuhakikisha taarifa zako za malipo ni sahihi wakati wote.' },
};

const VERIFICATION = {
  en: { heading: 'Verification', text: 'You confirm that the information and documents you give FitFlex are true, complete and yours to share, and you will keep them up to date. You will upload renewed licences and certificates before they expire; FitFlex will remind you. FitFlex may ask for more information, and may hold payouts while your verification is incomplete.' },
  sw: { heading: 'Uthibitishaji', text: 'Unathibitisha kuwa taarifa na nyaraka unazoipa FitFlex ni za kweli, kamili na una haki ya kuzitoa, na utazisasisha zinapobadilika. Utapakia leseni na vyeti vilivyohuishwa kabla havijaisha muda; FitFlex itakukumbusha. FitFlex inaweza kuomba taarifa zaidi, na inaweza kuzuia malipo mpaka uthibitishaji wako ukamilike.' },
};

const DATA = {
  en: { heading: 'Data and confidentiality', text: 'FitFlex owns the aggregated platform data (such as visit patterns and check-in times). Neither party will share the other\'s confidential business information, including rates, payouts and member details, except as needed to run the platform or as the law requires. Both parties will comply with the Personal Data Protection Act, 2022. You may use member details you see in the app only to serve those members.' },
  sw: { heading: 'Taarifa na usiri', text: 'FitFlex inamiliki takwimu za jumla za jukwaa (kama mwenendo wa matembeleo na nyakati za kuingia). Hakuna upande utakaotoa taarifa za siri za biashara za upande mwingine, zikiwemo viwango, malipo na taarifa za wanachama, isipokuwa inapohitajika kuendesha jukwaa au sheria inapotaka. Pande zote zitazingatia Sheria ya Ulinzi wa Taarifa Binafsi, 2022. Unaweza kutumia taarifa za wanachama unazoziona kwenye programu kwa ajili ya kuwahudumia wanachama hao tu.' },
};

const LIABILITY = {
  en: { heading: 'Liability', text: 'FitFlex is a technology platform. It does not provide the services you offer and is not responsible for them. FitFlex\'s liability to you is limited to the amounts due and unpaid to you at the time of the claim, and neither party is liable for indirect or consequential loss. You indemnify FitFlex against claims arising from your negligence or misconduct, from injury or loss connected with your services, and from your breach of these terms. Nothing here limits liability that the law does not allow to be limited.' },
  sw: { heading: 'Dhima', text: 'FitFlex ni jukwaa la teknolojia. Haitoi huduma unazozitoa na haiwajibiki kwa huduma hizo. Dhima ya FitFlex kwako ni kiasi unachodai ambacho hakijalipwa wakati wa madai tu, na hakuna upande utakaowajibika kwa hasara isiyo ya moja kwa moja. Unaifidia FitFlex dhidi ya madai yatokanayo na uzembe au utovu wako wa nidhamu, majeraha au hasara zinazohusiana na huduma zako, na kuvunja kwako masharti haya. Hakuna kilichomo hapa kinachopunguza dhima ambayo sheria hairuhusu kupunguzwa.' },
};

const both = (lang, ...parts) => parts.map(p => p[lang]);

// ── Partner terms, per partner type ─────────────────────────────────────────

const GYM_OWNER_TERMS = {
  version: '2026-09-29',
  reference: 'FFA-GPA-001 (online) v1.0',
  title: { en: 'FitFlex Gym Partner Terms', sw: 'Masharti ya Ushirikiano wa Gym na FitFlex' },
  sections: lang => [
    lang === 'en'
      ? { heading: 'Parties', text: `These terms are between ${COMPANY.en} and you, the gym owner, for each gym you list on FitFlex ("Gym Partner"). They adapt the FitFlex Gym Partner Agreement (FFA-GPA-001) for acceptance in the app. If you have also signed that agreement on paper, the signed agreement prevails where the two differ.` }
      : { heading: 'Wahusika', text: `Masharti haya ni kati ya ${COMPANY.sw} na wewe, mmiliki wa gym, kwa kila gym unayoiweka kwenye FitFlex ("Mshirika wa Gym"). Yanatokana na Mkataba wa Ushirikiano wa Gym wa FitFlex (FFA-GPA-001) na yamerekebishwa ili yakubaliwe ndani ya programu. Kama umeshasaini mkataba huo kwa karatasi, mkataba uliosainiwa ndio unaotumika pale yanapotofautiana.` },
    lang === 'en'
      ? { heading: 'Access for members', text: 'Your gym\'s classification (Standard, Mid-Tier, Premium or Luxury/Executive) is shown in the app and confirmed by FitFlex after a site visit. You will admit every FitFlex member whose pass covers your classification, without any extra entry fee, surcharge or required purchase. You will keep the facility at the standard of its classification and comply with Tanzanian health, safety and business licensing requirements.' }
      : { heading: 'Kuwapokea wanachama', text: 'Daraja la gym yako (Standard, Mid-Tier, Premium au Luxury/Executive) linaonyeshwa kwenye programu na kuthibitishwa na FitFlex baada ya kutembelea gym. Utampokea kila mwanachama wa FitFlex ambaye kifurushi chake kinahusisha daraja lako, bila ada ya ziada ya kuingia, nyongeza au ununuzi wa lazima. Utaitunza gym katika kiwango cha daraja lake na kuzingatia masharti ya Tanzania ya afya, usalama na leseni za biashara.' },
    lang === 'en'
      ? { heading: 'Check-in', text: 'Every visit is recorded with a FitFlex QR check-in, either by scanning the member\'s code or by the member scanning your gym\'s code. You will keep at least one staff member able to check members in during opening hours, confirm the member matches the photo in the app, and turn away members whose pass is inactive or does not cover your gym. You will never check in someone who is not physically present. A visit is one member at one gym on one calendar day, however many times they scan. Report check-in problems to FitFlex within two (2) hours; a missed check-in can be logged within twenty-four (24) hours and is paid once FitFlex verifies it.' }
      : { heading: 'Kuingia (check-in)', text: 'Kila tembeleo linarekodiwa kwa check-in ya QR ya FitFlex, iwe kwa kuskani msimbo wa mwanachama au mwanachama kuskani msimbo wa gym yako. Utahakikisha kuna angalau mfanyakazi mmoja anayeweza kuwaingiza wanachama wakati wote gym iko wazi, kuthibitisha mwanachama anafanana na picha yake kwenye programu, na kuwakataa wanachama ambao kifurushi chao hakitumiki au hakihusishi gym yako. Hutamwingiza mtu ambaye hayupo kimwili. Tembeleo moja ni mwanachama mmoja katika gym moja kwa siku moja, hata akiskani mara ngapi. Ripoti matatizo ya check-in kwa FitFlex ndani ya saa mbili (2); check-in iliyokosekana inaweza kurekodiwa ndani ya saa ishirini na nne (24) na italipwa FitFlex ikishaithibitisha.' },
    lang === 'en'
      ? { heading: 'Payouts', text: 'FitFlex pays you for verified visits using your gym\'s daily, weekly and monthly rates as set in the app, applying the combination that is most cost-efficient for the visits in the period, less the platform commission shown in your payout statement. Rates are agreed at onboarding, reviewed every six (6) months and may be changed by either party on thirty (30) days\' notice. All amounts are in Tanzanian Shillings. Raise any dispute about a payout statement within seven (7) days; FitFlex will respond within fourteen (14) days, and undisputed amounts are not held back.' }
      : { heading: 'Malipo', text: 'FitFlex inakulipa kwa matembeleo yaliyothibitishwa kwa kutumia viwango vya siku, wiki na mwezi vya gym yako kama vilivyowekwa kwenye programu, ikitumia mchanganyiko wenye gharama nafuu zaidi kwa matembeleo ya kipindi hicho, baada ya kutoa kamisheni ya jukwaa inayoonyeshwa kwenye taarifa yako ya malipo. Viwango vinakubaliwa wakati wa kujiunga, vinapitiwa kila miezi sita (6) na upande wowote unaweza kuvibadilisha kwa taarifa ya siku thelathini (30). Kiasi chote ni kwa Shilingi za Tanzania. Wasilisha malalamiko yoyote kuhusu taarifa ya malipo ndani ya siku saba (7); FitFlex itajibu ndani ya siku kumi na nne (14), na kiasi kisicho na mgogoro hakizuiliwi.' },
    ...both(lang, PAYOUT_ACCOUNT, VERIFICATION),
    lang === 'en'
      ? { heading: 'Your listing', text: 'You give FitFlex a non-exclusive, royalty-free licence to show your gym\'s name, logo, photos and description in the app and in FitFlex marketing while you are a partner. Promotions you publish must be accurate, lawful and not offensive; FitFlex may remove any that are not. This relationship is non-exclusive: you may work with other platforms and run your own memberships.' }
      : { heading: 'Taarifa za gym yako', text: 'Unaipa FitFlex leseni isiyo ya kipekee na isiyo na mrabaha kuonyesha jina, nembo, picha na maelezo ya gym yako kwenye programu na katika matangazo ya FitFlex wakati wote ukiwa mshirika. Matangazo unayochapisha lazima yawe sahihi, halali na yasiyokera; FitFlex inaweza kuondoa yasiyokidhi. Ushirikiano huu si wa kipekee: unaweza kufanya kazi na majukwaa mengine na kuendesha uanachama wako mwenyewe.' },
    ...both(lang, DATA, LIABILITY, CHANGES, LAW),
  ],
};

const TRAINER_TERMS = {
  version: '2026-09-29',
  reference: 'FFA-TPT-001 (online) v1.0',
  title: { en: 'FitFlex Trainer Partner Terms', sw: 'Masharti ya Wakufunzi Washirika wa FitFlex' },
  sections: lang => [
    lang === 'en'
      ? { heading: 'Parties', text: `These terms are between ${COMPANY.en} and you, a personal trainer or instructor offering services through FitFlex ("Trainer").` }
      : { heading: 'Wahusika', text: `Masharti haya ni kati ya ${COMPANY.sw} na wewe, mkufunzi binafsi au mwalimu wa mazoezi unayetoa huduma kupitia FitFlex ("Mkufunzi").` },
    lang === 'en'
      ? { heading: 'Independent contractor', text: 'You offer your services as an independent contractor, not as an employee or agent of FitFlex. You decide how you deliver your sessions and are responsible for them, for your own taxes and for any permits your work needs. A session booked through FitFlex is an arrangement between you and the member.' }
      : { heading: 'Mkandarasi huru', text: 'Unatoa huduma zako kama mkandarasi huru, si kama mwajiriwa au wakala wa FitFlex. Unaamua jinsi unavyoendesha vipindi vyako na unawajibika kwa vipindi hivyo, kwa kodi zako na kwa vibali vyovyote kazi yako inavyohitaji. Kipindi kinachowekwa kupitia FitFlex ni makubaliano kati yako na mwanachama.' },
    lang === 'en'
      ? { heading: 'Your conduct', text: 'You will keep your qualifications current and accurate, train members safely and within your competence, follow the rules of any gym you work at, and treat members and staff with respect. You will not ask members to pay you outside FitFlex for sessions booked through FitFlex, and you will never check in or record a session for someone who is not present.' }
      : { heading: 'Mwenendo wako', text: 'Utahakikisha sifa zako ni halali na sahihi, utawafundisha wanachama kwa usalama na ndani ya uwezo wako, utafuata taratibu za gym yoyote unayofanyia kazi, na kuwaheshimu wanachama na wafanyakazi. Hutawaomba wanachama wakulipe nje ya FitFlex kwa vipindi vilivyowekwa kupitia FitFlex, na hutarekodi kipindi au kumwingiza mtu ambaye hayupo.' },
    lang === 'en'
      ? { heading: 'Fees and payouts', text: 'Members pay for sessions booked through FitFlex in the app. FitFlex pays you your session fees less the platform commission shown in the app and your payout statement. All amounts are in Tanzanian Shillings. Raise any dispute about a payout statement within seven (7) days.' }
      : { heading: 'Ada na malipo', text: 'Wanachama wanalipia vipindi vilivyowekwa kupitia FitFlex ndani ya programu. FitFlex inakulipa ada za vipindi vyako baada ya kutoa kamisheni ya jukwaa inayoonyeshwa kwenye programu na kwenye taarifa yako ya malipo. Kiasi chote ni kwa Shilingi za Tanzania. Wasilisha malalamiko yoyote kuhusu taarifa ya malipo ndani ya siku saba (7).' },
    ...both(lang, PAYOUT_ACCOUNT, VERIFICATION),
    lang === 'en'
      ? { heading: 'Your profile', text: 'You give FitFlex a non-exclusive, royalty-free licence to show your name, photo, qualifications and profile in the app and in FitFlex marketing while you are a partner. This relationship is non-exclusive.' }
      : { heading: 'Wasifu wako', text: 'Unaipa FitFlex leseni isiyo ya kipekee na isiyo na mrabaha kuonyesha jina, picha, sifa na wasifu wako kwenye programu na katika matangazo ya FitFlex wakati wote ukiwa mshirika. Ushirikiano huu si wa kipekee.' },
    ...both(lang, DATA, LIABILITY, CHANGES, LAW),
  ],
};

const VENDOR_TERMS = {
  version: '2026-09-29',
  reference: 'FFA-VPT-001 (online) v1.0',
  title: { en: 'FitFlex Marketplace Vendor Terms', sw: 'Masharti ya Wauzaji wa Soko la FitFlex' },
  sections: lang => [
    lang === 'en'
      ? { heading: 'Parties', text: `These terms are between ${COMPANY.en} and you, a business selling products through the FitFlex marketplace ("Vendor").` }
      : { heading: 'Wahusika', text: `Masharti haya ni kati ya ${COMPANY.sw} na wewe, biashara inayouza bidhaa kupitia soko la FitFlex ("Muuzaji").` },
    lang === 'en'
      ? { heading: 'Your products', text: 'You are the seller of the products you list. You will describe them accurately, price them in Tanzanian Shillings including any taxes, keep stock levels current, and sell only genuine, safe and lawful products that you have the right to sell. FitFlex may hide or remove listings that breach these terms or the law.' }
      : { heading: 'Bidhaa zako', text: 'Wewe ndiye muuzaji wa bidhaa unazoziorodhesha. Utazieleza kwa usahihi, kuweka bei kwa Shilingi za Tanzania ikijumuisha kodi zozote, kusasisha idadi ya bidhaa zilizopo, na kuuza bidhaa halisi, salama na halali tu ambazo una haki ya kuziuza. FitFlex inaweza kuficha au kuondoa bidhaa zinazokiuka masharti haya au sheria.' },
    lang === 'en'
      ? { heading: 'Orders, delivery and returns', text: 'You will fulfil orders promptly, deliver within the regions and times you state, and honour the returns policy shown on your store and the rights buyers have under Tanzanian consumer-protection law. You are responsible for your products and for any claims about them.' }
      : { heading: 'Oda, usafirishaji na urejeshaji', text: 'Utatekeleza oda kwa haraka, kusafirisha ndani ya maeneo na muda uliotaja, na kuheshimu sera ya urejeshaji inayoonyeshwa kwenye duka lako na haki walizonazo wanunuzi chini ya sheria ya Tanzania ya kumlinda mlaji. Unawajibika kwa bidhaa zako na kwa madai yoyote kuhusu bidhaa hizo.' },
    lang === 'en'
      ? { heading: 'Fees and payouts', text: 'Buyers pay for orders in the app. FitFlex pays you the order amounts for fulfilled orders less the marketplace commission and any fees shown in the app and your payout statement, and less refunds for returned or cancelled orders. All amounts are in Tanzanian Shillings. Raise any dispute about a payout statement within seven (7) days.' }
      : { heading: 'Ada na malipo', text: 'Wanunuzi wanalipia oda ndani ya programu. FitFlex inakulipa kiasi cha oda zilizotekelezwa baada ya kutoa kamisheni ya soko na ada zozote zinazoonyeshwa kwenye programu na kwenye taarifa yako ya malipo, na baada ya kutoa marejesho ya oda zilizorudishwa au kufutwa. Kiasi chote ni kwa Shilingi za Tanzania. Wasilisha malalamiko yoyote kuhusu taarifa ya malipo ndani ya siku saba (7).' },
    ...both(lang, PAYOUT_ACCOUNT, VERIFICATION),
    lang === 'en'
      ? { heading: 'Your store', text: 'You give FitFlex a non-exclusive, royalty-free licence to show your business name, logo, product photos and descriptions in the app and in FitFlex marketing while you are a vendor. This relationship is non-exclusive.' }
      : { heading: 'Duka lako', text: 'Unaipa FitFlex leseni isiyo ya kipekee na isiyo na mrabaha kuonyesha jina la biashara yako, nembo, picha za bidhaa na maelezo yake kwenye programu na katika matangazo ya FitFlex wakati wote ukiwa muuzaji. Ushirikiano huu si wa kipekee.' },
    ...both(lang, DATA, LIABILITY, CHANGES, LAW),
  ],
};

// ── Verification consent (all partner types) ────────────────────────────────

const KYC_CONSENT = {
  version: '2026-09-29',
  reference: 'FFA-KYC-CON-001 v1.0',
  title: { en: 'Consent to verification and use of your details', sw: 'Ridhaa ya uthibitishaji na matumizi ya taarifa zako' },
  sections: lang => (lang === 'en' ? [
    { heading: 'What this covers', text: `To verify partners, ${COMPANY.en} collects the identity, business, professional and payout details and documents you provide in your verification. This consent is given under the Personal Data Protection Act, 2022.` },
    { heading: 'What FitFlex collects', text: 'Names, contact details, dates of birth, nationality and ID numbers (NIDA, passport, driving licence or voter ID), copies of ID documents and photos, business registration, TIN and licence details, professional certificates and insurance, gym location and site-visit findings, and payout account details.' },
    { heading: 'Why', text: 'To confirm who you are and that your business is genuine; to decide whether you can be listed, booked and paid; to pay you to the right account; to remind you before documents expire; to prevent fraud and meet legal, tax and anti-money-laundering obligations; and to handle disputes.' },
    { heading: 'Who sees it', text: 'Only authorised FitFlex administrators and staff. Your ID numbers, documents and payout details are never shown to members or other partners. Documents are stored privately and can be opened only by signed-in FitFlex staff. FitFlex may check your details with the issuing authorities, such as NIDA, BRELA and TRA, and may share them with a bank or payment provider to pay you, or where the law requires.' },
    { heading: 'How long it is kept', text: 'For as long as you are a FitFlex partner and afterwards for as long as the law requires FitFlex to keep records (for example for tax and anti-money-laundering purposes), after which it is deleted.' },
    { heading: 'Your rights', text: `You may ask to see or correct your details, withdraw this consent, or ask for your details to be deleted where the law allows, by writing to ${CONTACT}. Withdrawing consent means FitFlex can no longer verify you, so you may no longer be listed or paid. You may also complain to the Personal Data Protection Commission.` },
    { heading: 'Your confirmation', text: 'By accepting, you confirm that the details you provide are true and that you have permission to share any details of other people (such as directors or representatives) that you include.' },
  ] : [
    { heading: 'Ridhaa hii inahusu nini', text: `Ili kuthibitisha washirika, ${COMPANY.sw} inakusanya taarifa na nyaraka za utambulisho, biashara, taaluma na malipo unazotoa katika uthibitishaji wako. Ridhaa hii inatolewa chini ya Sheria ya Ulinzi wa Taarifa Binafsi, 2022.` },
    { heading: 'FitFlex inakusanya nini', text: 'Majina, mawasiliano, tarehe za kuzaliwa, uraia na namba za utambulisho (NIDA, pasipoti, leseni ya udereva au kitambulisho cha mpiga kura), nakala za vitambulisho na picha, usajili wa biashara, TIN na taarifa za leseni, vyeti vya taaluma na bima, eneo la gym na matokeo ya ukaguzi wa gym, na taarifa za akaunti ya malipo.' },
    { heading: 'Kwa nini', text: 'Kuthibitisha wewe ni nani na kwamba biashara yako ni halisi; kuamua kama unaweza kuorodheshwa, kuwekewa miadi na kulipwa; kukulipa kupitia akaunti sahihi; kukukumbusha kabla nyaraka hazijaisha muda; kuzuia udanganyifu na kutimiza wajibu wa kisheria, kodi na kupambana na utakatishaji fedha; na kushughulikia migogoro.' },
    { heading: 'Nani anaziona', text: 'Wasimamizi na wafanyakazi wa FitFlex walioidhinishwa tu. Namba zako za utambulisho, nyaraka na taarifa za malipo haziwahi kuonyeshwa kwa wanachama au washirika wengine. Nyaraka zinahifadhiwa kwa faragha na zinaweza kufunguliwa na wafanyakazi wa FitFlex walioingia kwenye mfumo tu. FitFlex inaweza kuhakiki taarifa zako na mamlaka zilizozitoa, kama NIDA, BRELA na TRA, na inaweza kuzitoa kwa benki au mtoa huduma za malipo ili kukulipa, au pale sheria inapotaka.' },
    { heading: 'Zinahifadhiwa kwa muda gani', text: 'Wakati wote ukiwa mshirika wa FitFlex na baada ya hapo kwa muda ambao sheria inaitaka FitFlex kuhifadhi kumbukumbu (kwa mfano kwa madhumuni ya kodi na kupambana na utakatishaji fedha), kisha zinafutwa.' },
    { heading: 'Haki zako', text: `Unaweza kuomba kuona au kusahihisha taarifa zako, kuondoa ridhaa hii, au kuomba taarifa zako zifutwe pale sheria inaporuhusu, kwa kuandika kwa ${CONTACT}. Kuondoa ridhaa kunamaanisha FitFlex haiwezi tena kukuthibitisha, hivyo huenda usiorodheshwe wala kulipwa. Unaweza pia kuwasilisha malalamiko kwa Tume ya Ulinzi wa Taarifa Binafsi.` },
    { heading: 'Uthibitisho wako', text: 'Kwa kukubali, unathibitisha kuwa taarifa unazotoa ni za kweli na kwamba una ruhusa ya kutoa taarifa za watu wengine (kama wakurugenzi au wawakilishi) unazoziweka.' },
  ]),
};

const PARTNER_TERMS = { gym_owner: GYM_OWNER_TERMS, trainer: TRAINER_TERMS, vendor: VENDOR_TERMS };

/** The agreements a partner type accepts in the app, in the order they are shown. */
export function requiredAgreements(partnerType) {
  const terms = PARTNER_TERMS[partnerType];
  if (!terms) return []; // corporate partners sign a contract offline
  return [
    { agreementType: 'partner_agreement', checklistKey: 'agreements.partner_terms', text: terms },
    { agreementType: 'kyc_consent', checklistKey: 'agreements.kyc_consent', text: KYC_CONSENT },
  ];
}

/** An agreement's text in a language (en or sw; anything else falls back to en). */
export function agreementText(text, lang) {
  const l = lang === 'sw' ? 'sw' : 'en';
  return { version: text.version, reference: text.reference, title: text.title[l], sections: text.sections(l), lang: l };
}
