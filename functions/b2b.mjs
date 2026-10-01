// B2B Foundation V1 REST surface — organisations, their users and beneficiaries.
//
// FitFlex admins (portal staff need the 'b2b' scope) manage every organisation.
// Organisation routes are also open to that organisation's own users: access
// comes from their B2BOrganizationUser role (or, for a company mapped from
// Corporate, its HR logins), never from anything the caller sends. Corporate
// routes (/corporate/*, /admin/corporate/*) are unchanged.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { b2bService, b2bProgramService, b2bConsumptionService, b2bBillingService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

const requireAdmin = [requireAuth('admin'), requireAcl('b2b')];
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
  description: 'Admin: reverse an approved consumption. The row is kept and marked reversed with who, when and why; the allowance and budget get it back.',
  requestSample: { reason: 'Checked in at the wrong gym' },
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await usage.reverse({
    consumptionId: req.params.consumptionId, reason: req.body?.reason, actorId: req.user.sub,
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
  onGuard: requireAdmin,
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
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await billing.adminListInvoices({ query: req.query || {} })),
};

export const adminGetB2BInvoice = {
  created, method: 'get', path: '/admin/b2b/invoices/:invoiceId',
  description: 'Admin: one sponsor invoice with every line.',
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await billing.getInvoice({ invoiceId: req.params.invoiceId })),
};

export const adminIssueB2BInvoice = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/issue',
  description: 'Admin: issue a draft invoice. Its figures freeze. Amounts are VAT-inclusive; state the VAT rate in basis points (1800 = 18%, 0 = none).',
  requestSample: { vatRateBps: 1800 },
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await billing.issueInvoice({ invoiceId: req.params.invoiceId, vatRateBps: req.body?.vatRateBps, actorId: req.user.sub })),
};

export const adminMarkB2BInvoicePaid = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/paid',
  description: 'Admin: record the sponsor\'s payment against a reference. Paying a prepaid invoice starts fully sponsored passes and lets members unlock the rest.',
  requestSample: { paymentReference: 'BANK-TRF-00123' },
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await billing.markPaid({ invoiceId: req.params.invoiceId, paymentReference: req.body?.paymentReference, actorId: req.user.sub })),
};

export const adminVoidB2BInvoice = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/void',
  description: 'Admin: void a draft or issued invoice, with a reason. It is kept; what was on it can be invoiced again.',
  requestSample: { reason: 'Raised for the wrong month' },
  onGuard: requireAdmin,
  onRequest: async (req, res) => send(res, await billing.voidInvoice({ invoiceId: req.params.invoiceId, reason: req.body?.reason, actorId: req.user.sub })),
};

export const adminListB2BEntitlements = {
  created, method: 'get', path: '/admin/b2b/programs/:programId/entitlements',
  description: 'Admin: who is covered by a sponsored pass for a month (?period=YYYY-MM, default this month) and where each pass stands.',
  onGuard: requireAdmin,
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
  description: 'An organisation\'s issued, paid and voided invoices (usage.read). Query: ?programId=&period=&kind=&status=.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => billing.listInvoices({ access, query: req.query || {} })),
};

export const getB2BOrganizationInvoice = {
  created, method: 'get', path: '/b2b/organizations/:id/invoices/:invoiceId',
  description: 'One of the organisation\'s invoices (usage.read): pass lines per person, usage as totals per benefit and person.',
  onGuard: requireOrgAccess,
  onRequest: (req, res) => inOrganization(req, res, access => billing.getInvoice({ access, invoiceId: req.params.invoiceId })),
};

export const unlockMyB2BPass = {
  created, method: 'post', path: '/b2b/me/passes/:entitlementId/unlock',
  description: 'Member: ask to pay your share of a sponsored pass for this month. Returns a payment request; the pass starts when the payment is approved.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await billing.unlock({ userId: req.user.sub, entitlementId: req.params.entitlementId }), 201),
};
