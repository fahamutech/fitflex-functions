// Trainer pricing — Tech Brief §4 calculation order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceSession, priceBooking, passDiscountPct, trainerCommissionPct } from '../src/shared/trainer-pricing.mjs';

test('no pass: commission on the full price', () => {
  const p = priceSession({ listPrice: 50_000, discountPct: 0, commissionPct: 15 });
  assert.equal(p.memberPrice, 50_000);
  assert.equal(p.commission, 7_500);
  assert.equal(p.trainerPayout, 42_500);
});

test('Pro pass: 10% off first, then 15% commission on the discounted price', () => {
  const p = priceSession({ listPrice: 50_000, discountPct: passDiscountPct('pro'), commissionPct: 15 });
  assert.equal(p.discount, 5_000);
  assert.equal(p.memberPrice, 45_000);
  assert.equal(p.commission, 6_750);
  assert.equal(p.trainerPayout, 38_250);
});

test('pass discounts follow PASS_TIERS', () => {
  assert.equal(passDiscountPct('basic'), 0);
  assert.equal(passDiscountPct('premium'), 20);
  assert.equal(passDiscountPct('executive'), 20);
  assert.equal(passDiscountPct(null), 0);
});

test('commission defaults to 15% and is clamped to the 15–20% band', () => {
  assert.equal(trainerCommissionPct({}), 15);
  assert.equal(trainerCommissionPct({ commissionPct: 18 }), 18);
  assert.equal(trainerCommissionPct({ commissionPct: 40 }), 20);
  assert.equal(trainerCommissionPct({ commissionPct: 5 }), 15);
});

test('multi-slot totals multiply the per-session price', () => {
  const b = priceBooking({ listPrice: 30_000, slotCount: 3, discountPct: 20, commissionPct: 15 });
  assert.equal(b.memberTotal, 72_000);
  assert.equal(b.discountTotal, 18_000);
  assert.equal(b.commissionTotal, 10_800);
  assert.equal(b.trainerPayoutTotal, 61_200);
});
