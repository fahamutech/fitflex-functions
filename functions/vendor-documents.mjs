// Vendor business tools · S5 — documents: share links, the public page /d/:token (+ .pdf), the logged-in
// document views (JSON / HTML / PDF) and link management. Dormant: VENDOR_TOOLS + VENDOR_DOCUMENTS (off →
// 404 feature_disabled; the public page answers its "not available" page). Links also need
// PUBLIC_API_URL (unset → 503 public_url_not_configured; there is no fallback host — Q-1).
// Permissions (design spec §0.3): receipt → sales · credit invoice → sales or customers · payment receipt
// and statement → customers · order invoice → orders. The vendor account has all of them.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { shopService, vendorDocumentService, users } from '../src/bootstrap/services.mjs';
import { vendorDocumentsOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { langOf, PAPERS, pdfFileName, validToken } from '../src/shared/vendor-documents.mjs';
import { renderDocumentHtml, renderUnavailable, renderRateLimited, renderServerError, renderPdfFailed } from '../src/shared/vendor-document-html.mjs';
import { renderDocumentPdf } from '../src/shared/vendor-document-pdf.mjs';

const created = new Date().toISOString();
const ACCESS = ['sales', 'customers', 'orders'];

/**
 * vendor_staff need at least one of `sales`, `customers`, `orders` (stored staff record, active, of the
 * vendor in their token); their vendor must not be suspended (as S3/S4: 403 vendor_suspended). Sets
 * req.vendorAccess { sales, customers, orders } — each document then checks its own permission.
 */
async function requireDocumentAccess(req, res, next) {
  if (req.user?.userType !== 'vendor_staff') {
    req.vendorAccess = { sales: true, customers: true, orders: true };
    return next();
  }
  let access;
  let vendor = null;
  try {
    access = Object.fromEntries(await Promise.all(ACCESS.map(async p => [p, await shopService.authorizeStaff(req.user, p)])));
    if (ACCESS.some(p => access[p])) vendor = await users.findByIdAsync(req.user.vendorId);
  } catch (error) {
    console.error('[vendor-documents] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
    return res.status(503).json({ error: 'authorization_unavailable' });
  }
  if (!ACCESS.some(p => access[p])) return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: 'sales', acceptedPermissions: ACCESS });
  if (!vendor || vendor.userType !== 'vendor' || vendor.accountStatus === 'suspended') return res.status(403).json({ error: 'vendor_suspended' });
  req.vendorAccess = access;
  return next();
}
const guards = method => routeGuard(method, [requireAuth('vendor', 'vendor_staff'), requireDocumentAccess]);
const vendorOf = user => (user.userType === 'vendor_staff' ? user.vendorId : user.sub);
const send = (res, result) => {
  const { error, status, ...extra } = result;
  return res.status(status).json({ error, ...extra });
};
const disabled = res => res.status(404).json({ error: 'feature_disabled' });
const setHeader = (res, key, value) => (typeof res.setHeader === 'function' ? res.setHeader(key, value) : res.set?.(key, value));

/** Link creation per vendor per minute, in memory per server (as S3/S4 writes). */
export const VENDOR_DOCUMENT_LIMITS = Object.freeze({ sharesPerMinute: 60, publicPerIpPerMinute: 60, publicPerTokenPerHour: 300 });
const shareLimiter = createVendorLimiter({ perMinute: VENDOR_DOCUMENT_LIMITS.sharesPerMinute });
const ipLimiter = createVendorLimiter({ perMinute: VENDOR_DOCUMENT_LIMITS.publicPerIpPerMinute, maxTracked: 20_000 });
const tokenLimiter = createVendorLimiter({ perMinute: VENDOR_DOCUMENT_LIMITS.publicPerTokenPerHour, windowMs: 3_600_000, maxTracked: 20_000 });
export const resetVendorDocumentLimits = () => { shareLimiter.reset(); ipLimiter.reset(); tokenLimiter.reset(); };
/** For specs: how many keys each public limiter tracks (both are hard-capped). */
export const publicLimiterSizes = () => ({ ip: ipLimiter.size(), token: tokenLimiter.size() });

const FLAG = 'VENDOR_TOOLS + VENDOR_DOCUMENTS; off → 404 feature_disabled';
const STAFF = 'Staff of a suspended vendor → 403 vendor_suspended; staff without the document\'s permission → 403 vendor_permission_forbidden { requiredPermission, acceptedPermissions }.';
const SHARE = `→ 201 { linkId, url ({PUBLIC_API_URL}/d/{token}; 22-character token, shown ONCE — only its hash is stored, so it can never be listed again; "?lang=sw" when lang is sw), lang, docType, docId, number|null, texts: { en: { whatsapp, sms }, sw: { whatsapp, sms } } (ready to send; SMS ≤ 160 GSM-7 characters), whatsappText, smsText (in lang) }. Body { lang?: en|sw (default en: the page's default language) }. 503 public_url_not_configured (PUBLIC_API_URL not set on the server: offer text sharing), 409 document_cancelled (voided: links already sent keep working and show Cancelled; no new ones), 400 invalid_lang, 429 rate_limited { retryAfterSeconds } (more than 60 links a minute for the vendor). ${STAFF}`;

function shareRoute(path, kind, { idParam = 'id', description, customerParam = null }) {
  return {
    created, method: 'post', path, description: `Vendor / staff (${FLAG}): make a share link for ${description}. ${SHARE}`,
    requestSample: { lang: 'sw' },
    onGuard: guards('post'),
    onRequest: async (req, res) => {
      if (!vendorDocumentsOn()) return disabled(res);
      if (limitOrNull(shareLimiter, vendorOf(req.user), res)) return;
      const result = await vendorDocumentService.share({
        vendorId: vendorOf(req.user), actorId: req.user.sub, access: req.vendorAccess, kind, id: req.params[idParam],
        customerId: customerParam ? req.params[customerParam] : null, body: req.body || {},
      });
      if (result.error) return send(res, result);
      const { status, ...body } = result;
      res.status(status).json(body);
    },
  };
}

export const vendorShareSale = shareRoute('/vendor/sales/:id/share', 'sale', {
  description: 'a walk-in sale: a cash sale is shared as its receipt (R-…, needs `sales`), a pay-later sale as its invoice (INV-…, needs `sales` or `customers`). 404 sale_not_found',
});
export const vendorShareOrder = shareRoute('/vendor/orders/:id/share', 'order', {
  description: 'my invoice for a marketplace order (INV-…, my own lines only; needs `orders`). 404 order_not_found (no line of mine), 409 invoice_not_ready (my part is not paid yet)',
});
export const vendorSharePayment = shareRoute('/vendor/customers/:id/payments/:paymentId/share', 'payment', {
  idParam: 'paymentId', customerParam: 'id', description: 'a customer payment receipt (PMT-…; needs `customers`). 404 payment_not_found (unknown, another customer\'s or another vendor\'s)',
});
export const vendorShareStatement = shareRoute('/vendor/customers/:id/statement/share', 'statement', {
  description: 'a customer statement (needs `customers`). The link shows the statement FROZEN as of now (Q-9): open pay-later sales, payments of the last 90 days, total owed, aging. A later payment never changes it — share again for new figures. 404 customer_not_found',
});

export const vendorDocumentLinks = {
  created, method: 'get', path: '/vendor/document-links',
  description: `Vendor / staff (${FLAG}): the links made for one document, oldest first. Query docType = sale (receipt and invoice) | receipt | invoice | payment | payment_receipt | statement | order | order_invoice, docId (the sale, payment, customer or order id). → { links: [{ id, n (Link 1, 2, …), docType, docId, lang, createdAt, createdBy { id, firstName|null }, lastOpenedAt|null, revokedAt|null, active }], activeCount }. Never the URL (only its hash exists). 400 invalid_doc_type | invalid_field { field: docId }. ${STAFF}`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (!vendorDocumentsOn()) return disabled(res);
    const result = await vendorDocumentService.links({ vendorId: vendorOf(req.user), access: req.vendorAccess, query: req.query || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorRevokeDocumentLinks = {
  created, method: 'post', path: '/vendor/document-links/revoke',
  description: `Vendor / staff (${FLAG}): turn off every active link of one document (permanent; audited). Body { docType (as GET /vendor/document-links), docId }. → { links (as GET /vendor/document-links), revokedCount }. Opening a turned-off link answers the same 404 page as a link that never existed. ${STAFF}`,
  requestSample: { docType: 'sale', docId: 'sal_0123456789abcdef' },
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorDocumentsOn()) return disabled(res);
    const result = await vendorDocumentService.revokeAll({ vendorId: vendorOf(req.user), actorId: req.user.sub, access: req.vendorAccess, body: req.body || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorRevokeDocumentLink = {
  created, method: 'post', path: '/vendor/documents/:linkId/revoke',
  description: `Vendor / staff (${FLAG}): turn off one link (permanent; audited). Already off → 200 with the link unchanged. → { link } (as GET /vendor/document-links rows). 404 link_not_found (unknown or another vendor's). ${STAFF}`,
  onGuard: guards('post'),
  onRequest: async (req, res) => {
    if (!vendorDocumentsOn()) return disabled(res);
    const result = await vendorDocumentService.revokeOne({ vendorId: vendorOf(req.user), actorId: req.user.sub, access: req.vendorAccess, linkId: req.params.linkId });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

const DOC_SHAPE = '{ docType: receipt|invoice|payment_receipt|statement|order_invoice, number|null (statement), saleRef? (R- of a credit invoice), orderShortRef? (order invoice), status: paid|pay_later|paid_in_full|cancelled|null, issuedAt, lang, seller { businessName, logoUrl|null, address|null, contactNumber|null, tin? , vrn? (only when VAT applied to this document: VRN verified) }, soldVia? (order invoice: "Seller: {business}. Sold through the FitFlex app."), customer? { name } (walk-in: the name the vendor entered; app buyer: display name only), servedBy? { firstName }, dueDate? (credit), lines: [{ name, variant|null, qty, unitPriceTzs, discountTzs, amountTzs, vatCode? }], subtotalTzs, discountsTzs, totalTzs, vatIncludedTzs (VAT contained in the prices; 0 when none), vatSummary: [{ code, ratePct|null (exempt), netTzs, vatTzs }], payments: [{ method, reference?, amountTzs }], changeTzs, paidNowTzs? + liveStatus? { asOf, balanceTzs, paidInFullAt?, paidWith: [PMT-…] } (credit invoice, live), paidTowards? [{ number, amountTzs }] + stillOwedTzs? (payment receipt: on those sales, now), receivedOn? (payment receipt), paymentMethod? (order invoice; never its reference), statement? { asOf, openSales: [{ number, soldAt, dueDate, totalTzs, balanceTzs, daysOverdue }], recentPayments: [{ number, receivedOn, method, amountTzs }], totalOwedTzs, aging { current, d1_30, d31_60, d61_90, d90plus } }, cancelledAt? }. Never: customer phone, email or address, buyer user id, cost, commission, payout, internal note, void reason, staff surname.';

export const vendorDocumentView = {
  created, method: 'get', path: '/vendor/documents/:docType/:docId',
  description: `Vendor / staff (${FLAG}): one document, for the in-app view, the portal (format=html inside a sandboxed iframe) and "Send PDF" — no link is made. :docType = sale | receipt | invoice | payment | payment_receipt | statement | order | order_invoice; :docId = the sale, payment, customer (statement: LIVE, as of now) or order id. Query format = json (default) → { doc: ${DOC_SHAPE} } | html (text/html, no script) | pdf (application/pdf; Content-Disposition attachment; filename {number}_{business}.pdf, statement_{initials}_{date}.pdf), lang = en (default) | sw, paper = a4 (default) | 80mm (receipt printer). 404 sale_not_found | payment_not_found | customer_not_found | order_not_found, 409 invoice_not_ready (order not paid), 400 invalid_doc_type | invalid_format | invalid_paper, 503 pdf_unavailable (format=pdf while the PDF library cannot be loaded). ${STAFF}`,
  onGuard: guards('get'),
  onRequest: async (req, res) => {
    if (!vendorDocumentsOn()) return disabled(res);
    let result;
    try {
      result = await vendorDocumentService.view({ vendorId: vendorOf(req.user), access: req.vendorAccess, kind: req.params.docType, id: req.params.docId, query: req.query || {} });
    } catch (error) {
      if (error.code === 'pdf_unavailable') return res.status(503).json({ error: 'pdf_unavailable' });
      throw error;
    }
    if (result.error) return send(res, result);
    setHeader(res, 'Cache-Control', 'no-store, private');
    if (result.html) {
      setHeader(res, 'Content-Type', 'text/html; charset=utf-8');
      setHeader(res, 'Content-Security-Policy', "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      setHeader(res, 'X-Content-Type-Options', 'nosniff');
      return res.status(200).send(result.html);
    }
    if (result.pdf) return sendPdf(res, result.pdf, result.fileName, 'attachment');
    res.json(result);
  },
};

function sendPdf(res, buffer, fileName, disposition = 'inline') {
  const safe = String(fileName).replace(/[^A-Za-z0-9._-]/g, '_');
  setHeader(res, 'Content-Type', 'application/pdf');
  setHeader(res, 'Content-Length', String(buffer.length));
  setHeader(res, 'Content-Disposition', `${disposition}; filename="${safe}"`);
  setHeader(res, 'Cache-Control', 'no-store, private');
  setHeader(res, 'X-Content-Type-Options', 'nosniff');
  res.status(200);
  return typeof res.end === 'function' ? res.end(buffer) : res.send(buffer);
}

// ── public page ─────────────────────────────────────────────────────────────

/**
 * The client address for the per-address limit (security review #229 M2). X-Forwarded-For is trusted only
 * as far as our own proxies: each proxy APPENDS the address it saw, so the client is the entry
 * PUBLIC_DOCS_TRUSTED_PROXY_HOPS from the right (default 1 = the address our nearest proxy — Firebase
 * Hosting / the bfast front — saw connect to it). Anything to the left of it is client-supplied and
 * ignored. 0 = no proxy in front: the socket's own address, X-Forwarded-For ignored entirely.
 */
const trustedHops = (raw = process.env.PUBLIC_DOCS_TRUSTED_PROXY_HOPS) => (raw == null || String(raw).trim() === '' ? 1 : Number(raw));
export function clientAddress(req, hops = trustedHops()) {
  const direct = req.socket?.remoteAddress || req.ip || 'unknown';
  const n = Number.isInteger(hops) && hops >= 0 ? hops : 1;
  if (n === 0) return direct;
  const chain = String(req.headers?.['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!chain.length) return direct;
  return chain[Math.max(0, chain.length - n)];
}

function publicHeaders(res, { logoUrl = null } = {}) {
  let img = '';
  if (logoUrl) {
    try {
      const url = new URL(logoUrl);
      img = ` ${url.origin}`;
      // /storage/… answers with a redirect to the storage service; the image must be allowed there too.
      if (url.pathname.includes('/storage/') && process.env.ZEBRA_BASE_URL) {
        const zebra = new URL(process.env.ZEBRA_BASE_URL).origin;
        if (zebra !== url.origin) img += ` ${zebra}`;
      }
    } catch { img = ''; }
  }
  setHeader(res, 'Cache-Control', 'no-store');
  setHeader(res, 'X-Robots-Tag', 'noindex, nofollow');
  setHeader(res, 'Referrer-Policy', 'no-referrer');
  setHeader(res, 'X-Frame-Options', 'DENY');
  setHeader(res, 'X-Content-Type-Options', 'nosniff');
  setHeader(res, 'Content-Security-Policy', `default-src 'none'; img-src 'self'${img}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
}
function htmlPage(res, status, content, opts) {
  publicHeaders(res, opts);
  setHeader(res, 'Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(content);
}

export const publicVendorDocument = {
  created, method: 'get', path: '/d/:token',
  description: 'Public (no sign-in), opened from a link a vendor shared: the document page, or its PDF when the path ends in .pdf (/d/{token}.pdf). Query lang = en | sw (default: the link\'s language; anything else → the default), paper = a4 | 80mm (PDF only). HTML with no JavaScript; headers Cache-Control: no-store, X-Robots-Tag: noindex, nofollow, Referrer-Policy: no-referrer, X-Frame-Options: DENY, a strict Content-Security-Policy. An unknown, mistyped, turned-off link (and VENDOR_DOCUMENTS off, or the vendor or document gone) → 404 with the SAME page every time (depends only on ?lang=). 429 + Retry-After over 60 requests a minute from one address (the address our nearest proxy saw: PUBLIC_DOCS_TRUSTED_PROXY_HOPS, default 1, counted from the right of X-Forwarded-For) or 300 an hour for one live link (only real links are counted; a malformed token is answered before any limiter). 500 on a server error; a PDF that fails → 500 page (503 while the PDF library cannot be loaded) with a link back to the HTML page. Each open sets the link\'s lastOpenedAt (no IP or count is stored). Never shows a customer\'s phone, email or address.',
  onRequest: async (req, res) => {
    const raw = String(req.params?.token || '');
    const pdf = raw.endsWith('.pdf');
    const token = pdf ? raw.slice(0, -4) : raw;
    const qlang = typeof req.query?.lang === 'string' ? req.query.lang : null;
    // A malformed token is answered at once, before any limiter or database work (#229 M2).
    if (!validToken(token)) return htmlPage(res, 404, renderUnavailable(qlang));
    const ip = ipLimiter.allow(clientAddress(req));
    if (!ip.ok) {
      setHeader(res, 'Retry-After', String(ip.retryAfterSeconds));
      return htmlPage(res, 429, renderRateLimited(qlang));
    }
    if (!vendorDocumentsOn()) return htmlPage(res, 404, renderUnavailable(qlang));
    let out;
    try {
      out = await vendorDocumentService.publicDocument({ token, lang: qlang, onLink: tokenHash => tokenLimiter.allow(tokenHash) });
    } catch (error) {
      console.error('[vendor-documents] public page failed', { error: error.message });
      return htmlPage(res, 500, renderServerError(qlang));
    }
    if (out.status === 429) {
      setHeader(res, 'Retry-After', String(out.retryAfterSeconds));
      return htmlPage(res, 429, renderRateLimited(qlang));
    }
    if (out.status !== 200) return htmlPage(res, 404, renderUnavailable(qlang));
    const lang = langOf(out.lang);
    if (pdf) {
      const paper = PAPERS.includes(req.query?.paper) ? req.query.paper : 'a4';
      let buffer;
      try {
        buffer = await renderDocumentPdf(out.doc, { lang, paper });
      } catch (error) {
        console.error('[vendor-documents] public PDF failed', { error: error.message });
        return htmlPage(res, error.code === 'pdf_unavailable' ? 503 : 500, renderPdfFailed(lang, token));
      }
      publicHeaders(res);
      return sendPdf(res, buffer, pdfFileName(out.doc), 'inline');
    }
    return htmlPage(res, 200, renderDocumentHtml(out.doc, { lang, mode: 'public', token }), { logoUrl: out.doc.seller?.logoUrl });
  },
};
