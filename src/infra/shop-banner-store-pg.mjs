// Postgres store for shop home banners (ShopBanner) and their photos (HeroImage rows with purpose
// 'shop_banner'), plus the AuditLog rows written with them.
//
// Every change of state runs in one transaction holding one advisory lock ('shop_banners'), so
// two admins cannot both approve (or one approve while another rejects) the same banner, and a
// vendor edit cannot slip in between a decision's read and its write. The writes go through the
// transaction itself, not beside it. Banner traffic is tiny, so one lock is the simple, safe choice.
import { HERO_ALLOWED_FIELDS } from './knex-store.mjs';

const LOCK_KEY = 'shop_banners';
const BANNER_FIELDS = new Set([
  'id', 'origin', 'vendorId', 'imageId', 'ctaKey', 'revision', 'editors', 'headlineLead', 'headlineAccent', 'subline', 'ctaLabel', 'imageAlt', 'target',
  'audienceRoles', 'startsAt', 'endsAt', 'position', 'status', 'statusReasonNote', 'statusReason', 'statusChangedAt',
  'expiresAt', 'createdBy', 'submittedBy', 'submittedAt', 'approvedBy', 'approvedAt', 'decidedBy', 'decidedAt',
  'endedBy', 'endedAt', 'createdAt', 'updatedAt',
]);
const BANNER_JSON = ['headlineLead', 'headlineAccent', 'subline', 'ctaLabel', 'imageAlt', 'target', 'audienceRoles', 'editors'];
const IMAGE_JSON = ['variants', 'textZoneLuminance'];
const AUDIT_FIELDS = new Set(['id', 'at', 'actor', 'action', 'target', 'before', 'after']);
const DATE_FIELDS = ['startsAt', 'endsAt', 'statusChangedAt', 'expiresAt', 'submittedAt', 'approvedAt', 'decidedAt', 'endedAt', 'createdAt', 'updatedAt'];

function forWrite(allowed, json, data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || !allowed.has(k)) continue;
    // Arrays must be stringified for jsonb (node-postgres would send a Postgres ARRAY literal).
    out[k] = json.includes(k) && v !== null && typeof v !== 'string' ? JSON.stringify(v) : v;
  }
  return out;
}

const iso = v => (v instanceof Date ? v.toISOString() : v ?? null);
const bannerFromDb = (r) => {
  if (!r) return null;
  const out = { ...r, position: r.position == null ? null : Number(r.position), revision: Number(r.revision ?? 1), editors: Array.isArray(r.editors) ? r.editors : [] };
  for (const k of DATE_FIELDS) out[k] = iso(r[k]);
  return out;
};
const imageFromDb = r => (r ? {
  ...r, focalX: Number(r.focalX), focalY: Number(r.focalY),
  rightsConfirmedAt: iso(r.rightsConfirmedAt), noFacesConfirmedAt: iso(r.noFacesConfirmedAt),
  createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
} : null);

function bind(q) {
  const banners = () => q('ShopBanner');
  const bannerImages = () => q('HeroImage').where({ purpose: 'shop_banner' });
  return {
    async getBanner(id) {
      return bannerFromDb(await banners().where({ id: String(id) }).first());
    },
    /** Every banner matching `where` (an object of columns), newest first. */
    async listBanners(where = {}) {
      return (await banners().where(where).orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id' }])).map(bannerFromDb);
    },
    /** Approved banners whose window has not ended at `at` (the shop home reads this on every request). */
    async approvedNotEnded(at) {
      return (await banners().where({ status: 'approved' }).where('endsAt', '>', at)).map(bannerFromDb);
    },
    /** Pending proposals past their expiry, and approved banners past their end, at `at`. */
    async lapsed(at) {
      const [expired, ended] = await Promise.all([
        banners().where({ status: 'pending_approval' }).where('expiresAt', '<=', at),
        banners().where({ status: 'approved' }).where('endsAt', '<=', at),
      ]);
      return { expired: expired.map(bannerFromDb), ended: ended.map(bannerFromDb) };
    },
    async insertBanner(row) {
      const [saved] = await banners().insert(forWrite(BANNER_FIELDS, BANNER_JSON, row)).returning('*');
      return bannerFromDb(saved);
    },
    async updateBanner(id, patch) {
      const [saved] = await banners().where({ id }).update(forWrite(BANNER_FIELDS, BANNER_JSON, patch)).returning('*');
      return bannerFromDb(saved);
    },
    async getImage(id) {
      if (!id) return null;
      return imageFromDb(await bannerImages().where({ id: String(id) }).first());
    },
    async getImages(ids) {
      const wanted = [...new Set(ids.filter(Boolean))];
      if (!wanted.length) return [];
      return (await bannerImages().whereIn('id', wanted)).map(imageFromDb);
    },
    async insertImage(row) {
      const [saved] = await q('HeroImage').insert(forWrite(HERO_ALLOWED_FIELDS.hero_images, IMAGE_JSON, { ...row, purpose: 'shop_banner' })).returning('*');
      return imageFromDb(saved);
    },
    async updateImage(id, patch) {
      const [saved] = await bannerImages().where({ id }).update(forWrite(HERO_ALLOWED_FIELDS.hero_images, IMAGE_JSON, patch)).returning('*');
      return imageFromDb(saved);
    },
    /** Vendor accounts by id (the fresh status checks: suspension, approval). */
    async vendors(ids) {
      const wanted = [...new Set(ids.filter(Boolean))];
      if (!wanted.length) return [];
      return q('User').whereIn('id', wanted).where({ userType: 'vendor' }).select('id', 'accountStatus', 'approvalStatus', 'vendorProfile', 'displayName', 'createdAt');
    },
    async products(ids) {
      const wanted = [...new Set(ids.filter(Boolean))];
      if (!wanted.length) return [];
      return q('Product').whereIn('id', wanted).select('id', 'vendorId', 'name', 'status', 'approvalStatus', 'visibility', 'homepageVisible', 'deletedAt', 'stock', 'category');
    },
    /** { userId: name } for showing who did what (display name, else email). */
    async displayNames(ids) {
      const wanted = [...new Set(ids.filter(Boolean))];
      if (!wanted.length) return {};
      const rows = await q('User').whereIn('id', wanted).select('id', 'displayName', 'email');
      return Object.fromEntries(rows.map(r => [r.id, r.displayName || r.email || null]));
    },
    async audit(row) {
      await q('AuditLog').insert(forWrite(AUDIT_FIELDS, ['before', 'after'], row));
    },
    async history(id) {
      return (await q('AuditLog').where({ target: id }).where('action', 'like', 'shop_banner.%').orderBy('at', 'asc'))
        .map(r => ({ ...r, at: iso(r.at) }));
    },
    /** How many of a vendor's banners are open proposals (draft, or pending and not yet expired at `at`). */
    async openProposals(vendorId, at) {
      const [{ n }] = await banners().where({ origin: 'vendor', vendorId })
        .where(w => w.where({ status: 'draft' }).orWhere(p => p.where({ status: 'pending_approval' }).where('expiresAt', '>', at)))
        .count({ n: '*' });
      return Number(n);
    },
  };
}

export function createPgShopBannerStore({ db }) {
  return {
    ...bind(db),
    /** Run fn(store) in one transaction under the banner lock. */
    transaction: fn => db.transaction(async (trx) => {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [LOCK_KEY]);
      return fn(bind(trx));
    }),
  };
}
