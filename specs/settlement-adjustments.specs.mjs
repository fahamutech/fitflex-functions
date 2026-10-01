// Adjustments and carry-forward (settlement Phase 4, PR B; DR-20): a signed
// correction on a draft statement, proposed by one person and applied by
// another; the net never negative; a shortfall carried into the gym's next
// statement once. Database tests run in a transaction that is rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { createSettlementWorkflowService } from '../src/services/settlement-workflow-service.mjs';

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

const workflowOn = (trx) => createSettlementWorkflowService({
  db: trx, now: () => new Date('2026-12-05T09:00:00.000Z'),
  payoutEligibility: { forGym: async () => ({ ok: true, destination: { kind: 'verified_account', accountLast4: '5678' } }) },
});

async function makeGym(trx) {
  const gymId = uid('gym');
  await trx('Gym').insert({ id: gymId, name: 'Adjustment Gym', tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
  return gymId;
}

/** A live draft statement of a locked run for `gymId` and month. */
async function statement(trx, gymId, { start, end, preliminaryTzs = 40000, mode = 'live' }) {
  const run = { id: uid('run'), mode, periodStartDate: start, periodEndDate: end, status: 'draft', engineVersion: 'settlement-engine/1', createdBy: 'system' };
  await trx('SettlementRun').insert(run);
  const id = uid('gs');
  await trx('GymSettlement').insert({ id, runId: run.id, mode, gymId, periodStartDate: start, periodEndDate: end, preliminaryTzs, finalNetTzs: preliminaryTzs });
  await trx('SettlementRun').where({ id: run.id }).update({ status: 'locked', lockedAt: new Date(), lockedBy: 'system', inputsHash: 'sha256:test' });
  return id;
}
const NOV = { start: '2026-11-01', end: '2026-12-01' };
const DEC = { start: '2026-12-01', end: '2027-01-01' };
const JAN = { start: '2027-01-01', end: '2027-02-01' };

test('an adjustment changes nothing until someone else applies it; then the net follows', () => inRollback(async (trx) => {
  const workflow = workflowOn(trx);
  const id = await statement(trx, await makeGym(trx), NOV);
  const { adjustment } = await workflow.proposeAdjustment({ statementId: id, amountTzs: -3500, type: 'clawback', reason: ' Visit voided after last month was paid ', sourceCheckinId: 'chk_1', actorId: 'maker' });
  assert.deepEqual([adjustment.status, adjustment.reason, adjustment.createdBy], ['proposed', 'Visit voided after last month was paid', 'maker']);
  assert.equal((await trx('GymSettlement').where({ id }).first()).finalNetTzs, 40000);

  assert.deepEqual(await workflow.decideAdjustment({ id: adjustment.id, decision: 'apply', actorId: 'maker' }), { error: 'cannot_approve_own_adjustment', status: 403 });
  const applied = await workflow.decideAdjustment({ id: adjustment.id, decision: 'apply', actorId: 'checker' });
  assert.deepEqual([applied.adjustment.status, applied.adjustment.approvedBy, applied.statement.adjustmentsTzs, applied.statement.finalNetTzs, applied.statement.carryForwardTzs],
    ['applied', 'checker', -3500, 36500, 0]);
  assert.ok(applied.adjustment.appliedAt);

  // A positive correction too; both add up.
  const plus = (await workflow.proposeAdjustment({ statementId: id, amountTzs: 2000, type: 'correction', reason: 'Missed visit confirmed', actorId: 'maker' })).adjustment;
  const after = await workflow.decideAdjustment({ id: plus.id, decision: 'apply', actorId: 'checker' });
  assert.deepEqual([after.statement.adjustmentsTzs, after.statement.finalNetTzs], [-1500, 38500]);
  assert.equal((await workflow.decideAdjustment({ id: plus.id, decision: 'apply', actorId: 'checker' })).error, 'invalid_status');   // only once

  const actions = (await trx('AuditLog').whereIn('target', [adjustment.id, plus.id])).map((a) => a.action).sort();
  assert.deepEqual(actions, ['settlement_adjustment_applied', 'settlement_adjustment_applied', 'settlement_adjustment_proposed', 'settlement_adjustment_proposed']);
}));

test('bad or late adjustments are refused', () => inRollback(async (trx) => {
  const workflow = workflowOn(trx);
  const gymId = await makeGym(trx);
  const id = await statement(trx, gymId, NOV);
  const propose = (extra) => workflow.proposeAdjustment({ statementId: id, amountTzs: -1000, type: 'correction', reason: 'x', actorId: 'maker', ...extra });
  assert.equal((await propose({ amountTzs: 0 })).error, 'amount_must_be_whole_nonzero_tzs');
  assert.equal((await propose({ amountTzs: 10.5 })).error, 'amount_must_be_whole_nonzero_tzs');
  assert.equal((await propose({ type: 'clawback', amountTzs: 500 })).error, 'clawback_must_be_negative');
  assert.equal((await propose({ type: 'carry_forward' })).error, 'invalid_adjustment_type');   // only the system carries forward
  assert.equal((await propose({ reason: ' ' })).error, 'reason_required');
  assert.equal((await propose({ statementId: 'nope' })).error, 'statement_not_found');
  const shadow = await statement(trx, gymId, { ...DEC, mode: 'shadow' });
  assert.equal((await propose({ statementId: shadow })).error, 'shadow_statement');

  // A proposed adjustment blocks submitting; rejecting it (with a reason) clears the way.
  const { adjustment } = await propose();
  assert.equal((await workflow.submit({ id, actorId: 'maker' })).error, 'pending_adjustments');
  assert.equal((await workflow.decideAdjustment({ id: adjustment.id, decision: 'reject', actorId: 'checker' })).error, 'reason_required');
  const rejected = await workflow.decideAdjustment({ id: adjustment.id, decision: 'reject', reason: 'Already corrected', actorId: 'checker' });
  assert.deepEqual([rejected.adjustment.status, rejected.adjustment.rejectReason, rejected.statement.finalNetTzs], ['rejected', 'Already corrected', 40000]);
  await workflow.submit({ id, actorId: 'maker' });
  // Once submitted the statement is frozen: nothing more can be proposed.
  assert.equal((await propose()).error, 'invalid_status');
}));

test('DR-20: the net never goes below zero; the shortfall is carried into the gym\'s next statement, once', () => inRollback(async (trx) => {
  const workflow = workflowOn(trx);
  const gymId = await makeGym(trx);
  const nov = await statement(trx, gymId, { ...NOV, preliminaryTzs: 12000 });
  const { adjustment } = await workflow.proposeAdjustment({ statementId: nov, amountTzs: -20000, type: 'clawback', reason: 'Visits voided after October was paid', actorId: 'maker' });
  const applied = await workflow.decideAdjustment({ id: adjustment.id, decision: 'apply', actorId: 'checker' });
  assert.deepEqual([applied.statement.finalNetTzs, applied.statement.carryForwardTzs], [0, -8000]);
  await workflow.submit({ id: nov, actorId: 'maker' });

  // December: 40,000 earned, less the 8,000 still owed.
  const dec = await statement(trx, gymId, DEC);
  const submitted = await workflow.submit({ id: dec, actorId: 'maker' });
  assert.deepEqual([submitted.statement.adjustmentsTzs, submitted.statement.finalNetTzs, submitted.statement.carryForwardTzs], [-8000, 32000, 0]);
  const carry = await trx('SettlementAdjustment').where({ gymSettlementId: dec, type: 'carry_forward' });
  assert.equal(carry.length, 1);
  assert.deepEqual([carry[0].amountTzs, carry[0].sourceSettlementId, carry[0].status, carry[0].createdBy, carry[0].approvedBy], [-8000, nov, 'applied', 'system:carry-forward', 'maker']);

  // January doesn't take November's shortfall again.
  const jan = await statement(trx, gymId, JAN);
  const next = await workflow.submit({ id: jan, actorId: 'maker' });
  assert.deepEqual([next.statement.adjustmentsTzs, next.statement.finalNetTzs], [0, 40000]);
  // The database allows one carry per source statement.
  await rejects(trx, (t) => t('SettlementAdjustment').insert({ id: uid('adj'), gymSettlementId: jan, amountTzs: -8000, type: 'carry_forward', reason: 'again',
    status: 'applied', sourceSettlementId: nov, createdBy: 'system:carry-forward', approvedBy: 'maker', approvedAt: new Date() }), '23505');
}));

test('a shortfall bigger than the next month keeps rolling forward; another gym is never charged for it', () => inRollback(async (trx) => {
  const workflow = workflowOn(trx);
  const gymId = await makeGym(trx);
  const otherGym = await makeGym(trx);
  const nov = await statement(trx, gymId, { ...NOV, preliminaryTzs: 5000 });
  const a = (await workflow.proposeAdjustment({ statementId: nov, amountTzs: -60000, type: 'clawback', reason: 'A month of visits voided', actorId: 'maker' })).adjustment;
  await workflow.decideAdjustment({ id: a.id, decision: 'apply', actorId: 'checker' });
  await workflow.submit({ id: nov, actorId: 'maker' });   // owes 55,000

  const dec = await statement(trx, gymId, DEC);           // earns 40,000
  const decSubmitted = await workflow.submit({ id: dec, actorId: 'maker' });
  assert.deepEqual([decSubmitted.statement.finalNetTzs, decSubmitted.statement.carryForwardTzs], [0, -15000]);

  const jan = await statement(trx, gymId, JAN);           // earns 40,000, less the remaining 15,000
  const janSubmitted = await workflow.submit({ id: jan, actorId: 'maker' });
  assert.deepEqual([janSubmitted.statement.adjustmentsTzs, janSubmitted.statement.finalNetTzs, janSubmitted.statement.carryForwardTzs], [-15000, 25000, 0]);

  const other = await statement(trx, otherGym, { start: '2027-02-01', end: '2027-03-01' });
  assert.equal((await workflow.submit({ id: other, actorId: 'maker' })).statement.finalNetTzs, 40000);
}));

test('a shortfall on a statement still in draft is not carried yet', () => inRollback(async (trx) => {
  const workflow = workflowOn(trx);
  const gymId = await makeGym(trx);
  const nov = await statement(trx, gymId, { ...NOV, preliminaryTzs: 12000 });
  const a = (await workflow.proposeAdjustment({ statementId: nov, amountTzs: -20000, type: 'clawback', reason: 'Under review', actorId: 'maker' })).adjustment;
  await workflow.decideAdjustment({ id: a.id, decision: 'apply', actorId: 'checker' });   // November stays a draft
  const dec = await statement(trx, gymId, DEC);
  assert.equal((await workflow.submit({ id: dec, actorId: 'maker' })).statement.finalNetTzs, 40000);
  assert.equal((await trx('SettlementAdjustment').where({ gymSettlementId: dec })).length, 0);
}));
