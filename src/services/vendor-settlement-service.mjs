// Vendor payouts — a weekly statement per vendor, on the shared statement
// path (partner-statement-workflow): draft → submitted → approved → payable
// → paid, or voided.
//
// What a vendor is paid for: their items on an order that was paid for and
// delivered. The commission was fixed on each order line when the order was
// placed, so the statement only adds up what the order already says.
//
// - An order is payable as soon as it is delivered. A statement covers a
//   Monday–Sunday week (East Africa Time), is prepared once the week has
//   ended, and also picks up earlier deliveries not yet on a statement.
// - A vendor's share of an order is paid once: it sits on one live line.
//   Voiding a statement releases its orders for the next one.
// - Paying a statement marks its orders settled.
// - The payout check: the vendor needs approved KYC and a verified payout
//   account past its 48-hour hold.
import { randomUUID } from 'node:crypto';
import { db as defaultDb } from '../infra/knex-store.mjs';
import { vendorShareOfOrder } from '../shared/marketplace-pricing.mjs';
import {
  createStatementWorkflow, fail, weekToPrepare, eatDate, partnerView, STATEMENT_STATUSES, VISIBLE_TO_PARTNER,
} from './partner-statement-workflow.mjs';

const DELIVERED = ['delivered', 'fulfilled'];
const parse = (v, fallback) => (typeof v === 'string' ? JSON.parse(v) : v ?? fallback);

/** The EAT date an order was delivered: its last "delivered" timeline entry, else when it was last changed. */
export function deliveredOn(order) {
  const timeline = parse(order.timeline, []) || [];
  const entry = [...timeline].reverse().find((t) => DELIVERED.includes(t?.status));
  const at = entry?.at || order.updatedAt || order.createdAt;
  return at ? eatDate(at) : null;
}

export function createVendorSettlementService({
  db = defaultDb, users, payoutEligibility,
  notify = async () => {},   // (userId, { type, title, body, data })
  now = () => new Date(),
} = {}) {
  const money = (n) => `TZS ${Number(n || 0).toLocaleString('en-US')}`;

  const workflow = createStatementWorkflow({
    db, now, table: 'VendorSettlement', lineTable: 'VendorSettlementLine', lineKey: 'vendorSettlementId', auditPrefix: 'vendor_settlement',
    payoutCheck: (s, at) => payoutEligibility.forVendor(s.vendorId, { at }),
    // The orders on a paid statement are settled.
    onPaid: async (s, q) => {
      const orderIds = (await q('VendorSettlementLine').where({ vendorSettlementId: s.id, voided: false }).select('orderId')).map((l) => l.orderId);
      if (orderIds.length) await q('ShopOrder').whereIn('id', orderIds).update({ settlementStatus: 'settled', updatedAt: now() });
    },
  });

  // ── preparing ───────────────────────────────────────────────────────────────

  /**
   * Prepare draft statements for a week that has ended (default: the last
   * one). A vendor with nothing delivered gets none. An existing draft for
   * the same week is rebuilt; a statement already submitted is left alone
   * and anything new waits for the next week's statement.
   */
  async function prepare({ periodStart = null, actorId } = {}) {
    if (!actorId) return fail('actor_required', 403);
    const at = now();
    const week = weekToPrepare(periodStart, at);
    if (week.error) return week;

    return db.transaction(async (q) => {
      const drafts = await q('VendorSettlement').where({ periodStartDate: week.periodStartDate, status: 'draft' }).forUpdate();
      const draftIds = drafts.map((d) => d.id);
      if (draftIds.length) await q('VendorSettlementLine').whereIn('vendorSettlementId', draftIds).del();

      // Paid and delivered; a refunded or cancelled order is neither.
      const orders = await q('ShopOrder').whereIn('status', DELIVERED).where({ paymentStatus: 'paid' }).orderBy('createdAt');
      const settled = new Set((await q('VendorSettlementLine').where({ voided: false }).select('orderId', 'vendorId')).map((l) => `${l.orderId}|${l.vendorId}`));

      const byVendor = new Map();
      for (const raw of orders) {
        const order = { ...raw, items: parse(raw.items, []) };
        const day = deliveredOn(order);
        if (!day || day > week.periodEndDate) continue;
        for (const vendorId of new Set(order.items.map((i) => i.vendorId).filter(Boolean))) {
          if (settled.has(`${order.id}|${vendorId}`)) continue;
          const share = vendorShareOfOrder(order, vendorId);
          if (!(share.payoutTzs > 0)) continue;
          if (!byVendor.has(vendorId)) byVendor.set(vendorId, []);
          byVendor.get(vendorId).push({ order, day, share });
        }
      }

      const locked = new Set((await q('VendorSettlement').where({ periodStartDate: week.periodStartDate }).whereNotIn('status', ['draft', 'voided'])).map((s) => s.vendorId));
      const draftByVendor = new Map(drafts.map((d) => [d.vendorId, d]));
      const out = { ...week, prepared: 0, rebuilt: 0, skipped: 0, removed: 0, statements: [] };

      for (const [vendorId, sales] of byVendor) {
        if (locked.has(vendorId)) { out.skipped += 1; continue; }
        const totals = sales.reduce((t, { share }) => ({
          salesTzs: t.salesTzs + share.salesTzs, commissionTzs: t.commissionTzs + share.commissionTzs, finalNetTzs: t.finalNetTzs + share.payoutTzs,
        }), { salesTzs: 0, commissionTzs: 0, finalNetTzs: 0 });
        const existing = draftByVendor.get(vendorId);
        const id = existing?.id || `vst_${randomUUID().slice(0, 12)}`;
        const fields = { orderCount: sales.length, ...totals, preparedBy: actorId, updatedAt: at };
        if (existing) {
          await q('VendorSettlement').where({ id }).update(fields);
          draftByVendor.delete(vendorId);
          out.rebuilt += 1;
        } else {
          await q('VendorSettlement').insert({ id, vendorId, periodStartDate: week.periodStartDate, periodEndDate: week.periodEndDate, status: 'draft', ...fields, createdAt: at });
          out.prepared += 1;
        }
        await q('VendorSettlementLine').insert(sales.map(({ order, day, share }) => ({
          id: randomUUID(), vendorSettlementId: id, vendorId, orderId: order.id, buyerId: order.buyerId, deliveredOn: day,
          itemCount: share.itemCount, salesTzs: share.salesTzs, commissionTzs: share.commissionTzs, payoutTzs: share.payoutTzs, createdAt: at,
        })));
        out.statements.push({ id, vendorId, orderCount: sales.length, finalNetTzs: totals.finalNetTzs });
      }
      for (const stale of draftByVendor.values()) {
        await q('VendorSettlement').where({ id: stale.id }).del();
        out.removed += 1;
      }
      await workflow.audit(q, 'prepared', actorId, week.periodStartDate, null, { ...week, prepared: out.prepared, rebuilt: out.rebuilt, skipped: out.skipped, removed: out.removed });
      return out;
    });
  }

  /** payable → paid: record that the money went, and tell the vendor. */
  async function pay(args) {
    const out = await workflow.pay(args);
    if (out.statement) {
      const s = out.statement;
      try {
        await notify(s.vendorId, {
          id: `ntf_vendor_payout_${s.id}`, type: 'vendor_payout_paid', title: 'Payout sent',
          body: `FitFlex sent you ${money(s.finalNetTzs)} for ${s.orderCount} order(s), ${s.periodStartDate} to ${s.periodEndDate}. Reference: ${s.paymentReference}.`,
          data: { statementId: s.id },
        });
      } catch { /* the payment itself is recorded */ }
    }
    return out;
  }

  // ── reading ─────────────────────────────────────────────────────────────────

  async function vendorNames(ids) {
    const rows = ids.length ? await users.filterByColumnInAsync('id', [...new Set(ids)]) : [];
    return new Map(rows.map((u) => [u.id, u.vendorProfile?.businessName || u.displayName || null]));
  }
  const withVendor = (s, names) => ({ ...s, vendor: { id: s.vendorId, businessName: names.get(s.vendorId) ?? null } });

  /** Admin: statements, newest week first. */
  async function list({ status, vendorId, limit = 200 } = {}) {
    if (status && !STATEMENT_STATUSES.includes(status)) return fail('invalid_status', 400, { allowed: STATEMENT_STATUSES });
    const query = db('VendorSettlement').orderBy([{ column: 'periodStartDate', order: 'desc' }, { column: 'vendorId' }]).limit(Math.min(Number(limit) || 200, 500));
    if (status) query.where({ status });
    if (vendorId) query.where({ vendorId });
    const rows = await query;
    const names = await vendorNames(rows.map((r) => r.vendorId));
    return { statements: rows.map((r) => withVendor(r, names)) };
  }

  async function linesOf(id, { includeVoided = false } = {}) {
    const query = db('VendorSettlementLine').where({ vendorSettlementId: id }).orderBy(['deliveredOn', 'orderId']);
    if (!includeVoided) query.where({ voided: false });
    return query;
  }

  /** Admin: one statement with its orders and whether the vendor can be paid now. */
  async function get(id) {
    const statement = await db('VendorSettlement').where({ id }).first();
    if (!statement) return fail('statement_not_found', 404);
    const payout = await payoutEligibility.forVendor(statement.vendorId, { at: now() });
    return {
      statement: withVendor(statement, await vendorNames([statement.vendorId])),
      lines: await linesOf(id, { includeVoided: statement.status === 'voided' }), payout,
    };
  }

  /** Vendor: my statements, and whether my payout account is ready. */
  async function listMine({ vendorId }) {
    const rows = await db('VendorSettlement').where({ vendorId }).whereIn('status', VISIBLE_TO_PARTNER).orderBy('periodStartDate', 'desc').limit(100);
    const payout = await payoutEligibility.forVendor(vendorId, { at: now() });
    return { statements: rows.map(partnerView), payoutReady: payout.ok, payoutBlockedBy: payout.ok ? null : payout.reason };
  }

  /** Vendor: one of my statements with its orders. */
  async function getMine({ vendorId, id }) {
    const statement = await db('VendorSettlement').where({ id, vendorId }).whereIn('status', VISIBLE_TO_PARTNER).first();
    if (!statement) return fail('statement_not_found', 404);
    // The buyer's id is not the vendor's to see here; the order itself has what they need.
    return { statement: partnerView(statement), lines: (await linesOf(id)).map(({ buyerId, ...line }) => line) };
  }

  const { submit, reject, approve, hold, release, markPayable, voidStatement } = workflow;
  return { prepare, submit, reject, approve, hold, release, markPayable, pay, voidStatement, list, get, listMine, getMine };
}
