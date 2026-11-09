// Postgres store for product barcodes (vendor business tools · S8, design docs/design/vendor-barcodes-s8.md §2).
//
// Every query is vendor-scoped and parameterised; nothing loads a whole table and nothing uses filterAsync.
// Codes are the vendor's private shop data: this store is read only by the vendor's own product views and the
// lookup, never by /shop/*, search, moderation or documents.
//
// A code is "dead" (B-7) when its product is deleted, or when it names a variant the product no longer has
// (a variant dropped while the flag was off). A dead code is never returned and never blocks a save: a save
// that wants it removes the old row in the same transaction.
import { randomUUID } from 'node:crypto';
import { variantsOf, isTracked } from '../shared/vendor-stock.mjs';
import { MAX_BARCODES_PER_PRODUCT, MAX_SKU_MATCHES, barcodeError } from '../shared/vendor-barcode.mjs';

const codeId = () => `pcd_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const parseVariants = p => variantsOf(p);
const variantNames = p => new Set(parseVariants(p).map(v => v.name));
const isDead = (row, product) => !product || product.deletedAt != null || (row.variant !== '' && !variantNames(product).has(row.variant));

export function createPgProductCodeStore({ db, now = () => new Date() }) {
  const audit = (q, { actorId, productId, vendorId, added = [], removed = [], reason, at }) => q('AuditLog').insert({
    id: randomUUID(), at, actor: actorId ?? null, action: 'product_barcodes_changed', target: productId, before: null,
    after: JSON.stringify({
      productId, vendorId, reason,
      added: added.map(c => ({ code: c.code, variant: c.variant || null })),
      removed: removed.map(c => ({ code: c.code, variant: c.variant || null })),
    }),
  });

  /**
   * The live codes of these products (one query): Map(productId → [{ code, variant|null }]), whole product first,
   * then by variant name and createdAt. `products` are the rows (their variants decide which codes are live).
   */
  async function codesOf(vendorId, products) {
    const out = new Map();
    if (!vendorId || !products.length) return out;
    const byId = new Map(products.map(p => [p.id, p]));
    const rows = await db('ProductCode').where({ vendorId }).whereIn('productId', [...byId.keys()])
      .orderBy([{ column: 'productId' }, { column: 'variant' }, { column: 'createdAt' }, { column: 'id' }])
      .select('productId', 'variant', 'code');
    for (const p of products) out.set(p.id, []);
    for (const r of rows) {
      if (isDead(r, byId.get(r.productId))) continue;
      out.get(r.productId).push({ code: r.code, variant: r.variant || null });
    }
    return out;
  }

  /** The holder of a codeKey within the vendor (locked when `lock`), with its product's name, variants and deletedAt. */
  async function holderOf(q, vendorId, key, { lock = false } = {}) {
    const res = await q.raw(`SELECT c.id, c."productId", c.variant, c.code, p.name, p.variants, p."deletedAt"
      FROM "ProductCode" c JOIN "Product" p ON p.id = c."productId"
      WHERE c."vendorId" = ? AND c."codeKey" = ?${lock ? ' FOR UPDATE OF c' : ''}`, [vendorId, key]);
    return res.rows[0] || null;
  }
  const inUse = (code, holder) => barcodeError('barcode_in_use', 409, { code, productId: holder.productId, name: holder.name, variant: holder.variant || null });

  /**
   * Inside the product save's transaction (applyProductForm / createProduct), under the product row lock, after
   * the product row is written (`saved`; `current` = the product as locked before the save, null when creating).
   * §2.3 step 2:
   *  - codes of variants the product does not have are deleted (B-6; reason variant_removed), whatever the body:
   *    a variant this save drops, and (security review #334 L-2) a variant that was ALREADY gone before this save
   *    (dropped while the flag was off), so an old code never comes back when a variant of the same name is added;
   *  - parsed (from parseBarcodeFields; null = the body has no codes): variants checked (B-5), the 20 cap,
   *    added/removed computed against the LOCKED current set, codes held by deleted products freed (B-7),
   *    rows inserted and deleted, one audit row (B-12).
   * Locks (security review #334 L-1): this product's codes and the holders of every code in the body are locked in
   * ONE statement, in codeKey order, before anything is deleted; new codes are inserted in codeKey order. Two saves
   * that swap codes between two products therefore queue on the first shared code instead of deadlocking.
   * → null when done, or { error, status, ... } (the caller rolls the whole save back).
   * reason: form (replace) | add_from_scan (add).
   */
  async function applyInSave(trx, { vendorId, productId, actorId, saved, current: before = null, parsed }) {
    const at = now();
    const names = variantNames(saved);
    const hadNames = before ? variantNames(before) : null;
    const bodyKeys = [...new Set((parsed?.items || []).map(i => i.codeKey))];
    const locked = (await trx.raw(`SELECT * FROM "ProductCode" WHERE "vendorId" = ? AND ("productId" = ? OR "codeKey" = ANY(?::text[]))
      ORDER BY "codeKey", id FOR UPDATE`, [vendorId, productId, bodyKeys])).rows;
    const byOrder = (a, b) => (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0) || (+new Date(a.createdAt) - +new Date(b.createdAt)) || (a.id < b.id ? -1 : 1);
    const current = locked.filter(r => r.productId === productId).sort(byOrder);
    const gone = current.filter(r => r.variant !== '' && (!names.has(r.variant) || (hadNames && !hadNames.has(r.variant))));
    if (gone.length) {
      await trx('ProductCode').whereIn('id', gone.map(r => r.id)).del();
      await audit(trx, { actorId, productId, vendorId, removed: gone, reason: 'variant_removed', at });
    }
    if (!parsed) return null;
    const live = current.filter(r => !gone.includes(r));
    for (const item of parsed.items) {
      if (item.variant && !names.has(item.variant)) return barcodeError('barcode_variant_not_found', 400, { code: item.code, variant: item.variant });
    }
    let desired;
    if (parsed.mode === 'replace') {
      desired = parsed.items;
    } else {
      desired = live.map(r => ({ code: r.code, codeKey: r.codeKey, variant: r.variant }));
      for (const item of parsed.items) {
        const mine = live.find(r => r.codeKey === item.codeKey);
        if (mine && mine.variant === item.variant) continue; // already there: a no-op
        // On this product but for another variant: adding never moves (or removes) a code.
        if (mine) return inUse(item.code, { productId, name: saved.name, variant: mine.variant });
        desired.push(item);
      }
    }
    if (desired.length > MAX_BARCODES_PER_PRODUCT) return barcodeError('too_many_barcodes', 400, { max: MAX_BARCODES_PER_PRODUCT });
    const same = (a, b) => a.codeKey === b.codeKey && (a.variant || '') === (b.variant || '');
    const removed = live.filter(r => !desired.some(d => same(d, r)));
    const added = desired.filter(d => !live.some(r => same(d, r)));
    // Another product's live code: refused before anything is deleted or inserted (the holders are locked above).
    for (const item of added) {
      const holder = await holderOf(trx, vendorId, item.codeKey);
      if (holder && holder.productId !== productId && !isDead(holder, holder)) return inUse(item.code, holder);
    }
    if (removed.length) await trx('ProductCode').whereIn('id', removed.map(r => r.id)).del();
    // Inserted in codeKey order (lock order); createdAt keeps the order they were sent in (one millisecond apart).
    const ordered = added.map((item, i) => ({ item, i })).sort((a, b) => (a.item.codeKey < b.item.codeKey ? -1 : 1));
    for (const { item, i } of ordered) {
      const holder = await holderOf(trx, vendorId, item.codeKey, { lock: true });
      if (holder) {
        if (!isDead(holder, holder)) return inUse(item.code, holder);
        // B-7: a deleted product (or a variant it no longer has) never blocks a code.
        await trx('ProductCode').where({ id: holder.id }).del();
        await audit(trx, { actorId, productId: holder.productId, vendorId, removed: [holder], reason: holder.deletedAt ? 'product_deleted' : 'variant_removed', at });
      }
      const inserted = await trx.raw(`INSERT INTO "ProductCode" (id, "vendorId", "productId", variant, code, "codeKey", "createdBy", "createdAt")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT ("vendorId", "codeKey") DO NOTHING RETURNING id`,
      [codeId(), vendorId, productId, item.variant || '', item.code, item.codeKey, actorId || vendorId, new Date(+at + i)]);
      if (!inserted.rows.length) {
        // A concurrent save took it first (it committed while this one waited): the unique index is the authority.
        const winner = await holderOf(trx, vendorId, item.codeKey);
        return inUse(item.code, winner || { productId: null, name: null, variant: null });
      }
    }
    if (added.length || removed.length) {
      await audit(trx, { actorId, productId, vendorId, added, removed, reason: parsed.mode === 'replace' ? 'form' : 'add_from_scan', at });
    }
    return null;
  }

  /** DELETE /vendor/products/:id (after the soft delete): the product's codes go, with one audit row. */
  async function deleteForProduct({ vendorId, productId, actorId }) {
    return db.transaction(async (trx) => {
      const rows = await trx('ProductCode').where({ vendorId, productId }).forUpdate();
      if (!rows.length) return 0;
      await trx('ProductCode').whereIn('id', rows.map(r => r.id)).del();
      await audit(trx, { actorId, productId, vendorId, removed: rows, reason: 'product_deleted', at: now() });
      return rows.length;
    });
  }

  const LOOKUP_COLUMNS = ['id', 'vendorId', 'name', 'variants', 'priceTzs', 'discountPriceTzs', 'stock', 'status', 'approvalStatus', 'sku', 'deletedAt'];
  /** A lookup match: never cost, images or reorder level (B-10). */
  function matchView(p, variant, matchedBy) {
    const variants = parseVariants(p);
    const tracked = variants.filter(isTracked);
    const own = variant ? variants.find(v => v.name === variant) : null;
    return {
      productId: p.id, name: p.name, variant: variant || null,
      variants: !variant && tracked.length && tracked.length === variants.length ? tracked.map(v => ({ name: v.name, stock: v.stock })) : null,
      priceTzs: p.priceTzs == null ? null : Number(p.priceTzs),
      discountPriceTzs: p.discountPriceTzs == null ? null : Number(p.discountPriceTzs),
      stock: own && isTracked(own) ? own.stock : Number(p.stock || 0),
      status: p.status || 'active', approvalStatus: p.approvalStatus || 'pending', sku: p.sku ?? null, matchedBy,
    };
  }

  /**
   * GET /vendor/products/lookup (§2.4). Only this vendor's codes and products; deleted products never match.
   * Barcode matches always win; with none, the exact SKU (trimmed, case-insensitive; B-9) — up to 10, by name.
   */
  async function lookup(vendorId, { code, codeKey, barcode }) {
    if (barcode) {
      const res = await db.raw(`SELECT c.variant AS "codeVariant", ${LOOKUP_COLUMNS.map(c => `p."${c}"`).join(', ')}
        FROM "ProductCode" c JOIN "Product" p ON p.id = c."productId" AND p."vendorId" = c."vendorId"
        WHERE c."vendorId" = ? AND c."codeKey" = ? AND p."deletedAt" IS NULL`, [vendorId, codeKey]);
      const live = res.rows.filter(r => !isDead({ variant: r.codeVariant }, r));
      if (live.length) return live.map(r => matchView(r, r.codeVariant, 'barcode'));
    }
    const rows = await db('Product').where({ vendorId }).whereNull('deletedAt')
      .whereRaw('lower(btrim(sku)) = lower(?)', [code])
      .orderBy([{ column: 'name' }, { column: 'id' }]).limit(MAX_SKU_MATCHES).select(LOOKUP_COLUMNS);
    return rows.map(r => matchView(r, null, 'sku'));
  }

  return { codesOf, applyInSave, deleteForProduct, lookup };
}
