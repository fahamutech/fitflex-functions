// Admin-portal audit M4: repeating status:'paid' on a paid legacy gym invoice must not add a second payout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvoiceService } from '../src/services/invoice-service.mjs';

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
