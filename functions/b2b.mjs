// B2B Foundation V1 REST surface — organisations, their users and beneficiaries.
//
// FitFlex admins (portal staff need the 'b2b' scope) manage every organisation.
// Organisation routes are also open to that organisation's own users: access
// comes from their B2BOrganizationUser role (or, for a company mapped from
// Corporate, its HR logins), never from anything the caller sends. Corporate
// routes (/corporate/*, /admin/corporate/*) are unchanged.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { b2bService } from '../src/bootstrap/services.mjs';

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
