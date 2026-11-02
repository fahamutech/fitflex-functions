// Marathon & running events · S7 (B4) — hardening carried in from earlier slices: webhook fairness and redelivery (H1, H4), post-commit safety (H2),
// outbox retention (H3), organizer status sweep (H7), timezone at submit (H8), team-code limiter (H9), payments reason (H14), pause registrations
// (H16), organizer search (H17), the retention job and the consent text draft (§6.2). docs/design/events-s7-hardening-and-pilot.md §6.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { organizerRedeliverWebhookEndpoint, resetEventsIntegrationsLimits } from '../functions/events-integrations.mjs';
import { adminSetRegistrationState, adminSetRewardsEligible } from '../functions/events-admin-s7.mjs';
import { adminListEventOrganizers, adminGetEvent } from '../functions/events-admin.mjs';
import { eventsOptions } from '../functions/events-public.mjs';
import { quoteEventOrder, resetEventsRegistrationLimits } from '../functions/events-registration.mjs';
import { harness, s7On, s7Off, db, uid, H, D } from './fixtures/events-s7.mjs';
import { webhookLab } from './fixtures/events-s5.mjs';
import { saveManualDetails, clearManualDetails } from './fixtures/events-s4.mjs';
import { eventsWebhookService, eventsOrganizerService, eventsRetentionService, opsService, eventStore, eventsOpsService } from '../src/bootstrap/services.mjs';
import { createEventsOpsService } from '../src/services/events-ops-service.mjs';
import { validateEvent, TIMEZONES } from '../src/shared/events-document.mjs';
import { consentTextFor } from '../src/shared/events-participants.mjs';
import { ticketKeyRing } from '../src/shared/events-ticket-token.mjs';
import { TICKET_SECRET } from './fixtures/events-s4.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetEventsIntegrationsLimits(); resetEventsRegistrationLimits(); s7Off(); });
after(async () => { await clearManualDetails(); await h.cleanup(); await db.destroy(); });

const key = () => `k_${uid('').slice(1)}`;

// ── H1 ───────────────────────────────────────────────────────────────────────

test('H1: a due-delivery claim takes at most EVENTS_WEBHOOK_PER_HOST_BATCH per receiving host, so a slow receiver cannot starve the others; leases are given back when the budget runs out', async () => {
  s7On();
  await db('WebhookDeliveryAttempt').del(); await db('WebhookDelivery').del();
  const f = await h.kitEvent({ n: 0 });
  const lab = webhookLab({ dns: { 'slow.example.test': ['93.184.216.34'], 'fast.example.test': ['93.184.216.35'] } });
  const slow = await lab.endpoint(f.organizer, { url: 'https://slow.example.test/hook' });
  const fast = await lab.endpoint(f.organizer, { url: 'https://fast.example.test/hook' });
  for (let i = 0; i < 12; i += 1) await lab.emit(f.event, f.organizer.id, 'kit.collected', null, `ereg_h1_${i}`);
  await lab.svc.fanout();
  assert.equal(await db('WebhookDelivery').where({ endpointId: slow.id }).count().then(r => Number(r[0].count)), 12);
  const claimed = await lab.svc.internals.claimDue(50, 5);
  const bySlow = claimed.filter(d => d.endpointId === slow.id).length;
  const byFast = claimed.filter(d => d.endpointId === fast.id).length;
  assert.equal(bySlow, 5, 'the slow host is held to 5');
  assert.equal(byFast, 5, 'the other host is claimed in the same round, not after the slow one\'s twelve');
  await db('WebhookDelivery').whereIn('id', claimed.map(d => d.id)).update({ leaseUntil: null });
  // budget spent: nothing is attempted and every lease is returned at once
  lab.hostDelayMs = { 'slow.example.test': 200 };
  const before = lab.calls.length;
  const out = await lab.svc.deliverDue({ budgetMs: -1 });
  assert.equal(lab.calls.length, before, 'no receiver was called');
  assert.ok(out.claimed >= 5);
  assert.equal(await db('WebhookDelivery').whereNotNull('leaseUntil').count().then(r => Number(r[0].count)), 0, 'leases released immediately, not after 60 seconds');
  // with time to work, both hosts deliver
  lab.hostDelayMs = { 'slow.example.test': 20 };
  const done = await lab.svc.deliverDue({ budgetMs: 30_000 });
  assert.ok(done.delivered >= 10, JSON.stringify(done));
});

// ── H2 ───────────────────────────────────────────────────────────────────────

test('H2: after the handover COMMITS, a failing card read, notice or analytics cannot throw out of the idempotent wrapper; a retry returns the original answer, never already_collected', async () => {
  s7On();
  const f = await h.kitEvent({ n: 1 });
  const state = { fail: false };
  const proxy = new Proxy(db, { apply(target, self, args) { if (state.fail && args[0] === 'EventCategory') throw new Error('database went away after the commit'); return Reflect.apply(target, self, args); } });
  const svc = createEventsOpsService({ db: proxy, eventStore, ticketRing: () => ticketKeyRing({ EVENT_TICKET_SECRET: TICKET_SECRET }), notify: async () => { throw new Error('push down'); } });
  const actor = { kind: 'staff', userId: f.organizer.ops.sub, role: 'ops' };
  const k = key();
  const body = { method: 'scan', payload: f.regs[0].payload, collectionPointId: f.points[0].id };
  state.fail = true;
  const first = await svc.collectKit({ actor, organizerId: f.organizer.id, eventId: f.event.id, key: k, body });
  state.fail = false;
  assert.equal(first.status, 201, JSON.stringify(first));
  assert.equal(first.collection.status, 'collected');
  assert.equal(first.card, null, 'the card could not be built, the handover stands');
  const retry = await svc.collectKit({ actor, organizerId: f.organizer.id, eventId: f.event.id, key: k, body });
  assert.equal(retry.replayed, true);
  assert.equal(retry.collection.id, first.collection.id);
  assert.equal(retry.error, undefined);
  assert.equal((await db('EventKitCollection').where({ registrationId: f.regs[0].id, status: 'collected' })).length, 1);
  // a NEW key for the same ticket is the honest already_collected
  const other = await svc.collectKit({ actor, organizerId: f.organizer.id, eventId: f.event.id, key: key(), body });
  assert.equal(other.error, 'already_collected');
  void eventsOpsService;
});

// ── H3 ───────────────────────────────────────────────────────────────────────

test('H3: outbox rows older than 90 days go whether published or not, in batches; recent rows and the feed stay', async () => {
  s7On();
  const f = await h.kitEvent({ n: 0 });
  const old = new Date(Date.now() - 95 * D);
  const mk = (createdAt, publishedAt) => ({ id: uid('obx'), type: 'kit.collected', aggregateType: 'registration', aggregateId: 'ereg_x', organizerId: f.organizer.id, eventId: f.event.id, payload: '{}', version: '1', createdAt, publishedAt });
  const rows = [...Array.from({ length: 5200 }, () => mk(old, null)), mk(old, old), mk(new Date(), null), mk(new Date(), new Date())];
  for (let i = 0; i < rows.length; i += 2000) await db('OutboxEvent').insert(rows.slice(i, i + 2000));
  const r = await eventsWebhookService.retention();
  assert.equal(r.outbox, 5201);
  const left = await db('OutboxEvent').where({ eventId: f.event.id });
  assert.equal(left.length, 2);
  assert.ok(left.every(x => +new Date(x.createdAt) > Date.now() - D));
  const idx = await db.raw(`select 1 from pg_indexes where indexname = 'outboxevent_created_idx'`);
  assert.equal(idx.rows.length, 1);
});

// ── H4 ───────────────────────────────────────────────────────────────────────

test('H4: the OWNER can send a time range again to one endpoint; only that organizer\'s rows; at most 7 days; rate limited; audited', async () => {
  s7On();
  await db('WebhookDeliveryAttempt').del(); await db('WebhookDelivery').del();
  const f = await h.kitEvent({ n: 0 });
  const g = await h.kitEvent({ n: 0 });
  const lab = webhookLab();
  const ep = await lab.endpoint(f.organizer, { events: ['kit.collected', 'bib.assigned'] });
  const mine = [];
  for (let i = 0; i < 3; i += 1) mine.push(await lab.emit(f.event, f.organizer.id, 'kit.collected', null, `ereg_h4_${i}`));
  const bib = await lab.emit(f.event, f.organizer.id, 'bib.assigned', { registrationId: 'ereg_h4_0', eventId: f.event.id, categoryId: 'evc_x', bibNumber: '12', previousBibNumber: null }, 'ereg_h4_0');
  const theirs = await lab.emit(g.event, g.organizer.id, 'kit.collected', null, 'ereg_other');
  await lab.svc.fanout();
  await db('WebhookDelivery').where({ outboxEventId: mine[0].id }).update({ status: 'delivered', deliveredAt: new Date(), attemptCount: 1 });
  assert.equal(await db('WebhookDelivery').where({ outboxEventId: theirs.id }).count().then(r => Number(r[0].count)), 0, 'the other organizer has no endpoint here');
  const range = { from: new Date(Date.now() - H).toISOString(), to: new Date().toISOString() };
  const run = (claims, body, id = ep.id) => call(organizerRedeliverWebhookEndpoint, claims, { params: { id }, body });
  assert.equal((await run(f.organizer.admin, range)).status, 403, 'owner only (D42)');
  assert.equal((await run(g.organizer.owner, range)).status, 404, 'another organizer cannot name this endpoint');
  assert.equal((await run(f.organizer.owner, { ...range, from: new Date(Date.now() - 8 * D).toISOString() })).body.error, 'range_too_large');
  assert.equal((await run(f.organizer.owner, { from: range.to, to: range.from })).status, 422);
  assert.equal((await run(f.organizer.owner, { ...range, to: new Date(Date.now() + D).toISOString() })).status, 422);
  assert.equal((await run(f.organizer.owner, { ...range, types: ['nope.type'] })).status, 422);
  const kitOnly = await run(f.organizer.owner, { ...range, types: ['kit.collected'] });
  assert.equal(kitOnly.status, 200, JSON.stringify(kitOnly.body));
  assert.equal(kitOnly.body.queued, 3);
  const d0 = await db('WebhookDelivery').where({ outboxEventId: mine[0].id }).first();
  assert.deepEqual([d0.status, d0.deliveredAt, d0.manualRetryCount], ['pending', null, 1], 'the delivered one is reset; same event id so receivers dedupe');
  assert.equal((await db('WebhookDelivery').where({ outboxEventId: bib.id }).first()).status, 'pending');
  assert.equal(await db('WebhookDelivery').where({ outboxEventId: theirs.id }).count().then(r => Number(r[0].count)), 0);
  const all = await run(f.organizer.owner, range);
  assert.equal(all.body.queued, 4);
  assert.equal((await run(f.organizer.owner, range)).status, 200);
  assert.equal((await run(f.organizer.owner, range)).body.error, 'rate_limited', 'the 4th request in an hour');
  assert.equal((await db('AuditLog').where({ action: 'events.webhook_redelivery_requested', target: f.organizer.id })).length, 3);
  // a request for a range with a missing delivery row creates it
  await db('WebhookDelivery').where({ endpointId: ep.id }).del();
  await db('AuditLog').where({ action: 'events.webhook_redelivery_requested' }).del();
  assert.equal((await run(f.organizer.owner, range)).body.queued, 4);
  assert.equal(await db('WebhookDelivery').where({ endpointId: ep.id }).count().then(r => Number(r[0].count)), 4);
});

// ── H7 ───────────────────────────────────────────────────────────────────────

test('H7: the sweep re-derives an organizer\'s status from its KYC case and audits the correction; a matching organizer is left alone', async () => {
  s7On();
  const f = await h.kitEvent({ n: 0 });
  assert.equal((await db('EventOrganizer').where({ id: f.organizer.id }).first()).status, 'active');
  const quiet = await eventsOrganizerService.sweepOrganizerStatus();
  assert.equal(await db('AuditLog').where({ action: 'events.organizer_status_corrected', target: f.organizer.id }).count().then(r => Number(r[0].count)), 0);
  assert.ok(quiet.checked >= 1);
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ status: 'draft', statusReason: null });   // the hook failed after the decision committed
  const r = await eventsOrganizerService.sweepOrganizerStatus();
  assert.ok(r.corrected >= 1);
  assert.equal((await db('EventOrganizer').where({ id: f.organizer.id }).first()).status, 'active');
  const audit = await db('AuditLog').where({ action: 'events.organizer_status_corrected', target: f.organizer.id });
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].before.status, audit[0].after.status], ['draft', 'active']);
  assert.equal((await eventsOrganizerService.sweepOrganizerStatus()).corrected, 0, 'idempotent');
  const job = await opsService.runJob('event-organizer-status-sweep', { trigger: 'manual', actorId: 'spec' });
  assert.equal(job.stats.skipped, undefined);
  s7Off();
  assert.equal((await opsService.runJob('event-organizer-status-sweep', { trigger: 'manual', actorId: 'spec' })).stats.skipped, 'flag_off');
});

// ── H8 / H9 / H14 ────────────────────────────────────────────────────────────

test('H8: at submit the timezone must be one of the published options.timezones; a draft may hold any valid IANA name', () => {
  const doc = { timezone: 'Asia/Tokyo' };
  assert.ok(!validateEvent(doc, { mode: 'patch' }).some(e => e.path === 'timezone'), 'a draft is not blocked');
  assert.ok(validateEvent(doc, { mode: 'submit' }).some(e => e.path === 'timezone'));
  assert.ok(!validateEvent({ timezone: TIMEZONES[0] }, { mode: 'submit' }).some(e => e.path === 'timezone'));
  assert.ok(validateEvent({ timezone: 'Mars/Olympus' }, { mode: 'patch' }).some(e => e.path === 'timezone'));
});

test('H9: joining a team by code inside a quote shares the lookup limiter (30 an hour per member)', async () => {
  s7On();
  const f = await h.kitEvent({ n: 0 });
  const id = await h.user({ phone: `+25576${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` });
  const claims = h.claimsOf(id);
  const q = () => call(quoteEventOrder, claims, { body: { eventId: f.event.id, lines: [{ ticketTypeId: f.ticket.id, quantity: 1 }], participants: [], team: { joinCode: 'NOPE-0000' } } });
  let last;
  for (let i = 0; i < 31; i += 1) last = await q();
  assert.equal(last.status, 429);
  assert.equal(last.body.error, 'rate_limited');
});

test('H14: GET /events/options says why payments are off', async () => {
  s7On();
  await saveManualDetails();
  assert.equal((await call(eventsOptions, null, {})).body.payments.blockedReason, null);
  delete process.env.EVENT_TICKET_SECRET;
  assert.equal((await call(eventsOptions, null, {})).body.payments.blockedReason, 'no_ticket_secret');
  process.env.EVENT_TICKET_SECRET = TICKET_SECRET;
  delete process.env.EVENTS_ALLOW_SINGLE_APPROVER;
  assert.equal((await call(eventsOptions, null, {})).body.payments.blockedReason, 'second_approver_off');
  process.env.EVENTS_ALLOW_SINGLE_APPROVER = '1';
  delete process.env.EVENTS_PAYMENTS_MANUAL;
  assert.equal((await call(eventsOptions, null, {})).body.payments.blockedReason, 'flag_off');
});

// ── H16 / H17 ────────────────────────────────────────────────────────────────

test('H16: an admin pauses and resumes ONE event\'s registrations with a reason; the organizer is told; ordering and the window are guarded', async () => {
  s7On();
  const f = await h.kitEvent({ n: 0 });
  const admin = await h.superAdmin();
  const post = (body, claims = admin) => call(adminSetRegistrationState, claims, { params: { id: f.event.id }, body });
  assert.equal((await post({ state: 'closed', reason: 'short' })).body.error, 'reason_required');
  assert.equal((await post({ state: 'maybe', reason: 'A long enough reason' })).status, 422);
  assert.equal((await post({ state: 'open', reason: 'Resume what is not paused' })).body.error, 'invalid_transition');
  const paused = await post({ state: 'closed', reason: 'Payment provider incident under review' });
  assert.deepEqual([paused.status, paused.body.eventStatus, paused.body.from], [200, 'registration_closed', 'published']);
  assert.equal((await db('Event').where({ id: f.event.id }).first()).status, 'registration_closed');
  assert.equal((await post({ state: 'closed', reason: 'Payment provider incident under review' })).body.error, 'invalid_transition');
  const note = await h.notifications(f.organizer.ownerUserId, 'organizer_registration_paused');
  assert.equal(note.length, 1);
  assert.match(note[0].data.bodySw, /\(kwa Kiingereza\) Payment provider/);
  await db('Event').where({ id: f.event.id }).update({ registrationClosesAt: new Date(Date.now() - 1000) });
  assert.equal((await post({ state: 'open', reason: 'Incident is over, resuming sales' })).body.error, 'registration_window_over');
  await db('Event').where({ id: f.event.id }).update({ registrationClosesAt: new Date(Date.now() + 2 * D) });
  const resumed = await post({ state: 'open', reason: 'Incident is over, resuming sales', reasonSw: 'Tatizo limeisha, tunaendelea na mauzo' });
  assert.equal(resumed.body.eventStatus, 'published');
  assert.match((await h.notifications(f.organizer.ownerUserId, 'organizer_registration_resumed'))[0].data.bodySw, /Tatizo limeisha/);
  assert.equal((await db('AuditLog').where({ action: 'events.admin_registration_state_changed', target: f.event.id })).length, 2);
  assert.equal((await post({ state: 'closed', reason: 'Payment provider incident under review' }, { sub: admin.sub, userType: 'admin', portalUser: true, aclPermissions: ['users'] })).status, 403);
  assert.equal((await call(adminSetRegistrationState, admin, { params: { id: 'evt_nothere' }, body: { state: 'closed', reason: 'Payment provider incident under review' } })).status, 404);
});

test('H17: the admin can find an organizer by name or id and see counts, without a direct API call; no secrets', async () => {
  s7On();
  const f = await h.kitEvent({ n: 0 });
  const admin = await h.superAdmin();
  await db('EventOrganizer').where({ id: f.organizer.id }).update({ name: 'Zanzibar Striders S7' });
  const byName = await call(adminListEventOrganizers, admin, { query: { q: 'zanzibar striders' } });
  assert.equal(byName.status, 200, JSON.stringify(byName.body));
  const row = byName.body.items.find(i => i.id === f.organizer.id);
  assert.deepEqual([row.name, row.status, row.apiAccessEnabled, row.activeClients, row.activeEndpoints], ['Zanzibar Striders S7', 'active', true, 0, 0]);
  assert.deepEqual(Object.keys(row).sort(), ['activeClients', 'activeEndpoints', 'apiAccessEnabled', 'id', 'name', 'status']);
  assert.equal((await call(adminListEventOrganizers, admin, { query: { q: f.organizer.id } })).body.items.length, 1);
  assert.ok((await call(adminListEventOrganizers, admin, { query: { apiAccess: 'false', q: 'Zanzibar' } })).body.items.length === 0);
  assert.equal((await call(adminListEventOrganizers, admin, { query: { q: 'zzz-nothing-matches' } })).body.items.length, 0);
  const page = await call(adminListEventOrganizers, admin, { query: { limit: '1' } });
  assert.equal(page.body.items.length, 1);
  assert.ok(page.body.nextCursor);
  assert.equal((await call(adminListEventOrganizers, admin, { query: { cursor: page.body.nextCursor, limit: '1' } })).status, 200);
  assert.equal((await call(adminListEventOrganizers, { sub: admin.sub, userType: 'admin', portalUser: true, aclPermissions: ['users'] }, {})).status, 403);
  assert.equal((await call(adminGetEvent, admin, { params: { id: f.event.id } })).status, 200, '/admin/events/:id still works');
  const detail = await call(adminGetEvent, admin, { params: { id: f.event.id } });
  assert.equal(detail.body.rewardsEligible, false);
  assert.ok('waitlist' in detail.body);
});

// ── Retention (ships unset) ──────────────────────────────────────────────────

test('retention: UNSET it does nothing and writes nothing; set, it clears contact and sensitive fields of old events only, keeps name initial, bib and results, once; a deleted purchaser\'s unclaimed places follow their own setting', async () => {
  s7On();
  const f = await h.kitEvent({ n: 2 });
  const recent = await h.kitEvent({ n: 1 });
  for (const reg of f.regs) await db('EventRegistration').where({ id: reg.id }).update({ phone: '+255700000001', email: 'a@b.test', dateOfBirth: '1990-01-01', gender: 'f', emergencyContact: JSON.stringify({ name: 'X', phone: '+255700000002' }), phoneNormalized: '+255700000001', emailNormalized: 'a@b.test', bibNumber: `B${reg.id.slice(-8)}`, claimTokenHash: `h${reg.id}` });
  await db('EventRegistration').where({ id: recent.regs[0].id }).update({ phone: '+255700000003', email: 'c@d.test' });
  const before = await db('AuditLog').where({ action: 'events.registration_anonymised' }).count().then(r => Number(r[0].count));
  assert.deepEqual(await eventsRetentionService.run(), { skipped: 'not_configured', rows: 0, events: 0 });
  assert.equal(await db('AuditLog').where({ action: 'events.registration_anonymised' }).count().then(r => Number(r[0].count)), before, 'unset: not even an audit row');
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).phone, '+255700000001');
  process.env.EVENTS_RETENTION_MONTHS = '6';
  assert.equal((await eventsRetentionService.run()).rows >= 0, true);
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).phone, '+255700000001', 'the event is still upcoming: nothing is cleared');
  await db('Event').where({ id: f.event.id }).update({ status: 'completed', startsAt: new Date(Date.now() - 400 * D), endsAt: new Date(Date.now() - 399 * D), registrationClosesAt: new Date(Date.now() - 401 * D) });
  const r = await eventsRetentionService.run();
  assert.ok(r.rows >= 2);
  for (const reg of f.regs) {
    const row = await db('EventRegistration').where({ id: reg.id }).first();
    assert.deepEqual([row.phone, row.email, row.dateOfBirth, row.gender, row.emergencyContact, row.phoneNormalized, row.emailNormalized, row.claimTokenHash], Array(8).fill(null));
    assert.ok(row.anonymisedAt);
    assert.equal(row.firstName, reg.firstName, 'the first name stays');
    assert.equal(row.lastName, reg.lastName, 'the last name stays (the board shows only the initial)');
    assert.match(row.bibNumber, /^B/);
    assert.equal(row.status, 'confirmed');
  }
  assert.equal((await db('EventRegistration').where({ id: recent.regs[0].id }).first()).phone, '+255700000003', 'a recent event is untouched');
  const audit = await db('AuditLog').where({ action: 'events.registration_anonymised' }).orderBy('at', 'desc').first();
  assert.ok(audit.after.rows >= 2 && audit.after.events >= 1);
  assert.equal((await eventsRetentionService.run()).rows, 0, 'each registration is cleared once');
  delete process.env.EVENTS_RETENTION_MONTHS;
  // the deleted-purchaser setting
  process.env.EVENTS_DELETED_USER_ANONYMISE_DAYS = '30';
  const g = await h.kitEvent({ n: 1 });
  await db('EventRegistration').where({ id: g.regs[0].id }).update({ purchaserUserId: null, participantUserId: null, claimedAt: null, consentBasis: 'purchaser_authorised', phone: '+255700000009', email: 'z@z.test' });
  await db('Event').where({ id: g.event.id }).update({ status: 'completed', startsAt: new Date(Date.now() - 60 * D), endsAt: new Date(Date.now() - 59 * D), registrationClosesAt: new Date(Date.now() - 61 * D) });
  const d = await eventsRetentionService.run();
  assert.ok(d.deletedUsers >= 1);
  assert.equal((await db('EventRegistration').where({ id: g.regs[0].id }).first()).phone, null);
  delete process.env.EVENTS_DELETED_USER_ANONYMISE_DAYS;
  // the job ships dormant: no settings, nothing to do
  const job = await opsService.runJob('event-registration-anonymise', { trigger: 'manual', actorId: 'spec' });
  assert.equal(job.stats.skipped, 'not_configured');
});

test('consent text draft: states what the organizer really receives (name, category, ticket type, bib, kit size, kit status) and what it does not (phone, email, date of birth, gender, emergency contact); the version moved on', () => {
  const text = consentTextFor('2026-11-draft');
  for (const basis of ['self', 'purchaser_authorised', 'organisation']) {
    assert.match(text[basis].en, /bib number/);
    assert.match(text[basis].en, /kit collection status/);
    assert.match(text[basis].en, /not shared with the organizer|kept by FitFlex/);
    assert.ok(!/share[sd]? my registration details \(name, contact, date of birth/.test(text[basis].en));
    assert.match(text[basis].sw, /namba ya mbio/);
    assert.match(text[basis].sw, /vinabaki kwa FitFlex/);
    assert.match(text[basis].sw, /inamshirikisha mwandaaji/);
    assert.match(text[basis].en, /demographic access/);
    assert.match(text[basis].sw, /vifaa vya mbio/);
  }
  assert.equal(text.versionLabel, '2026-11');
});

test('migration 4 down fails closed while an event is marked rewardsEligible or a registration was anonymised', async () => {
  s7On();
  const f = await h.kitEvent({ n: 0 });
  await db('Event').where({ id: f.event.id }).update({ rewardsEligible: true });
  const migration = createRequire(import.meta.url)('../db/migrations/20270202090300-events-hardening-s7.cjs');
  await assert.rejects(() => migration.down(db), /fails closed/);
  await db('Event').where({ id: f.event.id }).update({ rewardsEligible: false });
  void randomUUID; void adminSetRewardsEligible;
});
