// Postgres store for shop flash sales (FlashSale), the product price history (ProductPriceChange,
// written by a database trigger) and the AuditLog rows written with them.
//
// Every change of state runs in one transaction holding the PRODUCT's advisory lock
// ('flash_sale:<productId>'). The same lock is taken by vendor product saves that would change a
// price while SHOP_FLASH_SALES is on (shop-service), so an approval can never slip in between a price
// edit's check and its write, or the other way round. A sale's product never changes, so the lock
// key is known before the row is read. The exclusion constraint (one approved sale per product) is
// the last line of defence.

const LOCK_PREFIX = 'flash_sale:';
/** SQLSTATE of the one-approved-sale-per-product constraint (or its trigger): the transaction is rolled back. */
export const EXCLUSION_VIOLATION = '23P01';
const SALE_FIELDS = new Set([
  'id', 'origin', 'vendorId', 'productId', 'salePriceTzs', 'wasPriceTzs', 'regularPriceTzsAtSubmit', 'discountPriceTzsAtSubmit',
  'startsAt', 'endsAt', 'status', 'statusReason', 'statusReasonNote', 'statusChangedAt', 'expiresAt', 'revision', 'editors',
  'createdBy', 'submittedBy', 'submittedAt', 'approvedBy', 'approvedAt', 'decidedBy', 'decidedAt', 'endedBy', 'endedAt',
  'createdAt', 'updatedAt',
]);
const JSON_FIELDS = ['editors'];
const INT_FIELDS = ['salePriceTzs', 'wasPriceTzs', 'regularPriceTzsAtSubmit', 'discountPriceTzsAtSubmit', 'revision'];
const DATE_FIELDS = ['startsAt', 'endsAt', 'statusChangedAt', 'expiresAt', 'submittedAt', 'approvedAt', 'decidedAt', 'endedAt', 'createdAt', 'updatedAt'];
const AUDIT_FIELDS = new Set(['id', 'at', 'actor', 'action', 'target', 'before', 'after']);
const PRODUCT_COLUMNS = ['id', 'vendorId', 'name', 'images', 'priceTzs', 'discountPriceTzs', 'status', 'approvalStatus', 'visibility', 'homepageVisible', 'deletedAt', 'stock'];

function forWrite(allowed, json, data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || !allowed.has(k)) continue;
    out[k] = json.includes(k) && v !== null && typeof v !== 'string' ? JSON.stringify(v) : v;
  }
  return out;
}
const iso = v => (v instanceof Date ? v.toISOString() : v ?? null);
const saleFromDb = (r) => {
  if (!r) return null;
  const out = { ...r, editors: Array.isArray(r.editors) ? r.editors : [] };
  for (const k of INT_FIELDS) out[k] = r[k] == null ? null : Number(r[k]);
  for (const k of DATE_FIELDS) out[k] = iso(r[k]);
  return out;
};
const productFromDb = r => (r ? { ...r, priceTzs: Number(r.priceTzs ?? 0), discountPriceTzs: r.discountPriceTzs == null ? null : Number(r.discountPriceTzs), stock: Number(r.stock ?? 0), deletedAt: iso(r.deletedAt) } : null);

function bind(q) {
  const sales = () => q('FlashSale');
  return {
    async getSale(id) {
      return saleFromDb(await sales().where({ id: String(id) }).first());
    },
    /** Every sale matching `where` (columns), newest first. */
    async listSales(where = {}) {
      return (await sales().where(where).orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id' }])).map(saleFromDb);
    },
    /** Sales of these vendors' products: their own and the ones FitFlex staff made on them. */
    async listForVendor(vendorId) {
      return (await sales().where({ vendorId }).orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id' }])).map(saleFromDb);
    },
    /** Every sale of a product (overlap and lock checks), oldest start first. */
    async salesOfProduct(productId) {
      return (await sales().where({ productId }).orderBy('startsAt', 'asc')).map(saleFromDb);
    },
    /**
     * Approved sales whose window has not ended at `at` (scheduled or live), optionally for some
     * products only. The pricing paths read this on every request (nothing cached).
     */
    async approvedNotEnded(at, productIds = null) {
      let query = sales().where({ status: 'approved' }).where('endsAt', '>', at);
      if (productIds) {
        const wanted = [...new Set(productIds.filter(Boolean))];
        if (!wanted.length) return [];
        query = query.whereIn('productId', wanted);
      }
      return (await query).map(saleFromDb);
    },
    /** Approved sales live at `at`: startsAt ≤ at < endsAt. */
    async liveAt(at, productIds = null) {
      let query = sales().where({ status: 'approved' }).where('startsAt', '<=', at).where('endsAt', '>', at);
      if (productIds) {
        const wanted = [...new Set(productIds.filter(Boolean))];
        if (!wanted.length) return [];
        query = query.whereIn('productId', wanted);
      }
      return (await query).map(saleFromDb);
    },
    /** Pending proposals past their expiry, and approved sales past their end, at `at`. */
    async lapsed(at) {
      const [expired, ended] = await Promise.all([
        sales().where({ status: 'pending_approval' }).where('expiresAt', '<=', at),
        sales().where({ status: 'approved' }).where('endsAt', '<=', at),
      ]);
      return { expired: expired.map(saleFromDb), ended: ended.map(saleFromDb) };
    },
    async insertSale(row) {
      const [saved] = await sales().insert(forWrite(SALE_FIELDS, JSON_FIELDS, row)).returning('*');
      return saleFromDb(saved);
    },
    async updateSale(id, patch) {
      const [saved] = await sales().where({ id }).update(forWrite(SALE_FIELDS, JSON_FIELDS, patch)).returning('*');
      return saleFromDb(saved);
    },
    async product(id) {
      if (!id) return null;
      return productFromDb(await q('Product').where({ id: String(id) }).select(PRODUCT_COLUMNS).first());
    },
    async products(ids) {
      const wanted = [...new Set(ids.filter(Boolean))];
      if (!wanted.length) return [];
      return (await q('Product').whereIn('id', wanted).select(PRODUCT_COLUMNS)).map(productFromDb);
    },
    /** Vendor accounts by id (fresh status: suspension, approval). */
    async vendors(ids) {
      const wanted = [...new Set(ids.filter(Boolean))];
      if (!wanted.length) return [];
      return q('User').whereIn('id', wanted).where({ userType: 'vendor' }).select('id', 'accountStatus', 'approvalStatus', 'vendorProfile', 'displayName');
    },
    /** ProductPriceChange rows of a product since `since` (all when null), newest first. */
    async priceChanges(productId, since = null) {
      let query = q('ProductPriceChange').where({ productId });
      if (since) query = query.where('at', '>=', since);
      return (await query.orderBy([{ column: 'at', order: 'desc' }, { column: 'id', order: 'desc' }]))
        .map(r => ({ at: iso(r.at), field: r.field, fromTzs: r.fromTzs == null ? null : Number(r.fromTzs), toTzs: r.toTzs == null ? null : Number(r.toTzs) }));
    },
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
      return (await q('AuditLog').where({ target: id }).where('action', 'like', 'flash_sale.%').orderBy('at', 'asc'))
        .map(r => ({ ...r, at: iso(r.at) }));
    },
    /** A vendor's open proposals (its own drafts, and pending not yet expired at `at`). */
    async openProposals(vendorId, at) {
      const [{ n }] = await sales().where({ origin: 'vendor', vendorId })
        .where(w => w.where({ status: 'draft' }).orWhere(p => p.where({ status: 'pending_approval' }).where('expiresAt', '>', at)))
        .count({ n: '*' });
      return Number(n);
    },
  };
}

const lock = (trx, productId) => trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`${LOCK_PREFIX}${productId}`]);

export function createPgFlashSaleStore({ db }) {
  return {
    ...bind(db),
    /** Run fn(store) in one transaction holding the product's flash-sale lock. */
    transaction: (productId, fn) => db.transaction(async (trx) => {
      await lock(trx, productId);
      return fn(bind(trx));
    }),
    /**
     * Hold the product's flash-sale lock while fn(store) runs (fn may write elsewhere, e.g. the
     * product form through its own transaction). Used by product saves that change a price.
     */
    withProductLock: (productId, fn) => db.transaction(async (trx) => {
      await lock(trx, productId);
      return fn(bind(trx));
    }),
  };
}
