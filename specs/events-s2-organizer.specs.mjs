// Marathon & running events · S2 — the organizer side, route level against the CI database: the flag,
// organizer creation (persona, KYC case, membership), the derived organizer status after KYC decisions,
// staff invitations and role rules, event CRUD with compare-and-set versions, validation codes, nested
// upserts, the material-change rule, lifecycle transitions including D12 has_registrations, and tenancy.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { users, partnerKycService, invitationService, eventStore, eventCatalogueStore, eventsOrganizerService, identityLinkService } from '../src/bootstrap/services.mjs';
import {
  createOrganizer, organizerMe, organizerSummary, organizerListEvents, organizerCreateEvent, organizerGetEvent, organizerPatchEvent, organizerDeleteEvent,
  organizerSubmitEvent, organizerWithdrawEvent, organizerCancelEvent, organizerCompleteEvent, organizerArchiveEvent, organizerEventChanges,
  organizerListStaff, organizerInviteStaff, organizerChangeStaffRole, organizerRemoveStaff,
} from '../functions/events-organizer.mjs';
import { adminDecideEvent } from '../functions/events-admin.mjs';
import { eventsOptions } from '../functions/events-public.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const H = 3_600_000; const D = 24 * H;
const made = { users: [], organizers: [], events: [] };
const FLAGS = ['EVENTS_MODULE', 'EVENTS_FAVOURITES', 'IDENTITY_V2', 'V2_INVITES', 'V2_PIN_LOGIN'];
const on = () => { process.env.EVENTS_MODULE = '1'; process.env.IDENTITY_V2 = 'true'; process.env.V2_INVITES = 'true'; };
afterEach(() => { for (const f of FLAGS) delete process.env[f]; });

after(async () => {
  for (const f of FLAGS) delete process.env[f];
  const events = made.events.length ? made.events : [];
  const orderIds = events.length ? (await db('EventOrder').whereIn('eventId', events).select('id')).map(r => r.id) : [];
  if (orderIds.length) {
    await db.transaction(async (trx) => {
      await trx.raw('ALTER TABLE "EventInventoryMovement" DISABLE TRIGGER ALL');
      await trx('EventInventoryMovement').whereIn('orderId', orderIds).del();
      await trx.raw('ALTER TABLE "EventInventoryMovement" ENABLE TRIGGER ALL');
    });
    await db('OutboxEvent').whereIn('eventId', events).del();
    await db('EventRegistration').whereIn('orderId', orderIds).del();
    await db('EventOrderLine').whereIn('orderId', orderIds).del();
    await db('EventOrder').whereIn('id', orderIds).del();
  }
  if (events.length) {
    await db('EventChangeLog').whereIn('eventId', events).del();
    await db('EventFavourite').whereIn('eventId', events).del();
    await db('EventTicketType').whereIn('eventId', events).del();
    await db('EventCategory').whereIn('eventId', events).del();
    await db('EventCollectionPoint').whereIn('eventId', events).del();
    await db('Event').whereIn('id', events).del();
  }
  if (made.organizers.length) {
    await db('Event').whereIn('organizerId', made.organizers).del();
    await db('EventOrganizerStaff').whereIn('organizerId', made.organizers).del();
    await db('OrgMembership').whereIn('organizerId', made.organizers).del();
    await db('Invitation').whereIn('organizerId', made.organizers).del();
    await db('EventOrganizer').whereIn('id', made.organizers).del();
  }
  const staffUsers = (await db('User').whereIn('userType', ['event_organizer', 'organizer_staff']).whereIn('personId', (await db('User').whereIn('id', made.users).select('personId')).map(r => r.personId)).select('id')).map(r => r.id);
  const all = [...new Set([...made.users, ...staffUsers])];
  const caseIds = (await db('PartnerKycCase').whereIn('userId', all).select('id')).map(r => r.id);
  for (const t of ['PartnerKycEvent', 'PartnerDocument', 'PartnerPerson', 'PartnerSettlementAccount', 'PartnerAgreement', 'PartnerCheck']) await db(t).whereIn('caseId', caseIds).del();
  await db('PartnerKycCase').whereIn('id', caseIds).del();
  await db('AuditLog').whereIn('actor', all).del();
  await db('Notification').whereIn('userId', all).del();
  await db('CommunicationPreference').whereIn('id', all).del();
  await db('OrgMembership').whereIn('personaId', all).del();
  await db('User').whereIn('id', all).del();
  await db('JobRun').where({ job: 'event-lifecycle' }).del();
  await db.destroy();
});

function res() {
  return { statusCode: 200, body: null, ended: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { this.ended = true; return this; } };
}
async function call(route, claims, { params = {}, query = {}, body = {} } = {}) {
  const headers = claims ? { authorization: `Bearer ${sign(claims)}` } : {};
  const req = { method: route.method.toUpperCase(), headers, params, query, body, get: name => headers[String(name).toLowerCase()] ?? null };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return { status: out.statusCode, body: out.body };
  }
  await route.onRequest(req, out);
  return { status: out.statusCode, body: out.body };
}

async function makeUser(userType = 'member', extra = {}) {
  const id = uid('usr');
  await users.upsertAsync(u => u.id === id, { id, userType, displayName: `S2 ${userType}`, accountStatus: 'active', approvalStatus: 'approved', phone: `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, createdAt: new Date().toISOString(), ...extra });
  made.users.push(id);
  return db('User').where({ id }).first();
}
const claimsOf = u => ({ sub: u.id, userType: u.userType });
const admin = async () => claimsOf(await makeUser('admin', { email: `${uid('adm')}@example.com` }));

/** A member who asks for the organizer capability; returns the persona's claims and the organizer. */
async function organizerFixture(name = 'Dar Runners') {
  const member = await makeUser('member', { email: `${uid('m')}@example.com`, firebaseUid: uid('fb') });
  const r = await call(createOrganizer, claimsOf(member), { body: { name, contactPhone: '0712 345 678', contactEmail: 'ORG@example.com', timezone: 'Africa/Dar_es_Salaam' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  made.organizers.push(r.body.organizer.id);
  const persona = await db('User').where({ id: r.body.personaId }).first();
  return { member, persona, claims: claimsOf(persona), organizer: r.body.organizer, kycCaseId: r.body.kycCaseId };
}

/** Walk the organizer's KYC case to `to` through the review service (super-admin override, no checklist). */
async function decideKyc(kycCaseId, to) {
  const reviewer = { id: (await admin()).sub, role: 'admin', superAdmin: true };
  const kycCase = await db('PartnerKycCase').where({ id: kycCaseId }).first();
  if (to === 'approved' || to === 'rejected') {
    if (kycCase.status === 'draft') await db('PartnerKycCase').where({ id: kycCaseId }).update({ status: 'submitted', submittedAt: new Date().toISOString() });
    const claimed = await partnerKycService.claim(kycCaseId, reviewer);
    assert.equal(claimed.error, undefined, JSON.stringify(claimed));
    const decided = to === 'approved'
      ? await partnerKycService.decide(kycCaseId, { decision: 'approve', override: true, reasonNote: 'spec: documents seen offline' }, reviewer)
      : await partnerKycService.decide(kycCaseId, { decision: 'reject', reasonCode: 'suspected_fraud', reasonNote: 'spec: not genuine' }, reviewer);
    assert.equal(decided.error, undefined, JSON.stringify(decided));
  } else if (to === 'suspended') {
    const d = await partnerKycService.decide(kycCaseId, { decision: 'suspend', reasonCode: 'document_expired', reasonNote: 'spec: permit lapsed' }, reviewer);
    assert.equal(d.error, undefined, JSON.stringify(d));
  } else if (to === 'approved_again') {
    const d = await partnerKycService.decide(kycCaseId, { decision: 'reinstate', override: true, reasonNote: 'spec: reinstated' }, reviewer);
    assert.equal(d.error, undefined, JSON.stringify(d));
  }
}

async function activeOrganizer(name) {
  const f = await organizerFixture(name);
  await decideKyc(f.kycCaseId, 'approved');
  return f;
}

const starts = new Date(+new Date() + 40 * D);
/** A complete document (every §6.2 requirement) for PATCH. */
const fullDocument = (version, over = {}) => ({
  version, title: 'Dar Half Marathon', type: 'road',
  description: { en: 'A'.repeat(60), sw: 'B'.repeat(60) }, timezone: 'Africa/Dar_es_Salaam',
  startsAt: starts.toISOString(), endsAt: new Date(+starts + 6 * H).toISOString(), registrationOpensAt: null, registrationClosesAt: new Date(+starts - D).toISOString(),
  venue: { name: 'Coco Beach', address: 'Toure Drive', city: 'Dar es Salaam', region: 'dar-es-salaam', lat: -6.75, lng: 39.27 },
  categories: [
    { name: '21K', distanceM: 21097, startsAt: starts.toISOString(), capacity: 500, ticketTypes: [{ name: 'Early bird', priceTzs: 25000, capacity: 100 }, { name: 'Standard', priceTzs: 35000, capacity: null }] },
    { name: '5K', distanceM: 5000, startsAt: new Date(+starts + H).toISOString(), capacity: null, ticketTypes: [{ name: 'Fun run', priceTzs: 0, capacity: 1000 }] },
  ],
  kitProvided: false,
  terms: { en: 'T'.repeat(120), sw: 'M'.repeat(120) }, refundPolicy: { preset: 'refund_until_close' },
  contact: { email: 'race@example.com', phone: '0712345678' },
  ...over,
});

async function draftEvent(f, over = {}) {
  const created = await call(organizerCreateEvent, f.claims, { body: { title: 'Dar Half Marathon' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  made.events.push(created.body.id);
  const patched = await call(organizerPatchEvent, f.claims, { params: { id: created.body.id }, body: fullDocument(created.body.version, over) });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  return { id: created.body.id, version: patched.body.version };
}

async function publishedEvent(f, over = {}) {
  const e = await draftEvent(f, over);
  const submitted = await call(organizerSubmitEvent, f.claims, { params: { id: e.id } });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const approved = await call(adminDecideEvent, await admin(), { params: { id: e.id }, body: { decision: 'approve' } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, 'published');
  return { id: e.id, version: (await eventStore.getEvent(e.id)).version };
}

// ── Flags ─────────────────────────────────────────────────────────────────

test('EVENTS_MODULE off: every organizer route answers 404 feature_disabled; GET /events/options still answers { discovery: false }', async () => {
  const member = await makeUser('member');
  assert.deepEqual(await call(createOrganizer, claimsOf(member), { body: { name: 'X', contactPhone: '0712345678' } }), { status: 404, body: { error: 'feature_disabled' } });
  assert.equal((await call(organizerMe, { sub: member.id, userType: 'event_organizer' })).status, 404);
  assert.equal((await call(organizerListEvents, { sub: member.id, userType: 'event_organizer' })).body.error, 'feature_disabled');
  const options = await call(eventsOptions, null);
  assert.equal(options.status, 200);
  assert.equal(options.body.discovery, false);
  assert.equal(options.body.favourites, false);
  assert.equal(options.body.currency, 'TZS');
  assert.equal(options.body.closingSoonHours, 72);
  assert.ok(options.body.regions.some(r => r.code === 'dar-es-salaam' && r.name.sw === 'Dar es Salaam'));
  assert.ok(options.body.timezones.includes('Africa/Dar_es_Salaam'));
});

// ── Organizer creation ────────────────────────────────────────────────────

test('POST /me/organizer: persona under the caller\'s Person, draft organizer, owner staff row, KYC case, membership; refusals', async () => {
  on();
  const f = await organizerFixture('Kili Trail Club');
  assert.equal(f.persona.userType, 'event_organizer');
  assert.equal(f.persona.personId, f.member.personId);
  assert.equal(f.persona.organizerId, f.organizer.id);
  assert.equal(f.persona.organizerRole, 'owner');
  assert.equal(f.organizer.status, 'draft');
  assert.equal(f.organizer.name, 'Kili Trail Club');
  assert.equal(f.organizer.kycStatus, 'draft');
  const row = await db('EventOrganizer').where({ id: f.organizer.id }).first();
  assert.equal(row.ownerUserId, f.persona.id);
  assert.equal(row.contactPhone, '+255712345678');
  assert.equal(row.contactEmail, 'org@example.com');
  assert.equal(row.kycCaseId, f.kycCaseId);
  const kyc = await db('PartnerKycCase').where({ id: f.kycCaseId }).first();
  assert.equal(kyc.partnerType, 'event_organizer');
  assert.equal(kyc.userId, f.persona.id);
  const staff = await db('EventOrganizerStaff').where({ organizerId: f.organizer.id }).first();
  assert.equal(staff.role, 'owner'); assert.equal(staff.userId, f.persona.id);
  const membership = await db('OrgMembership').where({ organizerId: f.organizer.id, personaId: f.persona.id }).first();
  assert.ok(membership, 'organizer membership derived');
  assert.equal(membership.orgType, 'organizer'); assert.equal(membership.role, 'owner'); assert.equal(membership.status, 'active');
  // Once per person: the member and the persona both get organizer_exists.
  assert.equal((await call(createOrganizer, claimsOf(f.member), { body: { name: 'Again', contactPhone: '0712345678' } })).body.error, 'organizer_exists');
  assert.equal((await call(createOrganizer, f.claims, { body: { name: 'Again', contactPhone: '0712345678' } })).body.error, 'organizer_exists');
  // Validation and who may ask.
  const other = await makeUser('member');
  assert.equal((await call(createOrganizer, claimsOf(other), { body: { name: 'X', contactPhone: '0712345678' } })).body.error, 'invalid_name');
  assert.equal((await call(createOrganizer, claimsOf(other), { body: { name: 'Fine name', contactPhone: '12' } })).body.error, 'invalid_phone');
  assert.equal((await call(createOrganizer, claimsOf(other), { body: { name: 'Fine name', contactPhone: '0712345678', timezone: 'Mars/Olympus' } })).body.error, 'invalid_timezone');
  const staffUser = await makeUser('gym_staff');
  assert.deepEqual((await call(createOrganizer, claimsOf(staffUser), { body: { name: 'Fine name', contactPhone: '0712345678' } })).body, { error: 'persona_not_allowed' });
  // /organizer/me for the persona; an organizer-type session with no staff row gets no_organizer.
  const me = await call(organizerMe, f.claims);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.role, 'owner');
  assert.deepEqual(me.body.permissions, ['overview', 'onboarding']);
  assert.equal(me.body.organizer.status, 'draft');
  assert.equal(me.body.organizer.kycCaseId, f.kycCaseId);
  const stray = await makeUser('organizer_staff');
  assert.deepEqual(await call(organizerMe, claimsOf(stray)), { status: 404, body: { error: 'no_organizer' } });
  // Members cannot open organizer routes at all.
  assert.equal((await call(organizerMe, claimsOf(f.member))).status, 403);
  // The audit trail.
  const audit = await db('AuditLog').where({ action: 'events.organizer_created', target: f.organizer.id }).first();
  assert.ok(audit);
});

test('a draft organizer cannot create events (organizer_not_active); KYC decisions drive the derived status; suspended is read-only', async () => {
  on();
  const f = await organizerFixture('Pending Club');
  assert.deepEqual((await call(organizerCreateEvent, f.claims, { body: { title: 'Too early' } })).body, { error: 'organizer_not_active', organizerStatus: 'draft' });
  // Reads of events and staff are closed too until verified (L2); the overview stays open.
  assert.deepEqual((await call(organizerListEvents, f.claims)).body, { error: 'organizer_not_active', organizerStatus: 'draft' });
  assert.deepEqual((await call(organizerListStaff, f.claims)).body, { error: 'organizer_not_active', organizerStatus: 'draft' });
  assert.equal((await call(organizerSummary, f.claims)).status, 200);
  // L5: a persona left behind by an interrupted attempt is reused, not refused.
  const stranded = await makeUser('member', { email: `${uid('m')}@example.com`, firebaseUid: uid('fb') });
  const person = await identityLinkService.personOf(stranded.personId);
  const left = await identityLinkService.createPersona({ person, source: stranded, userType: 'event_organizer', approvalStatus: 'approved' });
  assert.equal(left.error, undefined);
  const retried = await call(createOrganizer, claimsOf(stranded), { body: { name: 'Second Try Club', contactPhone: '0712345678' } });
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  assert.equal(retried.body.personaId, left.row.id, 'the dangling persona is the organizer\'s owner');
  made.organizers.push(retried.body.organizer.id);
  assert.equal((await call(createOrganizer, claimsOf(stranded), { body: { name: 'Third', contactPhone: '0712345678' } })).body.error, 'organizer_exists');
  // submitted → pending_review (the hook runs on every case move).
  await db('PartnerKycCase').where({ id: f.kycCaseId }).update({ status: 'submitted' });
  const reviewer = { id: (await admin()).sub, role: 'admin', superAdmin: true };
  assert.equal((await partnerKycService.claim(f.kycCaseId, reviewer)).error, undefined);
  assert.equal((await call(organizerMe, f.claims)).body.organizer.status, 'pending_review');
  assert.equal((await call(organizerMe, f.claims)).body.organizer.kycStatus, 'in_review');
  await partnerKycService.decide(f.kycCaseId, { decision: 'approve', override: true, reasonNote: 'spec' }, reviewer);
  let me = await call(organizerMe, f.claims);
  assert.equal(me.body.organizer.status, 'active');
  assert.deepEqual(me.body.permissions, ['overview', 'onboarding', 'events:read', 'events:write', 'staff']);
  // The user-level approval never blocks the persona (spec §2: gating is the organizer status).
  assert.equal((await db('User').where({ id: f.persona.id }).first()).approvalStatus, 'approved');
  const created = await call(organizerCreateEvent, f.claims, { body: { title: 'Now allowed' } });
  assert.equal(created.status, 201); made.events.push(created.body.id);
  // suspended: list visible with no actions; writes refused with organizer_suspended.
  await decideKyc(f.kycCaseId, 'suspended');
  me = await call(organizerMe, f.claims);
  assert.equal(me.body.organizer.status, 'suspended');
  assert.equal(me.body.organizer.statusReason, 'spec: permit lapsed');
  assert.equal(me.body.organizer.statusReasonCode, 'document_expired');
  const list = await call(organizerListEvents, f.claims);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items[0].allowedActions, []);
  assert.deepEqual((await call(organizerCreateEvent, f.claims, { body: { title: 'Nope' } })).body, { error: 'organizer_suspended', organizerStatus: 'suspended' });
  assert.equal((await call(organizerPatchEvent, f.claims, { params: { id: created.body.id }, body: { version: 1, title: 'Nope' } })).body.error, 'organizer_suspended');
  await decideKyc(f.kycCaseId, 'approved_again');
  assert.equal((await call(organizerMe, f.claims)).body.organizer.status, 'active');
  assert.equal((await db('EventOrganizer').where({ id: f.organizer.id }).first()).statusReason, null);
  // rejected
  const g = await organizerFixture('Rejected Club');
  await decideKyc(g.kycCaseId, 'rejected');
  const gm = await call(organizerMe, g.claims);
  assert.equal(gm.body.organizer.status, 'rejected');
  // Rejected for suspected_fraud: the organizer is told under_review and never sees the reviewer's note (owner rule 22 Oct 2026).
  assert.equal(gm.body.organizer.statusReasonCode, 'under_review');
  assert.equal(gm.body.organizer.statusReason, null);
  assert.deepEqual(gm.body.permissions, ['overview', 'onboarding']);
  const status = await db('AuditLog').where({ action: 'events.organizer_status', target: g.organizer.id }).orderBy('at', 'desc').first();
  assert.equal(status.after.status, 'rejected');
});

test('GET /organizer/me never shows a sensitive KYC reason or its note to the owner or staff; safe reasons and notes still show', async () => {
  on();
  const reviewer = { id: (await admin()).sub, role: 'admin', superAdmin: true };
  // A partner-safe request for information: code and note are shown, as on /me/kyc.
  const a = await organizerFixture('Safe Reason Club');
  await db('PartnerKycCase').where({ id: a.kycCaseId }).update({ status: 'submitted', submittedAt: new Date().toISOString() });
  assert.equal((await partnerKycService.claim(a.kycCaseId, reviewer)).error, undefined);
  const asked = await partnerKycService.decide(a.kycCaseId, { decision: 'request_info', reasonCode: 'document_unreadable', reasonNote: 'spec: permit photo is blurry' }, reviewer);
  assert.equal(asked.error, undefined, JSON.stringify(asked));
  const am = (await call(organizerMe, a.claims)).body.organizer;
  assert.deepEqual([am.kycStatus, am.statusReasonCode, am.statusReason], ['info_requested', 'document_unreadable', 'spec: permit photo is blurry']);

  // Suspended as a duplicate partner: owner and staff get under_review, no note, and nothing naming the real reason.
  const f = await organizerFixture('Sensitive Reason Club');
  await decideKyc(f.kycCaseId, 'approved');
  const staff = await makeUser('organizer_staff', { organizerId: f.organizer.id, organizerRole: 'ops' });
  await eventCatalogueStore.addStaff({ organizerId: f.organizer.id, userId: staff.id, role: 'ops', addedBy: f.persona.id });
  const note = 'spec: same TIN as organizer evo_other';
  const suspended = await partnerKycService.decide(f.kycCaseId, { decision: 'suspend', reasonCode: 'duplicate_partner', reasonNote: note }, reviewer);
  assert.equal(suspended.error, undefined, JSON.stringify(suspended));
  for (const claims of [f.claims, claimsOf(staff)]) {
    const r = await call(organizerMe, claims);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.organizer.status, r.body.organizer.statusReasonCode, r.body.organizer.statusReason], ['suspended', 'under_review', null]);
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes('duplicate_partner') && !raw.includes('same TIN'), raw);
  }
  // Admins keep the real code and note: on the case and on the organizer row.
  assert.deepEqual(Object.values(await db('PartnerKycCase').where({ id: f.kycCaseId }).first('reasonCode', 'reasonNote')), ['duplicate_partner', note]);
  assert.equal((await db('EventOrganizer').where({ id: f.organizer.id }).first()).statusReason, note);

  // Fail closed: if the organizer row still holds the note but the case no longer has a code (the hook did not run),
  // the note is not shown. (Codes outside the catalogue are refused by partner_kyc_case_reason_chk / the helper's own specs.)
  await db('PartnerKycCase').where({ id: f.kycCaseId }).update({ status: 'submitted', reasonCode: null, reasonNote: null });
  assert.equal((await db('EventOrganizer').where({ id: f.organizer.id }).first()).statusReason, note);
  const m = (await call(organizerMe, f.claims)).body.organizer;
  assert.deepEqual([m.statusReasonCode, m.statusReason], [null, null]);
});

// ── Staff ─────────────────────────────────────────────────────────────────

test('staff: invitations through the organizer org type, acceptance creates the organizer_staff persona, role rules and refusals', async () => {
  on();
  const f = await activeOrganizer('Staffed Club');
  // Only owner/admin manage staff; a bad role and a self-invitation are refused.
  assert.equal((await call(organizerInviteStaff, f.claims, { body: { email: 'a@example.com', role: 'owner' } })).body.error, 'invalid_role');
  assert.equal((await call(organizerInviteStaff, f.claims, { body: { email: 'not-an-email', role: 'ops' } })).body.error, 'invalid_contact');
  assert.equal((await call(organizerInviteStaff, f.claims, { body: { role: 'ops' } })).body.error, 'invalid_contact');
  assert.equal((await call(organizerInviteStaff, f.claims, { body: { phone: f.persona.phone, role: 'ops' } })).body.error, 'cannot_invite_self');
  // A userId is never accepted (security review: no account probing, the mask is of what the caller typed).
  const someone = await makeUser('member');
  assert.deepEqual((await call(organizerInviteStaff, f.claims, { body: { userId: someone.id, role: 'ops' } })).body, { error: 'invalid_contact' });

  // Invite an existing verified person (email on their LoginIdentifier) as admin, then another as ops.
  const invitee = await makeUser('member', { email: `${uid('p')}@example.com`, firebaseUid: uid('fb') });
  await db('LoginIdentifier').insert({ id: uid('lid'), personId: invitee.personId, type: 'email', value: invitee.email, normalizedValue: invitee.email, verifiedAt: new Date(), status: 'active' });
  const sent = await call(organizerInviteStaff, f.claims, { body: { email: invitee.email.toUpperCase(), role: 'admin' } });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.invitation.status, 'invited');
  assert.equal(sent.body.invitation.role, 'admin');
  assert.match(sent.body.invitation.maskedContact, /^p•••@example\.com$/);
  const inv = await db('Invitation').where({ id: sent.body.invitation.id }).first();
  assert.equal(inv.orgType, 'organizer'); assert.equal(inv.organizerId, f.organizer.id); assert.equal(inv.role, 'staff'); assert.equal(inv.targetPersonId, invitee.personId);
  // The in-app notice names the organizer and the role in words, in both languages (English when no locale is chosen).
  const notice = await db('Notification').where({ id: `ntf_${inv.id}_${invitee.id}`.slice(0, 60) }).first();
  assert.ok(notice, 'the known person is told in-app');
  assert.equal(notice.title, 'You have an invitation');
  assert.equal(notice.body, 'Staffed Club invited you to join as admin.');
  assert.equal(notice.data.locale, 'en');
  assert.equal(notice.data.titleSw, 'Una mwaliko');
  assert.equal(notice.data.bodySw, 'Staffed Club imekualika kujiunga kama msimamizi.');
  // The staff list shows it as invited; a repeat invitation is the same open one (no duplicate).
  let list = await call(organizerListStaff, f.claims);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map(i => [i.role, i.status]), [['owner', 'active'], ['admin', 'invited']]);
  assert.equal((await call(organizerInviteStaff, f.claims, { body: { email: invitee.email, role: 'admin' } })).body.invitation.id, sent.body.invitation.id);

  // Accept as the invited person → organizer_staff persona + EventOrganizerStaff(admin) + membership.
  const accepted = await invitationService.accept({ user: await db('User').where({ id: invitee.id }).first(), invitationId: inv.id });
  assert.equal(accepted.error, undefined, JSON.stringify(accepted));
  const adminPersona = await db('User').where({ id: accepted.personaId }).first();
  assert.equal(adminPersona.userType, 'organizer_staff');
  assert.equal(adminPersona.organizerId, f.organizer.id);
  assert.equal(adminPersona.organizerRole, 'admin');
  assert.equal(adminPersona.personId, invitee.personId);
  const adminClaims = claimsOf(adminPersona);
  const adminMe = await call(organizerMe, adminClaims);
  assert.equal(adminMe.body.role, 'admin');
  assert.deepEqual(adminMe.body.permissions, ['overview', 'events:read', 'events:write', 'staff']);
  assert.ok(await db('OrgMembership').where({ organizerId: f.organizer.id, personaId: adminPersona.id, role: 'staff', status: 'active' }).first());
  // Inviting the same person again is already_staff.
  assert.equal((await call(organizerInviteStaff, f.claims, { body: { email: invitee.email, role: 'ops' } })).body.error, 'already_staff');

  // An admin invites an ops person by phone (a fresh identifier: no Person yet).
  const opsPhone = `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const opsSent = await call(organizerInviteStaff, adminClaims, { body: { phone: opsPhone, role: 'ops' } });
  assert.equal(opsSent.status, 201, JSON.stringify(opsSent.body));
  assert.match(opsSent.body.invitation.maskedContact, /^\+2557 •+ \d{3}$/);
  const opsUser = await makeUser('member', { phone: opsPhone, firebaseUid: uid('fb') });
  await db('LoginIdentifier').insert({ id: uid('lid'), personId: opsUser.personId, type: 'phone', value: opsPhone, normalizedValue: opsPhone, verifiedAt: new Date(), status: 'active' });
  await invitationService.claimFor(opsUser.personId);
  const opsAccepted = await invitationService.accept({ user: await db('User').where({ id: opsUser.id }).first(), invitationId: opsSent.body.invitation.id });
  assert.equal(opsAccepted.error, undefined, JSON.stringify(opsAccepted));
  const opsPersona = await db('User').where({ id: opsAccepted.personaId }).first();
  const opsClaims = claimsOf(opsPersona);
  list = await call(organizerListStaff, f.claims);
  assert.deepEqual(list.body.items.map(i => [i.role, i.status]), [['owner', 'active'], ['admin', 'active'], ['ops', 'active']]);
  const opsRow = list.body.items.find(i => i.role === 'ops');
  const ownerRow = list.body.items.find(i => i.role === 'owner');
  const adminRow = list.body.items.find(i => i.role === 'admin');

  // ops: no staff screen, read-only events, no creation.
  assert.equal((await call(organizerListStaff, opsClaims)).body.error, 'forbidden_role');
  assert.equal((await call(organizerListEvents, opsClaims)).status, 200);
  assert.equal((await call(organizerCreateEvent, opsClaims, { body: { title: 'Ops cannot' } })).body.error, 'forbidden_role');
  // Role rules: nobody touches the owner; an admin cannot remove another admin; the owner can.
  assert.deepEqual((await call(organizerRemoveStaff, adminClaims, { params: { id: ownerRow.id } })).body, { error: 'cannot_remove_owner' });
  assert.deepEqual((await call(organizerChangeStaffRole, f.claims, { params: { id: ownerRow.id }, body: { role: 'ops' } })).body, { error: 'cannot_remove_owner' });
  assert.equal((await call(organizerChangeStaffRole, f.claims, { params: { id: opsRow.id }, body: { role: 'owner' } })).body.error, 'invalid_role');
  const second = await makeUser('member', { email: `${uid('p2')}@example.com`, firebaseUid: uid('fb') });
  await db('LoginIdentifier').insert({ id: uid('lid'), personId: second.personId, type: 'email', value: second.email, normalizedValue: second.email, verifiedAt: new Date(), status: 'active' });
  // A person who chose Swahili for messages is told in Swahili.
  await db('CommunicationPreference').insert({ id: second.id, locale: 'sw', updatedAt: new Date() });
  const secondSent = await call(organizerInviteStaff, f.claims, { body: { email: second.email, role: 'admin' } });
  const swNotice = await db('Notification').where({ id: `ntf_${secondSent.body.invitation.id}_${second.id}`.slice(0, 60) }).first();
  assert.equal(swNotice.title, 'Una mwaliko');
  assert.equal(swNotice.body, 'Staffed Club imekualika kujiunga kama msimamizi.');
  assert.equal(swNotice.data.bodyEn, 'Staffed Club invited you to join as admin.');
  const secondAccepted = await invitationService.accept({ user: await db('User').where({ id: second.id }).first(), invitationId: secondSent.body.invitation.id });
  assert.equal(secondAccepted.error, undefined, JSON.stringify(secondAccepted));
  const secondRow = (await call(organizerListStaff, f.claims)).body.items.find(i => i.userId === secondAccepted.personaId);
  assert.deepEqual((await call(organizerRemoveStaff, adminClaims, { params: { id: secondRow.id } })).body, { error: 'forbidden_role' });
  assert.equal((await call(organizerChangeStaffRole, adminClaims, { params: { id: secondRow.id }, body: { role: 'ops' } })).body.error, 'forbidden_role');
  // An admin changes ops → finance, and removes them; the persona no longer opens the organizer.
  assert.deepEqual((await call(organizerChangeStaffRole, adminClaims, { params: { id: opsRow.id }, body: { role: 'finance' } })).body, { id: opsRow.id, role: 'finance' });
  assert.equal((await db('User').where({ id: opsPersona.id }).first()).organizerRole, 'finance');
  assert.deepEqual((await call(organizerRemoveStaff, adminClaims, { params: { id: opsRow.id } })).body, { removed: true });
  assert.deepEqual(await call(organizerMe, opsClaims), { status: 404, body: { error: 'no_organizer' } });
  assert.equal((await db('EventOrganizerStaff').where({ id: opsRow.id }).first()).status, 'removed');
  assert.equal((await db('OrgMembership').where({ organizerId: f.organizer.id, personaId: opsPersona.id }).first()).status, 'removed');
  // The owner removes the second admin; an open invitation can be withdrawn by its id.
  assert.deepEqual((await call(organizerRemoveStaff, f.claims, { params: { id: secondRow.id } })).body, { removed: true });
  const open = await call(organizerInviteStaff, f.claims, { body: { email: `${uid('x')}@example.com`, role: 'timing' } });
  assert.deepEqual((await call(organizerRemoveStaff, f.claims, { params: { id: open.body.invitation.id } })).body, { removed: true, invitation: true });
  assert.equal((await db('Invitation').where({ id: open.body.invitation.id }).first()).status, 'cancelled');
  assert.equal((await call(organizerRemoveStaff, f.claims, { params: { id: 'eos_nope' } })).status, 404);
  assert.equal(adminRow.role, 'admin');
});

// ── Events ────────────────────────────────────────────────────────────────

test('events: create → patch (CAS, validation codes, nested upsert, 403 tenancy) → submit checklist → withdraw → delete', async () => {
  on();
  const f = await activeOrganizer('Event Club');
  const other = await activeOrganizer('Other Club');
  const created = await call(organizerCreateEvent, f.claims, { body: { title: 'Dar Half Marathon' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  made.events.push(created.body.id);
  assert.equal(created.body.version, 1);
  assert.equal((await call(organizerCreateEvent, f.claims, { body: { title: 'ab' } })).body.fields[0].code, 'length');
  const id = created.body.id;

  // Tenancy: the other organizer sees 403 not_your_organizer, never a 404.
  assert.deepEqual(await call(organizerGetEvent, other.claims, { params: { id } }), { status: 403, body: { error: 'not_your_organizer' } });
  assert.equal((await call(organizerPatchEvent, other.claims, { params: { id }, body: { version: 1, title: 'Hijack' } })).body.error, 'not_your_organizer');
  assert.equal((await call(organizerSubmitEvent, other.claims, { params: { id } })).body.error, 'not_your_organizer');

  // The document starts as a draft; submit is refused with the full checklist.
  let doc = await call(organizerGetEvent, f.claims, { params: { id } });
  assert.equal(doc.body.status, 'draft');
  assert.deepEqual(doc.body.allowedActions, ['edit', 'submit', 'delete']);
  assert.equal(doc.body.slug, 'dar-half-marathon');
  const incomplete = await call(organizerSubmitEvent, f.claims, { params: { id } });
  assert.equal(incomplete.status, 422);
  assert.equal(incomplete.body.error, 'event_invalid');
  const codes = Object.fromEntries(incomplete.body.fields.map(x => [x.path, x.code]));
  assert.equal(codes['description.en'], 'required'); assert.equal(codes.categories, 'minCategory'); assert.equal(codes['terms.sw'], 'required');

  // Patch validation (422) and compare-and-set (409).
  const bad = await call(organizerPatchEvent, f.claims, { params: { id }, body: { version: 1, title: 'ab', routeUrl: 'http://x', categories: [{ name: '21K', distanceM: 21097, ticketTypes: [{ name: 'A', priceTzs: 10.5 }] }] } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.fields.map(x => `${x.path}:${x.code}`), ['title:length', 'routeUrl:httpsOnly', 'categories[0].ticketTypes[0].priceTzs:wholeShillings']);
  assert.deepEqual((await call(organizerPatchEvent, f.claims, { params: { id }, body: { version: 7, title: 'Stale' } })).body, { error: 'version_conflict', eventId: id, version: 1 });
  assert.equal((await call(organizerPatchEvent, f.claims, { params: { id }, body: { title: 'No version' } })).body.error, 'version_conflict');
  // Frozen fields never reach the store (dropped), status never changes from the body.
  const sneaky = await call(organizerPatchEvent, f.claims, { params: { id }, body: { version: 1, status: 'published', slug: 'hijack', termsSnapshot: { en: 'x' }, title: 'Dar Half Marathon 2027' } });
  assert.equal(sneaky.status, 200, JSON.stringify(sneaky.body));
  assert.deepEqual(sneaky.body, { version: 2, updatedAt: sneaky.body.updatedAt, material: false });
  const row = await eventStore.getEvent(id);
  assert.equal(row.status, 'draft'); assert.equal(row.slug, 'dar-half-marathon'); assert.equal(row.termsSnapshot, null); assert.equal(row.title, 'Dar Half Marathon 2027');

  // The full document with nested rows.
  const full = await call(organizerPatchEvent, f.claims, { params: { id }, body: fullDocument(2) });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  doc = await call(organizerGetEvent, f.claims, { params: { id } });
  assert.equal(doc.body.categories.length, 2);
  const c21 = doc.body.categories.find(c => c.name === '21K');
  assert.equal(c21.distanceM, 21097); assert.equal(c21.capacity, 500);
  assert.deepEqual(c21.ticketTypes.map(t => [t.name, t.priceTzs, t.capacity]), [['Early bird', 25000, 100], ['Standard', 35000, null]]);
  assert.deepEqual(doc.body.description, { en: 'A'.repeat(60), sw: 'B'.repeat(60) });
  assert.deepEqual(doc.body.venue, { name: 'Coco Beach', city: 'Dar es Salaam', region: 'dar-es-salaam', address: 'Toure Drive', lat: -6.75, lng: 39.27 });
  assert.equal(doc.body.utcOffsetMinutes, 180); assert.equal(doc.body.timezoneAbbr, 'EAT');
  assert.equal(doc.body.refundPolicy.preset, 'refund_until_close');
  assert.equal(doc.body.terms.en, 'T'.repeat(120));
  assert.equal(doc.body.availability, 'closed'); // a draft is never open
  // Nested upsert by id: rename one ticket, drop the other, add a category; the ids of kept rows survive.
  const early = c21.ticketTypes[0];
  const upsert = await call(organizerPatchEvent, f.claims, { params: { id }, body: { version: doc.body.version, categories: [
    { id: c21.id, name: '21K Half', distanceM: 21097, startsAt: c21.startsAt, capacity: 600, ticketTypes: [{ id: early.id, name: 'Early bird', priceTzs: 20000, capacity: 100 }] },
    { name: '10K', distanceM: 10000, startsAt: c21.startsAt, ticketTypes: [{ name: 'Standard', priceTzs: 15000, capacity: 50 }] },
  ] } });
  assert.equal(upsert.status, 200, JSON.stringify(upsert.body));
  doc = await call(organizerGetEvent, f.claims, { params: { id } });
  assert.deepEqual(doc.body.categories.map(c => c.name).sort(), ['10K', '21K Half']);
  const kept = doc.body.categories.find(c => c.id === c21.id);
  assert.equal(kept.capacity, 600);
  assert.deepEqual(kept.ticketTypes.map(t => [t.id, t.priceTzs]), [[early.id, 20000]]);
  assert.equal(await db('EventTicketType').where({ eventId: id }).count({ n: '*' }).first().then(r => Number(r.n)), 2);
  assert.equal(doc.body.changeLogCount, 0); // drafts are not logged
  // Submit → submitted (snapshots frozen, submittedAt set, analytics row); the document is read-only now.
  const submitted = await call(organizerSubmitEvent, f.claims, { params: { id } });
  assert.deepEqual(submitted.body, { status: 'submitted' });
  const sub = await eventStore.getEvent(id);
  assert.deepEqual(sub.termsSnapshot, { en: 'T'.repeat(120), sw: 'M'.repeat(120) });
  assert.equal(sub.refundPolicySnapshot.preset, 'refund_until_close');
  assert.ok(sub.submittedAt);
  assert.ok(await db('AuditLog').where({ action: 'analytics.organizer_event_submitted', target: id }).first());
  doc = await call(organizerGetEvent, f.claims, { params: { id } });
  assert.deepEqual(doc.body.allowedActions, ['withdraw']);
  assert.ok(doc.body.submittedAt);
  assert.equal((await call(organizerPatchEvent, f.claims, { params: { id }, body: { version: doc.body.version, title: 'Locked' } })).body.error, 'invalid_transition');
  assert.equal((await call(organizerSubmitEvent, f.claims, { params: { id } })).body.error, 'invalid_transition');
  assert.equal((await call(organizerDeleteEvent, f.claims, { params: { id } })).body.error, 'invalid_transition');
  // Withdraw → draft; delete the draft.
  assert.deepEqual((await call(organizerWithdrawEvent, f.claims, { params: { id } })).body, { status: 'draft' });
  assert.deepEqual((await call(organizerDeleteEvent, f.claims, { params: { id } })).body, { deleted: true });
  assert.equal(await eventStore.getEvent(id), null);
  assert.equal((await call(organizerGetEvent, f.claims, { params: { id } })).status, 403);
  // Lists and summary.
  const e2 = await draftEvent(f);
  const list = await call(organizerListEvents, f.claims, { query: { status: 'draft' } });
  assert.equal(list.body.items.some(i => i.id === e2.id), true);
  assert.equal(list.body.items.find(i => i.id === e2.id).categoriesCount, 2);
  assert.deepEqual(list.body.items.find(i => i.id === e2.id).distancesM, [5000, 21097]);
  assert.equal(list.body.nextCursor, null);
  assert.equal((await call(organizerListEvents, f.claims, { query: { status: 'published' } })).body.items.length, 0);
  const summary = await call(organizerSummary, f.claims);
  assert.equal(summary.body.eventsTotal, 1); assert.equal(summary.body.publishedTotal, 0); assert.equal(summary.body.registrationsTotal, 0);
  assert.equal(summary.body.nextEvents[0].id, e2.id);
});

test('published events: non-material edits log; material edits need a change note (409) and log as material; cancel rules incl. D12 has_registrations; complete and archive', async () => {
  on();
  const f = await activeOrganizer('Published Club');
  const e = await publishedEvent(f);
  let doc = await call(organizerGetEvent, f.claims, { params: { id: e.id } });
  assert.equal(doc.body.status, 'published');
  assert.deepEqual(doc.body.allowedActions, ['edit', 'cancel']);
  assert.ok(doc.body.publishedAt);
  assert.ok(await db('AuditLog').where({ action: 'analytics.event_published', target: e.id }).first());
  // Non-material: saves with no note, one change-log row (minor).
  const minor = await call(organizerPatchEvent, f.claims, { params: { id: e.id }, body: { version: doc.body.version, description: { en: 'C'.repeat(60), sw: 'D'.repeat(60) } } });
  assert.equal(minor.status, 200, JSON.stringify(minor.body));
  assert.equal(minor.body.material, false);
  // Material without a note: refused, nothing written.
  const newStart = new Date(+starts + D).toISOString();
  const refused = await call(organizerPatchEvent, f.claims, { params: { id: e.id }, body: { version: minor.body.version, startsAt: newStart, endsAt: new Date(+starts + D + 6 * H).toISOString() } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'change_note_required');
  const longNote = await call(organizerPatchEvent, f.claims, { params: { id: e.id }, body: { version: minor.body.version, startsAt: newStart, endsAt: new Date(+starts + D + 6 * H).toISOString(), changeNote: { en: 'n'.repeat(501), sw: 'ok' } } });
  assert.deepEqual(longNote.body, { error: 'event_invalid', fields: [{ path: 'changeNote.en', code: 'too_long', max: 500 }] });
  assert.deepEqual(refused.body.fields, ['endsAt', 'startsAt']);
  assert.equal((await eventStore.getEvent(e.id)).version, minor.body.version);
  // With a note: saved, material, logged with before/after and the note; frozen snapshots untouched.
  const material = await call(organizerPatchEvent, f.claims, { params: { id: e.id }, body: { version: minor.body.version, startsAt: newStart, endsAt: new Date(+starts + D + 6 * H).toISOString(), changeNote: { en: 'Start moved a day', sw: 'Kuanza kumesogezwa siku moja' } } });
  assert.equal(material.status, 200, JSON.stringify(material.body));
  assert.equal(material.body.material, true);
  const changes = await call(organizerEventChanges, f.claims, { params: { id: e.id } });
  assert.equal(changes.body.items.length, 2);
  assert.equal(changes.body.items[0].material, true);
  assert.deepEqual(changes.body.items[0].fields, ['endsAt', 'startsAt']);
  assert.equal(changes.body.items[0].before.startsAt, starts.toISOString());
  assert.equal(changes.body.items[0].after.startsAt, newStart);
  assert.deepEqual(changes.body.items[0].note, { en: 'Start moved a day', sw: 'Kuanza kumesogezwa siku moja' });
  assert.equal(changes.body.items[0].actor.role, 'owner');
  assert.equal(changes.body.items[1].material, false);
  assert.deepEqual(changes.body.items[1].fields, ['description.en', 'description.sw']);
  assert.equal((await call(organizerGetEvent, f.claims, { params: { id: e.id } })).body.changeLogCount, 2);
  // A price change is material too; a frozen column in the body is dropped, not an error.
  doc = await call(organizerGetEvent, f.claims, { params: { id: e.id } });
  const cat = doc.body.categories[0];
  const price = await call(organizerPatchEvent, f.claims, { params: { id: e.id }, body: { version: doc.body.version, categories: doc.body.categories.map(c => ({ ...c, startsAt: newStart, ticketTypes: c.ticketTypes.map(t => ({ ...t, priceTzs: t.priceTzs + 1000 })) })) } });
  assert.equal(price.body.error, 'change_note_required', JSON.stringify(price.body));
  assert.ok(price.body.fields.every(p => p.includes(`categories[${cat.id}]`) || p.includes('categories[')));
  // Delete is for drafts only.
  assert.equal((await call(organizerDeleteEvent, f.claims, { params: { id: e.id } })).body.error, 'invalid_transition');

  // D12: a confirmed registration blocks the organizer's cancel; FitFlex still can (admin spec).
  const tt = await db('EventTicketType').where({ eventId: e.id }).first();
  const buyer = await makeUser('member');
  const order = await eventStore.createOrderWithHolds({ eventId: e.id, purchaserUserId: buyer.id, lines: [{ ticketTypeId: tt.id, quantity: 1 }], participants: [{ ticketTypeId: tt.id, firstName: 'Asha', lastName: 'Juma', phone: '+255700000001', consentBasis: 'self' }] });
  assert.equal(order.error, undefined, JSON.stringify(order));
  const committed = await eventStore.commitOrder(order.order.id);
  assert.equal(committed.error, undefined, JSON.stringify(committed));
  assert.equal(committed.registrations[0].status, 'confirmed');
  assert.equal((await call(organizerCancelEvent, f.claims, { params: { id: e.id }, body: {} })).body.error, 'reason_code_required');
  assert.deepEqual((await call(organizerCancelEvent, f.claims, { params: { id: e.id }, body: { reason: 'weather', note: { en: 'n'.repeat(501), sw: 'x' } } })).body, { error: 'event_invalid', fields: [{ path: 'note.en', code: 'too_long', max: 500 }] });
  assert.deepEqual((await call(organizerCancelEvent, f.claims, { params: { id: e.id }, body: { reason: 'weather' } })).body, { error: 'has_registrations' });
  assert.equal((await eventStore.getEvent(e.id)).status, 'published');

  // A second published event: cancel with a reason and note, then archive; complete from in_progress.
  const g = await publishedEvent(f, { title: 'Second Race' });
  const cancelled = await call(organizerCancelEvent, f.claims, { params: { id: g.id }, body: { reason: 'permit', note: { en: 'No permit', sw: 'Hakuna kibali' } } });
  assert.deepEqual(cancelled.body, { status: 'cancelled' });
  const grow = await eventStore.getEvent(g.id);
  assert.deepEqual(grow.cancellation, { reason: 'permit', note: { en: 'No permit', sw: 'Hakuna kibali' } });
  assert.ok(grow.cancelledAt);
  assert.deepEqual((await call(organizerGetEvent, f.claims, { params: { id: g.id } })).body.allowedActions, ['archive']);
  assert.deepEqual((await call(organizerArchiveEvent, f.claims, { params: { id: g.id } })).body, { status: 'archived' });
  assert.equal((await call(organizerArchiveEvent, f.claims, { params: { id: g.id } })).body.error, 'invalid_transition');
  const h = await publishedEvent(f, { title: 'Third Race' });
  assert.equal((await call(organizerCompleteEvent, f.claims, { params: { id: h.id } })).body.error, 'invalid_transition');
  assert.equal((await eventStore.transitionEvent(h.id, 'in_progress')).to, 'in_progress');
  assert.deepEqual((await call(organizerGetEvent, f.claims, { params: { id: h.id } })).body.allowedActions, ['complete', 'cancel']);
  assert.deepEqual((await call(organizerCompleteEvent, f.claims, { params: { id: h.id } })).body, { status: 'completed' });
  // Audit rows carry before/after status.
  const audit = await db('AuditLog').where({ action: 'events.completed', target: h.id }).first();
  assert.deepEqual(audit.before, { status: 'in_progress' });
  assert.equal(audit.after.status, 'completed');
  assert.equal(audit.after.by, 'organizer');
  // Store-level: the service's lifecycle helper is what everything else uses.
  assert.equal(typeof eventsOrganizerService.moveEvent, 'function');
  assert.equal(typeof eventCatalogueStore.dueTransitions, 'function');
});
