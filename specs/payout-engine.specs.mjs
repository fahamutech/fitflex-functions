import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayout, bandFor } from '../src/shared/payout-engine.mjs';

test('Band 1 (0-49): 25% commission, 30-day delay', () => {
  const r = calculatePayout({ visitCount: 10, gymTier: 'standard' });
  assert.equal(r.band, 1);
  assert.equal(r.commissionPct, 25);
  assert.equal(r.gross, 35_000);   // 10 × 3,500 default gym payout (not the 5,000 member price)
  assert.equal(r.commission, 8_750);
  assert.equal(r.net, 26_250);
  assert.equal(r.payoutDelayDays, 30);
});

test('Band 3 (150-299): 15%, 7-day', () => {
  const r = calculatePayout({ visitCount: 200, gymTier: 'midtier' });
  assert.equal(r.band, 3);
  assert.equal(r.gross, 200 * 6_000);
  assert.equal(r.commissionPct, 15);
  assert.equal(r.payoutDelayDays, 7);
});

test('Band 4 (300-499): 10%, instant', () => {
  const r = calculatePayout({ visitCount: 300, gymTier: 'premium' });
  assert.equal(r.band, 4);
  assert.equal(r.payoutDelayDays, 0);
  assert.equal(r.commissionPct, 10);
});

test('Band 5 (500+): flat fee replaces per-visit', () => {
  const r = calculatePayout({ visitCount: 600, gymTier: 'standard', flatMonthlyFee: 2_500_000 });
  assert.equal(r.band, 5);
  assert.equal(r.flatFee, true);
  assert.equal(r.commissionPct, 0);
  assert.equal(r.net, 2_500_000);
});

test('Band 5 without flatMonthlyFee throws (renegotiation trigger)', () => {
  assert.throws(() => calculatePayout({ visitCount: 600, gymTier: 'standard' }), /renegotiation/);
});

test('Negotiated per-visit rate overrides indicative tier rate', () => {
  const r = calculatePayout({ visitCount: 100, gymTier: 'standard', negotiatedPerVisitRate: 6_000 });
  assert.equal(r.gross, 600_000);
});

test('bandFor boundary: exactly 50 = band 2, 49 = band 1', () => {
  assert.equal(bandFor(49).band, 1);
  assert.equal(bandFor(50).band, 2);
  assert.equal(bandFor(499).band, 4);
  assert.equal(bandFor(500).band, 5);
});
