// Admin-portal audit M4: repeating status:'paid' on a paid legacy gym invoice must not add a second payout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { createRequire } from 'node:module';
import { createInvoiceService } from '../src/services/invoice-service.mjs';
import { invoiceService } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
const migration = createRequire(import.meta.url)('../db/migrations/20270126090000-gym-payout-invoice-unique.cjs');

function store(seed = []) {
  const rows = [...seed];
  return {
    rows,
    findAsync: async p => rows.find(p) || null,
    findByIdAsync: async id => rows.find(r => r.id === id) || null,
    insertAsync: async r => { rows.push(r); return r; },
    updateByIdAsync: async (id, patch) => Object.assign(rows.find(r => r.id === id), patch),
  };
}
function setup() {
  const invoices = store([{ id: 'i1', gymId: 'g1', amount: 50000, status: 'sent', periodStart: '2026-10-01', periodEnd: '2026-10-31' }]);
  const gymPayouts = store();
  const svc = createInvoiceService({ invoices, gyms: store(), users: store(), gymPayouts, auditLog: store() });
  return { svc, invoices, gymPayouts };
}

test('first paid update creates exactly one payout', async () => {
  const { svc, gymPayouts, invoices } = setup();
  const r = await svc.update({ id: 'i1', status: 'paid', paymentReference: 'R1', actorId: 'a' });
  assert.equal(r.invoice.status, 'paid');
  assert.equal(gymPayouts.rows.length, 1);
  assert.equal(gymPayouts.rows[0].amount, 50000);
  assert.ok(invoices.rows[0].paidAt);
});

test('a repeated paid update creates no second payout, keeps paidAt, still updates other fields', async () => {
  const { svc, gymPayouts, invoices } = setup();
  await svc.update({ id: 'i1', status: 'paid', actorId: 'a' });
  const firstPaidAt = invoices.rows[0].paidAt;
  await new Promise(r => setTimeout(r, 5));
  const again = await svc.update({ id: 'i1', status: 'paid', note: 'receipt attached', receiptUrl: 'u', actorId: 'a' });
  assert.equal(again.invoice.status, 'paid');
  assert.equal(gymPayouts.rows.length, 1);
  assert.equal(again.invoice.paidAt, firstPaidAt);
  assert.equal(again.invoice.note, 'receipt attached');
  assert.equal(again.invoice.receiptUrl, 'u');
});

// ── database-backed: atomic (conditional UPDATE + unique index) ─────────────

const made = { gyms: [], invoices: [] };
after(async () => {
  await db('GymPayout').whereIn('invoiceId', made.invoices).del();
  await db('AuditLog').whereIn('target', made.invoices).del();
  await db('Invoice').whereIn('id', made.invoices).del();
  await db('Gym').whereIn('id', made.gyms).del();
  await db.destroy();
});

async function dbInvoice() {
  const gymId = `gym_pay_${randomUUID().slice(0, 8)}`;
  const id = `inv_pay_${randomUUID().slice(0, 8)}`;
  await db('Gym').insert({ id: gymId, name: 'Pay Gym', tier: 'standard', location: 'Dar', updatedAt: new Date() });
  await db('Invoice').insert({ id, gymId, gymName: 'Pay Gym', amount: 70000, status: 'unpaid', createdBy: 'spec' });
  made.gyms.push(gymId); made.invoices.push(id);
  return id;
}
const payouts = id => db('GymPayout').where({ invoiceId: id });

test('db: two concurrent paid updates create exactly one payout', async () => {
  const id = await dbInvoice();
  const results = await Promise.all([
    invoiceService.update({ id, status: 'paid', paymentReference: 'A', actorId: 'a' }),
    invoiceService.update({ id, status: 'paid', paymentReference: 'B', actorId: 'b' }),
  ]);
  assert.ok(results.every(r => r.invoice?.status === 'paid'), JSON.stringify(results));
  assert.equal((await payouts(id)).length, 1);
  const again = await invoiceService.update({ id, status: 'paid', note: 'later', actorId: 'a' });
  assert.equal(again.invoice.note, 'later');
  assert.equal((await payouts(id)).length, 1);
});

test('db: the unique index refuses a second payout row for one invoice', async () => {
  const id = await dbInvoice();
  const row = n => ({ id: `gp_${randomUUID().slice(0, 8)}${n}`, gymId: null, invoiceId: id, amount: 1, status: 'paid' });
  const gymId = (await db('Invoice').where({ id }).first()).gymId;
  await db('GymPayout').insert({ ...row(1), gymId });
  await assert.rejects(() => db('GymPayout').insert({ ...row(2), gymId }), /gympayout_invoiceid_unique|duplicate key/);
});

test('db: the migration with existing duplicates deletes nothing and creates no index; without, it creates it', async () => {
  const id = await dbInvoice();
  const gymId = (await db('Invoice').where({ id }).first()).gymId;
  await migration.down(db);
  try {
    for (const n of [1, 2]) await db('GymPayout').insert({ id: `gp_dup_${randomUUID().slice(0, 8)}${n}`, gymId, invoiceId: id, amount: 1, status: 'paid' });
    await migration.up(db);
    assert.equal((await payouts(id)).length, 2, 'duplicates are kept');
    assert.equal((await db.raw(`select 1 from pg_indexes where indexname = 'gympayout_invoiceid_unique'`)).rows.length, 0);
  } finally {
    await db('GymPayout').where({ invoiceId: id }).del();
    await migration.up(db);
  }
  assert.equal((await db.raw(`select 1 from pg_indexes where indexname = 'gympayout_invoiceid_unique'`)).rows.length, 1);
});
