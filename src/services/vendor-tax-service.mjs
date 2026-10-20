// Vendor VAT (vendor business tools · S5): the vendor tax profile, its KYC review, tax rates with
// maker ≠ checker approval, and the codes offered for products.
//
// Decisions (design spec docs/design/vendor-documents-s5.md, recommendations applied 2026-10-20):
// O-12 TIN/VRN appear on documents only once a KYC reviewer verified the VAT certificate; Q-11 prices
// include VAT (locked); Q-12 codes A, C, E only until counsel confirms B and D (wording drafts);
// Q-16 only the vendor account edits the tax profile (staff with `payments` read it).
// Tax rates are PRICING-ADJACENT CONSTANTS (CLAUDE.md rule 6). They never touch marketplace prices,
// commission or payouts (O-10).
// The routes check the flag (VENDOR_TOOLS + VENDOR_VAT) and who may call before calling in here.
import { parseTaxProfile, parseVatRejection, parseTaxRateProposal, rateStatuses, normaliseTin } from '../shared/vendor-vat.mjs';
import { certificateStands } from '../infra/vendor-tax-store-pg.mjs';
import { vendorVatOn } from '../shared/feature-flags.mjs';
import { eatDate } from '../shared/vendor-order-view.mjs';
import { addDays } from '../shared/vendor-customer.mjs';

const iso = v => (v == null ? null : new Date(v).toISOString());

/** The tax profile as the vendor (and the KYC reviewer) see it — design spec §11 GET /vendor/tax-profile. */
export function taxProfileView(row, kyc = null, certificate = null, verifiedCertificateStatus = null) {
  const r = row || { status: 'none', vatRegistered: false };
  const pending = r.status === 'pending'
    ? { tin: r.submittedTin, vrn: r.submittedVrn, certificateDocumentId: r.submittedCertificateDocumentId, submittedAt: iso(r.submittedAt) }
    : null;
  const verified = r.verifiedAt
    ? {
      tin: r.verifiedTin, vrn: r.verifiedVrn, certificateDocumentId: r.verifiedCertificateDocumentId, verifiedAt: iso(r.verifiedAt),
      // #229 L3: false once a reviewer rejected that certificate (or it expired): VAT is off until re-submitted.
      certificateStands: certificateStands(verifiedCertificateStatus),
    }
    : null;
  const rejected = r.status === 'rejected' ? { tin: r.submittedTin, vrn: r.submittedVrn, certificateDocumentId: r.submittedCertificateDocumentId } : null;
  const shown = pending || rejected || verified;
  return {
    vatRegistered: Boolean(r.vatRegistered),
    tin: shown?.tin ?? kyc?.tin ?? null,
    tinFromKyc: Boolean(kyc?.tin),
    vrn: shown?.vrn ?? null,
    certificateDocumentId: shown?.certificateDocumentId ?? certificate?.id ?? null,
    pricesIncludeVat: true,
    status: r.status || 'none',
    rejectReason: r.status === 'rejected' ? r.rejectReason ?? null : null,
    rejectNote: r.status === 'rejected' ? r.rejectNote ?? null : null,
    verifiedAt: verified?.verifiedAt ?? null,
    // VAT, TIN and VRN are on new documents: registered and verified (the verified values, even while a change is pending).
    inForce: Boolean(r.vatRegistered && r.verifiedAt && verified?.certificateStands),
    changePending: Boolean(pending && verified),
    verified,
    pending,
    updatedAt: iso(r.updatedAt),
  };
}

export function createVendorTaxService({ store, notifyVendor = async () => {}, vatOn = vendorVatOn, now = () => new Date() }) {
  const today = () => eatDate(now());

  async function getProfile({ vendorId }) {
    const { row, kyc, certificate, verifiedCertificateStatus } = await store.load(vendorId);
    return { taxProfile: taxProfileView(row, kyc, certificate, verifiedCertificateStatus) };
  }

  /** PUT /vendor/tax-profile (vendor account only; the route refuses staff with 403 owner_only). */
  async function saveProfile({ vendorId, actorId, body }) {
    const parsed = parseTaxProfile(body);
    if (parsed.error) return parsed;
    const { kyc } = await store.load(vendorId);
    let tin = null;
    if (parsed.vatRegistered) {
      // §6.1: the KYC case's TIN is used as it is (read-only in the form) when there is one.
      tin = kyc?.tin ? normaliseTin(kyc.tin) : parsed.tin;
      if (!tin) return { error: kyc?.tin ? 'kyc_tin_invalid' : 'tin_required', status: 400 };
    }
    const out = await store.save({ vendorId, actorId, input: { ...parsed, tin } });
    if (out.error) return out;
    return getProfile({ vendorId });
  }

  /** The VAT registration section of a vendor's KYC case (§7.4). */
  async function adminVatCase({ vendorId }) {
    const { row, kyc, certificate, verifiedCertificateStatus } = await store.load(vendorId);
    const view = taxProfileView(row, kyc, certificate, verifiedCertificateStatus);
    const submittedTin = view.pending?.tin ?? view.tin;
    return {
      vendorId,
      taxProfile: view,
      kycCaseId: kyc?.caseId ?? null,
      kycTin: kyc?.tin ?? null,
      tinMismatch: Boolean(kyc?.tin && submittedTin && normaliseTin(kyc.tin) !== submittedTin),
      certificate: certificate ? { id: certificate.id, status: certificate.status, fileName: certificate.fileName ?? null, mimeType: certificate.mimeType, uploadedAt: iso(certificate.createdAt) } : null,
    };
  }

  async function verifyVat({ vendorId, actorId }) {
    const out = await store.decide({ vendorId, actorId, decision: 'verify' });
    if (out.error) return out;
    try { await notifyVendor(vendorId, 'vendor_vat_verified', { open: 'tax' }); } catch (err) { console.warn('[vendor-tax] verified push failed:', err?.message); }
    return adminVatCase({ vendorId });
  }

  async function rejectVat({ vendorId, actorId, body }) {
    const parsed = parseVatRejection(body || {});
    if (parsed.error) return parsed;
    const out = await store.decide({ vendorId, actorId, decision: 'reject', reason: parsed.reason, note: parsed.note });
    if (out.error) return out;
    try { await notifyVendor(vendorId, 'vendor_vat_rejected', { open: 'tax', reason: parsed.reason }); } catch (err) { console.warn('[vendor-tax] rejected push failed:', err?.message); }
    return adminVatCase({ vendorId });
  }

  /** GET /vendor/tax-rates: the codes a product may use, with today's rate (§6.4). */
  async function vendorTaxRates() {
    const day = today();
    const [codes, rates] = await Promise.all([store.codes(), store.ratesOn(day)]);
    return {
      asOf: day,
      codes: codes.filter(c => c.inUse && rates.has(c.code)).map(c => ({
        code: c.code, nameEn: c.nameEn, nameSw: c.nameSw, exempt: Boolean(c.exempt), ratePct: c.exempt ? null : rates.get(c.code).ratePct,
      })),
    };
  }

  /** GET /admin/tax-rates (§7.3). */
  async function adminTaxRates() {
    const day = today();
    const [codes, rates] = await Promise.all([store.codes(), store.rates()]);
    const statuses = rateStatuses(rates, day);
    const history = await store.historyOf(rates.map(r => r.id));
    const byCode = new Map(codes.map(c => [c.code, c]));
    const rows = rates.map(r => ({
      id: r.id, code: r.code, nameEn: byCode.get(r.code)?.nameEn ?? null, nameSw: byCode.get(r.code)?.nameSw ?? null,
      ratePct: r.ratePct, exempt: r.ratePct == null, effectiveFrom: r.effectiveFrom, effectiveTo: statuses.get(r.id).effectiveTo,
      status: statuses.get(r.id).status, reason: r.reason, proposedBy: r.proposedBy, proposedAt: iso(r.proposedAt),
      decidedBy: r.decidedBy ?? null, decidedAt: iso(r.decidedAt), decisionNote: r.decisionNote ?? null,
      history: (history.get(r.id) || []).map(h => ({ action: h.action, actor: h.actor, at: iso(h.at), before: h.before ?? null, after: h.after ?? null })),
    }));
    return {
      asOf: day,
      codes: codes.map(c => ({
        code: c.code, nameEn: c.nameEn, nameSw: c.nameSw, exempt: Boolean(c.exempt), inUse: Boolean(c.inUse),
        // B and D (Q-12): shown as "Not in use" until counsel confirms them.
        status: c.inUse ? (rows.some(r => r.code === c.code && r.status === 'active') ? 'active' : 'no_rate') : 'unused',
      })),
      rates: rows,
    };
  }

  async function proposeRate({ actorId, body }) {
    const codes = new Map((await store.codes()).map(c => [c.code, { exempt: Boolean(c.exempt), inUse: Boolean(c.inUse) }]));
    const proposal = parseTaxRateProposal(body, { codes, tomorrow: addDays(today(), 1) });
    if (proposal.error) return proposal;
    return { rate: await store.propose({ actorId, proposal }), status: 201 };
  }

  /** Maker ≠ checker (§7.3): the proposer can never approve or reject their own proposal; only they withdraw it. */
  async function decideRate({ id, actorId, action, body = {} }) {
    const note = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : (typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null);
    if (action === 'reject' && !note) return { error: 'reason_required', status: 400 };
    if (note && note.length > 300) return { error: 'reason_too_long', status: 400, max: 300 };
    const tomorrow = addDays(today(), 1);
    return store.decideRate({
      id, actorId, action, note,
      check: (rate) => {
        if (action === 'withdraw') return rate.proposedBy === actorId ? null : { error: 'not_proposer', status: 403 };
        if (rate.proposedBy === actorId) return { error: 'same_admin', status: 403 };
        if (action === 'approve' && rate.effectiveFrom < tomorrow) return { error: 'effective_date_past', status: 400, earliest: tomorrow };
        return null;
      },
    });
  }

  /**
   * GET /vendor/tools/options `vatInForce` (any active staff, e.g. `products` only, for the product VAT code
   * field): true only with VENDOR_VAT on and the vendor's VAT in force now. No other tax detail.
   */
  async function vatInForce(vendorId) {
    if (!vatOn() || !vendorId) return false;
    return store.inForce(vendorId);
  }

  return { vatInForce, getProfile, saveProfile, adminVatCase, verifyVat, rejectVat, vendorTaxRates, adminTaxRates, proposeRate, decideRate };
}
