// Unit tests for the corporate wellness service.
// Run with: node --test specs/corporate.specs.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorporateService } from '../src/services/corporate-service.mjs';
import {
  INDUSTRY_SECTORS, WORKFORCE_BRACKETS, SUBSIDY_MODELS,
  CORPORATE_STATUS, EMPLOYEE_STATUS, DASHBOARD_MODES,
  ENGAGEMENT_TARGET_PCT, CORPORATE_PASS_TIERS, BILLING_CYCLE,
  calculateAbsenteeismDrop, calculateEngagementRate, calculateMonthlyBill
} from '../src/shared/corporate-constants.mjs';

function createStore() {
  const data = { users: [], gyms: [], checkins: [], corporate_accounts: [], corporate_employees: [], corporate_billing: [], audit_log: [] };
  function collection(name) {
    return {
      _data: data[name], all: () => data[name], find: p => data[name].find(p),
      filter: p => data[name].filter(p), some: p => data[name].some(p),
      insert: r => { data[name].push(r); return r; },
      update: (p, patch) => { const i = data[name].findIndex(p); if (i >= 0) data[name][i] = { ...data[name][i], ...patch }; return data[name].find(p); },
      remove: p => { const i = data[name].findIndex(p); if (i >= 0) return data[name].splice(i, 1)[0]; return null; }
    };
  }
  return { data, collection };
}

function setup() {
  const { data, collection } = createStore();
  const svc = createCorporateService({
    users: collection('users'), gyms: collection('gyms'), checkins: collection('checkins'),
    corporateAccounts: collection('corporate_accounts'),
    corporateEmployees: collection('corporate_employees'),
    corporateBilling: collection('corporate_billing'),
    auditLog: collection('audit_log')
  });
  return { data, svc };
}

// ═══════════════════════════════════════════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════════════════════════════════════════
test('Corporate onboarding creates pending account', () => {
  const { svc } = setup();
  const r = svc.onboardCorporate({
    companyName: 'CRDB Bank PLC', industrySector: 'banking',
    workforceBracket: '1000+', subsidyModel: 'fully_funded',
    corporatePassTier: 'pro'
  });
  assert.ok(r.ok);
  assert.equal(r.account.status, CORPORATE_STATUS.PENDING);
  assert.equal(r.account.companyName, 'CRDB Bank PLC');
});

test('Invalid industry sector rejected', () => {
  const { svc } = setup();
  assert.ok(!svc.onboardCorporate({ companyName: 'X', industrySector: 'invalid', workforceBracket: '50-100', subsidyModel: 'fully_funded' }).ok);
});

test('Invalid subsidy model rejected', () => {
  const { svc } = setup();
  assert.ok(!svc.onboardCorporate({ companyName: 'X', industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'invalid' }).ok);
});

test('Admin activates corporate account', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  const r = svc.activateCorporate(account.id, 'admin');
  assert.ok(r.ok);
  assert.equal(r.account.status, CORPORATE_STATUS.ACTIVE);
});

test('Cannot activate already-active account', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  const r = svc.activateCorporate(account.id, 'admin');
  assert.ok(!r.ok);
});

// ═══════════════════════════════════════════════════════════════════════════
// STAFF PROVISIONING
// ═══════════════════════════════════════════════════════════════════════════
test('Provision staff with auto-generated PIN', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  // Set seat limit
  svc.updateCorporateAccount(account.id, { seatLimit: 100 });

  const r = svc.provisionStaff({ accountId: account.id, name: 'John Mwaki', phone: '+255712111222', department: 'Retail Banking' });
  assert.ok(r.ok);
  assert.equal(r.employee.name, 'John Mwaki');
  assert.match(r.employee.pin, /^\d{4}$/); // 4-digit PIN
  assert.equal(r.employee.status, EMPLOYEE_STATUS.PENDING);
});

test('Cannot provision staff to inactive account', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  // Not activated
  const r = svc.provisionStaff({ accountId: account.id, name: 'John' });
  assert.ok(!r.ok);
  assert.equal(r.error, 'account_not_active');
});

test('Seat limit enforcement', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'Small', industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 2 });

  assert.ok(svc.provisionStaff({ accountId: account.id, name: 'E1' }).ok);
  assert.ok(svc.provisionStaff({ accountId: account.id, name: 'E2' }).ok);
  assert.ok(!svc.provisionStaff({ accountId: account.id, name: 'E3' }).ok);
  assert.equal(svc.provisionStaff({ accountId: account.id, name: 'E3' }).error, 'seat_limit_reached');
});

test('Bulk provision staff from CSV', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 1000 });

  const r = svc.bulkProvisionStaff({
    accountId: account.id,
    rawText: 'John,+255712111222,john@crdb.co.tz,Retail\nAshwa,+255712333444,ashwa@crdb.co.tz,Operations',
    defaultDepartment: 'General'
  });
  assert.ok(r.ok);
  assert.equal(r.imported, 2);
});

test('Activate employee status', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  const { employee } = svc.provisionStaff({ accountId: account.id, name: 'John' });
  const r = svc.activateEmployee(employee.id, 'admin');
  assert.ok(r.ok);
  assert.equal(r.employee.status, EMPLOYEE_STATUS.ACTIVE);
});

test('Suspend and exit employee', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  const { employee } = svc.provisionStaff({ accountId: account.id, name: 'John' });
  svc.activateEmployee(employee.id, 'admin');

  const suspended = svc.suspendEmployee(employee.id, 'Absenteeism');
  assert.equal(suspended.employee.status, EMPLOYEE_STATUS.SUSPENDED);

  const exited = svc.exitEmployee(employee.id);
  assert.equal(exited.employee.status, EMPLOYEE_STATUS.EXITED);
});

test('List staff with department filter', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 100 });
  svc.provisionStaff({ accountId: account.id, name: 'J1', department: 'Retail' });
  svc.provisionStaff({ accountId: account.id, name: 'A1', department: 'Operations' });
  const list = svc.listStaff(account.id, { department: 'Retail' });
  assert.equal(list.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD & TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════
test('Employer dashboard shows engagement and absenteeism', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 100 });
  for (let i = 0; i < 10; i++) {
    svc.provisionStaff({ accountId: account.id, name: `Emp${i}` });
  }
  // Activate 5 out of 10
  const employees = svc.listStaff(account.id);
  for (let i = 0; i < 5; i++) svc.activateEmployee(employees[i].id, 'admin');

  const dash = svc.getDashboard(account.id, { mode: DASHBOARD_MODES.EMPLOYER });
  assert.ok(dash);
  assert.equal(dash.totalEnrolled, 10);
  assert.equal(dash.activeCount, 5);
  assert.equal(dash.engagementRate, 50);
  assert.equal(dash.mode, 'employer');
});

test('Insurer dashboard shows risk and premium eligibility', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'insurance', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 100 });
  for (let i = 0; i < 10; i++) svc.provisionStaff({ accountId: account.id, name: `E${i}` });
  const employees = svc.listStaff(account.id);
  for (let i = 0; i < 8; i++) svc.activateEmployee(employees[i].id, 'admin');

  const dash = svc.getDashboard(account.id, { mode: DASHBOARD_MODES.INSURER });
  assert.equal(dash.mode, 'insurer');
  assert.equal(dash.metrics.groupSize, 10);
  assert.equal(dash.metrics.activeMembers, 8);
  assert.equal(dash.metrics.premiumDiscountEligible, true); // 80% ≥ 75%
});

test('Department breakdown analytics', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 100 });
  svc.provisionStaff({ accountId: account.id, name: 'R1', department: 'Retail' });
  svc.provisionStaff({ accountId: account.id, name: 'R2', department: 'Retail' });
  svc.provisionStaff({ accountId: account.id, name: 'O1', department: 'Operations' });

  const dash = svc.getDashboard(account.id);
  const depts = dash.departmentBreakdown;
  assert.ok(depts.length >= 2);
  const retail = depts.find(d => d.department === 'Retail');
  assert.equal(retail.total, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// BILLING
// ═══════════════════════════════════════════════════════════════════════════
test('Monthly bill: fully funded — employer pays all', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded', corporatePassTier: 'pro' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 100 });
  for (let i = 0; i < 10; i++) svc.provisionStaff({ accountId: account.id, name: `E${i}` });

  const bill = svc.getMonthlyBill(account.id);
  assert.ok(bill);
  // 10 seats × 120,000 (pro) = 1,200,000 gross, employer pays all
  assert.equal(bill.seatCount, 10);
  assert.equal(bill.perSeat, CORPORATE_PASS_TIERS.pro.price);
  assert.equal(bill.grossAmount, 120000 * 10);
  assert.equal(bill.employerShare, 120000 * 10);
  assert.equal(bill.employeeShare, 0);
});

test('Monthly bill: 50/50 copay — split equally', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'copay_50_50', corporatePassTier: 'basic' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 100 });
  for (let i = 0; i < 5; i++) svc.provisionStaff({ accountId: account.id, name: `E${i}` });

  const bill = svc.getMonthlyBill(account.id);
  // 5 × 60,000 = 300,000 → 50/50 = 150,000 each
  assert.equal(bill.grossAmount, 300000);
  assert.equal(bill.employerShare, 150000);
  assert.equal(bill.employeeShare, 150000);
});

test('Billing history', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 100 });
  svc.provisionStaff({ accountId: account.id, name: 'E1' });
  svc.getMonthlyBill(account.id, { month: '2026-08' });
  svc.getMonthlyBill(account.id, { month: '2026-09' });
  const history = svc.getBillingHistory(account.id);
  assert.equal(history.length, 2);
});

test('Mark bill as paid', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 100 });
  svc.provisionStaff({ accountId: account.id, name: 'E1' });
  const bill = svc.getMonthlyBill(account.id);
  const r = svc.markBillPaid(bill.id, { paymentRef: 'MPESA-815592', adminId: 'admin' });
  assert.ok(r.ok);
  assert.equal(r.bill.status, 'paid');
  assert.equal(r.bill.paymentRef, 'MPESA-815592');
});

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN WHITELIST
// ═══════════════════════════════════════════════════════════════════════════
test('Domain whitelist verification: matching domain', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({
    companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+',
    subsidyModel: 'fully_funded', domainWhitelist: ['@crdbbank.co.tz']
  });
  const r = svc.verifyDomain(account.id, 'john@crdbbank.co.tz');
  assert.ok(r.ok);
});

test('Domain whitelist verification: non-matching domain', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({
    companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+',
    subsidyModel: 'fully_funded', domainWhitelist: ['@crdbbank.co.tz']
  });
  const r = svc.verifyDomain(account.id, 'john@gmail.com');
  assert.ok(!r.ok);
});

// ═══════════════════════════════════════════════════════════════════════════
// AI COPILOT (STUB)
// ═══════════════════════════════════════════════════════════════════════════
test('Copilot returns stub recommendations', () => {
  const { svc } = setup();
  const { account } = svc.onboardCorporate({ companyName: 'CRDB', industrySector: 'banking', workforceBracket: '1000+', subsidyModel: 'fully_funded' });
  svc.activateCorporate(account.id, 'admin');
  svc.updateCorporateAccount(account.id, { seatLimit: 100 });
  const copilot = svc.getCopilotRecommendations(account.id);
  assert.ok(copilot);
  assert.ok(copilot.recommendations.length > 0);
  assert.match(copilot.note, /stub/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════
test('Absenteeism drop: more visits = higher drop %, capped at 30%', () => {
  const r1 = calculateAbsenteeismDrop({ avgVisitsPerWeek: 1, baselineSickDays: 7 });
  assert.equal(r1.dropPct, 3); // 1 × 3 = 3%
  const r3 = calculateAbsenteeismDrop({ avgVisitsPerWeek: 5, baselineSickDays: 7 });
  assert.equal(r3.dropPct, 15); // 5 × 3 = 15%
  const r10 = calculateAbsenteeismDrop({ avgVisitsPerWeek: 15, baselineSickDays: 7 });
  assert.equal(r10.dropPct, 30); // capped at 30%
});

test('Engagement rate: 5 active out of 10 = 50%', () => {
  assert.equal(calculateEngagementRate({ activeCount: 5, totalCount: 10 }), 50);
  assert.equal(calculateEngagementRate({ activeCount: 0, totalCount: 10 }), 0);
  assert.equal(calculateEngagementRate({ activeCount: 10, totalCount: 10 }), 100);
});

test('Monthly bill calculation: fully funded', () => {
  const bill = calculateMonthlyBill({ tier: 'pro', seatCount: 10, subsidyModel: 'fully_funded', billingCycle: 'monthly' });
  assert.equal(bill.grossAmount, 120000 * 10);
  assert.equal(bill.employerShare, 120000 * 10);
  assert.equal(bill.employeeShare, 0);
});

test('Monthly bill calculation: 70/30 copay', () => {
  const bill = calculateMonthlyBill({ tier: 'basic', seatCount: 10, subsidyModel: 'copay_70_30', billingCycle: 'monthly' });
  assert.equal(bill.grossAmount, 60000 * 10);
  assert.equal(bill.employerShare, Math.round(600000 * 0.7));
  assert.equal(bill.employeeShare, 600000 - Math.round(600000 * 0.7));
});

test('Engagement target is 75%', () => {
  assert.equal(ENGAGEMENT_TARGET_PCT, 75);
});

test('All corporate pass tiers exist', () => {
  assert.ok(CORPORATE_PASS_TIERS.basic);
  assert.ok(CORPORATE_PASS_TIERS.pro);
  assert.ok(CORPORATE_PASS_TIERS.premium);
  assert.ok(CORPORATE_PASS_TIERS.executive);
  assert.equal(CORPORATE_PASS_TIERS.executive.visitsAllowed, null); // unlimited
});

test('Industry sectors include banking, ngo, insurance', () => {
  assert.ok(Object.values(INDUSTRY_SECTORS).includes('Banking & Financial Services'));
  assert.ok(Object.values(INDUSTRY_SECTORS).includes('NGO & Development Agency'));
  assert.ok(Object.values(INDUSTRY_SECTORS).includes('Insurance'));
});

test('Subsidy models include all variants', () => {
  assert.ok(Object.values(SUBSIDY_MODELS).includes('fully_funded'));
  assert.ok(Object.values(SUBSIDY_MODELS).includes('copay_50_50'));
  assert.ok(Object.values(SUBSIDY_MODELS).includes('copay_70_30'));
  assert.ok(Object.values(SUBSIDY_MODELS).includes('employee_paid'));
});
