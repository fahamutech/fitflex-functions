// B2B Foundation V1 REST surface — organisations, their users and beneficiaries.
//
// FitFlex admins (portal staff need the 'b2b' scope) manage every organisation.
// Organisation routes are also open to that organisation's own users: access
// comes from their B2BOrganizationUser role (or, for a company mapped from
// Corporate, its HR logins), never from anything the caller sends. Corporate
// routes (/corporate/*, /admin/corporate/*) are unchanged.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { b2bService, b2bProgramService, b2bConsumptionService, b2bBillingService, b2bFinanceService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

const requireAdmin = [requireAuth('admin'), requireAcl('b2b')];
// B2B billing (Phase 5). Three separate grants for portal staff: raising and
// issuing invoices; approving corrections and reversals; recording payments.
const requireBilling = [requireAuth('admin'), requireAcl('b2b_billing')];
const requireBillingApproval = [requireAuth('admin'), requireAcl('b2b_billing_approve')];
const requirePayments = [requireAuth('admin'), requireAcl('b2b_payments')];
// Reading billing: any of the B2B grants.
const requireBillingRead = [requireAuth('admin'), requireAcl('b2b_billing', 'b2b', 'b2b_billing_approve', 'b2b_payments')];
// Any signed-in user; the organisation membership check happens per request.
const requireOrgAccess = [requireAuth(), requireAcl('b2b')];

function send(res, result, okStatus = 200) {
  const { error, status, ...payload } = result;
  if (error) return res.status(status).json({ error, ...payload });
  return res.status(okStatus).json(payload);
}

/** Resolve the caller's access to :id, then run the handler with it. */
async function inOrganization(req, res, handler, okStatus = 200) {
  const access = await b2bService.resolveAccess({
    organizationId: req.params.id, userId: req.user.sub, userType: req.user.userType,
  });
  if (access.error) return send(res, access);
  return send(res, await handler(access), okStatus);
}

export const b2bReference = {
  created, method: 'get', path: '/b2b/reference',
  description: 'Public: organisation types, lifecycles, user roles, permissions and beneficiary types.',
  onRequest: (_req, res) => res.json(b2bService.reference()),
};

// ── Organisations (FitFlex admin) ──────────────────────────────────────────

export const adminCreateB2BOrganization = {
  created, method: 'post', path: '/admin/b2b/organizations',
  description: 'Admin: create a B2B organisation. Starts pending. Companies are onboarded through /admin/corporate and mapped automatically.',
  requestSample: {
    organizationType: 'insurer', legalName: 'Jubilee Insurance Company of Tanzania Ltd', tradingName: 'Jubilee',
    industrySector: 'insurance', registrationNumber: '12345', taxIdentificationNumber: '100-200-300',
    email: 'wellness@example.co.tz', phone: '+255700000000', address: { city: 'Dar es Salaam', country: 'TZ' },
  },
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await b2bService.createOrganization({ body: req.body || {}, actorId: req.user.sub }), 201),
};

export const adminListB2BOrganizations = {
  created, method: 'get', path: '/admin/b2b/organizations',
  description: 'Admin: list organisations, newest first. Query: ?type=&status=&search=&limit=&cursor=. Returns { items, total, nextCursor }.',
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await b2bService.listOrganizations({ query: req.query || {} })),
};

export const adminSetB2BOrganizationStatus = {
  created, method: 'post', path: '/admin/b2b/organizations/:id/status',
  description: 'Admin: move an organisation between pending, active, suspended and inactive. A company mapped from Corporate changes status through /admin/corporate/:id/status.',
  requestSample: { status: 'active', reason: 'Contract signed' },
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await b2bService.setOrganizationStatus({
    organizationId: req.params.id, status: req.body?.status, reason: req.body?.reason, actorId: req.user.sub,
  })),
};

export const adminSyncCorporateOrganizations = {
  created, method: 'post', path: '/admin/b2b/corporate-sync',
  description: 'Admin: map every corporate account without an employer organisation. Idempotent; returns { created, existing }.',
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await b2bService.syncCorporateOrganizations({ actorId: req.user.sub })),
};

export const adminB2BOrganizationForCorporate = {
  created, method: 'get', path: '/admin/b2b/corporate/:corporateId',
  description: 'Admin: the employer organisation that represents a corporate account (null until mapped).',
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await b2bService.organizationForCorporate({ corporateId: req.params.corporateId })),
};

// ── Organisations (admin or the organisation's own users) ──────────────────

export const myB2BOrganizations = {
  created, method: 'get', path: '/b2b/me/organizations',
  description: 'Organisations the caller administers, with their role.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => send(res, await b2bService.listMyOrganizations({ userId: req.user.sub, userType: req.user.userType })),
};

export const getB2BOrganization = {
  created, method: 'get', path: '/b2b/organizations/:id',
  description: 'Organisation profile, KYB status and the caller\'s role and permissions.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, async access => ({
    organization: access.org, access: { role: access.role, permissions: access.permissions },
  })),
};

export const updateB2BOrganization = {
  created, method: 'put', path: '/b2b/organizations/:id',
  description: 'Update the organisation profile (organization.update). Fields Corporate owns for a mapped company are refused with managed_by_corporate.',
  requestSample: { tradingName: 'Jubilee Wellness', address: { city: 'Arusha', country: 'TZ' } },
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, async (access) => {
    if (!access.permissions.includes('organization.update')) return { error: 'forbidden', status: 403, requiredPermission: 'organization.update' };
    return b2bService.updateOrganization({
      organizationId: access.org.id, body: req.body || {}, actorId: req.user.sub, platformAdmin: access.platformAdmin,
    });
  }),
};

// ── Organisation users ─────────────────────────────────────────────────────

export const listB2BOrganizationUsers = {
  created, method: 'get', path: '/b2b/organizations/:id/users',
  description: 'Organisation users (users.read). Query: ?status=active|suspended|removed&limit=&cursor=. A mapped company\'s HR logins appear read-only with role hr.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.listOrganizationUsers({ access, query: req.query || {} })),
};

export const addB2BOrganizationUser = {
  created, method: 'post', path: '/b2b/organizations/:id/users',
  description: 'Add an existing FitFlex user to the organisation (users.manage). Roles: owner, admin, manager, finance, hr, analyst, viewer.',
  requestSample: { userId: 'usr_…', role: 'manager', permissions: [] },
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.addOrganizationUser({
    access, body: req.body || {}, actorId: req.user.sub,
  }), 201),
};

export const updateB2BOrganizationUser = {
  created, method: 'put', path: '/b2b/organizations/:id/users/:orgUserId',
  description: 'Change an organisation user\'s role, status (active | suspended | removed) or extra permissions (users.manage).',
  requestSample: { role: 'analyst', status: 'active' },
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.updateOrganizationUser({
    access, organizationUserId: req.params.orgUserId, body: req.body || {}, actorId: req.user.sub,
  })),
};

export const removeB2BOrganizationUser = {
  created, method: 'delete', path: '/b2b/organizations/:id/users/:orgUserId',
  description: 'Remove an organisation user (users.manage). The row is kept with status removed.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.removeOrganizationUser({
    access, organizationUserId: req.params.orgUserId, actorId: req.user.sub,
  })),
};

// ── Beneficiaries ──────────────────────────────────────────────────────────

export const listB2BBeneficiaries = {
  created, method: 'get', path: '/b2b/organizations/:id/beneficiaries',
  description: 'Beneficiaries (beneficiaries.read). Query: ?status=&type=&group=&search=&limit=&cursor=. A mapped company\'s employees appear read-only with source corporate_employee.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.listBeneficiaries({ access, query: req.query || {} })),
};

export const getB2BBeneficiary = {
  created, method: 'get', path: '/b2b/organizations/:id/beneficiaries/:beneficiaryId',
  description: 'One beneficiary of the organisation (beneficiaries.read).',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.getBeneficiary({
    access, beneficiaryId: req.params.beneficiaryId,
  })),
};

export const enrollB2BBeneficiary = {
  created, method: 'post', path: '/b2b/organizations/:id/beneficiaries',
  description: 'Enrol a FitFlex member (beneficiaries.manage). The organisation must be active. A mapped company enrols staff through /corporate/staff.',
  requestSample: { userId: 'usr_…', beneficiaryType: 'policyholder', externalReference: 'POL-00123', groupName: 'Gold scheme', status: 'active' },
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.enrollBeneficiary({
    access, body: req.body || {}, actorId: req.user.sub,
  }), 201),
};

export const setB2BBeneficiaryStatus = {
  created, method: 'post', path: '/b2b/organizations/:id/beneficiaries/:beneficiaryId/status',
  description: 'Move a beneficiary between pending, active, suspended and inactive (beneficiaries.manage).',
  requestSample: { status: 'suspended' },
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.setBeneficiaryStatus({
    access, beneficiaryId: req.params.beneficiaryId, status: req.body?.status, actorId: req.user.sub,
  })),
};

export const deactivateB2BBeneficiary = {
  created, method: 'delete', path: '/b2b/organizations/:id/beneficiaries/:beneficiaryId',
  description: 'Deactivate a beneficiary (beneficiaries.manage). The relationship is kept with status inactive.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.deactivateBeneficiary({
    access, beneficiaryId: req.params.beneficiaryId, actorId: req.user.sub,
  })),
};

// ── Wellness programmes and benefits (Phase 2) ─────────────────────────────
// Rules only: no usage is counted and no money moves through these routes.

const programs = b2bProgramService;

export const b2bProgramReference = {
  created, method: 'get', path: '/b2b/programs/reference',
  description: 'Public: programme types and lifecycle, benefit types (and the FitFlex service that fulfils each), funding types, usage periods and eligibility scopes.',
  onRequest: (_req, res) => res.json(programs.reference()),
};

export const adminListB2BPrograms = {
  created, method: 'get', path: '/admin/b2b/programs',
  description: 'Admin: wellness programmes across organisations. Query: ?organizationId=&status=&limit=&cursor=.',
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await programs.adminListPrograms({ query: req.query || {} })),
};

export const myB2BBenefits = {
  created, method: 'get', path: '/b2b/me/benefits',
  description: 'The caller\'s B2B wellness benefits today, across every organisation that sponsors them (read-only; remaining allowance comes with usage tracking).',
  onGuard: requireAuth(),
  onRequest: async (req, res) => send(res, await programs.myBenefits({ userId: req.user.sub })),
};

export const listB2BPrograms = {
  created, method: 'get', path: '/b2b/organizations/:id/programs',
  description: 'Programmes of an organisation (programs.read). Query: ?status=&limit=&cursor=.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.listPrograms({ access, query: req.query || {} })),
};

export const createB2BProgram = {
  created, method: 'post', path: '/b2b/organizations/:id/programs',
  description: 'Create a draft programme (programs.manage). Eligibility: { scope: all | groups | selected, groups, beneficiaryIds, beneficiaryTypes, enrolledOnOrBefore }.',
  requestSample: {
    name: 'ABC Employee Wellness 2027', programType: 'employee_wellness', startDate: '2027-01-01', endDate: '2027-12-31',
    eligibility: { scope: 'groups', groups: ['Finance', 'Operations'] }, budgetTzs: 50000000,
  },
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.createProgram({ access, body: req.body || {}, actorId: req.user.sub }), 201),
};

export const getB2BProgram = {
  created, method: 'get', path: '/b2b/organizations/:id/programs/:programId',
  description: 'A programme with its benefits (programs.read).',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.getProgram({ access, programId: req.params.programId })),
};

export const updateB2BProgram = {
  created, method: 'put', path: '/b2b/organizations/:id/programs/:programId',
  description: 'Edit a programme (programs.manage). Draft and pending: any field. Active or paused: name, description, a later end date or a larger budget.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.updateProgram({
    access, programId: req.params.programId, body: req.body || {}, actorId: req.user.sub,
  })),
};

export const setB2BProgramStatus = {
  created, method: 'post', path: '/b2b/organizations/:id/programs/:programId/status',
  description: 'Programme lifecycle (programs.manage): pending (submit), draft (withdraw), active (FitFlex activates a pending programme; the organisation may resume a paused one), paused, cancelled.',
  requestSample: { status: 'pending' },
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.setProgramStatus({
    access, programId: req.params.programId, status: req.body?.status, reason: req.body?.reason, actorId: req.user.sub,
  })),
};

export const listB2BProgramEligibility = {
  created, method: 'get', path: '/b2b/organizations/:id/programs/:programId/eligibility',
  description: 'Beneficiaries the programme (or ?benefitId=) reaches (programs.read + beneficiaries.read). ?include=all also lists the rest with the reason.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.listEligibleBeneficiaries({
    access, programId: req.params.programId, query: req.query || {},
  })),
};

export const listB2BBenefits = {
  created, method: 'get', path: '/b2b/organizations/:id/programs/:programId/benefits',
  description: 'Benefits of a programme (programs.read).',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.listBenefits({ access, programId: req.params.programId })),
};

export const createB2BBenefit = {
  created, method: 'post', path: '/b2b/organizations/:id/programs/:programId/benefits',
  description: 'Add a draft benefit (programs.manage).',
  requestSample: {
    name: '8 gym visits a month', benefitType: 'gym_access', fundingType: 'sponsor_percentage', sponsorShareBps: 6000,
    usageLimit: 8, usagePeriod: 'month', providerRules: { scope: 'selected', gymTiers: ['standard', 'midtier'] },
  },
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.createBenefit({
    access, programId: req.params.programId, body: req.body || {}, actorId: req.user.sub,
  }), 201),
};

export const getB2BBenefit = {
  created, method: 'get', path: '/b2b/organizations/:id/programs/:programId/benefits/:benefitId',
  description: 'One benefit with today\'s usage window (programs.read).',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.getBenefit({
    access, programId: req.params.programId, benefitId: req.params.benefitId,
  })),
};

export const updateB2BBenefit = {
  created, method: 'put', path: '/b2b/organizations/:id/programs/:programId/benefits/:benefitId',
  description: 'Edit a benefit (programs.manage). While it is active in a live programme only name, description and terms change.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.updateBenefit({
    access, programId: req.params.programId, benefitId: req.params.benefitId, body: req.body || {}, actorId: req.user.sub,
  })),
};

export const setB2BBenefitStatus = {
  created, method: 'post', path: '/b2b/organizations/:id/programs/:programId/benefits/:benefitId/status',
  description: 'Activate or deactivate a benefit (programs.manage).',
  requestSample: { status: 'active' },
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => programs.setBenefitStatus({
    access, programId: req.params.programId, benefitId: req.params.benefitId, status: req.body?.status, actorId: req.user.sub,
  })),
};

// ── Benefit usage (Phase 3) ────────────────────────────────────────────────
// Benefits are consumed by the existing services (gym check-in, trainer
// booking completion), never through a route: no caller can name a benefit,
// an amount or a usage count. These routes read the ledger and correct it.

const usage = b2bConsumptionService;

export const adminListB2BConsumptions = {
  created, method: 'get', path: '/admin/b2b/consumptions',
  description: 'Admin: the benefit consumption ledger, newest first. Query: ?organizationId=&programId=&benefitId=&beneficiaryId=&userId=&providerType=&providerId=&serviceType=&sourceType=&sourceId=&status=&from=&to=&limit=&cursor=. Returns { items, total, nextCursor, totals }.',
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await usage.adminList({ query: req.query || {} })),
};

export const adminGetB2BConsumption = {
  created, method: 'get', path: '/admin/b2b/consumptions/:consumptionId',
  description: 'Admin: one consumption with the rules in force, its source usage event (check-in or booking) and the settlement candidate.',
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await usage.adminGet({ consumptionId: req.params.consumptionId })),
};

export const adminReverseB2BConsumption = {
  created, method: 'post', path: '/admin/b2b/consumptions/:consumptionId/reverse',
  description: 'Admin: reverse an approved consumption. The row is kept and marked reversed with who, when and why; the allowance and budget get it back. Reversing a gym visit also voids its check-in (response: checkinVoided), so a gym already paid for it is clawed back on its next statement; portal staff need the payments scope for that as well.',
  requestSample: { reason: 'Checked in at the wrong gym' },
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await usage.reverse({
    consumptionId: req.params.consumptionId, reason: req.body?.reason, actorId: req.user.sub,
    mayVoidCheckin: !req.user.portalUser || (req.user.aclPermissions || []).includes('payments'),
  })),
};

export const adminEvaluateB2BUsage = {
  created, method: 'post', path: '/admin/b2b/evaluate-usage',
  description: 'Admin: dry run — which benefit would cover this member at this gym or trainer right now, and why the others would not. Writes nothing.',
  requestSample: { userId: 'usr_…', serviceType: 'gym_access', providerId: 'gym_…' },
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await usage.adminEvaluate({ body: req.body || {} })),
};

export const getB2BProgramUsage = {
  created, method: 'get', path: '/b2b/organizations/:id/programs/:programId/usage',
  description: 'Usage of a programme (usage.read): totals, budget, and breakdowns by benefit, provider and beneficiary. Aggregates only. Query: ?from=&to= (EAT days).',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => usage.programUsage({
    access, programId: req.params.programId, query: req.query || {},
  })),
};

// ── Sponsor billing ────────────────────────────────────────────────────────
// What organisations and their beneficiaries are charged: flat fees for
// sponsored passes (in advance) and the sponsor's share of per-use benefits
// (after the month). Invoices are raised and settled by FitFlex; organisations
// read their own. Nothing here pays a provider.

const billing = b2bBillingService;

export const adminPrepareB2BInvoice = {
  created, method: 'post', path: '/admin/b2b/programs/:programId/invoices/prepare',
  description: 'Admin: add what is not yet invoiced to the programme\'s draft invoice. kind "prepaid": everyone nominated for a sponsored pass in this or next month. kind "usage": the sponsor\'s share of approved per-use consumption in a month that has ended, plus credits for usage reversed since. Safe to repeat.',
  requestSample: { kind: 'prepaid', period: '2026-11' },
  onGuard: requireBilling,
  onRequest: async (req, res) => {
    const args = { programId: req.params.programId, period: req.body?.period, actorId: req.user.sub };
    if (req.body?.kind === 'prepaid') return send(res, await billing.preparePrepaid(args));
    if (req.body?.kind === 'usage') return send(res, await billing.prepareUsage(args));
    return res.status(400).json({ error: 'invalid_kind', allowed: ['prepaid', 'usage'] });
  },
};

export const adminListB2BInvoices = {
  created, method: 'get', path: '/admin/b2b/invoices',
  description: 'Admin: sponsor invoices across organisations. Query: ?organizationId=&programId=&period=&kind=&status=&limit=&cursor=.',
  onGuard: requireBillingRead,
  onRequest: async (req, res) => send(res, await billing.adminListInvoices({ query: req.query || {} })),
};

export const adminGetB2BInvoice = {
  created, method: 'get', path: '/admin/b2b/invoices/:invoiceId',
  description: 'Admin: one sponsor invoice with every line.',
  onGuard: requireBillingRead,
  onRequest: async (req, res) => send(res, await billing.getInvoice({ invoiceId: req.params.invoiceId })),
};

export const adminIssueB2BInvoice = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/issue',
  description: 'Admin (b2b_billing): issue a draft invoice. Its figures freeze, it gets its number (FF-INV-YYYY-NNNNNN) and its due date from the organisation\'s agreement, and the terms in force are kept on it. Amounts are VAT-inclusive; state the VAT rate in basis points (1800 = 18%, 0 = none), or leave it out to use the agreement\'s rate. A credit or debit note is issued with POST /admin/b2b/notes/:noteId/issue.',
  requestSample: { vatRateBps: 1800 },
  onGuard: requireBilling,
  onRequest: async (req, res) => send(res, await billing.issueInvoice({ invoiceId: req.params.invoiceId, vatRateBps: req.body?.vatRateBps, actorId: req.user.sub })),
};

export const adminMarkB2BInvoicePaid = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/paid',
  description: 'Admin (b2b_payments): settle an invoice in full against one payment reference. A shortcut for recording a payment for what is owed and allocating it; use POST /admin/b2b/organizations/:id/payments for part payments or one payment covering several invoices. The person who issued the invoice cannot do this. Paying a prepaid invoice starts fully sponsored passes and lets members unlock the rest.',
  requestSample: { paymentReference: 'BANK-TRF-00123' },
  onGuard: requirePayments,
  onRequest: async (req, res) => send(res, await billing.markPaid({ invoiceId: req.params.invoiceId, paymentReference: req.body?.paymentReference, actorId: req.user.sub })),
};

export const adminVoidB2BInvoice = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/void',
  description: 'Admin: void a draft or issued invoice, with a reason. It is kept; what was on it can be invoiced again.',
  requestSample: { reason: 'Raised for the wrong month' },
  onGuard: requireBilling,
  onRequest: async (req, res) => send(res, await billing.voidInvoice({ invoiceId: req.params.invoiceId, reason: req.body?.reason, actorId: req.user.sub })),
};

export const adminListB2BEntitlements = {
  created, method: 'get', path: '/admin/b2b/programs/:programId/entitlements',
  description: 'Admin: who is covered by a sponsored pass for a month (?period=YYYY-MM, default this month) and where each pass stands.',
  onGuard: requireBillingRead,
  onRequest: async (req, res) => send(res, await billing.listEntitlements({ programId: req.params.programId, period: req.query?.period || undefined })),
};

export const adminConvertCorporateToProgram = {
  created, method: 'post', path: '/admin/b2b/corporate/:corporateId/convert',
  description: 'Admin: express a company\'s seat arrangement as a draft programme with one sponsored pass (its pass tier and subsidy split). Once that programme is live, seat bills for the company are refused.',
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await billing.convertCorporate({ corporateId: req.params.corporateId, actorId: req.user.sub }), 201),
};

export const listB2BOrganizationInvoices = {
  created, method: 'get', path: '/b2b/organizations/:id/invoices',
  description: 'An organisation\'s issued, paid and voided invoices and notes (billing.read: owner, admin, finance), each with what is still owed. Query: ?programId=&period=&kind=&status=.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => billing.listInvoices({ access, query: req.query || {} })),
};

export const getB2BOrganizationInvoice = {
  created, method: 'get', path: '/b2b/organizations/:id/invoices/:invoiceId',
  description: 'One of the organisation\'s invoices (billing.read): pass lines per person, usage as totals per benefit and person, fees and notes as they are, with the payments and credits applied to it.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => billing.getInvoice({ access, invoiceId: req.params.invoiceId })),
};

export const unlockMyB2BPass = {
  created, method: 'post', path: '/b2b/me/passes/:entitlementId/unlock',
  description: 'Member: ask to pay your share of a sponsored pass for this month. Returns a payment request; the pass starts when the payment is approved.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await billing.unlock({ userId: req.user.sub, entitlementId: req.params.entitlementId }), 201),
};

// ── Billing and financial management (Phase 5) ─────────────────────────────
// Commercial agreements, the billing account, payments and their allocation,
// credit and debit notes, statements, aging and reconciliation. Customer
// billing only: provider settlement is a separate process and is only read
// here, to show the two side by side.

const finance = b2bFinanceService;
const actor = req => req.user.sub;

export const adminB2BBillingDashboard = {
  created, method: 'get', path: '/admin/b2b/billing',
  description: 'Admin: receivables across organisations: invoiced, collected, outstanding, overdue, credit on account and aging (current, 1-30, 31-60, 61-90, 90+ days overdue), per organisation and in total; draft invoices of the month; and for ?period=YYYY-MM (default this month) what was billed next to what gyms and trainers are owed for the same activity. That difference is not revenue or profit.',
  onGuard: requireBillingRead,
  onRequest: async (req, res) => send(res, await finance.dashboard({ query: req.query || {} })),
};

export const adminListB2BAgreements = {
  created, method: 'get', path: '/admin/b2b/organizations/:id/agreements',
  description: 'Admin: an organisation\'s commercial agreements, newest first, and the one in force today.',
  onGuard: requireBillingRead,
  onRequest: async (req, res) => send(res, await finance.listAgreements({ organizationId: req.params.id })),
};

export const adminCreateB2BAgreement = {
  created, method: 'post', path: '/admin/b2b/organizations/:id/agreements',
  description: 'Admin (b2b_billing): draft a commercial agreement: how FitFlex charges this organisation. Payment terms in days for invoices raised in advance (default 0) and after the month (default 14), an optional monthly platform fee (VAT-inclusive TZS) and an optional default VAT rate. Monthly billing in TZS.',
  requestSample: { effectiveFrom: '2026-11-01', prepaidTermsDays: 0, usageTermsDays: 14, platformFeeTzs: 500000, vatRateBps: 1800, contractReference: 'CRDB/FF/2026/01' },
  onGuard: requireBilling,
  onRequest: async (req, res) => send(res, await finance.createAgreement({ organizationId: req.params.id, body: req.body || {}, actorId: actor(req) }), 201),
};

export const adminUpdateB2BAgreement = {
  created, method: 'patch', path: '/admin/b2b/agreements/:agreementId',
  description: 'Admin (b2b_billing): change a draft agreement. One in force cannot be edited: end it and activate a new one.',
  onGuard: requireBilling,
  onRequest: async (req, res) => send(res, await finance.updateAgreement({ agreementId: req.params.agreementId, body: req.body || {}, actorId: actor(req) })),
};

export const adminActivateB2BAgreement = {
  created, method: 'post', path: '/admin/b2b/agreements/:agreementId/activate',
  description: 'Admin (b2b_billing): put a draft agreement in force from its start date. The agreement it replaces is closed the day before. Invoices already issued keep the terms they were issued under.',
  onGuard: requireBilling,
  onRequest: async (req, res) => send(res, await finance.activateAgreement({ agreementId: req.params.agreementId, actorId: actor(req) })),
};

export const adminEndB2BAgreement = {
  created, method: 'post', path: '/admin/b2b/agreements/:agreementId/end',
  description: 'Admin (b2b_billing): end an agreement in force on a day (default today).',
  requestSample: { effectiveTo: '2026-12-31' },
  onGuard: requireBilling,
  onRequest: async (req, res) => send(res, await finance.endAgreement({ agreementId: req.params.agreementId, effectiveTo: req.body?.effectiveTo, actorId: actor(req) })),
};

export const adminGetB2BBillingAccount = {
  created, method: 'get', path: '/admin/b2b/organizations/:id/billing-account',
  description: 'Admin: who the organisation\'s invoices go to. Falls back to the Corporate billing contact, then the organisation\'s own contact.',
  onGuard: requireBillingRead,
  onRequest: async (req, res) => send(res, await finance.getBillingAccount({ organizationId: req.params.id })),
};

export const adminSetB2BBillingAccount = {
  created, method: 'put', path: '/admin/b2b/organizations/:id/billing-account',
  description: 'Admin (b2b_billing): set the billing contact, email, phone and address.',
  requestSample: { contactName: 'Asha Mushi', email: 'accounts@example.co.tz', phone: '+255700000000' },
  onGuard: requireBilling,
  onRequest: async (req, res) => send(res, await finance.setBillingAccount({ organizationId: req.params.id, body: req.body || {}, actorId: actor(req) })),
};

export const adminPrepareB2BFeeInvoice = {
  created, method: 'post', path: '/admin/b2b/organizations/:id/invoices/prepare-fee',
  description: 'Admin (b2b_billing): draft the month\'s platform-fee invoice, when the agreement in force on the first of the month carries a fee. One per organisation and month; safe to repeat.',
  requestSample: { period: '2026-11' },
  onGuard: requireBilling,
  onRequest: async (req, res) => send(res, await finance.prepareFee({ organizationId: req.params.id, period: req.body?.period, actorId: actor(req) })),
};

export const adminB2BOrganizationStatement = {
  created, method: 'get', path: '/admin/b2b/organizations/:id/statement',
  description: 'Admin: the organisation\'s account: invoices, notes, payments, reversals and (read only) Corporate seat bills in date order with a running balance, plus what is outstanding, overdue, on account as credit, and aging. Query: ?from=&to= (EAT days).',
  onGuard: requireBillingRead,
  onRequest: async (req, res) => send(res, await finance.statement({ organizationId: req.params.id, query: req.query || {} })),
};

export const adminListB2BPayments = {
  created, method: 'get', path: '/admin/b2b/payments',
  description: 'Admin: payments received from organisations. Query: ?organizationId=&status=&limit=&cursor=.',
  onGuard: requireBillingRead,
  onRequest: async (req, res) => send(res, await finance.listPayments({ organizationId: req.query?.organizationId || null, query: req.query || {} })),
};

export const adminGetB2BPayment = {
  created, method: 'get', path: '/admin/b2b/payments/:paymentId',
  description: 'Admin: one payment with the invoices it settled.',
  onGuard: requireBillingRead,
  onRequest: async (req, res) => send(res, await finance.getPayment({ paymentId: req.params.paymentId })),
};

export const adminRecordB2BPayment = {
  created, method: 'post', path: '/admin/b2b/organizations/:id/payments',
  description: 'Admin (b2b_payments): record money received. method: bank_transfer | mobile_money | lipa_namba | cheque | cash | card | other. The same reference by the same method is one payment: recording it again returns the first (409 if the amount differs). `allocations` settles named invoices; `autoAllocate: true` settles the oldest due first; anything left stays on the account as credit. The person who issued an invoice cannot record its payment.',
  requestSample: { amountTzs: 1200000, method: 'bank_transfer', reference: 'CRDB-TRF-00917', receivedAt: '2026-11-03T09:00:00Z', allocations: [{ invoiceId: 'b2bi_…', amountTzs: 1000000 }, { invoiceId: 'b2bi_…', amountTzs: 200000 }] },
  onGuard: requirePayments,
  onRequest: async (req, res) => {
    const out = await finance.recordPayment({ organizationId: req.params.id, body: req.body || {}, actorId: actor(req) });
    return send(res, out, out.existing ? 200 : 201);
  },
};

export const adminAllocateB2BPayment = {
  created, method: 'post', path: '/admin/b2b/payments/:paymentId/allocate',
  description: 'Admin (b2b_payments): settle invoices from a payment already recorded. Each amount is checked against what is left on the payment and on the invoice, so sending it twice allocates once; an optional requestId makes that explicit.',
  requestSample: { allocations: [{ invoiceId: 'b2bi_…', amountTzs: 200000 }], requestId: 'alloc-2026-11-03-1' },
  onGuard: requirePayments,
  onRequest: async (req, res) => send(res, await finance.allocate({ paymentId: req.params.paymentId, body: req.body || {}, actorId: actor(req) })),
};

export const adminReverseB2BPayment = {
  created, method: 'post', path: '/admin/b2b/payments/:paymentId/reverse',
  description: 'Admin (b2b_billing_approve): reverse a payment that did not arrive, with a reason. The invoices it part-settled are opened again. A payment that completed an invoice is not reversed (a paid invoice is final): raise a debit note instead.',
  requestSample: { reason: 'Cheque returned unpaid' },
  onGuard: requireBillingApproval,
  onRequest: async (req, res) => send(res, await finance.reversePayment({ paymentId: req.params.paymentId, reason: req.body?.reason, actorId: actor(req) })),
};

export const adminCreateB2BNote = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/notes',
  description: 'Admin (b2b_billing): draft a credit note (takes an amount off an issued invoice) or a debit note (adds to it), with a reason. The invoice itself is never edited. A credit cannot exceed the invoice less the credits already raised on it.',
  requestSample: { type: 'credit', amountTzs: 60000, reason: 'One employee left before the month began' },
  onGuard: requireBilling,
  onRequest: async (req, res) => send(res, await finance.createNote({ invoiceId: req.params.invoiceId, body: req.body || {}, actorId: actor(req) }), 201),
};

export const adminIssueB2BNote = {
  created, method: 'post', path: '/admin/b2b/notes/:noteId/issue',
  description: 'Admin (b2b_billing_approve): issue a credit or debit note. It must be someone other than the person who drafted it. A credit note is applied at once to the invoice it corrects, up to what is owed on it; the rest stays on the account as credit.',
  onGuard: requireBillingApproval,
  onRequest: async (req, res) => send(res, await finance.issueNote({ noteId: req.params.noteId, body: req.body || {}, actorId: actor(req) })),
};

export const adminApplyB2BCredit = {
  created, method: 'post', path: '/admin/b2b/notes/:noteId/apply',
  description: 'Admin (b2b_payments): apply what is left of an issued credit note (or a credit for reversed usage) to other open invoices of the same organisation.',
  requestSample: { allocations: [{ invoiceId: 'b2bi_…', amountTzs: 60000 }] },
  onGuard: requirePayments,
  onRequest: async (req, res) => send(res, await finance.allocate({ creditInvoiceId: req.params.noteId, body: req.body || {}, actorId: actor(req) })),
};

export const adminB2BInvoiceReconciliation = {
  created, method: 'get', path: '/admin/b2b/invoices/:invoiceId/reconciliation',
  description: 'Admin: trace an invoice to what it charges for. Each usage line to its consumption and the check-in or session behind it; each pass line to the person\'s entitlement and pass; the payments applied; and, separately, where the provider side of the same activity stands in settlement. Includes checks that the lines add up and that each usage line equals the sponsor share on the ledger.',
  onGuard: requireBillingRead,
  onRequest: async (req, res) => send(res, await finance.reconciliation({ invoiceId: req.params.invoiceId })),
};

export const getB2BOrganizationBilling = {
  created, method: 'get', path: '/b2b/organizations/:id/billing',
  description: 'An organisation\'s billing overview (billing.read: owner, admin, finance): what is outstanding, overdue and on account as credit, aging, the billing contact, the payment terms in force and the latest invoices.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => finance.organizationOverview({ access })),
};

export const listB2BOrganizationPayments = {
  created, method: 'get', path: '/b2b/organizations/:id/payments',
  description: 'The payments FitFlex has recorded from the organisation (billing.read), newest first.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => finance.organizationPayments({ access, query: req.query || {} })),
};

export const getB2BOrganizationStatement = {
  created, method: 'get', path: '/b2b/organizations/:id/statement',
  description: 'The organisation\'s account statement (billing.read): invoices, notes, payments and seat bills in date order with a running balance. Query: ?from=&to= (EAT days).',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => finance.organizationStatement({ access, query: req.query || {} })),
};
