// FitFlex Af — Corporate Wellness Service (clean architecture + DI)
//
// Capabilities:
//   - Corporate onboarding (3-step: identity → objectives → staff provisioning)
//   - Staff roster with PIN provisioning and auto-generation
//   - CSV bulk staff import with auto-PIN generation
//   - Dual-mode dashboard (employer HR vs. insurer) with telemetry
//   - Absenteeism drop index (from check-in frequency)
//   - Engagement rate calculation (active / total)
//   - Department breakdown analytics
//   - Monthly billing statements (gross, subsidy, copay, net)
//   - Staff access control (activate, suspend, exit)
//   - Domain whitelisting for auto-verification
//   - M-Pesa Business billing reference (Lipa Namba)

import { randomUUID } from 'node:crypto';
import {
  INDUSTRY_SECTORS,
  WORKFORCE_BRACKETS,
  SUBSIDY_MODELS,
  CORPORATE_STATUS,
  EMPLOYEE_STATUS,
  DASHBOARD_MODES,
  HR_OBJECTIVES,
  ENGAGEMENT_TARGET_PCT,
  CORPORATE_PASS_TIERS,
  BILLING_CYCLE,
  calculateAbsenteeismDrop,
  calculateEngagementRate,
  calculateMonthlyBill
} from '../shared/corporate-constants.mjs';

export function createCorporateService({ users, gyms, checkins, corporateAccounts, corporateEmployees, corporateBilling, auditLog }) {

  // ─── Onboarding ──────────────────────────────────────────────────────────

  function onboardCorporate({ companyName, industrySector, workforceBracket, hrContactName, hrContactPhone, hrContactEmail, objectives, subsidyModel, corporatePassTier, billingCycle, domainWhitelist, lipaNamba }) {
    if (!companyName) return { ok: false, error: 'company_name_required' };
    if (!industrySector || !INDUSTRY_SECTORS[industrySector])
      return { ok: false, error: 'invalid_industry_sector' };
    if (!workforceBracket || !WORKFORCE_BRACKETS[workforceBracket])
      return { ok: false, error: 'invalid_workforce_bracket' };
    if (!subsidyModel || !Object.values(SUBSIDY_MODELS).includes(subsidyModel))
      return { ok: false, error: 'invalid_subsidy_model' };

    const account = {
      id: `crp_${randomUUID().slice(0, 8)}`,
      companyName,
      industrySector,
      workforceBracket,
      hrContactName: hrContactName || null,
      hrContactPhone: hrContactPhone || null,
      hrContactEmail: hrContactEmail || null,
      objectives: objectives || [],
      subsidyModel,
      corporatePassTier: corporatePassTier || 'basic',
      billingCycle: billingCycle || BILLING_CYCLE.MONTHLY,
      domainWhitelist: domainWhitelist || [],
      lipaNamba: lipaNamba || null,
      status: CORPORATE_STATUS.PENDING,
      seatLimit: 0,
      seatsUsed: 0,
      createdAt: new Date().toISOString(),
      activatedAt: null
    };

    corporateAccounts.insert(account);
    return { ok: true, account };
  }

  function activateCorporate(accountId, adminId) {
    const account = corporateAccounts.find(a => a.id === accountId);
    if (!account) return { ok: false, error: 'account_not_found' };
    if (account.status === CORPORATE_STATUS.ACTIVE)
      return { ok: false, error: 'already_active' };

    const updated = corporateAccounts.update(a => a.id === accountId, {
      status: CORPORATE_STATUS.ACTIVE,
      activatedAt: new Date().toISOString(),
      activatedBy: adminId
    });

    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: adminId, action: 'corporate_activated',
      target: accountId, before: account, after: updated
    });

    return { ok: true, account: updated };
  }

  function suspendCorporate(accountId, adminId) {
    const updated = corporateAccounts.update(a => a.id === accountId, {
      status: CORPORATE_STATUS.SUSPENDED
    });
    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: adminId, action: 'corporate_suspended', target: accountId
    });
    return { ok: true, account: updated };
  }

  function updateCorporateAccount(accountId, updates) {
    const account = corporateAccounts.find(a => a.id === accountId);
    if (!account) return { ok: false, error: 'account_not_found' };
    const allowed = ['companyName', 'industrySector', 'workforceBracket', 'hrContactName',
                     'hrContactPhone', 'hrContactEmail', 'objectives', 'subsidyModel',
                     'corporatePassTier', 'billingCycle', 'domainWhitelist', 'lipaNamba', 'seatLimit'];
    const patch = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) patch[key] = updates[key];
    }
    const updated = corporateAccounts.update(a => a.id === accountId, patch);
    return { ok: true, account: updated };
  }

  // ─── Staff Roster & PIN Provisioning ──────────────────────────────────────

  function generatePin() {
    return String(Math.floor(1000 + Math.random() * 9000));
  }

  function provisionStaff({ accountId, name, phone, email, department, pin }) {
    const account = corporateAccounts.find(a => a.id === accountId);
    if (!account) return { ok: false, error: 'account_not_found' };
    if (account.status !== CORPORATE_STATUS.ACTIVE)
      return { ok: false, error: 'account_not_active' };
    if (account.seatLimit > 0 && account.seatsUsed >= account.seatLimit)
      return { ok: false, error: 'seat_limit_reached' };

    const employee = {
      id: `emp_${randomUUID().slice(0, 8)}`,
      accountId,
      name: name || 'Employee',
      phone: phone || null,
      email: email || null,
      department: department || null,
      pin: pin || generatePin(),
      status: EMPLOYEE_STATUS.PENDING,
      activatedAt: null,
      lastVisitDate: null,
      totalVisits: 0,
      createdAt: new Date().toISOString()
    };

    corporateEmployees.insert(employee);
    corporateAccounts.update(a => a.id === accountId, {
      seatsUsed: (account.seatsUsed || 0) + 1
    });

    return { ok: true, employee };
  }

  function bulkProvisionStaff({ accountId, rawText, defaultDepartment }) {
    const account = corporateAccounts.find(a => a.id === accountId);
    if (!account) return { ok: false, error: 'account_not_found' };
    if (account.status !== CORPORATE_STATUS.ACTIVE)
      return { ok: false, error: 'account_not_active' };

    // Parse CSV (name, phone, email, department)
    const lines = rawText.trim().split(/\r?\n/).filter(l => l.trim());
    const imported = [];
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
      const cells = lines[i].split(/[,\t]/).map(c => c.trim());
      const [name, phone, email, department] = cells;

      if (!name) { errors.push({ row: i + 1, error: 'missing_name' }); continue; }
      if (account.seatLimit > 0 && account.seatsUsed + imported.length >= account.seatLimit) {
        errors.push({ row: i + 1, error: 'seat_limit_reached' });
        break;
      }

      const result = provisionStaff({
        accountId, name, phone, email,
        department: department || defaultDepartment
      });

      if (result.ok) imported.push(result.employee);
      else errors.push({ row: i + 1, error: result.error });
    }

    return { ok: true, imported: imported.length, errors: errors.length, errorDetails: errors, employees: imported };
  }

  function activateEmployee(employeeId, adminId) {
    const employee = corporateEmployees.find(e => e.id === employeeId);
    if (!employee) return { ok: false, error: 'employee_not_found' };
    const updated = corporateEmployees.update(e => e.id === employeeId, {
      status: EMPLOYEE_STATUS.ACTIVE,
      activatedAt: new Date().toISOString()
    });
    return { ok: true, employee: updated };
  }

  function suspendEmployee(employeeId, reason) {
    const updated = corporateEmployees.update(e => e.id === employeeId, {
      status: EMPLOYEE_STATUS.SUSPENDED,
      suspensionReason: reason || null
    });
    return { ok: true, employee: updated };
  }

  function exitEmployee(employeeId) {
    const updated = corporateEmployees.update(e => e.id === employeeId, {
      status: EMPLOYEE_STATUS.EXITED,
      exitDate: new Date().toISOString()
    });
    return { ok: true, employee: updated };
  }

  function listStaff(accountId, { search, department, status, limit = 100 } = {}) {
    let list = corporateEmployees.filter(e => e.accountId === accountId);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.email || '').toLowerCase().includes(q) ||
        (e.phone || '').includes(q)
      );
    }
    if (department) list = list.filter(e => e.department === department);
    if (status) list = list.filter(e => e.status === status);
    return list.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)).slice(0, limit);
  }

  function getEmployee(employeeId) {
    return corporateEmployees.find(e => e.id === employeeId) || null;
  }

  // ─── Dashboard & Telemetry ──────────────────────────────────────────────────

  function getDashboard(accountId, { mode = DASHBOARD_MODES.EMPLOYER } = {}) {
    const account = corporateAccounts.find(a => a.id === accountId);
    if (!account) return null;

    const employees = corporateEmployees.filter(e => e.accountId === accountId);
    const activeCount = employees.filter(e => e.status === EMPLOYEE_STATUS.ACTIVE).length;
    const pendingCount = employees.filter(e => e.status === EMPLOYEE_STATUS.PENDING).length;
    const totalCount = employees.length;
    const engagementRate = calculateEngagementRate({ activeCount, totalCount });

    // Absenteeism drop — from check-in frequency of corporate employees
    const employeeIds = employees.map(e => e.id);
    const corporateCheckins = checkins.filter ? checkins.filter(c => employeeIds.includes(c.memberId)) : [];

    // Calculate avg visits per week (last 4 weeks)
    const fourWeeksAgo = Date.now() - 28 * 86_400_000;
    const recentCheckins = corporateCheckins.filter(c => +new Date(c.timestamp) >= fourWeeksAgo);
    const activeEmployees = employees.filter(e => e.status === EMPLOYEE_STATUS.ACTIVE).length || 1;
    const avgVisitsPerWeek = (recentCheckins.length / 4) / activeEmployees;
    const absenteeism = calculateAbsenteeismDrop({ avgVisitsPerWeek, baselineSickDays: 7 });

    // Department breakdown
    const deptMap = {};
    for (const emp of employees) {
      const dept = emp.department || 'Unassigned';
      if (!deptMap[dept]) deptMap[dept] = { department: dept, total: 0, active: 0, visits: 0 };
      deptMap[dept].total++;
      if (emp.status === EMPLOYEE_STATUS.ACTIVE) deptMap[dept].active++;
      deptMap[dept].visits += emp.totalVisits || 0;
    }
    const departmentBreakdown = Object.values(deptMap).map(d => ({
      ...d,
      engagementRate: d.total > 0 ? Math.round((d.active / d.total) * 100) : 0
    })).sort((a, b) => b.active - a.active);

    // Monthly visit data (last 6 months for trend)
    const monthlyVisits = {};
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toISOString().slice(0, 7);
      monthlyVisits[key] = 0;
    }
    for (const c of corporateCheckins) {
      const key = new Date(c.timestamp).toISOString().slice(0, 7);
      if (monthlyVisits[key] !== undefined) monthlyVisits[key]++;
    }

    const base = {
      account,
      totalEnrolled: totalCount,
      activeCount,
      pendingCount,
      engagementRate,
      engagementTarget: ENGAGEMENT_TARGET_PCT,
      absenteeism,
      departmentBreakdown,
      monthlyVisits: Object.entries(monthlyVisits).map(([month, visits]) => ({ month, visits }))
    };

    if (mode === DASHBOARD_MODES.INSURER) {
      // Insurance-specific metrics
      return {
        ...base,
        mode: 'insurer',
        metrics: {
          groupSize: totalCount,
          activeMembers: activeCount,
          engagementRate,
          lifestyleRiskMitigation: engagementRate >= 75 ? 'Low Risk' : engagementRate >= 50 ? 'Moderate Risk' : 'High Risk',
          premiumDiscountEligible: engagementRate >= ENGAGEMENT_TARGET_PCT,
          estimatedClaimsReduction: absenteeism.dropPct
        }
      };
    }

    // Employer mode (default)
    return {
      ...base,
      mode: 'employer',
      metrics: {
        retentionIndex: Math.round(engagementRate * 0.7), // simplified
        productivityScore: Math.min(100, Math.round(avgVisitsPerWeek * 20)),
        burnoutMitigation: engagementRate >= 50 ? 'Effective' : 'Needs attention',
        staffSatisfaction: engagementRate // proxy
      }
    };
  }

  // ─── Billing ────────────────────────────────────────────────────────────────

  function getMonthlyBill(accountId, { month } = {}) {
    const account = corporateAccounts.find(a => a.id === accountId);
    if (!account) return null;

    const employees = corporateEmployees.filter(e =>
      e.accountId === accountId &&
      [EMPLOYEE_STATUS.ACTIVE, EMPLOYEE_STATUS.PENDING].includes(e.status)
    );
    const seatCount = employees.length;

    const bill = calculateMonthlyBill({
      tier: account.corporatePassTier,
      seatCount,
      subsidyModel: account.subsidyModel,
      billingCycle: account.billingCycle
    });

    const billingRecord = {
      id: `bil_${randomUUID().slice(0, 8)}`,
      accountId,
      month: month || new Date().toISOString().slice(0, 7),
      ...bill,
      status: 'pending', // pending → paid
      generatedAt: new Date().toISOString(),
      paidAt: null,
      paymentRef: null,
      lipaNamba: account.lipaNamba
    };

    corporateBilling.insert(billingRecord);
    return billingRecord;
  }

  function getBillingHistory(accountId, { limit = 12 } = {}) {
    return corporateBilling
      .filter(b => b.accountId === accountId)
      .sort((a, b) => +new Date(b.generatedAt) - +new Date(a.generatedAt))
      .slice(0, limit);
  }

  function markBillPaid(billId, { paymentRef, adminId }) {
    const bill = corporateBilling.find(b => b.id === billId);
    if (!bill) return { ok: false, error: 'bill_not_found' };
    const updated = corporateBilling.update(b => b.id === billId, {
      status: 'paid',
      paidAt: new Date().toISOString(),
      paymentRef: paymentRef || null
    });
    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: adminId, action: 'corporate_bill_paid', target: billId
    });
    return { ok: true, bill: updated };
  }

  // ─── Domain Whitelisting ────────────────────────────────────────────────────

  function verifyDomain(accountId, email) {
    const account = corporateAccounts.find(a => a.id === accountId);
    if (!account) return { ok: false, error: 'account_not_found' };
    const whitelist = account.domainWhitelist || [];
    if (whitelist.length === 0) return { ok: false, error: 'no_whitelist_configured' };
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return { ok: false, error: 'invalid_email' };
    const matched = whitelist.some(w => domain === w.replace(/^@/, '').toLowerCase());
    return { ok: matched, domain, whitelist };
  }

  // ─── AI Copilot (Stub — wire Gemini later) ──────────────────────────────────

  function getCopilotRecommendations(accountId) {
    const dashboard = getDashboard(accountId, { mode: DASHBOARD_MODES.EMPLOYER });
    if (!dashboard) return null;
    const recs = [];

    if (dashboard.engagementRate < 50) {
      recs.push({
        type: 'challenge',
        title: 'Inter-department 10,000 Step Challenge',
        description: 'Gamify fitness with a friendly competition across departments to boost engagement.',
        target: 'all_departments'
      });
    }
    if (dashboard.engagementRate < 75) {
      recs.push({
        type: 'wellness',
        title: 'Midday Ergonomic Stretch Breaks',
        description: 'Schedule 15-minute group stretch sessions twice weekly to reduce desk fatigue.',
        target: 'low_engagement_departments'
      });
    }
    recs.push({
      type: 'event',
      title: 'Corporate Marathon Preparation Bootcamp',
      description: '8-week training program leading to the Kilimanjaro Marathon — team building + fitness.',
      target: 'active_employees'
    });

    return {
      accountId,
      engagementRate: dashboard.engagementRate,
      recommendations: recs,
      note: 'AI Copilot is in stub mode — wire Gemini API for personalized recommendations.'
    };
  }

  // ─── Admin: List All Corporate Accounts ──────────────────────────────────────

  function listAccounts({ status, limit = 50 } = {}) {
    let list = corporateAccounts.all ? corporateAccounts.all() : corporateAccounts.filter(() => true);
    if (status) list = list.filter(a => a.status === status);
    return list
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, limit)
      .map(a => ({
        ...a,
        seatUtilization: a.seatLimit > 0 ? Math.round((a.seatsUsed / a.seatLimit) * 100) : null
      }));
  }

  return {
    // Onboarding
    onboardCorporate, activateCorporate, suspendCorporate, updateCorporateAccount,
    // Staff
    provisionStaff, bulkProvisionStaff, activateEmployee, suspendEmployee, exitEmployee,
    listStaff, getEmployee,
    // Dashboard
    getDashboard,
    // Billing
    getMonthlyBill, getBillingHistory, markBillPaid,
    // Domain
    verifyDomain,
    // Copilot (stub)
    getCopilotRecommendations,
    // Admin
    listAccounts,
    // Constants
    _constants: {
      INDUSTRY_SECTORS, WORKFORCE_BRACKETS, SUBSIDY_MODELS, CORPORATE_STATUS,
      EMPLOYEE_STATUS, DASHBOARD_MODES, HR_OBJECTIVES, ENGAGEMENT_TARGET_PCT,
      CORPORATE_PASS_TIERS, BILLING_CYCLE, calculateAbsenteeismDrop,
      calculateEngagementRate, calculateMonthlyBill
    }
  };
}
