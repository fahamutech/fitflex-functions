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
import { createHeroImageService, HERO_MANIFEST_CACHE_MS, ALLOWED_PEOPLE, HERO_AUDIT_PREVIEWS, HERO_PUBLIC_UPLOAD_TIMEOUT_MS } from '../src/services/hero-image-service.mjs';
import { createPgHeroImageStore } from '../src/infra/hero-image-store-pg.mjs';
import { PORTAL_ACL_SCOPES } from '../src/services/portal-user-service.mjs';
import { etagMatches, HERO_MANIFEST_CACHE_CONTROL } from '../functions/hero-images.mjs';
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
  licenceRef: 'SHOOT-2026-10', people: 'none', rightsConfirmed: 'true', noFacesConfirmed: 'true',
};

async function clearHeroTables() {
  await db('HeroPublication').update({ rolledBackFrom: null });
  await db('HeroImage').update({ unpublishedInPublication: null });
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

  // Retire: refused while in a draft (spec AC-N14); once out of the drafts it is retired, still
  // live until the next publish, and no rollback to it.
  assert.deepEqual(await svcA.update(image.id, { status: 'retired' }, 'adm_svc'), { error: 'image_in_draft', status: 409, slotIds: ['gyms'] });
  assert.equal((await db('HeroImage').where({ id: image.id }).first()).status, 'published', 'refused retire changed nothing');
  await svcA.setSlot('gyms', { imageIds: [] }, 'adm_svc');
  const retired = await svcA.update(image.id, { status: 'retired' }, 'adm_svc');
  assert.equal(retired.image.status, 'retired');
  assert.equal(retired.inLiveSnapshot, true);
  assert.equal((await svcA.update(image.id, { source: 'x' }, 'adm_svc')).error, 'image_retired');
  assert.equal((await svcA.setSlot('shop', { imageIds: [image.id] }, 'adm_svc')).error, 'image_retired');
  assert.equal((await svcA.rollback({ publicationId: first.publication.id }, 'adm_svc')).error, 'image_retired');
  await svcA.publish({ note: 'take it down' }, 'adm_svc');
  assert.deepEqual((await svcA.manifest()).body.slots, {});

  const actions = (await heroAudit()).map(a => a.action);
  assert.deepEqual(actions, [
    'hero_image_uploaded', 'hero_slot_updated', 'hero_image_public_files_created', 'hero_image_published', 'hero_published',
    'hero_image_updated', 'hero_published', 'hero_slot_updated', 'hero_published', 'hero_rolled_back',
    'hero_slot_updated', 'hero_image_retired', 'hero_published',
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
  assert.equal((await svc.update(a.id, { consentRef: 'GYM-CONSENT-7', licenceRef: null }, 'x')).error, 'rights_confirmation_required');
  const ok = await svc.update(a.id, { consentRef: 'GYM-CONSENT-7', licenceRef: null, rightsConfirmed: true }, 'x');
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
  ['POST', '/admin/hero-slots/rollback'], ['POST', '/admin/hero-images/hero_x/unpublish'],
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
  assert.equal(m.headers.get('cache-control'), 'public, max-age=300');
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
  assert.equal(m.headers.get('cache-control'), 'public, max-age=300');
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
    'hero_image_public_files_created', 'hero_image_public_files_created',
    'hero_image_published', 'hero_image_published', 'hero_published', 'hero_image_previewed', 'hero_image_previewed',
    'hero_image_updated', 'hero_slot_updated', 'hero_published', 'hero_rolled_back',
  ].sort());
  assert.ok(rows.every(r => r.actor === brand.sub));
  // Preview views are audited with their size (full or thumbnail width), never the storage key.
  const previews = rows.filter(r => r.action === 'hero_image_previewed');
  assert.ok(previews.every(r => r.target === img.id && r.after.imageId === img.id && r.before === null));
  assert.deepEqual(previews.map(r => String(r.after.size)).sort(), ['480', 'full']);
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

// ── Security-review fixes ───────────────────────────────────────────────────

/** Noise cannot meet the 2× budget even at quality 50: publish must refuse it. */
const noisePhoto = () => sharp(randomBytes(1600 * 1100 * 3), { raw: { width: 1600, height: 1100, channels: 3 } }).webp({ quality: 95 }).toBuffer();
const publicationCount = async () => Number((await db('HeroPublication').count({ n: '*' }))[0].n);

test('publish: a failure building the second photo uploads nothing for the first', async () => {
  await clearHeroTables();
  const stores = memoryStores();
  const svc = service(stores);
  const good = (await uploadVia(svc, await photo(1600, 1000))).image;
  const bad = (await uploadVia(svc, await noisePhoto())).image;
  assert.ok(bad, 'the noise photo is a valid upload');
  await svc.setSlot('gyms', { imageIds: [good.id, bad.id] }, 'x');
  const r = await svc.publish({}, 'x');
  assert.deepEqual([r.error, r.status, r.imageId], ['variant_over_budget', 422, bad.id]);
  assert.equal(stores.pub.size, 0, 'no public file for either photo');
  assert.equal(await publicationCount(), 0);
  const row = await db('HeroImage').where({ id: good.id }).first();
  assert.deepEqual([row.status, row.variants], ['draft', null]);

  // A broken private master (sha mismatch) on one photo: same, nothing public.
  const third = (await uploadVia(svc, await photo(1600, 1000))).image;
  const key = (await db('HeroImage').where({ id: third.id }).first()).privateKey;
  stores.priv.set(key, Buffer.from('tampered'));
  await svc.setSlot('gyms', { imageIds: [good.id, third.id] }, 'x');
  const r2 = await svc.publish({}, 'x');
  assert.deepEqual([r2.error, r2.imageId], ['stored_file_mismatch', third.id]);
  assert.equal(stores.pub.size, 0);
  assert.equal(await publicationCount(), 0);
});

test('publish: an upload failing part-way keeps whole photos, records the orphans, no snapshot; retry reuses', async () => {
  await clearHeroTables();
  const stores = memoryStores();
  const svc = service(stores);
  const a = (await uploadVia(svc, await photo(1600, 1000))).image;
  const b = (await uploadVia(svc, await photo(1600, 1000))).image;
  await svc.setSlot('gyms', { imageIds: [a.id, b.id] }, 'x');
  let puts = 0;
  const flaky = { async put(...args) { puts += 1; if (puts === 6) throw new Error('zebra down'); return stores.publicStore.put(...args); } };
  const r = await service({ ...stores, publicStore: flaky }).publish({}, 'x');
  assert.deepEqual([r.error, r.status, r.imageId], ['storage_service_unavailable', 503, b.id]);
  assert.equal(stores.pub.size, 5, 'a: 4 files, b: 1 before the failure');
  assert.equal(await publicationCount(), 0, 'no snapshot');
  const state = await svc.adminState();
  const view = id => state.images.find(i => i.id === id);
  assert.deepEqual([view(a.id).status, view(a.id).hasPublicFiles, view(a.id).live], ['draft', true, false], 'not "Published": never live');
  assert.deepEqual([view(b.id).status, view(b.id).hasPublicFiles], ['draft', false]);
  const orphan = (await heroAudit()).find(x => x.action === 'hero_image_orphaned_public_files');
  assert.equal(orphan.target, b.id);
  assert.equal(orphan.after.urls.length, 1);

  const ok = await svc.publish({}, 'x');
  assert.ok(ok.publication);
  assert.equal(stores.pub.size, 9, 'only b uploaded again; a reused');
  const after = await svc.adminState();
  for (const id of [a.id, b.id]) {
    const i = after.images.find(x => x.id === id);
    assert.deepEqual([i.status, i.hasPublicFiles, i.live], ['published', true, true]);
  }
});

test('publish: re-checks under the lock; a photo retired meanwhile is never uploaded', async () => {
  await clearHeroTables();
  const stores = memoryStores();
  const other = service(stores); // a second admin, racing
  const a = (await uploadVia(other, await photo(1600, 1000))).image;
  await other.setSlot('gyms', { imageIds: [a.id] }, 'x');
  // While publish is building outside the lock, the other admin takes the photo out and retires it.
  let raced = false;
  const racingDocs = {
    ...stores.documentStore,
    async get(key) {
      const buf = await stores.documentStore.get(key);
      if (!raced) {
        raced = true;
        await other.setSlot('gyms', { imageIds: [] }, 'y');
        assert.ok((await other.update(a.id, { status: 'retired' }, 'y')).image);
      }
      return buf;
    },
  };
  const r = await service({ ...stores, documentStore: racingDocs }).publish({}, 'x');
  assert.ok(r.publication, JSON.stringify(r));
  assert.deepEqual(r.publication.slots, {});
  assert.equal(stores.pub.size, 0, 'the retired photo got no public files');
  assert.equal((await db('HeroImage').where({ id: a.id }).first()).variants, null);

  // A photo drafted after the build step: drafts_changed, still nothing uploaded.
  const b = (await uploadVia(other, await photo(1600, 1000))).image;
  const c = (await uploadVia(other, await photo(1600, 1000))).image;
  await other.setSlot('gyms', { imageIds: [b.id] }, 'x');
  let added = false;
  const addingDocs = {
    ...stores.documentStore,
    async get(key) {
      const buf = await stores.documentStore.get(key);
      if (!added) { added = true; await other.setSlot('shop', { imageIds: [c.id] }, 'y'); }
      return buf;
    },
  };
  const r2 = await service({ ...stores, documentStore: addingDocs }).publish({}, 'x');
  assert.deepEqual([r2.error, r2.status, r2.imageIds], ['drafts_changed', 409, [c.id]]);
  assert.equal(stores.pub.size, 0);
});

test('PATCH: changing rights details needs a fresh confirmation by the session admin', async () => {
  await clearHeroTables();
  const stores = memoryStores();
  const svc = service(stores);
  const img = (await uploadVia(svc, await photo(1600, 1000), 'adm_uploader')).image;
  for (const change of [{ licence: 'CC BY 4.0' }, { licenceRef: 'NEW-REF' }, { source: 'Elsewhere' }, { photographer: 'Juma' }, { consentRef: 'C-1' }]) {
    assert.deepEqual(await svc.update(img.id, change, 'adm_editor'), { error: 'rights_confirmation_required', status: 400 }, JSON.stringify(change));
    assert.deepEqual(await svc.update(img.id, { ...change, rightsConfirmed: 'false' }, 'adm_editor'), { error: 'rights_confirmation_required', status: 400 });
  }
  // Unchanged values sent back with a focal edit need no confirmation and keep the confirmer.
  const focal = await svc.update(img.id, { focal: { x: 0.1, y: 0 }, licence: UPLOAD_FIELDS.licence, people: 'none' }, 'adm_editor');
  assert.equal(focal.image.rightsConfirmedBy, 'adm_uploader');
  assert.equal((await svc.update(img.id, { licence: UPLOAD_FIELDS.licence, rightsConfirmed: true }, 'adm_editor')).error, 'nothing_to_change');

  const ok = await svc.update(img.id, { licence: 'CC BY 4.0', rightsConfirmed: true }, 'adm_editor');
  assert.equal(ok.image.licence, 'CC BY 4.0');
  assert.equal(ok.image.rightsConfirmedBy, 'adm_editor');
  assert.ok(ok.image.rightsConfirmedAt > img.rightsConfirmedAt);
  assert.equal(ok.image.noFacesConfirmedBy, 'adm_uploader', 'no-faces confirmation only moves with people');

  // people: needs both confirmations. (A legacy row with hands_backs, as uploads now only take none.)
  await db('HeroImage').where({ id: img.id }).update({ people: 'hands_backs' });
  assert.equal((await svc.update(img.id, { people: 'none' }, 'adm_editor2')).error, 'rights_confirmation_required');
  assert.deepEqual(await svc.update(img.id, { people: 'none', rightsConfirmed: 'true' }, 'adm_editor2'), { error: 'no_faces_confirmation_required', status: 400 });
  const ppl = await svc.update(img.id, { people: 'none', rightsConfirmed: 'true', noFacesConfirmed: 'true' }, 'adm_editor2');
  assert.deepEqual([ppl.image.people, ppl.image.rightsConfirmedBy, ppl.image.noFacesConfirmedBy], ['none', 'adm_editor2', 'adm_editor2']);
  const audits = (await heroAudit()).filter(r => r.action === 'hero_image_updated');
  assert.equal(audits.at(-1).after.noFacesConfirmedBy, 'adm_editor2');
});

test('people: only "none" is accepted for now (owner 2026-10-19), on upload and PATCH', async () => {
  flag(true);
  await clearHeroTables();
  assert.deepEqual(ALLOWED_PEOPLE, ['none']);
  const fixture = await photo(1600, 1000);
  for (const people of ['hands_backs', 'unclear_faces']) {
    const r = await uploadReq(fixture, { ...UPLOAD_FIELDS, people });
    assert.deepEqual([r.status, r.body], [400, { error: 'people_not_allowed', allowed: ['none'] }], people);
  }
  assert.equal((await uploadReq(fixture, { ...UPLOAD_FIELDS, people: 'faces' })).body.error, 'invalid_people');
  // The no-faces confirmation is still required with none.
  assert.equal((await uploadReq(fixture, { ...UPLOAD_FIELDS, noFacesConfirmed: undefined })).body.error, 'no_faces_confirmation_required');
  assert.equal(await db('HeroImage').count({ n: '*' }).then(r => r[0].n), '0');
  const up = await uploadReq(fixture);
  assert.deepEqual([up.status, up.body.image.people], [201, 'none']);
  for (const people of ['hands_backs', 'unclear_faces']) {
    const r = await hit('PATCH', `/admin/hero-images/${up.body.image.id}`, { claims: brand, body: { people, rightsConfirmed: true, noFacesConfirmed: true } });
    assert.deepEqual([r.status, r.body.error], [400, 'people_not_allowed'], people);
  }
  const fine = await hit('PATCH', `/admin/hero-images/${up.body.image.id}`, { claims: brand, body: { people: 'none', focal: { x: 0.2, y: 0 } } });
  assert.equal(fine.status, 200);
});

test('unpublish: takes one photo out of the live snapshot at once; drafts untouched; audited', async () => {
  flag(true);
  await clearHeroTables();
  assert.equal(HERO_MANIFEST_CACHE_CONTROL, 'public, max-age=300', 'no stale-while-revalidate');
  const a = (await uploadReq(await photo(1600, 1000))).body.image;
  const b = (await uploadReq(await photo(1600, 1000))).body.image;
  await hit('PUT', '/admin/hero-slots/gyms', { claims: brand, body: { imageIds: [a.id] } });
  await hit('PUT', '/admin/hero-slots/footerPool', { claims: brand, body: { imageIds: [b.id, a.id] } });
  assert.deepEqual((await hit('POST', `/admin/hero-images/${a.id}/unpublish`, { claims: brand, body: {} })).body, { error: 'image_not_live' });
  const pub = (await hit('POST', '/admin/hero-slots/publish', { claims: brand, body: {} })).body.publication;
  assert.equal((await hit('GET', '/app/hero-images')).body.version, pub.id, 'manifest cached at this version');
  const zebraBefore = zebraFiles.size;

  const un = await hit('POST', `/admin/hero-images/${a.id}/unpublish`, { claims: brand, body: { note: 'takedown' } });
  assert.equal(un.status, 201);
  assert.deepEqual(un.body.removedFromSlots, ['footerPool', 'gyms']);
  assert.deepEqual(un.body.publication.slots, { footerPool: [b.id] });
  assert.equal(un.body.publication.note, 'takedown');
  assert.equal(un.body.rollbackBlockedBefore, un.body.publication.id);
  assert.equal(zebraFiles.size, zebraBefore, 'no new files');
  // This server answers the new snapshot straight away (its 60 s memory was cleared).
  const m = await hit('GET', '/app/hero-images');
  assert.equal(m.body.version, un.body.publication.id);
  assert.deepEqual(Object.keys(m.body.slots), ['footerPool']);
  assert.deepEqual(m.body.slots.footerPool.map(e => e.sourceId), [b.id]);
  assert.equal(m.headers.get('cache-control'), 'public, max-age=300');
  // Drafts untouched.
  const state = (await hit('GET', '/admin/hero-images', { claims: brand })).body;
  assert.deepEqual(state.slots.find(s => s.id === 'gyms').draft, [a.id]);
  assert.deepEqual(state.slots.find(s => s.id === 'footerPool').draft, [b.id, a.id]);
  assert.deepEqual(state.slots.find(s => s.id === 'gyms').published, []);
  assert.deepEqual([state.images.find(i => i.id === a.id).live, state.images.find(i => i.id === b.id).live], [false, true]);
  // Audited, by the acting admin, with before and after.
  const row = (await heroAudit()).find(r => r.action === 'hero_image_unpublished');
  assert.deepEqual([row.actor, row.target, row.before.publicationId, row.after.publicationId, row.after.removedFromSlots],
    [brand.sub, a.id, pub.id, un.body.publication.id, ['footerPool', 'gyms']]);
  assert.deepEqual(row.before.slots, { gyms: [a.id], footerPool: [b.id, a.id] });
  // Again: not live any more. Unknown photo: 404.
  assert.deepEqual([(await hit('POST', `/admin/hero-images/${a.id}/unpublish`, { claims: brand, body: {} })).status], [409]);
  assert.equal((await hit('POST', '/admin/hero-images/hero_missing/unpublish', { claims: brand, body: {} })).status, 404);
  // Retire through the route while drafted: refused.
  const rt = await hit('PATCH', `/admin/hero-images/${a.id}`, { claims: brand, body: { status: 'retired' } });
  assert.deepEqual([rt.status, rt.body], [409, { error: 'image_in_draft', slotIds: ['footerPool', 'gyms'] }]);
});

test('upload: a private file whose row cannot be saved is logged and audited, not silently lost', async () => {
  await clearHeroTables();
  const stores = memoryStores();
  const pg = createPgHeroImageStore({ db });
  let fail = true;
  const store = {
    ...pg,
    transaction: fn => pg.transaction(q => fn({ ...q, async insertImage(row) { if (fail) throw new Error('db write failed'); return q.insertImage(row); } })),
  };
  const logged = [];
  const svc = createHeroImageService({ store, documentStore: stores.documentStore, publicStore: stores.publicStore, now: steppingNow, logger: { error: (...a) => logged.push(a.join(' ')) } });
  const r = await uploadVia(svc, await photo(1600, 1000), 'adm_orphan');
  assert.deepEqual(r, { error: 'image_save_failed', status: 500 });
  assert.equal(stores.priv.size, 1, 'the private file was stored');
  const [key] = [...stores.priv.keys()];
  assert.equal(await db('HeroImage').count({ n: '*' }).then(x => x[0].n), '0');
  assert.ok(logged.some(l => l.includes('ORPHANED private file') && l.includes(key)), 'the log names the key');
  const rows = (await heroAudit()).filter(x => x.action === 'hero_image_orphaned_private_file');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'adm_orphan');
  assert.ok(rows[0].after.sha256 && rows[0].after.privateKeyHash);
  assert.ok(!JSON.stringify(rows[0]).includes(key), 'the audit row never holds the key');
  fail = false;
  assert.ok((await uploadVia(svc, await photo(1600, 1000))).image);
});

test('preview audit can be switched off with one constant', () => {
  assert.equal(HERO_AUDIT_PREVIEWS, true);
  const src = fs.readFileSync(path.join(root, 'src/services/hero-image-service.mjs'), 'utf8');
  assert.match(src, /export const HERO_AUDIT_PREVIEWS = true;/);
  assert.match(src, /if \(HERO_AUDIT_PREVIEWS\)/);
});

// ── Re-review fixes (PR #216) ───────────────────────────────────────────────

test('people: older photos with a people value no longer allowed are refused by setSlot, publish and rollback', async () => {
  await clearHeroTables();
  const stores = memoryStores();
  const svc = service(stores);
  const a = (await uploadVia(svc, await photo(1600, 1000))).image;
  const b = (await uploadVia(svc, await photo(1600, 1000))).image;
  await svc.setSlot('gyms', { imageIds: [a.id] }, 'x');
  const p1 = (await svc.publish({}, 'x')).publication;
  assert.equal(stores.pub.size, 4);

  // Rows from before the owner's 2026-10-19 rule (or a widened then narrowed list).
  await db('HeroImage').whereIn('id', [a.id, b.id]).update({ people: 'hands_backs' });
  assert.deepEqual(await svc.setSlot('shop', { imageIds: [b.id] }, 'x'),
    { error: 'people_not_allowed', status: 400, imageIds: [b.id], allowed: ['none'] });
  assert.deepEqual((await svc.setSlot('footerPool', { imageIds: [a.id, b.id] }, 'x')).imageIds, [a.id, b.id]);
  assert.deepEqual((await svc.adminState()).slots.find(s => s.id === 'shop').draft, [], 'refused setSlot changed nothing');

  // Publish: a still drafted in gyms; b drafted directly (as an older draft would be). Refused under
  // the lock, nothing uploaded, no snapshot.
  await db('HeroSlotDraft').insert({ slotId: 'shop', imageId: b.id, position: 0, updatedBy: 'x', updatedAt: new Date() });
  const count = await publicationCount();
  const r = await svc.publish({}, 'x');
  assert.deepEqual([r.error, r.status, [...r.imageIds].sort()], ['people_not_allowed', 400, [a.id, b.id].sort()]);
  assert.equal(stores.pub.size, 4, 'b got no public files');
  assert.equal(await publicationCount(), count, 'no snapshot');

  // Rollback to a snapshot holding a: refused, listing it.
  await svc.setSlot('gyms', { imageIds: [] }, 'x');
  await svc.setSlot('shop', { imageIds: [] }, 'x');
  assert.ok((await svc.publish({}, 'x')).publication);
  assert.deepEqual(await svc.rollback({ publicationId: p1.id }, 'x'),
    { error: 'people_not_allowed', status: 400, imageIds: [a.id], allowed: ['none'] });
  assert.deepEqual((await svc.manifest()).body.slots, {}, 'nothing restored');

  // Re-confirmed as no people: allowed again.
  assert.ok((await svc.update(a.id, { people: 'none', rightsConfirmed: true, noFacesConfirmed: true }, 'x')).image);
  assert.ok((await svc.rollback({ publicationId: p1.id }, 'x')).publication);
  assert.ok((await svc.setSlot('shop', { imageIds: [a.id] }, 'x')).slot);
});

test('rollback cannot bring back a photo unpublished after that snapshot (409 image_unpublished)', async () => {
  await clearHeroTables();
  const stores = memoryStores();
  const svc = service(stores);
  const a = (await uploadVia(svc, await photo(1600, 1000))).image;
  const b = (await uploadVia(svc, await photo(1600, 1000))).image;
  await svc.setSlot('gyms', { imageIds: [a.id, b.id] }, 'x');
  const p1 = (await svc.publish({}, 'x')).publication;
  await svc.setSlot('shop', { imageIds: [b.id] }, 'x');
  const p1b = (await svc.publish({}, 'x')).publication;

  const un = await svc.unpublish(a.id, { note: 'takedown' }, 'x');
  assert.equal(un.rollbackBlockedBefore, un.publication.id);
  assert.equal((await db('HeroImage').where({ id: a.id }).first()).unpublishedInPublication, String(un.publication.id));
  assert.equal((await svc.adminState()).images.find(i => i.id === a.id).unpublishedInPublication, un.publication.id);
  assert.equal((await svc.adminState()).images.find(i => i.id === b.id).unpublishedInPublication, null);

  for (const p of [p1, p1b]) {
    assert.deepEqual(await svc.rollback({ publicationId: p.id }, 'x'), { error: 'image_unpublished', status: 409, imageIds: [a.id] });
  }
  const live = await svc.manifest();
  assert.equal(live.body.version, un.publication.id, 'still the takedown snapshot');
  assert.deepEqual(live.body.slots.gyms.map(e => e.sourceId), [b.id]);
  assert.deepEqual((await svc.adminState()).slots.find(s => s.id === 'gyms').draft, [a.id, b.id], 'refused rollback left the drafts alone');

  // Published again on purpose (still in the gyms draft): that newer snapshot can be restored.
  const p3 = (await svc.publish({}, 'x')).publication;
  assert.deepEqual(p3.slots.gyms, [a.id, b.id]);
  await svc.setSlot('gyms', { imageIds: [b.id] }, 'x');
  await svc.publish({}, 'x');
  assert.ok((await svc.rollback({ publicationId: p3.id }, 'x')).publication);
  assert.equal((await svc.rollback({ publicationId: p1.id }, 'x')).error, 'image_unpublished', 'older ones stay blocked');
  // A second takedown moves the line forward.
  const un2 = await svc.unpublish(a.id, {}, 'x');
  assert.equal((await svc.rollback({ publicationId: p3.id }, 'x')).error, 'image_unpublished');
  assert.equal(un2.rollbackBlockedBefore, un2.publication.id);
});

test('publish: a hung public upload times out, releases the lock, writes no snapshot and records the orphans', async () => {
  assert.equal(HERO_PUBLIC_UPLOAD_TIMEOUT_MS, 30_000);
  await clearHeroTables();
  const stores = memoryStores();
  const a = (await uploadVia(service(stores), await photo(1600, 1000))).image;
  await service(stores).setSlot('gyms', { imageIds: [a.id] }, 'x');
  let puts = 0;
  let land;
  let hungAt = 0;
  const hanging = {
    async put(...args) {
      puts += 1;
      if (puts === 2) { hungAt = Date.now(); await new Promise((resolve) => { land = resolve; }); } // hangs until released
      return stores.publicStore.put(...args);
    },
  };
  const logged = [];
  const svc = service({ ...stores, publicStore: hanging }, { uploadTimeoutMs: 100, logger: { error: (...x) => logged.push(x.join(' ')) } });
  const r = await svc.publish({}, 'x');
  assert.ok(hungAt && Date.now() - hungAt < 5_000, 'gave up on the hung upload (100 ms limit), did not wait for it');
  assert.deepEqual([r.error, r.status, r.imageId, r.reason], ['storage_service_unavailable', 503, a.id, 'upload_timeout']);
  assert.equal(await publicationCount(), 0, 'no snapshot');
  assert.deepEqual([(await db('HeroImage').where({ id: a.id }).first()).variants, (await db('HeroImage').where({ id: a.id }).first()).status], [null, 'draft']);
  const orphan = (await heroAudit()).find(x => x.action === 'hero_image_orphaned_public_files');
  assert.equal(orphan.target, a.id);
  assert.equal(orphan.after.urls.length, 1, 'the 2x file made before the hang');
  assert.equal(orphan.after.timedOutFile, `${a.id}-1x.webp`);
  assert.equal(orphan.after.timeoutMs, 100);

  // The lock was released: another hero write and a clean publish go through at once.
  assert.ok((await service(stores).setSlot('shop', { imageIds: [a.id] }, 'x')).slot);
  const ok = await service(stores).publish({}, 'x');
  assert.ok(ok.publication, JSON.stringify(ok));

  // The hung upload finally lands: logged as an orphan.
  land();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(logged.some(l => l.includes('landed after timeout') && l.includes(a.id)), logged.join('\n'));
});
