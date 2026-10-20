// Postgres store for vendor customers, customer payments, balances and aging (vendor tools · S4).
//
// Every query is vendor-scoped and parameterised. Child rows reference (customerId, vendorId), so
// the database itself refuses a sale or payment that points at another vendor's customer.
//
// Balances live on the sale (VendorSale.balanceTzs, the current outstanding amount). Recording a
// customer payment is ONE transaction: the customer row is locked FOR UPDATE (payments, voids and
// archiving for one customer queue up), then their open credit sales FOR UPDATE (oldest due first);
// the amount must not exceed what is owed (O-8: 409 overpayment); the PMT number is issued from the
// vendor's row-locked sequence (a rollback gives it back, so numbers stay continuous); the payment,
// its allocations and each sale's paidTzs/balanceTzs/allocatedTzs are written together. Voiding a
// payment reverses its allocations in one transaction (same lock order: customer → payment → sales).
//
// A-02: a marketplace customer holds only buyerUserId + a name snapshot; views never return
// buyerUserId, and a CHECK keeps phone/email/address off marketplace rows.
import { randomUUID } from 'node:crypto';
import { newCustomerId } from './vendor-buyer-ref-store-pg.mjs';
import { dayOf } from './vendor-sale-store-pg.mjs';
import { PAYMENT_DOC_TYPE, paymentNumber, allocateOldestFirst, phoneLast3, AGING_BUCKETS, encodeOffset } from '../shared/vendor-customer.mjs';
import { ownLines, orderTab, shortRef } from '../shared/vendor-order-view.mjs';

const UNIQUE_VIOLATION = '23505';
const PAID_STATES = ['paid', 'refund_pending', 'refunded'];
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const refusal = (error, status, extra = {}) => Object.assign(new Error(error), { refusal: fail(error, status, extra) });
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const iso = v => (v == null ? null : new Date(v).toISOString());
const num = v => Number(v || 0);
const person = (id, name) => (id ? { id, name: name ?? null } : null);
const likeEscape = s => s.replace(/[\\%_]/g, c => `\\${c}`);

/**
 * Open credit sales of one vendor, grouped by customer, as of EAT day `today` (bindings: today, vendorId, …extra).
 * daysOverdue = today − dueDate: ≤ 0 not due yet, 1–30, 31–60, 61–90, ≥ 91.
 */
const OWED_SQL = extra => `
  SELECT s."customerId",
         sum(s."balanceTzs")::bigint AS "owedTzs",
         COALESCE(sum(s."balanceTzs") FILTER (WHERE d.today - s."dueDate" >= 1), 0)::bigint AS "overdueTzs",
         COALESCE(sum(s."balanceTzs") FILTER (WHERE d.today - s."dueDate" <= 0), 0)::bigint AS "current",
         COALESCE(sum(s."balanceTzs") FILTER (WHERE d.today - s."dueDate" BETWEEN 1 AND 30), 0)::bigint AS "d1_30",
         COALESCE(sum(s."balanceTzs") FILTER (WHERE d.today - s."dueDate" BETWEEN 31 AND 60), 0)::bigint AS "d31_60",
         COALESCE(sum(s."balanceTzs") FILTER (WHERE d.today - s."dueDate" BETWEEN 61 AND 90), 0)::bigint AS "d61_90",
         COALESCE(sum(s."balanceTzs") FILTER (WHERE d.today - s."dueDate" >= 91), 0)::bigint AS "d90plus",
         min(s."dueDate")::text AS "oldestDueDate",
         GREATEST(max(d.today - s."dueDate"), 0)::int AS "maxDaysOverdue",
         count(*)::int AS "openCount",
         count(*) FILTER (WHERE d.today - s."dueDate" >= 1)::int AS "overdueCount"
    FROM "VendorSale" s CROSS JOIN (SELECT ?::date AS today) d
   WHERE s."vendorId" = ? AND s.kind = 'credit' AND s.status = 'completed' AND s."balanceTzs" > 0 ${extra}
   GROUP BY s."customerId"`;

const agingOf = r => Object.fromEntries(AGING_BUCKETS.map(b => [b, num(r?.[b])]));
const moneyOf = r => ({
  owedTzs: num(r?.owedTzs), overdueTzs: num(r?.overdueTzs), oldestDueDate: r?.oldestDueDate ?? null,
  maxDaysOverdue: num(r?.maxDaysOverdue), aging: agingOf(r),
});

/** The customer as the vendor sees it (`customers` permission). Never buyerUserId; contact only on manual customers. */
export function customerView(row) {
  const c = plain(row);
  const manual = c.source === 'manual';
  return {
    id: c.id, source: c.source, name: c.name ?? null,
    phone: manual ? c.phone ?? null : null, email: manual ? c.email ?? null : null, address: manual ? c.address ?? null : null,
    note: c.note ?? null, archived: c.archivedAt != null, archivedAt: iso(c.archivedAt),
    // The app buyer deleted their FitFlex account: name is null; clients show "Deleted member".
    forgotten: c.forgottenAt != null,
    createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt),
  };
}
/** The POS picker row for staff with `sales` only: no money, no full phone. */
export const pickerView = c => ({ id: c.id, source: c.source, name: c.name ?? null, phoneLast3: c.source === 'manual' ? phoneLast3(c.phone) : null, forgotten: c.forgottenAt != null });

export function createPgVendorCustomerStore({ db, now = () => new Date() }) {
  async function namesOf(q, ids) {
    const wanted = [...new Set(ids.filter(Boolean))];
    if (!wanted.length) return new Map();
    const rows = await q('User').whereIn('id', wanted).select('id', 'displayName');
    return new Map(rows.map(r => [r.id, r.displayName ?? null]));
  }
  const audit = (q, { actor, action, target, before = null, after = null }) => q('AuditLog').insert({
    id: randomUUID(), at: now(), actor, action, target, before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });

  // ── customers ─────────────────────────────────────────────────────────────

  const find = (q, vendorId, customerId) => (typeof customerId === 'string' && customerId
    ? q('VendorCustomer').where({ id: customerId, vendorId }).first()
    : Promise.resolve(null));

  /** Another customer of this vendor with the same phone (Q-7: a warning, never a block). */
  async function phoneDuplicate(q, vendorId, phone, exceptId) {
    if (!phone) return null;
    const dup = await q('VendorCustomer').where({ vendorId, phone }).whereNot('id', exceptId)
      .orderByRaw('"archivedAt" IS NOT NULL, "createdAt"').first('id', 'name');
    return dup ? { id: dup.id, name: dup.name ?? null } : null;
  }

  /** What one customer owes, as of `today`. */
  async function owedOf(q, vendorId, customerId, today) {
    const { rows } = await q.raw(OWED_SQL('AND s."customerId" = ?'), [today, vendorId, customerId]);
    return moneyOf(rows[0]);
  }

  async function get(vendorId, customerId) {
    const row = await find(db, vendorId, customerId);
    return row ? plain(row) : null;
  }

  /** An earlier POST /vendor/customers with this clientRef: same body → it; another body → 409. */
  async function createReplay(vendorId, clientRef, fingerprint) {
    if (!clientRef) return null;
    const row = await db('VendorCustomer').where({ vendorId, clientRef }).first();
    if (!row) return null;
    if (row.clientFingerprint !== fingerprint) return fail('client_ref_reused', 409);
    return { customer: plain(row), phoneDuplicate: await phoneDuplicate(db, vendorId, row.phone, row.id), replayed: true };
  }

  /**
   * POST /vendor/customers: a manual (walk-in) customer. `clientRef` (optional) makes a retry return the
   * customer it already created. → { customer, phoneDuplicate, replayed } | 409 client_ref_reused
   */
  async function create({ vendorId, actorId, fields, clientRef = null, fingerprint = null }) {
    const earlier = await createReplay(vendorId, clientRef, fingerprint);
    if (earlier) return earlier;
    const at = now();
    const id = newCustomerId();
    try {
      await db('VendorCustomer').insert({
        id, vendorId, source: 'manual', buyerUserId: null, name: fields.name, phone: fields.phone ?? null, email: fields.email ?? null,
        address: fields.address ?? null, note: fields.note ?? null, clientRef, clientFingerprint: clientRef ? fingerprint : null,
        createdBy: actorId, createdAt: at, updatedAt: at,
      });
    } catch (err) {
      // The same clientRef twice at once: the other request created it.
      if (clientRef && err.code === UNIQUE_VIOLATION && /client_ref/.test(`${err.constraint || ''} ${err.message}`)) {
        const replay = await createReplay(vendorId, clientRef, fingerprint);
        if (replay) return replay;
      }
      throw err;
    }
    // Audit without personal data: which fields were given, not their values.
    await audit(db, { actor: actorId, action: 'vendor_customer_created', target: id, after: { vendorId, fields: Object.keys(fields).filter(k => fields[k] != null) } });
    const row = await find(db, vendorId, id);
    return { customer: plain(row), phoneDuplicate: await phoneDuplicate(db, vendorId, row.phone, id), replayed: false };
  }

  /**
   * PUT /vendor/customers/:id. `fields` already checked against the customer's source; `archived`
   * true archives (refused while anything is owed), false restores. `expectUpdatedAt` (optional) →
   * 409 customer_changed when someone else saved first. → { customer, phoneDuplicate } | refusal.
   */
  async function update({ vendorId, customerId, actorId, fields, archived, expectUpdatedAt, today }) {
    try {
      return await db.transaction(async (trx) => {
        const row = plain(await trx('VendorCustomer').where({ id: customerId, vendorId }).forUpdate().first());
        if (!row) throw refusal('customer_not_found', 404);
        if (expectUpdatedAt && iso(row.updatedAt) !== expectUpdatedAt) throw refusal('customer_changed', 409, { updatedAt: iso(row.updatedAt) });
        const at = now();
        const patch = {};
        for (const [k, v] of Object.entries(fields)) if ((row[k] ?? null) !== v) patch[k] = v;
        let archiveAction = null;
        if (archived === true && !row.archivedAt) {
          const owed = await owedOf(trx, vendorId, customerId, today);
          if (owed.owedTzs > 0) throw refusal('customer_has_balance', 409, { owedTzs: owed.owedTzs });
          Object.assign(patch, { archivedAt: at, archivedBy: actorId });
          archiveAction = 'vendor_customer_archived';
        } else if (archived === false && row.archivedAt) {
          Object.assign(patch, { archivedAt: null, archivedBy: null });
          archiveAction = 'vendor_customer_restored';
        }
        if (Object.keys(patch).length) {
          await trx('VendorCustomer').where({ id: customerId, vendorId }).update({ ...patch, updatedAt: at });
          const changed = Object.keys(patch).filter(k => !['archivedAt', 'archivedBy'].includes(k));
          if (changed.length) await audit(trx, { actor: actorId, action: 'vendor_customer_updated', target: customerId, after: { vendorId, fields: changed } });
          if (archiveAction) await audit(trx, { actor: actorId, action: archiveAction, target: customerId, after: { vendorId } });
        }
        const saved = plain(await find(trx, vendorId, customerId));
        return { customer: saved, phoneDuplicate: await phoneDuplicate(trx, vendorId, saved.phone, customerId) };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      throw err;
    }
  }

  /**
   * GET /vendor/customers. filter all (not archived) | owes | overdue | manual | marketplace | archived;
   * bucket (customers with money in it); sort name | owed | overdue | recent; q = name, or phone digits
   * (≥ 3). → { rows: [row + money + lastPurchaseAt], nextCursor }
   */
  async function list({ vendorId, today, q = null, filter = 'all', bucket = null, sort = 'name', limit = 50, offset = 0, phoneSearch = 'substring' }) {
    if (bucket && !AGING_BUCKETS.includes(bucket)) throw new Error(`unknown aging bucket ${bucket}`);
    const where = [];
    const binds = [];
    if (filter === 'archived') where.push('c."archivedAt" IS NOT NULL');
    else where.push('c."archivedAt" IS NULL');
    if (filter === 'owes') where.push('COALESCE(o."owedTzs", 0) > 0');
    if (filter === 'overdue') where.push('COALESCE(o."overdueTzs", 0) > 0');
    if (filter === 'manual' || filter === 'marketplace') { where.push('c.source = ?'); binds.push(filter); }
    if (bucket) where.push(`COALESCE(o."${bucket}", 0) > 0`); // bucket is one of AGING_BUCKETS (checked by the service)
    if (q) {
      const parts = ['c.name ILIKE ? ESCAPE \'\\\'' ];
      binds.push(`%${likeEscape(q)}%`);
      let digits = q.replace(/\D/g, '');
      if (digits.startsWith('255') && digits.length > 3) digits = digits.slice(3);
      else if (digits.startsWith('0')) digits = digits.slice(1);
      const phoneLike = /^[\d\s+\-()]+$/.test(q);
      if (phoneSearch === 'prefix7') {
        // POS picker for staff without `customers` (security review #224 L7): the start of the number,
        // at least 7 digits — never a short substring that would enumerate customers' numbers.
        if (phoneLike && digits.length >= 7) { parts.push('c.phone LIKE ?'); binds.push(`+255${digits}%`); }
      } else if (phoneLike && digits.length >= 3) { parts.push('c.phone LIKE ?'); binds.push(`%${digits}%`); }
      where.push(`(${parts.join(' OR ')})`);
    }
    const order = {
      name: 'lower(c.name) ASC NULLS LAST, c.id ASC',
      owed: 'COALESCE(o."owedTzs", 0) DESC, lower(c.name) ASC NULLS LAST, c.id ASC',
      overdue: 'CASE WHEN COALESCE(o."overdueTzs", 0) > 0 THEN o."maxDaysOverdue" ELSE -1 END DESC, COALESCE(o."overdueTzs", 0) DESC, COALESCE(o."owedTzs", 0) DESC, c.id ASC',
      recent: '"lastPurchaseAt" DESC NULLS LAST, c.id ASC',
    }[sort];
    const { rows } = await db.raw(`
      WITH o AS (${OWED_SQL('')}),
           ls AS (SELECT "customerId", max("soldAt") AS at FROM "VendorSale"
                   WHERE "vendorId" = ? AND status = 'completed' AND "customerId" IS NOT NULL GROUP BY 1)
      SELECT c.id, c.source, c.name, c.phone, c."archivedAt", c."forgottenAt",
             GREATEST(c."lastPurchaseAt", ls.at) AS "lastPurchaseAt",
             o."owedTzs", o."overdueTzs", o."oldestDueDate", o."maxDaysOverdue", o.current, o.d1_30, o.d31_60, o.d61_90, o.d90plus
        FROM "VendorCustomer" c
        LEFT JOIN o ON o."customerId" = c.id
        LEFT JOIN ls ON ls."customerId" = c.id
       WHERE c."vendorId" = ? AND ${where.join(' AND ')}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`, [today, vendorId, vendorId, vendorId, ...binds, limit + 1, offset]);
    const page = rows.slice(0, limit).map(plain);
    return {
      rows: page.map(r => ({ ...r, lastPurchaseAt: iso(r.lastPurchaseAt), ...moneyOf(r) })),
      nextCursor: rows.length > limit ? encodeOffset(offset + limit) : null,
    };
  }

  /** The app orders of a marketplace customer with this vendor (paid ones: paid, refund pending, refunded), newest first. */
  async function paidOrdersOf(vendorId, buyerUserId, { limit = null, after = null } = {}) {
    const query = db('ShopOrder').where({ buyerId: buyerUserId }).whereIn('paymentStatus', PAID_STATES)
      .whereRaw('"items" @> ?::jsonb', [JSON.stringify([{ vendorId: String(vendorId) }])])
      .orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }]);
    if (after) query.whereRaw('("createdAt", "id") < (?::timestamptz, ?)', [after.createdAt, after.id]);
    if (limit) query.limit(limit);
    return (await query).map(plain);
  }
  /** One app order as a customer-profile row: own part only, no contact details, no lines. */
  const orderRow = (order, vendorId) => {
    const mine = ownLines(order, vendorId);
    const own = (Array.isArray(order.fulfilments) ? order.fulfilments : []).find(f => f?.vendorId === vendorId);
    return {
      id: order.id, shortRef: shortRef(order.id), createdAt: iso(order.createdAt), status: own?.status || order.status, orderStatus: order.status,
      tab: orderTab(order, vendorId), paymentStatus: order.paymentStatus ?? null,
      totalTzs: mine.reduce((s, i) => s + Number(i.priceTzs || 0) * Number(i.qty || 0), 0),
      itemCount: mine.reduce((s, i) => s + Number(i.qty || 0), 0),
    };
  };

  /** GET /vendor/customers/:id — profile figures. null when not this vendor's customer. */
  async function profile(vendorId, customerId, today) {
    const row = await find(db, vendorId, customerId);
    if (!row) return null;
    const [owed, open, shop] = await Promise.all([
      owedOf(db, vendorId, customerId, today),
      db.raw(`SELECT s.id, s.number, s."soldAt", s."dueDate"::text AS "dueDate", s."totalTzs", s."balanceTzs", (?::date - s."dueDate")::int AS "daysPastDue"
                FROM "VendorSale" s
               WHERE s."vendorId" = ? AND s."customerId" = ? AND s.kind = 'credit' AND s.status = 'completed' AND s."balanceTzs" > 0
               ORDER BY s."dueDate", s."soldAt", s.id`, [today, vendorId, customerId]),
      db('VendorSale').where({ vendorId, customerId, status: 'completed' })
        .first(db.raw('count(*)::int AS n'), db.raw('COALESCE(sum("totalTzs"), 0)::bigint AS total'), db.raw('max("soldAt") AS last')),
    ]);
    let app = { n: 0, total: 0, last: null };
    if (row.source === 'marketplace' && row.buyerUserId) {
      for (const order of await paidOrdersOf(vendorId, row.buyerUserId)) {
        // App orders = this vendor's own lines of paid orders, not cancelled or refunded (§5.1).
        if (order.paymentStatus !== 'paid' || orderTab(order, vendorId) === 'cancelled') continue;
        app.n += 1;
        app.total += orderRow(order, vendorId).totalTzs;
        if (!app.last || +new Date(order.createdAt) > +new Date(app.last)) app.last = order.createdAt;
      }
    }
    const lastPurchase = [shop?.last, app.last].filter(Boolean).map(v => +new Date(v));
    return {
      customer: plain(row),
      money: owed,
      openSales: open.rows.map(plain).map(s => ({
        id: s.id, number: s.number, soldAt: iso(s.soldAt), dueDate: s.dueDate, totalTzs: s.totalTzs, balanceTzs: s.balanceTzs,
        daysOverdue: Math.max(0, s.daysPastDue), overdue: s.daysPastDue >= 1,
      })),
      totals: {
        shopSalesTzs: num(shop?.total), shopSalesCount: num(shop?.n), appOrdersTzs: app.total, appOrdersCount: app.n,
        lastPurchaseAt: lastPurchase.length ? new Date(Math.max(...lastPurchase)).toISOString() : null,
      },
    };
  }

  /** GET /vendor/customers/:id/orders rows (marketplace customers; manual ones have none). */
  async function ordersOf(vendorId, customerId, { limit, after }) {
    const row = await find(db, vendorId, customerId);
    if (!row) return null;
    if (row.source !== 'marketplace' || !row.buyerUserId) return { orders: [], last: null, more: false };
    const rows = await paidOrdersOf(vendorId, row.buyerUserId, { limit: limit + 1, after });
    const page = rows.slice(0, limit);
    return { orders: page.map(o => orderRow(o, vendorId)), last: page[page.length - 1] || null, more: rows.length > limit };
  }

  /**
   * The buyer behind a customerId of this vendor (GET /vendor/orders?customerId=): a marketplace
   * customer, or an S2 buyer pseudonym (VendorBuyerRef) with no customer record yet.
   * → { buyerUserId|null } (a manual customer has no app orders) | null (not this vendor's).
   */
  async function buyerOf(vendorId, customerId) {
    if (typeof customerId !== 'string' || !customerId) return null;
    const row = await find(db, vendorId, customerId);
    if (row) return { buyerUserId: row.buyerUserId ?? null };
    const ref = await db('VendorBuyerRef').where({ vendorId, customerId }).first('buyerId');
    return ref ? { buyerUserId: ref.buyerId } : null;
  }

  /**
   * A paid app order (Q-6): each vendor in it gets (or refreshes) the buyer as a marketplace customer —
   * id = the S2 buyer pseudonym, name = the buyer's display name now. Nothing else is copied (A-02).
   */
  async function marketplaceOrderPaid(order) {
    const vendorIds = [...new Set((order?.items || []).map(i => i?.vendorId).filter(Boolean).map(String))];
    if (!order?.buyerId || !vendorIds.length) return { customers: 0 };
    const at = now();
    const buyer = await db('User').where({ id: order.buyerId }).first('displayName');
    // A deleted account (e.g. a late payment on an old order) is never brought back as a customer (#224 H1).
    if (!buyer) return { customers: 0 };
    const name = typeof buyer?.displayName === 'string' && buyer.displayName.trim() ? buyer.displayName.trim().slice(0, 120) : null;
    for (const vendorId of vendorIds) {
      await db('VendorBuyerRef').insert({ vendorId, buyerId: String(order.buyerId), customerId: newCustomerId(), createdAt: at })
        .onConflict(['vendorId', 'buyerId']).ignore();
      const ref = await db('VendorBuyerRef').where({ vendorId, buyerId: String(order.buyerId) }).first('customerId');
      // A customer id whose buyer was forgotten (account deleted) is never reused or relinked.
      await db.raw(`INSERT INTO "VendorCustomer" (id, "vendorId", source, "buyerUserId", name, "lastPurchaseAt", "createdBy", "createdAt", "updatedAt")
        SELECT ?, ?, 'marketplace', ?, ?, ?, 'system:order', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM "VendorCustomer" f WHERE f.id = ? AND f."forgottenAt" IS NOT NULL)
        ON CONFLICT ("vendorId", "buyerUserId") WHERE "buyerUserId" IS NOT NULL DO UPDATE
          SET name = EXCLUDED.name,
              "lastPurchaseAt" = GREATEST("VendorCustomer"."lastPurchaseAt", EXCLUDED."lastPurchaseAt"),
              "updatedAt" = EXCLUDED."updatedAt"
          WHERE "VendorCustomer"."forgottenAt" IS NULL`, [ref.customerId, vendorId, String(order.buyerId), name, at, at, at, ref.customerId]);
    }
    return { customers: vendorIds.length };
  }

  /**
   * The buyer deleted their FitFlex account (security review #224 H1): at every vendor, their app
   * customer loses its name and the vendor's note about them (lead decision 2026-10-20, privacy first;
   * forgottenAt set; clients show "Deleted member"), and their S2 buyer pseudonyms (VendorBuyerRef) are
   * deleted at every vendor. Where nothing is owed the
   * link to the account (buyerUserId) is dropped too; where pay-later money is still owed it is kept,
   * nameless, until that is paid off (recordPayment then drops it). The row itself stays: sales and
   * payments reference it. Audited without personal data. → { forgotten, unlinked, refsDeleted }
   */
  async function forgetBuyer(userId) {
    if (!userId) return { forgotten: 0, unlinked: 0, refsDeleted: 0 };
    const at = now();
    const { rows } = await db.raw(`UPDATE "VendorCustomer" c
         SET name = NULL, note = NULL, "forgottenAt" = COALESCE(c."forgottenAt", ?), "updatedAt" = ?,
             "buyerUserId" = CASE WHEN EXISTS (SELECT 1 FROM "VendorSale" s
                                  WHERE s."vendorId" = c."vendorId" AND s."customerId" = c.id AND s.kind = 'credit'
                                    AND s.status = 'completed' AND s."balanceTzs" > 0)
                                 THEN c."buyerUserId" ELSE NULL END
       WHERE c.source = 'marketplace' AND c."buyerUserId" = ?
       RETURNING c.id, c."vendorId", c."buyerUserId"`, [at, at, String(userId)]);
    for (const r of rows) {
      await audit(db, { actor: 'system:account_deleted', action: 'vendor_customer_forgotten', target: r.id, after: { vendorId: r.vendorId, unlinked: r.buyerUserId == null } });
    }
    const refsDeleted = await db('VendorBuyerRef').where({ buyerId: String(userId) }).del();
    return { forgotten: rows.length, unlinked: rows.filter(r => r.buyerUserId == null).length, refsDeleted };
  }

  // ── payments ──────────────────────────────────────────────────────────────

  async function paymentViews(q, vendorId, rows) {
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const allocs = (await q('VendorPaymentAllocation as a').join('VendorSale as s', function joinSale() { this.on('s.id', 'a.saleId').andOn('s.vendorId', 'a.vendorId'); })
      .where('a.vendorId', vendorId).whereIn('a.paymentId', ids).orderBy(['a.paymentId', 'a.position'])
      .select('a.paymentId', 'a.saleId', 's.number', 'a.amountTzs')).map(plain);
    const names = await namesOf(q, rows.flatMap(r => [r.recordedBy, r.voidedBy]));
    return rows.map(plain).map(p => ({
      id: p.id, number: p.number, customerId: p.customerId, status: p.status, amountTzs: p.amountTzs, method: p.method,
      reference: p.reference ?? null, receivedOn: dayOf(p.receivedOn), note: p.note ?? null, clientRef: p.clientRef,
      recordedAt: iso(p.createdAt), recordedBy: person(p.recordedBy, names.get(p.recordedBy)),
      allocations: allocs.filter(a => a.paymentId === p.id).map(a => ({ saleId: a.saleId, saleNumber: a.number, amountTzs: a.amountTzs })),
      voidedAt: iso(p.voidedAt), voidedBy: person(p.voidedBy, names.get(p.voidedBy)), voidReason: p.voidReason ?? null,
    }));
  }
  const loadPayment = async (q, where) => {
    const row = await q('VendorCustomerPayment').where(where).first();
    return row ? (await paymentViews(q, where.vendorId, [row]))[0] : null;
  };

  async function getPayment(vendorId, customerId, paymentId) {
    if (typeof paymentId !== 'string' || !paymentId) return null;
    return loadPayment(db, { id: paymentId, vendorId, customerId });
  }

  /** A payment already recorded under this clientRef: the same request → it; another → 409 client_ref_reused. */
  async function paymentReplay(vendorId, clientRef, fingerprint) {
    const row = await db('VendorCustomerPayment').where({ vendorId, clientRef }).first('id', 'fingerprint', 'customerId');
    if (!row) return null;
    if (row.fingerprint !== fingerprint) return fail('client_ref_reused', 409);
    return { payment: await loadPayment(db, { id: row.id, vendorId }), customerId: row.customerId, replayed: true };
  }

  /**
   * Record a customer payment (parsed by parsePayment). → { payment, customer: money, replayed } | refusal:
   * 404 customer_not_found, 409 customer_archived, 409 overpayment { owedTzs }, 409 allocation_stale { saleId, balanceTzs }.
   */
  async function recordPayment({ vendorId, customerId, actorId, payment, fingerprint, today }) {
    const earlier = await paymentReplay(vendorId, payment.clientRef, fingerprint);
    if (earlier) return earlier.error ? earlier : { ...earlier, customer: await owedOf(db, vendorId, earlier.customerId, today) };
    const paymentId = newId('cpm');
    try {
      return await db.transaction(async (trx) => {
        const customer = await trx('VendorCustomer').where({ id: customerId, vendorId }).forUpdate().first('id', 'archivedAt', 'forgottenAt', 'buyerUserId');
        if (!customer) throw refusal('customer_not_found', 404);
        // A retry racing its first attempt waited on the customer lock: answer it as a replay, not as
        // an over-payment against the balance the first attempt just paid.
        const same = await trx('VendorCustomerPayment').where({ vendorId, clientRef: payment.clientRef }).first('id', 'fingerprint', 'customerId');
        if (same) {
          if (same.fingerprint !== fingerprint) throw refusal('client_ref_reused', 409);
          return { payment: await loadPayment(trx, { id: same.id, vendorId }), customer: await owedOf(trx, vendorId, same.customerId, today), replayed: true };
        }
        if (customer.archivedAt) throw refusal('customer_archived', 409);
        const open = (await trx('VendorSale').where({ vendorId, customerId, kind: 'credit', status: 'completed' }).where('balanceTzs', '>', 0)
          .orderBy([{ column: 'dueDate' }, { column: 'soldAt' }, { column: 'id' }]).forUpdate()
          .select('id', 'number', 'balanceTzs')).map(plain);
        const owedTzs = open.reduce((s, x) => s + x.balanceTzs, 0);
        // O-8: no customer credit balance — more than is owed is refused, whole.
        if (payment.amountTzs > owedTzs) throw refusal('overpayment', 409, { owedTzs });
        let plan;
        if (payment.allocations) {
          const byId = new Map(open.map(x => [x.id, x]));
          for (const a of payment.allocations) {
            const sale = byId.get(a.saleId);
            if (!sale || sale.balanceTzs < a.amountTzs) throw refusal('allocation_stale', 409, { saleId: a.saleId, balanceTzs: sale?.balanceTzs ?? 0 });
          }
          plan = payment.allocations;
        } else {
          plan = allocateOldestFirst(open, payment.amountTzs);
        }
        const at = now();
        const issued = await trx.raw(`INSERT INTO "VendorDocumentSequence" ("vendorId", "docType", "next", "updatedAt")
          VALUES (?, ?, 2, ?)
          ON CONFLICT ("vendorId", "docType") DO UPDATE SET "next" = "VendorDocumentSequence"."next" + 1, "updatedAt" = EXCLUDED."updatedAt"
          RETURNING "next" - 1 AS seq`, [vendorId, PAYMENT_DOC_TYPE, at]);
        const seq = Number(issued.rows[0].seq);
        await trx('VendorCustomerPayment').insert({
          id: paymentId, vendorId, customerId, seq, number: paymentNumber(seq), amountTzs: payment.amountTzs, method: payment.method,
          reference: payment.reference, receivedOn: payment.receivedOn, note: payment.note, clientRef: payment.clientRef, fingerprint,
          status: 'recorded', recordedBy: actorId, createdAt: at, updatedAt: at,
        });
        await trx('VendorPaymentAllocation').insert(plan.map((a, i) => ({
          id: newId('pal'), vendorId, paymentId, saleId: a.saleId, position: i + 1, amountTzs: a.amountTzs, createdAt: at,
        })));
        for (const a of plan) {
          // Balance moves to paid in the same transaction; the CHECKs (paid − change + balance = total,
          // 0 ≤ allocated ≤ paid, balance ≥ 0) hold after every write.
          const n = await trx('VendorSale').where({ id: a.saleId, vendorId, status: 'completed' }).where('balanceTzs', '>=', a.amountTzs)
            .update({
              paidTzs: trx.raw('"paidTzs" + ?', [a.amountTzs]), balanceTzs: trx.raw('"balanceTzs" - ?', [a.amountTzs]),
              allocatedTzs: trx.raw('"allocatedTzs" + ?', [a.amountTzs]), updatedAt: at,
            });
          if (n !== 1) throw refusal('allocation_stale', 409, { saleId: a.saleId });
        }
        // A forgotten buyer (account deleted) kept only while money was owed: paid off → unlinked (H1).
        if (customer.forgottenAt && customer.buyerUserId && payment.amountTzs === owedTzs) {
          await trx('VendorCustomer').where({ id: customerId, vendorId }).update({ buyerUserId: null, updatedAt: at });
        }
        await audit(trx, {
          actor: actorId, action: 'vendor_customer_payment_recorded', target: paymentId,
          after: { vendorId, customerId, number: paymentNumber(seq), amountTzs: payment.amountTzs, method: payment.method, receivedOn: payment.receivedOn, allocations: plan },
        });
        return { payment: await loadPayment(trx, { id: paymentId, vendorId }), customer: await owedOf(trx, vendorId, customerId, today), replayed: false };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      // The same clientRef arrived twice at once: the other request won; this one rolled back whole.
      if (err.code === UNIQUE_VIOLATION && /client_?ref/i.test(`${err.constraint || ''} ${err.message}`)) {
        const replay = await paymentReplay(vendorId, payment.clientRef, fingerprint);
        if (replay) return replay.error ? replay : { ...replay, customer: await owedOf(db, vendorId, replay.customerId, today) };
      }
      throw err;
    }
  }

  /** Void a payment: its allocations are reversed, the sales owe again. → { payment, customer: money } | refusal. */
  /**
   * `canVoid(payment)` → null or a refusal, judged on the locked row (review #224 M2: who may void which
   * payment). Order: customer_not_found, payment_not_found, void_not_allowed, already_voided, customer_archived.
   */
  async function voidPayment({ vendorId, customerId, paymentId, actorId, reason, today, canVoid = () => null }) {
    if (typeof paymentId !== 'string' || !paymentId) return fail('payment_not_found', 404);
    try {
      return await db.transaction(async (trx) => {
        const customer = await trx('VendorCustomer').where({ id: customerId, vendorId }).forUpdate().first('id', 'archivedAt');
        if (!customer) throw refusal('customer_not_found', 404);
        const p = plain(await trx('VendorCustomerPayment').where({ id: paymentId, vendorId, customerId }).forUpdate().first());
        if (!p) throw refusal('payment_not_found', 404);
        const refused = canVoid({ ...p, receivedOn: dayOf(p.receivedOn) });
        if (refused) throw Object.assign(new Error(refused.error), { refusal: refused });
        if (p.status === 'voided') throw refusal('already_voided', 409, { voidedAt: iso(p.voidedAt) });
        // L4: an archived customer's payments stay as they are; restore the customer first.
        if (customer.archivedAt) throw refusal('customer_archived', 409);
        const at = now();
        const allocs = (await trx('VendorPaymentAllocation').where({ paymentId, vendorId }).whereNull('voidedAt').orderBy('saleId')).map(plain);
        for (const a of allocs) {
          const n = await trx('VendorSale').where({ id: a.saleId, vendorId }).where('allocatedTzs', '>=', a.amountTzs)
            .update({
              paidTzs: trx.raw('"paidTzs" - ?', [a.amountTzs]), balanceTzs: trx.raw('"balanceTzs" + ?', [a.amountTzs]),
              allocatedTzs: trx.raw('"allocatedTzs" - ?', [a.amountTzs]), updatedAt: at,
            });
          if (n !== 1) throw new Error(`vendor customer payment void: allocation ${a.id} does not match sale ${a.saleId}`);
        }
        await trx('VendorPaymentAllocation').where({ paymentId, vendorId }).whereNull('voidedAt').update({ voidedAt: at });
        await trx('VendorCustomerPayment').where({ id: paymentId, vendorId, status: 'recorded' })
          .update({ status: 'voided', voidedAt: at, voidedBy: actorId, voidReason: reason, updatedAt: at });
        await audit(trx, {
          actor: actorId, action: 'vendor_customer_payment_voided', target: paymentId,
          before: { status: 'recorded', number: p.number, amountTzs: p.amountTzs, allocations: allocs.map(a => ({ saleId: a.saleId, amountTzs: a.amountTzs })) },
          after: { status: 'voided', vendorId, customerId, reason },
        });
        return { payment: await loadPayment(trx, { id: paymentId, vendorId }), customer: await owedOf(trx, vendorId, customerId, today) };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      throw err;
    }
  }

  /** GET /vendor/customers/:id/payments: newest first (number desc). from = EAT day (receivedOn ≥). */
  async function listPayments({ vendorId, customerId, from = null, limit = 50, beforeSeq = null }) {
    const query = db('VendorCustomerPayment').where({ vendorId, customerId }).orderBy('seq', 'desc').limit(limit + 1);
    if (from) query.where('receivedOn', '>=', from);
    if (beforeSeq != null) query.where('seq', '<', beforeSeq);
    const rows = (await query).map(plain);
    const page = rows.slice(0, limit);
    return { payments: await paymentViews(db, vendorId, page), lastSeq: page.length ? page[page.length - 1].seq : null, more: rows.length > limit };
  }

  // ── aging ─────────────────────────────────────────────────────────────────

  /**
   * GET /vendor/receivables/aging: one row per customer who owes (not archived: an archived customer
   * owes nothing), totals over all of them (not the bucket filter or the page).
   */
  async function aging({ vendorId, today, bucket = null, sort = 'overdue', limit = 50, offset = 0 }) {
    if (bucket && !AGING_BUCKETS.includes(bucket)) throw new Error(`unknown aging bucket ${bucket}`);
    const order = {
      overdue: 'o."maxDaysOverdue" DESC, o."owedTzs" DESC, c.id ASC',
      owed: 'o."owedTzs" DESC, c.id ASC',
      name: 'lower(c.name) ASC NULLS LAST, c.id ASC',
    }[sort];
    const base = `WITH o AS (${OWED_SQL('')}) SELECT o.*, c.name, c.source, c."forgottenAt" FROM o JOIN "VendorCustomer" c ON c.id = o."customerId" AND c."vendorId" = ?`;
    const [{ rows }, totals] = await Promise.all([
      db.raw(`${base} ${bucket ? `WHERE o."${bucket}" > 0` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`, [today, vendorId, vendorId, limit + 1, offset]),
      db.raw(`WITH o AS (${OWED_SQL('')})
        SELECT COALESCE(sum("owedTzs"), 0)::bigint AS "owedTzs", COALESCE(sum("overdueTzs"), 0)::bigint AS "overdueTzs",
               count(*)::int AS "customerCount", count(*) FILTER (WHERE "overdueTzs" > 0)::int AS "overdueCustomerCount",
               COALESCE(sum("openCount"), 0)::int AS "openSaleCount", COALESCE(sum("overdueCount"), 0)::int AS "overdueSaleCount",
               COALESCE(sum(current), 0)::bigint AS current, COALESCE(sum(d1_30), 0)::bigint AS d1_30, COALESCE(sum(d31_60), 0)::bigint AS d31_60,
               COALESCE(sum(d61_90), 0)::bigint AS d61_90, COALESCE(sum(d90plus), 0)::bigint AS d90plus
          FROM o`, [today, vendorId]),
    ]);
    const t = plain(totals.rows[0]);
    const page = rows.slice(0, limit).map(plain);
    return {
      totals: {
        owedTzs: num(t.owedTzs), overdueTzs: num(t.overdueTzs), customerCount: num(t.customerCount), overdueCustomerCount: num(t.overdueCustomerCount),
        openSaleCount: num(t.openSaleCount), overdueSaleCount: num(t.overdueSaleCount), ...agingOf(t),
      },
      rows: page.map(r => ({
        customerId: r.customerId, name: r.name ?? null, source: r.source, forgotten: r.forgottenAt != null, owedTzs: num(r.owedTzs), overdueTzs: num(r.overdueTzs),
        oldestDueDate: r.oldestDueDate, maxDaysOverdue: num(r.maxDaysOverdue), openSaleCount: num(r.openCount), overdueSaleCount: num(r.overdueCount), ...agingOf(r),
      })),
      nextCursor: rows.length > limit ? encodeOffset(offset + limit) : null,
    };
  }

  // ── overdue digest ────────────────────────────────────────────────────────

  /**
   * Vendors with pay-later sales that became overdue today (due yesterday, EAT), not yet told today.
   * Claims (vendorId, today) once; a vendor already claimed today is skipped.
   * → [{ vendorId, count, totalTzs }]
   */
  async function claimOverdueDigests(today) {
    const { rows } = await db.raw(`SELECT "vendorId", count(*)::int AS count, sum("balanceTzs")::bigint AS "totalTzs"
        FROM "VendorSale"
       WHERE kind = 'credit' AND status = 'completed' AND "balanceTzs" > 0 AND "dueDate" = (?::date - 1)
       GROUP BY "vendorId" ORDER BY "vendorId"`, [today]);
    const claimed = [];
    for (const r of rows.map(plain)) {
      const ins = await db.raw(`INSERT INTO "VendorOverdueDigest" ("vendorId", day, count, "totalTzs", "createdAt") VALUES (?, ?, ?, ?, ?)
        ON CONFLICT ("vendorId", day) DO NOTHING RETURNING "vendorId"`, [r.vendorId, today, r.count, r.totalTzs, now()]);
      if (ins.rows.length) claimed.push({ vendorId: r.vendorId, count: num(r.count), totalTzs: num(r.totalTzs) });
    }
    return claimed;
  }
  /** Who hears about a vendor's overdue sales: the vendor account (not suspended) and active staff with `customers`. */
  async function digestRecipients(vendorId) {
    const vendor = await db('User').where({ id: vendorId, userType: 'vendor' }).first('id', 'accountStatus');
    if (!vendor || vendor.accountStatus === 'suspended') return [];
    const staff = await db('User').where({ userType: 'vendor_staff', vendorId, accountStatus: 'active' })
      .whereRaw(`'customers' = ANY(COALESCE("vendorPermissions", '{}'))`).orderBy('id').select('id');
    return [vendorId, ...staff.map(s => s.id)];
  }
  const markDigestSent = (vendorId, day, recipients) => db('VendorOverdueDigest').where({ vendorId, day }).update({ recipients });

  return {
    get, create, update, list, profile, ordersOf, buyerOf, marketplaceOrderPaid, forgetBuyer,
    getPayment, recordPayment, voidPayment, listPayments, aging,
    claimOverdueDigests, digestRecipients, markDigestSent,
  };
}
