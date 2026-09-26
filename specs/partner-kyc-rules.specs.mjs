// Partner KYC — pure rules: case and settlement-account lifecycles, how a case
// drives the existing approval flag, requirement sets per partner type,
// registry checks and identifier normalisation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARTNER_TYPES, REQUIREMENTS, CASE_STATUSES, canTransitionCase, startsNewRound, approvalStatusForCase,
  partnerTypeForUserType, canTransitionSettlement, isPayable, missingRequirements,
  CHECK_PROVIDERS, providerConfirms, normalizeIdentifier,
} from '../src/shared/partner-kyc.mjs';

// ── Case lifecycle ──────────────────────────────────────────────────────────

test('a case moves draft → submitted → in review → approved', () => {
  assert.ok(canTransitionCase('draft', 'submitted'));
  assert.ok(canTransitionCase('submitted', 'in_review'));
  assert.ok(canTransitionCase('in_review', 'approved'));
});

test('a reviewer can ask for more information, and the partner resubmits', () => {
  assert.ok(canTransitionCase('in_review', 'info_requested'));
  assert.ok(canTransitionCase('info_requested', 'submitted'));
  assert.ok(!canTransitionCase('info_requested', 'approved'));
});

test('nothing skips review', () => {
  for (const from of ['draft', 'submitted', 'info_requested', 'rejected']) {
    assert.ok(!canTransitionCase(from, 'approved'), `${from} → approved must be refused`);
  }
  assert.ok(!canTransitionCase('rejected', 'submitted'));
  assert.ok(!canTransitionCase('nonsense', 'draft'));
});

test('re-verification and restarting after rejection open a new round', () => {
  assert.ok(startsNewRound('rejected', 'draft'));
  assert.ok(startsNewRound('approved', 'submitted'));
  assert.ok(startsNewRound('suspended', 'submitted'));
  assert.ok(!startsNewRound('info_requested', 'submitted'));
  assert.ok(!startsNewRound('draft', 'submitted'));
});

test('the case status drives the approval flag every app already reads', () => {
  assert.equal(approvalStatusForCase('approved'), 'approved');
  assert.equal(approvalStatusForCase('suspended'), 'approved');
  assert.equal(approvalStatusForCase('rejected'), 'rejected');
  for (const s of ['draft', 'submitted', 'in_review', 'info_requested']) {
    assert.equal(approvalStatusForCase(s), 'pending_approval');
  }
  assert.equal(CASE_STATUSES.length, 7);
});

test('partner types map to the existing user roles', () => {
  assert.equal(partnerTypeForUserType('gym_operator'), 'gym_owner');
  assert.equal(partnerTypeForUserType('trainer'), 'trainer');
  assert.equal(partnerTypeForUserType('vendor'), 'vendor');
  assert.equal(partnerTypeForUserType('member'), null);
  assert.equal(partnerTypeForUserType('gym_staff'), null);
});

// ── Settlement accounts ─────────────────────────────────────────────────────

test('a settlement account is verified or rejected once, and disabled for good', () => {
  assert.ok(canTransitionSettlement('pending_verification', 'verified'));
  assert.ok(canTransitionSettlement('pending_verification', 'rejected'));
  assert.ok(canTransitionSettlement('verified', 'disabled'));
  assert.ok(!canTransitionSettlement('rejected', 'verified'));
  assert.ok(!canTransitionSettlement('disabled', 'verified'));
});

test('payouts go only to the verified primary account after its cooling-off period', () => {
  const at = new Date('2026-10-10T12:00:00Z');
  const account = { status: 'verified', isPrimary: true, cooldownUntil: '2026-10-10T10:00:00Z' };
  assert.equal(isPayable(account, at), true);
  assert.equal(isPayable({ ...account, cooldownUntil: '2026-10-11T10:00:00Z' }, at), false);
  assert.equal(isPayable({ ...account, isPrimary: false }, at), false);
  assert.equal(isPayable({ ...account, status: 'pending_verification' }, at), false);
  assert.equal(isPayable(null, at), false);
});

// ── Requirements ────────────────────────────────────────────────────────────

test('every partner type has a requirement set, with canon tiers for owners and trainers', () => {
  for (const type of PARTNER_TYPES) assert.ok(REQUIREMENTS[type], type);
  assert.equal(REQUIREMENTS.gym_owner.tier, 3);
  assert.equal(REQUIREMENTS.trainer.tier, 2);
  assert.ok(REQUIREMENTS.gym_owner.checks.some(c => c.type === 'site_visit' && c.perGym));
  assert.equal(REQUIREMENTS.corporate.settlementAccount, false);
});

test('an empty trainer case is missing everything', () => {
  assert.deepEqual(missingRequirements('trainer', {}), [
    'trainer_id', 'certification', 'liability_insurance', 'settlement_account',
    'agreement:partner_agreement', 'agreement:kyc_consent',
  ]);
});

test('rejected or expired documents do not count; pending and accepted ones do', () => {
  const missing = missingRequirements('trainer', {
    documents: [
      { requirementKey: 'trainer_id', status: 'accepted' },
      { requirementKey: 'certification', status: 'pending' },
      { requirementKey: 'liability_insurance', status: 'expired' },
    ],
    settlementAccounts: [{ status: 'rejected' }],
    agreements: [{ agreementType: 'partner_agreement', status: 'accepted' }, { agreementType: 'kyc_consent', status: 'revoked' }],
  });
  assert.deepEqual(missing, ['liability_insurance', 'settlement_account', 'agreement:kyc_consent']);
});

test('a corporate partner needs no settlement account', () => {
  const missing = missingRequirements('corporate', {});
  assert.ok(!missing.includes('settlement_account'));
  assert.deepEqual(missingRequirements('unknown', {}), []);
});

// ── Registries and identifiers ──────────────────────────────────────────────

test('each registry confirms only its own kind of check', () => {
  assert.deepEqual(Object.keys(CHECK_PROVIDERS), ['nida', 'brela', 'tra']);
  assert.ok(providerConfirms('nida', 'identity'));
  assert.ok(providerConfirms('brela', 'business_registration'));
  assert.ok(providerConfirms('tra', 'tax'));
  assert.ok(!providerConfirms('nida', 'tax'));
  assert.ok(!providerConfirms('selcom', 'identity'));
});

test('identifiers entered in different formats normalise to the same value', () => {
  assert.equal(normalizeIdentifier('123-456 789'), '123456789');
  assert.equal(normalizeIdentifier(' bl/2025.0042 '), 'BL20250042');
  assert.equal(normalizeIdentifier('19900101-12345-00001-12'), '19900101123450000112');
  assert.equal(normalizeIdentifier(''), null);
  assert.equal(normalizeIdentifier(null), null);
});
