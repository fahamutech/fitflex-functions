// Vendor documents (vendor business tools · S5): share links, the public page and PDF, the logged-in
// document views, per-vendor order invoices and the buyer's invoice.
//
// Decisions (design spec docs/design/vendor-documents-s5.md; recommendations applied 2026-10-20 except
// Q-1, Q-10, Q-12): O-5 hash-only tokens, no expiry, revocable; Q-1 no links without PUBLIC_API_URL
// (503 public_url_not_configured, never a fallback host); Q-2 voided documents keep their links and read
// "Cancelled" (no new links); Q-9 statement links are frozen snapshots; Q-14 lastOpenedAt only;
// Q-15 order invoices are numbered when the vendor's part is paid. Permissions §0.3:
//   receipt → sales · invoice (credit sale) → sales or customers · payment receipt, statement → customers ·
//   order invoice → orders.
// The routes check the flag (VENDOR_TOOLS + VENDOR_DOCUMENTS) and resolve the caller's access first.
import {
  newToken, hashToken, validToken, langOf, publicBaseUrl, shareTexts, saleDocument, paymentDocument, statementSnapshot,
  statementDocument, orderInvoiceDocument, firstName, pdfFileName, LANGS, PAPERS,
} from '../shared/vendor-documents.mjs';
import { eatDate } from '../shared/vendor-order-view.mjs';

/** What each document kind needs (any of). */
export const DOC_PERMISSIONS = Object.freeze({
  receipt: ['sales'], invoice: ['sales', 'customers'], payment_receipt: ['customers'], statement: ['customers'], order_invoice: ['orders'], credit_note: ['sales'],
});
/** The kinds a client names (routes, link lists) → the link docTypes they cover. */
export const KIND_DOC_TYPES = Object.freeze({
  sale: ['receipt', 'invoice'], receipt: ['receipt'], invoice: ['invoice'],
  payment: ['payment_receipt'], payment_receipt: ['payment_receipt'],
  statement: ['statement'], order: ['order_invoice'], order_invoice: ['order_invoice'],
});
const KIND_OF = { receipt: 'sale', invoice: 'sale', sale: 'sale', payment: 'payment', payment_receipt: 'payment', statement: 'statement', order: 'order', order_invoice: 'order' };
const NOT_FOUND = { sale: 'sale_not_found', payment: 'payment_not_found', statement: 'customer_not_found', order: 'order_not_found' };
/**
 * Security review #229 L2: what a caller needs to even ASK for a kind, checked before anything is loaded
 * (so staff without it cannot probe ids or make an order invoice get numbered). A sale needs any of its
 * document permissions; the exact one (receipt → sales, invoice → sales or customers) is checked after.
 */
const KIND_PERMISSIONS = Object.freeze({ sale: ['sales', 'customers'], payment: ['customers'], statement: ['customers'], order: ['orders'] });
function precheck(kind, access) {
  const k = KIND_OF[kind];
  if (!k) return { error: 'invalid_doc_type', status: 400, allowed: Object.keys(KIND_OF) };
  const needs = KIND_PERMISSIONS[k];
  return needs.some(p => access?.[p]) ? null : { error: 'vendor_permission_forbidden', status: 403, requiredPermission: needs[0], acceptedPermissions: needs };
}
const allowed = (docType, access) => (DOC_PERMISSIONS[docType] || []).some(p => access?.[p]);
const forbidden = docType => ({ error: 'vendor_permission_forbidden', status: 403, requiredPermission: DOC_PERMISSIONS[docType][0], acceptedPermissions: DOC_PERMISSIONS[docType] });

export function createVendorDocumentService({ store, renderHtml, renderManyHtml, renderPdf, baseUrl = () => publicBaseUrl(), now = () => new Date() }) {
  const today = () => eatDate(now());

  /**
   * Load a document by kind + id for a vendor. → { doc (document JSON in `lang`), docType, docId, snapshot? } | error.
   * `fresh` statements are live (now); a link's statement is its snapshot.
   */
  async function load({ vendorId, kind, id, lang, customerId = null }) {
    const k = KIND_OF[kind];
    if (!k) return { error: 'invalid_doc_type', status: 400, allowed: Object.keys(KIND_OF) };
    if (k === 'sale') {
      const src = await store.saleSource(vendorId, id);
      if (!src) return { error: NOT_FOUND.sale, status: 404 };
      const doc = saleDocument({ ...src, today: today() }, lang);
      return { doc, docType: doc.docType, docId: src.sale.id };
    }
    if (k === 'payment') {
      const src = await store.paymentSource(vendorId, id);
      // Under /vendor/customers/:id/payments/:paymentId the payment must be that customer's.
      if (!src || (customerId && src.customerId !== customerId)) return { error: NOT_FOUND.payment, status: 404 };
      return { doc: paymentDocument(src, lang), docType: 'payment_receipt', docId: src.payment.id, customerId: src.customerId };
    }
    if (k === 'statement') {
      const src = await store.statementSource(vendorId, id, today());
      if (!src) return { error: NOT_FOUND.statement, status: 404 };
      const snapshot = statementSnapshot(src);
      return { doc: statementDocument(snapshot, lang), docType: 'statement', docId: id, snapshot };
    }
    const src = await store.orderInvoiceSource(vendorId, id);
    if (src.error === 'order_not_found') return { error: NOT_FOUND.order, status: 404 };
    if (src.error) return { error: src.error, status: 409 };
    return { doc: orderInvoiceDocument(src, lang), docType: 'order_invoice', docId: id };
  }

  /** GET /vendor/documents/:kind/:id?format&lang&paper → { doc } | { html } | { pdf, fileName }. */
  async function view({ vendorId, access, kind, id, query = {} }) {
    const lang = langOf(query.lang);
    const format = query.format == null || query.format === '' ? 'json' : String(query.format);
    if (!['json', 'html', 'pdf'].includes(format)) return { error: 'invalid_format', status: 400, allowed: ['json', 'html', 'pdf'] };
    const paper = query.paper == null || query.paper === '' ? 'a4' : String(query.paper);
    if (!PAPERS.includes(paper)) return { error: 'invalid_paper', status: 400, allowed: PAPERS };
    const refused = precheck(kind, access);
    if (refused) return refused;
    const out = await load({ vendorId, kind, id, lang });
    if (out.error) return out;
    if (!allowed(out.docType, access)) return forbidden(out.docType);
    if (format === 'json') return { doc: out.doc };
    if (format === 'html') return { html: renderHtml(out.doc, { lang, mode: 'embedded' }) };
    return { pdf: await renderPdf(out.doc, { lang, paper }), fileName: pdfFileName(out.doc) };
  }

  /** POST …/share { lang } → the link (token in the URL, returned once) and the share texts in both languages. */
  async function share({ vendorId, actorId, access, kind, id, customerId = null, body = {} }) {
    const base = baseUrl();
    // Q-1: no link without a configured public address (the app falls back to text sharing).
    if (!base) return { error: 'public_url_not_configured', status: 503 };
    if (body?.lang != null && !LANGS.includes(body.lang)) return { error: 'invalid_lang', status: 400, allowed: LANGS };
    const lang = langOf(body?.lang);
    const refused = precheck(kind, access);
    if (refused) return refused;
    const out = await load({ vendorId, kind, id, lang, customerId });
    if (out.error) return out;
    if (!allowed(out.docType, access)) return forbidden(out.docType);
    // Q-2: a cancelled document keeps the links already sent; no new ones.
    if (out.doc.status === 'cancelled') return { error: 'document_cancelled', status: 409 };
    const { token, tokenHash } = newToken();
    const link = await store.createLink({ vendorId, docType: out.docType, docId: out.docId, tokenHash, lang, snapshot: out.snapshot ?? null, createdBy: actorId });
    const plainUrl = `${base}/d/${token}`;
    const url = lang === 'sw' ? `${plainUrl}?lang=sw` : plainUrl;
    const urlFor = l => (l === 'sw' ? `${plainUrl}?lang=sw` : lang === 'en' ? plainUrl : `${plainUrl}?lang=en`);
    const texts = { en: shareTexts(out.doc, urlFor('en'), 'en'), sw: shareTexts(out.doc, urlFor('sw'), 'sw') };
    return {
      status: 201,
      linkId: link.id, url, lang, docType: out.docType, docId: out.docId, number: out.doc.number ?? null,
      texts, whatsappText: texts[lang].whatsapp, smsText: texts[lang].sms,
    };
  }
  const linkView = r => ({
    id: r.id, n: r.n, docType: r.docType, docId: r.docId, lang: r.lang,
    createdAt: r.createdAt, createdBy: { id: r.createdBy, firstName: firstName(r.createdByName) },
    lastOpenedAt: r.lastOpenedAt ?? null, revokedAt: r.revokedAt ?? null, active: r.revokedAt == null,
  });

  function kindTypes(kind) {
    const types = KIND_DOC_TYPES[kind];
    return types ? { types } : { error: 'invalid_doc_type', status: 400, allowed: Object.keys(KIND_DOC_TYPES) };
  }

  /**
   * UAT D6: the link docTypes a caller may list or turn off for one document — the same permission as share
   * and view. A sale is resolved to what it really is (cash → receipt needs `sales`; credit → invoice needs
   * `sales` or `customers`), so customers-only staff get 403 on a cash receipt's links. Another vendor's or
   * an unknown sale has no links (empty, as before). → { types } | error.
   */
  async function linkTypesFor({ vendorId, access, kind, docId }) {
    const t = kindTypes(kind);
    if (t.error) return t;
    if (!docId) return { error: 'invalid_field', status: 400, field: 'docId' };
    const refused = precheck(kind, access);
    if (refused) return refused;
    let types = t.types;
    if (KIND_OF[kind] === 'sale') {
      const actual = await store.saleDocType(vendorId, docId);
      if (!actual) return { types: [] };
      types = t.types.filter(dt => dt === actual);
      if (!types.length) return { types: [] };
    }
    if (!types.every(dt => allowed(dt, access))) return forbidden(types.find(dt => !allowed(dt, access)));
    return { types };
  }

  /** GET /vendor/document-links?docType&docId → { links } (never the URL: only its hash exists). */
  async function links({ vendorId, access, query = {} }) {
    const docId = typeof query.docId === 'string' ? query.docId : '';
    const t = await linkTypesFor({ vendorId, access, kind: String(query.docType || ''), docId });
    if (t.error) return t;
    if (!t.types.length) return { links: [], activeCount: 0 };
    const rows = await store.listLinks(vendorId, t.types, docId);
    return { links: rows.map(linkView), activeCount: rows.filter(r => !r.revokedAt).length };
  }

  /** POST /vendor/documents/:linkId/revoke → { link }. Already off → the same link (200). */
  async function revokeOne({ vendorId, actorId, access, linkId }) {
    const link = await store.getLink(vendorId, linkId);
    if (!link) return { error: 'link_not_found', status: 404 };
    if (!allowed(link.docType, access)) return forbidden(link.docType);
    if (!link.revokedAt) await store.revoke({ vendorId, actorId, linkId });
    const all = await store.listLinks(vendorId, [link.docType], link.docId);
    return { link: linkView(all.find(r => r.id === linkId)) };
  }

  /** POST /vendor/document-links/revoke { docType, docId } → { links, revokedCount }. */
  async function revokeAll({ vendorId, actorId, access, body = {} }) {
    const docId = typeof body?.docId === 'string' ? body.docId : '';
    const t = await linkTypesFor({ vendorId, access, kind: String(body?.docType || ''), docId });
    if (t.error) return t;
    if (!t.types.length) return { links: [], revokedCount: 0 };
    const revoked = await store.revoke({ vendorId, actorId, docTypes: t.types, docId });
    const rows = await store.listLinks(vendorId, t.types, docId);
    return { links: rows.map(linkView), revokedCount: revoked.length };
  }

  /**
   * GET /d/:token[.pdf] — the public page. → { status: 200, doc, lang } | { status: 404 } (unknown, revoked,
   * vendor or document gone: one answer for all). Each open sets lastOpenedAt.
   */
  async function publicDocument({ token, lang: queryLang, onLink = () => ({ ok: true }) }) {
    if (!validToken(token)) return { status: 404 };
    const tokenHash = hashToken(token);
    const link = await store.liveLinkByHash(tokenHash);
    if (!link) return { status: 404 };
    // Security review #229 M2: the per-link limit counts only hashes of real, live links.
    const allowed = onLink(tokenHash);
    if (!allowed.ok) return { status: 429, retryAfterSeconds: allowed.retryAfterSeconds };
    const lang = LANGS.includes(queryLang) ? queryLang : link.lang;
    let doc;
    if (link.docType === 'statement') {
      // Security review #229 M1: a member who deleted their account is never named, even on an old snapshot.
      const forgotten = await store.customerForgotten(link.vendorId, link.docId);
      const snapshot = forgotten ? { ...link.snapshot, customer: { name: null } } : link.snapshot;
      doc = statementDocument(snapshot, lang);
    }
    else {
      const kind = KIND_OF[link.docType];
      const out = await load({ vendorId: link.vendorId, kind, id: link.docId, lang });
      if (out.error) return { status: 404 };
      doc = out.doc;
    }
    await store.touch(link.id);
    return { status: 200, doc, lang };
  }

  /**
   * GET /me/shop-orders/:id/invoice?format=json|html|pdf (&vendorId for pdf when several vendors): one
   * invoice per vendor of the buyer's own paid order. → { invoices } | { html } | { pdf, fileName } | error.
   */
  async function buyerInvoices({ buyerId, orderId, query = {} }) {
    const lang = langOf(query.lang);
    const format = String(query.format);
    const paper = query.paper == null || query.paper === '' ? 'a4' : String(query.paper);
    if (!PAPERS.includes(paper)) return { error: 'invalid_paper', status: 400, allowed: PAPERS };
    const order = await store.orderVendorsForBuyer(buyerId, orderId);
    if (order.error) return { error: order.error, status: 404 };
    let vendorIds = order.vendorIds;
    if (format === 'pdf') {
      if (query.vendorId) {
        if (!vendorIds.includes(String(query.vendorId))) return { error: 'vendor_not_in_order', status: 404 };
        vendorIds = [String(query.vendorId)];
      } else if (vendorIds.length > 1) return { error: 'vendor_required', status: 400, vendors: vendorIds };
    }
    const invoices = [];
    for (const vendorId of vendorIds) {
      const src = await store.orderInvoiceSource(vendorId, orderId, { buyerId });
      if (src.error) continue;
      invoices.push({ vendorId, doc: orderInvoiceDocument(src, lang) });
    }
    if (!invoices.length) return { error: 'invoice_not_ready', status: 404 };
    if (format === 'json') return { invoices: invoices.map(i => ({ ...i.doc, vendorId: i.vendorId })) };
    if (format === 'html') return { html: renderManyHtml(invoices.map(i => i.doc), { lang }) };
    return { pdf: await renderPdf(invoices[0].doc, { lang, paper }), fileName: pdfFileName(invoices[0].doc) };
  }

  /** A paid app order (shop service hook): each vendor's invoice is numbered now (Q-15). Never fails the order. */
  async function orderPaid(order) {
    let issued = 0;
    for (const vendorId of store.vendorsOf(order)) {
      try {
        const out = await store.issueOrderInvoice(order, vendorId);
        if (out?.issued) issued += 1;
      } catch (err) { console.warn('[vendor-documents] order invoice not issued', { orderId: order?.id, vendorId, error: err?.message }); }
    }
    return { issued };
  }

  return { view, share, links, revokeOne, revokeAll, publicDocument, buyerInvoices, orderPaid };
}
