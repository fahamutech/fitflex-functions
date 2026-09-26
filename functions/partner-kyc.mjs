// Partner KYC/KYB REST surface.
//
// Partners (gym owners, trainers, vendors) fill in their own KYC under /me/kyc.
// FitFlex admins with the 'kyc' scope see every case and can fill any of them
// on a partner's behalf under /admin/kyc/partners/:partnerType/:subjectId —
// the way corporate KYB is done, since companies are onboarded by FitFlex.
// ID, TIN and account numbers go only to the partner themselves and to admins.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { partnerKycService as svc } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const PARTNER_ROLES = ['gym_operator', 'trainer', 'vendor'];
const adminGuard = [requireAuth('admin'), requireAcl('kyc')];

function send(res, result) {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  res.json(result);
}

const partnerActor = req => ({ id: req.user.sub, role: 'partner' });
// Super-admins (not portal staff) may override an incomplete checklist.
const adminActor = req => ({ id: req.user.sub, role: 'admin', superAdmin: !req.user.portalUser });

/** Run fn with the signed-in partner. */
const asPartner = fn => async (req, res) => {
  const partner = await svc.partnerForUser(req.user.sub);
  if (partner.error) return send(res, partner);
  send(res, await fn(partner, req));
};

/** Run fn with the partner named in an admin URL. */
const forPartner = fn => async (req, res) => {
  const partner = await svc.resolvePartner(req.params.partnerType, req.params.subjectId);
  if (partner.error) return send(res, partner);
  send(res, await fn(partner, req));
};

// ── Partner self-service ────────────────────────────────────────────────────

export const myKyc = {
  created, method: 'get', path: '/me/kyc',
  description: 'Partner: my KYC case, details, payout accounts and the checklist of what is still needed.',
  onGuard: requireAuth(...PARTNER_ROLES),
  onRequest: asPartner(partner => svc.overview(partner)),
};

export const myKycBusiness = {
  created, method: 'put', path: '/me/kyc/business',
  description: 'Gym owner / vendor: set business details — legalName, tradingName, entityType, registrationNumber, registrationAuthority, incorporatedOn (YYYY-MM-DD), registeredAddress { line1, city, region, country }, businessActivity, tin. null clears a field.',
  requestSample: { legalName: 'Iron Paradise Ltd', tradingName: 'Iron Paradise', registrationNumber: '123456', tin: '123-456-789', registeredAddress: { line1: 'Plot 12, Haile Selassie Rd', city: 'Dar es Salaam' } },
  onGuard: requireAuth(...PARTNER_ROLES),
  onRequest: asPartner((partner, req) => svc.updateBusiness(partner, req.body || {}, partnerActor(req))),
};

export const myKycPerson = {
  created, method: 'put', path: '/me/kyc/people/:role',
  description: 'Partner: set the identity of the principal (gym owner, trainer) or the authorised representative (vendor) — fullName, dateOfBirth, nationality, idType, idNumber, idExpiresOn, phone, email, address, position, relationship, authority.',
  requestSample: { fullName: 'Asha Mushi', idType: 'nida', idNumber: '19900101-12345-00001-12', phone: '+255754123456', email: 'asha@example.com', address: { line1: 'Mikocheni B', city: 'Dar es Salaam' }, relationship: 'owner' },
  onGuard: requireAuth(...PARTNER_ROLES),
  onRequest: asPartner((partner, req) => svc.upsertPerson(partner, req.params.role, req.body || {}, partnerActor(req))),
};

export const myKycDocument = {
  created, method: 'put', path: '/me/kyc/documents/:requirementKey',
  description: 'Partner: record a document\'s details — docType, documentNumber, issuer (certification body, insurer, licensing authority), issuedOn, expiresOn, details. The file itself is attached in a later step.',
  requestSample: { docType: 'certification', issuer: 'ACE', documentNumber: 'ACE-123456', issuedOn: '2024-02-01', expiresOn: '2026-12-31', details: { level: 'Personal Trainer' } },
  onGuard: requireAuth(...PARTNER_ROLES),
  onRequest: asPartner((partner, req) => svc.upsertDocumentDetails(partner, req.params.requirementKey, req.body || {}, partnerActor(req))),
};

export const myKycAddSettlementAccount = {
  created, method: 'post', path: '/me/kyc/settlement-accounts',
  description: 'Partner: add a payout account — method bank | mobile_money, provider (bank name, or mpesa | airtel_money | mixx | halopesa), accountName, accountNumber, branch, swiftCode. It starts unverified.',
  requestSample: { method: 'mobile_money', provider: 'mpesa', accountName: 'Asha Mushi', accountNumber: '0754 123 456' },
  onGuard: requireAuth(...PARTNER_ROLES),
  onRequest: asPartner((partner, req) => svc.addSettlementAccount(partner, req.body || {}, partnerActor(req))),
};

export const myKycRemoveSettlementAccount = {
  created, method: 'delete', path: '/me/kyc/settlement-accounts/:id',
  description: 'Partner: remove a payout account that has not been verified yet.',
  onGuard: requireAuth(...PARTNER_ROLES),
  onRequest: asPartner((partner, req) => svc.removeSettlementAccount(partner, req.params.id, partnerActor(req))),
};

export const myKycSubmit = {
  created, method: 'post', path: '/me/kyc/submit',
  description: 'Partner: send my KYC for review. Refused with 409 kyc_incomplete and the missing items until the checklist is ready.',
  onGuard: requireAuth(...PARTNER_ROLES),
  onRequest: asPartner((partner, req) => svc.submit(partner, partnerActor(req))),
};

export const myKycWithdraw = {
  created, method: 'post', path: '/me/kyc/withdraw',
  description: 'Partner: take a submitted KYC back to draft, before a reviewer picks it up.',
  onGuard: requireAuth(...PARTNER_ROLES),
  onRequest: asPartner((partner, req) => svc.withdraw(partner, partnerActor(req))),
};

// ── Admin ───────────────────────────────────────────────────────────────────

export const adminKycCases = {
  created, method: 'get', path: '/admin/kyc/cases',
  description: 'Admin: KYC cases, newest activity first. Optional ?status=&partnerType=.',
  onGuard: adminGuard,
  onRequest: async (req, res) => send(res, await svc.listCases({ status: req.query?.status, partnerType: req.query?.partnerType })),
};

export const adminKycCase = {
  created, method: 'get', path: '/admin/kyc/cases/:id',
  description: 'Admin: one KYC case with its people, documents, checks, payout accounts, agreements, checklist and timeline.',
  onGuard: adminGuard,
  onRequest: async (req, res) => send(res, await svc.caseDetail(req.params.id)),
};

export const adminKycPartner = {
  created, method: 'get', path: '/admin/kyc/partners/:partnerType/:subjectId',
  description: 'Admin: a partner\'s KYC and checklist (partnerType gym_owner | trainer | vendor | corporate; subjectId is the user id, or the corporate account id).',
  onGuard: adminGuard,
  onRequest: forPartner(partner => svc.overview(partner)),
};

export const adminKycPartnerBusiness = {
  created, method: 'put', path: '/admin/kyc/partners/:partnerType/:subjectId/business',
  description: 'Admin: set a partner\'s business details on their behalf (same fields as PUT /me/kyc/business).',
  onGuard: adminGuard,
  onRequest: forPartner((partner, req) => svc.updateBusiness(partner, req.body || {}, adminActor(req))),
};

export const adminKycPartnerPerson = {
  created, method: 'put', path: '/admin/kyc/partners/:partnerType/:subjectId/people/:role',
  description: 'Admin: set a partner\'s principal or authorised representative on their behalf (same fields as PUT /me/kyc/people/:role).',
  onGuard: adminGuard,
  onRequest: forPartner((partner, req) => svc.upsertPerson(partner, req.params.role, req.body || {}, adminActor(req))),
};

export const adminKycPartnerDocument = {
  created, method: 'put', path: '/admin/kyc/partners/:partnerType/:subjectId/documents/:requirementKey',
  description: 'Admin: record a partner\'s document details on their behalf (same fields as PUT /me/kyc/documents/:requirementKey).',
  onGuard: adminGuard,
  onRequest: forPartner((partner, req) => svc.upsertDocumentDetails(partner, req.params.requirementKey, req.body || {}, adminActor(req))),
};

export const adminKycPartnerSettlementAccount = {
  created, method: 'post', path: '/admin/kyc/partners/:partnerType/:subjectId/settlement-accounts',
  description: 'Admin: add a payout account on a partner\'s behalf (same fields as POST /me/kyc/settlement-accounts). It starts unverified.',
  onGuard: adminGuard,
  onRequest: forPartner((partner, req) => svc.addSettlementAccount(partner, req.body || {}, adminActor(req))),
};

export const adminKycSiteVisit = {
  created, method: 'post', path: '/admin/kyc/gyms/:gymId/site-visit',
  description: 'Admin: record a site visit to a gym — result passed | failed, score, maxScore, tier (the tier the gym merits), visitedOn (YYYY-MM-DD), notes, rubric. It goes on the gym owner\'s case. The gym\'s own tier is still set on the gym.',
  requestSample: { result: 'passed', score: 17, maxScore: 20, tier: 'midtier', visitedOn: '2026-10-02', notes: 'Clean, well-equipped, 2 trainers on shift.' },
  onGuard: adminGuard,
  onRequest: async (req, res) => send(res, await svc.recordSiteVisit({ gymId: req.params.gymId, body: req.body || {}, actor: adminActor(req) })),
};

export const adminKycCorporateContract = {
  created, method: 'post', path: '/admin/kyc/corporate/:corporateId/contract',
  description: 'Admin: record a signed corporate contract — version, signedOn, effectiveFrom, expiresOn (YYYY-MM-DD). Earlier versions are marked superseded.',
  requestSample: { version: 'FFB-2026-014', signedOn: '2026-10-01', effectiveFrom: '2026-10-01', expiresOn: '2027-09-30' },
  onGuard: adminGuard,
  onRequest: async (req, res) => send(res, await svc.recordCorporateContract({ corporateId: req.params.corporateId, body: req.body || {}, actor: adminActor(req) })),
};

// ── Review ──────────────────────────────────────────────────────────────────

export const adminKycClaim = {
  created, method: 'post', path: '/admin/kyc/cases/:id/claim',
  description: 'Admin: take a submitted case into review (or reassign a case in review to yourself).',
  onGuard: adminGuard,
  onRequest: async (req, res) => send(res, await svc.claim(req.params.id, adminActor(req))),
};

export const adminKycDecision = {
  created, method: 'post', path: '/admin/kyc/cases/:id/decision',
  description: 'Admin: decide a case — decision approve | reject | request_info | suspend | reinstate | reopen, reasonCode (required to reject, request info or suspend), reasonNote (shown to the partner). Approving needs a complete checklist; a super-admin may pass override: true with a reasonNote. Rejecting closes the partner role, so use request_info for anything the partner can fix.',
  requestSample: { decision: 'request_info', reasonCode: 'document_unreadable', reasonNote: 'Please re-upload your certificate; the number is not readable.' },
  onGuard: adminGuard,
  onRequest: async (req, res) => send(res, await svc.decide(req.params.id, req.body || {}, adminActor(req))),
};

export const adminKycReviewDocument = {
  created, method: 'post', path: '/admin/kyc/cases/:id/documents/:documentId/review',
  description: 'Admin: accept or reject a document (decision accept | reject, note — required to reject). The case must be in review, and only a document with its file can be accepted.',
  onGuard: adminGuard,
  onRequest: async (req, res) => send(res, await svc.reviewDocument(req.params.id, req.params.documentId, req.body || {}, adminActor(req))),
};

export const adminKycReviewSettlementAccount = {
  created, method: 'post', path: '/admin/kyc/cases/:id/settlement-accounts/:accountId/review',
  description: 'Admin: verify or reject a payout account (decision verify | reject, note — required to reject). Whoever added the account cannot verify it. A verified account becomes the payout account if there is none, after a 48-hour cooling-off period.',
  onGuard: adminGuard,
  onRequest: async (req, res) => send(res, await svc.reviewSettlementAccount(req.params.id, req.params.accountId, req.body || {}, adminActor(req))),
};
