// Vendor reports (S6 §10.2): the summary PDF. pdfkit is loaded lazily through the S5 loader, so a missing
// library never stops the server; the route answers 503 pdf_unavailable. A4 portrait, built-in Helvetica,
// tagged with the chosen language; tables only (no charts); "Figures are from FitFlex records; not a tax
// document." and "Page n of m" on every page. Only the sections the caller may see are in the data.
import { pdfkitClass } from './vendor-document-pdf.mjs';
import { formatTsh } from './money-display.mjs';
import { formatDateTime, formatDay } from './vendor-documents.mjs';
import { asOfText, reportLabel, reportCount, periodInWords, methodName, coverText, bucketsOf, REPORT_LIMITS, statementLabel } from './vendor-reports.mjs';

const MM = 72 / 25.4;
const GREEN = '#1F7A3A';
const GREY = '#4B5563';
const BLACK = '#111111';
// Retest N5: one negative format, "−TSh 60,000" and "−3", with a real minus sign (U+2212).
// The built-in Helvetica cannot print U+2212: WinAnsi has no code for it and pdfkit would write garbage bytes. The
// built-in Symbol font has the glyph at code 0x2D, so `putMinusText` draws it from there. No font file is embedded
// (S5 Q-17). pdfkit knows neither Symbol's ascender nor this glyph's width, so both are placed by hand.
const MINUS = '\u2212';
const SYMBOL_MINUS_EM = 0.549; // Symbol.afm: minus WX 549
const HELVETICA_ASCENDER_EM = 0.718; // Helvetica.afm: Ascender 718
/** An amount that may be negative: "TSh 60,000" / "−TSh 60,000". */
export const pdfMoney = v => (Number(v) < 0 ? `${MINUS}${formatTsh(-Number(v))}` : formatTsh(v));
/** A unit count that may be negative (net of refunds): "3" / "−3". */
export const pdfUnits = v => (Number(v) < 0 ? `${MINUS}${-Number(v)}` : String(Number(v || 0)));
/**
 * A figure that is taken OFF the line above it (discounts, refunds, commission, cost), shown as what it does to the
 * total so the rows add up: 6,000 taken off reads "−TSh 6,000". A reversal in the period (commissionTzs −6,000 after a
 * cancelled order) gives the money back and reads "TSh 6,000": −60,000 + 6,000 + 40,000 = −14,000.
 */
export const pdfDeduction = v => pdfMoney(-Number(v || 0));
const money = pdfMoney;
/** UAT D12: percentages with one decimal, "25.0%"; unknown → "—". */
export const pctText = v => (v == null ? '—' : `${Number(v) < 0 ? MINUS : ''}${Math.abs(Number(v)).toFixed(1)}%`);

function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/**
 * The summary PDF. `summary` = the service's summary data (with its PDF extras), `salesRows` = the by-bucket
 * rows to print (≤ 31), `stock` / `payoutWeeks` optional section data. → Buffer.
 */
export async function renderReportPdf({ summary, salesRows, stock = null, payoutWeeks = null, businessName, generatedBy = null, lang = 'en' }) {
  const PDFDocument = await pdfkitClass();
  const L = (k, v) => reportLabel(lang, k, v);
  const title = `${L('title')} · ${periodInWords(summary.from, summary.to, lang)}`;
  const doc = new PDFDocument({
    size: 'A4', margins: { top: 15 * MM, bottom: 15 * MM, left: 15 * MM, right: 15 * MM }, bufferPages: true, tagged: true,
    lang: lang === 'sw' ? 'sw' : 'en', displayTitle: true, pdfVersion: '1.7',
    info: { Title: title, Author: businessName || 'FitFlex', Subject: L('title'), Creator: 'FitFlex', Producer: 'FitFlex' },
  });
  const done = collect(doc);
  const root = doc.struct('Document');
  doc.addStructure(root);
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 28;
  const ensure = h => { if (doc.y + h > bottom()) { doc.addPage(); return true; } return false; };
  const widthOf = (text, size) => text.split(MINUS).reduce((w, part, i) => w + doc.widthOfString(part) + (i ? SYMBOL_MINUS_EM * size : 0), 0);
  /** Text in Helvetica at `size` that contains U+2212: greedy wrap, then Helvetica and Symbol runs placed by hand. */
  function putMinusText(text, x, y, boxWidth, align, size) {
    const lines = [];
    for (const word of text.split(' ')) {
      const line = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
      if (lines.length && widthOf(line, size) <= boxWidth) lines[lines.length - 1] = line;
      else lines.push(word);
    }
    const height = doc.currentLineHeight(true);
    lines.forEach((line, i) => {
      const lineY = y + i * height;
      let cursor = align === 'right' ? x + boxWidth - widthOf(line, size) : x;
      line.split(MINUS).forEach((part, index) => {
        if (index) {
          doc.font('Symbol').text('-', cursor, lineY + HELVETICA_ASCENDER_EM * size, { lineBreak: false });
          doc.font('Helvetica');
          cursor += SYMBOL_MINUS_EM * size;
        }
        if (part) { doc.text(part, cursor, lineY, { lineBreak: false }); cursor += doc.widthOfString(part); }
      });
    });
    doc.x = x;
    doc.y = y + lines.length * height;
  }
  const P = (text, opts = {}, type = 'P') => root.add(doc.struct(type, () => {
    if (String(text).includes(MINUS)) putMinusText(String(text), opts.x ?? left, opts.y ?? doc.y, opts.width ?? width, opts.align, opts.size ?? 10);
    else doc.text(text, opts.x ?? left, opts.y, { width: opts.width ?? width, align: opts.align });
  }));
  // UAT D9: a heading moves to the next page unless the heading, a note and the table header with its first
  // rows (≈ 110pt) fit under it — never an orphaned heading at the foot of a page.
  const KEEP_WITH_NEXT = 110;
  const h2 = text => { ensure(KEEP_WITH_NEXT); doc.y += 8; doc.font('Helvetica-Bold').fontSize(12).fillColor(BLACK); P(text, {}, 'H2'); doc.font('Helvetica').fontSize(10); doc.y += 2; };
  const note = text => { doc.font('Helvetica').fontSize(9).fillColor(GREY); P(text, { size: 9 }); doc.fillColor(BLACK).fontSize(10); };

  function table(columns, rows) {
    const fixed = columns.filter(c => c.width).reduce((s, c) => s + c.width, 0);
    const flex = columns.filter(c => !c.width).length || 1;
    const cols = columns.map(c => ({ ...c, w: c.width || (width - fixed) / flex }));
    const header = () => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GREY);
      const hh = Math.max(...cols.map(c => doc.heightOfString(c.title, { width: c.w - 4 }))) + 4;
      const y = doc.y;
      let x = left;
      for (const c of cols) { root.add(doc.struct('TH', () => doc.text(c.title, x + 2, y, { width: c.w - 4, align: c.align || 'left' }))); x += c.w; }
      doc.y = y + hh;
      doc.save().moveTo(left, doc.y - 1).lineTo(left + width, doc.y - 1).lineWidth(0.5).strokeColor('#D1D5DB').stroke().restore();
    };
    ensure(40);
    header();
    doc.font('Helvetica').fontSize(9).fillColor(BLACK);
    for (const row of rows) {
      const h = Math.max(...cols.map((c, i) => doc.heightOfString(String(row[i] ?? '').replaceAll(MINUS, '+'), { width: c.w - 4 }))) + 5;
      if (ensure(h)) { header(); doc.font('Helvetica').fontSize(9).fillColor(BLACK); }
      const y = doc.y;
      let x = left;
      cols.forEach((c, i) => {
        const cell = String(row[i] ?? '');
        root.add(doc.struct('TD', () => {
          if (cell.includes(MINUS)) putMinusText(cell, x + 2, y + 2, c.w - 4, c.align || 'left', 9);
          else doc.text(cell, x + 2, y + 2, { width: c.w - 4, align: c.align || 'left' });
        }));
        x += c.w;
      });
      doc.y = y + h;
    }
    doc.x = left;
    doc.y += 4;
  }
  const pairs = list => table([{ title: L('figure') }, { title: L('value'), width: 160, align: 'right' }], list);

  // Header.
  doc.font('Helvetica-Bold').fontSize(16).fillColor(BLACK);
  P(businessName || '', {}, 'H1');
  doc.font('Helvetica-Bold').fontSize(12);
  P(`${L('title')}: ${periodInWords(summary.from, summary.to, lang)}${summary.inProgress ? ` ${L('soFar')}` : ''}`);
  doc.font('Helvetica').fontSize(9).fillColor(GREY);
  const channelWord = summary.channel === 'app' ? L('appOnly') : summary.channel === 'walk_in' ? L('shopOnly') : L('allSales');
  P(`${channelWord} · ${generatedBy ? L('generated', { date: formatDateTime(summary.generatedAt, lang), name: generatedBy }) : L('generatedNoName', { date: formatDateTime(summary.generatedAt, lang) })}`);
  doc.y += 4;
  doc.save().moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1.5).strokeColor(GREEN).stroke().restore();
  doc.y += 6;
  doc.fillColor(BLACK);

  // Sales.
  const s = summary.sales;
  h2(L('net'));
  pairs([
    [L('gross'), money(s.grossTzs)], [L('discounts'), pdfDeduction(s.discountTzs)], [L('refunds'), pdfDeduction(s.refundTzs)], [L('net'), money(s.netTzs)],
    ...(s.vatIncludedTzs ? [[L('vatIncluded'), money(s.vatIncludedTzs)]] : []),
    [L('salesCount'), String(s.saleCount + s.orderCount)], [L('itemsSold'), pdfUnits(s.itemsSold)],
  ]);
  if (s.voided?.count) note(reportCount(lang, 'voided', s.voided.count, { amount: money(s.voided.totalTzs) }));
  table([{ title: L('periodStart'), width: 90 }, { title: L('appNet'), align: 'right' }, { title: L('shopNet'), align: 'right' }, { title: L('net'), align: 'right' }, { title: L('salesCount'), width: 60, align: 'right' }],
    salesRows.map(b => [b.start === b.end ? formatDay(b.start, lang) : `${formatDay(b.start, lang)} – ${formatDay(b.end, lang)}`, money(b.app.netTzs), money(b.walkIn.netTzs), money(b.netTzs), String(b.app.count + b.walkIn.count)]));

  // Products.
  const pdf = summary._pdf || { top: [], slow: [], methods: summary.methods };
  const pname = r => `${r.name || ''}${r.variant ? ` (${r.variant})` : ''}${r.removed ? ` ${L('removed')}` : ''}`;
  h2(L('topProducts'));
  if (pdf.top.length) table([{ title: L('product') }, { title: L('unitsSold'), width: 70, align: 'right' }, { title: L('revenue'), width: 110, align: 'right' }], pdf.top.map(r => [pname(r), pdfUnits(r.unitsSold), money(r.netRevenueTzs)]));
  else note(L('none'));
  h2(L('slowSellers'));
  if (pdf.slow.length) table([{ title: L('product') }, { title: L('unitsSold'), width: 60, align: 'right' }, { title: L('lastSold'), width: 85 }, { title: L('inStock'), width: 55, align: 'right' }, { title: L('cover'), width: 100 }],
    pdf.slow.map(r => [pname(r), pdfUnits(r.unitsSold), r.lastSoldAt ? formatDay(r.lastSoldAt, lang) : L('never'), r.stock == null ? '—' : String(r.stock), coverText(lang, r)]));
  else note(L('none'));

  if (stock) {
    h2(L('stockValue'));
    note(asOfText(lang, stock.asOf, new Date(summary.generatedAt)));
    pairs([[L('atRetail'), money(stock.totals.atRetailTzs)], ...(stock.totals.atCostTzs != null ? [[L('atCost'), money(stock.totals.atCostTzs)]] : []), [L('units'), String(stock.totals.units)], [L('products'), String(stock.totals.products)]]);
    if (stock.costUnknown?.count) note(reportCount(lang, 'costUnknown', stock.costUnknown.count));
  }
  if (summary.profit) {
    const p = summary.profit;
    h2(L('profit'));
    pairs([[L('netExVat'), money(p.netExVatTzs)], [L('commission'), pdfDeduction(p.commissionTzs)], [L('cogs'), pdfDeduction(p.costTzs)], [L('profit'), p.profitTzs == null ? '—' : money(p.profitTzs)], [L('margin'), pctText(p.marginPct)]]);
    if (p.uncosted.qty) note(reportCount(lang, 'uncosted', p.uncosted.qty, { n: pdfUnits(p.uncosted.qty), amount: money(p.uncosted.revenueTzs) }));
    if (s.vatIncludedTzs) note(L('profitNoVat'));
  }
  if (summary.payouts) {
    const p = summary.payouts;
    h2(L('payouts'));
    note(L('payoutsBasis'));
    pairs([[L('appSales'), money(p.grossTzs)], [L('commission'), pdfDeduction(p.commissionTzs)], [L('youReceive'), money(p.payoutTzs)], [L('paidOut'), money(p.paidOutTzs)], [L('waiting'), money(p.waitingTzs)], [L('notDelivered'), money(p.notDeliveredTzs)]]);
    if (payoutWeeks?.length) table([{ title: L('weekStart'), width: 90 }, { title: L('orders'), width: 50, align: 'right' }, { title: L('appSales'), align: 'right' }, { title: L('youReceive'), align: 'right' }, { title: L('statement'), width: 110 }],
      payoutWeeks.map(w => [formatDay(w.periodStartDate, lang), String(w.orderCount), money(w.grossTzs), money(w.payoutTzs), statementLabel(lang, w)]));
  }
  if (summary.customers) {
    h2(L('customers'));
    pairs([[L('owed'), money(summary.customers.owedTzs)], [L('overdue'), money(summary.customers.overdueTzs)], [L('collected'), money(summary.customers.collectedTzs)]]);
  }
  h2(L('methods'));
  const groups = [[L('byYou'), pdf.methods.byYou.map(r => [r.method === 'cash' ? L('netOfChange') : methodName(lang, r.method), money(r.amountTzs), pctText(r.sharePct)])],
    [L('viaFitFlex'), pdf.methods.viaFitFlex.map(r => [methodName(lang, r.paymentMethod), money(r.amountTzs), pctText(r.sharePct)])]];
  // Retest N6: no payments in the period reads like the other empty sections, not a bare heading.
  if (!groups.some(([, rows]) => rows.length)) note(L('none'));
  for (const [group, rows] of groups) {
    if (!rows.length) continue;
    ensure(KEEP_WITH_NEXT - 30); doc.font('Helvetica-Bold').fontSize(10); P(group); doc.font('Helvetica');
    table([{ title: L('method') }, { title: L('amount'), width: 120, align: 'right' }, { title: L('share'), width: 60, align: 'right' }], rows);
  }

  root.end();
  // Footer on every page, as an artifact (not read aloud).
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.markContent('Artifact', { type: 'Pagination' });
    doc.font('Helvetica').fontSize(8).fillColor(GREY);
    doc.text(`${L('footer')} · ${L('pageOf', { n: i - range.start + 1, m: range.count })}`, left, doc.page.height - saved - 14, { width, align: 'center', lineBreak: false });
    doc.endMarkedContent();
    doc.page.margins.bottom = saved;
  }
  doc.end();
  return done;
}

/** The by-bucket rows the PDF prints: the chosen grouping when ≤ 31 rows, else by week, else by month. */
export function pdfGroupBy(from, to, groupBy) {
  for (const g of [groupBy, 'week', 'month']) if (bucketsOf(from, to, g).length <= REPORT_LIMITS.pdfBucketRows) return g;
  return 'month';
}
