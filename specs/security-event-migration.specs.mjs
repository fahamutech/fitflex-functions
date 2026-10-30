// Migration 20270130090000-security-event against the CI database: table shape, check constraints, per-check-in
// uniqueness, cascade on User delete, idempotent up, reversible down. No IP / user agent / session / intent columns.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import migration from '../db/migrations/20270130090000-security-event.cjs';

assert.match(String(process.env.DATABASE_URL_CI || ''), /fitflex_ci/, 'specs run against the CI database only');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = [];
after(async () => {
  if (made.length) await db('User').whereIn('id', made).del();
  await db.destroy();
});
const rejects = (p, code) => assert.rejects(p, err => err.code === code, `expected Postgres error ${code}`);
const user = async () => { const id = uid('usr'); await db('User').insert({ id, userType: 'member', displayName: 'SecEvent Mig', updatedAt: new Date() }); made.push(id); return id; };
const ev = (userId, extra = {}) => ({ id: uid('sev'), userId, kind: 'web_checkin', checkinId: uid('chk'), gymId: 'g', occurredAt: new Date(), notifyState: 'none', ...extra });

test('columns are exactly the minimal set (no IP, user agent, client meta, session or intent id)', async () => {
  const cols = (await db.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'SecurityEvent'`)).rows.map(r => r.column_name).sort();
  assert.deepEqual(cols, ['businessDate', 'channel', 'checkinId', 'createdAt', 'details', 'gymId', 'id', 'kind', 'notifiedAt', 'notifyState', 'occurredAt', 'userId']);
});

test('constraints: kind and notifyState checks, one event per check-in, cascade on user delete', async () => {
  const u = await user();
  await db('SecurityEvent').insert(ev(u));
  await rejects(db('SecurityEvent').insert(ev(u, { kind: 'other' })), '23514');
  await rejects(db('SecurityEvent').insert(ev(u, { notifyState: 'sent' })), '23514');
  const dup = ev(u);
  await db('SecurityEvent').insert(dup);
  await rejects(db('SecurityEvent').insert(ev(u, { checkinId: dup.checkinId })), '23505');
  await rejects(db('SecurityEvent').insert(ev('usr_missing_x')), '23503');
  await db('User').where({ id: u }).del();
  assert.equal((await db('SecurityEvent').where({ userId: u })).length, 0);
});

test('up is idempotent; down drops the table; up restores it', async () => {
  await migration.up(db);
  await migration.up(db);
  try {
    await migration.down(db);
    assert.equal(await db.schema.hasTable('SecurityEvent'), false);
    await migration.down(db);   // dropping twice is harmless
  } finally {
    await migration.up(db);
  }
  assert.equal(await db.schema.hasTable('SecurityEvent'), true);
  const idx = (await db.raw(`SELECT indexname FROM pg_indexes WHERE tablename = 'SecurityEvent'`)).rows.map(r => r.indexname);
  for (const n of ['security_event_user_time_idx', 'security_event_kind_checkin_uq']) assert.ok(idx.includes(n), n);
});
