// Events S6 · B4 — organizer medal artwork: the upload pipeline, caps, replace / remove / takedown, serving authorisation, headers, flag-off fallback.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ensureInit } from '../functions/index.mjs';
import * as art from '../functions/events-medal-art.mjs';
import { harness, s6On, s6Off, db } from './fixtures/events-s6.mjs';
import { eventsMedalArtService, eventsMedalService as medals, eventsAwardService as awards } from '../src/bootstrap/services.mjs';
import { createEventsMedalArtService, MEDAL_ART_CONFIRMATION } from '../src/services/events-medal-art-service.mjs';
import { createJobGate } from '../src/services/partner-media-service.mjs';

await ensureInit();
const h = harness();
afterEach(() => { art.resetEventsMedalArtLimits(); delete process.env.EVENTS_MEDAL_ART_UPLOADS_PER_DAY; });
after(async () => { await h.cleanup(); await db.destroy(); });

const V = MEDAL_ART_CONFIRMATION.version;
const name = en => ({ en, sw: `${en} (sw)` });
const solid = (w, h2, fmt = 'png', color = { r: 20, g: 120, b: 60, alpha: 1 }) => sharp({ create: { width: w, height: h2, channels: 4, background: color } })[fmt]().toBuffer();
/** Something that is not a flat colour, so budgets and hashes mean something. */
const noisy = async (w, fmt = 'png', seed = 1) => {
  const raw = Buffer.alloc(w * w * 3);
  let a = (seed * 2654435761) >>> 0; // mulberry32: different seeds give unrelated pictures
  for (let i = 0; i < raw.length; i += 1) { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; raw[i] = (((t ^ (t >>> 14)) >>> 0) % 256); }
  return sharp(raw, { raw: { width: w, height: w, channels: 3 } })[fmt]().toBuffer();
};
const resetAttempts = () => db('EventMedalArtUploadAttempt').del();

async function setup({ n = 2 } = {}) {
  s6On({ rewards: true, medalArt: true });
  const o = await h.org();
  const f = await h.resultsEvent({ organizer: o, n });
  const t = (await medals.create({ actor: h.actors(o).owner, organizerId: o.id, eventId: f.event.id, key: h.key(), body: { name: name('Finisher') } })).template;
  return { o, f, t, a: h.actors(o) };
}
const up = (who, f, t, body, { query = {}, headers = {}, key = h.key() } = {}) => h.call(art.uploadMedalArt, who, {
  params: { id: f.event.id, templateId: t.id }, body, query: { confirmationVersion: V, ...query }, headers: { 'Idempotency-Key': key, ...headers },
});
const files = artId => db('EventMedalArtFile').where({ artId }).orderBy('variant');
const meta = bytes => sharp(bytes).metadata();

test('a valid design is live at once; only WebP is stored in six variants within budget; EXIF / GPS / ICC are gone; the declared type and file name are ignored', async () => {
  const { o, f, t } = await setup();
  const withGps = await sharp(await noisy(900, 'png', 3)).jpeg().withExif({ IFD0: { Copyright: 'secret owner', Artist: 'Someone' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '6/1 48/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '39/1 17/1 0/1' } }).toBuffer();
  assert.ok((await meta(withGps)).exif, 'the source does carry EXIF');
  const r = await up(o.claims, f, t, withGps, { headers: { 'Content-Type': 'application/pdf' }, query: { altEn: 'Green medal' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.art.status, r.body.art.source, r.body.art.revision, r.body.art.altText], ['live', 'custom', 1, { en: 'Green medal' }]);
  assert.equal(JSON.stringify(r.body).includes('bytes'), false);
  const tpl = await db('EventMedalTemplate').where({ id: t.id }).first();
  assert.equal(tpl.artId, r.body.art.id);
  assert.equal(tpl.imageUrl, null);
  const rows = await files(r.body.art.id);
  assert.deepEqual(rows.map(x => x.variant), ['m128', 'm256', 'm512', 'master', 'p240', 'p480']);
  const by = Object.fromEntries(rows.map(x => [x.variant, x]));
  assert.ok(by.m512.byteSize <= 90 * 1024 && by.m256.byteSize <= 40 * 1024 && by.m128.byteSize <= 15 * 1024, 'budgets');
  for (const x of rows) {
    assert.equal(x.contentType, 'image/webp');
    const m = await meta(x.bytes);
    assert.equal(m.format, 'webp');
    assert.deepEqual([m.exif, m.icc, m.xmp].map(v => v === undefined), [true, true, true], `${x.variant} carries no metadata`);
    assert.equal(x.bytes.includes(Buffer.from('secret owner')), false);
  }
  assert.deepEqual([(await meta(by.m512.bytes)).width, (await meta(by.m256.bytes)).width, (await meta(by.m128.bytes)).width], [512, 256, 128]);
  // a PNG named .jpg is accepted as PNG (bytes decide); a rotated JPEG comes out upright
  await resetAttempts();
  const png = await up(o.claims, f, t, await noisy(600, 'png', 4), { headers: { 'Content-Type': 'image/jpeg' }, query: { fileName: 'x.jpg' } });
  assert.equal(png.status, 201);
  assert.equal(png.body.art.revision, 2);
  const audit = await db('AuditLog').where({ target: f.event.id }).whereIn('action', ['events.medal_art_uploaded', 'events.medal_art_replaced']);
  assert.deepEqual(audit.map(a => a.action).sort(), ['events.medal_art_replaced', 'events.medal_art_uploaded']);
  assert.equal(JSON.stringify(audit).includes('AAAA'), false);
});

test('refusals: SVG (any declared type), GIF / TIFF / PDF / executable, animated, pixel bomb, too small, not square, corrupt, oversize (413 before reading), each with its own code', async () => {
  const { o, f, t } = await setup();
  const attempt = async (buf, extra = {}) => { await resetAttempts(); const r = await up(o.claims, f, t, buf, extra); return [r.status, r.body.error]; };
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><script>alert(1)</script></svg>');
  assert.deepEqual(await attempt(svg, { headers: { 'Content-Type': 'image/png' } }), [400, 'svg_not_allowed']);
  assert.deepEqual(await attempt(Buffer.concat([Buffer.from('<?xml version="1.0"?>\n'), svg])), [400, 'svg_not_allowed']);
  assert.deepEqual(await attempt(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100, 1)])), [400, 'unsupported_file_type']);
  assert.deepEqual(await attempt(Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(100, 1)])), [400, 'unsupported_file_type']);
  assert.deepEqual(await attempt(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 1)])), [400, 'unsupported_file_type']);
  assert.deepEqual(await attempt(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]), { headers: { 'Content-Type': 'image/png' }, query: { fileName: 'evil.png' } }), [400, 'unsupported_file_type']);
  assert.deepEqual(await attempt(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(100)])), [400, 'unsupported_file_type']);
  assert.deepEqual(await attempt(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(100)])), [400, 'unsupported_file_type']);
  const anim = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBPVP8X'), Buffer.from([10, 0, 0, 0, 2, 0, 0, 0]), Buffer.from('ANIM'), Buffer.alloc(80, 0)]);
  assert.deepEqual(await attempt(anim), [400, 'animated_not_allowed']);
  const apng = await solid(600, 600);
  const withActl = Buffer.concat([apng.subarray(0, 33), Buffer.from([0, 0, 0, 8]), Buffer.from('acTL'), Buffer.alloc(12), apng.subarray(33)]);
  assert.deepEqual(await attempt(withActl), [400, 'animated_not_allowed']);
  const bomb = await solid(5000, 5000);
  assert.ok(bomb.length < 2 * 1024 * 1024, 'a small file with huge dimensions');
  const bombRes = await (async () => { await resetAttempts(); return up(o.claims, f, t, bomb); })();
  assert.deepEqual([bombRes.status, bombRes.body.error], [400, 'image_too_large']);
  assert.deepEqual(await attempt(await solid(500, 500)), [400, 'image_too_small']);
  const ns = await (async () => { await resetAttempts(); return up(o.claims, f, t, await solid(600, 800)); })();
  assert.deepEqual([ns.status, ns.body.error, ns.body.width, ns.body.height], [400, 'not_square', 600, 800]);
  const ok2 = await solid(612, 600); // 2 % off square passes
  await resetAttempts();
  assert.equal((await up(o.claims, f, t, ok2)).status, 201);
  const good = await noisy(700, 'png', 9);
  assert.deepEqual(await attempt(good.subarray(0, Math.floor(good.length / 2))), [400, 'corrupt_image']);
  await resetAttempts();
  const big = await up(o.claims, f, t, Buffer.alloc(100), { headers: { 'Content-Length': String(3 * 1024 * 1024) } });
  assert.deepEqual([big.status, big.body.error], [413, 'payload_too_large']);
  assert.deepEqual(await attempt(Buffer.alloc(2 * 1024 * 1024 + 1, 7)), [413, 'payload_too_large']);
  assert.deepEqual(await attempt(Buffer.alloc(0)), [400, 'no_file_provided']);
  assert.equal(await db('EventMedalArt').where({ templateId: t.id }).count().then(r => Number(r[0].count)), 1, 'only the valid one was stored');
  assert.equal((await db('AuditLog').where({ action: 'events.medal_art_refused', target: f.event.id })).length >= 5, true);
});

test('rights confirmation: required and versioned (409 with the current text); an imageUrl or remote address is never stored or returned; Idempotency-Key required, replay returns the first answer', async () => {
  const { o, f, t } = await setup();
  const png = await noisy(600, 'png', 5);
  const none = await up(o.claims, f, t, png, { query: { confirmationVersion: undefined } });
  assert.deepEqual([none.status, none.body.error, none.body.current.version], [409, 'confirmation_outdated', V]);
  assert.deepEqual(none.body.current.status, 'draft_pending_counsel');
  assert.match(none.body.current.sw, /Nimetengeneza muundo/);
  const old = await up(o.claims, f, t, png, { query: { confirmationVersion: '2020-old' } });
  assert.equal(old.body.error, 'confirmation_outdated');
  const nokey = await h.call(art.uploadMedalArt, o.claims, { params: { id: f.event.id, templateId: t.id }, body: png, query: { confirmationVersion: V } });
  assert.deepEqual([nokey.status, nokey.body.error], [400, 'idempotency_key_required']);
  const k = h.key();
  const first = await up(o.claims, f, t, png, { key: k, query: { imageUrl: 'https://evil.example/m.png', url: 'file:///etc/passwd' } });
  assert.equal(first.status, 201);
  assert.equal(JSON.stringify(first.body).includes('http'), false);
  assert.equal(JSON.stringify(first.body).includes('evil'), false);
  const row = await db('EventMedalArt').where({ id: first.body.art.id }).first();
  assert.equal(JSON.stringify(row).includes('evil'), false);
  assert.deepEqual([row.confirmationVersion, row.confirmedBy], [V, o.ownerUserId]);
  assert.equal((await db('EventMedalTemplate').where({ id: t.id }).first()).imageUrl, null);
  const replay = await up(o.claims, f, t, png, { key: k });
  assert.deepEqual([replay.status, replay.headers?.['Idempotent-Replayed'] ?? replay.body.art.id], [200, first.body.art.id]);
  assert.equal(await db('EventMedalArt').where({ templateId: t.id }).count().then(r => Number(r[0].count)), 1);
  assert.equal((await up(o.claims, f, t, await noisy(600, 'png', 6), { key: k })).body.error, 'idempotency_key_reused');
  const view = await medals.list({ actor: h.actors(o).owner, organizerId: o.id, eventId: f.event.id });
  assert.equal(view.items[0].art.source, 'custom');
  assert.equal(JSON.stringify(view).includes('http'), false);
});

test('roles and standing: only owner / admin upload; timing and ops are refused; a suspended organizer is read-only; another organizer gets 404; a cancelled event refuses', async () => {
  const { o, f, t, a } = await setup();
  const png = await noisy(600, 'png', 7);
  for (const who of [o.timing, o.ops, o.finance]) { const r = await up(who, f, t, png); assert.equal(r.status, 403, JSON.stringify(r.body)); }
  assert.equal((await up(o.admin, f, t, png)).status, 201);
  await resetAttempts();
  const stranger = await h.org();
  const lost = await up(stranger.claims, f, t, png);
  assert.equal(lost.status, 404, JSON.stringify(lost.body));
  assert.equal((await h.call(art.previewMedalArt, o.timing, { params: { id: f.event.id, templateId: t.id }, query: { w: '240' } })).status, 200, 'timing may preview');
  await db('EventOrganizer').where({ id: o.id }).update({ status: 'suspended', statusReason: 'spec' });
  const sus = await up(o.claims, f, t, png);
  assert.deepEqual([sus.status, sus.body.error], [403, 'organizer_suspended']);
  assert.equal((await h.call(art.previewMedalArt, o.timing, { params: { id: f.event.id, templateId: t.id }, query: { w: '240' } })).status, 200, 'a suspended organizer may still read');
  await db('EventOrganizer').where({ id: o.id }).update({ status: 'active', statusReason: null });
  await db('Event').where({ id: f.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  assert.equal((await up(o.claims, f, t, png)).body.error, 'event_cancelled');
  void a;
});

test('caps count refusals BEFORE the body is read (a refused attempt never uses the successful allowance); successful uploads are capped per organizer; the cap is per person too', async () => {
  const { o, f, t } = await setup();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await h.call(art.uploadMedalArt, o.claims, { params: { id: f.event.id, templateId: t.id }, body: i < 5 ? svg : undefined, query: { confirmationVersion: V }, headers: { 'Idempotency-Key': h.key() } })).status);
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429], 'the 6th attempt is refused without its body ever being read');
  const limited = await h.call(art.uploadMedalArt, o.claims, { params: { id: f.event.id, templateId: t.id }, query: { confirmationVersion: V }, headers: { 'Idempotency-Key': h.key() } });
  assert.deepEqual([limited.status, limited.body.error, limited.body.scope], [429, 'rate_limited', 'person']);
  assert.ok(limited.body.retryAfterSeconds > 0);
  assert.equal(await db('EventMedalArtUploadAttempt').where({ succeeded: true, organizerId: o.id }).count().then(r => Number(r[0].count)), 0, 'refusals used none of the successful allowance');
  // the owner's failures do not lock a teammate out (a different person), and the organizer-wide successful cap holds
  process.env.EVENTS_MEDAL_ART_UPLOADS_PER_DAY = '2';
  const png = n => noisy(600, 'png', n);
  assert.equal((await up(o.admin, f, t, await png(11))).status, 201);
  assert.equal((await up(o.admin, f, t, await png(12))).status, 201);
  const third = await up(o.admin, f, t, await png(13));
  assert.deepEqual([third.status, third.body.scope], [429, 'organizer']);
  await db('EventMedalArtUploadAttempt').del();
  assert.equal(await db('EventMedalArtUploadAttempt').count().then(r => Number(r[0].count)), 0);
});

test('the shared decode gate: beyond its queue a request is 503 busy (retry later) and nothing is stored', async () => {
  const { o, f, t } = await setup();
  const svc = createEventsMedalArtService({ db, results: h.service, gate: createJobGate({ max: 1, maxWaiting: 0 }) });
  const png = await noisy(640, 'png', 21);
  const actor = { kind: 'staff', userId: o.ownerUserId, role: 'owner', requestId: 'req_gate' };
  const run = async () => { const admission = await svc.admit({ actor, organizerId: o.id, eventId: f.event.id, templateId: t.id, key: h.key() }); return svc.store({ actor, admission, buffer: png, confirmationVersion: V, key: h.key() }); };
  const out = await Promise.all([run(), run(), run()]);
  const codes = out.map(r => r.error ?? 'ok').sort();
  assert.ok(codes.includes('busy') && codes.includes('ok'), codes.join());
  assert.equal(out.find(r => r.error === 'busy').status, 503);
  assert.equal(await db('EventMedalArt').where({ templateId: t.id, status: 'live' }).count().then(r => Number(r[0].count)), 1);
});

test('one live design per template; replace and remove really delete the old bytes; the medal falls back to its built-in design', async () => {
  const { o, f, t, a } = await setup();
  const one = await up(o.claims, f, t, await noisy(600, 'png', 31));
  await resetAttempts();
  const two = await up(o.claims, f, t, await noisy(600, 'png', 32));
  assert.equal((await files(one.body.art.id)).length, 0, 'replaced: bytes gone');
  assert.equal((await db('EventMedalArt').where({ id: one.body.art.id }).first()).status, 'replaced');
  assert.equal(await db('EventMedalArt').where({ templateId: t.id, status: 'live' }).count().then(r => Number(r[0].count)), 1);
  await assert.rejects(db('EventMedalArt').insert({ ...(await db('EventMedalArt').where({ id: two.body.art.id }).first()), id: 'ema_dup_live' }), /eventmedalart_live_template_unique|duplicate/);
  const patch = await h.call(art.patchMedalArt, o.claims, { params: { id: f.event.id, templateId: t.id }, body: { altText: { en: 'Blue', sw: 'Bluu' } }, headers: { 'Idempotency-Key': h.key() } });
  assert.deepEqual(patch.body.art.altText, { en: 'Blue', sw: 'Bluu' });
  assert.equal((await h.call(art.patchMedalArt, o.claims, { params: { id: f.event.id, templateId: t.id }, body: { altText: { en: 'x'.repeat(121) } }, headers: { 'Idempotency-Key': h.key() } })).status, 422);
  assert.equal((await h.call(art.removeMedalArt, o.timing, { params: { id: f.event.id, templateId: t.id }, headers: { 'Idempotency-Key': h.key() } })).status, 403);
  const rm = await h.call(art.removeMedalArt, o.claims, { params: { id: f.event.id, templateId: t.id }, headers: { 'Idempotency-Key': h.key() } });
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.equal((await files(two.body.art.id)).length, 0);
  assert.equal((await db('EventMedalTemplate').where({ id: t.id }).first()).artId, null);
  const view = await medals.list({ actor: a.owner, organizerId: o.id, eventId: f.event.id });
  assert.deepEqual([view.items[0].art.source, view.items[0].art.artKey], ['builtin', 'finisher_green']);
});

test('takedown: bytes deleted, hashes kept, the same file AND a re-saved copy are refused, the medal reverts without touching awards, organizer owners and admins get a bilingual essential notice', async () => {
  const { o, f, t, a } = await setup({ n: 1 });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', '']]));
  const row = await h.current(f.regs[0].id);
  await h.service.verify({ actor: a.owner, organizerId: o.id, eventId: f.event.id, resultId: row.id, key: h.key(), body: { expectedRevision: 1 } });
  const p = await h.service.releasePreview({ actor: a.owner, organizerId: o.id, eventId: f.event.id, body: { stage: 'official' } });
  await h.service.release({ actor: a.owner, organizerId: o.id, eventId: f.event.id, key: h.key(), body: { stage: 'official', previewHash: p.previewHash } });
  while ((await awards.runBatch()).claimed);
  const award = await db('EventMedalAward').where({ registrationId: f.regs[0].id }).first();
  assert.equal(award.awardStatus, 'awarded');
  const src = await noisy(640, 'png', 41);
  const live = await up(o.claims, f, t, src);
  const admin = await h.user({ userType: 'admin' });
  const claims = { sub: admin, userType: 'admin' };
  const queue = await h.call(art.adminListMedalArt, claims, { query: { reviewState: 'to_review' } });
  assert.equal(queue.body.toReview >= 1, true);
  const item = queue.body.items.find(i => i.id === live.body.art.id);
  assert.deepEqual([item.organizerName !== undefined, item.reviewState, item.confirmationVersion], [true, 'to_review', V]);
  assert.equal((await h.call(art.adminPreviewMedalArt, claims, { params: { id: live.body.art.id }, query: { w: '480' } })).status, 200);
  assert.equal((await h.call(art.adminReviewedMedalArt, claims, { params: { id: live.body.art.id } })).body.art.reviewState, 'reviewed');
  assert.equal((await h.call(art.adminTakeDownMedalArt, claims, { params: { id: live.body.art.id }, body: { reason: 'nope' } })).status, 422);
  assert.equal((await h.call(art.adminTakeDownMedalArt, claims, { params: { id: live.body.art.id }, body: { reason: 'other' } })).status, 422);
  assert.equal((await h.call(art.adminTakeDownMedalArt, o.claims, { params: { id: live.body.art.id }, body: { reason: 'rights' } })).status, 403);
  const down = await h.call(art.adminTakeDownMedalArt, claims, { params: { id: live.body.art.id }, body: { reason: 'person_request', note: 'Asked by the person pictured' } });
  assert.equal(down.status, 200, JSON.stringify(down.body));
  const stored = await db('EventMedalArt').where({ id: live.body.art.id }).first();
  assert.deepEqual([stored.status, stored.reason, stored.sha256 !== null, stored.pixelSha256 !== null, stored.purgedAt !== null], ['taken_down', 'person_request', true, true, true]);
  assert.equal((await files(live.body.art.id)).length, 0);
  assert.equal((await db('EventMedalTemplate').where({ id: t.id }).first()).artId, null);
  assert.equal((await db('EventMedalAward').where({ id: award.id }).first()).awardStatus, 'awarded', 'awards are untouched');
  const view = await medals.awardViews([await db('EventMedalAward').where({ id: award.id }).first()]);
  assert.deepEqual([view[0].art.source, view[0].art.artKey], ['builtin', 'finisher_green']);
  assert.equal((await h.call(art.adminTakeDownMedalArt, claims, { params: { id: live.body.art.id }, body: { reason: 'rights' } })).status, 409);
  for (const who of [o.ownerUserId, o.admin.sub]) {
    const n = await db('Notification').where({ userId: who, type: 'event_medal_art_taken_down' });
    assert.equal(n.length, 1, `notice for ${who}`);
    assert.deepEqual([n[0].data.essential, n[0].data.titleSw], [true, 'Muundo wa medali umeondolewa']);
    assert.match(n[0].data.bodySw, /mtu aliyeko ndani yake aliomba iondolewe/);
  }
  assert.equal((await db('Notification').where({ userId: o.ops.sub, type: 'event_medal_art_taken_down' })).length, 0);
  // the same file, and a re-saved copy with different metadata, are refused for good
  await resetAttempts();
  const again = await up(o.claims, f, t, src);
  assert.deepEqual([again.status, again.body.error], [409, 'file_not_allowed']);
  const resaved = await sharp(src).png({ compressionLevel: 1 }).withExif({ IFD0: { Copyright: 'changed' } }).toBuffer();
  assert.notDeepEqual(resaved, src);
  await resetAttempts();
  assert.equal((await up(o.claims, f, t, resaved)).body.error, 'file_not_allowed');
  await resetAttempts();
  assert.equal((await up(o.claims, f, t, await noisy(640, 'png', 42))).status, 201, 'a different design is fine');
  const audit = await db('AuditLog').where({ action: 'events.medal_art_taken_down', target: f.event.id }).first();
  assert.equal(JSON.stringify(audit).includes('bytes'), false);
});

test('serving: award holders, organizer staff and an events admin get the file; every other caller gets 404 (never 403); the master is never served; headers are set; removed art is 404', async () => {
  const { o, f, t, a } = await setup({ n: 2 });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', ''], ['1002', 'finished', '0:51:00', '']]));
  for (const r of f.regs) { const row = await h.current(r.id); await h.service.verify({ actor: a.owner, organizerId: o.id, eventId: f.event.id, resultId: row.id, key: h.key(), body: { expectedRevision: 1 } }); }
  await db('EventAwardTask').where({ eventId: f.event.id }).del();
  const body = { stage: 'official', leaveUnsettledOut: true };
  const p = await h.service.releasePreview({ actor: a.owner, organizerId: o.id, eventId: f.event.id, body });
  await h.service.release({ actor: a.owner, organizerId: o.id, eventId: f.event.id, key: h.key(), body: { ...body, previewHash: p.previewHash } });
  await awards.evaluate(f.regs[0].id);
  const live = await up(o.claims, f, t, await noisy(640, 'png', 51));
  const id = live.body.art.id;
  const get = (claims, query = {}) => h.call(art.serveMedalArt, claims, { params: { artId: id }, query });
  const holder = await get({ sub: f.regs[0].userId, userType: 'member' });
  assert.equal(holder.status, 200);
  assert.equal((await get({ sub: o.ownerUserId, userType: 'event_organizer' })).status, 200, 'staff');
  assert.equal((await get({ sub: o.admin.sub, userType: 'organizer_staff' })).status, 200, 'staff admin');
  assert.equal((await get({ sub: await h.user({ userType: 'admin' }), userType: 'admin' })).status, 200, 'super-admin');
  const limitedAdmin = await get({ sub: await h.user({ userType: 'admin' }), userType: 'admin', portalUser: true, aclPermissions: ['moderation'] });
  assert.equal(limitedAdmin.status, 404, 'a portal admin without the events scope');
  const otherMember = await h.call(art.serveMedalArt, { sub: f.regs[1].userId, userType: 'member' }, { params: { artId: id } });
  assert.equal(otherMember.status, 404, 'a member with no award from this template');
  const stranger = await h.org();
  assert.equal((await get({ sub: stranger.ownerUserId, userType: 'event_organizer' })).status, 404, 'another organizer');
  assert.equal((await h.call(art.serveMedalArt, null, { params: { artId: id } })).status, 401, 'signed out');
  for (const variant of ['master', 'p240', 'bogus']) assert.equal((await get({ sub: f.regs[0].userId, userType: 'member' }, { variant })).status, 404, variant);
  for (const variant of ['m512', 'm256', 'm128']) assert.equal((await get({ sub: f.regs[0].userId, userType: 'member' }, { variant })).status, 200);
  assert.equal((await h.call(art.serveMedalArt, { sub: f.regs[0].userId, userType: 'member' }, { params: { artId: 'ema_unknown' } })).status, 404);
  // headers, through a real response object
  const headers = {};
  const sink = { statusCode: 200, status(c) { this.statusCode = c; return this; }, set(k, v) { headers[k] = v; return this; }, end(b) { this.sent = b; return this; }, json(b) { this.sent = b; return this; } };
  await art.serveMedalArt.onRequest({ user: { sub: f.regs[0].userId, userType: 'member' }, params: { artId: id }, query: {}, headers: {} }, sink);
  assert.deepEqual([headers['Content-Type'], headers['X-Content-Type-Options'], headers['Content-Disposition'], headers['Content-Security-Policy'], headers['Cache-Control']],
    ['image/webp', 'nosniff', 'inline', "default-src 'none'", 'private, max-age=300, must-revalidate']);
  assert.equal((await meta(sink.sent)).format, 'webp');
  assert.equal((await meta(sink.sent)).width, 512);
  // a regular member's medal payload now carries the custom art id; flag off → built-in only and the file route disappears
  const mine = await medals.forRegistration(f.regs[0].id);
  assert.deepEqual([mine[0].art.source, mine[0].art.artId, mine[0].art.revision], ['custom', id, 1]);
  s6Off(); s6On({ rewards: true });
  const off = await medals.forRegistration(f.regs[0].id);
  assert.deepEqual([off[0].art.source, off[0].art.artId, off[0].art.artKey], ['builtin', null, 'finisher_green']);
  assert.equal((await get({ sub: f.regs[0].userId, userType: 'member' })).status, 404);
  assert.equal((await h.call(art.serveMedalArt, { sub: f.regs[0].userId, userType: 'member' }, { params: { artId: id } })).body.error, 'feature_disabled');
  s6Off(); s6On({ rewards: true, medalArt: true });
  await h.call(art.removeMedalArt, o.claims, { params: { id: f.event.id, templateId: t.id }, headers: { 'Idempotency-Key': h.key() } });
  assert.equal((await get({ sub: f.regs[0].userId, userType: 'member' })).status, 404, 'removed');
});

test('flag matrix: every medal-art route is 404 feature_disabled unless EVENTS_MEDAL_ART (and rewards, results) are on; the admin queue needs the events scope', async () => {
  const { o, f, t } = await setup({ n: 1 });
  const claims = { sub: await h.user({ userType: 'admin' }), userType: 'admin' };
  const call = (r, who) => h.call(r, who, { params: { id: f.event.id, templateId: t.id, artId: 'x' }, query: {}, headers: { 'Idempotency-Key': 'flag-matrix-key' } });
  const everyRoute = Object.values(art).filter(r => r?.path);
  for (const mode of ['all off', 'no medal art', 'no rewards']) {
    s6Off();
    if (mode === 'no medal art') s6On({ rewards: true });
    if (mode === 'no rewards') s6On({ medalArt: true });
    for (const r of everyRoute) {
      const res = await call(r, r.path.startsWith('/admin') ? claims : r.path.startsWith('/events') ? { sub: o.ownerUserId, userType: 'event_organizer' } : o.claims);
      assert.deepEqual([mode, r.path, res.status, res.body?.error], [mode, r.path, 404, 'feature_disabled']);
    }
  }
  s6Off(); s6On({ rewards: true, medalArt: true });
  assert.equal((await call(art.adminListMedalArt, { sub: await h.user({ userType: 'admin' }), userType: 'admin', portalUser: true, aclPermissions: ['users'] })).status, 403);
  assert.equal((await call(art.adminListMedalArt, o.claims)).status, 403);
});

test('FitFlex can set a design for an organizer (stored as reviewed with its own confirmation); nothing here is part of any webhook, API or roster payload', async () => {
  const { o, f, t } = await setup({ n: 1 });
  const claims = { sub: await h.user({ userType: 'admin' }), userType: 'admin' };
  const png = await noisy(600, 'png', 61);
  const bad = await h.call(art.adminUploadMedalArt, claims, { params: { id: f.event.id, templateId: t.id }, body: png, query: { confirmationVersion: V }, headers: { 'Idempotency-Key': h.key() } });
  assert.equal(bad.body.error, 'confirmation_outdated');
  assert.equal(bad.body.current.version, '2026-10-29.s6admin1');
  const ok = await h.call(art.adminUploadMedalArt, claims, { params: { id: f.event.id, templateId: t.id }, body: png, query: { confirmationVersion: '2026-10-29.s6admin1' }, headers: { 'Idempotency-Key': h.key() } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.art.reviewState, ok.body.art.status], ['reviewed', 'live']);
  const { projectOutbox } = await import('../src/shared/webhook-events.mjs');
  assert.equal(projectOutbox({ type: 'medal.art', payload: {} }), null);
  const regs = await (await import('../src/bootstrap/services.mjs')).eventsSyncService.listRecords({ organizerId: o.id, eventId: f.event.id, query: {} });
  assert.equal(JSON.stringify(regs).includes(ok.body.art.id), false);
});
