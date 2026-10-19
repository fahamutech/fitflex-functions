// Admin-managed app photos (plan docs/plans/photo-hero-sections-footer-admin-plan.md, slice 4).
//
// - Uploads are cleaned (rotated, metadata stripped) and kept PRIVATE on Zebra; only the server
//   knows their storage key. Admins preview them through the API.
// - Editing a slot changes its draft only. Publish freezes every slot into a snapshot and is the
//   only step that makes public files (WebP 2×/1×/wide + AVIF), for photos used for the first time.
//   The apps read the latest snapshot (GET /app/hero-images). Rollback re-publishes an earlier one
//   and puts the drafts back to it.
// - Any admin with the brand_media scope publishes alone (owner decision D-4); every write adds an
//   AuditLog row with before and after (never the private storage key).
// - The public manifest carries only what the apps draw with: no licence, uploader, drafts or keys.
import { createHash, randomUUID } from 'node:crypto';
import { HERO_SLOTS, heroSlot, textZoneFor } from '../shared/hero-slots.mjs';
import { prepareHeroUpload, buildHeroVariants, isBright, sha256 } from '../infra/hero-image-file.mjs';

export const HERO_PEOPLE = Object.freeze(['none', 'hands_backs', 'unclear_faces']);
export const HERO_MANIFEST_CACHE_MS = 60_000;
export const HERO_PUBLICATIONS_LISTED = 20;
const TEXT_MAX = 200;
const NOTE_MAX = 500;

/** What the apps get when there is nothing to show (flag off, or nothing published): use bundled photos. */
export const EMPTY_HERO_MANIFEST = Object.freeze({ etag: '"hp_0"', body: Object.freeze({ version: 0, slots: Object.freeze({}) }) });

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const text = (v, max = TEXT_MAX) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
};
const optionalText = (v, max = TEXT_MAX) => (v == null || v === '' ? { value: null } : text(v, max) ? { value: text(v, max) } : { invalid: true });
const round3 = n => Math.round(n * 1000) / 1000;
const shortHash = s => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const newImageId = () => `hero_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

function parseFocal(focal) {
  if (!focal || typeof focal !== 'object') return null;
  const x = Number(focal.x); const y = Number(focal.y);
  if (![x, y].every(n => Number.isFinite(n) && n >= -1 && n <= 1)) return null;
  return { x: round3(x), y: round3(y) };
}

/** An image as admins see it (and as the audit log records it): never the private storage key. */
export function adminImageView(img) {
  const lum = img.textZoneLuminance || null;
  return {
    id: img.id, status: img.status, width: img.width, height: img.height,
    focal: { x: img.focalX, y: img.focalY },
    variants: img.variants || null,
    textZoneLuminance: lum,
    brightWarning: { vertical: isBright(lum?.vertical), horizontal: isBright(lum?.horizontal) },
    source: img.source, photographer: img.photographer, licence: img.licence, licenceRef: img.licenceRef ?? null,
    people: img.people, consentRef: img.consentRef ?? null,
    rightsConfirmedBy: img.rightsConfirmedBy, rightsConfirmedAt: img.rightsConfirmedAt,
    noFacesConfirmedBy: img.noFacesConfirmedBy, noFacesConfirmedAt: img.noFacesConfirmedAt,
    createdBy: img.createdBy, createdAt: img.createdAt, updatedAt: img.updatedAt,
    previewUrl: `/admin/hero-images/${encodeURIComponent(img.id)}/preview`,
  };
}
const auditImage = img => { const { previewUrl, ...rest } = adminImageView(img); return rest; };

/** One photo in a snapshot: exactly the fields the public manifest may carry. */
function snapshotEntry(img) {
  const v = img.variants;
  return {
    id: `${img.id}-${shortHash(v.url2x)}`, sourceId: img.id,
    url: v.url2x, url1x: v.url1x, urlWide: v.urlWide, urlAvif: v.urlAvif ?? null,
    width: v.width2x, height: v.height2x, bytes: v.bytes2x,
    focal: { x: img.focalX, y: img.focalY },
  };
}
const PUBLIC_ENTRY_FIELDS = ['id', 'sourceId', 'url', 'url1x', 'urlWide', 'urlAvif', 'width', 'height', 'bytes'];
const publicEntry = e => ({
  ...Object.fromEntries(PUBLIC_ENTRY_FIELDS.map(k => [k, e?.[k] ?? null])),
  focal: { x: Number(e?.focal?.x ?? 0), y: Number(e?.focal?.y ?? 0) },
});

/** Snapshot slots as the public manifest shows them: known slots with at least one photo. */
function publicSlots(slots) {
  const out = {};
  for (const s of HERO_SLOTS) {
    const entries = Array.isArray(slots?.[s.id]) ? slots[s.id].filter(e => e?.url) : [];
    if (entries.length) out[s.id] = entries.map(publicEntry);
  }
  return out;
}
const slotImageIds = slots => Object.fromEntries(Object.entries(slots || {}).map(([k, list]) => [k, (list || []).map(e => e.sourceId)]));
const publicationView = p => (p ? {
  id: p.id, publishedBy: p.publishedBy, publishedAt: p.publishedAt, note: p.note, rolledBackFrom: p.rolledBackFrom,
  slots: slotImageIds(p.slots),
} : null);
const draftsBySlot = rows => {
  const out = {};
  for (const r of rows) (out[r.slotId] ||= []).push(r.imageId);
  return out;
};

export function createHeroImageService({
  store, documentStore = null, publicStore = null,
  now = () => new Date(), nowMs = () => Date.now(), logger = console,
}) {
  let cache = null; // { at, value }
  const invalidate = () => { cache = null; };
  const audit = (q, action, actor, target, before, after) => q.audit({ id: randomUUID(), at: now(), actor, action, target, before, after });

  // ── Admin: the whole picture ───────────────────────────────────────────────

  async function adminState() {
    const [images, drafts, publications] = await Promise.all([
      store.listImages(), store.drafts(), store.listPublications(HERO_PUBLICATIONS_LISTED),
    ]);
    const byId = new Map(images.map(i => [i.id, i]));
    const draft = draftsBySlot(drafts);
    const live = slotImageIds(publications[0]?.slots);
    return {
      images: images.map(adminImageView),
      slots: HERO_SLOTS.map(s => ({
        id: s.id, surface: s.surface, variant: s.variant, aspectHint: s.aspectHint, maxImages: s.maxImages,
        draft: draft[s.id] || [], published: live[s.id] || [],
        brightWarning: (draft[s.id] || []).some(id => isBright(byId.get(id)?.textZoneLuminance?.[textZoneFor(s)])),
      })),
      publications: publications.map(publicationView),
    };
  }

  // ── Admin: upload ──────────────────────────────────────────────────────────

  async function upload({ file, fields = {}, actorId }) {
    if (fields.rightsConfirmed !== 'true') return fail('rights_confirmation_required', 400);
    if (fields.noFacesConfirmed !== 'true') return fail('no_faces_confirmation_required', 400);
    const missing = ['source', 'photographer', 'licence'].filter(k => !text(fields[k]));
    if (missing.length) return fail('licence_details_required', 400, { fields: missing });
    if (!HERO_PEOPLE.includes(fields.people)) return fail('invalid_people', 400, { allowed: HERO_PEOPLE });
    const licenceRef = optionalText(fields.licenceRef);
    const consentRef = optionalText(fields.consentRef);
    if (licenceRef.invalid || consentRef.invalid) return fail('invalid_reference', 400);
    if (!file?.buffer?.length) return fail('no_file_provided', 400);
    if (file.truncated) return fail('file_too_large', 413);
    if (!documentStore) return fail('storage_service_unavailable', 503);

    const prepared = await prepareHeroUpload(file.buffer);
    if (prepared.error) return prepared;

    const id = newImageId();
    let stored;
    try {
      stored = await documentStore.put(prepared.buffer, `${id}.webp`, prepared.mimeType);
    } catch (err) {
      logger.error?.('[hero-images] private upload failed:', err?.message);
      return fail('storage_service_unavailable', 503);
    }
    const at = now();
    const row = {
      id, privateProvider: stored.provider, privateKey: stored.key, sha256: prepared.sha256, status: 'draft',
      width: prepared.width, height: prepared.height, focalX: 0, focalY: 0, variants: null,
      textZoneLuminance: prepared.luminance,
      source: text(fields.source), photographer: text(fields.photographer), licence: text(fields.licence),
      licenceRef: licenceRef.value, people: fields.people, consentRef: consentRef.value,
      rightsConfirmedBy: actorId, rightsConfirmedAt: at, noFacesConfirmedBy: actorId, noFacesConfirmedAt: at,
      createdBy: actorId, createdAt: at, updatedAt: at,
    };
    const image = await store.transaction(async (q) => {
      const saved = await q.insertImage(row);
      await audit(q, 'hero_image_uploaded', actorId, saved.id, null, auditImage(saved));
      return saved;
    });
    return { image: adminImageView(image) };
  }

  async function readPrivate(img) {
    if (!documentStore || documentStore.provider !== img.privateProvider) return fail('storage_service_unavailable', 503);
    let buffer;
    try {
      buffer = await documentStore.get(img.privateKey);
    } catch (err) {
      logger.error?.('[hero-images] private read failed:', err?.message);
      return fail('storage_service_unavailable', 503);
    }
    if (sha256(buffer) !== img.sha256) return fail('stored_file_mismatch', 502);
    return { buffer };
  }

  async function preview(id) {
    const img = await store.getImage(id);
    if (!img) return fail('image_not_found', 404);
    const r = await readPrivate(img);
    if (r.error) return r;
    return { file: { buffer: r.buffer, mimeType: 'image/webp', fileName: `${img.id}.webp` } };
  }

  // ── Admin: edit details / retire ───────────────────────────────────────────

  const EDITABLE = ['focal', 'source', 'photographer', 'licence', 'licenceRef', 'people', 'consentRef', 'status'];

  async function update(id, body = {}, actorId) {
    const unknown = Object.keys(body).filter(k => !EDITABLE.includes(k));
    if (unknown.length) return fail('unknown_field', 400, { fields: unknown });
    const patch = {};
    if ('focal' in body) {
      const f = parseFocal(body.focal);
      if (!f) return fail('invalid_focal', 400);
      patch.focalX = f.x; patch.focalY = f.y;
    }
    for (const k of ['source', 'photographer', 'licence']) {
      if (!(k in body)) continue;
      if (!text(body[k])) return fail('licence_details_required', 400, { fields: [k] });
      patch[k] = text(body[k]);
    }
    for (const k of ['licenceRef', 'consentRef']) {
      if (!(k in body)) continue;
      const v = optionalText(body[k]);
      if (v.invalid) return fail('invalid_reference', 400);
      patch[k] = v.value;
    }
    if ('people' in body) {
      if (!HERO_PEOPLE.includes(body.people)) return fail('invalid_people', 400, { allowed: HERO_PEOPLE });
      patch.people = body.people;
    }
    if ('status' in body && body.status !== 'retired') return fail('invalid_status', 400, { allowed: ['retired'] });
    const retiring = body.status === 'retired';
    if (!Object.keys(patch).length && !retiring) return fail('nothing_to_change', 400);

    return store.transaction(async (q) => {
      const before = await q.getImage(id);
      if (!before) return fail('image_not_found', 404);
      if (before.status === 'retired') return fail('image_retired', 409);
      const saved = await q.updateImage(id, { ...patch, ...(retiring ? { status: 'retired' } : {}), updatedAt: now() });
      let removedFromDraftSlots = [];
      if (retiring) removedFromDraftSlots = await q.removeFromDrafts(id);
      const live = await q.latestPublication();
      const inLiveSnapshot = Object.values(live?.slots || {}).some(list => (list || []).some(e => e.sourceId === id));
      await audit(q, retiring ? 'hero_image_retired' : 'hero_image_updated', actorId, id, auditImage(before),
        { ...auditImage(saved), ...(retiring ? { removedFromDraftSlots } : {}) });
      // A retired photo still shows until the next publish: the admin screen should offer one.
      return { image: adminImageView(saved), ...(retiring ? { removedFromDraftSlots, inLiveSnapshot } : {}) };
    });
  }

  // ── Admin: drafts ──────────────────────────────────────────────────────────

  async function setSlot(slotId, body = {}, actorId) {
    const slot = heroSlot(slotId);
    if (!slot) return fail('unknown_slot', 400);
    const ids = body.imageIds;
    if (!Array.isArray(ids) || ids.some(v => typeof v !== 'string' || !v)) return fail('invalid_image_ids', 400);
    if (new Set(ids).size !== ids.length) return fail('duplicate_image', 400);
    if (ids.length > slot.maxImages) return fail('too_many_images', 400, { maxImages: slot.maxImages });
    return store.transaction(async (q) => {
      const images = await q.getImages(ids);
      const found = new Map(images.map(i => [i.id, i]));
      const missing = ids.filter(i => !found.has(i));
      if (missing.length) return fail('image_not_found', 400, { imageIds: missing });
      const retired = ids.filter(i => found.get(i).status === 'retired');
      if (retired.length) return fail('image_retired', 400, { imageIds: retired });
      const before = draftsBySlot(await q.drafts())[slot.id] || [];
      await q.replaceSlot(slot.id, ids, actorId, now());
      await audit(q, 'hero_slot_updated', actorId, `slot:${slot.id}`, { imageIds: before }, { imageIds: ids });
      return { slot: { id: slot.id, draft: ids } };
    });
  }

  // ── Admin: publish / rollback ──────────────────────────────────────────────

  /** Make the public files for a photo used for the first time. */
  async function makeVariants(img, actorId) {
    if (!publicStore) return fail('storage_service_unavailable', 503);
    const master = await readPrivate(img);
    if (master.error) return master;
    const built = await buildHeroVariants(master.buffer);
    if (built.error) return { ...built, imageId: img.id };
    const urls = {};
    try {
      for (const [name, suffix] of [['x2', '2x'], ['x1', '1x'], ['wide', 'wide'], ['avif', 'wide']]) {
        urls[name] = (await publicStore.put(built[name].buffer, `${img.id}-${suffix}.${built[name].ext}`, built[name].mimeType)).url;
      }
    } catch (err) {
      logger.error?.('[hero-images] public upload failed:', err?.message);
      return fail('storage_service_unavailable', 503);
    }
    const variants = {
      url2x: urls.x2, url1x: urls.x1, urlWide: urls.wide, urlAvif: urls.avif,
      bytes2x: built.x2.bytes, bytes1x: built.x1.bytes, bytesWide: built.wide.bytes, bytesAvif: built.avif.bytes,
      width2x: built.x2.width, height2x: built.x2.height, width1x: built.x1.width, height1x: built.x1.height,
      widthWide: built.wide.width, heightWide: built.wide.height,
      quality2x: built.x2.quality, quality1x: built.x1.quality, qualityWide: built.wide.quality,
    };
    return store.transaction(async (q) => {
      const current = await q.getImage(img.id);
      // Another publish got there first: keep its files.
      if (current.variants) return { image: current };
      const saved = await q.updateImage(img.id, { variants, status: current.status === 'retired' ? 'retired' : 'published', updatedAt: now() });
      await audit(q, 'hero_image_published', actorId, img.id, auditImage(current), auditImage(saved));
      return { image: saved };
    });
  }

  async function publish(body = {}, actorId) {
    const note = optionalText(body.note, NOTE_MAX);
    if (note.invalid) return fail('invalid_note', 400, { maxLength: NOTE_MAX });

    // Public files first (slow, outside the lock); then the snapshot under the lock.
    const drafted = [...new Set((await store.drafts()).map(r => r.imageId))];
    for (const img of await store.getImages(drafted)) {
      if (img.variants || img.status === 'retired') continue;
      const made = await makeVariants(img, actorId);
      if (made.error) return made;
    }

    const publication = await store.transaction(async (q) => {
      const drafts = draftsBySlot(await q.drafts());
      const ids = [...new Set(Object.values(drafts).flat())];
      const byId = new Map((await q.getImages(ids)).map(i => [i.id, i]));
      const notReady = ids.filter(i => !byId.get(i)?.variants || byId.get(i).status === 'retired');
      if (notReady.length) return fail('drafts_changed', 409, { imageIds: notReady });
      const slots = {};
      for (const s of HERO_SLOTS) if (drafts[s.id]?.length) slots[s.id] = drafts[s.id].map(i => snapshotEntry(byId.get(i)));
      const previous = await q.latestPublication();
      const saved = await q.insertPublication({ slots, publishedBy: actorId, publishedAt: now(), note: note.value });
      await audit(q, 'hero_published', actorId, `publication:${saved.id}`,
        { publicationId: previous?.id ?? 0, slots: slotImageIds(previous?.slots) },
        { publicationId: saved.id, slots: slotImageIds(saved.slots), note: saved.note });
      return saved;
    });
    if (publication.error) return publication;
    invalidate();
    return { publication: publicationView(publication) };
  }

  async function rollback(body = {}, actorId) {
    const targetId = Number(body.publicationId);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return fail('invalid_publication_id', 400);
    const note = optionalText(body.note, NOTE_MAX);
    if (note.invalid) return fail('invalid_note', 400, { maxLength: NOTE_MAX });
    const result = await store.transaction(async (q) => {
      const target = await q.getPublication(targetId);
      if (!target) return fail('publication_not_found', 404);
      const latest = await q.latestPublication();
      if (latest?.id === target.id) return fail('already_current', 409);
      const ids = [...new Set(Object.values(target.slots || {}).flat().map(e => e.sourceId))];
      const byId = new Map((await q.getImages(ids)).map(i => [i.id, i]));
      const unusable = ids.filter(i => !byId.get(i) || byId.get(i).status === 'retired');
      if (unusable.length) return fail('image_retired', 409, { imageIds: unusable });

      const slots = {};
      for (const s of HERO_SLOTS) if (target.slots?.[s.id]?.length) slots[s.id] = target.slots[s.id];
      const draftsBefore = draftsBySlot(await q.drafts());
      const draftsAfter = slotImageIds(slots);
      const at = now();
      for (const s of HERO_SLOTS) {
        const was = draftsBefore[s.id] || []; const will = draftsAfter[s.id] || [];
        if (was.join('\n') !== will.join('\n')) await q.replaceSlot(s.id, will, actorId, at);
      }
      const saved = await q.insertPublication({ slots, publishedBy: actorId, publishedAt: at, note: note.value, rolledBackFrom: target.id });
      await audit(q, 'hero_rolled_back', actorId, `publication:${saved.id}`,
        { publicationId: latest?.id ?? 0, slots: slotImageIds(latest?.slots), drafts: draftsBefore },
        { publicationId: saved.id, rolledBackFrom: target.id, slots: draftsAfter, drafts: draftsAfter, note: saved.note });
      return saved;
    });
    if (result.error) return result;
    invalidate();
    return { publication: publicationView(result) };
  }

  // ── Public: the manifest the apps read ─────────────────────────────────────

  /** → { etag, body } of the latest snapshot; kept in memory for 60 s. */
  async function manifest() {
    const t = nowMs();
    if (cache && t - cache.at < HERO_MANIFEST_CACHE_MS) return cache.value;
    let value;
    try {
      const pub = await store.latestPublication();
      value = pub
        ? { etag: `"hp_${pub.id}"`, body: { version: pub.id, publishedAt: pub.publishedAt, slots: publicSlots(pub.slots) } }
        : EMPTY_HERO_MANIFEST;
    } catch (err) {
      // A short database outage keeps the last good answer rather than telling apps to purge.
      if (cache) return cache.value;
      throw err;
    }
    cache = { at: t, value };
    return value;
  }

  return { adminState, upload, preview, update, setSlot, publish, rollback, manifest, invalidateManifest: invalidate };
}
