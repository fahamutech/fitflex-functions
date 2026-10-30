// Security fix 2026-10-28: partner-supplied image sources and /storage/upload.
// 1. Images the apps show to other people (vendor logo/banner, product images, trainer photos, gym
//    photos, account photo) accept only a data:image/(png|jpeg|webp) URI that really decodes, or our
//    own /storage/<cid>/<file> path. Any other host or scheme → 400 invalid_media_src. A value already
//    stored in the same field of the record is accepted unchanged. Sign-in provider photos are kept
//    only from an allowed host. Gallery caps and a per-person decode rate limit.
// 2. /storage/upload: only staff, partners, organizers, company HR or an active billing seat (active or pending org);
//    byte-level format check (no SVG); per-person rate limit first; one audit row per upload, and
//    per refusal (never the file).
// Service tests use the CI database; route tests mount every function file the way bfast does,
// against a local Zebra stand-in.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import FormData from 'form-data';
import sharp from 'sharp';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { parseMultipartRequest } from '../src/infra/storage-client.mjs';
import { shopService, trainerService, ownerGymService, accountService, authService, trainers, users, gyms, products } from '../src/bootstrap/services.mjs';
import { mediaSrcProblem, mediaSrcShapeProblem, checkMediaFields, isStoragePath, mediaSrcMaxBytes, signInPhotoOrNull, copyablePhotoOrNull, resetMediaDecodeLimits, MEDIA_DECODE_RATE } from '../src/shared/media-src.mjs';
import { documentLogoUrl } from '../src/shared/vendor-documents.mjs';
import { resetStorageUploadLimits, UPLOAD_RATE_LIMITS, MAX_UPLOAD_BYTES } from '../functions/storage.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

await ensureInit();

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

// ── Fixtures ────────────────────────────────────────────────────────────────

const picture = (format, size = 8) => sharp({ create: { width: size, height: size, channels: 3, background: { r: 31, g: 122, b: 58 } } })[format]().toBuffer();
const dataUri = (mime, buf) => `data:image/${mime};base64,${buf.toString('base64')}`;
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://tracker.example/p.png"/></svg>');
let PNG; let JPEG; let WEBP; let GIF;
const STORAGE = '/storage/bafyabc123/logo.webp';
const BAD = {
  otherHost: 'https://tracker.example/pixel.png',
  plainHttp: 'http://tracker.example/pixel.png',
  protocolRelative: '//tracker.example/pixel.png',
  javascript: 'javascript:alert(1)',
  svgDataUri: `data:image/svg+xml;base64,${SVG.toString('base64')}`,
  file: 'file:///etc/passwd',
};

const made = { users: [], gyms: [], trainers: [], products: [], orgs: [], persons: [] };
let zebraFails = false;
async function user(userType, extra = {}) {
  const id = uid(userType === 'admin' ? 'adm' : 'usr');
  await users.upsertAsync(u => u.id === id, { id, userType, displayName: `Media ${userType}`, accountStatus: 'active', approvalStatus: 'approved', createdAt: new Date().toISOString(), ...extra });
  made.users.push(id);
  return id;
}

// ── A local Zebra and every route, mounted as bfast does ────────────────────

let zebra; let server; let base; let zebraCount = 0;
before(async () => {
  [PNG, JPEG, WEBP, GIF] = await Promise.all([picture('png'), picture('jpeg'), picture('webp'), picture('gif')]);
  zebra = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/storage') {
      const { files } = await parseMultipartRequest(req);
      if (zebraFails) { res.statusCode = 500; return res.end('internal zebra detail: db host 10.0.0.7'); }
      zebraCount += 1;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ urls: [`/storage/bafymedia${zebraCount}/${files[0].filename}`] }));
    }
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
  app.use(express.json({ limit: '20mb' }));
  mountGuards(Object.keys(functions).filter(k => functions[k].onGuard), functions, app);
  mountHttpRoutes(Object.keys(functions).filter(k => functions[k].onRequest), functions, app);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  delete process.env.ZEBRA_BASE_URL;
  server?.close();
  await new Promise(resolve => zebra.close(resolve));
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('B2BOrganizationUser').whereIn('userId', made.users).del();
  await db('B2BOrganization').whereIn('id', made.orgs).del();
  await db('Product').whereIn('id', made.products).del();
  await db('TrainerProfileGym').whereIn('trainerId', made.trainers).del();
  await db('TrainerProfile').whereIn('id', made.trainers).del();
  await db('Gym').whereIn('id', made.gyms).del();
  await db('User').whereIn('id', made.users).del();
  await db('Person').whereIn('id', made.persons).del();
  await db.destroy();
});

beforeEach(() => { resetStorageUploadLimits(); resetMediaDecodeLimits(); zebraFails = false; });

async function hit(method, url, { claims, body } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, headers: res.headers };
}
async function upload(claims, buffer, { filename = 'photo.png', contentType = 'image/png' } = {}) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType });
  const res = await fetch(`${base}/storage/upload`, {
    method: 'POST', body: form.getBuffer(),
    headers: { ...form.getHeaders(), ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) },
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

// ── 1. The validator ────────────────────────────────────────────────────────

test('validator: PNG, JPEG and WebP data URIs that decode, and our own storage path, are accepted', async () => {
  assert.equal(await mediaSrcProblem(dataUri('png', PNG)), null);
  assert.equal(await mediaSrcProblem(dataUri('jpeg', JPEG)), null);
  assert.equal(await mediaSrcProblem(dataUri('webp', WEBP)), null);
  // The app labels a picked file by its extension: real raster bytes under another allowed label pass.
  assert.equal(await mediaSrcProblem(dataUri('jpeg', WEBP)), null);
  assert.equal(await mediaSrcProblem(STORAGE), null);
  assert.equal(isStoragePath('/storage/bafy-1_2.3/photo-thumb.webp'), true);
});

test('validator: other hosts, other schemes, SVG and non-image bytes are refused with a reason', async () => {
  assert.equal(await mediaSrcProblem(BAD.otherHost), 'scheme_not_allowed');
  assert.equal(await mediaSrcProblem(BAD.plainHttp), 'scheme_not_allowed');
  assert.equal(await mediaSrcProblem(BAD.protocolRelative), 'scheme_not_allowed');
  assert.equal(await mediaSrcProblem(BAD.javascript), 'scheme_not_allowed');
  assert.equal(await mediaSrcProblem(BAD.file), 'scheme_not_allowed');
  assert.equal(await mediaSrcProblem('JavaScript:alert(1)'), 'scheme_not_allowed');
  assert.equal(await mediaSrcProblem(BAD.svgDataUri), 'data_type_not_allowed');
  assert.equal(await mediaSrcProblem(dataUri('gif', GIF)), 'data_type_not_allowed');
  assert.equal(await mediaSrcProblem('data:text/html;base64,PHNjcmlwdD4='), 'data_type_not_allowed');
  // SVG (or any non-raster) bytes under an allowed label: the decode check catches it.
  assert.equal(await mediaSrcProblem(dataUri('png', SVG)), 'not_an_image');
  assert.equal(await mediaSrcProblem(dataUri('png', GIF)), 'not_an_image');
  assert.equal(await mediaSrcProblem(dataUri('png', Buffer.from('not an image at all'))), 'not_an_image');
  // A truncated PNG fails the full decode.
  const big = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } }).png({ compressionLevel: 0 }).toBuffer();
  assert.equal(await mediaSrcProblem(dataUri('png', big.subarray(0, Math.floor(big.length / 2)))), 'not_an_image');
  assert.equal(await mediaSrcProblem('data:image/png;base64,@@@@'), 'invalid_base64');
  assert.equal(await mediaSrcProblem('data:image/png,rawdata'), 'data_type_not_allowed');
  // Our path shape only: no dot segments, no encoded separators, no query, no other root.
  for (const p of ['/storage/../admin', '/storage/a/..', '/storage/../x.png', '/storage/a/b%2fc', '/storage/a/b%41.png', '/storage/a/b(1).png', '/storage/a/b?x=1', '/storage/a', '/storage/a/b c.png', '/storage/a/b/c.png']) {
    assert.equal(await mediaSrcProblem(p), 'invalid_storage_path', p);
  }
  assert.equal(await mediaSrcProblem('/static/a/b.png'), 'scheme_not_allowed');
  assert.equal(await mediaSrcProblem(123), 'not_a_string');
  assert.equal(await mediaSrcProblem(''), 'empty');
});

test('validator: oversize is refused (default 1.4 MB decoded, before decoding; fits a 2 MB body) and big dimensions are refused', async () => {
  assert.equal(mediaSrcMaxBytes({}), 1_400_000);
  assert.ok(4 * Math.ceil(mediaSrcMaxBytes({}) / 3) + 100 < 2 * 1024 * 1024, 'one data URI fits BFAST_BODY_LIMIT 2mb');
  assert.equal(mediaSrcMaxBytes({ MEDIA_SRC_MAX_BYTES: '1000000' }), 1_000_000);
  const over = `data:image/png;base64,${Buffer.alloc(1_400_003).toString('base64')}`;
  assert.equal(mediaSrcShapeProblem(over), 'too_large');
  assert.equal(await mediaSrcProblem(over), 'too_large');
  // A real image just over a small cap.
  const noisy = await sharp({ create: { width: 200, height: 200, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toBuffer();
  assert.equal(await mediaSrcProblem(dataUri('png', noisy), { maxBytes: noisy.length - 1 }), 'too_large');
  assert.equal(await mediaSrcProblem(dataUri('png', noisy), { maxBytes: noisy.length }), null);
  const tall = await sharp({ create: { width: 1, height: 2049, channels: 3, background: '#000' } }).png().toBuffer();
  assert.equal(await mediaSrcProblem(dataUri('png', tall)), 'image_too_large');
  const square = await sharp({ create: { width: 2049, height: 2049, channels: 3, background: '#000' } }).png().toBuffer();
  assert.equal(await mediaSrcProblem(dataUri('png', square)), 'image_too_large');
  const edge = await sharp({ create: { width: 2048, height: 16, channels: 3, background: '#000' } }).png().toBuffer();
  assert.equal(await mediaSrcProblem(dataUri('png', edge)), null);
});

test('checkMediaFields: names the field and index; a stored value is kept only in its own field', async () => {
  const bad = await checkMediaFields({ logo: dataUri('png', PNG), images: [STORAGE, BAD.otherHost] });
  assert.deepEqual(bad, { error: 'invalid_media_src', status: 400, field: 'images', index: 1, reason: 'scheme_not_allowed' });
  assert.equal(await checkMediaFields({ images: [STORAGE, BAD.otherHost] }, { kept: { images: [BAD.otherHost] } }), null);
  // Not moved to another field: thumbnails → images, logo → banner.
  const moved = await checkMediaFields({ images: [BAD.otherHost] }, { kept: { thumbnails: [BAD.otherHost] } });
  assert.equal(moved?.field, 'images');
  const swapped = await checkMediaFields({ banner: BAD.otherHost }, { kept: { logo: [BAD.otherHost] } });
  assert.equal(swapped?.field, 'banner');
  assert.equal(await checkMediaFields({ logo: undefined, banner: null, photoUrl: '' }), null);
});

test('checkMediaFields: list caps are checked before any decode; decoding saves are rate limited per actor', async () => {
  const many = Array.from({ length: 11 }, () => dataUri('png', PNG));
  assert.deepEqual(await checkMediaFields({ images: many }, { maxItems: { images: 10 } }), { error: 'too_many_images', status: 400, field: 'images', max: 10 });
  for (let i = 0; i < MEDIA_DECODE_RATE.perWindow; i += 1) assert.equal(await checkMediaFields({ logo: dataUri('png', PNG) }, { actor: 'person:a' }), null, `save ${i + 1}`);
  const limited = await checkMediaFields({ logo: dataUri('png', PNG) }, { actor: 'person:a' });
  assert.equal(limited.error, 'rate_limited');
  assert.equal(limited.status, 429);
  assert.ok(limited.retryAfterSeconds >= 1);
  // Nothing to decode (a storage path, or a kept value) is never limited; other people are unaffected.
  assert.equal(await checkMediaFields({ logo: STORAGE }, { actor: 'person:a' }), null);
  assert.equal(await checkMediaFields({ logo: dataUri('png', PNG) }, { actor: 'person:b' }), null);
});

test('sign-in photos: only https on Google photo hosts (or our storage path) are kept; anything else is dropped', () => {
  assert.equal(signInPhotoOrNull('https://lh3.googleusercontent.com/a/abc=s96-c'), 'https://lh3.googleusercontent.com/a/abc=s96-c');
  assert.equal(signInPhotoOrNull(STORAGE), STORAGE);
  for (const v of ['https://evil.example/x.png', 'http://lh3.googleusercontent.com/a/x', 'https://lh3.googleusercontent.com.evil.example/x', 'https://user@lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com:8443/a', 'javascript:alert(1)', dataUri('png', Buffer.from('x')), null, 42]) {
    assert.equal(signInPhotoOrNull(v), null, String(v));
  }
  assert.equal(signInPhotoOrNull('https://cdn.idp.example/p.png', { hosts: ['cdn.idp.example'] }), 'https://cdn.idp.example/p.png');
  assert.equal(copyablePhotoOrNull('https://evil.example/x.png'), null);
  assert.equal(copyablePhotoOrNull(STORAGE), STORAGE);
});

test('Firebase sign-in: a picture on another host is never stored on the account (new or existing)', async () => {
  const devToken = payload => `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const fbUid = uid('fb');
  const first = await authService.firebaseSession({ idToken: devToken({ uid: fbUid, email: `${fbUid}@example.com`, name: 'Picture Test', picture: 'https://evil.example/x.png' }), requestedRole: 'trainer' });
  assert.ok(first.user?.id, JSON.stringify(first));
  made.users.push(first.user.id);
  assert.equal((await db('User').where({ id: first.user.id }).first()).photoUrl, null);
  // Existing account: a later sign-in with a planted picture keeps the stored, allowed photo.
  await db('User').where({ id: first.user.id }).update({ photoUrl: 'https://lh3.googleusercontent.com/a/kept' });
  await users.updateByIdAsync(first.user.id, { photoUrl: 'https://lh3.googleusercontent.com/a/kept' });
  await authService.firebaseSession({ idToken: devToken({ uid: fbUid, email: `${fbUid}@example.com`, picture: 'https://evil.example/y.png' }) });
  assert.equal((await db('User').where({ id: first.user.id }).first()).photoUrl, 'https://lh3.googleusercontent.com/a/kept');
  // An allowed Google photo is taken.
  await authService.firebaseSession({ idToken: devToken({ uid: fbUid, email: `${fbUid}@example.com`, picture: 'https://lh3.googleusercontent.com/a/new' }) });
  assert.equal((await db('User').where({ id: first.user.id }).first()).photoUrl, 'https://lh3.googleusercontent.com/a/new');
});

// ── Vendor profile (PUT /vendor/profile) ────────────────────────────────────

test('vendor profile: a logo or banner on another host, javascript:, SVG or oversize → 400 invalid_media_src, nothing saved', async () => {
  const vendor = await user('vendor', { vendorProfile: { businessName: 'Media Shop', status: 'draft' } });
  const claims = { sub: vendor, userType: 'vendor' };
  const cases = [
    ['logo', BAD.otherHost, 'scheme_not_allowed'],
    ['banner', BAD.javascript, 'scheme_not_allowed'],
    ['logo', BAD.svgDataUri, 'data_type_not_allowed'],
    ['banner', `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 3).toString('base64')}`, 'too_large'],
  ];
  for (const [field, value, reason] of cases) {
    const res = await hit('PUT', '/vendor/profile', { claims, body: { businessName: 'Changed', [field]: value } });
    assert.equal(res.status, 400, `${field} ${reason}`);
    assert.equal(res.body.error, 'invalid_media_src');
    assert.equal(res.body.field, field);
    assert.equal(res.body.reason, reason);
  }
  const stored = await users.findByIdAsync(vendor);
  assert.equal(stored.vendorProfile.businessName, 'Media Shop');
  assert.equal(stored.vendorProfile.logo, undefined);
});

test('vendor profile: a data URI and our storage path are saved; a stored legacy value is kept unchanged', async () => {
  const vendor = await user('vendor', { vendorProfile: { businessName: 'Old Shop', logo: 'https://images.unsplash.com/old-logo', status: 'draft' } });
  const claims = { sub: vendor, userType: 'vendor' };
  const ok = await hit('PUT', '/vendor/profile', { claims, body: { logo: 'https://images.unsplash.com/old-logo', banner: dataUri('webp', WEBP) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.logo, 'https://images.unsplash.com/old-logo');
  assert.equal(ok.body.banner, dataUri('webp', WEBP));
  const next = await hit('PUT', '/vendor/profile', { claims, body: { logo: STORAGE } });
  assert.equal(next.status, 200);
  assert.equal(next.body.logo, STORAGE);
  // Once replaced, the old host is no longer "kept".
  const back = await hit('PUT', '/vendor/profile', { claims, body: { logo: 'https://images.unsplash.com/old-logo' } });
  assert.equal(back.status, 400);
  assert.equal(back.body.error, 'invalid_media_src');
});

// ── Products, trainers, gyms, account photo (service level) ─────────────────

test('product images: another host is refused on create and update; our storage path is accepted', async () => {
  const vendor = await user('vendor', { vendorProfile: { businessName: 'Product Shop', status: 'published' } });
  const refused = await shopService.upsertProduct({ vendorId: vendor, body: { name: 'Bar', category: 'equipment', priceTzs: 1000, images: [BAD.otherHost] } });
  assert.equal(refused.error, 'invalid_media_src');
  assert.equal(refused.field, 'images');
  const created = await shopService.upsertProduct({ vendorId: vendor, body: { name: 'Bar', category: 'equipment', priceTzs: 1000, images: [STORAGE] } });
  assert.ok(created.product?.id, JSON.stringify(created));
  made.products.push(created.product.id);
  const update = await shopService.upsertProduct({ vendorId: vendor, productId: created.product.id, body: { images: [STORAGE, BAD.javascript] } });
  assert.equal(update.error, 'invalid_media_src');
  assert.equal(update.index, 1);
  const kept = await shopService.upsertProduct({ vendorId: vendor, productId: created.product.id, body: { images: [STORAGE], name: 'Bar 2' } });
  assert.equal(kept.error, undefined, JSON.stringify(kept));
});

test('product images: the app\'s inline photo (data URI, far over 500 characters) saves on create and update over HTTP', async () => {
  // What the vendor product form sends: an 800 px WebP at quality 80, inline as a data URI.
  const photo = await sharp({ create: { width: 800, height: 800, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 30 } } }).webp({ quality: 80 }).toBuffer();
  const appPhoto = dataUri('webp', photo);
  assert.ok(appPhoto.length > 500);
  const vendor = await user('vendor', { vendorProfile: { businessName: 'Photo Shop', status: 'published' } });
  const claims = { sub: vendor, userType: 'vendor' };
  const created = await hit('POST', '/vendor/products', { claims, body: { name: 'Mat', category: 'equipment', priceTzs: 1000, images: [appPhoto] } });
  assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 300));
  made.products.push(created.body.id);
  assert.deepEqual(created.body.images, [appPhoto]);
  const second = dataUri('jpeg', JPEG);
  const updated = await hit('PUT', `/vendor/products/${created.body.id}`, { claims, body: { images: [appPhoto, second] } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body).slice(0, 300));
  assert.deepEqual(updated.body.images, [appPhoto, second]);
  // Still refused: an SVG data URI, bytes that are not an image, and a data URI over the 2 MB decoded cap.
  const svg = await shopService.upsertProduct({ vendorId: vendor, body: { name: 'Mat', category: 'equipment', priceTzs: 1000, images: [BAD.svgDataUri] } });
  assert.equal(svg.error, 'invalid_media_src');
  const fake = await shopService.upsertProduct({ vendorId: vendor, body: { name: 'Mat', category: 'equipment', priceTzs: 1000, images: [`data:image/png;base64,${Buffer.alloc(900, 7).toString('base64')}`] } });
  assert.deepEqual([fake.error, fake.reason], ['invalid_media_src', 'not_an_image']);
  const huge = `data:image/png;base64,${Buffer.alloc(mediaSrcMaxBytes() + 3).toString('base64')}`;
  const tooBig = await shopService.upsertProduct({ vendorId: vendor, body: { name: 'Mat', category: 'equipment', priceTzs: 1000, images: [huge] } });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.field, 'images');
  // A non-data string keeps the 500-character cap.
  const longPath = await shopService.upsertProduct({ vendorId: vendor, body: { name: 'Mat', category: 'equipment', priceTzs: 1000, images: [`/storage/bafy/${'a'.repeat(500)}.webp`] } });
  assert.deepEqual([longPath.error, longPath.field], ['invalid_field', 'images']);
});

test('trainer photos: updateProfile and register refuse other hosts; data URIs and kept values pass', async () => {
  const userId = await user('trainer', { photoUrl: 'https://lh3.googleusercontent.com/a/sign-in-photo' });
  const id = uid('trn');
  await trainers.upsertAsync(t => t.id === id, trainerService.normalizeTrainerPayload({ id, userId, displayName: 'Media Trainer', images: ['https://images.unsplash.com/legacy'] }, {}));
  made.trainers.push(id);
  const bad = await trainerService.updateProfile({ userId, body: { images: ['https://images.unsplash.com/legacy', BAD.otherHost] } });
  assert.equal(bad.error, 'invalid_media_src');
  assert.equal(bad.field, 'images');
  assert.equal(bad.index, 1);
  const badPhoto = await trainerService.updateProfile({ userId, body: { photoUrl: BAD.svgDataUri } });
  assert.equal(badPhoto.field, 'photoUrl');
  const badThumb = await trainerService.updateProfile({ userId, body: { images: [STORAGE], imageThumbnails: [BAD.plainHttp] } });
  assert.equal(badThumb.field, 'imageThumbnails');
  const ok = await trainerService.updateProfile({ userId, body: { images: ['https://images.unsplash.com/legacy', dataUri('jpeg', JPEG)] } });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(ok.trainer.images.length, 2);

  // Register: the account's own sign-in photo may be used; a new outside host may not.
  const regUser = await user('trainer', { photoUrl: 'https://lh3.googleusercontent.com/a/another' });
  const account = await users.findByIdAsync(regUser);
  const refused = await trainerService.register({ userId: regUser, user: account, body: { photoUrl: BAD.otherHost, gender: 'female' } });
  assert.equal(refused.error, 'invalid_media_src');
  const registered = await trainerService.register({ userId: regUser, user: account, body: { photoUrl: 'https://lh3.googleusercontent.com/a/another', gender: 'female' } });
  assert.equal(registered.error, undefined, JSON.stringify(registered));
  made.trainers.push(registered.trainer.id);

  // An account photo planted before this fix (another host) is NOT "kept" for the trainer profile.
  const planted = await user('trainer', { photoUrl: 'https://evil.example/x.png' });
  const plantedAccount = await users.findByIdAsync(planted);
  const plantedReg = await trainerService.register({ userId: planted, user: plantedAccount, body: { photoUrl: 'https://evil.example/x.png', gender: 'male' } });
  assert.equal(plantedReg.error, 'invalid_media_src');
  assert.equal(plantedReg.field, 'photoUrl');

  // Thumbnails keep only stored thumbnails: a stored gallery image may not move into them... and the
  // other way round a stored thumbnail may not become a gallery image.
  const thumbUser = await user('trainer');
  const thumbId = uid('trn');
  await trainers.upsertAsync(t => t.id === thumbId, trainerService.normalizeTrainerPayload({ id: thumbId, userId: thumbUser, displayName: 'Thumb Trainer', images: [STORAGE], imageThumbnails: ['https://images.unsplash.com/legacy-thumb'] }, {}));
  made.trainers.push(thumbId);
  const movedUp = await trainerService.updateProfile({ userId: thumbUser, body: { images: ['https://images.unsplash.com/legacy-thumb'] } });
  assert.equal(movedUp.error, 'invalid_media_src');
  // The first image becomes the profile picture, which is checked first: either way it is refused.
  assert.ok(['images', 'photoUrl'].includes(movedUp.field), movedUp.field);
  const tooMany = await trainerService.updateProfile({ userId: thumbUser, body: { images: Array.from({ length: 9 }, () => STORAGE) } });
  assert.equal(tooMany.error, 'too_many_images');
});

test('gym photos: owner create, update and register refuse other hosts; stored photos are kept', async () => {
  const ownerId = await user('gym_operator', { gymIds: [] });
  let owner = await users.findByIdAsync(ownerId);
  const refused = await ownerGymService.createGym({ owner, body: { name: 'Media Gym', images: [BAD.otherHost] } });
  assert.equal(refused.error, 'invalid_media_src');
  const refusedThumb = await ownerGymService.createGym({ owner, body: { name: 'Media Gym', images: [STORAGE], thumbnails: [BAD.javascript] } });
  assert.equal(refusedThumb.field, 'thumbnails');
  const gymCount = (await gyms.allAsync()).length;
  const createdGym = await ownerGymService.createGym({ owner, body: { name: 'Media Gym', images: [dataUri('webp', WEBP)], thumbnails: [STORAGE] } });
  assert.ok(createdGym.gym?.id, JSON.stringify(createdGym));
  made.gyms.push(createdGym.gym.id);
  assert.equal((await gyms.allAsync()).length, gymCount + 1);

  // A gym an admin set up with an absolute address keeps it on the owner's next save.
  const legacy = 'https://api.fitflex.example/storage/bafyold/gym.webp';
  await gyms.updateAsync(g => g.id === createdGym.gym.id, { images: [legacy] });
  owner = await users.findByIdAsync(ownerId);
  const keptSave = await ownerGymService.updateGym({ owner, gymId: createdGym.gym.id, body: { name: 'Media Gym 2', images: [legacy, STORAGE] } });
  assert.equal(keptSave.error, undefined, JSON.stringify(keptSave));
  const badSave = await ownerGymService.updateGym({ owner, gymId: createdGym.gym.id, body: { images: [legacy, BAD.otherHost] } });
  assert.equal(badSave.error, 'invalid_media_src');

  // Registration: a bad photo in any gym → nothing is created.
  const regOwnerId = await user('gym_operator');
  const regOwner = await users.findByIdAsync(regOwnerId);
  const before = (await gyms.allAsync()).length;
  const reg = await ownerGymService.registerOwner({ user: regOwner, body: { gyms: [{ name: 'Good', images: [STORAGE] }, { name: 'Bad', imagePaths: [BAD.otherHost] }] } });
  assert.equal(reg.error, 'invalid_media_src');
  assert.equal(reg.gymIndex, 1);
  assert.equal((await gyms.allAsync()).length, before);
});

test('gym photos: at most 10 each; a stored image may be sent as its thumbnail, a stored thumbnail never as an image', async () => {
  const ownerId = await user('gym_operator', { gymIds: [] });
  let owner = await users.findByIdAsync(ownerId);
  const tooMany = await ownerGymService.createGym({ owner, body: { name: 'Big Gym', images: Array.from({ length: 11 }, () => STORAGE) } });
  assert.deepEqual([tooMany.error, tooMany.field, tooMany.max], ['too_many_images', 'images', 10]);
  const created = await ownerGymService.createGym({ owner, body: { name: 'Carry Gym', images: [STORAGE] } });
  made.gyms.push(created.gym.id);
  await gyms.updateAsync(g => g.id === created.gym.id, { images: ['https://images.unsplash.com/legacy-gym'], thumbnails: ['https://images.unsplash.com/legacy-gym-thumb'] });
  owner = await users.findByIdAsync(ownerId);
  // What the app sends for a photo without a recorded thumbnail: the image itself as the thumbnail.
  const asThumb = await ownerGymService.updateGym({ owner, gymId: created.gym.id, body: { images: ['https://images.unsplash.com/legacy-gym'], thumbnails: ['https://images.unsplash.com/legacy-gym'] } });
  assert.equal(asThumb.error, undefined, JSON.stringify(asThumb));
  await gyms.updateAsync(g => g.id === created.gym.id, { thumbnails: ['https://images.unsplash.com/legacy-gym-thumb'] });
  const thumbUp = await ownerGymService.updateGym({ owner, gymId: created.gym.id, body: { images: ['https://images.unsplash.com/legacy-gym-thumb'] } });
  assert.deepEqual([thumbUp.error, thumbUp.field], ['invalid_media_src', 'images']);
});

test('gym with 12 stored photos (before the cap) can still edit hours and shorten its gallery, but never grow it', async () => {
  const ownerId = await user('gym_operator', { gymIds: [] });
  let owner = await users.findByIdAsync(ownerId);
  const created = await ownerGymService.createGym({ owner, body: { name: 'Legacy Big Gym', images: [STORAGE] } });
  made.gyms.push(created.gym.id);
  const twelve = Array.from({ length: 12 }, (_, i) => `/storage/bafyold${i}/photo.webp`);
  await gyms.updateAsync(g => g.id === created.gym.id, { images: twelve, thumbnails: twelve });
  owner = await users.findByIdAsync(ownerId);
  const hours = { mon: { open: '06:00', close: '22:00' } };
  // Photos left out (kept from the stored gym)…
  const onlyHours = await ownerGymService.updateGym({ owner, gymId: created.gym.id, body: { operatingHours: hours } });
  assert.equal(onlyHours.error, undefined, JSON.stringify(onlyHours));
  assert.deepEqual(onlyHours.gym.operatingHours, hours);
  assert.equal(onlyHours.gym.images.length, 12);
  // …or sent back whole, as the app does.
  const resent = await ownerGymService.updateGym({ owner, gymId: created.gym.id, body: { name: 'Legacy Big Gym 2', images: twelve, thumbnails: twelve } });
  assert.equal(resent.error, undefined, JSON.stringify(resent));
  const shorter = await ownerGymService.updateGym({ owner, gymId: created.gym.id, body: { images: twelve.slice(0, 11), thumbnails: twelve.slice(0, 11) } });
  assert.equal(shorter.error, undefined, JSON.stringify(shorter));
  const grown = await ownerGymService.updateGym({ owner, gymId: created.gym.id, body: { images: [...twelve.slice(0, 11), STORAGE, STORAGE] } });
  assert.deepEqual([grown.error, grown.field, grown.max], ['too_many_images', 'images', 10]);
});

test('trainer with 10 stored photos can still edit the bio (gallery sent back) but cannot add an 11th', async () => {
  const userId = await user('trainer');
  const id = uid('trn');
  const ten = Array.from({ length: 10 }, (_, i) => `/storage/bafytrn${i}/photo.webp`);
  await trainers.upsertAsync(t => t.id === id, trainerService.normalizeTrainerPayload({ id, userId, displayName: 'Big Gallery Trainer', images: ten }, {}));
  made.trainers.push(id);
  const bio = await trainerService.updateProfile({ userId, body: { bio: 'New bio', images: ten } });
  assert.equal(bio.error, undefined, JSON.stringify(bio));
  assert.equal(bio.trainer.bio, 'New bio');
  const onlyBio = await trainerService.updateProfile({ userId, body: { bio: 'Again' } });
  assert.equal(onlyBio.error, undefined, JSON.stringify(onlyBio));
  const eleven = await trainerService.updateProfile({ userId, body: { images: [...ten, STORAGE] } });
  assert.equal(eleven.error, 'too_many_images');
});

test('trainer edit: the photo-decode limit counts per person (personId), not per account', async () => {
  const personKey = uid('person');
  const accounts = [];
  for (let i = 0; i < 2; i += 1) {
    const userId = await user('trainer');
    const id = uid('trn');
    await trainers.upsertAsync(t => t.id === id, trainerService.normalizeTrainerPayload({ id, userId, displayName: `Persona ${i}` }, {}));
    made.trainers.push(id);
    accounts.push(userId);
  }
  // A different picture every time, so no save is a "kept" value that needs no decoding.
  const pics = await Promise.all(Array.from({ length: MEDIA_DECODE_RATE.perWindow + 2 }, (_, i) => picture('png', i + 2)));
  for (let i = 0; i < MEDIA_DECODE_RATE.perWindow; i += 1) {
    const r = await trainerService.updateProfile({ userId: accounts[i % 2], personId: personKey, body: { photoUrl: dataUri('png', pics[i]) } });
    assert.equal(r.error, undefined, `save ${i + 1}: ${JSON.stringify(r)}`);
  }
  const limited = await trainerService.updateProfile({ userId: accounts[0], personId: personKey, body: { photoUrl: dataUri('png', pics[MEDIA_DECODE_RATE.perWindow]) } });
  assert.equal(limited.error, 'rate_limited');
  const other = await trainerService.updateProfile({ userId: accounts[1], personId: uid('person'), body: { photoUrl: dataUri('png', pics[MEDIA_DECODE_RATE.perWindow + 1]) } });
  assert.equal(other.error, undefined, 'another person is unaffected');
});

test('product duplicate: a copy keeps the source product\'s old images; a new outside image is still refused', async () => {
  const vendor = await user('vendor', { vendorProfile: { businessName: 'Dup Shop', status: 'published' } });
  const created = await shopService.upsertProduct({ vendorId: vendor, body: { name: 'Mat', category: 'equipment', priceTzs: 1000, images: [STORAGE] } });
  made.products.push(created.product.id);
  await products.updateByIdAsync(created.product.id, { images: ['https://images.unsplash.com/old-product'] });
  const copy = await shopService.duplicateProduct({ vendorId: vendor, productId: created.product.id });
  assert.equal(copy.error, undefined, JSON.stringify(copy));
  made.products.push(copy.product.id);
  assert.deepEqual(copy.product.images, ['https://images.unsplash.com/old-product']);
  const fresh = await shopService.upsertProduct({ vendorId: vendor, body: { name: 'Mat 2', category: 'equipment', priceTzs: 1000, images: ['https://images.unsplash.com/old-product'] } });
  assert.equal(fresh.error, 'invalid_media_src');
});

test('vendor documents: the logo shows only from our storage, resolved to our host; other hosts and data URIs stay off', () => {
  const base = 'https://api.fitflex.example';
  assert.equal(documentLogoUrl(STORAGE, base), `${base}${STORAGE}`);
  assert.equal(documentLogoUrl(`${base}${STORAGE}`, base), `${base}${STORAGE}`);
  assert.equal(documentLogoUrl('https://cdn.example.com/logo.png', base), null);
  assert.equal(documentLogoUrl(`${base}/other/logo.png`, base), null);
  assert.equal(documentLogoUrl(`${base}${STORAGE}?x=1`, base), null);
  assert.equal(documentLogoUrl(dataUri('png', Buffer.from('x')), base), null);
  assert.equal(documentLogoUrl(STORAGE, null), null, 'no PUBLIC_API_URL → no logo');
});

test('owner-created trainer: a photo on another host is refused', async () => {
  const ownerId = await user('gym_operator');
  let owner = await users.findByIdAsync(ownerId);
  const g = await ownerGymService.createGym({ owner, body: { name: 'Trainer Gym' } });
  made.gyms.push(g.gym.id);
  owner = await users.findByIdAsync(ownerId);
  const res = await ownerGymService.createTrainer({ owner, body: { gymId: g.gym.id, displayName: 'New Trainer', email: `${uid('t')}@example.com`, initialPin: '1234', photoUrl: BAD.otherHost } });
  assert.equal(res.error, 'invalid_media_src');
  assert.equal(res.field, 'photoUrl');
});

test('account photo (POST /me/profile): another host refused with the field; data URI and the stored photo accepted', async () => {
  const member = await user('member', { photoUrl: 'https://lh3.googleusercontent.com/a/member' });
  const claims = { sub: member, userType: 'member' };
  const bad = await hit('POST', '/me/profile', { claims, body: { photoUrl: BAD.otherHost } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'invalid_media_src', field: 'photoUrl', reason: 'scheme_not_allowed' });
  const kept = await accountService.updateMemberProfile({ claims, user: await users.findByIdAsync(member), body: { photoUrl: 'https://lh3.googleusercontent.com/a/member', displayName: 'Kept' } });
  assert.equal(kept.error, undefined, JSON.stringify(kept));
  const ok = await hit('POST', '/me/profile', { claims, body: { photoUrl: dataUri('png', PNG) } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

// ── 2. /storage/upload ──────────────────────────────────────────────────────

test('/storage/upload: signed out → 401; a plain member → 403 upload_forbidden (nothing stored)', async () => {
  const before = zebraCount;
  assert.equal((await upload(null, PNG)).status, 401);
  const member = await user('member');
  const res = await upload({ sub: member, userType: 'member' }, PNG);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'upload_forbidden');
  const staff = await user('gym_staff');
  assert.equal((await upload({ sub: staff, userType: 'gym_staff' }, PNG)).status, 403);
  assert.equal(zebraCount, before);
});

test('/storage/upload: partners, staff, organizers and HR may upload; each upload leaves one audit row', async () => {
  for (const userType of ['vendor', 'trainer', 'gym_operator', 'admin', 'event_organizer', 'corporate_hr']) {
    const id = await user(userType);
    const res = await upload({ sub: id, userType }, PNG);
    assert.equal(res.status, 200, `${userType}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.url, /^\/storage\/bafymedia\d+\/photo\.webp$/);
    assert.match(res.body.thumbnailUrl, /^\/storage\/bafymedia\d+\/photo-thumb\.webp$/);
    const rows = await db('AuditLog').where({ actor: id, action: 'storage_upload' });
    assert.equal(rows.length, 1, userType);
    const after = typeof rows[0].after === 'string' ? JSON.parse(rows[0].after) : rows[0].after;
    assert.equal(rows[0].target, res.body.url);
    assert.equal(after.userType, userType);
    assert.equal(after.format, 'png');
  }
});

async function org(status = 'active') {
  const id = uid('b2b');
  await db('B2BOrganization').insert({ id, organizationType: 'employer', legalName: `Media Org ${id}`, status });
  made.orgs.push(id);
  return id;
}
async function seat(userId, organizationId, role, extra = {}) {
  const id = uid('b2bu');
  await db('B2BOrganizationUser').insert({ id, organizationId, userId, role, status: 'active', ...extra });
  return id;
}
const proof = claims => upload(claims, JPEG, { filename: 'proof.jpg', contentType: 'image/jpeg' });

test('/storage/upload: a member with an active billing seat (owner/admin/finance/hr) in an active organisation may upload; a removed seat may not', async () => {
  const activeOrg = await org();
  for (const role of ['owner', 'admin', 'finance', 'hr']) {
    const member = await user('member');
    const seatId = await seat(member, activeOrg, role);
    assert.equal((await proof({ sub: member, userType: 'member' })).status, 200, role);
    if (role === 'finance') {
      await db('B2BOrganizationUser').where({ id: seatId }).update({ status: 'removed', removedAt: new Date() });
      assert.equal((await proof({ sub: member, userType: 'member' })).status, 403, 'removed seat');
    }
  }
});

test('/storage/upload: a non-billing seat, a suspended seat or a seat in an inactive organisation → 403', async () => {
  const activeOrg = await org();
  for (const role of ['viewer', 'analyst', 'manager']) {
    const member = await user('member');
    await seat(member, activeOrg, role);
    assert.equal((await proof({ sub: member, userType: 'member' })).status, 403, role);
  }
  const granted = await user('member');
  await seat(granted, activeOrg, 'viewer', { permissions: ['billing.pay'] });
  assert.equal((await proof({ sub: granted, userType: 'member' })).status, 200, 'explicit billing.pay grant');
  const suspendedSeat = await user('member');
  await seat(suspendedSeat, activeOrg, 'finance', { status: 'suspended' });
  assert.equal((await proof({ sub: suspendedSeat, userType: 'member' })).status, 403, 'suspended seat');
  for (const status of ['suspended', 'inactive']) {
    const closedOrg = await org(status);
    for (const role of ['owner', 'finance']) {
      const member = await user('member');
      await seat(member, closedOrg, role);
      assert.equal((await proof({ sub: member, userType: 'member' })).status, 403, `${status} organisation, ${role}`);
    }
    const grantedClosed = await user('member');
    await seat(grantedClosed, closedOrg, 'viewer', { permissions: ['billing.pay'] });
    assert.equal((await proof({ sub: grantedClosed, userType: 'member' })).status, 403, `${status} organisation, billing.pay grant`);
  }
});

test('/storage/upload: a billing seat in a PENDING organisation may upload proof of payment (owner decision 2026-10-29); non-billing or inactive seats there may not', async () => {
  const pendingOrg = await org('pending');
  for (const role of ['owner', 'admin', 'finance', 'hr']) {
    const member = await user('member');
    await seat(member, pendingOrg, role);
    assert.equal((await proof({ sub: member, userType: 'member' })).status, 200, `pending organisation, ${role}`);
  }
  const granted = await user('member');
  await seat(granted, pendingOrg, 'viewer', { permissions: ['billing.pay'] });
  assert.equal((await proof({ sub: granted, userType: 'member' })).status, 200, 'pending organisation, billing.pay grant');
  for (const role of ['viewer', 'analyst', 'manager']) {
    const member = await user('member');
    await seat(member, pendingOrg, role);
    assert.equal((await proof({ sub: member, userType: 'member' })).status, 403, `pending organisation, ${role}`);
  }
  const suspendedSeat = await user('member');
  await seat(suspendedSeat, pendingOrg, 'finance', { status: 'suspended' });
  assert.equal((await proof({ sub: suspendedSeat, userType: 'member' })).status, 403, 'pending organisation, suspended seat');
  const removed = await user('member');
  await seat(removed, pendingOrg, 'owner', { status: 'removed', removedAt: new Date() });
  assert.equal((await proof({ sub: removed, userType: 'member' })).status, 403, 'pending organisation, removed seat');
});

test('/storage/upload: refusals are audited without the file; storage failures never echo upstream detail', async () => {
  const member = await user('member');
  assert.equal((await upload({ sub: member, userType: 'member' }, PNG)).status, 403);
  const vendor = await user('vendor');
  assert.equal((await upload({ sub: vendor, userType: 'vendor' }, SVG, { filename: 'secret-name.svg', contentType: 'image/svg+xml' })).status, 400);
  const rows = await db('AuditLog').whereIn('actor', [member, vendor]).where({ action: 'storage_upload_refused' }).orderBy('at');
  assert.equal(rows.length, 2);
  const afters = rows.map(r => (typeof r.after === 'string' ? JSON.parse(r.after) : r.after));
  assert.deepEqual(afters.map(a => [a.status, a.error]).sort(), [[400, 'unsupported_file_type'], [403, 'upload_forbidden']]);
  const text = JSON.stringify(rows);
  assert.equal(text.includes('secret-name'), false, 'no file name');
  assert.equal(text.includes('<svg'), false, 'no file contents');

  zebraFails = true;
  const failed = await upload({ sub: vendor, userType: 'vendor' }, PNG);
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: 'storage_upload_failed' });
});

test('/storage/upload: SVG (even labelled PNG), PDF and non-image bytes → 400 unsupported_file_type; over 10 MB → 413', async () => {
  const vendor = await user('vendor');
  const claims = { sub: vendor, userType: 'vendor' };
  const svg = await upload(claims, SVG, { filename: 'x.svg', contentType: 'image/svg+xml' });
  assert.equal(svg.status, 400);
  assert.equal(svg.body.error, 'unsupported_file_type');
  const disguised = await upload(claims, SVG, { filename: 'x.png', contentType: 'image/png' });
  assert.equal(disguised.status, 400);
  assert.equal(disguised.body.error, 'unsupported_file_type');
  const pdf = await upload(claims, Buffer.from('%PDF-1.4\n%…'), { filename: 'x.pdf', contentType: 'application/pdf' });
  assert.equal(pdf.status, 400);
  const junk = await upload(claims, Buffer.from('hello'), { filename: 'x.png', contentType: 'image/png' });
  assert.equal(junk.status, 400);
  const tiff = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).tiff().toBuffer();
  assert.equal((await upload(claims, tiff, { filename: 'x.tiff', contentType: 'image/tiff' })).status, 400);
  const big = await upload(claims, Buffer.alloc(MAX_UPLOAD_BYTES + 1), { filename: 'big.png', contentType: 'image/png' });
  assert.equal(big.status, 413);
  assert.equal(big.body.error, 'file_too_large');
  // WebP and GIF are fine.
  assert.equal((await upload(claims, WEBP, { filename: 'a.webp', contentType: 'image/webp' })).status, 200);
  assert.equal((await upload(claims, GIF, { filename: 'a.gif', contentType: 'image/gif' })).status, 200);
});

test('/storage/upload: rate limited per PERSON across their accounts, before the role check; refusals audited at most 10 a minute', async () => {
  const personId = uid('per');
  await db('Person').insert({ id: personId, updatedAt: new Date() });
  made.persons.push(personId);
  // Two accounts of one person, inserted with the person as identity linking does (the users store
  // never writes personId, and a trigger refuses changing it later).
  const persona = async (userType) => {
    const id = uid('usr');
    await db('User').insert({ id, userType, personId, displayName: `Persona ${userType}`, accountStatus: 'active', approvalStatus: 'approved', createdAt: new Date(), updatedAt: new Date() });
    made.users.push(id);
    return id;
  };
  const vendorPersona = await persona('vendor');
  const memberPersona = await persona('member');
  for (let i = 0; i < UPLOAD_RATE_LIMITS.perMinute; i += 1) {
    assert.equal((await upload({ sub: vendorPersona, userType: 'vendor' }, PNG)).status, 200, `upload ${i + 1}`);
  }
  const otherPersona = await upload({ sub: memberPersona, userType: 'member' }, PNG);
  assert.equal(otherPersona.status, 429, 'the same person on another account shares the limit (and it is checked before the 403)');
  for (let i = 0; i < 15; i += 1) await upload({ sub: memberPersona, userType: 'member' }, PNG);
  const refusals = await db('AuditLog').whereIn('actor', [vendorPersona, memberPersona]).where({ action: 'storage_upload_refused' });
  assert.equal(refusals.length, 10, 'a flood of refusals writes at most 10 rows a minute');
});

test('/storage/upload: rate limited per user (20 a minute) with Retry-After; another user is unaffected', async () => {
  const a = await user('vendor');
  const b = await user('vendor');
  for (let i = 0; i < UPLOAD_RATE_LIMITS.perMinute; i += 1) {
    const res = await upload({ sub: a, userType: 'vendor' }, PNG);
    assert.equal(res.status, 200, `upload ${i + 1}`);
  }
  const limited = await upload({ sub: a, userType: 'vendor' }, PNG);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await upload({ sub: b, userType: 'vendor' }, PNG)).status, 200);
});

test('/storage/:cid/:filename stays public (no sign-in) and redirects to storage', async () => {
  const res = await fetch(`${base}/storage/bafyabc/photo.webp`, { redirect: 'manual' });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), `${process.env.ZEBRA_BASE_URL}/storage/bafyabc/photo.webp`);
});
