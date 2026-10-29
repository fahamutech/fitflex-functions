// Vendor business tools · S6 — vendor reports + CSV / PDF export (design spec docs/design/vendor-reports-s6.md).
// Dormant: VENDOR_TOOLS + VENDOR_REPORTS (off → 404 feature_disabled). Permission `reports` (vendor_staff,
// read from the stored, active staff record of the vendor in their token; the vendor account has it).
// No FitFlex admin view in S6 (Q-13). Read only.
// Extra rights (stored accounts, never the token):
//   cost / profit / margin — canSeeCost (vendor account, vendorRole admin). Otherwise the fields are ABSENT and
//     /profit answers 403 cost_not_allowed.
//   App sales after commission — canSeeOrderMoney (vendor, vendorRole admin, staff with `payments`). Otherwise
//     /marketplace-net answers 403 payout_not_allowed and the summary has no `payouts`.
//   Customers — permission `customers` + VENDOR_CUSTOMERS.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { shopService, vendorReportService, users } from '../src/bootstrap/services.mjs';
import { vendorReportsOn, vendorStockLedgerOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { renderReportPdf, pdfGroupBy } from '../src/shared/vendor-report-pdf.mjs';
import { reportFileName } from '../src/shared/vendor-reports.mjs';
import { firstName } from '../src/shared/vendor-documents.mjs';

const created = new Date().toISOString();

/** vendor_staff need `reports` (stored record, active, of the vendor in their token). Sets req.reportAccess. */
async function requireReportAccess(req, res, next) {
  try {
    if (req.user?.userType === 'vendor_staff' && !(await shopService.authorizeStaff(req.user, 'reports'))) {
      return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: 'reports' });
    }
    req.reportAccess = {
      cost: await shopService.canSeeCost(req.user),
      payout: await shopService.canSeeOrderMoney(req.user),
      customers: req.user?.userType === 'vendor' || await shopService.authorizeStaff(req.user, 'customers'),
    };
  } catch (error) {
    console.error('[vendor-reports] staff authorization lookup failed', { staffId: req.user?.sub, error: error.message });
    return res.status(503).json({ error: 'authorization_unavailable' });
  }
  return next();
}
/**
 * Security review #275: the flag is the FIRST guard — with VENDOR_REPORTS off every request (with or without a
 * token) gets 404 feature_disabled before any token check or staff lookup.
 */
function requireReportsOn(req, res, next) {
  if (!vendorReportsOn()) return res.status(404).json({ error: 'feature_disabled' });
  return next();
}
/**
 * Per vendor per minute, in memory per server (as S3–S5): report reads, and a tighter limit for exports
 * (format=csv|pdf), which are heavier and are audited. Over it: 429 rate_limited { retryAfterSeconds } + Retry-After.
 */
export const VENDOR_REPORT_LIMITS = Object.freeze({ readsPerMinute: 120, exportsPerMinute: 10 });
const readLimiter = createVendorLimiter({ perMinute: VENDOR_REPORT_LIMITS.readsPerMinute });
const exportLimiter = createVendorLimiter({ perMinute: VENDOR_REPORT_LIMITS.exportsPerMinute });
export const resetVendorReportLimits = () => { readLimiter.reset(); exportLimiter.reset(); };
function limitReports(req, res, next) {
  const vendorId = vendorOf(req.user);
  const format = String(req.query?.format || 'json');
  if (limitOrNull(readLimiter, vendorId, res)) return undefined;
  if (['csv', 'pdf'].includes(format) && limitOrNull(exportLimiter, vendorId, res)) return undefined;
  return next();
}
const guards = routeGuard('get', [requireReportsOn, requireAuth('vendor', 'vendor_staff'), requireReportAccess, limitReports]);
const vendorOf = user => (user.userType === 'vendor_staff' ? user.vendorId : user.sub);
const setHeader = (res, key, value) => (typeof res.setHeader === 'function' ? res.setHeader(key, value) : res.set?.(key, value));
const send = (res, result) => {
  const { error, status, ...extra } = result;
  return res.status(status).json({ error, ...extra });
};
const safeName = name => String(name).replace(/[^A-Za-z0-9._-]/g, '_');

function sendFile(res, body, type, fileName) {
  setHeader(res, 'Content-Type', type);
  setHeader(res, 'Content-Disposition', `attachment; filename="${safeName(fileName)}"`);
  // The portal (another origin) reads the server's file name: expose it on these responses only, not as a
  // global CORS change.
  setHeader(res, 'Access-Control-Expose-Headers', 'Content-Disposition');
  setHeader(res, 'Cache-Control', 'no-store, private');
  setHeader(res, 'X-Content-Type-Options', 'nosniff');
  res.status(200);
  if (Buffer.isBuffer(body)) {
    setHeader(res, 'Content-Length', String(body.length));
    return typeof res.end === 'function' ? res.end(body) : res.send(body);
  }
  return res.send(body);
}

async function summaryPdf(req, res, vendorId, result) {
  const access = req.reportAccess;
  const { period, data } = result;
  const query = { ...(req.query || {}), format: 'json' };
  const g = pdfGroupBy(period.from, period.to, period.groupBy);
  const sales = await vendorReportService.report('sales', { vendorId, access, query: { ...query, groupBy: g } });
  const stock = vendorStockLedgerOn() ? (await vendorReportService.report('stock-value', { vendorId, access, query: { lang: period.lang } })).data : null;
  const payouts = access.payout ? (await vendorReportService.report('marketplace-net', { vendorId, access, query })).data : null;
  const me = await users.findByIdAsync(req.user.sub);
  const businessName = await vendorReportService.businessName(vendorId);
  const pdf = await renderReportPdf({
    summary: data, salesRows: sales.data.buckets, stock, payoutWeeks: payouts?.weeks || null, businessName,
    generatedBy: firstName(me?.displayName), lang: period.lang,
  });
  await vendorReportService.recordExport({ actorId: req.user.sub, vendorId, section: 'summary', period, format: 'pdf', access });
  return sendFile(res, pdf, 'application/pdf', reportFileName(businessName, 'report', period.from, period.to, 'pdf'));
}

const COMMON = 'Query: from, to (EAT dates YYYY-MM-DD, inclusive; both or neither — neither = this month so far), lang en|sw (CSV headers / PDF), format.';
const ERRORS = 'Errors: 404 feature_disabled (VENDOR_TOOLS + VENDOR_REPORTS off; checked before the token), 429 rate_limited { retryAfterSeconds } + Retry-After (per vendor: 120 report calls a minute, 10 CSV/PDF exports a minute), 403 vendor_permission_forbidden { requiredPermission: reports }, 400 invalid_range { reason: from_and_to_required | invalid_date | future | to_before_from | too_long, maxDays: 366 } | invalid_channel | invalid_format | invalid_lang | invalid_group_by | too_many_buckets { max: 120 }, 413 export_too_large { maxRows: 50000 } (CSV).';
const HEAD = 'Every JSON answer starts with { from, to, channel, groupBy? (grouped reports), generatedAt (ISO; "Updated {time}"), timezone: Africa/Dar_es_Salaam, inProgress (the period includes today: "(so far)"), channels: { app: true, walkIn (VENDOR_WALKIN_SALES on, or walk-in sales exist in the period) }, hasEverSold (this vendor has ever recorded a walk-in sale or had a paid app order: false → show the first-use state; always fresh, never cached) }. Units (itemsSold, unitsSold, uncosted qty) are net of refunds on the same dates as the money: a paid app order cancelled later takes its units off on its cancellation date. Closed periods (to before today) may be served from a 10-minute server cache.';
const CSV = 'format=csv → text/csv; charset=utf-8, attachment {business-slug}_{section}_{from}_{to}.csv (Content-Disposition, exposed to the browser by Access-Control-Expose-Headers): UTF-8 with BOM, CRLF, header row in the chosen language, money columns end "(TZS)", raw integers, dates YYYY-MM-DD (EAT), formula-injection safe; cost/payout columns only when allowed; every export writes one audit row (vendor_report_exported).';

const DESCRIPTIONS = {
  summary: `Overview: one call for the mobile Reports cards and the portal Overview. ${COMMON} channel all|app|walk_in, groupBy day|week|month (auto: ≤31 days day, ≤26 weeks week, else month), format json|pdf. → { …head, sales { grossTzs, discountTzs, refundTzs, netTzs, vatIncludedTzs, saleCount (shop receipts), orderCount (app orders), itemsSold, voided { count, totalTzs }, buckets [{ start, end, netTzs }] }, topProducts [≤5 { productId, variant|null, name, removed, unitsSold, netRevenueTzs }], slowCount, methods { byYou [≤3], viaFitFlex [≤3] }, stock? { atRetailTzs, units, atCostTzs?, costUnknownCount? } (VENDOR_STOCK_LEDGER; cost keys only with canSeeCost), profit? { profitTzs, marginPct|null, netExVatTzs, commissionTzs, costTzs, uncosted { qty, revenueTzs } } (canSeeCost), payouts? { grossTzs, commissionTzs, payoutTzs, paidOutTzs, waitingTzs, notDeliveredTzs } (canSeeOrderMoney), customers? { owedTzs, overdueTzs, collectedTzs } (customers + VENDOR_CUSTOMERS) }. format=pdf → application/pdf attachment {business-slug}_report_{from}_{to}.pdf (Content-Disposition exposed by Access-Control-Expose-Headers; A4, tables, only permitted sections, tagged with lang; 503 pdf_unavailable). No CSV for the overview.`,
  sales: `Sales by period and channel. ${COMMON} channel, groupBy, format json|csv. App orders count on their PAID date; a paid app order cancelled later is a refund on its cancellation date (the paid day is unchanged); walk-in sales on soldAt (late/offline sales change past days); voided sales are in no total (voided { count, totalTzs }). → { …head, totals { grossTzs, discountTzs, refundTzs, netTzs (= gross − discounts − refunds), vatIncludedTzs (inside net), saleCount, orderCount, itemsSold, voided }, byChannel { app, walkIn: { grossTzs, discountTzs, refundTzs, netTzs, vatIncludedTzs, count, itemsSold } }, buckets [{ start, end, netTzs, app {…}, walkIn {…} }] } — every bucket of the period, empty ones included; Σ buckets = totals.`,
  products: `Best / most units / slow sellers. ${COMMON} channel, sort revenue (default) | units | slow, q (name contains, ≤80), limit 1–200 (default 50), cursor, format json|csv (csv: every row). → { …head, sort, rows [{ productId, variant|null, name, removed, unitsSold, appUnits, walkInUnits, netRevenueTzs, lastSoldAt|null (ever), stock|null (null = not tracked), avgDailyUnits30, daysOfCover|null (0 = less than 1 day), coverState ok|soon (≤7 days)|none (no sales in 30 days)|out|untracked, noSalesInPeriod, profitTzs?|null, marginPct?|null (canSeeCost only; null = no line of the product had a cost price — never 0) }], totals { unitsSold, netRevenueTzs } (= sales itemsSold / netTzs), slowCount, nextCursor|null }. Days of cover use the last 30 days (both channels), whatever the period. slow = products in stock, fewest units first (including none).`,
  'stock-value': `Stock value as of NOW (the period does not apply; VENDOR_STOCK_LEDGER, else 404 feature_disabled). lang, format json|csv. → { …head, asOf, totals { atRetailTzs, units, products, atCostTzs? }, costUnknown? { count, units, retailTzs }, rows [{ productId, variant|null, name, stock, priceTzs (selling price), valueAtRetailTzs, costTzs?|null, valueAtCostTzs?|null }] } — cost keys only with canSeeCost; products with stock 0 left out; one row per variant when variants keep their own stock. Cost unknown is never 0: those rows are not in atCostTzs.`,
  profit: `Profit (canSeeCost, else 403 cost_not_allowed). ${COMMON} channel, groupBy, format json|csv. Profit = net ex-VAT − commission (app) − cost, on lines with a cost price ONLY; lines without one are reported apart and never counted as cost 0. A bucket, channel or period with no costed line has profitTzs: null and marginPct: null. → { …head, totals { netExVatTzs, commissionTzs, costTzs, profitTzs, marginPct|null (one decimal) }, uncosted { lineCount, qty, revenueTzs, netExVatTzs }, hasVat, buckets [{ start, end, netExVatTzs, commissionTzs, costTzs, profitTzs, marginPct, uncostedRevenueTzs }], byChannel { app, walkIn }, byProduct [{ productId, variant, name, removed, units, netExVatTzs, commissionTzs, costTzs, profitTzs, marginPct }], uncostedProducts [{ productId, variant, name, removed, units, revenueTzs }] }. A cancelled paid app order reverses its revenue, commission and cost on the cancellation date.`,
  'marketplace-net': `App sales after commission (canSeeOrderMoney, else 403 payout_not_allowed). App orders only, by DELIVERY date — the same rules as payout statements. from, to, lang, format json|csv (channel ignored). → { …head, basis: delivered, totals { orderCount, grossTzs, commissionTzs, payoutTzs } (delivered in the period), status { notDelivered (paid in the period, not delivered yet), waiting (delivered, not paid out), paidOut: { orders, grossTzs, commissionTzs, payoutTzs } }, weeks [{ periodStartDate, periodEndDate (Mon–Sun EAT), orderCount, grossTzs, commissionTzs, payoutTzs, paidOut, statement { id, status, finalNetTzs }|null }] }. statement is set only for statements the vendor can see (submitted, approved, payable, paid); such a row is that statement's week with the statement's own figures, so a statement wholly inside the period matches its salesTzs / commissionTzs / finalNetTzs. Draft statements show as null (Not on a statement yet). Read only: the payout engine is not involved.`,
  customers: `Customers and money owed (permission customers + VENDOR_CUSTOMERS; else 403 vendor_permission_forbidden { requiredPermission: customers } / 404 feature_disabled). from, to, lang, format json|csv. → { …head, asOf (EAT day), owedTzs, overdueTzs, aging { current, d1_30, d31_60, d61_90, d90plus } (now, same as S4 Owed to you), creditSales { count, totalTzs } (pay-later sales in the period), collectedTzs (customer payments received in the period), buyers { shop, app } (distinct customers who bought — counts only, no names) }.`,
  refunds: `Refunds on walk-in sales (credit notes, S7). Until S7 ships there are none: → { …head, rows: [] }. from, to, lang, format json|csv (CSV: header row only). Same guards as every report.`,
  'payment-methods': `Payment methods. ${COMMON} channel, format json|csv. → { …head, byYou [{ method, amountTzs, count, sharePct }] (walk-in: sale payments on the sale date, cash after change, + customer payments on their received date; never money owed), viaFitFlex [{ paymentMethod, amountTzs, count, sharePct }] (app orders on their paid date, this vendor's lines) } — two groups, never added together; sharePct per group (one decimal).`,
};

function route(section) {
  return {
    created, method: 'get', path: `/vendor/reports/${section}`,
    description: `Vendor / staff with \`reports\` (VENDOR_TOOLS + VENDOR_REPORTS). ${DESCRIPTIONS[section]} ${HEAD} ${section === 'summary' ? '' : CSV} ${ERRORS}`,
    onGuard: guards,
    onRequest: async (req, res) => {
      if (!vendorReportsOn()) return res.status(404).json({ error: 'feature_disabled' });
      const vendorId = vendorOf(req.user);
      const access = req.reportAccess;
      const result = await vendorReportService.report(section, { vendorId, access, query: req.query || {} });
      if (result.error) return send(res, result);
      setHeader(res, 'Cache-Control', 'no-store, private');
      if (result.period.format === 'pdf') {
        try { return await summaryPdf(req, res, vendorId, result); } catch (error) {
          if (error.code === 'pdf_unavailable') return res.status(503).json({ error: 'pdf_unavailable' });
          throw error;
        }
      }
      if (result.period.format === 'csv') {
        const file = await vendorReportService.toCsv(section, result, access, vendorId);
        if (file.error) return send(res, file);
        await vendorReportService.recordExport({ actorId: req.user.sub, vendorId, section, period: result.period, format: 'csv', access, rows: file.rowCount });
        return sendFile(res, file.csv, 'text/csv; charset=utf-8', file.fileName);
      }
      return res.json(section === 'summary' ? vendorReportService.publicSummary(result.data) : result.data);
    },
  };
}

export const vendorReportSummary = route('summary');
export const vendorReportSales = route('sales');
export const vendorReportProducts = route('products');
export const vendorReportStockValue = route('stock-value');
export const vendorReportProfit = route('profit');
export const vendorReportMarketplaceNet = route('marketplace-net');
export const vendorReportCustomers = route('customers');
export const vendorReportPaymentMethods = route('payment-methods');
export const vendorReportRefunds = route('refunds');
/** For specs: forget cached closed periods. */
export const resetVendorReportCache = () => vendorReportService.resetCache();
