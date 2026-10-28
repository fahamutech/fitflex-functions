// Security fix 2026-10-29: partner-supplied image sources and /storage/upload.
// 1. Images the apps show to other people (vendor logo/banner, product images, trainer photos, gym
//    photos, account photo) accept only a data:image/(png|jpeg|webp) URI that really decodes, or our
//    own /storage/<cid>/<file> path. Any other host or scheme → 400 invalid_media_src. A value already
//    stored on the record is accepted unchanged.
// 2. /storage/upload: only staff, partners, organizers, company HR or an active B2B seat; byte-level
//    format check (no SVG); per-user rate limit; one audit row per upload.
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
import { shopService, trainerService, ownerGymService, accountService, trainers, users, gyms } from '../src/bootstrap/services.mjs';
import { mediaSrcProblem, mediaSrcShapeProblem, checkMediaFields, isStoragePath, mediaSrcMaxBytes } from '../src/shared/media-src.mjs';
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

const made = { users: [], gyms: [], trainers: [], products: [], orgs: [] };
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
  await db.destroy();
});

beforeEach(() => resetStorageUploadLimits());

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
  for (const p of ['/storage/../admin', '/storage/a/..', '/storage/a/b%2fc', '/storage/a/b?x=1', '/storage/a', '/storage/a/b c.png']) {
    assert.equal(await mediaSrcProblem(p), 'invalid_storage_path', p);
  }
  assert.equal(await mediaSrcProblem('/static/a/b.png'), 'scheme_not_allowed');
  assert.equal(await mediaSrcProblem(123), 'not_a_string');
  assert.equal(await mediaSrcProblem(''), 'empty');
});

test('validator: oversize is refused (default 2 MB decoded, before decoding) and huge dimensions are refused', async () => {
  assert.equal(mediaSrcMaxBytes({}), 2 * 1024 * 1024);
  assert.equal(mediaSrcMaxBytes({ MEDIA_SRC_MAX_BYTES: '1500000' }), 1_500_000);
  const over = `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 3).toString('base64')}`;
  assert.equal(mediaSrcShapeProblem(over), 'too_large');
  assert.equal(await mediaSrcProblem(over), 'too_large');
  // A real image just over a small cap.
  const noisy = await sharp({ create: { width: 200, height: 200, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toBuffer();
  assert.equal(await mediaSrcProblem(dataUri('png', noisy), { maxBytes: noisy.length - 1 }), 'too_large');
  assert.equal(await mediaSrcProblem(dataUri('png', noisy), { maxBytes: noisy.length }), null);
  const tall = await sharp({ create: { width: 1, height: 5000, channels: 3, background: '#000' } }).png().toBuffer();
  assert.equal(await mediaSrcProblem(dataUri('png', tall)), 'image_too_large');
});

test('checkMediaFields: names the field and index; a value already stored is kept as is', async () => {
  const bad = await checkMediaFields({ logo: dataUri('png', PNG), images: [STORAGE, BAD.otherHost] });
  assert.deepEqual(bad, { error: 'invalid_media_src', status: 400, field: 'images', index: 1, reason: 'scheme_not_allowed' });
  assert.equal(await checkMediaFields({ images: [STORAGE, BAD.otherHost] }, { kept: [BAD.otherHost] }), null);
  assert.equal(await checkMediaFields({ logo: undefined, banner: null, photoUrl: '' }), null);
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

test('/storage/upload: a member with an active B2B organisation seat may upload (proof of payment); a removed seat may not', async () => {
  const member = await user('member');
  const orgId = uid('b2b');
  await db('B2BOrganization').insert({ id: orgId, organizationType: 'employer', legalName: 'Media Org Ltd', status: 'active' });
  made.orgs.push(orgId);
  const seatId = uid('b2bu');
  await db('B2BOrganizationUser').insert({ id: seatId, organizationId: orgId, userId: member, role: 'finance', status: 'active' });
  const ok = await upload({ sub: member, userType: 'member' }, JPEG, { filename: 'proof.jpg', contentType: 'image/jpeg' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await db('B2BOrganizationUser').where({ id: seatId }).update({ status: 'removed', removedAt: new Date() });
  const refused = await upload({ sub: member, userType: 'member' }, JPEG, { filename: 'proof.jpg', contentType: 'image/jpeg' });
  assert.equal(refused.status, 403);
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
