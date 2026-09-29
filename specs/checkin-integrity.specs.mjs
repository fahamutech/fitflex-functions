// Check-in integrity for gym settlement (Phase 2, PR 1) — service level, no
// database: the status lifecycle and its audit, the settlement fields every
// check-in now records, and the owner manual check-in guard.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKIN_STATUS, CHECKIN_SOURCE, canTransition, checkStatusChange, currentStatus, sourceForMethod } from '../src/shared/checkin-status.mjs';
import { createCheckinStatusService } from '../src/services/checkin-status-service.mjs';
import { createCheckInService } from '../src/services/check-in-service.mjs';
import { createMemberManagementService } from '../src/services/member-management-service.mjs';
import { localDay } from '../src/shared/member-progress.mjs';

const mkCol = (initial = []) => {
  const rows = [...initial];
  return {
    rows,
    find: (pred) => rows.find(pred),
    findByIdAsync: async (id) => rows.find((r) => r.id === id) ?? null,
    findAsync: async (pred) => rows.find(pred) ?? null,
    filterAsync: async (pred) => rows.filter(pred),
    insertAsync: async (row) => { rows.push(row); return row; },
    updateByIdAsync: async (id, patch) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return null;
      rows[i] = { ...rows[i], ...patch };
      return rows[i];
    },
  };
};

const { VALID, DISPUTED, FLAGGED, VOIDED } = CHECKIN_STATUS;

// ── lifecycle rules (DR-14) ──────────────────────────────────────────────────

describe('check-in status transitions', () => {
  const allowed = [[VALID, DISPUTED], [VALID, FLAGGED], [VALID, VOIDED], [DISPUTED, VALID], [DISPUTED, VOIDED], [FLAGGED, VALID], [FLAGGED, VOIDED]];
  const all = [VALID, DISPUTED, FLAGGED, VOIDED];
  for (const from of all) {
    for (const to of all) {
      const ok = allowed.some(([f, t]) => f === from && t === to);
      test(`${from} → ${to}: ${ok ? 'allowed' : 'refused'}`, () => assert.equal(canTransition(from, to), ok));
    }
  }
  test('voided is final, with its own error', () => {
    assert.deepEqual(checkStatusChange({ from: VOIDED, to: VALID, reason: 'x' }), { ok: false, error: 'checkin_voided_final', status: 409 });
  });
  test('a reason is required and trimmed; unknown statuses are refused', () => {
    assert.equal(checkStatusChange({ from: VALID, to: VOIDED, reason: '   ' }).error, 'reason_required');
    assert.equal(checkStatusChange({ from: VALID, to: VOIDED }).error, 'reason_required');
    assert.equal(checkStatusChange({ from: VALID, to: 'VOIDED', reason: 'x' }).error, 'invalid_status');
    assert.equal(checkStatusChange({ from: VALID, to: VOIDED, reason: 'x'.repeat(501) }).error, 'reason_too_long');
    assert.deepEqual(checkStatusChange({ from: VALID, to: VOIDED, reason: '  dup scan ' }), { ok: true, reason: 'dup scan' });
  });
  test('rows written before the lifecycle existed read as valid', () => {
    assert.equal(currentStatus({}), VALID);
    assert.equal(currentStatus({ status: FLAGGED }), FLAGGED);
  });
  test('check-in method maps to its source', () => {
    assert.equal(sourceForMethod('gym_scanned'), CHECKIN_SOURCE.MEMBER_QR_BY_STAFF);
    assert.equal(sourceForMethod('member_scanned'), CHECKIN_SOURCE.GYM_QR_BY_MEMBER);
  });
});

describe('check-in status service', () => {
  const setup = (status = VALID) => {
    const checkins = mkCol([{ id: 'c1', memberId: 'm1', gymId: 'g1', status }]);
    const auditLog = mkCol();
    return { checkins, auditLog, svc: createCheckinStatusService({ checkins, auditLog }) };
  };
  const at = new Date('2026-10-05T09:00:00.000Z');

  test('void keeps who, when and why on the check-in and writes an audit row', async () => {
    const { checkins, auditLog, svc } = setup();
    const r = await svc.setStatus({ checkinId: 'c1', status: VOIDED, reason: 'Duplicate scan', actorId: 'admin-1', now: at });
    assert.equal(r.checkin.status, VOIDED);
    assert.equal(r.checkin.voidedAt, at.toISOString());
    assert.equal(r.checkin.voidedBy, 'admin-1');
    assert.equal(r.checkin.voidReason, 'Duplicate scan');
    assert.equal(r.checkin.statusChangedBy, 'admin-1');
    assert.equal(checkins.rows.length, 1, 'never deleted');
    assert.equal(auditLog.rows.length, 1);
    assert.deepEqual(
      { action: auditLog.rows[0].action, actor: auditLog.rows[0].actor, target: auditLog.rows[0].target, before: auditLog.rows[0].before.status, after: auditLog.rows[0].after.status },
      { action: 'checkin_voided', actor: 'admin-1', target: 'c1', before: VALID, after: VOIDED });
  });
  for (const [status, action] of [[DISPUTED, 'checkin_disputed'], [FLAGGED, 'checkin_flagged']]) {
    test(`${status}: held with its reason and audited as ${action}; no void fields`, async () => {
      const { auditLog, svc } = setup();
      const r = await svc.setStatus({ checkinId: 'c1', status, reason: 'Member says they were not there', actorId: 'admin-1', now: at });
      assert.equal(r.checkin.status, status);
      assert.equal(r.checkin.statusReason, 'Member says they were not there');
      assert.equal(r.checkin.voidedAt, undefined);
      assert.equal(auditLog.rows[0].action, action);
    });
  }
  test('a disputed check-in resolved as valid is reinstated explicitly', async () => {
    const { auditLog, svc } = setup(DISPUTED);
    const r = await svc.setStatus({ checkinId: 'c1', status: VALID, reason: 'Gym camera confirms the visit', actorId: 'admin-2', now: at });
    assert.equal(r.checkin.status, VALID);
    assert.equal(auditLog.rows[0].action, 'checkin_reinstated');
  });
  test('a voided check-in cannot change again, and nothing is written', async () => {
    const { checkins, auditLog, svc } = setup(VOIDED);
    const r = await svc.setStatus({ checkinId: 'c1', status: VALID, reason: 'undo', actorId: 'admin-1' });
    assert.deepEqual(r, { error: 'checkin_voided_final', status: 409 });
    assert.equal(checkins.rows[0].status, VOIDED);
    assert.equal(auditLog.rows.length, 0);
  });
  test('valid → valid is refused (a transition must change something)', async () => {
    const { svc } = setup();
    assert.equal((await svc.setStatus({ checkinId: 'c1', status: VALID, reason: 'x', actorId: 'a' })).error, 'invalid_status_transition');
  });
  test('unknown check-in', async () => {
    const { svc } = setup();
    assert.deepEqual(await svc.setStatus({ checkinId: 'nope', status: VOIDED, reason: 'x', actorId: 'a' }), { error: 'checkin_not_found', status: 404 });
  });
});

// ── settlement fields written at check-in ────────────────────────────────────

describe('check-in service records settlement inputs', () => {
  const setup = () => {
    const users = mkCol([{ id: 'm1', userType: 'member' }, { id: 't1', userType: 'trainer' }]);
    const gyms = mkCol([{ id: 'g1', tier: 'standard' }]);
    const subscriptions = mkCol([{ id: 'sub-1', memberId: 'm1', type: 'platform_pass', tier: 'pro', status: 'active',
      startedAt: '2026-10-01T07:00:00Z', cycleStartedAt: '2026-10-01T07:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }]);
    const checkins = mkCol();
    const trainers = { find: (pred) => [{ id: 't1', userId: 't1', status: 'active', gymIds: ['g1'] }].find(pred) };
    return { checkins, svc: createCheckInService({ users, gyms, subscriptions, checkins, trainers }) };
  };

  test('staff scan: valid, linked to the pass subscription, EAT business day, member_qr_by_staff', async () => {
    const { svc } = setup();
    const now = new Date('2026-10-05T06:00:00.000Z');
    const r = await svc.perform({ memberId: 'm1', gymId: 'g1', method: 'gym_scanned', now });
    assert.equal(r.ok, true);
    assert.equal(r.checkin.status, VALID);
    assert.equal(r.checkin.subscriptionId, 'sub-1');
    assert.equal(r.checkin.businessDate, '2026-10-05');
    assert.equal(r.checkin.source, CHECKIN_SOURCE.MEMBER_QR_BY_STAFF);
  });
  test('member scan at 00:30 EAT: gym_qr_by_member, and the business day is the EAT day, not the UTC day', async () => {
    const { svc } = setup();
    const r = await svc.perform({ memberId: 'm1', gymId: 'g1', method: 'member_scanned', now: new Date('2026-10-05T21:30:00.000Z') });
    assert.equal(r.checkin.source, CHECKIN_SOURCE.GYM_QR_BY_MEMBER);
    assert.equal(r.checkin.businessDate, '2026-10-06');
  });
  test('a linked trainer entering free has no subscription link', async () => {
    const { svc } = setup();
    const r = await svc.perform({ memberId: 't1', gymId: 'g1', now: new Date('2026-10-05T06:00:00.000Z') });
    assert.equal(r.ok, true);
    assert.equal(r.checkin.subscriptionType, 'trainer_home');
    assert.equal(r.checkin.subscriptionId, null);
    assert.equal(r.checkin.status, VALID);
  });
  test('the existing rules are unchanged: same gym twice in a day returns the first check-in', async () => {
    const { checkins, svc } = setup();
    const now = new Date('2026-10-05T06:00:00.000Z');
    await svc.perform({ memberId: 'm1', gymId: 'g1', now });
    const again = await svc.perform({ memberId: 'm1', gymId: 'g1', now: new Date('2026-10-05T10:00:00.000Z') });
    assert.equal(again.idempotent, true);
    assert.equal(checkins.rows.length, 1);
  });
});

// ── owner manual check-in (review finding, prompt 4 §30) ─────────────────────

describe('owner manual check-in', () => {
  const owner = { id: 'o1', userType: 'gym_operator', gymIds: ['g1'] };
  const passSub = { id: 'sub-pass', memberId: 'm-pass', type: 'platform_pass', tier: 'pro', status: 'active', startedAt: '2026-10-01T07:00:00Z', expiresAt: '2099-01-01T00:00:00Z' };
  const directSub = { id: 'sub-direct', memberId: 'm-direct', type: 'direct_sub', plan: 'monthly', homeGymId: 'g1', status: 'active', startedAt: '2026-10-01T07:00:00Z', expiresAt: '2099-01-01T00:00:00Z' };
  const setup = (existingCheckins = []) => {
    const checkins = mkCol(existingCheckins);
    const svc = createMemberManagementService({
      users: mkCol([{ id: 'm-pass', userType: 'member' }, { id: 'm-direct', userType: 'member' }]),
      gyms: mkCol([{ id: 'g1', name: 'Gym One', tier: 'standard' }]),
      subscriptions: mkCol([passSub, directSub]),
      checkins, paymentRequests: mkCol(), publicUserId: async () => 'FM001',
    });
    return { checkins, svc };
  };

  test('a Platform Pass member who once scanned in here is refused (they check in by QR)', async () => {
    const { checkins, svc } = setup([{ id: 'old', memberId: 'm-pass', gymId: 'g1', timestamp: '2026-09-01T06:00:00.000Z', subscriptionType: 'platform_pass', visitConsumed: true }]);
    const r = await svc.checkInMember({ owner, memberId: 'm-pass', gymId: 'g1' });
    assert.deepEqual(r, { error: 'direct_membership_required', status: 409 });
    assert.equal(checkins.rows.length, 1, 'no direct_sub row recorded for a pass member');
  });
  test('a direct member whose plan the gym has paused is refused', async () => {
    const { checkins } = setup();
    const paused = { ...directSub, id: 'sub-paused', memberId: 'm-direct', status: 'suspended', startedAt: '2026-10-02T07:00:00Z' };
    const svc2 = createMemberManagementService({
      users: mkCol([{ id: 'm-direct', userType: 'member' }]),
      gyms: mkCol([{ id: 'g1', name: 'Gym One', tier: 'standard' }]),
      subscriptions: mkCol([paused]), checkins, paymentRequests: mkCol(), publicUserId: async () => 'FM001',
    });
    assert.deepEqual(await svc2.checkInMember({ owner, memberId: 'm-direct', gymId: 'g1' }), { error: 'member_suspended', status: 409 });
    assert.equal(checkins.rows.length, 0);
  });
  test('a direct member is checked in with the settlement fields', async () => {
    const { svc } = setup();
    const r = await svc.checkInMember({ owner, memberId: 'm-direct', gymId: 'g1' });
    assert.equal(r.ok, true);
    assert.equal(r.checkin.subscriptionType, 'direct_sub');
    assert.equal(r.checkin.subscriptionId, 'sub-direct');
    assert.equal(r.checkin.status, VALID);
    assert.equal(r.checkin.source, CHECKIN_SOURCE.OWNER_MANUAL);
    assert.equal(r.checkin.businessDate, localDay(r.checkin.timestamp));
  });
  test('the duplicate check uses the EAT day: a visit at 00:00 EAT today (21:00 UTC yesterday) counts as today', async () => {
    const today = localDay(new Date());
    const startOfEatDay = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 3_600_000).toISOString();
    const { checkins, svc } = setup([{ id: 'early', memberId: 'm-direct', gymId: 'g1', timestamp: startOfEatDay, subscriptionType: 'direct_sub', visitConsumed: true }]);
    const r = await svc.checkInMember({ owner, memberId: 'm-direct', gymId: 'g1' });
    assert.equal(r.idempotent, true);
    assert.equal(checkins.rows.length, 1);
  });
  test('a visit at 23:59 EAT yesterday does not block today', async () => {
    const today = localDay(new Date());
    const lateYesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 3_600_000 - 60_000).toISOString();
    const { checkins, svc } = setup([{ id: 'late', memberId: 'm-direct', gymId: 'g1', timestamp: lateYesterday, subscriptionType: 'direct_sub', visitConsumed: true }]);
    const r = await svc.checkInMember({ owner, memberId: 'm-direct', gymId: 'g1' });
    assert.equal(r.ok, true);
    assert.equal(r.idempotent, undefined);
    assert.equal(checkins.rows.length, 2);
  });
});
