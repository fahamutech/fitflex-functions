// Trainer pricing. Whoever sponsors a discount absorbs it: the trainer is
// paid on their full price unless they fund the discount themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceSession, priceBooking, passDiscountPct, trainerCommissionPct } from '../src/shared/trainer-pricing.mjs';

test('no pass: commission on the full price', () => {
  const p = priceSession({ listPrice: 50_000, discountPct: 0, commissionPct: 15 });
  assert.equal(p.memberPrice, 50_000);
  assert.equal(p.commission, 7_500);
  assert.equal(p.trainerPayout, 42_500);
});

test('Pro pass: the member pays 10% less, FitFlex funds it, and the trainer earns as if there were no discount', () => {
  const p = priceSession({ listPrice: 50_000, discountPct: passDiscountPct('pro'), commissionPct: 15 });
  assert.equal(p.discount, 5_000);
  assert.equal(p.memberPrice, 45_000);
  assert.equal(p.discountFundedBy, 'fitflex');
  assert.equal(p.commission, 7_500);
  assert.equal(p.trainerPayout, 42_500);
});

test('a sponsor-funded discount also leaves the trainer whole; no discount records no funder', () => {
  const sponsored = priceSession({ listPrice: 50_000, discountPct: 100, commissionPct: 15, discountFundedBy: 'sponsor' });
  assert.deepEqual([sponsored.memberPrice, sponsored.trainerPayout, sponsored.discountFundedBy], [0, 42_500, 'sponsor']);
  assert.equal(priceSession({ listPrice: 50_000, commissionPct: 15 }).discountFundedBy, null);
});

test('a discount the trainer funds comes out of the trainer\'s side', () => {
  const p = priceSession({ listPrice: 50_000, discountPct: 10, commissionPct: 15, discountFundedBy: 'trainer' });
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
  // 20% off is FitFlex's: commission and payout stay on the full 30,000.
  assert.equal(b.commissionTotal, 13_500);
  assert.equal(b.trainerPayoutTotal, 76_500);
});
