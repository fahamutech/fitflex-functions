// Postgres store for vendor VAT (vendor business tools · S5): the vendor tax profile and its review,
// tax codes and dated tax rates (maker ≠ checker), product VAT codes, and the helpers the sale,
// customer-payment and order-invoice transactions use to snapshot VAT and seller details.
// Every query is parameterised; vendor data is always read by vendorId.
import { randomUUID } from 'node:crypto';
import { vatForLines } from '../shared/vendor-vat.mjs';
import { eatDate } from '../shared/vendor-order-view.mjs';
import { vendorDocumentsTinWithoutVatOn } from '../shared/feature-flags.mjs';

const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v == null ? null : new Date(v).toISOString());
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const refusal = (error, status, extra = {}) => Object.assign(new Error(error), { refusal: fail(error, status, extra) });
const dayText = v => (v == null ? null : typeof v === 'string' ? v.slice(0, 10)
  : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`);

// ── helpers used inside other stores' transactions ──────────────────────────

/**
 * Security review #229 L3 (fail closed): the verified VAT certificate must still stand. If a KYC reviewer
 * later rejects it (or it expires, or the document is gone), VAT, TIN and VRN stop on NEW sales and
 * documents at once — the vendor must submit again. A certificate superseded by an accepted renewal still stands.
 */
export const certificateStands = status => status != null && !['rejected', 'expired'].includes(status);

/** The vendor's VAT in force now: { inForce, verifiedAt|null, tin|null, vrn|null }. */
export async function taxContextOf(q, vendorId) {
  const p = await q('VendorTaxProfile as t').leftJoin('PartnerDocument as d', 'd.id', 't.verifiedCertificateDocumentId')
    .where('t.vendorId', vendorId).first('t.vatRegistered', 't.verifiedAt', 't.verifiedTin', 't.verifiedVrn', 'd.status as certificateStatus');
  const inForce = Boolean(p?.vatRegistered && p?.verifiedAt && certificateStands(p?.certificateStatus));
  return { inForce, verifiedAt: inForce ? iso(p.verifiedAt) : null, tin: inForce ? p.verifiedTin : null, vrn: inForce ? p.verifiedVrn : null };
}

/** The rate in force on an EAT day for each code that is in use: Map code → { ratePct|null, exempt }. */
export async function ratesOn(q, day) {
  const { rows } = await q.raw(`SELECT DISTINCT ON (r.code) r.code, r."ratePct", c.exempt
      FROM "TaxRate" r JOIN "TaxCode" c ON c.code = r.code
     WHERE r.status = 'approved' AND r."effectiveFrom" <= ?::date AND c."inUse"
     ORDER BY r.code, r."effectiveFrom" DESC`, [day]);
  return new Map(rows.map(r => [r.code, { ratePct: r.ratePct == null ? null : Number(r.ratePct), exempt: Boolean(r.exempt) }]));
}

/** The VAT code of each product (its own '' row in ProductPrivate): Map productId → code. Products without one are not in the map (= A). */
export async function productVatCodes(q, vendorId, productIds) {
  const ids = [...new Set((productIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await q('ProductPrivate').where({ vendorId, variant: '' }).whereIn('productId', ids).whereNotNull('vatCode').select('productId', 'vatCode');
  return new Map(rows.map(r => [r.productId, r.vatCode]));
}

/**
 * VAT for a vendor's sale lines at instant `at` (a walk-in sale's soldAt, or now for an order paid now).
 * Applies only when `vatOn`, the profile is in force, and `at` is at or after its verification (§3).
 * lines: [{ productId, netTzs }] → { applied, tax, lines: [{ vatCode, vatRatePct, vatTzs, exempt }|null] }
 */
export async function vatForSale(q, { vendorId, at, lines, vatOn }) {
  const tax = vatOn ? await taxContextOf(q, vendorId) : { inForce: false, verifiedAt: null, tin: null, vrn: null };
  if (!tax.inForce || +new Date(at) < +new Date(tax.verifiedAt)) return { applied: false, tax, lines: lines.map(() => null) };
  const [rates, codes] = await Promise.all([ratesOn(q, eatDate(at)), productVatCodes(q, vendorId, lines.map(l => l.productId))]);
  return { applied: true, tax, lines: vatForLines(lines, id => codes.get(id), rates) };
}

/** The KYC case of a vendor and the TIN on it. → { caseId, tin|null, tinCertificateAccepted } | null */
export async function kycTinOf(q, vendorId) {
  const kyc = await q('PartnerKycCase').where({ userId: vendorId, partnerType: 'vendor' }).orderBy('createdAt', 'desc').first('id', 'tin');
  if (!kyc) return null;
  const cert = await q('PartnerDocument').where({ caseId: kyc.id, requirementKey: 'tin_certificate' }).whereNot('status', 'superseded')
    .orderBy('createdAt', 'desc').first('status');
  return { caseId: kyc.id, tin: kyc.tin ? String(kyc.tin).replace(/[\s-]/g, '') : null, tinCertificateAccepted: cert?.status === 'accepted' };
}

/**
 * The seller details printed on a document, frozen at issue (Q-8). TIN and VRN only when VAT applied to
 * this document (O-12); with the Q-10 setting on (default off), the KYC TIN alone when its certificate
 * was accepted. Never the payout account or commission.
 */
export async function sellerSnapshotOf(q, vendorId, { vat = null } = {}) {
  const vendor = await q('User').where({ id: vendorId }).first('vendorProfile', 'displayName');
  const profile = (typeof vendor?.vendorProfile === 'string' ? JSON.parse(vendor.vendorProfile) : vendor?.vendorProfile) || {};
  let tin = vat?.applied ? vat.tax.tin : null;
  const vrn = vat?.applied ? vat.tax.vrn : null;
  if (!tin && vendorDocumentsTinWithoutVatOn()) {
    const kyc = await kycTinOf(q, vendorId);
    if (kyc?.tinCertificateAccepted && kyc.tin) tin = kyc.tin;
  }
  const text = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    businessName: text(profile.businessName) || text(vendor?.displayName) || null,
    logoUrl: typeof profile.logo === 'string' && /^https:\/\//i.test(profile.logo) ? profile.logo : null,
    address: profile.address ?? null,
    contactNumber: text(profile.contactNumber),
    tin: tin || null,
    vrn: vrn || null,
  };
}

// ── the store ───────────────────────────────────────────────────────────────

export function createPgVendorTaxStore({ db, now = () => new Date() }) {
  const audit = (q, { actor, action, target, before = null, after = null }) => q('AuditLog').insert({
    id: randomUUID(), at: now(), actor, action, target, before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });

  async function profileRow(q, vendorId) {
    return plain(await q('VendorTaxProfile').where({ vendorId }).first());
  }

  /** The vendor's VAT certificate standing on their KYC case (requirement vat_certificate), or the one named. */
  async function certificateOf(q, caseId, documentId = null) {
    if (!caseId) return null;
    const query = q('PartnerDocument').where({ caseId, requirementKey: 'vat_certificate' }).whereNotIn('status', ['superseded', 'rejected']).whereNotNull('storageKey');
    if (documentId) query.where({ id: documentId });
    return plain(await query.orderBy('createdAt', 'desc').first('id', 'status', 'fileName', 'mimeType', 'createdAt'));
  }

  /** Everything the tax profile screen and the KYC section need (verifiedCertificateStatus: #229 L3). */
  async function load(vendorId) {
    const [row, kyc] = await Promise.all([profileRow(db, vendorId), kycTinOf(db, vendorId)]);
    const cert = kyc ? await certificateOf(db, kyc.caseId) : null;
    const verifiedCert = row?.verifiedCertificateDocumentId
      ? await db('PartnerDocument').where({ id: row.verifiedCertificateDocumentId }).first('status') : null;
    return { row, kyc, certificate: cert, verifiedCertificateStatus: verifiedCert?.status ?? null };
  }

  /**
   * PUT /vendor/tax-profile, in one transaction under the profile's row lock.
   * input = { vatRegistered, tin, vrn, certificateDocumentId, expectUpdatedAt } (tin already resolved
   * against the KYC case). → { row } | refusal 409 tax_profile_changed { updatedAt } | 400 certificate_required.
   */
  async function save({ vendorId, actorId, input }) {
    try {
      return await db.transaction(async (trx) => {
        await trx.raw(`INSERT INTO "VendorTaxProfile" ("vendorId", "createdAt", "updatedAt") VALUES (?, ?, ?) ON CONFLICT ("vendorId") DO NOTHING`, [vendorId, now(), now()]);
        const row = plain(await trx('VendorTaxProfile').where({ vendorId }).forUpdate().first());
        if (input.expectUpdatedAt && iso(row.updatedAt) !== input.expectUpdatedAt) throw refusal('tax_profile_changed', 409, { updatedAt: iso(row.updatedAt) });
        const at = now();
        let patch;
        let action;
        if (!input.vatRegistered) {
          // Stop VAT now (§6.1 stopConfirm): new sales get none; past documents keep theirs. A pending change is dropped.
          patch = {
            vatRegistered: false, submittedTin: null, submittedVrn: null, submittedCertificateDocumentId: null, submittedAt: null, submittedBy: null,
            status: row.verifiedAt ? 'verified' : 'none', rejectReason: null, rejectNote: null, rejectedAt: null, rejectedBy: null,
          };
          action = 'vendor_tax_profile_stopped';
        } else {
          const kyc = await kycTinOf(trx, vendorId);
          const cert = await certificateOf(trx, kyc?.caseId, input.certificateDocumentId);
          if (!cert) throw refusal('certificate_required', 400);
          const same = row.verifiedAt && row.verifiedTin === input.tin && row.verifiedVrn === input.vrn && row.verifiedCertificateDocumentId === cert.id;
          if (same) {
            // The details already verified, switched back on: in force again, nothing to review.
            patch = {
              vatRegistered: true, status: 'verified', submittedTin: null, submittedVrn: null, submittedCertificateDocumentId: null, submittedAt: null,
              submittedBy: null, rejectReason: null, rejectNote: null, rejectedAt: null, rejectedBy: null,
            };
            action = 'vendor_tax_profile_resumed';
          } else {
            patch = {
              vatRegistered: true, status: 'pending', submittedTin: input.tin, submittedVrn: input.vrn, submittedCertificateDocumentId: cert.id,
              submittedAt: at, submittedBy: actorId, rejectReason: null, rejectNote: null, rejectedAt: null, rejectedBy: null,
            };
            action = 'vendor_tax_profile_submitted';
          }
        }
        await trx('VendorTaxProfile').where({ vendorId }).update({ ...patch, updatedAt: at });
        await audit(trx, {
          actor: actorId, action, target: vendorId,
          before: { status: row.status, vatRegistered: row.vatRegistered, vrn: row.submittedVrn || row.verifiedVrn || null },
          after: { status: patch.status, vatRegistered: patch.vatRegistered, vrn: patch.submittedVrn ?? row.verifiedVrn ?? null },
        });
        return { row: await profileRow(trx, vendorId) };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      throw err;
    }
  }

  /**
   * KYC reviewer verifies or rejects the pending submission (§7.4). Verify: the submitted values come into
   * force (verifiedBy/At) and the certificate document is accepted. Reject: the verified values (if any) stay
   * in force; the certificate document is rejected with the reason. → { row, decided } | refusal
   * 404 tax_profile_not_found | 409 nothing_to_review { status }.
   */
  async function decide({ vendorId, actorId, decision, reason = null, note = null }) {
    try {
      return await db.transaction(async (trx) => {
        const row = plain(await trx('VendorTaxProfile').where({ vendorId }).forUpdate().first());
        if (!row) throw refusal('tax_profile_not_found', 404);
        if (row.status !== 'pending') throw refusal('nothing_to_review', 409, { currentStatus: row.status });
        const at = now();
        if (decision === 'verify') {
          // #229 L3: the certificate submitted must still be the vendor's current one, with its file, not rejected.
          const kyc = await kycTinOf(trx, vendorId);
          const cert = kyc ? await trx('PartnerDocument').where({ id: row.submittedCertificateDocumentId, caseId: kyc.caseId, requirementKey: 'vat_certificate' })
            .whereIn('status', ['pending', 'accepted']).whereNotNull('storageKey').first('id') : null;
          const current = cert ? await certificateOf(trx, kyc.caseId) : null;
          if (!cert || current?.id !== cert.id) throw refusal('certificate_not_current', 409);
        }
        // The document's reviewer column references User; record the admin only when they have a User row.
        const reviewer = (await trx('User').where({ id: actorId }).first('id')) ? actorId : null;
        if (decision === 'verify') {
          await trx('VendorTaxProfile').where({ vendorId }).update({
            status: 'verified', verifiedTin: row.submittedTin, verifiedVrn: row.submittedVrn, verifiedCertificateDocumentId: row.submittedCertificateDocumentId,
            verifiedAt: at, verifiedBy: actorId, submittedTin: null, submittedVrn: null, submittedCertificateDocumentId: null, submittedAt: null, submittedBy: null,
            rejectReason: null, rejectNote: null, rejectedAt: null, rejectedBy: null, updatedAt: at,
          });
          await trx('PartnerDocument').where({ id: row.submittedCertificateDocumentId, status: 'pending' })
            .update({ status: 'accepted', reviewedBy: reviewer, reviewedAt: at, reviewNote: null, updatedAt: at });
        } else {
          await trx('VendorTaxProfile').where({ vendorId }).update({
            status: 'rejected', rejectReason: reason, rejectNote: note, rejectedAt: at, rejectedBy: actorId, updatedAt: at,
          });
          await trx('PartnerDocument').where({ id: row.submittedCertificateDocumentId, status: 'pending' })
            .update({ status: 'rejected', reviewedBy: reviewer, reviewedAt: at, reviewNote: `vat_${reason}${note ? `: ${note}` : ''}`.slice(0, 2000), updatedAt: at });
        }
        await audit(trx, {
          actor: actorId, action: decision === 'verify' ? 'vendor_vat_verified' : 'vendor_vat_rejected', target: vendorId,
          before: { status: 'pending', vrn: row.submittedVrn, verifiedVrn: row.verifiedVrn },
          after: decision === 'verify' ? { status: 'verified', vrn: row.submittedVrn } : { status: 'rejected', reason },
        });
        return { row: await profileRow(trx, vendorId), decided: decision };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      throw err;
    }
  }

  // ── codes and rates ───────────────────────────────────────────────────────

  async function codes() {
    return (await db('TaxCode').orderBy('sortOrder')).map(plain);
  }
  const rateRow = r => ({ ...plain(r), ratePct: r.ratePct == null ? null : Number(r.ratePct), effectiveFrom: dayText(r.effectiveFrom) });
  async function rates() {
    return (await db('TaxRate').orderBy([{ column: 'code' }, { column: 'effectiveFrom' }, { column: 'proposedAt' }])).map(rateRow);
  }
  async function rate(id) {
    const r = await db('TaxRate').where({ id }).first();
    return r ? rateRow(r) : null;
  }
  async function historyOf(ids) {
    if (!ids.length) return new Map();
    const rows = (await db('AuditLog').whereIn('target', ids).where('action', 'like', 'tax_rate_%').orderBy('at')).map(plain);
    const out = new Map();
    for (const r of rows) out.set(r.target, [...(out.get(r.target) || []), r]);
    return out;
  }
  async function propose({ actorId, proposal }) {
    const id = `txr_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const at = now();
    await db.transaction(async (trx) => {
      await trx('TaxRate').insert({ id, ...proposal, status: 'pending', proposedBy: actorId, proposedAt: at, updatedAt: at });
      await audit(trx, { actor: actorId, action: 'tax_rate_proposed', target: id, before: null, after: { ...proposal, status: 'pending' } });
    });
    return rate(id);
  }

  /**
   * approve | reject | withdraw a pending rate under its row lock. `check(row)` → null | refusal (maker ≠
   * checker, effective date, proposer-only withdraw), judged on the locked row.
   */
  async function decideRate({ id, actorId, action, note = null, check }) {
    try {
      return await db.transaction(async (trx) => {
        const row = await trx('TaxRate').where({ id }).forUpdate().first();
        if (!row) throw refusal('tax_rate_not_found', 404);
        const r = rateRow(row);
        if (r.status !== 'pending') throw refusal('tax_rate_not_pending', 409, { currentStatus: r.status });
        const refused = check(r);
        if (refused) throw Object.assign(new Error(refused.error), { refusal: refused });
        if (action === 'approve') {
          const clash = await trx('TaxRate').where({ code: r.code, status: 'approved' }).whereRaw('"effectiveFrom" = ?::date', [r.effectiveFrom]).first('id');
          if (clash) throw refusal('rate_conflict', 409, { rateId: clash.id });
        }
        const status = { approve: 'approved', reject: 'rejected', withdraw: 'withdrawn' }[action];
        const at = now();
        await trx('TaxRate').where({ id, status: 'pending' }).update({ status, decidedBy: actorId, decidedAt: at, decisionNote: note, updatedAt: at });
        await audit(trx, {
          actor: actorId, action: `tax_rate_${status}`, target: id,
          before: { status: 'pending', code: r.code, ratePct: r.ratePct, effectiveFrom: r.effectiveFrom },
          after: { status, ...(note ? { note } : {}) },
        });
        return { rate: rateRow(await trx('TaxRate').where({ id }).first()) };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      throw err;
    }
  }

  // ── product VAT codes ─────────────────────────────────────────────────────

  /** Set (or clear, null) a product's VAT code. Private bookkeeping: the product row and its approval are untouched. */
  async function setProductVatCode({ vendorId, productId, vatCode, actorId }) {
    const at = now();
    const before = await db('ProductPrivate').where({ productId, variant: '' }).first('vatCode');
    if ((before?.vatCode ?? null) === (vatCode ?? null)) return { changed: false };
    await db('ProductPrivate').insert({ productId, variant: '', vendorId, vatCode, updatedAt: at })
      .onConflict(['productId', 'variant']).merge({ vatCode, updatedAt: at });
    await audit(db, { actor: actorId, action: 'vendor_product_vat_code_set', target: productId, before: { vatCode: before?.vatCode ?? null }, after: { vendorId, vatCode } });
    return { changed: true };
  }
  const vatCodesOf = (vendorId, productIds) => productVatCodes(db, vendorId, productIds);
  /** For admin views across vendors: by product id only. */
  async function vatCodesById(productIds) {
    const ids = [...new Set((productIds || []).filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await db('ProductPrivate').where({ variant: '' }).whereIn('productId', ids).whereNotNull('vatCode').select('productId', 'vatCode');
    return new Map(rows.map(r => [r.productId, r.vatCode]));
  }

  return {
    load, save, decide, codes, rates, rate, historyOf, propose, decideRate,
    /** Display names by user id (admins on tax rates). */
    namesOf: async (ids) => {
      const wanted = [...new Set(ids.filter(id => id && !String(id).startsWith('system:')))];
      if (!wanted.length) return new Map();
      return new Map((await db('User').whereIn('id', wanted).select('id', 'displayName')).map(r => [r.id, r.displayName ?? null]));
    },
    inForce: async vendorId => (await taxContextOf(db, vendorId)).inForce,
    setProductVatCode, vatCodesOf, vatCodesById,
    ratesOn: day => ratesOn(db, day),
  };
}
