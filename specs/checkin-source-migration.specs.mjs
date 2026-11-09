// Migration 20270129090000-checkin-web-qr against the CI database: the new source value, the three nullable
// columns and the partial unique intentId index; up is idempotent, down refuses while web visits exist.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { CHECKIN_SOURCE_VALUES, sourceForMethod } from '../src/shared/checkin-status.mjs';
import migration from '../db/migrations/20270129090000-checkin-web-qr.cjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const created = { users: [], gyms: [] };

async function fixture() {
  const memberId = uid('usr'); const gymId = uid('gym');
  await db('User').insert({ id: memberId, userType: 'member', displayName: 'Source Migration', updatedAt: new Date() });
  await db('Gym').insert({ id: gymId, name: 'Source Migration Gym', tier: 'standard', location: 'Dar es Salaam', updatedAt: new Date() });
  created.users.push(memberId); created.gyms.push(gymId);
  return { memberId, gymId };
}
let n = 0;
const row = ({ memberId, gymId }, extra = {}) => ({
  id: uid('chk'), memberId, gymId, timestamp: new Date(Date.now() - (n += 1) * 86_400_000 * 2), method: 'gym_scanned', subscriptionType: 'platform_pass',
  passTier: 'pro', visitNumberInCycle: 1, gymTier: 'standard', creditsDeductedTzs: 0, visitConsumed: true, ...extra,
});
const sourceConstraint = async () => (await db.raw(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'checkin_source_ck'`)).rows[0]?.def ?? null;
const columns = async () => (await db.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Checkin'`)).rows.map(r => r.column_name);
const rejects = (p, code) => assert.rejects(p, err => err.code === code, `expected Postgres error ${code}`);

after(async () => {
  if (created.users.length) await db('User').whereIn('id', created.users).del();
  if (created.gyms.length) await db('Gym').whereIn('id', created.gyms).del();
  await db.destroy();
});

test('the database check lists exactly the shared allowed-source constant', async () => {
  const def = await sourceConstraint();
  const inDb = [...def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]).sort();
  assert.deepEqual(inDb, [...CHECKIN_SOURCE_VALUES].sort());
  assert.ok(CHECKIN_SOURCE_VALUES.includes('web_gym_qr_by_member'));
  assert.equal(sourceForMethod('web_scanned'), 'web_gym_qr_by_member');
  assert.equal(sourceForMethod('member_scanned'), 'gym_qr_by_member');
  assert.equal(sourceForMethod('gym_scanned'), 'member_qr_by_staff');
});

test('up: web source accepted, NULL still allowed, unknown refused; the three columns exist; intentId is unique only when set', async () => {
  const f = await fixture();
  const cols = await columns();
  for (const c of ['authSessionId', 'clientMeta', 'intentId']) assert.ok(cols.includes(c), c);
  await db('Checkin').insert(row(f, { source: 'web_gym_qr_by_member', method: 'web_scanned', intentId: 'i-1', authSessionId: 's', clientMeta: JSON.stringify({ channel: 'web' }) }));
  await db('Checkin').insert(row(f, { source: null }));
  await db('Checkin').insert(row(f, { source: 'gym_qr_by_member' }));
  await db('Checkin').insert(row(f, { source: 'member_qr_by_staff' }));
  await rejects(db('Checkin').insert(row(f, { source: 'web_something_else' })), '23514');
  await rejects(db('Checkin').insert(row(f, { source: 'web_gym_qr_by_member', intentId: 'i-1' })), '23505');
  // Several rows without an intent are fine (partial index).
  await db('Checkin').insert(row(f, { source: 'gym_qr_by_member' }));
  assert.equal((await db('Checkin').where({ memberId: f.memberId }).whereNull('intentId')).length, 4);
});

test('up is idempotent: running it again changes nothing and loses nothing', async () => {
  const f = await fixture();
  await db('Checkin').insert(row(f, { source: 'web_gym_qr_by_member', intentId: uid('i') }));
  const before = await sourceConstraint();
  await migration.up(db);
  await migration.up(db);
  assert.equal(await sourceConstraint(), before);
  assert.equal((await db('Checkin').where({ memberId: f.memberId, source: 'web_gym_qr_by_member' })).length, 1);
});

test('down refuses while web_gym_qr_by_member rows exist, and changes nothing when it refuses', async () => {
  const f = await fixture();
  const id = uid('chk');
  await db('Checkin').insert(row(f, { id, source: 'web_gym_qr_by_member', intentId: uid('i') }));
  const defBefore = await sourceConstraint();
  await assert.rejects(migration.down(db), /web_gym_qr_by_member/);
  assert.equal(await sourceConstraint(), defBefore);
  assert.ok((await columns()).includes('intentId'));
  await db('Checkin').where({ id }).del();
});

test('down (no web rows) restores the old constraint and drops the columns and index; up brings it all back', async () => {
  const webCount = Number((await db('Checkin').where({ source: 'web_gym_qr_by_member' }).count('* as n'))[0].n);
  // Other specs' leftovers or real web rows would make down refuse (correctly): park them for this test only.
  const parked = webCount ? await db('Checkin').where({ source: 'web_gym_qr_by_member' }) : [];
  try {
    if (parked.length) await db('Checkin').where({ source: 'web_gym_qr_by_member' }).update({ source: null });
    await migration.down(db);
    const def = await sourceConstraint();
    assert.ok(!def.includes('web_gym_qr_by_member'));
    assert.ok(def.includes('gym_qr_by_member') && def.includes('admin_backfill') && def.includes('IS NULL'));
    const cols = await columns();
    for (const c of ['authSessionId', 'clientMeta', 'intentId']) assert.ok(!cols.includes(c), c);
    const idx = (await db.raw(`SELECT 1 FROM pg_indexes WHERE indexname = 'checkin_intent_id_uq'`)).rows;
    assert.equal(idx.length, 0);
    await migration.down(db);   // down twice is safe
  } finally {
    await migration.up(db);
    for (const p of parked) await db('Checkin').where({ id: p.id }).update({ source: 'web_gym_qr_by_member' });
  }
  assert.ok((await sourceConstraint()).includes('web_gym_qr_by_member'));
  assert.ok((await columns()).includes('intentId'));
});
