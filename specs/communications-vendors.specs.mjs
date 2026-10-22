// Communications — FitFlex announcements to vendors (owner decision
// 2026-10-22) against the CI database. Admins pick `recipients: 'vendors'`;
// the audience is each vendor account that isn't suspended or closed, plus
// its active staff with vendorRole 'admin'. Each copy is in the recipient's
// language (English only if they chose 'en', Swahili otherwise) and lands in
// their own inbox / push. Gym owners can never address vendors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import {
  users, deviceTokens, notifications, communicationPreferences, communicationCampaigns, gyms,
} from '../src/bootstrap/collections.mjs';
import { createNotificationService } from '../src/services/notification-service.mjs';
import { createSegmentService } from '../src/services/segment-service.mjs';
import { createCampaignService } from '../src/services/campaign-service.mjs';
import { createDeliveryService } from '../src/services/delivery-service.mjs';
import { createCommunicationPreferenceService } from '../src/services/communication-preference-service.mjs';
import { audienceScope, buildAudienceFilter, audienceCatalog, RECIPIENTS } from '../src/shared/audience.mjs';
import * as routes from '../functions/communications.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
const quiet = { warn: () => {}, error: () => {} };
const made = { users: [], gyms: [], persons: [], products: [], sales: [] };
const w = {};
// Every vendor in this run shares one made-up business category, so audiences
// can be narrowed to this run whatever else the CI database holds.
const CAT = uid('vndcat');
const ours = () => ({ all: [{ field: 'vendorCategory', op: 'eq', value: CAT }] });

const fcm = {
  sent: [],
  async sendEachForMulticast({ tokens, notification, data }) {
    this.sent.push({ tokens, notification, data });
    return { successCount: tokens.length, failureCount: 0, responses: tokens.map(() => ({ success: true })) };
  },
};
let delivery;
const notificationService = createNotificationService({
  users, deviceTokens, notifications, logger: quiet,
  getMessaging: () => fcm,
  onOpened: (rows) => delivery.onOpened(rows),
  onClicked: (row, opts) => delivery.onClicked(row, opts),
});
const segments = createSegmentService({ db, communicationPreferences, deviceTokens, pushAvailable: () => true, whatsappAvailable: () => false });
const campaigns = createCampaignService({
  db, campaigns: communicationCampaigns, gyms, segmentService: segments, auditLog: null,
  largeSendThreshold: 50, marketingWeeklyCap: 5,
});
delivery = createDeliveryService({ db, notificationService, campaignService: campaigns, logger: quiet });
const prefs = createCommunicationPreferenceService({ preferences: communicationPreferences });

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
/** Runs a route as a real request: signed token → each guard → handler. */
async function invoke(route, claims, { params = {}, query = {}, body = {} } = {}) {
  const out = res();
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, query, body };
  for (const guard of [route.onGuard].flat()) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

async function person() {
  const id = uid('psn');
  await db('Person').insert({ id, status: 'active' });
  made.persons.push(id);
  return id;
}
async function user(fields) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', accountStatus: 'active', updatedAt: new Date(), ...fields });
  made.users.push(id);
  return id;
}
async function vendor(displayName, { approvalStatus = 'approved', accountStatus = 'active', createdAt = new Date(), personId = null } = {}) {
  return user({
    userType: 'vendor', displayName, approvalStatus, accountStatus, createdAt, ...(personId ? { personId } : {}),
    vendorProfile: { businessName: `${displayName} Shop`, businessCategory: CAT },
  });
}
const staff = (vendorId, displayName, { vendorRole = 'admin', accountStatus = 'active', personId = null } = {}) => user({
  userType: 'vendor_staff', vendorId, displayName, vendorRole, accountStatus, ...(personId ? { personId } : {}),
});
async function product(vendorId, { approvalStatus = 'approved' } = {}) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name: 'Whey', priceTzs: 10000, stock: 5, status: 'active', approvalStatus, updatedAt: new Date() });
  made.products.push(id);
}
async function walkInSale(vendorId, { soldAt = new Date(), status = 'completed' } = {}) {
  const id = uid('vsl');
  const seq = made.sales.length + 1;
  await db('VendorSale').insert({
    id, vendorId, seq, number: `WS-${seq}`, kind: 'cash', status, soldAt,
    subtotalTzs: 1000, totalTzs: 1000, paidTzs: 1000, clientRef: uid('ref'), fingerprint: uid('fp'), createdBy: vendorId,
    ...(status === 'voided' ? { voidedAt: new Date(), voidedBy: vendorId, voidReason: 'test' } : {}),
  });
  made.sales.push(id);
}

before(async () => {
  w.pA = await person();
  // Approved, selling walk-in, one live product: the account and its admin staff hear.
  w.vA = await vendor('Asha Vendor', { personId: w.pA });
  w.vAAdmin = await staff(w.vA, 'Anna Admin');
  w.vASales = await staff(w.vA, 'Sam Sales', { vendorRole: 'sales' });
  w.vAOff = await staff(w.vA, 'Oscar Off', { accountStatus: 'suspended' });
  // The vendor's own person as their staff too: one copy is enough.
  w.vASelf = await staff(w.vA, 'Asha Again', { personId: w.pA });
  await product(w.vA);
  await product(w.vA, { approvalStatus: 'pending' });
  await walkInSale(w.vA);
  // Waiting for approval (one with the old 'pending' spelling, joined long ago).
  w.vB = await vendor('Baraka Vendor', { approvalStatus: 'pending_approval' });
  w.vE = await vendor('Eli Vendor', { approvalStatus: 'pending', createdAt: daysAgo(60) });
  // Approved but nothing live, and only an old / a voided walk-in sale.
  w.vF = await vendor('Fatma Vendor');
  await product(w.vF, { approvalStatus: 'pending' });
  await walkInSale(w.vF, { soldAt: daysAgo(45) });
  await walkInSale(w.vF, { status: 'voided' });
  // Never messaged: rejected, suspended (and its staff), closed.
  w.vC = await vendor('Chausiku Rejected', { approvalStatus: 'rejected' });
  w.vD = await vendor('Dau Suspended', { accountStatus: 'suspended' });
  w.vDAdmin = await staff(w.vD, 'Dora Admin');
  w.vG = await vendor('Gift Closed', { accountStatus: 'closed' });
  // Not vendors.
  w.member = await user({ displayName: 'Plain Member' });
  w.trainer = await user({ userType: 'trainer', displayName: 'Coach Tumaini' });

  await prefs.update(w.vAAdmin, { locale: 'en' });
  await prefs.update(w.vB, { locale: 'sw' });
  await db('DeviceToken').insert({ id: uid('dvt'), userId: w.vA, token: uid('tok'), platform: 'android' });

  w.admin = await user({ userType: 'admin', displayName: 'FitFlex Admin', portalUser: true, aclPermissions: ['communications'] });
  w.FF = { senderType: 'platform', actorId: w.admin };
  w.adminClaims = { sub: w.admin, userType: 'admin', portalUser: true, aclPermissions: ['communications'] };

  w.gym = uid('gym');
  await db('Gym').insert({ id: w.gym, name: 'Vendor Test Gym', tier: 'standard', location: uid('Tanga'), updatedAt: new Date() });
  made.gyms.push(w.gym);
  w.owner = await user({ userType: 'gym_operator', displayName: 'Owner', gymIds: [w.gym], gymId: w.gym });
  w.OWNER = { senderType: 'gym', owner: { id: w.owner, gymIds: [w.gym] }, actorId: w.owner };
  w.ownerClaims = { sub: w.owner, userType: 'gym_operator', gymIds: [w.gym], aclPermissions: [] };
});

after(async () => {
  const ids = (await db('CommunicationCampaign').where('createdBy', w.admin).select('id')).map(r => r.id);
  if (ids.length) {
    await db('CommunicationMessage').whereIn('campaignId', ids).del();
    await db('CommunicationCampaign').whereIn('id', ids).del();
  }
  if (made.users.length) {
    await db('Notification').whereIn('userId', made.users).del().catch(() => {});
    await db('DeviceToken').whereIn('userId', made.users).del();
    await db('CommunicationPreference').whereIn('id', made.users).del().catch(() => {});
  }
  if (made.sales.length) await db('VendorSale').whereIn('id', made.sales).del();
  if (made.products.length) await db('Product').whereIn('id', made.products).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
  if (made.persons.length) await db('Person').whereIn('id', made.persons).del().catch(() => {});
});

const preview = (preset, filter = ours()) => segments.previewAudience({ sender: w.FF, recipients: 'vendors', preset, filter });
const idsOf = async (preset, filter) => {
  const r = await segments.resolveAudience({ sender: w.FF, recipients: 'vendors', preset, filter: filter ?? ours() });
  assert.equal(r.error, undefined, JSON.stringify(r));
  return r.members.map(m => m.memberId).sort();
};

test('vendors are a FitFlex-only audience with their own fields and presets', () => {
  assert.deepEqual([...RECIPIENTS], ['members', 'trainers', 'vendors']);
  assert.equal(audienceScope('platform', 'vendors'), 'vendors');
  assert.equal(audienceScope('gym', 'vendors'), null, 'gyms cannot message vendors');
  // Member and trainer fields don't apply to vendors; vendor fields don't apply to anyone else.
  assert.equal(buildAudienceFilter({ filter: { all: [{ field: 'status', op: 'eq', value: 'expired' }] } }, 'vendors').error, 'invalid_audience');
  assert.equal(buildAudienceFilter({ filter: { all: [{ field: 'trainerPass', op: 'eq', value: 'active' }] } }, 'vendors').error, 'invalid_audience');
  for (const scope of ['platform', 'trainers', 'gym']) {
    assert.equal(buildAudienceFilter({ filter: { all: [{ field: 'vendorApproval', op: 'eq', value: 'approved' }] } }, scope).error, 'invalid_audience', scope);
  }
  const cat = audienceCatalog('vendors');
  assert.deepEqual(cat.presets.map(p => p.key), ['all', 'approved', 'pending', 'walk_in', 'no_live_products', 'new']);
  assert.deepEqual(cat.fields.map(f => f.key).sort(), [
    'joinedDaysAgo', 'vendorApproval', 'vendorCategory', 'vendorLiveProducts', 'vendorProducts', 'vendorRecipient', 'vendorWalkInSales',
  ]);
});

test('audience counts: accounts plus active admin staff; suspended, closed, rejected and non-vendors left out', async () => {
  assert.deepEqual(await idsOf('all'), [w.vA, w.vAAdmin, w.vB, w.vE, w.vF].sort());
  assert.deepEqual(await idsOf('approved'), [w.vA, w.vAAdmin, w.vF].sort());
  assert.deepEqual(await idsOf('pending'), [w.vB, w.vE].sort(), "the old 'pending' spelling counts as waiting for approval");
  assert.deepEqual(await idsOf('walk_in'), [w.vA, w.vAAdmin].sort(), 'only a completed walk-in sale in the last 30 days');
  assert.deepEqual(await idsOf('no_live_products'), [w.vF]);
  assert.deepEqual(await idsOf('new'), [w.vA, w.vAAdmin, w.vB, w.vF].sort(), 'joined in the last 30 days');
  assert.deepEqual(
    await idsOf('all', { all: [{ field: 'vendorCategory', op: 'eq', value: CAT }, { field: 'vendorRecipient', op: 'eq', value: 'account' }] }),
    [w.vA, w.vB, w.vE, w.vF].sort(), 'accounts only, without staff',
  );
  assert.deepEqual(
    await idsOf(undefined, { all: [{ field: 'vendorCategory', op: 'eq', value: CAT }, { field: 'vendorProducts', op: 'gte', value: 2 }] }),
    [w.vA, w.vAAdmin].sort(),
  );
  // Never: sales staff, suspended staff, the vendor's own person twice, rejected/suspended/closed vendors, their staff.
  const all = await idsOf('all', undefined);
  for (const never of [w.vASales, w.vAOff, w.vASelf, w.vC, w.vD, w.vDAdmin, w.vG, w.member, w.trainer]) {
    assert.ok(!all.includes(never), never);
  }

  const p = await preview('all');
  assert.equal(p.recipients, 'vendors');
  assert.equal(p.count, 5);
  assert.equal(p.channels.in_app.eligible, 5);
  assert.equal(p.channels.push.eligible, 1, 'push only where there is a device');
  assert.equal(p.channels.push.excluded.no_device, 4);
  const asha = p.sample.find(s => s.id === w.vA);
  assert.deepEqual(asha, { id: w.vA, displayName: 'Asha Vendor', status: 'active', businessName: 'Asha Vendor Shop', vendorId: w.vA, vendorRecipient: 'account' });
  const anna = p.sample.find(s => s.id === w.vAAdmin);
  assert.equal(anna.vendorId, w.vA);
  assert.equal(anna.vendorRecipient, 'admin_staff');
});

test('admin routes: the vendor catalogue and preview need the communications scope', async () => {
  const cat = await invoke(routes.adminCommunicationSegments, w.adminClaims, { query: { recipients: 'vendors' } });
  assert.equal(cat.statusCode, 200);
  assert.equal(cat.body.scope, 'vendors');
  const pv = await invoke(routes.adminAudiencePreview, w.adminClaims, { body: { recipients: 'vendors', preset: 'approved', filter: ours() } });
  assert.equal(pv.statusCode, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.count, 3);
  await db('User').where({ id: w.admin }).update({ aclPermissions: ['members'] });
  try {
    const denied = await invoke(routes.adminAudiencePreview, w.adminClaims, { body: { recipients: 'vendors', preset: 'all' } });
    assert.equal(denied.statusCode, 403);
  } finally {
    await db('User').where({ id: w.admin }).update({ aclPermissions: ['communications'] });
  }
  // A gym owner's token never reaches FitFlex's vendor audiences.
  assert.equal((await invoke(routes.adminAudiencePreview, w.ownerClaims, { body: { recipients: 'vendors', preset: 'all' } })).statusCode, 403);
  assert.equal((await invoke(routes.adminCommunicationSegments, w.ownerClaims, { query: { recipients: 'vendors' } })).statusCode, 403);
});

test('gym owners cannot target vendors', async () => {
  const r = await campaigns.create(w.OWNER, {
    purpose: 'announcement', audience: { recipients: 'vendors', preset: 'all' },
    content: { title: 'Hi', body: 'Hello' }, channels: ['in_app'],
  });
  assert.equal(r.error, 'invalid_recipients');
  const pv = await segments.previewAudience({ sender: { senderType: 'gym', owner: { gymIds: [w.gym] } }, recipients: 'vendors', preset: 'all' });
  assert.equal(pv.error, 'invalid_recipients');
  const unsaved = await campaigns.preview(w.OWNER, { body: {
    purpose: 'announcement', audience: { recipients: 'vendors', preset: 'all' }, content: { title: 'Hi', body: 'Hello' }, channels: ['in_app'],
  } });
  assert.equal(unsaved.error, 'invalid_recipients');
  // A gym draft can't be switched to vendors later either.
  const draft = await campaigns.create(w.OWNER, { purpose: 'announcement', audience: { preset: 'all' }, content: { title: 'Hi', body: 'Hello' }, channels: ['in_app'] });
  assert.equal(draft.error, undefined, JSON.stringify(draft));
  assert.equal((await campaigns.update(w.OWNER, draft.campaign.id, { audience: { recipients: 'vendors', preset: 'all' } })).error, 'invalid_recipients');
  await db('CommunicationCampaign').where({ id: draft.campaign.id }).del();
  // The owner's segment catalogue has no vendor fields, and the owner's preview route ignores `recipients`.
  const ownerCat = segments.catalog('gym');
  assert.ok(!ownerCat.fields.some(f => f.key.startsWith('vendor')));
  assert.ok(!audienceCatalog('platform').fields.some(f => f.key.startsWith('vendor')));
});

test('each vendor gets the message in their language: English only if they chose it, Swahili otherwise', async () => {
  const { campaign, error } = await campaigns.create(w.FF, {
    purpose: 'announcement',
    audience: { recipients: 'vendors', preset: 'all', filter: ours() },
    content: {
      locale: 'en', title: 'Shop update', body: 'Hi {{member_name}}, new seller tools are here.',
      translations: { sw: { title: 'Taarifa ya duka', body: 'Habari {{member_name}}, zana mpya za wauzaji zimefika.' } },
    },
    channels: ['in_app', 'push'],
  });
  assert.equal(error, undefined);
  assert.equal(campaign.audience.recipients, 'vendors');
  const pv = await campaigns.preview(w.FF, { campaignId: campaign.id });
  assert.ok(!pv.warnings.some(x => x.code === 'no_swahili_text' || x.code === 'no_english_text'), JSON.stringify(pv.warnings));
  const sent = await campaigns.send(w.FF, campaign.id, { sendRequestId: uid('req') });
  assert.equal(sent.error, undefined, JSON.stringify(sent));
  assert.equal(sent.campaign.counts.targeted, 5);
  const rows = await db('CommunicationMessage').where({ campaignId: campaign.id, channel: 'in_app' });
  const by = Object.fromEntries(rows.map(r => [r.memberId, r]));
  assert.deepEqual(Object.keys(by).sort(), [w.vA, w.vAAdmin, w.vB, w.vE, w.vF].sort());
  assert.equal(by[w.vA].locale, 'sw', 'no saved language → Swahili');
  assert.equal(by[w.vA].title, 'Taarifa ya duka');
  assert.equal(by[w.vA].body, 'Habari Asha Vendor, zana mpya za wauzaji zimefika.');
  assert.equal(by[w.vB].locale, 'sw');
  assert.equal(by[w.vAAdmin].locale, 'en', "chose 'en' → English");
  assert.equal(by[w.vAAdmin].body, 'Hi Anna Admin, new seller tools are here.');
  const listed = (await campaigns.list(w.FF)).campaigns.find(c => c.id === campaign.id);
  assert.equal(listed.recipients, 'vendors');
  const overview = await campaigns.overview(w.FF, {});
  assert.equal(typeof overview.vendors, 'number');
  assert.ok(overview.vendors >= 5);
  assert.equal((await campaigns.overview(w.OWNER, {})).vendors, undefined, 'owners see no vendor count');
  w.langCampaign = campaign.id;
});

test('a vendor message written only in English warns how many vendors read Swahili', async () => {
  const body = {
    purpose: 'announcement', audience: { recipients: 'vendors', preset: 'all', filter: ours() },
    content: { title: 'English only', body: 'Hello.' }, channels: ['in_app'],
  };
  const pv = await campaigns.preview(w.FF, { body });
  assert.equal(pv.error, undefined, JSON.stringify(pv));
  assert.deepEqual(pv.warnings.find(x => x.code === 'no_swahili_text'), { code: 'no_swahili_text', count: 4, of: 5 });
  const sw = await campaigns.preview(w.FF, { body: { ...body, content: { locale: 'sw', title: 'Kiswahili tu', body: 'Habari.' } } });
  assert.deepEqual(sw.warnings.find(x => x.code === 'no_english_text'), { code: 'no_english_text', count: 1, of: 5 });
  // Member campaigns are unchanged: no language warnings there.
  const members = await campaigns.preview(w.FF, { body: { ...body, audience: { preset: 'all' } } });
  assert.ok(!members.warnings?.some(x => x.code === 'no_swahili_text'));
});

test("delivery puts the copy in each vendor's own inbox and pushes to their device", async () => {
  fcm.sent.length = 0;
  await delivery.runOnce();
  const rows = await db('CommunicationMessage').where({ campaignId: w.langCampaign });
  assert.ok(rows.every(r => ['sent', 'delivered', 'skipped'].includes(r.status)), JSON.stringify(rows.map(r => [r.channel, r.status, r.failureReason])));
  const ashaInbox = (await notificationService.inbox({ userId: w.vA })).notifications.find(n => n.campaignId === w.langCampaign);
  assert.ok(ashaInbox, 'in the vendor account inbox');
  assert.equal(ashaInbox.title, 'Taarifa ya duka');
  const annaInbox = (await notificationService.inbox({ userId: w.vAAdmin })).notifications.find(n => n.campaignId === w.langCampaign);
  assert.equal(annaInbox?.title, 'Shop update', 'admin staff get their own English copy');
  const salesInbox = (await notificationService.inbox({ userId: w.vASales })).notifications.find(n => n.campaignId === w.langCampaign);
  assert.equal(salesInbox, undefined, 'sales staff are not addressed');
  const push = fcm.sent.find(s => s.data?.campaignId === w.langCampaign);
  assert.ok(push, 'pushed to the vendor with a device');
  assert.equal(push.notification.title, 'Taarifa ya duka');
  assert.equal(rows.find(r => r.memberId === w.vA && r.channel === 'push').status, 'sent');
});

test("staff of a vendor suspended after queueing are skipped at delivery", async () => {
  const { campaign } = await campaigns.create(w.FF, {
    purpose: 'announcement',
    audience: { recipients: 'vendors', preset: 'approved', filter: { all: [{ field: 'vendorCategory', op: 'eq', value: CAT }, { field: 'vendorRecipient', op: 'eq', value: 'admin_staff' }] } },
    content: { locale: 'sw', title: 'Habari', body: 'Taarifa.' }, channels: ['in_app'],
  });
  const sent = await campaigns.send(w.FF, campaign.id, { sendRequestId: uid('req') });
  assert.equal(sent.campaign.counts.targeted, 1);
  await db('User').where({ id: w.vA }).update({ accountStatus: 'suspended' });
  try {
    await delivery.runOnce();
  } finally {
    await db('User').where({ id: w.vA }).update({ accountStatus: 'active' });
  }
  const row = await db('CommunicationMessage').where({ campaignId: campaign.id, memberId: w.vAAdmin }).first();
  assert.equal(row.status, 'skipped');
  assert.equal(row.skipReason, 'vendor_unavailable');
});
