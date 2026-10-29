// Vendor reports (vendor business tools · S6; design spec docs/design/vendor-reports-s6.md, decided 2026-10-22).
//
// Read only: nothing here writes orders, sales, statements or money. The payout engine and settlement are
// not called; App sales after commission reads the order lines' commission / payout as fixed when the order
// was placed and the vendor's statements (VendorSettlement), so a statement week reconciles exactly.
//
// Access (`access`, worked out by the route from the STORED accounts, never the token):
//   cost      — canSeeCost (vendor account, vendorRole admin staff): cost, stock value at cost, profit, margin.
//               Without it these fields are absent (not null) and /profit answers 403 cost_not_allowed.
//   payout    — canSeeOrderMoney (vendor, admin staff, staff with `payments`): App sales after commission.
//               Without it /marketplace-net answers 403 payout_not_allowed and the summary has no payouts.
//   customers — the `customers` permission: the Customers section (also needs VENDOR_CUSTOMERS).
// Walk-in money never passes through FitFlex: walk-in figures are what the vendor recorded; they are never in
// settlement, commission or App sales after commission.
// A-02: no buyer names, phones or ids leave this service — customers are counted, never listed.
import { randomUUID } from 'node:crypto';
import {
  REPORT_LIMITS, REPORT_TIMEZONE, PRODUCT_SORTS, STOCK_SORTS, PRODUCTS_PAGE, COVER, parseReportQuery, bucketsOf, addDays, eatToday, pct1, cover,
  createReportCache, salesCsv, productsCsv, stockCsv, profitCsv, payoutsCsv, customersCsv, methodsCsv, reportFileName, autoGroupBy,
} from '../shared/vendor-reports.mjs';
import { csvDocument } from '../shared/csv-export.mjs';
import { variantsOf, isTracked } from '../shared/vendor-stock.mjs';
import { walkInPrice } from '../shared/vendor-sale.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const keyOf = (productId, variant) => `${productId}\u0000${variant || ''}`;
const channelTotals = () => ({ grossTzs: 0, discountTzs: 0, refundTzs: 0, netTzs: 0, vatIncludedTzs: 0, count: 0, itemsSold: 0 });
const addInto = (t, r) => {
  t.grossTzs += r.gross; t.discountTzs += r.discount; t.refundTzs += r.refund; t.netTzs += r.net; t.vatIncludedTzs += r.vat; t.count += r.count; t.itemsSold += r.items;
  return t;
};
const encodeOffset = n => Buffer.from(`o:${n}`).toString('base64url');
const decodeOffset = c => {
  try { const m = /^o:(\d{1,7})$/.exec(Buffer.from(String(c), 'base64url').toString()); return m ? Number(m[1]) : null; } catch { return null; }
};
const METHOD_ORDER = ['cash', 'mpesa', 'airtel_money', 'mixx', 'halopesa', 'card', 'bank', 'other'];
export const REPORT_SECTIONS = ['summary', 'sales', 'products', 'stock-value', 'profit', 'marketplace-net', 'customers', 'payment-methods'];

export function createVendorReportService({
  store, users, auditLog,
  owedTotals = async () => null,          // (vendorId) → S4 aging totals { owedTzs, overdueTzs, current, d1_30, … }
  flags = { stockLedger: () => false, walkInSales: () => false, customers: () => false },
  now = () => new Date(),
  cache = createReportCache(),
} = {}) {
  /** Closed periods (to < today EAT) are cached for 10 minutes; a period that includes today never is. */
  async function cached(key, closed, compute) {
    if (!closed) return compute();
    const hit = cache.get(key);
    if (hit) return hit;
    const value = await compute();
    cache.set(key, value);
    return value;
  }
  const cacheKey = (vendorId, section, period, access, extra = {}) => JSON.stringify([vendorId, section, period.from, period.to, period.channel, period.groupBy,
    Boolean(access.cost), Boolean(access.payout), Boolean(access.customers), flags.stockLedger(), flags.customers(), extra]);

  async function head(vendorId, period, { channel = period.channel, grouped = true } = {}) {
    const walkIn = flags.walkInSales() || await store.hasWalkIn({ vendorId, from: period.from, to: period.to });
    return {
      from: period.from, to: period.to, channel, ...(grouped && period.groupBy ? { groupBy: period.groupBy } : {}),
      generatedAt: now().toISOString(), timezone: REPORT_TIMEZONE, inProgress: !period.closed, channels: { app: true, walkIn },
    };
  }

  // ── sales ───────────────────────────────────────────────────────────────────

  async function salesData(vendorId, period) {
    const [rows, voided] = await Promise.all([
      store.salesByBucket({ vendorId, from: period.from, to: period.to, channel: period.channel, groupBy: period.groupBy }),
      period.channel === 'app' ? { count: 0, totalTzs: 0 } : store.voided({ vendorId, from: period.from, to: period.to }),
    ]);
    const byKey = new Map(bucketsOf(period.from, period.to, period.groupBy).map(b => [b.key, { start: b.start, end: b.end, app: channelTotals(), walkIn: channelTotals() }]));
    const app = channelTotals(), walkIn = channelTotals();
    for (const r of rows) {
      const b = byKey.get(r.bucket);
      if (!b) throw new Error(`vendor report: bucket ${r.bucket} outside the period`);
      addInto(r.channel === 'app' ? b.app : b.walkIn, r);
      addInto(r.channel === 'app' ? app : walkIn, r);
    }
    const buckets = [...byKey.values()].map(b => ({ ...b, netTzs: b.app.netTzs + b.walkIn.netTzs }));
    const totals = {
      grossTzs: app.grossTzs + walkIn.grossTzs, discountTzs: app.discountTzs + walkIn.discountTzs, refundTzs: app.refundTzs + walkIn.refundTzs,
      netTzs: app.netTzs + walkIn.netTzs, vatIncludedTzs: app.vatIncludedTzs + walkIn.vatIncludedTzs,
      saleCount: walkIn.count, orderCount: app.count, itemsSold: app.itemsSold + walkIn.itemsSold, voided,
    };
    return { totals, byChannel: { app, walkIn }, buckets };
  }

  // ── products ────────────────────────────────────────────────────────────────

  /** Current stock of a product + variant: null when not known (removed product, or a variant without its own count). */
  function stockOf(product, variant) {
    if (!product || product.deletedAt) return null;
    if (!variant) return Number(product.stock || 0);
    const v = variantsOf(product).find(x => x.name === variant);
    return v && isTracked(v) ? Number(v.stock) : null;
  }
  /** In-stock units of the vendor's live products: one per variant when the variants keep their own counts. */
  function inStockKeys(products) {
    const out = [];
    for (const p of products) {
      if (p.deletedAt) continue;
      const variants = variantsOf(p);
      if (variants.length && variants.every(isTracked)) {
        for (const v of variants) if (Number(v.stock) > 0) out.push({ product: p, variant: v.name, stock: Number(v.stock) });
      } else if (Number(p.stock || 0) > 0) out.push({ product: p, variant: '', stock: Number(p.stock) });
    }
    return out;
  }

  async function productRows(vendorId, period, access) {
    const today = eatToday(now());
    const [facts, inventory, last, window] = await Promise.all([
      store.byProduct({ vendorId, from: period.from, to: period.to, channel: period.channel }),
      store.productsOf(vendorId),
      store.lastSold({ vendorId }),
      store.unitsInWindow({ vendorId, from: addDays(today, -(COVER.windowDays - 1)), to: today }),
    ]);
    const products = new Map(inventory.products.map(p => [p.id, p]));
    const rowFor = (productId, variant, fact, snapshotName) => {
      const product = products.get(productId);
      const removed = !product || Boolean(product.deletedAt);
      const stock = stockOf(product, variant);
      const row = {
        productId, variant: variant || null, name: (!removed && product?.name) || snapshotName || product?.name || null, removed,
        unitsSold: fact?.units ?? 0, appUnits: fact?.appUnits ?? 0, walkInUnits: fact?.walkInUnits ?? 0, netRevenueTzs: fact?.net ?? 0,
        lastSoldAt: last.get(keyOf(productId, variant)) ?? null, stock, ...cover(stock, window.get(keyOf(productId, variant)) ?? 0),
        noSalesInPeriod: !(fact?.units > 0),
      };
      if (access.cost) row.profitTzs = fact ? fact.costedNetExVat - fact.costedCommission - fact.cost : 0;
      return row;
    };
    const sold = facts.map(f => rowFor(f.productId, f.variant, f, f.name));
    const factByKey = new Map(facts.map(f => [keyOf(f.productId, f.variant), f]));
    const slow = inStockKeys(inventory.products).map(({ product, variant }) => rowFor(product.id, variant, factByKey.get(keyOf(product.id, variant)), product.name));
    const totals = { unitsSold: facts.reduce((s, f) => s + f.units, 0), netRevenueTzs: facts.reduce((s, f) => s + f.net, 0) };
    return { sold, slow, totals, facts, inventory };
  }
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || '')) || String(a.variant || '').localeCompare(String(b.variant || ''));
  const SORTERS = {
    revenue: (a, b) => b.netRevenueTzs - a.netRevenueTzs || b.unitsSold - a.unitsSold || byName(a, b),
    units: (a, b) => b.unitsSold - a.unitsSold || b.netRevenueTzs - a.netRevenueTzs || byName(a, b),
    slow: (a, b) => a.unitsSold - b.unitsSold || String(a.lastSoldAt || '').localeCompare(String(b.lastSoldAt || '')) || byName(a, b),
  };

  // ── stock value (as of now) ───────────────────────────────────────────────

  function stockValueData(inventory, access) {
    const rows = [];
    for (const { product, variant, stock } of inStockKeys(inventory.products)) {
      const priceTzs = walkInPrice(product);
      const costTzs = variant ? inventory.costs.get(keyOf(product.id, variant)) ?? inventory.costs.get(keyOf(product.id, '')) ?? null : inventory.costs.get(keyOf(product.id, '')) ?? null;
      const row = { productId: product.id, variant: variant || null, name: product.name || null, stock, priceTzs, valueAtRetailTzs: stock * priceTzs };
      if (access.cost) Object.assign(row, { costTzs, valueAtCostTzs: costTzs == null ? null : stock * costTzs });
      rows.push(row);
    }
    const totals = { atRetailTzs: rows.reduce((s, r) => s + r.valueAtRetailTzs, 0), units: rows.reduce((s, r) => s + r.stock, 0), products: new Set(rows.map(r => r.productId)).size };
    const out = { asOf: now().toISOString(), totals, rows };
    if (access.cost) {
      const costed = rows.filter(r => r.costTzs != null), unknown = rows.filter(r => r.costTzs == null);
      totals.atCostTzs = costed.reduce((s, r) => s + r.valueAtCostTzs, 0);
      out.costUnknown = { count: unknown.length, units: unknown.reduce((s, r) => s + r.stock, 0), retailTzs: unknown.reduce((s, r) => s + r.valueAtRetailTzs, 0) };
    }
    return out;
  }

  // ── profit ──────────────────────────────────────────────────────────────────

  async function profitData(vendorId, period) {
    const [rows, facts, inventory] = await Promise.all([
      store.profitByBucket({ vendorId, from: period.from, to: period.to, channel: period.channel, groupBy: period.groupBy }),
      store.byProduct({ vendorId, from: period.from, to: period.to, channel: period.channel }),
      store.productsOf(vendorId),
    ]);
    const empty = () => ({ netExVatTzs: 0, commissionTzs: 0, costTzs: 0, profitTzs: 0, uncostedRevenueTzs: 0 });
    const byKey = new Map(bucketsOf(period.from, period.to, period.groupBy).map(b => [b.key, { start: b.start, end: b.end, ...empty() }]));
    const channels = { app: empty(), walkIn: empty() };
    let hasVat = false;
    for (const r of rows) {
      const b = byKey.get(r.bucket);
      for (const t of [b, channels[r.channel === 'app' ? 'app' : 'walkIn']]) {
        t.netExVatTzs += r.netExVat; t.commissionTzs += r.commission; t.costTzs += r.cost; t.uncostedRevenueTzs += r.uncostedNet;
      }
      hasVat ||= r.hasVat;
    }
    const finish = t => ({ ...t, profitTzs: t.netExVatTzs - t.commissionTzs - t.costTzs, marginPct: pct1(t.netExVatTzs - t.commissionTzs - t.costTzs, t.netExVatTzs) });
    const buckets = [...byKey.values()].map(finish);
    const sum = (k) => buckets.reduce((s, b) => s + b[k], 0);
    const netExVatTzs = sum('netExVatTzs'), commissionTzs = sum('commissionTzs'), costTzs = sum('costTzs');
    const totals = { netExVatTzs, commissionTzs, costTzs, profitTzs: netExVatTzs - commissionTzs - costTzs, marginPct: pct1(netExVatTzs - commissionTzs - costTzs, netExVatTzs) };
    const products = new Map(inventory.products.map(p => [p.id, p]));
    const named = f => {
      const p = products.get(f.productId);
      const removed = !p || Boolean(p.deletedAt);
      return { productId: f.productId, variant: f.variant || null, name: (!removed && p?.name) || f.name || null, removed };
    };
    const byProduct = facts.filter(f => f.costedUnits || f.costedNetExVat || f.cost).map(f => {
      const profitTzs = f.costedNetExVat - f.costedCommission - f.cost;
      return { ...named(f), units: f.costedUnits, netExVatTzs: f.costedNetExVat, commissionTzs: f.costedCommission, costTzs: f.cost, profitTzs, marginPct: pct1(profitTzs, f.costedNetExVat) };
    }).sort((a, b) => b.profitTzs - a.profitTzs || byName(a, b));
    const noCost = facts.filter(f => f.uncostedUnits || f.uncostedNet).map(f => ({ ...named(f), units: f.uncostedUnits, revenueTzs: f.uncostedNet }))
      .sort((a, b) => b.revenueTzs - a.revenueTzs || byName(a, b));
    const uncosted = {
      lineCount: facts.reduce((s, f) => s + f.uncostedLines, 0), qty: facts.reduce((s, f) => s + f.uncostedUnits, 0),
      revenueTzs: facts.reduce((s, f) => s + f.uncostedNet, 0), netExVatTzs: facts.reduce((s, f) => s + f.uncostedNetExVat, 0),
    };
    return { totals, uncosted, hasVat, buckets, byChannel: { app: finish(channels.app), walkIn: finish(channels.walkIn) }, byProduct, uncostedProducts: noCost };
  }

  // ── app sales after commission ────────────────────────────────────────────

  async function payoutData(vendorId, period) {
    const rows = await store.marketplaceNet({ vendorId, from: period.from, to: period.to });
    const state = k => {
      const list = rows.filter(r => r.state === k);
      return { orders: list.reduce((s, r) => s + r.orders, 0), grossTzs: list.reduce((s, r) => s + r.sales, 0), commissionTzs: list.reduce((s, r) => s + r.commission, 0), payoutTzs: list.reduce((s, r) => s + r.payout, 0) };
    };
    const status = { notDelivered: state('not_delivered'), waiting: state('waiting'), paidOut: state('paid_out') };
    const delivered = rows.filter(r => r.state !== 'not_delivered');
    const weekMap = new Map();
    for (const r of delivered) {
      const k = `${r.weekStart}|${r.statement?.id || ''}`;
      const w = weekMap.get(k) || { periodStartDate: r.weekStart, periodEndDate: r.weekEnd, orderCount: 0, grossTzs: 0, commissionTzs: 0, payoutTzs: 0, paidOut: true,
        statement: r.statement ? { id: r.statement.id, status: r.statement.status, finalNetTzs: r.statement.finalNetTzs } : null };
      w.orderCount += r.orders; w.grossTzs += r.sales; w.commissionTzs += r.commission; w.payoutTzs += r.payout; w.paidOut &&= r.state === 'paid_out';
      weekMap.set(k, w);
    }
    const weeks = [...weekMap.values()].sort((a, b) => a.periodStartDate.localeCompare(b.periodStartDate) || (a.statement ? -1 : 1));
    const totals = { orderCount: status.waiting.orders + status.paidOut.orders, grossTzs: status.waiting.grossTzs + status.paidOut.grossTzs,
      commissionTzs: status.waiting.commissionTzs + status.paidOut.commissionTzs, payoutTzs: status.waiting.payoutTzs + status.paidOut.payoutTzs };
    return { basis: 'delivered', totals, status, weeks };
  }

  // ── payment methods, customers ────────────────────────────────────────────

  async function methodsData(vendorId, period) {
    const m = await store.paymentMethods({ vendorId, from: period.from, to: period.to });
    const withShare = list => {
      const total = list.reduce((s, r) => s + r.amountTzs, 0);
      return list.map(r => ({ ...r, sharePct: pct1(r.amountTzs, total) ?? 0 }));
    };
    let byYou = [];
    if (period.channel !== 'app') {
      const acc = new Map();
      for (const r of [...m.salePayments, ...m.customerPayments]) {
        const a = acc.get(r.method) || { method: r.method, amountTzs: 0, count: 0 };
        a.amountTzs += r.amount; a.count += r.count;
        acc.set(r.method, a);
      }
      // Cash is what stayed in the till: after the change given back.
      if (acc.has('cash')) acc.get('cash').amountTzs -= m.changeTzs;
      byYou = withShare([...acc.values()].filter(r => r.amountTzs > 0 || r.count > 0)
        .sort((a, b) => b.amountTzs - a.amountTzs || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method)));
    }
    const viaFitFlex = period.channel === 'walk_in' ? [] : withShare(m.app.map(r => ({ paymentMethod: r.method, amountTzs: r.amount, count: r.count })).sort((a, b) => b.amountTzs - a.amountTzs));
    return { byYou, viaFitFlex };
  }

  async function customersData(vendorId, period) {
    const [owed, activity] = await Promise.all([owedTotals(vendorId), store.customerActivity({ vendorId, from: period.from, to: period.to })]);
    const t = owed || {};
    return {
      asOf: eatToday(now()), owedTzs: Number(t.owedTzs || 0), overdueTzs: Number(t.overdueTzs || 0),
      aging: { current: Number(t.current || 0), d1_30: Number(t.d1_30 || 0), d31_60: Number(t.d31_60 || 0), d61_90: Number(t.d61_90 || 0), d90plus: Number(t.d90plus || 0) },
      ...activity,
    };
  }

  // ── sections ──────────────────────────────────────────────────────────────

  const GROUPED = new Set(['summary', 'sales', 'profit']);
  const FORMATS = { summary: ['json', 'pdf'] };
  const NO_CHANNEL = new Set(['stock-value', 'marketplace-net', 'customers']);

  /**
   * One report section as data. → { data, period, access } or { error, status, … }. `access` as above;
   * `flagsOk` is checked by the caller for the whole area (VENDOR_TOOLS + VENDOR_REPORTS).
   */
  async function report(section, { vendorId, access, query = {} }) {
    if (!REPORT_SECTIONS.includes(section)) return fail('report_not_found', 404);
    if (section === 'profit' && !access.cost) return fail('cost_not_allowed', 403);
    if (section === 'marketplace-net' && !access.payout) return fail('payout_not_allowed', 403);
    if (section === 'stock-value' && !flags.stockLedger()) return fail('feature_disabled', 404);
    if (section === 'customers') {
      if (!flags.customers()) return fail('feature_disabled', 404);
      if (!access.customers) return fail('vendor_permission_forbidden', 403, { requiredPermission: 'customers' });
    }
    const period = parseReportQuery(query, { now: now(), grouped: GROUPED.has(section), formats: FORMATS[section] || ['json', 'csv'], channelUsed: !NO_CHANNEL.has(section) });
    if (period.error) return period;
    if (section === 'marketplace-net') period.channel = 'app';

    if (section === 'stock-value') {
      // As of now: never cached, the period does not apply.
      const inventory = await store.productsOf(vendorId);
      return { period, data: { ...(await head(vendorId, period, { grouped: false })), ...stockValueData(inventory, access) } };
    }
    if (section === 'products') {
      const sort = query.sort == null || query.sort === '' ? 'revenue' : String(query.sort);
      if (!PRODUCT_SORTS.includes(sort)) return fail('invalid_sort', 400, { allowed: PRODUCT_SORTS });
      const q = query.q == null ? '' : String(query.q).trim();
      if (q.length > 80) return fail('invalid_query', 400, { max: 80 });
      const all = period.format === 'csv';
      const limit = query.limit == null || query.limit === '' ? PRODUCTS_PAGE.default : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > PRODUCTS_PAGE.max) return fail('invalid_limit', 400, { max: PRODUCTS_PAGE.max });
      const offset = query.cursor ? decodeOffset(query.cursor) : 0;
      if (offset == null) return fail('invalid_cursor', 400);
      // Days of cover and stock are "now", so a products report is cached only within its closed period key + today.
      const built = await cached(cacheKey(vendorId, section, period, access, { today: eatToday(now()) }), period.closed, async () => {
        const p = await productRows(vendorId, period, access);
        return { sold: p.sold, slow: p.slow, totals: p.totals, head: await head(vendorId, period, { grouped: false }) };
      });
      let list = (sort === 'slow' ? built.slow : built.sold).slice().sort(SORTERS[sort]);
      if (q) list = list.filter(r => String(r.name || '').toLowerCase().includes(q.toLowerCase()));
      const page = all ? list : list.slice(offset, offset + limit);
      return {
        period, all: list.length,
        data: { ...built.head, sort, rows: page, totals: built.totals, slowCount: built.slow.filter(r => r.noSalesInPeriod).length, nextCursor: !all && offset + limit < list.length ? encodeOffset(offset + limit) : null },
      };
    }
    const data = await cached(cacheKey(vendorId, section, period, access), period.closed, async () => {
      const top = await head(vendorId, period, { grouped: GROUPED.has(section) });
      if (section === 'sales') return { ...top, ...(await salesData(vendorId, period)) };
      if (section === 'profit') return { ...top, ...(await profitData(vendorId, period)) };
      if (section === 'marketplace-net') return { ...top, ...(await payoutData(vendorId, period)) };
      if (section === 'payment-methods') return { ...top, ...(await methodsData(vendorId, period)) };
      if (section === 'customers') return { ...top, ...(await customersData(vendorId, period)) };
      return { ...top, ...(await summaryData(vendorId, period, access)) };
    });
    return { period, data };
  }

  /** GET /vendor/reports/summary: one call for the mobile Reports cards, the portal Overview and the PDF. */
  async function summaryData(vendorId, period, access) {
    const [sales, products, methods] = await Promise.all([salesData(vendorId, period), productRows(vendorId, period, access), methodsData(vendorId, period)]);
    const out = {
      sales: { ...sales.totals, buckets: sales.buckets.map(b => ({ start: b.start, end: b.end, netTzs: b.netTzs })) },
      topProducts: products.sold.slice().sort(SORTERS.revenue).slice(0, 5).map(r => ({ productId: r.productId, variant: r.variant, name: r.name, removed: r.removed, unitsSold: r.unitsSold, netRevenueTzs: r.netRevenueTzs })),
      slowCount: products.slow.filter(r => r.noSalesInPeriod).length,
      methods: { byYou: methods.byYou.slice(0, 3), viaFitFlex: methods.viaFitFlex.slice(0, 3) },
      // Kept for the PDF only (top 10, slow 10, all methods); not part of the JSON contract.
      _pdf: { top: products.sold.slice().sort(SORTERS.revenue).slice(0, 10), slow: products.slow.slice().sort(SORTERS.slow).slice(0, 10), methods },
    };
    if (flags.stockLedger()) {
      const s = stockValueData(products.inventory, access);
      out.stock = { atRetailTzs: s.totals.atRetailTzs, units: s.totals.units, ...(access.cost ? { atCostTzs: s.totals.atCostTzs, costUnknownCount: s.costUnknown.count } : {}) };
    }
    if (access.cost) {
      const p = await profitData(vendorId, period);
      out.profit = { profitTzs: p.totals.profitTzs, marginPct: p.totals.marginPct, netExVatTzs: p.totals.netExVatTzs, commissionTzs: p.totals.commissionTzs, costTzs: p.totals.costTzs, uncosted: { qty: p.uncosted.qty, revenueTzs: p.uncosted.revenueTzs } };
    }
    if (access.payout) {
      const p = await payoutData(vendorId, period);
      out.payouts = { grossTzs: p.totals.grossTzs, commissionTzs: p.totals.commissionTzs, payoutTzs: p.totals.payoutTzs, paidOutTzs: p.status.paidOut.payoutTzs, waitingTzs: p.status.waiting.payoutTzs, notDeliveredTzs: p.status.notDelivered.payoutTzs };
    }
    if (access.customers && flags.customers()) {
      const c = await customersData(vendorId, period);
      out.customers = { owedTzs: c.owedTzs, overdueTzs: c.overdueTzs, collectedTzs: c.collectedTzs };
    }
    return out;
  }
  /** The JSON answer of the summary (without the PDF-only extras). */
  const publicSummary = ({ _pdf, ...rest }) => rest;

  // ── exports ───────────────────────────────────────────────────────────────

  const CSV_OF = {
    sales: (d, lang) => salesCsv(d, lang),
    products: (d, lang, a) => productsCsv(d, lang, { cost: a.cost }),
    'stock-value': (d, lang, a) => stockCsv(d, lang, { cost: a.cost }),
    profit: (d, lang) => profitCsv(d, lang),
    'marketplace-net': (d, lang) => payoutsCsv(d, lang),
    customers: (d, lang) => customersCsv(d, lang),
    'payment-methods': (d, lang) => methodsCsv(d, lang),
  };
  async function businessName(vendorId) {
    const vendor = await users.findByIdAsync(vendorId);
    const profile = typeof vendor?.vendorProfile === 'string' ? JSON.parse(vendor.vendorProfile) : vendor?.vendorProfile;
    return profile?.businessName || vendor?.displayName || 'vendor';
  }

  /** A section as CSV. → { csv, fileName, rowCount } | { error: export_too_large, status: 413, maxRows }. */
  async function toCsv(section, result, access, vendorId) {
    const { period, data } = result;
    const table = CSV_OF[section](data, period.lang, access);
    if (table.rows.length > REPORT_LIMITS.maxCsvRows) return fail('export_too_large', 413, { maxRows: REPORT_LIMITS.maxCsvRows, rows: table.rows.length });
    const name = await businessName(vendorId);
    const dated = section === 'stock-value' ? [eatToday(now()), null] : [period.from, period.to];
    return { csv: csvDocument(table.header, table.rows), fileName: reportFileName(name, section, dated[0], dated[1], 'csv'), rowCount: table.rows.length };
  }

  /** One audit row per export (Q-14): who, which section and period, format, and whether cost / payouts were in it. */
  async function recordExport({ actorId, vendorId, section, period, format, access, rows = null }) {
    await auditLog.insertAsync({
      id: randomUUID(), at: now().toISOString(), actor: actorId, action: 'vendor_report_exported', target: vendorId, before: null,
      after: { section, from: period.from, to: period.to, channel: period.channel, format, lang: period.lang, includedCost: Boolean(access.cost) && ['products', 'stock-value', 'profit', 'summary'].includes(section),
        includedPayout: Boolean(access.payout) && ['marketplace-net', 'summary'].includes(section), rows },
    });
  }

  return { report, publicSummary, toCsv, recordExport, businessName, autoGroupBy, resetCache: () => cache.reset(), cacheSize: () => cache.size() };
}
