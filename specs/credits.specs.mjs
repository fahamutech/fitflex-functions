import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTopUp, applyDeduction, isExpired, deductionForRoamingVisit } from '../src/shared/credits.mjs';

test('Top-up resets the 90-day rolling expiry', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date('2026-02-01T00:00:00Z');
  let w = applyTopUp({ balanceTzs: 0 }, 50_000, t0);
  assert.equal(w.balanceTzs, 50_000);
  const exp0 = w.expiresAt;
  w = applyTopUp(w, 10_000, t1);
  assert.equal(w.balanceTzs, 60_000);
  assert.notEqual(w.expiresAt, exp0); // expiry advanced
});

test('Wallet expires 90 days after last top-up', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const w = applyTopUp({}, 1_000, t0);
  const day89 = new Date('2026-03-31T00:00:00Z');
  const day91 = new Date('2026-04-02T00:00:00Z');
  assert.equal(isExpired(w, day89), false);
  assert.equal(isExpired(w, day91), true);
});

test('Deduction fails on insufficient balance', () => {
  const w = { balanceTzs: 1_000 };
  const r = applyDeduction(w, 5_000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_balance');
});

test('Per-visit roaming deduction by gym tier', () => {
  assert.equal(deductionForRoamingVisit('standard'), 5_000);
  assert.equal(deductionForRoamingVisit('midtier'),  8_000);
  assert.equal(deductionForRoamingVisit('premium'),  13_000);
});
