// Partner hero photo and logo (plan docs/plans/partner-hero-media-plan.md slice 1; design spec
// photo-hero-screens.md §39–§45; owner decisions 2026-10-29; security review of functions#277).
// Dormant behind PARTNER_MEDIA (the routes check the flag; this service does not).
//
// - A gym (per gym), a trainer profile or a vendor has at most one live photo ('hero') and one live
//   logo. An upload is live as soon as it is cleaned (post-moderation, D-3); the previous live item
//   becomes `replaced` in the same transaction and its bytes are deleted.
// - Tenancy is decided HERE, from the stored accounts, not only by route guards:
//     gym      owner: the gym is in their own gymIds; gym staff: the gym is in their gymIds (read),
//              plus the `gyms` scope on their stored record (write). With V2_ORG_AUTHZ enforcing,
//              ACTIVE OrgMemberships at that gym decide instead (owner → read + write; staff →
//              read, + write with `gyms`). Takedown notices use the same rule (review L6).
//     trainer  only the TrainerProfile whose userId is the caller.
//     vendor   the vendor account; active vendor staff of that vendor (read), vendorRole admin (write).
//   An item of another partner reads as 404 media_not_found, never 403.
// - Abuse limits (O-P5, review M3/L8): per person (checked before the body is read, admitUpload) and
//   per partner, a minute window in memory and a daily count of ATTEMPTS in the database, counted
//   under a lock. At most IMAGE_JOBS.concurrent images are decoded at once in this process.
// - FitFlex: `moderation_decide` marks an item reviewed (never one's own upload) or takes it down
//   (reason code; the bytes are deleted at once, the hashes kept for O-P2); `brand_media` sets a
//   photo or logo for a partner directly (live and reviewed; no notice, O-P3). Putting back a file
//   that was taken down needs `moderation_decide` (and a reason, when it was a person's request; L2).
// - Bytes are deleted on replace, remove, takedown and purge; the metadata row stays (O-P4: no
//   evidence copy). purgeSubject (review M2) runs when a gym, trainer profile or partner account goes.
// - Every write adds an AuditLog row `partner_media.<action>` with ids only; the upload hashes appear
//   only on taken-down items (review L5). Never bytes, never the note text.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  ADMIN_CONFIRMATION, DEFAULT_VARIANT, IMAGE_JOBS, MEDIA_KINDS, NOTE_MAX, OVERRIDE_REASON_MAX, PARTNER_CONFIRMATION, PARTNER_MEDIA_LIMITS,
  PLATE_CHOICES, PREVIEW_VARIANT_OF_WIDTH, PREVIEW_WIDTHS, SERVED_VARIANTS, SUBJECT_TYPES, SUBJECT_TYPE_OF_ROLE, TAKEDOWN_REASONS,
  UPLOAD_RATE, confirmed, parseFocal, settingsRoute, takenDownMessage,
} from '../shared/partner-media-rules.mjs';
import {
  buildLogoVariants, buildPartnerHeroVariants, isBright, looksLikeSvg, pixelSha256, plateFor, prepareHeroUpload, prepareLogoUpload,
  previewAt, sniffImageType,
} from '../infra/hero-image-file.mjs';
import { createVendorLimiter } from '../shared/vendor-rate-limit.mjs';
import { storeNameOf } from '../shared/vendor-name.mjs';

const DAY_MS = 86_400_000;
const ATTEMPT_KEEP_MS = 2 * DAY_MS;
const CLOSED_ACCOUNTS = new Set(['suspended', 'closed']);
const SYSTEM_ACTOR = 'system';
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const newMediaId = () => `pmd_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
// File ids are random and never reused: they are the files' ETags.
const newFileId = () => `pmf_${randomBytes(16).toString('hex')}`;
const sha256Of = buffer => createHash('sha256').update(buffer).digest('hex');
const ownGymIds = row => (Array.isArray(row?.gymIds) && row.gymIds.length ? row.gymIds : row?.gymId ? [row.gymId] : []);
const vendorNameOf = row => storeNameOf({ ...row, vendorProfile: typeof row?.vendorProfile === 'string' ? JSON.parse(row.vendorProfile) : row?.vendorProfile });
const notFound = () => fail('media_not_found', 404);
const filePath = (id, variant) => `/partner/media/${encodeURIComponent(id)}/file?variant=${variant}`;

// Magic bytes first (review L7), then sharp's own reading of the format.
const HERO_SNIFFED = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);
const LOGO_SNIFFED = new Set(['jpeg', 'png', 'webp']);
const HERO_FORMATS = ['jpeg', 'png', 'webp', 'heif'];

/**
 * At most `max` jobs at once; up to `maxWaiting` more wait their turn; beyond that → { busy: true }.
 * A finished job hands its place straight to the next one, so the limit is never exceeded.
 */
export function createJobGate({ max = IMAGE_JOBS.concurrent, maxWaiting = IMAGE_JOBS.maxWaiting } = {}) {
  let active = 0;
  const waiting = [];
  async function run(fn) {
    if (active < max) active += 1;
    else {
      if (waiting.length >= maxWaiting) return { busy: true };
      await new Promise(resolve => waiting.push(resolve));
    }
    try {
      return { value: await fn() };
    } finally {
      const next = waiting.shift();
      if (next) next(); else active -= 1;
    }
  }
  return { run, stats: () => ({ active, waiting: waiting.length }) };
}

// One gate for the whole process (every service instance shares the CPU).
const processImageGate = createJobGate();
let sharpTuned = false;
/** Review M3: libvips uses one thread per image job. Process-wide; applied on the first partner image job only. */
function tuneSharp() {
  if (sharpTuned) return;
  sharp.concurrency(1);
  sharpTuned = true;
}

export function createPartnerMediaService({
  store,
  notify = async () => {},          // (userId, { id, type, title, body, data }) → inbox + push
  localeOf = async () => null,      // the person's chosen message language ('en' | 'sw' | null)
  orgAuthzMode = () => 'off',
  now = () => new Date(),
  logger = console,
  minuteLimiter = createVendorLimiter({ perMinute: UPLOAD_RATE.perMinute }),
  userMinuteLimiter = createVendorLimiter({ perMinute: UPLOAD_RATE.perUserMinute }),
  imageGate = processImageGate,
}) {
  const stamp = () => now().toISOString();
  const dayAgo = () => new Date(now().getTime() - DAY_MS).toISOString();
  let lastAuditMs = 0;
  const auditAt = () => {
    lastAuditMs = Math.max(now().getTime(), lastAuditMs + 1);
    return new Date(lastAuditMs).toISOString();
  };
  // Review L5: the upload's hashes are recorded only once it is taken down (O-P2 needs them there).
  const snapshot = m => (m ? {
    id: m.id, subjectType: m.subjectType, subjectId: m.subjectId, kind: m.kind, origin: m.origin, status: m.status,
    revision: m.revision, reviewState: m.reviewState, reason: m.reason ?? null,
    ...(m.status === 'taken_down' ? { sha256: m.sha256 ?? null, pixelSha256: m.pixelSha256 ?? null } : {}),
    focalX: m.focalX ?? null, focalY: m.focalY ?? null, plate: m.plate ?? null, plateChoice: m.plateChoice ?? null,
    confirmationVersion: m.confirmationVersion,
  } : null);
  const audit = (q, action, actor, m, before, after, extra = {}) => q.audit({
    id: randomUUID(), at: auditAt(), actor, action: `partner_media.${action}`, target: m.id,
    before: snapshot(before), after: after ? { ...snapshot(after), ...extra } : extra,
  });
  const slotKey = (subjectType, subjectId, kind) => `slot:${subjectType}:${subjectId}:${kind}`;
  const enforce = () => orgAuthzMode() === 'enforce';

  // ── Who may see and change whose media ──────────────────────────────────────

  /**
   * The partner the caller acts for, and whether they may change its media.
   * `target` = { gymId } (the caller's own home) or { subject: { type, id } } (an item's partner:
   * anything that is not the caller's reads as 404 media_not_found).
   * → { subject: { type, id, name }, canEdit, editRule } or { error, status }.
   */
  async function resolveAccess(claims, target = {}) {
    const forItem = Boolean(target.subject);
    const deny = out => (forItem ? notFound() : out);
    const type = SUBJECT_TYPE_OF_ROLE[claims?.userType];
    if (!type || !claims?.sub) return deny(fail('acl_forbidden', 403));
    if (forItem && target.subject.type !== type) return notFound();
    const me = await store.userRow(claims.sub);
    if (!me || me.userType !== claims.userType || CLOSED_ACCOUNTS.has(me.accountStatus)) return deny(fail('acl_forbidden', 403));

    if (type === 'gym') {
      const gymId = forItem ? target.subject.id : target.gymId;
      if (typeof gymId !== 'string' || !gymId.trim()) return fail('gym_id_required', 400, { field: 'gymId' });
      const owner = claims.userType === 'gym_operator';
      let member = false; let canEdit = false;
      if (enforce()) {
        const rows = await store.gymMemberships(claims.sub, gymId);
        const m = rows.find(r => r.role === (owner ? 'owner' : 'staff'));
        member = Boolean(m);
        canEdit = member && (owner || (m.aclPermissions || []).includes('gyms'));
      } else {
        member = ownGymIds(me).includes(gymId);
        canEdit = member && (owner || (Array.isArray(me.aclPermissions) && me.aclPermissions.includes('gyms')));
      }
      if (!member) return deny(fail('not_your_gym', 403));
      const gym = await store.gymRow(gymId);
      if (!gym) return deny(fail('subject_not_found', 404));
      return { subject: { type, id: gym.id, name: gym.name ?? null }, canEdit, editRule: 'gyms' };
    }
    if (type === 'trainer') {
      const t = forItem ? await store.trainerRow(target.subject.id) : await store.trainerByUser(claims.sub);
      if (!t || t.userId !== claims.sub) return deny(fail('subject_not_found', 404));
      return { subject: { type, id: t.id, name: t.displayName ?? null }, canEdit: true, editRule: 'own_profile' };
    }
    // vendor
    const staff = claims.userType === 'vendor_staff';
    if (staff && (!me.vendorId || me.vendorId !== claims.vendorId || me.accountStatus !== 'active')) return deny(fail('acl_forbidden', 403));
    const vendorId = staff ? me.vendorId : me.id;
    if (forItem && target.subject.id !== vendorId) return notFound();
    const vendor = await store.vendorRow(vendorId);
    if (!vendor || CLOSED_ACCOUNTS.has(vendor.accountStatus)) return deny(fail('subject_not_found', 404));
    return { subject: { type, id: vendor.id, name: vendorNameOf(vendor) }, canEdit: !staff || me.vendorRole === 'admin', editRule: 'vendor_admin' };
  }

  const editRefusal = acc => fail('acl_forbidden', 403, { requiredScope: acc.editRule });

  /** An item the caller's partner owns (any status) → { item, acc } or { error }. */
  async function ownItem(claims, id) {
    const item = await store.getMedia(id);
    if (!item) return notFound();
    const acc = await resolveAccess(claims, { subject: { type: item.subjectType, id: item.subjectId } });
    if (acc.error) return acc;
    return { item, acc };
  }

  /** The partners whose takedowns count for an upload to this one (review L1: every gym of the same owner). */
  const takedownScope = async subject => (subject.type === 'gym' ? store.relatedGymIds(subject.id) : [subject.id]);

  // ── Views ───────────────────────────────────────────────────────────────────

  async function views(rows, side, { actorId = null, subjects = null } = {}) {
    if (!rows.length) return [];
    const metas = await store.fileMeta(rows.filter(r => r.status === 'live').map(r => r.id));
    // Review L4: the partner side shows display names only, never an email.
    const names = await store.displayNames(rows.flatMap(r => [r.uploadedBy, r.reviewedBy, r.decidedBy, r.rightsConfirmedBy, r.ownLogoConfirmedBy]), { displayOnly: side !== 'admin' });
    return rows.map(r => view(r, { meta: metas.get(r.id) || {}, names, side, actorId, subject: subjects?.get?.(r.id) }));
  }

  /**
   * MediaItem (spec §44.4). The partner side never names FitFlex staff: for items FitFlex set, and
   * for review and takedown, the person is left out (by/byName are admin-only).
   */
  function view(m, { meta, names, side, actorId, subject }) {
    const admin = side === 'admin';
    const live = m.status === 'live';
    const staffItem = m.origin === 'fitflex';
    const who = id => (admin || !staffItem ? id ?? null : null);
    const whoName = id => (admin || !staffItem ? (id ? names[id] ?? null : null) : null);
    const files = {}; const bytes = {};
    if (live) {
      for (const v of SERVED_VARIANTS[m.kind]) {
        if (!meta[v]) continue;
        if (!admin) files[v] = filePath(m.id, v);
        bytes[v] = meta[v].bytes;
      }
    }
    const out = {
      id: m.id,
      kind: m.kind,
      subject: subject || { type: m.subjectType, id: m.subjectId, name: m.subjectName ?? null },
      status: m.status,
      origin: m.origin,
      review: {
        state: m.reviewState,
        ...(admin ? { by: m.reviewedBy ?? null, byName: m.reviewedBy ? names[m.reviewedBy] ?? null : null } : {}),
        at: m.reviewedAt ?? null,
      },
      takedown: m.status === 'taken_down' ? {
        reason: m.reason, note: m.reasonNote ?? null,
        ...(admin ? { by: m.decidedBy, byName: names[m.decidedBy] ?? null } : {}),
        at: m.decidedAt,
      } : null,
      width: m.width,
      height: m.height,
      ...(m.kind === 'hero' ? {
        focal: { x: m.focalX ?? 0, y: m.focalY ?? 0 },
        bright: isBright({ mean: m.textZoneMean ?? 0, maxPatch: m.textZonePatch ?? 0 }),
      } : {
        plate: m.plate, plateChoice: m.plateChoice,
      }),
      files: admin ? null : files,
      bytes,
      uploadedBy: who(m.uploadedBy),
      uploadedByName: whoName(m.uploadedBy),
      uploadedByRole: m.uploadedByRole,
      confirmationVersion: m.confirmationVersion,
      rightsConfirmedBy: who(m.rightsConfirmedBy),
      rightsConfirmedAt: m.rightsConfirmedAt,
      rightsConfirmedByName: whoName(m.rightsConfirmedBy),
      ...(m.kind === 'logo' ? {
        ownLogoConfirmedBy: who(m.ownLogoConfirmedBy),
        ownLogoConfirmedAt: m.ownLogoConfirmedAt ?? null,
        ownLogoConfirmedByName: whoName(m.ownLogoConfirmedBy),
      } : {}),
      revision: m.revision,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
    if (admin) {
      out.ownUpload = Boolean(actorId) && actorId === m.uploadedBy;
      out.previewUrl = live ? `/admin/partner-media/${encodeURIComponent(m.id)}/preview` : null;
      out.statusChangedAt = m.statusChangedAt ?? null;
    }
    return out;
  }

  const partnerConfirmation = () => ({
    version: PARTNER_CONFIRMATION.version, status: PARTNER_CONFIRMATION.status,
    rights: { ...PARTNER_CONFIRMATION.rights }, ownLogo: { ...PARTNER_CONFIRMATION.ownLogo },
  });
  const limitsView = () => ({
    hero: { minWidth: PARTNER_MEDIA_LIMITS.hero.minWidth, maxBytes: PARTNER_MEDIA_LIMITS.hero.maxBytes, types: [...PARTNER_MEDIA_LIMITS.hero.types] },
    logo: { minSide: PARTNER_MEDIA_LIMITS.logo.minSide, maxBytes: PARTNER_MEDIA_LIMITS.logo.maxBytes, types: [...PARTNER_MEDIA_LIMITS.logo.types] },
  });

  // ── Partner: read ───────────────────────────────────────────────────────────

  /** GET /partner/media: the caller's home photo and logo, with canEdit, texts and limits. */
  async function overview({ claims, gymId = null }) {
    const acc = await resolveAccess(claims, { gymId });
    if (acc.error) return acc;
    const rows = await store.listForSubject(acc.subject.type, acc.subject.id);
    const out = { subject: acc.subject, canEdit: acc.canEdit };
    const subjects = new Map(rows.map(r => [r.id, acc.subject]));
    for (const kind of MEDIA_KINDS) {
      const ofKind = rows.filter(r => r.kind === kind);
      const live = ofKind.find(r => r.status === 'live') || null;
      // The latest event is a takedown only when nothing was uploaded after it.
      const newest = ofKind[0] || null;
      const lastTakedown = !live && newest?.status === 'taken_down' ? newest : null;
      const shown = live || lastTakedown;
      const [v] = shown ? await views([shown], 'partner', { subjects }) : [null];
      out[kind] = { live: live ? v : null, lastTakedown: lastTakedown ? v : null };
    }
    out.confirmation = partnerConfirmation();
    out.limits = limitsView();
    return out;
  }

  /**
   * GET /partner/media/:id/file?variant= — a live item's bytes, to signed-in readers of its partner
   * only (O-P1). The file id is the ETag: a matching If-None-Match → { notModified } without reading
   * the bytes; a removed item answers 404 at the next revalidation (review M1).
   */
  async function file({ claims, id, variant = null, ifNoneMatch = null }) {
    const own = await ownItem(claims, id);
    if (own.error) return own;
    const { item } = own;
    const v = variant == null || variant === '' ? DEFAULT_VARIANT[item.kind] : String(variant);
    if (!SERVED_VARIANTS[item.kind].includes(v)) return fail('invalid_variant', 400, { allowed: SERVED_VARIANTS[item.kind] });
    if (item.status !== 'live') return notFound();
    const fileId = await store.fileId(item.id, v);
    if (!fileId) return notFound();
    const etag = `"${fileId}"`;
    if (ifNoneMatch && String(ifNoneMatch).split(',').map(s => s.trim().replace(/^W\//, '')).includes(etag)) return { notModified: true, etag };
    const f = await store.getFile(item.id, v);
    if (!f) return notFound();
    return { file: { id: f.id, buffer: f.data, mimeType: f.contentType } };
  }

  /** A stored preview (made at upload; review M3): ?w = 240 | 480 | 960 (default 960). Live items only. */
  async function previewOf(item, width) {
    const w = width == null || width === '' ? 960 : Number(width);
    if (!PREVIEW_WIDTHS.includes(w)) return fail('invalid_width', 400, { allowed: PREVIEW_WIDTHS });
    if (item.status !== 'live') return fail('image_not_found', 404);
    const f = await store.getFile(item.id, PREVIEW_VARIANT_OF_WIDTH[w]);
    if (!f) return fail('image_not_found', 404);
    return { file: { buffer: f.data, mimeType: 'image/webp', fileName: `${item.id}-${w}.webp` } };
  }

  /** GET /partner/media/:id/preview?w= — a thumbnail for the item's own partner (no-store). */
  async function preview({ claims, id, width = null }) {
    const own = await ownItem(claims, id);
    if (own.error) return own;
    return previewOf(own.item, width);
  }

  // ── Uploads (partner and FitFlex) ───────────────────────────────────────────

  /**
   * Review M3: the route guard asks this BEFORE the request body is read. Every attempt counts
   * (refused and failed ones too): 10 a minute per person (this server) and 40 a day per person
   * (all servers; counted and written under the person's lock, L8). → { attemptId } or { error: rate_limited }.
   */
  async function admitUpload(claims) {
    if (!claims?.sub) return fail('acl_forbidden', 403);
    const minute = userMinuteLimiter.allow(`user:${claims.sub}`, now().getTime());
    if (!minute.ok) return fail('rate_limited', 429, { retryAfterSeconds: minute.retryAfterSeconds, limit: 'minute', scope: 'person', max: UPLOAD_RATE.perUserMinute });
    const attemptId = `pma_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    return store.transaction(`rate:user:${claims.sub}`, async (q) => {
      if (await q.countUserAttempts(claims.sub, dayAgo()) >= UPLOAD_RATE.perUserDay) {
        return fail('rate_limited', 429, { retryAfterSeconds: 3600, limit: 'day', scope: 'person', max: UPLOAD_RATE.perUserDay });
      }
      await q.insertAttempt({ id: attemptId, userId: claims.sub, createdAt: stamp() });
      return { attemptId };
    });
  }

  /** The partner's daily cap (O-P5): counted and claimed under the partner's lock (L8). */
  async function claimSubjectAttempt({ claims, subject, attemptId }) {
    return store.transaction(`rate:${subject.type}:${subject.id}`, async (q) => {
      if (await q.countSubjectAttempts(subject.type, subject.id, dayAgo()) >= UPLOAD_RATE.perDay) {
        return fail('rate_limited', 429, { retryAfterSeconds: 3600, limit: 'day', scope: 'partner', max: UPLOAD_RATE.perDay });
      }
      if (attemptId) await q.setAttemptSubject(attemptId, subject.type, subject.id);
      else await q.insertAttempt({ id: `pma_${randomUUID().replace(/-/g, '').slice(0, 20)}`, userId: claims.sub, subjectType: subject.type, subjectId: subject.id, createdAt: stamp() });
      return null;
    });
  }

  /** Clean the upload and make its files, at most IMAGE_JOBS.concurrent at a time. → { prepared, files[] } or { error }. */
  async function processImage(kind, buffer) {
    if (looksLikeSvg(buffer)) return fail('svg_not_allowed', 400);
    const sniffed = sniffImageType(buffer);
    if (!sniffed || !(kind === 'hero' ? HERO_SNIFFED : LOGO_SNIFFED).has(sniffed)) return fail('unsupported_file_type', 400, { reason: 'not_an_accepted_image' });
    const job = await imageGate.run(async () => {
      tuneSharp();
      return kind === 'hero' ? processHero(buffer) : processLogo(buffer);
    });
    if (job.busy) return fail('image_service_busy', 503, { retryAfterSeconds: 5 });
    return job.value;
  }
  async function previews(master) {
    const out = [];
    for (const w of PREVIEW_WIDTHS) {
      const buffer = await previewAt(master, w);
      const meta = await sharp(buffer).metadata();
      out.push({ variant: PREVIEW_VARIANT_OF_WIDTH[w], buffer, width: meta.width, height: meta.height });
    }
    return out;
  }
  async function processHero(buffer) {
    const prepared = await prepareHeroUpload(buffer, {
      maxBytes: PARTNER_MEDIA_LIMITS.hero.maxBytes, minWidth: PARTNER_MEDIA_LIMITS.hero.minWidth, formats: HERO_FORMATS,
    });
    if (prepared.error) return prepared;
    const variants = await buildPartnerHeroVariants(prepared.buffer);
    if (variants.error) return variants;
    const v = prepared.luminance;
    return {
      prepared: {
        width: prepared.width, height: prepared.height, pixelSha256: await pixelSha256(prepared.buffer),
        textZoneMean: Math.max(v.vertical.mean, v.horizontal.mean), textZonePatch: Math.max(v.vertical.maxPatch, v.horizontal.maxPatch),
      },
      files: [
        { variant: 'master', buffer: prepared.buffer, width: prepared.width, height: prepared.height },
        { variant: 'x2', buffer: variants.x2.buffer, width: variants.x2.width, height: variants.x2.height },
        { variant: 'x1', buffer: variants.x1.buffer, width: variants.x1.width, height: variants.x1.height },
        ...await previews(prepared.buffer),
      ],
    };
  }
  async function processLogo(buffer) {
    const prepared = await prepareLogoUpload(buffer, PARTNER_MEDIA_LIMITS.logo);
    if (prepared.error) return prepared;
    const variants = await buildLogoVariants(prepared.buffer);
    if (variants.error) return variants;
    return {
      prepared: {
        width: prepared.width, height: prepared.height, pixelSha256: await pixelSha256(prepared.buffer),
        logoLuminance: prepared.luminance, plateAuto: prepared.plateAuto,
      },
      files: [
        { variant: 'master', buffer: prepared.buffer, width: prepared.width, height: prepared.height },
        { variant: 'logo256', buffer: variants.logo256.buffer, width: variants.logo256.width, height: variants.logo256.height },
        { variant: 'logo128', buffer: variants.logo128.buffer, width: variants.logo128.width, height: variants.logo128.height },
        ...await previews(prepared.buffer),
      ],
    };
  }

  /**
   * Make the new item live: the previous live one is replaced and its bytes deleted, in one transaction.
   * `beforeSave(q)` may refuse (→ { error }) inside the lock, e.g. the O-P2 check.
   */
  async function saveLive({ subject, kind, row, files, actorId, beforeSave = null, auditExtra = {} }) {
    const refuse = out => { throw Object.assign(new Error(out.error), { refusal: out }); };
    try {
      return await store.transaction(slotKey(subject.type, subject.id, kind), async (q) => {
        if (beforeSave) {
          const refused = await beforeSave(q);
          if (refused) refuse(refused);
        }
        const at = row.createdAt;
        const prev = await q.liveFor(subject.type, subject.id, kind);
        if (prev) {
          const replaced = await q.updateMedia(prev.id, {
            status: 'replaced', statusChangedBy: actorId, statusChangedAt: at, sha256: null, pixelSha256: null, revision: prev.revision + 1, updatedAt: at,
          });
          const deleted = await q.deleteFiles(prev.id);
          await audit(q, 'replaced', actorId, prev, prev, replaced, { replacedBy: row.id, filesDeleted: deleted });
        }
        const saved = await q.insertMedia(row);
        await q.insertFiles(saved.id, files.map(f => ({ ...f, id: newFileId(), contentType: 'image/webp' })));
        await audit(q, row.origin === 'fitflex' ? 'set_by_fitflex' : 'uploaded', actorId, saved, null, saved, {
          width: saved.width, height: saved.height, replaced: prev?.id ?? null,
          files: files.map(f => ({ variant: f.variant, bytes: f.buffer.length })), ...auditExtra,
        });
        return saved;
      });
    } catch (err) {
      if (err?.refusal) return err.refusal;
      logger.error?.(`[partner-media] save failed for ${subject.type}/${subject.id}/${kind}: ${err?.message}`);
      return fail('image_save_failed', 500);
    }
  }

  /**
   * POST /partner/media/hero | /logo. fields: rightsConfirmed, confirmationVersion, (logo) ownLogoConfirmed,
   * plate?; (hero) focalX?, focalY?; gymId (gym roles). The file is checked and cleaned here.
   * `attemptId` comes from admitUpload (the route guard); without it the attempt is recorded here.
   */
  async function upload({ claims, kind, file: upload, fields = {}, gymId = null, attemptId = null }) {
    if (!MEDIA_KINDS.includes(kind)) return fail('invalid_kind', 400);
    const acc = await resolveAccess(claims, { gymId: gymId ?? fields.gymId ?? null });
    if (acc.error) return acc;
    if (!acc.canEdit) return editRefusal(acc);
    const { subject } = acc;

    const minute = minuteLimiter.allow(`${subject.type}:${subject.id}`, now().getTime());
    if (!minute.ok) return fail('rate_limited', 429, { retryAfterSeconds: minute.retryAfterSeconds, limit: 'minute', scope: 'partner', max: UPLOAD_RATE.perMinute });
    const capped = await claimSubjectAttempt({ claims, subject, attemptId });
    if (capped) return capped;

    if ('people' in fields || 'peopleConfirmed' in fields) return fail('unknown_field', 400, { field: 'people' in fields ? 'people' : 'peopleConfirmed' });
    if (fields.confirmationVersion !== PARTNER_CONFIRMATION.version) {
      return fail('confirmation_version_mismatch', 400, { field: 'confirmationVersion', current: PARTNER_CONFIRMATION.version });
    }
    if (!confirmed(fields.rightsConfirmed)) return fail('rights_confirmation_required', 400, { field: 'rightsConfirmed' });
    let focal = null; let plateChoice = null;
    if (kind === 'logo') {
      if (!confirmed(fields.ownLogoConfirmed)) return fail('own_logo_confirmation_required', 400, { field: 'ownLogoConfirmed' });
      plateChoice = fields.plate == null || fields.plate === '' ? 'auto' : String(fields.plate);
      if (!PLATE_CHOICES.includes(plateChoice)) return fail('invalid_plate', 400, { allowed: PLATE_CHOICES });
    } else {
      const fx = parseFocal(fields.focalX); const fy = parseFocal(fields.focalY);
      if (fx.invalid || fy.invalid) return fail('invalid_focal', 400);
      focal = { x: fx.value, y: fy.value };
    }
    if (!upload?.buffer?.length) return fail('no_file_provided', 400);
    if (upload.truncated) return fail('file_too_large', 413, { maxBytes: PARTNER_MEDIA_LIMITS[kind].maxBytes });

    // O-P2 / L1: the same file — same bytes, or the same pixels re-saved — taken down for this partner
    // (or any gym of the same owner) before is refused. Checked before the work and again in the lock.
    const scope = await takedownScope(subject);
    const sha256 = sha256Of(upload.buffer);
    if ((await store.takenDownMatches(subject.type, scope, { sha256 })).length) return fail('image_taken_down_before', 409);
    const processed = await processImage(kind, upload.buffer);
    if (processed.error) return processed;
    const hashes = { sha256, pixelSha256: processed.prepared.pixelSha256 };

    const at = stamp();
    const row = baseRow({ subject, kind, processed, focal, plateChoice, hashes, at, actorId: claims.sub, role: claims.userType });
    Object.assign(row, {
      origin: 'partner', reviewState: 'to_review',
      confirmationVersion: PARTNER_CONFIRMATION.version, rightsConfirmedBy: claims.sub, rightsConfirmedAt: at,
      ...(kind === 'logo' ? { ownLogoConfirmedBy: claims.sub, ownLogoConfirmedAt: at } : {}),
    });
    const saved = await saveLive({
      subject, kind, row, files: processed.files, actorId: claims.sub,
      beforeSave: async q => ((await q.takenDownMatches(subject.type, scope, hashes)).length ? fail('image_taken_down_before', 409) : null),
    });
    if (saved.error) return saved;
    const [item] = await views([saved], 'partner', { subjects: new Map([[saved.id, subject]]) });
    return { item };
  }

  function baseRow({ subject, kind, processed, focal, plateChoice, hashes, at, actorId, role }) {
    const p = processed.prepared;
    return {
      id: newMediaId(), subjectType: subject.type, subjectId: subject.id, kind, status: 'live', revision: 1,
      width: p.width, height: p.height,
      ...(kind === 'hero'
        ? { focalX: focal.x, focalY: focal.y, textZoneMean: p.textZoneMean, textZonePatch: p.textZonePatch }
        : { plateChoice, plate: plateChoice === 'auto' ? p.plateAuto : plateChoice, logoLuminance: p.logoLuminance }),
      sha256: hashes.sha256, pixelSha256: hashes.pixelSha256, uploadedBy: actorId, uploadedByRole: role, createdAt: at, updatedAt: at,
    };
  }

  /** DELETE /partner/media/:id — the partner removes their live item; its bytes go at once. */
  async function remove({ claims, id }) {
    const own = await ownItem(claims, id);
    if (own.error) return own;
    if (!own.acc.canEdit) return editRefusal(own.acc);
    const { item } = own;
    try {
      const saved = await store.transaction(slotKey(item.subjectType, item.subjectId, item.kind), async (q) => {
        const cur = await q.getMedia(item.id);
        if (!cur || cur.status !== 'live') return fail('not_editable', 409, { currentStatus: cur?.status ?? null });
        const at = stamp();
        const after = await q.updateMedia(cur.id, {
          status: 'removed', statusChangedBy: claims.sub, statusChangedAt: at, sha256: null, pixelSha256: null, revision: cur.revision + 1, updatedAt: at,
        });
        const deleted = await q.deleteFiles(cur.id);
        await audit(q, 'removed', claims.sub, cur, cur, after, { filesDeleted: deleted });
        return after;
      });
      if (saved.error) return saved;
      const [view0] = await views([saved], 'partner', { subjects: new Map([[saved.id, own.acc.subject]]) });
      return { item: view0 };
    } catch (err) {
      logger.error?.(`[partner-media] remove failed for ${id}: ${err?.message}`);
      return fail('image_save_failed', 500);
    }
  }

  // ── FitFlex (admin) ─────────────────────────────────────────────────────────

  const ADMIN_TABS = ['to_review', 'live', 'taken_down'];

  /**
   * GET /admin/partner-media — the queue. Review L3: an admin with brand_media but neither moderation
   * scope sees only tab=live for one partner (subjectId required), which is what the Set-photo dialog needs.
   * viewer = { canModerate }.
   */
  async function adminList({ query = {}, actorId, viewer = { canModerate: true } }) {
    const tab = query.tab == null || query.tab === '' ? 'to_review' : String(query.tab);
    if (!ADMIN_TABS.includes(tab)) return fail('invalid_tab', 400, { allowed: ADMIN_TABS });
    const subjectType = query.subjectType || query.type || null;
    if (subjectType && !SUBJECT_TYPES.includes(subjectType)) return fail('invalid_subject_type', 400, { allowed: SUBJECT_TYPES });
    const kind = query.kind || null;
    if (kind && !MEDIA_KINDS.includes(kind)) return fail('invalid_kind', 400, { allowed: MEDIA_KINDS });
    const subjectId = typeof query.subjectId === 'string' && query.subjectId ? query.subjectId : null;
    if (!viewer.canModerate && (tab !== 'live' || !subjectId)) {
      return fail('acl_forbidden', 403, { requiredScope: 'moderation', allowedWithBrandMedia: { tab: 'live', subjectId: 'required' } });
    }
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
    const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
    const search = typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 100) : null;
    const { rows, total } = await store.adminList({ tab, subjectType, kind, subjectId, search, limit, offset });
    return { items: await views(rows, 'admin', { actorId }), total, next: offset + rows.length < total ? offset + rows.length : null };
  }

  async function adminView(m, actorId) {
    const named = await subjectWithName(m.subjectType, m.subjectId);
    const [v] = await views([m], 'admin', { actorId, subjects: new Map([[m.id, named ?? { type: m.subjectType, id: m.subjectId, name: null }]]) });
    return v;
  }
  /** { type, id, name } of an existing partner, or null when it no longer exists (closed vendors count as gone). */
  async function subjectWithName(type, id) {
    if (type === 'gym') { const g = await store.gymRow(id); return g ? { type, id, name: g.name ?? null } : null; }
    if (type === 'trainer') { const t = await store.trainerRow(id); return t ? { type, id, name: t.displayName ?? null } : null; }
    const v = await store.vendorRow(id);
    return v && v.accountStatus !== 'closed' ? { type, id, name: vendorNameOf(v) } : null;
  }

  /** GET /admin/partner-media/:id/preview?w= — 404 when the partner no longer exists (review M2). */
  async function adminPreview({ id, width = null }) {
    const item = await store.getMedia(id);
    if (!item || !(await subjectWithName(item.subjectType, item.subjectId))) return notFound();
    return previewOf(item, width);
  }

  const revisionOf = (revision) => {
    if (revision == null || revision === '') return { missing: true };
    const n = Number(revision);
    return Number.isInteger(n) && n > 0 ? { value: n } : { invalid: true };
  };
  /** Shared checks of an admin decision on a live item, inside its lock. */
  function decisionState(cur, rev) {
    if (!cur) return notFound();
    if (cur.status === 'replaced' || cur.status === 'removed') return fail('media_gone', 404, { currentStatus: cur.status });
    if (cur.status !== 'live') return fail('not_editable', 409, { currentStatus: cur.status });
    if (rev.value !== cur.revision) return fail('stale_revision', 409, { revision: cur.revision });
    return null;
  }

  /** POST /admin/partner-media/:id/reviewed { revision } — "Looks fine". */
  async function markReviewed({ actorId, id, revision }) {
    const rev = revisionOf(revision);
    if (rev.missing) return fail('revision_required', 400, { field: 'revision' });
    if (rev.invalid) return fail('invalid_revision', 400, { field: 'revision' });
    const item = await store.getMedia(id);
    if (!item) return notFound();
    const out = await store.transaction(slotKey(item.subjectType, item.subjectId, item.kind), async (q) => {
      const cur = await q.getMedia(id);
      const refused = decisionState(cur, rev);
      if (refused) return refused;
      if (cur.uploadedBy === actorId) return fail('own_upload', 403);
      if (cur.reviewState === 'reviewed') return cur;
      const at = stamp();
      const after = await q.updateMedia(cur.id, { reviewState: 'reviewed', reviewedBy: actorId, reviewedAt: at, revision: cur.revision + 1, updatedAt: at });
      await audit(q, 'reviewed', actorId, cur, cur, after);
      return after;
    });
    if (out.error) return out;
    return { item: await adminView(out, actorId) };
  }

  /** POST /admin/partner-media/:id/take-down { revision, reason, note? } */
  async function takeDown({ actorId, id, revision, reason, note }) {
    if (reason == null || reason === '') return fail('reason_required', 400, { field: 'reason' });
    if (typeof reason !== 'string' || !TAKEDOWN_REASONS[reason]) return fail('invalid_reason', 400, { field: 'reason', allowed: Object.keys(TAKEDOWN_REASONS) });
    if (note != null && typeof note !== 'string') return fail('invalid_note', 400, { field: 'note' });
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim() : null;
    if (cleanNote && cleanNote.length > NOTE_MAX) return fail('note_too_long', 400, { field: 'note', maxLength: NOTE_MAX });
    if (reason === 'other' && !cleanNote) return fail('note_required', 400, { field: 'note' });
    const rev = revisionOf(revision);
    if (rev.missing) return fail('revision_required', 400, { field: 'revision' });
    if (rev.invalid) return fail('invalid_revision', 400, { field: 'revision' });
    const item = await store.getMedia(id);
    if (!item) return notFound();
    if (!TAKEDOWN_REASONS[reason].includes(item.kind)) return fail('invalid_reason', 400, { field: 'reason', allowedFor: TAKEDOWN_REASONS[reason] });
    const out = await store.transaction(slotKey(item.subjectType, item.subjectId, item.kind), async (q) => {
      const cur = await q.getMedia(id);
      const refused = decisionState(cur, rev);
      if (refused) return refused;
      const at = stamp();
      const after = await q.updateMedia(cur.id, {
        status: 'taken_down', reason, reasonNote: cleanNote, decidedBy: actorId, decidedAt: at,
        statusChangedBy: actorId, statusChangedAt: at, revision: cur.revision + 1, updatedAt: at,
      });
      const deleted = await q.deleteFiles(cur.id);
      // O-P4: no evidence copy — the reason, note, who, when and the upload's hashes only.
      await audit(q, 'taken_down', actorId, cur, cur, after, { filesDeleted: deleted, hasNote: Boolean(cleanNote) });
      return after;
    });
    if (out.error) return out;
    await tellTakenDown(out);
    return { item: await adminView(out, actorId) };
  }

  /** partner_media.taken_down to the people who run that home (§44.3 audience), in their language; never the note. */
  async function tellTakenDown(m) {
    let recipients = [];
    try {
      if (m.subjectType === 'gym') recipients = await store.gymAudience(m.subjectId, { enforce: enforce() });
      else if (m.subjectType === 'trainer') recipients = [(await store.trainerRow(m.subjectId))?.userId].filter(Boolean);
      else recipients = await store.vendorAudience(m.subjectId);
    } catch (err) {
      logger.warn?.(`[partner-media] takedown audience for ${m.id} failed: ${err?.message}`);
      return;
    }
    const texts = takenDownMessage(m.kind, m.reason);
    const route = settingsRoute(m.subjectType, m.subjectId);
    for (const userId of [...new Set(recipients)]) {
      try {
        const locale = await localeOf(userId);
        // The convention of the partner notices: English only for those who chose it.
        const text = locale === 'en' ? texts.en : texts.sw;
        await notify(userId, {
          id: `ntf_pmtd_${m.id.replace(/[^A-Za-z0-9]/g, '').slice(-20)}_${String(userId).replace(/[^A-Za-z0-9]/g, '').slice(-10)}`,
          type: 'partner_media.taken_down',
          title: text.title,
          body: text.body,
          data: {
            mediaId: m.id, kind: m.kind, subjectType: m.subjectType, subjectId: m.subjectId,
            ...(m.subjectType === 'gym' ? { gymId: m.subjectId } : {}),
            reason: m.reason, route, open: 'brand_media',
            titleEn: texts.en.title, bodyEn: texts.en.body, titleSw: texts.sw.title, bodySw: texts.sw.body,
          },
        });
      } catch (err) {
        logger.warn?.(`[partner-media] takedown notice to ${userId} failed: ${err?.message}`);
      }
    }
  }

  /** GET /admin/partner-media/confirmation */
  const adminConfirmation = () => ({
    adminConfirmation: {
      version: ADMIN_CONFIRMATION.version, status: ADMIN_CONFIRMATION.status,
      rights: { ...ADMIN_CONFIRMATION.rights }, partnerLogo: { ...ADMIN_CONFIRMATION.partnerLogo },
    },
    limits: limitsView(),
  });

  /**
   * POST /admin/partner-media (brand_media) — FitFlex sets a partner's photo or logo: live and reviewed at once.
   * Review L2: a file matching a taken-down item of this partner (or a gym of the same owner) is a
   * reinstatement: it needs viewer.canDecide (moderation_decide or super-admin), and when that
   * takedown was a person's request, an `overrideReason`. Audited as reinstates: <id>.
   */
  async function adminSet({ actorId, file: upload, fields = {}, viewer = { canDecide: false } }) {
    const subjectType = fields.subjectType;
    if (!SUBJECT_TYPES.includes(subjectType)) return fail('invalid_subject_type', 400, { allowed: SUBJECT_TYPES });
    const kind = fields.kind;
    if (!MEDIA_KINDS.includes(kind)) return fail('invalid_kind', 400, { allowed: MEDIA_KINDS });
    if (typeof fields.subjectId !== 'string' || !fields.subjectId) return fail('subject_not_found', 404);
    const subject = await subjectWithName(subjectType, fields.subjectId);
    if (!subject) return fail('subject_not_found', 404);
    if ('people' in fields || 'peopleConfirmed' in fields) return fail('unknown_field', 400, { field: 'people' in fields ? 'people' : 'peopleConfirmed' });
    if (fields.adminConfirmationVersion !== ADMIN_CONFIRMATION.version) {
      return fail('confirmation_version_mismatch', 400, { field: 'adminConfirmationVersion', current: ADMIN_CONFIRMATION.version });
    }
    if (!confirmed(fields.rightsConfirmed)) return fail('rights_confirmation_required', 400, { field: 'rightsConfirmed' });
    const overrideReason = typeof fields.overrideReason === 'string' && fields.overrideReason.trim() ? fields.overrideReason.trim() : null;
    if (overrideReason && overrideReason.length > OVERRIDE_REASON_MAX) return fail('override_reason_too_long', 400, { maxLength: OVERRIDE_REASON_MAX });
    let focal = null; let plateChoice = null;
    if (kind === 'logo') {
      if (!confirmed(fields.partnerLogoConfirmed)) return fail('partner_logo_confirmation_required', 400, { field: 'partnerLogoConfirmed' });
      plateChoice = fields.plate == null || fields.plate === '' ? 'auto' : String(fields.plate);
      if (!PLATE_CHOICES.includes(plateChoice)) return fail('invalid_plate', 400, { allowed: PLATE_CHOICES });
    } else {
      const fx = parseFocal(fields.focalX); const fy = parseFocal(fields.focalY);
      if (fx.invalid || fy.invalid) return fail('invalid_focal', 400);
      focal = { x: fx.value, y: fy.value };
    }
    if (!upload?.buffer?.length) return fail('no_file_provided', 400);
    if (upload.truncated) return fail('file_too_large', 413, { maxBytes: PARTNER_MEDIA_LIMITS[kind].maxBytes });
    const processed = await processImage(kind, upload.buffer);
    if (processed.error) return processed;
    const hashes = { sha256: sha256Of(upload.buffer), pixelSha256: processed.prepared.pixelSha256 };
    const scope = await takedownScope(subject);
    const reinstateCheck = (matches) => {
      if (!matches.length) return null;
      if (!viewer.canDecide) return fail('reinstate_requires_moderation_decide', 403, { reinstates: matches[0].id, requiredScope: 'moderation_decide' });
      if (matches.some(m => m.reason === 'person_request') && !overrideReason) {
        return fail('override_reason_required', 409, { reinstates: matches[0].id, field: 'overrideReason', takedownReason: 'person_request' });
      }
      return null;
    };
    const early = reinstateCheck(await store.takenDownMatches(subject.type, scope, hashes));
    if (early) return early;
    const at = stamp();
    const row = baseRow({ subject, kind, processed, focal, plateChoice, hashes, at, actorId, role: 'admin' });
    Object.assign(row, {
      origin: 'fitflex', reviewState: 'reviewed', reviewedBy: actorId, reviewedAt: at,
      confirmationVersion: ADMIN_CONFIRMATION.version, rightsConfirmedBy: actorId, rightsConfirmedAt: at,
      ...(kind === 'logo' ? { ownLogoConfirmedBy: actorId, ownLogoConfirmedAt: at } : {}),
    });
    const auditExtra = {};
    const saved = await saveLive({
      subject, kind, row, files: processed.files, actorId, auditExtra,
      beforeSave: async (q) => {
        const matches = await q.takenDownMatches(subject.type, scope, hashes);
        const refused = reinstateCheck(matches);
        if (refused) return refused;
        if (matches.length) Object.assign(auditExtra, { reinstates: matches[0].id, reinstatesReason: matches[0].reason, ...(overrideReason ? { overrideReason } : {}) });
        return null;
      },
    });
    if (saved.error) return saved;
    // No notice (O-P3).
    return { item: await adminView(saved, actorId) };
  }

  /** PATCH /admin/partner-media/:id (brand_media) { focal?: { x, y } (hero), plate?: auto|light|dark (logo), revision? } */
  async function adminUpdate({ actorId, id, body = {} }) {
    const allowed = new Set(['focal', 'plate', 'revision']);
    const unknown = Object.keys(body).find(k => !allowed.has(k));
    if (unknown) return fail('unknown_field', 400, { field: unknown });
    if (body.focal === undefined && body.plate === undefined) return fail('nothing_to_change', 400);
    const rev = revisionOf(body.revision);
    if (rev.invalid) return fail('invalid_revision', 400, { field: 'revision' });
    const item = await store.getMedia(id);
    if (!item) return notFound();
    const patch = {};
    if (body.focal !== undefined) {
      if (item.kind !== 'hero') return fail('field_not_applicable', 400, { field: 'focal' });
      const fx = parseFocal(body.focal?.x); const fy = parseFocal(body.focal?.y);
      if (!body.focal || typeof body.focal !== 'object' || fx.invalid || fy.invalid) return fail('invalid_focal', 400);
      Object.assign(patch, { focalX: fx.value, focalY: fy.value });
    }
    if (body.plate !== undefined) {
      if (item.kind !== 'logo') return fail('field_not_applicable', 400, { field: 'plate' });
      if (!PLATE_CHOICES.includes(body.plate)) return fail('invalid_plate', 400, { allowed: PLATE_CHOICES });
      Object.assign(patch, { plateChoice: body.plate, plate: body.plate === 'auto' ? plateFor(item.logoLuminance) : body.plate });
    }
    const out = await store.transaction(slotKey(item.subjectType, item.subjectId, item.kind), async (q) => {
      const cur = await q.getMedia(id);
      if (!cur) return notFound();
      if (cur.status === 'replaced' || cur.status === 'removed') return fail('media_gone', 404, { currentStatus: cur.status });
      if (cur.status !== 'live') return fail('not_editable', 409, { currentStatus: cur.status });
      if (!rev.missing && rev.value !== cur.revision) return fail('stale_revision', 409, { revision: cur.revision });
      const at = stamp();
      const after = await q.updateMedia(cur.id, { ...patch, revision: cur.revision + 1, updatedAt: at });
      await audit(q, 'updated', actorId, cur, cur, after);
      return after;
    });
    if (out.error) return out;
    return { item: await adminView(out, actorId) };
  }

  // ── Purge (security review M2) ──────────────────────────────────────────────

  /**
   * A partner went (gym deleted, trainer profile deleted, vendor account closed or deleted): in one
   * transaction under both slot locks, every file of its media is deleted, live items become removed,
   * and every row loses its hashes and note and is marked purged — so a re-created id shows nothing.
   * Safe to repeat. → { items, files }.
   */
  async function purgeSubject(subjectType, subjectId, { actor = SYSTEM_ACTOR, cause = 'subject_removed' } = {}) {
    if (!SUBJECT_TYPES.includes(subjectType) || typeof subjectId !== 'string' || !subjectId) return { items: 0, files: 0 };
    return store.transaction(MEDIA_KINDS.map(kind => slotKey(subjectType, subjectId, kind)), async (q) => {
      let files = 0;
      const rows = await q.unpurgedOf(subjectType, subjectId);
      for (const cur of rows) {
        const at = stamp();
        const deleted = await q.deleteFiles(cur.id);
        files += deleted;
        const after = await q.updateMedia(cur.id, {
          ...(cur.status === 'live' ? { status: 'removed', statusChangedBy: actor, statusChangedAt: at } : {}),
          sha256: null, pixelSha256: null, reasonNote: null, purgedAt: at, revision: cur.revision + 1, updatedAt: at,
        });
        await audit(q, 'purged', actor, cur, cur, after, { cause, filesDeleted: deleted });
      }
      return { items: rows.length, files };
    });
  }

  /**
   * An account was deleted or closed (`user` = the stored row as it was). Vendor: its media. Trainer:
   * media of trainer profiles that no longer exist. Gym owner: media of their gyms no open owner runs
   * any more. Other roles have no media. Never throws on a missing row.
   */
  async function purgeAccount(user, { actor = SYSTEM_ACTOR, cause = 'account_removed' } = {}) {
    if (!user?.id) return { items: 0, files: 0 };
    const total = { items: 0, files: 0 };
    const add = r => { total.items += r.items; total.files += r.files; };
    if (user.userType === 'vendor') add(await purgeSubject('vendor', user.id, { actor, cause }));
    if (user.userType === 'trainer') add(await purgeOrphans({ subjectType: 'trainer', actor, cause }));
    if (user.userType === 'gym_operator') {
      for (const gymId of await store.gymsWithoutOwner(ownGymIds(user))) add(await purgeSubject('gym', gymId, { actor, cause }));
    }
    return total;
  }

  /** Purge the media of every partner that no longer exists (optionally of one type). → { subjects, items, files }. */
  async function purgeOrphans({ subjectType = null, actor = SYSTEM_ACTOR, cause = 'orphan_sweep', limit = 500 } = {}) {
    const out = { subjects: 0, items: 0, files: 0 };
    for (const s of await store.orphanSubjects(limit)) {
      if (subjectType && s.subjectType !== subjectType) continue;
      const r = await purgeSubject(s.subjectType, s.subjectId, { actor, cause });
      out.subjects += 1; out.items += r.items; out.files += r.files;
    }
    return out;
  }

  /** The nightly sweep: orphaned media, and upload attempts older than two days. */
  async function sweep() {
    const orphans = await purgeOrphans();
    const attempts = await store.deleteAttemptsBefore(new Date(now().getTime() - ATTEMPT_KEEP_MS).toISOString());
    return { ...orphans, attemptsDeleted: Number(attempts) || 0 };
  }

  return {
    resolveAccess, overview, file, preview, admitUpload, upload, remove,
    adminList, adminPreview, markReviewed, takeDown, adminConfirmation, adminSet, adminUpdate,
    purgeSubject, purgeAccount, purgeOrphans, sweep,
    resetLimits: () => { minuteLimiter.reset(); userMinuteLimiter.reset(); },
  };
}
