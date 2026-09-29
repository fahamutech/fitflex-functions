// Check-in integrity (settlement Phase 2, PR 1) against the CI database: the
// new columns round-trip through the collection API (nothing silently
// dropped by ALLOWED_FIELDS), existing rows backfill safely, and the database
// itself refuses a bad status or source, a held or voided visit with no
// reason, and any change to a voided visit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { checkins, auditLog } from '../src/bootstrap/collections.mjs';
import { createCheckinStatusService } from '../src/services/checkin-status-service.mjs';
import migration from '../db/migrations/20261026090000-checkin-settlement-integrity.cjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const created = { users: [], gyms: [], checkins: [] };

async function fixture() {
  const memberId = uid('usr');
  const gymId = uid('gym');
  const subscriptionId = uid('sub');
  await db('User').insert({ id: memberId, userType: 'member', displayName: 'Settlement Test', updatedAt: new Date() });
  await db('Gym').insert({ id: gymId, name: 'Settlement Test Gym', tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
  await db('Subscription').insert({
    id: subscriptionId, memberId, type: 'platform_pass', tier: 'pro', status: 'active',
    startedAt: new Date('2026-10-01T07:00:00Z'), cycleStartedAt: new Date('2026-10-01T07:00:00Z'),
    renewsAt: new Date('2026-10-31T07:00:00Z'), expiresAt: new Date('2026-10-31T07:00:00Z'),
  });
  created.users.push(memberId);
  created.gyms.push(gymId);
  return { memberId, gymId, subscriptionId };
}

function baseRow({ memberId, gymId }, extra = {}) {
  const id = uid('chk');
  created.checkins.push(id);
  return {
    id, memberId, gymId, timestamp: new Date(Date.now() - Math.floor(Math.random() * 1e9)).toISOString(),
    method: 'gym_scanned', subscriptionType: 'platform_pass', passTier: 'pro', visitNumberInCycle: 1,
    gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true, ...extra,
  };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => err.code === code, `expected Postgres error ${code}`);
}

after(async () => {
  if (created.checkins.length) await db('AuditLog').whereIn('target', created.checkins).del();
  if (created.users.length) await db('User').whereIn('id', created.users).del();   // cascades check-ins and subscriptions
  if (created.gyms.length) await db('Gym').whereIn('id', created.gyms).del();
});

test('every new field round-trips through the collection API', async () => {
  const f = await fixture();
  const row = baseRow(f, {
    status: 'voided', statusReason: 'Duplicate scan', statusChangedBy: 'admin-1', statusChangedAt: '2026-10-05T09:00:00.000Z',
    voidedAt: '2026-10-05T09:00:00.000Z', voidedBy: 'admin-1', voidReason: 'Duplicate scan',
    subscriptionId: f.subscriptionId, businessDate: '2026-10-05', source: 'member_qr_by_staff',
  });
  await checkins.insertAsync(row);
  const back = await checkins.findByIdAsync(row.id);
  for (const k of ['status', 'statusReason', 'statusChangedBy', 'voidedBy', 'voidReason', 'subscriptionId', 'businessDate', 'source']) {
    assert.equal(back[k], row[k], k);
  }
  assert.equal(new Date(back.statusChangedAt).toISOString(), row.statusChangedAt);
  assert.equal(new Date(back.voidedAt).toISOString(), row.voidedAt);
});

test('a check-in written without a status is valid (the column default backfills existing rows)', async () => {
  const f = await fixture();
  const row = baseRow(f);
  await db('Checkin').insert(row);
  const back = await db('Checkin').where({ id: row.id }).first();
  assert.equal(back.status, 'valid');
  assert.equal(back.source, null);
  assert.equal(back.subscriptionId, null);
});

test('the backfill sets businessDate to the EAT day of existing rows', async () => {
  const f = await fixture();
  const late = baseRow(f, { timestamp: '2026-10-05T21:30:00.000Z' });   // 00:30 EAT 6 Oct
  const early = baseRow(f, { timestamp: '2026-10-05T20:59:00.000Z' });  // 23:59 EAT 5 Oct
  await db('Checkin').insert([late, early]);
  await migration.up(db);   // idempotent: only fills rows with no business date
  const rows = Object.fromEntries((await db('Checkin').whereIn('id', [late.id, early.id])).map((r) => [r.id, r.businessDate]));
  assert.equal(rows[late.id], '2026-10-06');
  assert.equal(rows[early.id], '2026-10-05');
});

test('the database refuses unknown statuses and sources and malformed business dates', async () => {
  const f = await fixture();
  await rejects(db('Checkin').insert(baseRow(f, { status: 'VALID' })), '23514');
  await rejects(db('Checkin').insert(baseRow(f, { status: 'pending' })), '23514');
  await rejects(db('Checkin').insert(baseRow(f, { source: 'kiosk' })), '23514');
  await rejects(db('Checkin').insert(baseRow(f, { businessDate: '5/10/2026' })), '23514');
});

test('a held or voided check-in must say why; a voided one must say when', async () => {
  const f = await fixture();
  await rejects(db('Checkin').insert(baseRow(f, { status: 'disputed' })), '23514');
  await rejects(db('Checkin').insert(baseRow(f, { status: 'flagged' })), '23514');
  await rejects(db('Checkin').insert(baseRow(f, { status: 'voided', statusReason: 'x' })), '23514');   // no voidedAt/voidReason
});

test('a voided check-in is final: no status change, no rewriting its void audit', async () => {
  const f = await fixture();
  const row = baseRow(f, { status: 'voided', statusReason: 'fraud', voidedAt: new Date(), voidedBy: 'admin-1', voidReason: 'fraud' });
  await db('Checkin').insert(row);
  await rejects(db('Checkin').where({ id: row.id }).update({ status: 'valid' }), 'P0001');
  await rejects(db('Checkin').where({ id: row.id }).update({ voidReason: 'changed my mind' }), 'P0001');
  await rejects(db('Checkin').where({ id: row.id }).update({ voidedAt: null }), 'P0001');
  assert.equal((await db('Checkin').where({ id: row.id }).first()).status, 'voided');
});

test('deleting a subscription keeps the check-in and clears its link', async () => {
  const f = await fixture();
  const row = baseRow(f, { subscriptionId: f.subscriptionId });
  await db('Checkin').insert(row);
  await db('Subscription').where({ id: f.subscriptionId }).del();
  const back = await db('Checkin').where({ id: row.id }).first();
  assert.ok(back, 'check-in kept');
  assert.equal(back.subscriptionId, null);
});

test('the status service against the database: dispute, reinstate, void, then refuse', async () => {
  const f = await fixture();
  const row = baseRow(f, { status: 'valid', subscriptionId: f.subscriptionId, businessDate: '2026-10-05', source: 'gym_qr_by_member' });
  await checkins.insertAsync(row);
  const svc = createCheckinStatusService({ checkins, auditLog });

  const disputed = await svc.setStatus({ checkinId: row.id, status: 'disputed', reason: 'Member disputes', actorId: 'admin-1' });
  assert.equal(disputed.checkin.status, 'disputed');
  const back = await svc.setStatus({ checkinId: row.id, status: 'valid', reason: 'Confirmed by gym', actorId: 'admin-2' });
  assert.equal(back.checkin.status, 'valid');
  const voided = await svc.setStatus({ checkinId: row.id, status: 'voided', reason: 'Duplicate of another visit', actorId: 'admin-1' });
  assert.equal(voided.checkin.status, 'voided');
  assert.equal(voided.checkin.voidedBy, 'admin-1');
  assert.equal(voided.checkin.voidReason, 'Duplicate of another visit');
  assert.ok(voided.checkin.voidedAt);

  const refused = await svc.setStatus({ checkinId: row.id, status: 'valid', reason: 'undo', actorId: 'admin-3' });
  assert.equal(refused.error, 'checkin_voided_final');

  const audit = await db('AuditLog').where({ target: row.id }).orderBy('at');
  assert.deepEqual(audit.map((a) => a.action), ['checkin_disputed', 'checkin_reinstated', 'checkin_voided']);
  assert.equal(audit[2].actor, 'admin-1');
  assert.equal((await db('Checkin').where({ id: row.id })).length, 1, 'never deleted');
});
