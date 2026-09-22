// Unit tests for the trainer payout calculation logic.
// Run with: node --test specs/trainer-payout.specs.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTrainerPayout, TRAINER_COMMISSION_RANGE } from '../src/shared/trainer-constants.mjs';

// ─── Payout Formula Tests ──────────────────────────────────────────────────

test('Straight commission — 15% rate', () => {
  // Session TZS 50,000, trainer 15% commission
  // commission = 50,000 * 0.15 = 7,500
  // trainerPayout = 50,000 - 7,500 = 42,500
  const result = calculateTrainerPayout({ sessionPrice: 50000, commissionRate: 0.15 });
  assert.equal(result.sessionPrice, 50000);
  assert.equal(result.commissionAmount, 7500);
  assert.equal(result.trainerPayout, 42500);
  assert.equal(result.fitflexNet, 7500);
  assert.equal(result.currency, 'TZS');
});

test('Straight commission — 20% rate', () => {
  // Session TZS 60,000, trainer 20% commission
  // commission = 60,000 * 0.20 = 12,000
  // trainerPayout = 60,000 - 12,000 = 48,000
  const result = calculateTrainerPayout({ sessionPrice: 60000, commissionRate: 0.20 });
  assert.equal(result.commissionAmount, 12000);
  assert.equal(result.trainerPayout, 48000);
  assert.equal(result.fitflexNet, 12000);
});

test('Throws on invalid session price', () => {
  assert.throws(() => calculateTrainerPayout({ sessionPrice: -1, commissionRate: 0.15 }));
  assert.throws(() => calculateTrainerPayout({ sessionPrice: 'abc', commissionRate: 0.15 }));
});

test('Throws on commission rate below minimum (15%)', () => {
  assert.throws(() => calculateTrainerPayout({ sessionPrice: 50000, commissionRate: 0.05 }));
  assert.throws(() => calculateTrainerPayout({ sessionPrice: 50000, commissionRate: -0.05 }));
});

test('Throws on commission rate above maximum (20%)', () => {
  assert.throws(() => calculateTrainerPayout({ sessionPrice: 50000, commissionRate: 0.30 }));
});

test('Currency is always TZS', () => {
  const result = calculateTrainerPayout({ sessionPrice: 50000, commissionRate: 0.15 });
  assert.equal(result.currency, 'TZS');
});

test('Commission range is 15-20%', () => {
  assert.equal(TRAINER_COMMISSION_RANGE.min, 0.15);
  assert.equal(TRAINER_COMMISSION_RANGE.max, 0.20);
  assert.equal(TRAINER_COMMISSION_RANGE.default, 0.15);
});

test('Edge case: session price of 0', () => {
  const result = calculateTrainerPayout({ sessionPrice: 0, commissionRate: 0.15 });
  assert.equal(result.commissionAmount, 0);
  assert.equal(result.trainerPayout, 0);
});
