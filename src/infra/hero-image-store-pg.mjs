// Postgres store for admin-managed app photos (plan slice 4): HeroImage, HeroSlotDraft,
// HeroPublication, and the AuditLog rows written with them.
//
// Changes that touch drafts or publications run in one transaction holding one advisory lock, so
// two admins publishing at once get two clean snapshots, never a mix. Admin traffic is tiny, so a
// single lock is the simple and safe choice. Columns written are the knex-store allowlists.
import { HERO_ALLOWED_FIELDS } from './knex-store.mjs';

const LOCK_KEY = 'hero_images';
const JSON_COLUMNS = { HeroImage: ['variants', 'textZoneLuminance'], HeroPublication: ['slots'], AuditLog: ['before', 'after'] };
const ALLOWED = {
  HeroImage: HERO_ALLOWED_FIELDS.hero_images,
  HeroSlotDraft: HERO_ALLOWED_FIELDS.hero_slot_drafts,
  HeroPublication: HERO_ALLOWED_FIELDS.hero_publications,
  AuditLog: new Set(['id', 'at', 'actor', 'action', 'target', 'before', 'after']),
};

function forWrite(table, data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || !ALLOWED[table].has(k)) continue;
    out[k] = (JSON_COLUMNS[table] || []).includes(k) && v !== null && typeof v !== 'string' ? JSON.stringify(v) : v;
  }
  return out;
}

const iso = v => (v instanceof Date ? v.toISOString() : v ?? null);
const imageFromDb = r => (r ? {
  ...r, focalX: Number(r.focalX), focalY: Number(r.focalY),
  rightsConfirmedAt: iso(r.rightsConfirmedAt), noFacesConfirmedAt: iso(r.noFacesConfirmedAt),
  createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
} : null);
const publicationFromDb = r => (r ? {
  id: Number(r.id), slots: r.slots || {}, publishedBy: r.publishedBy, publishedAt: iso(r.publishedAt),
  note: r.note ?? null, rolledBackFrom: r.rolledBackFrom == null ? null : Number(r.rolledBackFrom),
} : null);

function bind(q) {
  return {
    async listImages() {
      return (await q('HeroImage').select('*').orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id' }])).map(imageFromDb);
    },
    async getImage(id) {
      return imageFromDb(await q('HeroImage').where({ id: String(id) }).first());
    },
    async getImages(ids) {
      if (!ids.length) return [];
      return (await q('HeroImage').whereIn('id', ids)).map(imageFromDb);
    },
    async insertImage(row) {
      const [saved] = await q('HeroImage').insert(forWrite('HeroImage', row)).returning('*');
      return imageFromDb(saved);
    },
    async updateImage(id, patch) {
      const [saved] = await q('HeroImage').where({ id }).update(forWrite('HeroImage', patch)).returning('*');
      return imageFromDb(saved);
    },
    /** Every draft row, by slot then position. */
    async drafts() {
      return q('HeroSlotDraft').select('slotId', 'imageId', 'position').orderBy([{ column: 'slotId' }, { column: 'position' }]);
    },
    async replaceSlot(slotId, imageIds, actorId, at) {
      await q('HeroSlotDraft').where({ slotId }).del();
      if (imageIds.length) {
        await q('HeroSlotDraft').insert(imageIds.map((imageId, position) => forWrite('HeroSlotDraft', { slotId, imageId, position, updatedBy: actorId, updatedAt: at })));
      }
    },
    /** Take a photo out of every draft; → the slots it was in. */
    async removeFromDrafts(imageId) {
      const rows = await q('HeroSlotDraft').where({ imageId }).del().returning('slotId');
      return rows.map(r => r.slotId).sort();
    },
    async latestPublication() {
      return publicationFromDb(await q('HeroPublication').orderBy('id', 'desc').first());
    },
    async listPublications(limit) {
      return (await q('HeroPublication').orderBy('id', 'desc').limit(limit)).map(publicationFromDb);
    },
    async getPublication(id) {
      return publicationFromDb(await q('HeroPublication').where({ id }).first());
    },
    async insertPublication(row) {
      const [saved] = await q('HeroPublication').insert(forWrite('HeroPublication', row)).returning('*');
      return publicationFromDb(saved);
    },
    async audit(row) {
      await q('AuditLog').insert(forWrite('AuditLog', row));
    },
  };
}

export function createPgHeroImageStore({ db }) {
  return {
    ...bind(db),
    /** Run fn(store) in one transaction under the hero lock. */
    transaction: fn => db.transaction(async (trx) => {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [LOCK_KEY]);
      return fn(bind(trx));
    }),
  };
}
