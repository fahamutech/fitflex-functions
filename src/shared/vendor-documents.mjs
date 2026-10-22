// Vendor documents (vendor business tools · S5). Pure functions: no storage.
//
// Decisions (design spec docs/design/vendor-documents-s5.md, recommendations applied 2026-10-20, except Q-1,
// Q-10 and Q-12 which are open with the owner / counsel):
// - O-5: a share link is a 128-bit random token (22 base64url characters), returned once; only its SHA-256
//   is stored. No expiry; revocable.
// - Q-1: links need PUBLIC_API_URL. Unset → 503 public_url_not_configured; there is NO fallback host.
// - Q-2: a voided document's links keep working and show "Cancelled" (never the reason). No new links.
// - Q-9: a statement link is a frozen snapshot "as of" the share time.
// - Privacy (§0 ground rules, A-02): a document never carries the customer's phone, email or address,
//   buyerUserId, cost price, commission, payout, internal note, void reason or a staff surname. App
//   buyers appear by display name only. `documentJson` builds the document from an allowlist.
// - "This is not a TRA fiscal receipt." on every document until S10.
// - Money reads "TSh 95,000"; dates are the EAT calendar; Swahili time is the apps' rule (glossary §5a, owner
//   2026-10-04; fitflexmobile lib/shared/formatters.dart): a 12-hour clock + the part of the day, "2:05 mchana".
// Every Swahili string here is a DRAFT for native review; legal-ish wording (soldVia, notFiscal) is a
// draft pending Tanzanian counsel (Q-12).
import { randomBytes, createHash } from 'node:crypto';
import { formatTsh } from './money-display.mjs';
import { vatSummary } from './vendor-vat.mjs';

export const LINK_DOC_TYPES = ['receipt', 'invoice', 'payment_receipt', 'statement', 'order_invoice', 'credit_note'];
export const LANGS = ['en', 'sw'];
export const PAPERS = ['a4', '80mm'];
export const TOKEN_BYTES = 16;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const INVOICE_DOC_TYPE = 'invoice';
export const invoiceNumber = seq => `INV-${String(seq).padStart(6, '0')}`;
export const SMS_MAX = 160;
export const SMS_BUSINESS_MAX = 24;

/** A new share token (22 base64url characters, 128 bits) and the hash that is stored. */
export function newToken() {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}
export const hashToken = token => createHash('sha256').update(String(token)).digest('hex');
export const validToken = token => typeof token === 'string' && TOKEN_PATTERN.test(token);
export const langOf = (value, fallback = 'en') => (LANGS.includes(value) ? value : fallback);

/**
 * PUBLIC_API_URL as an origin + path without a trailing slash, or null when unset/invalid (Q-1: no fallback).
 * https only (security review #229 L4); plain http is accepted only while NODE_ENV=test (local UAT).
 */
export function publicBaseUrl(raw = process.env.PUBLIC_API_URL, { nodeEnv = process.env.NODE_ENV } = {}) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && nodeEnv === 'test')) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

// ── labels (EN + SW; SW drafts for native review) ───────────────────────────

export const DOC_LABELS = {
  en: {
    receipt: 'Receipt', invoice: 'Invoice', payment_receipt: 'Payment receipt', statement: 'Statement', order_invoice: 'Invoice', credit_note: 'Credit note',
    saleRef: 'Sale ref {number}', orderRef: 'Order {ref}', forReceipt: 'For receipt {number}', date: 'Date', customer: 'Customer: {name}',
    servedBy: 'Served by {name}', dueBy: 'Due by {date}', soldVia: 'Seller: {business}. Sold through the FitFlex app.', paidBy: 'Paid by {method}',
    statusCancelledOrder: 'Cancelled', cancelledOrder: 'Cancelled on {date}. This order was cancelled.', watermarkOrder: 'CANCELLED · IMEGHAIRIWA',
    item: 'Item', qty: 'Qty', price: 'Price', discount: 'Discount', amount: 'Amount', vat: 'VAT', subtotal: 'Subtotal', discounts: 'Discounts', total: 'Total',
    includesVat: 'Includes VAT {amount}', vatSummary: 'VAT summary', vatCode: 'Code', vatRate: 'Rate', vatNet: 'Before VAT', exempt: 'Exempt', zeroRated: 'Zero-rated',
    payments: 'Payments', change: 'Change', paidNow: 'Paid now', statusOn: 'Status on {date}', balanceDue: 'Balance due', paidInFull: 'Paid in full on {date}',
    paidWith: 'Paid with {numbers}', paidTowards: 'Paid towards', stillOwed: 'Still owed', asOf: 'As of {date}', openSales: 'Unpaid pay-later sales',
    recentPayments: 'Payments (last 90 days)', totalOwed: 'Total owed', daysOverdue: '{n} days overdue', sold: 'Sold', due: 'Due', balance: 'Balance',
    statusPaid: 'Paid', statusPayLater: 'Pay later', statusPaidInFull: 'Paid in full', statusCancelled: 'Cancelled',
    cancelled: 'Cancelled on {date}. {business} cancelled this document.', watermark: 'CANCELLED · IMEBATILISHWA',
    refunded: 'Refunded {amount} by {method}', receivedBy: 'Payment received by {business}.', notFiscal: 'This is not a TRA fiscal receipt.',
    copyNote: 'This is a copy of a document issued by {business}.', pageOf: 'Page {n} of {m}', langEn: 'English', langSw: 'Kiswahili',
    unavailableTitle: "This link isn't available", unavailableBody: 'The seller may have turned it off. Ask them to send it again.',
    // UAT D7: a short heading (also the tab title) and one sentence below it, so nothing reads twice.
    rateLimitedTitle: 'Too many requests', rateLimited: 'Try again in a minute.',
    serverErrorTitle: 'Something went wrong', serverError: 'Try again later.',
    pdfFailedTitle: 'PDF not available', pdfFailedPage: "The PDF couldn't be made. You can still view the page.", backToPage: 'Back to the document', downloadPdf: 'Download PDF',
    tin: 'TIN {tin}', vrn: 'VRN {vrn}', aging: 'Not due yet {current} · 1–30 days {d1_30} · 31–60 days {d31_60} · 61–90 days {d61_90} · Over 90 days {d90plus}',
    waText: '{business}: {title} {number}, {amount}. View it here: {url}', smsText: '{business} {title} {number} {amount}: {url}',
    method: { cash: 'Cash', mpesa: 'M-Pesa', airtel_money: 'Airtel Money', mixx: 'Mixx by Yas', halopesa: 'HaloPesa', card: 'Card', bank: 'Bank', other: 'Other' },
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  sw: {
    receipt: 'Risiti', invoice: 'Ankara', payment_receipt: 'Risiti ya malipo', statement: 'Taarifa ya akaunti', order_invoice: 'Ankara', credit_note: 'Hati ya marejesho',
    saleRef: 'Kumb. ya mauzo {number}', orderRef: 'Oda {ref}', forReceipt: 'Kwa risiti {number}', date: 'Tarehe', customer: 'Mteja: {name}',
    servedBy: 'Mhudumu: {name}', dueBy: 'Tarehe ya mwisho ya kulipa: {date}', soldVia: 'Muuzaji: {business}. Imeuzwa kupitia app ya FitFlex.', paidBy: 'Imelipwa kwa {method}',
    // A cancelled ORDER is "imeghairiwa"; a voided sale or payment stays "imebatilishwa" (Swahili audit #229).
    statusCancelledOrder: 'Imeghairiwa', cancelledOrder: 'Imeghairiwa tarehe {date}. Oda hii imeghairiwa.', watermarkOrder: 'CANCELLED · IMEGHAIRIWA',
    item: 'Bidhaa', qty: 'Idadi', price: 'Bei', discount: 'Punguzo', amount: 'Kiasi', vat: 'VAT', subtotal: 'Jumla ndogo', discounts: 'Mapunguzo', total: 'Jumla',
    includesVat: 'Inajumuisha VAT {amount}', vatSummary: 'Muhtasari wa VAT', vatCode: 'Msimbo', vatRate: 'Kiwango', vatNet: 'Kabla ya VAT', exempt: 'Msamaha', zeroRated: 'Kiwango sifuri',
    payments: 'Malipo', change: 'Chenji', paidNow: 'Imelipwa sasa', statusOn: 'Hali kufikia {date}', balanceDue: 'Kiasi kinachodaiwa', paidInFull: 'Imelipwa yote tarehe {date}',
    paidWith: 'Imelipwa kwa {numbers}', paidTowards: 'Imelipia', stillOwed: 'Bado anadaiwa', asOf: 'Kufikia {date}', openSales: 'Mauzo ya mkopo ambayo hayajalipwa',
    recentPayments: 'Malipo (siku 90 zilizopita)', totalOwed: 'Jumla inayodaiwa', daysOverdue: 'Imechelewa siku {n}', sold: 'Imeuzwa', due: 'Mwisho wa kulipa', balance: 'Salio',
    statusPaid: 'Imelipwa', statusPayLater: 'Mkopo', statusPaidInFull: 'Imelipwa yote', statusCancelled: 'Imebatilishwa',
    cancelled: 'Imebatilishwa tarehe {date}. {business} imebatilisha hati hii.', watermark: 'CANCELLED · IMEBATILISHWA',
    refunded: 'Imerejeshwa {amount} kwa {method}', receivedBy: 'Malipo yamepokelewa na {business}.', notFiscal: 'Hii si risiti ya kodi ya TRA.',
    copyNote: 'Hii ni nakala ya hati iliyotolewa na {business}.', pageOf: 'Ukurasa {n} kati ya {m}', langEn: 'English', langSw: 'Kiswahili',
    unavailableTitle: 'Kiungo hiki hakipatikani', unavailableBody: 'Huenda muuzaji amekizima. Mwombe akutumie tena.',
    rateLimitedTitle: 'Maombi ni mengi mno', rateLimited: 'Jaribu tena baada ya dakika moja.',
    serverErrorTitle: 'Kuna hitilafu', serverError: 'Jaribu tena baadaye.',
    pdfFailedTitle: 'PDF haipatikani', pdfFailedPage: 'Imeshindikana kutengeneza PDF. Bado unaweza kuona ukurasa.', backToPage: 'Rudi kwenye hati', downloadPdf: 'Pakua PDF',
    tin: 'TIN {tin}', vrn: 'VRN {vrn}', aging: 'Bado muda haujafika {current} · Siku 1–30 {d1_30} · Siku 31–60 {d31_60} · Siku 61–90 {d61_90} · Zaidi ya siku 90 {d90plus}',
    waText: '{business}: {title} {number}, {amount}. Itazame hapa: {url}', smsText: '{business} {title} {number} {amount}: {url}',
    method: { cash: 'Taslimu', mpesa: 'M-Pesa', airtel_money: 'Airtel Money', mixx: 'Mixx by Yas', halopesa: 'HaloPesa', card: 'Kadi', bank: 'Benki', other: 'Nyingine' },
    months: ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ago', 'Sep', 'Okt', 'Nov', 'Des'],
  },
};

/** "{a} and {b}" templating; missing values become ''. */
export const fill = (template, values = {}) => String(template).replace(/\{(\w+)\}/g, (_, k) => (values[k] == null ? '' : String(values[k])));
export const label = (lang, key, values) => fill(DOC_LABELS[langOf(lang)][key] ?? DOC_LABELS.en[key] ?? key, values);
export const methodLabel = (lang, method) => DOC_LABELS[langOf(lang)].method[method] || method;
export const money = amount => formatTsh(amount);
/** A discount: "-TSh 1,500" (UAT D4: discounts read like every other amount). */
export const minusMoney = amount => `-${formatTsh(amount)}`;

// ── dates (EAT, UTC+3, no daylight saving) ──────────────────────────────────

const EAT_MS = 3 * 3_600_000;
const parts = (instant) => {
  const d = new Date(+new Date(instant) + EAT_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes() };
};
/** The part of the day — the apps' rule (fitflexmobile lib/shared/formatters.dart `_swDayPeriod`). */
export function swahiliDayPeriod(h) {
  if (h >= 5 && h < 12) return 'asubuhi';
  if (h >= 12 && h < 16) return 'mchana';
  if (h >= 16 && h < 19) return 'jioni';
  return 'usiku';
}
/**
 * Swahili time of day as the apps write it (glossary §5a, owner 2026-10-04; formatters.dart
 * `formatTimeOfDay`): a 12-hour clock with the part of the day — 14:05 → "2:05 mchana", 05:30 →
 * "5:30 asubuhi", 00:15 → "12:15 usiku". Not the six-hour Swahili offset. Draft for native review.
 */
export function swahiliTime(h, min) {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, '0')} ${swahiliDayPeriod(h)}`;
}
/** "19 Oct 2026" / "19 Okt 2026" for an instant, or for a YYYY-MM-DD day. */
export function formatDay(value, lang = 'en') {
  if (value == null) return '';
  const months = DOC_LABELS[langOf(lang)].months;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return `${d} ${months[m - 1]} ${y}`;
  }
  const p = parts(value);
  return `${p.day} ${months[p.m]} ${p.y}`;
}
/** "19 Oct 2026, 14:05" / "19 Okt 2026, 2:05 mchana" (EAT). */
export function formatDateTime(instant, lang = 'en') {
  if (instant == null) return '';
  const p = parts(instant);
  const time = langOf(lang) === 'sw' ? swahiliTime(p.h, p.min) : `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
  return `${formatDay(instant, lang)}, ${time}`;
}
export const eatDay = instant => new Date(+new Date(instant) + EAT_MS).toISOString().slice(0, 10);

/** The first word of a person's display name (§4.1: "Served by {first name}" — never a surname). */
export const firstName = name => (typeof name === 'string' && name.trim() ? name.trim().split(/\s+/)[0] : null);

/** A vendor address (string, or { line1, line2, area, city, region }) as one line. */
export function addressLine(address) {
  if (address == null) return null;
  if (typeof address === 'string') return address.trim() || null;
  if (typeof address === 'object') {
    const bits = ['line1', 'line2', 'street', 'area', 'district', 'city', 'region'].map(k => address[k]).filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
    return bits.length ? bits.join(', ') : null;
  }
  return null;
}

/** A slug of the business name for file names: lower case, a–z0–9 and dashes, ≤ 40. */
export const slug = text => (String(text || 'document').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'document');

/** §8.1 file name: {number}_{business-slug}.pdf; statement: statement_{customer-initials}_{YYYY-MM-DD}.pdf (no full name). */
export function pdfFileName(doc) {
  if (doc.docType === 'statement') {
    const initials = String(doc.customer?.name || '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4) || 'X';
    return `statement_${initials}_${eatDay(doc.statement?.asOf || doc.issuedAt)}.pdf`;
  }
  return `${doc.number}_${slug(doc.seller?.businessName)}.pdf`;
}

// ── document JSON (allowlist) ───────────────────────────────────────────────

const seller = s => ({
  businessName: s?.businessName ?? null, logoUrl: s?.logoUrl ?? null, address: addressLine(s?.address), contactNumber: s?.contactNumber ?? null,
  ...(s?.tin ? { tin: s.tin } : {}), ...(s?.vrn ? { vrn: s.vrn } : {}),
});
const vatBlock = (lines) => {
  const summary = vatSummary(lines);
  return { vatIncludedTzs: summary.totalVatTzs, vatSummary: summary.rows };
};

/**
 * A walk-in sale (cash receipt or credit invoice) as a document. `src` comes from the document store:
 * { sale (row), lines (rows), payments (rows), customer { name, forgotten }|null, servedByName, allocations
 *   [{ number, amountTzs, receivedOn, voided }], seller (snapshot or current profile), today }.
 */
export function saleDocument(src, lang = 'en') {
  const s = src.sale;
  const credit = s.kind === 'credit';
  const voided = s.status === 'voided';
  const applied = src.lines.some(l => l.vatCode);
  const lines = [...src.lines].sort((a, b) => a.lineNo - b.lineNo);
  const live = src.allocations.filter(a => !a.voided);
  const doc = {
    docType: credit ? 'invoice' : 'receipt',
    number: credit ? s.invoiceNumber || s.number : s.number,
    ...(credit && s.invoiceNumber ? { saleRef: s.number } : {}),
    status: voided ? 'cancelled' : !credit ? 'paid' : s.balanceTzs > 0 ? 'pay_later' : 'paid_in_full',
    issuedAt: new Date(s.soldAt).toISOString(),
    lang: langOf(lang),
    seller: seller(src.seller),
    ...(src.customer?.name ? { customer: { name: src.customer.name } } : {}),
    ...(firstName(src.servedByName) ? { servedBy: { firstName: firstName(src.servedByName) } } : {}),
    ...(credit && s.dueDate ? { dueDate: s.dueDate } : {}),
    lines: lines.map(l => ({
      name: l.nameSnapshot, variant: l.variant || null, qty: l.qty, unitPriceTzs: l.unitPriceTzs, discountTzs: l.discountTzs, amountTzs: l.lineTotalTzs,
      ...(applied && l.vatCode ? { vatCode: l.vatCode } : {}),
    })),
    subtotalTzs: s.subtotalTzs,
    discountsTzs: s.lineDiscountTzs + s.discountTzs,
    totalTzs: s.totalTzs,
    ...(applied
      ? vatBlock(lines.map(l => ({ vatCode: l.vatCode, vatRatePct: Number(l.vatRatePct), vatTzs: l.vatTzs, netTzs: l.lineTotalTzs - l.saleDiscountShareTzs })))
      : { vatIncludedTzs: 0, vatSummary: [] }),
    payments: [...src.payments].sort((a, b) => a.position - b.position).map(p => ({ method: p.method, ...(p.reference ? { reference: p.reference } : {}), amountTzs: p.amountTzs })),
    changeTzs: s.changeTzs,
    ...(credit ? {
      paidNowTzs: s.paidTzs - (s.allocatedTzs || 0),
      liveStatus: {
        asOf: src.today,
        balanceTzs: voided ? 0 : s.balanceTzs,
        ...(s.balanceTzs === 0 && !voided && live.length ? { paidInFullAt: [...live].sort((a, b) => (a.receivedOn < b.receivedOn ? -1 : 1)).pop().receivedOn } : {}),
        paidWith: live.map(a => a.number),
      },
    } : {}),
    ...(voided ? { cancelledAt: new Date(s.voidedAt).toISOString() } : {}),
  };
  return doc;
}

/**
 * A customer payment (PMT receipt). src: { payment (row), customer { name }, receivedByName, allocations
 * [{ number (INV or R), amountTzs }], stillOwedTzs (Σ current balances of the sales it paid towards), seller }.
 */
export function paymentDocument(src, lang = 'en') {
  const p = src.payment;
  const voided = p.status === 'voided';
  return {
    docType: 'payment_receipt',
    number: p.number,
    status: voided ? 'cancelled' : 'paid',
    issuedAt: new Date(p.createdAt).toISOString(),
    receivedOn: p.receivedOn,
    lang: langOf(lang),
    seller: seller(src.seller),
    ...(src.customer?.name ? { customer: { name: src.customer.name } } : {}),
    ...(firstName(src.receivedByName) ? { servedBy: { firstName: firstName(src.receivedByName) } } : {}),
    lines: [],
    subtotalTzs: p.amountTzs, discountsTzs: 0, totalTzs: p.amountTzs, vatIncludedTzs: 0, vatSummary: [],
    payments: [{ method: p.method, ...(p.reference ? { reference: p.reference } : {}), amountTzs: p.amountTzs }],
    changeTzs: 0,
    paidTowards: src.allocations.map(a => ({ number: a.number, amountTzs: a.amountTzs })),
    stillOwedTzs: voided ? null : src.stillOwedTzs,
    ...(voided ? { cancelledAt: new Date(p.voidedAt).toISOString() } : {}),
  };
}

/** The frozen statement (Q-9): what is stored in the link's snapshot and rendered. src from the store. */
export function statementSnapshot(src) {
  return {
    asOf: new Date(src.asOf).toISOString(),
    today: src.today,
    customer: { name: src.customer?.name ?? null },
    openSales: src.openSales.map(s => ({ number: s.invoiceNumber || s.number, soldAt: s.soldAt, dueDate: s.dueDate, totalTzs: s.totalTzs, balanceTzs: s.balanceTzs, daysOverdue: s.daysOverdue })),
    recentPayments: src.payments.map(p => ({ number: p.number, receivedOn: p.receivedOn, method: p.method, amountTzs: p.amountTzs })),
    totalOwedTzs: src.owedTzs,
    aging: src.aging,
    seller: src.seller,
  };
}
export function statementDocument(snapshot, lang = 'en') {
  return {
    docType: 'statement',
    number: null,
    status: null,
    issuedAt: snapshot.asOf,
    lang: langOf(lang),
    seller: seller(snapshot.seller),
    ...(snapshot.customer?.name ? { customer: { name: snapshot.customer.name } } : {}),
    lines: [], subtotalTzs: snapshot.totalOwedTzs, discountsTzs: 0, totalTzs: snapshot.totalOwedTzs, vatIncludedTzs: 0, vatSummary: [], payments: [], changeTzs: 0,
    statement: {
      asOf: snapshot.asOf, openSales: snapshot.openSales, recentPayments: snapshot.recentPayments, totalOwedTzs: snapshot.totalOwedTzs, aging: snapshot.aging,
    },
  };
}

/**
 * A vendor's part of a paid app order. src: { invoice (VendorOrderInvoice row), order { id, status,
 * paymentStatus, cancelledAt|null }, buyerName|null }. Only that vendor's lines; never commission or payout.
 */
export function orderInvoiceDocument(src, lang = 'en') {
  const inv = src.invoice;
  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  const cancelled = Boolean(src.order.cancelled);
  return {
    docType: 'order_invoice',
    number: inv.number,
    orderShortRef: String(src.order.id || '').slice(-6).toUpperCase(),
    status: cancelled ? 'cancelled' : 'paid',
    issuedAt: new Date(inv.issuedAt).toISOString(),
    lang: langOf(lang),
    seller: seller(inv.sellerSnapshot),
    soldVia: label(lang, 'soldVia', { business: inv.sellerSnapshot?.businessName || '' }),
    ...(src.buyerName ? { customer: { name: src.buyerName } } : {}),
    lines: lines.map(l => ({
      name: l.name, variant: l.variant || null, qty: l.qty, unitPriceTzs: l.unitPriceTzs, discountTzs: 0, amountTzs: l.amountTzs,
      ...(inv.vatApplied && l.vatCode ? { vatCode: l.vatCode } : {}),
    })),
    subtotalTzs: inv.subtotalTzs,
    discountsTzs: 0,
    totalTzs: inv.totalTzs,
    ...(inv.vatApplied
      ? vatBlock(lines.map(l => ({ vatCode: l.vatCode, vatRatePct: Number(l.vatRatePct), vatTzs: l.vatTzs, netTzs: l.amountTzs })))
      : { vatIncludedTzs: 0, vatSummary: [] }),
    payments: [],
    paymentMethod: inv.paymentMethod ?? null,
    changeTzs: 0,
    ...(cancelled ? { cancelledAt: src.order.cancelledAt ? new Date(src.order.cancelledAt).toISOString() : null } : {}),
  };
}

/** The document's title in a language: "Receipt", "Ankara", … */
export const titleOf = (doc, lang) => label(lang, doc.docType);

/** Status label key; a cancelled app ORDER reads "Imeghairiwa", a voided sale/payment "Imebatilishwa". */
export const STATUS_KEYS = { paid: 'statusPaid', pay_later: 'statusPayLater', paid_in_full: 'statusPaidInFull', cancelled: 'statusCancelled' };
export const statusKeyOf = doc => (doc.status === 'cancelled' && doc.docType === 'order_invoice' ? 'statusCancelledOrder' : STATUS_KEYS[doc.status]);
/** The cancelled banner and watermark for a document (order: "imeghairiwa"; sale/payment: "imebatilishwa"). */
export function cancelledBanner(doc, lang) {
  const date = doc.cancelledAt ? formatDay(doc.cancelledAt, lang) : '';
  return doc.docType === 'order_invoice' ? label(lang, 'cancelledOrder', { date }) : label(lang, 'cancelled', { date, business: doc.seller?.businessName || '' });
}
export const watermarkOf = doc => DOC_LABELS.en[doc.docType === 'order_invoice' ? 'watermarkOrder' : 'watermark'];

// ── GSM-7 (SMS) ─────────────────────────────────────────────────────────────

const GSM_BASIC = new Set([...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà']);
const GSM_EXTENDED = new Set([...'^{}\\[~]|€']);
const GSM_REPLACE = [[/[‘’‚‛′]/g, "'"], [/[“”„‟″]/g, '"'], [/[–—―−]/g, '-'], [/…/g, '...'], [/[\u00A0\u2000-\u200B\u202F]/g, ' ']];
/**
 * Text that stays in the GSM-7 alphabet (Swahili audit #229 item 12): curly quotes and dashes become
 * straight ones, the ellipsis three dots, and anything else outside GSM-7 (emoji, other scripts) is removed.
 */
export function gsmSafe(text) {
  let s = String(text ?? '');
  for (const [re, to] of GSM_REPLACE) s = s.replace(re, to);
  return [...s].filter(c => GSM_BASIC.has(c) || GSM_EXTENDED.has(c)).join('').replace(/ {2,}/g, ' ').trim();
}
/** GSM-7 length (extension characters take 2), or null when the text is not GSM-7 at all. */
export function gsmLength(text) {
  let n = 0;
  for (const c of String(text)) {
    if (GSM_BASIC.has(c)) n += 1;
    else if (GSM_EXTENDED.has(c)) n += 2;
    else return null;
  }
  return n;
}

// ── share texts (§2.5; the client never builds them) ────────────────────────

/** The amount a share message names: total owed for a statement, else the total. */
const shareAmount = doc => (doc.docType === 'statement' ? doc.statement?.totalOwedTzs ?? doc.totalTzs : doc.totalTzs);

/**
 * WhatsApp and SMS texts in one language. SMS stays one GSM-7 segment (≤ 160) where possible: the business
 * name is first made GSM-safe (gsmSafe: straight quotes, no emoji — any non-GSM character would turn the
 * whole SMS into UCS-2, 70 per segment), cut to 24 characters with "..." (three dots: "…" is not GSM-7),
 * then the amount is left out if still too long. Lengths are counted in GSM-7 units (gsmLength).
 */
export function shareTexts(doc, url, lang) {
  const l = langOf(lang);
  const business = doc.seller?.businessName || 'FitFlex';
  const title = titleOf(doc, l);
  const number = doc.number || formatDay(doc.statement?.asOf || doc.issuedAt, l);
  const amount = money(shareAmount(doc));
  const whatsapp = label(l, 'waText', { business, title, number, amount, url });
  const safeBusiness = gsmSafe(business) || 'FitFlex';
  const shortBusiness = safeBusiness.length > SMS_BUSINESS_MAX ? `${safeBusiness.slice(0, SMS_BUSINESS_MAX - 3).trimEnd()}...` : safeBusiness;
  const smsNumber = gsmSafe(number);
  let sms = label(l, 'smsText', { business: shortBusiness, title, number: smsNumber, amount, url });
  if ((gsmLength(sms) ?? Infinity) > SMS_MAX) sms = label(l, 'smsText', { business: shortBusiness, title, number: smsNumber, amount: '', url }).replace(/\s+:/, ':').replace(/ {2,}/g, ' ');
  return { whatsapp, sms };
}
