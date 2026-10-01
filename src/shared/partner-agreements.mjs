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

// Mirrors the Gym Partner Agreement FFA-GPA-001 v2.0 (29 September 2026).
const GYM_OWNER_TERMS = {
  version: '2026-10-01',
  reference: 'FFA-GPA-001 (online) v2.0',
  title: { en: 'FitFlex Gym Partner Terms', sw: 'Masharti ya Ushirikiano wa Gym na FitFlex' },
  sections: lang => [
    lang === 'en'
      ? { heading: 'Parties', text: `These terms are between ${COMPANY.en} and you, the gym owner, for each gym you list on FitFlex ("Gym Partner"). They adapt the FitFlex Gym Partner Agreement (FFA-GPA-001 v2.0) for acceptance in the app. If you have also signed that agreement on paper, the signed agreement prevails where the two differ.` }
      : { heading: 'Wahusika', text: `Masharti haya ni kati ya ${COMPANY.sw} na wewe, mmiliki wa gym, kwa kila gym unayoiweka kwenye FitFlex ("Mshirika wa Gym"). Yanatokana na Mkataba wa Ushirikiano wa Gym wa FitFlex (FFA-GPA-001 v2.0) na yamerekebishwa ili yakubaliwe ndani ya programu. Kama umeshasaini mkataba huo kwa karatasi, mkataba uliosainiwa ndio unaotumika pale yanapotofautiana.` },
    lang === 'en'
      ? { heading: 'Inspection and classification', text: 'Before your gym goes live, FitFlex inspects it on site and scores it on the FitFlex vetting rubric (equipment, amenities, facility and staffing). The score sets your gym\'s classification: Standard, Mid-Tier, Premium or Luxury/Executive. You cannot choose or change your own classification. FitFlex re-scores gyms from time to time, taking account of member ratings and complaints, and may change the classification on notice. Until verification and inspection are approved, the gym is shown as pending and cannot accept check-ins.' }
      : { heading: 'Ukaguzi na daraja', text: 'Kabla gym yako haijaanza kutumika, FitFlex inaikagua na kuipa alama kwa vigezo vya FitFlex (vifaa, huduma, jengo na wafanyakazi). Alama hizo ndizo zinazoamua daraja la gym yako: Standard, Mid-Tier, Premium au Luxury/Executive. Huwezi kuchagua wala kubadilisha daraja lako mwenyewe. FitFlex hukagua upya gym mara kwa mara, ikizingatia tathmini na malalamiko ya wanachama, na inaweza kubadilisha daraja baada ya kukujulisha. Mpaka uthibitishaji na ukaguzi vikubaliwe, gym inaonekana kuwa inasubiri na haiwezi kupokea check-in.' },
    lang === 'en'
      ? { heading: 'Access for members', text: 'You will admit every FitFlex Pass member whose pass covers your classification, and every member with an active plan for your gym, during your published opening hours, without any extra entry fee, surcharge or required purchase. Optional extras may be sold at the member\'s choice. You will keep the facility at the standard of its classification, keep your opening hours in the app accurate, and comply with Tanzanian health, safety and business licensing requirements. You may apply your reasonable house rules to all members equally.' }
      : { heading: 'Kuwapokea wanachama', text: 'Utampokea kila mwanachama wa FitFlex Pass ambaye kifurushi chake kinahusisha daraja lako, na kila mwanachama mwenye mpango hai wa gym yako, wakati wa saa zako za kazi zilizotangazwa, bila ada ya ziada ya kuingia, nyongeza au ununuzi wa lazima. Huduma za ziada zinaweza kuuzwa kwa hiari ya mwanachama. Utaitunza gym katika kiwango cha daraja lake, kuhakikisha saa za kazi kwenye programu ni sahihi, na kuzingatia masharti ya Tanzania ya afya, usalama na leseni za biashara. Unaweza kutumia taratibu zako za ndani zinazofaa kwa wanachama wote kwa usawa.' },
    lang === 'en'
      ? { heading: 'Check-in', text: 'Every visit is recorded with a FitFlex QR check-in, either by scanning the member\'s code (which changes every 60 seconds) or by the member scanning your gym\'s entrance code. You will keep at least one staff member and a working device able to check members in during opening hours, confirm the member matches the photo shown, and admit or refuse entry according to the result the app shows. You will never check in someone who is not physically present, and never share your entrance code outside the gym. A visit is one member at one gym on one calendar day, however many times they scan. Report check-in problems to FitFlex support within two (2) hours. A visit that could not be recorded because of a technical failure may be reported to FitFlex support within twenty-four (24) hours and is paid once FitFlex verifies it.' }
      : { heading: 'Kuingia (check-in)', text: 'Kila tembeleo linarekodiwa kwa check-in ya QR ya FitFlex, iwe kwa kuskani msimbo wa mwanachama (unaobadilika kila sekunde 60) au mwanachama kuskani msimbo wa mlangoni wa gym yako. Utahakikisha kuna angalau mfanyakazi mmoja na kifaa kinachofanya kazi cha kuwaingiza wanachama wakati wote gym iko wazi, kuthibitisha mwanachama anafanana na picha inayoonyeshwa, na kumruhusu au kumkatalia kuingia kulingana na matokeo yanayoonyeshwa na programu. Hutamwingiza mtu ambaye hayupo kimwili, wala kutoa msimbo wako wa mlangoni nje ya gym. Tembeleo moja ni mwanachama mmoja katika gym moja kwa siku moja, hata akiskani mara ngapi. Ripoti matatizo ya check-in kwa huduma ya wateja ya FitFlex ndani ya saa mbili (2). Tembeleo lililoshindwa kurekodiwa kwa sababu ya hitilafu ya kiufundi linaweza kuripotiwa kwa FitFlex ndani ya saa ishirini na nne (24) na litalipwa FitFlex ikishalithibitisha.' },
    lang === 'en'
      ? { heading: 'How you are paid for FitFlex Pass members', text: 'FitFlex pays you for each Pass member\'s visit-days at your gym in a calendar month, from your gym\'s own daily, weekly and monthly rates: 1 to 3 visit-days are paid at your daily rate for each day; 4 to 7 visit-days at one weekly rate; 8 to 14 visit-days at two weekly rates; and 15 or more visit-days at one monthly rate. The payout for any one member in a month never exceeds your monthly rate. No commission is deducted from Pass payouts. Pass payouts are paid monthly, by the 5th day of the following month.' }
      : { heading: 'Jinsi unavyolipwa kwa wanachama wa FitFlex Pass', text: 'FitFlex inakulipa kwa siku za matembeleo ya kila mwanachama wa Pass kwenye gym yako ndani ya mwezi wa kalenda, kwa kutumia viwango vya gym yako vya siku, wiki na mwezi: siku 1 hadi 3 hulipwa kwa kiwango chako cha siku kwa kila siku; siku 4 hadi 7 kwa kiwango kimoja cha wiki; siku 8 hadi 14 kwa viwango viwili vya wiki; na siku 15 au zaidi kwa kiwango kimoja cha mwezi. Malipo ya mwanachama mmoja kwa mwezi hayazidi kamwe kiwango chako cha mwezi. Hakuna kamisheni inayokatwa kwenye malipo ya Pass. Malipo ya Pass hulipwa kila mwezi, kufikia tarehe 5 ya mwezi unaofuata.' },
    lang === 'en'
      ? { heading: 'Your gym plans, trainer passes and your own members', text: 'Members and trainers who buy your gym\'s plans or trainer passes through FitFlex pay FitFlex your price. FitFlex keeps the platform commission agreed with you (between 10% and 15% of the price) and pays you the balance weekly. These plans and passes are valid only at the gym they were bought for. Trainers you have approved to work at your gym check in there free of charge, and their check-ins are not paid visits. Members you sign up and collect payment from yourself (for example in cash) can be registered in the app so they can check in: they are your own members, FitFlex charges no commission on them and makes no payout for their visits.' }
      : { heading: 'Mipango ya gym yako, pasi za wakufunzi na wanachama wako mwenyewe', text: 'Wanachama na wakufunzi wanaonunua mipango ya gym yako au pasi za wakufunzi kupitia FitFlex huilipa FitFlex bei yako. FitFlex hubaki na kamisheni ya jukwaa mliyokubaliana (kati ya asilimia 10 na 15 ya bei) na hukulipa kiasi kilichobaki kila wiki. Mipango na pasi hizi zinatumika tu kwenye gym zilikonunuliwa. Wakufunzi uliowaidhinisha kufanya kazi kwenye gym yako huingia hapo bila malipo, na check-in zao si matembeleo ya kulipwa. Wanachama unaowasajili na kupokea malipo yao mwenyewe (kwa mfano kwa fedha taslimu) wanaweza kuandikishwa kwenye programu ili waweze kufanya check-in: hao ni wanachama wako mwenyewe, FitFlex haitozi kamisheni kwao na hailipi matembeleo yao.' },
    lang === 'en'
      ? { heading: 'Rates, statements and disputes', text: 'You provide your daily, weekly and monthly rates when you join. They are reviewed every six (6) months and may be changed by either party on thirty (30) days\' notice. Statements and invoices for each payout period are available in the app. All amounts are in Tanzanian Shillings and include VAT where applicable; each party is responsible for its own taxes, and FitFlex deducts withholding tax where the law requires. Raise any dispute about a statement within seven (7) days; FitFlex will respond within fourteen (14) days, and undisputed amounts are not held back.' }
      : { heading: 'Viwango, taarifa na migogoro', text: 'Unatoa viwango vyako vya siku, wiki na mwezi unapojiunga. Vinapitiwa kila miezi sita (6) na upande wowote unaweza kuvibadilisha kwa taarifa ya siku thelathini (30). Taarifa na ankara za kila kipindi cha malipo zinapatikana kwenye programu. Kiasi chote ni kwa Shilingi za Tanzania na kinajumuisha VAT pale inapohusika; kila upande unawajibika kwa kodi zake, na FitFlex hukata kodi ya zuio pale sheria inapotaka. Wasilisha malalamiko yoyote kuhusu taarifa ndani ya siku saba (7); FitFlex itajibu ndani ya siku kumi na nne (14), na kiasi kisicho na mgogoro hakizuiliwi.' },
    ...both(lang, PAYOUT_ACCOUNT, VERIFICATION),
    lang === 'en'
      ? { heading: 'Staff and trainers', text: 'You may create staff accounts and choose what each can access (members, check-ins, payments, trainers, gym settings, shop and messaging). You are responsible for your staff\'s use of FitFlex and will remove access promptly when someone leaves. Trainers ask to join your gym in the app and you approve or decline them; FitFlex separately verifies every trainer. Trainers are independent contractors.' }
      : { heading: 'Wafanyakazi na wakufunzi', text: 'Unaweza kufungua akaunti za wafanyakazi na kuchagua kila mmoja anaweza kufikia nini (wanachama, check-in, malipo, wakufunzi, mipangilio ya gym, duka na ujumbe). Unawajibika kwa matumizi ya FitFlex ya wafanyakazi wako na utaondoa ruhusa mara mtu anapoondoka. Wakufunzi huomba kujiunga na gym yako kwenye programu nawe unawakubali au kuwakataa; FitFlex huthibitisha kila mkufunzi kivyake. Wakufunzi ni wakandarasi huru.' },
    lang === 'en'
      ? { heading: 'Messaging members', text: 'You may message your own gym members only, through FitFlex\'s messaging tools. You may not message FitFlex Pass members who are not your own members, or export member contact details to message them elsewhere. Members receive no more than two promotional messages a week from all senders on FitFlex combined; FitFlex applies this limit automatically. Automated messages are off until you turn them on and are sent only between 08:00 and 20:00 East Africa Time. WhatsApp messages go only to members who have opted in, using FitFlex-approved templates. Messages must be accurate, lawful and not offensive; FitFlex may remove any that are not.' }
      : { heading: 'Kuwatumia wanachama ujumbe', text: 'Unaweza kuwatumia ujumbe wanachama wa gym yako mwenyewe tu, kupitia zana za ujumbe za FitFlex. Huruhusiwi kuwatumia ujumbe wanachama wa FitFlex Pass ambao si wanachama wako, wala kuhamisha mawasiliano ya wanachama ili kuwatumia ujumbe kwingine. Wanachama hupokea ujumbe wa matangazo usiozidi miwili kwa wiki kutoka kwa watumaji wote wa FitFlex kwa pamoja; FitFlex hutekeleza kikomo hiki kiotomatiki. Ujumbe wa kiotomatiki huwa umezimwa mpaka uuwashe na hutumwa kati ya saa 2:00 asubuhi na saa 2:00 usiku tu kwa saa za Afrika Mashariki. Ujumbe wa WhatsApp huenda kwa wanachama waliokubali tu, kwa kutumia violezo vilivyoidhinishwa na FitFlex. Ujumbe lazima uwe sahihi, halali na usiokera; FitFlex inaweza kuondoa usiokidhi.' },
    lang === 'en'
      ? { heading: 'Your listing and reviews', text: 'You give FitFlex a non-exclusive, royalty-free licence to show your gym\'s name, logo, photos and description in the app and in FitFlex marketing while you are a partner. Members may review your gym after checking in or while holding a plan with you. You must not offer anything in return for reviews, post reviews of your own gym, or pressure members about reviews; FitFlex moderates reviews and you may report one to FitFlex support. This relationship is non-exclusive: you may work with other platforms and run your own memberships.' }
      : { heading: 'Taarifa za gym yako na maoni', text: 'Unaipa FitFlex leseni isiyo ya kipekee na isiyo na mrabaha kuonyesha jina, nembo, picha na maelezo ya gym yako kwenye programu na katika matangazo ya FitFlex wakati wote ukiwa mshirika. Wanachama wanaweza kutoa maoni kuhusu gym yako baada ya kufanya check-in au wakiwa na mpango kwako. Huruhusiwi kutoa chochote ili kupata maoni, kuandika maoni kuhusu gym yako mwenyewe, wala kuwashinikiza wanachama kuhusu maoni; FitFlex husimamia maoni na unaweza kuripoti maoni kwa huduma ya wateja ya FitFlex. Ushirikiano huu si wa kipekee: unaweza kufanya kazi na majukwaa mengine na kuendesha uanachama wako mwenyewe.' },
    lang === 'en'
      ? { heading: 'Data protection and confidentiality', text: 'Both parties will comply with the Personal Data Protection Act, 2022. FitFlex is responsible for platform data, including Pass members\' data and all check-in, payment and usage data, and owns the aggregated platform data. You are responsible for the data you hold about your own gym members. You will use what is shown at check-in (photo, tier and status) only to control access, and will not copy, export or reuse Pass members\' data. Members decide what else your gym can see; those choices are off unless the member turns them on. Each party will keep member data secure and tell the other within forty-eight (48) hours of a personal-data breach affecting the other\'s data. Neither party will share the other\'s confidential business information, including rates and payouts, except as needed to run the platform or as the law requires.' }
      : { heading: 'Ulinzi wa taarifa na usiri', text: 'Pande zote zitazingatia Sheria ya Ulinzi wa Taarifa Binafsi, 2022. FitFlex inawajibika kwa taarifa za jukwaa, zikiwemo taarifa za wanachama wa Pass na taarifa zote za check-in, malipo na matumizi, na inamiliki takwimu za jumla za jukwaa. Wewe unawajibika kwa taarifa unazohifadhi kuhusu wanachama wa gym yako mwenyewe. Utatumia kinachoonyeshwa wakati wa check-in (picha, daraja na hali) kwa ajili ya kudhibiti kuingia tu, na hutanakili, kuhamisha wala kutumia tena taarifa za wanachama wa Pass. Wanachama huamua gym yako inaweza kuona nini kingine; chaguo hizo huwa zimezimwa mpaka mwanachama aziwashe. Kila upande utalinda taarifa za wanachama na kuujulisha upande mwingine ndani ya saa arobaini na nane (48) pale panapotokea uvujaji wa taarifa binafsi unaogusa taarifa za upande huo. Hakuna upande utakaotoa taarifa za siri za biashara za upande mwingine, zikiwemo viwango na malipo, isipokuwa inapohitajika kuendesha jukwaa au sheria inapotaka.' },
    ...both(lang, LIABILITY),
    lang === 'en'
      ? { heading: 'Term and pilot period', text: 'These terms apply from the day you accept them and continue for twelve (12) months from the date your gym goes live, renewing automatically for further twelve-month periods. The first ninety (90) days after going live are a pilot period, after which FitFlex and you review performance, classification and rates. When the relationship ends, FitFlex removes the gym from the app within seven (7) business days and pays outstanding payouts for verified visits within thirty (30) days; you will honour gym plans already paid for until they end.' }
      : { heading: 'Muda na kipindi cha majaribio', text: 'Masharti haya yanaanza kutumika siku unayoyakubali na yanaendelea kwa miezi kumi na miwili (12) tangu siku gym yako inapoanza kutumika, yakijihuisha yenyewe kwa vipindi vingine vya miezi kumi na miwili. Siku tisini (90) za kwanza baada ya kuanza ni kipindi cha majaribio, kisha FitFlex na wewe mnapitia utendaji, daraja na viwango. Ushirikiano unapoisha, FitFlex huiondoa gym kwenye programu ndani ya siku saba (7) za kazi na hulipa malipo yaliyobaki ya matembeleo yaliyothibitishwa ndani ya siku thelathini (30); utaheshimu mipango ya gym iliyokwisha lipiwa mpaka iishe.' },
    ...both(lang, CHANGES, LAW),
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
