// Partner hero photo and logo (plan docs/plans/partner-hero-media-plan.md slice 1; design spec
// photo-hero-screens.md §39–§45; owner decisions 2026-10-29). Dormant behind PARTNER_MEDIA (the
// routes check the flag; this service does not).
//
// - A gym (per gym), a trainer profile or a vendor has at most one live photo ('hero') and one live
//   logo. An upload is live as soon as it is cleaned (post-moderation, D-3); the previous live item
//   becomes `replaced` in the same transaction and its bytes are deleted.
// - Tenancy is decided HERE, from the stored accounts, not only by route guards:
//     gym      owner: the gym is in their own gymIds; gym staff: the gym is in their gymIds (read),
//              plus the `gyms` scope on their stored record (write). With V2_ORG_AUTHZ enforcing,
//              ACTIVE OrgMemberships at that gym decide instead (owner → read + write; staff →
//              read, + write with `gyms`).
//     trainer  only the TrainerProfile whose userId is the caller.
//     vendor   the vendor account; active vendor staff of that vendor (read), vendorRole admin (write).
//   An item of another partner reads as 404 media_not_found, never 403.
// - FitFlex: `moderation_decide` marks an item reviewed (never one's own upload) or takes it down
//   (reason code; the bytes are deleted at once, the hash kept for O-P2; the partner is told);
//   `brand_media` sets a photo or logo for a partner directly (live and reviewed; no notice, O-P3).
// - Bytes are deleted on replace, remove and takedown; the metadata row stays (O-P4: no evidence copy).
// - Every write adds an AuditLog row `partner_media.<action>` with ids and hashes only, never bytes.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ADMIN_CONFIRMATION, DEFAULT_VARIANT, MEDIA_KINDS, NOTE_MAX, PARTNER_CONFIRMATION, PARTNER_MEDIA_LIMITS, PLATE_CHOICES,
  PREVIEW_WIDTHS, SERVED_VARIANTS, SUBJECT_TYPES, SUBJECT_TYPE_OF_ROLE, TAKEDOWN_REASONS, UPLOAD_RATE,
  confirmed, parseFocal, settingsRoute, takenDownMessage,
} from '../shared/partner-media-rules.mjs';
import {
  buildLogoVariants, buildPartnerHeroVariants, isBright, looksLikeSvg, plateFor, prepareHeroUpload, prepareLogoUpload, previewAt,
} from '../infra/hero-image-file.mjs';
import { createVendorLimiter } from '../shared/vendor-rate-limit.mjs';
import { storeNameOf } from '../shared/vendor-name.mjs';

const DAY_MS = 86_400_000;
const CLOSED_ACCOUNTS = new Set(['suspended', 'closed']);
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const newMediaId = () => `pmd_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
// File ids are random and never reused: a cached copy can be immutable.
const newFileId = () => `pmf_${randomBytes(16).toString('hex')}`;
const sha256Of = buffer => createHash('sha256').update(buffer).digest('hex');
const ownGymIds = row => (Array.isArray(row?.gymIds) && row.gymIds.length ? row.gymIds : row?.gymId ? [row.gymId] : []);
const vendorNameOf = row => storeNameOf({ ...row, vendorProfile: typeof row?.vendorProfile === 'string' ? JSON.parse(row.vendorProfile) : row?.vendorProfile });
const notFound = () => fail('media_not_found', 404);
const filePath = (id, variant) => `/partner/media/${encodeURIComponent(id)}/file?variant=${variant}`;

const HERO_FORMATS = ['jpeg', 'png', 'webp', 'heif'];

export function createPartnerMediaService({
  store,
  notify = async () => {},          // (userId, { id, type, title, body, data }) → inbox + push
  localeOf = async () => null,      // the person's chosen message language ('en' | 'sw' | null)
  orgAuthzMode = () => 'off',
  now = () => new Date(),
  logger = console,
  minuteLimiter = createVendorLimiter({ perMinute: UPLOAD_RATE.perMinute }),
}) {
  const stamp = () => now().toISOString();
  let lastAuditMs = 0;
  const auditAt = () => {
    lastAuditMs = Math.max(now().getTime(), lastAuditMs + 1);
    return new Date(lastAuditMs).toISOString();
  };
  const snapshot = m => (m ? {
    id: m.id, subjectType: m.subjectType, subjectId: m.subjectId, kind: m.kind, origin: m.origin, status: m.status,
    revision: m.revision, reviewState: m.reviewState, reason: m.reason ?? null, sha256: m.sha256 ?? null,
    focalX: m.focalX ?? null, focalY: m.focalY ?? null, plate: m.plate ?? null, plateChoice: m.plateChoice ?? null,
    confirmationVersion: m.confirmationVersion,
  } : null);
  const audit = (q, action, actor, m, before, after, extra = {}) => q.audit({
    id: randomUUID(), at: auditAt(), actor, action: `partner_media.${action}`, target: m.id,
    before: snapshot(before), after: after ? { ...snapshot(after), ...extra } : extra,
  });
  const slotKey = (subjectType, subjectId, kind) => `${subjectType}:${subjectId}:${kind}`;

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
      if (orgAuthzMode() === 'enforce') {
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

  // ── Views ───────────────────────────────────────────────────────────────────

  async function views(rows, side, { actorId = null, subjects = null } = {}) {
    if (!rows.length) return [];
    const metas = await store.fileMeta(rows.filter(r => r.status === 'live').map(r => r.id));
    const names = await store.displayNames(rows.flatMap(r => [r.uploadedBy, r.reviewedBy, r.decidedBy, r.rightsConfirmedBy, r.ownLogoConfirmedBy]));
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
    const served = SERVED_VARIANTS[m.kind];
    const files = {}; const bytes = {};
    if (live) {
      for (const v of served) {
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

  /** GET /partner/media/:id/file?variant= — the bytes of a live item, to signed-in readers of its partner only. */
  async function file({ claims, id, variant = null }) {
    const own = await ownItem(claims, id);
    if (own.error) return own;
    const { item } = own;
    const v = variant == null || variant === '' ? DEFAULT_VARIANT[item.kind] : String(variant);
    if (!SERVED_VARIANTS[item.kind].includes(v)) return fail('invalid_variant', 400, { allowed: SERVED_VARIANTS[item.kind] });
    if (item.status !== 'live') return notFound();
    const f = await store.getFile(item.id, v);
    if (!f) return notFound();
    return { file: { id: f.id, buffer: f.data, mimeType: f.contentType } };
  }

  const parseWidth = (width) => {
    if (width == null || width === '') return { value: null };
    const w = Number(width);
    return PREVIEW_WIDTHS.includes(w) ? { value: w } : { invalid: true };
  };
  async function previewOf(item, width) {
    const w = parseWidth(width);
    if (w.invalid) return fail('invalid_width', 400, { allowed: PREVIEW_WIDTHS });
    if (item.status !== 'live') return fail('image_not_found', 404);
    const master = await store.getFile(item.id, 'master');
    if (!master) return fail('image_not_found', 404);
    const buffer = w.value ? await previewAt(master.data, w.value) : master.data;
    return { file: { buffer, mimeType: 'image/webp', fileName: `${item.id}${w.value ? `-${w.value}` : ''}.webp` } };
  }

  /** GET /partner/media/:id/preview?w= — a thumbnail for the item's own partner (no-store). */
  async function preview({ claims, id, width = null }) {
    const own = await ownItem(claims, id);
    if (own.error) return own;
    return previewOf(own.item, width);
  }

  // ── Uploads (partner and FitFlex) ───────────────────────────────────────────

  /** Clean the upload and make its files. → { prepared, files[] } or { error }. */
  async function processImage(kind, buffer) {
    if (looksLikeSvg(buffer)) return fail('svg_not_allowed', 400);
    if (kind === 'hero') {
      const prepared = await prepareHeroUpload(buffer, {
        maxBytes: PARTNER_MEDIA_LIMITS.hero.maxBytes, minWidth: PARTNER_MEDIA_LIMITS.hero.minWidth, formats: HERO_FORMATS,
      });
      if (prepared.error) return prepared;
      const variants = await buildPartnerHeroVariants(prepared.buffer);
      if (variants.error) return variants;
      const v = prepared.luminance;
      return {
        prepared: {
          width: prepared.width, height: prepared.height,
          textZoneMean: Math.max(v.vertical.mean, v.horizontal.mean), textZonePatch: Math.max(v.vertical.maxPatch, v.horizontal.maxPatch),
        },
        files: [
          { variant: 'master', buffer: prepared.buffer, width: prepared.width, height: prepared.height },
          { variant: 'x2', buffer: variants.x2.buffer, width: variants.x2.width, height: variants.x2.height },
          { variant: 'x1', buffer: variants.x1.buffer, width: variants.x1.width, height: variants.x1.height },
        ],
      };
    }
    const prepared = await prepareLogoUpload(buffer, PARTNER_MEDIA_LIMITS.logo);
    if (prepared.error) return prepared;
    const variants = await buildLogoVariants(prepared.buffer);
    if (variants.error) return variants;
    return {
      prepared: { width: prepared.width, height: prepared.height, logoLuminance: prepared.luminance, plateAuto: prepared.plateAuto },
      files: [
        { variant: 'master', buffer: prepared.buffer, width: prepared.width, height: prepared.height },
        { variant: 'logo256', buffer: variants.logo256.buffer, width: variants.logo256.width, height: variants.logo256.height },
        { variant: 'logo128', buffer: variants.logo128.buffer, width: variants.logo128.width, height: variants.logo128.height },
      ],
    };
  }

  /** Make the new item live: the previous live one is replaced and its bytes deleted, in one transaction. */
  async function saveLive({ subject, kind, row, files, actorId, checkTakenDown }) {
    const refuse = out => { throw Object.assign(new Error(out.error), { refusal: out }); };
    try {
      return await store.transaction(slotKey(subject.type, subject.id, kind), async (q) => {
        if (checkTakenDown && await q.takenDownBefore(subject.type, subject.id, row.sha256)) refuse(fail('image_taken_down_before', 409));
        const at = row.createdAt;
        const prev = await q.liveFor(subject.type, subject.id, kind);
        if (prev) {
          const replaced = await q.updateMedia(prev.id, {
            status: 'replaced', statusChangedBy: actorId, statusChangedAt: at, sha256: null, revision: prev.revision + 1, updatedAt: at,
          });
          const deleted = await q.deleteFiles(prev.id);
          await audit(q, 'replaced', actorId, prev, prev, replaced, { replacedBy: row.id, filesDeleted: deleted });
        }
        const saved = await q.insertMedia(row);
        await q.insertFiles(saved.id, files.map(f => ({ ...f, id: newFileId(), contentType: 'image/webp' })));
        await audit(q, row.origin === 'fitflex' ? 'set_by_fitflex' : 'uploaded', actorId, saved, null, saved, {
          width: saved.width, height: saved.height, replaced: prev?.id ?? null,
          files: files.map(f => ({ variant: f.variant, bytes: f.buffer.length })),
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
   */
  async function upload({ claims, kind, file: upload, fields = {}, gymId = null }) {
    if (!MEDIA_KINDS.includes(kind)) return fail('invalid_kind', 400);
    const acc = await resolveAccess(claims, { gymId: gymId ?? fields.gymId ?? null });
    if (acc.error) return acc;
    if (!acc.canEdit) return editRefusal(acc);
    const { subject } = acc;

    // O-P5: 10 a minute (this server) and 20 a day (all servers, counted in the database) per partner.
    const key = `${subject.type}:${subject.id}`;
    const minute = minuteLimiter.allow(key, now().getTime());
    if (!minute.ok) return fail('rate_limited', 429, { retryAfterSeconds: minute.retryAfterSeconds, limit: 'minute', max: UPLOAD_RATE.perMinute });
    const today = await store.partnerUploadsSince(subject.type, subject.id, new Date(now().getTime() - DAY_MS).toISOString());
    if (today >= UPLOAD_RATE.perDay) return fail('rate_limited', 429, { retryAfterSeconds: 3600, limit: 'day', max: UPLOAD_RATE.perDay });

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

    const sha256 = sha256Of(upload.buffer);
    if (await store.takenDownBefore(subject.type, subject.id, sha256)) return fail('image_taken_down_before', 409);
    const processed = await processImage(kind, upload.buffer);
    if (processed.error) return processed;

    const at = stamp();
    const row = baseRow({ subject, kind, processed, focal, plateChoice, sha256, at, actorId: claims.sub, role: claims.userType });
    Object.assign(row, {
      origin: 'partner', reviewState: 'to_review',
      confirmationVersion: PARTNER_CONFIRMATION.version, rightsConfirmedBy: claims.sub, rightsConfirmedAt: at,
      ...(kind === 'logo' ? { ownLogoConfirmedBy: claims.sub, ownLogoConfirmedAt: at } : {}),
    });
    const saved = await saveLive({ subject, kind, row, files: processed.files, actorId: claims.sub, checkTakenDown: true });
    if (saved.error) return saved;
    const [item] = await views([saved], 'partner', { subjects: new Map([[saved.id, subject]]) });
    return { item };
  }

  function baseRow({ subject, kind, processed, focal, plateChoice, sha256, at, actorId, role }) {
    const p = processed.prepared;
    return {
      id: newMediaId(), subjectType: subject.type, subjectId: subject.id, kind, status: 'live', revision: 1,
      width: p.width, height: p.height,
      ...(kind === 'hero'
        ? { focalX: focal.x, focalY: focal.y, textZoneMean: p.textZoneMean, textZonePatch: p.textZonePatch }
        : { plateChoice, plate: plateChoice === 'auto' ? p.plateAuto : plateChoice, logoLuminance: p.logoLuminance }),
      sha256, uploadedBy: actorId, uploadedByRole: role, createdAt: at, updatedAt: at,
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
          status: 'removed', statusChangedBy: claims.sub, statusChangedAt: at, sha256: null, revision: cur.revision + 1, updatedAt: at,
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

  /** GET /admin/partner-media — the queue. */
  async function adminList({ query = {}, actorId }) {
    const tab = query.tab == null || query.tab === '' ? 'to_review' : String(query.tab);
    if (!ADMIN_TABS.includes(tab)) return fail('invalid_tab', 400, { allowed: ADMIN_TABS });
    const subjectType = query.subjectType || query.type || null;
    if (subjectType && !SUBJECT_TYPES.includes(subjectType)) return fail('invalid_subject_type', 400, { allowed: SUBJECT_TYPES });
    const kind = query.kind || null;
    if (kind && !MEDIA_KINDS.includes(kind)) return fail('invalid_kind', 400, { allowed: MEDIA_KINDS });
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
    const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
    const search = typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 100) : null;
    const subjectId = typeof query.subjectId === 'string' && query.subjectId ? query.subjectId : null;
    const { rows, total } = await store.adminList({ tab, subjectType, kind, subjectId, search, limit, offset });
    return { items: await views(rows, 'admin', { actorId }), total, next: offset + rows.length < total ? offset + rows.length : null };
  }

  async function adminView(m, actorId) {
    const named = await subjectWithName(m.subjectType, m.subjectId);
    const [v] = await views([m], 'admin', { actorId, subjects: new Map([[m.id, named]]) });
    return v;
  }
  async function subjectWithName(type, id) {
    if (type === 'gym') return { type, id, name: (await store.gymRow(id))?.name ?? null };
    if (type === 'trainer') return { type, id, name: (await store.trainerRow(id))?.displayName ?? null };
    const v = await store.vendorRow(id);
    return { type, id, name: v ? vendorNameOf(v) : null };
  }

  /** GET /admin/partner-media/:id/preview?w= */
  async function adminPreview({ id, width = null }) {
    const item = await store.getMedia(id);
    if (!item) return notFound();
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
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim() : null;
    if (note != null && typeof note !== 'string') return fail('invalid_note', 400, { field: 'note' });
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
      // O-P4: no evidence copy — the reason, note, who, when and the upload's hash only.
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
      if (m.subjectType === 'gym') recipients = await store.gymAudience(m.subjectId);
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

  /** POST /admin/partner-media (brand_media) — FitFlex sets a partner's photo or logo: live and reviewed at once. */
  async function adminSet({ actorId, file: upload, fields = {} }) {
    const subjectType = fields.subjectType;
    if (!SUBJECT_TYPES.includes(subjectType)) return fail('invalid_subject_type', 400, { allowed: SUBJECT_TYPES });
    const kind = fields.kind;
    if (!MEDIA_KINDS.includes(kind)) return fail('invalid_kind', 400, { allowed: MEDIA_KINDS });
    if (typeof fields.subjectId !== 'string' || !fields.subjectId) return fail('subject_not_found', 404);
    const subject = await subjectWithName(subjectType, fields.subjectId);
    const exists = subjectType === 'gym' ? await store.gymRow(subject.id) : subjectType === 'trainer' ? await store.trainerRow(subject.id) : await store.vendorRow(subject.id);
    if (!exists) return fail('subject_not_found', 404);
    if ('people' in fields || 'peopleConfirmed' in fields) return fail('unknown_field', 400, { field: 'people' in fields ? 'people' : 'peopleConfirmed' });
    if (fields.adminConfirmationVersion !== ADMIN_CONFIRMATION.version) {
      return fail('confirmation_version_mismatch', 400, { field: 'adminConfirmationVersion', current: ADMIN_CONFIRMATION.version });
    }
    if (!confirmed(fields.rightsConfirmed)) return fail('rights_confirmation_required', 400, { field: 'rightsConfirmed' });
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
    const at = stamp();
    const row = baseRow({ subject, kind, processed, focal, plateChoice, sha256: sha256Of(upload.buffer), at, actorId, role: 'admin' });
    Object.assign(row, {
      origin: 'fitflex', reviewState: 'reviewed', reviewedBy: actorId, reviewedAt: at,
      confirmationVersion: ADMIN_CONFIRMATION.version, rightsConfirmedBy: actorId, rightsConfirmedAt: at,
      ...(kind === 'logo' ? { ownLogoConfirmedBy: actorId, ownLogoConfirmedAt: at } : {}),
    });
    // A FitFlex decision: the O-P2 refusal applies to partner uploads only. No notice (O-P3).
    const saved = await saveLive({ subject, kind, row, files: processed.files, actorId, checkTakenDown: false });
    if (saved.error) return saved;
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

  return {
    resolveAccess, overview, file, preview, upload, remove,
    adminList, adminPreview, markReviewed, takeDown, adminConfirmation, adminSet, adminUpdate,
    resetLimits: () => minuteLimiter.reset(),
  };
}
