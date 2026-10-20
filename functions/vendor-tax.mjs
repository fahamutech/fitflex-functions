// Vendor business tools · S5 — VAT: the vendor's tax profile (TIN, VRN, VAT certificate), the KYC
// reviewer's VAT decision, the VAT codes products may use, and admin tax rates with maker ≠ checker.
// Dormant: VENDOR_TOOLS + VENDOR_VAT (off → 404 feature_disabled).
// TAX RATES ARE PRICING-ADJACENT CONSTANTS (CLAUDE.md rule 6). VAT never changes marketplace prices,
// commission or payouts (O-10); it is shown on vendor documents and recorded on vendor sales only.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { shopService, vendorTaxService, users } from '../src/bootstrap/services.mjs';
import { vendorVatOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';

const created = new Date().toISOString();
const send = (res, result) => {
  const { error, status, ...extra } = result;
  return res.status(status).json({ error, ...extra });
};
const disabled = res => res.status(404).json({ error: 'feature_disabled' });
const FLAG = 'VENDOR_TOOLS + VENDOR_VAT; off → 404 feature_disabled';

/** vendor_staff holding one of `permissions` (stored record, active, of the vendor in the token), vendor not suspended. */
function requireStaff(...permissions) {
  return async (req, res, next) => {
    if (req.user?.userType !== 'vendor_staff') return next();
    let ok = false;
    let vendor = null;
    try {
      for (const p of permissions) if (await shopService.authorizeStaff(req.user, p)) { ok = true; break; }
      if (ok) vendor = await users.findByIdAsync(req.user.vendorId);
    } catch (error) {
      console.error('[vendor-tax] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
      return res.status(503).json({ error: 'authorization_unavailable' });
    }
    if (!ok) return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: permissions[0], acceptedPermissions: permissions });
    if (!vendor || vendor.userType !== 'vendor' || vendor.accountStatus === 'suspended') return res.status(403).json({ error: 'vendor_suspended' });
    return next();
  };
}
const vendorOf = user => (user.userType === 'vendor_staff' ? user.vendorId : user.sub);

const PROFILE = '{ vatRegistered, tin|null (from the KYC case when it has one: tinFromKyc true, read-only), tinFromKyc, vrn|null, certificateDocumentId|null (KYC document, requirement vat_certificate), pricesIncludeVat: true (locked), status: none|pending|verified|rejected, rejectReason|null (unreadable|number_mismatch|name_mismatch|not_vat_certificate|other), rejectNote|null, verifiedAt|null, inForce (VAT, TIN and VRN are on new documents and sales: registered, verified, and the verified certificate still stands — a reviewer rejecting it later turns VAT off at once), changePending (verified + new details waiting: the verified ones stay in force), verified { tin, vrn, certificateDocumentId, verifiedAt, certificateStands }|null, pending { tin, vrn, certificateDocumentId, submittedAt }|null, updatedAt|null }';

export const vendorGetTaxProfile = {
  created, method: 'get', path: '/vendor/tax-profile',
  description: `Vendor account, or staff with \`payments\` (read only) (${FLAG}): my VAT registration → { taxProfile: ${PROFILE} }. Staff of a suspended vendor → 403 vendor_suspended.`,
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff'), requireStaff('payments')]),
  onRequest: async (req, res) => {
    if (!vendorVatOn()) return disabled(res);
    res.json(await vendorTaxService.getProfile({ vendorId: vendorOf(req.user) }));
  },
};

export const vendorPutTaxProfile = {
  created, method: 'put', path: '/vendor/tax-profile',
  description: `Vendor ACCOUNT only (${FLAG}; staff → 403 owner_only, Q-16): register for VAT, change the details, or stop. Body { vatRegistered: boolean, tin? (9 digits; ignored when the KYC case has a TIN — that one is used), vrn (required when registered; 8–15 letters/digits after dashes and spaces are removed), certificateDocumentId? (default: my current KYC document for requirement vat_certificate — upload it first with POST /me/kyc/documents/vat_certificate/file), updatedAt? (the profile's updatedAt you loaded → 409 tax_profile_changed { updatedAt }) }. New or changed details → status pending (the verified ones stay in force until a KYC reviewer decides); the verified details again → in force at once; vatRegistered false → VAT stops on new sales now (past documents unchanged). → { taxProfile }. 400 vrn_invalid | tin_invalid | tin_required | certificate_required | prices_include_vat_locked | invalid_field { field }.`,
  requestSample: { vatRegistered: true, vrn: '40-012345-X', updatedAt: '2026-10-20T08:00:00.000Z' },
  onGuard: routeGuard('put', requireAuth('vendor', 'vendor_staff')),
  onRequest: async (req, res) => {
    if (!vendorVatOn()) return disabled(res);
    if (req.user.userType !== 'vendor') return res.status(403).json({ error: 'owner_only' });
    const result = await vendorTaxService.saveProfile({ vendorId: req.user.sub, actorId: req.user.sub, body: req.body || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const vendorTaxRates = {
  created, method: 'get', path: '/vendor/tax-rates',
  description: `Vendor / staff with \`products\` or \`payments\` (${FLAG}): the VAT codes a product may use, with today's rate → { asOf (EAT day), codes: [{ code: A|C|E, nameEn, nameSw (draft), exempt, ratePct|null (exempt) }] }. B and D are not offered until counsel confirms them (Q-12). Labels: "A · Standard 18%", "C · Zero-rated 0%", "E · Exempt". A product's code is sent as vatCode on POST/PUT /vendor/products (never re-queues approval).`,
  onGuard: routeGuard('get', [requireAuth('vendor', 'vendor_staff'), requireStaff('products', 'payments')]),
  onRequest: async (req, res) => {
    if (!vendorVatOn()) return disabled(res);
    res.json(await vendorTaxService.vendorTaxRates());
  },
};

// ── admin: tax rates (scope `payments`, maker ≠ checker) ────────────────────

const adminRates = method => routeGuard(method, [requireAuth('admin'), requireAcl('payments')]);
const RATE = '{ id, code, nameEn, nameSw, ratePct|null, exempt, effectiveFrom (EAT day), effectiveTo|null (the day before the next approved rate), status: active|scheduled|ended|pending|rejected|withdrawn, reason, proposedBy, proposedAt, decidedBy|null, decidedAt|null, decisionNote|null, history: [{ action, actor, at, before, after }] }';

export const adminListTaxRates = {
  created, method: 'get', path: '/admin/tax-rates',
  description: `Admin, scope \`payments\` (${FLAG}): VAT codes and every rate → { asOf, codes: [{ code, nameEn, nameSw, exempt, inUse, status: active|no_rate|unused (B, D until counsel) }], rates: [${RATE}] }. PRICING-ADJACENT CONSTANTS.`,
  onGuard: adminRates('get'),
  onRequest: async (req, res) => {
    if (!vendorVatOn()) return disabled(res);
    res.json(await vendorTaxService.adminTaxRates());
  },
};

export const adminProposeTaxRate = {
  created, method: 'post', path: '/admin/tax-rates',
  description: `Admin, scope \`payments\` (${FLAG}): propose a rate change; ANOTHER admin must approve it. Body { code (A | C | E), ratePct (0–100, ≤ 2 decimals; C must be 0) | exempt: true (E only), effectiveFrom (YYYY-MM-DD, tomorrow EAT or later), reason (3–300) }. → 201 { rate } (status pending). 400 effective_date_past { earliest } | code_not_in_use (B, D) | invalid_code | invalid_rate | invalid_field | reason_required | reason_too_long.`,
  requestSample: { code: 'A', ratePct: 16, effectiveFrom: '2026-11-01', reason: 'Finance Act 2026 (example)' },
  onGuard: adminRates('post'),
  onRequest: async (req, res) => {
    if (!vendorVatOn()) return disabled(res);
    const result = await vendorTaxService.proposeRate({ actorId: req.user.sub, body: req.body || {} });
    if (result.error) return send(res, result);
    res.status(201).json({ rate: result.rate });
  },
};

function decideRoute(action, description) {
  return {
    created, method: 'post', path: `/admin/tax-rates/:id/${action}`,
    description: `Admin, scope \`payments\` (${FLAG}): ${description} → { rate }. 404 tax_rate_not_found, 409 tax_rate_not_pending { currentStatus }. Audited (tax_rate_${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'withdrawn'}).`,
    onGuard: adminRates('post'),
    onRequest: async (req, res) => {
      if (!vendorVatOn()) return disabled(res);
      const result = await vendorTaxService.decideRate({ id: req.params.id, actorId: req.user.sub, action, body: req.body || {} });
      if (result.error) return send(res, result);
      res.json(result);
    },
  };
}
export const adminApproveTaxRate = decideRoute('approve', 'approve a pending rate. The proposer cannot (403 same_admin — maker ≠ checker, also enforced by the database). 400 effective_date_past { earliest } (approve before the day it starts), 409 rate_conflict (another approved rate starts the same day).');
export const adminRejectTaxRate = decideRoute('reject', 'reject a pending rate. Body { reason } (required). The proposer cannot (403 same_admin). 400 reason_required.');
export const adminWithdrawTaxRate = decideRoute('withdraw', 'the proposer withdraws their own pending rate (anyone else → 403 not_proposer).');

// ── admin: KYC VAT review (scope `kyc`) ─────────────────────────────────────

const adminKyc = method => routeGuard(method, [requireAuth('admin'), requireAcl('kyc')]);
const CASE = `{ vendorId, taxProfile: ${PROFILE}, kycCaseId|null, kycTin|null, tinMismatch (the submitted TIN differs from the KYC case's), certificate { id, status, fileName|null, mimeType, uploadedAt }|null (view it with GET /admin/kyc/cases/:caseId/documents/:id/file) }`;

export const adminVendorVat = {
  created, method: 'get', path: '/admin/kyc/vendors/:id/vat',
  description: `KYC reviewer, scope \`kyc\` (${FLAG}): the VAT registration section of a vendor's KYC case → ${CASE}. It never changes the KYC case decision; VAT is optional for vendors.`,
  onGuard: adminKyc('get'),
  onRequest: async (req, res) => {
    if (!vendorVatOn()) return disabled(res);
    res.json(await vendorTaxService.adminVatCase({ vendorId: req.params.id }));
  },
};

export const adminVerifyVendorVat = {
  created, method: 'post', path: '/admin/kyc/vendors/:id/vat/verify',
  description: `KYC reviewer, scope \`kyc\` (${FLAG}): verify the pending VAT details. They come into force at once (verifiedBy/At; VAT, TIN and VRN on new sales and documents from now on; past ones unchanged), the certificate document is accepted, and the vendor is told (push vendor_vat_verified, EN/SW). → ${CASE}. 404 tax_profile_not_found, 409 nothing_to_review { currentStatus }, 409 certificate_not_current (the submitted certificate was replaced, rejected or lost its file since — the vendor must submit again).`,
  onGuard: adminKyc('post'),
  onRequest: async (req, res) => {
    if (!vendorVatOn()) return disabled(res);
    const result = await vendorTaxService.verifyVat({ vendorId: req.params.id, actorId: req.user.sub });
    if (result.error) return send(res, result);
    res.json(result);
  },
};

export const adminRejectVendorVat = {
  created, method: 'post', path: '/admin/kyc/vendors/:id/vat/reject',
  description: `KYC reviewer, scope \`kyc\` (${FLAG}): not accepted. Body { reason: unreadable | number_mismatch | name_mismatch | not_vat_certificate | other, note? (required for other; ≤ 300) }. Details verified earlier stay in force. The vendor is told (push vendor_vat_rejected, EN/SW). → ${CASE}. 400 invalid_reason | note_required | note_too_long, 404 tax_profile_not_found, 409 nothing_to_review { currentStatus }.`,
  requestSample: { reason: 'number_mismatch', note: 'VRN on the certificate ends in Y' },
  onGuard: adminKyc('post'),
  onRequest: async (req, res) => {
    if (!vendorVatOn()) return disabled(res);
    const result = await vendorTaxService.rejectVat({ vendorId: req.params.id, actorId: req.user.sub, body: req.body || {} });
    if (result.error) return send(res, result);
    res.json(result);
  },
};
