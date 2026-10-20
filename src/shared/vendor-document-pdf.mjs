// Vendor documents (S5): PDF of a document with pdfkit (O-4, new dependency), from the same document JSON as
// the HTML page. A4 (default) or 80mm receipt paper (Q-5). Built-in Helvetica only (Q-17: no font files,
// small PDFs for WhatsApp). Tagged PDF with lang and title; footer on every page with "not a TRA fiscal
// receipt" and "Page n of m"; a diagonal CANCELLED watermark at 12% on cancelled documents. The vendor's
// logo is NOT embedded: that would make the server fetch a vendor-supplied URL (SSRF); the HTML page
// shows it instead. Design spec §8.
import PDFDocument from 'pdfkit';
import { label, langOf, money, formatDay, formatDateTime, methodLabel, titleOf, DOC_LABELS } from './vendor-documents.mjs';

const MM = 72 / 25.4;
const GREEN = '#1F7A3A';
const GREY = '#4B5563';
const BLACK = '#111111';
const statusKey = { paid: 'statusPaid', pay_later: 'statusPayLater', paid_in_full: 'statusPaidInFull', cancelled: 'statusCancelled' };
const vatRate = (lang, code, ratePct) => (code === 'E' || ratePct == null ? label(lang, 'exempt') : `${Number(ratePct)}%`);
const lineName = l => `${l.name}${l.variant ? ` (${l.variant})` : ''}`;
const amountOnly = v => Number(v || 0).toLocaleString('en-US');

function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function newDoc(document, lang, { size, margins }) {
  const business = document.seller?.businessName || 'FitFlex';
  const title = document.number ? `${titleOf(document, lang)} ${document.number}` : titleOf(document, lang);
  return new PDFDocument({
    size, margins, bufferPages: true, autoFirstPage: true, tagged: true, lang: lang === 'sw' ? 'sw' : 'en', displayTitle: true, pdfVersion: '1.7',
    info: { Title: title, Author: business, Subject: title, Creator: 'FitFlex', Producer: 'FitFlex' },
  });
}

// ── A4 ──────────────────────────────────────────────────────────────────────

function renderA4(doc, d, lang, root) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 28; // room for the footer
  const ensure = (h) => { if (doc.y + h > bottom()) { doc.addPage(); return true; } return false; };
  const P = (text, opts = {}, type = 'P') => root.add(doc.struct(type, () => { doc.text(text, opts.x ?? left, opts.y, { width: opts.width ?? width, align: opts.align, lineBreak: opts.lineBreak }); }));
  const business = d.seller?.businessName || '';

  // Header: seller on the left, title on the right.
  const top = doc.y;
  const half = width / 2 - 8;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(BLACK);
  P(business, { width: half });
  doc.font('Helvetica').fontSize(10).fillColor(GREY);
  for (const t of [d.seller?.address, d.seller?.contactNumber, d.seller?.tin && label(lang, 'tin', { tin: d.seller.tin }), d.seller?.vrn && label(lang, 'vrn', { vrn: d.seller.vrn }), d.soldVia]) {
    if (t) P(t, { width: half });
  }
  const leftEnd = doc.y;
  const heading = d.number ? `${titleOf(d, lang)} ${d.number}` : titleOf(d, lang);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(BLACK);
  P(heading, { x: left + width / 2 + 8, y: top, width: half, align: 'right' }, 'H1');
  doc.font('Helvetica').fontSize(10).fillColor(GREY);
  for (const t of [d.saleRef && label(lang, 'saleRef', { number: d.saleRef }), d.orderShortRef && label(lang, 'orderRef', { ref: d.orderShortRef })]) {
    if (t) P(t, { x: left + width / 2 + 8, width: half, align: 'right' });
  }
  if (d.status) { doc.font('Helvetica-Bold').fillColor(d.status === 'cancelled' ? '#B91C1C' : BLACK); P(label(lang, statusKey[d.status]), { x: left + width / 2 + 8, width: half, align: 'right' }); }
  doc.y = Math.max(leftEnd, doc.y) + 6;
  doc.save().moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1.5).strokeColor(GREEN).stroke().restore();
  doc.y += 8;

  // Meta.
  doc.font('Helvetica').fontSize(10).fillColor(BLACK);
  P(`${label(lang, 'date')}: ${formatDateTime(d.docType === 'statement' ? d.statement.asOf : d.issuedAt, lang)}`);
  if (d.docType === 'statement') { doc.font('Helvetica-Bold'); P(label(lang, 'asOf', { date: formatDateTime(d.statement.asOf, lang) })); doc.font('Helvetica'); }
  if (d.customer?.name) P(label(lang, 'customer', { name: d.customer.name }));
  if (d.dueDate) P(label(lang, 'dueBy', { date: formatDay(d.dueDate, lang) }));
  if (d.servedBy?.firstName) P(label(lang, 'servedBy', { name: d.servedBy.firstName }));
  if (d.paymentMethod) P(label(lang, 'paidBy', { method: methodLabel(lang, d.paymentMethod) }));
  doc.y += 6;

  if (d.status === 'cancelled') {
    const text = label(lang, 'cancelled', { date: d.cancelledAt ? formatDay(d.cancelledAt, lang) : '', business });
    const h = doc.heightOfString(text, { width: width - 16 }) + 12;
    ensure(h);
    doc.save().rect(left, doc.y, width, h).lineWidth(1.5).strokeColor('#B91C1C').stroke().restore();
    const y0 = doc.y;
    doc.font('Helvetica-Bold').fillColor('#7F1D1D');
    P(text, { x: left + 8, y: y0 + 6, width: width - 16 });
    doc.y = y0 + h + 8;
    doc.font('Helvetica').fillColor(BLACK);
  }

  // A table with a header row repeated on every page.
  function table(columns, rows, { header = true } = {}) {
    const drawHeader = () => {
      if (!header) return;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GREY);
      const y = doc.y;
      let x = left;
      for (const c of columns) {
        root.add(doc.struct('TH', () => doc.text(c.title, x + 2, y, { width: c.width - 4, align: c.align || 'left', lineBreak: false })));
        x += c.width;
      }
      doc.y = y + 14;
      doc.save().moveTo(left, doc.y - 2).lineTo(left + width, doc.y - 2).lineWidth(0.5).strokeColor('#D1D5DB').stroke().restore();
    };
    drawHeader();
    doc.font('Helvetica').fontSize(10).fillColor(BLACK);
    for (const row of rows) {
      const h = Math.max(...columns.map((c, i) => doc.heightOfString(String(row[i] ?? ''), { width: c.width - 4 }))) + 6;
      if (ensure(h)) { drawHeader(); doc.font('Helvetica').fontSize(10).fillColor(BLACK); }
      const y = doc.y;
      let x = left;
      columns.forEach((c, i) => {
        root.add(doc.struct('TD', () => doc.text(String(row[i] ?? ''), x + 2, y + 2, { width: c.width - 4, align: c.align || 'left' })));
        x += c.width;
      });
      doc.y = y + h;
    }
    doc.y += 4;
    doc.x = left;
  }
  const heading2 = (text) => { ensure(30); doc.y += 6; doc.font('Helvetica-Bold').fontSize(11).fillColor(BLACK); P(text, {}, 'H2'); doc.font('Helvetica').fontSize(10); };
  const pair = (a, b, { bold = false } = {}) => {
    ensure(16);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(BLACK);
    const y = doc.y;
    root.add(doc.struct('P', () => {
      doc.text(a, left + width / 2, y, { width: width / 4, lineBreak: false });
      doc.text(b, left + (3 * width) / 4, y, { width: width / 4, align: 'right', lineBreak: false });
    }));
    doc.y = y + (bold ? 17 : 14);
    doc.x = left;
    doc.font('Helvetica').fontSize(10);
  };

  if (d.lines?.length) {
    const hasVat = d.lines.some(l => l.vatCode);
    const fixed = [40, 80, 70, 85, ...(hasVat ? [34] : [])];
    const cols = [
      { title: label(lang, 'item'), width: width - fixed.reduce((s, w) => s + w, 0) },
      { title: label(lang, 'qty'), width: 40, align: 'right' },
      { title: label(lang, 'price'), width: 80, align: 'right' },
      { title: label(lang, 'discount'), width: 70, align: 'right' },
      { title: label(lang, 'amount'), width: 85, align: 'right' },
      ...(hasVat ? [{ title: label(lang, 'vat'), width: 34 }] : []),
    ];
    table(cols, d.lines.map(l => [lineName(l), l.qty, money(l.unitPriceTzs), l.discountTzs ? `-${amountOnly(l.discountTzs)}` : '', money(l.amountTzs), ...(hasVat ? [l.vatCode || ''] : [])]));
  }

  if (!['statement', 'payment_receipt'].includes(d.docType)) {
    pair(label(lang, 'subtotal'), money(d.subtotalTzs));
    if (d.discountsTzs > 0) pair(label(lang, 'discounts'), `-${amountOnly(d.discountsTzs)}`);
    pair(label(lang, 'total'), money(d.totalTzs), { bold: true });
    if (d.vatSummary?.length) pair(label(lang, 'includesVat', { amount: money(d.vatIncludedTzs) }), '');
  }

  if (d.vatSummary?.length) {
    heading2(label(lang, 'vatSummary'));
    const net = d.vatSummary.reduce((s, r) => s + r.netTzs, 0);
    table(
      [{ title: label(lang, 'vatCode'), width: 80 }, { title: label(lang, 'vatRate'), width: 100 }, { title: label(lang, 'vatNet'), width: (width - 180) / 2, align: 'right' }, { title: label(lang, 'vat'), width: (width - 180) / 2, align: 'right' }],
      [...d.vatSummary.map(r => [r.code, vatRate(lang, r.code, r.ratePct), money(r.netTzs), money(r.vatTzs)]), [label(lang, 'total'), '', money(net), money(d.vatIncludedTzs)]],
    );
  }

  if (d.docType !== 'statement' && (d.payments?.length || d.liveStatus || d.paidTowards)) {
    heading2(label(lang, 'payments'));
    for (const p of d.payments || []) pair(`${methodLabel(lang, p.method)}${p.reference ? ` (${p.reference})` : ''}`, money(p.amountTzs));
    if (d.changeTzs > 0) pair(label(lang, 'change'), money(d.changeTzs));
    if (d.paidNowTzs != null) pair(label(lang, 'paidNow'), money(d.paidNowTzs));
    if (d.liveStatus) {
      const ls = d.liveStatus;
      const lines = [label(lang, 'statusOn', { date: formatDay(ls.asOf, lang) }),
        ls.paidInFullAt ? label(lang, 'paidInFull', { date: formatDay(ls.paidInFullAt, lang) }) : `${label(lang, 'balanceDue')}: ${money(ls.balanceTzs)}`,
        ...(ls.paidWith?.length ? [label(lang, 'paidWith', { numbers: ls.paidWith.join(', ') })] : [])];
      const text = lines.join('\n');
      const h = doc.heightOfString(text, { width: width - 16 }) + 12;
      ensure(h + 4);
      const y0 = doc.y + 4;
      doc.save().rect(left, y0, width, h).lineWidth(0.75).strokeColor('#9CA3AF').stroke().restore();
      P(text, { x: left + 8, y: y0 + 6, width: width - 16 });
      doc.y = y0 + h + 6;
    }
    if (d.paidTowards) {
      heading2(label(lang, 'paidTowards'));
      for (const a of d.paidTowards) pair(a.number, money(a.amountTzs));
      if (d.stillOwedTzs != null) pair(label(lang, 'stillOwed'), money(d.stillOwedTzs), { bold: true });
    }
  }

  if (d.docType === 'statement') {
    const st = d.statement;
    heading2(label(lang, 'openSales'));
    if (st.openSales.length) {
      table([{ title: '#', width: 100 }, { title: label(lang, 'sold'), width: 90 }, { title: label(lang, 'due'), width: 90 }, { title: label(lang, 'balance'), width: 100, align: 'right' }, { title: '', width: width - 380 }],
        st.openSales.map(s => [s.number, formatDay(s.soldAt, lang), formatDay(s.dueDate, lang), money(s.balanceTzs), s.daysOverdue > 0 ? label(lang, 'daysOverdue', { n: s.daysOverdue }) : '']));
    } else P('—');
    heading2(label(lang, 'recentPayments'));
    if (st.recentPayments.length) {
      table([{ title: '#', width: 100 }, { title: label(lang, 'date'), width: 110 }, { title: '', width: width - 330 }, { title: label(lang, 'amount'), width: 120, align: 'right' }],
        st.recentPayments.map(p => [p.number, formatDay(p.receivedOn, lang), methodLabel(lang, p.method), money(p.amountTzs)]), { header: false });
    } else P('—');
    pair(label(lang, 'totalOwed'), money(st.totalOwedTzs), { bold: true });
    const a = st.aging || {};
    doc.fillColor(GREY).fontSize(9);
    P(label(lang, 'aging', Object.fromEntries(['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'].map(k => [k, money(a[k] || 0)]))));
  }

  ensure(40);
  doc.y += 10;
  doc.font('Helvetica').fontSize(9).fillColor(GREY);
  if (['receipt', 'payment_receipt'].includes(d.docType) && d.status !== 'cancelled') P(label(lang, 'receivedBy', { business }));
  P(label(lang, 'copyNote', { business }));
}

/** Footer (and the cancelled watermark) on every buffered page, as artifacts (not read aloud). */
function finishPages(doc, d, lang, { footer = true } = {}) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing near the bottom must not start a new page
    doc.markContent('Artifact', { type: 'Pagination' });
    if (d.status === 'cancelled') {
      doc.save();
      doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.fillOpacity(0.12).fillColor('#B91C1C').font('Helvetica-Bold').fontSize(doc.page.width > 400 ? 44 : 16);
      doc.text(DOC_LABELS.en.watermark, 0, doc.page.height / 2 - 20, { width: doc.page.width, align: 'center', lineBreak: false });
      doc.restore();
    }
    if (footer) {
      const y = doc.page.height - savedBottom - 14;
      const left = doc.page.margins.left;
      const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.fillOpacity(1).font('Helvetica').fontSize(8).fillColor(GREY);
      const pageText = label(lang, 'pageOf', { n: i - range.start + 1, m: range.count });
      doc.text(`${label(lang, 'notFiscal')} · ${d.number ? `${d.number} · ` : ''}${pageText}`, left, y, { width, align: 'center', lineBreak: false });
    }
    doc.endMarkedContent();
    doc.page.margins.bottom = savedBottom;
  }
}

// ── 80mm receipt paper ──────────────────────────────────────────────────────

function render80(doc, d, lang, root) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const P = (text, { align = 'left', bold = false, size = 8, color = BLACK } = {}, type = 'P') => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
    root.add(doc.struct(type, () => doc.text(text, left, doc.y, { width, align })));
  };
  const pair = (a, b, opts = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(BLACK);
    const y = doc.y;
    root.add(doc.struct('P', () => { doc.text(a, left, y, { width: width * 0.6 }); }));
    const yEnd = doc.y;
    root.add(doc.struct('P', () => { doc.text(b, left + width * 0.6, y, { width: width * 0.4, align: 'right' }); }));
    doc.y = Math.max(yEnd, doc.y);
  };
  const rule = () => { doc.y += 2; doc.save().moveTo(left, doc.y).lineTo(left + width, doc.y).dash(1.5, { space: 1.5 }).lineWidth(0.5).strokeColor('#666').stroke().undash().restore(); doc.y += 3; };
  const business = d.seller?.businessName || '';
  P(business, { align: 'center', bold: true, size: 10 });
  for (const t of [d.seller?.address, d.seller?.contactNumber, d.seller?.tin && label(lang, 'tin', { tin: d.seller.tin }), d.seller?.vrn && label(lang, 'vrn', { vrn: d.seller.vrn }), d.soldVia]) if (t) P(t, { align: 'center' });
  rule();
  P(d.number ? `${titleOf(d, lang)} ${d.number}` : titleOf(d, lang), { bold: true, size: 9 }, 'H1');
  if (d.saleRef) P(label(lang, 'saleRef', { number: d.saleRef }));
  if (d.orderShortRef) P(label(lang, 'orderRef', { ref: d.orderShortRef }));
  if (d.status) P(label(lang, statusKey[d.status]), { bold: true });
  if (d.status === 'cancelled') P(label(lang, 'cancelled', { date: d.cancelledAt ? formatDay(d.cancelledAt, lang) : '', business }), { bold: true });
  P(formatDateTime(d.docType === 'statement' ? d.statement.asOf : d.issuedAt, lang));
  if (d.customer?.name) P(label(lang, 'customer', { name: d.customer.name }));
  if (d.dueDate) P(label(lang, 'dueBy', { date: formatDay(d.dueDate, lang) }));
  if (d.servedBy?.firstName) P(label(lang, 'servedBy', { name: d.servedBy.firstName }));
  if (d.paymentMethod) P(label(lang, 'paidBy', { method: methodLabel(lang, d.paymentMethod) }));
  if (d.lines?.length) {
    rule();
    for (const l of d.lines) {
      P(lineName(l));
      pair(`${l.qty} x ${amountOnly(l.unitPriceTzs)}${l.discountTzs ? ` -${amountOnly(l.discountTzs)}` : ''}`, `${amountOnly(l.amountTzs)}${l.vatCode ? ` ${l.vatCode}` : ''}`);
    }
  }
  if (!['statement', 'payment_receipt'].includes(d.docType)) {
    rule();
    pair(label(lang, 'subtotal'), money(d.subtotalTzs));
    if (d.discountsTzs > 0) pair(label(lang, 'discounts'), `-${amountOnly(d.discountsTzs)}`);
    pair(label(lang, 'total'), money(d.totalTzs), { bold: true });
  }
  if (d.vatSummary?.length) {
    for (const r of d.vatSummary) P(`${r.code} ${vatRate(lang, r.code, r.ratePct)}  ${label(lang, 'vat')} ${amountOnly(r.vatTzs)}`);
    P(label(lang, 'includesVat', { amount: money(d.vatIncludedTzs) }));
  }
  if (d.docType !== 'statement' && (d.payments?.length || d.liveStatus || d.paidTowards)) {
    rule();
    for (const p of d.payments || []) pair(`${methodLabel(lang, p.method)}${p.reference ? ` ${p.reference}` : ''}`, amountOnly(p.amountTzs));
    if (d.changeTzs > 0) pair(label(lang, 'change'), amountOnly(d.changeTzs));
    if (d.paidNowTzs != null) pair(label(lang, 'paidNow'), amountOnly(d.paidNowTzs));
    if (d.liveStatus) {
      P(label(lang, 'statusOn', { date: formatDay(d.liveStatus.asOf, lang) }));
      P(d.liveStatus.paidInFullAt ? label(lang, 'paidInFull', { date: formatDay(d.liveStatus.paidInFullAt, lang) }) : `${label(lang, 'balanceDue')}: ${money(d.liveStatus.balanceTzs)}`, { bold: true });
    }
    if (d.paidTowards) {
      P(label(lang, 'paidTowards'), { bold: true });
      for (const a of d.paidTowards) pair(a.number, amountOnly(a.amountTzs));
      if (d.stillOwedTzs != null) pair(label(lang, 'stillOwed'), money(d.stillOwedTzs), { bold: true });
    }
  }
  if (d.docType === 'statement') {
    rule();
    P(label(lang, 'openSales'), { bold: true });
    for (const s of d.statement.openSales) pair(`${s.number} ${formatDay(s.dueDate, lang)}`, amountOnly(s.balanceTzs));
    P(label(lang, 'recentPayments'), { bold: true });
    for (const p of d.statement.recentPayments) pair(`${p.number} ${formatDay(p.receivedOn, lang)}`, amountOnly(p.amountTzs));
    pair(label(lang, 'totalOwed'), money(d.statement.totalOwedTzs), { bold: true });
  }
  rule();
  if (['receipt', 'payment_receipt'].includes(d.docType) && d.status !== 'cancelled') P(label(lang, 'receivedBy', { business }), { align: 'center' });
  P(label(lang, 'notFiscal'), { align: 'center', bold: true });
  P(label(lang, 'copyNote', { business }), { align: 'center', color: GREY });
}

/**
 * The PDF of a document. paper 'a4' (default) | '80mm'. → Buffer.
 * 80mm is continuous: the page is as tall as the content (measured in a first pass).
 */
export async function renderDocumentPdf(document, { lang = document.lang, paper = 'a4' } = {}) {
  const l = langOf(lang);
  if (paper === '80mm') {
    const margins = { top: 4 * MM, bottom: 4 * MM, left: 4 * MM, right: 4 * MM };
    const widthPt = 80 * MM;
    // Pass 1: measure on a very tall page.
    const probe = newDoc(document, l, { size: [widthPt, 4000], margins });
    const probeRoot = probe.struct('Document');
    probe.addStructure(probeRoot);
    render80(probe, document, l, probeRoot);
    const height = Math.ceil(probe.y + margins.bottom + 2);
    probeRoot.end();
    const drained = collect(probe);
    probe.end();
    await drained;
    const doc = newDoc(document, l, { size: [widthPt, Math.max(height, 60 * MM)], margins });
    const done = collect(doc);
    const root = doc.struct('Document');
    doc.addStructure(root);
    render80(doc, document, l, root);
    root.end();
    finishPages(doc, document, l, { footer: false });
    doc.end();
    return done;
  }
  const doc = newDoc(document, l, { size: 'A4', margins: { top: 15 * MM, bottom: 15 * MM, left: 15 * MM, right: 15 * MM } });
  const done = collect(doc);
  const root = doc.struct('Document');
  doc.addStructure(root);
  renderA4(doc, document, l, root);
  root.end();
  finishPages(doc, document, l);
  doc.end();
  return done;
}
