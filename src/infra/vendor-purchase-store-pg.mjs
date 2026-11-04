// Postgres store for suppliers, receiving stock (GRN) and payables (vendor business tools · S9; design spec
// docs/design/vendor-purchases-s9.md §2, approved 2026-11-04). RULE 6 AREA: money records, cost-price writes,
// shared product rows.
//
// Lock order everywhere: supplier → purchase → products (ids in order; lines are unique per product + variant,
// moved in the fixed productId\0variant order S3 uses) → ProductPrivate rows → the GRN sequence. App orders and
// POS sales lock products only, S7 locks sale → products, so there is no cycle.
//
// Receive (ONE transaction): supplier FOR SHARE (archive takes FOR UPDATE, so it cannot race a new debt) →
// products FOR UPDATE, re-checked → stock + q (the variant's own count in the same statement) → ProductPrivate
// rows FOR UPDATE, cost price set to the unit cost (O-9, P-6; free lines never change it) → GRN number from the
// vendor's row-locked `purchase` sequence (a rollback gives it back) → ledger rows (reason stock_in, sourceId =
// the purchase, note = the GRN) → purchase, lines, instalments, the payment at receipt, audit.
// Void: supplier FOR SHARE → purchase FOR UPDATE → products: conditional stock >= q (every short line is
// collected, then refused together) → ledger stock_in_void → cost prices put back where nothing changed them
// since → payments voided with it → purchase voided.
//
// FitFlex moves no money: nothing here writes ShopOrder, PaymentRequest, commission or settlement rows. Every
// query is vendor-scoped and parameterised.
import { randomUUID } from 'node:crypto';
import { VARIANT_HAS_STOCK, variantStockAdjusted, variantStockOf } from './shop-order-store-pg.mjs';
import { variantsOf, isTracked } from '../shared/vendor-stock.mjs';
import { dayOf } from './vendor-sale-store-pg.mjs';
import { AGING_BUCKETS, addDays, encodeOffset } from '../shared/vendor-customer.mjs';
import {
  PURCHASE_DOC_TYPE, grnNumber, planPurchaseMoney, coverInstalments, coveredBy, paymentStateOf, planChange,
  parseSchedule, atReceiptClientRef, DUE_MAX_DAYS,
} from '../shared/vendor-purchase.mjs';

const UNIQUE_VIOLATION = '23505';
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
/** Thrown inside a transaction so that it rolls back, then returned to the caller. */
const refusal = (error, status, extra = {}) => Object.assign(new Error(error), { refusal: fail(error, status, extra) });
const asRefusal = r => Object.assign(new Error(r.error), { refusal: r });
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const iso = v => (v == null ? null : new Date(v).toISOString());
const person = (id, name) => (id ? { id, name: name ?? null } : null);
const keyOf = (productId, variant) => `${productId}\u0000${variant || ''}`;
const num = v => (v == null ? 0 : Number(v));
const likeOf = q => `%${String(q).toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;
const byKey = (a, b) => (keyOf(a.productId, a.variant) < keyOf(b.productId, b.variant) ? -1 : 1);

/**
 * Open instalments of received purchases, with coverage (P-5): per active instalment, covered = min(amount,
 * max(0, paid − Σ earlier amounts in plan order)). Params: [today, vendorId, ...extra params].
 * Columns: supplierId, purchaseId, number, pos (1-based position in the plan), dueDate (text), openTzs, late.
 */
const OPEN_SQL = extra => `
  SELECT x.* FROM (
    SELECT p."supplierId", p.id AS "purchaseId", p.number, i.seq,
           row_number() OVER (PARTITION BY i."purchaseId" ORDER BY i.seq)::int AS pos,
           i."dueDate"::text AS "dueDate",
           (i."amountTzs" - LEAST(i."amountTzs", GREATEST(0, p."paidTzs" - COALESCE(sum(i."amountTzs") OVER (
             PARTITION BY i."purchaseId" ORDER BY i.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))))::bigint AS "openTzs",
           (d.today - i."dueDate")::int AS late
      FROM "VendorPurchase" p
      JOIN "VendorPurchaseInstalment" i ON i."purchaseId" = p.id AND i."vendorId" = p."vendorId" AND i.status = 'active'
      CROSS JOIN (SELECT ?::date AS today) d
     WHERE p."vendorId" = ? AND p.status = 'received' AND p."balanceTzs" > 0 ${extra}
  ) x WHERE x."openTzs" > 0`;

/** Per supplier: owed, overdue, the five buckets, due in 7 days. Params as OPEN_SQL. */
const OWED_SQL = extra => `
  SELECT o."supplierId",
         sum(o."openTzs")::bigint AS "owedTzs",
         COALESCE(sum(o."openTzs") FILTER (WHERE o.late >= 1), 0)::bigint AS "overdueTzs",
         COALESCE(sum(o."openTzs") FILTER (WHERE o.late <= 0), 0)::bigint AS current,
         COALESCE(sum(o."openTzs") FILTER (WHERE o.late BETWEEN 1 AND 30), 0)::bigint AS d1_30,
         COALESCE(sum(o."openTzs") FILTER (WHERE o.late BETWEEN 31 AND 60), 0)::bigint AS d31_60,
         COALESCE(sum(o."openTzs") FILTER (WHERE o.late BETWEEN 61 AND 90), 0)::bigint AS d61_90,
         COALESCE(sum(o."openTzs") FILTER (WHERE o.late >= 91), 0)::bigint AS d90plus,
         COALESCE(sum(o."openTzs") FILTER (WHERE o.late BETWEEN -7 AND 0), 0)::bigint AS "dueIn7DaysTzs",
         min(o."dueDate") AS "oldestDueDate",
         GREATEST(max(o.late), 0)::int AS "maxDaysOverdue"
    FROM (${OPEN_SQL(extra)}) o
   GROUP BY o."supplierId"`;

/** Per purchase (correlated on p): overdueTzs and nextDueDate. One param: today. */
const PURCHASE_OPEN_LATERAL = `LEFT JOIN LATERAL (
    SELECT COALESCE(sum(y.open) FILTER (WHERE y."dueDate" < y.today), 0)::bigint AS "overdueTzs",
           min(y."dueDate") FILTER (WHERE y.open > 0)::text AS "nextDueDate"
      FROM (SELECT i."dueDate", d.today,
                   i."amountTzs" - LEAST(i."amountTzs", GREATEST(0, p."paidTzs" - COALESCE(sum(i."amountTzs") OVER (
                     ORDER BY i.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))) AS open
              FROM "VendorPurchaseInstalment" i CROSS JOIN (SELECT ?::date AS today) d
             WHERE i."purchaseId" = p.id AND i."vendorId" = p."vendorId" AND i.status = 'active' AND p.status = 'received') y
  ) ov ON true`;

const agingOf = r => Object.fromEntries(AGING_BUCKETS.map(b => [b, num(r?.[b])]));

export const supplierView = (row) => {
  const s = plain(row);
  return {
    id: s.id, name: s.name, phone: s.phone ?? null, email: s.email ?? null, contactPerson: s.contactPerson ?? null,
    address: s.address ?? null, tin: s.tin ?? null, note: s.note ?? null, archived: s.archivedAt != null, archivedAt: iso(s.archivedAt),
    createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt),
  };
};

export function createPgVendorPurchaseStore({ db, now = () => new Date() }) {
  async function namesOf(q, ids) {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (!wanted.length) return new Map();
    const rows = await q('User').whereIn('id', wanted).select('id', 'displayName');
    return new Map(rows.map(r => [r.id, r.displayName ?? null]));
  }
  const audit = (q, { actor, action, target, before = null, after = null }) => q('AuditLog').insert({
    id: randomUUID(), at: now(), actor, action, target, before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });
  const sequence = async (trx, vendorId, at) => Number((await trx.raw(`INSERT INTO "VendorDocumentSequence" ("vendorId", "docType", "next", "updatedAt")
      VALUES (?, ?, 2, ?)
      ON CONFLICT ("vendorId", "docType") DO UPDATE SET "next" = "VendorDocumentSequence"."next" + 1, "updatedAt" = EXCLUDED."updatedAt"
      RETURNING "next" - 1 AS seq`, [vendorId, PURCHASE_DOC_TYPE, at])).rows[0].seq);

  // ── suppliers ───────────────────────────────────────────────────────────────

  const findSupplier = (q, vendorId, supplierId) => (typeof supplierId === 'string' && supplierId
    ? q('VendorSupplier').where({ id: supplierId, vendorId }).first() : null);

  /** What the supplier is owed now (received purchases only; voided ones never count). */
  async function owedBalance(q, vendorId, supplierId) {
    const row = await q('VendorPurchase').where({ vendorId, supplierId, status: 'received' }).sum({ s: 'balanceTzs' }).first();
    return num(row?.s);
  }
  async function duplicateOf(q, vendorId, name, exceptId = null) {
    const query = q('VendorSupplier').where({ vendorId }).whereNull('archivedAt').whereRaw('lower(name) = lower(?)', [name]);
    if (exceptId) query.whereNot('id', exceptId);
    return (await query.first('id'))?.id ?? null;
  }
  const isNameClash = err => err?.code === UNIQUE_VIOLATION && /vendorsupplier_active_name_unique/.test(`${err.constraint || ''} ${err.message}`);

  async function createSupplier({ vendorId, actorId, fields }) {
    const at = now();
    const id = newId('vsp');
    try {
      return await db.transaction(async (trx) => {
        const clash = await duplicateOf(trx, vendorId, fields.name);
        if (clash) throw refusal('duplicate_supplier', 409, { supplierId: clash });
        await trx('VendorSupplier').insert({ id, vendorId, ...fields, createdBy: actorId, createdAt: at, updatedAt: at });
        await audit(trx, { actor: actorId, action: 'vendor_supplier_created', target: id, after: { vendorId, ...fields } });
        return { supplier: supplierView(await trx('VendorSupplier').where({ id }).first()) };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      if (isNameClash(err)) return fail('duplicate_supplier', 409, { supplierId: await duplicateOf(db, vendorId, fields.name) });
      throw err;
    }
  }

  async function updateSupplier({ vendorId, actorId, supplierId, fields, archived }) {
    if (typeof supplierId !== 'string' || !supplierId) return fail('supplier_not_found', 404);
    const at = now();
    let nameForClash = null;
    try {
      return await db.transaction(async (trx) => {
        // FOR UPDATE: a receive holding the supplier FOR SHARE finishes first, so archiving sees its debt.
        const row = plain(await trx('VendorSupplier').where({ id: supplierId, vendorId }).forUpdate().first());
        if (!row) throw refusal('supplier_not_found', 404);
        const changes = {};
        for (const [k, v] of Object.entries(fields)) if ((row[k] ?? null) !== v) changes[k] = v;
        const archiving = archived === true && !row.archivedAt;
        const restoring = archived === false && row.archivedAt;
        if (archiving) {
          const owedTzs = await owedBalance(trx, vendorId, supplierId);
          if (owedTzs > 0) throw refusal('supplier_has_balance', 409, { owedTzs });
        }
        const name = changes.name ?? row.name;
        nameForClash = name;
        if ((restoring || (changes.name && !row.archivedAt && !archiving))) {
          const clash = await duplicateOf(trx, vendorId, name, supplierId);
          if (clash) throw refusal('duplicate_supplier', 409, { supplierId: clash });
        }
        if (Object.keys(changes).length) {
          await trx('VendorSupplier').where({ id: supplierId, vendorId }).update({ ...changes, updatedAt: at });
          await audit(trx, {
            actor: actorId, action: 'vendor_supplier_updated', target: supplierId,
            before: Object.fromEntries(Object.keys(changes).map(k => [k, row[k] ?? null])), after: { vendorId, ...changes },
          });
        }
        if (archiving) {
          await trx('VendorSupplier').where({ id: supplierId, vendorId }).update({ archivedAt: at, archivedBy: actorId, updatedAt: at });
          await audit(trx, { actor: actorId, action: 'vendor_supplier_archived', target: supplierId, after: { vendorId } });
        }
        if (restoring) {
          await trx('VendorSupplier').where({ id: supplierId, vendorId }).update({ archivedAt: null, archivedBy: null, updatedAt: at });
          await audit(trx, { actor: actorId, action: 'vendor_supplier_restored', target: supplierId, after: { vendorId } });
        }
        return { supplier: supplierView(await trx('VendorSupplier').where({ id: supplierId }).first()) };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      if (isNameClash(err)) return fail('duplicate_supplier', 409, { supplierId: await duplicateOf(db, vendorId, nameForClash, supplierId) });
      throw err;
    }
  }

  /** GET /vendor/suppliers: one row per supplier with what they are owed. Offset cursor (sorted by money figures). */
  async function listSuppliers({ vendorId, today, q = null, filter = 'active', sort = 'name', limit = 50, offset = 0 }) {
    const where = ['s."vendorId" = ?'];
    const params = [];
    if (filter === 'archived') where.push('s."archivedAt" IS NOT NULL');
    else where.push('s."archivedAt" IS NULL');
    if (filter === 'owing') where.push('COALESCE(o."owedTzs", 0) > 0');
    if (filter === 'overdue') where.push('COALESCE(o."overdueTzs", 0) > 0');
    if (q) {
      // A phone typed as 07… matches the stored +2557…: the national leading 0 is dropped.
      const digits = String(q).replace(/\D/g, '').replace(/^0/, '');
      where.push(`(lower(s.name) LIKE ? ESCAPE '\\' OR lower(COALESCE(s."contactPerson", '')) LIKE ? ESCAPE '\\'${digits.length >= 2 ? ` OR s.phone LIKE ?` : ''})`);
      params.push(likeOf(q), likeOf(q));
      if (digits.length >= 2) params.push(`%${digits}%`);
    }
    const order = {
      name: 'lower(s.name) ASC, s.id ASC',
      owed: 'COALESCE(o."owedTzs", 0) DESC, lower(s.name) ASC, s.id ASC',
      recent: 'lr."lastReceivedOn" DESC NULLS LAST, s."createdAt" DESC, s.id ASC',
    }[sort];
    const { rows } = await db.raw(`
      SELECT s.id, s.name, s.phone, s."contactPerson", s."archivedAt",
             COALESCE(o."owedTzs", 0)::bigint AS "owedTzs", COALESCE(o."overdueTzs", 0)::bigint AS "overdueTzs",
             o."oldestDueDate" AS "nextDueDate", lr."lastReceivedOn"
        FROM "VendorSupplier" s
        LEFT JOIN (${OWED_SQL('')}) o ON o."supplierId" = s.id
        LEFT JOIN (SELECT "supplierId", max("receivedOn")::text AS "lastReceivedOn" FROM "VendorPurchase"
                    WHERE "vendorId" = ? AND status = 'received' GROUP BY 1) lr ON lr."supplierId" = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY ${order} LIMIT ? OFFSET ?`, [today, vendorId, vendorId, vendorId, ...params, limit + 1, offset]);
    const page = rows.slice(0, limit).map(plain);
    return {
      suppliers: page.map(r => ({
        id: r.id, name: r.name, phone: r.phone ?? null, contactPerson: r.contactPerson ?? null, owedTzs: num(r.owedTzs), overdueTzs: num(r.overdueTzs),
        nextDueDate: r.nextDueDate ?? null, lastReceivedOn: r.lastReceivedOn ?? null, archived: r.archivedAt != null,
      })),
      nextCursor: rows.length > limit ? encodeOffset(offset + limit) : null,
    };
  }

  /** GET /vendor/suppliers/:id → profile, or null (unknown / another vendor's). */
  async function supplierProfile({ vendorId, supplierId, today }) {
    const row = await findSupplier(db, vendorId, supplierId);
    if (!row) return null;
    const [totals, owed, open] = await Promise.all([
      db('VendorPurchase').where({ vendorId, supplierId, status: 'received' })
        .first(db.raw('COALESCE(sum("totalTzs"), 0)::bigint AS "purchasedTzs"'), db.raw('count(*)::int AS "purchaseCount"'),
          db.raw('COALESCE(sum("paidTzs"), 0)::bigint AS "paidTzs"'), db.raw('max("receivedOn")::text AS "lastReceivedOn"')),
      db.raw(OWED_SQL('AND p."supplierId" = ?'), [today, vendorId, supplierId]),
      db.raw(`${OPEN_SQL('AND p."supplierId" = ?')} ORDER BY x."dueDate", x.number, x.pos`, [today, vendorId, supplierId]),
    ]);
    const t = plain(totals);
    const o = plain(owed.rows[0]);
    return {
      supplier: supplierView(row),
      totals: { purchasedTzs: num(t?.purchasedTzs), purchaseCount: num(t?.purchaseCount), paidTzs: num(t?.paidTzs), lastReceivedOn: t?.lastReceivedOn ?? null },
      owedTzs: num(o?.owedTzs), overdueTzs: num(o?.overdueTzs), aging: agingOf(o), asOf: today,
      openInstalments: open.rows.map(plain).map(r => ({
        purchaseId: r.purchaseId, number: r.number, seq: r.pos, dueDate: r.dueDate, openTzs: num(r.openTzs), daysOverdue: Math.max(0, num(r.late)),
      })),
    };
  }

  // ── purchase view ───────────────────────────────────────────────────────────

  async function loadPurchase(q, where) {
    const p = plain(await q('VendorPurchase').where(where).first());
    if (!p) return null;
    const [lines, instalments, payments, supplier] = await Promise.all([
      q('VendorPurchaseLine').where({ purchaseId: p.id, vendorId: p.vendorId }).orderBy('lineNo'),
      q('VendorPurchaseInstalment').where({ purchaseId: p.id, vendorId: p.vendorId, status: 'active' }).orderBy('seq'),
      q('VendorPurchasePayment').where({ purchaseId: p.id, vendorId: p.vendorId }).orderBy([{ column: 'createdAt' }, { column: 'id' }]),
      p.supplierId ? q('VendorSupplier').where({ id: p.supplierId, vendorId: p.vendorId }).first('id', 'name', 'archivedAt') : null,
    ]);
    const names = await namesOf(q, [p.createdBy, p.voidedBy, ...payments.flatMap(x => [x.recordedBy, x.voidedBy])]);
    return {
      p, lines: lines.map(plain), instalments: instalments.map(plain).map(i => ({ ...i, dueDate: dayOf(i.dueDate) })),
      payments: payments.map(plain), supplier: plain(supplier), names,
    };
  }

  /** The purchase as vendors see it (§2.3). Never fingerprint, clientRef, costSourceId or internals. */
  function purchaseView(found, { canSeeCost = false, today }) {
    const { p, lines, instalments, payments, supplier, names } = found;
    const voided = p.status === 'voided';
    const covered = coverInstalments(instalments, p.paidTzs, today).map(i => (voided ? { ...i, state: i.state === 'overdue' ? 'due' : i.state, daysOverdue: 0 } : i));
    const overdueTzs = voided ? 0 : covered.filter(i => i.dueDate < today).reduce((s, i) => s + i.openTzs, 0);
    const next = voided ? null : covered.find(i => i.openTzs > 0) || null;
    return {
      id: p.id, number: p.number, status: p.status,
      supplier: supplier ? { id: supplier.id, name: supplier.name, archived: supplier.archivedAt != null } : null,
      receivedOn: dayOf(p.receivedOn), recordedAt: iso(p.createdAt), supplierInvoiceRef: p.supplierInvoiceRef ?? null, note: p.note ?? null,
      createdBy: person(p.createdBy, names.get(p.createdBy)),
      totalTzs: p.totalTzs, paidTzs: p.paidTzs, balanceTzs: p.balanceTzs, overdueTzs,
      paymentState: paymentStateOf(p),
      nextDue: next ? { dueDate: next.dueDate, openTzs: next.openTzs, daysOverdue: next.daysOverdue } : null,
      lines: lines.map(l => ({
        id: l.id, productId: l.productId, variant: l.variant || null, nameSnapshot: l.nameSnapshot, qty: l.qty,
        unitCostTzs: l.unitCostTzs, lineTotalTzs: l.lineTotalTzs, costUpdated: Boolean(l.costUpdated), free: l.unitCostTzs === 0,
        ...(canSeeCost ? { previousCostTzs: l.costUpdated ? l.previousCostTzs ?? null : null } : {}),
        costRestoredOnVoid: l.costRestoredOnVoid ?? null,
      })),
      instalments: covered.map((i, n) => ({
        id: i.id, seq: n + 1, dueDate: i.dueDate, amountTzs: i.amountTzs, coveredTzs: i.coveredTzs, openTzs: i.openTzs, state: i.state, daysOverdue: i.daysOverdue,
      })),
      payments: payments.map(x => ({
        id: x.id, amountTzs: x.amountTzs, paidOn: dayOf(x.paidOn), method: x.method, reference: x.reference ?? null, note: x.note ?? null,
        atReceipt: Boolean(x.atReceipt), recordedBy: person(x.recordedBy, names.get(x.recordedBy)), recordedAt: iso(x.createdAt),
        status: x.status, voidedBy: person(x.voidedBy, names.get(x.voidedBy)), voidedAt: iso(x.voidedAt), voidReason: x.voidReason ?? null,
        voidedWithPurchase: Boolean(x.voidedWithPurchase),
      })),
      voidedBy: person(p.voidedBy, names.get(p.voidedBy)), voidedAt: iso(p.voidedAt), voidReason: p.voidReason ?? null,
    };
  }

  /** The cost-price changes a purchase made (the receive response; fromTzs only for canSeeCost). */
  function costChangesOf(lines, canSeeCost) {
    return lines.filter(l => l.costUpdated).map(l => ({
      productId: l.productId, variant: l.variant || null, name: l.nameSnapshot,
      ...(canSeeCost ? { fromTzs: l.previousCostTzs ?? null } : {}), toTzs: l.unitCostTzs,
    }));
  }

  async function getPurchase({ vendorId, purchaseId, canSeeCost, today }) {
    if (typeof purchaseId !== 'string' || !purchaseId) return null;
    const found = await loadPurchase(db, { id: purchaseId, vendorId });
    return found ? purchaseView(found, { canSeeCost, today }) : null;
  }

  // ── receive ─────────────────────────────────────────────────────────────────

  /** A purchase already recorded under this clientRef: the same request → it (200); a different one → 409. */
  async function receiveReplay(q, vendorId, clientRef, fingerprint, { canSeeCost, today }) {
    const row = await q('VendorPurchase').where({ vendorId, clientRef }).first('id', 'fingerprint');
    if (!row) return null;
    if (row.fingerprint !== fingerprint) return fail('client_ref_reused', 409);
    const found = await loadPurchase(q, { id: row.id, vendorId });
    return { purchase: purchaseView(found, { canSeeCost, today }), costChanges: costChangesOf(found.lines, canSeeCost), replayed: true, productIds: [] };
  }

  /** Check one line against its (locked) product → { name, variantTracked } or throws a refusal (S3 rules). */
  function checkLine(product, line) {
    if (!product || product.deletedAt) throw refusal('product_not_found', 404, { productId: line.productId });
    if (product.status === 'archived') throw refusal('product_unavailable', 400, { productId: line.productId });
    const variants = variantsOf(product);
    const tracked = variants.filter(isTracked);
    let variantTracked = false;
    if (line.variant) {
      const found = variants.find(v => v.name === line.variant);
      if (!found) throw refusal('variant_not_found', 404, { productId: line.productId, variant: line.variant, variants: variants.map(v => v.name) });
      variantTracked = isTracked(found);
    } else if (tracked.length) {
      throw refusal('variant_required', 400, { productId: line.productId, variants: tracked.map(v => v.name) });
    }
    return { name: String(product.name || ''), variantTracked };
  }

  /**
   * Receive stock. `parsed` from parseReceive. → { purchase, costChanges, replayed, productIds } or { error, status, ... }.
   */
  async function receive({ vendorId, actorId, parsed, fingerprint, canSeeCost = false, today }) {
    const earlier = await receiveReplay(db, vendorId, parsed.clientRef, fingerprint, { canSeeCost, today });
    if (earlier) return earlier;
    const at = now();
    const purchaseId = newId('vpo');
    try {
      return await db.transaction(async (trx) => {
        // 1. The supplier, FOR SHARE (other receives may run alongside; archiving waits).
        let supplier = null;
        if (parsed.supplierId) {
          supplier = plain(await trx('VendorSupplier').where({ id: parsed.supplierId, vendorId }).forShare().first('id', 'name', 'archivedAt'));
          if (!supplier) throw refusal('supplier_not_found', 404);
          if (supplier.archivedAt) throw refusal('supplier_archived', 409, { supplierId: supplier.id });
        }
        // 2. Each product FOR UPDATE, in id order; only this vendor's row (another vendor's is "not found").
        const productIds = [...new Set(parsed.lines.map(l => l.productId))].sort();
        const products = new Map();
        for (const id of productIds) products.set(id, plain(await trx('Product').where({ id, vendorId }).forUpdate().first()) || null);
        // Two identical requests at once: the second waited for the product locks; the first is now committed.
        const raced = await receiveReplay(trx, vendorId, parsed.clientRef, fingerprint, { canSeeCost, today });
        if (raced) return raced;
        const lines = parsed.lines.map(l => ({ ...l, ...checkLine(products.get(l.productId), l) }));

        // 3. Money (P-3, P-4, P-5) on the server's total.
        const money = planPurchaseMoney(parsed, { hasSupplier: Boolean(supplier) });
        if (money.error) throw asRefusal(money);

        // 4. Stock in: + qty (the variant's own count too while it keeps one). Adding stock cannot fail on quantity.
        const ordered = [...lines].sort(byKey);
        for (const l of ordered) {
          const update = { stock: trx.raw('stock + ?', [l.qty]), updatedAt: at };
          if (l.variantTracked) update.variants = trx.raw(variantStockAdjusted('+'), [l.variant, l.qty]);
          const rows = await trx('Product').where({ id: l.productId, vendorId }).update(update).returning(['stock', 'variants']);
          l.stockAfter = l.variantTracked ? variantStockOf(rows[0].variants, l.variant) ?? rows[0].stock : rows[0].stock;
        }

        // 5. Cost price (O-9, P-6): a line with a unit cost sets its target row (the variant's own, else the product's).
        const costed = ordered.filter(l => l.unitCostTzs > 0);
        if (costed.length) {
          await trx('ProductPrivate').insert(costed.map(l => ({ productId: l.productId, variant: l.variant || '', vendorId, updatedAt: at })))
            .onConflict(['productId', 'variant']).ignore();
          const rows = (await trx('ProductPrivate').whereIn(['productId', 'variant'], costed.map(l => [l.productId, l.variant || '']))
            .orderBy([{ column: 'productId' }, { column: 'variant' }]).forUpdate()).map(plain);
          const rowOf = l => rows.find(r => r.productId === l.productId && r.variant === (l.variant || ''));
          for (const l of costed) {
            const row = rowOf(l);
            if (row && row.costTzs != null && Number(row.costTzs) === l.unitCostTzs) continue;
            l.costUpdated = true;
            l.previousCostTzs = row?.costTzs == null ? null : Number(row.costTzs);
            l.previousCostSourceId = row?.costSourceId ?? null;
            await trx('ProductPrivate').where({ productId: l.productId, variant: l.variant || '' })
              .update({ costTzs: l.unitCostTzs, costSourceId: purchaseId, costUpdatedAt: at, updatedAt: at });
          }
        }

        // 6. The GRN number, under the sequence row's lock (released at commit; a rollback gives it back).
        const seq = await sequence(trx, vendorId, at);
        const number = grnNumber(seq);

        // 7. The ledger, one row per line (the unique (sourceId, productId, variant, reason) index allows one).
        await trx('ShopStockMovement').insert(ordered.map(l => ({
          id: `stk_${randomUUID().slice(0, 12)}`, orderId: null, productId: l.productId, variant: l.variant || '', cycle: 1,
          delta: l.qty, reason: 'stock_in', kind: 'stock_in', stockAfter: l.stockAfter, vendorId, note: number, actorId,
          clientRef: null, sourceId: purchaseId, createdAt: at,
        })));

        // 8. The purchase, its lines, the plan and the payment at receipt.
        await trx('VendorPurchase').insert({
          id: purchaseId, vendorId, seq, number, supplierId: supplier?.id ?? null, status: 'received', receivedOn: parsed.receivedOn,
          supplierInvoiceRef: parsed.supplierInvoiceRef, note: parsed.note, totalTzs: parsed.totalTzs, paidTzs: money.paidNowTzs,
          balanceTzs: money.balanceTzs, clientRef: parsed.clientRef, fingerprint, createdBy: actorId, createdAt: at, updatedAt: at,
        });
        await trx('VendorPurchaseLine').insert(lines.map((l, i) => ({
          id: newId('vpl'), purchaseId, vendorId, lineNo: i + 1, productId: l.productId, variant: l.variant || '', variantTracked: l.variantTracked,
          nameSnapshot: l.name, qty: l.qty, unitCostTzs: l.unitCostTzs, lineTotalTzs: l.lineTotalTzs, costUpdated: Boolean(l.costUpdated),
          previousCostTzs: l.costUpdated ? l.previousCostTzs : null, previousCostSourceId: l.costUpdated ? l.previousCostSourceId : null,
        })));
        if (money.instalments.length) {
          await trx('VendorPurchaseInstalment').insert(money.instalments.map((r, i) => ({
            id: newId('vpi'), purchaseId, vendorId, seq: i + 1, dueDate: r.dueDate, amountTzs: r.amountTzs, status: 'active', createdBy: actorId, createdAt: at,
          })));
        }
        if (money.paidNowTzs > 0) {
          await trx('VendorPurchasePayment').insert({
            id: newId('vpp'), vendorId, purchaseId, supplierId: supplier?.id ?? null, amountTzs: money.paidNowTzs, paidOn: parsed.receivedOn,
            method: parsed.paidNow.method, reference: parsed.paidNow.reference, note: null, atReceipt: true, status: 'recorded',
            clientRef: atReceiptClientRef(parsed.clientRef), fingerprint, recordedBy: actorId, createdAt: at,
          });
        }
        await audit(trx, {
          actor: actorId, action: 'vendor_purchase_received', target: purchaseId,
          after: {
            vendorId, number, supplierId: supplier?.id ?? null, receivedOn: parsed.receivedOn, totalTzs: parsed.totalTzs, paidNowTzs: money.paidNowTzs,
            lines: lines.map(l => ({ productId: l.productId, variant: l.variant || null, qty: l.qty, unitCostTzs: l.unitCostTzs })),
            costChanges: lines.filter(l => l.costUpdated).map(l => ({ productId: l.productId, variant: l.variant || null, fromTzs: l.previousCostTzs, toTzs: l.unitCostTzs })),
          },
        });
        const found = await loadPurchase(trx, { id: purchaseId, vendorId });
        return { purchase: purchaseView(found, { canSeeCost, today }), costChanges: costChangesOf(found.lines, canSeeCost), replayed: false, productIds };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      // The same clientRef arrived twice at once and the other one won: answer as its replay.
      if (err.code === UNIQUE_VIOLATION && /client_?ref/i.test(`${err.constraint || ''} ${err.message}`)) {
        const replay = await receiveReplay(db, vendorId, parsed.clientRef, fingerprint, { canSeeCost, today });
        if (replay) return replay;
      }
      throw err;
    }
  }

  // ── void a purchase ─────────────────────────────────────────────────────────

  /**
   * P-6 on void: the cost to put back. A previous source that is itself a voided purchase is walked back to what
   * that purchase replaced (its own cost no longer stands). → { costTzs, sourceId }
   */
  async function restoredCost(trx, vendorId, line) {
    let costTzs = line.previousCostTzs ?? null;
    let sourceId = line.previousCostSourceId ?? null;
    for (let hops = 0; sourceId && hops < 50; hops += 1) {
      const earlier = await trx('VendorPurchase as p').join('VendorPurchaseLine as l', 'l.purchaseId', 'p.id')
        .where({ 'p.id': sourceId, 'p.vendorId': vendorId, 'l.productId': line.productId, 'l.variant': line.variant || '' })
        .first('p.status', 'l.costUpdated', 'l.previousCostTzs', 'l.previousCostSourceId');
      if (!earlier || earlier.status !== 'voided' || !earlier.costUpdated) break;
      costTzs = earlier.previousCostTzs ?? null;
      sourceId = earlier.previousCostSourceId ?? null;
    }
    return { costTzs, sourceId };
  }

  /**
   * M-1: the latest LATER (higher GRN seq) received purchase of this vendor with a line for the same product +
   * variant at exactly `costTzs` (free lines never count). → { purchaseId, lineId, costUpdated } or null.
   */
  async function laterLiveSameCost(trx, vendorId, seq, line, costTzs) {
    if (costTzs == null) return null;
    const found = await trx('VendorPurchaseLine as l').join('VendorPurchase as p', function joinP() { this.on('p.id', 'l.purchaseId').andOn('p.vendorId', 'l.vendorId'); })
      .where({ 'l.vendorId': vendorId, 'l.productId': line.productId, 'l.variant': line.variant || '', 'p.status': 'received', 'l.unitCostTzs': Number(costTzs) })
      .where('p.seq', '>', seq).where('l.unitCostTzs', '>', 0)
      .orderBy('p.seq', 'desc').first('p.id as purchaseId', 'l.id as lineId', 'l.costUpdated');
    return found ? { purchaseId: found.purchaseId, lineId: found.lineId, costUpdated: Boolean(found.costUpdated) } : null;
  }

  /**
   * Void a received purchase. `canVoid(row)` → null or a refusal (M2, judged on the locked row).
   * → { purchase, costRestored, costKept, paymentsVoided, productIds, row } or { error, status, ... }.
   */
  async function voidPurchase({ vendorId, purchaseId, actorId, reason, canVoid = () => null, othersPaymentsBlock = false, canSeeCost = false, today }) {
    if (typeof purchaseId !== 'string' || !purchaseId) return fail('purchase_not_found', 404);
    const at = now();
    try {
      return await db.transaction(async (trx) => {
        const peek = await trx('VendorPurchase').where({ id: purchaseId, vendorId }).first('supplierId');
        if (!peek) throw refusal('purchase_not_found', 404);
        if (peek.supplierId) await trx('VendorSupplier').where({ id: peek.supplierId, vendorId }).forShare().first('id');
        const row = plain(await trx('VendorPurchase').where({ id: purchaseId, vendorId }).forUpdate().first());
        if (!row) throw refusal('purchase_not_found', 404);
        const refused = canVoid(row);
        if (refused) throw asRefusal(refused);
        if (row.status === 'voided') throw refusal('already_voided', 409, { voidedAt: iso(row.voidedAt) });
        // L-2: a void takes its payments with it, so a caller without voidsAny may not void payments recorded by others.
        if (othersPaymentsBlock) {
          const others = await trx('VendorPurchasePayment').where({ purchaseId, vendorId, status: 'recorded' }).whereNot('recordedBy', actorId).first('id');
          if (others) throw refusal('void_not_allowed', 409, { reason: 'has_others_payments' });
        }

        const lines = (await trx('VendorPurchaseLine').where({ purchaseId, vendorId }).orderBy('lineNo')).map(plain);
        const productIds = [...new Set(lines.map(l => l.productId))].sort();
        const products = new Map();
        for (const id of productIds) products.set(id, plain(await trx('Product').where({ id, vendorId }).forUpdate().first()) || null);

        // Units leave only if they are still there: conditional stock >= q (and the variant's own). Every short
        // line is collected first, so the refusal lists them all; then the transaction rolls back whole.
        const short = [];
        const moved = [];
        for (const l of [...lines].sort(byKey)) {
          const product = products.get(l.productId);
          if (!product) { short.push({ productId: l.productId, variant: l.variant || null, name: l.nameSnapshot, receivedQty: l.qty, available: 0 }); continue; }
          const fromVariant = l.variantTracked && variantsOf(product).some(v => v.name === l.variant && isTracked(v));
          let query = trx('Product').where({ id: l.productId, vendorId }).where('stock', '>=', l.qty);
          const update = { stock: trx.raw('stock - ?', [l.qty]), updatedAt: at };
          if (fromVariant) {
            query = query.whereRaw(VARIANT_HAS_STOCK, [l.variant, l.qty]);
            update.variants = trx.raw(variantStockAdjusted('-'), [l.variant, l.qty]);
          }
          const rows = await query.update(update).returning(['stock', 'variants']);
          if (!rows.length) {
            const own = fromVariant ? variantStockOf(product.variants, l.variant) ?? 0 : Number(product.stock || 0);
            short.push({ productId: l.productId, variant: l.variant || null, name: l.nameSnapshot, receivedQty: l.qty, available: Math.max(0, Math.min(own, Number(product.stock || 0))) });
            continue;
          }
          moved.push({ line: l, stockAfter: fromVariant ? variantStockOf(rows[0].variants, l.variant) ?? rows[0].stock : rows[0].stock, fromVariant });
        }
        if (short.length) throw refusal('insufficient_stock', 409, { lines: short });
        await trx('ShopStockMovement').insert(moved.map(m => ({
          id: `stk_${randomUUID().slice(0, 12)}`, orderId: null, productId: m.line.productId, variant: m.line.variant || '', cycle: 1,
          delta: -m.line.qty, reason: 'stock_in_void', kind: 'stock_in_void', stockAfter: m.stockAfter, vendorId,
          note: m.line.variantTracked && !m.fromVariant ? 'variant_gone' : row.number, actorId, clientRef: null, sourceId: purchaseId, createdAt: at,
        })));

        // Cost prices (P-6): put back only where this purchase is still the source.
        const updated = lines.filter(l => l.costUpdated);
        const costRestored = [];
        const costKept = [];
        if (updated.length) {
          const privs = (await trx('ProductPrivate').whereIn(['productId', 'variant'], updated.map(l => [l.productId, l.variant || '']))
            .orderBy([{ column: 'productId' }, { column: 'variant' }]).forUpdate()).map(plain);
          for (const l of [...updated].sort(byKey)) {
            const priv = privs.find(r => r.productId === l.productId && r.variant === (l.variant || ''));
            const item = { productId: l.productId, variant: l.variant || null, name: l.nameSnapshot };
            // M-1 (security review #327): a LATER delivery still received that set (or confirmed) this same cost keeps
            // it standing — its line inherits what this one replaced, so voiding it later puts back the right cost.
            const live = priv && priv.costSourceId === purchaseId ? await laterLiveSameCost(trx, vendorId, row.seq, l, priv.costTzs) : null;
            if (live) {
              await trx('ProductPrivate').where({ productId: l.productId, variant: l.variant || '' })
                .update({ costSourceId: live.purchaseId, costUpdatedAt: at, updatedAt: at });
              if (!live.costUpdated) {
                await trx('VendorPurchaseLine').where({ id: live.lineId, vendorId })
                  .update({ costUpdated: true, previousCostTzs: l.previousCostTzs ?? null, previousCostSourceId: l.previousCostSourceId ?? null });
              }
              await trx('VendorPurchaseLine').where({ id: l.id }).update({ costRestoredOnVoid: false });
              costKept.push(item);
            } else if (priv && priv.costSourceId === purchaseId) {
              const back = await restoredCost(trx, vendorId, l);
              await trx('ProductPrivate').where({ productId: l.productId, variant: l.variant || '' })
                .update({ costTzs: back.costTzs, costSourceId: back.sourceId, costUpdatedAt: at, updatedAt: at });
              await trx('VendorPurchaseLine').where({ id: l.id }).update({ costRestoredOnVoid: true });
              costRestored.push(item);
            } else {
              await trx('VendorPurchaseLine').where({ id: l.id }).update({ costRestoredOnVoid: false });
              costKept.push(item);
            }
          }
        }

        // Its payments go with it (they belong only to this purchase; nothing is reallocated).
        const voidedPayments = await trx('VendorPurchasePayment').where({ purchaseId, vendorId, status: 'recorded' })
          .update({ status: 'voided', voidedBy: actorId, voidedAt: at, voidReason: reason, voidedWithPurchase: true }).returning('id');
        await trx('VendorPurchase').where({ id: purchaseId, vendorId, status: 'received' })
          .update({ status: 'voided', voidedBy: actorId, voidedAt: at, voidReason: reason, updatedAt: at });
        await audit(trx, {
          actor: actorId, action: 'vendor_purchase_voided', target: purchaseId,
          before: { status: 'received', number: row.number, totalTzs: row.totalTzs, paidTzs: row.paidTzs },
          after: { vendorId, reason, costRestored, costKept, paymentsVoided: voidedPayments.length },
        });
        const found = await loadPurchase(trx, { id: purchaseId, vendorId });
        return { purchase: purchaseView(found, { canSeeCost, today }), costRestored, costKept, paymentsVoided: voidedPayments.length, productIds, row };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      // The ledger's unique (sourceId, productId, variant, 'stock_in_void') is the backstop against a double void.
      if (err.code === UNIQUE_VIOLATION && /source_unique/.test(`${err.constraint || ''} ${err.message}`)) return fail('already_voided', 409);
      throw err;
    }
  }

  // ── payments ────────────────────────────────────────────────────────────────

  /** What `paymentId` covered (P-5), as positions in the current plan: [{ seq, dueDate, amountTzs }]. */
  async function coverageOfPayment(q, found, paymentId) {
    const recorded = found.payments.filter(x => x.status === 'recorded');
    const idx = recorded.findIndex(x => x.id === paymentId);
    if (idx < 0) return [];
    const before = recorded.slice(0, idx).reduce((s, x) => s + x.amountTzs, 0);
    return coveredBy(found.instalments, before, recorded[idx].amountTzs)
      .map(c => ({ seq: c.index + 1, dueDate: found.instalments[c.index].dueDate, amountTzs: c.amountTzs }));
  }
  const paymentViewOf = (view, paymentId) => view.payments.find(x => x.id === paymentId) || null;

  async function paymentReplay(q, { vendorId, purchaseId, clientRef, fingerprint, canSeeCost, today }) {
    const row = await q('VendorPurchasePayment').where({ vendorId, clientRef }).first('id', 'purchaseId', 'fingerprint');
    if (!row) return null;
    if (row.fingerprint !== fingerprint || row.purchaseId !== purchaseId) return fail('client_ref_reused', 409);
    const found = await loadPurchase(q, { id: row.purchaseId, vendorId });
    const purchase = purchaseView(found, { canSeeCost, today });
    return { purchase, payment: paymentViewOf(purchase, row.id), covered: await coverageOfPayment(q, found, row.id), replayed: true };
  }

  /** P-9. `parsed` from parsePurchasePayment. → { purchase, payment, covered, replayed } or { error, status, ... }. */
  async function recordPayment({ vendorId, purchaseId, actorId, parsed, fingerprint, canSeeCost = false, today }) {
    if (typeof purchaseId !== 'string' || !purchaseId) return fail('purchase_not_found', 404);
    const earlier = await paymentReplay(db, { vendorId, purchaseId, clientRef: parsed.clientRef, fingerprint, canSeeCost, today });
    if (earlier) return earlier;
    const at = now();
    const paymentId = newId('vpp');
    try {
      return await db.transaction(async (trx) => {
        const peek = await trx('VendorPurchase').where({ id: purchaseId, vendorId }).first('supplierId');
        if (!peek) throw refusal('purchase_not_found', 404);
        if (peek.supplierId) await trx('VendorSupplier').where({ id: peek.supplierId, vendorId }).forShare().first('id');
        const row = plain(await trx('VendorPurchase').where({ id: purchaseId, vendorId }).forUpdate().first());
        const raced = await paymentReplay(trx, { vendorId, purchaseId, clientRef: parsed.clientRef, fingerprint, canSeeCost, today });
        if (raced) return raced;
        if (row.status === 'voided') throw refusal('purchase_voided', 409, { voidedAt: iso(row.voidedAt) });
        const earliest = dayOf(row.receivedOn);
        if (!parsed.paidOn || parsed.paidOn < earliest || parsed.paidOn > today) throw refusal('paid_on_out_of_range', 400, { earliest, latest: today });
        if (row.balanceTzs === 0) throw refusal('nothing_owed', 409);
        if (parsed.amountTzs > row.balanceTzs) throw refusal('overpayment', 409, { balanceTzs: row.balanceTzs });
        await trx('VendorPurchasePayment').insert({
          id: paymentId, vendorId, purchaseId, supplierId: row.supplierId ?? null, amountTzs: parsed.amountTzs, paidOn: parsed.paidOn,
          method: parsed.method, reference: parsed.reference, note: parsed.note, atReceipt: false, status: 'recorded',
          clientRef: parsed.clientRef, fingerprint, recordedBy: actorId, createdAt: at,
        });
        await trx('VendorPurchase').where({ id: purchaseId, vendorId, status: 'received' }).update({
          paidTzs: trx.raw('"paidTzs" + ?', [parsed.amountTzs]), balanceTzs: trx.raw('"balanceTzs" - ?', [parsed.amountTzs]), updatedAt: at,
        });
        await audit(trx, {
          actor: actorId, action: 'vendor_purchase_payment_recorded', target: paymentId,
          before: { purchaseId, number: row.number, balanceTzs: row.balanceTzs },
          after: { vendorId, purchaseId, amountTzs: parsed.amountTzs, method: parsed.method, reference: parsed.reference, paidOn: parsed.paidOn },
        });
        const found = await loadPurchase(trx, { id: purchaseId, vendorId });
        const purchase = purchaseView(found, { canSeeCost, today });
        return { purchase, payment: paymentViewOf(purchase, paymentId), covered: await coverageOfPayment(trx, found, paymentId), replayed: false };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      if (err.code === UNIQUE_VIOLATION && /client_?ref/i.test(`${err.constraint || ''} ${err.message}`)) {
        const replay = await paymentReplay(db, { vendorId, purchaseId, clientRef: parsed.clientRef, fingerprint, canSeeCost, today });
        if (replay) return replay;
      }
      throw err;
    }
  }

  /** P-10. `canVoid(paymentRow)` → null or a refusal (M2 on recordedBy / createdAt). → { purchase, payment, row, number } or an error. */
  async function voidPayment({ vendorId, purchaseId, paymentId, actorId, reason, canVoid = () => null, canSeeCost = false, today }) {
    if (typeof purchaseId !== 'string' || !purchaseId || typeof paymentId !== 'string' || !paymentId) return fail('payment_not_found', 404);
    const at = now();
    try {
      return await db.transaction(async (trx) => {
        const peek = await trx('VendorPurchase').where({ id: purchaseId, vendorId }).first('supplierId');
        if (!peek) throw refusal('payment_not_found', 404);
        const supplier = peek.supplierId ? plain(await trx('VendorSupplier').where({ id: peek.supplierId, vendorId }).forShare().first('id', 'archivedAt')) : null;
        const purchase = plain(await trx('VendorPurchase').where({ id: purchaseId, vendorId }).forUpdate().first());
        const pay = plain(await trx('VendorPurchasePayment').where({ id: paymentId, purchaseId, vendorId }).forUpdate().first());
        if (!pay) throw refusal('payment_not_found', 404);
        const refused = canVoid(pay);
        if (refused) throw asRefusal(refused);
        if (pay.status === 'voided') throw refusal('already_voided', 409, { voidedAt: iso(pay.voidedAt) });
        if (purchase.status === 'voided') throw refusal('purchase_voided', 409, { voidedAt: iso(purchase.voidedAt) });
        // A purchase without a supplier can never go into debt (void the whole purchase instead).
        if (!purchase.supplierId) throw refusal('supplier_required', 409);
        // P-12: an archived supplier is owed nothing; restore them first.
        if (supplier?.archivedAt) throw refusal('supplier_archived', 409, { supplierId: supplier.id });
        await trx('VendorPurchasePayment').where({ id: paymentId, vendorId, status: 'recorded' })
          .update({ status: 'voided', voidedBy: actorId, voidedAt: at, voidReason: reason });
        await trx('VendorPurchase').where({ id: purchaseId, vendorId, status: 'received' }).update({
          paidTzs: trx.raw('"paidTzs" - ?', [pay.amountTzs]), balanceTzs: trx.raw('"balanceTzs" + ?', [pay.amountTzs]), updatedAt: at,
        });
        await audit(trx, {
          actor: actorId, action: 'vendor_purchase_payment_voided', target: paymentId,
          before: { status: 'recorded', purchaseId, number: purchase.number, amountTzs: pay.amountTzs, method: pay.method, reference: pay.reference, paidOn: dayOf(pay.paidOn) },
          after: { status: 'voided', vendorId, reason },
        });
        const found = await loadPurchase(trx, { id: purchaseId, vendorId });
        const view = purchaseView(found, { canSeeCost, today });
        return { purchase: view, payment: paymentViewOf(view, paymentId), row: pay, number: purchase.number };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      throw err;
    }
  }

  /**
   * P-11: replace the unpaid part of the plan. `schedule` shape-checked by the caller; ranges and the sum are
   * checked here against the locked purchase. → { purchase } or an error.
   */
  async function changePlan({ vendorId, purchaseId, actorId, schedule, canSeeCost = false, today }) {
    if (typeof purchaseId !== 'string' || !purchaseId) return fail('purchase_not_found', 404);
    const at = now();
    try {
      return await db.transaction(async (trx) => {
        const peek = await trx('VendorPurchase').where({ id: purchaseId, vendorId }).first('supplierId');
        if (!peek) throw refusal('purchase_not_found', 404);
        if (peek.supplierId) await trx('VendorSupplier').where({ id: peek.supplierId, vendorId }).forShare().first('id');
        const row = plain(await trx('VendorPurchase').where({ id: purchaseId, vendorId }).forUpdate().first());
        if (row.status === 'voided') throw refusal('purchase_voided', 409, { voidedAt: iso(row.voidedAt) });
        if (row.balanceTzs === 0) throw refusal('nothing_owed', 409);
        const parsed = parseSchedule(schedule, { earliest: today, latest: addDays(dayOf(row.receivedOn), DUE_MAX_DAYS) });
        if (parsed.error) throw asRefusal(parsed);
        const scheduledTzs = parsed.schedule.reduce((s, r) => s + r.amountTzs, 0);
        if (scheduledTzs !== row.balanceTzs) throw refusal('schedule_mismatch', 400, { expectedTzs: row.balanceTzs, scheduledTzs });

        const all = (await trx('VendorPurchaseInstalment').where({ purchaseId, vendorId }).orderBy('seq').forUpdate()).map(plain)
          .map(i => ({ ...i, dueDate: dayOf(i.dueDate) }));
        const active = all.filter(i => i.status === 'active');
        const covered = coverInstalments(active, row.paidTzs, today);
        const change = planChange(covered);
        let seq = all.reduce((m, i) => Math.max(m, i.seq), 0);
        if (change.replace.length) {
          await trx('VendorPurchaseInstalment').whereIn('id', change.replace.map(i => i.id)).where({ vendorId, status: 'active' })
            .update({ status: 'replaced', replacedAt: at, replacedBy: actorId });
        }
        const inserts = [];
        // The covered part of a partly paid instalment stays, with its due date, right after the paid rows.
        if (change.splitFrom) inserts.push({ dueDate: change.splitFrom.dueDate, amountTzs: change.splitCoveredTzs });
        inserts.push(...parsed.schedule);
        await trx('VendorPurchaseInstalment').insert(inserts.map(r => ({
          id: newId('vpi'), purchaseId, vendorId, seq: (seq += 1), dueDate: r.dueDate, amountTzs: r.amountTzs, status: 'active', createdBy: actorId, createdAt: at,
        })));
        const sum = (await trx('VendorPurchaseInstalment').where({ purchaseId, vendorId, status: 'active' }).sum({ s: 'amountTzs' }).first())?.s;
        if (num(sum) !== row.totalTzs) throw new Error(`vendor purchase plan: active instalments ${sum} ≠ total ${row.totalTzs}`);
        await audit(trx, {
          actor: actorId, action: 'vendor_purchase_plan_changed', target: purchaseId,
          before: { instalments: active.map(i => ({ dueDate: i.dueDate, amountTzs: i.amountTzs })) },
          after: { vendorId, instalments: [...change.keep.map(i => ({ dueDate: i.dueDate, amountTzs: i.amountTzs })), ...inserts] },
        });
        const found = await loadPurchase(trx, { id: purchaseId, vendorId });
        return { purchase: purchaseView(found, { canSeeCost, today }) };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      throw err;
    }
  }

  // ── lists ───────────────────────────────────────────────────────────────────

  const encodeCursor = r => Buffer.from(JSON.stringify([r.receivedOn, r.seq])).toString('base64url');
  function decodeCursor(cursor) {
    try {
      const [d, s] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
      return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isInteger(s) ? { d, s } : null;
    } catch { return null; }
  }

  /**
   * GET /vendor/purchases. from/to: EAT days on receivedOn (inclusive). Newest first (receivedOn desc, number desc).
   * summary covers the whole filter (received purchases only; not the page, not the status filter).
   */
  async function listPurchases({ vendorId, today, from = null, to = null, supplierId = null, status = null, payment = null, createdBy = null, limit = 50, cursor = null }) {
    let after = null;
    if (cursor) {
      after = decodeCursor(cursor);
      if (!after) return fail('invalid_cursor', 400);
    }
    const scope = (q) => {
      q.where('p.vendorId', vendorId);
      if (from) q.where('p.receivedOn', '>=', from);
      if (to) q.where('p.receivedOn', '<=', to);
      if (supplierId) q.where('p.supplierId', supplierId);
      if (createdBy) q.where('p.createdBy', createdBy);
      if (payment === 'open') q.where('p.status', 'received').where('p.balanceTzs', '>', 0);
      if (payment === 'paid') q.where('p.status', 'received').where('p.balanceTzs', 0);
      if (payment === 'overdue') q.where('p.status', 'received').whereRaw('ov."overdueTzs" > 0');
      return q;
    };
    const base = () => db('VendorPurchase as p').joinRaw(PURCHASE_OPEN_LATERAL, [today]);
    let q = scope(base());
    if (status) q = q.where('p.status', status);
    if (after) q = q.whereRaw('(p."receivedOn", p.seq) < (?::date, ?)', [after.d, after.s]);
    const rows = (await q.orderBy([{ column: 'p.receivedOn', order: 'desc' }, { column: 'p.seq', order: 'desc' }]).limit(limit + 1)
      .select('p.id', 'p.number', 'p.seq', 'p.status', db.raw('p."receivedOn"::text AS "receivedOn"'), 'p.createdAt', 'p.supplierId', 'p.totalTzs', 'p.paidTzs',
        'p.balanceTzs', 'p.createdBy', 'ov.overdueTzs', 'ov.nextDueDate',
        db.raw(`(SELECT count(*)::int FROM "VendorPurchaseLine" l WHERE l."purchaseId" = p.id) AS "lineCount"`),
        db.raw(`(SELECT COALESCE(sum(l.qty), 0)::int FROM "VendorPurchaseLine" l WHERE l."purchaseId" = p.id) AS units`))).map(plain);
    const page = rows.slice(0, limit);
    const summary = plain(await scope(base()).where('p.status', 'received').first(
      db.raw('count(*)::int AS count'), db.raw('COALESCE(sum(p."totalTzs"), 0)::bigint AS "totalTzs"'), db.raw('COALESCE(sum(p."paidTzs"), 0)::bigint AS "paidTzs"'),
      db.raw('COALESCE(sum(p."balanceTzs"), 0)::bigint AS "balanceTzs"'),
      db.raw(`COALESCE(sum((SELECT COALESCE(sum(l.qty), 0) FROM "VendorPurchaseLine" l WHERE l."purchaseId" = p.id)), 0)::bigint AS units`),
    ));
    const [names, suppliers] = await Promise.all([
      namesOf(db, page.map(r => r.createdBy)),
      db('VendorSupplier').where({ vendorId }).whereIn('id', [...new Set(page.map(r => r.supplierId).filter(Boolean))]).select('id', 'name'),
    ]);
    const supplierName = new Map(suppliers.map(s => [s.id, s.name]));
    return {
      purchases: page.map(r => ({
        id: r.id, number: r.number, status: r.status, receivedOn: r.receivedOn, recordedAt: iso(r.createdAt),
        supplier: r.supplierId ? { id: r.supplierId, name: supplierName.get(r.supplierId) ?? null } : null,
        totalTzs: r.totalTzs, paidTzs: r.paidTzs, balanceTzs: r.balanceTzs, overdueTzs: r.status === 'voided' ? 0 : num(r.overdueTzs),
        paymentState: paymentStateOf(r), nextDueDate: r.status === 'voided' ? null : r.nextDueDate ?? null,
        lineCount: num(r.lineCount), units: num(r.units), createdBy: person(r.createdBy, names.get(r.createdBy)),
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
      summary: { count: num(summary?.count), totalTzs: num(summary?.totalTzs), paidTzs: num(summary?.paidTzs), balanceTzs: num(summary?.balanceTzs), units: num(summary?.units) },
    };
  }

  /** GET /vendor/purchases/last-costs: the latest non-voided, non-free line per product + variant. */
  async function lastCosts({ vendorId, productIds }) {
    if (!productIds.length) return { rows: [] };
    const { rows } = await db.raw(`
      SELECT DISTINCT ON (l."productId", l.variant) l."productId", l.variant, l."unitCostTzs", p."receivedOn"::text AS "receivedOn", p.number, s.name AS "supplierName"
        FROM "VendorPurchaseLine" l
        JOIN "VendorPurchase" p ON p.id = l."purchaseId" AND p."vendorId" = l."vendorId"
        LEFT JOIN "VendorSupplier" s ON s.id = p."supplierId" AND s."vendorId" = p."vendorId"
       WHERE l."vendorId" = ? AND p.status = 'received' AND l."unitCostTzs" > 0 AND l."productId" = ANY(?)
       ORDER BY l."productId", l.variant, p."receivedOn" DESC, p.seq DESC`, [vendorId, productIds]);
    return {
      rows: rows.map(plain).map(r => ({
        productId: r.productId, variant: r.variant || null, unitCostTzs: r.unitCostTzs, receivedOn: r.receivedOn, supplierName: r.supplierName ?? null, number: r.number,
      })),
    };
  }

  /**
   * GET /vendor/payables/aging: one row per supplier owed money, totals over all of them (not the bucket filter
   * or the page). Server-computed in SQL.
   */
  async function aging({ vendorId, today, bucket = null, sort = 'overdue', limit = 50, offset = 0 }) {
    if (bucket && !AGING_BUCKETS.includes(bucket)) throw new Error(`unknown aging bucket ${bucket}`);
    const order = {
      overdue: 'o."maxDaysOverdue" DESC, o."overdueTzs" DESC, o."owedTzs" DESC, s.id ASC',
      owed: 'o."owedTzs" DESC, s.id ASC',
      name: 'lower(s.name) ASC, s.id ASC',
    }[sort];
    const base = `WITH o AS (${OWED_SQL('')}) SELECT o.*, s.name FROM o JOIN "VendorSupplier" s ON s.id = o."supplierId" AND s."vendorId" = ?`;
    const [{ rows }, totals] = await Promise.all([
      db.raw(`${base} ${bucket ? `WHERE o."${bucket}" > 0` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`, [today, vendorId, vendorId, limit + 1, offset]),
      db.raw(`WITH o AS (${OWED_SQL('')})
        SELECT COALESCE(sum("owedTzs"), 0)::bigint AS "owedTzs", COALESCE(sum("overdueTzs"), 0)::bigint AS "overdueTzs",
               count(*)::int AS "supplierCount", count(*) FILTER (WHERE "overdueTzs" > 0)::int AS "overdueSupplierCount",
               COALESCE(sum("dueIn7DaysTzs"), 0)::bigint AS "dueIn7DaysTzs",
               COALESCE(sum(current), 0)::bigint AS current, COALESCE(sum(d1_30), 0)::bigint AS d1_30, COALESCE(sum(d31_60), 0)::bigint AS d31_60,
               COALESCE(sum(d61_90), 0)::bigint AS d61_90, COALESCE(sum(d90plus), 0)::bigint AS d90plus
          FROM o`, [today, vendorId]),
    ]);
    const t = plain(totals.rows[0]);
    const page = rows.slice(0, limit).map(plain);
    return {
      asOf: today,
      totals: {
        owedTzs: num(t.owedTzs), overdueTzs: num(t.overdueTzs), supplierCount: num(t.supplierCount), overdueSupplierCount: num(t.overdueSupplierCount),
        dueIn7DaysTzs: num(t.dueIn7DaysTzs), ...agingOf(t),
      },
      rows: page.map(r => ({
        supplierId: r.supplierId, name: r.name, owedTzs: num(r.owedTzs), overdueTzs: num(r.overdueTzs), oldestDueDate: r.oldestDueDate ?? null,
        maxDaysOverdue: num(r.maxDaysOverdue), ...agingOf(r),
      })),
      nextCursor: rows.length > limit ? encodeOffset(offset + limit) : null,
    };
  }

  /** S6 Payment methods "Paid to suppliers (by you)": recorded supplier payments by paidOn (voided ones drop out). */
  async function paidToSuppliers({ vendorId, from, to }) {
    const { rows } = await db.raw(`SELECT method, sum("amountTzs")::bigint AS amount, count(*)::int AS count
        FROM "VendorPurchasePayment" WHERE "vendorId" = ? AND status = 'recorded' AND "paidOn" BETWEEN ?::date AND ?::date
       GROUP BY 1`, [vendorId, from, to]);
    return rows.map(plain).map(r => ({ method: r.method, amount: num(r.amount), count: num(r.count) }));
  }

  const replayPurchase = ({ vendorId, clientRef, fingerprint, canSeeCost = false, today }) => receiveReplay(db, vendorId, clientRef, fingerprint, { canSeeCost, today });
  const replayPayment = ({ vendorId, purchaseId, clientRef, fingerprint, canSeeCost = false, today }) => paymentReplay(db, { vendorId, purchaseId, clientRef, fingerprint, canSeeCost, today });

  return {
    createSupplier, updateSupplier, listSuppliers, supplierProfile, replayPurchase, replayPayment,
    receive, voidPurchase, recordPayment, voidPayment, changePlan, getPurchase, listPurchases, lastCosts, aging, paidToSuppliers,
  };
}
