// Shop home banners (Phase 2 · slice 1, flag SHOP_BANNERS). Contract: docs/shop-banners-api.md.
// - Text rules: no prices, percentages or amounts in either language; both languages required.
// - State machine: draft → pending_approval → approved (→ live by time) → ended; withdraw, reject,
//   expiry after 14 days or at the start; edits send an approved banner back for approval.
// - The approver is never the creator or the sender; approving needs the photo confirmations.
// - A vendor links only to their own product or store; a suspended vendor cannot propose and their
//   live banners leave the shop at once; the audience decides who sees a banner.
// - Photos: the app-photo pipeline (EXIF stripped, private until approved); banner photos never
//   appear in the app-photo library.
// - Flag off: every route 404s before sign-in and GET /shop/home is byte-identical to before.
// Service tests use the real Postgres store (CI database) with in-memory Zebra stand-ins; route
// tests mount every function file the way bfast does, against a local Zebra.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import FormData from 'form-data';
import sharp from 'sharp';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { shopHomeService, heroImageService } from '../src/bootstrap/services.mjs';
import { parseMultipartRequest } from '../src/infra/storage-client.mjs';
import { createShopBannerService } from '../src/services/shop-banner-service.mjs';
import { createPgShopBannerStore } from '../src/infra/shop-banner-store-pg.mjs';
import { createShopHomeService, shopHomeConfigFromEnv } from '../src/services/shop-home-service.mjs';
import { createPartnerNotifier } from '../src/services/partner-notifier.mjs';
import { resetShopHomeLimits } from '../functions/shop-home.mjs';
import { resetShopBannerLimits, BANNER_RATE_LIMITS } from '../functions/shop-banners.mjs';
import {
  hasPriceClaim, hasContact, parseBannerInput, effectiveStatus, proposalExpiry, bannerConfigFromEnv, DEFAULT_CTA, BANNER_CONFIRMATION, normaliseText,
} from '../src/shared/shop-banner-rules.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

await ensureInit();

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── Fixtures ────────────────────────────────────────────────────────────────

const made = { users: [], products: [] };
async function user(userType, extra = {}) {
  const id = uid(userType === 'admin' ? 'adm' : 'usr');
  await db('User').insert({ id, userType, displayName: `Banner ${userType}`, accountStatus: 'active', updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
const vendorUser = (name, extra = {}) => user('vendor', { approvalStatus: 'approved', vendorProfile: JSON.stringify({ businessName: name, status: 'published' }), ...extra });
async function product(vendorId, extra = {}) {
  const id = uid('prd');
  await db('Product').insert({ id, vendorId, name: `Banner product ${id.slice(-4)}`, category: 'equipment', priceTzs: 20_000, stock: 5, status: 'active', approvalStatus: 'approved', updatedAt: new Date(), ...extra });
  made.products.push(id);
  return id;
}

/** A photo-like picture (smooth colour + grain), optionally with GPS EXIF. Test fixture only. */
async function photo(width = 1600, height = 1000, { format = 'jpeg', gps = false } = {}) {
  const small = await sharp(randomBytes(32 * 20 * 3), { raw: { width: 32, height: 20, channels: 3 } }).resize(width, height, { kernel: 'cubic' }).blur(2).png().toBuffer();
  let img = sharp(small);
  if (gps) {
    img = sharp(await img.jpeg({ quality: 90 }).toBuffer()).withExif({
      IFD0: { Make: 'PhoneCo' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '6/1 48/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '39/1 17/1 0/1' },
    });
  }
  if (format === 'png') return img.png().toBuffer();
  if (format === 'gif') return img.gif().toBuffer();
  return img.jpeg({ quality: 90 }).toBuffer();
}
let PHOTO;

function memoryStores() {
  const priv = new Map(); const pub = new Map();
  let n = 0;
  return {
    priv, pub,
    documentStore: {
      provider: 'zebra',
      async put(buffer, name) { const key = `bafypriv${++n}/${name}`; priv.set(key, Buffer.from(buffer)); return { provider: 'zebra', key }; },
      async get(key) { if (!priv.has(key)) throw new Error('missing'); return Buffer.from(priv.get(key)); },
    },
    publicStore: {
      async put(buffer, filename) { const cid = `bafypub${++n}`; pub.set(`${cid}/${filename}`, Buffer.from(buffer)); return { url: `/storage/${cid}/${filename}` }; },
    },
  };
}

/** A service over the real store, with its own clock, Zebra stand-ins, gates and a notice log. */
function harness({ unverified = [], blocked = [] } = {}) {
  let clock = Date.now();
  const notices = [];
  const stores = memoryStores();
  const gate = { unverified: new Set(unverified), blocked: new Set(blocked) };
  const raw = createShopBannerService({
    store: createPgShopBannerStore({ db }),
    documentStore: stores.documentStore, publicStore: stores.publicStore,
    partnerGate: { operationalUserIds: async ids => new Set(ids.filter(id => !gate.unverified.has(id))) },
    moderationGate: { blocked: async () => gate.blocked },
    notifyVendor: async (vendorId, type, data) => { notices.push({ vendorId, type, data }); },
    now: () => new Date(clock),
    logger: { error() {}, warn() {} },
  });
  // Decisions name the revision and photo reviewed; unless a test passes its own, use the current ones.
  const fresh = async (id) => {
    const r = await db('ShopBanner').where({ id }).first();
    return r ? { revision: r.revision, imageId: r.imageId } : {};
  };
  const svc = {
    ...raw,
    approve: async a => raw.approve({ ...(await fresh(a.id)), ...a }),
    reject: async a => raw.reject({ ...(await fresh(a.id)), ...a }),
  };
  return { svc, raw, fresh, notices, stores, gate, tick: msAhead => { clock += msAhead; }, now: () => new Date(clock) };
}

const TEXT = {
  headlineLead: { en: 'Train harder with', sw: 'Fanya mazoezi zaidi na' },
  headlineAccent: { en: 'new gear', sw: 'vifaa vipya' },
  subline: { en: 'Fresh stock from a Dar seller.', sw: 'Bidhaa mpya kutoka kwa muuzaji wa Dar.' },
  imageAlt: { en: 'Dumbbells on a rack', sw: 'Dumbbell kwenye rafu' },
};
const windowFrom = (now, startInMs = 2 * HOUR, lengthMs = 3 * DAY) => ({
  startsAt: new Date(now.getTime() + startInMs).toISOString(), endsAt: new Date(now.getTime() + startInMs + lengthMs).toISOString(),
});
const GOOD_FIELDS = { people: 'none', rightsConfirmed: 'true', confirmationVersion: BANNER_CONFIRMATION.version };
const MODEL_FIELDS = { ...GOOD_FIELDS, people: 'product_models', peopleConfirmed: 'true', consentRef: 'MR-2026-001' };
const ALL_CHECKS = ['people', 'text', 'languages'];

/** A vendor banner sent for approval. → { id, vendor, productId, h }. */
async function pendingVendorBanner(h, { vendor, productId, body = {}, fields = GOOD_FIELDS } = {}) {
  vendor ||= await vendorUser('Dar Gear');
  productId ||= await product(vendor);
  const scope = { origin: 'vendor', vendorId: vendor };
  const c = await h.svc.create({ scope, actorId: vendor, body: { ...TEXT, target: { type: 'product', value: productId }, ...windowFrom(h.now()), ...body } });
  assert.equal(c.error, undefined, JSON.stringify(c));
  const up = await h.svc.uploadImage({ scope, id: c.banner.id, file: { buffer: PHOTO }, fields, actorId: vendor });
  assert.equal(up.error, undefined, JSON.stringify(up));
  const s = await h.svc.submit({ scope, id: c.banner.id, actorId: vendor });
  assert.equal(s.error, undefined, JSON.stringify(s));
  return { id: c.banner.id, vendor, productId, scope };
}

async function cleanBanners() {
  const banners = await db('ShopBanner').select('id', 'imageId');
  const ids = banners.map(b => b.id);
  const images = (await db('HeroImage').where({ purpose: 'shop_banner' }).pluck('id'));
  await db('AuditLog').where('action', 'like', 'shop\\_banner.%').del();
  await db('ShopBanner').del();
  if (images.length) await db('HeroImage').whereIn('id', images).del();
  return ids;
}

// ── A local Zebra and every route, mounted as bfast does ────────────────────

const zebraFiles = new Map();
let zebra; let server; let base;

before(async () => {
  PHOTO = await photo();
  zebra = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/storage') {
      const { files } = await parseMultipartRequest(req);
      const cid = `bafyzebra${zebraFiles.size + 1}`;
      zebraFiles.set(`${cid}/${files[0].filename}`, files[0].buffer);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ urls: [`/storage/${cid}/${files[0].filename}`] }));
    }
    const key = decodeURIComponent(req.url.replace(/^\/storage\//, ''));
    if (req.method === 'GET' && zebraFiles.has(key)) return res.end(zebraFiles.get(key));
    res.statusCode = 404;
    res.end();
  });
  await new Promise(resolve => zebra.listen(0, '127.0.0.1', resolve));
  process.env.ZEBRA_BASE_URL = `http://127.0.0.1:${zebra.address().port}`;
  const functionsDir = path.join(root, 'functions');
  const functions = {};
  for (const file of fs.readdirSync(functionsDir).filter(f => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
    const mod = await import(path.join(functionsDir, file));
    for (const [name, d] of Object.entries(mod)) if (d && typeof d === 'object' && (d.onRequest || d.onGuard)) functions[name] = d;
  }
  const app = express();
  app.use(express.json());
  mountGuards(Object.keys(functions).filter(k => functions[k].onGuard), functions, app);
  mountHttpRoutes(Object.keys(functions).filter(k => functions[k].onRequest), functions, app);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await cleanBanners();
});

after(async () => {
  for (const k of ['ZEBRA_BASE_URL', 'SHOP_BANNERS', 'SHOP_HOME_V2', 'SHOP_HOME_MIN_ITEMS', 'SHOP_HOME_CACHE_SECONDS', 'SHOP_BANNER_MAX_LIVE', 'SHOP_PROPOSAL_EXPIRY_DAYS']) delete process.env[k];
  server?.close();
  await new Promise(resolve => zebra.close(resolve));
  await cleanBanners();
  await db('MarketplaceNotification').whereIn('userId', made.users).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('Product').whereIn('id', made.products).del();
  await db('User').whereIn('id', made.users).del();
  await db.destroy();
});

beforeEach(() => {
  delete process.env.SHOP_BANNER_MAX_LIVE;
  delete process.env.SHOP_PROPOSAL_EXPIRY_DAYS;
  delete process.env.SHOP_BANNER_MAX_OPEN;
  resetShopBannerLimits();
});

async function hit(method, url, { claims, body } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let parsed = buf.toString();
  try { parsed = JSON.parse(parsed); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, raw: buf, headers: res.headers };
}
async function uploadReq(url, file, fields, claims) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('file', file, { filename: 'banner.jpg', contentType: 'image/jpeg' });
  const res = await fetch(`${base}${url}`, { method: 'POST', body: form.getBuffer(), headers: { ...form.getHeaders(), authorization: `Bearer ${sign(claims)}` } });
  return { status: res.status, body: await res.json() };
}

// ── Text rules ──────────────────────────────────────────────────────────────

test('text rule: prices, percentages and amounts are refused in either language, with the field', () => {
  for (const t of ['20% off', 'Punguzo la %', 'TSh 50,000', 'TZS5000', '50,000/=', 'Sh. 500 tu', 'Bei 5000', 'asilimia 20', '10 percent off', '1.200.000', '500 shilingi']) {
    assert.equal(hasPriceClaim(t), true, t);
  }
  for (const t of ['New whey in stock', 'Buy 2, get 1', '5K fun run tickets', 'Sugar-free whey', 'Co-op gear', 'Mpya kwa msimu huu']) assert.equal(hasPriceClaim(t), false, t);
  for (const t of ['call 0712 345 678', '+255 712 345 678', 'www.mydeals.com', 'https://x.co', 'shop.co.tz']) assert.equal(hasContact(t), true, t);

  const sw = parseBannerInput({ ...TEXT, headlineAccent: { en: 'new gear', sw: 'punguzo la 30%' } }, { origin: 'vendor', vendorId: 'v' });
  assert.deepEqual([sw.error, sw.status, sw.field], ['price_claim_in_text', 422, 'headlineAccent.sw']);
  const en = parseBannerInput({ ...TEXT, subline: { en: 'Only TSh 20,000', sw: 'Mpya' } }, { origin: 'vendor', vendorId: 'v' });
  assert.deepEqual([en.error, en.field], ['price_claim_in_text', 'subline.en']);
  const contact = parseBannerInput({ ...TEXT, subline: { en: 'Call 0712 345 678', sw: 'Piga simu' } }, { origin: 'vendor', vendorId: 'v' });
  assert.deepEqual([contact.error, contact.status, contact.field], ['contact_in_text', 422, 'subline.en']);
});

test('text rule: both languages are required (missing_translation), an optional subline needs both or neither', () => {
  const ctx = { origin: 'vendor', vendorId: 'v' };
  const noSw = parseBannerInput({ headlineLead: { en: 'Train with' } }, ctx);
  assert.deepEqual([noSw.error, noSw.status, noSw.field, noSw.missing], ['missing_translation', 422, 'headlineLead.sw', ['sw']]);
  const noEn = parseBannerInput({ imageAlt: { en: '  ', sw: 'Picha' } }, ctx);
  assert.deepEqual([noEn.error, noEn.field], ['missing_translation', 'imageAlt.en']);
  const halfSub = parseBannerInput({ subline: { en: 'Fresh stock', sw: '' } }, ctx);
  assert.deepEqual([halfSub.error, halfSub.field], ['missing_translation', 'subline.sw']);
  assert.equal(parseBannerInput({ subline: { en: '', sw: '' } }, ctx).value.subline, null, 'both empty clears it');
  assert.equal(parseBannerInput({ subline: null }, ctx).value.subline, null);
  const cta = parseBannerInput({ ctaLabel: { en: 'Shop' } }, { origin: 'staff' });
  assert.equal(cta.error, 'missing_translation');
  assert.deepEqual(parseBannerInput({ nope: 1 }, ctx).error, 'unknown_field');
});

test('service: the headline length limit counts lead + accent per language; refused texts are not saved', async () => {
  const h = harness();
  const vendor = await vendorUser('Long Text');
  const scope = { origin: 'vendor', vendorId: vendor };
  const long = await h.svc.create({ scope, actorId: vendor, body: { headlineLead: { en: 'An extremely long headline lead', sw: 'Kichwa' }, headlineAccent: { en: 'and accent', sw: 'kifupi' } } });
  assert.deepEqual([long.error, long.status, long.field, long.max], ['headline_too_long', 422, 'headlineAccent.en', 32]);
  const price = await h.svc.create({ scope, actorId: vendor, body: { ...TEXT, headlineLead: { en: 'Save 20%', sw: 'Okoa' } } });
  assert.equal(price.error, 'price_claim_in_text');
  assert.equal((await db('ShopBanner').where({ vendorId: vendor })).length, 0);
});

// ── State machine ───────────────────────────────────────────────────────────

test('state machine: draft → pending → approved → live (by time) → ended, with audit, history and notices', async () => {
  const h = harness();
  const approver = await user('admin', { displayName: 'Approver Y' });
  const { id, vendor, scope } = await pendingVendorBanner(h);
  const pending = (await h.svc.vendorGet({ vendorId: vendor, id })).banner;
  assert.equal(pending.status, 'pending_approval');
  assert.deepEqual(pending.allowedActions.sort(), ['edit', 'image', 'withdraw']);
  assert.deepEqual(pending.ctaLabel, DEFAULT_CTA.product, 'default CTA by target');

  const ok = await h.svc.approve({ id, actorId: approver, checks: ALL_CHECKS, position: 2 });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(ok.saved.status, 'approved');
  assert.equal(ok.saved.position, 2);
  assert.equal(effectiveStatus(ok.saved, h.now()), 'approved', 'scheduled: start still ahead');
  assert.equal(h.stores.pub.size, 4, 'public files made on approval: 2x, 1x, wide, avif');
  assert.deepEqual(h.notices.map(n => n.type), ['shop_banner_approved']);
  assert.equal(h.notices[0].data.headline, 'Train harder with new gear');
  assert.equal(h.notices[0].data.headlineSw, 'Fanya mazoezi zaidi na vifaa vipya');

  // An approved banner still ahead of its start can be withdrawn; this one goes live instead.
  h.tick(3 * HOUR);
  const live = (await h.svc.vendorGet({ vendorId: vendor, id })).banner;
  assert.equal(live.status, 'approved');
  assert.equal(live.effectiveStatus, 'live');
  assert.deepEqual(live.allowedActions.sort(), ['edit', 'end', 'image'], 'a new photo is an edit, like PATCH');
  const noWithdraw = await h.svc.withdraw({ scope, id, actorId: vendor });
  assert.deepEqual([noWithdraw.error, noWithdraw.status, noWithdraw.hint], ['invalid_transition', 409, 'end']);
  const ended = await h.svc.vendorEnd({ scope, id, actorId: vendor });
  assert.equal(ended.saved.status, 'ended');
  assert.equal((await h.svc.vendorGet({ vendorId: vendor, id })).banner.endedByFitflex, false);
  const again = await h.svc.update({ scope, id, actorId: vendor, body: { subline: null } });
  assert.deepEqual([again.error, again.status], ['not_editable', 409]);

  const detail = await h.svc.adminGet({ id, viewer: { actorId: approver, canApprove: true } });
  assert.deepEqual(detail.history.map(r => r.action), ['shop_banner.created', 'shop_banner.image_uploaded', 'shop_banner.submitted', 'shop_banner.image_published', 'shop_banner.approved', 'shop_banner.ended']);
  assert.equal(detail.banner.approvedByName, 'Approver Y');
  assert.equal(detail.banner.image.rightsConfirmedBy, vendor);
  assert.ok(detail.banner.image.rightsConfirmedAt && detail.banner.image.peopleConfirmedAt);
  assert.equal(detail.banner.vendorName, 'Dar Gear');
  assert.equal(detail.history.find(r => r.action === 'shop_banner.approved').actorName, 'Approver Y');
  assert.equal(detail.history[0].actorName, 'Banner vendor');
});

test('state machine: edits — pending stays pending, approved goes back to pending, rejected back to draft; withdraw; reject needs a reason', async () => {
  const h = harness();
  const approver = await user('admin');
  const { id, vendor, scope } = await pendingVendorBanner(h);
  const before = await db('ShopBanner').where({ id }).first();
  const edited = await h.svc.update({ scope, id, actorId: vendor, body: { subline: { en: 'New stock in Dar', sw: 'Bidhaa mpya Dar' } } });
  assert.equal(edited.banner.status, 'pending_approval');
  assert.equal(edited.banner.expiresAt, before.expiresAt.toISOString(), 'the expiry clock keeps its start');

  await h.svc.approve({ id, actorId: approver, checks: ALL_CHECKS });
  const back = await h.svc.update({ scope, id, actorId: vendor, body: { headlineAccent: { en: 'fresh gear', sw: 'vifaa vibichi' } } });
  assert.equal(back.banner.status, 'pending_approval', 'editing an approved banner sends it back for approval');
  const row = await db('ShopBanner').where({ id }).first();
  assert.equal(row.approvedBy, null);
  assert.equal(row.submittedBy, vendor);

  assert.deepEqual((await h.svc.reject({ id, actorId: approver, note: 'Blurry' })).error, 'reason_code_required');
  assert.deepEqual((await h.svc.reject({ id, actorId: approver, note: 'Blurry', code: 'nope' })).error, 'invalid_reason_code');
  assert.deepEqual((await h.svc.reject({ id, actorId: approver, code: 'other', note: '  ' })).error, 'note_required');
  // updatedAt is accepted in place of revision (portal fallback); a stale one is refused.
  const seenRow = await db('ShopBanner').where({ id }).first();
  const staleAt = await h.raw.reject({ id, actorId: approver, code: 'image', updatedAt: '2020-01-01T00:00:00.000Z', imageId: seenRow.imageId });
  assert.equal(staleAt.error, 'banner_changed');
  const rej = await h.raw.reject({ id, actorId: approver, code: 'image', note: 'The photo is blurry.', updatedAt: seenRow.updatedAt.toISOString(), imageId: seenRow.imageId });
  assert.equal(rej.saved.status, 'rejected');
  assert.equal(h.notices.at(-1).type, 'shop_banner_rejected');
  assert.equal(h.notices.at(-1).data.reason, 'The photo is blurry.');
  const vendorSees = (await h.svc.vendorGet({ vendorId: vendor, id })).banner;
  assert.deepEqual([vendorSees.statusReasonNote, vendorSees.statusReason], ['The photo is blurry.', 'image']);
  assert.equal(vendorSees.approvedBy, undefined, 'vendors never see staff ids');

  const fixed = await h.svc.update({ scope, id, actorId: vendor, body: { imageAlt: { en: 'A rack of dumbbells', sw: 'Rafu ya dumbbell' } } });
  assert.equal(fixed.banner.status, 'draft', 'a rejected banner edited becomes a draft to send again');
  assert.equal((await h.svc.approve({ id, actorId: approver, checks: ALL_CHECKS })).error, 'banner_not_found', 'a vendor draft is not visible to FitFlex');
  const resent = await h.svc.submit({ scope, id, actorId: vendor });
  assert.equal(resent.saved.status, 'pending_approval');
  const wd = await h.svc.withdraw({ scope, id, actorId: vendor });
  assert.equal(wd.saved.status, 'withdrawn');
  assert.equal((await h.svc.submit({ scope, id, actorId: vendor })).error, 'invalid_transition');
  assert.equal((await h.svc.update({ scope, id, actorId: vendor, body: { subline: null } })).error, 'not_editable');
});

test('submit: needs a photo, a start at least an hour ahead, an end after it, and an eligible target', async () => {
  const h = harness();
  const vendor = await vendorUser('Submit Rules');
  const p = await product(vendor);
  const scope = { origin: 'vendor', vendorId: vendor };
  const c = await h.svc.create({ scope, actorId: vendor, body: { ...TEXT, target: { type: 'product', value: p }, ...windowFrom(h.now(), 30 * 60_000) } });
  assert.equal((await h.svc.submit({ scope, id: c.banner.id, actorId: vendor })).error, 'start_too_soon');
  await h.svc.update({ scope, id: c.banner.id, actorId: vendor, body: windowFrom(h.now()) });
  assert.equal((await h.svc.submit({ scope, id: c.banner.id, actorId: vendor })).error, 'image_required');
  const bad = await h.svc.update({ scope, id: c.banner.id, actorId: vendor, body: { endsAt: new Date(h.now().getTime() + HOUR).toISOString() } });
  assert.deepEqual([bad.error, bad.field], ['end_before_start', 'endsAt']);
  await h.svc.uploadImage({ scope, id: c.banner.id, file: { buffer: PHOTO }, fields: GOOD_FIELDS, actorId: vendor });
  await db('Product').where({ id: p }).update({ status: 'archived' });
  const notListed = await h.svc.submit({ scope, id: c.banner.id, actorId: vendor });
  assert.deepEqual([notListed.error, notListed.reason], ['target_not_eligible', 'product_not_listed']);
  await db('Product').where({ id: p }).update({ status: 'active' });
  // No 30-day maximum (owner 2026-10-20): a 90-day run is accepted.
  await h.svc.update({ scope, id: c.banner.id, actorId: vendor, body: windowFrom(h.now(), 2 * HOUR, 90 * DAY) });
  assert.equal((await h.svc.submit({ scope, id: c.banner.id, actorId: vendor })).saved.status, 'pending_approval');
});

// ── Self-approval ───────────────────────────────────────────────────────────

test('self-approval: the creator and the sender can never approve or reject; another admin can', async () => {
  const h = harness();
  const x = await user('admin'); const y = await user('admin'); const z = await user('admin');
  const vendor = await vendorUser('Staff Target');
  await product(vendor, { category: 'supplements_nutrition' });
  const c = await h.svc.create({ scope: { origin: 'staff' }, actorId: x, body: { ...TEXT, target: { type: 'category', value: 'supplements_nutrition' }, ...windowFrom(h.now()) } });
  assert.equal(c.banner.origin, 'staff');
  await h.svc.uploadImage({ scope: { origin: 'staff' }, id: c.banner.id, file: { buffer: PHOTO }, fields: GOOD_FIELDS, actorId: x });
  // y sends what x made: now neither may decide it.
  const sent = await h.svc.submit({ scope: { origin: 'staff' }, id: c.banner.id, actorId: y });
  assert.equal(sent.saved.status, 'pending_approval');
  for (const who of [x, y]) {
    const a = await h.svc.approve({ id: c.banner.id, actorId: who, checks: ALL_CHECKS });
    assert.deepEqual([a.error, a.status], ['cannot_approve_own_submission', 403]);
    const r = await h.svc.reject({ id: c.banner.id, actorId: who, code: 'other', note: 'Nope, wrong.' });
    assert.deepEqual([r.error, r.status], ['cannot_approve_own_submission', 403]);
  }
  const viewX = (await h.svc.adminGet({ id: c.banner.id, viewer: { actorId: x, canApprove: true, canManage: true } })).banner;
  assert.equal(viewX.ownItem, true);
  assert.ok(!viewX.allowedActions.includes('approve'));
  const viewZ = (await h.svc.adminGet({ id: c.banner.id, viewer: { actorId: z, canApprove: true } })).banner;
  assert.ok(viewZ.allowedActions.includes('approve'));
  const ok = await h.svc.approve({ id: c.banner.id, actorId: z, checks: ALL_CHECKS });
  assert.equal(ok.saved.status, 'approved');
  assert.equal(h.notices.length, 0, 'staff banners notify no vendor');
  // Ending is allowed to anyone with the approve scope, the creator too.
  const end = await h.svc.end({ id: c.banner.id, actorId: x, reason: 'Campaign over.' });
  assert.equal(end.saved.status, 'ended');
});

// ── Vendor target ownership ─────────────────────────────────────────────────

test('vendor targets: only my own product or store; category and results are staff only', async () => {
  const h = harness();
  const a = await vendorUser('Vendor A'); const b = await vendorUser('Vendor B');
  const pa = await product(a); const pb = await product(b);
  const scope = { origin: 'vendor', vendorId: a };
  const other = await h.svc.create({ scope, actorId: a, body: { ...TEXT, target: { type: 'product', value: pb } } });
  assert.deepEqual([other.error, other.status, other.field], ['target_not_owned', 403, 'target.value']);
  const ghost = await h.svc.create({ scope, actorId: a, body: { target: { type: 'product', value: 'prd_nope' } } });
  assert.equal(ghost.error, 'target_not_owned');
  const store = await h.svc.create({ scope, actorId: a, body: { target: { type: 'vendor_store', value: b } } });
  assert.equal(store.error, 'target_not_owned');
  const cat = await h.svc.create({ scope, actorId: a, body: { target: { type: 'category', value: 'equipment' } } });
  assert.deepEqual([cat.error, cat.status], ['target_type_not_allowed', 403]);
  const own = await h.svc.create({ scope, actorId: a, body: { target: { type: 'vendor_store' } } });
  assert.deepEqual(own.banner.target, { type: 'vendor_store', value: a }, 'my store when the value is left out');
  assert.deepEqual(own.banner.ctaLabel, DEFAULT_CTA.vendor_store);
  const ok = await h.svc.create({ scope, actorId: a, body: { target: { type: 'product', value: pa } } });
  assert.equal(ok.error, undefined);
  const patch = await h.svc.update({ scope, id: ok.banner.id, actorId: a, body: { target: { type: 'product', value: pb } } });
  assert.equal(patch.error, 'target_not_owned');
  // Another vendor's banner id reads as not found.
  assert.equal((await h.svc.update({ scope: { origin: 'vendor', vendorId: b }, id: ok.banner.id, actorId: b, body: { subline: null } })).error, 'banner_not_found');
  assert.equal((await h.svc.vendorGet({ vendorId: b, id: ok.banner.id })).error, 'banner_not_found');
  // FitFlex never edits a vendor's banner, and a vendor's draft is not in the queue.
  assert.equal((await h.svc.update({ scope: { origin: 'staff' }, id: ok.banner.id, actorId: 'adm_x', body: { subline: null } })).error, 'banner_not_found');
  assert.equal((await h.svc.adminGet({ id: ok.banner.id, viewer: {} })).error, 'banner_not_found');
});

// ── Image confirmations and the photo pipeline ──────────────────────────────

test('photo: rights and people confirmations are required; limits; EXIF/GPS stripped; private until approved', async () => {
  const h = harness();
  const vendor = await vendorUser('Photo Rules');
  const p = await product(vendor);
  const scope = { origin: 'vendor', vendorId: vendor };
  const c = await h.svc.create({ scope, actorId: vendor, body: { ...TEXT, target: { type: 'product', value: p }, ...windowFrom(h.now()) } });
  const up = (fields, buffer = PHOTO) => h.svc.uploadImage({ scope, id: c.banner.id, file: { buffer }, fields, actorId: vendor });
  assert.equal((await up({ ...GOOD_FIELDS, rightsConfirmed: undefined })).error, 'rights_confirmation_required');
  assert.equal((await up({ ...GOOD_FIELDS, people: 'product_models' })).error, 'people_confirmation_required');
  assert.equal((await up({ ...GOOD_FIELDS, people: 'members' })).error, 'invalid_people');
  const small = await up(GOOD_FIELDS, await photo(1200, 800));
  assert.deepEqual([small.error, small.minWidth, small.minHeight], ['image_too_small', 1600, 1000]);
  assert.equal((await up(GOOD_FIELDS, await photo(1800, 900))).error, 'image_too_small', 'too short');
  assert.equal((await up(GOOD_FIELDS, await photo(1600, 1000, { format: 'gif' }))).error, 'unsupported_file_type');
  const big = await up(GOOD_FIELDS, Buffer.alloc(5 * 1024 * 1024 + 1, 1));
  assert.deepEqual([big.error, big.status], ['file_too_large', 413]);
  assert.equal(h.stores.priv.size, 0, 'nothing stored for refused uploads');

  const withGps = await photo(1600, 1000, { gps: true });
  assert.ok((await sharp(withGps).metadata()).exif, 'fixture carries EXIF');
  assert.deepEqual((await up({ ...MODEL_FIELDS, consentRef: undefined }, withGps)).error, 'consent_reference_required');
  const old = await up({ ...GOOD_FIELDS, confirmationVersion: '2026-01-01' });
  assert.deepEqual([old.error, old.current], ['confirmation_version_mismatch', BANNER_CONFIRMATION.version]);
  assert.equal((await up({ ...GOOD_FIELDS, confirmationVersion: undefined })).error, 'confirmation_version_mismatch');
  const ok = await up({ ...MODEL_FIELDS, focalX: '0.25', licenceRef: 'Own shoot' }, withGps);
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(ok.banner.image.people, 'product_models');
  assert.deepEqual(ok.banner.image.focal, { x: 0.25, y: 0 });
  assert.equal(ok.banner.image.public, null, 'no public files before approval');
  const [master] = [...h.stores.priv.values()];
  const meta = await sharp(master).metadata();
  assert.equal(meta.exif, undefined, 'EXIF/GPS stripped');
  assert.equal(meta.format, 'webp');
  assert.equal(h.stores.pub.size, 0);
  const row = await db('HeroImage').where({ id: ok.banner.image.id }).first();
  assert.deepEqual([row.purpose, row.vendorId, row.rightsConfirmedBy, row.noFacesConfirmedBy], ['shop_banner', vendor, vendor, vendor]);
  assert.deepEqual([row.consentRef, row.licenceRef, row.confirmationVersion], ['MR-2026-001', 'Own shoot', BANNER_CONFIRMATION.version]);
  assert.equal(BANNER_CONFIRMATION.status, 'draft_pending_counsel');

  // A second photo replaces the first (retired).
  const second = await up(GOOD_FIELDS);
  assert.notEqual(second.banner.image.id, ok.banner.image.id);
  assert.equal((await db('HeroImage').where({ id: ok.banner.image.id }).first()).status, 'retired');
  const preview = await h.svc.imagePreview({ scope, id: c.banner.id, width: '240' });
  assert.equal((await sharp(preview.file.buffer).metadata()).width, 240);
  assert.equal((await h.svc.imagePreview({ scope: { origin: 'vendor', vendorId: 'someone_else' }, id: c.banner.id })).error, 'banner_not_found');
});

test('approve: needs the uploader\'s confirmations and the reviewer\'s people check (image_people_unconfirmed)', async () => {
  const h = harness();
  const approver = await user('admin');
  const { id } = await pendingVendorBanner(h);
  const noPeople = await h.svc.approve({ id, actorId: approver, checks: ['text', 'languages'] });
  assert.deepEqual([noPeople.error, noPeople.status], ['image_people_unconfirmed', 422]);
  const missing = await h.svc.approve({ id, actorId: approver, checks: ['people'] });
  assert.deepEqual([missing.error, missing.missing], ['review_checks_required', ['text', 'languages']]);
  // A photo whose people value is not a banner one (an older or edited row) is refused even with every check.
  const { imageId } = await db('ShopBanner').where({ id }).first();
  await db('HeroImage').where({ id: imageId }).update({ people: 'unclear_faces' });
  const unconfirmed = await h.svc.approve({ id, actorId: approver, checks: ALL_CHECKS });
  assert.equal(unconfirmed.error, 'image_people_unconfirmed');
  await db('HeroImage').where({ id: imageId }).update({ people: 'none' });
  assert.equal((await h.svc.approve({ id, actorId: approver, checks: ALL_CHECKS, position: -1 })).error, 'invalid_position');
  assert.equal((await h.svc.approve({ id, actorId: approver, checks: ALL_CHECKS })).saved.status, 'approved');
  assert.equal((await db('ShopBanner').where({ id }).first()).status, 'approved');
});

test('photo library: banner photos never appear among app photos and cannot be put in a slot', async () => {
  const h = harness();
  const { id } = await pendingVendorBanner(h);
  const { imageId } = await db('ShopBanner').where({ id }).first();
  const state = await heroImageService.adminState();
  assert.ok(!state.images.some(i => i.id === imageId));
  const slot = await heroImageService.setSlot('shop', { imageIds: [imageId] }, 'adm_brand');
  assert.deepEqual([slot.error, slot.imageIds], ['image_not_found', [imageId]]);
  // And the database refuses models on an app photo.
  await assert.rejects(db('HeroImage').insert({
    id: uid('hero'), privateKey: 'k', sha256: 's', width: 1, height: 1, source: 's', photographer: 'p', licence: 'l', people: 'product_models',
    rightsConfirmedBy: 'a', rightsConfirmedAt: new Date(), noFacesConfirmedBy: 'a', noFacesConfirmedAt: new Date(), createdBy: 'a',
  }), /heroimage_models_banner_only_chk/);
});

// ── Expiry ──────────────────────────────────────────────────────────────────

test('expiry: an undecided proposal expires after 14 days or at its start, whichever is first; the vendor is told', async () => {
  await cleanBanners();
  assert.equal(bannerConfigFromEnv({}).proposalExpiryDays, 14);
  assert.equal(bannerConfigFromEnv({ SHOP_PROPOSAL_EXPIRY_DAYS: '3' }).proposalExpiryDays, 3);
  assert.equal(bannerConfigFromEnv({ SHOP_PROPOSAL_EXPIRY_DAYS: 'x' }).proposalExpiryDays, 14);
  const t = new Date('2026-10-20T08:00:00Z');
  assert.equal(proposalExpiry(t, '2026-12-01T00:00:00Z').toISOString(), '2026-11-03T08:00:00.000Z');
  assert.equal(proposalExpiry(t, '2026-10-22T00:00:00Z').toISOString(), '2026-10-22T00:00:00.000Z');

  const h = harness();
  const approver = await user('admin');
  // Starts in 20 days: expires at sent + 14 days.
  const late = await pendingVendorBanner(h, { body: windowFrom(h.now(), 20 * DAY) });
  const lateRow = await db('ShopBanner').where({ id: late.id }).first();
  assert.equal(lateRow.expiresAt.getTime(), lateRow.submittedAt.getTime() + 14 * DAY);
  // Starts in 3 days: expires at the start.
  const soon = await pendingVendorBanner(h, { body: windowFrom(h.now(), 3 * DAY) });
  const soonRow = await db('ShopBanner').where({ id: soon.id }).first();
  assert.equal(soonRow.expiresAt.getTime(), soonRow.startsAt.getTime());

  h.tick(3 * DAY + HOUR);
  assert.equal((await h.svc.vendorGet({ vendorId: soon.vendor, id: soon.id })).banner.effectiveStatus, 'expired', 'read as expired before any job runs');
  const tooLate = await h.svc.approve({ id: soon.id, actorId: approver, checks: ALL_CHECKS });
  assert.deepEqual([tooLate.error, tooLate.status], ['proposal_expired', 409]);
  assert.equal((await h.svc.vendorGet({ vendorId: late.vendor, id: late.id })).banner.effectiveStatus, 'pending_approval');

  const r1 = await h.svc.runLifecycle();
  assert.equal(r1.expired, 1);
  const soonAfter = await db('ShopBanner').where({ id: soon.id }).first();
  assert.deepEqual([soonAfter.status, soonAfter.statusReason], ['expired', 'start_passed']);
  assert.deepEqual(h.notices.filter(n => n.type === 'shop_banner_expired').map(n => n.data.bannerId), [soon.id]);

  h.tick(11 * DAY);
  const r2 = await h.svc.runLifecycle();
  assert.equal(r2.expired, 1);
  const lateAfter = await db('ShopBanner').where({ id: late.id }).first();
  assert.deepEqual([lateAfter.status, lateAfter.statusReason], ['expired', 'not_reviewed_in_time']);
  assert.equal((await h.svc.runLifecycle()).expired, 0, 'idempotent');
  assert.equal((await h.svc.withdraw({ scope: late.scope, id: late.id, actorId: late.vendor })).error, 'invalid_transition');
});

test('lifecycle: approved banners past their end are written down as ended (window_passed)', async () => {
  const h = harness();
  const approver = await user('admin');
  const b = await pendingVendorBanner(h, { body: windowFrom(h.now(), 2 * HOUR, DAY) });
  await h.svc.approve({ id: b.id, actorId: approver, checks: ALL_CHECKS });
  h.tick(2 * DAY);
  assert.equal((await h.svc.vendorGet({ vendorId: b.vendor, id: b.id })).banner.effectiveStatus, 'ended');
  const r = await h.svc.runLifecycle();
  assert.ok(r.ended >= 1);
  const row = await db('ShopBanner').where({ id: b.id }).first();
  assert.deepEqual([row.status, row.statusReason], ['ended', 'window_passed']);
});

// ── The shop home feed ──────────────────────────────────────────────────────

async function liveBanner(h, opts = {}) {
  const approver = await user('admin');
  const b = await pendingVendorBanner(h, opts);
  const ok = await h.svc.approve({ id: b.id, actorId: approver, checks: ALL_CHECKS, position: opts.position });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  return b;
}
const productsOf = async ids => db('Product').whereIn('id', ids);

test('feed: the live banner shape; suspended or not-operational vendors drop at once; out of stock drops', async () => {
  await cleanBanners();
  const h = harness();
  const b = await liveBanner(h);
  const products = await productsOf([b.productId]);
  assert.deepEqual(await h.svc.feed({ mode: 'member', products, at: h.now() }), [], 'not live before its start');
  h.tick(3 * HOUR);
  const [banner] = await h.svc.feed({ mode: 'member', products, at: h.now() });
  assert.deepEqual(Object.keys(banner), ['id', 'image', 'imageAlt', 'headlineLead', 'headlineAccent', 'subline', 'ctaLabel', 'target', 'origin', 'vendorName', 'endsAt']);
  assert.deepEqual(Object.keys(banner.image), ['url1x', 'url2x', 'urlWide', 'focal']);
  assert.ok(banner.image.url1x.startsWith('/storage/'));
  assert.deepEqual(banner.target, { type: 'product', value: b.productId });
  assert.equal(banner.origin, 'vendor');
  assert.equal(banner.vendorName, 'Dar Gear');
  assert.equal(JSON.stringify(banner).includes('Sponsored'), false, 'no paid-placement label');

  await db('User').where({ id: b.vendor }).update({ accountStatus: 'suspended' });
  assert.deepEqual(await h.svc.feed({ mode: 'member', products, at: h.now() }), [], 'suspended vendor: gone on the next request');
  await db('User').where({ id: b.vendor }).update({ accountStatus: 'active' });
  h.gate.unverified.add(b.vendor);
  assert.deepEqual(await h.svc.feed({ mode: 'member', products, at: h.now() }), [], 'not operational (KYC gate): gone');
  h.gate.unverified.clear();
  h.gate.blocked.add(b.vendor);
  assert.deepEqual(await h.svc.feed({ mode: 'member', products, at: h.now() }), [], 'suspended in moderation: gone');
  h.gate.blocked.clear();
  assert.equal((await h.svc.feed({ mode: 'member', products: products.map(p => ({ ...p, stock: 0 })), at: h.now() })).length, 0, 'out of stock: gone');
  assert.equal((await h.svc.feed({ mode: 'member', products: [], at: h.now() })).length, 0, 'product no longer listed: gone');
  assert.equal((await h.svc.feed({ mode: 'member', products, ownVendorIds: [b.vendor], at: h.now() })).length, 0, 'never my own');
  assert.equal((await h.svc.feed({ mode: 'member', products, at: h.now() })).length, 1);
});

test('suspended vendor: cannot propose, and a pending banner cannot be approved', async () => {
  const h = harness();
  const approver = await user('admin');
  const b = await pendingVendorBanner(h);
  await db('User').where({ id: b.vendor }).update({ accountStatus: 'suspended' });
  const create = await h.svc.create({ scope: b.scope, actorId: b.vendor, body: { ...TEXT } });
  assert.deepEqual([create.error, create.status], ['vendor_suspended', 403]);
  assert.equal((await h.svc.update({ scope: b.scope, id: b.id, actorId: b.vendor, body: { subline: null } })).error, 'vendor_suspended');
  const a = await h.svc.approve({ id: b.id, actorId: approver, checks: ALL_CHECKS });
  assert.deepEqual([a.error, a.status], ['vendor_suspended', 409]);
  const list = await h.svc.vendorList({ vendorId: b.vendor });
  assert.deepEqual(list.vendor, { canPropose: false, reason: 'vendor_suspended' });
  assert.equal((await h.svc.withdraw({ scope: b.scope, id: b.id, actorId: b.vendor })).saved.status, 'withdrawn', 'stopping is always allowed');
  await db('User').where({ id: b.vendor }).update({ accountStatus: 'active' });
  const pendingVendor = await vendorUser('Pending Vendor', { approvalStatus: 'pending' });
  const p = await h.svc.create({ scope: { origin: 'vendor', vendorId: pendingVendor }, actorId: pendingVendor, body: {} });
  assert.deepEqual([p.error, p.status], ['vendor_not_approved', 403]);
});

test('feed: audience roles decide who sees a banner; vendor_personal sees none', async () => {
  await cleanBanners();
  const h = harness();
  const b = await liveBanner(h, { body: { audienceRoles: ['owner', 'trainer'] } });
  h.tick(3 * HOUR);
  const products = await productsOf([b.productId]);
  assert.equal((await h.svc.feed({ mode: 'member', products, at: h.now() })).length, 0);
  assert.equal((await h.svc.feed({ mode: 'owner', products, at: h.now() })).length, 1);
  assert.equal((await h.svc.feed({ mode: 'trainer', products, at: h.now() })).length, 1);
  assert.equal((await h.svc.feed({ mode: 'vendor_personal', products, at: h.now() })).length, 0);
  const bad = parseBannerInput({ audienceRoles: ['vendor'] }, { origin: 'vendor', vendorId: 'v' });
  assert.equal(bad.error, 'invalid_audience');
  assert.equal(parseBannerInput({ audienceRoles: [] }, { origin: 'vendor', vendorId: 'v' }).error, 'audience_required');
});

test('feed: ordered by position, then staff before vendor, then start; SHOP_BANNER_MAX_LIVE is a display limit (0 = all)', async () => {
  await cleanBanners();
  const h = harness();
  const v1 = await liveBanner(h, { position: 5 });
  const v2 = await liveBanner(h, { body: windowFrom(h.now(), 90 * 60_000) });
  // A staff banner with no position, linking to a category.
  const x = await user('admin'); const y = await user('admin');
  const s = await h.svc.create({ scope: { origin: 'staff' }, actorId: x, body: { ...TEXT, target: { type: 'category', value: 'equipment' }, ...windowFrom(h.now()) } });
  await h.svc.uploadImage({ scope: { origin: 'staff' }, id: s.banner.id, file: { buffer: PHOTO }, fields: GOOD_FIELDS, actorId: x });
  await h.svc.submit({ scope: { origin: 'staff' }, id: s.banner.id, actorId: x });
  await h.svc.approve({ id: s.banner.id, actorId: y, checks: ALL_CHECKS });
  h.tick(3 * HOUR);
  const products = await productsOf([v1.productId, v2.productId]);
  const feed = await h.svc.feed({ mode: 'member', products, at: h.now() });
  assert.deepEqual(feed.map(f => f.id), [v1.id, s.banner.id, v2.id]);
  const staff = feed.find(f => f.origin === 'staff');
  assert.equal('vendorName' in staff, false, 'staff banners have no "From" name');
  assert.deepEqual(staff.ctaLabel, DEFAULT_CTA.category);
  process.env.SHOP_BANNER_MAX_LIVE = '2';
  assert.equal((await h.svc.feed({ mode: 'member', products, at: h.now() })).length, 2);
  process.env.SHOP_BANNER_MAX_LIVE = '0';
  assert.equal((await h.svc.feed({ mode: 'member', products, at: h.now() })).length, 3);
  // No per-audience cap (owner 2026-10-20): a sixth and seventh live banner are approved and shown.
  for (let i = 0; i < 4; i += 1) {
    const extra = await liveBanner(h, { body: windowFrom(h.now()) });
    products.push(...await productsOf([extra.productId]));
  }
  h.tick(3 * HOUR);
  assert.equal((await h.svc.feed({ mode: 'member', products, at: h.now() })).length, 7);
  // Reordering an approved banner does not send it back for approval.
  const moved = await h.svc.setPosition({ id: v2.id, actorId: y, position: 0 });
  assert.equal(moved.saved.status, 'approved');
  assert.equal((await h.svc.feed({ mode: 'member', products, at: h.now() }))[0].id, v2.id);
});

test('admin list: tabs, counts, oldest-expiring requests first, a vendor draft never listed', async () => {
  await cleanBanners();
  const h = harness();
  const a = await pendingVendorBanner(h, { body: windowFrom(h.now(), 10 * DAY) });
  const b = await pendingVendorBanner(h, { body: windowFrom(h.now(), 2 * DAY) });
  const vendor = await vendorUser('Draft Only');
  await h.svc.create({ scope: { origin: 'vendor', vendorId: vendor }, actorId: vendor, body: { ...TEXT } });
  const list = await h.svc.adminList({ query: { tab: 'requests' }, viewer: { actorId: 'adm_viewer', canApprove: true } });
  assert.deepEqual(list.items.map(i => i.id), [b.id, a.id]);
  assert.equal(list.counts.requests, 2);
  assert.equal(list.counts.drafts, 0, 'vendor drafts are private');
  assert.equal((await h.svc.adminList({ query: { kind: 'flash_sale' }, viewer: {} })).error, 'invalid_kind');
  assert.equal((await h.svc.adminList({ query: { q: 'dar gear' }, viewer: {} })).total, 2);
});

// ── Notifications (English + Swahili) ───────────────────────────────────────

test('vendor notices: approved, rejected, expired and ended by FitFlex, in the vendor\'s language with Swahili always in data', async () => {
  const sent = [];
  const notifier = createPartnerNotifier({
    users: { findByIdAsync: async () => null }, gyms: { filterAsync: async () => [] },
    preferences: { findByIdAsync: async id => (id === 'v_en' ? { locale: 'en' } : null) },
    notify: async (userId, m) => { sent.push({ userId, ...m }); },
  });
  const d = { bannerId: 'sbn_1', headline: 'Train with new gear', headlineSw: 'Mazoezi na vifaa vipya', startsAt: '2026-10-21T07:00:00Z', reason: 'Blurry photo' };
  for (const kind of ['approved', 'rejected', 'expired', 'ended']) await notifier.vendorEvent('v_en', `shop_banner_${kind}`, d);
  await notifier.vendorEvent('v_sw', 'shop_banner_approved', d);
  assert.deepEqual(sent.map(s => s.type), ['vendor_shop_banner_approved', 'vendor_shop_banner_rejected', 'vendor_shop_banner_expired', 'vendor_shop_banner_ended', 'vendor_shop_banner_approved']);
  assert.equal(sent[0].body, 'Your banner "Train with new gear" is approved. It goes live 21/10/2026 10:00.');
  assert.equal(sent[4].body, 'Bango lako "Mazoezi na vifaa vipya" limeidhinishwa. Litaanza 21/10/2026 10:00.');
  // Glossary 2026-10-20: rejected = limekataliwa; End = sitisha (simamisha is reserved for Suspended).
  assert.deepEqual([sent[1].data.titleSw, sent[1].data.bodySw], ['Bango limekataliwa', 'Bango lako "Mazoezi na vifaa vipya" limekataliwa. Tazama sababu.']);
  assert.deepEqual([sent[3].data.titleSw, sent[3].data.bodySw], ['Bango limesitishwa na FitFlex', 'FitFlex imesitisha bango lako "Mazoezi na vifaa vipya".']);
  assert.ok(!JSON.stringify(sent).includes('simamish'));
  for (const s of sent) {
    assert.ok(s.data.titleSw && s.data.bodySw, 'Swahili always in data');
    assert.deepEqual([s.data.open, s.data.item], ['merch', 'sbn_1']);
  }
});

// ── Routes, flag and the shop home ──────────────────────────────────────────

test('flag off: every banner route answers 404 feature_disabled before sign-in; tools options say merch.banners false', async () => {
  delete process.env.SHOP_BANNERS;
  for (const [m, u] of [['get', '/vendor/shop-banners'], ['post', '/vendor/shop-banners'], ['patch', '/vendor/shop-banners/x'], ['post', '/vendor/shop-banners/x/submit'],
    ['post', '/vendor/shop-banners/x/image'], ['get', '/admin/shop-merch'], ['post', '/admin/shop-banners'], ['post', '/admin/shop-banners/x/approve'],
    ['post', '/admin/shop-banners/x/reject'], ['post', '/admin/shop-banners/x/end']]) {
    const r = await hit(m.toUpperCase(), u, { body: m === 'get' ? undefined : {} });
    assert.equal(r.status, 404, `${m} ${u}`);
    assert.deepEqual(r.body, { error: 'feature_disabled' });
  }
  const vendor = await vendorUser('Options');
  const off = await hit('GET', '/vendor/tools/options', { claims: { sub: vendor, userType: 'vendor' } });
  assert.deepEqual(off.body.merch, { banners: false, productTargets: false });
  process.env.SHOP_BANNERS = '1';
  const on = await hit('GET', '/vendor/tools/options', { claims: { sub: vendor, userType: 'vendor' } });
  assert.deepEqual(on.body.merch, { banners: true, productTargets: false });
  delete process.env.SHOP_BANNERS;
});

test('flag off: GET /shop/home is byte-identical to the Phase 1 answer, even with a live banner in the database', async () => {
  // Same data, same clock: the Phase 1 service (no banner feed) and the new one with the flag off.
  const at = new Date('2026-10-20T08:00:00Z');
  const deps = () => ({
    shopService: { listProducts: async () => [{ id: 'prd_1', vendorId: 'v1', name: 'Rope', category: 'equipment', priceTzs: 5000, stock: 3, createdAt: '2026-10-01T00:00:00Z' }] },
    discoveryService: { discover: async () => ({ featured: [] }) },
    promotionService: { listLive: async () => [] },
    users: { findByIdAsync: async id => ({ id, userType: 'member' }), filterByColumnInAsync: async () => [] },
    trainerService: null, identityLink: null, recentPaidOrders: async () => [],
    config: () => shopHomeConfigFromEnv({ SHOP_HOME_MIN_ITEMS: '1' }), now: () => at,
  });
  const phase1 = createShopHomeService(deps());
  let feedCalls = 0;
  const withBanners = createShopHomeService({ ...deps(), bannerFeed: async () => { feedCalls += 1; return [{ id: 'sbn_x' }]; }, bannersOn: () => false });
  const claims = { sub: 'usr_m', userType: 'member' };
  const a = JSON.stringify((await phase1.home({ claims })).body);
  const b = JSON.stringify((await withBanners.home({ claims })).body);
  assert.equal(b, a, 'byte-identical');
  assert.equal(feedCalls, 0, 'the banner store is not even read');
  const on = createShopHomeService({ ...deps(), bannerFeed: async () => [{ id: 'sbn_x' }], bannersOn: () => true });
  assert.deepEqual((await on.home({ claims })).body.banners, [{ id: 'sbn_x' }]);
  const broken = createShopHomeService({ ...deps(), bannerFeed: async () => { throw new Error('db down'); }, bannersOn: () => true, logger: { error() {} } });
  const out = await broken.home({ claims });
  assert.deepEqual(out.body.banners, [], 'a failed banner read never fails the page');
  assert.equal(JSON.stringify({ ...out.body, banners: undefined }), a);

  // And through the real route with a live banner stored: no `banners` key while the flag is off.
  await cleanBanners();
  // Stored directly as approved and live (a start in the past cannot be sent through the API).
  const v = await vendorUser('Live Direct');
  const p = await product(v);
  const img = uid('hero');
  await db('HeroImage').insert({ id: img, purpose: 'shop_banner', vendorId: v, privateKey: 'k', sha256: 's', width: 1600, height: 1000, source: 'vendor_upload', photographer: 'uploader', licence: 'uploader_confirmed_rights', people: 'none', rightsConfirmedBy: v, rightsConfirmedAt: new Date(), noFacesConfirmedBy: v, noFacesConfirmedAt: new Date(), createdBy: v, status: 'published', variants: JSON.stringify({ url1x: '/storage/c/1x.webp', url2x: '/storage/c/2x.webp', urlWide: '/storage/c/w.webp' }) });
  await db('ShopBanner').insert({ id: uid('sbn'), origin: 'vendor', vendorId: v, imageId: img, ...Object.fromEntries(Object.entries(TEXT).map(([k, val]) => [k, JSON.stringify(val)])), target: JSON.stringify({ type: 'product', value: p }), audienceRoles: JSON.stringify(['member']), startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + DAY), status: 'approved', createdBy: v, approvedBy: 'adm_direct' });
  process.env.SHOP_HOME_V2 = '1'; process.env.SHOP_HOME_MIN_ITEMS = '1'; process.env.SHOP_HOME_CACHE_SECONDS = '1';
  shopHomeService.clearCache(); resetShopHomeLimits();
  const member = await user('member');
  delete process.env.SHOP_BANNERS;
  const offRes = await hit('GET', '/shop/home', { claims: { sub: member, userType: 'member' } });
  assert.equal(offRes.status, 200);
  assert.deepEqual(Object.keys(offRes.body), ['serverNow', 'currency', 'mode', 'personalised', 'signalsUsed', 'categories', 'allProductsCount', 'sections', 'products']);
  process.env.SHOP_BANNERS = '1';
  const onRes = await hit('GET', '/shop/home', { claims: { sub: member, userType: 'member' } });
  assert.equal(onRes.body.banners.length, 1);
  assert.deepEqual(Object.keys(onRes.body.banners[0].image), ['url1x', 'url2x', 'urlWide', 'focal']);
  delete process.env.SHOP_BANNERS;
  for (const k of ['SHOP_HOME_V2', 'SHOP_HOME_MIN_ITEMS', 'SHOP_HOME_CACHE_SECONDS']) delete process.env[k];
});

test('routes: vendor and staff permissions, admin scopes, the whole flow over HTTP with a real upload', async () => {
  await cleanBanners();
  process.env.SHOP_BANNERS = '1';
  try {
    const vendor = await vendorUser('Route Vendor');
    const p = await product(vendor);
    const staffOk = await user('vendor_staff', { vendorId: vendor, vendorPermissions: ['products'] });
    const staffNo = await user('vendor_staff', { vendorId: vendor, vendorPermissions: ['orders'] });
    const asVendor = { sub: vendor, userType: 'vendor' };
    const asStaff = { sub: staffOk, userType: 'vendor_staff', vendorId: vendor };
    const runner = await user('admin'); const approver = await user('admin');
    const asRunner = { sub: runner, userType: 'admin', portalUser: true, aclPermissions: ['promotions'] };
    const asApprover = { sub: approver, userType: 'admin', portalUser: true, aclPermissions: ['promotions_approve'] };
    const asOther = { sub: 'adm_other', userType: 'admin', portalUser: true, aclPermissions: ['gyms'] };

    assert.equal((await hit('GET', '/vendor/shop-banners')).status, 401);
    const noPerm = await hit('GET', '/vendor/shop-banners', { claims: { sub: staffNo, userType: 'vendor_staff', vendorId: vendor } });
    assert.deepEqual([noPerm.status, noPerm.body.error], [403, 'vendor_permission_forbidden']);
    assert.equal((await hit('GET', '/vendor/shop-banners', { claims: { sub: 'usr_m', userType: 'member' } })).status, 403);

    const now = new Date();
    const created = await hit('POST', '/vendor/shop-banners', { claims: asStaff, body: { ...TEXT, target: { type: 'product', value: p }, ...windowFrom(now) } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.banner.id;
    const priceRes = await hit('PATCH', `/vendor/shop-banners/${id}`, { claims: asVendor, body: { subline: { en: 'Now 10% off', sw: 'Sasa' } } });
    assert.deepEqual([priceRes.status, priceRes.body], [422, { error: 'price_claim_in_text', field: 'subline.en' }]);
    const missing = await hit('PATCH', `/vendor/shop-banners/${id}`, { claims: asVendor, body: { subline: { en: 'Fresh stock' } } });
    assert.deepEqual([missing.status, missing.body.error, missing.body.field], [422, 'missing_translation', 'subline.sw']);

    const up = await uploadReq(`/vendor/shop-banners/${id}/image`, PHOTO, GOOD_FIELDS, asStaff);
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const pv = await hit('GET', `/vendor/shop-banners/${id}/image?w=240`, { claims: asVendor });
    assert.deepEqual([pv.status, pv.headers.get('content-type'), pv.headers.get('cache-control')], [200, 'image/webp', 'no-store, private']);
    const sub = await hit('POST', `/vendor/shop-banners/${id}/submit`, { claims: asStaff });
    assert.equal(sub.body.banner.status, 'pending_approval');

    assert.equal((await hit('GET', '/admin/shop-merch?tab=requests', { claims: asOther })).status, 403);
    const queue = await hit('GET', '/admin/shop-merch?tab=requests', { claims: asRunner });
    assert.deepEqual(queue.body.items.map(i => i.id), [id]);
    assert.ok(!queue.body.items[0].allowedActions.includes('approve'), 'promotions alone cannot approve');
    const reviewed = { revision: sub.body.banner.revision, imageId: sub.body.banner.image.id };
    const runnerTry = await hit('POST', `/admin/shop-banners/${id}/approve`, { claims: asRunner, body: { checks: ALL_CHECKS, ...reviewed } });
    assert.deepEqual([runnerTry.status, runnerTry.body.error], [403, 'acl_forbidden']);
    const adminPv = await hit('GET', `/admin/shop-banners/${id}/image`, { claims: asApprover });
    assert.equal(adminPv.status, 200);
    const noRev = await hit('POST', `/admin/shop-banners/${id}/approve`, { claims: asApprover, body: { checks: ALL_CHECKS } });
    assert.deepEqual([noRev.status, noRev.body.error, noRev.body.fields], [400, 'revision_required', ['revision', 'imageId']]);
    const appr = await hit('POST', `/admin/shop-banners/${id}/approve`, { claims: asApprover, body: { checks: ALL_CHECKS, position: 1, ...reviewed } });
    assert.equal(appr.status, 200, JSON.stringify(appr.body));
    assert.equal(appr.body.banner.status, 'approved');
    assert.ok(appr.body.banner.image.public.url2x.startsWith('/storage/bafyzebra'));
    const inbox = await db('MarketplaceNotification').where({ userId: vendor, type: 'shop_banner_approved' });
    assert.equal(inbox.length, 1, 'the vendor\'s shop inbox got the notice');

    // Staff banner over HTTP: the runner creates and sends; the runner cannot approve it even with both scopes.
    const both = { sub: runner, userType: 'admin', portalUser: true, aclPermissions: ['promotions', 'promotions_approve'] };
    const sb = await hit('POST', '/admin/shop-banners', { claims: asRunner, body: { ...TEXT, target: { type: 'results', value: { category: 'equipment', sort: 'popularity' } }, ...windowFrom(now) } });
    assert.equal(sb.status, 201, JSON.stringify(sb.body));
    await uploadReq(`/admin/shop-banners/${sb.body.banner.id}/image`, PHOTO, GOOD_FIELDS, asRunner);
    assert.equal((await hit('POST', `/admin/shop-banners/${sb.body.banner.id}/submit`, { claims: asRunner })).body.banner.status, 'pending_approval');
    const sbNow = (await hit('GET', `/admin/shop-banners/${sb.body.banner.id}`, { claims: both })).body.banner;
    const self = await hit('POST', `/admin/shop-banners/${sb.body.banner.id}/approve`, { claims: both, body: { checks: ALL_CHECKS, revision: sbNow.revision, imageId: sbNow.image.id } });
    assert.deepEqual([self.status, self.body.error], [403, 'cannot_approve_own_submission']);
    const detail = await hit('GET', `/admin/shop-banners/${sb.body.banner.id}`, { claims: both });
    assert.equal(detail.body.banner.ownItem, true);
    const ended = await hit('POST', `/admin/shop-banners/${id}/end`, { claims: asApprover, body: { reason: 'Seller asked us to stop it.' } });
    assert.equal(ended.body.banner.status, 'ended');
    const vendorView = await hit('GET', `/vendor/shop-banners/${id}`, { claims: asVendor });
    assert.deepEqual([vendorView.body.banner.endedByFitflex, vendorView.body.banner.statusReasonNote], [true, 'Seller asked us to stop it.']);
    assert.equal(vendorView.body.banner.endedBy, undefined);
  } finally {
    delete process.env.SHOP_BANNERS;
  }
});

// ── Review round 1 (security, contract, i18n) ───────────────────────────────

test('H1 two-person rule: whoever edited the text or replaced the photo of a pending banner cannot approve, reject or reorder it', async () => {
  await cleanBanners();
  const h = harness();
  const x = await user('admin'); const y = await user('admin'); const z = await user('admin'); const w = await user('admin');
  await product(await vendorUser('Category seller'));
  const scope = { origin: 'staff' };
  const c = await h.svc.create({ scope, actorId: x, body: { ...TEXT, target: { type: 'category', value: 'equipment' }, ...windowFrom(h.now()) } });
  await h.svc.uploadImage({ scope, id: c.banner.id, file: { buffer: PHOTO }, fields: GOOD_FIELDS, actorId: x });
  await h.svc.submit({ scope, id: c.banner.id, actorId: x });
  // y changes the words of x's pending banner; z only swaps the photo.
  const edited = await h.svc.update({ scope, id: c.banner.id, actorId: y, body: { subline: { en: 'Gear for every gym', sw: 'Vifaa kwa kila gym' } } });
  assert.equal(edited.banner.status, 'pending_approval');
  await h.svc.uploadImage({ scope, id: c.banner.id, file: { buffer: PHOTO }, fields: GOOD_FIELDS, actorId: z });
  for (const who of [x, y, z]) {
    const a = await h.svc.approve({ id: c.banner.id, actorId: who, checks: ALL_CHECKS });
    assert.deepEqual([a.error, a.status], ['cannot_approve_own_submission', 403], `approve by ${who}`);
    const r = await h.svc.reject({ id: c.banner.id, actorId: who, code: 'text', note: 'Not this one.' });
    assert.equal(r.error, 'cannot_approve_own_submission', `reject by ${who}`);
    const view = (await h.svc.adminGet({ id: c.banner.id, viewer: { actorId: who, canApprove: true, canManage: true } })).banner;
    assert.equal(view.ownItem, true);
    assert.ok(!view.allowedActions.includes('approve') && !view.allowedActions.includes('reject'));
  }
  assert.deepEqual((await db('ShopBanner').where({ id: c.banner.id }).first()).editors, [x, y, z]);
  const viewW = (await h.svc.adminGet({ id: c.banner.id, viewer: { actorId: w, canApprove: true } })).banner;
  assert.deepEqual([viewW.editedBy, viewW.image.uploadedBy, viewW.ownItem], [[x, y, z], z, false]);
  assert.equal((await h.svc.approve({ id: c.banner.id, actorId: w, checks: ALL_CHECKS })).saved.status, 'approved');
  // L2: reordering is a decision too.
  const pz = await h.svc.setPosition({ id: c.banner.id, actorId: z, position: 1 });
  assert.deepEqual([pz.error, pz.status], ['cannot_approve_own_submission', 403]);
  assert.ok(!(await h.svc.adminGet({ id: c.banner.id, viewer: { actorId: z, canApprove: true } })).banner.allowedActions.includes('position'));
  assert.equal((await h.svc.setPosition({ id: c.banner.id, actorId: w, position: 1 })).saved.position, 1);
});

test('H2 a decision names the revision and photo reviewed: anything changed since → 409 banner_changed; missing → 400', async () => {
  const h = harness();
  const approver = await user('admin');
  const b = await pendingVendorBanner(h);
  const seen = await h.fresh(b.id);
  await h.svc.update({ scope: b.scope, id: b.id, actorId: b.vendor, body: { subline: { en: 'Changed after review', sw: 'Imebadilika baada ya ukaguzi' } } });
  const stale = await h.raw.approve({ id: b.id, actorId: approver, checks: ALL_CHECKS, ...seen });
  assert.deepEqual([stale.error, stale.status, stale.revision, stale.imageId], ['banner_changed', 409, seen.revision + 1, seen.imageId]);
  const staleReject = await h.raw.reject({ id: b.id, actorId: approver, code: 'image', note: 'Blurry photo.', ...seen });
  assert.equal(staleReject.error, 'banner_changed');
  // A new photo is a new revision too; and the photo id must match on its own as well.
  await h.svc.uploadImage({ scope: b.scope, id: b.id, file: { buffer: PHOTO }, fields: GOOD_FIELDS, actorId: b.vendor });
  const now2 = await h.fresh(b.id);
  assert.equal(now2.revision, seen.revision + 2);
  assert.equal((await h.raw.approve({ id: b.id, actorId: approver, checks: ALL_CHECKS, revision: now2.revision, imageId: seen.imageId })).error, 'banner_changed');
  const missing = await h.raw.approve({ id: b.id, actorId: approver, checks: ALL_CHECKS });
  assert.deepEqual([missing.error, missing.status, missing.fields], ['revision_required', 400, ['revision', 'imageId']]);
  assert.equal(h.stores.pub.size, 0, 'no public files for refused decisions');
  assert.equal((await db('ShopBanner').where({ id: b.id }).first()).status, 'pending_approval');
  assert.equal((await h.raw.approve({ id: b.id, actorId: approver, checks: ALL_CHECKS, ...now2 })).saved.status, 'approved');
});

test('M3 public files are made outside the banner lock; a change while they upload refuses the approval and records the files', async () => {
  const h = harness();
  const approver = await user('admin');
  const b = await pendingVendorBanner(h);
  const realPut = h.stores.publicStore.put.bind(h.stores.publicStore);
  let release; const gate = new Promise((r) => { release = r; });
  let started; const startedP = new Promise((r) => { started = r; });
  h.stores.publicStore.put = async (...a) => { started(); await gate; return realPut(...a); };
  const approving = h.svc.approve({ id: b.id, actorId: approver, checks: ALL_CHECKS });
  await startedP;
  // Under the lock this would wait for the upload; outside it, it goes straight through.
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('banner write blocked by a publish')), 4000));
  const edit = await Promise.race([
    h.svc.update({ scope: b.scope, id: b.id, actorId: b.vendor, body: { subline: { en: 'Edited during upload', sw: 'Imehaririwa wakati wa kupakia' } } }),
    timeout,
  ]);
  assert.equal(edit.banner.revision, 3, 'created 1, photo 2, edit 3');
  release();
  const out = await approving;
  assert.deepEqual([out.error, out.status], ['banner_changed', 409]);
  const row = await db('ShopBanner').where({ id: b.id }).first();
  assert.equal(row.status, 'pending_approval');
  assert.equal((await db('HeroImage').where({ id: row.imageId }).first()).variants, null, 'nothing points at the files');
  const orphan = await db('AuditLog').where({ target: b.id, action: 'shop_banner.public_files_orphaned' }).first();
  assert.equal(orphan.after.urls.length, 4);
  assert.equal(orphan.after.reason, 'banner_changed');
  h.stores.publicStore.put = realPut;
  assert.equal((await h.svc.approve({ id: b.id, actorId: approver, checks: ALL_CHECKS })).saved.status, 'approved');
});

test('M1 a public upload that fails part-way leaves the banner pending and records the files already made', async () => {
  const h = harness();
  const approver = await user('admin');
  const b = await pendingVendorBanner(h);
  const realPut = h.stores.publicStore.put.bind(h.stores.publicStore);
  let n = 0;
  h.stores.publicStore.put = async (...a) => { n += 1; if (n === 3) throw new Error('zebra down'); return realPut(...a); };
  const out = await h.svc.approve({ id: b.id, actorId: approver, checks: ALL_CHECKS });
  assert.deepEqual([out.error, out.status], ['storage_service_unavailable', 503]);
  assert.equal((await db('ShopBanner').where({ id: b.id }).first()).status, 'pending_approval');
  const orphan = await db('AuditLog').where({ target: b.id, action: 'shop_banner.public_files_orphaned' }).first();
  assert.equal(orphan.after.urls.length, 2);
  assert.match(orphan.after.reason, /^upload_failed/);
});

test('M2 open proposals are capped per vendor (SHOP_BANNER_MAX_OPEN); a refused photo upload is audited, never a silent orphan', async () => {
  assert.equal(bannerConfigFromEnv({}).maxOpenProposals, 10);
  const h = harness();
  const approver = await user('admin');
  const b = await pendingVendorBanner(h);
  await h.svc.reject({ id: b.id, actorId: approver, code: 'image', note: 'Try a sharper photo.' });
  process.env.SHOP_BANNER_MAX_OPEN = '2';
  await h.svc.create({ scope: b.scope, actorId: b.vendor, body: {} });
  await h.svc.create({ scope: b.scope, actorId: b.vendor, body: {} });
  const third = await h.svc.create({ scope: b.scope, actorId: b.vendor, body: {} });
  assert.deepEqual([third.error, third.status, third.max, third.open], ['too_many_open_proposals', 409, 2, 2]);
  // A new photo would turn the rejected banner back into a draft: refused after the private file was stored.
  const before = await db('HeroImage').where({ purpose: 'shop_banner', vendorId: b.vendor }).count({ n: '*' });
  const up = await h.svc.uploadImage({ scope: b.scope, id: b.id, file: { buffer: PHOTO }, fields: GOOD_FIELDS, actorId: b.vendor });
  assert.equal(up.error, 'too_many_open_proposals');
  const after = await db('HeroImage').where({ purpose: 'shop_banner', vendorId: b.vendor }).count({ n: '*' });
  assert.equal(after[0].n, before[0].n, 'no row for the refused photo');
  const orphan = await db('AuditLog').where({ target: b.id, action: 'shop_banner.image_orphaned' }).first();
  assert.equal(orphan.after.reason, 'too_many_open_proposals');
  assert.ok(orphan.after.privateKeyHash && !JSON.stringify(orphan.after).includes('bafypriv'), 'the audit row never holds the storage key');
  assert.equal((await h.svc.update({ scope: b.scope, id: b.id, actorId: b.vendor, body: { subline: null } })).error, 'too_many_open_proposals');
  const list = await h.svc.vendorList({ vendorId: b.vendor });
  assert.deepEqual(list.openProposals, { open: 2, max: 2 });
  assert.equal(list.confirmation.version, BANNER_CONFIRMATION.version);
});

test('M2 vendor create, photo and send are rate limited per vendor (429 rate_limited)', async () => {
  process.env.SHOP_BANNERS = '1';
  process.env.SHOP_BANNER_MAX_OPEN = '1000';
  try {
    const vendor = await vendorUser('Busy Vendor');
    const other = await vendorUser('Quiet Vendor');
    const claims = { sub: vendor, userType: 'vendor' };
    for (let i = 0; i < BANNER_RATE_LIMITS.create; i += 1) assert.equal((await hit('POST', '/vendor/shop-banners', { claims, body: {} })).status, 201);
    const over = await hit('POST', '/vendor/shop-banners', { claims, body: {} });
    assert.deepEqual([over.status, over.body.error], [429, 'rate_limited']);
    assert.ok(over.body.retryAfterSeconds >= 1 && over.headers.get('retry-after'));
    assert.equal((await hit('POST', '/vendor/shop-banners', { claims: { sub: other, userType: 'vendor' }, body: {} })).status, 201, 'other vendors are not affected');
    const id = (await db('ShopBanner').where({ vendorId: other }).first()).id;
    for (let i = 0; i < BANNER_RATE_LIMITS.upload; i += 1) await uploadReq(`/vendor/shop-banners/${id}/image`, null, GOOD_FIELDS, { sub: other, userType: 'vendor' });
    const upOver = await uploadReq(`/vendor/shop-banners/${id}/image`, PHOTO, GOOD_FIELDS, { sub: other, userType: 'vendor' });
    assert.deepEqual([upOver.status, upOver.body.error], [429, 'rate_limited']);
  } finally {
    delete process.env.SHOP_BANNERS;
  }
});

test('L1 text rules: normalised before checking (NFKC, format characters removed); the review bypass list is refused', () => {
  assert.equal(normaliseText('Tr​ain‮ hard­'), 'Train hard');
  assert.equal(normaliseText('ＧＥＡＲ　２０'), 'GEAR 20');
  const prices = ['2​0% off', '20％ off', '٢٠٪', '‮20%', '5000/-', '5,000/=', 'Elfu kumi tu', 'Laki mbili', 'Milioni moja', 'Nusu bei', 'Bure kabisa', 'Punguzo kubwa',
    'Half price', 'Big discount', 'Since 2019', '١٢٣٤', 'TSh​ 500', 'KSh 500'];
  for (const t of prices) assert.equal(hasPriceClaim(t), true, JSON.stringify(t));
  const contacts = ['follow @darfit', 'shop dot com', 'shop dot co dot tz', 'gear.app', 'gear.co.ke', 'fit.io', 'best.me', 'w​ww.x.com', 'darfit.africa', '+254 712 345 678'];
  for (const t of contacts) assert.equal(hasContact(t), true, JSON.stringify(t));
  for (const t of ['Get fit. Me first', 'Co-op gear', 'Sugar-free whey', 'Buy 2, get 1']) assert.equal(hasPriceClaim(t) || hasContact(t), false, t);
  const parsed = parseBannerInput({ headlineLead: { en: 'Train​ hard', sw: 'Fanya‍ mazoezi' } }, { origin: 'vendor', vendorId: 'v' });
  assert.deepEqual(parsed.value.headlineLead, { en: 'Train hard', sw: 'Fanya mazoezi' }, 'stored cleaned');
  const sneaky = parseBannerInput({ subline: { en: 'Fresh stock', sw: 'Punguzo la ２０％' } }, { origin: 'vendor', vendorId: 'v' });
  assert.deepEqual([sneaky.error, sneaky.field], ['price_claim_in_text', 'subline.sw']);
});

test('CTA: vendors pick from the fixed list (ctaKey) and never write a label; staff may', async () => {
  const h = harness();
  const vendor = await vendorUser('CTA Vendor');
  const p = await product(vendor);
  const scope = { origin: 'vendor', vendorId: vendor };
  const label = await h.svc.create({ scope, actorId: vendor, body: { ctaLabel: { en: 'Grab it', sw: 'Chukua' } } });
  assert.deepEqual([label.error, label.status, label.field], ['cta_label_not_allowed', 422, 'ctaLabel']);
  assert.equal((await h.svc.create({ scope, actorId: vendor, body: { ctaKey: 'shop_now' } })).error, 'invalid_cta_key');
  const wrong = await h.svc.create({ scope, actorId: vendor, body: { ctaKey: 'visit_store', target: { type: 'product', value: p } } });
  assert.deepEqual([wrong.error, wrong.allowed], ['invalid_cta_key', ['view_product']]);
  const ok = await h.svc.create({ scope, actorId: vendor, body: { ctaKey: 'view_product', target: { type: 'product', value: p } } });
  assert.deepEqual([ok.banner.ctaKey, ok.banner.ctaLabel, ok.banner.ctaLabelCustom], ['view_product', DEFAULT_CTA.product, false]);
  const staff = await h.svc.create({ scope: { origin: 'staff' }, actorId: 'adm_cta', body: { ctaLabel: { en: 'Get moving', sw: 'Anza mazoezi' }, target: { type: 'results', value: {} } } });
  assert.deepEqual([staff.banner.ctaKey, staff.banner.ctaLabel.en, staff.banner.ctaLabelCustom], [null, 'Get moving', true]);
  const staffKey = await h.svc.create({ scope: { origin: 'staff' }, actorId: 'adm_cta', body: { ctaKey: 'shop_now', target: { type: 'results', value: {} } } });
  assert.deepEqual(staffKey.banner.ctaLabel, { en: 'Shop now', sw: 'Nunua sasa' });
});

// ── QA round 2 ──────────────────────────────────────────────────────────────

test('QA2 vendor eligibility fails closed: only approvalStatus "approved" may propose or stay live (pending_approval, pending, rejected, any other)', async () => {
  await cleanBanners();
  const h = harness(); // KYC gate open for everyone: the approval status alone must decide
  // (User.approvalStatus is NOT NULL in the database, so "missing" cannot be stored; the code treats it as not approved too.)
  for (const status of ['pending_approval', 'pending', 'rejected', 'under_review']) {
    const v = await vendorUser(`Status ${status}`, { approvalStatus: status });
    const c = await h.svc.create({ scope: { origin: 'vendor', vendorId: v }, actorId: v, body: {} });
    assert.deepEqual([c.error, c.status], ['vendor_not_approved', 403], String(status));
    assert.deepEqual((await h.svc.vendorList({ vendorId: v })).vendor, { canPropose: false, reason: 'vendor_not_approved' }, String(status));
  }
  // An approved vendor's banners: pending cannot be approved, and a live one drops, once the vendor is back to pending_approval.
  const approver = await user('admin');
  const live = await liveBanner(h);
  h.tick(3 * HOUR);
  const pending = await pendingVendorBanner(h);
  const products = await productsOf([live.productId]);
  assert.equal((await h.svc.feed({ mode: 'member', products, at: h.now() })).length, 1);
  await db('User').where({ id: live.vendor }).update({ approvalStatus: 'pending_approval' });
  assert.equal((await h.svc.feed({ mode: 'member', products, at: h.now() })).length, 0, 'live banner leaves the shop');
  await db('User').where({ id: pending.vendor }).update({ approvalStatus: 'pending_approval' });
  const a = await h.svc.approve({ id: pending.id, actorId: approver, checks: ALL_CHECKS });
  assert.deepEqual([a.error, a.status], ['vendor_not_approved', 409]);
  // A staff banner linking to such a vendor's store or product is not eligible either.
  const x = await user('admin');
  const s = await h.svc.create({ scope: { origin: 'staff' }, actorId: x, body: { ...TEXT, target: { type: 'vendor_store', value: pending.vendor }, ...windowFrom(h.now()) } });
  await h.svc.uploadImage({ scope: { origin: 'staff' }, id: s.banner.id, file: { buffer: PHOTO }, fields: GOOD_FIELDS, actorId: x });
  const sub = await h.svc.submit({ scope: { origin: 'staff' }, id: s.banner.id, actorId: x });
  assert.deepEqual([sub.error, sub.reason], ['target_not_eligible', 'vendor_not_approved']);
});

test('QA2 product rows carry vendorName (store name, else display name) on /shop/products, /shop/products/:id, /discover/products and /shop/home', async () => {
  process.env.SHOP_HOME_V2 = '1'; process.env.SHOP_HOME_MIN_ITEMS = '1'; process.env.SHOP_HOME_CACHE_SECONDS = '1';
  shopHomeService.clearCache(); resetShopHomeLimits();
  try {
    const named = await vendorUser('Dar Fitness Gear');
    const plain = await user('vendor', { approvalStatus: 'approved', displayName: 'Mama Neema Shop' });
    const p1 = await product(named, { name: 'QA2 rope' });
    const p2 = await product(plain, { name: 'QA2 mat' });
    const member = await user('member');
    const claims = { sub: member, userType: 'member' };
    const list = await hit('GET', `/shop/products?vendorId=${named}`, { claims });
    assert.deepEqual(list.body.map(r => [r.id, r.vendorName]), [[p1, 'Dar Fitness Gear']]);
    const other = await hit('GET', `/shop/products?vendorId=${plain}`, { claims });
    assert.equal(other.body[0].vendorName, 'Mama Neema Shop', 'falls back to the display name');
    const detail = await hit('GET', `/shop/products/${p1}`, { claims });
    assert.equal(detail.body.vendorName, 'Dar Fitness Gear');
    assert.ok(detail.body.similarProducts.every(r => 'vendorName' in r));
    const disc = await hit('GET', '/discover/products?q=QA2', { claims });
    const cards = [...disc.body.items, ...disc.body.featured];
    assert.deepEqual(new Map(cards.filter(c => [p1, p2].includes(c.id)).map(c => [c.id, c.vendorName])), new Map([[p1, 'Dar Fitness Gear'], [p2, 'Mama Neema Shop']]));
    const home = await hit('GET', '/shop/home', { claims });
    assert.equal(home.status, 200);
    const homeRows = Object.values(home.body.products);
    assert.ok(homeRows.length > 0 && homeRows.every(r => 'vendorName' in r), 'every home product row has the field');
    if (home.body.products[p1]) assert.equal(home.body.products[p1].vendorName, 'Dar Fitness Gear');
    // The vendor's own product list (vendor tools) is unchanged: no vendorName there.
    const own = await hit('GET', '/vendor/products', { claims: { sub: named, userType: 'vendor' } });
    assert.equal(own.status, 200);
    const ownRows = Array.isArray(own.body) ? own.body : (own.body.products || own.body.items || []);
    assert.ok(ownRows.length && ownRows.every(r => !('vendorName' in r)));
  } finally {
    for (const k of ['SHOP_HOME_V2', 'SHOP_HOME_MIN_ITEMS', 'SHOP_HOME_CACHE_SECONDS']) delete process.env[k];
  }
});
