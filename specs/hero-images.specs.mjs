// Admin-managed app photos (plan docs/plans/photo-hero-sections-footer-admin-plan.md, slice 4).
// - The slot registry mirrors the app's FFHeroPhoto names plus the section, footer and portal slots.
// - Uploads are checked from their bytes, rotated upright and stripped of EXIF/GPS, kept private.
// - Publish makes public variants within their byte budgets; drafts never reach the public list.
// - The public manifest: ETag/304, cache headers, 60 s memory cache, no licence/uploader/keys.
// - Rollback, retire, and an audit row with before/after on every write.
// - Flag off (HERO_IMAGES_CMS): admin routes 404 before sign-in; the manifest is empty.
// - Routes run as bfast mounts them (guards as path prefixes), against a local stand-in for Zebra
//   through the real storage client. Against the CI database.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import FormData from 'form-data';
import sharp from 'sharp';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { heroImageService } from '../src/bootstrap/services.mjs';
import { parseMultipartRequest } from '../src/infra/storage-client.mjs';
import { HERO_AREAS, HERO_SLOTS, heroSlot, textZoneFor } from '../src/shared/hero-slots.mjs';
import { HERO_LIMITS, HERO_VARIANT_BUDGETS, prepareHeroUpload, buildHeroVariants, measureTextZones, isBright } from '../src/infra/hero-image-file.mjs';
import { createHeroImageService, HERO_MANIFEST_CACHE_MS } from '../src/services/hero-image-service.mjs';
import { createPgHeroImageStore } from '../src/infra/hero-image-store-pg.mjs';
import { PORTAL_ACL_SCOPES } from '../src/services/portal-user-service.mjs';
import { etagMatches } from '../functions/hero-images.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

await ensureInit();

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A photo-like picture: smooth colour fields with a little grain (compresses like a real photo). */
// Test fixtures only: the server never keeps metadata (no withMetadata / keepExif in src/).
async function photo(width, height, { format = 'jpeg', exif = null, orientation = null, brightness = 1 } = {}) {
  const small = await sharp(randomBytes(32 * 24 * 3), { raw: { width: 32, height: 24, channels: 3 } })
    .resize(width, height, { kernel: 'cubic' }).blur(2).linear(brightness, 0).png().toBuffer();
  const grain = await sharp(randomBytes(64 * 64 * 3), { raw: { width: 64, height: 64, channels: 3 } }).blur(1.5).png().toBuffer();
  let img = sharp(small).composite([{ input: grain, tile: true, blend: 'soft-light' }]);
  if (exif || orientation) {
    img = sharp(await img.jpeg({ quality: 92 }).toBuffer());
    if (exif) img = img.withExif(exif);
    if (orientation) img = img.withMetadata({ orientation });
  }
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 92 }).toBuffer();
}
const solid = (width, height, background, format = 'jpeg') => sharp({ create: { width, height, channels: 3, background } })[format]().toBuffer();
const GPS_EXIF = {
  IFD0: { Make: 'PhoneCo', Model: 'P1' },
  IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '6/1 48/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '39/1 17/1 0/1' },
};

/** In-memory private and public stores (the service tests). */
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
      async put(buffer, filename) { const cid = `bafypub${++n}`; pub.set(`${cid}/${filename}`, Buffer.from(buffer)); return { cid, filename, url: `/storage/${cid}/${filename}` }; },
    },
  };
}

const UPLOAD_FIELDS = {
  source: 'FitFlex shoot, Mikocheni', photographer: 'Asha Photographer', licence: 'FitFlex owned',
  licenceRef: 'SHOOT-2026-10', people: 'hands_backs', rightsConfirmed: 'true', noFacesConfirmed: 'true',
};

async function clearHeroTables() {
  await db('HeroPublication').update({ rolledBackFrom: null });
  await db('HeroPublication').del();
  await db('HeroSlotDraft').del();
  await db('HeroImage').del();
  await db('AuditLog').where('action', 'like', 'hero\\_%').del();
}
const heroAudit = () => db('AuditLog').where('action', 'like', 'hero\\_%').orderBy('at', 'asc');

// ── A local Zebra ───────────────────────────────────────────────────────────

const zebraFiles = new Map();
let zebraDown = false;
let zebra;
const servers = [];
let base;

before(async () => {
  zebra = http.createServer(async (req, res) => {
    if (zebraDown) { res.statusCode = 503; return res.end(); }
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

  // Every function file, mounted the way bfast does (guards are path prefixes).
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
  const server = app.listen(0);
  servers.push(server);
  base = `http://127.0.0.1:${server.address().port}`;
  await db('User').insert({ id: BRAND_ID, userType: 'admin', displayName: 'Brand Admin', portalUser: true, aclPermissions: ['brand_media'], updatedAt: new Date() });
  await clearHeroTables();
});

after(async () => {
  delete process.env.ZEBRA_BASE_URL;
  delete process.env.HERO_IMAGES_CMS;
  for (const s of servers) s.close();
  await new Promise(resolve => zebra.close(resolve));
  await clearHeroTables();
  await db('User').where({ id: BRAND_ID }).del();
  await db.destroy();
});

beforeEach(() => { zebraDown = false; heroImageService.invalidateManifest(); });

const flag = on => { if (on) process.env.HERO_IMAGES_CMS = 'true'; else delete process.env.HERO_IMAGES_CMS; };
// A real User row, so display names can be checked.
const BRAND_ID = `adm_hero_${randomBytes(4).toString('hex')}`;
const brand = { sub: BRAND_ID, userType: 'admin', portalUser: true, aclPermissions: ['brand_media'] };
const superAdmin = { sub: 'adm_super', userType: 'admin', portalUser: false };
const otherStaff = { sub: 'adm_gyms_only', userType: 'admin', portalUser: true, aclPermissions: ['gyms', 'settings'] };
const member = { sub: 'usr_member', userType: 'member' };

async function hit(method, url, { claims, body, headers = {} } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let parsed = buf.toString();
  try { parsed = JSON.parse(parsed); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body: parsed, raw: buf };
}

async function uploadReq(file, fields = UPLOAD_FIELDS, claims = brand, filename = 'photo.jpg') {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v);
  if (file) form.append('file', file, { filename, contentType: 'image/jpeg' });
  const res = await fetch(`${base}/admin/hero-images`, {
    method: 'POST', body: form.getBuffer(),
    headers: { ...form.getHeaders(), ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) },
  });
  return { status: res.status, body: await res.json() };
}

// ── Registry and scope ──────────────────────────────────────────────────────

test('slots mirror the app\'s FFHeroPhoto names plus sections, footer pool and portal login', () => {
  const ffHeroPhoto = ['language', 'signIn', 'signUp', 'role', 'homeStart', 'homePass', 'profile', 'pin', 'upgrade',
    'activityToday', 'activityTraining', 'activityChallenges', 'activityProgress', 'trainer', 'vendor', 'owner'];
  const ids = HERO_SLOTS.map(s => s.id);
  for (const id of [...ffHeroPhoto, 'gyms', 'trainers', 'shop', 'footerPool', 'portalLogin']) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(heroSlot('footerPool').maxImages, 8);
  assert.equal(heroSlot('footerPool').variant, 'band');
  assert.equal(heroSlot('portalLogin').surface, 'portal');
  assert.equal(textZoneFor('portalLogin'), 'horizontal');
  assert.equal(textZoneFor('gyms'), 'vertical');
  assert.equal(heroSlot('nope'), null);
  assert.ok(PORTAL_ACL_SCOPES.includes('brand_media'));
  // Grouped and ordered as the portal's Places tab lists them (design spec §36.2).
  assert.deepEqual(HERO_AREAS, ['preSignIn', 'members', 'partners', 'footers', 'portal']);
  const byArea = area => HERO_SLOTS.filter(s => s.area === area).map(s => s.id);
  assert.deepEqual(byArea('preSignIn'), ['language', 'signIn', 'signUp', 'role', 'pin']);
  assert.deepEqual(byArea('members'), ['homeStart', 'homePass', 'profile', 'upgrade', 'activityToday', 'activityTraining',
    'activityChallenges', 'activityProgress', 'gyms', 'trainers', 'shop']);
  assert.deepEqual(byArea('partners'), ['trainer', 'vendor', 'owner']);
  assert.deepEqual(byArea('footers'), ['footerPool']);
  assert.deepEqual(byArea('portal'), ['portalLogin']);
  assert.deepEqual(HERO_SLOTS.map(s => s.area), [...HERO_SLOTS.map(s => s.area)].sort((a, b) => HERO_AREAS.indexOf(a) - HERO_AREAS.indexOf(b)));
});

test('If-None-Match matching honours lists, weak tags and *', () => {
  assert.ok(etagMatches('"hp_3"', '"hp_3"'));
  assert.ok(etagMatches('"hp_1", W/"hp_3"', '"hp_3"'));
  assert.ok(etagMatches('*', '"hp_3"'));
  assert.ok(!etagMatches('"hp_2"', '"hp_3"'));
  assert.ok(!etagMatches(undefined, '"hp_3"'));
});

// ── Upload processing ───────────────────────────────────────────────────────

test('an upload is rotated upright and loses its EXIF and GPS', async () => {
  // Stored landscape 1600×1200 with "rotate 90°": upright it is 1200×1600.
  const input = await photo(1600, 1200, { exif: GPS_EXIF, orientation: 6 });
  const inMeta = await sharp(input).metadata();
  assert.ok(inMeta.exif, 'fixture carries EXIF');
  assert.equal(inMeta.orientation, 6);
  const out = await prepareHeroUpload(input);
  assert.equal(out.error, undefined);
  assert.equal(out.mimeType, 'image/webp');
  assert.deepEqual([out.width, out.height], [1200, 1600]);
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.exif, undefined, 'no EXIF (so no GPS)');
  assert.equal(meta.xmp, undefined);
  assert.equal(meta.icc, undefined);
  assert.equal(meta.orientation, undefined);
  assert.ok(!out.buffer.includes(Buffer.from('PhoneCo')));
});

test('the hero image code never asks sharp to keep metadata', () => {
  for (const file of ['src/infra/hero-image-file.mjs', 'src/services/hero-image-service.mjs', 'functions/hero-images.mjs']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /\.(withMetadata|keepMetadata|keepExif|withExif|withExifMerge|keepIccProfile|withIccProfile|keepXmp|withXmp)\(/, file);
  }
});

test('uploads are checked from their bytes: size, pixels, width and decoding', async () => {
  assert.equal((await prepareHeroUpload(Buffer.from('MZ\x90\x00 not an image at all'))).error, 'unsupported_file_type');
  const gif = await prepareHeroUpload(await solid(1200, 800, '#246', 'gif'));
  assert.deepEqual([gif.error, gif.reason], ['unsupported_file_type', 'format_not_accepted']);
  const small = await prepareHeroUpload(await photo(1000, 1400));
  assert.deepEqual([small.error, small.status, small.width], ['image_too_small', 400, 1000]);
  // 1400 wide as stored, but 1000 wide once rotated upright.
  assert.equal((await prepareHeroUpload(await photo(1400, 1000, { orientation: 6 }))).error, 'image_too_small');
  const huge = await prepareHeroUpload(await solid(8000, 6300, '#333'));
  assert.deepEqual([huge.error, huge.status], ['file_too_large', 413]);
  assert.equal((await prepareHeroUpload(Buffer.alloc(HERO_LIMITS.maxBytes + 1))).error, 'file_too_large');
  const good = await photo(1600, 1000);
  assert.equal((await prepareHeroUpload(good.subarray(0, Math.floor(good.length * 0.6)))).error, 'unsupported_file_type', 'a cut-off file does not decode cleanly');
  assert.equal((await prepareHeroUpload(await photo(1600, 1000, { format: 'png' }))).width, 1600, 'PNG accepted');
});

test('the text zones are measured and bright ones flagged (spec §8.3)', async () => {
  const dark = await measureTextZones(await solid(1600, 1000, '#000'));
  assert.deepEqual(dark.vertical, { mean: 0, maxPatch: 0 });
  assert.ok(!isBright(dark.vertical));
  const white = await measureTextZones(await solid(1600, 1000, '#fff'));
  assert.ok(white.vertical.mean > 0.99 && isBright(white.horizontal));
  // White top, black bottom: fine for phone heroes (text at the bottom), bright for panels (left half).
  const split = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#000' } })
    .composite([{ input: await solid(1600, 400, '#fff', 'png'), top: 0, left: 0 }]).png().toBuffer();
  const z = await measureTextZones(split);
  assert.ok(!isBright(z.vertical), JSON.stringify(z));
  assert.ok(isBright(z.horizontal), JSON.stringify(z));
  // One bright patch is enough to warn, even on a dark average.
  const patch = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#000' } })
    .composite([{ input: await solid(200, 200, '#fff', 'png'), top: 750, left: 700 }]).png().toBuffer();
  const p = await measureTextZones(patch);
  assert.ok(p.vertical.mean <= 0.2 && p.vertical.maxPatch > 0.45 && isBright(p.vertical), JSON.stringify(p));
});

test('variants: 2× 1080 ≤ 150 KB, 1× 540 ≤ 60 KB, wide ≤ 1600, AVIF; all without metadata', async () => {
  const master = (await prepareHeroUpload(await photo(2400, 1600, { exif: GPS_EXIF, orientation: 6 }))).buffer;
  const v = await buildHeroVariants(master);
  assert.equal(v.error, undefined);
  assert.equal(v.x2.width, 1080);
  assert.ok(v.x2.bytes <= HERO_VARIANT_BUDGETS.x2.maxBytes, `2x ${v.x2.bytes}`);
  assert.ok(v.x2.quality <= 72 && v.x2.quality >= 50);
  assert.equal(v.x1.width, 540);
  assert.ok(v.x1.bytes <= HERO_VARIANT_BUDGETS.x1.maxBytes, `1x ${v.x1.bytes}`);
  assert.ok(v.wide.width <= 1600);
  for (const [name, file] of Object.entries(v)) {
    const meta = await sharp(file.buffer).metadata();
    assert.equal(meta.exif, undefined, name);
    assert.equal(file.bytes, file.buffer.length);
    assert.equal(meta.format, name === 'avif' ? 'heif' : 'webp', name);
  }
  assert.equal((await sharp(v.avif.buffer).metadata()).compression, 'av1');
});

test('a photo that cannot meet the 2× budget even at quality 50 is refused, not shipped', async () => {
  const noise = await sharp(randomBytes(1600 * 1100 * 3), { raw: { width: 1600, height: 1100, channels: 3 } }).webp({ quality: 95 }).toBuffer();
  const r = await buildHeroVariants(noise);
  assert.deepEqual([r.error, r.status, r.variant], ['variant_over_budget', 422, 'x2']);
});

// ── Service against the CI database (stores in memory) ──────────────────────

// A clock that moves 1 ms per read, so audit rows sort in the order they were written.
let tick = Date.parse('2026-10-19T08:00:00.000Z');
const steppingNow = () => new Date(tick++);
function service(stores, extra = {}) {
  return createHeroImageService({ store: createPgHeroImageStore({ db }), documentStore: stores.documentStore, publicStore: stores.publicStore, logger: { error() {} }, now: steppingNow, ...extra });
}
const uploadVia = async (svc, buffer, actorId = 'adm_svc') => svc.upload({ file: { buffer }, fields: UPLOAD_FIELDS, actorId });

test('service: private until published, publish, the 60 s cache, rollback and audit', async () => {
  await clearHeroTables();
  const stores = memoryStores();
  let clock = 1_000_000;
  const svcA = service(stores, { nowMs: () => clock });
  const svcB = service(stores); // a second server

  const { image } = await uploadVia(svcA, await photo(2000, 1300, { exif: GPS_EXIF, orientation: 6 }));
  assert.equal(image.status, 'draft');
  assert.equal(image.privateKey, undefined);
  assert.equal(image.variants, null);
  assert.equal(stores.pub.size, 0, 'nothing public on upload');
  const row = await db('HeroImage').where({ id: image.id }).first();
  assert.ok(stores.priv.has(row.privateKey));
  assert.equal((await sharp(stores.priv.get(row.privateKey)).metadata()).exif, undefined, 'private master stripped');

  assert.deepEqual((await svcA.setSlot('gyms', { imageIds: [image.id] }, 'adm_svc')).slot, { id: 'gyms', draft: [image.id] });
  assert.equal((await svcA.manifest()).body.version, 0, 'a draft is not public');

  const first = await svcB.publish({ note: 'first photos' }, 'adm_svc');
  assert.equal(first.publication.note, 'first photos');
  assert.deepEqual(first.publication.slots, { gyms: [image.id] });
  assert.equal(stores.pub.size, 4, '2x, 1x, wide, avif');
  // svcA still answers from its 60 s memory.
  assert.equal((await svcA.manifest()).body.version, 0);
  clock += HERO_MANIFEST_CACHE_MS;
  const m = await svcA.manifest();
  assert.equal(m.body.version, first.publication.id);
  assert.equal(m.etag, `"hp_${first.publication.id}"`);
  const [entry] = m.body.slots.gyms;
  assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'focal', 'height', 'id', 'sourceId', 'url', 'url1x', 'urlAvif', 'urlWide', 'width']);
  assert.equal(entry.sourceId, image.id);
  assert.equal(entry.width, 1080);
  assert.ok(entry.bytes <= 150 * 1024);
  assert.ok(stores.pub.has(entry.url.replace('/storage/', '')));

  // Focal changes reach the apps at the next publish only.
  await svcA.update(image.id, { focal: { x: -0.3, y: 0.25 } }, 'adm_svc');
  assert.deepEqual((await svcA.adminState()).images[0].focal, { x: -0.3, y: 0.25 });
  const second = await svcA.publish({}, 'adm_svc');
  assert.equal(stores.pub.size, 4, 'files are made once per photo');
  assert.deepEqual((await svcA.manifest()).body.slots.gyms[0].focal, { x: -0.3, y: 0.25 }, 'own publish clears own cache');

  // Empty the slot and publish: the apps go back to the bundled photo.
  await svcA.setSlot('gyms', { imageIds: [] }, 'adm_svc');
  const third = await svcA.publish({}, 'adm_svc');
  assert.deepEqual((await svcA.manifest()).body.slots, {});

  // Roll back to the second snapshot: published again, drafts follow.
  const back = await svcA.rollback({ publicationId: second.publication.id }, 'adm_svc');
  assert.equal(back.publication.rolledBackFrom, second.publication.id);
  assert.ok(back.publication.id > third.publication.id);
  assert.deepEqual((await svcA.manifest()).body.slots.gyms[0].focal, { x: -0.3, y: 0.25 });
  assert.deepEqual((await svcA.adminState()).slots.find(s => s.id === 'gyms').draft, [image.id]);
  assert.equal((await svcA.rollback({ publicationId: back.publication.id }, 'adm_svc')).error, 'already_current');
  assert.equal((await svcA.rollback({ publicationId: 999999 }, 'adm_svc')).error, 'publication_not_found');

  // Retire: out of the drafts at once, still live until the next publish, and no rollback to it.
  const retired = await svcA.update(image.id, { status: 'retired' }, 'adm_svc');
  assert.deepEqual(retired.removedFromDraftSlots, ['gyms']);
  assert.equal(retired.inLiveSnapshot, true);
  assert.equal((await svcA.update(image.id, { source: 'x' }, 'adm_svc')).error, 'image_retired');
  assert.equal((await svcA.setSlot('shop', { imageIds: [image.id] }, 'adm_svc')).error, 'image_retired');
  assert.equal((await svcA.rollback({ publicationId: first.publication.id }, 'adm_svc')).error, 'image_retired');
  await svcA.publish({ note: 'take it down' }, 'adm_svc');
  assert.deepEqual((await svcA.manifest()).body.slots, {});

  const actions = (await heroAudit()).map(a => a.action);
  assert.deepEqual(actions, [
    'hero_image_uploaded', 'hero_slot_updated', 'hero_image_published', 'hero_published',
    'hero_image_updated', 'hero_published', 'hero_slot_updated', 'hero_published', 'hero_rolled_back',
    'hero_image_retired', 'hero_published',
  ]);
  for (const a of await heroAudit()) {
    assert.ok(a.after, `${a.action} has after`);
    assert.ok(!JSON.stringify(a).includes(row.privateKey), `${a.action} never records the storage key`);
  }
});

test('service: slot rules and edit validation', async () => {
  await clearHeroTables();
  const stores = memoryStores();
  const svc = service(stores);
  const a = (await uploadVia(svc, await photo(1600, 1000))).image;
  const b = (await uploadVia(svc, await photo(1600, 1000))).image;
  assert.equal((await svc.setSlot('nope', { imageIds: [] }, 'x')).error, 'unknown_slot');
  assert.equal((await svc.setSlot('portalLogin', { imageIds: [a.id, b.id] }, 'x')).error, 'too_many_images');
  assert.equal((await svc.setSlot('gyms', { imageIds: [a.id, a.id] }, 'x')).error, 'duplicate_image');
  assert.equal((await svc.setSlot('gyms', { imageIds: 'abc' }, 'x')).error, 'invalid_image_ids');
  assert.deepEqual((await svc.setSlot('gyms', { imageIds: ['hero_missing'] }, 'x')).imageIds, ['hero_missing']);
  assert.ok((await svc.setSlot('footerPool', { imageIds: [a.id, b.id] }, 'x')).slot);
  assert.equal((await svc.update(a.id, { focal: { x: 2, y: 0 } }, 'x')).error, 'invalid_focal');
  assert.equal((await svc.update(a.id, { status: 'published' }, 'x')).error, 'invalid_status');
  assert.equal((await svc.update(a.id, { privateKey: 'x' }, 'x')).error, 'unknown_field');
  assert.equal((await svc.update(a.id, { photographer: '  ' }, 'x')).error, 'licence_details_required');
  assert.equal((await svc.update(a.id, { people: 'faces' }, 'x')).error, 'invalid_people');
  assert.equal((await svc.update(a.id, {}, 'x')).error, 'nothing_to_change');
  assert.equal((await svc.update('hero_missing', { source: 'y' }, 'x')).error, 'image_not_found');
  const ok = await svc.update(a.id, { consentRef: 'GYM-CONSENT-7', licenceRef: null }, 'x');
  assert.deepEqual([ok.image.consentRef, ok.image.licenceRef], ['GYM-CONSENT-7', null]);
  // Storage outage: nothing is half published.
  const broken = service({ ...stores, publicStore: { async put() { throw new Error('down'); } } });
  assert.equal((await broken.publish({}, 'x')).error, 'storage_service_unavailable');
  assert.equal((await db('HeroPublication').count({ n: '*' }))[0].n, '0');
  assert.equal((await svc.publish({ note: 'n'.repeat(501) }, 'x')).error, 'invalid_note');
});

// ── Routes ──────────────────────────────────────────────────────────────────

const ADMIN_ROUTES = [
  ['GET', '/admin/hero-images'], ['POST', '/admin/hero-images'], ['GET', '/admin/hero-images/hero_x/preview'],
  ['PATCH', '/admin/hero-images/hero_x'], ['PUT', '/admin/hero-slots/gyms'], ['POST', '/admin/hero-slots/publish'],
  ['POST', '/admin/hero-slots/rollback'],
];

test('flag off: admin routes 404 before sign-in, the manifest is empty', async () => {
  flag(false);
  for (const [method, url] of ADMIN_ROUTES) {
    for (const claims of [undefined, superAdmin, brand]) {
      const r = await hit(method, url, { claims, body: method === 'GET' ? undefined : {} });
      assert.deepEqual([r.status, r.body], [404, { error: 'feature_disabled' }], `${method} ${url}`);
    }
  }
  const m = await hit('GET', '/app/hero-images');
  assert.equal(m.status, 200);
  assert.deepEqual(m.body, { version: 0, slots: {} });
  assert.equal(m.headers.get('etag'), '"hp_0"');
  assert.equal(m.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
});

test('flag on: only admins with brand_media (or super-admins) reach the admin routes', async () => {
  flag(true);
  await clearHeroTables();
  for (const [method, url] of ADMIN_ROUTES) {
    const body = method === 'GET' ? undefined : {};
    assert.equal((await hit(method, url, { body })).status, 401, `${method} ${url} anonymous`);
    assert.equal((await hit(method, url, { claims: member, body })).status, 403, `${method} ${url} member`);
    const staff = await hit(method, url, { claims: otherStaff, body });
    assert.deepEqual([staff.status, staff.body], [403, { error: 'acl_forbidden', requiredScope: 'brand_media' }], `${method} ${url} staff`);
  }
  assert.equal((await hit('GET', '/admin/hero-images', { claims: brand })).status, 200);
  assert.equal((await hit('GET', '/admin/hero-images', { claims: superAdmin })).status, 200);
  // The public manifest needs no sign-in.
  assert.equal((await hit('GET', '/app/hero-images')).status, 200);
});

test('routes: upload checks, private preview, drafts not public, publish, ETag/304, rollback, audit', async () => {
  flag(true);
  await clearHeroTables();

  // Upload checks.
  const fixture = await photo(1800, 1200, { exif: GPS_EXIF, orientation: 6 });
  const noRights = await uploadReq(fixture, { ...UPLOAD_FIELDS, rightsConfirmed: 'false' });
  assert.deepEqual([noRights.status, noRights.body.error], [400, 'rights_confirmation_required']);
  const noFaces = await uploadReq(fixture, { ...UPLOAD_FIELDS, noFacesConfirmed: undefined });
  assert.deepEqual([noFaces.status, noFaces.body.error], [400, 'no_faces_confirmation_required']);
  const { licence, ...noLicence } = UPLOAD_FIELDS;
  assert.deepEqual((await uploadReq(fixture, noLicence)).body, { error: 'licence_details_required', fields: ['licence'] });
  assert.equal((await uploadReq(await photo(900, 1200))).body.error, 'image_too_small');
  assert.equal((await uploadReq(Buffer.from('<html><script>alert(1)</script>'))).body.error, 'unsupported_file_type');
  const big = await uploadReq(Buffer.alloc(HERO_LIMITS.maxBytes + 1024, 1));
  assert.deepEqual([big.status, big.body.error], [413, 'file_too_large']);
  zebraDown = true;
  const down = await uploadReq(fixture);
  assert.deepEqual([down.status, down.body.error], [503, 'storage_service_unavailable']);
  zebraDown = false;
  assert.equal(await db('HeroImage').count({ n: '*' }).then(r => r[0].n), '0', 'no rows for refused uploads');

  const up = await uploadReq(fixture);
  assert.equal(up.status, 201);
  const img = up.body.image;
  assert.deepEqual([img.width, img.height], [1200, 1800], 'rotated upright');
  assert.equal(img.privateKey, undefined);
  assert.ok(!JSON.stringify(up.body).includes('bafyzebra'), 'the private address never leaves the server');
  assert.equal(img.photographer, 'Asha Photographer');
  assert.equal(img.rightsConfirmedBy, brand.sub);
  assert.equal(img.noFacesConfirmedBy, brand.sub);

  // Preview: streamed, stripped, never cached.
  const pv = await hit('GET', img.previewUrl, { claims: brand });
  assert.equal(pv.status, 200);
  assert.equal(pv.headers.get('content-type'), 'image/webp');
  assert.equal(pv.headers.get('cache-control'), 'no-store, private');
  assert.equal(pv.headers.get('x-content-type-options'), 'nosniff');
  const pvMeta = await sharp(pv.raw).metadata();
  assert.equal(pvMeta.exif, undefined, 'EXIF/GPS stripped');
  assert.ok(!pv.raw.includes(Buffer.from('PhoneCo')));
  assert.equal((await hit('GET', '/admin/hero-images/hero_missing/preview', { claims: brand })).status, 404);
  // Thumbnails (spec O-30): a fixed set of widths, also without metadata.
  const thumb = await hit('GET', `${img.previewUrl}?w=480`, { claims: brand });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('cache-control'), 'no-store, private');
  const thumbMeta = await sharp(thumb.raw).metadata();
  assert.deepEqual([thumbMeta.width, thumbMeta.exif], [480, undefined]);
  assert.ok(thumb.raw.length < pv.raw.length);
  assert.deepEqual((await hit('GET', `${img.previewUrl}?w=5000`, { claims: brand })).body, { error: 'invalid_width', allowed: [240, 480, 960] });
  // The upload answer already names the uploader and carries the scene id.
  assert.deepEqual([img.createdByName, img.rightsConfirmedByName, img.sourceId, img.focalX, img.focalY], ['Brand Admin', 'Brand Admin', img.id, 0, 0]);

  // Slots.
  assert.deepEqual((await hit('PUT', '/admin/hero-slots/nope', { claims: brand, body: { imageIds: [] } })).body, { error: 'unknown_slot' });
  const second = (await uploadReq(await photo(1600, 1100))).body.image;
  assert.deepEqual((await hit('PUT', '/admin/hero-slots/portalLogin', { claims: brand, body: { imageIds: [img.id, second.id] } })).body, { error: 'too_many_images', maxImages: 1 });
  assert.equal((await hit('PUT', '/admin/hero-slots/gyms', { claims: brand, body: { imageIds: [img.id] } })).status, 200);
  assert.equal((await hit('PUT', '/admin/hero-slots/footerPool', { claims: brand, body: { imageIds: [second.id, img.id] } })).status, 200);
  const before = await hit('GET', '/app/hero-images');
  assert.deepEqual(before.body, { version: 0, slots: {} }, 'drafts are not public');
  const zebraBeforePublish = zebraFiles.size;

  // Publish.
  const pub = await hit('POST', '/admin/hero-slots/publish', { claims: brand, body: { note: 'launch' } });
  assert.equal(pub.status, 201);
  assert.equal(zebraFiles.size, zebraBeforePublish + 8, 'four public files for each of the two photos');
  const m = await hit('GET', '/app/hero-images');
  assert.equal(m.status, 200);
  assert.equal(m.body.version, pub.body.publication.id);
  assert.equal(m.headers.get('etag'), `"hp_${pub.body.publication.id}"`);
  assert.equal(m.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
  assert.deepEqual(Object.keys(m.body.slots).sort(), ['footerPool', 'gyms']);
  assert.deepEqual(m.body.slots.footerPool.map(e => e.sourceId), [second.id, img.id], 'order kept');
  const text = JSON.stringify(m.body);
  for (const secret of ['Asha Photographer', 'FitFlex owned', 'SHOOT-2026-10', 'licence', 'photographer', 'createdBy', brand.sub, 'privateKey', 'draft']) {
    assert.ok(!text.includes(secret), `manifest must not carry ${secret}`);
  }
  const privateKeys = (await db('HeroImage').select('privateKey')).map(r => r.privateKey);
  for (const k of privateKeys) assert.ok(!text.includes(`/storage/${k.split('/')[0]}/`), 'no private content id');
  for (const e of [...m.body.slots.gyms, ...m.body.slots.footerPool]) {
    const x2 = zebraFiles.get(e.url.replace('/storage/', ''));
    const x1 = zebraFiles.get(e.url1x.replace('/storage/', ''));
    assert.ok(x2 && x1 && zebraFiles.get(e.urlWide.replace('/storage/', '')) && zebraFiles.get(e.urlAvif.replace('/storage/', '')));
    assert.equal(x2.length, e.bytes);
    assert.ok(x2.length <= 150 * 1024, `2x ${x2.length}`);
    assert.ok(x1.length <= 60 * 1024, `1x ${x1.length}`);
    assert.equal((await sharp(x2).metadata()).width, 1080);
    assert.equal((await sharp(x1).metadata()).width, 540);
    for (const f of [x2, x1]) assert.equal((await sharp(f).metadata()).exif, undefined, 'public files carry no EXIF');
  }

  // 304 when unchanged.
  const etag = m.headers.get('etag');
  const nm = await hit('GET', '/app/hero-images', { headers: { 'if-none-match': etag } });
  assert.equal(nm.status, 304);
  assert.equal(nm.raw.length, 0);
  assert.equal(nm.headers.get('etag'), etag);
  assert.equal((await hit('GET', '/app/hero-images', { headers: { 'if-none-match': '"hp_0"' } })).status, 200);

  // Admin view.
  const state = (await hit('GET', '/admin/hero-images', { claims: brand })).body;
  assert.equal(state.images.length, 2);
  assert.ok(!JSON.stringify(state).includes('privateKey'));
  const gyms = state.slots.find(s => s.id === 'gyms');
  assert.deepEqual([gyms.draft, gyms.published], [[img.id], [img.id]]);
  assert.deepEqual([gyms.area, gyms.surface, gyms.variant, gyms.aspectHint, gyms.maxImages], ['members', 'mobile', 'compact', 1.5, 3]);
  assert.deepEqual(state.slots.find(s => s.id === 'footerPool').maxImages, 8);
  assert.deepEqual(state.areas, HERO_AREAS);
  assert.deepEqual(state.slots.map(s => s.id), HERO_SLOTS.map(s => s.id), 'display order');
  assert.equal(state.publications[0].note, 'launch');
  assert.equal(state.publications[0].publishedByName, 'Brand Admin');
  assert.equal(pub.body.publication.publishedByName, 'Brand Admin');
  assert.ok(state.images.every(i => i.createdByName === 'Brand Admin' && i.sourceId === i.id));
  assert.equal(state.slots.length, HERO_SLOTS.length);

  // Edit, publish again, then roll back to the first snapshot.
  assert.equal((await hit('PATCH', `/admin/hero-images/${img.id}`, { claims: brand, body: { focal: { x: 0.5, y: -0.5 } } })).status, 200);
  assert.equal((await hit('PUT', '/admin/hero-slots/gyms', { claims: brand, body: { imageIds: [second.id] } })).status, 200);
  const pub2 = await hit('POST', '/admin/hero-slots/publish', { claims: brand, body: {} });
  const m2 = await hit('GET', '/app/hero-images', { headers: { 'if-none-match': etag } });
  assert.equal(m2.status, 200, 'a new snapshot is a new ETag');
  assert.equal(m2.body.slots.gyms[0].sourceId, second.id);
  assert.deepEqual(m2.body.slots.footerPool[1].focal, { x: 0.5, y: -0.5 });

  const rb = await hit('POST', '/admin/hero-slots/rollback', { claims: brand, body: { publicationId: pub.body.publication.id } });
  assert.equal(rb.status, 201);
  assert.equal(rb.body.publication.rolledBackFrom, pub.body.publication.id);
  const m3 = await hit('GET', '/app/hero-images');
  assert.equal(m3.body.version, rb.body.publication.id);
  assert.deepEqual(m3.body.slots, m.body.slots, 'the first snapshot exactly');
  assert.deepEqual((await hit('POST', '/admin/hero-slots/rollback', { claims: brand, body: { publicationId: rb.body.publication.id } })).body, { error: 'already_current' });
  assert.equal((await hit('POST', '/admin/hero-slots/rollback', { claims: brand, body: { publicationId: 'abc' } })).body.error, 'invalid_publication_id');
  assert.ok(pub2.body.publication.id < rb.body.publication.id);

  // Audit: one row per write, with before and after, by the acting admin. (Real clock here: rows
  // written in the same millisecond may sort either way, so compare them as a set.)
  const rows = await heroAudit();
  assert.deepEqual(rows.map(r => r.action).sort(), [
    'hero_image_uploaded', 'hero_image_uploaded', 'hero_slot_updated', 'hero_slot_updated',
    'hero_image_published', 'hero_image_published', 'hero_published',
    'hero_image_updated', 'hero_slot_updated', 'hero_published', 'hero_rolled_back',
  ].sort());
  assert.ok(rows.every(r => r.actor === brand.sub));
  const slotRow = rows.find(r => r.action === 'hero_slot_updated' && r.target === 'slot:gyms' && r.before.imageIds.length === 0);
  assert.deepEqual([slotRow.before, slotRow.after], [{ imageIds: [] }, { imageIds: [img.id] }]);
  const edit = rows.find(r => r.action === 'hero_image_updated');
  assert.deepEqual([edit.before.focal, edit.after.focal], [{ x: 0, y: 0 }, { x: 0.5, y: -0.5 }]);
  const rbRow = rows.find(r => r.action === 'hero_rolled_back');
  assert.equal(rbRow.before.publicationId, pub2.body.publication.id);
  assert.equal(rbRow.after.rolledBackFrom, pub.body.publication.id);
  for (const r of rows) for (const k of privateKeys) assert.ok(!JSON.stringify(r).includes(k), 'audit never records storage keys');
  // The manifest's sourceId is the scene id (each upload its own scene for now: the image id).
  assert.deepEqual(m3.body.slots.gyms.map(e => e.sourceId), [img.id]);

  // Turning the flag off empties the manifest straight away (apps purge).
  flag(false);
  assert.deepEqual((await hit('GET', '/app/hero-images')).body, { version: 0, slots: {} });
});
