// Marathon & running events · S2 — the pure rules: derived organizer status and permissions, staff role
// rules, document parsing / validation codes, material-change detection, availability, timezone info,
// allowed actions. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { organizerStatusOf, permissionsFor, removalRefusal, roleChangeRefusal, INVITABLE_ORGANIZER_ROLES } from '../src/shared/events-organizer.mjs';
import {
  parseEventPatch, validateEvent, changedPaths, materialChanges, availabilityOf, ticketAvailability, categoryAvailability, tzInfo, slugify, distanceBucket,
  allowedActionsFor, summaryView, detailView, REGIONS, REGION_CODES, UNLIMITED_CAPACITY,
} from '../src/shared/events-document.mjs';
import { eventsClosingSoonHours, eventAutoCompleteGraceHours } from '../src/shared/feature-flags.mjs';

const H = 3_600_000;
const D = 24 * H;
const NOW = new Date('2027-01-10T09:00:00Z');
const codesOf = fields => Object.fromEntries(fields.map(f => [f.path, f.code]));

test('organizer status is derived from the KYC case exactly as spec §2 says', () => {
  const map = { draft: 'draft', submitted: 'pending_review', in_review: 'pending_review', info_requested: 'pending_review', approved: 'active', rejected: 'rejected', suspended: 'suspended' };
  for (const [kyc, organizer] of Object.entries(map)) assert.equal(organizerStatusOf({ status: kyc }), organizer, kyc);
  assert.equal(organizerStatusOf(null), 'draft');
  assert.equal(organizerStatusOf({ status: 'weird' }), 'draft');
});

test('permissions follow role and status; staff role rules (owner-only removals of admins, never the owner)', () => {
  assert.deepEqual(permissionsFor('owner', 'draft'), ['overview', 'onboarding']);
  assert.deepEqual(permissionsFor('owner', 'active'), ['overview', 'onboarding', 'events:read', 'events:write', 'staff']);
  assert.deepEqual(permissionsFor('admin', 'active'), ['overview', 'events:read', 'events:write', 'staff']);
  assert.deepEqual(permissionsFor('ops', 'active'), ['overview', 'events:read']);
  assert.deepEqual(permissionsFor('admin', 'suspended'), ['overview', 'events:read']);
  assert.deepEqual(permissionsFor('owner', 'rejected'), ['overview', 'onboarding']);
  assert.equal(removalRefusal('owner', 'admin'), null);
  assert.equal(removalRefusal('owner', 'owner'), 'cannot_remove_owner');
  assert.equal(removalRefusal('admin', 'admin'), 'forbidden_role');
  assert.equal(removalRefusal('admin', 'ops'), null);
  assert.equal(removalRefusal('ops', 'timing'), 'forbidden_role');
  assert.equal(roleChangeRefusal('owner', 'ops', 'owner'), 'invalid_role');
  assert.equal(roleChangeRefusal('admin', 'admin', 'ops'), 'forbidden_role');
  assert.equal(roleChangeRefusal('owner', 'ops', 'admin'), null);
  assert.deepEqual([...INVITABLE_ORGANIZER_ROLES], ['admin', 'ops', 'finance', 'timing']);
});

test('parseEventPatch keeps only the document fields and never forwards status, slug, version or snapshots', () => {
  const { patch, nested, changeNote } = parseEventPatch({
    title: ' Dar Half ', type: 'road', status: 'published', slug: 'hack', version: 9, publishedAt: 'x', termsSnapshot: { en: 'x' }, refundPolicySnapshot: {},
    description: { en: 'E', sw: 'S' }, venue: { name: 'Coco', address: 'Toure Dr', city: 'Dar', region: 'dar-es-salaam', lat: -6.75, lng: 39.27 },
    coverAlt: 'Runners at dawn', contact: { email: 'a@b.co' }, refundPolicy: { preset: 'no_refund' },
    categories: [{ name: '21K', distanceM: 21097, ticketTypes: [{ name: 'Early', priceTzs: 25000, capacity: null }] }],
    collectionPoints: [{ name: 'Expo', address: 'Mlimani', windows: [{ opensAt: '2027-03-05T06:00:00Z', closesAt: '2027-03-05T15:00:00Z' }], instructions: { en: 'Bring ID', sw: 'Leta kitambulisho' } }],
    changeNote: { en: 'Moved start', sw: 'Kuanza kumehamishwa' }, nonsense: 1,
  });
  assert.equal(patch.title, 'Dar Half');
  assert.equal(patch.eventType, 'road');
  assert.equal(patch.description, 'E'); assert.equal(patch.descriptionSw, 'S');
  assert.equal(patch.venueName, 'Coco'); assert.equal(patch.venueRegion, 'dar-es-salaam'); assert.equal(patch.lat, -6.75);
  assert.equal(patch.heroImageAlt, 'Runners at dawn');
  assert.deepEqual(patch.contact, { email: 'a@b.co', phone: null, whatsapp: null });
  for (const k of ['status', 'slug', 'version', 'publishedAt', 'termsSnapshot', 'refundPolicySnapshot', 'nonsense']) assert.equal(k in patch, false, k);
  assert.equal(nested.categories[0].distanceM, 21097);
  assert.equal(nested.categories[0].ticketTypes[0].capacity, null);
  assert.equal(nested.collectionPoints[0].windows.length, 1);
  assert.deepEqual(changeNote, { en: 'Moved start', sw: 'Kuanza kumehamishwa' });
});

test('validateEvent: patch mode checks only what is present; submit mode runs the full checklist with spec §10 codes', () => {
  const starts = new Date(+NOW + 10 * D); const ends = new Date(+starts + 6 * H);
  assert.deepEqual(validateEvent({ title: 'Dar Half', eventType: 'road' }, { mode: 'patch', now: NOW }), []);
  const bad = validateEvent({
    title: 'ab', eventType: 'nope', description: 'short', timezone: 'Mars/Olympus', startsAt: starts, endsAt: new Date(+starts - H),
    registrationOpensAt: new Date(+starts), registrationClosesAt: new Date(+starts - D), heroImageUrl: 'https://x/y.webp', routeUrl: 'http://insecure',
    accessibility: { en: 'Step-free', sw: '' }, venueRegion: 'atlantis', lat: 200,
    categories: [
      { name: '5K', distanceMeters: 100, startTime: new Date(+starts + 10 * D), capacity: 0, minAge: 3, ticketTypes: [{ name: 'A', priceTzs: 10.5, minPerOrder: 5, maxPerOrder: 2 }, { name: 'a', priceTzs: 0 }] },
      { name: '5k', distanceMeters: 5000, ticketTypes: [] },
    ],
    contact: { email: 'not-an-email', phone: '12' }, sponsors: [{ name: '', url: 'ftp://x' }],
    schedule: [{ at: new Date(+starts - 30 * D), label: { en: 'Expo', sw: '' } }],
  }, { mode: 'patch', now: NOW });
  const codes = codesOf(bad);
  assert.equal(codes.title, 'length');
  assert.equal(codes.type, 'required');
  assert.equal(codes['description.en'], 'length');
  assert.equal(codes.timezone, 'required');
  assert.equal(codes.endsAt, 'endAfterStart');
  assert.equal(codes.registrationClosesAt, 'endAfterStart');
  assert.equal(codes.heroImageAlt, 'altRequired');
  assert.equal(codes.routeUrl, 'httpsOnly');
  assert.equal(codes.accessibility, 'bothLanguages');
  assert.equal(codes['venue.region'], 'required');
  assert.equal(codes['venue.lat'], 'range');
  assert.equal(codes['categories[0].distanceM'], 'range');
  assert.equal(codes['categories[0].startsAt'], 'withinEvent');
  assert.equal(codes['categories[0].capacity'], 'range');
  assert.equal(codes['categories[0].minAge'], 'range');
  assert.equal(codes['categories[0].ticketTypes[0].priceTzs'], 'wholeShillings');
  assert.equal(codes['categories[0].ticketTypes[0].maxPerOrder'], 'maxGteMin');
  assert.equal(codes['categories[0].ticketTypes[1].name'], 'unique');
  assert.equal(codes['categories[1].name'], 'unique');
  assert.equal(codes['contact.email'], 'email');
  assert.equal(codes['contact.phone'], 'phone');
  assert.equal(codes['sponsors[0].name'], 'required');
  assert.equal(codes['sponsors[0].url'], 'httpsOnly');
  assert.equal(codes['schedule[0].at'], 'withinEvent');
  assert.equal(codes['schedule[0].label'], 'bothLanguages');
  // Patch mode never asks for what is absent.
  assert.equal(codes.categories, undefined);
  assert.equal(codes['categories[1].ticketTypes'], undefined);

  const empty = codesOf(validateEvent({ title: 'Dar Half', eventType: 'road', kitProvided: true }, { mode: 'submit', now: NOW }));
  assert.equal(empty['description.en'], 'required');
  assert.equal(empty['description.sw'], 'required');
  assert.equal(empty.startsAt, 'required');
  assert.equal(empty.registrationClosesAt, 'required');
  assert.equal(empty['venue.name'], 'required');
  assert.equal(empty['venue.lat'], 'pinRequired');
  assert.equal(empty.categories, 'minCategory');
  assert.equal(empty.collectionPoints, 'required');
  assert.equal(empty['terms.en'], 'required');
  assert.equal(empty['refundPolicy.preset'], 'required');
  assert.equal(empty['contact.email'], 'required');
  const soon = codesOf(validateEvent({ startsAt: new Date(+NOW + 2 * H), endsAt: new Date(+NOW + 10 * D) }, { mode: 'submit', now: NOW }));
  assert.equal(soon.startsAt, 'startsTooSoon');
  assert.equal(soon.endsAt, 'tooLong');
  const minTicket = codesOf(validateEvent({ categories: [{ name: '10K', distanceMeters: 10000, ticketTypes: [] }] }, { mode: 'submit', now: NOW }));
  assert.equal(minTicket['categories[0].ticketTypes'], 'minTicket');
  // A virtual event needs no venue.
  const virtual = codesOf(validateEvent({ eventType: 'virtual' }, { mode: 'submit', now: NOW }));
  assert.equal(virtual['venue.name'], undefined);
  assert.equal(virtual['venue.lat'], undefined);
});

test('material changes (§7.4): dates, venue, route, distances, start times, prices, close date and refund policy; not descriptions or sponsors', () => {
  const base = {
    title: 'Dar Half', startsAt: '2027-03-06T04:00:00.000Z', endsAt: '2027-03-06T10:00:00.000Z', timezone: 'Africa/Dar_es_Salaam', registrationClosesAt: '2027-03-05T04:00:00.000Z',
    venue: { name: 'Coco', address: 'Toure', city: 'Dar', region: 'dar-es-salaam', lat: -6.75, lng: 39.27 }, description: { en: 'A', sw: 'B' },
    refundPolicy: { preset: 'no_refund', text: { en: null, sw: null } }, sponsors: [], schedule: [],
    categories: [{ id: 'c1', name: '21K', distanceM: 21097, startsAt: '2027-03-06T04:00:00.000Z', ticketTypes: [{ id: 't1', name: 'Early', priceTzs: 25000 }] }],
  };
  const minor = { ...base, description: { en: 'A longer text', sw: 'B' }, sponsors: [{ name: 'Vodacom', url: 'https://v.co' }] };
  assert.deepEqual(materialChanges(base, minor), []);
  assert.deepEqual(changedPaths(base, minor), ['description.en', 'sponsors']);
  const moved = { ...base, startsAt: '2027-03-07T04:00:00.000Z', venue: { ...base.venue, name: 'Leaders Club' } };
  assert.deepEqual(materialChanges(base, moved), ['startsAt', 'venue.name']);
  const repriced = { ...base, categories: [{ ...base.categories[0], ticketTypes: [{ id: 't1', name: 'Early bird', priceTzs: 30000 }] }] };
  assert.deepEqual(materialChanges(base, repriced), ['categories[c1].ticketTypes[t1].priceTzs']);
  const longer = { ...base, categories: [{ ...base.categories[0], distanceM: 21100 }] };
  assert.deepEqual(materialChanges(base, longer), ['categories[c1].distanceM']);
  const policy = { ...base, refundPolicy: { preset: 'refund_until_close', text: { en: null, sw: null } } };
  assert.deepEqual(materialChanges(base, policy), ['refundPolicy']);
  // Reordering rows is not a change.
  const two = { ...base, categories: [base.categories[0], { id: 'c2', name: '5K', distanceM: 5000, ticketTypes: [] }] };
  assert.deepEqual(changedPaths(two, { ...two, categories: [...two.categories].reverse() }), []);
});

test('availability: status first, then registration window, sold-out, closing-soon (configurable hours) and open', () => {
  const closes = new Date(+NOW + 10 * D);
  const published = { status: 'published', registrationOpensAt: null, registrationClosesAt: closes };
  const tt = (over = {}) => ({ capacity: 10, sold: 0, held: 0, status: 'active', ...over });
  assert.equal(availabilityOf({ status: 'cancelled' }, [tt()], { now: NOW }), 'cancelled');
  assert.equal(availabilityOf({ status: 'in_progress' }, [tt()], { now: NOW }), 'in_progress');
  assert.equal(availabilityOf({ status: 'completed' }, [tt()], { now: NOW }), 'completed');
  assert.equal(availabilityOf({ status: 'registration_closed' }, [tt()], { now: NOW }), 'closed');
  assert.equal(availabilityOf({ status: 'draft' }, [tt()], { now: NOW }), 'closed');
  assert.equal(availabilityOf(published, [tt()], { now: NOW }), 'open');
  assert.equal(availabilityOf({ ...published, registrationOpensAt: new Date(+NOW + D) }, [tt()], { now: NOW }), 'not_yet_open');
  assert.equal(availabilityOf({ ...published, registrationClosesAt: new Date(+NOW - H) }, [tt()], { now: NOW }), 'closed');
  assert.equal(availabilityOf(published, [tt({ sold: 7, held: 3 }), tt({ saleClosesAt: new Date(+NOW - H) })], { now: NOW }), 'sold_out');
  assert.equal(availabilityOf(published, [tt({ sold: 10 }), tt()], { now: NOW }), 'open');
  assert.equal(availabilityOf({ ...published, registrationClosesAt: new Date(+NOW + 48 * H) }, [tt()], { now: NOW }), 'closing_soon');
  assert.equal(availabilityOf({ ...published, registrationClosesAt: new Date(+NOW + 48 * H) }, [tt()], { now: NOW, closingSoonHours: 24 }), 'open');
  assert.equal(availabilityOf({ ...published, registrationClosesAt: new Date(+NOW + 100 * H) }, [tt()], { now: NOW, closingSoonHours: 120 }), 'closing_soon');
  // Ticket-type and category level.
  assert.equal(ticketAvailability(tt({ sold: 10 }), { now: NOW }), 'sold_out');
  assert.equal(ticketAvailability(tt({ saleOpensAt: new Date(+NOW + D) }), { now: NOW }), 'not_yet_open');
  assert.equal(ticketAvailability(tt({ saleClosesAt: new Date(+NOW + 2 * H) }), { now: NOW }), 'closing_soon');
  assert.equal(ticketAvailability(tt(), { now: NOW, registrationClosesAt: closes }), 'open');
  assert.equal(categoryAvailability('open', [tt({ sold: 10 }), tt({ saleOpensAt: new Date(+NOW + D) })], { now: NOW }), 'not_yet_open');
  assert.equal(categoryAvailability('open', [tt({ sold: 10 })], { now: NOW }), 'sold_out');
  assert.equal(categoryAvailability('closing_soon', [tt()], { now: NOW }), 'closing_soon');
  assert.equal(categoryAvailability('closed', [tt()], { now: NOW }), 'closed');
  // The env-configured values.
  const saved = { c: process.env.EVENTS_CLOSING_SOON_HOURS, g: process.env.EVENT_AUTO_COMPLETE_GRACE_HOURS };
  try {
    delete process.env.EVENTS_CLOSING_SOON_HOURS; delete process.env.EVENT_AUTO_COMPLETE_GRACE_HOURS;
    assert.equal(eventsClosingSoonHours(), 72); assert.equal(eventAutoCompleteGraceHours(), 6);
    process.env.EVENTS_CLOSING_SOON_HOURS = '24'; process.env.EVENT_AUTO_COMPLETE_GRACE_HOURS = '0';
    assert.equal(eventsClosingSoonHours(), 24); assert.equal(eventAutoCompleteGraceHours(), 0);
    process.env.EVENTS_CLOSING_SOON_HOURS = 'nope';
    assert.equal(eventsClosingSoonHours(), 72);
  } finally {
    if (saved.c === undefined) delete process.env.EVENTS_CLOSING_SOON_HOURS; else process.env.EVENTS_CLOSING_SOON_HOURS = saved.c;
    if (saved.g === undefined) delete process.env.EVENT_AUTO_COMPLETE_GRACE_HOURS; else process.env.EVENT_AUTO_COMPLETE_GRACE_HOURS = saved.g;
  }
});

test('tzInfo from Intl only: Dar is UTC+3 EAT, London shifts with DST, an unknown zone falls back to UTC', () => {
  assert.deepEqual(tzInfo('Africa/Dar_es_Salaam', new Date('2027-03-06T04:00:00Z')), { utcOffsetMinutes: 180, timezoneAbbr: 'EAT' });
  assert.deepEqual(tzInfo('Africa/Johannesburg', new Date('2027-03-06T04:00:00Z')), { utcOffsetMinutes: 120, timezoneAbbr: 'SAST' });
  assert.equal(tzInfo('Europe/London', new Date('2027-01-10T12:00:00Z')).utcOffsetMinutes, 0);
  assert.equal(tzInfo('Europe/London', new Date('2027-07-10T12:00:00Z')).utcOffsetMinutes, 60);
  assert.equal(tzInfo('America/New_York', new Date('2027-01-10T12:00:00Z')).utcOffsetMinutes, -300);
  assert.deepEqual(tzInfo('Mars/Olympus', NOW), { utcOffsetMinutes: 0, timezoneAbbr: 'UTC' });
});

test('slugs, distance buckets and regions', () => {
  assert.equal(slugify('Dar Half Marathon 2027!'), 'dar-half-marathon-2027');
  assert.equal(slugify('Mbio za Kilimanjaro — 42K'), 'mbio-za-kilimanjaro-42k');
  assert.match(slugify('ab'), /^event-ab$/);
  assert.equal(distanceBucket(5000), '5k'); assert.equal(distanceBucket(10000), '10k'); assert.equal(distanceBucket(21097), '21k'); assert.equal(distanceBucket(42195), '42k'); assert.equal(distanceBucket(15000), 'other');
  assert.equal(REGIONS.length, 31);
  assert.ok(REGION_CODES.includes('dar-es-salaam') && REGION_CODES.includes('kilimanjaro'));
  assert.deepEqual(REGIONS.find(r => r.code === 'dar-es-salaam').name, { en: 'Dar es Salaam', sw: 'Dar es Salaam' });
  // The Zanzibar regions carry their Swahili names.
  assert.deepEqual(REGIONS.find(r => r.code === 'pemba-north').name, { en: 'Pemba North', sw: 'Kaskazini Pemba' });
  assert.deepEqual(REGIONS.find(r => r.code === 'pemba-south').name, { en: 'Pemba South', sw: 'Kusini Pemba' });
  assert.deepEqual(REGIONS.find(r => r.code === 'unguja-north').name, { en: 'Unguja North', sw: 'Kaskazini Unguja' });
  assert.deepEqual(REGIONS.find(r => r.code === 'unguja-south').name, { en: 'Unguja South', sw: 'Kusini Unguja' });
});

test('allowed actions per status and actor (§7.2); nothing for suspended organizers or non-editor roles', () => {
  const org = (status, role = 'owner', organizerStatus = 'active') => allowedActionsFor({ status, actor: 'organizer', role, organizerStatus });
  assert.deepEqual(org('draft'), ['edit', 'submit', 'delete']);
  assert.deepEqual(org('submitted'), ['withdraw']);
  assert.deepEqual(org('published'), ['edit', 'cancel']);
  assert.deepEqual(org('registration_closed', 'admin'), ['edit', 'cancel']);
  assert.deepEqual(org('in_progress'), ['complete', 'cancel']);
  assert.deepEqual(org('completed'), ['archive']);
  assert.deepEqual(org('cancelled'), ['archive']);
  assert.deepEqual(org('archived'), []);
  assert.deepEqual(org('draft', 'ops'), []);
  assert.deepEqual(org('draft', 'owner', 'suspended'), []);
  assert.deepEqual(org('draft', 'owner', 'pending_review'), []);
  const admin = status => allowedActionsFor({ status, actor: 'admin' });
  assert.deepEqual(admin('submitted'), ['approve', 'reject']);
  assert.deepEqual(admin('draft'), []);
  assert.deepEqual(admin('published'), ['edit', 'cancel']);
  assert.deepEqual(admin('in_progress'), ['complete', 'cancel']);
  assert.deepEqual(admin('cancelled'), ['archive']);
});

test('views: summary and detail carry the §14 fields, unlimited capacity shows as null, snapshots win on the public detail', () => {
  const joined = {
    event: {
      id: 'evt_1', slug: 'dar-half', title: 'Dar Half', eventType: 'road', status: 'published', startsAt: '2027-03-06T04:00:00.000Z', endsAt: '2027-03-06T10:00:00.000Z',
      timezone: 'Africa/Dar_es_Salaam', registrationOpensAt: null, registrationClosesAt: '2027-03-05T04:00:00.000Z', venueName: 'Coco', venueCity: 'Dar', venueRegion: 'dar-es-salaam',
      heroImageUrl: 'https://img/full.webp', heroThumbUrl: null, heroImageAlt: 'Runners', description: 'E', descriptionSw: 'S', updatedAt: '2027-01-01T00:00:00.000Z', version: 3,
      terms: { en: 'working', sw: 'kazi' }, termsSnapshot: { en: 'frozen', sw: 'imegandishwa' }, refundPolicy: { preset: 'custom', text: { en: 'x', sw: 'y' } }, refundPolicySnapshot: { preset: 'no_refund', text: {} },
      contact: { email: 'a@b.co' }, publishedAt: '2027-01-02T00:00:00.000Z',
    },
    categories: [
      { id: 'c1', name: '21K', distanceMeters: 21097, startTime: '2027-03-06T04:00:00.000Z', capacity: 12, eligibility: {}, status: 'active', ticketTypes: [
        { id: 't1', name: 'Early', priceTzs: 25000, currency: 'TZS', capacity: UNLIMITED_CAPACITY, sold: 5, held: 0, minPerOrder: 1, maxPerOrder: 10, status: 'active' },
        { id: 't2', name: 'Std', priceTzs: 30000, currency: 'TZS', capacity: 10, sold: 0, held: 0, minPerOrder: 1, maxPerOrder: 10, status: 'inactive' },
      ] },
      { id: 'c2', name: 'Old', distanceMeters: 5000, status: 'inactive', ticketTypes: [{ id: 't3', name: 'X', priceTzs: 1000, capacity: 1, sold: 0, held: 0, status: 'active' }] },
    ],
    collectionPoints: [], organizer: { id: 'evo_1', name: 'Dar Runners', status: 'active' },
  };
  const s = summaryView(joined, { now: NOW, saved: true });
  assert.equal(s.availability, 'open');
  assert.equal(s.utcOffsetMinutes, 180); assert.equal(s.timezoneAbbr, 'EAT');
  assert.deepEqual(s.distancesM, [21097]);
  assert.equal(s.fromPriceTzs, 25000);
  assert.equal(s.heroThumbUrl, 'https://img/full.webp');
  assert.deepEqual(s.organizer, { id: 'evo_1', name: 'Dar Runners', verified: true });
  assert.equal(s.isSaved, true);
  assert.equal('isSaved' in summaryView(joined, { now: NOW }), false);
  const d = detailView(joined, { now: NOW, shareUrl: 'https://app/events/dar-half' });
  assert.equal(d.categories.length, 1);
  assert.equal(d.categories[0].ticketTypes.length, 1);
  assert.equal(d.categories[0].ticketTypes[0].capacity, null);
  assert.equal(d.categories[0].remaining, 7);
  assert.deepEqual(d.terms, { en: 'frozen', sw: 'imegandishwa' });
  assert.equal(d.refundPolicy.preset, 'no_refund');
  assert.equal(d.coverAlt, 'Runners');
  assert.equal(d.shareUrl, 'https://app/events/dar-half');
  assert.deepEqual(d.description, { en: 'E', sw: 'S' });
});
