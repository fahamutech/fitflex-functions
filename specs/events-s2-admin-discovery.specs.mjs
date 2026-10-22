// Marathon & running events · S2 — admin moderation, public discovery, favourites and the lifecycle job,
// route level against the CI database: the flag and the ACL scope, decisions with audit rows, the queue
// with permitOnFile, cancel with registrations (admin may, D12), discovery filters / sort / pagination /
// availability / closing-soon / sold-out, drafts never revealed, favourites, and automatic transitions.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { eventStore, eventCatalogueStore, opsService } from '../src/bootstrap/services.mjs';
import { UNLIMITED_CAPACITY } from '../src/shared/events-document.mjs';
import { PORTAL_ACL_SCOPES } from '../src/services/portal-user-service.mjs';
import { adminListEvents, adminEventsSummary, adminEventsAudit, adminGetEvent, adminDecideEvent, adminCancelEvent, adminArchiveEvent, adminCompleteEvent, adminEventAudit } from '../functions/events-admin.mjs';
import { eventsOptions, eventsList, eventDetail, saveEventFavourite, removeEventFavourite } from '../functions/events-public.mjs';
import { organizerGetEvent, organizerSubmitEvent, organizerEventChanges } from '../functions/events-organizer.mjs';
import { invitationService } from '../src/bootstrap/services.mjs';
import { eventLifecycle } from '../functions/jobs.mjs';
import { postPromotionEvents } from '../functions/promotion-events.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const H = 3_600_000; const D = 24 * H;
const made = { users: [], organizers: [], events: [] };
const FLAGS = ['EVENTS_MODULE', 'EVENTS_FAVOURITES', 'EVENTS_REGISTRATION', 'EVENTS_CLOSING_SOON_HOURS', 'EVENT_AUTO_COMPLETE_GRACE_HOURS'];
const on = (extra = {}) => { process.env.EVENTS_MODULE = '1'; Object.assign(process.env, extra); };
afterEach(() => { for (const f of FLAGS) delete process.env[f]; });

after(async () => {
  for (const f of FLAGS) delete process.env[f];
  const events = made.events;
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
    await db('AuditLog').whereIn('target', events).del();
    await db('Event').whereIn('id', events).del();
  }
  if (made.organizers.length) {
    await db('EventOrganizerStaff').whereIn('organizerId', made.organizers).del();
    await db('OrgMembership').whereIn('organizerId', made.organizers).del();
    await db('Invitation').whereIn('organizerId', made.organizers).del();
    await db('AuditLog').whereIn('target', made.organizers).del();
    await db('EventOrganizer').whereIn('id', made.organizers).del();
  }
  const caseIds = (await db('PartnerKycCase').whereIn('userId', made.users).select('id')).map(r => r.id);
  await db('PartnerDocument').whereIn('caseId', caseIds).del();
  await db('PartnerKycCase').whereIn('id', caseIds).del();
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('User').whereIn('id', made.users).del();
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
    if (!passed) return { status: out.statusCode, body: out.body, ended: out.ended };
  }
  await route.onRequest(req, out);
  return { status: out.statusCode, body: out.body, ended: out.ended };
}

async function user(userType = 'member', extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `S2 ${userType}`, accountStatus: 'active', approvalStatus: 'approved', updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
const superAdmin = async () => ({ sub: await user('admin'), userType: 'admin' });
const staffWith = async (...scopes) => ({ sub: await user('admin', { portalUser: true }), userType: 'admin', portalUser: true, aclPermissions: scopes });

/** An organizer straight from the store, with an approved KYC case and the derived status set (no review walk). */
async function organizer({ status = 'active', kyc = 'approved', name = 'Dar Runners' } = {}) {
  const ownerUserId = await user('event_organizer');
  const row = await eventStore.createOrganizer({ ownerUserId, name });
  made.organizers.push(row.id);
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'event_organizer', userId: ownerUserId, status: kyc, tier: 3, updatedAt: new Date() });
  await eventCatalogueStore.patchOrganizer(row.id, { kycCaseId: caseId });
  await eventCatalogueStore.setOrganizerStatus(row.id, status, status === 'active' ? null : 'spec');
  await eventCatalogueStore.addStaff({ organizerId: row.id, userId: ownerUserId, role: 'owner' });
  await db('User').where({ id: ownerUserId }).update({ organizerId: row.id, organizerRole: 'owner' });
  return { id: row.id, ownerUserId, caseId, claims: { sub: ownerUserId, userType: 'event_organizer' } };
}

const base = (over = {}) => {
  const startsAt = over.startsAt ?? new Date(+new Date() + 30 * D);
  return {
    title: 'Dar Half Marathon', eventType: 'road', timezone: 'Africa/Dar_es_Salaam', description: 'E'.repeat(50), descriptionSw: 'S'.repeat(50),
    startsAt, endsAt: new Date(+startsAt + 6 * H), registrationClosesAt: new Date(+startsAt - D), venueName: 'Coco Beach', venueAddress: 'Toure Drive', venueCity: 'Dar es Salaam', venueRegion: 'dar-es-salaam', lat: -6.75, lng: 39.27,
    terms: { en: 'T'.repeat(120), sw: 'M'.repeat(120) }, refundPolicy: { preset: 'no_refund', text: {} }, contact: { email: 'race@example.com' }, ...over,
  };
};

/**
 * An event in `status` with categories [{ name, distanceMeters, tickets: [{ priceTzs, capacity, sold?, saleOpensAt?, saleClosesAt? }] }].
 * Moves through the S1 machine directly (the organizer and admin specs cover the routes).
 */
async function seed(org, { status = 'published', categories = [{ name: '21K', distanceMeters: 21097, tickets: [{ priceTzs: 25000, capacity: 100 }] }], ...over } = {}) {
  const created = await eventStore.createEvent({ organizerId: org.id, slug: `${uid('race').replace(/_/g, '-')}`, ...base(over) });
  assert.equal(created.error, undefined, JSON.stringify(created));
  made.events.push(created.id);
  for (const c of categories) {
    const cat = await eventStore.createCategory({ eventId: created.id, name: c.name, distanceMeters: c.distanceMeters, startTime: c.startTime ?? created.startsAt });
    for (const t of c.tickets || []) {
      const tt = await eventStore.createTicketType({ eventId: created.id, categoryId: cat.id, name: t.name || `Ticket ${uid('t')}`, priceTzs: t.priceTzs, capacity: t.capacity ?? UNLIMITED_CAPACITY, saleOpensAt: t.saleOpensAt ?? null, saleClosesAt: t.saleClosesAt ?? null });
      assert.equal(tt.error, undefined, JSON.stringify(tt));
      if (t.sold) await db('EventTicketType').where({ id: tt.id }).update({ sold: t.sold });
    }
  }
  const path = { draft: [], submitted: ['submitted'], published: ['submitted', 'published'], registration_closed: ['submitted', 'published', 'registration_closed'], in_progress: ['submitted', 'published', 'in_progress'], completed: ['submitted', 'published', 'in_progress', 'completed'], cancelled: ['submitted', 'published', 'cancelled'], archived: ['submitted', 'published', 'cancelled', 'archived'] }[status];
  for (const to of path) assert.equal((await eventStore.transitionEvent(created.id, to)).to, to);
  if (status === 'submitted') await eventCatalogueStore.patchEventRaw(created.id, { submittedAt: new Date() });
  return eventStore.getEvent(created.id);
};

// ── Flags and ACL ─────────────────────────────────────────────────────────

test('EVENTS_MODULE off: admin, public and favourite routes answer 404 feature_disabled; options never does', async () => {
  const admin = await superAdmin();
  for (const [route, params] of [[adminListEvents, {}], [adminEventsSummary, {}], [adminGetEvent, { id: 'x' }], [adminDecideEvent, { id: 'x' }], [adminEventsAudit, {}]]) {
    const r = await call(route, admin, { params });
    assert.deepEqual([r.status, r.body], [404, { error: 'feature_disabled' }], route.path);
  }
  assert.deepEqual((await call(eventsList, null)).body, { error: 'feature_disabled' });
  assert.deepEqual((await call(eventDetail, null, { params: { idOrSlug: 'x' } })).body, { error: 'feature_disabled' });
  assert.equal((await call(saveEventFavourite, admin, { params: { eventId: 'x' } })).body.error, 'feature_disabled');
  assert.equal((await call(eventsOptions, null)).body.discovery, false);
  on();
  const options = (await call(eventsOptions, null)).body;
  assert.equal(options.discovery, true); assert.equal(options.favourites, false); assert.equal(options.registration, false);
  process.env.EVENTS_FAVOURITES = '1'; process.env.EVENTS_REGISTRATION = '1'; process.env.EVENTS_CLOSING_SOON_HOURS = '48';
  const all = (await call(eventsOptions, null)).body;
  assert.equal(all.favourites, true); assert.equal(all.registration, true); assert.equal(all.closingSoonHours, 48);
  assert.deepEqual(all.types, ['road', 'trail', 'fun', 'charity', 'virtual']);
  assert.deepEqual(all.distances, ['5k', '10k', '21k', '42k', 'other']);
});

test('portal ACL: the events scope is grantable; staff without it are refused, with it (or super-admin) admitted', async () => {
  on();
  assert.ok(PORTAL_ACL_SCOPES.includes('events'));
  assert.deepEqual((await call(adminEventsSummary, await staffWith('gyms', 'kyc'))).body, { error: 'acl_forbidden', requiredScope: 'events' });
  assert.equal((await call(adminEventsSummary, await staffWith('events'))).status, 200);
  assert.equal((await call(adminEventsSummary, await superAdmin())).status, 200);
  assert.equal((await call(adminEventsSummary, { sub: 'm', userType: 'member' })).status, 403);
});

test('the existing POST /events (promotion analytics) keeps working next to GET /events, flag on or off; the GET guards never run for it', async () => {
  // bfast mounts guards with app.use(path) (prefix, method-blind); routeGuard keeps them to their own method + exact path.
  const asMounted = async (route, method, mountPath, remainder) => {
    const req = { method, headers: {}, params: {}, query: {}, body: {}, baseUrl: mountPath, path: remainder, get: () => null };
    const out = res();
    let passed = false;
    for (const guard of [route.onGuard].flat().filter(Boolean)) { passed = false; await guard(req, out, () => { passed = true; }); if (!passed) break; }
    return { passed, status: out.statusCode, body: out.body };
  };
  for (const flag of [false, true]) {
    if (flag) on(); else delete process.env.EVENTS_MODULE;
    // A POST reaching the GET /events guard (same mount path) passes straight through, whatever the flag.
    assert.deepEqual(await asMounted(eventsList, 'POST', '/events', '/'), { passed: true, status: 200, body: null }, `flag ${flag}`);
    assert.deepEqual(await asMounted(eventDetail, 'POST', '/events/:idOrSlug', '/'), { passed: true, status: 200, body: null }, `flag ${flag}`);
    // While a real GET /events is refused with the flag off and served with it on.
    const get = await asMounted(eventsList, 'GET', '/events', '/');
    assert.equal(get.passed, flag, `flag ${flag}`);
    if (!flag) assert.deepEqual(get.body, { error: 'feature_disabled' });
    // The analytics route itself (no guard) answers the same way with the module on or off.
    const r = await call(postPromotionEvents, null, { body: { source: 'mobile', events: [{ type: 'impression', entityType: 'gym', entityId: 'gym_x', promotionId: 'prm_x', sessionId: 'sess_x' }] } });
    assert.equal(r.status, 202, `flag ${flag}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(await call(postPromotionEvents, null, { body: { events: [] } }), { status: 400, body: { error: 'events_required' }, ended: false }, `flag ${flag}: the route's own validation is untouched`);
  }
  assert.equal(postPromotionEvents.onGuard, undefined, 'the analytics route carries no guard that could catch GET /events');
});

// ── Moderation ────────────────────────────────────────────────────────────

test('queue, summary, detail, decisions (approve → published, reject → draft with reason+note), audit rows', async () => {
  on();
  const org = await organizer({ name: 'Moderated Club' });
  const submitted = await seed(org, { status: 'submitted' });
  const admin = await superAdmin();
  // Queue: submitted first, organizer card, permit not on file yet.
  const before = await call(adminEventsSummary, admin);
  const queue = await call(adminListEvents, admin, { query: { status: 'submitted' } });
  assert.equal(queue.status, 200);
  const row = queue.body.items.find(i => i.id === submitted.id);
  assert.ok(row);
  assert.equal(row.status, 'submitted');
  assert.ok(row.submittedAt);
  assert.equal(row.permitOnFile, false);
  assert.deepEqual(row.organizer, { id: org.id, name: 'Moderated Club', status: 'active', kycCaseId: org.caseId, permitOnFile: false });
  assert.deepEqual(row.allowedActions, ['approve', 'reject']);
  assert.ok(before.body.submitted >= 1);
  // A permit document on the organizer's case flips permitOnFile.
  await db('PartnerDocument').insert({ id: uid('doc'), caseId: org.caseId, round: 1, requirementKey: 'event_permit', docType: 'event_permit', storageProvider: 'zebra', storageKey: 'k', fileName: 'permit.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64), status: 'pending', createdAt: new Date(), updatedAt: new Date() });
  assert.equal((await call(adminGetEvent, admin, { params: { id: submitted.id } })).body.permitOnFile, true);
  const detail = await call(adminGetEvent, admin, { params: { id: submitted.id } });
  assert.deepEqual(detail.body.allowedActions, ['approve', 'reject']);
  assert.deepEqual(detail.body.description, { en: 'E'.repeat(50), sw: 'S'.repeat(50) });
  assert.equal(detail.body.organizer.id, org.id);
  assert.equal((await call(adminGetEvent, admin, { params: { id: 'evt_nope' } })).body.error, 'event_not_found');
  // Reject: reason and note are required; the organizer sees the event as draft with the rejection.
  assert.deepEqual((await call(adminDecideEvent, admin, { params: { id: submitted.id }, body: { decision: 'reject', note: 'x' } })).body, { error: 'reason_code_required', allowed: ['incomplete_details', 'permit_missing', 'pricing_unclear', 'terms_unclear', 'duplicate_event', 'policy_violation', 'other'] });
  assert.deepEqual((await call(adminDecideEvent, admin, { params: { id: submitted.id }, body: { decision: 'reject', reason: 'permit_missing' } })).body, { error: 'note_required' });
  assert.equal((await call(adminDecideEvent, admin, { params: { id: submitted.id }, body: { decision: 'maybe' } })).body.error, 'invalid_decision');
  const rejected = await call(adminDecideEvent, admin, { params: { id: submitted.id }, body: { decision: 'reject', reason: 'permit_missing', note: 'Upload the permit first.' } });
  assert.deepEqual(rejected.body, { status: 'draft' });
  const orgView = await call(organizerGetEvent, org.claims, { params: { id: submitted.id } });
  assert.equal(orgView.body.status, 'draft');
  assert.equal(orgView.body.rejection.reason, 'permit_missing');
  assert.equal(orgView.body.rejection.note, 'Upload the permit first.');
  assert.ok(orgView.body.rejection.at);
  assert.equal((await call(adminDecideEvent, admin, { params: { id: submitted.id }, body: { decision: 'approve' } })).body.error, 'invalid_transition');
  // Resubmit and approve → published with publishedAt; the rejection is cleared; audit rows carry before/after.
  const resubmitted = await call(organizerSubmitEvent, org.claims, { params: { id: submitted.id } });
  assert.deepEqual(resubmitted.body, { status: 'submitted' });
  const approved = await call(adminDecideEvent, admin, { params: { id: submitted.id }, body: { decision: 'approve', note: 'Looks good' } });
  assert.equal(approved.body.status, 'published');
  assert.ok(approved.body.publishedAt);
  assert.equal((await eventStore.getEvent(submitted.id)).rejection, null);
  const audit = await call(adminEventAudit, admin, { params: { id: submitted.id } });
  assert.deepEqual(audit.body.items.map(i => i.action), ['events.published', 'events.submitted', 'events.rejected']);
  assert.equal(audit.body.items[2].reason, 'permit_missing');
  assert.equal(audit.body.items[2].note, 'Upload the permit first.');
  assert.deepEqual(audit.body.items[2].before, { status: 'submitted' });
  assert.equal(audit.body.items[2].after.status, 'draft');
  assert.equal(audit.body.items[0].actor.id, admin.sub);
  const global = await call(adminEventsAudit, admin, { query: { action: 'published' } });
  assert.ok(global.body.items.some(i => i.target === submitted.id && i.action === 'events.published'));
  assert.ok(global.body.items.every(i => i.action === 'events.published'));
  assert.ok(await db('AuditLog').where({ action: 'analytics.event_published', target: submitted.id }).first());
  // Approval needs an active organizer with an approved case (follow-ups S2).
  const pending = await organizer({ status: 'pending_review', kyc: 'in_review', name: 'Not yet' });
  const early = await seed(pending, { status: 'submitted' });
  assert.deepEqual((await call(adminDecideEvent, admin, { params: { id: early.id }, body: { decision: 'approve' } })).body, { error: 'organizer_not_active', organizerStatus: 'pending_review' });
  assert.equal((await eventStore.getEvent(early.id)).status, 'submitted');
  // L4: a staff invitation at an organizer that is not active cannot be accepted; the invitation stays open.
  const inviteeId = await user('member', { email: `${uid('inv')}@example.com`, firebaseUid: uid('fb') });
  const invitee = await db('User').where({ id: inviteeId }).first();
  await db('LoginIdentifier').insert({ id: uid('lid'), personId: invitee.personId, type: 'email', value: invitee.email, normalizedValue: invitee.email, verifiedAt: new Date(), status: 'active' });
  const sent = await invitationService.create({ actor: { id: pending.ownerUserId, userType: 'event_organizer' }, orgType: 'organizer', orgId: pending.id, body: { email: invitee.email, role: 'staff', organizerRole: 'ops' } });
  assert.equal(sent.error, undefined, JSON.stringify(sent));
  const refused = await invitationService.accept({ user: invitee, invitationId: sent.invitation.id });
  assert.deepEqual([refused.error, refused.status, refused.organizerStatus], ['organizer_not_active', 409, 'pending_review']);
  assert.equal((await db('Invitation').where({ id: sent.invitation.id }).first()).status, 'pending');
  assert.equal(await db('User').where({ personId: invitee.personId, userType: 'organizer_staff' }).first(), undefined);
});

test('admin cancel (even with confirmed registrations, D12), complete and archive; every action audited', async () => {
  on();
  const org = await organizer({ name: 'Cancelled Club' });
  const published = await seed(org);
  const tt = await db('EventTicketType').where({ eventId: published.id }).first();
  const buyer = await user('member');
  const order = await eventStore.createOrderWithHolds({ eventId: published.id, purchaserUserId: buyer, lines: [{ ticketTypeId: tt.id, quantity: 1 }], participants: [{ ticketTypeId: tt.id, firstName: 'Asha', lastName: 'Juma', phone: '+255700000001', consentBasis: 'self' }] });
  assert.equal(order.error, undefined, JSON.stringify(order));
  assert.equal((await eventStore.commitOrder(order.order.id)).error, undefined);
  const admin = await superAdmin();
  assert.equal((await call(adminCancelEvent, admin, { params: { id: published.id }, body: { note: { en: 'x' } } })).body.error, 'reason_code_required');
  assert.deepEqual((await call(adminCancelEvent, admin, { params: { id: published.id }, body: { reason: 'safety', note: { en: 'Flooding', sw: 'Mafuriko' } } })).body, { status: 'cancelled' });
  const row = await eventStore.getEvent(published.id);
  assert.equal(row.status, 'cancelled');
  assert.deepEqual(row.cancellation, { reason: 'safety', note: { en: 'Flooding', sw: 'Mafuriko' } });
  const log = await eventCatalogueStore.listChangeLog(published.id);
  assert.equal(log.length, 1); assert.equal(log[0].material, true); assert.deepEqual(log[0].fields, ['status']); assert.equal(log[0].actorRole, 'admin');
  // The organizer sees the role, never the admin's name (L3).
  const seen = await call(organizerEventChanges, org.claims, { params: { id: published.id } });
  assert.deepEqual(seen.body.items[0].actor, { name: null, role: 'admin' });
  assert.deepEqual((await call(adminCancelEvent, admin, { params: { id: published.id }, body: { reason: 'safety', note: { en: 'n'.repeat(501) } } })).body, { error: 'event_invalid', fields: [{ path: 'note.en', code: 'too_long', max: 500 }] });
  assert.deepEqual((await call(adminGetEvent, admin, { params: { id: published.id } })).body.allowedActions, ['archive']);
  const live = await seed(org, { title: 'Live for actions' });
  assert.deepEqual((await call(adminGetEvent, admin, { params: { id: live.id } })).body.allowedActions, ['cancel'], 'no admin edit action (L8)');
  assert.deepEqual((await call(adminArchiveEvent, admin, { params: { id: published.id } })).body, { status: 'archived' });
  assert.ok((await eventStore.getEvent(published.id)).cancelledAt, 'archiving keeps the cancellation time');
  const running = await seed(org, { status: 'in_progress' });
  assert.deepEqual((await call(adminCompleteEvent, admin, { params: { id: running.id } })).body, { status: 'completed' });
  const actions = (await call(adminEventAudit, admin, { params: { id: published.id } })).body.items.map(i => i.action);
  assert.deepEqual(actions, ['events.archived', 'events.cancelled']);
});

// ── Discovery ─────────────────────────────────────────────────────────────

test('GET /events: default statuses only, filters, sort, opaque cursor pagination, computed fields; drafts never revealed', async () => {
  on();
  const org = await organizer({ name: 'Discovery Club' });
  const soon = new Date(+new Date() + 5 * D);
  const later = new Date(+new Date() + 20 * D);
  const a = await seed(org, { title: 'Alpha Half Dar', startsAt: soon, venueRegion: 'dar-es-salaam', categories: [{ name: '21K', distanceMeters: 21097, tickets: [{ priceTzs: 30000, capacity: 100 }, { priceTzs: 25000, capacity: 50 }] }] });
  const b = await seed(org, { title: 'Bravo Trail Arusha', eventType: 'trail', startsAt: later, venueRegion: 'arusha', venueCity: 'Arusha', categories: [{ name: '10K', distanceMeters: 10000, tickets: [{ priceTzs: 0, capacity: 100 }] }, { name: '5K', distanceMeters: 5000, tickets: [{ priceTzs: 15000, capacity: 100 }] }] });
  const c = await seed(org, { title: 'Charlie Closed', status: 'registration_closed', startsAt: new Date(+later + D) });
  const d = await seed(org, { title: 'Delta Running', status: 'in_progress', startsAt: new Date(+new Date() - H), endsAt: new Date(+new Date() + 5 * H) });
  const soldOut = await seed(org, { title: 'Echo Sold Out', startsAt: new Date(+later + 2 * D), categories: [{ name: '42K', distanceMeters: 42195, tickets: [{ priceTzs: 50000, capacity: 10, sold: 10 }] }] });
  const draft = await seed(org, { title: 'Hidden Draft', status: 'draft', startsAt: new Date(+later + 3 * D) });
  const submitted = await seed(org, { title: 'Hidden Submitted', status: 'submitted', startsAt: new Date(+later + 4 * D) });
  const cancelled = await seed(org, { title: 'Foxtrot Cancelled', status: 'cancelled', startsAt: new Date(+later + 5 * D) });
  const archived = await seed(org, { title: 'Golf Archived', status: 'archived', startsAt: new Date(+later + 6 * D) });
  const mine = ids => ids.filter(id => [a, b, c, d, soldOut, draft, submitted, cancelled, archived].some(e => e.id === id));

  const all = await call(eventsList, null, { query: { limit: 50 } });
  assert.equal(all.status, 200);
  const ids = mine(all.body.items.map(i => i.id));
  assert.deepEqual(ids, [d.id, a.id, b.id, c.id, soldOut.id], 'soonest first; draft, submitted, cancelled, archived absent');
  const itemA = all.body.items.find(i => i.id === a.id);
  assert.equal(itemA.availability, 'open');
  assert.equal(itemA.fromPriceTzs, 25000);
  assert.deepEqual(itemA.distancesM, [21097]);
  assert.equal(itemA.utcOffsetMinutes, 180); assert.equal(itemA.timezoneAbbr, 'EAT');
  assert.deepEqual(itemA.venue, { name: 'Coco Beach', city: 'Dar es Salaam', region: 'dar-es-salaam' });
  assert.deepEqual(itemA.organizer, { id: org.id, name: 'Discovery Club', verified: true });
  assert.equal('isSaved' in itemA, false, 'anonymous: no isSaved');
  assert.equal(all.body.items.find(i => i.id === b.id).fromPriceTzs, 0);
  assert.equal(all.body.items.find(i => i.id === c.id).availability, 'closed');
  assert.equal(all.body.items.find(i => i.id === d.id).availability, 'in_progress');
  assert.equal(all.body.items.find(i => i.id === soldOut.id).availability, 'sold_out');
  // Filters.
  const q = async query => mine((await call(eventsList, null, { query: { limit: 50, ...query } })).body.items.map(i => i.id));
  assert.deepEqual(await q({ type: 'trail' }), [b.id]);
  assert.deepEqual(await q({ type: ['trail', 'road'], region: 'arusha' }), [b.id]);
  assert.deepEqual(await q({ distance: '5k' }), [b.id]);
  assert.deepEqual(await q({ distance: ['21k', '42k'] }), [d.id, a.id, c.id, soldOut.id]);
  assert.deepEqual(await q({ price: 'free' }), [b.id]);
  assert.deepEqual(await q({ price: 'under_20k' }), [b.id]);
  assert.deepEqual(await q({ price: 'under_50k' }), [d.id, a.id, b.id, c.id]);
  assert.deepEqual(await q({ availability: 'open' }), [a.id, b.id]);
  assert.deepEqual(await q({ q: 'bravo' }), [b.id]);
  assert.deepEqual(await q({ q: 'Arusha' }), [b.id]);
  assert.deepEqual(await q({ q: '%' }), [], 'LIKE wildcards are literal (L7)');
  assert.deepEqual(await q({ q: 'Bravo_Trail' }), []);
  assert.deepEqual(await q({ q: 'Bravo Trail' }), [b.id]);
  assert.deepEqual(await q({ from: new Date(+later - D).toISOString(), to: new Date(+later + D).toISOString() }), [b.id, c.id]);
  assert.deepEqual(await q({ sort: 'price_low' }), [b.id, d.id, a.id, c.id, soldOut.id]);
  // Pagination: an opaque cursor walks the same ordering without gaps.
  const page1 = await call(eventsList, null, { query: { limit: 2, sort: 'soonest' } });
  assert.equal(page1.body.items.length, 2);
  assert.equal(typeof page1.body.nextCursor, 'string');
  assert.ok(page1.body.total >= 5);
  const page2 = await call(eventsList, null, { query: { limit: 2, cursor: page1.body.nextCursor } });
  assert.equal(page2.body.items.length, 2);
  assert.ok(!page1.body.items.some(i => page2.body.items.some(j => j.id === i.id)));
  assert.equal((await call(eventsList, null, { query: { limit: 2, cursor: 'garbage' } })).body.items[0].id, page1.body.items[0].id);
  // Closing soon: configurable hours.
  const closing = await seed(org, { title: 'Hotel Closing', startsAt: new Date(+new Date() + 3 * D), registrationClosesAt: new Date(+new Date() + 2 * D) });
  assert.equal((await call(eventsList, null, { query: { q: 'Hotel Closing' } })).body.items[0].availability, 'closing_soon');
  process.env.EVENTS_CLOSING_SOON_HOURS = '24';
  assert.equal((await call(eventsList, null, { query: { q: 'Hotel Closing' } })).body.items[0].availability, 'open');
  delete process.env.EVENTS_CLOSING_SOON_HOURS;
  assert.equal((await call(eventsList, null, { query: { q: 'Hotel Closing' } })).body.items[0].availability, 'closing_soon');
  // Not yet open.
  const notYet = await seed(org, { title: 'India Later', registrationOpensAt: new Date(+new Date() + 2 * D) });
  assert.equal((await call(eventsList, null, { query: { q: 'India Later' } })).body.items[0].availability, 'not_yet_open');
  assert.equal(closing.status, 'published'); assert.equal(notYet.status, 'published');
});

test('GET /events/:idOrSlug: public document by id or slug, cancelled readable, never a draft / submitted / archived; isSaved when signed in', async () => {
  on();
  const org = await organizer({ name: 'Detail Club' });
  const e = await seed(org, { title: 'Juliet Detail', categories: [{ name: '21K', distanceMeters: 21097, tickets: [{ name: 'Early', priceTzs: 25000, capacity: 12, sold: 5 }, { name: 'Late', priceTzs: 30000, capacity: 100, saleOpensAt: new Date(+new Date() + 10 * D) }] }] });
  const byId = await call(eventDetail, null, { params: { idOrSlug: e.id } });
  assert.equal(byId.status, 200);
  assert.equal(byId.body.slug, e.slug);
  assert.deepEqual(byId.body.description, { en: 'E'.repeat(50), sw: 'S'.repeat(50) });
  assert.equal(byId.body.categories.length, 1);
  assert.equal(byId.body.categories[0].availability, 'open');
  // Seeded through the S1 store in the same millisecond, so compare by name rather than by position.
  assert.deepEqual(byId.body.categories[0].ticketTypes.map(t => [t.name, t.availability, t.capacity]).sort(), [['Early', 'open', 12], ['Late', 'not_yet_open', 100]]);
  assert.equal(byId.body.categories[0].remaining, null, 'category has no cap');
  assert.equal(byId.body.shareUrl, `https://fitflex-af-app.web.app/events/${e.slug}`);
  assert.equal(byId.body.terms.en, 'T'.repeat(120));
  assert.equal(byId.body.refundPolicy.preset, 'no_refund');
  assert.equal(byId.body.cancellation, null);
  assert.equal(byId.body.version, e.version);
  assert.equal('isSaved' in byId.body, false);
  const bySlug = await call(eventDetail, null, { params: { idOrSlug: e.slug } });
  assert.equal(bySlug.body.id, e.id);
  const member = { sub: await user('member'), userType: 'member' };
  assert.equal((await call(eventDetail, member, { params: { idOrSlug: e.id } })).body.isSaved, false);
  for (const status of ['draft', 'submitted', 'archived']) {
    const hidden = await seed(org, { title: `Hidden ${status}`, status });
    assert.deepEqual((await call(eventDetail, null, { params: { idOrSlug: hidden.id } })).body, { error: 'event_not_found' }, status);
    assert.deepEqual((await call(eventDetail, null, { params: { idOrSlug: hidden.slug } })).body, { error: 'event_not_found' }, `${status} by slug`);
  }
  const cancelled = await seed(org, { title: 'Kilo Cancelled', status: 'cancelled' });
  await eventCatalogueStore.patchEventRaw(cancelled.id, { cancellation: { reason: 'weather', note: { en: 'Storm', sw: 'Dhoruba' } } });
  const cd = await call(eventDetail, null, { params: { idOrSlug: cancelled.id } });
  assert.equal(cd.body.availability, 'cancelled');
  assert.deepEqual(cd.body.cancellation, { reason: 'weather', note: { en: 'Storm', sw: 'Dhoruba' } });
  assert.equal((await call(eventDetail, null, { params: { idOrSlug: 'nope-nope' } })).body.error, 'event_not_found');
});

test('favourites: behind EVENTS_FAVOURITES; PUT/DELETE 204; isSaved and saved=1; hidden events are not found', async () => {
  on();
  const org = await organizer({ name: 'Saved Club' });
  const e = await seed(org, { title: 'Lima Saved' });
  const member = { sub: await user('member'), userType: 'member' };
  assert.deepEqual(await call(saveEventFavourite, member, { params: { eventId: e.id } }), { status: 404, body: { error: 'feature_disabled' }, ended: false });
  process.env.EVENTS_FAVOURITES = '1';
  assert.equal((await call(saveEventFavourite, null, { params: { eventId: e.id } })).status, 401);
  const saved = await call(saveEventFavourite, member, { params: { eventId: e.id } });
  assert.equal(saved.status, 204); assert.equal(saved.ended, true);
  assert.equal((await call(saveEventFavourite, member, { params: { eventId: e.id } })).status, 204, 'idempotent');
  assert.equal((await call(eventDetail, member, { params: { idOrSlug: e.id } })).body.isSaved, true);
  assert.equal((await call(eventsList, member, { query: { q: 'Lima Saved' } })).body.items[0].isSaved, true);
  const savedList = await call(eventsList, member, { query: { saved: '1', limit: 50 } });
  assert.deepEqual(savedList.body.items.map(i => i.id), [e.id]);
  assert.deepEqual((await call(eventsList, null, { query: { saved: '1' } })).body, { items: [], nextCursor: null, total: 0 });
  const draft = await seed(org, { title: 'Hidden', status: 'draft' });
  assert.deepEqual((await call(saveEventFavourite, member, { params: { eventId: draft.id } })).body, { error: 'event_not_found' });
  assert.equal((await call(removeEventFavourite, member, { params: { eventId: e.id } })).status, 204);
  assert.equal((await call(eventDetail, member, { params: { idOrSlug: e.id } })).body.isSaved, false);
  assert.equal((await call(removeEventFavourite, member, { params: { eventId: e.id } })).status, 204, 'idempotent');
});

// ── The lifecycle job ─────────────────────────────────────────────────────

test('eventLifecycle job: flag-gated; published → registration_closed → in_progress → completed (with grace) on schedule, nothing else touched', async () => {
  const org = await organizer({ name: 'Clockwork Club' });
  const now = new Date();
  const closeNow = await seed(org, { title: 'Closes now', startsAt: new Date(+now + 2 * D), registrationClosesAt: new Date(+now - H) });
  const startNow = await seed(org, { title: 'Starts now', startsAt: new Date(+now - H), endsAt: new Date(+now + 3 * H), registrationClosesAt: new Date(+now - 2 * H) });
  const startedClosed = await seed(org, { title: 'Closed then starts', status: 'registration_closed', startsAt: new Date(+now - H), endsAt: new Date(+now + 3 * H), registrationClosesAt: new Date(+now - 2 * H) });
  const endedRecently = await seed(org, { title: 'Ended in grace', status: 'in_progress', startsAt: new Date(+now - 8 * H), endsAt: new Date(+now - 2 * H), registrationClosesAt: new Date(+now - 9 * H) });
  const endedLongAgo = await seed(org, { title: 'Ended long ago', status: 'in_progress', startsAt: new Date(+now - 2 * D), endsAt: new Date(+now - 10 * H), registrationClosesAt: new Date(+now - 3 * D) });
  const future = await seed(org, { title: 'Still open' });
  const untouched = await seed(org, { title: 'Submitted stays', status: 'submitted', startsAt: new Date(+now - H), endsAt: new Date(+now + H), registrationClosesAt: new Date(+now - 2 * H) });
  // Off: the bfast job returns at once and the ops job records skipped.
  assert.equal(await eventLifecycle.onJob(), undefined);
  assert.equal((await eventStore.getEvent(closeNow.id)).status, 'published');
  const off = await opsService.runJob('event-lifecycle', { trigger: 'manual', actorId: org.ownerUserId });
  assert.equal(off.stats?.skipped ?? off.skipped, 'flag_off');
  on();
  const run = await opsService.runJob('event-lifecycle', { trigger: 'manual', actorId: org.ownerUserId });
  assert.equal(run.error, undefined, JSON.stringify(run));
  assert.ok((run.stats?.moved ?? 0) >= 4, JSON.stringify(run));
  const statusOf = async e => (await eventStore.getEvent(e.id)).status;
  assert.equal(await statusOf(closeNow), 'registration_closed');
  assert.equal(await statusOf(startNow), 'in_progress');
  assert.equal(await statusOf(startedClosed), 'in_progress');
  assert.equal(await statusOf(endedRecently), 'in_progress', 'within the 6 h grace');
  assert.equal(await statusOf(endedLongAgo), 'completed');
  assert.equal(await statusOf(future), 'published');
  assert.equal(await statusOf(untouched), 'submitted');
  // A shorter grace completes the recent one; the job is idempotent; audit rows name the system actor.
  process.env.EVENT_AUTO_COMPLETE_GRACE_HOURS = '1';
  await opsService.runJob('event-lifecycle', { trigger: 'manual', actorId: org.ownerUserId });
  assert.equal(await statusOf(endedRecently), 'completed');
  const again = await opsService.runJob('event-lifecycle', { trigger: 'manual', actorId: org.ownerUserId });
  assert.equal(again.stats?.moved ?? 0, 0, JSON.stringify(again));
  const audit = await db('AuditLog').where({ target: endedLongAgo.id, action: 'events.completed' }).first();
  assert.equal(audit.actor, 'system');
  assert.equal(audit.after.by, 'system');
  // A completed event sits outside the default discovery list but its detail still answers.
  assert.equal((await call(eventDetail, null, { params: { idOrSlug: endedLongAgo.id } })).body.availability, 'completed');
});
