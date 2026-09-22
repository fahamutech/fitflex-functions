// FitFlex Af — Corporate Wellness & Gym Owner REST Endpoints
//
// To wire into index.mjs:
//   import { initCorporateEndpoints } from './corporate-endpoints.mjs';
//   import { initGymOwnerEndpoints } from './gym-owner-endpoints.mjs';
//   initCorporateEndpoints({ collection, requireAuth, auditLog, users, gyms, checkins });
//   initGymOwnerEndpoints({ collection, requireAuth, auditLog, users, gyms, checkins, marketplaceOrders: collection('marketplace_orders') });

import { randomUUID } from 'node:crypto';
import { createCorporateService } from '../src/services/corporate-service.mjs';
import { INDUSTRY_SECTORS, WORKFORCE_BRACKETS, SUBSIDY_MODELS, CORPORATE_STATUS, EMPLOYEE_STATUS, DASHBOARD_MODES, HR_OBJECTIVES, BILLING_CYCLE } from '../src/shared/corporate-constants.mjs';

let svc = null;
let requireAuth = null;
let auditLog = null;
let users = null;
let gyms = null;
let checkins = null;

export function initCorporateEndpoints({ collection, requireAuth: ra, auditLog: al, users: u, gyms: g, checkins: c }) {
  svc = createCorporateService({
    users: u,
    gyms: g,
    checkins: c,
    corporateAccounts: collection('corporate_accounts'),
    corporateEmployees: collection('corporate_employees'),
    corporateBilling: collection('corporate_billing'),
    auditLog: al
  });
  requireAuth = ra;
  auditLog = al;
  users = u;
  gyms = g;
  checkins = c;
}

const created = new Date().toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// CORPORATE ONBOARDING
// ═══════════════════════════════════════════════════════════════════════════
export const corporateOnboarding = {
  created, method: 'post', path: '/corporate/onboarding',
  description: 'Corporate: 3-step onboarding — identity, objectives, subsidy model.',
  requestSample: {
    companyName: 'CRDB Bank PLC',
    industrySector: 'banking',
    workforceBracket: '1000+',
    hrContactName: 'HR Manager',
    hrContactPhone: '+255712345678',
    hrContactEmail: 'hr@crdbbank.co.tz',
    objectives: ['reduce_absenteeism', 'boost_talent_retention'],
    subsidyModel: 'fully_funded',
    corporatePassTier: 'pro',
    billingCycle: 'monthly',
    domainWhitelist: ['@crdbbank.co.tz'],
    lipaNamba: '815592'
  },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.onboardCorporate(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const corporateReference = {
  created, method: 'get', path: '/corporate/reference',
  description: 'Public: list industry sectors, workforce brackets, subsidy models, HR objectives.',
  onRequest: (_, res) => {
    res.json({
      industrySectors: Object.entries(INDUSTRY_SECTORS).map(([id, label]) => ({ id, label })),
      workforceBrackets: Object.entries(WORKFORCE_BRACKETS).map(([id, label]) => ({ id, label })),
      subsidyModels: Object.entries(SUBSIDY_MODELS).map(([id, label]) => ({ id, label })),
      hrObjectives: HR_OBJECTIVES,
      billingCycles: Object.entries(BILLING_CYCLE).map(([id, label]) => ({ id, label }))
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// STAFF ROSTER & PIN PROVISIONING
// ═══════════════════════════════════════════════════════════════════════════
export const corporateListStaff = {
  created, method: 'get', path: '/corporate/staff',
  description: 'Corporate HR: list staff with filters (search, department, status).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { accountId, search, department, status, limit } = req.query || {};
    if (!accountId) return res.status(400).json({ error: 'accountId_required' });
    const list = svc.listStaff(accountId, {
      search, department, status,
      limit: limit ? Number(limit) : 100
    });
    res.json(list);
  }
};

export const corporateProvisionStaff = {
  created, method: 'post', path: '/corporate/staff',
  description: 'Corporate HR: provision a single employee with auto-generated 4-digit PIN.',
  requestSample: { accountId: 'crp_001', name: 'John Mwakikagile', phone: '+255712111222', email: 'john@crdbbank.co.tz', department: 'Retail Banking' },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.provisionStaff(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const corporateBulkProvisionStaff = {
  created, method: 'post', path: '/corporate/staff/bulk',
  description: 'Corporate HR: bulk provision staff from CSV/Excel paste. Auto-generates PINs.',
  requestSample: {
    accountId: 'crp_001',
    rawText: 'John Mwakikagile,+255712111222,john@crdb.co.tz,Retail Banking\\nAshwa Ahmed,+255712333444,ashwa@crdb.co.tz,Operations',
    defaultDepartment: 'General'
  },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.bulkProvisionStaff(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const corporateActivateEmployee = {
  created, method: 'post', path: '/corporate/staff/:id/activate',
  description: 'Corporate HR: activate a provisioned employee (status: pending → active).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.activateEmployee(req.params.id, req.user?.sub);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const corporateSuspendEmployee = {
  created, method: 'post', path: '/corporate/staff/:id/suspend',
  description: 'Corporate HR: suspend an employee.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { reason } = req.body || {};
    const result = svc.suspendEmployee(req.params.id, reason);
    res.json(result);
  }
};

export const corporateExitEmployee = {
  created, method: 'post', path: '/corporate/staff/:id/exit',
  description: 'Corporate HR: mark employee as exited (left the company).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.exitEmployee(req.params.id);
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD & TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════
export const corporateDashboard = {
  created, method: 'get', path: '/corporate/dashboard',
  description: 'Corporate HR: dual-mode dashboard (employer vs insurer). Telemetry, ROI, absenteeism.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { accountId, mode } = req.query || {};
    if (!accountId) return res.status(400).json({ error: 'accountId_required' });
    const dashboard = svc.getDashboard(accountId, { mode: mode || DASHBOARD_MODES.EMPLOYER });
    if (!dashboard) return res.status(404).json({ error: 'account_not_found' });
    res.json(dashboard);
  }
};

export const corporateCopilot = {
  created, method: 'get', path: '/corporate/copilot',
  description: 'Corporate HR: AI wellness copilot recommendations (stub mode — Gemini integration later).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { accountId } = req.query || {};
    if (!accountId) return res.status(400).json({ error: 'accountId_required' });
    const result = svc.getCopilotRecommendations(accountId);
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// BILLING
// ═══════════════════════════════════════════════════════════════════════════
export const corporateMonthlyBill = {
  created, method: 'post', path: '/corporate/billing/generate',
  description: 'Corporate HR: generate monthly billing statement (gross, subsidy, copay, net).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { accountId, month } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'accountId_required' });
    const bill = svc.getMonthlyBill(accountId, { month });
    res.status(201).json(bill);
  }
};

export const corporateBillingHistory = {
  created, method: 'get', path: '/corporate/billing',
  description: 'Corporate HR: list billing history (all months).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { accountId, limit } = req.query || {};
    if (!accountId) return res.status(400).json({ error: 'accountId_required' });
    const list = svc.getBillingHistory(accountId, { limit: limit ? Number(limit) : 12 });
    res.json(list);
  }
};

export const corporateMarkBillPaid = {
  created, method: 'post', path: '/corporate/billing/:id/paid',
  description: 'Admin: mark a corporate bill as paid (M-Pesa Business / Lipa Namba reference).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { paymentRef } = req.body || {};
    const result = svc.markBillPaid(req.params.id, { paymentRef, adminId: req.user?.sub });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: CORPORATE ACCOUNT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
export const adminListCorporateAccounts = {
  created, method: 'get', path: '/admin/corporate',
  description: 'Admin: list all corporate accounts. ?status=pending|active|suspended|terminated',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { status, limit } = req.query || {};
    const list = svc.listAccounts({ status, limit: limit ? Number(limit) : 50 });
    res.json(list);
  }
};

export const adminActivateCorporate = {
  created, method: 'post', path: '/admin/corporate/:id/activate',
  description: 'Admin: activate a corporate account (pending → active).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.activateCorporate(req.params.id, req.user?.sub);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const adminSuspendCorporate = {
  created, method: 'post', path: '/admin/corporate/:id/suspend',
  description: 'Admin: suspend a corporate account.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.suspendCorporate(req.params.id, req.user?.sub);
    res.json(result);
  }
};

export const adminUpdateCorporate = {
  created, method: 'put', path: '/admin/corporate/:id',
  description: 'Admin: update corporate account (seat limit, subsidy model, pass tier, etc.).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.updateCorporateAccount(req.params.id, req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const adminVerifyDomain = {
  created, method: 'post', path: '/admin/corporate/verify-domain',
  description: 'Admin: verify if an email domain is whitelisted for a corporate account.',
  requestSample: { accountId: 'crp_001', email: 'john@crdbbank.co.tz' },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { accountId, email } = req.body || {};
    if (!accountId || !email) return res.status(400).json({ error: 'accountId_and_email_required' });
    const result = svc.verifyDomain(accountId, email);
    res.json(result);
  }
};
