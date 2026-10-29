// Partner progress (Phase B · B4a): the pure builder. One tracker of steps
// registered → approved → verified → payoutReady for gym owners, trainers and
// vendors, from approvalStatus, the KYC case/checklist and payout eligibility.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProgress, buildGymOwnerProgress, checklistForGym, payoutStep, PROGRESS_STEPS, NEXT_ACTIONS, BLOCKED_REASONS,
} from '../src/shared/partner-progress.mjs';

const CREATED = '2026-10-01T08:00:00.000Z';
const DECIDED = '2026-10-05T10:00:00.000Z';
const user = (userType, extra = {}) => ({ id: 'u1', userType, approvalStatus: 'approved', accountStatus: 'active', createdAt: CREATED, ...extra });
const kyc = (status, extra = {}) => ({ id: 'kyc1', status, ...extra });
const NOT_STARTED = { ok: false, reason: 'kyc_not_started' };
const states = p => Object.fromEntries(p.steps.map(s => [s.key, s.state]));
const ALL_STATES = new Set(['done', 'current', 'todo', 'blocked']);

/** Every progress has the four steps in order, valid states, one current, and a known action. */
function assertShape(p) {
  assert.deepEqual(p.steps.map(s => s.key), PROGRESS_STEPS);
  for (const s of p.steps) assert.ok(ALL_STATES.has(s.state), s.state);
  assert.ok(PROGRESS_STEPS.includes(p.current));
  assert.ok(NEXT_ACTIONS.includes(p.nextAction.code), p.nextAction.code);
  assert.ok(p.steps.filter(s => s.state === 'current').length <= 1);
  for (const s of p.steps) if (s.state === 'blocked') assert.ok(BLOCKED_REASONS.includes(s.reason), s.reason);
  // Nothing free-text leaves the builder.
  assert.ok(!JSON.stringify(p).match(/note/i), 'no notes in progress');
}

// ── Trainer (approved at sign-up; verified by KYC) ──────────────────────────

test('trainer with no case: approved, verification is current with the missing items', () => {
  const p = buildProgress({ user: user('trainer'), checklist: { missing: ['identity.fullName', 'settlement.payout_account'] }, eligibility: NOT_STARTED });
  assertShape(p);
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'current', payoutReady: 'todo' });
  assert.equal(p.current, 'verified');
  assert.deepEqual(p.nextAction, { code: 'complete_kyc_items', missing: ['identity.fullName', 'settlement.payout_account'] });
  assert.equal(p.steps[0].at, CREATED);
  assert.equal(p.steps[1].at, undefined);
});

test('trainer draft with nothing missing: submit', () => {
  const p = buildProgress({ user: user('trainer'), kycCase: kyc('draft'), checklist: { missing: [] }, eligibility: { ok: false, reason: 'kyc_draft' } });
  assertShape(p);
  assert.deepEqual(p.nextAction, { code: 'submit_kyc' });
});

test('trainer submitted or in review: under review', () => {
  for (const status of ['submitted', 'in_review']) {
    const p = buildProgress({ user: user('trainer'), kycCase: kyc(status), checklist: { missing: [] }, eligibility: { ok: false, reason: `kyc_${status}` } });
    assertShape(p);
    assert.equal(p.current, 'verified');
    assert.deepEqual(p.nextAction, { code: 'kyc_under_review' });
  }
});

test('trainer asked for changes: reason code and missing items, never the note', () => {
  const p = buildProgress({
    user: user('trainer'), kycCase: kyc('info_requested', { reasonCode: 'document_unreadable', reasonNote: 'Admin-only remark' }),
    checklist: { missing: ['documents.certification'] }, eligibility: { ok: false, reason: 'kyc_info_requested' },
  });
  assertShape(p);
  assert.deepEqual(p.nextAction, { code: 'kyc_changes_requested', reasonCode: 'document_unreadable', missing: ['documents.certification'] });
  assert.ok(!JSON.stringify(p).includes('Admin-only'));
});

test('trainer verified, no payout account: add one', () => {
  const p = buildProgress({
    user: user('trainer'), kycCase: kyc('approved', { decidedAt: DECIDED }), checklist: { missing: [] },
    eligibility: { ok: false, reason: 'payout_account_not_verified' },
  });
  assertShape(p);
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'done', payoutReady: 'current' });
  assert.equal(p.steps[2].at, DECIDED);
  assert.deepEqual(p.nextAction, { code: 'add_payout_account' });
});

test('trainer verified, payout account rejected: add another, saying why', () => {
  const p = buildProgress({
    user: user('trainer'), kycCase: kyc('approved'), settlementAccounts: [{ status: 'rejected' }],
    eligibility: { ok: false, reason: 'payout_account_not_verified' },
  });
  assert.deepEqual(p.nextAction, { code: 'add_payout_account', reason: 'payout_account_rejected' });
});

test('trainer verified, payout account waiting for review', () => {
  const p = buildProgress({
    user: user('trainer'), kycCase: kyc('approved'), settlementAccounts: [{ status: 'rejected' }, { status: 'pending_verification' }],
    eligibility: { ok: false, reason: 'payout_account_not_verified' },
  });
  assert.deepEqual(p.nextAction, { code: 'payout_account_under_review' });
});

test('trainer verified, account in its cooling-off: until when', () => {
  const until = '2026-10-22T10:00:00.000Z';
  const p = buildProgress({
    user: user('trainer'), kycCase: kyc('approved'), settlementAccounts: [{ status: 'verified', isPrimary: true }],
    eligibility: { ok: false, reason: 'payout_account_cooling_off', until },
  });
  assertShape(p);
  assert.equal(p.current, 'payoutReady');
  assert.deepEqual(p.nextAction, { code: 'payout_account_cooling_off', until });
});

test('trainer ready to be paid: every step done, nothing to do', () => {
  const p = buildProgress({ user: user('trainer'), kycCase: kyc('approved'), eligibility: { ok: true, destination: { kind: 'verified_account' } } });
  assertShape(p);
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'done', payoutReady: 'done' });
  assert.equal(p.current, 'payoutReady');
  assert.deepEqual(p.nextAction, { code: 'none' });
  assert.ok(!JSON.stringify(p).includes('destination'), 'payout destination is not echoed');
});

test('trainer suspended: verification and payout blocked', () => {
  const p = buildProgress({ user: user('trainer'), kycCase: kyc('suspended', { reasonCode: 'document_expired' }), eligibility: { ok: false, reason: 'kyc_suspended' } });
  assertShape(p);
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'blocked', payoutReady: 'blocked' });
  assert.equal(p.current, 'verified');
  assert.deepEqual(p.steps[2], { key: 'verified', state: 'blocked', reason: 'kyc_suspended' });
  assert.deepEqual(p.nextAction, { code: 'contact_support', reason: 'kyc_suspended' });
});

test('trainer rejected: the role is blocked by the KYC rejection', () => {
  const p = buildProgress({ user: user('trainer', { approvalStatus: 'rejected', approvalNote: 'secret' }), kycCase: kyc('rejected'), eligibility: { ok: false, reason: 'kyc_rejected' } });
  assertShape(p);
  assert.deepEqual(states(p), { registered: 'done', approved: 'blocked', verified: 'blocked', payoutReady: 'blocked' });
  assert.equal(p.current, 'approved');
  assert.deepEqual(p.nextAction, { code: 'contact_support', reason: 'kyc_rejected' });
  assert.ok(!JSON.stringify(p).includes('secret'));
});

test('trainer with no profile yet: payout not ready, with the reason', () => {
  const r = payoutStep({ ok: false, reason: 'no_trainer_account' });
  assert.deepEqual(r.action, { code: 'payout_not_ready', reason: 'no_trainer_account' });
  assert.equal(r.step.state, 'todo');
});

// ── Vendor (waits for approval, which comes with KYC) ──────────────────────

test('new vendor pending: approval is current and the action is the KYC', () => {
  const p = buildProgress({
    user: user('vendor', { approvalStatus: 'pending_approval' }), checklist: { missing: ['business.legalName'] },
    kycDrivesApproval: true, eligibility: NOT_STARTED,
  });
  assertShape(p);
  assert.deepEqual(states(p), { registered: 'done', approved: 'current', verified: 'todo', payoutReady: 'todo' });
  assert.deepEqual(p.nextAction, { code: 'complete_kyc_items', missing: ['business.legalName'] });
});

test('vendor pending with a submitted case: under review', () => {
  const p = buildProgress({ user: user('vendor', { approvalStatus: 'pending_approval' }), kycCase: kyc('submitted'), kycDrivesApproval: true, eligibility: { ok: false, reason: 'kyc_submitted' } });
  assert.equal(p.current, 'approved');
  assert.deepEqual(p.nextAction, { code: 'kyc_under_review' });
});

test('legacy vendor pending with no case: wait for an admin', () => {
  const p = buildProgress({ user: user('vendor', { approvalStatus: 'pending_approval' }), kycDrivesApproval: false, checklist: { missing: ['x'] }, eligibility: NOT_STARTED });
  assertShape(p);
  assert.deepEqual(p.nextAction, { code: 'wait_for_approval' });
});

test('vendor approved by KYC: approval and verification share the decision time', () => {
  const p = buildProgress({ user: user('vendor'), kycCase: kyc('approved', { decidedAt: DECIDED }), eligibility: { ok: true } });
  assert.equal(p.steps[1].at, DECIDED);
  assert.equal(p.steps[2].at, DECIDED);
  assert.deepEqual(p.nextAction, { code: 'none' });
});

test('vendor rejected as a role (no KYC): role_rejected', () => {
  const p = buildProgress({ user: user('vendor', { approvalStatus: 'rejected' }), kycDrivesApproval: false, eligibility: NOT_STARTED });
  assertShape(p);
  assert.deepEqual(p.steps[1], { key: 'approved', state: 'blocked', reason: 'role_rejected' });
  assert.deepEqual(p.nextAction, { code: 'contact_support', reason: 'role_rejected' });
});

test('account suspended: approval blocked whatever the KYC says', () => {
  const p = buildProgress({ user: user('vendor', { accountStatus: 'suspended' }), kycCase: kyc('approved'), eligibility: { ok: true } });
  assertShape(p);
  assert.deepEqual(states(p), { registered: 'done', approved: 'blocked', verified: 'done', payoutReady: 'done' });
  assert.deepEqual(p.nextAction, { code: 'contact_support', reason: 'account_suspended' });
});

// ── Gym owner (one case, payout per gym) ───────────────────────────────────

test('gym checklist: owner-wide items plus that gym only', () => {
  const checklist = { missing: ['identity.fullName', 'operational.rate_card@g1', 'operational.rate_card@g2'], readyToSubmit: false };
  assert.deepEqual(checklistForGym(checklist, 'g1').missing, ['identity.fullName', 'operational.rate_card@g1']);
  assert.deepEqual(checklistForGym(checklist, 'g2').missing, ['identity.fullName', 'operational.rate_card@g2']);
});

test('gym owner with two gyms in KYC: each gym sees its own missing items, overall sees all', () => {
  const p = buildGymOwnerProgress({
    user: user('gym_operator'), kycCase: kyc('draft'),
    checklist: { missing: ['identity.fullName', 'operational.rate_card@g2'] },
    gyms: [{ gymId: 'g1', name: 'One', eligibility: { ok: false, reason: 'kyc_draft' } }, { gymId: 'g2', name: 'Two', eligibility: { ok: false, reason: 'kyc_draft' } }],
  });
  assertShape(p);
  assert.deepEqual(p.nextAction, { code: 'complete_kyc_items', missing: ['identity.fullName', 'operational.rate_card@g2'] });
  assert.deepEqual(p.gyms.map(g => [g.gymId, g.name, g.progress.nextAction.missing]), [
    ['g1', 'One', ['identity.fullName']], ['g2', 'Two', ['identity.fullName', 'operational.rate_card@g2']],
  ]);
  for (const g of p.gyms) { assertShape(g.progress); assert.equal(g.progress.gyms, undefined); }
});

test('verified gym owner: overall payout waits on the first gym that is not ready, and names it', () => {
  const p = buildGymOwnerProgress({
    user: user('gym_operator'), kycCase: kyc('approved'), checklist: { missing: [] },
    settlementAccounts: [{ status: 'verified', isPrimary: true }],
    gyms: [
      { gymId: 'g1', name: 'One', eligibility: { ok: true } },
      { gymId: 'g2', name: 'Two', eligibility: { ok: false, reason: 'payout_account_cooling_off', until: '2026-10-22T00:00:00.000Z' } },
    ],
  });
  assertShape(p);
  assert.equal(p.current, 'payoutReady');
  assert.deepEqual(p.nextAction, { code: 'payout_account_cooling_off', until: '2026-10-22T00:00:00.000Z', gymId: 'g2' });
  assert.deepEqual(p.gyms.map(g => [g.gymId, g.progress.steps[3].state]), [['g1', 'done'], ['g2', 'current']]);
});

test('every gym ready: overall done', () => {
  const p = buildGymOwnerProgress({
    user: user('gym_operator'), kycCase: kyc('approved'),
    gyms: [{ gymId: 'g1', eligibility: { ok: true } }, { gymId: 'g2', eligibility: { ok: true } }],
  });
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'done', payoutReady: 'done' });
  assert.deepEqual(p.nextAction, { code: 'none' });
});

test('legacy gym inside the payout grace: payoutReady before verified', () => {
  const p = buildGymOwnerProgress({
    user: user('gym_operator'), kycCase: null, checklist: { missing: ['identity.fullName'] }, kycDrivesApproval: false,
    gyms: [{ gymId: 'g1', eligibility: { ok: true, destination: { kind: 'legacy_grace' } } }],
  });
  assertShape(p);
  assert.deepEqual(states(p), { registered: 'done', approved: 'done', verified: 'current', payoutReady: 'done' });
  assert.deepEqual(p.nextAction, { code: 'complete_kyc_items', missing: ['identity.fullName'] });
});

test('verified gym owner with no gym: add a gym', () => {
  const p = buildGymOwnerProgress({ user: user('gym_operator'), kycCase: kyc('approved'), gyms: [] });
  assertShape(p);
  assert.equal(p.current, 'payoutReady');
  assert.deepEqual(p.nextAction, { code: 'add_gym' });
  assert.deepEqual(p.gyms, []);
});

test('suspended gym owner: every gym blocked', () => {
  const p = buildGymOwnerProgress({
    user: user('gym_operator'), kycCase: kyc('suspended'),
    gyms: [{ gymId: 'g1', eligibility: { ok: false, reason: 'kyc_suspended' } }, { gymId: 'g2', eligibility: { ok: false, reason: 'kyc_suspended' } }],
  });
  assertShape(p);
  assert.deepEqual(p.nextAction, { code: 'contact_support', reason: 'kyc_suspended' });
  for (const g of p.gyms) assert.deepEqual(states(g.progress), { registered: 'done', approved: 'done', verified: 'blocked', payoutReady: 'blocked' });
});
