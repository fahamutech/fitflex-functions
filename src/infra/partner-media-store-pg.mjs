// Postgres store for partner hero photos and logos (PartnerMedia, PartnerMediaFile and
// PartnerMediaUploadAttempt; migration 20270125090000-partner-media). The image bytes live in
// PartnerMediaFile.data (bytea): deleting those rows really deletes the image (owner decision D-1).
//
// Every change of state runs in one transaction under advisory locks (`partner_media:<key>`): one
// per partner and kind for media changes, one per partner or person for the daily upload counts.
// Several keys are always taken in sorted order, so two transactions never wait on each other in
// a circle. The partial unique index keeps one live item per slot whatever happens.
// Rows of a purged partner (purgedAt set) are never read again (security review M2).
// Every query is parameterised. No query here returns file bytes except getFile().
import { MEDIA_STATUSES } from '../shared/partner-media-rules.mjs';

const MEDIA_FIELDS = new Set([
  'id', 'subjectType', 'subjectId', 'kind', 'origin', 'status', 'revision', 'reviewState', 'reviewedBy', 'reviewedAt',
  'reason', 'reasonNote', 'decidedBy', 'decidedAt', 'statusChangedBy', 'statusChangedAt', 'width', 'height', 'focalX', 'focalY',
  'textZoneMean', 'textZonePatch', 'plate', 'plateChoice', 'logoLuminance', 'sha256', 'pixelSha256', 'purgedAt', 'confirmationVersion',
  'rightsConfirmedBy', 'rightsConfirmedAt', 'ownLogoConfirmedBy', 'ownLogoConfirmedAt', 'uploadedBy', 'uploadedByRole',
  'createdAt', 'updatedAt',
]);
const DATE_FIELDS = ['reviewedAt', 'decidedAt', 'statusChangedAt', 'rightsConfirmedAt', 'ownLogoConfirmedAt', 'purgedAt', 'createdAt', 'updatedAt'];
const NUMBER_FIELDS = ['focalX', 'focalY', 'textZoneMean', 'textZonePatch', 'logoLuminance'];
const AUDIT_FIELDS = new Set(['id', 'at', 'actor', 'action', 'target', 'before', 'after']);
const FILE_META = ['id', 'mediaId', 'variant', 'contentType', 'byteLength', 'width', 'height', 'createdAt'];
const CLOSED = ['suspended', 'closed'];

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
/**
 * PartnerMedia with its partner joined; a partner that no longer exists joins as nulls: a deleted gym,
 * a deleted trainer profile or one whose account is closed or gone (re-review R2), a deleted or closed vendor.
 */
function withSubjects(q) {
  return q('PartnerMedia as pm')
    .leftJoin('Gym as g', function joinGym() { this.on('g.id', 'pm.subjectId').andOn('pm.subjectType', q.raw('?', ['gym'])); })
    .leftJoin('TrainerProfile as tp', function joinTrainer() { this.on('tp.id', 'pm.subjectId').andOn('pm.subjectType', q.raw('?', ['trainer'])); })
    .leftJoin('User as tu', function joinTrainerUser() { this.on('tu.id', 'tp.userId').andOn('tu.accountStatus', '<>', q.raw('?', ['closed'])); })
    .leftJoin('User as vu', function joinVendor() {
      this.on('vu.id', 'pm.subjectId').andOn('pm.subjectType', q.raw('?', ['vendor'])).andOn('vu.userType', q.raw('?', ['vendor']))
        .andOn('vu.accountStatus', '<>', q.raw('?', ['closed']));
    });
}
// A trainer profile with no account (admin-made, or its user row gone: userId is SET NULL) still counts;
// one whose account is closed does not.
const SUBJECT_EXISTS = '(g.id IS NOT NULL OR (tp.id IS NOT NULL AND (tp."userId" IS NULL OR tu.id IS NOT NULL)) OR vu.id IS NOT NULL)';

function bind(q) {
  const media = () => q('PartnerMedia').whereNull('purgedAt');
  const attempts = () => q('PartnerMediaUploadAttempt');
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
      const [saved] = await q('PartnerMedia').insert(pick(MEDIA_FIELDS, row)).returning('*');
      return mediaFromDb(saved);
    },
    async updateMedia(id, patch) {
      const [saved] = await q('PartnerMedia').where({ id }).update(pick(MEDIA_FIELDS, patch)).returning('*');
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
    /** One file's id (no bytes): answers a revalidation without reading the image. */
    async fileId(mediaId, variant) {
      return (await q('PartnerMediaFile').where({ mediaId, variant }).first('id'))?.id ?? null;
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
    /**
     * O-P2 / review L1: taken-down items of these partners matching the upload's bytes or its decoded
     * pixels, newest first → [{ id, reason, subjectId, decidedAt }].
     */
    async takenDownMatches(subjectType, subjectIds, { sha256 = null, pixelSha256 = null }) {
      const ids = [...new Set(subjectIds.filter(Boolean))];
      if (!ids.length || (!sha256 && !pixelSha256)) return [];
      const rows = await media().where({ subjectType, status: 'taken_down' }).whereIn('subjectId', ids)
        .where((b) => {
          if (sha256) b.orWhere({ sha256 });
          if (pixelSha256) b.orWhere({ pixelSha256 });
        })
        .orderBy([{ column: 'decidedAt', order: 'desc' }, { column: 'id', order: 'desc' }])
        .select('id', 'reason', 'subjectId', 'decidedAt');
      return rows.map(r => ({ ...r, decidedAt: iso(r.decidedAt) }));
    },
    /** A gym and every other gym run by an owner of it (review L1: takedowns count across them). */
    async relatedGymIds(gymId) {
      const owners = await q('User').where({ userType: 'gym_operator' })
        .where(b => b.whereRaw('? = ANY("gymIds")', [gymId]).orWhere({ gymId }))
        .whereNot({ accountStatus: 'closed' }).select('gymId', 'gymIds');
      const out = new Set([gymId]);
      for (const o of owners) for (const id of [...(o.gymIds || []), o.gymId]) if (id) out.add(id);
      return [...out];
    },

    // ── Upload attempts (daily caps, O-P5 / review M3, L8) ──────────────────

    async insertAttempt(row) {
      await attempts().insert(row);
    },
    async countUserAttempts(userId, sinceIso) {
      const [{ n }] = await attempts().where({ userId }).where('createdAt', '>', sinceIso).count({ n: '*' });
      return Number(n);
    },
    async countSubjectAttempts(subjectType, subjectId, sinceIso) {
      const [{ n }] = await attempts().where({ subjectType, subjectId }).where('createdAt', '>', sinceIso).count({ n: '*' });
      return Number(n);
    },
    /** Successful partner uploads of one partner since `sinceIso` (O-P5: the 20 a day; purged rows still count). */
    async countPartnerUploadsSince(subjectType, subjectId, sinceIso) {
      const [{ n }] = await q('PartnerMedia').where({ subjectType, subjectId, origin: 'partner' }).where('createdAt', '>', sinceIso).count({ n: '*' });
      return Number(n);
    },
    async setAttemptSubject(id, subjectType, subjectId) {
      return attempts().where({ id }).update({ subjectType, subjectId });
    },
    async deleteAttemptsBefore(iso0) {
      return attempts().where('createdAt', '<', iso0).del();
    },

    /**
     * The admin queue. tab: to_review (live partner uploads not yet reviewed, oldest first) | live
     * (newest first) | taken_down (newest takedown first). Items of a partner that no longer exists
     * are never listed. → { rows (each with subjectName), total }.
     */
    async adminList({ tab, subjectType = null, kind = null, subjectId = null, search = null, limit = 25, offset = 0 }) {
      const base = () => {
        const b = withSubjects(q).whereNull('pm.purgedAt').whereRaw(SUBJECT_EXISTS);
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

    /**
     * Partners whose name contains `search` (case-insensitive; LIKE wildcards in it are literal), for
     * the admin "Set photo for this partner" picker. Only partners the set endpoint accepts and that are
     * not closed: any gym; trainer profiles with no account or an open one; open vendor accounts.
     * Ids are the ones POST /admin/partner-media takes. Names and ids only.
     * → { rows: [{ id, name }], total }, by name then id.
     */
    async searchSubjects({ subjectType, search, limit }) {
      const pattern = `%${likeEscape(search)}%`;
      let base; let nameSql;
      if (subjectType === 'gym') {
        nameSql = 'g."name"';
        base = () => q('Gym as g');
      } else if (subjectType === 'trainer') {
        nameSql = 'tp."displayName"';
        base = () => q('TrainerProfile as tp').leftJoin('User as u', 'u.id', 'tp.userId')
          .where(b => b.whereNull('tp.userId').orWhereNot('u.accountStatus', 'closed'));
      } else {
        nameSql = `coalesce(nullif(btrim(v."vendorProfile"->>'businessName'), ''), v."displayName")`;
        base = () => q('User as v').where({ 'v.userType': 'vendor' }).whereNot('v.accountStatus', 'closed');
      }
      const matching = () => base().whereRaw(`${nameSql} ILIKE ? ESCAPE '\\'`, [pattern]);
      const [{ n }] = await matching().count({ n: '*' });
      const idCol = subjectType === 'gym' ? 'g.id' : subjectType === 'trainer' ? 'tp.id' : 'v.id';
      const rows = await matching().select(q.raw(`${idCol} as id`), q.raw(`${nameSql} as name`))
        .orderByRaw(`lower(${nameSql}) asc, ${idCol} asc`).limit(limit);
      return { rows: rows.map(r => ({ id: r.id, name: r.name ?? null })), total: Number(n) };
    },

    // ── Purge (review M2) ───────────────────────────────────────────────────

    /** Every not-yet-purged item of a partner, any status. */
    async unpurgedOf(subjectType, subjectId) {
      return (await media().where({ subjectType, subjectId })).map(mediaFromDb);
    },
    /** Partners with media whose partner no longer exists (gym or trainer profile gone, vendor gone or closed). */
    async orphanSubjects(limit = 500) {
      return withSubjects(q).whereNull('pm.purgedAt').whereRaw(`NOT ${SUBJECT_EXISTS}`)
        .distinct('pm.subjectType', 'pm.subjectId').limit(limit);
    },
    /**
     * Of these gyms, the ones no open owner runs any more (or that no longer exist). An owner is an
     * open gym_operator account listing the gym, or (Identity V2) an ACTIVE owner OrgMembership whose
     * persona is an open account (re-review R2).
     */
    async gymsWithoutOwner(gymIds) {
      const out = [];
      for (const gymId of [...new Set(gymIds.filter(Boolean))]) {
        const legacy = await q('User').where({ userType: 'gym_operator' })
          .where(b => b.whereRaw('? = ANY("gymIds")', [gymId]).orWhere({ gymId }))
          .whereNotIn('accountStatus', ['closed']).first('id');
        if (legacy) continue;
        const v2 = await q('OrgMembership as m').join('User as u', 'u.id', 'm.personaId')
          .where({ 'm.gymId': gymId, 'm.orgType': 'gym', 'm.role': 'owner', 'm.status': 'active' })
          .whereNot('u.accountStatus', 'closed').first('m.id');
        if (!v2) out.push(gymId);
      }
      return out;
    },
    /**
     * Gyms an account owned through owner OrgMemberships (any status). After the account row is deleted
     * its memberships lose personaId (ON DELETE SET NULL), so those of its Person without a persona count too.
     */
    async ownedGymIdsOfPersona(user) {
      if (!user?.id) return [];
      return q('OrgMembership').where({ orgType: 'gym', role: 'owner' }).whereNotNull('gymId')
        .where(b => b.where({ personaId: user.id }).modify((w) => { if (user.personId) w.orWhere(x => x.whereNull('personaId').andWhere({ personId: user.personId })); }))
        .distinct().pluck('gymId');
    },
    /** Every gym with media not yet purged (the sweep checks each still has an open owner). */
    async gymSubjectsWithMedia(limit = 2000) {
      return q('PartnerMedia').whereNull('purgedAt').where({ subjectType: 'gym' }).distinct().limit(limit).pluck('subjectId');
    },
    /** Does the partner still exist (inside an upload's lock; re-review R1)? Trainers need an open account, vendors an open vendor account. */
    async subjectExists(subjectType, subjectId) {
      if (subjectType === 'gym') return Boolean(await q('Gym').where({ id: subjectId }).first('id'));
      if (subjectType === 'trainer') {
        const t = await q('TrainerProfile as tp').leftJoin('User as u', 'u.id', 'tp.userId').where('tp.id', subjectId).first('tp.userId', 'u.accountStatus');
        return Boolean(t) && (!t.userId || (t.accountStatus != null && t.accountStatus !== 'closed'));
      }
      if (subjectType === 'vendor') return Boolean(await q('User').where({ id: subjectId, userType: 'vendor' }).whereNot({ accountStatus: 'closed' }).first('id'));
      return false;
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
    /**
     * Who hears about a gym's media (spec §44.3 audience): its owners and its staff holding `gyms`.
     * `enforce` (V2_ORG_AUTHZ): from ACTIVE OrgMemberships at that gym, the same rule as access (review L6).
     */
    async gymAudience(gymId, { enforce = false } = {}) {
      if (enforce) {
        const rows = await q('OrgMembership as m').join('User as u', 'u.id', 'm.personaId')
          .where({ 'm.gymId': gymId, 'm.orgType': 'gym', 'm.status': 'active' }).whereIn('m.role', ['owner', 'staff'])
          .whereIn('u.userType', ['gym_operator', 'gym_staff']).whereNotIn('u.accountStatus', CLOSED)
          .select('u.id', 'm.role', 'm.aclPermissions');
        return rows.filter(r => r.role === 'owner' || (r.aclPermissions || []).includes('gyms')).map(r => r.id);
      }
      const rows = await q('User').whereIn('userType', ['gym_operator', 'gym_staff'])
        .where(b => b.whereRaw('? = ANY("gymIds")', [gymId]).orWhere({ gymId }))
        .whereNotIn('accountStatus', CLOSED)
        .select('id', 'userType', 'aclPermissions');
      return rows.filter(r => r.userType === 'gym_operator' || (r.aclPermissions || []).includes('gyms')).map(r => r.id);
    },
    /** A vendor and its active admin staff. */
    async vendorAudience(vendorId) {
      const staff = await q('User').where({ userType: 'vendor_staff', vendorId, vendorRole: 'admin', accountStatus: 'active' }).pluck('id');
      return [vendorId, ...staff];
    },
    /**
     * { userId: name } for showing who did what. `displayOnly` (the partner side, review L4): the
     * display name only, never the email; null when there is none.
     */
    async displayNames(ids, { displayOnly = false } = {}) {
      const wanted = [...new Set(ids.filter(Boolean))];
      if (!wanted.length) return {};
      const rows = await q('User').whereIn('id', wanted).select('id', 'displayName', 'email');
      const clean = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
      return Object.fromEntries(rows.map(r => [r.id, displayOnly ? clean(r.displayName) : clean(r.displayName) || clean(r.email)]));
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
    /** Run fn(store) in one transaction holding the lock(s) of `lockKeys` (a key or a list), taken in sorted order. */
    transaction: (lockKeys, fn) => db.transaction(async (trx) => {
      for (const key of [...new Set([lockKeys].flat())].sort()) {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`partner_media:${key}`]);
      }
      return fn(bind(trx));
    }),
  };
}
