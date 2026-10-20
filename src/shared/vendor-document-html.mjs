// Vendor documents (S5): the server-rendered HTML of a document (public page /d/:token and the logged-in
// view the portal shows in a sandboxed iframe) and the error pages. One template for every document type,
// from the document JSON (src/shared/vendor-documents.mjs). No JavaScript, no third-party requests (only
// the vendor's https logo), every value escaped. Design spec §4, §5, §9.
import { DOC_LABELS, label, langOf, money, formatDay, formatDateTime, methodLabel, titleOf, statusKeyOf, cancelledBanner } from './vendor-documents.mjs';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
const L = (lang, key, values) => esc(label(lang, key, values));

const STYLE = `
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#F4F6F5;color:#111827;font:16px/1.5 Inter,-apple-system,Roboto,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;max-width:720px;margin:0 auto;padding:8px 16px}
.bar a{display:inline-flex;align-items:center;min-height:44px;min-width:44px;padding:0 12px;color:#1F7A3A;text-decoration:none}
.bar a[aria-current="true"]{font-weight:700;color:#111827}
.bar .pdf{border:1px solid #1F7A3A;border-radius:8px;font-weight:600}
main{background:#fff;max-width:720px;margin:0 auto 24px;padding:16px;border-radius:0}
@media (min-width:768px){main{border-radius:12px;padding:24px}.head{display:flex;justify-content:space-between;gap:24px}.head .right{text-align:right}}
h1{font-size:22px;margin:4px 0;border-bottom:3px solid #1F7A3A;padding-bottom:4px}
h2{font-size:16px;margin:20px 0 6px}
.muted{color:#4B5563;font-size:14px}
.logo{max-width:150px;max-height:76px;display:block;margin-bottom:6px}
.badge{display:inline-block;min-width:auto;padding:2px 10px;border-radius:999px;font-size:14px;font-weight:600;border:1px solid}
.paid{color:#14532D;background:#DCFCE7;border-color:#86EFAC}.pay_later{color:#1E3A8A;background:#DBEAFE;border-color:#93C5FD}
.paid_in_full{color:#14532D;background:#DCFCE7;border-color:#86EFAC}.cancelled{color:#7F1D1D;background:#FEE2E2;border-color:#FCA5A5}
.banner{border:2px solid #B91C1C;background:#FEF2F2;color:#7F1D1D;border-radius:8px;padding:10px 12px;margin:12px 0;font-weight:600}
dl.line{margin:0;padding:8px 0;border-bottom:1px solid #E5E7EB;display:grid;grid-template-columns:1fr auto;gap:2px 12px}
dl.line dt{font-weight:600}dl.line dd{margin:0;text-align:right}dl.line dd.sub{grid-column:1/3;text-align:left;color:#4B5563;font-size:14px}
table{border-collapse:collapse;width:100%}th,td{padding:6px 8px;border-bottom:1px solid #E5E7EB;text-align:left;vertical-align:top}
th{font-size:14px;color:#4B5563}td.n,th.n{text-align:right;white-space:nowrap}
.lines-table{display:none}@media (min-width:768px){.lines-table{display:table}.lines-list{display:none}}
.scroll{overflow-x:auto}
.totals{margin-top:8px}.totals div{display:flex;justify-content:space-between;padding:2px 0}.totals .grand{font-weight:700;font-size:18px;border-top:2px solid #111827;margin-top:4px;padding-top:6px}
.box{border:1px solid #D1D5DB;border-radius:8px;padding:10px 12px;margin-top:12px}
footer{margin-top:20px;color:#4B5563;font-size:14px}
@page{size:A4;margin:15mm}
@media print{body{background:#fff;color:#000}.bar{display:none}main{max-width:none;margin:0;padding:0}thead{display:table-header-group}.lines-table{display:table}.lines-list{display:none}a{color:#000}}
`;

function page({ lang, title, body, bar = '' }) {
  const htmlLang = lang === 'both' ? 'en' : langOf(lang);
  return `<!doctype html><html lang="${htmlLang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>${bar}${body}</body></html>`;
}


function sellerBlock(doc, lang) {
  const s = doc.seller || {};
  return `<section aria-labelledby="h-seller"><h2 id="h-seller" class="sr" style="position:absolute;left:-9999px">${esc(s.businessName || '')}</h2>
${s.logoUrl ? `<img class="logo" src="${esc(s.logoUrl)}" alt="${esc(s.businessName || '')}">` : ''}
<div><strong>${esc(s.businessName || '')}</strong></div>
${s.address ? `<div class="muted">${esc(s.address)}</div>` : ''}
${s.contactNumber ? `<div class="muted">${esc(s.contactNumber)}</div>` : ''}
${s.tin ? `<div class="muted">${L(lang, 'tin', { tin: s.tin })}</div>` : ''}
${s.vrn ? `<div class="muted">${L(lang, 'vrn', { vrn: s.vrn })}</div>` : ''}
${doc.soldVia ? `<div class="muted">${esc(doc.soldVia)}</div>` : ''}</section>`;
}

const vatCell = (lang, code, ratePct) => (code === 'E' || ratePct == null ? L(lang, 'exempt') : `${esc(Number(ratePct).toString())}%`);

function linesBlock(doc, lang) {
  if (!doc.lines?.length) return '';
  const hasVat = doc.lines.some(l => l.vatCode);
  const list = doc.lines.map((l) => {
    const name = `${l.name}${l.variant ? ` (${l.variant})` : ''}`;
    const sub = `${l.qty} × ${money(l.unitPriceTzs)}${l.discountTzs ? ` · ${label(lang, 'discount')} -${Number(l.discountTzs).toLocaleString('en-US')}` : ''}`;
    return `<dl class="line"><dt>${esc(name)}</dt><dd>${esc(money(l.amountTzs))}${l.vatCode ? ` ${esc(l.vatCode)}` : ''}</dd><dd class="sub">${esc(sub)}</dd></dl>`;
  }).join('');
  const rows = doc.lines.map(l => `<tr><td>${esc(`${l.name}${l.variant ? ` (${l.variant})` : ''}`)}</td><td class="n">${esc(l.qty)}</td><td class="n">${esc(money(l.unitPriceTzs))}</td><td class="n">${l.discountTzs ? `-${esc(Number(l.discountTzs).toLocaleString('en-US'))}` : ''}</td><td class="n">${esc(money(l.amountTzs))}</td>${hasVat ? `<td>${esc(l.vatCode || '')}</td>` : ''}</tr>`).join('');
  return `<section aria-labelledby="h-lines"><h2 id="h-lines">${L(lang, 'item')}</h2>
<div class="lines-list">${list}</div>
<table class="lines-table"><thead><tr><th scope="col">${L(lang, 'item')}</th><th scope="col" class="n">${L(lang, 'qty')}</th><th scope="col" class="n">${L(lang, 'price')}</th><th scope="col" class="n">${L(lang, 'discount')}</th><th scope="col" class="n">${L(lang, 'amount')}</th>${hasVat ? `<th scope="col">${L(lang, 'vat')}</th>` : ''}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

function totalsBlock(doc, lang) {
  if (doc.docType === 'statement' || doc.docType === 'payment_receipt') return '';
  return `<div class="totals"><div><span>${L(lang, 'subtotal')}</span><span>${esc(money(doc.subtotalTzs))}</span></div>
${doc.discountsTzs > 0 ? `<div><span>${L(lang, 'discounts')}</span><span>-${esc(Number(doc.discountsTzs).toLocaleString('en-US'))}</span></div>` : ''}
<div class="grand"><span>${L(lang, 'total')}</span><span>${esc(money(doc.totalTzs))}</span></div>
${doc.vatSummary?.length ? `<div class="muted"><span>${L(lang, 'includesVat', { amount: money(doc.vatIncludedTzs) })}</span></div>` : ''}</div>`;
}

function vatBlock(doc, lang) {
  if (!doc.vatSummary?.length) return '';
  const rows = doc.vatSummary.map(r => `<tr><td>${esc(r.code)}</td><td>${vatCell(lang, r.code, r.ratePct)}</td><td class="n">${esc(money(r.netTzs))}</td><td class="n">${esc(money(r.vatTzs))}</td></tr>`).join('');
  const net = doc.vatSummary.reduce((s, r) => s + r.netTzs, 0);
  return `<section aria-labelledby="h-vat"><h2 id="h-vat">${L(lang, 'vatSummary')}</h2><div class="scroll"><table>
<thead><tr><th scope="col">${L(lang, 'vatCode')}</th><th scope="col">${L(lang, 'vatRate')}</th><th scope="col" class="n">${L(lang, 'vatNet')}</th><th scope="col" class="n">${L(lang, 'vat')}</th></tr></thead>
<tbody>${rows}<tr><th scope="row" colspan="2">${L(lang, 'total')}</th><td class="n">${esc(money(net))}</td><td class="n">${esc(money(doc.vatIncludedTzs))}</td></tr></tbody></table></div></section>`;
}

function paymentsBlock(doc, lang) {
  if (doc.docType === 'statement') return '';
  const parts = [];
  if (doc.paymentMethod) parts.push(`<div>${L(lang, 'paidBy', { method: methodLabel(lang, doc.paymentMethod) })}</div>`);
  for (const p of doc.payments || []) {
    parts.push(`<div class="totals"><div><span>${esc(methodLabel(lang, p.method))}${p.reference ? ` (${esc(p.reference)})` : ''}</span><span>${esc(money(p.amountTzs))}</span></div></div>`);
  }
  if (doc.changeTzs > 0) parts.push(`<div class="totals"><div><span>${L(lang, 'change')}</span><span>${esc(money(doc.changeTzs))}</span></div></div>`);
  if (doc.paidNowTzs != null) parts.push(`<div class="totals"><div><span>${L(lang, 'paidNow')}</span><span>${esc(money(doc.paidNowTzs))}</span></div></div>`);
  if (doc.liveStatus) {
    const ls = doc.liveStatus;
    const inner = ls.paidInFullAt
      ? `${L(lang, 'paidInFull', { date: formatDay(ls.paidInFullAt, lang) })}${ls.paidWith?.length ? `<br>${L(lang, 'paidWith', { numbers: ls.paidWith.join(', ') })}` : ''}`
      : `${L(lang, 'balanceDue')}: <strong>${esc(money(ls.balanceTzs))}</strong>${ls.paidWith?.length ? `<br>${L(lang, 'paidWith', { numbers: ls.paidWith.join(', ') })}` : ''}`;
    parts.push(`<div class="box"><div class="muted">${L(lang, 'statusOn', { date: formatDay(ls.asOf, lang) })}</div>${inner}</div>`);
  }
  if (doc.paidTowards) {
    parts.push(`<h2>${L(lang, 'paidTowards')}</h2>${doc.paidTowards.map(a => `<div class="totals"><div><span>${esc(a.number)}</span><span>${esc(money(a.amountTzs))}</span></div></div>`).join('')}`);
    if (doc.stillOwedTzs != null) parts.push(`<div class="totals"><div class="grand"><span>${L(lang, 'stillOwed')}</span><span>${esc(money(doc.stillOwedTzs))}</span></div></div>`);
  }
  if (!parts.length) return '';
  return `<section aria-labelledby="h-pay"><h2 id="h-pay">${L(lang, 'payments')}</h2>${parts.join('')}</section>`;
}

function statementBlock(doc, lang) {
  if (doc.docType !== 'statement') return '';
  const st = doc.statement;
  const open = st.openSales.length
    ? `<div class="scroll"><table><thead><tr><th scope="col">#</th><th scope="col">${L(lang, 'sold')}</th><th scope="col">${L(lang, 'due')}</th><th scope="col" class="n">${L(lang, 'balance')}</th><th scope="col"></th></tr></thead><tbody>${st.openSales.map(s => `<tr><td>${esc(s.number)}</td><td>${esc(formatDay(s.soldAt, lang))}</td><td>${esc(formatDay(s.dueDate, lang))}</td><td class="n">${esc(money(s.balanceTzs))}</td><td>${s.daysOverdue > 0 ? L(lang, 'daysOverdue', { n: s.daysOverdue }) : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">—</p>';
  const pays = st.recentPayments.length
    ? `<div class="scroll"><table><tbody>${st.recentPayments.map(p => `<tr><td>${esc(p.number)}</td><td>${esc(formatDay(p.receivedOn, lang))}</td><td>${esc(methodLabel(lang, p.method))}</td><td class="n">${esc(money(p.amountTzs))}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">—</p>';
  const a = st.aging || {};
  const aging = label(lang, 'aging', Object.fromEntries(['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'].map(k => [k, money(a[k] || 0)])));
  return `<section aria-labelledby="h-open"><h2 id="h-open">${L(lang, 'openSales')}</h2>${open}</section>
<section aria-labelledby="h-rp"><h2 id="h-rp">${L(lang, 'recentPayments')}</h2>${pays}</section>
<div class="totals"><div class="grand"><span>${L(lang, 'totalOwed')}</span><span>${esc(money(st.totalOwedTzs))}</span></div></div>
<p class="muted">${esc(aging)}</p>`;
}

/**
 * The document page. mode 'public' adds the language links and Download PDF (relative to /d/:token);
 * 'embedded' (logged-in view for the portal iframe) has no top bar — the portal has its own toolbar.
 */
export function renderDocumentHtml(doc, { lang = doc.lang, mode = 'public', token = null } = {}) {
  const l = langOf(lang);
  const { body, heading, business } = documentBody(doc, l, mode);
  let bar = '';
  if (mode === 'public' && token) {
    const link = (code, text) => `<a href="?lang=${code}" hreflang="${code}" lang="${code}"${code === l ? ' aria-current="true"' : ''}>${esc(text)}</a>`;
    bar = `<nav class="bar" aria-label="${esc(DOC_LABELS[l].langEn)} / ${esc(DOC_LABELS[l].langSw)}"><div>${link('en', 'English')} | ${link('sw', 'Kiswahili')}</div>
<a class="pdf" href="${esc(`${token}.pdf?lang=${l}`)}">${L(l, 'downloadPdf')}</a></nav>`;
  }
  return page({ lang: l, title: `${heading} · ${business}`, body, bar });
}

/** Several documents on one page (the buyer's invoices for a multi-vendor order: one per seller). */
export function renderDocumentsHtml(docs, { lang = 'en' } = {}) {
  const l = langOf(lang);
  const parts = docs.map(d => documentBody(d, l, 'embedded'));
  return page({ lang: l, title: parts.map(p => p.heading).join(' · '), body: parts.map(p => p.body).join('\n') });
}

function documentBody(doc, l, mode) {
  const title = titleOf(doc, l);
  const business = doc.seller?.businessName || '';
  const heading = doc.number ? `${title} ${doc.number}` : title;
  const sub = [
    doc.saleRef ? label(l, 'saleRef', { number: doc.saleRef }) : null,
    doc.orderShortRef ? label(l, 'orderRef', { ref: doc.orderShortRef }) : null,
  ].filter(Boolean);
  const meta = [
    `<div>${L(l, 'date')}: ${esc(formatDateTime(doc.docType === 'statement' ? doc.statement.asOf : doc.issuedAt, l))}</div>`,
    doc.docType === 'statement' ? `<div><strong>${L(l, 'asOf', { date: formatDateTime(doc.statement.asOf, l) })}</strong></div>` : '',
    doc.customer?.name ? `<div>${L(l, 'customer', { name: doc.customer.name })}</div>` : '',
    doc.dueDate ? `<div>${L(l, 'dueBy', { date: formatDay(doc.dueDate, l) })}</div>` : '',
    doc.servedBy?.firstName ? `<div>${L(l, 'servedBy', { name: doc.servedBy.firstName })}</div>` : '',
  ].join('');
  const status = doc.status ? `<span class="badge ${esc(doc.status)}">${L(l, statusKeyOf(doc))}</span>` : '';
  const banner = doc.status === 'cancelled' ? `<div class="banner" role="note">${esc(cancelledBanner(doc, l))}</div>` : '';
  const footer = [
    ['receipt', 'payment_receipt'].includes(doc.docType) && doc.status !== 'cancelled' ? `<div>${L(l, 'receivedBy', { business })}</div>` : '',
    `<div>${L(l, 'notFiscal')}</div>`,
    mode === 'public' ? `<div>${L(l, 'copyNote', { business })}</div>` : '',
  ].join('');
  const body = `<main><div class="head"><div class="left">${sellerBlock(doc, l)}</div><div class="right">
<h1>${esc(heading)}</h1>${sub.map(s => `<div class="muted">${esc(s)}</div>`).join('')}<div>${status}</div></div></div>
${banner}<section aria-labelledby="h-meta"><h2 id="h-meta" style="position:absolute;left:-9999px">${L(l, 'date')}</h2>${meta}</section>
${linesBlock(doc, l)}${totalsBlock(doc, l)}${vatBlock(doc, l)}${paymentsBlock(doc, l)}${statementBlock(doc, l)}
<footer>${footer}</footer></main>`;
  return { body, heading, business };
}

/** An error page in one language, or both stacked when the language is not known (§5.5). */
function messagePage(lang, titleKey, bodyKey, extra = () => '') {
  const langs = lang ? [langOf(lang)] : ['en', 'sw'];
  const body = `<main>${langs.map(l => `<section lang="${l}"><h1>${L(l, titleKey)}</h1>${bodyKey ? `<p>${L(l, bodyKey)}</p>` : ''}${extra(l)}</section>`).join('')}</main>`;
  return page({ lang: lang ? langOf(lang) : 'both', title: langs.map(l => label(l, titleKey)).join(' / '), body });
}

/**
 * The page for an unknown, revoked or switched-off link (and a deleted vendor or document): one body for
 * all of them, chosen only by ?lang= — never by anything about the link — so nothing can be learnt (§5.5).
 */
export const renderUnavailable = queryLang => messagePage(queryLang && ['en', 'sw'].includes(queryLang) ? queryLang : null, 'unavailableTitle', 'unavailableBody');
export const renderRateLimited = queryLang => messagePage(queryLang && ['en', 'sw'].includes(queryLang) ? queryLang : null, 'rateLimited', null);
export const renderServerError = queryLang => messagePage(queryLang && ['en', 'sw'].includes(queryLang) ? queryLang : null, 'serverError', null);
export const renderPdfFailed = (lang, token) => messagePage(lang, 'pdfFailedPage', null, l => `<p><a href="${esc(`${token}?lang=${l}`)}">${L(l, 'backToPage')}</a></p>`);
