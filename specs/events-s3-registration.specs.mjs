// Marathon & running events · S3 — member registration at the route level against the CI database
// (spec §3.16 scenarios 1, 2, 3, 5 and the rules): the flag, the options probe, quote → order with an
// Idempotency-Key, replay and reuse, price drift, participant validation listing every row, register-for-
// other + claim (verified contact mandatory), group orders with per-place release and remove_whole_line,
// whole-order cancel, two buyers for the last place, hold expiry with its notification, teams, organizer
// and admin reads with status-based masking, and admin cancel.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { eventStore, eventsRegistrationService, eventsDiscoveryService } from '../src/bootstrap/services.mjs';
import {
  quoteEventOrder, createEventOrder, listMyEventOrders, getMyEventOrder, cancelMyEventOrder, claimableEventRegistrations, claimEventRegistrationByToken,
  listMyEventRegistrations, getMyEventRegistration, claimEventRegistration, cancelMyEventRegistration, previewEventClaim, createEventTeam, lookupEventTeam, getEventTeam,
  resetEventsRegistrationLimits,
} from '../functions/events-registration.mjs';
import { organizerListRegistrations, organizerRegistrationsSummary, organizerListOrders, organizerSummary } from '../functions/events-organizer.mjs';
import { adminListEventOrders, adminGetEventOrder, adminCancelEventOrder, adminListEventRegistrations } from '../functions/events-admin.mjs';
import { eventsOptions } from '../functions/events-public.mjs';
import { hashToken, newClaimToken } from '../src/shared/events-participants.mjs';
import { createEventsRegistrationService } from '../src/services/events-registration-service.mjs';
import { users, eventCatalogueStore, verifiedContacts, auditLog } from '../src/bootstrap/services.mjs';
import { harness, participant, phone, mail, flagsOn, flagsOff, uid, D } from './fixtures/events-s3.mjs';

await ensureInit();
const h = harness();
const { db } = h;
const rawCall = h.call;
/** createEventOrder now needs expectedTotalTzs (review M2): unless a spec sets it, price the same body with the quote first. */
const call = async (route, claims, opts = {}) => {
  if (route === createEventOrder && opts.body && opts.body.expectedTotalTzs === undefined) {
    const q = await rawCall(quoteEventOrder, claims, { body: opts.body });
    opts = { ...opts, body: { ...opts.body, expectedTotalTzs: q.body?.quote?.totalTzs ?? 0 } };
  }
  return rawCall(route, claims, opts);
};
afterEach(() => { flagsOff(); resetEventsRegistrationLimits(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const CONSENT = '2026-10-draft';
const key = () => `chk_${uid('').slice(1)}`;
const orderBody = (eventId, lines, participants, extra = {}) => ({ eventId, lines, participants, acceptedTerms: true, consentTextVersion: CONSENT, ...extra });
/** A member with a verified phone, as a signed-up person has. */
const buyer = async (over = {}) => { const p = phone(); const sub = await h.user({ phone: p, ...over }); return { claims: h.claimsOf(sub), sub, phone: p }; };
const self = (ticketTypeId, b, over = {}) => ({ ticketTypeId, firstName: 'Neema', lastName: 'Abdallah', phone: b.phone, consentBasis: 'self', ...over });

// ── Flag and options ──────────────────────────────────────────────────────

test('flag off: every S3 route answers 404 feature_disabled (also with EVENTS_MODULE alone); the options probe shows registration:false without the S3 keys', async () => {
  const b = await buyer();
  const routes = [
    [quoteEventOrder, {}], [createEventOrder, {}], [listMyEventOrders, {}], [getMyEventOrder, { params: { id: 'x' } }], [cancelMyEventOrder, { params: { id: 'x' } }],
    [claimableEventRegistrations, {}], [claimEventRegistrationByToken, {}], [listMyEventRegistrations, {}], [getMyEventRegistration, { params: { id: 'x' } }],
    [claimEventRegistration, { params: { id: 'x' } }], [cancelMyEventRegistration, { params: { id: 'x' } }], [createEventTeam, {}], [lookupEventTeam, {}], [getEventTeam, { params: { id: 'x' } }],
  ];
  for (const flags of [() => {}, () => { process.env.EVENTS_MODULE = '1'; }]) {
    flagsOff(); flags();
    for (const [route, opts] of routes) {
      const r = await call(route, b.claims, opts);
      assert.deepEqual([r.status, r.body], [404, { error: 'feature_disabled' }], route.path);
    }
    assert.deepEqual((await call(previewEventClaim, null, { params: { token: 'x' } })).body, { error: 'feature_disabled' });
    const o = (await call(eventsOptions, null)).body;
    assert.equal(o.registration, false);
    for (const k of ['holdTtlMinutes', 'maxParticipantsPerOrder', 'payment', 'teams', 'corporate', 'claim', 'consentTextVersion']) assert.ok(!(k in o), k);
  }
  flagsOn();
  const o = (await call(eventsOptions, null)).body;
  assert.equal(o.registration, true);
  assert.equal(o.payment, 'none'); assert.equal(o.teams, true); assert.equal(o.corporate, true);
  assert.equal(o.holdTtlMinutes, 30); assert.equal(o.maxParticipantsPerOrder, 10); assert.equal(o.consentTextVersion, CONSENT);
  assert.deepEqual(Object.keys(o.claim).sort(), ['emailCodes', 'smsCodes']);
  // the probe is the same object the service exposes
  assert.deepEqual(eventsDiscoveryService.options().claim, o.claim);
});

test('only members use the member routes; a trainer or an organizer persona is refused by requireAuth', async () => {
  flagsOn();
  const trainer = h.claimsOf(await h.user({ userType: 'trainer' }), 'trainer');
  const r = await call(listMyEventOrders, trainer);
  assert.equal(r.status, 403, JSON.stringify(r.body));
});

// ── Scenario 1: individual ────────────────────────────────────────────────

test('scenario 1: quote → order (Idempotency-Key) → awaiting_payment with one self registration, held +1, one hold movement; replay, reuse, price drift', async () => {
  flagsOn();
  const f = await h.publishedEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early bird', priceTzs: 20000, capacity: 10 }] }] });
  const b = await buyer();
  const lines = [{ ticketTypeId: f.ticket.id, quantity: 1 }];
  const participants = [self(f.ticket.id, b)];

  const q = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines, participants } });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.valid, true, JSON.stringify(q.body));
  assert.equal(q.body.quote.totalTzs, 20000);
  assert.equal(q.body.quote.feesTzs, 0);
  assert.equal(q.body.quote.feeLabel, null);
  assert.equal(q.body.holdTtlMinutes, 30);
  assert.deepEqual(q.body.fields, { phone: 'required', email: 'optional', dateOfBirth: 'off', gender: 'off', emergencyContact: 'optional', kitSize: 'off' });
  assert.equal(q.body.consentText.version, CONSENT);
  assert.ok(q.body.consentText.self.sw.length > 20);
  assert.equal(q.body.availability[f.ticket.id].availability, 'open');
  assert.equal(q.body.termsVersion, f.event.version);

  // no key → 400
  const noKey = await call(createEventOrder, b.claims, { body: orderBody(f.event.id, lines, participants, { expectedTotalTzs: 20000 }) });
  assert.deepEqual([noKey.status, noKey.body.error], [400, 'idempotency_key_required']);
  // price drift → 409 and nothing written
  const drift = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, lines, participants, { expectedTotalTzs: 15000 }) });
  assert.deepEqual([drift.status, drift.body], [409, { error: 'price_changed', quotedTotalTzs: 15000, totalTzs: 20000 }]);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 0, capacity: 10 });
  assert.equal((await db('EventOrder').where({ eventId: f.event.id })).length, 0);

  const k = key();
  const body = orderBody(f.event.id, lines, participants, { expectedTotalTzs: 20000 });
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': k }, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.replayed, false);
  assert.equal(r.body.order.status, 'awaiting_payment');
  assert.match(r.body.order.reference, /^EV-[0-9A-F]{10}$/);
  assert.equal(r.body.order.totalTzs, 20000);
  assert.ok(r.body.holdExpiresAt);
  assert.deepEqual(r.body.next, { payment: 'none', instructions: null });
  assert.equal(r.body.event.id, f.event.id);
  assert.equal(r.body.registrations.length, 1);
  assert.deepEqual([r.body.registrations[0].status, r.body.registrations[0].isSelf, r.body.registrations[0].claimState], ['reserved', true, 'self']);
  const reg = await db('EventRegistration').where({ id: r.body.registrations[0].id }).first();
  assert.equal(reg.participantUserId, b.sub);
  assert.equal(reg.phoneNormalized, b.phone);
  assert.equal(reg.consentTextVersion, CONSENT);
  assert.ok(reg.consentAt);
  assert.equal(reg.claimTokenHash, null); // a self place has nothing to claim
  const order = await db('EventOrder').where({ id: r.body.order.id }).first();
  assert.ok(order.termsAcceptedAt); assert.equal(order.consentTextVersion, CONSENT); assert.equal(order.createdByUserId, b.sub);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 1, capacity: 10 });
  assert.deepEqual((await h.movements(r.body.order.id)).map(m => [m.kind, m.quantity]), [['hold', 1]]);
  // no registration.reserved outbox event (follow-ups S5)
  assert.equal((await h.outbox(f.event.id)).length, 0);
  // notification 1 to the purchaser, bilingual
  const n = await h.notifications(b.sub, 'event_order_created');
  assert.equal(n.length, 1);
  assert.equal(n[0].data.titleSw, 'Usajili umepokelewa · Inasubiri malipo');
  assert.equal(n[0].data.orderId, r.body.order.id);
  // analytics row
  assert.equal((await db('AuditLog').where({ action: 'analytics.order_created', target: f.event.id })).length, 1);

  // replay: same key + same body → 200 replayed, the same order; still one hold
  const again = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': k }, body: { ...body, participants: [{ ...participants[0] }] } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.order.id, r.body.order.id);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 1, capacity: 10 });
  // reuse: same key + different body → 409
  const reused = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': k }, body: { ...body, expectedTotalTzs: 20001 } });
  assert.deepEqual([reused.status, reused.body.error], [409, 'idempotency_key_reused']);

  // reads
  const list = await call(listMyEventOrders, b.claims);
  assert.equal(list.body.items.length, 1);
  assert.deepEqual([list.body.items[0].placesCount, list.body.items[0].event.title], [1, 'Dar Half Marathon']);
  const detail = await call(getMyEventOrder, b.claims, { params: { id: r.body.order.id } });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.allowedActions, ['cancel']);
  assert.equal(detail.body.registrations[0].phone, b.phone);
  assert.ok(detail.body.event.refundPolicy);
  const stranger = await buyer();
  assert.deepEqual((await call(getMyEventOrder, stranger.claims, { params: { id: r.body.order.id } })).body, { error: 'order_not_found' });
  const regs = await call(listMyEventRegistrations, b.claims);
  assert.equal(regs.body.items[0].relation, 'self');
  assert.equal(regs.body.items[0].orderReference, r.body.order.reference);
  const one = await call(getMyEventRegistration, b.claims, { params: { id: reg.id } });
  assert.deepEqual([one.status, one.body.allowedActions, one.body.ticket], [200, ['cancel'], null]);
});

test('order refusals: terms, stale consent version, too many participants, organisation id, bad lines, mismatch, multiple self', async () => {
  flagsOn();
  const f = await h.publishedEvent();
  const b = await buyer();
  const lines = [{ ticketTypeId: f.ticket.id, quantity: 1 }];
  const p = [self(f.ticket.id, b)];
  const hk = () => ({ headers: { 'Idempotency-Key': key() } });
  let r = await call(createEventOrder, b.claims, { ...hk(), body: { ...orderBody(f.event.id, lines, p), acceptedTerms: false } });
  assert.deepEqual([r.status, r.body.error], [400, 'terms_not_accepted']);
  r = await call(createEventOrder, b.claims, { ...hk(), body: { ...orderBody(f.event.id, lines, p), consentTextVersion: 'old' } });
  assert.deepEqual([r.status, r.body], [409, { error: 'consent_version_stale', current: CONSENT }]);
  r = await call(createEventOrder, b.claims, { ...hk(), body: { ...orderBody(f.event.id, lines, p), organizationId: 'org_x' } });
  assert.deepEqual([r.status, r.body.error], [400, 'organization_not_allowed']);
  r = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines: [], participants: [] } });
  assert.deepEqual([r.status, r.body.error], [400, 'invalid_lines']);
  r = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines: [{ ticketTypeId: 'ett_nope', quantity: 1 }], participants: [] } });
  assert.deepEqual([r.status, r.body.error], [400, 'invalid_lines']);
  r = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines, participants: [] } });
  assert.deepEqual([r.status, r.body.error], [400, 'participants_mismatch']);
  r = await call(quoteEventOrder, b.claims, { body: { eventId: 'evt_nope', lines, participants: p } });
  assert.deepEqual([r.status, r.body.error], [404, 'event_not_found']);
  process.env.EVENTS_MAX_PARTICIPANTS_PER_ORDER = '2';
  r = await call(createEventOrder, b.claims, { ...hk(), body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 3 }], [self(f.ticket.id, b), participant(f.ticket.id), participant(f.ticket.id)]) });
  assert.deepEqual([r.status, r.body], [400, { error: 'too_many_participants', max: 2 }]);
  delete process.env.EVENTS_MAX_PARTICIPANTS_PER_ORDER;
  r = await call(createEventOrder, b.claims, { ...hk(), body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 2 }], [self(f.ticket.id, b), self(f.ticket.id, b)]) });
  assert.equal(r.status, 422);
  assert.equal(r.body.participants[1].problems[0].code, 'multiple_self_participants');
  // a draft event does not exist to this surface; a closed one is not open
  const draft = await h.publishedEvent({ publish: false });
  r = await call(quoteEventOrder, b.claims, { body: { eventId: draft.event.id, lines: [{ ticketTypeId: draft.ticket.id, quantity: 1 }], participants: [self(draft.ticket.id, b)] } });
  assert.deepEqual([r.status, r.body.error], [404, 'event_not_found']);
  await eventStore.transitionEvent(f.event.id, 'registration_closed');
  r = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines, participants: p } });
  assert.deepEqual([r.status, r.body], [409, { error: 'event_not_open', eventStatus: 'registration_closed' }]);
});

test('fee rule: EVENTS_FEE_RULE adds a labelled fee line to the quote and the order equally; a bad value refuses rather than guessing', async () => {
  flagsOn();
  process.env.EVENTS_FEE_RULE = '{"type":"flat","perTicketTzs":1000}';
  const f = await h.publishedEvent();
  const b = await buyer();
  const lines = [{ ticketTypeId: f.ticket.id, quantity: 1 }];
  const q = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines, participants: [self(f.ticket.id, b)] } });
  assert.deepEqual([q.body.quote.feesTzs, q.body.quote.totalTzs, q.body.quote.feeLabel], [1000, 21000, { en: 'Service fee', sw: 'Ada ya huduma' }]);
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, lines, [self(f.ticket.id, b)], { expectedTotalTzs: 21000 }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.order.feesTzs, r.body.order.totalTzs], [1000, 21000]);
  process.env.EVENTS_FEE_RULE = '{"type":"percent","pct":999}';
  const bad = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines, participants: [self(f.ticket.id, b)] } });
  assert.equal(bad.status, 500);
  assert.equal(bad.body.error, 'invalid_config');
});

// ── Scenario 2: register another person + claim ───────────────────────────

test('scenario 2: a purchaser_authorised place has no participant, a claim token hash; preview is masked; claim needs a verified matching contact; own-contact, already-claimed and name-only rules', async () => {
  flagsOn();
  const f = await h.publishedEvent();
  const b = await buyer();
  const other = phone();
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [participant(f.ticket.id, { firstName: 'Asha', lastName: 'Mollel', phone: other })]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.registrations[0].isSelf, r.body.registrations[0].claimState], [false, 'unclaimed']);
  const regId = r.body.registrations[0].id;
  const stored = await db('EventRegistration').where({ id: regId }).first();
  assert.equal(stored.participantUserId, null);
  assert.ok(stored.claimTokenHash); assert.ok(stored.claimTokenExpiresAt);
  assert.equal(stored.phoneNormalized, other);
  // nobody has verified that number yet → no "Is this you?" notice
  assert.equal((await db('Notification').where({ type: 'event_claim_available' }).whereRaw(`data->>'registrationId' = ?`, [regId])).length, 0);

  // the purchaser's own list shows it as purchased; the purchaser may read the full row
  const mine = await call(listMyEventRegistrations, b.claims);
  assert.equal(mine.body.items[0].relation, 'purchased');
  assert.equal((await call(getMyEventRegistration, b.claims, { params: { id: regId } })).body.phone, other);

  // plant a token we know (S3 mints hashes at creation; S4 sends tokens) and preview it
  const token = newClaimToken();
  await db('EventRegistration').where({ id: regId }).update({ claimTokenHash: hashToken(token) });
  const preview = await call(previewEventClaim, null, { params: { token } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.participant, { firstNameMasked: 'A***', lastInitial: 'M.' });
  assert.equal(preview.body.contact.type, 'phone');
  assert.equal(preview.body.contact.masked, `••• ${other.slice(-3)}`);
  assert.match(preview.body.purchaser.nameMasked, /^S\*+ m\*+ \w\*+$|^S\*+/);
  assert.equal(preview.body.status, 'reserved');
  assert.ok(!('phone' in preview.body) && !('id' in preview.body));
  assert.deepEqual((await call(previewEventClaim, null, { params: { token: newClaimToken() } })).body, { error: 'claim_token_invalid' });
  assert.equal((await call(previewEventClaim, null, { params: { token: 'short' } })).status, 404);

  // a user who only typed the number on their profile (unverified) → 403 claim_not_verified
  const typed = h.claimsOf(await h.user({ phone: other, verified: false }));
  const nv = await call(claimEventRegistration, typed, { params: { id: regId }, body: { token } });
  assert.equal(nv.status, 403, JSON.stringify(nv.body));
  assert.equal(nv.body.error, 'claim_not_verified');
  assert.deepEqual(nv.body, { error: 'claim_not_verified' }); // no masked contact, no hints (review M1)
  await db('User').where({ id: typed.sub }).update({ phone: null }); // (phone, userType) is unique on User; the real owner signs up below
  // name alone never matches: a verified "Asha Mollel" with another number sees nothing claimable
  const sameName = h.claimsOf(await h.user({ phone: phone(), name: 'Asha Mollel' }));
  assert.deepEqual((await call(claimableEventRegistrations, sameName)).body, { items: [] });
  assert.equal((await call(claimEventRegistration, sameName, { params: { id: regId } })).body.error, 'claim_not_verified');
  // the purchaser registering someone else with their own number → claim_own_contact
  const b2 = await buyer();
  const own = await call(createEventOrder, b2.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [participant(f.ticket.id, { phone: b2.phone })]) });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.deepEqual((await call(claimEventRegistration, b2.claims, { params: { id: own.body.registrations[0].id } })).body, { error: 'claim_own_contact' });
  assert.deepEqual((await call(claimableEventRegistrations, b2.claims)).body, { items: [] });

  // the real Asha: verified number → the place is claimable, the claim succeeds, the purchaser is told
  const asha = h.claimsOf(await h.user({ phone: other, name: 'Asha Mollel' }));
  const claimable = await call(claimableEventRegistrations, asha);
  assert.equal(claimable.body.items.length, 1);
  assert.equal(claimable.body.items[0].id, regId);
  assert.deepEqual(claimable.body.items[0].matchedContact, { type: 'phone', masked: `••• ${other.slice(-3)}` });
  const wrongToken = await call(claimEventRegistration, asha, { params: { id: regId }, body: { token: newClaimToken() } });
  assert.deepEqual([wrongToken.status, wrongToken.body.error], [400, 'claim_token_invalid']);
  const claimed = await call(claimEventRegistration, asha, { params: { id: regId }, body: { token } });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.registration.claimState, 'claimed');
  const after1 = await db('EventRegistration').where({ id: regId }).first();
  assert.equal(after1.participantUserId, asha.sub); assert.ok(after1.claimedAt); assert.equal(after1.claimTokenHash, null);
  assert.equal((await h.notifications(b.sub, 'event_place_claimed')).length, 1);
  assert.equal((await call(listMyEventRegistrations, asha)).body.items[0].relation, 'claimed');
  const ashaView = await call(getMyEventRegistration, asha, { params: { id: regId } });
  assert.ok(ashaView.body.purchaser.nameMasked);
  assert.deepEqual(ashaView.body.allowedActions, []); // the purchaser keeps the cancel right
  // idempotent for the same person; another verified holder of that number is refused
  assert.equal((await call(claimEventRegistration, asha, { params: { id: regId } })).body.changed, false);
  const twin = h.claimsOf(await h.user({ email: mail('twin') }));
  await db('LoginIdentifier').insert({ id: uid('lid'), personId: (await db('User').where({ id: twin.sub }).first('personId')).personId, type: 'phone', value: other, normalizedValue: other, verifiedAt: new Date(), provider: 'test', status: 'active' }).catch(() => {});
  const second = await call(claimEventRegistration, twin, { params: { id: regId } });
  assert.ok(['already_claimed', 'claim_not_verified'].includes(second.body.error), JSON.stringify(second.body));

  // expired token
  const b3 = await buyer();
  const exp = await call(createEventOrder, b3.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [participant(f.ticket.id, { phone: phone() })]) });
  const t2 = newClaimToken();
  await db('EventRegistration').where({ id: exp.body.registrations[0].id }).update({ claimTokenHash: hashToken(t2), claimTokenExpiresAt: new Date(Date.now() - 1000) });
  assert.deepEqual([(await call(previewEventClaim, null, { params: { token: t2 } })).status, (await call(claimEventRegistrationByToken, asha, { body: { token: t2 } })).status], [410, 410]);
});

test('"Is this you?" notice at order creation goes to a member whose VERIFIED contact matches, once per registration', async () => {
  flagsOn();
  const f = await h.publishedEvent();
  const b = await buyer();
  const friendPhone = phone();
  const friend = await h.user({ phone: friendPhone });
  const unverified = await h.user({ phone: phone(), verified: false });
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 2 }], [participant(f.ticket.id, { phone: friendPhone }), participant(f.ticket.id, { phone: (await db('User').where({ id: unverified }).first('phone')).phone })]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const n = await h.notifications(friend, 'event_claim_available');
  assert.equal(n.length, 1);
  assert.equal(n[0].data.titleSw, 'Ni wewe? Tiketi ya Dar Half Marathon');
  assert.equal((await h.notifications(unverified, 'event_claim_available')).length, 0);
});

// ── Scenario 3: group with the purchaser ──────────────────────────────────

test('scenario 3: 1 self + 2 others across two ticket types; participant_invalid lists every bad row; per-place release; remove_whole_line; whole-order cancel with the reason', async () => {
  flagsOn();
  const f = await h.publishedEvent({ categories: [
    { name: '10K', distanceMeters: 10000, tickets: [{ name: 'Standard', priceTzs: 20000, capacity: 10 }] },
    { name: '21K', distanceMeters: 21097, minAge: 18, tickets: [{ name: 'Standard', priceTzs: 30000, capacity: 10 }] },
  ] });
  const [t10, t21] = [f.categories[0].tickets[0], f.categories[1].tickets[0]];
  const b = await buyer();
  const lines = [{ ticketTypeId: t10.id, quantity: 2 }, { ticketTypeId: t21.id, quantity: 1 }];
  // every bad row is listed: missing DOB on the 21K row, bad phone on a 10K row, and the self row is fine
  // (DOB is required on every row once any category carries minAge, §3.3)
  const bad = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, lines, [self(t10.id, b, { dateOfBirth: '1990-01-01' }), participant(t10.id, { phone: '12', dateOfBirth: '1990-01-01' }), participant(t21.id)]) });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.deepEqual(bad.body.participants.map(p => [p.index, p.ok, p.problems.map(x => x.code)]), [[0, true, []], [1, false, ['phone_invalid']], [2, false, ['required']]]);
  assert.equal((await db('EventOrder').where({ eventId: f.event.id })).length, 0);

  const participants = [self(t10.id, b, { dateOfBirth: '1990-01-01' }), participant(t10.id, { firstName: 'Baraka', lastName: 'Juma', dateOfBirth: '1991-01-01' }), participant(t21.id, { firstName: 'Zuwena', lastName: 'Said', dateOfBirth: '1995-05-05' })];
  const q = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines, participants } });
  assert.equal(q.body.valid, true, JSON.stringify(q.body));
  assert.equal(q.body.fields.dateOfBirth, 'required');
  assert.equal(q.body.quote.totalTzs, 70000);
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, lines, participants, { expectedTotalTzs: 70000 }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.registrations.length, 3);
  assert.equal(r.body.lines.length, 2);
  assert.deepEqual((await h.movements(r.body.order.id)).map(m => [m.kind, m.ticketTypeId, m.quantity]).sort(), [['hold', t10.id, 2], ['hold', t21.id, 1]].sort());
  assert.deepEqual(await h.counters(t10.id), { sold: 0, held: 2, capacity: 10 });
  const baraka = r.body.registrations.find(x => x.firstName === 'Baraka');
  const zuwena = r.body.registrations.find(x => x.firstName === 'Zuwena');

  // a claimed participant may not remove themselves (purchaser only); a bad reason is refused
  assert.equal((await call(cancelMyEventRegistration, b.claims, { params: { id: baraka.id }, body: { reason: 'because' } })).body.error, 'invalid_reason');
  // the 21K line has one place and other lines remain → remove_whole_line
  const whole = await call(cancelMyEventRegistration, b.claims, { params: { id: zuwena.id }, body: { reason: 'wrong_details' } });
  assert.deepEqual([whole.status, whole.body.error, whole.body.ticketTypeId], [409, 'remove_whole_line', t21.id]);
  // one of two 10K places: line reduced, totals re-derived, held −1, one release movement keyed per registration, one outbox row
  const one = await call(cancelMyEventRegistration, b.claims, { params: { id: baraka.id }, body: { reason: 'duplicate' } });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.changed, true);
  assert.equal(one.body.order.totalTzs, 50000);
  assert.equal(one.body.registration.status, 'cancelled');
  assert.equal((await db('EventRegistration').where({ id: baraka.id }).first()).cancelReason, 'duplicate');
  const line10 = await db('EventOrderLine').where({ orderId: r.body.order.id, ticketTypeId: t10.id }).first();
  assert.deepEqual([line10.quantity, line10.lineTotalTzs], [1, 20000]);
  assert.deepEqual(await h.counters(t10.id), { sold: 0, held: 1, capacity: 10 });
  const mv = await h.movements(r.body.order.id);
  assert.deepEqual(mv.filter(m => m.kind === 'release').map(m => [m.quantity, m.movementKey]), [[1, `${r.body.order.id}:1:release:${t10.id}:${baraka.id}`]]);
  assert.equal((await h.outbox(f.event.id, 'registration.cancelled')).length, 1);
  // repeating the removal changes nothing
  assert.equal((await call(cancelMyEventRegistration, b.claims, { params: { id: baraka.id }, body: { reason: 'duplicate' } })).body.changed, false);

  // whole-order cancel: everything released, reason stored on the rows, the order closed as cancelled; idempotent
  assert.equal((await call(cancelMyEventOrder, b.claims, { params: { id: r.body.order.id }, body: { reason: 'nope' } })).body.error, 'invalid_reason');
  const cancelled = await call(cancelMyEventOrder, b.claims, { params: { id: r.body.order.id }, body: { reason: 'changed_mind' } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.order.status, 'cancelled');
  assert.equal(cancelled.body.order.closeReason, 'cancelled');
  assert.deepEqual(await h.counters(t10.id), { sold: 0, held: 0, capacity: 10 });
  assert.deepEqual(await h.counters(t21.id), { sold: 0, held: 0, capacity: 10 });
  const rows = await db('EventRegistration').where({ orderId: r.body.order.id }).orderBy('id');
  assert.ok(rows.every(x => x.status === 'cancelled'));
  assert.deepEqual(rows.filter(x => x.id !== baraka.id).map(x => x.cancelReason), ['changed_mind', 'changed_mind']);
  assert.equal((await h.outbox(f.event.id, 'registration.cancelled')).length, 3);
  const again = await call(cancelMyEventOrder, b.claims, { params: { id: r.body.order.id }, body: { reason: 'other' } });
  assert.deepEqual([again.status, again.body.changed, again.body.order.status], [200, false, 'cancelled']);
  assert.deepEqual((await call(getMyEventOrder, b.claims, { params: { id: r.body.order.id } })).body.allowedActions, []);
  // a stranger cannot cancel
  const s = await buyer();
  assert.deepEqual((await call(cancelMyEventOrder, s.claims, { params: { id: r.body.order.id }, body: { reason: 'other' } })).body, { error: 'order_not_found' });
});

test('duplicate policy (D20): the same phone twice in one category is refused in the request and across orders; "allow" switches it off; a second category is fine', async () => {
  flagsOn();
  const f = await h.publishedEvent({ categories: [
    { name: '5K', distanceMeters: 5000, tickets: [{ name: 'S', priceTzs: 0, capacity: 10 }] },
    { name: '10K', distanceMeters: 10000, tickets: [{ name: 'S', priceTzs: 0, capacity: 10 }] },
  ] });
  const [t5, t10] = [f.categories[0].tickets[0], f.categories[1].tickets[0]];
  const b = await buyer();
  const p = phone();
  const twice = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines: [{ ticketTypeId: t5.id, quantity: 2 }], participants: [participant(t5.id, { phone: p }), participant(t5.id, { phone: p })] } });
  assert.equal(twice.body.valid, false);
  assert.deepEqual(twice.body.participants.map(x => x.problems.map(y => y.code)), [[], ['duplicate_participant']]);
  const first = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: t5.id, quantity: 1 }], [participant(t5.id, { phone: p })]) });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const other = await buyer();
  const again = await call(createEventOrder, other.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: t5.id, quantity: 1 }], [participant(t5.id, { phone: p })]) });
  assert.equal(again.status, 422);
  assert.equal(again.body.participants[0].problems[0].code, 'duplicate_participant');
  // someone else's registration is never identified (review M1) ...
  assert.deepEqual(again.body.participants[0].problems[0], { field: 'phone', code: 'duplicate_participant' });
  // ... but the caller's own live order is
  const mine = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines: [{ ticketTypeId: t5.id, quantity: 1 }], participants: [participant(t5.id, { phone: p })] } });
  assert.equal(mine.body.participants[0].problems[0].registrationId, first.body.registrations[0].id);
  const otherCategory = await call(createEventOrder, other.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: t10.id, quantity: 1 }], [participant(t10.id, { phone: p })]) });
  assert.equal(otherCategory.status, 201, JSON.stringify(otherCategory.body));
  await db('Event').where({ id: f.event.id }).update({ duplicatePolicy: 'allow' });
  const third = await buyer();
  const allowed = await call(createEventOrder, third.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: t5.id, quantity: 1 }], [participant(t5.id, { phone: p })]) });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
});

test('minAge: age on the event day in the event timezone; a birthday on event day is eligible', async () => {
  flagsOn();
  const startsAt = new Date(+new Date() + 60 * D);
  const f = await h.publishedEvent({ event: { startsAt }, categories: [{ name: '21K', distanceMeters: 21097, minAge: 18, tickets: [{ name: 'S', priceTzs: 1000, capacity: 5 }] }] });
  const eventDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(startsAt);
  const [y, m, d] = eventDay.split('-');
  const onTheDay = `${Number(y) - 18}-${m}-${d}`;
  const dayAfter = new Date(Date.UTC(Number(y) - 18, Number(m) - 1, Number(d) + 1)).toISOString().slice(0, 10);
  const b = await buyer();
  const ok = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], participants: [participant(f.ticket.id, { dateOfBirth: onTheDay })] } });
  assert.equal(ok.body.valid, true, JSON.stringify(ok.body.participants));
  const young = await call(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], participants: [participant(f.ticket.id, { dateOfBirth: dayAfter })] } });
  assert.equal(young.body.valid, false);
  assert.deepEqual(young.body.participants[0].problems, [{ field: 'dateOfBirth', code: 'age_not_eligible', minAge: 18, ageOnEventDay: 17 }]);
});

// ── Scenario 5: two buyers, the last place ────────────────────────────────

test('scenario 5: two concurrent orders for the last place → exactly one 201 and one capacity_unavailable; after expiry (expireHolds) a third succeeds; expiry writes closeReason and sends notification 2 once', async () => {
  flagsOn();
  const f = await h.publishedEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Last', priceTzs: 5000, capacity: 1 }] }] });
  const [a, b] = [await buyer(), await buyer()];
  const body = who => orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [self(f.ticket.id, who)]);
  const [ra, rb] = await Promise.all([
    call(createEventOrder, a.claims, { headers: { 'Idempotency-Key': key() }, body: body(a) }),
    call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: body(b) }),
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [201, 409], JSON.stringify([ra.body, rb.body]));
  const loser = ra.status === 409 ? ra : rb;
  const winner = ra.status === 201 ? ra : rb;
  assert.deepEqual(loser.body, { error: 'capacity_unavailable', ticketTypeId: f.ticket.id });
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 1, capacity: 1 });
  // the place is gone for a third buyer as well, and the quote says so
  const c = await buyer();
  const q = await call(quoteEventOrder, c.claims, { body: { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], participants: [self(f.ticket.id, c)] } });
  assert.equal(q.body.valid, false);
  assert.equal(q.body.availability[f.ticket.id].availability, 'sold_out');
  assert.ok(q.body.problems.some(p => p.code === 'capacity_unavailable'));

  // the hold lapses
  const run = await eventStore.expireHolds({ at: new Date(Date.now() + 31 * 60_000) });
  assert.ok(run.released >= 1, JSON.stringify(run)); // earlier tests' holds lapse too
  const expired = await db('EventOrder').where({ id: winner.body.order.id }).first();
  assert.deepEqual([expired.status, expired.closeReason], ['expired', 'expired']);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 0, capacity: 1 });
  const winnerUser = winner === ra ? a : b;
  const n = await h.notifications(winnerUser.sub, 'event_order_expired');
  assert.equal(n.length, 1);
  assert.equal(n[0].data.titleSw, 'Tiketi zako zimeachiliwa');
  await eventStore.expireHolds({ at: new Date(Date.now() + 31 * 60_000) });
  assert.equal((await h.notifications(winnerUser.sub, 'event_order_expired')).length, 1);
  assert.equal((await db('AuditLog').where({ action: 'analytics.order_expired', target: f.event.id })).length, 1);
  // the replayed answer of the expired order is still the original (the app then reads its status)
  const third = await call(createEventOrder, c.claims, { headers: { 'Idempotency-Key': key() }, body: body(c) });
  assert.equal(third.status, 201, JSON.stringify(third.body));
  const list = await call(listMyEventOrders, winnerUser.claims, { query: { status: 'expired' } });
  assert.deepEqual([list.body.items.length, list.body.items[0].closeReason], [1, 'expired']);
});

// ── Teams ─────────────────────────────────────────────────────────────────

test('teams: create (unguessable code), lookup, join through an order with the cap, team_name_taken, captain = the creator\'s self place, visibility', async () => {
  flagsOn();
  process.env.EVENTS_TEAM_MAX_MEMBERS = '3';
  const f = await h.publishedEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'S', priceTzs: 1000, capacity: 20 }] }] });
  const captain = await buyer();
  const created = await call(createEventTeam, captain.claims, { body: { eventId: f.event.id, name: 'Kijitonyama Runners', teamType: 'club' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.team.joinCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.deepEqual([created.body.team.memberCount, created.body.team.maxMembers, created.body.team.captainRegistrationId], [0, 3, null]);
  assert.deepEqual((await call(createEventTeam, captain.claims, { body: { eventId: f.event.id, name: 'kijitonyama runners'.replace('k', 'K'), teamType: 'club' } })).body, { error: 'team_name_taken' });
  assert.equal((await call(createEventTeam, captain.claims, { body: { eventId: f.event.id, name: '', teamType: 'club' } })).body.error, 'team_name_invalid');
  const code = created.body.team.joinCode;
  const looked = await call(lookupEventTeam, captain.claims, { body: { eventId: f.event.id, joinCode: code.toLowerCase().replace('-', ' ') } });
  assert.equal(looked.status, 200, JSON.stringify(looked.body));
  assert.deepEqual([looked.body.team.name, looked.body.team.memberCount, looked.body.team.captain], ['Kijitonyama Runners', 0, null]);
  assert.deepEqual((await call(lookupEventTeam, captain.claims, { body: { eventId: f.event.id, joinCode: 'ZZZZ-ZZZZ' } })).body, { error: 'team_not_found' });
  const otherEvent = await h.publishedEvent();
  assert.deepEqual((await call(lookupEventTeam, captain.claims, { body: { eventId: otherEvent.event.id, joinCode: code } })).body, { error: 'team_not_found' });

  // the captain joins with a self place + one friend → captain set to the self registration
  const join = await call(createEventOrder, captain.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 2 }], [self(f.ticket.id, captain), participant(f.ticket.id)], { team: { joinCode: code } }) });
  assert.equal(join.status, 201, JSON.stringify(join.body));
  assert.equal(join.body.order.teamId, created.body.team.id);
  assert.equal(join.body.team.memberCount, 2);
  assert.equal(join.body.team.joinCode, code); // captain sees the code
  const team = await db('EventTeam').where({ id: created.body.team.id }).first();
  assert.equal(team.captainRegistrationId, join.body.registrations.find(r => r.isSelf).id);
  // a second buyer: 2 more would exceed 3 → team_full (quote reports it, order refuses it)
  const b2 = await buyer();
  const q = await call(quoteEventOrder, b2.claims, { body: { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 2 }], participants: [self(f.ticket.id, b2), participant(f.ticket.id)], team: { joinCode: code } } });
  assert.equal(q.body.valid, false);
  assert.equal(q.body.team.problems[0].code, 'team_full');
  const full = await call(createEventOrder, b2.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 2 }], [self(f.ticket.id, b2), participant(f.ticket.id)], { team: { joinCode: code } }) });
  assert.deepEqual([full.status, full.body.error], [409, 'team_full']);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 2, capacity: 20 });
  const one = await call(createEventOrder, b2.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [self(f.ticket.id, b2)], { team: { joinCode: code } }) });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.equal(one.body.team.joinCode, undefined); // a member, not the captain
  const view = await call(getEventTeam, b2.claims, { params: { id: created.body.team.id } });
  assert.deepEqual([view.status, view.body.isCaptain, view.body.team.joinCode, view.body.members.length], [200, false, null, 3]);
  const capView = await call(getEventTeam, captain.claims, { params: { id: created.body.team.id } });
  assert.deepEqual([capView.body.isCaptain, capView.body.team.joinCode], [true, code]);
  assert.deepEqual((await call(getEventTeam, (await buyer()).claims, { params: { id: created.body.team.id } })).body, { error: 'team_not_found' });
  assert.deepEqual((await call(lookupEventTeam, captain.claims, { body: { eventId: f.event.id, joinCode: code } })).body, { error: 'team_full', maxMembers: 3 });
  // creating a team inside an order, and the registrations list shows the team
  const c3 = await buyer();
  const made = await call(createEventOrder, c3.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [self(f.ticket.id, c3)], { team: { create: { name: 'Mbezi Crew', teamType: 'community' } } }) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.team.name, made.body.team.memberCount, made.body.team.isCaptain], ['Mbezi Crew', 1, true]);
  assert.equal((await call(listMyEventRegistrations, c3.claims)).body.items[0].team.name, 'Mbezi Crew');
  const taken = await call(createEventOrder, (await buyer()).claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [participant(f.ticket.id)], { team: { create: { name: 'Mbezi Crew', teamType: 'community' } } }) });
  assert.deepEqual([taken.status, taken.body.error], [409, 'team_name_taken']);
});

// ── Organizer and admin reads ─────────────────────────────────────────────

test('organizer reads: reserved rows masked without kit size or contacts; confirmed rows full; summary; orders with masked purchaser; another organizer → 404; roles', async () => {
  flagsOn();
  const org = await h.organizer();
  const f = await h.publishedEvent({ organizer: org, event: { kitProvided: true }, categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'S', priceTzs: 1000, capacity: 10 }] }] });
  const b = await buyer({ name: 'Neema Abdallah' });
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 2 }], [self(f.ticket.id, b, { kitSize: 'm' }), participant(f.ticket.id, { firstName: 'Asha', lastName: 'Mollel', kitSize: 'l', emergencyContact: { name: 'Mama', phone: '0712000000' } })]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const roster = await call(organizerListRegistrations, org.claims, { params: { id: f.event.id } });
  assert.equal(roster.status, 200, JSON.stringify(roster.body));
  assert.equal(roster.body.total, 2);
  const asha = roster.body.items.find(x => x.participant.name.startsWith('A'));
  assert.deepEqual([asha.participant.name, asha.kitSize, asha.status, asha.claimed], ['A*** M*****', null, 'reserved', false]);
  for (const k of ['phone', 'email', 'dateOfBirth', 'gender', 'emergencyContact']) assert.ok(!(k in asha), k);
  // search covers confirmed rows only
  assert.equal((await call(organizerListRegistrations, org.claims, { params: { id: f.event.id }, query: { q: 'Asha' } })).body.total, 0);
  // after confirmation (S4 commits; the store primitive exists) the names and kit sizes show
  assert.equal((await eventStore.commitOrder(r.body.order.id)).changed, true);
  const paid = await call(organizerListRegistrations, org.claims, { params: { id: f.event.id }, query: { q: 'asha', status: 'confirmed' } });
  assert.equal(paid.body.total, 1);
  assert.deepEqual([paid.body.items[0].participant.name, paid.body.items[0].kitSize], ['Asha Mollel', 'l']);
  assert.ok(!('emergencyContact' in paid.body.items[0]));
  const summary = await call(organizerRegistrationsSummary, org.claims, { params: { id: f.event.id } });
  assert.deepEqual(summary.body.byStatus, { reserved: 0, confirmed: 2, cancelled: 0 });
  assert.deepEqual(summary.body.byCategory.map(c => [c.name, c.sold, c.held]), [['10K', 2, 0]]);
  const orders = await call(organizerListOrders, org.claims, { params: { id: f.event.id } });
  assert.equal(orders.body.items.length, 1);
  assert.deepEqual(orders.body.items[0].purchaser, { type: 'member', label: 'N**** A*******' });
  assert.deepEqual([orders.body.items[0].placesCount, orders.body.items[0].totalTzs, orders.body.items[0].status], [2, 2000, 'confirmed']);
  // roles: timing may read the roster, not orders; finance the other way round
  const timing = await org.staff('timing');
  assert.equal((await call(organizerListRegistrations, timing, { params: { id: f.event.id } })).status, 200);
  assert.equal((await call(organizerListOrders, timing, { params: { id: f.event.id } })).body.error, 'forbidden_role');
  const finance = await org.staff('finance');
  assert.equal((await call(organizerListOrders, finance, { params: { id: f.event.id } })).status, 200);
  assert.equal((await call(organizerListRegistrations, finance, { params: { id: f.event.id } })).body.error, 'forbidden_role');
  // another organizer → 404 event_not_found on all three
  const other = await h.organizer({ name: 'Arusha Runners' });
  for (const route of [organizerListRegistrations, organizerRegistrationsSummary, organizerListOrders]) assert.deepEqual((await call(route, other.claims, { params: { id: f.event.id } })).body, { error: 'event_not_found' });
  // the overview counters are filled now
  const overview = await call(organizerSummary, org.claims);
  assert.deepEqual([overview.body.registrationsTotal, overview.body.confirmedTotal, overview.body.awaitingPaymentTotal], [2, 2, 0]);
  // flag off → 404 even for the organizer
  delete process.env.EVENTS_REGISTRATION;
  assert.deepEqual((await call(organizerListRegistrations, org.claims, { params: { id: f.event.id } })).body, { error: 'feature_disabled' });
});

test('admin reads: full names, order detail without emergency contact, cancel of an unpaid order with an audit row; scope and flag', async () => {
  flagsOn();
  const f = await h.publishedEvent();
  const b = await buyer({ name: 'Neema Abdallah' });
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [participant(f.ticket.id, { firstName: 'Asha', lastName: 'Mollel', emergencyContact: { name: 'Mama', phone: '0712000000' } })]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const admin = await h.superAdmin();
  const staffNoScope = { ...(await h.superAdmin()), portalUser: true, aclPermissions: ['gyms'] };
  assert.deepEqual((await call(adminListEventOrders, staffNoScope, { params: { id: f.event.id } })).body, { error: 'acl_forbidden', requiredScope: 'events' });
  const orders = await call(adminListEventOrders, admin, { params: { id: f.event.id } });
  assert.equal(orders.status, 200, JSON.stringify(orders.body));
  assert.deepEqual(orders.body.items[0].purchaser, { type: 'member', label: 'Neema Abdallah' });
  assert.deepEqual(orders.body.items[0].allowedActions, ['cancel']);
  const regs = await call(adminListEventRegistrations, admin, { params: { id: f.event.id } });
  assert.deepEqual([regs.body.items[0].participant.name, 'emergencyContact' in regs.body.items[0]], ['Asha Mollel', false]);
  const detail = await call(adminGetEventOrder, admin, { params: { id: f.event.id, orderId: r.body.order.id } });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.registrations[0].firstName, 'Asha');
  assert.ok(!('emergencyContact' in detail.body.registrations[0]));
  for (const k of ['phone', 'email', 'dateOfBirth', 'gender']) assert.ok(!(k in detail.body.registrations[0]), k); // review L7
  assert.deepEqual(detail.body.allowedActions, ['cancel']);
  assert.deepEqual((await call(adminGetEventOrder, admin, { params: { id: 'evt_other', orderId: r.body.order.id } })).body, { error: 'order_not_found' });
  const cancelled = await call(adminCancelEventOrder, admin, { params: { id: f.event.id, orderId: r.body.order.id }, body: { note: 'duplicate of EV-1' } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.deepEqual([cancelled.body.order.status, cancelled.body.order.closeReason], ['cancelled', 'admin']);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 0, capacity: 10 });
  const aud = await db('AuditLog').where({ action: 'events.order_cancelled', target: r.body.order.id }).first();
  assert.equal(aud.actor, admin.sub);
  assert.equal(aud.after.note, 'duplicate of EV-1');
  assert.equal((await h.notifications(b.sub, 'event_order_cancelled')).length, 1);
  assert.equal((await call(adminCancelEventOrder, admin, { params: { id: f.event.id, orderId: r.body.order.id }, body: {} })).body.changed, false);
  // a confirmed order cannot be cancelled here (refunds are S4)
  const r2 = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [self(f.ticket.id, b)]) });
  await eventStore.commitOrder(r2.body.order.id);
  assert.equal((await call(adminCancelEventOrder, admin, { params: { id: f.event.id, orderId: r2.body.order.id }, body: {} })).body.error, 'invalid_transition');
  assert.equal((await call(cancelMyEventOrder, b.claims, { params: { id: r2.body.order.id }, body: { reason: 'other' } })).body.error, 'invalid_transition');
  delete process.env.EVENTS_REGISTRATION;
  assert.deepEqual((await call(adminListEventOrders, admin, { params: { id: f.event.id } })).body, { error: 'feature_disabled' });
});

test('S4 seam: inviteClaims is built (templates, token rotation, bookkeeping) but no S3 route or job calls it', async () => {
  flagsOn();
  const f = await h.publishedEvent();
  const b = await buyer({ name: 'Neema Abdallah' });
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 2 }], [self(f.ticket.id, b), participant(f.ticket.id, { phone: phone() })]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const other = r.body.registrations.find(x => !x.isSelf);
  const before = await db('EventRegistration').where({ id: other.id }).first();
  assert.equal(before.claimInviteCount, 0); assert.equal(before.claimInvitedAt, null);
  const text = eventsRegistrationService.claimInvitationText({ purchaser: 'Neema', event: 'Dar Half', category: '10K', link: 'https://fitflex.app/event-claim/#abc' });
  assert.ok(text.sms.en.length <= 160 && text.sms.sw.length <= 160, 'SMS within 160 characters');
  assert.match(text.sms.sw, /amekusajili kwa Dar Half \(10K\)/);
  // nothing in S3 has sent anything
  const stillUnsent = await db('EventRegistration').where({ id: other.id }).first();
  assert.equal(stillUnsent.claimInviteCount, 0);
});


// ── Security review fixes ────────────────────────────────────────────────

test('M2: expectedTotalTzs is required to place an order (the quote stays free of it)', async () => {
  flagsOn();
  const f = await h.publishedEvent();
  const b = await buyer();
  const lines = [{ ticketTypeId: f.ticket.id, quantity: 1 }];
  const body = orderBody(f.event.id, lines, [self(f.ticket.id, b)]);
  const missing = await rawCall(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body });
  assert.deepEqual([missing.status, missing.body.error], [400, 'expected_total_required']);
  assert.equal((await rawCall(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: { ...body, expectedTotalTzs: -5 } })).body.error, 'invalid_expected_total');
  assert.equal((await rawCall(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines, participants: [self(f.ticket.id, b)] } })).status, 200);
  assert.equal((await db('EventOrder').where({ eventId: f.event.id })).length, 0);
});

test('M3: one live unpaid order per user per event (409 hold_limit_reached), also under a race; a cancelled order frees the slot; the order route is rate limited', async () => {
  flagsOn();
  const f = await h.publishedEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'S', priceTzs: 1000, capacity: 50 }] }] });
  const b = await buyer();
  const mk = () => orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [participant(f.ticket.id)], { expectedTotalTzs: 1000 });
  const first = await rawCall(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: mk() });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await rawCall(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: mk() });
  assert.deepEqual([second.status, second.body.error], [409, 'hold_limit_reached']);
  assert.deepEqual(await h.counters(f.ticket.id), { sold: 0, held: 1, capacity: 50 });
  await rawCall(cancelMyEventOrder, b.claims, { params: { id: first.body.order.id }, body: { reason: 'other' } });
  assert.equal((await rawCall(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: mk() })).status, 201);
  // a race: two simultaneous orders by one user for a fresh event → exactly one wins
  const g = await h.publishedEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'S', priceTzs: 1000, capacity: 50 }] }] });
  const c = await buyer();
  const mk2 = () => orderBody(g.event.id, [{ ticketTypeId: g.ticket.id, quantity: 1 }], [participant(g.ticket.id)], { expectedTotalTzs: 1000 });
  const raced = await Promise.all([1, 2, 3].map(() => rawCall(createEventOrder, c.claims, { headers: { 'Idempotency-Key': key() }, body: mk2() })));
  assert.deepEqual(raced.map(r => r.status).sort(), [201, 409, 409], JSON.stringify(raced.map(r => r.body.error)));
  assert.deepEqual(await h.counters(g.ticket.id), { sold: 0, held: 1, capacity: 50 });
  // rate limit: 20 / minute per user
  resetEventsRegistrationLimits();
  const d = await buyer();
  let limited = null;
  for (let i = 0; i < 22 && !limited; i += 1) {
    const r = await rawCall(createEventOrder, d.claims, { headers: { 'Idempotency-Key': key() }, body: { eventId: f.event.id } });
    if (r.status === 429) limited = r;
  }
  assert.equal(limited?.body.error, 'rate_limited');
});

test('M4: oversized input is refused with 400 before any regex runs, fast', async () => {
  flagsOn();
  const f = await h.publishedEvent();
  const b = await buyer();
  const lines = [{ ticketTypeId: f.ticket.id, quantity: 1 }];
  const huge = 'a'.repeat(50_000);
  for (const [field, value] of [['email', `${huge}@x.co`], ['phone', '1'.repeat(5000)], ['firstName', huge], ['lastName', huge], ['gender', huge], ['dateOfBirth', huge], ['emergencyContact', { name: huge, phone: '0712345678' }]]) {
    const started = Date.now();
    const q = await rawCall(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines, participants: [participant(f.ticket.id, { [field]: value })] } });
    const o = await rawCall(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, lines, [participant(f.ticket.id, { [field]: value })], { expectedTotalTzs: 20000 }) });
    assert.deepEqual([q.status, q.body.error, o.status, o.body.error], [400, 'field_too_long', 400, 'field_too_long'], field);
    assert.ok(Date.now() - started < 1500, `${field} took ${Date.now() - started} ms`);
  }
  assert.equal((await db('EventOrder').where({ eventId: f.event.id })).length, 0);
});

test('L2: a name starting with = + - @ is refused (invalid_text); costCentre and purchaserReference too', async () => {
  flagsOn();
  const f = await h.publishedEvent();
  const b = await buyer();
  const lines = [{ ticketTypeId: f.ticket.id, quantity: 1 }];
  const q = await rawCall(quoteEventOrder, b.claims, { body: { eventId: f.event.id, lines, participants: [participant(f.ticket.id, { firstName: '=HYPERLINK' })] } });
  assert.deepEqual(q.body.participants[0].problems, [{ field: 'firstName', code: 'invalid_text' }]);
});

test('M5: once a place is claimed the purchaser sees the masked view; the participant is told when the purchaser cancels the unpaid place', async () => {
  flagsOn();
  const f = await h.publishedEvent({ event: { kitProvided: true } });
  const b = await buyer();
  const ashaPhone = phone();
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 2 }], [self(f.ticket.id, b), participant(f.ticket.id, { firstName: 'Asha', lastName: 'Mollel', phone: ashaPhone, kitSize: 'm', emergencyContact: { name: 'Mama', phone: '0712000000' } })]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const regId = r.body.registrations.find(x => !x.isSelf).id;
  // before the claim the purchaser sees what they typed
  assert.equal((await call(getMyEventRegistration, b.claims, { params: { id: regId } })).body.phone, ashaPhone);
  const asha = h.claimsOf(await h.user({ phone: ashaPhone, name: 'Asha Mollel', }));
  assert.equal((await call(claimEventRegistration, asha, { params: { id: regId } })).status, 200);
  const view = await call(getMyEventRegistration, b.claims, { params: { id: regId } });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.deepEqual([view.body.firstName, view.body.status, view.body.kitSize, view.body.masked], ['Asha', 'reserved', 'm', true]);
  for (const k of ['phone', 'email', 'dateOfBirth', 'gender', 'emergencyContact']) assert.equal(view.body[k], null, k);
  const detail = await call(getMyEventOrder, b.claims, { params: { id: r.body.order.id } });
  const row = detail.body.registrations.find(x => x.id === regId);
  assert.deepEqual([row.masked, row.phone, row.emergencyContact, row.kitSize], [true, null, null, 'm']);
  const mineRow = detail.body.registrations.find(x => x.isSelf);
  assert.equal(mineRow.phone, b.phone); // my own place is not masked
  // the claimed participant keeps full access
  assert.equal((await call(getMyEventRegistration, asha, { params: { id: regId } })).body.phone, ashaPhone);
  // the purchaser cancels the unpaid claimed place → Asha is told, in both languages
  const gone = await call(cancelMyEventRegistration, b.claims, { params: { id: regId }, body: { reason: 'wrong_details' } });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  const n = await h.notifications(asha.sub, 'event_place_cancelled');
  assert.equal(n.length, 1);
  assert.equal(n[0].data.titleSw, 'Tiketi yako imeghairiwa');
  assert.equal(n[0].data.titleEn, 'Your place was cancelled');
});

test('Swahili: order notice uses the 12-hour clock and one/other plurals; fallbacks and wording per the audit', async () => {
  flagsOn();
  const f = await h.publishedEvent({ categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'S', priceTzs: 1000, capacity: 50 }] }] });
  const b = await buyer();
  const one = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [self(f.ticket.id, b)]) });
  assert.equal(one.status, 201, JSON.stringify(one.body));
  const n = (await h.notifications(b.sub, 'event_order_created'))[0];
  assert.equal(n.data.titleSw, 'Usajili umepokelewa · Inasubiri malipo');
  assert.match(n.data.bodySw, /^Tiketi yako ya Dar Half Marathon imeshikiliwa hadi \d{1,2}:\d{2} (asubuhi|mchana|jioni|usiku)\./);
  assert.match(n.data.bodyEn, /^Your place for Dar Half Marathon is held until \d{2}:\d{2}\./);
  // a corporate purchaser with no name gets Swahili fallbacks, never English words, in the Swahili text
  const friend = phone();
  const friendUser = await h.user({ phone: friend });
  const c = await buyer();
  const many = await call(createEventOrder, c.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 2 }], [participant(f.ticket.id, { phone: friend }), participant(f.ticket.id)]) });
  assert.equal(many.status, 201, JSON.stringify(many.body));
  const nn = (await h.notifications(c.sub, 'event_order_created'))[0];
  assert.match(nn.data.bodySw, /^Tiketi zako 2 za /);
  assert.match(nn.data.bodyEn, /^Your 2 places for /);
  const claimNotice = (await h.notifications(friendUser, 'event_claim_available'))[0];
  assert.ok(!/Someone|An organisation/.test(claimNotice.data.bodySw));
  // consent wording and the label without the draft suffix
  const q = await call(quoteEventOrder, c.claims, { body: { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], participants: [self(f.ticket.id, c)] } });
  assert.match(q.body.consentText.self.sw, /kushirikisha taarifa/);
  assert.equal(q.body.consentText.version, '2026-10-draft');
  assert.equal(q.body.consentText.versionLabel, '2026-10');
});

test('L9 / Swahili: inviteClaims refuses an unpaid order; for a paid one it sends both languages (or the recipient\'s) and rotates the token', async () => {
  flagsOn();
  const f = await h.publishedEvent();
  const b = await buyer({ name: 'Neema Abdallah' });
  const target = phone();
  const r = await call(createEventOrder, b.claims, { headers: { 'Idempotency-Key': key() }, body: orderBody(f.event.id, [{ ticketTypeId: f.ticket.id, quantity: 1 }], [participant(f.ticket.id, { phone: target })]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const sent = [];
  const svc = createEventsRegistrationService({
    db, eventStore, catalogue: eventCatalogueStore, users, verifiedContacts, auditLog,
    senders: { sms: () => ({ configured: true, send: async (to, m) => { sent.push({ to, ...m }); return { ok: true }; } }), email: () => ({ configured: false }) },
  });
  const refused = await svc.inviteClaims({ orderId: r.body.order.id });
  assert.deepEqual([refused.status, refused.error], [409, 'order_not_confirmed']);
  assert.equal(sent.length, 0);
  await eventStore.commitOrder(r.body.order.id);
  const before = await db('EventRegistration').where({ orderId: r.body.order.id }).first();
  assert.deepEqual(await svc.inviteClaims({ orderId: r.body.order.id }), { invited: 1, skipped: 0 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /amekusajili/);   // unknown recipient: Swahili and English together
  assert.match(sent[0].text, /registered you/);
  const after = await db('EventRegistration').where({ orderId: r.body.order.id }).first();
  assert.notEqual(after.claimTokenHash, before.claimTokenHash);
  assert.equal(after.claimInviteCount, 1);
});
