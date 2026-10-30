// Marathon & running events · S6 — every server-sent sentence of the slice, English and Swahili (spec §11, §12). Swahili is a DRAFT for
// native review. Each builder returns { en: { title, body }, sw: { title, body } } so `notice` can pick the person's language and
// still carry both in `data` (titleEn / titleSw …).

const STAGE_WORD = {
  provisional: { en: 'provisional', sw: 'ya awali' },
  official: { en: 'official', sw: 'rasmi' },
};
// TODO(sw-review): every Swahili string in this file is a draft for native review; findings 5 (disqualification wording), 6 and 14 are still open.
const OUTCOME_WORD = {
  upheld: { en: 'the organizer changed your result', sw: 'mwandaaji amebadilisha matokeo yako' },
  rejected: { en: 'no change was made', sw: 'hakuna mabadiliko yaliyofanywa' },
  open: { en: 'the organizer is reviewing it', sw: 'mwandaaji analiangalia' },
  withdrawn: { en: 'you withdrew it', sw: 'umeliondoa' },
};
/** Plain-language reasons built from reason codes (medal / reward removal, rejection). */
export const REASON_WORD = {
  result_corrected: { en: 'your result was corrected', sw: 'matokeo yako yalisahihishwa' },
  // TODO(sw-review): finding 5, the disqualification wording
  disqualified: { en: 'your result was disqualified', sw: 'matokeo yako yamefutwa kwa kukiuka sheria' },
  registration_cancelled: { en: 'your place was cancelled', sw: 'tiketi yako ilighairiwa' },
  event_cancelled: { en: 'the event was cancelled', sw: 'tukio lilighairiwa' },
  rule_changed_by_admin: { en: 'FitFlex changed the rule', sw: 'FitFlex ilibadilisha sharti' },
  source_revoked: { en: 'what earned it was removed', sw: 'kilichokupatia kiliondolewa' },
  not_a_valid_run: { en: 'it was not a valid run', sw: 'haikuwa mbio halali' },
  data_error: { en: 'the run data had an error', sw: 'taarifa za mbio zilikuwa na hitilafu' },
  duplicate: { en: 'it was a duplicate', sw: 'ilikuwa nakala' },
  replaced_by_participant: { en: 'you replaced it', sw: 'uliibadilisha' },
  other: { en: 'of another reason', sw: 'nyingine' }, // used after "kwa sababu"
};
const reasonOf = code => REASON_WORD[code] ?? REASON_WORD.other;
export const TAKEDOWN_WORD = {
  inappropriate: { en: 'it was not appropriate', sw: 'haikufaa' },
  rights: { en: 'it may use someone else\'s work', sw: 'huenda inatumia kazi ya mtu mwingine' },
  other_brand: { en: 'it uses another brand\'s mark', sw: 'inatumia nembo ya chapa nyingine' },
  person_request: { en: 'a person in it asked for it to be removed', sw: 'mtu aliyeko ndani yake aliomba iondolewe' },
  quality: { en: 'it was unreadable or misleading', sw: 'haisomeki au inapotosha' },
  other: { en: 'of another reason', sw: 'nyingine' }, // used after "kwa sababu"
};

const pack = (en, sw) => ({ en, sw });
/** Push titles stay short (a long title is cut off on a phone); the body carries the sentence. */
const DISPUTE_TITLE = {
  upheld: { en: 'Result changed', sw: 'Matokeo yamebadilishwa' },
  rejected: { en: 'Result stands', sw: 'Matokeo yanabaki' },
  open: { en: 'Question under review', sw: 'Swali linapitiwa' },
  withdrawn: { en: 'Question withdrawn', sw: 'Swali limeondolewa' },
};

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
    { title: DISPUTE_TITLE[outcome].en, body: `Your question about your result: ${OUTCOME_WORD[outcome].en}.` },
    { title: DISPUTE_TITLE[outcome].sw, body: `Swali lako kuhusu matokeo yako: ${OUTCOME_WORD[outcome].sw}.` }),
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

/**
 * Member-facing error codes the server returns, in both languages (clients may show these sentences or map the code themselves).
 * TODO(sw-review): native review of every Swahili sentence below.
 */
export const ERROR_MESSAGES = {
  registration_not_found: { en: 'We could not find this place.', sw: 'Hatukuipata tiketi hii.' },
  event_not_found: { en: 'We could not find this event.', sw: 'Hatukulipata tukio hili.' },
  not_found: { en: 'Not found.', sw: 'Haijapatikana.' },
  no_result: { en: 'There is no published result to ask about yet.', sw: 'Bado hakuna matokeo yaliyochapishwa ya kuuliza.' },
  dispute_open: { en: 'You already have a question open for this result.', sw: 'Tayari una swali lililo wazi kuhusu matokeo haya.' },
  dispute_closed: { en: 'This question is already closed.', sw: 'Swali hili limeshafungwa.' },
  dispute_not_found: { en: 'We could not find this question.', sw: 'Hatukuliona swali hili.' },
  dispute_window_closed: { en: 'The time to ask about this result has passed.', sw: 'Muda wa kuuliza kuhusu matokeo haya umeisha.' },
  visibility_not_allowed: { en: 'You cannot choose this option.', sw: 'Huwezi kuchagua chaguo hili.' },
  run_outside_window: { en: 'This run is outside the time allowed for this event.', sw: 'Mbio hizi ziko nje ya muda unaoruhusiwa kwa tukio hili.' },
  distance_too_short: { en: 'This run does not reach the distance of your category.', sw: 'Mbio hizi hazifikii umbali wa kundi lako.' },
  activity_not_recorded_in_app: { en: 'Only runs recorded in the FitFlex app can be added.', sw: 'Ni mbio zilizorekodiwa kwenye app ya FitFlex pekee zinazoweza kuongezwa.' },
  activity_not_found: { en: 'We could not find this run.', sw: 'Hatukuziona mbio hizi.' },
  run_already_linked: { en: 'A run is already added for this place. Remove it first.', sw: 'Tayari kuna mbio zilizoongezwa kwa tiketi hii. Ziondoe kwanza.' },
  activity_already_linked: { en: 'This run is already added.', sw: 'Mbio hizi zimeshaongezwa.' },
  evidence_limit: { en: 'You can add up to 3 runs to one event.', sw: 'Unaweza kuongeza hadi mbio 3 kwa tukio moja.' },
  link_locked: { en: 'The organizer has already decided on this run.', sw: 'Mwandaaji ameshaamua kuhusu mbio hizi.' },
  link_not_found: { en: 'We could not find this run link.', sw: 'Hatukuliona kiungo cha mbio hizi.' },
  linking_closed: { en: 'Adding runs has closed for this event.', sw: 'Kuongeza mbio kumefungwa kwa tukio hili.' },
  event_cancelled: { en: 'This event was cancelled.', sw: 'Tukio hili lilighairiwa.' },
  ticket_revoked: { en: 'This ticket is no longer valid.', sw: 'Tiketi hii haitumiki tena.' },
  registration_not_confirmed: { en: 'This place is not confirmed.', sw: 'Tiketi hii haijathibitishwa.' },
  result_exists: { en: 'This place already has a verified result.', sw: 'Tiketi hii tayari ina matokeo yaliyothibitishwa.' },
  not_enough_units: { en: 'You have no reward left to claim.', sw: 'Huna zawadi iliyobaki ya kudai.' },
  reward_unavailable: { en: 'This reward is no longer available.', sw: 'Zawadi hii haipatikani tena.' },
  rewards_unavailable: { en: 'Rewards with a code are not available right now.', sw: 'Zawadi zenye msimbo hazipatikani kwa sasa.' },
  redemption_expired: { en: 'This reward code has expired.', sw: 'Msimbo wa zawadi hii umeisha muda.' },
  idempotency_key_reused: { en: 'This request was already used with different details.', sw: 'Ombi hili lilishatumika kwa taarifa tofauti.' },
  idempotency_key_required: { en: 'The request is missing its unique key.', sw: 'Ombi halina ufunguo wake wa kipekee.' },
  rate_limited: { en: 'Too many tries. Please wait and try again.', sw: 'Majaribio mengi mno. Tafadhali subiri ujaribu tena.' },
  organizer_owner: { en: 'Transfer or close your organizer account first.', sw: 'Hamisha au funga akaunti yako ya mwandaaji kwanza.' },
  feature_disabled: { en: 'This is not available yet.', sw: 'Huduma hii bado haipatikani.' },
};
/** { message, messageSw } for a code, or {} when the code has no sentence. */
export const errorText = code => (ERROR_MESSAGES[code] ? { message: ERROR_MESSAGES[code].en, messageSw: ERROR_MESSAGES[code].sw } : {});
