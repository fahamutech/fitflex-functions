// Postgres store for partner hero photos and logos (PartnerMedia + PartnerMediaFile, migration
// 20270122090000-partner-media). The image bytes live in PartnerMediaFile.data (bytea): deleting
// those rows really deletes the image (owner decision D-1).
//
// Every change of state runs in one transaction under an advisory lock per partner and kind
// (`partner_media:<type>:<id>:<kind>`), so an upload, a remove and a takedown of the same slot can
// never interleave; the partial unique index keeps one live item per slot whatever happens.
// Every query is parameterised. No query here returns file bytes except getFile().
import { MEDIA_STATUSES } from '../shared/partner-media-rules.mjs';

const MEDIA_FIELDS = new Set([
  'id', 'subjectType', 'subjectId', 'kind', 'origin', 'status', 'revision', 'reviewState', 'reviewedBy', 'reviewedAt',
  'reason', 'reasonNote', 'decidedBy', 'decidedAt', 'statusChangedBy', 'statusChangedAt', 'width', 'height', 'focalX', 'focalY',
  'textZoneMean', 'textZonePatch', 'plate', 'plateChoice', 'logoLuminance', 'sha256', 'confirmationVersion',
  'rightsConfirmedBy', 'rightsConfirmedAt', 'ownLogoConfirmedBy', 'ownLogoConfirmedAt', 'uploadedBy', 'uploadedByRole',
  'createdAt', 'updatedAt',
]);
const DATE_FIELDS = ['reviewedAt', 'decidedAt', 'statusChangedAt', 'rightsConfirmedAt', 'ownLogoConfirmedAt', 'createdAt', 'updatedAt'];
const NUMBER_FIELDS = ['focalX', 'focalY', 'textZoneMean', 'textZonePatch', 'logoLuminance'];
const AUDIT_FIELDS = new Set(['id', 'at', 'actor', 'action', 'target', 'before', 'after']);
const FILE_META = ['id', 'mediaId', 'variant', 'contentType', 'byteLength', 'width', 'height', 'createdAt'];

const iso = v => (v instanceof Date ? v.toISOString() : v ?? null);
const pick = (allowed, data) => Object.fromEntries(Object.entries(data).filter(([k, v]) => v !== undefined && allowed.has(k)));
function mediaFromDb(r) {
  if (!r) return null;
  const out = { ...r, revision: Number(r.revision ?? 1), width: Number(r.width), height: Number(r.height) };
  for (const k of DATE_FIELDS) out[k] = iso(r[k]);
  for (const k of NUMBER_FIELDS) out[k] = r[k] == null ? null : Number(r[k]);
  return out;
}
const likeEscape = s => s.replace(/[\\%_]/g, m => `\\${m}`);

// The partner's name, whatever kind of partner it is (gym name, trainer display name, vendor store name).
const NAME_SQL = `coalesce(g."name", tp."displayName", nullif(btrim(vu."vendorProfile"->>'businessName'), ''), vu."displayName")`;
function withNames(q) {
  return q('PartnerMedia as pm')
    .leftJoin('Gym as g', function joinGym() { this.on('g.id', 'pm.subjectId').andOn('pm.subjectType', q.raw('?', ['gym'])); })
    .leftJoin('TrainerProfile as tp', function joinTrainer() { this.on('tp.id', 'pm.subjectId').andOn('pm.subjectType', q.raw('?', ['trainer'])); })
    .leftJoin('User as vu', function joinVendor() {
      this.on('vu.id', 'pm.subjectId').andOn('pm.subjectType', q.raw('?', ['vendor'])).andOn('vu.userType', q.raw('?', ['vendor']));
    });
}

function bind(q) {
  const media = () => q('PartnerMedia');
  return {
    async getMedia(id) {
      if (typeof id !== 'string' || !id) return null;
      return mediaFromDb(await media().where({ id }).first());
    },
    /** Every item of one slot (or both kinds when `kind` is null), newest first. */
    async listForSubject(subjectType, subjectId, kind = null) {
      const rows = await media().where({ subjectType, subjectId }).modify((b) => { if (kind) b.where({ kind }); })
        .orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }]);
      return rows.map(mediaFromDb);
    },
    async liveFor(subjectType, subjectId, kind) {
      return mediaFromDb(await media().where({ subjectType, subjectId, kind, status: 'live' }).first());
    },
    async insertMedia(row) {
      const [saved] = await media().insert(pick(MEDIA_FIELDS, row)).returning('*');
      return mediaFromDb(saved);
    },
    async updateMedia(id, patch) {
      const [saved] = await media().where({ id }).update(pick(MEDIA_FIELDS, patch)).returning('*');
      return mediaFromDb(saved);
    },
    async insertFiles(mediaId, files) {
      if (!files.length) return;
      await q('PartnerMediaFile').insert(files.map(f => ({
        id: f.id, mediaId, variant: f.variant, contentType: f.contentType, byteLength: f.buffer.length,
        width: f.width, height: f.height, data: f.buffer,
      })));
    },
    /** Deletes the bytes of an item. → how many file rows went. */
    async deleteFiles(mediaId) {
      return q('PartnerMediaFile').where({ mediaId }).del();
    },
    /** One file with its bytes. */
    async getFile(mediaId, variant) {
      const r = await q('PartnerMediaFile').where({ mediaId, variant }).first();
      return r ? { ...r, data: Buffer.from(r.data), byteLength: Number(r.byteLength), createdAt: iso(r.createdAt) } : null;
    },
    /** File metadata (never bytes) of several items: Map(mediaId → { variant: { id, bytes, width, height } }). */
    async fileMeta(mediaIds) {
      const wanted = [...new Set(mediaIds.filter(Boolean))];
      const out = new Map();
      if (!wanted.length) return out;
      for (const r of await q('PartnerMediaFile').whereIn('mediaId', wanted).select(FILE_META)) {
        if (!out.has(r.mediaId)) out.set(r.mediaId, {});
        out.get(r.mediaId)[r.variant] = { id: r.id, bytes: Number(r.byteLength), width: Number(r.width), height: Number(r.height) };
      }
      return out;
    },
    /** How many file rows exist for an item (specs: the bytes are gone). */
    async fileCount(mediaId) {
      const [{ n }] = await q('PartnerMediaFile').where({ mediaId }).count({ n: '*' });
      return Number(n);
    },
    /** O-P2: was this exact upload (sha256 of the uploaded bytes) taken down for this partner before? */
    async takenDownBefore(subjectType, subjectId, sha256) {
      return Boolean(await media().where({ subjectType, subjectId, sha256, status: 'taken_down' }).first('id'));
    },
    /** Partner uploads of one partner since `sinceIso` (the daily cap, O-P5). */
    async partnerUploadsSince(subjectType, subjectId, sinceIso) {
      const [{ n }] = await media().where({ subjectType, subjectId, origin: 'partner' }).where('createdAt', '>', sinceIso).count({ n: '*' });
      return Number(n);
    },
    /**
     * The admin queue. tab: to_review (live partner uploads not yet reviewed, oldest first) | live
     * (newest first) | taken_down (newest takedown first). → { rows (each with subjectName), total }.
     */
    async adminList({ tab, subjectType = null, kind = null, subjectId = null, search = null, limit = 25, offset = 0 }) {
      const base = () => {
        const b = withNames(q);
        if (tab === 'to_review') b.where({ 'pm.status': 'live', 'pm.origin': 'partner', 'pm.reviewState': 'to_review' });
        else if (MEDIA_STATUSES.includes(tab)) b.where('pm.status', tab);
        if (subjectType) b.where('pm.subjectType', subjectType);
        if (kind) b.where('pm.kind', kind);
        if (subjectId) b.where('pm.subjectId', subjectId);
        if (search) b.whereRaw(`${NAME_SQL} ILIKE ? ESCAPE '\\'`, [`%${likeEscape(search)}%`]);
        return b;
      };
      const [{ n }] = await base().count({ n: '*' });
      const order = tab === 'to_review' ? [{ column: 'pm.createdAt', order: 'asc' }, { column: 'pm.id', order: 'asc' }]
        : tab === 'taken_down' ? [{ column: 'pm.decidedAt', order: 'desc' }, { column: 'pm.id', order: 'desc' }]
          : [{ column: 'pm.createdAt', order: 'desc' }, { column: 'pm.id', order: 'desc' }];
      const rows = await base().select('pm.*', q.raw(`${NAME_SQL} as "subjectName"`)).orderBy(order).limit(limit).offset(offset);
      return { rows: rows.map(r => ({ ...mediaFromDb(r), subjectName: r.subjectName ?? null })), total: Number(n) };
    },

    // ── Partners and people ─────────────────────────────────────────────────

    async userRow(id) {
      if (!id) return null;
      return q('User').where({ id }).first('id', 'userType', 'accountStatus', 'displayName', 'email', 'gymId', 'gymIds', 'aclPermissions', 'vendorId', 'vendorRole', 'vendorProfile');
    },
    async gymRow(id) {
      if (typeof id !== 'string' || !id) return null;
      return q('Gym').where({ id }).first('id', 'name');
    },
    async trainerRow(id) {
      if (typeof id !== 'string' || !id) return null;
      return q('TrainerProfile').where({ id }).first('id', 'userId', 'displayName');
    },
    /** The caller's own trainer profile (the oldest, when an account somehow has two). */
    async trainerByUser(userId) {
      if (!userId) return null;
      return q('TrainerProfile').where({ userId }).orderBy([{ column: 'createdAt' }, { column: 'id' }]).first('id', 'userId', 'displayName');
    },
    async vendorRow(id) {
      if (typeof id !== 'string' || !id) return null;
      return q('User').where({ id, userType: 'vendor' }).first('id', 'displayName', 'vendorProfile', 'accountStatus');
    },
    /** Identity V2 · I5 (enforce): the caller's ACTIVE owner/staff memberships at one gym. */
    async gymMemberships(personaId, gymId) {
      return q('OrgMembership').where({ personaId, gymId, orgType: 'gym', status: 'active' }).whereIn('role', ['owner', 'staff'])
        .select('role', 'aclPermissions');
    },
    /** Who hears about a gym's media: its owners, and its active staff holding `gyms` (spec §44.3 audience). */
    async gymAudience(gymId) {
      const rows = await q('User').whereIn('userType', ['gym_operator', 'gym_staff'])
        .where(b => b.whereRaw('? = ANY("gymIds")', [gymId]).orWhere({ gymId }))
        .whereNotIn('accountStatus', ['suspended', 'closed'])
        .select('id', 'userType', 'aclPermissions');
      return rows.filter(r => r.userType === 'gym_operator' || (r.aclPermissions || []).includes('gyms')).map(r => r.id);
    },
    /** A vendor and its active admin staff. */
    async vendorAudience(vendorId) {
      const staff = await q('User').where({ userType: 'vendor_staff', vendorId, vendorRole: 'admin', accountStatus: 'active' }).pluck('id');
      return [vendorId, ...staff];
    },
    /** { userId: name } for showing who did what (display name, else email). */
    async displayNames(ids) {
      const wanted = [...new Set(ids.filter(Boolean))];
      if (!wanted.length) return {};
      const rows = await q('User').whereIn('id', wanted).select('id', 'displayName', 'email');
      return Object.fromEntries(rows.map(r => [r.id, r.displayName || r.email || null]));
    },
    async audit(row) {
      const out = pick(AUDIT_FIELDS, row);
      for (const k of ['before', 'after']) if (out[k] != null && typeof out[k] !== 'string') out[k] = JSON.stringify(out[k]);
      await q('AuditLog').insert(out);
    },
  };
}

export function createPgPartnerMediaStore({ db }) {
  return {
    ...bind(db),
    /** Run fn(store) in one transaction under the lock of one partner's photo or logo slot. */
    transaction: (lockKey, fn) => db.transaction(async (trx) => {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`partner_media:${lockKey}`]);
      return fn(bind(trx));
    }),
  };
}
