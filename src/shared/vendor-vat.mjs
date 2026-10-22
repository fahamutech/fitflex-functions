// Vendor VAT (vendor business tools · S5). Pure functions: no storage.
//
// Decisions (design spec docs/design/vendor-documents-s5.md §3, recommendations applied 2026-10-20):
// - Prices include VAT (Q-11, locked): the VAT is inside the price; the customer's total never changes.
// - Per-line rounding (Q-6): lineVat = round_half_up(lineNet × r / (100 + r)) in whole TSh, where lineNet
//   = the line total after its own discount and its share of the sale discount. Document VAT = Σ line VAT.
//   Example: TSh 10,000 at 18% → 1,525 (1,525.42), net 8,475.
// - Codes (Q-12, counsel pending): A standard, C zero-rated, E exempt are in use; B and D are not offered.
//   E shows "Exempt" (never "0%"); C shows "0%".
// - VAT applies only while the vendor's VRN is verified (O-12) and VENDOR_VAT is on; never on the
//   marketplace price, commission or payout (O-10).
// TaxRate values are pricing-adjacent constants (CLAUDE.md rule 6): they live in the TaxRate table,
// changed only by maker ≠ checker approval.

export const VAT_CODES = ['A', 'B', 'C', 'D', 'E'];
export const DEFAULT_VAT_CODE = 'A';
export const EXEMPT_CODE = 'E';
export const ZERO_RATED_CODE = 'C';
export const TAX_REJECT_REASONS = ['unreadable', 'number_mismatch', 'name_mismatch', 'not_vat_certificate', 'other'];
export const TAX_RATE_REASON = { min: 3, max: 300 };
export const MAX_REJECT_NOTE = 300;

const fail = (error, status, extra = {}) => ({ error, status, ...extra });

/** The rate in hundredths of a percent (18 → 1800, 16.5 → 1650), so the arithmetic stays in integers. */
const hundredths = ratePct => Math.round(Number(ratePct) * 100);

/**
 * VAT contained in a VAT-inclusive amount, rounded half-up to a whole shilling.
 * lineNetTzs × r / (100 + r) with r in hundredths: N = net × rh, D = 10000 + rh, half-up = ⌊(2N + D) / 2D⌋.
 * Exempt (ratePct null) and 0% give 0.
 */
export function includedVat(lineNetTzs, ratePct) {
  const net = Number(lineNetTzs);
  if (!Number.isInteger(net) || net <= 0 || ratePct == null) return 0;
  const rh = hundredths(ratePct);
  if (!(rh > 0)) return 0;
  const n = BigInt(net) * BigInt(rh);
  const d = 10000n + BigInt(rh);
  return Number((2n * n + d) / (2n * d));
}

/**
 * One line's VAT snapshot. `rate` = { ratePct|null, exempt } for the code on the sale's EAT day.
 * → { vatCode, vatRatePct (0 for exempt), vatTzs, exempt }
 */
export function lineVat(lineNetTzs, vatCode, rate) {
  const exempt = Boolean(rate?.exempt) || rate?.ratePct == null;
  const ratePct = exempt ? 0 : Number(rate.ratePct);
  return { vatCode, vatRatePct: ratePct, vatTzs: exempt ? 0 : includedVat(lineNetTzs, ratePct), exempt };
}

/**
 * VAT for every line of a sale (or a vendor's part of an order).
 * lines: [{ productId, netTzs }]; codeOf(productId) → code|null; rates: Map code → { ratePct, exempt }.
 * A product without a code, or with a code that has no rate in force (B/D before counsel), is taxed as A.
 * → [{ vatCode, vatRatePct, vatTzs, exempt }] in the same order.
 */
export function vatForLines(lines, codeOf, rates) {
  return lines.map((l) => {
    let code = codeOf(l.productId) || DEFAULT_VAT_CODE;
    if (!rates.has(code)) code = DEFAULT_VAT_CODE;
    const rate = rates.get(code);
    if (!rate) throw new Error(`no VAT rate in force for code ${code}`);
    return lineVat(l.netTzs, code, rate);
  });
}

/**
 * The document's VAT summary: one row per code, in code order, then the total.
 * lines: [{ vatCode, vatRatePct, vatTzs, netTzs (VAT-inclusive line net), exempt? }] (lines without a code are left out).
 * → { rows: [{ code, ratePct|null (exempt), netTzs (before VAT), vatTzs }], totalNetTzs, totalVatTzs }
 */
export function vatSummary(lines) {
  const by = new Map();
  for (const l of lines) {
    if (!l.vatCode) continue;
    const exempt = l.vatCode === EXEMPT_CODE || l.exempt === true;
    const row = by.get(l.vatCode) || { code: l.vatCode, ratePct: exempt ? null : Number(l.vatRatePct), netTzs: 0, vatTzs: 0 };
    row.vatTzs += Number(l.vatTzs || 0);
    row.netTzs += Number(l.netTzs || 0) - Number(l.vatTzs || 0);
    by.set(l.vatCode, row);
  }
  const rows = VAT_CODES.filter(c => by.has(c)).map(c => by.get(c));
  return { rows, totalNetTzs: rows.reduce((s, r) => s + r.netTzs, 0), totalVatTzs: rows.reduce((s, r) => s + r.vatTzs, 0) };
}

// ── tax profile ─────────────────────────────────────────────────────────────

/** TIN: 9 digits once dashes and spaces are removed (TRA format). → digits | null */
export function normaliseTin(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\s-]/g, '');
  return /^\d{9}$/.test(s) ? s : null;
}
/** VRN: free format for now (Q-12): 8–15 letters/digits once dashes and spaces are removed, upper case. */
export function normaliseVrn(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{8,15}$/.test(s) ? s : null;
}

/**
 * PUT /vendor/tax-profile body → { vatRegistered, tin|null, vrn|null, certificateDocumentId|null, expectUpdatedAt|null } or an error.
 * The TIN from the KYC case wins when there is one (§6.1: read-only then); that is decided by the service.
 */
export function parseTaxProfile(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  if (typeof body.vatRegistered !== 'boolean') return fail('invalid_field', 400, { field: 'vatRegistered' });
  if ('pricesIncludeVat' in body && body.pricesIncludeVat !== true) return fail('prices_include_vat_locked', 400);
  let expectUpdatedAt = null;
  if (body.updatedAt != null) {
    if (typeof body.updatedAt !== 'string' || Number.isNaN(Date.parse(body.updatedAt))) return fail('invalid_field', 400, { field: 'updatedAt' });
    expectUpdatedAt = new Date(body.updatedAt).toISOString();
  }
  if (!body.vatRegistered) return { vatRegistered: false, tin: null, vrn: null, certificateDocumentId: null, expectUpdatedAt };
  const vrn = normaliseVrn(body.vrn);
  if (!vrn) return fail('vrn_invalid', 400);
  let tin = null;
  if (body.tin != null && body.tin !== '') {
    tin = normaliseTin(body.tin);
    if (!tin) return fail('tin_invalid', 400);
  }
  let certificateDocumentId = null;
  if (body.certificateDocumentId != null && body.certificateDocumentId !== '') {
    if (typeof body.certificateDocumentId !== 'string' || body.certificateDocumentId.length > 100) return fail('invalid_field', 400, { field: 'certificateDocumentId' });
    certificateDocumentId = body.certificateDocumentId;
  }
  return { vatRegistered: true, tin, vrn, certificateDocumentId, expectUpdatedAt };
}

/** POST /admin/kyc/vendors/:id/vat/reject body → { reason, note|null } or an error. */
export function parseVatRejection(body) {
  const reason = body?.reason;
  if (!TAX_REJECT_REASONS.includes(reason)) return fail('invalid_reason', 400, { allowed: TAX_REJECT_REASONS });
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null;
  if (note && note.length > MAX_REJECT_NOTE) return fail('note_too_long', 400, { max: MAX_REJECT_NOTE });
  if (reason === 'other' && !note) return fail('note_required', 400);
  return { reason, note };
}

// ── tax rates (admin) ───────────────────────────────────────────────────────

/** A rate with at most 2 decimals in 0–100. */
const validRate = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;

/**
 * POST /admin/tax-rates body. `codes` = Map code → { exempt, inUse }; `tomorrow` = the EAT day after today.
 * → { code, ratePct|null, effectiveFrom, reason } or an error.
 */
export function parseTaxRateProposal(body, { codes, tomorrow }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 400);
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : null;
  const meta = code ? codes.get(code) : null;
  if (!meta) return fail('invalid_code', 400, { allowed: [...codes.keys()] });
  if (!meta.inUse) return fail('code_not_in_use', 400, { code });
  let ratePct = null;
  if (meta.exempt) {
    if (body.exempt !== true || (body.ratePct != null && body.ratePct !== '')) return fail('invalid_rate', 400, { code, reason: 'exempt_code' });
  } else {
    if (body.exempt === true) return fail('invalid_rate', 400, { code, reason: 'not_exempt_code' });
    if (!validRate(body.ratePct)) return fail('invalid_rate', 400, { code, min: 0, max: 100, decimals: 2 });
    ratePct = body.ratePct;
    if (code === ZERO_RATED_CODE && ratePct !== 0) return fail('invalid_rate', 400, { code, reason: 'zero_rated' });
  }
  const day = typeof body.effectiveFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.effectiveFrom) ? body.effectiveFrom : null;
  if (!day || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    return fail('invalid_field', 400, { field: 'effectiveFrom' });
  }
  if (day < tomorrow) return fail('effective_date_past', 400, { earliest: tomorrow });
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < TAX_RATE_REASON.min) return fail('reason_required', 400, { min: TAX_RATE_REASON.min });
  if (reason.length > TAX_RATE_REASON.max) return fail('reason_too_long', 400, { max: TAX_RATE_REASON.max });
  return { code, ratePct, effectiveFrom: day, reason };
}

/**
 * The display status of each rate (§7.3), given every rate and today's EAT day.
 * approved: active (the latest in force for its code) | scheduled (future) | ended (superseded);
 * pending | rejected | withdrawn as stored. effectiveTo = the day before the next approved rate of the code.
 */
export function rateStatuses(rates, today) {
  const approved = rates.filter(r => r.status === 'approved').sort((a, b) => (a.code === b.code ? (a.effectiveFrom < b.effectiveFrom ? -1 : 1) : a.code < b.code ? -1 : 1));
  const out = new Map();
  const dayBefore = day => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  for (const code of new Set(approved.map(r => r.code))) {
    const mine = approved.filter(r => r.code === code);
    const current = [...mine].reverse().find(r => r.effectiveFrom <= today) || null;
    mine.forEach((r, i) => {
      const next = mine[i + 1];
      const status = r.effectiveFrom > today ? 'scheduled' : r === current ? 'active' : 'ended';
      out.set(r.id, { status, effectiveTo: next ? dayBefore(next.effectiveFrom) : null });
    });
  }
  for (const r of rates) if (!out.has(r.id)) out.set(r.id, { status: r.status, effectiveTo: null });
  return out;
}
