// Credential hashes and member profile values must never be written to
// AuditLog.before / AuditLog.after, by the admin user services or by any
// caller of the audit_log collection.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, collection } from '../src/infra/knex-store.mjs';
import { redactAuditValue, userAuditSnapshot } from '../src/shared/audit-redact.mjs';
import { createAdminMemberService } from '../src/services/admin-member-service.mjs';
import { createAdminOwnerService } from '../src/services/admin-owner-service.mjs';
import { createAdminApprovalService } from '../src/services/admin-approval-service.mjs';

const SECRETS = ['scrypt:pw-secret', 'scrypt:start-secret', 'scrypt:pin-secret'];

function userRow(over = {}) {
  return {
    id: 'usr_audit1', userType: 'member', email: 'm@example.test', phone: '+255700000001',
    displayName: 'Member', accountStatus: 'active', firebaseUid: 'fb_123', personId: 'per_1',
    passwordHash: SECRETS[0], startPasswordHash: SECRETS[1], pinHash: SECRETS[2],
    memberProfile: { dateOfBirth: '1990-05-01', gender: 'female', heightCm: 170, weightKg: null },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function assertClean(entry) {
  const text = JSON.stringify(entry);
  for (const s of SECRETS) assert.ok(!text.includes(s), `audit entry leaks ${s}: ${text}`);
  for (const k of ['passwordHash', 'startPasswordHash', 'pinHash', 'firebaseUid', 'personId', '1990-05-01', 'female']) {
    assert.ok(!text.includes(k), `audit entry leaks ${k}: ${text}`);
  }
}

function store(rows = []) {
  return {
    rows,
    find: p => rows.find(p) || null,
    async findAsync(p) { return rows.find(p) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async filterAsync(p) { return rows.filter(p); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v); },
    async upsertAsync(p, row) { const i = rows.findIndex(p); if (i >= 0) rows[i] = row; else rows.push(row); return row; },
    async updateByIdAsync(id, patch) { const i = rows.findIndex(r => r.id === id); rows[i] = { ...rows[i], ...patch }; return rows[i]; },
    async removeAsync(p) { const i = rows.findIndex(p); return i >= 0 ? rows.splice(i, 1)[0] : null; },
  };
}

function auditSink() {
  const entries = [];
  return { entries, insert: e => entries.push(e), insertAsync: async e => { entries.push(e); return e; } };
}

test('redactAuditValue drops credential keys at any depth and keeps the rest', () => {
  const out = redactAuditValue({ a: 1, passwordHash: 'x', nested: { pinHash: 'y', list: [{ tokenHash: 'z', ok: true }] } });
  assert.deepEqual(out, { a: 1, nested: { list: [{ ok: true }] } });
  assert.equal(redactAuditValue(null), null);
});

test('userAuditSnapshot keeps account fields and lists profile fields without their values', () => {
  const snap = userAuditSnapshot(userRow());
  assertClean(snap);
  assert.equal(snap.email, 'm@example.test');
  assert.equal(snap.accountStatus, 'active');
  assert.deepEqual(snap.memberProfileFields, ['dateOfBirth', 'gender', 'heightCm']);
  assert.equal(userAuditSnapshot(null), null);
});

test('admin member update writes no hashes or profile values to the audit log', async () => {
  const users = store([userRow()]);
  const auditLog = auditSink();
  const svc = createAdminMemberService({
    users, subscriptions: store(), paymentRequests: store(), checkins: store(), gyms: [], auditLog, issueQr: () => 'qr',
  });
  const res = await svc.upsert({ body: { id: 'usr_audit1', displayName: 'Renamed' }, actorId: 'adm_1' });
  assert.equal(res.error, undefined);
  assert.equal(auditLog.entries.length, 1);
  const [entry] = auditLog.entries;
  assert.equal(entry.action, 'member_updated');
  assert.equal(entry.before.displayName, 'Member');
  assert.equal(entry.after.displayName, 'Renamed');
  assertClean(entry);
});

test('admin member suspend writes no hashes to the audit log', async () => {
  const users = store([userRow()]);
  const auditLog = auditSink();
  const svc = createAdminMemberService({
    users, subscriptions: store(), paymentRequests: store(), checkins: store(), gyms: [], auditLog, issueQr: () => 'qr',
  });
  const res = await svc.setStatus({ memberId: 'usr_audit1', status: 'suspended', actorId: 'adm_1' });
  assert.equal(res.error, undefined);
  const [entry] = auditLog.entries;
  assert.equal(entry.before.accountStatus, 'active');
  assert.equal(entry.after.accountStatus, 'suspended');
  assertClean(entry);
});

test('admin gym-owner update and delete write no hashes to the audit log', async () => {
  const users = store([userRow({ id: 'usr_own1', userType: 'gym_operator', gymId: null, gymIds: [] })]);
  const auditLog = auditSink();
  const svc = createAdminOwnerService({ users, gyms: [], checkins: store(), auditLog, gymService: { slimGymRef: g => g } });
  assert.equal((await svc.upsert({ body: { id: 'usr_own1', displayName: 'Owner' }, actorId: 'adm_1' })).error, undefined);
  // The update replaced the row; put the hashes back to prove delete is clean too.
  users.rows[0] = { ...users.rows[0], passwordHash: SECRETS[0], startPasswordHash: SECRETS[1] };
  assert.equal((await svc.remove({ id: 'usr_own1', actorId: 'adm_1' })).error, undefined);
  assert.equal(auditLog.entries.length, 2);
  for (const e of auditLog.entries) assertClean(e);
});

test('admin role approval writes no hashes to the audit log', async () => {
  const users = store([userRow({ id: 'usr_trn1', userType: 'trainer', approvalStatus: 'pending_approval' })]);
  const auditLog = auditSink();
  const svc = createAdminApprovalService({ users, auditLog });
  const res = await svc.decide({ id: 'usr_trn1', decision: 'approve', actorId: 'adm_1' });
  assert.equal(res.error, undefined);
  const [entry] = auditLog.entries;
  assert.equal(entry.after.approvalStatus, 'approved');
  assertClean(entry);
});

// Store level: whatever a caller passes, the AuditLog row in Postgres holds no hashes.
const insertedIds = [];
after(async () => {
  if (insertedIds.length) await db('AuditLog').whereIn('id', insertedIds).del();
});

test('audit_log collection strips credential keys before writing to the database', async () => {
  const auditLog = collection('audit_log');
  const id = randomUUID();
  insertedIds.push(id);
  await auditLog.insertAsync({
    id, at: new Date().toISOString(), actor: 'spec', action: 'spec_audit_redaction', target: 'usr_spec',
    before: { passwordHash: SECRETS[0], startPasswordHash: SECRETS[1], email: 'a@example.test' },
    after: { employee: { pinHash: SECRETS[2], status: 'active' } },
  });
  const row = await db('AuditLog').where({ id }).first();
  assert.ok(row, 'audit row was written');
  const text = JSON.stringify(row);
  for (const s of SECRETS) assert.ok(!text.includes(s), `stored audit row leaks ${s}`);
  const before = typeof row.before === 'string' ? JSON.parse(row.before) : row.before;
  const afterVal = typeof row.after === 'string' ? JSON.parse(row.after) : row.after;
  assert.deepEqual(before, { email: 'a@example.test' });
  assert.deepEqual(afterVal, { employee: { status: 'active' } });
});
