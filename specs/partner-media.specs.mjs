// Partner hero photo and logo (PARTNER_MEDIA; plan docs/plans/partner-hero-media-plan.md slice 1,
// design spec photo-hero-screens.md §44.4, owner decisions 2026-10-29).
// - Flag off: every route 404s feature_disabled before sign-in.
// - Tenancy: owners only for their own gyms, gym staff read at their gym and write with `gyms`,
//   trainers only their own profile, vendors and vendor admin staff; members refused; another
//   partner's item reads as 404.
// - Pipeline: EXIF/GPS stripped, SVG / GIF / too-small refused, byte budgets, logo alpha and plate.
// - Live at once; replace / remove / takedown delete the bytes (files 404) and keep the row.
// - O-P2 same file refused after a takedown; O-P5 10 a minute and 20 a day per partner.
// - Admin queue, Looks fine (never one's own), takedown reasons, set by FitFlex (no notice),
//   notifications in the partner's language without the note, audit rows without bytes, ETag/304.
// Routes are mounted the way bfast does, against the real Postgres store (CI database only).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import FormData from 'form-data';
import sharp from 'sharp';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { ensureInit } from '../functions/index.mjs';
import { partnerMediaService, gymService, ownerGymService, adminOwnerService, accountService, trainerService } from '../src/bootstrap/services.mjs';
import { resetPartnerMediaPreviewLimits, partnerMediaSweep } from '../functions/partner-media.mjs';
import { createPartnerMediaService, createJobGate } from '../src/services/partner-media-service.mjs';
import { createPgPartnerMediaStore } from '../src/infra/partner-media-store-pg.mjs';
import { createVendorLimiter } from '../src/shared/vendor-rate-limit.mjs';
import {
  ADMIN_CONFIRMATION, PARTNER_CONFIRMATION, REASON_TEXT, TAKEDOWN_REASONS, takenDownMessage, settingsRoute,
} from '../src/shared/partner-media-rules.mjs';
import { looksLikeSvg, prepareLogoUpload, buildLogoVariants, sniffImageType, pixelSha256, HERO_LIMITS, LOGO_LIMITS } from '../src/infra/hero-image-file.mjs';
import { crc32, deflateSync } from 'node:zlib';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

await ensureInit();

// Never against anything but an isolated CI database.
assert.equal(process.env.FITFLEX_USE_CI_DB, '1', 'partner media specs run only with FITFLEX_USE_CI_DB=1');
assert.match(new URL(process.env.DATABASE_URL_CI).pathname, /^\/fitflex_ci/, 'DATABASE_URL_CI must name a fitflex_ci* database');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const DAY_MS = 86_400_000;

// ── Fixtures ────────────────────────────────────────────────────────────────

const made = { users: [], gyms: [], trainers: [], persons: [], memberships: [], subjects: [] };
async function user(userType, extra = {}) {
  const id = uid(userType.slice(0, 3));
  await db('User').insert({ id, userType, displayName: `PM ${userType} ${id.slice(-4)}`, accountStatus: 'active', updatedAt: new Date(), ...extra });
  made.users.push(id);
  return id;
}
async function gym(name) {
  const id = uid('gym');
  await db('Gym').insert({ id, name, tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
  made.gyms.push(id);
  return id;
}
async function trainerProfile(userId, displayName) {
  const id = uid('trn');
  await db('TrainerProfile').insert({ id, userId, displayName, updatedAt: new Date() });
  made.trainers.push(id);
  return id;
}

/** A photo-like picture (smooth colour + grain), optionally with GPS EXIF. Test fixture only. */
async function photo(width = 1600, height = 1000, { gps = false, format = 'jpeg' } = {}) {
  const small = await sharp(randomBytes(32 * 20 * 3), { raw: { width: 32, height: 20, channels: 3 } }).resize(width, height, { kernel: 'cubic' }).blur(2).png().toBuffer();
  let img = sharp(small);
  if (gps) {
    img = sharp(await img.jpeg({ quality: 90 }).toBuffer()).withExif({
      IFD0: { Make: 'PhoneCo', Model: 'GymCam' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '6/1 48/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '39/1 17/1 0/1' },
    });
  }
  if (format === 'gif') return img.gif().toBuffer();
  if (format === 'png') return img.png().toBuffer();
  return img.jpeg({ quality: 90 }).toBuffer();
}
/** A logo: a solid shape of one colour on a transparent background (PNG). */
async function logo({ width = 512, height = 256, rgb = [20, 30, 40], seed = 0 } = {}) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const inside = x > width * 0.15 && x < width * 0.85 && y > height * 0.2 && y < height * 0.8;
      buf[p] = rgb[0]; buf[p + 1] = rgb[1]; buf[p + 2] = (rgb[2] + seed) % 256; buf[p + 3] = inside ? 255 : 0;
    }
  }
  return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><script>alert(1)</script><rect width="512" height="512" fill="#000"/></svg>');

let PHOTO; let LOGO_DARK; let LOGO_WHITE;
const P = {}; // the people and partners of this run

const HERO_FIELDS = () => ({ rightsConfirmed: 'true', confirmationVersion: PARTNER_CONFIRMATION.version });
const LOGO_FIELDS = () => ({ ...HERO_FIELDS(), ownLogoConfirmed: 'true' });
const ADMIN_ALL = ['moderation', 'moderation_decide', 'brand_media'];
const claimsOf = (id, userType, extra = {}) => ({ sub: id, userType, ...extra });
const adminClaims = (id, acl = ADMIN_ALL) => ({ sub: id, userType: 'admin', portalUser: true, aclPermissions: acl });

let server; let base;

before(async () => {
  [PHOTO, LOGO_DARK, LOGO_WHITE] = await Promise.all([photo(), logo(), logo({ rgb: [250, 250, 250] })]);
  P.gymA = await gym('Mazoezi Arena');
  P.gymB = await gym('Other Gym');
  P.gymC = await gym('Arena Two');
  P.ownerA = await user('gym_operator', { gymIds: [P.gymA, P.gymC] });
  P.ownerB = await user('gym_operator', { gymIds: [P.gymB] });
  P.staffEdit = await user('gym_staff', { gymIds: [P.gymA], aclPermissions: ['gyms', 'checkins'] });
  P.staffRead = await user('gym_staff', { gymIds: [P.gymA], aclPermissions: ['checkins'] });
  P.staffOther = await user('gym_staff', { gymIds: [P.gymB], aclPermissions: ['gyms'] });
  P.trainer1 = await user('trainer');
  P.trainer2 = await user('trainer');
  P.tp1 = await trainerProfile(P.trainer1, 'Coach One');
  P.tp2 = await trainerProfile(P.trainer2, 'Coach Two');
  P.vendor1 = await user('vendor', { approvalStatus: 'approved', vendorProfile: JSON.stringify({ businessName: 'Dar Gear' }) });
  P.vendor2 = await user('vendor', { approvalStatus: 'approved', vendorProfile: JSON.stringify({ businessName: 'Other Shop' }) });
  P.vAdmin = await user('vendor_staff', { vendorId: P.vendor1, vendorRole: 'admin' });
  P.vStaff = await user('vendor_staff', { vendorId: P.vendor1, vendorRole: 'staff', vendorPermissions: ['products'] });
  P.member = await user('member');
  P.modOnly = await user('admin', { portalUser: true, aclPermissions: ['moderation'] });
  P.decider = await user('admin', { portalUser: true, aclPermissions: ['moderation_decide'] });
  P.brand = await user('admin', { portalUser: true, aclPermissions: ['brand_media'] });
  P.super = await user('admin');
  // ownerA reads messages in English; everyone else has no preference (Swahili, the partner-notice default).
  await db('CommunicationPreference').insert({ id: P.ownerA, locale: 'en', updatedAt: new Date() }).onConflict('id').merge();

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
});

const subjectIds = () => [...made.gyms, ...made.trainers, P.vendor1, P.vendor2, ...made.subjects];
async function cleanMedia() {
  const ids = await db('PartnerMedia').whereIn('subjectId', subjectIds()).pluck('id');
  if (ids.length) await db('AuditLog').whereIn('target', ids).del();
  await db('PartnerMedia').whereIn('subjectId', subjectIds()).del();
  await db('PartnerMediaUploadAttempt').where(b => b.whereIn('userId', made.users).orWhereIn('subjectId', subjectIds())).del();
  await db('Notification').whereIn('userId', made.users).where({ type: 'partner_media.taken_down' }).del();
}

after(async () => {
  delete process.env.PARTNER_MEDIA;
  server?.close();
  await cleanMedia();
  if (made.memberships.length) await db('OrgMembership').whereIn('id', made.memberships).del();
  await db('CommunicationPreference').whereIn('id', made.users).del();
  await db('Notification').whereIn('userId', made.users).del();
  await db('TrainerProfile').whereIn('id', made.trainers).del();
  await db('User').whereIn('id', made.users).del();
  if (made.persons.length) await db('Person').whereIn('id', made.persons).del();
  await db('Gym').whereIn('id', made.gyms).del();
  await db.destroy();
});

beforeEach(async () => {
  process.env.PARTNER_MEDIA = '1';
  delete process.env.IDENTITY_V2;
  delete process.env.V2_ORG_AUTHZ;
  partnerMediaService.resetLimits();
  resetPartnerMediaPreviewLimits();
  await cleanMedia();
});

async function hit(method, url, { claims, body, headers = {} } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  let parsed = raw.toString();
  try { parsed = JSON.parse(parsed); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, raw, headers: res.headers };
}
async function uploadReq(url, file, fields, claims, { filename = 'photo.jpg', contentType = 'image/jpeg' } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('file', file, { filename, contentType });
  const res = await fetch(`${base}${url}`, { method: 'POST', body: form.getBuffer(), headers: { ...form.getHeaders(), ...(claims ? { authorization: `Bearer ${sign(claims)}` } : {}) } });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const owner = () => claimsOf(P.ownerA, 'gym_operator');
const heroFor = (claims, extra = {}, file = PHOTO) => uploadReq('/partner/media/hero', file, { ...HERO_FIELDS(), ...extra }, claims);
const logoFor = (claims, extra = {}, file = LOGO_DARK) => uploadReq('/partner/media/logo', file, { ...LOGO_FIELDS(), ...extra }, claims, { filename: 'logo.png', contentType: 'image/png' });
const fileCount = async mediaId => Number((await db('PartnerMediaFile').where({ mediaId }).count({ n: '*' }))[0].n);
const row = id => db('PartnerMedia').where({ id }).first();

// ── Flag ────────────────────────────────────────────────────────────────────

test('flag off: every partner-media route answers 404 feature_disabled before sign-in', async () => {
  delete process.env.PARTNER_MEDIA;
  const routes = [
    ['GET', '/partner/media'], ['POST', '/partner/media/hero'], ['POST', '/partner/media/logo'], ['GET', '/partner/media/x/file'],
    ['GET', '/partner/media/x/file?variant=x2'], ['GET', '/partner/media/x/preview'], ['DELETE', '/partner/media/x'],
    ['GET', '/admin/partner-media'], ['GET', '/admin/partner-media/subjects?type=gym&q=ar'], ['GET', '/admin/partner-media/confirmation'], ['GET', '/admin/partner-media/x/preview'],
    ['POST', '/admin/partner-media/x/reviewed'], ['POST', '/admin/partner-media/x/take-down'], ['POST', '/admin/partner-media'],
    ['PATCH', '/admin/partner-media/x'],
  ];
  for (const [m, u] of routes) {
    const anon = await hit(m, u, { body: m === 'GET' || m === 'DELETE' ? undefined : {} });
    assert.equal(anon.status, 404, `${m} ${u}`);
    assert.deepEqual(anon.body, { error: 'feature_disabled' }, `${m} ${u}`);
    const signedIn = await hit(m, u, { claims: m.includes('admin') || u.startsWith('/admin') ? adminClaims(P.super) : owner() });
    assert.equal(signedIn.status, 404, `${m} ${u} signed in`);
    assert.equal(signedIn.body.error, 'feature_disabled');
  }
});

// ── Server texts and rules ──────────────────────────────────────────────────

test('texts: partner and admin confirmations and every reason exist in English and Swahili, marked draft_pending_counsel; no people texts', async () => {
  for (const c of [PARTNER_CONFIRMATION, ADMIN_CONFIRMATION]) assert.equal(c.status, 'draft_pending_counsel');
  for (const t of [PARTNER_CONFIRMATION.rights, PARTNER_CONFIRMATION.ownLogo, ADMIN_CONFIRMATION.rights, ADMIN_CONFIRMATION.partnerLogo]) {
    assert.ok(t.en?.length > 10 && t.sw?.length > 10);
    assert.notEqual(t.en, t.sw);
  }
  assert.deepEqual(Object.keys(REASON_TEXT).sort(), Object.keys(TAKEDOWN_REASONS).sort());
  for (const r of Object.values(REASON_TEXT)) assert.ok(r.en && r.sw && r.en !== r.sw);
  for (const kind of ['hero', 'logo']) {
    const m = takenDownMessage(kind, 'quality');
    assert.match(m.en.body, /Tap to upload another\.$/);
    assert.match(m.sw.body, /Gusa kupakia nyingine\.$/);
  }
  assert.equal(settingsRoute('gym', 'g 1'), '/owner/brand-media?gymId=g%201');
  assert.equal(settingsRoute('trainer', 'x'), '/trainer/brand-media');
  assert.equal(settingsRoute('vendor', 'x'), '/vendor/brand-media');

  const r = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: owner() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.confirmation, {
    version: PARTNER_CONFIRMATION.version, status: 'draft_pending_counsel',
    rights: { ...PARTNER_CONFIRMATION.rights }, ownLogo: { ...PARTNER_CONFIRMATION.ownLogo },
  });
  assert.deepEqual(r.body.limits.hero, { minWidth: 1080, maxBytes: 15 * 1024 * 1024, maxPixels: 50_000_000, types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] });
  assert.deepEqual(r.body.limits.logo, { minSide: 256, maxSide: 4000, maxBytes: 2 * 1024 * 1024, types: ['image/png', 'image/jpeg', 'image/webp'] });
  // The limits the apps are told are the ones the pipeline enforces.
  assert.equal(r.body.limits.hero.maxPixels, HERO_LIMITS.maxPixels);
  assert.equal(r.body.limits.logo.maxSide, LOGO_LIMITS.maxSide);
  assert.doesNotMatch(JSON.stringify(r.body), /people|faces/i);
  const a = await hit('GET', '/admin/partner-media/confirmation', { claims: adminClaims(P.brand, ['brand_media']) });
  assert.equal(a.status, 200);
  assert.equal(a.body.adminConfirmation.status, 'draft_pending_counsel');
  assert.deepEqual(a.body.adminConfirmation.partnerLogo, { ...ADMIN_CONFIRMATION.partnerLogo });
});

// ── Pipeline ────────────────────────────────────────────────────────────────

test('pipeline: GPS/EXIF stripped from every stored file; photo budgets kept; preview and file are WebP', async () => {
  const gpsPhoto = await photo(1600, 1000, { gps: true });
  assert.ok((await sharp(gpsPhoto).metadata()).exif, 'fixture carries EXIF');
  const up = await heroFor(owner(), { gymId: P.gymA, focalX: '0.25', focalY: '-0.5' }, gpsPhoto);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const { item } = up.body;
  assert.equal(item.status, 'live');
  assert.equal(item.review.state, 'to_review');
  assert.deepEqual(item.focal, { x: 0.25, y: -0.5 });
  assert.equal(typeof item.bright, 'boolean');
  assert.deepEqual(Object.keys(item.files).sort(), ['x1', 'x2']);
  assert.equal(item.files.x2, `/partner/media/${item.id}/file?variant=x2`);
  assert.ok(item.bytes.x2 <= 150 * 1024 && item.bytes.x1 <= 60 * 1024, JSON.stringify(item.bytes));
  assert.equal('people' in item, false);
  const files = await db('PartnerMediaFile').where({ mediaId: item.id });
  assert.deepEqual(files.map(f => f.variant).sort(), ['master', 'p240', 'p480', 'p960', 'x1', 'x2']);
  for (const f of files) {
    const meta = await sharp(f.data).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.exif, undefined, `${f.variant} has no EXIF`);
    assert.equal(meta.xmp, undefined);
    assert.equal(f.byteLength, f.data.length);
  }
  assert.equal((await sharp(files.find(f => f.variant === 'x2').data).metadata()).width, 1080);
  assert.equal((await sharp(files.find(f => f.variant === 'x1').data).metadata()).width, 540);
  // The upload's own hash is stored (O-P2), not the cleaned file's.
  assert.match((await row(item.id)).sha256, /^[0-9a-f]{64}$/);
  const pv = await hit('GET', `/partner/media/${item.id}/preview?w=240`, { claims: owner() });
  assert.equal(pv.status, 200);
  assert.equal(pv.headers.get('cache-control'), 'no-store, private');
  assert.equal((await sharp(pv.raw).metadata()).width, 240);
  assert.equal((await sharp((await hit('GET', `/partner/media/${item.id}/preview`, { claims: owner() })).raw).metadata()).width, 960, 'default 960, never the master');
  assert.match((await row(item.id)).pixelSha256, /^[0-9a-f]{64}$/);
  assert.equal((await hit('GET', `/partner/media/${item.id}/preview?w=100`, { claims: owner() })).body.error, 'invalid_width');
});

test('pipeline: SVG, GIF, too small and too large are refused with their codes; nothing is stored', async () => {
  assert.equal(looksLikeSvg(SVG), true);
  assert.equal(looksLikeSvg(PHOTO), false);
  const cases = [
    [await heroFor(owner(), { gymId: P.gymA }, SVG), 400, 'svg_not_allowed'],
    [await logoFor(owner(), { gymId: P.gymA }, SVG), 400, 'svg_not_allowed'],
    [await heroFor(owner(), { gymId: P.gymA }, await photo(900, 600)), 400, 'image_too_small'],
    [await logoFor(owner(), { gymId: P.gymA }, await logo({ width: 300, height: 200 })), 400, 'image_too_small'],
    [await heroFor(owner(), { gymId: P.gymA }, await photo(1200, 800, { format: 'gif' })), 400, 'unsupported_file_type'],
    [await logoFor(owner(), { gymId: P.gymA }, await photo(600, 400, { format: 'gif' })), 400, 'unsupported_file_type'],
    [await logoFor(owner(), { gymId: P.gymA }, Buffer.concat([await photo(600, 400, { format: 'png' }), randomBytes(2 * 1024 * 1024)])), 413, 'file_too_large'],
    [await heroFor(owner(), { gymId: P.gymA }, Buffer.from('not an image at all')), 400, 'unsupported_file_type'],
    [await heroFor(owner(), { gymId: P.gymA }, null), 400, 'no_file_provided'],
  ];
  for (const [r, status, code] of cases) {
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.error, code);
  }
  partnerMediaService.resetLimits(); // eleven attempts on one gym would pass the minute limit
  const small = await heroFor(owner(), { gymId: P.gymA }, await photo(900, 600));
  assert.deepEqual([small.body.minWidth, small.body.width], [1080, 900]);
  const smallLogo = await logoFor(owner(), { gymId: P.gymA }, await logo({ width: 300, height: 200 }));
  assert.deepEqual([smallLogo.body.minSide, smallLogo.body.width, smallLogo.body.height], [256, 300, 200]);
  assert.equal(Number((await db('PartnerMedia').whereIn('subjectId', subjectIds()).count({ n: '*' }))[0].n), 0);
});

test('pipeline: logos keep transparency, fit 256/128 within 40 KB, and the plate is dark for white logos, light for dark ones; a choice wins', async () => {
  const white = await logoFor(owner(), { gymId: P.gymA }, LOGO_WHITE);
  assert.equal(white.status, 201, JSON.stringify(white.body));
  assert.deepEqual([white.body.item.plate, white.body.item.plateChoice], ['dark', 'auto']);
  assert.equal('focal' in white.body.item, false);
  assert.deepEqual(Object.keys(white.body.item.files).sort(), ['logo128', 'logo256']);
  for (const v of ['logo256', 'logo128']) {
    const f = await db('PartnerMediaFile').where({ mediaId: white.body.item.id, variant: v }).first();
    const meta = await sharp(f.data).metadata();
    assert.equal(meta.hasAlpha, true, `${v} keeps alpha`);
    assert.ok(Math.max(meta.width, meta.height) <= (v === 'logo256' ? 256 : 128));
    assert.ok(f.byteLength <= 40 * 1024);
  }
  const dark = await logoFor(owner(), { gymId: P.gymC }, LOGO_DARK);
  assert.equal(dark.body.item.plate, 'light');
  const chosen = await logoFor(owner(), { gymId: P.gymC, plate: 'dark' }, LOGO_DARK);
  assert.deepEqual([chosen.body.item.plate, chosen.body.item.plateChoice], ['dark', 'dark']);
  assert.equal((await logoFor(owner(), { gymId: P.gymC, plate: 'pink' })).body.error, 'invalid_plate');
  // The pipeline on its own: a JPEG logo (no alpha) is accepted.
  const jpeg = await prepareLogoUpload(await photo(400, 300));
  assert.equal(jpeg.error, undefined);
  const variants = await buildLogoVariants(jpeg.buffer);
  assert.ok(variants.logo256.bytes <= 40 * 1024);
});

// ── Confirmations ───────────────────────────────────────────────────────────

test('confirmations: version, rights and own-logo are required; people fields and bad focal points are refused', async () => {
  const g = { gymId: P.gymA };
  const v = await heroFor(owner(), { ...g, confirmationVersion: 'old' });
  assert.deepEqual([v.status, v.body.error, v.body.current], [400, 'confirmation_version_mismatch', PARTNER_CONFIRMATION.version]);
  assert.equal((await heroFor(owner(), { ...g, rightsConfirmed: 'false' })).body.error, 'rights_confirmation_required');
  assert.equal((await logoFor(owner(), { ...g, ownLogoConfirmed: 'no' })).body.error, 'own_logo_confirmation_required');
  assert.equal((await heroFor(owner(), { ...g, focalX: '2' })).body.error, 'invalid_focal');
  assert.equal((await heroFor(owner(), { ...g, people: 'none' })).body.error, 'unknown_field');
  assert.equal((await heroFor(owner(), { ...g, peopleConfirmed: 'true' })).body.error, 'unknown_field');
});

// ── Tenancy ─────────────────────────────────────────────────────────────────

test('tenancy (gyms): owner A only on their own gyms; staff read at their gym, write only with `gyms`; staff elsewhere refused', async () => {
  const mine = await heroFor(owner(), { gymId: P.gymA });
  assert.equal(mine.status, 201);
  const id = mine.body.item.id;
  assert.deepEqual(mine.body.item.subject, { type: 'gym', id: P.gymA, name: 'Mazoezi Arena' });

  const other = await heroFor(owner(), { gymId: P.gymB });
  assert.deepEqual([other.status, other.body.error], [403, 'not_your_gym']);
  assert.equal((await hit('GET', `/partner/media?gymId=${P.gymB}`, { claims: owner() })).body.error, 'not_your_gym');
  assert.equal((await hit('GET', `/partner/media?gymId=nope`, { claims: owner() })).body.error, 'not_your_gym');
  assert.deepEqual([(await hit('GET', '/partner/media', { claims: owner() })).status, (await hit('GET', '/partner/media', { claims: owner() })).body.error], [400, 'gym_id_required']);

  const ownerB = claimsOf(P.ownerB, 'gym_operator');
  assert.equal((await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: ownerB })).status, 403);
  // Another gym's item reads as not found, never as forbidden.
  for (const [m, u] of [['GET', `/partner/media/${id}/file`], ['GET', `/partner/media/${id}/preview`], ['DELETE', `/partner/media/${id}`]]) {
    const r = await hit(m, u, { claims: ownerB });
    assert.deepEqual([r.status, r.body.error], [404, 'media_not_found'], `${m} ${u}`);
    const s = await hit(m, u, { claims: claimsOf(P.staffOther, 'gym_staff', { aclPermissions: ['gyms'] }) });
    assert.equal(s.status, 404, `staff elsewhere ${m} ${u}`);
  }

  // Staff with `gyms` at gym A: read and write.
  const edit = claimsOf(P.staffEdit, 'gym_staff', { aclPermissions: ['gyms', 'checkins'] });
  const ov = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: edit });
  assert.equal(ov.body.canEdit, true);
  assert.equal((await logoFor(edit, { gymId: P.gymA })).status, 201);

  // Staff without `gyms`: read (the same photo the owner sees), canEdit false, no writes. Even a forged token claim does not help.
  for (const c of [claimsOf(P.staffRead, 'gym_staff', { aclPermissions: ['checkins'] }), claimsOf(P.staffRead, 'gym_staff', { aclPermissions: ['gyms'] })]) {
    const read = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: c });
    assert.equal(read.status, 200);
    assert.equal(read.body.canEdit, false);
    assert.equal(read.body.hero.live.id, id);
    assert.equal((await hit('GET', `/partner/media/${id}/file`, { claims: c })).status, 200);
    const w = await heroFor(c, { gymId: P.gymA });
    assert.deepEqual([w.status, w.body.error, w.body.requiredScope], [403, 'acl_forbidden', 'gyms']);
    assert.deepEqual([(await hit('DELETE', `/partner/media/${id}`, { claims: c })).status], [403]);
  }
  // Staff of gym B with `gyms`: refused on gym A.
  const away = await heroFor(claimsOf(P.staffOther, 'gym_staff', { aclPermissions: ['gyms'] }), { gymId: P.gymA });
  assert.deepEqual([away.status, away.body.error], [403, 'not_your_gym']);
  assert.equal((await row(id)).status, 'live');
});

test('tenancy (trainers, vendors, members): own profile only; vendor admin staff write, other staff read; members refused everywhere', async () => {
  const t1 = claimsOf(P.trainer1, 'trainer'); const t2 = claimsOf(P.trainer2, 'trainer');
  const up = await heroFor(t1);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.deepEqual(up.body.item.subject, { type: 'trainer', id: P.tp1, name: 'Coach One' });
  const id = up.body.item.id;
  assert.equal((await hit('GET', `/partner/media/${id}/file`, { claims: t2 })).status, 404);
  assert.equal((await hit('DELETE', `/partner/media/${id}`, { claims: t2 })).status, 404);
  const t2view = await hit('GET', '/partner/media', { claims: t2 });
  assert.equal(t2view.body.subject.id, P.tp2);
  assert.equal(t2view.body.hero.live, null);
  // A trainer account with no profile.
  const lone = await user('trainer');
  assert.deepEqual([(await hit('GET', '/partner/media', { claims: claimsOf(lone, 'trainer') })).body.error], ['subject_not_found']);

  const vAdmin = claimsOf(P.vAdmin, 'vendor_staff', { vendorId: P.vendor1 });
  const vStaff = claimsOf(P.vStaff, 'vendor_staff', { vendorId: P.vendor1 });
  const vup = await logoFor(vAdmin);
  assert.equal(vup.status, 201, JSON.stringify(vup.body));
  assert.deepEqual(vup.body.item.subject, { type: 'vendor', id: P.vendor1, name: 'Dar Gear' });
  const staffView = await hit('GET', '/partner/media', { claims: vStaff });
  assert.deepEqual([staffView.body.canEdit, staffView.body.logo.live.id], [false, vup.body.item.id]);
  const vw = await heroFor(vStaff);
  assert.deepEqual([vw.status, vw.body.error, vw.body.requiredScope], [403, 'acl_forbidden', 'vendor_admin']);
  assert.equal((await hit('GET', '/partner/media', { claims: claimsOf(P.vendor1, 'vendor') })).body.canEdit, true);
  assert.equal((await hit('GET', `/partner/media/${vup.body.item.id}/file`, { claims: claimsOf(P.vendor2, 'vendor') })).status, 404);
  // Staff whose token names another vendor than their record.
  assert.equal((await hit('GET', '/partner/media', { claims: claimsOf(P.vAdmin, 'vendor_staff', { vendorId: P.vendor2 }) })).body.error, 'acl_forbidden');

  const m = claimsOf(P.member, 'member');
  for (const [method, u] of [['GET', '/partner/media'], ['GET', `/partner/media/${id}/file`], ['DELETE', `/partner/media/${id}`]]) {
    const r = await hit(method, u, { claims: m });
    assert.deepEqual([r.status, r.body.error], [403, 'forbidden'], `${method} ${u}`);
  }
  assert.equal((await heroFor(m)).status, 403);
  // Partners are not admins and admins are not partners.
  assert.equal((await hit('GET', '/admin/partner-media', { claims: owner() })).status, 403);
  assert.equal((await hit('GET', `/partner/media/${id}/file`, { claims: adminClaims(P.super) })).status, 403);
  // Unsigned.
  assert.equal((await hit('GET', `/partner/media/${id}/file`)).status, 401);
});

test('tenancy under V2_ORG_AUTHZ enforce: active memberships at that gym decide, not the legacy gym list', async () => {
  process.env.IDENTITY_V2 = '1';
  process.env.V2_ORG_AUTHZ = 'true';
  const person = uid('per');
  await db('Person').insert({ id: person });
  made.persons.push(person);
  // Legacy rows say gym B; memberships say only gym C (with `gyms`).
  const staff = await user('gym_staff', { gymIds: [P.gymB], aclPermissions: ['gyms'], personId: person });
  const om = uid('om');
  await db('OrgMembership').insert({ id: om, personId: person, personaId: staff, orgType: 'gym', gymId: P.gymC, role: 'staff', status: 'active', aclPermissions: ['gyms'], source: 'sync' });
  made.memberships.push(om);
  const c = claimsOf(staff, 'gym_staff', { aclPermissions: ['gyms'] });
  assert.equal((await hit('GET', `/partner/media?gymId=${P.gymB}`, { claims: c })).body.error, 'not_your_gym');
  const r = await hit('GET', `/partner/media?gymId=${P.gymC}`, { claims: c });
  assert.deepEqual([r.status, r.body.canEdit], [200, true]);
  await db('OrgMembership').where({ id: om }).update({ aclPermissions: ['checkins'] });
  assert.equal((await hit('GET', `/partner/media?gymId=${P.gymC}`, { claims: c })).body.canEdit, false);
  await db('OrgMembership').where({ id: om }).update({ status: 'suspended' });
  assert.equal((await hit('GET', `/partner/media?gymId=${P.gymC}`, { claims: c })).status, 403);
});

// ── Serving, replace, remove ────────────────────────────────────────────────

test('serving: live at once to signed-in readers (private, no-cache, ETag = file id → 304); replace deletes the old bytes in the same step; one live at a time', async () => {
  const first = await heroFor(owner(), { gymId: P.gymA });
  const a = first.body.item;
  const f = await hit('GET', a.files.x2, { claims: owner() });
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/webp');
  assert.equal(f.headers.get('cache-control'), 'private, no-cache');
  const etag = f.headers.get('etag');
  assert.match(etag, /^"pmf_[0-9a-f]{32}"$/);
  const again = await hit('GET', a.files.x2, { claims: owner(), headers: { 'if-none-match': etag } });
  assert.deepEqual([again.status, again.raw.length, again.headers.get('etag')], [304, 0, etag]);
  assert.equal((await hit('GET', a.files.x1, { claims: owner(), headers: { 'if-none-match': etag } })).status, 200, 'another file, another tag');
  assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(f.headers.get('content-disposition'), 'inline');
  assert.equal(Number(f.headers.get('content-length')), a.bytes.x2);
  assert.equal((await hit('GET', `/partner/media/${a.id}/file`, { claims: owner() })).raw.length, a.bytes.x2, 'x2 by default');
  assert.equal((await hit('GET', a.files.x1, { claims: owner() })).raw.length, a.bytes.x1);
  for (const bad of ['master', 'logo256', 'x3']) assert.equal((await hit('GET', `/partner/media/${a.id}/file?variant=${bad}`, { claims: owner() })).body.error, 'invalid_variant');

  const second = await heroFor(owner(), { gymId: P.gymA }, await photo());
  assert.equal(second.status, 201);
  const old = await row(a.id);
  assert.deepEqual([old.status, old.sha256, await fileCount(a.id)], ['replaced', null, 0]);
  assert.equal((await hit('GET', a.files.x2, { claims: owner() })).status, 404);
  assert.equal((await hit('GET', a.files.x2, { claims: owner(), headers: { 'if-none-match': etag } })).status, 404, 'a revalidation of a replaced file is a 404');
  assert.equal((await hit('GET', second.body.item.files.x2, { claims: owner() })).status, 200);
  const live = await db('PartnerMedia').where({ subjectType: 'gym', subjectId: P.gymA, kind: 'hero', status: 'live' });
  assert.deepEqual(live.map(r => r.id), [second.body.item.id]);
  // The database refuses a second live row whatever the code does.
  await assert.rejects(db('PartnerMedia').insert({ ...live[0], id: uid('pmd') }), /partner_media_one_live_uq/);
  // A photo and a logo live side by side; each gym has its own.
  assert.equal((await logoFor(owner(), { gymId: P.gymA })).status, 201);
  assert.equal((await heroFor(owner(), { gymId: P.gymC })).status, 201);
  const ov = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: owner() });
  assert.equal(ov.body.hero.live.id, second.body.item.id);
  assert.equal(ov.body.logo.live.kind, 'logo');
});

test('remove: the partner removes a live item → bytes deleted, file 404, row kept as removed (hash cleared); twice → 409', async () => {
  const up = await logoFor(owner(), { gymId: P.gymA });
  const id = up.body.item.id;
  const r = await hit('DELETE', `/partner/media/${id}`, { claims: owner() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.item.status, 'removed');
  assert.deepEqual(r.body.item.files, {});
  const kept = await row(id);
  assert.deepEqual([kept.status, kept.sha256, kept.statusChangedBy, await fileCount(id)], ['removed', null, P.ownerA, 0]);
  assert.equal((await hit('GET', `/partner/media/${id}/file`, { claims: owner() })).status, 404);
  assert.equal((await hit('GET', `/partner/media/${id}/preview`, { claims: owner() })).status, 404);
  const again = await hit('DELETE', `/partner/media/${id}`, { claims: owner() });
  assert.deepEqual([again.status, again.body.error, again.body.currentStatus], [409, 'not_editable', 'removed']);
  const ov = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: owner() });
  assert.deepEqual([ov.body.logo.live, ov.body.logo.lastTakedown], [null, null]);
});

test('ETag: GET /partner/media answers 304 to a matching If-None-Match and changes after an upload', async () => {
  const one = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: owner() });
  const etag = one.headers.get('etag');
  assert.ok(etag);
  const same = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: owner(), headers: { 'if-none-match': etag } });
  assert.equal(same.status, 304);
  await heroFor(owner(), { gymId: P.gymA });
  const changed = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: owner(), headers: { 'if-none-match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
});

// ── Rate limits (O-P5) ──────────────────────────────────────────────────────

test('rate limits: 10 a minute per person (before the body is read) and per partner; refused attempts count', async () => {
  for (let i = 0; i < 10; i += 1) assert.equal((await heroFor(owner(), { gymId: P.gymA, rightsConfirmed: 'false' })).status, 400);
  const r = await heroFor(owner(), { gymId: P.gymA });
  assert.deepEqual([r.status, r.body.error, r.body.limit, r.body.scope, r.body.max], [429, 'rate_limited', 'minute', 'person', 10]);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  // The person's limit applies to every gym they run, and before anything is parsed: no body at all.
  assert.equal((await heroFor(owner(), { gymId: P.gymC })).body.scope, 'person');
  const bare = await fetch(`${base}/partner/media/hero`, { method: 'POST', headers: { authorization: `Bearer ${sign(owner())}`, 'content-type': 'multipart/form-data; boundary=x' }, body: 'garbage' });
  assert.equal(bare.status, 429, 'refused before the body is read (it is not even valid multipart)');
  // Staff of the same gym share the gym's allowance (10 used): refused per partner.
  const staff = await heroFor(claimsOf(P.staffEdit, 'gym_staff', { aclPermissions: ['gyms'] }), { gymId: P.gymA });
  assert.deepEqual([staff.status, staff.body.scope], [429, 'partner']);
  assert.equal((await heroFor(claimsOf(P.ownerB, 'gym_operator'), { gymId: P.gymB })).status, 201, 'another person and partner');
  // Every admitted attempt is on record (refused ones too), not only saved uploads.
  assert.equal(Number((await db('PartnerMediaUploadAttempt').where({ userId: P.ownerA }).count({ n: '*' }))[0].n), 10);
  // A service clock a minute later: allowed again (a partner not used above).
  let clock = Date.now();
  const svc = createPartnerMediaService({ store: createPgPartnerMediaStore({ db }), now: () => new Date(clock), minuteLimiter: createVendorLimiter({ perMinute: 10 }), logger: { error() {}, warn() {} } });
  const t2 = claimsOf(P.trainer2, 'trainer');
  for (let i = 0; i < 10; i += 1) await svc.upload({ claims: t2, kind: 'hero', fields: {} });
  assert.equal((await svc.upload({ claims: t2, kind: 'hero', fields: {} })).error, 'rate_limited');
  clock += 61_000;
  assert.equal((await svc.upload({ claims: t2, kind: 'hero', fields: {} })).error, 'confirmation_version_mismatch');
});

test('rate limits (R5): 20 SUCCESSFUL uploads a day per partner; failed attempts have their own 60 a day; 40 a day per person', async () => {
  const at = new Date(Date.now() - 3_600_000);
  // 19 earlier successful uploads on trainer 1's profile (since replaced).
  await db('PartnerMedia').insert(Array.from({ length: 19 }, (_, i) => ({
    id: uid('pmd'), subjectType: 'trainer', subjectId: P.tp1, kind: i % 2 ? 'logo' : 'hero', origin: 'partner', status: 'replaced',
    width: 1600, height: 1000, ...(i % 2 ? { plate: 'light', plateChoice: 'auto' } : { focalX: 0, focalY: 0 }),
    confirmationVersion: PARTNER_CONFIRMATION.version, rightsConfirmedBy: P.trainer1, rightsConfirmedAt: at, uploadedBy: P.trainer1, uploadedByRole: 'trainer',
    createdAt: at, updatedAt: at,
  })));
  const t1 = claimsOf(P.trainer1, 'trainer');
  assert.equal((await heroFor(t1, { rightsConfirmed: 'false' })).status, 400, 'a refused attempt does not use one of the 20');
  assert.equal((await heroFor(t1)).status, 201, 'the 20th successful upload of the day');
  const r = await heroFor(t1);
  assert.deepEqual([r.status, r.body.error, r.body.limit, r.body.scope, r.body.max], [429, 'rate_limited', 'day', 'partner', 20]);
  // Older than a day: no longer counted.
  await db('PartnerMedia').where({ subjectId: P.tp1 }).where('createdAt', '<', new Date(Date.now() - 60_000)).update({ createdAt: new Date(Date.now() - DAY_MS - 3_600_000) });
  assert.equal((await heroFor(t1, {}, await photo())).status, 201);

  // A teammate's 25 failed attempts today do not lock the owner out of gym A.
  const failed = n => Array.from({ length: n }, () => ({ id: uid('pma'), userId: P.staffEdit, subjectType: 'gym', createdAt: at }));
  await db('PartnerMediaUploadAttempt').insert(failed(25).map(x => ({ ...x, subjectId: P.gymA })));
  assert.equal((await heroFor(owner(), { gymId: P.gymA })).status, 201);
  // But attempts have their own cap: 60 a day per partner, whatever their outcome.
  await db('PartnerMediaUploadAttempt').insert(failed(60).map(x => ({ ...x, subjectId: P.gymC })));
  const a = await heroFor(owner(), { gymId: P.gymC });
  assert.deepEqual([a.status, a.body.limit, a.body.scope, a.body.max], [429, 'day', 'partner_attempts', 60]);

  // Per person across every gym they run: 40 attempts a day, wherever they were spent.
  await db('PartnerMediaUploadAttempt').insert(Array.from({ length: 40 }, (_, i) => ({ id: uid('pma'), userId: P.ownerA, subjectType: 'gym', subjectId: i % 2 ? P.gymA : P.gymC, createdAt: at })));
  const p = await heroFor(owner(), { gymId: P.gymA });
  assert.deepEqual([p.status, p.body.limit, p.body.scope, p.body.max], [429, 'day', 'person', 40]);
  // The sweep deletes attempts older than two days.
  await db('PartnerMediaUploadAttempt').where({ userId: P.ownerA }).update({ createdAt: new Date(Date.now() - 3 * DAY_MS) });
  const swept = await partnerMediaService.sweep();
  assert.ok(swept.attemptsDeleted >= 40);
});

// ── Admin: queue, review, takedown ──────────────────────────────────────────

test('admin queue: to_review is live partner uploads oldest first; live newest first; filters and search; scopes', async () => {
  const g = await heroFor(owner(), { gymId: P.gymA });
  const t = await heroFor(claimsOf(P.trainer1, 'trainer'));
  const v = await logoFor(claimsOf(P.vendor1, 'vendor'));
  const set = await adminSetReq(adminClaims(P.brand, ['brand_media']), { subjectType: 'gym', subjectId: P.gymC, kind: 'hero' }, PHOTO);
  assert.equal(set.status, 201, JSON.stringify(set.body));
  const mod = adminClaims(P.modOnly, ['moderation']);
  const q = await hit('GET', '/admin/partner-media', { claims: mod });
  assert.equal(q.status, 200);
  const ours = q.body.items.filter(i => subjectIds().includes(i.subject.id));
  assert.deepEqual(ours.map(i => i.id), [g.body.item.id, t.body.item.id, v.body.item.id], 'oldest first; the FitFlex-set item is not here');
  assert.deepEqual(ours[0].subject, { type: 'gym', id: P.gymA, name: 'Mazoezi Arena' });
  assert.equal(ours[0].files, null);
  assert.equal(ours[0].previewUrl, `/admin/partner-media/${g.body.item.id}/preview`);
  assert.equal(ours[0].uploadedByName, `PM gym_operator ${P.ownerA.slice(-4)}`);
  const live = await hit('GET', '/admin/partner-media?tab=live&subjectType=gym', { claims: mod });
  const liveOurs = live.body.items.filter(i => subjectIds().includes(i.subject.id));
  assert.deepEqual(liveOurs.map(i => i.id), [set.body.item.id, g.body.item.id]);
  const search = await hit('GET', '/admin/partner-media?tab=live&q=dar%20ge', { claims: mod });
  assert.deepEqual(search.body.items.map(i => i.id), [v.body.item.id]);
  assert.deepEqual((await hit('GET', `/admin/partner-media?tab=live&type=trainer&kind=hero&subjectId=${P.tp1}`, { claims: mod })).body.items.map(i => i.id), [t.body.item.id]);
  assert.equal((await hit('GET', '/admin/partner-media?tab=pending', { claims: mod })).body.error, 'invalid_tab');
  const pv = await hit('GET', `/admin/partner-media/${g.body.item.id}/preview?w=480`, { claims: mod });
  assert.deepEqual([pv.status, pv.headers.get('cache-control')], [200, 'no-store, private']);
  // moderation only: no decisions, no setting.
  assert.equal((await hit('POST', `/admin/partner-media/${g.body.item.id}/reviewed`, { claims: mod, body: { revision: 1 } })).body.error, 'acl_forbidden');
  assert.equal((await hit('POST', `/admin/partner-media/${g.body.item.id}/take-down`, { claims: mod, body: { revision: 1, reason: 'quality' } })).status, 403);
  assert.equal((await adminSetReq(mod, { subjectType: 'gym', subjectId: P.gymA, kind: 'hero' }, PHOTO)).status, 403);
  assert.equal((await hit('GET', '/admin/partner-media', { claims: adminClaims(P.brand, ['promotions']) })).status, 403);
});

async function adminSetReq(claims, fields, file, { logo: isLogo = false } = {}) {
  return uploadReq('/admin/partner-media', file, {
    rightsConfirmed: 'true', adminConfirmationVersion: ADMIN_CONFIRMATION.version, ...(isLogo ? { partnerLogoConfirmed: 'true' } : {}), ...fields,
  }, claims, isLogo ? { filename: 'logo.png', contentType: 'image/png' } : {});
}

test('Looks fine: needs the revision, refuses one\'s own upload and a stale revision; the item leaves To review and stays live', async () => {
  const up = await heroFor(owner(), { gymId: P.gymA });
  const id = up.body.item.id;
  const decider = adminClaims(P.decider, ['moderation_decide']);
  assert.equal((await hit('POST', `/admin/partner-media/${id}/reviewed`, { claims: decider, body: {} })).body.error, 'revision_required');
  const stale = await hit('POST', `/admin/partner-media/${id}/reviewed`, { claims: decider, body: { revision: 7 } });
  assert.deepEqual([stale.status, stale.body.error, stale.body.revision], [409, 'stale_revision', 1]);
  // Whoever uploaded it never reviews it (reachable when an admin persona also uploaded as a partner).
  const own = await partnerMediaService.markReviewed({ actorId: P.ownerA, id, revision: 1 });
  assert.deepEqual([own.status, own.error], [403, 'own_upload']);
  const ok = await hit('POST', `/admin/partner-media/${id}/reviewed`, { claims: decider, body: { revision: 1 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.item.review.state, ok.body.item.review.by, ok.body.item.status, ok.body.item.revision], ['reviewed', P.decider, 'live', 2]);
  const queue = await hit('GET', '/admin/partner-media', { claims: decider });
  assert.equal(queue.body.items.some(i => i.id === id), false);
  // The partner sees "reviewed" but never who reviewed it.
  const ov = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: owner() });
  assert.equal(ov.body.hero.live.review.state, 'reviewed');
  assert.equal('by' in ov.body.hero.live.review, false);
  assert.equal((await hit('POST', `/admin/partner-media/missing/reviewed`, { claims: decider, body: { revision: 1 } })).status, 404);
});

test('takedown: reason rules; bytes gone and file 404; hash kept; partner told in their language without the note; lastTakedown; the same file is refused', async () => {
  const takenPhoto = await photo();
  const up = await heroFor(owner(), { gymId: P.gymA }, takenPhoto);
  const id = up.body.item.id;
  const decider = adminClaims(P.decider, ['moderation_decide']);
  const td = body => hit('POST', `/admin/partner-media/${id}/take-down`, { claims: decider, body });
  assert.equal((await td({ revision: 1 })).body.error, 'reason_required');
  assert.equal((await td({ revision: 1, reason: 'people' })).body.error, 'invalid_reason');
  assert.deepEqual((await td({ revision: 1, reason: 'not_own_logo' })).body.allowedFor, ['logo'], 'a logo-only reason on a photo');
  assert.equal((await td({ revision: 1, reason: 'other' })).body.error, 'note_required');
  assert.equal((await td({ revision: 1, reason: 'other', note: 'x'.repeat(501) })).body.error, 'note_too_long');
  assert.equal((await td({ reason: 'quality' })).body.error, 'revision_required');
  assert.equal((await td({ revision: 3, reason: 'quality' })).body.error, 'stale_revision');
  const sha = (await row(id)).sha256;
  const ok = await td({ revision: 1, reason: 'person_request', note: 'A member asked us on 28 Oct.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.item.takedown, { reason: 'person_request', note: 'A member asked us on 28 Oct.', by: P.decider, byName: `PM admin ${P.decider.slice(-4)}`, at: ok.body.item.takedown.at });
  const kept = await row(id);
  assert.deepEqual([kept.status, kept.sha256, kept.decidedBy, await fileCount(id)], ['taken_down', sha, P.decider, 0]);
  assert.equal((await hit('GET', `/partner/media/${id}/file`, { claims: owner() })).status, 404);
  assert.equal((await hit('GET', `/admin/partner-media/${id}/preview`, { claims: decider })).status, 404);
  assert.equal((await td({ revision: 2, reason: 'quality' })).body.error, 'not_editable');

  // Notices: the owner (English, chosen) and staff with `gyms` (Swahili); not staff without `gyms`, not another gym.
  const notes = await db('Notification').where({ type: 'partner_media.taken_down' }).whereIn('userId', made.users);
  const byUser = Object.fromEntries(notes.map(n => [n.userId, n]));
  assert.deepEqual(Object.keys(byUser).sort(), [P.ownerA, P.staffEdit].sort());
  assert.equal(byUser[P.ownerA].title, 'Your home photo was taken down');
  assert.equal(byUser[P.ownerA].body, `${REASON_TEXT.person_request.en} Tap to upload another.`);
  assert.equal(byUser[P.staffEdit].title, 'Picha yako ya mwanzo imeondolewa');
  const data = typeof byUser[P.ownerA].data === 'string' ? JSON.parse(byUser[P.ownerA].data) : byUser[P.ownerA].data;
  assert.equal(data.route, `/owner/brand-media?gymId=${encodeURIComponent(P.gymA)}`);
  assert.deepEqual([data.mediaId, data.kind, data.gymId, data.reason], [id, 'hero', P.gymA, 'person_request']);
  for (const n of notes) assert.doesNotMatch(JSON.stringify(n), /A member asked us/, 'the note never travels in a notice');

  // The partner page: taken down with reason and note, no admin names, no files.
  const ov = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: owner() });
  assert.equal(ov.body.hero.live, null);
  assert.deepEqual(ov.body.hero.lastTakedown.takedown, { reason: 'person_request', note: 'A member asked us on 28 Oct.', at: ok.body.item.takedown.at });
  assert.deepEqual(ov.body.hero.lastTakedown.files, {});

  // O-P2: the same file again → refused; another photo → fine, and the takedown notice clears.
  const again = await heroFor(owner(), { gymId: P.gymA }, takenPhoto);
  assert.deepEqual([again.status, again.body.error], [409, 'image_taken_down_before']);
  const sameOwner = await heroFor(owner(), { gymId: P.gymC }, takenPhoto);
  assert.deepEqual([sameOwner.status, sameOwner.body.error], [409, 'image_taken_down_before'], 'any gym of the same owner (review L1)');
  assert.equal((await heroFor(claimsOf(P.ownerB, 'gym_operator'), { gymId: P.gymB }, takenPhoto)).status, 201, 'another owner\'s gym may use it');
  // L1: the same picture with only its metadata changed (a JPEG comment segment added: other bytes,
  // same pixels) is recognised by its decoded pixels.
  const comment = Buffer.from('edited in another app');
  const seg = Buffer.concat([Buffer.from([0xFF, 0xFE, 0x00, comment.length + 2]), comment]);
  const relabelled = Buffer.concat([takenPhoto.subarray(0, 2), seg, takenPhoto.subarray(2)]);
  assert.notEqual(relabelled.length, takenPhoto.length);
  const rr = await heroFor(owner(), { gymId: P.gymA }, relabelled);
  assert.deepEqual([rr.status, rr.body.error], [409, 'image_taken_down_before']);
  const fresh = await heroFor(owner(), { gymId: P.gymA }, await photo());
  assert.equal(fresh.status, 201);
  const after2 = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: owner() });
  assert.deepEqual([after2.body.hero.live.id, after2.body.hero.lastTakedown], [fresh.body.item.id, null]);
  const queue = await hit('GET', '/admin/partner-media?tab=taken_down', { claims: decider });
  assert.ok(queue.body.items.some(i => i.id === id && i.takedown.reason === 'person_request'));
});

test('takedown: vendor and trainer notices go to the vendor and admin staff, and to the trainer; logo wording', async () => {
  const v = await logoFor(claimsOf(P.vendor1, 'vendor'));
  const decider = adminClaims(P.super);
  const r = await hit('POST', `/admin/partner-media/${v.body.item.id}/take-down`, { claims: decider, body: { revision: 1, reason: 'not_own_logo' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = await heroFor(claimsOf(P.trainer1, 'trainer'));
  assert.equal((await hit('POST', `/admin/partner-media/${t.body.item.id}/take-down`, { claims: decider, body: { revision: 1, reason: 'quality' } })).status, 200);
  const notes = await db('Notification').where({ type: 'partner_media.taken_down' }).whereIn('userId', made.users);
  assert.deepEqual(notes.map(n => n.userId).sort(), [P.vendor1, P.vAdmin, P.trainer1].sort());
  assert.equal(notes.find(n => n.userId === P.vendor1).title, 'Nembo yako imeondolewa');
  const td = notes.find(n => n.userId === P.trainer1);
  assert.equal((typeof td.data === 'string' ? JSON.parse(td.data) : td.data).route, '/trainer/brand-media');
});

test('set by FitFlex (brand_media): live and reviewed at once, replaces the live one, no notice, never in To review; PATCH focal/plate; take-down works on it', async () => {
  const brand = adminClaims(P.brand, ['brand_media']);
  const partnerUp = await heroFor(claimsOf(P.trainer1, 'trainer'));
  const bad = await adminSetReq(brand, { subjectType: 'trainer', subjectId: P.tp1, kind: 'hero', adminConfirmationVersion: 'x' }, PHOTO);
  assert.deepEqual([bad.body.error, bad.body.current], ['confirmation_version_mismatch', ADMIN_CONFIRMATION.version]);
  assert.equal((await adminSetReq(brand, { subjectType: 'trainer', subjectId: P.tp1, kind: 'logo' }, LOGO_DARK)).body.error, 'partner_logo_confirmation_required');
  assert.equal((await adminSetReq(brand, { subjectType: 'trainer', subjectId: 'nope', kind: 'hero' }, PHOTO)).body.error, 'subject_not_found');
  assert.equal((await adminSetReq(brand, { subjectType: 'member', subjectId: P.member, kind: 'hero' }, PHOTO)).body.error, 'invalid_subject_type');
  assert.equal((await adminSetReq(brand, { subjectType: 'trainer', subjectId: P.tp1, kind: 'hero', people: 'none' }, PHOTO)).body.error, 'unknown_field');
  const set = await adminSetReq(brand, { subjectType: 'trainer', subjectId: P.tp1, kind: 'hero', focalY: '0.5' }, PHOTO);
  assert.equal(set.status, 201, JSON.stringify(set.body));
  assert.deepEqual([set.body.item.origin, set.body.item.review.state, set.body.item.status, set.body.item.uploadedByRole], ['fitflex', 'reviewed', 'live', 'admin']);
  assert.equal(set.body.item.confirmationVersion, ADMIN_CONFIRMATION.version);
  assert.equal((await row(partnerUp.body.item.id)).status, 'replaced');
  assert.equal(await fileCount(partnerUp.body.item.id), 0);
  const logoSet = await adminSetReq(brand, { subjectType: 'vendor', subjectId: P.vendor1, kind: 'logo' }, LOGO_WHITE, { logo: true });
  assert.equal(logoSet.status, 201, JSON.stringify(logoSet.body));
  assert.equal(logoSet.body.item.plate, 'dark');
  // O-P3: nobody is told.
  assert.equal(Number((await db('Notification').whereIn('userId', made.users).count({ n: '*' }))[0].n), 0);
  // The trainer sees it, without the admin's name.
  const ov = await hit('GET', '/partner/media', { claims: claimsOf(P.trainer1, 'trainer') });
  assert.deepEqual([ov.body.hero.live.id, ov.body.hero.live.origin, ov.body.hero.live.uploadedBy, ov.body.hero.live.uploadedByName, ov.body.hero.live.rightsConfirmedBy], [set.body.item.id, 'fitflex', null, null, null]);
  assert.equal((await hit('GET', ov.body.hero.live.files.x2, { claims: claimsOf(P.trainer1, 'trainer') })).status, 200);
  const q = await hit('GET', '/admin/partner-media', { claims: adminClaims(P.super) });
  assert.equal(q.body.items.some(i => i.id === set.body.item.id || i.id === logoSet.body.item.id), false);

  // PATCH (brand_media).
  const p = body => hit('PATCH', `/admin/partner-media/${set.body.item.id}`, { claims: brand, body });
  assert.equal((await p({})).body.error, 'nothing_to_change');
  assert.equal((await p({ plate: 'dark' })).body.error, 'field_not_applicable');
  assert.equal((await p({ focal: { x: 3, y: 0 } })).body.error, 'invalid_focal');
  assert.equal((await p({ focal: { x: 0, y: 0 }, people: 'none' })).body.error, 'unknown_field');
  assert.equal((await p({ focal: { x: 0, y: 0 }, revision: 9 })).body.error, 'stale_revision');
  const moved = await p({ focal: { x: -0.5, y: 0.25 }, revision: 1 });
  assert.deepEqual([moved.status, moved.body.item.focal, moved.body.item.revision], [200, { x: -0.5, y: 0.25 }, 2]);
  const plate = await hit('PATCH', `/admin/partner-media/${logoSet.body.item.id}`, { claims: brand, body: { plate: 'light' } });
  assert.deepEqual([plate.body.item.plate, plate.body.item.plateChoice], ['light', 'light']);
  const auto = await hit('PATCH', `/admin/partner-media/${logoSet.body.item.id}`, { claims: brand, body: { plate: 'auto' } });
  assert.deepEqual([auto.body.item.plate, auto.body.item.plateChoice], ['dark', 'auto']);
  assert.equal((await hit('PATCH', `/admin/partner-media/${set.body.item.id}`, { claims: adminClaims(P.decider, ['moderation_decide']), body: { focal: { x: 0, y: 0 } } })).status, 403);

  // Take down a FitFlex-set item.
  const td = await hit('POST', `/admin/partner-media/${set.body.item.id}/take-down`, { claims: adminClaims(P.decider, ['moderation_decide']), body: { revision: 2, reason: 'rights' } });
  assert.equal(td.status, 200, JSON.stringify(td.body));
  assert.equal(await fileCount(set.body.item.id), 0);
  // A replaced item can no longer be decided on: gone.
  const gone = await hit('POST', `/admin/partner-media/${partnerUp.body.item.id}/reviewed`, { claims: adminClaims(P.decider, ['moderation_decide']), body: { revision: 2 } });
  assert.deepEqual([gone.status, gone.body.error], [404, 'media_gone']);
});

test('audit: every write adds a partner_media.* row with ids and hashes, never bytes', async () => {
  const a = await heroFor(owner(), { gymId: P.gymA });
  const b = await heroFor(owner(), { gymId: P.gymA }, await photo());
  await hit('POST', `/admin/partner-media/${b.body.item.id}/reviewed`, { claims: adminClaims(P.decider, ['moderation_decide']), body: { revision: 1 } });
  await hit('POST', `/admin/partner-media/${b.body.item.id}/take-down`, { claims: adminClaims(P.decider, ['moderation_decide']), body: { revision: 2, reason: 'quality' } });
  const l = await logoFor(owner(), { gymId: P.gymA });
  await hit('DELETE', `/partner/media/${l.body.item.id}`, { claims: owner() });
  const rows = await db('AuditLog').whereIn('target', [a.body.item.id, b.body.item.id, l.body.item.id]).orderBy('at');
  assert.deepEqual(rows.map(r => `${r.action}:${r.target === a.body.item.id ? 'a' : r.target === b.body.item.id ? 'b' : 'l'}`), [
    'partner_media.uploaded:a', 'partner_media.replaced:a', 'partner_media.uploaded:b', 'partner_media.reviewed:b', 'partner_media.taken_down:b',
    'partner_media.uploaded:l', 'partner_media.removed:l',
  ]);
  for (const r of rows) {
    const text = JSON.stringify([r.before, r.after]);
    assert.ok(text.length < 2000, `${r.action} is small`);
    assert.doesNotMatch(text, /"data"|base64|RIFF/);
  }
  for (const r0 of rows.filter(x => x.action !== 'partner_media.taken_down')) {
    assert.doesNotMatch(JSON.stringify([r0.before, r0.after]), /[0-9a-f]{64}/, `${r0.action} carries no upload hash (review L5)`);
  }
  const takedown = rows.find(r => r.action === 'partner_media.taken_down');
  const after = typeof takedown.after === 'string' ? JSON.parse(takedown.after) : takedown.after;
  assert.match(after.sha256, /^[0-9a-f]{64}$/);
  assert.equal(after.filesDeleted, 6, 'master, x2, x1 and the three previews');
  assert.equal(after.reason, 'quality');
});

// ── Security review of functions#277 ────────────────────────────────────────

const mediaRows = subjectId => db('PartnerMedia').where({ subjectId }).orderBy('createdAt');
const filesOf = async subjectId => Number((await db('PartnerMediaFile').whereIn('mediaId', db('PartnerMedia').where({ subjectId }).select('id')).count({ n: '*' }))[0].n);
const brandSet = (subjectType, subjectId, kind = 'hero', extra = {}, claims = adminClaims(P.super)) =>
  adminSetReq(claims, { subjectType, subjectId, kind, ...extra }, kind === 'logo' ? LOGO_DARK : PHOTO, { logo: kind === 'logo' });

/** Every purged row: bytes gone, not live, hashes and note cleared, purgedAt set. */
async function assertPurged(subjectId, label) {
  const rows = await mediaRows(subjectId);
  assert.ok(rows.length, `${label}: there were items`);
  assert.equal(await filesOf(subjectId), 0, `${label}: bytes deleted`);
  for (const r of rows) {
    assert.ok(r.purgedAt, `${label}: purgedAt`);
    assert.notEqual(r.status, 'live');
    assert.deepEqual([r.sha256, r.pixelSha256, r.reasonNote], [null, null, null], `${label}: hashes and note cleared`);
  }
}

test('M2 purge: admin gym delete and owner gym delete purge that gym; a re-created gym id shows nothing old', async () => {
  // Admin-created gym (no operator, no check-ins): gymService.remove.
  const g = await gymService.upsert({ body: { name: 'Purge Gym', tier: 'standard', location: 'Dar' }, actorId: P.super });
  const gymId = g.gym.id;
  made.subjects.push(gymId);
  const hero = await brandSet('gym', gymId);
  assert.equal(hero.status, 201, JSON.stringify(hero.body));
  const logoItem = await brandSet('gym', gymId, 'logo');
  await hit('POST', `/admin/partner-media/${logoItem.body.item.id}/take-down`, { claims: adminClaims(P.super), body: { revision: 1, reason: 'other', note: 'private note' } });
  assert.equal((await gymService.remove({ id: gymId, actorId: P.super })).error, undefined);
  await assertPurged(gymId, 'gymService.remove');
  assert.equal((await hit('GET', `/admin/partner-media/${hero.body.item.id}/preview`, { claims: adminClaims(P.super) })).status, 404);
  const purgeAudit = await db('AuditLog').where({ action: 'partner_media.purged' }).whereIn('target', [hero.body.item.id, logoItem.body.item.id]);
  assert.equal(purgeAudit.length, 2);
  // R3: not even the taken-down logo's hashes are written into the purge rows.
  for (const r of purgeAudit) assert.doesNotMatch(JSON.stringify([r.before, r.after]), /[0-9a-f]{64}|sha256/i, 'no hashes in purged audit rows');
  // The same id comes back: no live item, no old takedown, nothing in the admin queue.
  await gymService.upsert({ body: { id: gymId, name: 'Purge Gym again', tier: 'standard', location: 'Dar' }, actorId: P.super });
  const reborn = await user('gym_operator', { gymIds: [gymId] });
  const ov = await hit('GET', `/partner/media?gymId=${gymId}`, { claims: claimsOf(reborn, 'gym_operator') });
  assert.equal(ov.status, 200, JSON.stringify(ov.body));
  assert.deepEqual([ov.body.hero.live, ov.body.logo.live, ov.body.logo.lastTakedown], [null, null, null]);
  for (const tab of ['live', 'taken_down']) {
    const q = await hit('GET', `/admin/partner-media?tab=${tab}&subjectId=${gymId}`, { claims: adminClaims(P.super) });
    assert.deepEqual(q.body.items, [], tab);
  }
  // The old file can be uploaded again (its hash went with the purge).
  assert.equal((await heroFor(claimsOf(reborn, 'gym_operator'), { gymId })).status, 201);
  await gymService.remove({ id: gymId, actorId: P.super });
  await db('User').where({ id: reborn }).update({ gymIds: [] });

  // Owner deletes one of their gyms: ownerGymService.deleteGym.
  const g2 = await gymService.upsert({ body: { name: 'Owner Purge', tier: 'standard', location: 'Dar' }, actorId: P.super });
  made.subjects.push(g2.gym.id);
  const own = await user('gym_operator', { gymIds: [g2.gym.id] });
  const ownClaims = claimsOf(own, 'gym_operator');
  assert.equal((await heroFor(ownClaims, { gymId: g2.gym.id })).status, 201);
  assert.equal((await logoFor(ownClaims, { gymId: g2.gym.id })).status, 201);
  const ownerRow = await db('User').where({ id: own }).first();
  assert.deepEqual(await ownerGymService.deleteGym({ owner: ownerRow, gymId: g2.gym.id }), { ok: true });
  await assertPurged(g2.gym.id, 'ownerGymService.deleteGym');
});

test('M2 purge: admin owner delete purges gyms no owner runs any more; self-deletion of a vendor and a trainer; trainer profile delete', async () => {
  // Owner removed by an admin: their sole gym is purged, a gym another owner still runs is kept.
  const gSole = await gym('Sole owner gym'); const gShared = await gym('Shared gym');
  const leaving = await user('gym_operator', { gymIds: [gSole, gShared] });
  await user('gym_operator', { gymIds: [gShared] });
  assert.equal((await heroFor(claimsOf(leaving, 'gym_operator'), { gymId: gSole })).status, 201);
  assert.equal((await heroFor(claimsOf(leaving, 'gym_operator'), { gymId: gShared }, await photo())).status, 201);
  assert.equal((await adminOwnerService.remove({ id: leaving, actorId: P.super })).error, undefined);
  await assertPurged(gSole, 'adminOwnerService.remove');
  assert.equal((await mediaRows(gShared)).filter(r => r.status === 'live' && !r.purgedAt).length, 1, 'the shared gym keeps its photo');

  // A vendor deletes their account.
  const v = await user('vendor', { approvalStatus: 'approved', vendorProfile: JSON.stringify({ businessName: 'Leaving Shop' }) });
  made.subjects.push(v);
  assert.equal((await logoFor(claimsOf(v, 'vendor'))).status, 201);
  const vRow = await db('User').where({ id: v }).first();
  assert.equal((await accountService.deleteMyAccount(vRow)).ok, true);
  await assertPurged(v, 'vendor self-deletion');

  // A trainer deletes their account (the profile goes with it).
  const tu = await user('trainer');
  const tp = await trainerService.adminUpsert({ body: { displayName: 'Leaving Coach', userId: tu }, actorId: P.super });
  made.subjects.push(tp.trainer.id);
  assert.equal((await heroFor(claimsOf(tu, 'trainer'))).status, 201);
  const tRow = await db('User').where({ id: tu }).first();
  assert.equal((await accountService.deleteMyAccount(tRow)).ok, true);
  await assertPurged(tp.trainer.id, 'trainer self-deletion');

  // An admin deletes a trainer profile.
  const tu2 = await user('trainer');
  const tp2 = await trainerService.adminUpsert({ body: { displayName: 'Removed Coach', userId: tu2 }, actorId: P.super });
  made.subjects.push(tp2.trainer.id);
  assert.equal((await heroFor(claimsOf(tu2, 'trainer'))).status, 201);
  assert.equal((await trainerService.adminRemove({ id: tp2.trainer.id, actorId: P.super })).error, undefined);
  await assertPurged(tp2.trainer.id, 'trainerService.adminRemove');
});

test('M2 sweep: media of partners that vanished another way are purged nightly; the admin list and preview hide them meanwhile', async () => {
  const gx = await gym('Vanishing gym');
  const ox = await user('gym_operator', { gymIds: [gx] });
  const up = await heroFor(claimsOf(ox, 'gym_operator'), { gymId: gx });
  assert.equal(up.status, 201);
  const vx = await user('vendor', { approvalStatus: 'approved' });
  made.subjects.push(vx);
  assert.equal((await logoFor(claimsOf(vx, 'vendor'))).status, 201);
  // Gone behind the service's back (e.g. the dev clean-up route), and a vendor closed.
  await db('Gym').where({ id: gx }).del();
  await db('User').where({ id: vx }).update({ accountStatus: 'closed' });
  const q = await hit('GET', '/admin/partner-media?tab=live', { claims: adminClaims(P.super) });
  assert.equal(q.body.items.some(i => [gx, vx].includes(i.subject.id)), false, 'hidden from the queue');
  assert.equal((await hit('GET', `/admin/partner-media/${up.body.item.id}/preview`, { claims: adminClaims(P.super) })).status, 404);
  assert.equal(typeof partnerMediaSweep.onJob, 'function');
  assert.match(partnerMediaSweep.rule, /^\d+ \d+ \* \* \*$/);
  await partnerMediaSweep.onJob();
  await assertPurged(gx, 'sweep (gym)');
  await assertPurged(vx, 'sweep (closed vendor)');
  const again = await partnerMediaService.sweep();
  assert.equal(again.subjects, 0, 'idempotent');
});

test('M3: previews are made at upload and the routes are rate limited per person; one process-wide gate decodes at most two images at once', async () => {
  const up = await heroFor(owner(), { gymId: P.gymA });
  const id = up.body.item.id;
  for (const [w, variant] of [[240, 'p240'], [480, 'p480'], [960, 'p960']]) {
    const f = await db('PartnerMediaFile').where({ mediaId: id, variant }).first();
    assert.equal((await sharp(f.data).metadata()).width, w);
    const r = await hit('GET', `/partner/media/${id}/preview?w=${w}`, { claims: owner() });
    assert.deepEqual(r.raw, Buffer.from(f.data), 'served as stored, not made per request');
  }
  for (let i = 3; i < 120; i += 1) await hit('GET', `/partner/media/${id}/preview?w=240`, { claims: owner() });
  const limited = await hit('GET', `/partner/media/${id}/preview?w=240`, { claims: owner() });
  assert.deepEqual([limited.status, limited.body.error], [429, 'rate_limited']);
  assert.equal((await hit('GET', `/partner/media/${id}/preview?w=240`, { claims: claimsOf(P.staffRead, 'gym_staff') })).status, 200, 'per person');

  const gate = createJobGate({ max: 2, maxWaiting: 1 });
  let running = 0; let peak = 0;
  const release = [];
  const job = () => gate.run(() => new Promise((resolve) => { running += 1; peak = Math.max(peak, running); release.push(() => { running -= 1; resolve('done'); }); }));
  const a = job(); const b = job(); const c = job();
  assert.deepEqual(await job(), { busy: true }, 'beyond the waiting room → busy (503 image_service_busy)');
  await new Promise(r => setImmediate(r));
  assert.deepEqual([running, gate.stats().waiting], [2, 1]);
  release.shift()(); await new Promise(r => setImmediate(r));
  assert.equal(running, 2, 'the waiting job took the freed place');
  while (release.length) { release.shift()(); await new Promise(r => setImmediate(r)); }
  assert.deepEqual(await Promise.all([a, b, c]), [{ value: 'done' }, { value: 'done' }, { value: 'done' }]);
  assert.equal(peak, 2);
  assert.deepEqual(gate.stats(), { active: 0, waiting: 0 });
});

test('L2: putting back a taken-down file needs moderation_decide, and a reason when it was a person\'s request; audited as reinstates', async () => {
  const pic = await photo();
  const up = await heroFor(claimsOf(P.trainer1, 'trainer'), {}, pic);
  await hit('POST', `/admin/partner-media/${up.body.item.id}/take-down`, { claims: adminClaims(P.decider, ['moderation_decide']), body: { revision: 1, reason: 'person_request' } });
  const fields = { subjectType: 'trainer', subjectId: P.tp1, kind: 'hero' };
  const brandOnly = await adminSetReq(adminClaims(P.brand, ['brand_media']), fields, pic);
  assert.deepEqual([brandOnly.status, brandOnly.body.error, brandOnly.body.reinstates], [403, 'reinstate_requires_moderation_decide', up.body.item.id]);
  const both = adminClaims(P.brand, ['brand_media', 'moderation_decide']);
  const noReason = await adminSetReq(both, fields, pic);
  assert.deepEqual([noReason.status, noReason.body.error], [409, 'override_reason_required']);
  const ok = await adminSetReq(both, { ...fields, overrideReason: 'The person withdrew the request in writing (ticket 812).' }, pic);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const a = await db('AuditLog').where({ target: ok.body.item.id, action: 'partner_media.set_by_fitflex' }).first();
  const after = typeof a.after === 'string' ? JSON.parse(a.after) : a.after;
  assert.deepEqual([after.reinstates, after.reinstatesReason, after.overrideReason], [up.body.item.id, 'person_request', 'The person withdrew the request in writing (ticket 812).']);
  // Another file needs none of this; brand_media alone sets it.
  assert.equal((await adminSetReq(adminClaims(P.brand, ['brand_media']), fields, await photo())).status, 201);
});

test('L3: brand_media alone lists only tab=live for one partner; the full queue needs a moderation scope', async () => {
  await heroFor(owner(), { gymId: P.gymA });
  const brand = adminClaims(P.brand, ['brand_media']);
  for (const u of ['/admin/partner-media', '/admin/partner-media?tab=live', '/admin/partner-media?tab=taken_down&subjectId=x', `/admin/partner-media?tab=to_review&subjectId=${P.gymA}`]) {
    const r = await hit('GET', u, { claims: brand });
    assert.deepEqual([r.status, r.body.error, r.body.requiredScope], [403, 'acl_forbidden', 'moderation'], u);
  }
  const one = await hit('GET', `/admin/partner-media?tab=live&subjectType=gym&subjectId=${P.gymA}`, { claims: brand });
  assert.equal(one.status, 200);
  assert.equal(one.body.items.length, 1);
  assert.equal((await hit('GET', '/admin/partner-media', { claims: adminClaims(P.modOnly, ['moderation']) })).status, 200);
  assert.equal((await hit('GET', '/admin/partner-media', { claims: adminClaims(P.decider, ['moderation_decide']) })).status, 200);
});

test('L4: the partner side shows display names only — an uploader with no display name is null there, never their email', async () => {
  const noName = await user('gym_staff', { gymIds: [P.gymA], aclPermissions: ['gyms'], displayName: null, email: 'staff.private@example.com' });
  const up = await heroFor(claimsOf(noName, 'gym_staff', { aclPermissions: ['gyms'] }), { gymId: P.gymA });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.deepEqual([up.body.item.uploadedByName, up.body.item.uploadedByRole], [null, 'gym_staff']);
  const ov = await hit('GET', `/partner/media?gymId=${P.gymA}`, { claims: owner() });
  assert.doesNotMatch(JSON.stringify(ov.body), /staff\.private@example\.com/);
  const q = await hit('GET', `/admin/partner-media?tab=live&subjectId=${P.gymA}`, { claims: adminClaims(P.super) });
  assert.equal(q.body.items[0].uploadedByName, 'staff.private@example.com', 'admins may still see the email');
});

test('L6: under V2_ORG_AUTHZ enforce the takedown notice goes to the people memberships give access, not the legacy lists', async () => {
  const gE = await gym('Enforced gym');
  const person = uid('per'); await db('Person').insert({ id: person }); made.persons.push(person);
  const person2 = uid('per'); await db('Person').insert({ id: person2 }); made.persons.push(person2);
  // Legacy rows say nothing about gE; memberships say: an owner, and staff with `gyms`.
  const own = await user('gym_operator', { gymIds: [], personId: person });
  const st = await user('gym_staff', { gymIds: [], aclPermissions: [], personId: person2 });
  const legacyOnly = await user('gym_staff', { gymIds: [gE], aclPermissions: ['gyms'] });
  for (const [personId, personaId, role, acl] of [[person, own, 'owner', []], [person2, st, 'staff', ['gyms']]]) {
    const id = uid('om');
    await db('OrgMembership').insert({ id, personId, personaId, orgType: 'gym', gymId: gE, role, status: 'active', aclPermissions: acl, source: 'sync' });
    made.memberships.push(id);
  }
  process.env.IDENTITY_V2 = '1';
  process.env.V2_ORG_AUTHZ = 'true';
  const up = await heroFor(claimsOf(own, 'gym_operator'), { gymId: gE });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal((await hit('POST', `/admin/partner-media/${up.body.item.id}/take-down`, { claims: adminClaims(P.super), body: { revision: 1, reason: 'quality' } })).status, 200);
  const to = (await db('Notification').where({ type: 'partner_media.taken_down' }).whereIn('userId', [own, st, legacyOnly]).pluck('userId')).sort();
  assert.deepEqual(to, [own, st].sort());
});

test('L7: only JPEG, PNG, WebP and HEIF/AVIF magic bytes reach the decoder (logos: JPEG, PNG, WebP)', async () => {
  assert.equal(sniffImageType(PHOTO), 'jpeg');
  assert.equal(sniffImageType(LOGO_DARK), 'png');
  assert.equal(sniffImageType(await sharp(PHOTO).webp().toBuffer()), 'webp');
  assert.equal(sniffImageType(await sharp(PHOTO).avif().toBuffer()), 'avif');
  assert.equal(sniffImageType(Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1', 'latin1')), 'heif');
  assert.equal(sniffImageType(await sharp(PHOTO).tiff().toBuffer()), null);
  assert.equal(sniffImageType(await sharp(PHOTO).gif().toBuffer()), null);
  assert.equal(sniffImageType(Buffer.from('BM\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1')), null);
  const tiff = await heroFor(owner(), { gymId: P.gymA }, await sharp(await photo()).tiff().toBuffer());
  assert.deepEqual([tiff.status, tiff.body.error, tiff.body.reason], [400, 'unsupported_file_type', 'not_an_accepted_image']);
  const avifLogo = await logoFor(owner(), { gymId: P.gymA }, await sharp(LOGO_DARK).avif().toBuffer());
  assert.deepEqual([avifLogo.status, avifLogo.body.error], [400, 'unsupported_file_type']);
  assert.match(await pixelSha256(await sharp(PHOTO).webp().toBuffer()), /^[0-9a-f]{64}$/);
});

// ── Re-review of functions#277 ──────────────────────────────────────────────

test('R1: a partner deleted while its file is being cleaned is refused inside the lock (404 subject_not_found); nothing is saved', async () => {
  const gR = await gym('Deleted mid-upload');
  const oR = await user('gym_operator', { gymIds: [gR] });
  const svc = createPartnerMediaService({
    store: createPgPartnerMediaStore({ db }), logger: { error() {}, warn() {} },
    // The gym goes while the image is being processed (after every check made before the work).
    imageGate: { run: async (fn) => { const value = await fn(); await db('Gym').where({ id: gR }).del(); return { value }; } },
  });
  const r = await svc.upload({ claims: claimsOf(oR, 'gym_operator'), kind: 'hero', gymId: gR, file: { buffer: PHOTO }, fields: HERO_FIELDS() });
  assert.deepEqual([r.status, r.error], [404, 'subject_not_found']);
  assert.equal((await mediaRows(gR)).length, 0);
});

test('R2: the sweep purges gyms with no open owner and trainers whose account is closed; keeps V2-only owners and account-less trainer profiles; purgeAccount finds V2-only gyms', async () => {
  const sa = adminClaims(P.super);
  // A gym nobody owns (FitFlex set its photo).
  const gNone = await gym('Ownerless gym');
  assert.equal((await brandSet('gym', gNone)).status, 201);
  // A gym whose only owner is a closed account.
  const gClosed = await gym('Closed owner gym');
  const closedOwner = await user('gym_operator', { gymIds: [gClosed] });
  assert.equal((await heroFor(claimsOf(closedOwner, 'gym_operator'), { gymId: gClosed })).status, 201);
  await db('User').where({ id: closedOwner }).update({ accountStatus: 'closed' });
  // A gym owned only through an ACTIVE Identity V2 owner membership: kept.
  const gV2 = await gym('V2 owned gym');
  const person = uid('per'); await db('Person').insert({ id: person }); made.persons.push(person);
  const v2Owner = await user('gym_operator', { gymIds: [], personId: person });
  const om = uid('om');
  await db('OrgMembership').insert({ id: om, personId: person, personaId: v2Owner, orgType: 'gym', gymId: gV2, role: 'owner', status: 'active', aclPermissions: [], source: 'sync' });
  made.memberships.push(om);
  assert.equal((await brandSet('gym', gV2)).status, 201);
  // A trainer whose account is closed, and an account-less (admin-made) profile.
  const tcUser = await user('trainer');
  const tcProfile = await trainerProfile(tcUser, 'Closed Coach');
  assert.equal((await heroFor(claimsOf(tcUser, 'trainer'))).status, 201);
  await db('User').where({ id: tcUser }).update({ accountStatus: 'closed' });
  const tNoUser = await trainerProfile(null, 'Studio Coach');
  assert.equal((await brandSet('trainer', tNoUser)).status, 201);
  // Until the sweep, the admin list already hides the closed trainer.
  const before = await hit('GET', '/admin/partner-media?tab=live&subjectType=trainer', { claims: sa });
  assert.equal(before.body.items.some(i => i.subject.id === tcProfile), false);
  assert.equal(before.body.items.some(i => i.subject.id === tNoUser), true);

  await partnerMediaSweep.onJob();
  await assertPurged(gNone, 'sweep: gym with no owner');
  await assertPurged(gClosed, 'sweep: gym whose owner is closed');
  await assertPurged(tcProfile, 'sweep: trainer whose account is closed');
  for (const kept of [gV2, tNoUser]) {
    const rows = await mediaRows(kept);
    assert.equal(rows.filter(r => r.status === 'live' && !r.purgedAt).length, 1, `kept: ${kept}`);
  }

  // purgeAccount for a V2-only owner (no gymIds): their gym goes when an admin removes them.
  assert.equal((await adminOwnerService.remove({ id: v2Owner, actorId: P.super })).error, undefined);
  await assertPurged(gV2, 'adminOwnerService.remove of a V2-only owner');
});

test('sharp settings are not changed by partner uploads (the gate alone limits them)', async () => {
  const beforeThreads = sharp.concurrency();
  assert.equal((await heroFor(owner(), { gymId: P.gymA })).status, 201);
  assert.equal((await logoFor(owner(), { gymId: P.gymA })).status, 201);
  assert.equal(sharp.concurrency(), beforeThreads);
});

// ── Contract-checker (final round) ──────────────────────────────────────────

/** A PNG of a few bytes declaring width × height (IHDR, a tiny IDAT, IEND): enough for the size checks, which run before any decode. */
function pngHeader(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(16))), chunk('IEND', Buffer.alloc(0))]);
}

test('contract: 413 file_too_large carries maxPixels (photos over 50 MP) or maxSide (logos over 4000 px); 503 image_service_busy carries retryAfterSeconds', async () => {
  const huge = await heroFor(owner(), { gymId: P.gymA }, pngHeader(10_000, 6_000));
  assert.deepEqual([huge.status, huge.body.error, huge.body.maxPixels], [413, 'file_too_large', 50_000_000]);
  const wide = await logoFor(owner(), { gymId: P.gymA }, pngHeader(5_000, 400));
  assert.deepEqual([wide.status, wide.body.error, wide.body.maxSide], [413, 'file_too_large', 4000]);
  const busy = createPartnerMediaService({ store: createPgPartnerMediaStore({ db }), imageGate: { run: async () => ({ busy: true }) }, logger: { error() {}, warn() {} } });
  const r = await busy.upload({ claims: owner(), kind: 'hero', gymId: P.gymA, file: { buffer: PHOTO }, fields: HERO_FIELDS() });
  assert.deepEqual([r.status, r.error, r.retryAfterSeconds], [503, 'image_service_busy', 5]);
});

// ── Partner picker: GET /admin/partner-media/subjects ───────────────────────

test('subjects: case-insensitive name search per type, ids the set endpoint takes, names and ids only', async () => {
  const sa = adminClaims(P.super);
  const pii = await user('vendor', { approvalStatus: 'approved', email: 'owner.private@example.com', phone: '+255700000111', vendorProfile: JSON.stringify({ businessName: 'Arena Supplies', address: 'Plot 7, Kariakoo' }) });
  made.subjects.push(pii);
  const g = await hit('GET', '/admin/partner-media/subjects?type=gym&q=ARENA', { claims: sa });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const ours = g.body.items.filter(i => made.gyms.includes(i.id));
  assert.deepEqual(ours.map(i => i.name), ['Arena Two', 'Mazoezi Arena'], 'by name, case-insensitive');
  for (const i of g.body.items) assert.deepEqual(Object.keys(i).sort(), ['id', 'name', 'type']);
  assert.ok(g.body.total >= 2);
  const t = await hit('GET', '/admin/partner-media/subjects?type=trainer&q=coach%20one', { claims: sa });
  assert.deepEqual(t.body.items, [{ type: 'trainer', id: P.tp1, name: 'Coach One' }], 'the trainer profile id');
  const v = await hit('GET', '/admin/partner-media/subjects?type=vendor&q=arena%20sup', { claims: sa });
  assert.deepEqual(v.body.items, [{ type: 'vendor', id: pii, name: 'Arena Supplies' }], 'the vendor account id, by store name');
  assert.doesNotMatch(JSON.stringify(v.body), /owner\.private|255700000111|Kariakoo/, 'no email, phone or address');
  // The id is the one POST /admin/partner-media takes.
  assert.equal((await brandSet('vendor', v.body.items[0].id, 'logo')).status, 201);
  assert.equal((await brandSet('trainer', t.body.items[0].id)).status, 201);
  // limit: default 10, at most 25.
  for (let i = 0; i < 27; i += 1) await gym(`Picker Gym ${String(i).padStart(2, '0')}`);
  const dflt = await hit('GET', '/admin/partner-media/subjects?type=gym&q=picker%20gym', { claims: sa });
  assert.deepEqual([dflt.body.items.length, dflt.body.total], [10, 27]);
  assert.equal((await hit('GET', '/admin/partner-media/subjects?type=gym&q=picker%20gym&limit=100', { claims: sa })).body.items.length, 25);
  assert.equal((await hit('GET', '/admin/partner-media/subjects?type=gym&q=picker%20gym&limit=3', { claims: sa })).body.items[2].name, 'Picker Gym 02');
});

test('subjects: closed vendors and trainers whose account is closed are left out; account-less trainer profiles stay', async () => {
  const sa = adminClaims(P.super);
  const closedVendor = await user('vendor', { accountStatus: 'closed', vendorProfile: JSON.stringify({ businessName: 'Shut Shop Zeta' }) });
  const openVendor = await user('vendor', { vendorProfile: JSON.stringify({ businessName: 'Open Shop Zeta' }) });
  const closedTrainerUser = await user('trainer', { accountStatus: 'closed' });
  await trainerProfile(closedTrainerUser, 'Coach Zeta Closed');
  const studio = await trainerProfile(null, 'Coach Zeta Studio');
  const v = await hit('GET', '/admin/partner-media/subjects?type=vendor&q=zeta', { claims: sa });
  assert.deepEqual(v.body.items.map(i => i.id), [openVendor]);
  assert.equal(v.body.items.some(i => i.id === closedVendor), false);
  const t = await hit('GET', '/admin/partner-media/subjects?type=trainer&q=zeta', { claims: sa });
  assert.deepEqual(t.body.items.map(i => i.id), [studio]);
  assert.equal(t.body.total, 1);
});

test('subjects: LIKE wildcards in q are literal', async () => {
  const sa = adminClaims(P.super);
  const pct = await gym('100% Fit_Club');
  await gym('1000 FitXClub');
  await gym('Back\\slash Gym');
  const names = async q => (await hit('GET', `/admin/partner-media/subjects?type=gym&q=${encodeURIComponent(q)}`, { claims: sa })).body.items.filter(i => made.gyms.includes(i.id)).map(i => i.name);
  assert.deepEqual(await names('0%'), ['100% Fit_Club'], '% is not "anything"');
  assert.deepEqual(await names('t_c'), ['100% Fit_Club'], '_ is not "any one character"');
  assert.deepEqual(await names('%%'), [], 'nothing has two percent signs');
  assert.deepEqual(await names('__'), [], 'nothing has two underscores');
  assert.deepEqual(await names('k\\s'), ['Back\\slash Gym'], 'a backslash is literal too');
  assert.ok(pct);
});

test('subjects: guard, validation and rate limit', async () => {
  const u = '/admin/partner-media/subjects?type=gym&q=arena';
  assert.equal((await hit('GET', u)).status, 401);
  assert.equal((await hit('GET', u, { claims: owner() })).status, 403, 'partners are not admins');
  assert.equal((await hit('GET', u, { claims: claimsOf(P.member, 'member') })).status, 403);
  const promo = await hit('GET', u, { claims: adminClaims(P.brand, ['promotions']) });
  assert.deepEqual([promo.status, promo.body.error], [403, 'acl_forbidden']);
  for (const acl of [['brand_media'], ['moderation'], ['moderation_decide']]) {
    assert.equal((await hit('GET', u, { claims: adminClaims(P.brand, acl) })).status, 200, acl[0]);
  }
  const sa = adminClaims(P.super);
  for (const bad of ['', '&type=member', '&type=admin']) {
    const r = await hit('GET', `/admin/partner-media/subjects?q=arena${bad}`, { claims: sa });
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_subject_type'], bad);
  }
  for (const q of ['', 'a', '%20a%20']) {
    const r = await hit('GET', `/admin/partner-media/subjects?type=gym&q=${q}`, { claims: sa });
    assert.deepEqual([r.status, r.body.error, r.body.minLength], [400, 'q_too_short', 2], `q=${q}`);
  }
  resetPartnerMediaPreviewLimits();
  const limiter = adminClaims(P.modOnly, ['moderation']);
  for (let i = 0; i < 300; i += 1) assert.equal((await hit('GET', u, { claims: limiter })).status, 200);
  const limited = await hit('GET', u, { claims: limiter });
  assert.deepEqual([limited.status, limited.body.error], [429, 'rate_limited']);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await hit('GET', u, { claims: sa })).status, 200, 'per admin');
  // Its own window: previews of the limited admin still work.
  assert.equal((await hit('GET', '/admin/partner-media?tab=live', { claims: limiter })).status, 200);
});
