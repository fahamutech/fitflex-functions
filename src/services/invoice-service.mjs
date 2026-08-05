// Invoice service — admin billing of gym owners for gym usage.
import { randomUUID } from 'node:crypto';

export function createInvoiceService({ invoices, gyms, users, gymPayouts, auditLog }) {
  async function list({ gymId, status, ownerId }) {
    let rows = await invoices.allAsync();
    if (gymId) rows = rows.filter(i => i.gymId === gymId);
    if (status) rows = rows.filter(i => i.status === status);
    if (ownerId) rows = rows.filter(i => i.ownerId === ownerId);
    rows.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return rows;
  }

  async function create({ gymId, amount, note, periodStart, periodEnd, actorId }) {
    if (!gymId || !amount) return { error: 'gymId and amount required', status: 400 };
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    const owner = await users.findAsync(u => u.userType === 'gym_operator' && (u.gymId === gymId || (u.gymIds || []).includes(gymId)));

    const inv = {
      id: randomUUID(),
      gymId,
      gymName: gym.name,
      ownerId: owner?.id || null,
      ownerName: owner?.displayName || owner?.email || null,
      amount: Number(amount),
      status: 'unpaid',
      note: note || null,
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      receiptUrl: null,
      paymentReference: null,
      createdAt: new Date().toISOString(),
      createdBy: actorId,
      paidAt: null,
    };
    await invoices.insertAsync(inv);
    auditLog.insert({
      id: randomUUID(), at: inv.createdAt,
      actor: actorId, action: 'invoice_created',
      target: inv.id, before: null, after: inv
    });
    return { invoice: inv };
  }

  async function update({ id, receiptUrl, paymentReference, status, note, actorId }) {
    const inv = await invoices.findAsync(i => i.id === id);
    if (!inv) return { error: 'invoice_not_found', status: 404 };

    const before = { ...inv };
    const updates = {};
    if (receiptUrl !== undefined) updates.receiptUrl = receiptUrl;
    if (paymentReference !== undefined) updates.paymentReference = paymentReference;
    if (note !== undefined) updates.note = note;
    if (status === 'paid') {
      updates.status = 'paid';
      updates.paidAt = new Date().toISOString();
      await gymPayouts.insertAsync({
        id: randomUUID(),
        gymId: inv.gymId,
        invoiceId: inv.id,
        amount: inv.amount,
        status: 'paid',
        periodStart: inv.periodStart || null,
        periodEnd: inv.periodEnd || null,
        paidAt: updates.paidAt,
        reference: paymentReference || receiptUrl || null
      });
    } else if (status) {
      updates.status = status;
    }

    const updated = await invoices.updateByIdAsync(inv.id, updates);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'invoice_updated',
      target: inv.id, before, after: updated
    });
    return { invoice: updated };
  }

  async function get(id) {
    const inv = await invoices.findAsync(i => i.id === id);
    if (!inv) return { error: 'invoice_not_found', status: 404 };
    return { invoice: inv };
  }

  return { list, create, update, get };
}
