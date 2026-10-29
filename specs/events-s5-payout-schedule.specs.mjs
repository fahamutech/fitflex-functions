// Marathon & running events · S5 — the payout schedule (spec §3, D33): required at submit, free in a draft, locked after submit, changed after
// publication only by a FitFlex admin with a reason (audited, organizer told). A label for the later settlement slice: no date, no amount.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { organizerCreateEvent, organizerPatchEvent, organizerGetEvent, organizerSubmitEvent, organizerWithdrawEvent, organizerEventFinance, organizerListEvents, resetEventsOrganizerLimits } from '../functions/events-organizer.mjs';
import { adminDecideEvent, adminGetEvent, adminListEvents, adminEventAudit, adminEventFinance, resetEventsAdminLimits } from '../functions/events-admin.mjs';
import { adminChangePayoutSchedule } from '../functions/events-admin-s5.mjs';
import { eventsOptions, eventDetail, eventsList } from '../functions/events-public.mjs';
import { apiListEvents } from '../functions/events-organizer-api.mjs';
import { harness, s5On, s5Off, db } from './fixtures/events-s5.mjs';

await ensureInit();
const h = harness();
const { call } = h;
afterEach(() => { resetEventsOrganizerLimits(); resetEventsAdminLimits(); s5Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const D = 86_400_000; const H = 3_600_000;
const starts = new Date(+new Date() + 40 * D);
const fullDocument = (version, over = {}) => ({
  version, title: 'Dar Half Marathon', type: 'road',
  description: { en: 'A'.repeat(60), sw: 'B'.repeat(60) }, timezone: 'Africa/Dar_es_Salaam',
  startsAt: starts.toISOString(), endsAt: new Date(+starts + 6 * H).toISOString(), registrationOpensAt: null, registrationClosesAt: new Date(+starts - D).toISOString(),
  venue: { name: 'Coco Beach', address: 'Toure Drive', city: 'Dar es Salaam', region: 'dar-es-salaam', lat: -6.75, lng: 39.27 },
  categories: [{ name: '21K', distanceM: 21097, startsAt: starts.toISOString(), capacity: 500, ticketTypes: [{ name: 'Standard', priceTzs: 35000, capacity: 100 }] }],
  kitProvided: false, terms: { en: 'T'.repeat(120), sw: 'M'.repeat(120) }, refundPolicy: { preset: 'refund_until_close' }, contact: { email: 'race@example.com', phone: '0712345678' },
  ...over,
});
const adminWith = async (aclPermissions) => ({ sub: await h.user({ userType: 'admin' }), userType: 'admin', portalUser: true, aclPermissions });

async function draft(o, over = {}) {
  const created = await call(organizerCreateEvent, o.owner, { body: { title: 'Dar Half Marathon' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  h.made.events.push(created.body.id);
  const patched = await call(organizerPatchEvent, o.owner, { params: { id: created.body.id }, body: fullDocument(created.body.version, over) });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  return { id: created.body.id, version: patched.body.version };
}

test('the column: the database refuses anything but biweekly / monthly / NULL; existing events stay NULL (no default, no backfill)', async () => {
  s5On();
  const o = await h.org();
  const e = await draft(o);
  assert.equal((await db('Event').where({ id: e.id }).first()).payoutSchedule, null);
  for (const bad of ['weekly', 'daily', '', 'Monthly']) await assert.rejects(db('Event').where({ id: e.id }).update({ payoutSchedule: bad }), err => err.code === '23514', bad);
  for (const ok of ['biweekly', 'monthly', null]) await db('Event').where({ id: e.id }).update({ payoutSchedule: ok });
});

test('draft: free to set, change and clear (autosave); an invalid value is 422 { path, code: invalid }; it is part of the organizer document; submit without it is 422 required, with it succeeds', async () => {
  s5On();
  const o = await h.org();
  const e = await draft(o);
  const doc = async () => (await call(organizerGetEvent, o.owner, { params: { id: e.id } })).body;
  assert.equal((await doc()).payoutSchedule, null);
  const blocked = await call(organizerSubmitEvent, o.owner, { params: { id: e.id } });
  assert.deepEqual([blocked.status, blocked.body.error, blocked.body.fields], [422, 'event_invalid', [{ path: 'payoutSchedule', code: 'required' }]]);
  let v = e.version;
  for (const value of ['monthly', 'biweekly', null, 'monthly']) {
    const r = await call(organizerPatchEvent, o.owner, { params: { id: e.id }, body: { version: v, payoutSchedule: value } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    v = r.body.version;
    assert.equal((await doc()).payoutSchedule, value);
  }
  for (const bad of ['weekly', 'MONTHLY', 12, true, {}]) {
    const r = await call(organizerPatchEvent, o.owner, { params: { id: e.id }, body: { version: v, payoutSchedule: bad } });
    assert.deepEqual([r.status, r.body.fields], [422, [{ path: 'payoutSchedule', code: 'invalid' }]], JSON.stringify(bad));
  }
  assert.equal((await doc()).payoutSchedule, 'monthly', 'a refused value changed nothing');
  // a draft SAVE never needs it (it is required at submit, not at create)
  const fresh = await call(organizerCreateEvent, o.owner, { body: { title: 'Zanzibar 10K' } });
  h.made.events.push(fresh.body.id);
  assert.equal((await call(organizerPatchEvent, o.owner, { params: { id: fresh.body.id }, body: { version: fresh.body.version, title: 'Zanzibar 10K run' } })).status, 200);
  assert.equal((await call(organizerSubmitEvent, o.owner, { params: { id: e.id } })).body.status, 'submitted');
});

test('locked after submit: a submitted event is read-only (withdraw unlocks it); once published an organizer PATCH with a different value is 409 payout_schedule_locked, the same value is ignored', async () => {
  s5On();
  const o = await h.org();
  const e = await draft(o, { payoutSchedule: 'biweekly' });
  assert.equal((await call(organizerSubmitEvent, o.owner, { params: { id: e.id } })).status, 200);
  const submitted = await call(organizerPatchEvent, o.owner, { params: { id: e.id }, body: { version: (await db('Event').where({ id: e.id }).first()).version, payoutSchedule: 'monthly' } });
  assert.deepEqual([submitted.status, submitted.body.error], [409, 'invalid_transition']);
  assert.equal((await call(organizerWithdrawEvent, o.owner, { params: { id: e.id } })).body.status, 'draft');
  const reopened = await call(organizerPatchEvent, o.owner, { params: { id: e.id }, body: { version: (await db('Event').where({ id: e.id }).first()).version, payoutSchedule: 'monthly' } });
  assert.equal(reopened.status, 200, 'withdrawn → draft → editable again');
  assert.equal((await call(organizerSubmitEvent, o.owner, { params: { id: e.id } })).status, 200);
  const admin = await adminWith(['events', 'kyc']);
  const approved = await call(adminDecideEvent, admin, { params: { id: e.id }, body: { decision: 'approve' } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const version = () => db('Event').where({ id: e.id }).first().then(r => r.version);
  const locked = await call(organizerPatchEvent, o.owner, { params: { id: e.id }, body: { version: await version(), payoutSchedule: 'biweekly' } });
  assert.deepEqual([locked.status, locked.body.error], [409, 'payout_schedule_locked']);
  assert.equal((await db('Event').where({ id: e.id }).first()).payoutSchedule, 'monthly');
  assert.equal((await call(organizerPatchEvent, o.owner, { params: { id: e.id }, body: { version: await version(), payoutSchedule: null } })).body.error, 'payout_schedule_locked', 'clearing it is a change too');
  const same = await call(organizerPatchEvent, o.owner, { params: { id: e.id }, body: { version: await version(), payoutSchedule: 'monthly', accessibility: { en: 'Step-free', sw: 'Bila ngazi' } } });
  assert.equal(same.status, 200, 'the same value is ignored, the rest of the save goes through');
  assert.equal((await call(organizerPatchEvent, o.owner, { params: { id: e.id }, body: { version: await version(), payoutSchedule: 'monthly' } })).status, 200);
  assert.equal((await db('EventChangeLog').where({ eventId: e.id }).whereRaw(`fields::text LIKE '%payoutSchedule%'`)).length, 0, 'the organizer\'s saves never log a payout change');
});

test('admin change after publish: scope `events`, a valid value, a reason of 10–300; AuditLog { before, after, reason }, EventChangeLog (not material, admin), a bilingual notice to the owner and admins; no-op when unchanged; draft / submitted refused', async () => {
  s5On();
  const o = await h.org();
  const e = await draft(o, { payoutSchedule: 'biweekly' });
  const admin = await adminWith(['events']);
  const change = (claims, body, id = e.id) => call(adminChangePayoutSchedule, claims, { params: { id }, body });
  assert.equal((await change(admin, { payoutSchedule: 'monthly', reason: 'Organizer asked by phone to be paid monthly' })).body.error, 'invalid_transition', 'a draft is the organizer\'s to edit');
  await call(organizerSubmitEvent, o.owner, { params: { id: e.id } });
  assert.equal((await change(admin, { payoutSchedule: 'monthly', reason: 'Organizer asked by phone to be paid monthly' })).body.error, 'invalid_transition', 'a submitted one is locked');
  assert.equal((await call(adminDecideEvent, admin, { params: { id: e.id }, body: { decision: 'approve' } })).status, 200);
  // who may
  for (const claims of [o.owner, h.claimsOf(await h.user({ userType: 'member' })), await adminWith(['kyc', 'payments'])]) assert.equal((await change(claims, { payoutSchedule: 'monthly', reason: 'Organizer asked by phone to be paid monthly' })).status, 403);
  assert.equal((await change(admin, { payoutSchedule: 'weekly', reason: 'Organizer asked by phone to be paid monthly' })).body.fields[0].code, 'invalid');
  for (const reason of [undefined, '', 'too short', 'x'.repeat(301)]) assert.equal((await change(admin, { payoutSchedule: 'monthly', reason })).body.error, 'reason_required');
  assert.equal((await change(admin, { payoutSchedule: 'monthly', reason: 'Organizer asked by phone to be paid monthly' }, 'evt_missing')).status, 404);
  const done = await change(admin, { payoutSchedule: 'monthly', reason: 'Organizer asked by phone to be paid monthly' });
  assert.deepEqual([done.status, done.body], [200, { payoutSchedule: 'monthly', changed: true }]);
  assert.equal((await db('Event').where({ id: e.id }).first()).payoutSchedule, 'monthly');
  const audit = await db('AuditLog').where({ action: 'events.payout_schedule_changed', target: e.id });
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].before, audit[0].after], [{ payoutSchedule: 'biweekly' }, { payoutSchedule: 'monthly', reason: 'Organizer asked by phone to be paid monthly' }]);
  assert.equal(audit[0].actor, admin.sub);
  const log = await db('EventChangeLog').where({ eventId: e.id }).orderBy('createdAt', 'desc').first();
  assert.deepEqual([log.actorRole, log.material, log.fields], ['admin', false, ['payoutSchedule']]);
  assert.deepEqual([log.before, log.after], [{ payoutSchedule: 'biweekly' }, { payoutSchedule: 'monthly' }]);
  const notes = await db('Notification').where({ type: 'organizer_payout_schedule_changed' });
  const staff = await db('EventOrganizerStaff').where({ organizerId: o.id, status: 'active' }).whereIn('role', ['owner', 'admin']);
  assert.equal(notes.length, staff.length);
  assert.ok(notes.every(n => n.data.titleSw === 'Ratiba ya malipo imebadilishwa' && n.data.bodyEn.includes('once a month') && n.data.bodySw.includes('mara moja kwa mwezi')));
  // unchanged: nothing written again
  assert.deepEqual((await change(admin, { payoutSchedule: 'monthly', reason: 'Organizer asked by phone to be paid monthly' })).body, { payoutSchedule: 'monthly', changed: false });
  assert.equal((await db('AuditLog').where({ action: 'events.payout_schedule_changed', target: e.id })).length, 1);
  // the admin audit route shows it
  const shown = await call(adminEventAudit, admin, { params: { id: e.id }, query: {} });
  assert.ok(shown.body.items.some(i => i.action === 'events.payout_schedule_changed' && i.reason));
  // the organizer's own PATCH is still locked
  assert.equal((await call(organizerPatchEvent, o.owner, { params: { id: e.id }, body: { version: (await db('Event').where({ id: e.id }).first()).version, payoutSchedule: 'biweekly' } })).body.error, 'payout_schedule_locked');
});

test('where it shows: organizer document and list, admin detail and list, the Finance view (organizer and admin) — and NOWHERE public: not the public event, not the list, not /v1/organizer; options list the two values', async () => {
  s5On();
  const f = await h.kitEvent({ n: 0 });
  await db('Event').where({ id: f.event.id }).update({ payoutSchedule: 'biweekly' });
  const admin = await adminWith(['events', 'payments']);
  assert.equal((await call(organizerGetEvent, f.organizer.owner, { params: { id: f.event.id } })).body.payoutSchedule, 'biweekly');
  assert.equal((await call(organizerListEvents, f.organizer.owner, {})).body.items.find(i => i.id === f.event.id).payoutSchedule, 'biweekly');
  assert.equal((await call(adminGetEvent, admin, { params: { id: f.event.id } })).body.payoutSchedule, 'biweekly');
  assert.equal((await call(adminListEvents, admin, { query: { status: 'published' } })).body.items.find(i => i.id === f.event.id).payoutSchedule, 'biweekly');
  const fin = await call(organizerEventFinance, f.organizer.finance, { params: { id: f.event.id } });
  assert.deepEqual([fin.status, fin.body.payoutSchedule, fin.body.settlement], [200, 'biweekly', { state: 'not_started' }]);
  assert.equal((await call(adminEventFinance, admin, { params: { id: f.event.id } })).body.payoutSchedule, 'biweekly');
  assert.deepEqual(Object.keys(fin.body).filter(k => /payoutDate|nextPayout|payoutAmount|payoutDue/i.test(k)), [], 'no date or amount is promised');
  // NULL (an event from before D33) reads null, never an error
  await db('Event').where({ id: f.event.id }).update({ payoutSchedule: null });
  assert.equal((await call(organizerEventFinance, f.organizer.finance, { params: { id: f.event.id } })).body.payoutSchedule, null);
  await db('Event').where({ id: f.event.id }).update({ payoutSchedule: 'monthly' });
  // public surfaces
  const pub = await call(eventDetail, null, { params: { idOrSlug: f.event.id } });
  const list = await call(eventsList, null, { query: {} });
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.ok(!JSON.stringify(pub.body).includes('payoutSchedule') && !JSON.stringify(list.body).includes('payoutSchedule') && !JSON.stringify(pub.body).includes('commission'));
  const c = await h.apiClient(f.organizer, {});
  assert.ok(!JSON.stringify((await call(apiListEvents, null, { headers: await c.bearer() })).body).includes('payoutSchedule'));
  const options = (await call(eventsOptions, null, {})).body;
  assert.deepEqual(options.payoutSchedules, ['biweekly', 'monthly']);
  assert.deepEqual(options.ops, { kit: true, api: true, webhooks: true });
  assert.equal(options.tickets.scanning, true);
  s5Off(); s5On({ kit: false, api: false, webhooks: false });
  const quiet = (await call(eventsOptions, null, {})).body;
  assert.deepEqual([quiet.ops, quiet.tickets.scanning], [{ kit: false, api: false, webhooks: false }, false]);
  s5Off(); s5On({ key: false });
  assert.deepEqual((await call(eventsOptions, null, {})).body.ops, { kit: true, api: true, webhooks: false }, 'webhooks is off without the key');
  s5Off();
  assert.deepEqual((await call(eventsOptions, null, {})).body.ops, { kit: false, api: false, webhooks: false });
  assert.deepEqual((await call(eventsOptions, null, {})).body.payoutSchedules, ['biweekly', 'monthly'], 'the list is the same with the module off');
});
