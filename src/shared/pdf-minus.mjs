// A real minus sign (U+2212) in pdfkit PDFs that use the built-in fonts (S7 UAT L-2; same approach as the S6
// report PDF, src/shared/vendor-report-pdf.mjs, retest N5).
// The built-in Helvetica cannot print U+2212: WinAnsi has no code for it and pdfkit would write garbage bytes. The
// built-in Symbol font has the glyph at code 0x2D, so text containing U+2212 is drawn as Helvetica runs with the
// minus taken from Symbol. No font file is embedded (S5 Q-17). pdfkit knows neither Symbol's ascender nor this
// glyph's width, so both are placed by hand. Text without U+2212 goes straight to doc.text, unchanged.
export const MINUS = '−';
const SYMBOL_MINUS_EM = 0.549; // Symbol.afm: minus WX 549
const HELVETICA_ASCENDER_EM = 0.718; // Helvetica.afm: Ascender 718

/** Height of `text` as pdfkit would lay it out (the minus measured as a "+", about the same width). */
export const heightWithMinus = (doc, text, opts) => doc.heightOfString(String(text ?? '').replaceAll(MINUS, '+'), opts);

/**
 * doc.text(text, x, y, opts) that prints U+2212 correctly. With a minus: greedy word wrap inside opts.width, then
 * runs in the current font and Symbol placed by hand; doc.x / doc.y end as after doc.text.
 */
export function textWithMinus(doc, text, x, y, opts = {}) {
  const s = String(text ?? '');
  if (!s.includes(MINUS)) return doc.text(s, x, y, opts);
  const startX = x ?? doc.x;
  const startY = y ?? doc.y;
  const size = doc._fontSize;
  const font = doc._font?.name || 'Helvetica';
  const widthOf = t => t.split(MINUS).reduce((w, part, i) => w + doc.widthOfString(part) + (i ? SYMBOL_MINUS_EM * size : 0), 0);
  const box = opts.width ?? (doc.page.width - doc.page.margins.right - startX);
  const lines = [];
  for (const word of s.split(' ')) {
    const line = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
    if (lines.length && (opts.lineBreak === false || widthOf(line) <= box)) lines[lines.length - 1] = line;
    else lines.push(word);
  }
  const height = doc.currentLineHeight(true);
  lines.forEach((line, i) => {
    const lineY = startY + i * height;
    let cursor = opts.align === 'right' ? startX + box - widthOf(line) : opts.align === 'center' ? startX + (box - widthOf(line)) / 2 : startX;
    line.split(MINUS).forEach((part, index) => {
      if (index) {
        doc.font('Symbol').text('-', cursor, lineY + HELVETICA_ASCENDER_EM * size, { lineBreak: false });
        doc.font(font);
        cursor += SYMBOL_MINUS_EM * size;
      }
      if (part) { doc.text(part, cursor, lineY, { lineBreak: false }); cursor += doc.widthOfString(part); }
    });
  });
  doc.x = startX;
  doc.y = startY + lines.length * height;
  return doc;
}
