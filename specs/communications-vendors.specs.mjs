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
import { createSmsService } from '../src/services/sms-service.mjs';
import { createFakeSmsProvider } from '../src/integrations/sms/provider.mjs';
import * as routes from '../functions/communications.mjs';
import * as meRoutes from '../functions/notifications.mjs';

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
    await db('SmsLog').whereIn('userId', made.users).del().catch(() => {});
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
  // Rejected vendors can't be named: they are never in a vendor audience.
  assert.equal(buildAudienceFilter({ filter: { all: [{ field: 'vendorApproval', op: 'eq', value: 'rejected' }] } }, 'vendors').error, 'invalid_audience');
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
  // A custom filter alone still keeps to approved / awaiting approval (review of #257) …
  assert.deepEqual(await idsOf(undefined, ours()), [w.vA, w.vAAdmin, w.vB, w.vE, w.vF].sort());
  const built = buildAudienceFilter({ filter: ours() }, 'vendors').filter;
  assert.deepEqual(built.all[0], { all: [{ field: 'vendorApproval', op: 'in', value: ['approved', 'pending_approval'] }] });
  // … and a filter that names vendorApproval decides for itself, within those two.
  assert.deepEqual(
    await idsOf(undefined, { all: [{ field: 'vendorCategory', op: 'eq', value: CAT }, { field: 'vendorApproval', op: 'eq', value: 'pending_approval' }] }),
    [w.vB, w.vE].sort(),
  );
  assert.equal(JSON.stringify(buildAudienceFilter({ filter: { all: [{ field: 'vendorApproval', op: 'eq', value: 'approved' }] } }, 'vendors').filter).match(/vendorApproval/g).length, 1);
  // Never: sales staff, suspended staff, the vendor's own person twice, rejected/suspended/closed vendors, their staff.
  const all = await idsOf('all', undefined);
  for (const never of [w.vASales, w.vAOff, w.vASelf, w.vC, w.vD, w.vDAdmin, w.vG, w.member, w.trainer]) {
    assert.ok(!all.includes(never), never);
  }

  const p = await preview('all');
  assert.equal(p.recipients, 'vendors');
  assert.equal(p.category, 'marketing', 'without a purpose the stricter marketing rules apply, as for members');
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

test('marketing to vendors is accepted now vendors can opt out (owner decision 2026-10-29)', async () => {
  const body = (purpose) => ({
    purpose, audience: { recipients: 'vendors', preset: 'all', filter: ours() },
    content: { locale: 'sw', title: 'Ofa', body: 'Punguzo.' }, channels: ['in_app'],
  });
  const ids = [];
  try {
    for (const purpose of ['promotion', 'engagement', 'general']) {
      const r = await campaigns.create(w.FF, body(purpose));
      assert.equal(r.error, undefined, `${purpose}: ${JSON.stringify(r)}`);
      assert.equal(r.campaign.category, 'marketing', purpose);
      ids.push(r.campaign.id);
      const pv = await campaigns.preview(w.FF, { body: body(purpose) });
      assert.equal(pv.error, undefined, `${purpose}: ${JSON.stringify(pv)}`);
      const aud = await segments.previewAudience({ sender: w.FF, recipients: 'vendors', preset: 'all', filter: ours(), purpose });
      assert.equal(aud.error, undefined, purpose);
      assert.equal(aud.category, 'marketing', purpose);
      assert.equal(aud.count, 5, purpose);
    }
    // Service messages are unchanged: still transactional.
    for (const purpose of ['announcement', 'renewal', 'payment']) {
      const r = await campaigns.create(w.FF, body(purpose));
      assert.equal(r.error, undefined, purpose);
      assert.equal(r.campaign.category, 'transactional', purpose);
      ids.push(r.campaign.id);
      const aud = await segments.previewAudience({ sender: w.FF, recipients: 'vendors', preset: 'all', filter: ours(), purpose });
      assert.equal(aud.category, 'transactional', purpose);
    }
    // Either way round through an edit: a vendor announcement made a promotion, or a member promotion sent to vendors.
    const ann = await campaigns.create(w.FF, body('announcement'));
    ids.push(ann.campaign.id);
    const edited = await campaigns.update(w.FF, ann.campaign.id, { purpose: 'promotion' });
    assert.equal(edited.error, undefined, JSON.stringify(edited));
    assert.equal(edited.campaign.category, 'marketing');
    const promo = await campaigns.create(w.FF, { ...body('promotion'), audience: { preset: 'all' } });
    ids.push(promo.campaign.id);
    const moved = await campaigns.update(w.FF, promo.campaign.id, { audience: { recipients: 'vendors', preset: 'all', filter: ours() } });
    assert.equal(moved.error, undefined, JSON.stringify(moved));
    assert.equal(moved.campaign.audience.recipients, 'vendors');
    // And it can be scheduled.
    const sch = await campaigns.schedule(w.FF, ann.campaign.id, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(sch.error, undefined, JSON.stringify(sch));
    assert.equal(sch.campaign.status, 'scheduled');
  } finally {
    await db('CommunicationMessage').whereIn('campaignId', ids).del();
    await db('CommunicationCampaign').whereIn('id', ids).del();
  }
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
  // The overview's count-only query agrees with the full audience for preset `all`.
  const everyone = await segments.previewAudience({ sender: w.FF, recipients: 'vendors', preset: 'all' });
  assert.equal(overview.vendors, everyone.count);
  assert.equal(await segments.vendorRecipientCount(), everyone.count);
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

// Queues a vendor announcement to `filter` (within this run's vendors), changes something, then delivers.
async function queuedThen(filter, change) {
  const { campaign, error } = await campaigns.create(w.FF, {
    purpose: 'announcement',
    audience: { recipients: 'vendors', filter: { all: [{ field: 'vendorCategory', op: 'eq', value: CAT }, ...filter] } },
    content: { locale: 'sw', title: 'Habari', body: 'Taarifa.' }, channels: ['in_app'],
  });
  assert.equal(error, undefined);
  const sent = await campaigns.send(w.FF, campaign.id, { sendRequestId: uid('req') });
  assert.equal(sent.error, undefined, JSON.stringify(sent));
  const undo = await change();
  try {
    await delivery.runOnce();
  } finally {
    await undo();
  }
  return Object.fromEntries((await db('CommunicationMessage').where({ campaignId: campaign.id })).map(r => [r.memberId, r]));
}
const set = (id, patch, back) => async () => {
  await db('User').where({ id }).update(patch);
  return () => db('User').where({ id }).update(back);
};

test('delivery re-checks vendors: suspended or rejected since queueing, and their staff, get nothing', async () => {
  const staffOnly = [{ field: 'vendorRecipient', op: 'eq', value: 'admin_staff' }];
  let rows = await queuedThen(staffOnly, set(w.vA, { accountStatus: 'suspended' }, { accountStatus: 'active' }));
  assert.equal(rows[w.vAAdmin].status, 'skipped');
  assert.equal(rows[w.vAAdmin].skipReason, 'vendor_unavailable');

  rows = await queuedThen([{ field: 'vendorApproval', op: 'eq', value: 'approved' }], set(w.vA, { approvalStatus: 'rejected' }, { approvalStatus: 'approved' }));
  assert.equal(rows[w.vA].skipReason, 'vendor_unavailable', 'the rejected vendor account');
  assert.equal(rows[w.vAAdmin].skipReason, 'vendor_unavailable', "the rejected vendor's staff");
  assert.equal(rows[w.vF].status, 'delivered', 'another approved vendor still gets it');
});

test('delivery re-checks staff: no longer the vendor\'s admin → skipped', async () => {
  const rows = await queuedThen(
    [{ field: 'vendorRecipient', op: 'eq', value: 'admin_staff' }],
    set(w.vAAdmin, { vendorRole: 'sales' }, { vendorRole: 'admin' }),
  );
  assert.equal(rows[w.vAAdmin].status, 'skipped');
  assert.equal(rows[w.vAAdmin].skipReason, 'not_vendor_admin');
});

// ── Vendors' own message settings (mobile#228) ─────────────────────────────
// Vendors save offers on/off per channel through the same endpoint as
// members (PUT /me/communication-preferences → CommunicationPreference, keyed
// by the signed-in user's id), and the same per-channel rules decide who gets
// a marketing message: in-app and push offers on unless switched off, SMS and
// WhatsApp offers only once opted in, and the SMS/WhatsApp opt-out flag
// (smsOptedOutAt / whatsappOptedOutAt) blocks all. Nothing handles an inbound
// SMS STOP yet: the spec sets the SMS flag directly, it does not test STOP.
test('marketing to vendors honours each vendor\'s own opt-out per channel (SMS opt-out flag set directly); service messages unchanged', async () => {
  const CAT2 = uid('vndcat2');
  const mine = { all: [{ field: 'vendorCategory', op: 'eq', value: CAT2 }] };
  const smsProvider = createFakeSmsProvider();
  const sms = createSmsService({ db, provider: smsProvider, logger: quiet });
  const segAll = createSegmentService({
    db, communicationPreferences, deviceTokens,
    pushAvailable: () => true, whatsappAvailable: () => true, smsAvailable: () => true,
  });
  const campaignsAll = createCampaignService({
    db, campaigns: communicationCampaigns, gyms, segmentService: segAll, auditLog: null,
    largeSendThreshold: 50, marketingWeeklyCap: 5,
  });
  const deliveryAll = createDeliveryService({ db, notificationService, campaignService: campaignsAll, smsChannel: sms, logger: quiet });

  const phones = new Map();
  const tokens = new Map();
  async function reachable(id) {
    const local = `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    phones.set(id, `+255${local.slice(1)}`);
    await db('User').where({ id }).update({ phone: local });
    const token = uid('tok');
    tokens.set(id, token);
    await db('DeviceToken').insert({ id: uid('dvt'), userId: id, token, platform: 'android' });
    return id;
  }
  const mk = async (name) => reachable(await user({
    userType: 'vendor', displayName: name, approvalStatus: 'approved', accountStatus: 'active',
    vendorProfile: { businessName: `${name} Shop`, businessCategory: CAT2 },
  }));
  const v = {};
  v.in = await mk('Imani OptedIn');
  v.inAdmin = await reachable(await staff(v.in, 'Ida Admin'));
  v.noInApp = await mk('Neema NoInApp');
  v.noPush = await mk('Nuru NoPush');
  v.noSms = await mk('Nasra NoSms');
  v.smsFlag = await mk('Saidi SmsOptOutFlag');
  v.noWa = await mk('Nadia NoWhatsApp');
  v.defaults = await mk('Dalila Defaults'); // never opened message settings

  // Each vendor saves their choices through the app's endpoint, signed in as themselves.
  const put = async (id, userType, body) => {
    const r = await invoke(meRoutes.updateMyCommunicationPreferences, { sub: id, userType }, { body });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    return r.body.preferences;
  };
  const both = { smsMarketing: true, whatsappMarketing: true };
  await put(v.in, 'vendor', both);
  await put(v.inAdmin, 'vendor_staff', { ...both, pushMarketing: false }); // staff choose for themselves
  await put(v.noInApp, 'vendor', { ...both, inAppMarketing: false });
  await put(v.noPush, 'vendor', { ...both, pushMarketing: false });
  await put(v.noSms, 'vendor', { whatsappMarketing: true });
  await put(v.smsFlag, 'vendor', both);
  // The SMS opt-out flag set directly: no code sets it today (no inbound STOP handler).
  await db('CommunicationPreference').where({ id: v.smsFlag }).update({ smsOptedOutAt: new Date() });
  await put(v.noWa, 'vendor', { smsMarketing: true });
  const got = await invoke(meRoutes.myCommunicationPreferences, { sub: v.noPush, userType: 'vendor' });
  assert.equal(got.statusCode, 200);
  assert.equal(got.body.preferences.pushMarketing, false, 'the vendor reads back what they saved');

  // Per channel, per vendor, for a promotion.
  const everyone = Object.values(v);
  const reach = await segAll.reachByMember((await segAll.resolveAudience({ sender: w.FF, recipients: 'vendors', filter: mine })).members, 'marketing');
  assert.deepEqual([...reach.keys()].sort(), [...everyone].sort());
  const expect = {
    [v.in]: { in_app: null, push: null, whatsapp: null, sms: null },
    [v.inAdmin]: { in_app: null, push: 'push_marketing_off', whatsapp: null, sms: null },
    [v.noInApp]: { in_app: 'in_app_marketing_off', push: null, whatsapp: null, sms: null },
    [v.noPush]: { in_app: null, push: 'push_marketing_off', whatsapp: null, sms: null },
    [v.noSms]: { in_app: null, push: null, whatsapp: null, sms: 'sms_marketing_not_opted_in' },
    [v.smsFlag]: { in_app: null, push: null, whatsapp: null, sms: 'sms_opted_out' },
    [v.noWa]: { in_app: null, push: null, whatsapp: 'whatsapp_marketing_not_opted_in', sms: null },
    [v.defaults]: { in_app: null, push: null, whatsapp: 'whatsapp_marketing_not_opted_in', sms: 'sms_marketing_not_opted_in' },
  };
  for (const id of everyone) assert.deepEqual(reach.get(id), expect[id], id);

  const promoPv = await segAll.previewAudience({ sender: w.FF, recipients: 'vendors', filter: mine, purpose: 'promotion' });
  assert.equal(promoPv.category, 'marketing');
  assert.deepEqual(promoPv.channels.push, { eligible: 6, excluded: { push_marketing_off: 2 } });
  assert.deepEqual(promoPv.channels.in_app, { eligible: 7, excluded: { in_app_marketing_off: 1 } });
  assert.deepEqual(promoPv.channels.sms, { eligible: 5, excluded: { sms_marketing_not_opted_in: 2, sms_opted_out: 1 } });
  assert.deepEqual(promoPv.channels.whatsapp, { eligible: 6, excluded: { whatsapp_marketing_not_opted_in: 2 } });

  // Service messages are unchanged: offers switched off don't stop them; the SMS opt-out flag still does.
  const annPv = await segAll.previewAudience({ sender: w.FF, recipients: 'vendors', filter: mine, purpose: 'announcement' });
  assert.equal(annPv.category, 'transactional');
  assert.deepEqual(annPv.channels.in_app, { eligible: 8, excluded: {} });
  assert.deepEqual(annPv.channels.push, { eligible: 8, excluded: {} });
  assert.deepEqual(annPv.channels.sms, { eligible: 7, excluded: { sms_opted_out: 1 } });

  // A real promotion over in-app, push and SMS: opted-out vendors are skipped per channel, the rest get it.
  const sendPromo = async (channels) => {
    const { campaign, error } = await campaignsAll.create(w.FF, {
      purpose: 'promotion', audience: { recipients: 'vendors', filter: mine },
      content: { locale: 'sw', title: 'Ofa ya wauzaji', body: 'Punguzo kwa {{member_name}}.' }, channels,
    });
    assert.equal(error, undefined);
    const sent = await campaignsAll.send(w.FF, campaign.id, { sendRequestId: uid('req') });
    assert.equal(sent.error, undefined, JSON.stringify(sent));
    return campaign.id;
  };
  const rowsOf = async (campaignId) => Object.fromEntries((await db('CommunicationMessage').where({ campaignId }))
    .map(r => [`${r.memberId}:${r.channel}`, r]));
  const promoId = await sendPromo(['in_app', 'push', 'sms']);
  let rows = await rowsOf(promoId);
  for (const id of everyone) {
    for (const ch of ['in_app', 'push', 'sms']) {
      const r = rows[`${id}:${ch}`];
      assert.ok(r, `${id}:${ch}`);
      assert.equal(r.category, 'marketing');
      assert.equal(r.skipReason ?? null, expect[id][ch], `${id}:${ch}`);
      assert.equal(r.status, expect[id][ch] ? 'skipped' : 'queued', `${id}:${ch}`);
    }
  }

  fcm.sent.length = 0;
  smsProvider.sent.length = 0;
  await deliveryAll.runOnce();
  rows = await rowsOf(promoId);
  const inboxHas = async (id) => Boolean((await notificationService.inbox({ userId: id })).notifications.find(n => n.campaignId === promoId));
  const pushedTo = (id) => fcm.sent.some(s => s.data?.campaignId === promoId && s.tokens.includes(tokens.get(id)));
  const textedTo = (id) => smsProvider.sent.some(s => s.to.includes(phones.get(id)));
  // The opted-in vendor gets it on every channel.
  assert.equal(await inboxHas(v.in), true, 'opted-in vendor: inbox');
  assert.equal(pushedTo(v.in), true, 'opted-in vendor: push');
  assert.equal(textedTo(v.in), true, 'opted-in vendor: SMS');
  assert.equal(rows[`${v.in}:sms`].status, 'sent');
  // Each opted-out vendor misses only the channel they switched off.
  assert.equal(await inboxHas(v.noInApp), false);
  assert.equal(pushedTo(v.noInApp), true);
  assert.equal(pushedTo(v.noPush), false);
  assert.equal(await inboxHas(v.noPush), true);
  assert.equal(pushedTo(v.inAdmin), false, "staff's own push opt-out, not the vendor account's");
  assert.equal(textedTo(v.inAdmin), true);
  for (const id of [v.noSms, v.smsFlag, v.defaults]) assert.equal(textedTo(id), false, id);
  assert.equal(textedTo(v.noWa), true);

  // Opting out after the message was queued is honoured at delivery (SMS checks again just before sending).
  const lateId = await sendPromo(['sms']);
  await put(v.in, 'vendor', { smsMarketing: false });
  smsProvider.sent.length = 0;
  await deliveryAll.runOnce();
  rows = await rowsOf(lateId);
  assert.equal(rows[`${v.in}:sms`].status, 'skipped');
  assert.equal(rows[`${v.in}:sms`].skipReason, 'sms_marketing_not_opted_in');
  assert.equal(textedTo(v.in), false);
  assert.equal(rows[`${v.noWa}:sms`].status, 'sent', 'another opted-in vendor still gets it');

  // In-app and push offers switched off after an immediate send was queued: not delivered (review of #274).
  const appId = await sendPromo(['in_app', 'push']);
  rows = await rowsOf(appId);
  assert.equal(rows[`${v.noSms}:in_app`].status, 'queued');
  await put(v.noSms, 'vendor', { inAppMarketing: false, pushMarketing: false });
  fcm.sent.length = 0;
  await deliveryAll.runOnce();
  rows = await rowsOf(appId);
  assert.deepEqual([rows[`${v.noSms}:in_app`].status, rows[`${v.noSms}:in_app`].skipReason], ['skipped', 'in_app_marketing_off']);
  assert.deepEqual([rows[`${v.noSms}:push`].status, rows[`${v.noSms}:push`].skipReason], ['skipped', 'push_marketing_off']);
  assert.equal((await notificationService.inbox({ userId: v.noSms })).notifications.find(n => n.campaignId === appId), undefined);
  assert.ok(!fcm.sent.some(s => s.data?.campaignId === appId && s.tokens.includes(tokens.get(v.noSms))));
  assert.equal(rows[`${v.noWa}:in_app`].status, 'delivered', 'another vendor still gets it');
  assert.equal(rows[`${v.noWa}:push`].status, 'sent');

  // A service SMS still reaches the vendor who switched SMS offers off.
  const { campaign: svc } = await campaignsAll.create(w.FF, {
    purpose: 'announcement', audience: { recipients: 'vendors', filter: mine },
    content: { locale: 'sw', title: 'Taarifa', body: 'Taarifa ya huduma.' }, channels: ['sms'],
  });
  assert.equal((await campaignsAll.send(w.FF, svc.id, { sendRequestId: uid('req') })).error, undefined);
  smsProvider.sent.length = 0;
  await deliveryAll.runOnce();
  rows = await rowsOf(svc.id);
  assert.equal(rows[`${v.in}:sms`].status, 'sent');
  assert.equal(rows[`${v.smsFlag}:sms`].skipReason, 'sms_opted_out', 'the SMS opt-out flag still blocks service SMS');
});
