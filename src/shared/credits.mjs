// FitFlex Credits Wallet rules — pure logic.
// 90-day rolling expiry: clock RESETS on any top-up.
// ⛔ OI-009: forfeiture enforcement is BLOCKED until legal T&C is finalized.
//   We compute "isExpired" but callers must NOT zero out balances yet.

import { CREDITS_ROLLING_EXPIRY_DAYS, PER_VISIT_RATES_TZS } from './constants.mjs';

const DAY_MS = 86_400_000;

export function expiresAt(lastTopUpAt) {
  return new Date(+new Date(lastTopUpAt) + CREDITS_ROLLING_EXPIRY_DAYS * DAY_MS);
}

export function isExpired(wallet, now = new Date()) {
  if (!wallet?.lastTopUpAt) return false;
  return now >= expiresAt(wallet.lastTopUpAt);
}

export function applyTopUp(wallet, amountTzs, now = new Date()) {
  if (amountTzs <= 0) throw new Error('Top-up amount must be > 0');
  return {
    ...wallet,
    balanceTzs: (wallet?.balanceTzs ?? 0) + amountTzs,
    lastTopUpAt: now.toISOString(),
    expiresAt: expiresAt(now).toISOString()
  };
}

export function deductionForRoamingVisit(gymTier) {
  const rate = PER_VISIT_RATES_TZS[gymTier];
  if (rate == null) throw new Error(`Unknown gym tier: ${gymTier}`);
  return rate;
}

export function applyDeduction(wallet, amountTzs) {
  if (amountTzs <= 0) throw new Error('Deduction must be > 0');
  if ((wallet?.balanceTzs ?? 0) < amountTzs) {
    return { ok: false, reason: 'insufficient_balance' };
  }
  return { ok: true, wallet: { ...wallet, balanceTzs: wallet.balanceTzs - amountTzs } };
}
