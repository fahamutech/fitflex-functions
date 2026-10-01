// Settlement workflow (settlement Phase 4): a statement's path from draft to
// a recorded payout, the payout check, and what the database refuses.
// Database tests run in a transaction that is rolled back.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { createSettlementWorkflowService } from '../src/services/settlement-workflow-service.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import { createFinanceService } from '../src/services/finance-service.mjs';
import { PORTAL_ACL_SCOPES } from '../src/services/portal-user-service.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const ROLLBACK = Symbol('rollback');
async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}
async function rejects(trx, fn, code) {
  await assert.rejects(trx.transaction(fn), (err) => err.code === code, `expected Postgres error ${code}`);
}

// ── the payout check (DR-08) ─────────────────────────────────────────────────

describe('payout eligibility', () => {
  const AT = new Date('2026-12-05T09:00:00.000Z');
  const owner = { id: 'owner-1', userType: 'gym_operator', gymIds: ['gym-1'] };
  const account = (extra = {}) => ({ id: 'acc-1', caseId: 'kyc-1', status: 'verified', isPrimary: true, method: 'mobile_money', provider: 'mpesa',
    accountName: 'Gym One Ltd', accountNumber: '0712345678', cooldownUntil: '2026-12-01T00:00:00.000Z', ...extra });
  const build = ({ kyc = { id: 'kyc-1', status: 'approved' }, accounts = [account()], exempt = false, graceEndsAt = null, gym = { id: 'gym-1' }, owners = [owner] } = {}) =>
    createPayoutEligibility({
      users: { findAsync: async (f) => owners.find(f) ?? null },
      gyms: { find: (f) => [gym].find(f) },
      partnerGate: { kycCaseFor: async () => kyc, exempt: () => exempt },
      partnerSettlementAccounts: { filterByColumnAsync: async () => accounts },
      legacyKycGraceEndsAt: graceEndsAt,
    });

  test('KYC approved and a verified primary account past its cooling-off: payable, with a masked destination', async () => {
    const r = await build().forGym('gym-1', { at: AT });
    assert.equal(r.ok, true);
    assert.deepEqual(r.destination, { kind: 'verified_account', ownerId: 'owner-1', kycCaseId: 'kyc-1', accountId: 'acc-1', method: 'mobile_money',
      provider: 'mpesa', accountName: 'Gym One Ltd', accountLast4: '5678' });
  });
  test('an account still cooling off, or none verified, is not payable', async () => {
    const cooling = await build({ accounts: [account({ cooldownUntil: '2026-12-06T00:00:00.000Z' })] }).forGym('gym-1', { at: AT });
    assert.deepEqual(cooling, { ok: false, reason: 'payout_account_cooling_off', until: '2026-12-06T00:00:00.000Z' });
    assert.deepEqual(await build({ accounts: [account({ status: 'pending_verification', isPrimary: false })] }).forGym('gym-1', { at: AT }), { ok: false, reason: 'payout_account_not_verified' });
    assert.deepEqual(await build({ accounts: [] }).forGym('gym-1', { at: AT }), { ok: false, reason: 'payout_account_not_verified' });
  });
  test('KYC not approved: the reason says where it stands', async () => {
    assert.deepEqual(await build({ kyc: null }).forGym('gym-1', { at: AT }), { ok: false, reason: 'kyc_not_started' });
    assert.deepEqual(await build({ kyc: { id: 'k', status: 'in_review' } }).forGym('gym-1', { at: AT }), { ok: false, reason: 'kyc_in_review' });
    assert.deepEqual(await build({ owners: [] }).forGym('gym-1', { at: AT }), { ok: false, reason: 'no_owner_account' });
  });
  test('a legacy partner is not exempt unless a grace end date is configured', async () => {
    const legacy = { kyc: null, exempt: true, gym: { id: 'gym-1', paymentBank: 'M-Pesa', paymentNumber: '0755000111' } };
    assert.deepEqual(await build(legacy).forGym('gym-1', { at: AT }), { ok: false, reason: 'kyc_not_started' });
  });
  test('inside the configured grace a legacy partner is paid to the gym\'s recorded details; after it, not', async () => {
    const legacy = { kyc: null, exempt: true, gym: { id: 'gym-1', paymentBank: 'M-Pesa', paymentNumber: '0755000111' }, graceEndsAt: '2026-12-31T21:00:00.000Z' };
    const inGrace = await build(legacy).forGym('gym-1', { at: AT });
    assert.deepEqual(inGrace, { ok: true, destination: { kind: 'legacy_grace', ownerId: 'owner-1', provider: 'M-Pesa', accountLast4: '0111', graceEndsAt: '2026-12-31T21:00:00.000Z' } });
    assert.deepEqual(await build(legacy).forGym('gym-1', { at: new Date('2026-12-31T21:00:00.000Z') }), { ok: false, reason: 'kyc_not_started' });
    assert.deepEqual(await build({ ...legacy, gym: { id: 'gym-1' } }).forGym('gym-1', { at: AT }), { ok: false, reason: 'legacy_payout_details_missing' });
    // The grace is for legacy partners only.
    assert.deepEqual(await build({ ...legacy, exempt: false }).forGym('gym-1', { at: AT }), { ok: false, reason: 'kyc_not_started' });
  });
});

test('preparing, approving and paying are separate grantable scopes', () => {
  for (const scope of ['settlements_prepare', 'settlements_approve', 'settlements_pay']) assert.ok(PORTAL_ACL_SCOPES.includes(scope), scope);
});

// ── the workflow ─────────────────────────────────────────────────────────────

const DESTINATION = { kind: 'verified_account', ownerId: 'owner-1', accountId: 'acc-1', method: 'mobile_money', provider: 'mpesa', accountLast4: '5678' };

/** A live statement of a locked run (or a shadow / unlocked one), and a workflow whose payout check the test controls. */
async function setup(trx, { mode = 'live', locked = true, amounts = { preliminaryTzs: 40000, networkAdjustmentTzs: -5000, finalNetTzs: 35000 }, start = '2026-11-01', end = '2026-12-01' } = {}) {
  const gymId = uid('gym');
  await trx('Gym').insert({ id: gymId, name: 'Workflow Gym', tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
  const run = { id: uid('run'), mode, periodStartDate: start, periodEndDate: end, status: 'draft', engineVersion: 'settlement-engine/1', createdBy: 'system' };
  await trx('SettlementRun').insert(run);
  const statement = { id: uid('gs'), runId: run.id, mode, gymId, periodStartDate: start, periodEndDate: end, memberCycleCount: 3, qualifyingVisitCount: 15, ...amounts };
  await trx('GymSettlement').insert(statement);
  if (locked) await trx('SettlementRun').where({ id: run.id }).update({ status: 'locked', lockedAt: new Date(), lockedBy: 'system', inputsHash: 'sha256:test' });
  const check = { result: { ok: true, destination: DESTINATION } };
  const workflow = createSettlementWorkflowService({ db: trx, payoutEligibility: { forGym: async () => check.result }, now: () => new Date('2026-12-05T09:00:00.000Z') });
  return { gymId, run, id: statement.id, workflow, check };
}

test('a statement goes draft → submitted → approved → payable → paid, and paying records one payout', () => inRollback(async (trx) => {
  const { id, gymId, workflow } = await setup(trx);
  assert.equal((await workflow.submit({ id, actorId: 'maker' })).statement.status, 'submitted');
  const approved = await workflow.approve({ id, actorId: 'checker' });
  assert.deepEqual([approved.statement.status, approved.statement.submittedBy, approved.statement.approvedBy], ['approved', 'maker', 'checker']);
  const payable = await workflow.markPayable({ id, actorId: 'payer' });
  assert.equal(payable.statement.status, 'payable');
  assert.deepEqual(payable.statement.destinationSnapshot, DESTINATION);
  assert.ok(payable.statement.payableAt);

  const paid = await workflow.pay({ id, paymentReference: ' MPESA-QK7H2L9 ', receiptUrl: 'https://x/receipt.png', actorId: 'payer' });
  assert.deepEqual([paid.statement.status, paid.statement.paidBy, paid.statement.paymentReference, paid.statement.receiptUrl], ['paid', 'payer', 'MPESA-QK7H2L9', 'https://x/receipt.png']);
  const payouts = await trx('GymPayout').where({ gymSettlementId: id });
  assert.equal(payouts.length, 1);
  assert.deepEqual([payouts[0].gymId, payouts[0].amount, payouts[0].status, payouts[0].reference, payouts[0].gymSettlementMode, payouts[0].periodStart],
    [gymId, 35000, 'paid', 'MPESA-QK7H2L9', 'live', '2026-11-01']);

  // A paid statement is final.
  assert.equal((await workflow.pay({ id, paymentReference: 'again', actorId: 'payer' })).error, 'invalid_status');
  assert.equal((await workflow.hold({ id, reason: 'late dispute', actorId: 'maker' })).error, 'invalid_status');
  assert.equal((await trx('GymPayout').where({ gymSettlementId: id })).length, 1);

  const audit = (await trx('AuditLog').where({ target: id }).orderBy('at')).map((a) => a.action).sort();
  assert.deepEqual(audit, ['settlement_approved', 'settlement_paid', 'settlement_payable', 'settlement_submitted']);
}));

test('maker-checker: the submitter can\'t approve, whoever they are', () => inRollback(async (trx) => {
  const { id, workflow } = await setup(trx);
  await workflow.submit({ id, actorId: 'super-admin' });
  assert.deepEqual(await workflow.approve({ id, actorId: 'super-admin' }), { error: 'cannot_approve_own_submission', status: 403 });
  assert.equal((await workflow.approve({ id, actorId: 'someone-else' })).statement.status, 'approved');
  assert.equal((await workflow.submit({ id })).error, 'actor_required');
  // The database refuses it as well.
  const other = await setup(trx, { start: '2026-12-01', end: '2027-01-01' });
  await other.workflow.submit({ id: other.id, actorId: 'maker' });
  await rejects(trx, (t) => t('GymSettlement').where({ id: other.id }).update({ status: 'approved', approvedBy: 'maker', approvedAt: new Date() }), '23514');
}));

test('a rejected statement goes back to draft with the reason, and can be submitted again', () => inRollback(async (trx) => {
  const { id, workflow } = await setup(trx);
  await workflow.submit({ id, actorId: 'maker' });
  assert.equal((await workflow.reject({ id, reason: '  ', actorId: 'checker' })).error, 'reason_required');
  const back = await workflow.reject({ id, reason: 'Visit count looks wrong', actorId: 'checker' });
  assert.deepEqual([back.statement.status, back.statement.rejectReason, back.statement.rejectedBy, back.statement.submittedBy], ['draft', 'Visit count looks wrong', 'checker', null]);
  const again = await workflow.submit({ id, actorId: 'maker' });
  assert.deepEqual([again.statement.status, again.statement.rejectReason], ['submitted', null]);
  assert.equal((await workflow.reject({ id: 'nope', reason: 'x', actorId: 'c' })).error, 'statement_not_found');
}));

test('only live statements of a locked run enter the workflow; steps can\'t be skipped', () => inRollback(async (trx) => {
  const shadow = await setup(trx, { mode: 'shadow' });
  assert.equal((await shadow.workflow.submit({ id: shadow.id, actorId: 'maker' })).error, 'shadow_statement');
  const open = await setup(trx, { locked: false, start: '2026-12-01', end: '2027-01-01' });
  assert.equal((await open.workflow.submit({ id: open.id, actorId: 'maker' })).error, 'run_not_locked');

  const { id, workflow } = await setup(trx, { start: '2027-01-01', end: '2027-02-01' });
  assert.equal((await workflow.approve({ id, actorId: 'checker' })).error, 'invalid_status');
  assert.equal((await workflow.markPayable({ id, actorId: 'payer' })).error, 'invalid_status');
  assert.equal((await workflow.pay({ id, paymentReference: 'x', actorId: 'payer' })).error, 'invalid_status');
  // Nor directly in the database.
  await rejects(trx, (t) => t('GymSettlement').where({ id }).update({ status: 'paid', paidAt: new Date(), paidBy: 'p', paymentReference: 'r', approvedBy: 'a' }), 'P0001');
}));

test('a hold blocks payment, pulls a payable statement back, and releasing it doesn\'t pay by itself', () => inRollback(async (trx) => {
  const { id, workflow } = await setup(trx);
  await workflow.submit({ id, actorId: 'maker' });
  await workflow.approve({ id, actorId: 'checker' });
  assert.equal((await workflow.hold({ id, actorId: 'maker' })).error, 'reason_required');
  const held = await workflow.hold({ id, reason: 'Gym disputes two visits', actorId: 'maker' });
  assert.deepEqual([held.statement.status, held.statement.holdReason, held.statement.heldBy], ['approved', 'Gym disputes two visits', 'maker']);
  assert.deepEqual(await workflow.markPayable({ id, actorId: 'payer' }), { error: 'on_hold', status: 409, holdReason: 'Gym disputes two visits' });

  const released = await workflow.release({ id, actorId: 'checker' });
  assert.deepEqual([released.statement.status, released.statement.holdReason, released.statement.heldAt], ['approved', null, null]);
  assert.equal((await workflow.release({ id, actorId: 'checker' })).error, 'not_on_hold');

  await workflow.markPayable({ id, actorId: 'payer' });
  const pulled = await workflow.hold({ id, reason: 'Bank details changed', actorId: 'maker' });
  assert.deepEqual([pulled.statement.status, pulled.statement.destinationSnapshot, pulled.statement.payableAt], ['approved', null, null]);
  assert.equal((await workflow.pay({ id, paymentReference: 'x', actorId: 'payer' })).error, 'invalid_status');
  // The database won't hold a payable statement either.
  await workflow.release({ id, actorId: 'checker' });
  await workflow.markPayable({ id, actorId: 'payer' });
  await rejects(trx, (t) => t('GymSettlement').where({ id }).update({ holdReason: 'x', heldAt: new Date() }), '23514');
}));

test('the payout check gates "payable" and runs again at payment', () => inRollback(async (trx) => {
  const { id, workflow, check } = await setup(trx);
  await workflow.submit({ id, actorId: 'maker' });
  await workflow.approve({ id, actorId: 'checker' });
  check.result = { ok: false, reason: 'kyc_in_review' };
  assert.deepEqual(await workflow.markPayable({ id, actorId: 'payer' }), { error: 'not_payable', status: 409, reason: 'kyc_in_review' });
  check.result = { ok: false, reason: 'payout_account_cooling_off', until: '2026-12-06T00:00:00.000Z' };
  assert.deepEqual(await workflow.markPayable({ id, actorId: 'payer' }), { error: 'not_payable', status: 409, reason: 'payout_account_cooling_off', until: '2026-12-06T00:00:00.000Z' });

  check.result = { ok: true, destination: DESTINATION };
  await workflow.markPayable({ id, actorId: 'payer' });
  assert.equal((await workflow.pay({ id, paymentReference: '', actorId: 'payer' })).error, 'payment_reference_required');
  check.result = { ok: false, reason: 'kyc_suspended' };   // the owner was suspended after the statement was cleared
  assert.deepEqual(await workflow.pay({ id, paymentReference: 'MPESA-1', actorId: 'payer' }), { error: 'not_payable', status: 409, reason: 'kyc_suspended' });
  assert.equal((await trx('GymPayout').where({ gymSettlementId: id })).length, 0);
  assert.equal((await trx('GymSettlement').where({ id }).first()).status, 'payable');
}));

test('a statement with nothing to pay can\'t be made payable', () => inRollback(async (trx) => {
  const { id, workflow } = await setup(trx, { amounts: { preliminaryTzs: 12000, finalNetTzs: 12000 } });
  const { adjustment } = await workflow.proposeAdjustment({ statementId: id, amountTzs: -20000, type: 'clawback', reason: 'Visits voided after payment', actorId: 'maker' });
  await workflow.decideAdjustment({ id: adjustment.id, decision: 'apply', actorId: 'checker' });
  await workflow.submit({ id, actorId: 'maker' });
  await workflow.approve({ id, actorId: 'checker' });
  assert.equal((await workflow.markPayable({ id, actorId: 'payer' })).error, 'nothing_to_pay');
}));

test('the engine\'s figures freeze when the run locks; adjustments can still change a draft, never a submitted statement', () => inRollback(async (trx) => {
  const { id, workflow } = await setup(trx);
  await rejects(trx, (t) => t('GymSettlement').where({ id }).update({ preliminaryTzs: 50000, finalNetTzs: 45000 }), 'P0001');
  await rejects(trx, (t) => t('GymSettlement').where({ id }).update({ qualifyingVisitCount: 99 }), 'P0001');
  await trx('GymSettlement').where({ id }).update({ adjustmentsTzs: -5000, finalNetTzs: 30000 });   // a draft's adjustment total may change
  await workflow.submit({ id, actorId: 'maker' });   // (submit re-totals from the applied adjustments: none here)
  await rejects(trx, (t) => t('GymSettlement').where({ id }).update({ adjustmentsTzs: -1000, finalNetTzs: 34000 }), 'P0001');
}));

test('statements are listed by status and gym; shadow ones only when asked for', () => inRollback(async (trx) => {
  const a = await setup(trx);
  const shadow = await setup(trx, { mode: 'shadow', start: '2026-12-01', end: '2027-01-01' });
  await a.workflow.submit({ id: a.id, actorId: 'maker' });
  const submitted = await a.workflow.list({ status: 'submitted', gymId: a.gymId });
  assert.deepEqual(submitted.map((s) => s.id), [a.id]);
  assert.equal((await a.workflow.list({ gymId: shadow.gymId })).length, 0);
  assert.deepEqual((await a.workflow.list({ gymId: shadow.gymId, mode: 'shadow' })).map((s) => s.id), [shadow.id]);
}));

// ── book-keeping ─────────────────────────────────────────────────────────────

test('book-keeping shows settlement payouts as gym payouts, without double-counting legacy invoices', async () => {
  const mem = (rows = []) => ({ rows, find: (f) => rows.find(f), filter: (f) => rows.filter(f), filterAsync: async (f) => rows.filter(f),
    filterByColumnAsync: async (c, v) => rows.filter((r) => r[c] === v), filterByColumnInAsync: async (c, vs) => rows.filter((r) => vs.includes(r[c])) });
  const finance = createFinanceService({
    gyms: mem([{ id: 'g1', name: 'Gym One' }]), checkins: mem(), users: mem(), settingsService: {},
    invoices: mem([{ id: 'inv1', gymId: 'g1', gymName: 'Gym One', status: 'paid', amount: 9000, paidAt: '2026-10-02T00:00:00Z' }]),
    gymPayouts: mem([
      { id: 'po-legacy', gymId: 'g1', invoiceId: 'inv1', amount: 9000, status: 'paid', paidAt: '2026-10-02T00:00:00Z' },
      { id: 'po-new', gymId: 'g1', gymSettlementId: 'gs1', amount: 35000, status: 'paid', periodStart: '2026-11-01', periodEnd: '2026-12-01', paidAt: '2026-12-05T09:00:00Z', reference: 'MPESA-1' },
      { id: 'po-failed', gymId: 'g1', gymSettlementId: 'gs2', amount: 1, status: 'failed' },
    ]),
  });
  const entries = await finance.bookKeeping({ paymentRequests: mem() });
  assert.deepEqual(entries.map((e) => [e.id, e.type, e.amount]), [['po-new', 'expense', 35000], ['inv1', 'expense', 9000]]);
  assert.equal(entries[0].description, 'Gym settlement — Gym One (2026-11-01 – 2026-12-01)');
});
