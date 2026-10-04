// Corporate wellness (B2B) REST surface — HR self-service plus admin oversight.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { corporateService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// HR routes are account-scoped: corporate_hr acts on its own account, while an
// admin acts on any account by passing ?corporateId=.
const requireHr = [requireAuth('corporate_hr', 'admin'), requireAcl('corporate')];

async function scoped(req, res, handler) {
  const actor = await corporateService.resolveActorAccount({
    userId: req.user.sub, userType: req.user.userType, corporateIdParam: req.query?.corporateId,
  });
  if (actor.error) return res.status(actor.status).json({ error: actor.error });

  const { error, status, ...payload } = await handler(actor.corporateId);
  // Services attach context alongside the error (seatLimit, errors, ...) — keep it.
  if (error) return res.status(status).json({ error, ...payload });
  return res.json(payload);
}

export const corporateReference = {
  created, method: 'get', path: '/corporate/reference',
  description: 'Public: industry sectors, workforce brackets, subsidy models, HR objectives and billing cycles.',
  onRequest: (_req, res) => res.json(corporateService.reference())
};

// ── Account lifecycle (admin) ──────────────────────────────────────────────

export const adminOnboardCorporate = {
  created, method: 'post', path: '/admin/corporate',
  description: 'Admin: onboard a corporate account (identity, objectives, subsidy model). Starts pending.',
  requestSample: {
    companyName: 'NMB Bank', industrySector: 'banking', workforceBracket: '1000+',
    subsidyModel: 'copay_70_30', passTier: 'pro', billingCycle: 'monthly',
    seatLimit: 500, domainWhitelist: ['nmbtz.com'], objectives: ['reduce_absenteeism'],
  },
  onGuard: [requireAuth('admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const result = await corporateService.onboard({ body: req.body || {}, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error, invalid: result.invalid });
    res.status(201).json(result.account);
  }
};

export const adminListHrUsers = {
  created, method: 'get', path: '/admin/corporate/:id/hr-users',
  description: 'Admin: HR logins for a corporate account.',
  onGuard: [requireAuth('admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const result = await corporateService.listHrUsers({ corporateId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const adminCreateHrUser = {
  created, method: 'post', path: '/admin/corporate/:id/hr-users',
  description: 'Admin: create an HR login for a corporate account (email + initial password, min 10 characters). HR signs in to the portal with POST /auth/login { email, password, requestedRole: "corporate_hr" }.',
  requestSample: { displayName: 'Neema HR', email: 'hr@company.co.tz', password: 'a-long-initial-password' },
  onGuard: [requireAuth('admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const result = await corporateService.createHrUser({ corporateId: req.params.id, body: req.body || {}, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error, ...(result.minLength ? { minLength: result.minLength } : {}) });
    res.status(201).json(result);
  }
};

export const adminSetHrUserStatus = {
  created, method: 'post', path: '/admin/corporate/:id/hr-users/:userId/status',
  description: 'Admin: suspend or re-activate an HR login.',
  requestSample: { status: 'suspended' },
  onGuard: [requireAuth('admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const result = await corporateService.setHrUserStatus({ corporateId: req.params.id, userId: req.params.userId, status: req.body?.status, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const adminListCorporate = {
  created, method: 'get', path: '/admin/corporate',
  description: 'Admin: list corporate accounts, newest first. Query: ?status=pending|active|suspended|terminated.',
  onGuard: [requireAuth('admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const result = await corporateService.adminList({ status: req.query?.status });
    res.json(result.accounts);
  }
};

export const adminUpdateCorporate = {
  created, method: 'put', path: '/admin/corporate/:id',
  description: 'Admin: update seat limit, subsidy model, pass tier, billing cycle, HR contact or domain whitelist.',
  onGuard: [requireAuth('admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const result = await corporateService.update({
      corporateId: req.params.id, body: req.body || {}, actorId: req.user.sub,
    });
    if (result.error) return res.status(result.status).json({ error: result.error, seatsUsed: result.seatsUsed });
    res.json(result.account);
  }
};

export const adminSetCorporateStatus = {
  created, method: 'post', path: '/admin/corporate/:id/status',
  description: 'Admin: move a corporate account between pending, active, suspended and terminated.',
  requestSample: { status: 'active' },
  onGuard: [requireAuth('admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const result = await corporateService.setStatus({
      corporateId: req.params.id, status: req.body?.status, actorId: req.user.sub,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.account);
  }
};

export const adminVerifyCorporateDomain = {
  created, method: 'get', path: '/admin/corporate/:id/verify-domain',
  description: "Admin: check whether an email's domain is whitelisted for a corporate account. Query: ?email=.",
  onGuard: [requireAuth('admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const result = await corporateService.verifyDomain({ corporateId: req.params.id, email: req.query?.email });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

// ── Seat provisioning (HR) ─────────────────────────────────────────────────

export const corporateListStaff = {
  created, method: 'get', path: '/corporate/staff',
  description: 'Corporate HR: list staff. Query: ?search=&department=&status=pending|active|suspended|exited.',
  onGuard: requireHr,
  onRequest: (req, res) => scoped(req, res, corporateId => corporateService.listStaff({
    corporateId, search: req.query?.search, department: req.query?.department, status: req.query?.status,
  }))
};

export const corporateProvisionStaff = {
  created, method: 'post', path: '/corporate/staff',
  description: 'Corporate HR: provision one employee. The generated activation PIN is returned once and stored only as a hash.',
  requestSample: { displayName: 'Asha Mollel', phone: '+2557XXXXXXXX', email: 'asha@nmbtz.com', department: 'Operations' },
  onGuard: requireHr,
  onRequest: (req, res) => scoped(req, res, corporateId => corporateService.provisionStaff({
    corporateId, body: req.body || {}, actorId: req.user.sub,
  }))
};

export const corporateBulkProvisionStaff = {
  created, method: 'post', path: '/corporate/staff/bulk',
  description: 'Corporate HR: bulk provision from pasted CSV rows (name,phone,email,department). Rejects the whole batch if any row is invalid.',
  requestSample: { rawText: 'Asha Mollel,+255700000001,asha@nmbtz.com,Operations', defaultDepartment: 'General' },
  onGuard: requireHr,
  onRequest: (req, res) => scoped(req, res, corporateId => corporateService.bulkProvisionStaff({
    corporateId, body: req.body || {}, actorId: req.user.sub,
  }))
};

export const corporateSetStaffStatus = {
  created, method: 'post', path: '/corporate/staff/:id/status',
  description: 'Corporate HR: activate, suspend or exit an employee. Exiting returns the seat to the pool.',
  requestSample: { status: 'active' },
  onGuard: requireHr,
  onRequest: (req, res) => scoped(req, res, corporateId => corporateService.setEmployeeStatus({
    corporateId, employeeId: req.params.id, status: req.body?.status, actorId: req.user.sub,
  }))
};

export const corporateLinkStaffUser = {
  created, method: 'post', path: '/corporate/staff/:id/link',
  description: 'Corporate HR: link an employee to their FitFlex member account so they can use the company\'s benefits. Give the account\'s email, its mobile number or its userId (one of them). Send userId null to unlink.',
  requestSample: { email: 'asha@nmbtz.com' },
  onGuard: requireHr,
  onRequest: (req, res) => scoped(req, res, corporateId => corporateService.linkEmployeeUser({
    corporateId, employeeId: req.params.id, userId: req.body?.userId, email: req.body?.email, phone: req.body?.phone, actorId: req.user.sub,
  }))
};

// ── Dashboard + billing (HR) ───────────────────────────────────────────────

export const corporateDashboard = {
  created, method: 'get', path: '/corporate/dashboard',
  description: 'Corporate HR: engagement and absenteeism telemetry. Query: ?mode=employer|insurer.',
  onGuard: requireHr,
  onRequest: (req, res) => scoped(req, res, corporateId => corporateService.dashboard({
    corporateId, mode: req.query?.mode || 'employer',
  }))
};

export const corporateGenerateBill = {
  created, method: 'post', path: '/corporate/billing/generate',
  description: 'Corporate HR: generate the seat bill for a period (defaults to the current month). Idempotent per period.',
  requestSample: { period: '2026-09' },
  onGuard: requireHr,
  onRequest: (req, res) => scoped(req, res, corporateId => corporateService.generateBill({
    corporateId, period: req.body?.period, actorId: req.user.sub,
  }))
};

export const corporateBillingHistory = {
  created, method: 'get', path: '/corporate/billing',
  description: 'Corporate HR: billing history, newest period first.',
  onGuard: requireHr,
  onRequest: (req, res) => scoped(req, res, corporateId => corporateService.listBills({ corporateId }))
};

export const adminMarkCorporateBillPaid = {
  created, method: 'post', path: '/admin/corporate/billing/:id/paid',
  description: 'Admin: mark a corporate bill paid against an M-Pesa Business / Lipa Namba reference.',
  requestSample: { paymentReference: 'MPESA-XYZ123' },
  onGuard: [requireAuth('admin'), requireAcl('corporate')],
  onRequest: async (req, res) => {
    const result = await corporateService.markBillPaid({
      billId: req.params.id, paymentReference: req.body?.paymentReference, actorId: req.user.sub,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.bill);
  }
};
