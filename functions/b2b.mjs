// B2B Foundation V1 REST surface — organisations, their users and beneficiaries.
//
// FitFlex admins (portal staff need the 'b2b' scope) manage every organisation.
// Organisation routes are also open to that organisation's own users: access
// comes from their B2BOrganizationUser role (or, for a company mapped from
// Corporate, its HR logins), never from anything the caller sends. Corporate
// routes (/corporate/*, /admin/corporate/*) are unchanged.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { orgOnlySponsorsOn } from '../src/shared/feature-flags.mjs';
import { b2bMemberRequestService, b2bService, b2bProgramService, b2bConsumptionService, b2bBillingService, b2bFinanceService, b2bCollectionsService, b2bAnalyticsService, opsService, b2bOps, b2bBeneficiaryImportService, b2bLifecycleService } from '../src/bootstrap/services.mjs';

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

// An add by user id that now waits for the member to accept answers 202.
const PENDING_MEMBER = 'pending_member_acceptance';

function send(res, result, okStatus = 200) {
  const { error, status, ...payload } = result;
  if (error) return res.status(status).json({ error, ...payload });
  return res.status(payload.outcome === PENDING_MEMBER ? 202 : okStatus).json(payload);
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
  onGuard: routeGuard('post', requireAdmin),
  onRequest: async (req, res) => send(res, await b2bService.createOrganization({ body: req.body || {}, actorId: req.user.sub }), 201),
};

export const adminListB2BOrganizations = {
  created, method: 'get', path: '/admin/b2b/organizations',
  description: 'Admin: list organisations, newest first. Query: ?type=&status=&search=&limit=&cursor=. Returns { items, total, nextCursor }.',
  onGuard: routeGuard('get', requireAdmin),
  onRequest: async (req, res) => send(res, await b2bService.listOrganizations({ query: req.query || {} })),
};

export const adminSetB2BOrganizationStatus = {
  created, method: 'post', path: '/admin/b2b/organizations/:id/status',
  description: 'Admin: move an organisation between pending, active, suspended and inactive. A company mapped from Corporate changes status through /admin/corporate/:id/status.',
  requestSample: { status: 'active', reason: 'Contract signed' },
  onGuard: routeGuard('post', requireAdmin),
  onRequest: async (req, res) => send(res, await b2bService.setOrganizationStatus({
    organizationId: req.params.id, status: req.body?.status, reason: req.body?.reason, actorId: req.user.sub,
  })),
};

export const adminSyncCorporateOrganizations = {
  created, method: 'post', path: '/admin/b2b/corporate-sync',
  description: 'Admin: map every corporate account without an employer organisation. Idempotent; returns { created, existing }.',
  onGuard: routeGuard('post', requireAdmin),
  onRequest: async (req, res) => send(res, await b2bService.syncCorporateOrganizations({ actorId: req.user.sub })),
};

export const adminB2BOrganizationForCorporate = {
  created, method: 'get', path: '/admin/b2b/corporate/:corporateId',
  description: 'Admin: the employer organisation that represents a corporate account (null until mapped).',
  onGuard: routeGuard('get', requireAdmin),
  onRequest: async (req, res) => send(res, await b2bService.organizationForCorporate({ corporateId: req.params.corporateId })),
};

// ── Organisations (admin or the organisation's own users) ──────────────────

export const myB2BOrganizations = {
  created, method: 'get', path: '/b2b/me/organizations',
  description: 'Organisations the caller administers, with their role.',
  onGuard: routeGuard('get', requireAuth()),
  onRequest: async (req, res) => send(res, await b2bService.listMyOrganizations({ userId: req.user.sub, userType: req.user.userType })),
};

export const myB2BOrganizationSession = {
  created, method: 'get', path: '/b2b/me/organization-session',
  description: 'B5a: what a sign-in would tell the portal about the caller right now, without signing in again. Always { orgOnlySponsors } (whether ORG_ONLY_SPONSORS is on); while it is on and the caller is a company HR login that reaches its organisation, also { organizationUser: true, organizationRoles, organizationIds }, computed exactly as in the sign-in response. Any other caller (or the flag off) gets orgOnlySponsors only.',
  responseSample: { orgOnlySponsors: true, organizationUser: true, organizationRoles: ['hr'], organizationIds: ['b2bo_0123456789ab'] },
  onGuard: routeGuard('get', requireAuth()),
  onRequest: async (req, res) => {
    const marks = await b2bService.organizationSessionMarks({ userId: req.user.sub, userType: req.user.userType });
    res.json({ orgOnlySponsors: orgOnlySponsorsOn(), ...(marks ?? {}) });
  },
};

export const getB2BOrganization = {
  created, method: 'get', path: '/b2b/organizations/:id',
  description: 'Organisation profile, KYB status and the caller\'s role and permissions. access.companyStaffManage (B5a): whether the caller may add, change, link and import a company\'s staff here (ORG_ONLY_SPONSORS on, a company\'s organisation, org role hr or admin only); false everywhere else.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, async access => ({
    organization: access.org,
    access: {
      role: access.role, permissions: access.permissions,
      // B5a: true only where the caller may manage a company's staff from here (ORG_ONLY_SPONSORS on, a company's organisation, org role hr or admin).
      companyStaffManage: b2bService.companyStaffManage(access),
    },
  })),
};

export const updateB2BOrganization = {
  created, method: 'put', path: '/b2b/organizations/:id',
  description: 'Update the organisation profile (organization.update). Fields Corporate owns for a mapped company are refused with managed_by_corporate.',
  requestSample: { tradingName: 'Jubilee Wellness', address: { city: 'Arusha', country: 'TZ' } },
  onGuard: routeGuard('put', requireOrgAccess),
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
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.listOrganizationUsers({ access, query: req.query || {} })),
};

export const addB2BOrganizationUser = {
  created, method: 'post', path: '/b2b/organizations/:id/users',
  description: 'Add someone who already has a FitFlex account to the organisation (users.manage). Name them by the verified email or mobile number of their account, or by userId (one of the three). When several accounts share that email or number, the member account is used. Roles: owner, admin, manager, finance, hr, analyst, viewer. Organisation users (not FitFlex admins) never add anyone directly: 202 { outcome: "pending_member_acceptance", memberRequest } and the person must accept in the app; until then they have no role. By email/phone the reply is the same whether or not an account is behind the contact (memberRequest.userId null, always stored, listed in pendingMemberAcceptance; the same contact again returns the same request). FitFlex admins add directly (201) and the person is told (b2b_admin_added).',
  requestSample: { email: 'grace@example.co.tz', role: 'finance', permissions: [] },
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.addOrganizationUser({
    access, body: req.body || {}, actorId: req.user.sub,
  }), 201),
};

export const updateB2BOrganizationUser = {
  created, method: 'put', path: '/b2b/organizations/:id/users/:orgUserId',
  description: 'Change an organisation user\'s role, status (active | suspended | removed) or extra permissions (users.manage).',
  requestSample: { role: 'analyst', status: 'active' },
  onGuard: routeGuard('put', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.updateOrganizationUser({
    access, organizationUserId: req.params.orgUserId, body: req.body || {}, actorId: req.user.sub,
  })),
};

export const removeB2BOrganizationUser = {
  created, method: 'delete', path: '/b2b/organizations/:id/users/:orgUserId',
  description: 'Remove an organisation user (users.manage). The row is kept with status removed.',
  onGuard: routeGuard('delete', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.removeOrganizationUser({
    access, organizationUserId: req.params.orgUserId, actorId: req.user.sub,
  })),
};

// ── Beneficiaries ──────────────────────────────────────────────────────────

export const listB2BBeneficiaries = {
  created, method: 'get', path: '/b2b/organizations/:id/beneficiaries',
  description: 'Beneficiaries (beneficiaries.read). Query: ?status=&type=&group=&search=&limit=&cursor=. A mapped company\'s employees appear read-only with source corporate_employee.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.listBeneficiaries({ access, query: req.query || {} })),
};

export const getB2BBeneficiary = {
  created, method: 'get', path: '/b2b/organizations/:id/beneficiaries/:beneficiaryId',
  description: 'One beneficiary of the organisation (beneficiaries.read).',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.getBeneficiary({
    access, beneficiaryId: req.params.beneficiaryId,
  })),
};

export const enrollB2BBeneficiary = {
  created, method: 'post', path: '/b2b/organizations/:id/beneficiaries',
  description: 'Enrol someone (beneficiaries.manage). The organisation must be active. ' +
    'OTHER ORGANISATIONS: a FitFlex member named by the verified email or mobile number of their member account, or by userId (one of the three). Organisation users (not FitFlex admins) never enrol anyone directly: 202 { outcome: "pending_member_acceptance", memberRequest }; the member must accept in the app, and until then the organisation sees nothing of them and is charged nothing. By userId an id that names nobody gets the same 202 (memberRequest.id null, nothing stored); asking again while open is 409 member_request_pending. By email/phone (consent slice (a)) the reply is the same whether or not a member is behind the contact: memberRequest { id, source: "contact", contactType, contact, userId: null, displayName: null } is always stored (it simply expires when nobody can be asked), the same contact asked again returns the same request (202), and it is listed in pendingMemberAcceptance; refusals never depend on the person (400 invalid_email / invalid_phone, 409 external_reference_in_use, 429 rate_limited / member_request_limit). FitFlex admins enrol directly (201) and the member is told (b2b_admin_added). ' +
    'A COMPANY\'S ORGANISATION (mirrored from Corporate): 409 managed_by_corporate (use /corporate/staff) unless ORG_ONLY_SPONSORS is on; then org roles hr and admin only (others 403 forbidden { requiredRoles }), and the person joins the company staff list through the company staff path (seat limit, billing): body { displayName (required), email?, phone?, userId?, groupName? (department), status?: pending|active }. The staff row always gets the name given here — nothing of the member\'s is copied before they accept — and an activation PIN, shown once. ' +
    'Name only: 201 { beneficiary, pin, writtenThrough: "corporate_staff" }. Also named by userId or by email/phone: the row is added unlinked and the member is ASKED to accept the link — 202 { outcome: "pending_member_acceptance", memberRequest, beneficiary, pin, writtenThrough }; it is linked only when they accept. By userId an unknown id gets the same 202 (memberRequest.id null, nothing stored). By email/phone the reply is the same whether or not a member is behind the contact (memberRequest.userId is always null; memberRequest.id is a stored request either way). A FitFlex platform admin links directly (201, the member is told). Link refusals (e.g. 409 already_enrolled, member_request_pending, 429 rate_limited / member_request_cooldown) add nobody (the seat is given back).',
  requestSample: { phone: '0712 345 678', beneficiaryType: 'policyholder', externalReference: 'POL-00123', groupName: 'Gold scheme', status: 'active' },
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.enrollBeneficiary({
    access, body: req.body || {}, actorId: req.user.sub,
  }), 201),
};

export const setB2BBeneficiaryStatus = {
  created, method: 'post', path: '/b2b/organizations/:id/beneficiaries/:beneficiaryId/status',
  description: 'Move a beneficiary between pending, active, suspended and inactive (beneficiaries.manage). A mapped company\'s employee: 409 managed_by_corporate, unless ORG_ONLY_SPONSORS is on — then active/suspended/inactive set the employee active/suspended/exited (exited frees the seat) through the company staff path.',
  requestSample: { status: 'suspended' },
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.setBeneficiaryStatus({
    access, beneficiaryId: req.params.beneficiaryId, status: req.body?.status, actorId: req.user.sub,
  })),
};

export const deactivateB2BBeneficiary = {
  created, method: 'delete', path: '/b2b/organizations/:id/beneficiaries/:beneficiaryId',
  description: 'Deactivate a beneficiary (beneficiaries.manage). The relationship is kept with status inactive.',
  onGuard: routeGuard('delete', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.deactivateBeneficiary({
    access, beneficiaryId: req.params.beneficiaryId, actorId: req.user.sub,
  })),
};

export const linkB2BBeneficiaryAccount = {
  created, method: 'post', path: '/b2b/organizations/:id/beneficiaries/:beneficiaryId/link',
  description: 'B5a (404 unless ORG_ONLY_SPONSORS is on): link a company\'s employee to their FitFlex member account, or unlink (no contact, or userId null; an open link request is withdrawn too). Org roles hr and admin only (others 403 forbidden { requiredRoles }); 409 link_not_supported for anyone who is not company staff. By userId, email or mobile number (one of them) an organisation user only ASKS the member: 202 { outcome: "pending_member_acceptance", memberRequest, beneficiary, writtenThrough } and the record is linked when they accept (an unknown id gets the same 202, memberRequest.id null; by email/phone memberRequest.userId is always null and the request is stored whether or not a member is behind the contact). A FitFlex platform admin links directly: 200 { beneficiary, writtenThrough }, and the member is told. Unlink: 200.',
  requestSample: { email: 'asha@nmbtz.com' },
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bService.linkBeneficiaryAccount({
    access, beneficiaryId: req.params.beneficiaryId, body: req.body || {}, actorId: req.user.sub,
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
  onGuard: routeGuard('get', requireAdmin),
  onRequest: async (req, res) => send(res, await programs.adminListPrograms({ query: req.query || {} })),
};

export const myB2BBenefits = {
  created, method: 'get', path: '/b2b/me/benefits',
  description: 'The caller\'s B2B wellness benefits today, across every organisation that sponsors them (read-only; remaining allowance comes with usage tracking). memberRequests: organisations waiting for the caller to accept being added (same items as GET /b2b/me/member-requests).',
  onGuard: routeGuard('get', requireAuth()),
  onRequest: async (req, res) => {
    // Someone invited before they joined is enrolled now, rather than at the next run of the matching job.
    await b2bBeneficiaryImportService.matchInvites({ userId: req.user.sub }).catch(() => null);
    const benefits = await programs.myBenefits({ userId: req.user.sub });
    const requests = await b2bMemberRequestService.listForMember({ userId: req.user.sub }).catch(() => ({ items: [] }));
    return send(res, { ...benefits, memberRequests: requests.items });
  },
};

// ── Member requests: an organisation asked to add the caller by user id ────

export const myB2BMemberRequests = {
  created, method: 'get', path: '/b2b/me/member-requests',
  description: 'Organisations waiting for the caller to accept being added (named by user id): as a beneficiary, a company staff link, or an organisation user. Each item: who is asking, what they will see (A-02, English and Swahili), and the benefits the caller would get. Requests expire after B2B_MEMBER_REQUEST_TTL_DAYS days (default 14).',
  onGuard: routeGuard('get', requireAuth()),
  onRequest: async (req, res) => send(res, await b2bMemberRequestService.listForMember({ userId: req.user.sub })),
};

export const acceptMyB2BMemberRequest = {
  created, method: 'post', path: '/b2b/me/member-requests/:requestId/accept',
  description: 'Accept an organisation\'s request: the add happens now (enrolled, staff record linked, or organisation role given). Single use: 409 member_request_not_pending once answered, 410 member_request_expired after expiry, 404 for a request that is not the caller\'s.',
  onGuard: routeGuard('post', requireAuth()),
  onRequest: async (req, res) => send(res, await b2bMemberRequestService.accept({ userId: req.user.sub, requestId: req.params.requestId })),
};

export const declineMyB2BMemberRequest = {
  created, method: 'post', path: '/b2b/me/member-requests/:requestId/decline',
  description: 'Decline an organisation\'s request. Nothing is added; the organisation sees the request as declined.',
  onGuard: routeGuard('post', requireAuth()),
  onRequest: async (req, res) => send(res, await b2bMemberRequestService.decline({ userId: req.user.sub, requestId: req.params.requestId })),
};

export const cancelB2BMemberRequest = {
  created, method: 'delete', path: '/b2b/organizations/:id/member-requests/:requestId',
  description: 'Withdraw a request to add someone (by user id or by email/phone) that shows as waiting (beneficiaries.manage for a beneficiary, users.manage for an organisation user). 200 { memberRequest } with status cancelled; 409 member_request_not_pending once it has been answered or has expired. A request by contact only ever shows the organisation waiting / expired / cancelled / accepted: whatever the member did otherwise, it answers as for a contact nobody was behind (a second DELETE: 409 { requestStatus: "cancelled" }; after expiry: "expired"). Requests made from invites are withdrawn by cancelling the invite.',
  onGuard: routeGuard('delete', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bMemberRequestService.cancel({
    access, requestId: req.params.requestId, actorId: req.user.sub,
  })),
};

export const listB2BPrograms = {
  created, method: 'get', path: '/b2b/organizations/:id/programs',
  description: 'Programmes of an organisation (programs.read). Query: ?status=&limit=&cursor=.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => programs.listPrograms({ access, query: req.query || {} })),
};

export const createB2BProgram = {
  created, method: 'post', path: '/b2b/organizations/:id/programs',
  description: 'Create a draft programme (programs.manage). Eligibility: { scope: all | groups | selected, groups, beneficiaryIds, beneficiaryTypes, enrolledOnOrBefore }.',
  requestSample: {
    name: 'ABC Employee Wellness 2027', programType: 'employee_wellness', startDate: '2027-01-01', endDate: '2027-12-31',
    eligibility: { scope: 'groups', groups: ['Finance', 'Operations'] }, budgetTzs: 50000000,
  },
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => programs.createProgram({ access, body: req.body || {}, actorId: req.user.sub }), 201),
};

export const getB2BProgram = {
  created, method: 'get', path: '/b2b/organizations/:id/programs/:programId',
  description: 'A programme with its benefits (programs.read).',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => programs.getProgram({ access, programId: req.params.programId })),
};

export const updateB2BProgram = {
  created, method: 'put', path: '/b2b/organizations/:id/programs/:programId',
  description: 'Edit a programme (programs.manage). Draft and pending: any field. Active or paused: name, description, a later end date or a larger budget.',
  onGuard: routeGuard('put', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => programs.updateProgram({
    access, programId: req.params.programId, body: req.body || {}, actorId: req.user.sub,
  })),
};

export const setB2BProgramStatus = {
  created, method: 'post', path: '/b2b/organizations/:id/programs/:programId/status',
  description: 'Programme lifecycle (programs.manage): pending (submit), draft (withdraw), active (FitFlex activates a pending programme; the organisation may resume a paused one), paused, cancelled.',
  requestSample: { status: 'pending' },
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => programs.setProgramStatus({
    access, programId: req.params.programId, status: req.body?.status, reason: req.body?.reason, actorId: req.user.sub,
  })),
};

export const listB2BProgramEligibility = {
  created, method: 'get', path: '/b2b/organizations/:id/programs/:programId/eligibility',
  description: 'Beneficiaries the programme (or ?benefitId=) reaches (programs.read + beneficiaries.read). ?include=all also lists the rest with the reason.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => programs.listEligibleBeneficiaries({
    access, programId: req.params.programId, query: req.query || {},
  })),
};

export const listB2BBenefits = {
  created, method: 'get', path: '/b2b/organizations/:id/programs/:programId/benefits',
  description: 'Benefits of a programme (programs.read).',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => programs.listBenefits({ access, programId: req.params.programId })),
};

export const createB2BBenefit = {
  created, method: 'post', path: '/b2b/organizations/:id/programs/:programId/benefits',
  description: 'Add a draft benefit (programs.manage).',
  requestSample: {
    name: '8 gym visits a month', benefitType: 'gym_access', fundingType: 'sponsor_percentage', sponsorShareBps: 6000,
    usageLimit: 8, usagePeriod: 'month', providerRules: { scope: 'selected', gymTiers: ['standard', 'midtier'] },
  },
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => programs.createBenefit({
    access, programId: req.params.programId, body: req.body || {}, actorId: req.user.sub,
  }), 201),
};

export const getB2BBenefit = {
  created, method: 'get', path: '/b2b/organizations/:id/programs/:programId/benefits/:benefitId',
  description: 'One benefit with today\'s usage window (programs.read).',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => programs.getBenefit({
    access, programId: req.params.programId, benefitId: req.params.benefitId,
  })),
};

export const updateB2BBenefit = {
  created, method: 'put', path: '/b2b/organizations/:id/programs/:programId/benefits/:benefitId',
  description: 'Edit a benefit (programs.manage). While it is active in a live programme only name, description and terms change.',
  onGuard: routeGuard('put', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => programs.updateBenefit({
    access, programId: req.params.programId, benefitId: req.params.benefitId, body: req.body || {}, actorId: req.user.sub,
  })),
};

export const setB2BBenefitStatus = {
  created, method: 'post', path: '/b2b/organizations/:id/programs/:programId/benefits/:benefitId/status',
  description: 'Activate or deactivate a benefit (programs.manage).',
  requestSample: { status: 'active' },
  onGuard: routeGuard('post', requireOrgAccess),
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
  onGuard: routeGuard('get', requireAdmin),
  onRequest: async (req, res) => send(res, await usage.adminList({ query: req.query || {} })),
};

export const adminGetB2BConsumption = {
  created, method: 'get', path: '/admin/b2b/consumptions/:consumptionId',
  description: 'Admin: one consumption with the rules in force, its source usage event (check-in or booking) and the settlement candidate.',
  onGuard: routeGuard('get', requireAdmin),
  onRequest: async (req, res) => send(res, await usage.adminGet({ consumptionId: req.params.consumptionId })),
};

export const adminReverseB2BConsumption = {
  created, method: 'post', path: '/admin/b2b/consumptions/:consumptionId/reverse',
  description: 'Admin: reverse an approved consumption. The row is kept and marked reversed with who, when and why; the allowance and budget get it back. Reversing a gym visit also voids its check-in (response: checkinVoided), so a gym already paid for it is clawed back on its next statement; portal staff need the payments scope for that as well.',
  requestSample: { reason: 'Checked in at the wrong gym' },
  onGuard: routeGuard('post', requireAdmin),
  onRequest: async (req, res) => send(res, await usage.reverse({
    consumptionId: req.params.consumptionId, reason: req.body?.reason, actorId: req.user.sub,
    mayVoidCheckin: !req.user.portalUser || (req.user.aclPermissions || []).includes('payments'),
  })),
};

export const adminEvaluateB2BUsage = {
  created, method: 'post', path: '/admin/b2b/evaluate-usage',
  description: 'Admin: dry run — which benefit would cover this member at this gym or trainer right now, and why the others would not. Writes nothing.',
  requestSample: { userId: 'usr_…', serviceType: 'gym_access', providerId: 'gym_…' },
  onGuard: routeGuard('post', requireAdmin),
  onRequest: async (req, res) => send(res, await usage.adminEvaluate({ body: req.body || {} })),
};

export const getB2BProgramUsage = {
  created, method: 'get', path: '/b2b/organizations/:id/programs/:programId/usage',
  description: 'Usage of a programme (usage.read): totals, budget, and breakdowns by benefit, provider and beneficiary. Aggregates only. Query: ?from=&to= (EAT days).',
  onGuard: routeGuard('get', requireOrgAccess),
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
  onGuard: routeGuard('post', requireBilling),
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
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await billing.adminListInvoices({ query: req.query || {} })),
};

export const adminGetB2BInvoice = {
  created, method: 'get', path: '/admin/b2b/invoices/:invoiceId',
  description: 'Admin: one sponsor invoice with every line.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await billing.getInvoice({ invoiceId: req.params.invoiceId })),
};

export const adminIssueB2BInvoice = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/issue',
  description: 'Admin (b2b_billing): issue a draft invoice. Its figures freeze, it gets its number (FF-INV-YYYY-NNNNNN) and its due date from the organisation\'s agreement, and the terms in force are kept on it. Amounts are VAT-inclusive; state the VAT rate in basis points (1800 = 18%, 0 = none), or leave it out to use the agreement\'s rate. A credit or debit note is issued with POST /admin/b2b/notes/:noteId/issue.',
  requestSample: { vatRateBps: 1800 },
  onGuard: routeGuard('post', requireBilling),
  onRequest: async (req, res) => send(res, await billing.issueInvoice({ invoiceId: req.params.invoiceId, vatRateBps: req.body?.vatRateBps, actorId: req.user.sub })),
};

export const adminMarkB2BInvoicePaid = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/paid',
  description: 'Admin (b2b_payments): settle an invoice in full against one payment reference. A shortcut for recording a payment for what is owed and allocating it; use POST /admin/b2b/organizations/:id/payments for part payments or one payment covering several invoices. The person who issued the invoice cannot do this. Paying a prepaid invoice starts fully sponsored passes and lets members unlock the rest.',
  requestSample: { paymentReference: 'BANK-TRF-00123' },
  onGuard: routeGuard('post', requirePayments),
  onRequest: async (req, res) => send(res, await billing.markPaid({ invoiceId: req.params.invoiceId, paymentReference: req.body?.paymentReference, actorId: req.user.sub })),
};

export const adminVoidB2BInvoice = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/void',
  description: 'Admin: void a draft or issued invoice, with a reason. It is kept; what was on it can be invoiced again.',
  requestSample: { reason: 'Raised for the wrong month' },
  onGuard: routeGuard('post', requireBilling),
  onRequest: async (req, res) => send(res, await billing.voidInvoice({ invoiceId: req.params.invoiceId, reason: req.body?.reason, actorId: req.user.sub })),
};

export const adminListB2BEntitlements = {
  created, method: 'get', path: '/admin/b2b/programs/:programId/entitlements',
  description: 'Admin: who is covered by a sponsored pass for a month (?period=YYYY-MM, default this month) and where each pass stands.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await billing.listEntitlements({ programId: req.params.programId, period: req.query?.period || undefined })),
};

export const adminConvertCorporateToProgram = {
  created, method: 'post', path: '/admin/b2b/corporate/:corporateId/convert',
  description: 'Admin: express a company\'s seat arrangement as a draft programme with one sponsored pass (its pass tier and subsidy split). Once that programme is live, seat bills for the company are refused.',
  onGuard: routeGuard('post', requireAdmin),
  onRequest: async (req, res) => send(res, await billing.convertCorporate({ corporateId: req.params.corporateId, actorId: req.user.sub }), 201),
};

export const listB2BOrganizationInvoices = {
  created, method: 'get', path: '/b2b/organizations/:id/invoices',
  description: 'An organisation\'s issued, paid and voided invoices and notes (billing.read: owner, admin, finance), each with what is still owed. Query: ?programId=&period=&kind=&status=.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => billing.listInvoices({ access, query: req.query || {} })),
};

export const getB2BOrganizationInvoice = {
  created, method: 'get', path: '/b2b/organizations/:id/invoices/:invoiceId',
  description: 'One of the organisation\'s invoices (billing.read): pass lines per person, usage as totals per benefit and person, fees and notes as they are, with the payments and credits applied to it.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => billing.getInvoice({ access, invoiceId: req.params.invoiceId })),
};

export const unlockMyB2BPass = {
  created, method: 'post', path: '/b2b/me/passes/:entitlementId/unlock',
  description: 'Member: ask to pay your share of a sponsored pass for this month. Returns a payment request; the pass starts when the payment is approved.',
  onGuard: routeGuard('post', requireAuth('member')),
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
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await finance.dashboard({ query: req.query || {} })),
};

export const adminListB2BAgreements = {
  created, method: 'get', path: '/admin/b2b/organizations/:id/agreements',
  description: 'Admin: an organisation\'s commercial agreements, newest first, and the one in force today.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await finance.listAgreements({ organizationId: req.params.id })),
};

export const adminCreateB2BAgreement = {
  created, method: 'post', path: '/admin/b2b/organizations/:id/agreements',
  description: 'Admin (b2b_billing): draft a commercial agreement: how FitFlex charges this organisation. Payment terms in days for invoices raised in advance (default 0) and after the month (default 14), an optional monthly platform fee (VAT-inclusive TZS) and an optional default VAT rate. Monthly billing in TZS.',
  requestSample: { effectiveFrom: '2026-11-01', prepaidTermsDays: 0, usageTermsDays: 14, platformFeeTzs: 500000, vatRateBps: 1800, contractReference: 'CRDB/FF/2026/01' },
  onGuard: routeGuard('post', requireBilling),
  onRequest: async (req, res) => send(res, await finance.createAgreement({ organizationId: req.params.id, body: req.body || {}, actorId: actor(req) }), 201),
};

export const adminUpdateB2BAgreement = {
  created, method: 'patch', path: '/admin/b2b/agreements/:agreementId',
  description: 'Admin (b2b_billing): change a draft agreement. One in force cannot be edited: end it and activate a new one.',
  onGuard: routeGuard('patch', requireBilling),
  onRequest: async (req, res) => send(res, await finance.updateAgreement({ agreementId: req.params.agreementId, body: req.body || {}, actorId: actor(req) })),
};

export const adminActivateB2BAgreement = {
  created, method: 'post', path: '/admin/b2b/agreements/:agreementId/activate',
  description: 'Admin (b2b_billing): put a draft agreement in force from its start date. Body { version }: the draft\'s updatedAt as checked (400 version_required; 409 agreement_changed when it has changed since). Refused to the admin who drafted or changed it (403 cannot_activate_own_agreement). The agreement it replaces is closed the day before. Invoices already issued keep the terms they were issued under.',
  requestSample: { version: '2026-10-19T09:30:00.000Z' },
  onGuard: routeGuard('post', requireBilling),
  onRequest: async (req, res) => send(res, await finance.activateAgreement({ agreementId: req.params.agreementId, version: req.body?.version, actorId: actor(req) })),
};

export const adminEndB2BAgreement = {
  created, method: 'post', path: '/admin/b2b/agreements/:agreementId/end',
  description: 'Admin (b2b_billing): end an agreement in force on a day (default today).',
  requestSample: { effectiveTo: '2026-12-31' },
  onGuard: routeGuard('post', requireBilling),
  onRequest: async (req, res) => send(res, await finance.endAgreement({ agreementId: req.params.agreementId, effectiveTo: req.body?.effectiveTo, actorId: actor(req) })),
};

export const adminGetB2BBillingAccount = {
  created, method: 'get', path: '/admin/b2b/organizations/:id/billing-account',
  description: 'Admin: who the organisation\'s invoices go to. Falls back to the Corporate billing contact, then the organisation\'s own contact.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await finance.getBillingAccount({ organizationId: req.params.id })),
};

export const adminSetB2BBillingAccount = {
  created, method: 'put', path: '/admin/b2b/organizations/:id/billing-account',
  description: 'Admin (b2b_billing): set the billing contact, email, phone and address.',
  requestSample: { contactName: 'Asha Mushi', email: 'accounts@example.co.tz', phone: '+255700000000' },
  onGuard: routeGuard('put', requireBilling),
  onRequest: async (req, res) => send(res, await finance.setBillingAccount({ organizationId: req.params.id, body: req.body || {}, actorId: actor(req) })),
};

export const adminPrepareB2BFeeInvoice = {
  created, method: 'post', path: '/admin/b2b/organizations/:id/invoices/prepare-fee',
  description: 'Admin (b2b_billing): draft the month\'s platform-fee invoice, when the agreement in force on the first of the month carries a fee. One per organisation and month; safe to repeat.',
  requestSample: { period: '2026-11' },
  onGuard: routeGuard('post', requireBilling),
  onRequest: async (req, res) => send(res, await finance.prepareFee({ organizationId: req.params.id, period: req.body?.period, actorId: actor(req) })),
};

export const adminB2BOrganizationStatement = {
  created, method: 'get', path: '/admin/b2b/organizations/:id/statement',
  description: 'Admin: the organisation\'s account: invoices, notes, payments, reversals and (read only) Corporate seat bills in date order with a running balance, plus what is outstanding, overdue, on account as credit, and aging. Query: ?from=&to= (EAT days).',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await finance.statement({ organizationId: req.params.id, query: req.query || {} })),
};

export const adminListB2BPayments = {
  created, method: 'get', path: '/admin/b2b/payments',
  description: 'Admin: payments received from organisations. Query: ?organizationId=&status=&limit=&cursor=.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await finance.listPayments({ organizationId: req.query?.organizationId || null, query: req.query || {} })),
};

export const adminGetB2BPayment = {
  created, method: 'get', path: '/admin/b2b/payments/:paymentId',
  description: 'Admin: one payment with the invoices it settled.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await finance.getPayment({ paymentId: req.params.paymentId })),
};

export const adminRecordB2BPayment = {
  created, method: 'post', path: '/admin/b2b/organizations/:id/payments',
  description: 'Admin (b2b_payments): record money received. method: bank_transfer | mobile_money | lipa_namba | cheque | cash | card | other. The same reference by the same method is one payment: recording it again returns the first (409 if the amount differs). `allocations` settles named invoices; `autoAllocate: true` settles the oldest due first; anything left stays on the account as credit. The person who issued an invoice cannot record its payment.',
  requestSample: { amountTzs: 1200000, method: 'bank_transfer', reference: 'CRDB-TRF-00917', receivedAt: '2026-11-03T09:00:00Z', allocations: [{ invoiceId: 'b2bi_…', amountTzs: 1000000 }, { invoiceId: 'b2bi_…', amountTzs: 200000 }] },
  onGuard: routeGuard('post', requirePayments),
  onRequest: async (req, res) => {
    const out = await finance.recordPayment({ organizationId: req.params.id, body: req.body || {}, actorId: actor(req) });
    return send(res, out, out.existing ? 200 : 201);
  },
};

export const adminAllocateB2BPayment = {
  created, method: 'post', path: '/admin/b2b/payments/:paymentId/allocate',
  description: 'Admin (b2b_payments): settle invoices from a payment already recorded. Each amount is checked against what is left on the payment and on the invoice, so sending it twice allocates once; an optional requestId makes that explicit.',
  requestSample: { allocations: [{ invoiceId: 'b2bi_…', amountTzs: 200000 }], requestId: 'alloc-2026-11-03-1' },
  onGuard: routeGuard('post', requirePayments),
  onRequest: async (req, res) => send(res, await finance.allocate({ paymentId: req.params.paymentId, body: req.body || {}, actorId: actor(req) })),
};

export const adminReverseB2BPayment = {
  created, method: 'post', path: '/admin/b2b/payments/:paymentId/reverse',
  description: 'Admin (b2b_billing_approve): reverse a payment that did not arrive, with a reason. The invoices it part-settled are opened again. A payment that completed an invoice is not reversed (a paid invoice is final): raise a debit note instead.',
  requestSample: { reason: 'Cheque returned unpaid' },
  onGuard: routeGuard('post', requireBillingApproval),
  onRequest: async (req, res) => send(res, await finance.reversePayment({ paymentId: req.params.paymentId, reason: req.body?.reason, actorId: actor(req) })),
};

export const adminCreateB2BNote = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/notes',
  description: 'Admin (b2b_billing): draft a credit note (takes an amount off an issued invoice) or a debit note (adds to it), with a reason. The invoice itself is never edited. A credit cannot exceed the invoice less the credits already raised on it.',
  requestSample: { type: 'credit', amountTzs: 60000, reason: 'One employee left before the month began' },
  onGuard: routeGuard('post', requireBilling),
  onRequest: async (req, res) => send(res, await finance.createNote({ invoiceId: req.params.invoiceId, body: req.body || {}, actorId: actor(req) }), 201),
};

export const adminIssueB2BNote = {
  created, method: 'post', path: '/admin/b2b/notes/:noteId/issue',
  description: 'Admin (b2b_billing_approve): issue a credit or debit note. It must be someone other than the person who drafted it. A credit note is applied at once to the invoice it corrects, up to what is owed on it; the rest stays on the account as credit.',
  onGuard: routeGuard('post', requireBillingApproval),
  onRequest: async (req, res) => send(res, await finance.issueNote({ noteId: req.params.noteId, body: req.body || {}, actorId: actor(req) })),
};

export const adminApplyB2BCredit = {
  created, method: 'post', path: '/admin/b2b/notes/:noteId/apply',
  description: 'Admin (b2b_payments): apply what is left of an issued credit note (or a credit for reversed usage) to other open invoices of the same organisation.',
  requestSample: { allocations: [{ invoiceId: 'b2bi_…', amountTzs: 60000 }] },
  onGuard: routeGuard('post', requirePayments),
  onRequest: async (req, res) => send(res, await finance.allocate({ creditInvoiceId: req.params.noteId, body: req.body || {}, actorId: actor(req) })),
};

export const adminB2BInvoiceReconciliation = {
  created, method: 'get', path: '/admin/b2b/invoices/:invoiceId/reconciliation',
  description: 'Admin: trace an invoice to what it charges for. Each usage line to its consumption and the check-in or session behind it; each pass line to the person\'s entitlement and pass; the payments applied; and, separately, where the provider side of the same activity stands in settlement. Includes checks that the lines add up and that each usage line equals the sponsor share on the ledger.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await finance.reconciliation({ invoiceId: req.params.invoiceId })),
};

export const getB2BOrganizationBilling = {
  created, method: 'get', path: '/b2b/organizations/:id/billing',
  description: 'An organisation\'s billing overview (billing.read: owner, admin, finance): what is outstanding, overdue and on account as credit, aging, the billing contact, the payment terms in force and the latest invoices.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => finance.organizationOverview({ access })),
};

export const listB2BOrganizationPayments = {
  created, method: 'get', path: '/b2b/organizations/:id/payments',
  description: 'The payments FitFlex has recorded from the organisation (billing.read), newest first.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => finance.organizationPayments({ access, query: req.query || {} })),
};

export const getB2BOrganizationStatement = {
  created, method: 'get', path: '/b2b/organizations/:id/statement',
  description: 'The organisation\'s account statement (billing.read): invoices, notes, payments and seat bills in date order with a running balance. Query: ?from=&to= (EAT days).',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => finance.organizationStatement({ access, query: req.query || {} })),
};

// ── Collections (Phase 6): paying an invoice and chasing a late one ──────────

const collections = b2bCollectionsService;

export const adminB2BPaymentInstructions = {
  created, method: 'get', path: '/admin/b2b/payment-instructions',
  description: 'Admin (any billing scope): where organisations pay FitFlex — bank account and Lipa Namba — as shown on their invoices.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (_req, res) => send(res, await collections.getInstructions()),
};

export const adminSetB2BPaymentInstructions = {
  created, method: 'put', path: '/admin/b2b/payment-instructions',
  description: 'Admin (b2b_billing_approve): ask to change where organisations pay FitFlex. Nothing changes until a different admin confirms it (POST /admin/b2b/payment-instructions/confirm). Every field is optional; send them all, a missing one is cleared. A new request replaces one still waiting. Answers 202 with { instructions (in force), configured, pendingChange }.',
  requestSample: { bankName: 'CRDB Bank', accountName: 'FitFlex Africa Ltd', accountNumber: '0150000000000', branch: 'Mlimani City', swiftCode: 'CORUTZTZ', lipaNamba: '5550000', lipaNambaName: 'FITFLEX AFRICA', notes: 'Quote the invoice number as the reference.' },
  onGuard: routeGuard('put', requireBillingApproval),
  onRequest: async (req, res) => send(res, await collections.requestInstructionsChange({ body: req.body || {}, actorId: actor(req) }), 202),
};

export const adminConfirmB2BPaymentInstructions = {
  created, method: 'post', path: '/admin/b2b/payment-instructions/confirm',
  description: 'Admin (b2b_billing_approve): put the requested payment details in force. Body { changeId }: the pendingChange.changeId checked (400 change_id_required; 409 change_superseded when another request replaced it). Refused to the admin who asked (403 cannot_confirm_own_request); 409 no_pending_change when nothing waits.',
  requestSample: { changeId: 'pic_0123456789ab' },
  onGuard: routeGuard('post', requireBillingApproval),
  onRequest: async (req, res) => send(res, await collections.confirmInstructionsChange({ changeId: req.body?.changeId, actorId: actor(req) })),
};

export const adminCancelB2BPaymentInstructions = {
  created, method: 'post', path: '/admin/b2b/payment-instructions/cancel',
  description: 'Admin (b2b_billing_approve): withdraw or decline the requested payment details. The details in force stay. Body { changeId, reason? } (400 change_id_required; 409 change_superseded).',
  requestSample: { changeId: 'pic_0123456789ab', reason: 'Wrong account number' },
  onGuard: routeGuard('post', requireBillingApproval),
  onRequest: async (req, res) => send(res, await collections.cancelInstructionsChange({ changeId: req.body?.changeId, actorId: actor(req), reason: req.body?.reason })),
};

export const adminB2BCollections = {
  created, method: 'get', path: '/admin/b2b/collections',
  description: 'Admin (any billing scope): the collections queue — payment notices waiting to be checked, invoices past due with the last reminder sent, and organisations on hold.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (_req, res) => send(res, await collections.queue()),
};

export const adminListB2BPaymentNotices = {
  created, method: 'get', path: '/admin/b2b/payment-notices',
  description: 'Admin (any billing scope): payment notices from organisations, newest first. Query: ?status=submitted|confirmed|rejected|withdrawn.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await collections.listNotices({ query: req.query || {} })),
};

export const adminConfirmB2BPaymentNotice = {
  created, method: 'post', path: '/admin/b2b/payment-notices/:noticeId/confirm',
  description: 'Admin (b2b_payments): the money is on the statement — record the payment. `amountTzs` overrides the amount the organisation gave. The invoices the notice names are settled first (oldest due first), otherwise the oldest open ones; the rest stays on the account as credit. Invoices you issued yourself are left for a colleague. Confirming twice records one payment.',
  requestSample: { amountTzs: 1200000, note: 'Seen on CRDB statement 4 Nov' },
  onGuard: routeGuard('post', requirePayments),
  onRequest: async (req, res) => send(res, await collections.confirmNotice({ noticeId: req.params.noticeId, body: req.body || {}, actorId: actor(req) })),
};

export const adminRejectB2BPaymentNotice = {
  created, method: 'post', path: '/admin/b2b/payment-notices/:noticeId/reject',
  description: 'Admin (b2b_payments): the money cannot be found or the notice is wrong. The reason is shown to the organisation.',
  requestSample: { reason: 'No transfer with this reference on our statement up to 5 Nov.' },
  onGuard: routeGuard('post', requirePayments),
  onRequest: async (req, res) => send(res, await collections.rejectNotice({ noticeId: req.params.noticeId, reason: req.body?.reason, actorId: actor(req) })),
};

export const adminRemindB2BInvoice = {
  created, method: 'post', path: '/admin/b2b/invoices/:invoiceId/remind',
  description: 'Admin (b2b_billing): send a payment reminder for an issued invoice now, to the organisation\'s owners and finance users and its billing email. The scheduled reminders (3 days before due, on the day, +7, +14, +30) are unaffected.',
  onGuard: routeGuard('post', requireBilling),
  onRequest: async (req, res) => send(res, await collections.remindNow({ invoiceId: req.params.invoiceId, actorId: actor(req) })),
};

export const adminSetB2BBillingHold = {
  created, method: 'post', path: '/admin/b2b/organizations/:id/billing-hold',
  description: 'Admin (b2b_billing_approve): put an organisation on hold for late payment, or lift it. On hold, no new sponsored-pass invoice is prepared and per-use benefits are not funded; passes already paid for carry on. Never automatic.',
  requestSample: { onHold: true, reason: 'FF-INV-2026-000041 is 45 days overdue.' },
  onGuard: routeGuard('post', requireBillingApproval),
  onRequest: async (req, res) => send(res, await collections.setHold({ organizationId: req.params.id, body: req.body || {}, actorId: actor(req) })),
};

export const getB2BOrganizationPaying = {
  created, method: 'get', path: '/b2b/organizations/:id/paying',
  description: 'How the organisation pays (billing.read): FitFlex\'s payment details, whether the account is on hold, whether you may send a payment notice, and the notices sent so far.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => collections.organizationPaying({ access })),
};

export const submitB2BPaymentNotice = {
  created, method: 'post', path: '/b2b/organizations/:id/payment-notices',
  description: 'Tell FitFlex a payment has been made (billing.pay: owner, admin, finance). Nothing is settled until FitFlex confirms it. The same reference by the same method is one notice: sending it again returns the first (409 if the amount differs).',
  requestSample: { amountTzs: 1200000, method: 'bank_transfer', reference: 'CRDB-TRF-00917', paidOn: '2026-11-03', invoiceIds: ['b2bi_…'], note: 'October passes', proofUrl: 'https://…' },
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: async (req, res) => {
    const access = await b2bService.resolveAccess({ organizationId: req.params.id, userId: req.user.sub, userType: req.user.userType });
    if (access.error) return send(res, access);
    const out = await collections.submitNotice({ access, body: req.body || {}, actorId: actor(req) });
    return send(res, out, out.existing ? 200 : 201);
  },
};

export const withdrawB2BPaymentNotice = {
  created, method: 'post', path: '/b2b/organizations/:id/payment-notices/:noticeId/withdraw',
  description: 'Take back a payment notice FitFlex has not decided yet (billing.pay).',
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => collections.withdrawNotice({ access, noticeId: req.params.noticeId, actorId: actor(req) })),
};

// ── Analytics and reporting (Phase 6 analytics) ─────────────────────────────
//
// A read layer over the ledgers. Periods: ?period=today|yesterday|last_7_days|
// last_30_days|this_month|last_month|this_quarter|last_quarter|year_to_date|
// last_year, or ?from=&to= (East Africa Time days). FitFlex staff use the same
// organisation routes; the cross-organisation ones are theirs alone.

const analytics = b2bAnalyticsService;
const PERIOD_HELP = 'Period: ?period= (default this_month) or ?from=&to= as EAT days.';

export const getB2BOrganizationDashboard = {
  created, method: 'get', path: '/b2b/organizations/:id/analytics/dashboard',
  description: `An organisation's wellness programme at a glance (analytics.read): people, how many used a sponsored benefit, usage, spend, benefits, top providers, engagement and a trend, beside the comparable period before. Billing figures are included for roles with billing.read. ${PERIOD_HELP} Filters: programId, benefitId, providerId, group.`,
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => analytics.dashboard({ access, query: req.query || {} })),
};

export const listB2BOrganizationPeopleAnalytics = {
  created, method: 'get', path: '/b2b/organizations/:id/analytics/people',
  description: `Each person on the organisation's list with what they used and did in the period (analytics.people: owner, admin, manager, hr). ${PERIOD_HELP} ?search=&group=&status=&activity=active|inactive&sort=name|uses|spend|last_active&limit=&cursor=.`,
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => analytics.people({ access, query: req.query || {} })),
};

export const getB2BOrganizationPersonAnalytics = {
  created, method: 'get', path: '/b2b/organizations/:id/analytics/people/:beneficiaryId',
  description: `One person in the period (analytics.people): sponsored visits and sessions with date and provider, pass check-ins, other gym visits, activities logged and progress in the organisation's own challenges. Never included: weight, height, calories, notes, routes, or anything another organisation funds or runs. ${PERIOD_HELP}`,
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => analytics.person({ access, beneficiaryId: req.params.beneficiaryId, query: req.query || {} })),
};

export const getB2BOrganizationProgramAnalytics = {
  created, method: 'get', path: '/b2b/organizations/:id/analytics/programs',
  description: `Every programme side by side (analytics.read): eligible people, participation, usage, sponsor and member spend, budget used. ${PERIOD_HELP}`,
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => analytics.programAnalytics({ access, query: req.query || {} })),
};

export const getB2BOrganizationBenefitAnalytics = {
  created, method: 'get', path: '/b2b/organizations/:id/analytics/benefits',
  description: `Every benefit (analytics.read): eligible, used it, reach, uses, value and each side's share; for a benefit with a limit, the allowance used in the window in force today. ${PERIOD_HELP} ?programId=.`,
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => analytics.benefitAnalytics({ access, query: req.query || {} })),
};

export const getB2BOrganizationProviderAnalytics = {
  created, method: 'get', path: '/b2b/organizations/:id/analytics/providers',
  description: `Where the organisation's people went (analytics.read): each gym and trainer with visits, people, repeat users and service value. FitFlex staff also see how far settlement of those visits has got. ${PERIOD_HELP} Filters: programId, benefitId.`,
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => analytics.providerAnalytics({ access, query: req.query || {} })),
};

export const getB2BOrganizationFinanceAnalytics = {
  created, method: 'get', path: '/b2b/organizations/:id/analytics/finance',
  description: `Billing over time (billing.read): invoiced and collected by month, what is owed now with aging, and sponsor usage beside it. ${PERIOD_HELP}`,
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => analytics.financeAnalytics({ access, query: req.query || {} })),
};

export const exportB2BOrganizationReport = {
  created, method: 'get', path: '/b2b/organizations/:id/analytics/export/:report',
  description: `A report as CSV: beneficiaries, usage, activity (analytics.people); benefits, programs, providers (analytics.read); invoices, payments (billing.read). Returns { filename, rows, csv }. Every export is audited. ${PERIOD_HELP}`,
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => analytics.exportCsv({ access, report: req.params.report, query: req.query || {}, actorId: actor(req) })),
};

export const adminB2BAnalyticsOverview = {
  created, method: 'get', path: '/admin/b2b/analytics',
  description: `Admin (b2b): the whole B2B book for a period — organisations, people, usage, invoiced and collected, top organisations and providers, and a trend. ${PERIOD_HELP}`,
  onGuard: routeGuard('get', requireAdmin),
  onRequest: async (req, res) => send(res, await analytics.overview({ query: req.query || {} })),
};

export const adminB2BDataQuality = {
  created, method: 'get', path: '/admin/b2b/analytics/data-quality',
  description: 'Admin (b2b or any billing scope): records that should not exist or are missing their other half — usage without a visit, shares that do not add up, usage on no invoice, invoices and payments that do not add up. Reports a count and examples; repairs nothing.',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (_req, res) => send(res, await analytics.dataQuality()),
};

// ── Operations (Phase 7): jobs, exceptions and work waiting on a person ─────

const ops = opsService;
/** An exception raised by a finance job, or about money, is closed by someone who may approve billing. */
const FINANCE_JOBS = new Set(['b2b-sponsor-billing', 'b2b-collections', 'b2b-integrity-check']);
/**
 * A job run's own `status` (ok / failed) and `error` text are the answer, not
 * an HTTP outcome: a run that failed is still a request that worked.
 */
const runView = r => (r && typeof r.status === 'string' ? { ...r, status: undefined, error: undefined, outcome: r.status, failure: r.error ?? null } : r);
function sendRun(res, result) {
  if (result?.error && Number.isInteger(result.status)) return send(res, result);
  return res.status(200).json(runView(result));
}

export const adminB2BOpsOverview = {
  created, method: 'get', path: '/admin/b2b/ops',
  description: 'Admin (b2b or any billing scope): the operations page in one call — every recurring B2B job with its state (ok, running, delayed, retrying, failed, paused), last run and next due time; live exceptions by severity with the most urgent; and counts of work waiting on a person (draft invoices, payment notices, overdue invoices, stale holds, passes waiting, people not yet linked).',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (_req, res) => send(res, await b2bOps.overview()),
};

export const adminB2BJobRuns = {
  created, method: 'get', path: '/admin/b2b/ops/jobs/:job/runs',
  description: 'Admin (b2b or any billing scope): a job\'s recent runs, newest first: slot, trigger (schedule, catch_up, retry, manual), attempt, status, items processed / succeeded / failed, error. ?limit=',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await ops.jobRuns({ name: req.params.job, query: req.query || {} })),
};

export const adminRunB2BJob = {
  created, method: 'post', path: '/admin/b2b/ops/jobs/:job/run',
  description: 'Admin (b2b): run a job now. Jobs are safe to repeat: a run does only what is still missing. Takes the job\'s lock, so it never overlaps a scheduled run. Returns { outcome: ok | failed, failure, processed, succeeded, failed } or { skipped }. Audited.',
  onGuard: routeGuard('post', requireAdmin),
  onRequest: async (req, res) => sendRun(res, await ops.runJob(req.params.job, { trigger: 'manual', actorId: actor(req) })),
};

export const adminPauseB2BJob = {
  created, method: 'post', path: '/admin/b2b/ops/jobs/:job/pause',
  description: 'Admin (b2b): pause a job (reason required) or resume it. A paused job is skipped by the scheduler and the catch-up sweeper; it can still be run by hand. Audited.',
  requestSample: { paused: true, reason: 'Investigating duplicate reminders' },
  onGuard: routeGuard('post', requireAdmin),
  onRequest: async (req, res) => send(res, await ops.setPaused({ name: req.params.job, paused: req.body?.paused === true, reason: req.body?.reason, actorId: actor(req) })),
};

export const adminListB2BExceptions = {
  created, method: 'get', path: '/admin/b2b/ops/exceptions',
  description: 'Admin (b2b or any billing scope): operations exceptions, most severe and oldest first. ?status=live (default) | all | open | investigating | retrying | resolved | ignored | permanently_failed, ?severity=, ?type=job_failed|job_item_failed|data_quality, ?job=, ?organizationId=, ?limit=&cursor=',
  onGuard: routeGuard('get', requireBillingRead),
  onRequest: async (req, res) => send(res, await ops.listExceptions({ query: req.query || {} })),
};

async function mayClose(req, res, id) {
  const found = await ops.getException({ id });
  if (found.error) { send(res, found); return null; }
  const finance = FINANCE_JOBS.has(found.exception.job) || found.exception.type === 'data_quality';
  const scopes = req.user?.aclPermissions;
  // Super-admins hold every scope; portal staff are checked against theirs.
  if (finance && req.user?.portalUser && !(scopes || []).includes('b2b_billing_approve')) {
    res.status(403).json({ error: 'acl_forbidden', requiredScope: 'b2b_billing_approve' });
    return null;
  }
  return found.exception;
}

export const adminSetB2BExceptionStatus = {
  created, method: 'post', path: '/admin/b2b/ops/exceptions/:exceptionId/status',
  description: 'Admin (b2b; b2b_billing_approve for a finance exception): move an exception on — investigating, resolved (say what was done), ignored (say why), or back to open. Changes nothing about the records it is about. Audited.',
  requestSample: { status: 'resolved', resolution: 'Check-in restored by support; the check now passes.' },
  onGuard: routeGuard('post', requireAdmin),
  onRequest: async (req, res) => {
    if (!(await mayClose(req, res, req.params.exceptionId))) return undefined;
    return send(res, await ops.setExceptionStatus({ id: req.params.exceptionId, status: req.body?.status, resolution: req.body?.resolution, actorId: actor(req) }));
  },
};

export const adminRetryB2BException = {
  created, method: 'post', path: '/admin/b2b/ops/exceptions/:exceptionId/retry',
  description: 'Admin (b2b; b2b_billing_approve for a finance exception): try again by running the job the exception came from. At most five times per exception. The exception clears itself if the retry gets through. Audited.',
  onGuard: routeGuard('post', requireAdmin),
  onRequest: async (req, res) => {
    if (!(await mayClose(req, res, req.params.exceptionId))) return undefined;
    const out = await ops.retryException({ id: req.params.exceptionId, actorId: actor(req) });
    return out.error ? send(res, out) : res.status(200).json({ exception: out.exception, run: runView(out.run) });
  },
};

// ── Bulk import and invites (Phase 7, slice 2) ──────────────────────────────

const people = b2bBeneficiaryImportService;

export const importB2BBeneficiaries = {
  created, method: 'post', path: '/b2b/organizations/:id/beneficiaries/import',
  description: 'Add many people at once (beneficiaries.manage). Give `rows` [{ name, email, phone, group, reference, type }] or `rawText` (CSV; with a header line the columns can be in any order, without one: name, email, phone, group, reference, type). Each person needs an email or a mobile number. Nobody is enrolled by an import and accounts are not looked up (consent slice (a)): everyone new is invited (by email, and by SMS when listed with a mobile number), `enrolled` is always 0, and the reply is the same whoever has an account. When a member has verified an invited email or number (now, or later) the app asks them whether they accept; they are enrolled only if they do, and the invite then shows as enrolled (until then it stays invited, whatever they answer). An email or number only typed onto a profile matches nobody. Up to 2,000 rows. `dryRun: true` checks the list without changing anything. Uploading the same list again adds nobody twice. Returns counts and every row that could not be used, with the reason, plus `emailCodesAvailable` (false: people listed by email only cannot verify it in the app yet, so ask for a mobile number too). A mapped company: 409 managed_by_corporate, unless ORG_ONLY_SPONSORS is on — then each new person joins the company staff list unlinked and pending (a member behind a verified email or number is asked to accept the link; nobody is invited), all-or-nothing on free seats (409 seat_limit_reached), and the reply adds companyStaff: true, seatsAvailable and credentials [{ line, employeeId, displayName, pin }] for every row added (shown once, never stored).',
  requestSample: { rawText: 'name,email,phone,group\nAsha Mollel,asha@example.com,0712345678,Finance', dryRun: true },
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => people.importPeople({ access, body: req.body || {}, actorId: actor(req) })),
};

export const listB2BBeneficiaryImports = {
  created, method: 'get', path: '/b2b/organizations/:id/beneficiary-imports',
  description: 'The last 20 imports (beneficiaries.read): counts and the rows that could not be used.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => people.listImports({ access })),
};

export const listB2BBeneficiaryInvites = {
  created, method: 'get', path: '/b2b/organizations/:id/beneficiary-invites',
  description: 'People invited who have not joined yet (beneficiaries.read). ?status=invited (default) | enrolled | cancelled | all. Says whether invitation emails and SMS can be sent at all.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => people.listInvites({ access, query: req.query || {} })),
};

export const cancelB2BBeneficiaryInvite = {
  created, method: 'post', path: '/b2b/organizations/:id/beneficiary-invites/:inviteId/cancel',
  description: 'Cancel an invite (beneficiaries.manage): no more emails, and the person is not enrolled if they join.',
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => people.cancelInvite({ access, inviteId: req.params.inviteId, actorId: actor(req) })),
};

export const resendB2BBeneficiaryInvite = {
  created, method: 'post', path: '/b2b/organizations/:id/beneficiary-invites/:inviteId/resend',
  description: 'Send the invitation again now, by email and by SMS where the person can be reached that way (beneficiaries.manage). Not within an hour of the last one; at most six emails and three SMS per invite. Returns sent: { email, sms }.',
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => people.resendInvite({ access, inviteId: req.params.inviteId, actorId: actor(req) })),
};

// ── Programme lifecycle and renewal (Phase 7, slice 3) ──────────────────────

export const getB2BProgramLifecycle = {
  created, method: 'get', path: '/b2b/organizations/:id/program-lifecycle',
  description: 'For each of the organisation\'s programmes (programs.read): its status, days left, whether it is ending soon (within 30 days), whether a renewal can be prepared, and the renewal if there is one.',
  onGuard: routeGuard('get', requireOrgAccess),
  onRequest: (req, res) => inOrganization(req, res, access => b2bLifecycleService.programLifecycle({ access })),
};

export const prepareB2BProgramRenewal = {
  created, method: 'post', path: '/b2b/organizations/:id/programs/:programId/renewal',
  description: 'Prepare a programme\'s renewal (programs.manage): a DRAFT programme for the period that follows, with the same name, people, budget and benefits and the dates moved on. Nothing is charged and nobody is covered until it is submitted and FitFlex activates it, like any new programme. Asking again returns the same draft. A discount FitFlex gave is carried over only when FitFlex staff prepare the renewal. Returns { program, benefits, skipped, discountNotCarriedOver }.',
  onGuard: routeGuard('post', requireOrgAccess),
  onRequest: async (req, res) => {
    const access = await b2bService.resolveAccess({ organizationId: req.params.id, userId: req.user.sub, userType: req.user.userType });
    if (access.error) return send(res, access);
    const out = await b2bLifecycleService.prepareRenewal({ access, programId: req.params.programId, actorId: actor(req) });
    return send(res, out, out.existing ? 200 : 201);
  },
};
