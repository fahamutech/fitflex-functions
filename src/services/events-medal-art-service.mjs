// Marathon & running events · S6 — organizer medal artwork (spec §7.7, D54 as changed). RULE 6 / SECURITY AREA.
// Organizers upload their own design per medal template; the 8 built-in designs are the default and the fallback. Artwork goes live at once
// (show-now) and FitFlex takes it down afterwards, like partner photos and logos. Stored in the database (bytea, WebP only), served only
// to signed-in people who may see it, never as a remote URL: a client-supplied imageUrl is not a field anywhere in this slice.
//
// What this file adds to the pipeline in src/infra/medal-art-file.mjs: the caps that count attempts BEFORE the body is read (refused
// attempts never use the successful-upload allowance), the rights confirmation (draft text pending counsel), one live art per template,
// replacement / removal that really deletes bytes, takedown that keeps only the hashes, and the authorisation of who may fetch a file.
import { randomUUID } from 'node:crypto';
import { prepareMedalArt } from '../infra/medal-art-file.mjs';
import { createJobGate } from './partner-media-service.mjs';
import { createIdempotency } from '../shared/organizer-idempotency.mjs';
import { pixelSha256, sha256 } from '../infra/hero-image-file.mjs';
import { sha256hex } from '../shared/events-results-rules.mjs';
import { encodeCursor, decodeCursor, parseLimit } from '../shared/events-ops-rules.mjs';
import { COPY } from '../shared/events-results-copy.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v ? new Date(v).toISOString() : null);
const newId = () => `ema_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const DAY = 86_400_000;
const STAFF_WRITE = ['owner', 'admin'];
const STAFF_READ = ['owner', 'admin', 'timing'];

/** The organizer's warranty (draft pending Tanzanian counsel; the only copyright cover until organizer terms exist). */
export const MEDAL_ART_CONFIRMATION = Object.freeze({
  version: '2026-10-29.s6draft1', status: 'draft_pending_counsel',
  en: 'I made this design or have the right to use it. It does not use another brand\'s logo or an identifiable person\'s picture without permission. FitFlex may show it to participants in the app.',
  sw: 'Nimetengeneza muundo huu au nina haki ya kuutumia. Hauna nembo ya chapa nyingine wala picha ya mtu anayetambulika bila ruhusa. FitFlex inaweza kuuonyesha kwa washiriki kwenye app.',
});
export const ADMIN_MEDAL_ART_CONFIRMATION = Object.freeze({ version: '2026-10-29.s6admin1', status: 'draft_pending_counsel', en: 'FitFlex staff confirm this design was supplied by the organizer for use in the app.', sw: 'Wafanyakazi wa FitFlex wanathibitisha muundo huu uliletwa na mwandaaji kwa matumizi kwenye app.' });
export const TAKEDOWN_REASONS = Object.freeze(['inappropriate', 'rights', 'other_brand', 'person_request', 'quality', 'other']);
export const ART_RATE = Object.freeze({ personPerMinute: 5, personPerDay: 30, organizerPerMinute: 10, organizerPerDay: 60 });
const SERVED = ['m512', 'm256', 'm128'];
const PREVIEWS = { 240: 'p240', 480: 'p480' };

export function createEventsMedalArtService({
  db, results, notice = async () => {}, now = () => new Date(), maxBytes = () => 2 * 1024 * 1024, maxPixels = () => 16_000_000, uploadsPerDay = () => 20, gate = createJobGate(),
}) {
  const stamp = () => new Date(now());
  const idempotent = createIdempotency({ db, now });
  const { load, audit } = results.internals;

  const view = (a, { admin = false } = {}) => ({
    id: a.id, templateId: a.templateId, eventId: a.eventId, status: a.status, revision: a.revision, width: a.width, height: a.height, altText: a.altText ?? {}, source: 'custom',
    confirmedAt: iso(a.confirmedAt), createdAt: iso(a.createdAt),
    ...(a.status === 'taken_down' ? { takedown: { reason: a.reason, note: a.reasonNote ?? null, at: iso(a.decidedAt) } } : {}),
    ...(admin ? { reviewState: a.reviewState, confirmationVersion: a.confirmationVersion } : {}),
  });

  // ── Admission (before the body is read) ───────────────────────────────────

  /**
   * Checks that need no body: role, organizer, template, event, key; then the caps. The attempt row is written FIRST, so a refused or failed
   * upload counts. → { attemptId, ctx, template } or an error.
   */
  async function admit({ actor, organizerId = null, eventId, templateId, key }) {
    const isAdmin = actor.kind === 'admin';
    if (!isAdmin && !STAFF_WRITE.includes(actor.role)) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId: isAdmin ? null : organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    if (!isAdmin) {
      const org = plain(await db('EventOrganizer').where({ id: ctx.event.organizerId }).first('status'));
      if (org?.status !== 'active') return fail('organizer_not_active', 403);
    }
    if (ctx.event.status === 'cancelled') return fail('event_cancelled', 409);
    const template = plain(await db('EventMedalTemplate').where({ id: String(templateId), eventId: ctx.event.id }).first());
    if (!template) return fail('template_not_found', 404);
    if (key === undefined || key === null || key === '') return fail('idempotency_key_required', 400);
    if (typeof key !== 'string' || key.length < 8 || key.length > 100) return fail('invalid_idempotency_key', 400);
    const attemptId = `maa_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const at = stamp();
    await db('EventMedalArtUploadAttempt').insert({ id: attemptId, userId: actor.userId, organizerId: ctx.event.organizerId, createdAt: at });
    const count = async (col, val, since) => Number((await db('EventMedalArtUploadAttempt').where(col, val).where('createdAt', '>', since).count({ n: '*' }).first()).n);
    const limited = (retry, scope, max, limit) => fail('rate_limited', 429, { retryAfterSeconds: retry, limit, scope, max });
    if (await count('userId', actor.userId, new Date(+at - 60_000)) > ART_RATE.personPerMinute) return limited(60, 'person', ART_RATE.personPerMinute, 'minute');
    if (await count('userId', actor.userId, new Date(+at - DAY)) > ART_RATE.personPerDay) return limited(3600, 'person', ART_RATE.personPerDay, 'day');
    if (await count('organizerId', ctx.event.organizerId, new Date(+at - 60_000)) > ART_RATE.organizerPerMinute) return limited(60, 'organizer', ART_RATE.organizerPerMinute, 'minute');
    if (await count('organizerId', ctx.event.organizerId, new Date(+at - DAY)) > ART_RATE.organizerPerDay) return limited(3600, 'organizer_attempts', ART_RATE.organizerPerDay, 'day');
    const successes = Number((await db('EventMedalArtUploadAttempt').where({ organizerId: ctx.event.organizerId, succeeded: true }).where('createdAt', '>', new Date(+at - DAY)).count({ n: '*' }).first()).n);
    if (successes >= uploadsPerDay()) return limited(3600, 'organizer', uploadsPerDay(), 'day');
    return { attemptId, ctx, template };
  }

  // ── Store ─────────────────────────────────────────────────────────────────

  async function store({ actor, admission, buffer, confirmationVersion, altText = null, key }) {
    const { ctx, template, attemptId } = admission;
    const isAdmin = actor.kind === 'admin';
    const required = isAdmin ? ADMIN_MEDAL_ART_CONFIRMATION : MEDAL_ART_CONFIRMATION;
    const fingerprint = { templateId: template.id, body: Buffer.isBuffer(buffer) ? sha256hex(buffer.toString('base64')) : null, confirmationVersion, altText };
    return idempotent({ actor, route: `medalart.upload:${template.id}`, key, body: fingerprint }, async () => {
      const prepared = await gate.run(() => prepareMedalArt(buffer, { maxBytes: maxBytes(), maxPixels: maxPixels() }));
      if (prepared.busy) return fail('busy', 503, { retryAfterSeconds: 5 });
      const p = prepared.value;
      if (p.error) { await audit('system', 'events.medal_art_refused', ctx.event.id, null, { code: p.error }); return p; }
      if (confirmationVersion !== required.version) return fail('confirmation_outdated', 409, { current: required });
      const blocked = await db('EventMedalArt').where({ status: 'taken_down' }).where(function same() { this.where('sha256', p.sha256).orWhere('pixelSha256', p.pixelSha256); }).first('id');
      if (blocked) return fail('file_not_allowed', 409);
      const alt = {};
      for (const lang of ['en', 'sw']) {
        const v = altText?.[lang];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string' || v.trim().length > 120) return fail('validation_failed', 422, { fields: [{ path: `altText.${lang}`, code: 'too_long' }] });
        alt[lang] = v.trim();
      }
      const out = await db.transaction(async (trx) => {
        const tpl = plain(await trx('EventMedalTemplate').where({ id: template.id }).forUpdate().first());
        const prev = plain(await trx('EventMedalArt').where({ templateId: tpl.id, status: 'live' }).forUpdate().first());
        const at = stamp();
        if (prev) {
          await trx('EventMedalArtFile').where({ artId: prev.id }).del();
          await trx('EventMedalArt').where({ id: prev.id }).update({ status: 'replaced', statusChangedBy: actor.userId, statusChangedAt: at, updatedAt: at });
        }
        const id = newId();
        const revisions = Number((await trx('EventMedalArt').where({ templateId: tpl.id }).count({ n: '*' }).first()).n);
        const [row] = await trx('EventMedalArt').insert({
          id, eventId: ctx.event.id, organizerId: ctx.event.organizerId, templateId: tpl.id, status: 'live', revision: revisions + 1, reviewState: isAdmin ? 'reviewed' : 'to_review',
          reviewedBy: isAdmin ? actor.userId : null, reviewedAt: isAdmin ? at : null, width: p.width, height: p.height, altText: JSON.stringify(alt), confirmationVersion: required.version,
          confirmedBy: actor.userId, confirmedAt: at, uploadedBy: actor.userId, createdAt: at, updatedAt: at,
        }).returning('*');
        for (const f of p.files) await trx('EventMedalArtFile').insert({ artId: id, variant: f.variant, contentType: 'image/webp', bytes: f.buffer, byteSize: f.buffer.length });
        await trx('EventMedalTemplate').where({ id: tpl.id }).update({ artId: id, updatedAt: at });
        await trx('EventMedalArtUploadAttempt').where({ id: attemptId }).update({ succeeded: true });
        await audit(actor, prev ? 'events.medal_art_replaced' : 'events.medal_art_uploaded', ctx.event.id, prev ? { artId: prev.id } : null,
          { artId: id, templateId: tpl.id, width: p.width, height: p.height, bytes: p.files.reduce((n, f) => n + f.buffer.length, 0), confirmationVersion: required.version }, trx);
        return { art: view(plain(row), { admin: isAdmin }), status: 201 };
      });
      return out;
    });
  }

  // ── Organizer: alt text, remove, preview ──────────────────────────────────

  async function ownTemplate({ actor, organizerId, eventId, templateId, level }) {
    if (level === 'write' ? !STAFF_WRITE.includes(actor.role) : !STAFF_READ.includes(actor.role)) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    if (!ctx) return fail('event_not_found', 404);
    const template = plain(await db('EventMedalTemplate').where({ id: String(templateId), eventId: ctx.event.id }).first());
    return template ? { ctx, template } : fail('template_not_found', 404);
  }

  async function patchAlt({ actor, organizerId, eventId, templateId, key, body = {} }) {
    const t = await ownTemplate({ actor, organizerId, eventId, templateId, level: 'write' });
    if (t.error) return t;
    const alt = {};
    for (const lang of ['en', 'sw']) {
      const v = body.altText?.[lang];
      if (v === undefined) continue;
      if (v !== null && v !== '' && (typeof v !== 'string' || v.trim().length > 120)) return fail('validation_failed', 422, { fields: [{ path: `altText.${lang}`, code: 'too_long' }] });
      if (v) alt[lang] = v.trim();
    }
    return idempotent({ actor, route: `medalart.alt:${templateId}`, key, body }, async () => {
      const art = plain(await db('EventMedalArt').where({ templateId: t.template.id, status: 'live' }).first());
      if (!art) return fail('art_not_found', 404);
      const [row] = await db('EventMedalArt').where({ id: art.id }).update({ altText: JSON.stringify(alt), updatedAt: stamp() }).returning('*');
      await audit(actor, 'events.medal_art_updated', t.ctx.event.id, null, { artId: art.id }, db);
      return { art: view(plain(row)), status: 200 };
    });
  }

  async function remove({ actor, organizerId, eventId, templateId, key }) {
    const t = await ownTemplate({ actor, organizerId, eventId, templateId, level: 'write' });
    if (t.error) return t;
    return idempotent({ actor, route: `medalart.remove:${templateId}`, key, body: {} }, async () => db.transaction(async (trx) => {
      const art = plain(await trx('EventMedalArt').where({ templateId: t.template.id, status: 'live' }).forUpdate().first());
      if (!art) return fail('art_not_found', 404);
      const at = stamp();
      await trx('EventMedalArtFile').where({ artId: art.id }).del();
      await trx('EventMedalArt').where({ id: art.id }).update({ status: 'removed', statusChangedBy: actor.userId, statusChangedAt: at, updatedAt: at });
      await trx('EventMedalTemplate').where({ id: t.template.id }).update({ artId: null, updatedAt: at });
      await audit(actor, 'events.medal_art_removed', t.ctx.event.id, { artId: art.id }, { templateId: t.template.id }, trx);
      return { removed: { artId: art.id }, status: 200 };
    }));
  }

  /** Staff preview of the live art (the stored 240 / 480 previews only; nothing is resized per request). */
  async function staffPreview({ actor, organizerId, eventId, templateId, width }) {
    const t = await ownTemplate({ actor, organizerId, eventId, templateId, level: 'read' });
    if (t.error) return t;
    const variant = PREVIEWS[Number(width ?? 240)];
    if (!variant) return fail('invalid_request', 400, { field: 'w' });
    const file = await db('EventMedalArtFile as f').join('EventMedalArt as a', 'a.id', 'f.artId').where({ 'a.templateId': t.template.id, 'a.status': 'live', 'f.variant': variant }).first('f.bytes', 'a.id');
    return file ? { file: { buffer: file.bytes, id: file.id } } : fail('art_not_found', 404);
  }

  // ── Serving ───────────────────────────────────────────────────────────────

  /**
   * GET /events/medal-art/:artId/file — signed in only. Allowed: a member who holds (or held) an award from the template, staff of the event's
   * organizer, a FitFlex admin with `events`. Everyone else, a non-live art id and the master all answer 404, never 403.
   */
  async function serve({ viewer, artId, variant = 'm512' }) {
    if (!SERVED.includes(variant)) return fail('not_found', 404);
    const art = plain(await db('EventMedalArt').where({ id: String(artId), status: 'live' }).first());
    if (!art) return fail('not_found', 404);
    let allowedToSee = false;
    if (viewer.userType === 'admin') allowedToSee = viewer.adminEvents === true;
    else {
      allowedToSee = Boolean(await db('EventOrganizerStaff').where({ organizerId: art.organizerId, userId: viewer.userId, status: 'active' }).first('id'));
      if (!allowedToSee) {
        allowedToSee = Boolean(await db('EventMedalAward as a').join('EventRegistration as r', 'r.id', 'a.registrationId')
          .where({ 'a.medalTemplateId': art.templateId, 'r.participantUserId': viewer.userId }).first('a.id'));
      }
    }
    if (!allowedToSee) return fail('not_found', 404);
    const file = await db('EventMedalArtFile').where({ artId: art.id, variant }).first('bytes');
    return file ? { file: { buffer: file.bytes, id: art.id } } : fail('not_found', 404);
  }

  // ── FitFlex moderation ────────────────────────────────────────────────────

  async function adminList({ query = {} }) {
    const limit = parseLimit(query.limit);
    if (limit === null) return fail('invalid_request', 400, { field: 'limit' });
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) return fail('invalid_cursor', 400);
    const q = db('EventMedalArt as a').join('Event as e', 'e.id', 'a.eventId').join('EventOrganizer as o', 'o.id', 'a.organizerId').join('EventMedalTemplate as t', 't.id', 'a.templateId')
      .leftJoin('EventCategory as c', 'c.id', 't.categoryId');
    if (query.status) { if (!['live', 'replaced', 'removed', 'taken_down'].includes(String(query.status))) return fail('invalid_request', 400, { field: 'status' }); q.where('a.status', String(query.status)); } else q.where('a.status', 'live');
    if (query.reviewState) { if (!['to_review', 'reviewed'].includes(String(query.reviewState))) return fail('invalid_request', 400, { field: 'reviewState' }); q.where('a.reviewState', String(query.reviewState)); }
    if (cursor?.at) q.where(function k() { this.where('a.createdAt', '>', new Date(cursor.at)).orWhere(function t() { this.where('a.createdAt', new Date(cursor.at)).where('a.id', '>', cursor.id); }); });
    const rows = (await q.orderBy('a.createdAt').orderBy('a.id').limit(limit + 1)
      .select('a.*', 'e.title as eventTitle', 'o.name as organizerName', 't.tier', 'c.name as categoryName')).map(plain);
    const page = rows.slice(0, limit);
    const since = new Date(+stamp() - 30 * DAY);
    const downs = new Map((await db('EventMedalArt').where({ status: 'taken_down' }).where('decidedAt', '>', since).whereIn('organizerId', page.map(r => r.organizerId)).groupBy('organizerId').select('organizerId').count({ n: '*' })).map(r => [r.organizerId, Number(r.n)]));
    const toReview = Number((await db('EventMedalArt').where({ status: 'live', reviewState: 'to_review' }).count({ n: '*' }).first()).n);
    return {
      toReview,
      items: page.map(r => ({
        ...view(r, { admin: true }), eventTitle: r.eventTitle, organizerName: r.organizerName, tier: r.tier, categoryName: r.categoryName,
        organizerTakedowns30d: downs.get(r.organizerId) ?? 0, highlightOrganizer: (downs.get(r.organizerId) ?? 0) >= 3,
      })),
      nextCursor: rows.length > limit ? encodeCursor({ at: page[page.length - 1].createdAt, id: page[page.length - 1].id }) : null,
    };
  }

  async function adminPreview({ id, width }) {
    const variant = PREVIEWS[Number(width ?? 240)];
    if (!variant) return fail('invalid_request', 400, { field: 'w' });
    const file = await db('EventMedalArtFile').where({ artId: String(id), variant }).first('bytes');
    return file ? { file: { buffer: file.bytes, id: String(id) } } : fail('not_found', 404);
  }

  async function markReviewed({ admin, id }) {
    const [row] = await db('EventMedalArt').where({ id: String(id), status: 'live' }).update({ reviewState: 'reviewed', reviewedBy: admin, reviewedAt: stamp(), updatedAt: stamp() }).returning('*');
    if (!row) return fail('not_found', 404);
    await audit(admin, 'events.medal_art_reviewed', row.eventId, null, { artId: row.id });
    return { art: view(plain(row), { admin: true }) };
  }

  async function takeDown({ admin, id, body = {} }) {
    if (!TAKEDOWN_REASONS.includes(body.reason)) return fail('validation_failed', 422, { fields: [{ path: 'reason', code: 'invalid', allowed: TAKEDOWN_REASONS }] });
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 200 || (body.reason === 'other' && note.length < 3)) return fail('validation_failed', 422, { fields: [{ path: 'note', code: note.length > 200 ? 'too_long' : 'required' }] });
    let taken = null;
    const out = await db.transaction(async (trx) => {
      const art = plain(await trx('EventMedalArt').where({ id: String(id) }).forUpdate().first());
      if (!art) return fail('not_found', 404);
      if (art.status !== 'live') return fail('invalid_transition', 409, { from: art.status, to: 'taken_down' });
      const master = await trx('EventMedalArtFile').where({ artId: art.id, variant: 'master' }).first('bytes');
      const hashes = master ? { sha256: sha256(master.bytes), pixelSha256: await pixelSha256(master.bytes) } : { sha256: null, pixelSha256: null };
      const at = stamp();
      await trx('EventMedalArtFile').where({ artId: art.id }).del();
      const [row] = await trx('EventMedalArt').where({ id: art.id }).update({ status: 'taken_down', reason: body.reason, reasonNote: note || null, decidedBy: admin, decidedAt: at, statusChangedBy: admin, statusChangedAt: at, updatedAt: at, purgedAt: at, ...hashes }).returning('*');
      await trx('EventMedalTemplate').where({ id: art.templateId }).update({ artId: null, updatedAt: at });
      await audit(admin, 'events.medal_art_taken_down', art.eventId, { status: 'live' }, { artId: art.id, reason: body.reason, hashed: Boolean(hashes.sha256) }, trx);
      taken = art;
      return { art: view(plain(row), { admin: true }) };
    });
    if (taken && !out.error) await tellOrganizer(taken, body.reason);
    return out;
  }

  async function tellOrganizer(art, reason) {
    try {
      const event = plain(await db('Event').where({ id: art.eventId }).first('title'));
      const staff = await db('EventOrganizerStaff').where({ organizerId: art.organizerId, status: 'active' }).whereIn('role', ['owner', 'admin']).select('userId');
      const copy = COPY.artTakenDown({ event: event.title, reason });
      for (const s of staff) await notice(s.userId, { id: `evart:${art.id}:taken_down_${s.userId}`.slice(0, 60), type: 'event_medal_art_taken_down', en: copy.en, sw: copy.sw, data: { eventId: art.eventId, route: `/organizer/events?event=${art.eventId}&view=results&section=medals`, essential: true } });
    } catch (err) { console.warn('[events-medal-art] notice skipped:', err?.message); }
  }

  return { admit, store, patchAlt, remove, staffPreview, serve, adminList, adminPreview, markReviewed, takeDown, confirmation: () => MEDAL_ART_CONFIRMATION };
}
