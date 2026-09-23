// Unit tests for the corporate seat-billing and telemetry calculations.
// Run with: node --test specs/corporate-billing.specs.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBill, calculateAbsenteeismDrop, calculateEngagementRate,
  SUBSIDY_MODELS, ENGAGEMENT_TARGET_PCT,
} from '../src/shared/corporate-constants.mjs';

const base = { perSeatMonthlyTzs: 120_000, seatCount: 100, billingCycle: 'monthly' };

test('fully funded — employer pays the whole gross', () => {
  const bill = calculateBill({ ...base, subsidyModel: 'fully_funded' });
  assert.equal(bill.grossTzs, 12_000_000);
  assert.equal(bill.employerTzs, 12_000_000);
  assert.equal(bill.employeeTzs, 0);
  assert.equal(bill.currency, 'TZS');
});

test('50/50 co-pay splits the gross evenly', () => {
  const bill = calculateBill({ ...base, subsidyModel: 'copay_50_50' });
  assert.equal(bill.employerTzs, 6_000_000);
  assert.equal(bill.employeeTzs, 6_000_000);
});

test('70/30 co-pay puts 70% on the employer', () => {
  const bill = calculateBill({ ...base, subsidyModel: 'copay_70_30' });
  assert.equal(bill.employerTzs, 8_400_000);
  assert.equal(bill.employeeTzs, 3_600_000);
});

test('employee paid — employer owes nothing', () => {
  const bill = calculateBill({ ...base, subsidyModel: 'employee_paid' });
  assert.equal(bill.employerTzs, 0);
  assert.equal(bill.employeeTzs, 12_000_000);
});

test('shares always reconcile to the gross', () => {
  for (const subsidyModel of Object.keys(SUBSIDY_MODELS)) {
    // An odd seat count forces the rounding path in the co-pay models.
    const bill = calculateBill({ ...base, seatCount: 77, subsidyModel });
    assert.equal(bill.employerTzs + bill.employeeTzs, bill.grossTzs, subsidyModel);
  }
});

test('quarterly and annual cycles scale the gross by months', () => {
  const quarterly = calculateBill({ ...base, subsidyModel: 'fully_funded', billingCycle: 'quarterly' });
  const annually = calculateBill({ ...base, subsidyModel: 'fully_funded', billingCycle: 'annually' });
  assert.equal(quarterly.months, 3);
  assert.equal(quarterly.grossTzs, 36_000_000);
  assert.equal(annually.grossTzs, 144_000_000);
});

test('zero seats bills nothing', () => {
  const bill = calculateBill({ ...base, seatCount: 0, subsidyModel: 'fully_funded' });
  assert.equal(bill.grossTzs, 0);
  assert.equal(bill.employerTzs, 0);
});

test('rejects unknown subsidy model, cycle and malformed inputs', () => {
  assert.throws(() => calculateBill({ ...base, subsidyModel: 'nope' }), /subsidy model/);
  assert.throws(() => calculateBill({ ...base, subsidyModel: 'fully_funded', billingCycle: 'weekly' }), /billing cycle/);
  assert.throws(() => calculateBill({ ...base, subsidyModel: 'fully_funded', seatCount: 1.5 }), /seat count/);
  assert.throws(() => calculateBill({ ...base, subsidyModel: 'fully_funded', perSeatMonthlyTzs: -1 }), /per-seat/);
});

test('absenteeism drop is 3 points per weekly visit, capped at 30%', () => {
  assert.deepEqual(calculateAbsenteeismDrop({ avgVisitsPerWeek: 2, baselineSickDays: 10 }), {
    dropPct: 6, estimatedDaysReduced: 1,
  });
  assert.equal(calculateAbsenteeismDrop({ avgVisitsPerWeek: 20, baselineSickDays: 10 }).dropPct, 30);
});

test('absenteeism drop is zero without visits', () => {
  assert.deepEqual(calculateAbsenteeismDrop({ avgVisitsPerWeek: 0 }), { dropPct: 0, estimatedDaysReduced: 0 });
  assert.deepEqual(calculateAbsenteeismDrop({ avgVisitsPerWeek: undefined }), { dropPct: 0, estimatedDaysReduced: 0 });
});

test('engagement rate is a percentage of provisioned seats', () => {
  assert.equal(calculateEngagementRate({ activeCount: 75, totalCount: 100 }), ENGAGEMENT_TARGET_PCT);
  assert.equal(calculateEngagementRate({ activeCount: 1, totalCount: 3 }), 33);
  assert.equal(calculateEngagementRate({ activeCount: 0, totalCount: 0 }), 0);
});
