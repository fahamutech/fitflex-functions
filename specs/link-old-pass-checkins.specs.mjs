// One-off data fix: old pass check-ins are linked to the pass cycle they
// fall in (migration 20261122090000). Runs the migration's own code inside a
// transaction that is rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../src/infra/knex-store.mjs';

const migration = createRequire(import.meta.url)('../db/migrations/20261122090000-link-old-pass-checkins.cjs');
const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const ROLLBACK = Symbol('rollback');

test('an old pass check-in is linked to the cycle that contains it; anything else is left alone', async () => {
  try {
    await db.transaction(async (trx) => {
      const memberId = uid('usr');
      const gymId = uid('gym');
      await trx('User').insert({ id: memberId, userType: 'member', displayName: 'Old Visits', updatedAt: new Date() });
      await trx('Gym').insert({ id: gymId, name: 'Old Gym', tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
      const pass = async (start, end, type = 'platform_pass') => {
        const id = uid('sub');
        await trx('Subscription').insert({ id, memberId, type, tier: type === 'platform_pass' ? 'pro' : null, status: 'expired', startedAt: new Date(start), cycleStartedAt: new Date(start), renewsAt: new Date(end), expiresAt: new Date(end), ...(type === 'direct_sub' ? { gymId } : {}) });
        return id;
      };
      const july = await pass('2026-07-01T07:00:00Z', '2026-07-31T07:00:00Z');
      const august = await pass('2026-08-05T07:00:00Z', '2026-09-04T07:00:00Z');
      const checkin = async (at, extra = {}) => {
        const id = uid('chk');
        await trx('Checkin').insert({ id, memberId, gymId, timestamp: new Date(at), method: 'gym_scanned', subscriptionType: 'platform_pass', gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', ...extra });
        return id;
      };
      const inJuly = await checkin('2026-07-10T12:00:00Z');
      const inAugust = await checkin('2026-08-20T12:00:00Z');
      const betweenCycles = await checkin('2026-08-02T12:00:00Z');
      const direct = await checkin('2026-07-11T12:00:00Z', { subscriptionType: 'direct_sub' });
      const voided = await checkin('2026-07-12T12:00:00Z', { status: 'voided', statusReason: 'x', voidedAt: new Date(), voidedBy: 'admin', voidReason: 'x' });
      const alreadyLinked = await checkin('2026-08-22T12:00:00Z', { subscriptionId: july });

      await migration.up(trx);
      const linked = Object.fromEntries((await trx('Checkin').where({ memberId })).map((c) => [c.id, c.subscriptionId]));
      assert.deepEqual([linked[inJuly], linked[inAugust], linked[betweenCycles], linked[direct], linked[voided], linked[alreadyLinked]],
        [july, august, null, null, null, july]);

      await migration.down(trx);
      const undone = Object.fromEntries((await trx('Checkin').where({ memberId })).map((c) => [c.id, c.subscriptionId]));
      assert.deepEqual([undone[inJuly], undone[inAugust], undone[alreadyLinked]], [null, null, july]);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
});
