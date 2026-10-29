// Marathon & running events · S6 — every server-sent sentence of the slice, English and Swahili (spec §11, §12). Swahili is a DRAFT for
// native review. Each builder returns { en: { title, body }, sw: { title, body } } so `notice` can pick the person's language and
// still carry both in `data` (titleEn / titleSw …).

const STAGE_WORD = {
  provisional: { en: 'provisional', sw: 'ya muda' },
  official: { en: 'official', sw: 'rasmi' },
};
const OUTCOME_WORD = {
  upheld: { en: 'the organizer changed your result', sw: 'mwandaaji amebadilisha matokeo yako' },
  rejected: { en: 'no change was made', sw: 'hakuna mabadiliko yaliyofanywa' },
  open: { en: 'the organizer is reviewing it', sw: 'mwandaaji analiangalia' },
  withdrawn: { en: 'you withdrew it', sw: 'umeliondoa' },
};
/** Plain-language reasons built from reason codes (medal / reward removal, rejection). */
export const REASON_WORD = {
  result_corrected: { en: 'your result was corrected', sw: 'matokeo yako yalisahihishwa' },
  disqualified: { en: 'your result was disqualified', sw: 'matokeo yako yamefutwa kwa kukiuka sheria' },
  registration_cancelled: { en: 'your place was cancelled', sw: 'nafasi yako ilifutwa' },
  event_cancelled: { en: 'the event was cancelled', sw: 'tukio lilifutwa' },
  rule_changed_by_admin: { en: 'FitFlex changed the rule', sw: 'FitFlex ilibadilisha sharti' },
  source_revoked: { en: 'what earned it was removed', sw: 'kilichokupatia kiliondolewa' },
  not_a_valid_run: { en: 'it was not a valid run', sw: 'haikuwa mbio halali' },
  data_error: { en: 'the run data had an error', sw: 'taarifa za mbio zilikuwa na hitilafu' },
  duplicate: { en: 'it was a duplicate', sw: 'ilikuwa nakala' },
  replaced_by_participant: { en: 'you replaced it', sw: 'uliibadilisha' },
  other: { en: 'of another reason', sw: 'kwa sababu nyingine' },
};
const reasonOf = code => REASON_WORD[code] ?? REASON_WORD.other;
export const TAKEDOWN_WORD = {
  inappropriate: { en: 'it was not appropriate', sw: 'haikufaa' },
  rights: { en: 'it may use someone else\'s work', sw: 'huenda inatumia kazi ya mtu mwingine' },
  other_brand: { en: 'it uses another brand\'s mark', sw: 'inatumia nembo ya chapa nyingine' },
  person_request: { en: 'a person in it asked for it to be removed', sw: 'mtu aliyeko ndani yake aliomba iondolewe' },
  quality: { en: 'it was unreadable or misleading', sw: 'haisomeki au inapotosha' },
  other: { en: 'of another reason', sw: 'kwa sababu nyingine' },
};

const pack = (en, sw) => ({ en, sw });

export const COPY = {
  resultPublished: ({ event, stage }) => pack(
    { title: 'Results are out', body: `Your result for ${event} is ${STAGE_WORD[stage].en}.` },
    { title: 'Matokeo yametoka', body: `Matokeo yako ya ${event} ni ${STAGE_WORD[stage].sw}.` }),
  resultCorrected: ({ event }) => pack(
    { title: 'Your result was corrected', body: `The organizer corrected your result for ${event}.` },
    { title: 'Matokeo yako yamesahihishwa', body: `Mwandaaji amesahihisha matokeo yako ya ${event}.` }),
  resultRejected: ({ event }) => pack(
    { title: 'Run not accepted', body: `Your run for ${event} was not accepted. See why.` },
    { title: 'Mbio hazikukubaliwa', body: `Mbio zako za ${event} hazikukubaliwa. Angalia sababu.` }),
  disputeUpdate: ({ outcome }) => pack(
    { title: `Question about your result: ${OUTCOME_WORD[outcome].en}`, body: `Your question about your result: ${OUTCOME_WORD[outcome].en}.` },
    { title: `Swali kuhusu matokeo yako: ${OUTCOME_WORD[outcome].sw}`, body: `Swali lako kuhusu matokeo yako: ${OUTCOME_WORD[outcome].sw}.` }),
  disputeOpened: ({ event }) => pack(
    { title: 'A runner asked for a review', body: `A participant raised a question about a result for ${event}.` },
    { title: 'Mshiriki ameomba mapitio', body: `Mshiriki ameuliza swali kuhusu matokeo ya ${event}.` }),
  medalAwarded: ({ medal }) => pack(
    { title: 'New medal', body: `You earned the ${medal} medal.` },
    { title: 'Medali mpya', body: `Umepata medali ya ${medal}.` }),
  medalRevoked: ({ medal, reason }) => pack(
    { title: 'A medal was removed', body: `The ${medal} medal was removed because ${reasonOf(reason).en}.` },
    { title: 'Medali imeondolewa', body: `Medali ya ${medal} imeondolewa kwa sababu ${reasonOf(reason).sw}.` }),
  rewardEarned: ({ reward }) => pack(
    { title: 'New reward', body: `You earned: ${reward}.` },
    { title: 'Zawadi mpya', body: `Umepata: ${reward}.` }),
  rewardReversed: ({ reward, reason }) => pack(
    { title: 'A reward was removed', body: `${reward} was removed because ${reasonOf(reason).en}.` },
    { title: 'Zawadi imeondolewa', body: `${reward} imeondolewa kwa sababu ${reasonOf(reason).sw}.` }),
  artTakenDown: ({ event, reason }) => pack(
    { title: 'Medal design removed', body: `Your medal design for ${event} was removed because ${(TAKEDOWN_WORD[reason] ?? TAKEDOWN_WORD.other).en}.` },
    { title: 'Muundo wa medali umeondolewa', body: `Muundo wako wa medali wa ${event} uliondolewa kwa sababu ${(TAKEDOWN_WORD[reason] ?? TAKEDOWN_WORD.other).sw}.` }),
  adminException: ({ event }) => pack(
    { title: 'FitFlex changed a result', body: `FitFlex corrected a result for ${event} on your behalf. The reason is in the result history.` },
    { title: 'FitFlex imebadilisha matokeo', body: `FitFlex imesahihisha matokeo ya ${event} kwa niaba yako. Sababu iko kwenye historia ya matokeo.` }),
};

/** The words an error needs when it reaches a person (the API returns codes; these are the sentences clients may show). */
export const ERROR_TEXT = {
  organizer_owner: {
    en: 'Transfer or close your organizer account first.',
    sw: 'Hamisha au funga akaunti yako ya mwandaaji kwanza.',
  },
};
