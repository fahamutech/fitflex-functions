// B2B Foundation V1 against the CI database: what the schema refuses, the
// store wiring, and the Corporate backfill migration (idempotent, reversible,
// Corporate tables untouched).
//
// Every test runs inside a transaction that is rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, collection } from '../src/infra/knex-store.mjs';
import { corporateOrganizationId } from '../src/services/b2b-service.mjs';

const backfill = (await import('../db/migrations/20261101091000-b2b-corporate-backfill.cjs')).default;

const ROLLBACK = Symbol('rollback');
const uid = p => `${p}_${randomUUID().slice(0, 8)}`;

async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

/** Expect a Postgres error inside a savepoint, so the outer transaction survives. */
async function rejects(trx, fn, ...codes) {
  await assert.rejects(trx.transaction(fn), err => codes.includes(err.code), `expected Postgres error ${codes.join(' or ')}`);
}

const org = (extra = {}) => ({ id: uid('b2bo'), organizationType: 'insurer', legalName: 'Schema Insurer', ...extra });
const corp = (extra = {}) => ({
  id: uid('corp'), companyName: 'Schema Co', industrySector: 'banking', workforceBracket: '50-100',
  subsidyModel: 'fully_funded', passTier: 'pro', ...extra,
});
async function member(trx) {
  const id = uid('usr');
  await trx('User').insert({ id, userType: 'member', displayName: 'B2B schema member', updatedAt: new Date() });
  return id;
}

test('organisation status, type shape, name and the employer-only corporate link are enforced', () => inRollback(async (trx) => {
  await rejects(trx, t => t('B2BOrganization').insert(org({ status: 'terminated' })), '23514');
  await rejects(trx, t => t('B2BOrganization').insert(org({ organizationType: 'Big Insurer' })), '23514');
  await rejects(trx, t => t('B2BOrganization').insert(org({ legalName: '   ' })), '23514');
  const c = corp();
  await trx('CorporateAccount').insert(c);
  await rejects(trx, t => t('B2BOrganization').insert(org({ legacyCorporateId: c.id })), '23514');
  await trx('B2BOrganization').insert(org({ organizationType: 'employer', legacyCorporateId: c.id }));
  await rejects(trx, t => t('B2BOrganization').insert(org({ organizationType: 'employer', legacyCorporateId: c.id })), '23505');
  // A future type needs no DDL.
  await trx('B2BOrganization').insert(org({ organizationType: 'cooperative_society' }));
  // A mapped company can't be deleted out from under its organisation.
  await rejects(trx, t => t('CorporateAccount').where({ id: c.id }).del(), '23001', '23503');   // restrict_violation (PG 17+) or foreign_key_violation
}));

test('registration and tax numbers are unique across organisations', () => inRollback(async (trx) => {
  await trx('B2BOrganization').insert(org({ registrationNumber: 'REG1', taxIdentificationNumber: 'TIN1' }));
  await rejects(trx, t => t('B2BOrganization').insert(org({ registrationNumber: 'REG1' })), '23505');
  await rejects(trx, t => t('B2BOrganization').insert(org({ taxIdentificationNumber: 'TIN1' })), '23505');
  await trx('B2BOrganization').insert(org());   // nulls don't clash
  await trx('B2BOrganization').insert(org());
}));

test('one live seat per user per organisation; removed seats need removedAt and may be re-added', () => inRollback(async (trx) => {
  const o = org();
  await trx('B2BOrganization').insert(o);
  const userId = await member(trx);
  const seat = { organizationId: o.id, userId, role: 'owner' };
  await rejects(trx, t => t('B2BOrganizationUser').insert({ id: uid('b2bu'), ...seat, userId: 'usr_missing' }), '23503');
  await rejects(trx, t => t('B2BOrganizationUser').insert({ id: uid('b2bu'), ...seat, status: 'deleted' }), '23514');
  await rejects(trx, t => t('B2BOrganizationUser').insert({ id: uid('b2bu'), ...seat, status: 'removed' }), '23514');
  const first = uid('b2bu');
  await trx('B2BOrganizationUser').insert({ id: first, ...seat });
  await rejects(trx, t => t('B2BOrganizationUser').insert({ id: uid('b2bu'), ...seat, role: 'viewer' }), '23505');
  await trx('B2BOrganizationUser').where({ id: first }).update({ status: 'removed', removedAt: new Date() });
  await trx('B2BOrganizationUser').insert({ id: uid('b2bu'), ...seat, role: 'viewer' });
}));

test('one beneficiary row per member and per external reference within an organisation', () => inRollback(async (trx) => {
  const a = org();
  const b = org();
  await trx('B2BOrganization').insert([a, b]);
  const userId = await member(trx);
  const row = extra => ({ id: uid('b2bb'), organizationId: a.id, beneficiaryType: 'member', ...extra });
  await rejects(trx, t => t('B2BBeneficiary').insert(row({ userId, status: 'exited' })), '23514');
  await trx('B2BBeneficiary').insert(row({ userId, externalReference: 'POL-1' }));
  await rejects(trx, t => t('B2BBeneficiary').insert(row({ userId })), '23505');
  const other = await member(trx);
  await rejects(trx, t => t('B2BBeneficiary').insert(row({ userId: other, externalReference: 'POL-1' })), '23505');
  // Same member and reference in another organisation is a separate relationship.
  await trx('B2BBeneficiary').insert(row({ organizationId: b.id, userId, externalReference: 'POL-1' }));
  // Deleting the persona keeps the organisation's record.
  await trx('User').where({ id: userId }).del();
  assert.equal((await trx('B2BBeneficiary').where({ organizationId: b.id }).first()).userId, null);
}));

test('the collection API round-trips address JSON, permission arrays and timestamps', async () => {
  const orgs = collection('b2b_organizations');
  const seats = collection('b2b_organization_users');
  const id = uid('b2bo');
  const userId = uid('usr');
  await db('User').insert({ id: userId, userType: 'member', displayName: 'Wiring', updatedAt: new Date() });
  try {
    await orgs.insertAsync({ ...org({ id }), address: { city: 'Dar es Salaam' }, statusChangedAt: '2026-10-01T09:00:00.000Z' });
    const back = await orgs.findByIdAsync(id);
    assert.deepEqual(back.address, { city: 'Dar es Salaam' });
    assert.equal(new Date(back.statusChangedAt).toISOString(), '2026-10-01T09:00:00.000Z');
    const seatId = uid('b2bu');
    await seats.insertAsync({ id: seatId, organizationId: id, userId, role: 'viewer', permissions: ['beneficiaries.read'], status: 'active' });
    assert.deepEqual((await seats.findByIdAsync(seatId)).permissions, ['beneficiaries.read']);
    await seats.updateByIdAsync(seatId, { status: 'removed', removedAt: new Date().toISOString() });
    assert.equal((await seats.findByIdAsync(seatId)).status, 'removed');
  } finally {
    await db('B2BOrganization').where({ id }).del();   // cascades the seat
    await db('User').where({ id: userId }).del();
  }
});

test('the backfill maps each CorporateAccount once, mirrors status, and leaves Corporate untouched', () => inRollback(async (trx) => {
  const active = corp({ status: 'active', hrContactEmail: 'hr@schema.co' });
  const terminated = corp({ status: 'terminated' });
  const suspended = corp({ status: 'suspended' });
  await trx('CorporateAccount').insert([active, terminated, suspended]);
  const before = await trx('CorporateAccount').whereIn('id', [active.id, terminated.id, suspended.id]).orderBy('id');

  await backfill.up(trx);
  await backfill.up(trx);   // idempotent

  const mapped = await trx('B2BOrganization').whereIn('legacyCorporateId', [active.id, terminated.id, suspended.id]);
  assert.equal(mapped.length, 3);
  const byCorp = Object.fromEntries(mapped.map(o => [o.legacyCorporateId, o]));
  assert.equal(byCorp[active.id].id, corporateOrganizationId(active.id));   // same id the service derives
  assert.deepEqual([byCorp[active.id].organizationType, byCorp[active.id].legalName, byCorp[active.id].email, byCorp[active.id].status],
    ['employer', 'Schema Co', 'hr@schema.co', 'active']);
  assert.equal(byCorp[terminated.id].status, 'inactive');
  assert.equal(byCorp[suspended.id].status, 'suspended');
  assert.deepEqual(await trx('CorporateAccount').whereIn('id', [active.id, terminated.id, suspended.id]).orderBy('id'), before);

  // down keeps any organisation someone has started using.
  const userId = await member(trx);
  await trx('B2BOrganizationUser').insert({ id: uid('b2bu'), organizationId: byCorp[active.id].id, userId, role: 'finance' });
  await backfill.down(trx);
  const left = await trx('B2BOrganization').whereIn('legacyCorporateId', [active.id, terminated.id, suspended.id]);
  assert.deepEqual(left.map(o => o.legacyCorporateId), [active.id]);
  assert.equal((await trx('CorporateAccount').whereIn('id', [active.id, terminated.id, suspended.id])).length, 3);
}));
