// Unit tests for the admin portal service (rubric, roaming, commission, contracts, audit, pitch deck).
// Run with: node --test specs/admin.specs.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminService } from '../src/services/admin-service.mjs';
import {
  RUBRIC_PILLARS, TIER_THRESHOLDS, assignTierFromScore,
  validateRubricScores, ROAMING_DEFAULTS, COMMISSION_RANGE,
  CONTRACT_STATUS, AUDIT_ACTIONS, PITCH_DECK_SLIDES
} from '../src/shared/admin-constants.mjs';

function createStore() {
  const data = { users: [], gyms: [], trainers: [], vendors: [], corporate_accounts: [], audit_log: [], roaming_rates: [], b2b_contracts: [] };
  function collection(name) {
    return {
      _data: data[name], all: () => data[name], find: p => data[name].find(p),
      filter: p => data[name].filter(p), some: p => data[name].some(p),
      insert: r => { data[name].push(r); return r; },
      update: (p, patch) => { const i = data[name].findIndex(p); if (i >= 0) data[name][i] = { ...data[name][i], ...patch }; return data[name].find(p); }
    };
  }
  return { data, collection };
}

function setup() {
  const { data, collection } = createStore();
  data.gyms = [
    { id: 'gym_001', name: 'Power Gym Mikocheni', status: 'active', isVerified: false, tier: 'standard' },
    { id: 'gym_002', name: 'Luxury Executive Club', status: 'active', isVerified: true, verifiedClassification: 'luxury_executive', verifiedScore: 95 }
  ];
  data.trainers = [{ id: 'tr_001', name: 'John Doe', status: 'active', isVerified: false }];
  data.vendors = [{ id: 'ven_001', name: 'Bongo Elite', status: 'pending' }];
  data.corporate_accounts = [{ id: 'crp_001', companyName: 'CRDB Bank', status: 'pending' }];
  const svc = createAdminService({
    gyms: collection('gyms'), trainers: collection('trainers'), vendors: collection('vendors'),
    corporateAccounts: collection('corporate_accounts'), auditLog: collection('audit_log'),
    roamingRates: collection('roaming_rates'), b2bContracts: collection('b2b_contracts')
  });
  return { data, svc };
}

// ═══════════════════════════════════════════════════════════════════════════
// RUBRIC TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Rubric: 5 pillars total 100 points', () => {
  const total = Object.values(RUBRIC_PILLARS).reduce((s, p) => s + p.maxScore, 0);
  assert.equal(total, 100);
});

test('Rubric: scores validate correctly', () => {
  const r = validateRubricScores({
    equipment_modernity: 20, hygiene_ventilation: 22,
    safety_emergency: 18, staff_professionalism: 15, digital_connectivity: 8
  });
  assert.ok(r.valid);
  assert.equal(r.total, 83);
});

test('Rubric: score exceeds max for a pillar is rejected', () => {
  const r = validateRubricScores({
    equipment_modernity: 30, // max is 25
    hygiene_ventilation: 20, safety_emergency: 18,
    staff_professionalism: 15, digital_connectivity: 8
  });
  assert.ok(!r.valid);
});

test('Rubric: tier assignment from score', () => {
  assert.equal(assignTierFromScore(95), 'luxury_executive');
  assert.equal(assignTierFromScore(90), 'luxury_executive');
  assert.equal(assignTierFromScore(80), 'premium');
  assert.equal(assignTierFromScore(75), 'premium');
  assert.equal(assignTierFromScore(65), 'midtier');
  assert.equal(assignTierFromScore(60), 'midtier');
  assert.equal(assignTierFromScore(55), 'standard');
  assert.equal(assignTierFromScore(0), 'standard');
});

test('Score gym rubric updates tier and logs audit', () => {
  const { data, svc } = setup();
  const r = svc.scoreGymRubric({
    gymId: 'gym_001',
    scores: { equipment_modernity: 22, hygiene_ventilation: 23, safety_emergency: 18, staff_professionalism: 17, digital_connectivity: 9 },
    scoredBy: 'admin_user'
  });
  assert.ok(r.ok);
  assert.equal(r.rubric.totalScore, 89);
  assert.equal(r.newTier, 'premium'); // 89 ≥ 75 → premium
  assert.equal(r.tierChanged, true); // was standard, now premium
  // Audit log entries
  assert.ok(data.audit_log.length >= 1);
  // Gym record updated
  const gym = data.gyms.find(g => g.id === 'gym_001');
  assert.equal(gym.verifiedScore, 89);
  assert.equal(gym.verifiedClassification, 'premium');
});

test('Score gym rubric: non-existent gym rejected', () => {
  const { svc } = setup();
  assert.ok(!svc.scoreGymRubric({ gymId: 'gym_x', scores: {} }).ok);
});

test('Get gym rubric returns pillars + current score', () => {
  const { svc } = setup();
  const r = svc.getGymRubric('gym_002');
  assert.ok(r);
  assert.equal(r.currentTier, 'luxury_executive');
  assert.equal(r.currentScore, 95);
  assert.equal(r.pillars.length, 5);
});

test('Get rubric pillars returns all 5', () => {
  const { svc } = setup();
  const pillars = svc.getRubricPillars();
  assert.equal(pillars.length, 5);
  assert.ok(pillars.find(p => p.id === 'equipment_modernity'));
});

// ═══════════════════════════════════════════════════════════════════════════
// ROAMING RATES TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Set roaming rates for a gym', () => {
  const { svc } = setup();
  const r = svc.setRoamingRates({
    gymId: 'gym_001',
    dailyScanFee: 15000, weeklyPassFee: 50000,
    monthlyPassFee: 100000, commissionRate: 0.12,
    adminId: 'admin'
  });
  assert.ok(r.ok);
  assert.equal(r.rates.dailyScanFee, 15000);
  assert.equal(r.rates.commissionRate, 0.12);
});

test('Get roaming rates uses defaults if not set', () => {
  const { svc } = setup();
  const r = svc.getRoamingRates('gym_001');
  assert.equal(r.dailyScanFee, ROAMING_DEFAULTS.daily_scan_fee);
  assert.equal(r.commissionRate, ROAMING_DEFAULTS.commission_rate);
});

test('Commission rate outside 10-25% is rejected', () => {
  const { svc } = setup();
  assert.ok(!svc.setRoamingRates({ gymId: 'gym_001', commissionRate: 0.05 }).ok);
  assert.ok(!svc.setRoamingRates({ gymId: 'gym_001', commissionRate: 0.30 }).ok);
  assert.ok(svc.setRoamingRates({ gymId: 'gym_001', commissionRate: 0.10 }).ok);
  assert.ok(svc.setRoamingRates({ gymId: 'gym_001', commissionRate: 0.25 }).ok);
});

// ═══════════════════════════════════════════════════════════════════════════
// COMMISSION RATE MANAGEMENT TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Set commission rate for a gym', () => {
  const { data, svc } = setup();
  const r = svc.setCommissionRate({ entityType: 'gym', entityId: 'gym_001', commissionRate: 0.18, adminId: 'admin' });
  assert.ok(r.ok);
  assert.equal(r.previousRate, undefined); // gym_001 had no commissionRate before
  assert.equal(r.newRate, 0.18);
  assert.equal(data.gyms.find(g => g.id === 'gym_001').commissionRate, 0.18);
});

test('Set commission rate for a trainer', () => {
  const { data, svc } = setup();
  const r = svc.setCommissionRate({ entityType: 'trainer', entityId: 'tr_001', commissionRate: 0.20, adminId: 'admin' });
  assert.ok(r.ok);
  assert.equal(data.trainers.find(t => t.id === 'tr_001').commissionRate, 0.20);
});

test('Invalid entity type rejected', () => {
  const { svc } = setup();
  assert.ok(!svc.setCommissionRate({ entityType: 'invalid', entityId: 'x', commissionRate: 0.15 }).ok);
});

// ═══════════════════════════════════════════════════════════════════════════
// B2B CONTRACT TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Create a B2B contract', () => {
  const { svc } = setup();
  const r = svc.createContract({
    corporateAccountId: 'crp_001',
    contractName: 'CRDB Wellness 2026',
    seatLimit: 500,
    perSeatCap: 350000,
    domainWhitelist: ['@crdbbank.co.tz'],
    endDate: '2026-12-31',
    adminId: 'admin'
  });
  assert.ok(r.ok);
  assert.equal(r.contract.status, CONTRACT_STATUS.DRAFT);
  assert.equal(r.contract.seatLimit, 500);
});

test('Activate a contract (draft → active)', () => {
  const { svc } = setup();
  const { contract } = svc.createContract({ corporateAccountId: 'crp_001', adminId: 'admin' });
  const r = svc.activateContract(contract.id, 'admin');
  assert.ok(r.ok);
  assert.equal(r.contract.status, CONTRACT_STATUS.ACTIVE);
  assert.ok(r.contract.signedAt);
});

test('Cannot activate already-active contract', () => {
  const { svc } = setup();
  const { contract } = svc.createContract({ corporateAccountId: 'crp_001', adminId: 'admin' });
  svc.activateContract(contract.id, 'admin');
  const r = svc.activateContract(contract.id, 'admin');
  assert.ok(!r.ok);
});

test('Terminate a contract', () => {
  const { svc } = setup();
  const { contract } = svc.createContract({ corporateAccountId: 'crp_001', adminId: 'admin' });
  svc.activateContract(contract.id, 'admin');
  const r = svc.terminateContract(contract.id, 'admin', 'Not renewed');
  assert.ok(r.ok);
  assert.equal(r.contract.status, CONTRACT_STATUS.TERMINATED);
  assert.equal(r.contract.terminationReason, 'Not renewed');
});

test('List contracts with status filter', () => {
  const { svc } = setup();
  svc.createContract({ corporateAccountId: 'crp_001', adminId: 'admin' });
  const { contract: c2 } = svc.createContract({ corporateAccountId: 'crp_001', adminId: 'admin' });
  svc.activateContract(c2.id, 'admin');
  const drafts = svc.listContracts({ status: CONTRACT_STATUS.DRAFT });
  const actives = svc.listContracts({ status: CONTRACT_STATUS.ACTIVE });
  assert.equal(drafts.length, 1);
  assert.equal(actives.length, 1);
});

test('Get contract with company name', () => {
  const { svc } = setup();
  const { contract } = svc.createContract({ corporateAccountId: 'crp_001', adminId: 'admin' });
  const c = svc.getContract(contract.id);
  assert.ok(c);
  assert.equal(c.companyName, 'CRDB Bank');
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT LOG TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Audit log captures rubric scoring', () => {
  const { svc } = setup();
  svc.scoreGymRubric({
    gymId: 'gym_001',
    scores: { equipment_modernity: 20, hygiene_ventilation: 20, safety_emergency: 18, staff_professionalism: 15, digital_connectivity: 8 },
    scoredBy: 'admin_user'
  });
  const log = svc.getAuditLog({ target: 'gym_001' });
  assert.ok(log.length >= 1);
  assert.ok(log.some(l => l.action === AUDIT_ACTIONS.RUBRIC_SCORED));
});

test('Audit log filters by action type', () => {
  const { svc } = setup();
  svc.setRoamingRates({ gymId: 'gym_001', adminId: 'admin' });
  const log = svc.getAuditLog({ action: AUDIT_ACTIONS.ROAMING_RATE_UPDATED });
  assert.ok(log.length >= 1);
  assert.equal(log[0].action, AUDIT_ACTIONS.ROAMING_RATE_UPDATED);
});

test('Audit log count', () => {
  const { svc } = setup();
  svc.scoreGymRubric({ gymId: 'gym_001', scores: { equipment_modernity: 20, hygiene_ventilation: 20, safety_emergency: 18, staff_professionalism: 15, digital_connectivity: 8 }, scoredBy: 'admin' });
  svc.setRoamingRates({ gymId: 'gym_001', adminId: 'admin' });
  assert.ok(svc.getAuditLogCount() >= 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// VETTING QUEUES TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Pending gyms queue shows unverified gyms', () => {
  const { svc } = setup();
  const list = svc.getPendingGyms();
  assert.equal(list.length, 1); // gym_001 is unverified, gym_002 is verified
  assert.equal(list[0].id, 'gym_001');
});

test('Pending trainers queue shows unverified trainers', () => {
  const { svc } = setup();
  const list = svc.getPendingTrainers();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'tr_001');
});

test('Pending vendors queue shows pending vendors', () => {
  const { svc } = setup();
  const list = svc.getPendingVendors();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ven_001');
});

test('Pending corporates queue shows pending accounts', () => {
  const { svc } = setup();
  const list = svc.getPendingCorporates();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'crp_001');
});

// ═══════════════════════════════════════════════════════════════════════════
// PITCH DECK TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Pitch deck returns 6 slides', () => {
  const { svc } = setup();
  const slides = svc.getPitchDeck();
  assert.equal(slides.length, 6);
  assert.equal(slides[0].title, 'The Problem');
  assert.equal(slides[1].title, 'The Solution');
  assert.equal(slides[5].title, 'Technology & Platform');
});

test('Pitch deck slides have required fields', () => {
  for (const slide of PITCH_DECK_SLIDES) {
    assert.ok(slide.id);
    assert.ok(slide.title);
    assert.ok(slide.bullets);
    assert.ok(slide.bullets.length >= 3);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PLATFORM OVERVIEW TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Platform overview shows correct counts', () => {
  const { svc } = setup();
  const overview = svc.getPlatformOverview();
  assert.equal(overview.gyms.total, 2);
  assert.equal(overview.gyms.verified, 1);
  assert.equal(overview.gyms.pending, 1);
  assert.equal(overview.trainers.total, 1);
  assert.equal(overview.vendors.pending, 1);
  assert.equal(overview.corporates.pending, 1);
  assert.ok(overview.auditLogCount >= 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Tier thresholds are correct', () => {
  assert.equal(TIER_THRESHOLDS.luxury_executive.min, 90);
  assert.equal(TIER_THRESHOLDS.premium.min, 75);
  assert.equal(TIER_THRESHOLDS.midtier.min, 60);
  assert.equal(TIER_THRESHOLDS.standard.min, 0);
});

test('Commission range is 10-25%', () => {
  assert.equal(COMMISSION_RANGE.min, 0.10);
  assert.equal(COMMISSION_RANGE.max, 0.25);
  assert.equal(COMMISSION_RANGE.default, 0.15);
});

test('Contract status values', () => {
  assert.equal(CONTRACT_STATUS.DRAFT, 'draft');
  assert.equal(CONTRACT_STATUS.ACTIVE, 'active');
  assert.equal(CONTRACT_STATUS.TERMINATED, 'terminated');
  assert.equal(CONTRACT_STATUS.EXPIRED, 'expired');
});

test('Roaming defaults are set', () => {
  assert.ok(ROAMING_DEFAULTS.daily_scan_fee > 0);
  assert.ok(ROAMING_DEFAULTS.weekly_pass_fee > 0);
  assert.ok(ROAMING_DEFAULTS.monthly_pass_fee > 0);
});

test('Audit action types include key events', () => {
  assert.ok(AUDIT_ACTIONS.GYM_TIER_CHANGED);
  assert.ok(AUDIT_ACTIONS.RUBRIC_SCORED);
  assert.ok(AUDIT_ACTIONS.VENDOR_APPROVED);
  assert.ok(AUDIT_ACTIONS.CONTRACT_SIGNED);
});
