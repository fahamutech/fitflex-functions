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
import { partnerMediaService } from '../src/bootstrap/services.mjs';
import { createPartnerMediaService } from '../src/services/partner-media-service.mjs';
import { createPgPartnerMediaStore } from '../src/infra/partner-media-store-pg.mjs';
import { createVendorLimiter } from '../src/shared/vendor-rate-limit.mjs';
import {
  ADMIN_CONFIRMATION, PARTNER_CONFIRMATION, REASON_TEXT, TAKEDOWN_REASONS, takenDownMessage, settingsRoute,
} from '../src/shared/partner-media-rules.mjs';
import { looksLikeSvg, prepareLogoUpload, buildLogoVariants } from '../src/infra/hero-image-file.mjs';
import { mountGuards, mountHttpRoutes } from 'bfast-function/src/controllers/index.mjs';

await ensureInit();

// Never against anything but an isolated CI database.
assert.equal(process.env.FITFLEX_USE_CI_DB, '1', 'partner media specs run only with FITFLEX_USE_CI_DB=1');
assert.match(new URL(process.env.DATABASE_URL_CI).pathname, /^\/fitflex_ci/, 'DATABASE_URL_CI must name a fitflex_ci* database');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const express = createRequire(path.join(root, 'package.json'))('express');
const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

// ── Fixtures ────────────────────────────────────────────────────────────────

const made = { users: [], gyms: [], trainers: [], persons: [], memberships: [] };
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

const subjectIds = () => [P.gymA, P.gymB, P.gymC, P.tp1, P.tp2, P.vendor1, P.vendor2];
async function cleanMedia() {
  const ids = await db('PartnerMedia').whereIn('subjectId', subjectIds()).pluck('id');
  if (ids.length) await db('AuditLog').whereIn('target', ids).del();
  await db('PartnerMedia').whereIn('subjectId', subjectIds()).del();
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
    ['GET', '/admin/partner-media'], ['GET', '/admin/partner-media/confirmation'], ['GET', '/admin/partner-media/x/preview'],
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
  assert.deepEqual(r.body.limits.hero, { minWidth: 1080, maxBytes: 15 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] });
  assert.deepEqual(r.body.limits.logo, { minSide: 256, maxBytes: 2 * 1024 * 1024, types: ['image/png', 'image/jpeg', 'image/webp'] });
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
  assert.deepEqual(files.map(f => f.variant).sort(), ['master', 'x1', 'x2']);
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

test('serving: live at once to signed-in readers (private, immutable); replace deletes the old bytes in the same step; one live at a time', async () => {
  const first = await heroFor(owner(), { gymId: P.gymA });
  const a = first.body.item;
  const f = await hit('GET', a.files.x2, { claims: owner() });
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/webp');
  assert.equal(f.headers.get('cache-control'), 'private, max-age=31536000, immutable');
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

test('rate limits: 10 uploads a minute per partner (429 limit minute); another partner is not affected', async () => {
  for (let i = 0; i < 10; i += 1) assert.equal((await heroFor(owner(), { gymId: P.gymA, rightsConfirmed: 'false' })).status, 400);
  const r = await heroFor(owner(), { gymId: P.gymA });
  assert.deepEqual([r.status, r.body.error, r.body.limit, r.body.max], [429, 'rate_limited', 'minute', 10]);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  // Staff of the same gym share the gym's allowance.
  assert.equal((await heroFor(claimsOf(P.staffEdit, 'gym_staff', { aclPermissions: ['gyms'] }), { gymId: P.gymA })).status, 429);
  assert.equal((await heroFor(owner(), { gymId: P.gymC })).status, 201, 'gym C has its own allowance');
  // A service clock a minute later: allowed again.
  let clock = Date.now();
  const svc = createPartnerMediaService({ store: createPgPartnerMediaStore({ db }), now: () => new Date(clock), minuteLimiter: createVendorLimiter({ perMinute: 10 }), logger: { error() {}, warn() {} } });
  for (let i = 0; i < 10; i += 1) await svc.upload({ claims: owner(), kind: 'hero', gymId: P.gymA, fields: {} });
  assert.equal((await svc.upload({ claims: owner(), kind: 'hero', gymId: P.gymA, fields: {} })).error, 'rate_limited');
  clock += 61_000;
  assert.equal((await svc.upload({ claims: owner(), kind: 'hero', gymId: P.gymA, fields: {} })).error, 'confirmation_version_mismatch');
});

test('rate limits: 20 partner uploads a day per partner (429 limit day); FitFlex uploads do not count', async () => {
  const at = new Date(Date.now() - 3_600_000);
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: uid('pmd'), subjectType: 'trainer', subjectId: P.tp1, kind: i % 2 ? 'logo' : 'hero', origin: 'partner', status: 'replaced',
    width: 1600, height: 1000, ...(i % 2 ? { plate: 'light', plateChoice: 'auto' } : { focalX: 0, focalY: 0 }),
    confirmationVersion: PARTNER_CONFIRMATION.version, rightsConfirmedBy: P.trainer1, rightsConfirmedAt: at, uploadedBy: P.trainer1, uploadedByRole: 'trainer',
    createdAt: at, updatedAt: at,
  }));
  await db('PartnerMedia').insert(rows.slice(0, 19));
  assert.equal((await heroFor(claimsOf(P.trainer1, 'trainer'))).status, 201, 'the 20th of the day');
  const r = await heroFor(claimsOf(P.trainer1, 'trainer'));
  assert.deepEqual([r.status, r.body.error, r.body.limit, r.body.max], [429, 'rate_limited', 'day', 20]);
  // Older than a day: no longer counted.
  await db('PartnerMedia').whereIn('id', rows.slice(0, 5).map(x => x.id)).update({ createdAt: new Date(Date.now() - 25 * 3_600_000) });
  assert.equal((await heroFor(claimsOf(P.trainer1, 'trainer'))).status, 201);
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
  assert.equal((await heroFor(owner(), { gymId: P.gymC }, takenPhoto)).status, 201, 'another gym may use it');
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
  const takedown = rows.find(r => r.action === 'partner_media.taken_down');
  const after = typeof takedown.after === 'string' ? JSON.parse(takedown.after) : takedown.after;
  assert.match(after.sha256, /^[0-9a-f]{64}$/);
  assert.equal(after.filesDeleted, 3);
  assert.equal(after.reason, 'quality');
});
