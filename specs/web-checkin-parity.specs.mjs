// A browser check-in is the same visit as an in-app scan (S2): settlement and the owner dashboard count
// web_gym_qr_by_member visits exactly like gym_qr_by_member ones. Settlement runs inside a rolled-back transaction.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { gyms, users } from '../src/bootstrap/collections.mjs';
import { operatorService } from '../src/bootstrap/services.mjs';
import { createSettlementConfigService } from '../src/services/settlement-config-service.mjs';
import { createSettlementService, periodForMonth } from '../src/services/settlement-service.mjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');

const ROLLBACK = Symbol('rollback');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], gyms: [] };

after(async () => {
  if (made.users.length) await db('User').whereIn('id', made.users).del();
  for (const id of made.users) await users.removeAsync(u => u.id === id);
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  await db.destroy();
});

const WEB = { source: 'web_gym_qr_by_member', method: 'web_scanned' };
const SCAN = { source: 'gym_qr_by_member', method: 'member_scanned' };
const webMeta = () => ({ intentId: uid('intent'), authSessionId: uid('sid'), clientMeta: { channel: 'web', uaFamily: 'chrome', ipHash: 'a'.repeat(32) } });

test('settlement pays web visits exactly like in-app scan visits', async () => {
  try {
    await db.transaction(async trx => {
      await trx('Subscription').update({ status: 'payment_cancelled' });
      await trx('B2BBenefitConsumption').whereIn('status', ['approved', 'pending']).update({ status: 'cancelled' });
      const configService = createSettlementConfigService({ db: trx, now: () => new Date('2026-09-01T09:00:00.000Z') });
      const gymId = uid('gymp');
      await trx('Gym').insert({ id: gymId, name: 'Parity Premium', tier: 'premium', location: 'Dar es Salaam', updatedAt: new Date() });
      const card = (await configService.createRateCard({ gymId, retailDailyTzs: 20000, retailWeeklyTzs: 70000, retailMonthlyTzs: 250000, actorId: 'maker' }, { trx })).rateCard;
      assert.ok((await configService.activate({ kind: 'rate_card', id: card.id, effectiveFrom: '2026-10-01', actorId: 'checker' }, { trx })).rateCard);

      const member = async (channel, extra) => {
        const memberId = uid('usr'); const subscriptionId = uid('sub');
        await trx('User').insert({ id: memberId, userType: 'member', displayName: 'Parity Member', updatedAt: new Date() });
        await trx('Subscription').insert({ id: subscriptionId, memberId, type: 'platform_pass', tier: 'premium', status: 'expired',
          startedAt: new Date('2026-10-01T07:00:00Z'), cycleStartedAt: new Date('2026-10-01T07:00:00Z'), renewsAt: new Date('2026-10-31T07:00:00Z'), expiresAt: new Date('2026-10-31T07:00:00Z') });
        await trx('PaymentRequest').insert({ id: uid('pay'), memberId, subscriptionId, tier: 'premium', amountTzs: 250000, status: 'approved', provider: 'admin_approved', requestedAt: new Date('2026-10-01T06:00:00Z') });
        await trx('Checkin').insert(Array.from({ length: 12 }, (_, i) => ({
          id: uid('chk'), memberId, gymId, timestamp: new Date(Date.UTC(2026, 9, 1 + i, 12)), subscriptionType: 'platform_pass', passTier: 'premium',
          visitNumberInCycle: i + 1, gymTier: 'premium', creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', subscriptionId,
          businessDate: `2026-10-${String(1 + i).padStart(2, '0')}`, ...channel,
          ...(extra ? { ...extra(), intentId: uid('intent'), clientMeta: JSON.stringify({ channel: 'web', uaFamily: 'chrome', ipHash: 'a'.repeat(32) }) } : {}),
        })));
        return { memberId, subscriptionId };
      };
      const a = await member(SCAN);
      const b = await member(WEB, () => ({ authSessionId: uid('sid') }));

      const settlement = createSettlementService({ db: trx, configService, now: () => new Date('2026-12-02T09:00:00.000Z'), logger: { error() {} } });
      const out = await settlement.run({ ...periodForMonth('2026-11'), mode: 'live', actorId: 'admin-1' });
      assert.equal(out.run.status, 'locked');
      assert.equal(out.stats.settledCycles, 2);
      assert.equal(out.stats.payableVisits, 24);
      const cyc = async m => trx('MemberCycleSettlement').where({ runId: out.run.id, subscriptionId: m.subscriptionId }).first();
      const [ca, cb] = [await cyc(a), await cyc(b)];
      for (const k of ['collectedApprovedAmountTzs', 'networkCapTzs', 'totalFinalTzs', 'visitAllowance', 'catalogPriceTzs']) assert.equal(cb[k], ca[k], k);
      const outcomes = async m => {
        const mcs = await cyc(m);
        return (await trx('SettlementVisit').where({ runId: out.run.id, memberCycleSettlementId: mcs.id })).map(v => `${v.outcome}/${v.eligibility}/${v.allowanceSlot ?? ''}`).sort();
      };
      assert.deepEqual(await outcomes(b), await outcomes(a));
      assert.equal((await outcomes(b)).length, 12);
      const statement = await trx('GymSettlement').where({ runId: out.run.id, gymId }).first();
      assert.equal(statement.qualifyingVisitCount, 24, 'both members\' visits count at the gym');
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
});

test('the owner dashboard counts web visits like scan visits', async () => {
  await gyms.ready;
  const gymId = uid('gym');
  await gyms.insertAsync({ id: gymId, name: 'Parity Dashboard Gym', tier: 'standard', status: 'active', location: 'Masaki', homepageVisible: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  made.gyms.push(gymId);
  const visit = async (channel, extra = {}) => {
    const id = uid('usr');
    await users.insertAsync({ id, userType: 'member', displayName: 'Parity', accountStatus: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    made.users.push(id);
    await db('Checkin').insert({ id: uid('chk'), memberId: id, gymId, timestamp: new Date(), subscriptionType: 'platform_pass', passTier: 'pro', visitNumberInCycle: 1,
      gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true, status: 'valid', businessDate: new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10), ...channel, ...extra });
  };
  await visit(SCAN);
  await visit(WEB, { ...webMeta(), clientMeta: JSON.stringify(webMeta().clientMeta) });
  const d = await operatorService.dashboard({ operator: { gymIds: [gymId], gymId }, query: { gymId }, includeSettlement: false });
  assert.equal(d.todayCount, 2);
  assert.equal(d.periodVisits, 2);
  assert.equal(d.periodMembers, 2);
  assert.equal(d.fitflexVisits, 2);
  assert.equal(d.fitflexMembers, 2);
  assert.equal(d.directVisits, 0);
  assert.equal(d.gymSummaries[0].totalVisits, 2);
});
