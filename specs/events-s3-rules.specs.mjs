// Marathon & running events · S3 — the pure rules (no database): field policy, participant checks, age on the
// event day in the event's timezone, duplicates within a request, consent texts, masking, idempotency
// fingerprints, join codes, claim tokens, roster parsing and the configuration readers.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveFields, parseParticipantFields, checkParticipant, findDuplicatesInRequest, ageOnEventDay, localDateIn, consentTextFor,
  maskName, maskFirstName, lastInitial, maskContactShort, canonicalFingerprint, IDEMPOTENCY_KEY_RE, newJoinCode, normaliseJoinCode, formatJoinCode,
  newClaimToken, hashToken, isClaimTokenShape, MEMBER_CANCEL_REASONS,
} from '../src/shared/events-participants.mjs';
import { parseRosterText, normaliseRosterDate, matchCategory } from '../src/services/events-roster-service.mjs';
import { eventsFeeRule, eventsOrgDiscounts, eventsMaxParticipantsPerOrder, eventsConsentTextVersion, feeLabelFor } from '../src/shared/events-config.mjs';
import { quoteLines } from '../src/shared/events-pricing.mjs';

afterEach(() => { for (const k of ['EVENTS_FEE_RULE', 'EVENTS_ORG_DISCOUNTS', 'EVENTS_MAX_PARTICIPANTS_PER_ORDER', 'EVENTS_CONSENT_TEXT_VERSION']) delete process.env[k]; });

// A Dar event starting 2027-03-06 04:00Z = 07:00 EAT on 6 March.
const event = { startsAt: new Date('2027-03-06T04:00:00Z'), timezone: 'Africa/Dar_es_Salaam', kitProvided: false, participantFields: {} };
const ctx = over => ({ fields: effectiveFields(over.event ?? event, over.categories ?? []), category: over.category ?? { id: 'c1', minAge: null }, event: over.event ?? event, mode: over.mode ?? 'member', purchaserContacts: over.purchaserContacts ?? [], now: new Date('2026-10-22T10:00:00Z') });
const codes = r => r.problems.map(p => p.code);

test('effectiveFields: §3.3 defaults; DOB required once a category has minAge; kit size only when a kit is handed out; stored values win', () => {
  assert.deepEqual(effectiveFields(event, []), { phone: 'required', email: 'optional', dateOfBirth: 'off', gender: 'off', emergencyContact: 'optional', kitSize: 'off' });
  assert.equal(effectiveFields(event, [{ minAge: 18, status: 'active' }]).dateOfBirth, 'required');
  assert.equal(effectiveFields(event, [{ minAge: 18, status: 'inactive' }]).dateOfBirth, 'off');
  assert.equal(effectiveFields({ ...event, kitProvided: true }, []).kitSize, 'optional');
  assert.equal(effectiveFields({ ...event, participantFields: { gender: 'required', phone: 'optional' } }, []).gender, 'required');
  assert.equal(effectiveFields({ ...event, participantFields: { phone: 'optional' } }, []).phone, 'optional');
  // DOB cannot be switched off while an age rule exists
  assert.equal(effectiveFields({ ...event, participantFields: { dateOfBirth: 'off' } }, [{ minAge: 16, status: 'active' }]).dateOfBirth, 'required');
  assert.deepEqual(parseParticipantFields({ phone: 'off', bogus: 'required', gender: 'maybe' }), { phone: 'off' });
  assert.equal(parseParticipantFields('x'), undefined);
});

test('checkParticipant: names, contact, formats, consent basis per mode, warnings for fields that are off', () => {
  const ok = checkParticipant({ firstName: ' Asha ', lastName: 'Mollel', phone: '0712 345 678', email: 'ASHA@Example.com', consentBasis: 'purchaser_authorised' }, ctx({}));
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(ok.participant.firstName, 'Asha');
  assert.equal(ok.participant.phoneNormalized, '+255712345678');
  assert.equal(ok.participant.emailNormalized, 'asha@example.com');
  const bad = checkParticipant({ firstName: 'A1', lastName: '', phone: '12', email: 'nope', gender: 'x', kitSize: 'huge', emergencyContact: { name: 'M', phone: 'zz' }, consentBasis: 'organisation' }, ctx({ event: { ...event, participantFields: { gender: 'optional', kitSize: 'optional' } } }));
  assert.deepEqual(codes(bad).sort(), ['consent_basis_invalid', 'email_invalid', 'emergency_contact_invalid', 'gender_invalid', 'kit_size_invalid', 'name_invalid', 'phone_invalid', 'required'].sort());
  // a non-self row needs one contact
  assert.deepEqual(codes(checkParticipant({ firstName: 'A', lastName: 'B', consentBasis: 'purchaser_authorised' }, ctx({ event: { ...event, participantFields: { phone: 'optional' } } }))), ['contact_required']);
  // phone required by default
  assert.deepEqual(codes(checkParticipant({ firstName: 'A', lastName: 'B', email: 'a@b.co', consentBasis: 'purchaser_authorised' }, ctx({}))), ['required']);
  // a field that is off is dropped with a warning, never a refusal
  const off = checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', dateOfBirth: '1990-01-01', gender: 'male', consentBasis: 'purchaser_authorised' }, ctx({}));
  assert.equal(off.ok, true);
  assert.deepEqual(off.warnings.map(w => w.code), ['not_collected', 'not_collected']);
  assert.equal(off.participant.gender, null);
  // corporate rows must be organisation; member rows never
  assert.deepEqual(codes(checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', consentBasis: 'self' }, ctx({ mode: 'corporate' }))), ['consent_basis_invalid']);
  assert.equal(checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', consentBasis: 'organisation', groupLabel: ' Finance ' }, ctx({ mode: 'corporate' })).participant.groupLabel, 'Finance');
});

test('checkParticipant: a self row must carry one of the purchaser\'s verified contacts', () => {
  const mine = [{ type: 'phone', value: '+255712345678' }];
  assert.equal(checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', consentBasis: 'self' }, ctx({ purchaserContacts: mine })).ok, true);
  assert.deepEqual(codes(checkParticipant({ firstName: 'A', lastName: 'B', phone: '0799999999', consentBasis: 'self' }, ctx({ purchaserContacts: mine }))), ['self_contact_mismatch']);
  assert.deepEqual(codes(checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', consentBasis: 'self' }, ctx({ purchaserContacts: [] }))), ['self_contact_mismatch']);
});

test('age: computed on the event start day in the event timezone; a birthday on event day is eligible; DOB sanity rule', () => {
  assert.equal(localDateIn('Africa/Dar_es_Salaam', new Date('2027-03-05T22:30:00Z')), '2027-03-06'); // 01:30 EAT on the 6th
  assert.equal(ageOnEventDay('2009-03-06', event.startsAt, event.timezone), 18);
  assert.equal(ageOnEventDay('2009-03-07', event.startsAt, event.timezone), 17);
  const category = { id: 'c', minAge: 18 };
  const cats = [{ minAge: 18, status: 'active' }];
  const okRow = checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', dateOfBirth: '2009-03-06', consentBasis: 'purchaser_authorised' }, ctx({ category, categories: cats }));
  assert.equal(okRow.ok, true, JSON.stringify(okRow.problems));
  const young = checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', dateOfBirth: '2009-03-07', consentBasis: 'purchaser_authorised' }, ctx({ category, categories: cats }));
  assert.deepEqual(young.problems, [{ field: 'dateOfBirth', code: 'age_not_eligible', minAge: 18, ageOnEventDay: 17 }]);
  assert.deepEqual(codes(checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', consentBasis: 'purchaser_authorised' }, ctx({ category, categories: cats }))), ['required']);
  // required (policy) and dob_required are not both reported; without a policy requirement the age rule still asks
  const optionalDob = checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', consentBasis: 'purchaser_authorised' }, ctx({ category, event: { ...event, participantFields: { dateOfBirth: 'optional' } } }));
  assert.deepEqual(codes(optionalDob), ['dob_required']);
  assert.deepEqual(codes(checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', dateOfBirth: '03/05/2011', consentBasis: 'purchaser_authorised' }, ctx({ category, categories: cats }))), ['dob_invalid']);
  assert.deepEqual(codes(checkParticipant({ firstName: 'A', lastName: 'B', phone: '0712345678', dateOfBirth: '2030-01-01', consentBasis: 'purchaser_authorised' }, ctx({ category, categories: cats }))), ['dob_invalid']);
});

test('findDuplicatesInRequest: same normalised phone or email twice in one category flags the later row only', () => {
  const rows = [
    { categoryId: 'a', phoneNormalized: '+255712000001', emailNormalized: null },
    { categoryId: 'a', phoneNormalized: '+255712000002', emailNormalized: 'x@y.z' },
    { categoryId: 'a', phoneNormalized: '+255712000001', emailNormalized: null },
    { categoryId: 'b', phoneNormalized: '+255712000001', emailNormalized: null },
    { categoryId: 'a', phoneNormalized: null, emailNormalized: 'X@Y.Z'.toLowerCase() },
  ];
  assert.deepEqual(findDuplicatesInRequest(rows), [{ index: 2, otherIndex: 0, key: 'phone' }, { index: 4, otherIndex: 1, key: 'email' }]);
});

test('consent texts, masking, fingerprints, codes, tokens, closed reason set', () => {
  const c = consentTextFor('2026-10-draft');
  assert.equal(c.version, '2026-10-draft');
  for (const k of ['self', 'purchaser_authorised', 'organisation']) { assert.ok(c[k].en.length > 40); assert.ok(c[k].sw.length > 40); }
  assert.equal(maskName('Neema Abdallah'), 'N**** A*******');
  assert.equal(maskFirstName('Asha'), 'A***');
  assert.equal(lastInitial('mollel'), 'M.');
  assert.deepEqual(maskContactShort({ phone: '+255712345678' }), { type: 'phone', masked: '••• 678' });
  assert.deepEqual(maskContactShort({ email: 'asha@example.com' }), { type: 'email', masked: 'a•••@example.com' });
  assert.equal(canonicalFingerprint({ a: 1, b: [{ d: 2, c: 3 }] }), canonicalFingerprint({ b: [{ c: 3, d: 2 }], a: 1 }));
  assert.notEqual(canonicalFingerprint({ a: 1 }), canonicalFingerprint({ a: 2 }));
  assert.ok(IDEMPOTENCY_KEY_RE.test('chk_0123456789abcdef'));
  assert.ok(!IDEMPOTENCY_KEY_RE.test('short'));
  assert.ok(!IDEMPOTENCY_KEY_RE.test('has space key'));
  const code = newJoinCode();
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(normaliseJoinCode(formatJoinCode(code).toLowerCase()), code);
  assert.equal(normaliseJoinCode('AB12-CD3O'), null); // O is not in the alphabet
  const token = newClaimToken();
  assert.ok(isClaimTokenShape(token));
  assert.equal(hashToken(token).length, 64);
  assert.ok(!isClaimTokenShape('abc'));
  assert.deepEqual([...MEMBER_CANCEL_REASONS], ['changed_mind', 'wrong_details', 'duplicate', 'other']);
});

test('roster parsing: header aliases in any order, no-header column order, DD/MM/YYYY dates, category by name or distance', () => {
  const rows = parseRosterText('Surname,Given name,Mobile,DOB,Distance,Department\nMollel,Asha,0712 345 678,05/03/1990,10K,Finance\n"Juma, Jr",Baraka,,1992-01-01,21km,Ops');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { line: 2, lastName: 'Mollel', firstName: 'Asha', phone: '0712 345 678', dateOfBirth: '05/03/1990', category: '10K', group: 'Finance' });
  assert.equal(rows[1].lastName, 'Juma, Jr');
  const bare = parseRosterText('Asha,Mollel,0712345678,,10K');
  assert.deepEqual(bare[0], { line: 1, firstName: 'Asha', lastName: 'Mollel', phone: '0712345678', category: '10K' });
  assert.equal(normaliseRosterDate('05/03/1990'), '1990-03-05');
  assert.equal(normaliseRosterDate('1990-03-05'), '1990-03-05');
  const categories = [{ id: 'a', name: '10K Fun Run', distanceMeters: 10000, status: 'active' }, { id: 'b', name: 'Half Marathon', distanceMeters: 21097, status: 'active' }, { id: 'c', name: 'Old 5K', distanceMeters: 5000, status: 'inactive' }];
  assert.equal(matchCategory('half marathon', categories)?.id, 'b');
  assert.equal(matchCategory('10K', categories)?.id, 'a');
  assert.equal(matchCategory('21 km', categories)?.id, 'b');
  assert.equal(matchCategory('21.1km', categories)?.id, 'b');
  assert.equal(matchCategory('5k', categories), null); // inactive categories never match
  assert.equal(matchCategory('42K', categories), null);
});

test('configuration readers: fee rule and organisation discounts parse strictly; defaults otherwise', () => {
  assert.deepEqual(eventsFeeRule(), { type: 'none' });
  assert.equal(feeLabelFor(eventsFeeRule()), null);
  process.env.EVENTS_FEE_RULE = '{"type":"percent","pct":5,"minTzs":500}';
  assert.deepEqual(eventsFeeRule(), { type: 'percent', pct: 5, minTzs: 500, maxTzs: null });
  assert.deepEqual(feeLabelFor(eventsFeeRule()), { en: 'Service fee', sw: 'Ada ya huduma' });
  const q = quoteLines([{ id: 't', priceTzs: 20000 }], [{ ticketTypeId: 't', quantity: 2 }], { feeRule: eventsFeeRule() });
  assert.equal(q.feesTzs, 2000); assert.equal(q.totalTzs, 42000);
  process.env.EVENTS_FEE_RULE = '{"type":"percent","pct":500}';
  assert.equal(eventsFeeRule().error, 'invalid_fee_rule');
  process.env.EVENTS_FEE_RULE = 'not json';
  assert.equal(eventsFeeRule().error, 'invalid_config');
  assert.deepEqual(eventsOrgDiscounts(), {});
  process.env.EVENTS_ORG_DISCOUNTS = '{"org_1":{"pct":10}}';
  assert.deepEqual(eventsOrgDiscounts(), { org_1: { pct: 10 } });
  process.env.EVENTS_ORG_DISCOUNTS = '{"org_1":{"pct":150}}';
  assert.equal(eventsOrgDiscounts().error, 'invalid_config');
  assert.equal(eventsMaxParticipantsPerOrder(), 10);
  process.env.EVENTS_MAX_PARTICIPANTS_PER_ORDER = '3';
  assert.equal(eventsMaxParticipantsPerOrder(), 3);
  assert.equal(eventsConsentTextVersion(), '2026-10-draft');
});
