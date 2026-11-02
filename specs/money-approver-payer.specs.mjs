// Phase 1 slice A: refund scopes split (REFUND_SPLIT_SCOPES) and approver != payer on payout statements
// (STATEMENT_PAY_SECOND_PERSON). Both flags default off.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { users } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { PORTAL_ACL_SCOPES } from '../src/services/portal-user-service.mjs';
import { createSettlementWorkflowService } from '../src/services/settlement-workflow-service.mjs';
import { createStatementWorkflow } from '../src/services/partner-statement-workflow.mjs';
import * as refunds from '../functions/refunds.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test('refunds_approve and refunds_pay are grantable scopes', () => {
  for (const s of ['refunds_approve', 'refunds_pay']) assert.ok(PORTAL_ACL_SCOPES.includes(s), s);
});

// ── route guards ─────────────────────────────────────────────────────────────

const created = [];
after(async () => { if (created.length) await db('User').whereIn('id', created).del(); });
async function staff(aclPermissions, portalUser = true) {
  const id = uid('usr_ma');
  created.push(id);
  await users.upsertAsync(u => u.id === id, {
    id, userType: 'admin', email: `${id}@example.com`, displayName: id, accountStatus: 'active', approvalStatus: 'approved',
    onboardingCompleted: true, portalUser, aclPermissions, createdAt: new Date().toISOString(),
  });
  return sign({ sub: id, userType: 'admin', portalUser, aclPermissions });
}
async function reaches(ep, token) {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { method: String(ep.method).toUpperCase(), headers: { authorization: `Bearer ${token}` }, params: {}, query: {}, body: {} };
  for (const guard of [ep.onGuard].flat()) {
    let ok = false;
    await guard(req, res, () => { ok = true; });
    if (!ok) return { passed: false, status: res.statusCode, error: res.body?.error };
  }
  return { passed: true };
}
const DECIDE = ['adminDecideRefund', 'adminDecideRefundBatch'];
const PAY = ['adminMarkRefundPaid', 'adminMarkRefundBatchPaid'];

test('flag OFF: `payments` opens decide and pay as before; scope-less staff and the new scopes alone do not', async () => {
  await withEnv({ REFUND_SPLIT_SCOPES: undefined }, async () => {
    const payments = await staff(['payments']);
    const none = await staff([]);
    const newOnly = await staff(['refunds_approve', 'refunds_pay']);
    for (const name of [...DECIDE, ...PAY]) {
      assert.equal((await reaches(refunds[name], payments)).passed, true, name);
      const r = await reaches(refunds[name], none);
      assert.deepEqual([r.passed, r.status, r.error], [false, 403, 'acl_forbidden'], name);
      assert.equal((await reaches(refunds[name], newOnly)).passed, false, `${name} newOnly`);
    }
  });
});

test('flag ON: decide needs refunds_approve, pay needs refunds_pay; payments alone is refused; list/raise stay on payments', async () => {
  await withEnv({ REFUND_SPLIT_SCOPES: '1' }, async () => {
    const payments = await staff(['payments']);
    const approver = await staff(['refunds_approve']);
    const payer = await staff(['refunds_pay']);
    const superAdmin = await staff([], false);
    for (const name of DECIDE) {
      assert.equal((await reaches(refunds[name], payments)).passed, false, `${name} payments`);
      assert.equal((await reaches(refunds[name], payer)).passed, false, `${name} payer`);
      assert.equal((await reaches(refunds[name], approver)).passed, true, `${name} approver`);
      assert.equal((await reaches(refunds[name], superAdmin)).passed, true, `${name} super`);
    }
    for (const name of PAY) {
      const r = await reaches(refunds[name], payments);
      assert.deepEqual([r.passed, r.status, r.error], [false, 403, 'acl_forbidden'], `${name} payments`);
      assert.equal((await reaches(refunds[name], approver)).passed, false, `${name} approver`);
      assert.equal((await reaches(refunds[name], payer)).passed, true, `${name} payer`);
      assert.equal((await reaches(refunds[name], superAdmin)).passed, true, `${name} super`);
    }
    for (const name of ['adminListRefunds', 'adminRaiseRefund']) {
      assert.equal((await reaches(refunds[name], payments)).passed, true, `${name} payments`);
      assert.equal((await reaches(refunds[name], approver)).passed, false, `${name} approver`);
    }
  });
});

// ── approver != payer on statements ──────────────────────────────────────────

const ROLLBACK = Symbol('rollback');
async function inRollback(fn) {
  try { await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; }); } catch (err) { if (err !== ROLLBACK) throw err; }
}
const DEST = { kind: 'verified_account', accountId: 'acc-1', method: 'mobile_money', accountLast4: '5678' };
const NOW = () => new Date('2026-12-05T09:00:00.000Z');

async function gymStatement(trx) {
  const gymId = uid('gym');
  await trx('Gym').insert({ id: gymId, name: 'Pay Gym', tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
  const run = { id: uid('run'), mode: 'live', periodStartDate: '2026-11-01', periodEndDate: '2026-12-01', status: 'draft', engineVersion: 'settlement-engine/1', createdBy: 'system' };
  await trx('SettlementRun').insert(run);
  const id = uid('gs');
  await trx('GymSettlement').insert({ id, runId: run.id, mode: 'live', gymId, periodStartDate: '2026-11-01', periodEndDate: '2026-12-01', memberCycleCount: 3, qualifyingVisitCount: 15, preliminaryTzs: 40000, networkAdjustmentTzs: -5000, finalNetTzs: 35000 });
  await trx('SettlementRun').where({ id: run.id }).update({ status: 'locked', lockedAt: new Date(), lockedBy: 'system', inputsHash: 'sha256:test' });
  const workflow = createSettlementWorkflowService({ db: trx, payoutEligibility: { forGym: async () => ({ ok: true, destination: DEST }) }, now: NOW });
  return { id, workflow };
}
async function partnerStatement(trx, table, keyCol, lineTable, lineKey, auditPrefix) {
  const id = uid('ps');
  await trx(table).insert({ id, [keyCol]: uid('p'), periodStartDate: '2026-11-02', periodEndDate: '2026-11-08', finalNetTzs: 20000 });
  const workflow = createStatementWorkflow({ db: trx, now: NOW, table, lineTable, lineKey, auditPrefix, payoutCheck: async () => ({ ok: true, destination: DEST }) });
  return { id, workflow };
}
const cases = {
  gym: gymStatement,
  trainer: (trx) => partnerStatement(trx, 'TrainerSettlement', 'trainerId', 'TrainerSettlementLine', 'trainerSettlementId', 'trainer_settlement'),
  vendor: (trx) => partnerStatement(trx, 'VendorSettlement', 'vendorId', 'VendorSettlementLine', 'vendorSettlementId', 'vendor_settlement'),
};
async function toPayable({ id, workflow }) {
  await workflow.submit({ id, actorId: 'maker' });
  const approved = await workflow.approve({ id, actorId: 'checker' });
  assert.equal(approved.statement.status, 'approved');
  assert.equal((await workflow.markPayable({ id, actorId: 'payer' })).statement.status, 'payable');
}

for (const [kind, build] of Object.entries(cases)) {
  test(`${kind}: flag OFF the approver can also pay`, () => inRollback(async (trx) => {
    await withEnv({ STATEMENT_PAY_SECOND_PERSON: undefined }, async () => {
      const s = await build(trx);
      await toPayable(s);
      const paid = await s.workflow.pay({ id: s.id, paymentReference: 'REF-1', actorId: 'checker' });
      assert.equal(paid.statement.status, 'paid');
      assert.equal(paid.statement.paidBy, 'checker');
    });
  }));

  test(`${kind}: flag ON the approver is refused, a different admin pays`, () => inRollback(async (trx) => {
    await withEnv({ STATEMENT_PAY_SECOND_PERSON: '1' }, async () => {
      const s = await build(trx);
      await toPayable(s);
      assert.deepEqual(await s.workflow.pay({ id: s.id, paymentReference: 'REF-1', actorId: 'checker' }), { error: 'cannot_pay_own_approval', status: 403 });
      const still = await trx(kind === 'gym' ? 'GymSettlement' : kind === 'trainer' ? 'TrainerSettlement' : 'VendorSettlement').where({ id: s.id }).first();
      assert.equal(still.status, 'payable');
      const paid = await s.workflow.pay({ id: s.id, paymentReference: 'REF-1', actorId: 'payer' });
      assert.equal(paid.statement.status, 'paid');
      assert.equal(paid.statement.paidBy, 'payer');
    });
  }));
}

// ── legacy statements with no recorded approver ──────────────────────────────

for (const kind of ['gym', 'trainer', 'vendor']) {
  test(`${kind}: flag ON a payable statement with no approvedBy is refused 409 approver_unknown; flag OFF it can be paid`, async () => {
    const table = kind === 'gym' ? 'GymSettlement' : kind === 'trainer' ? 'TrainerSettlement' : 'VendorSettlement';
    // A paid gym statement must have an approver (DB check), so only the refusal is exercised for gym.
    for (const [flag, expectPaid] of kind === 'gym' ? [['1', false]] : [['1', false], [undefined, true]]) {
      await inRollback(async (trx) => withEnv({ STATEMENT_PAY_SECOND_PERSON: flag }, async () => {
        const s = await cases[kind](trx);
        await toPayable(s);
        await trx.raw(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
        await trx(table).where({ id: s.id }).update({ approvedBy: null });
        await trx.raw(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
        const r = await s.workflow.pay({ id: s.id, paymentReference: 'REF-L', actorId: 'anyone' });
        if (expectPaid) assert.equal(r.statement.status, 'paid');
        else {
          assert.deepEqual(r, { error: 'approver_unknown', status: 409 });
          assert.equal((await trx(table).where({ id: s.id }).first()).status, 'payable');
        }
      }));
    }
  });
}

// ── the pay routes take the actor from the token, never the body ─────────────

test('gym, trainer and vendor pay routes take the actor from the token only: a body actorId is ignored', async () => {
  const gym = await import('../functions/admin-settlements.mjs');
  const trainer = await import('../functions/trainer-settlements.mjs');
  const vendor = await import('../functions/vendor-settlements.mjs');
  for (const ep of [gym.adminPayStatement, trainer.adminPayTrainerSettlement, vendor.adminPayVendorSettlement]) {
    assert.ok(ep, 'route found');
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    // No signed-in actor on the request. If the body could name the actor, this would get past actor_required.
    await ep.onRequest({ params: { id: 'nope' }, user: {}, body: { actorId: 'spoofed', approvedBy: 'spoofed', paymentReference: 'R' } }, res);
    assert.deepEqual([res.code, res.body?.error], [403, 'actor_required'], ep.path);
  }
});

// ── raise is tied to approve under REFUND_SPLIT_SCOPES ───────────────────────

import { createRefundService } from '../src/services/refund-service.mjs';
function memStore(rows = []) {
  return {
    rows,
    async allAsync() { return [...rows]; },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async filterByColumnAsync(col, value) { return rows.filter(r => r[col] === value); },
    async filterAsync(fn) { return rows.filter(fn); },
    async filterByColumnInAsync(col, ids) { return rows.filter(r => ids.includes(r[col])); },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows[i] = { ...rows[i], ...patch }; return rows[i] || null; },
  };
}
function refundFixture({ split }) {
  const refunds = memStore();
  const svc = createRefundService({
    refunds, paymentRequests: memStore([{ id: 'pr1', memberId: 'm1', subscriptionId: 'sub1', amountTzs: 60_000, status: 'approved' }]),
    subscriptions: memStore([{ id: 'sub1' }]), users: memStore([{ id: 'm1', displayName: 'Asha' }]), auditLog: memStore(),
    secondApprover: () => false, splitScopes: () => split, notify: async () => {},
  });
  return { svc, refunds };
}

test('split ON: an admin-raised refund stays requested; the raiser cannot approve it, another approver can', async () => {
  const f = refundFixture({ split: true });
  const { refund } = await f.svc.adminRaise({ body: { paymentRequestId: 'pr1' }, actorId: 'raiser' });
  assert.equal(refund.status, 'requested');
  assert.equal(refund.decidedBy, null);
  assert.deepEqual(await f.svc.decide({ id: refund.id, body: { decision: 'approve' }, actorId: 'raiser' }), { error: 'cannot_approve_own_request', status: 403 });
  assert.equal((await f.refunds.findByIdAsync(refund.id)).status, 'requested');
  const ok = await f.svc.decide({ id: refund.id, body: { decision: 'approve' }, actorId: 'approver' });
  assert.equal(ok.refund.status, 'approved');
});

test('split ON: any staff-started refund through raise() (shop raise-refund, admin cancellation) is held; system and member ones are not', async () => {
  const f = refundFixture({ split: true });
  const base = { memberId: 'm1', kind: 'shop_order', amountTzs: 1000, reasonCode: 'payment_error' };
  const admin = await f.svc.raise({ ...base, sourceId: 'o1', requestedBy: 'a1', requestedRole: 'admin', approved: true });
  assert.equal(admin.refund.status, 'requested');
  const system = await f.svc.raise({ ...base, sourceId: 'o2', requestedBy: 'system', requestedRole: 'system', approved: true });
  assert.equal(system.refund.status, 'approved');
});

test('split OFF: admin-raised is approved at once and the raiser can still pay it, as before', async () => {
  const f = refundFixture({ split: false });
  const { refund } = await f.svc.adminRaise({ body: { paymentRequestId: 'pr1' }, actorId: 'a1' });
  assert.equal(refund.status, 'approved');
  assert.equal(refund.decidedBy, 'policy');
  const admin = await f.svc.raise({ memberId: 'm1', kind: 'shop_order', sourceId: 'o1', amountTzs: 1000, reasonCode: 'payment_error', requestedBy: 'a1', requestedRole: 'admin', approved: true });
  assert.equal(admin.refund.status, 'approved');
});

test('split ON: whoever approved a refund cannot record it paid, even holding both scopes; another person can. Split OFF: unchanged', async () => {
  const on = refundFixture({ split: true });
  const { refund } = await on.svc.adminRaise({ body: { paymentRequestId: 'pr1' }, actorId: 'raiser' });
  await on.svc.decide({ id: refund.id, body: { decision: 'approve' }, actorId: 'both' });
  assert.deepEqual(await on.svc.markPaid({ id: refund.id, body: { paymentReference: 'R1' }, actorId: 'both' }), { error: 'cannot_pay_own_approval', status: 403 });
  assert.equal((await on.svc.markPaid({ id: refund.id, body: { paymentReference: 'R1' }, actorId: 'payer' })).refund.status, 'paid');

  const off = refundFixture({ split: false });
  const r = await off.svc.adminRaise({ body: { paymentRequestId: 'pr1' }, actorId: 'a1' });
  assert.equal((await off.svc.markPaid({ id: r.refund.id, body: { paymentReference: 'R2' }, actorId: 'a1' })).refund.status, 'paid');
});
