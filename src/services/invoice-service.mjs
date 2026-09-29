// Invoice service — admin billing of gym owners for gym usage.
import { randomUUID } from 'node:crypto';
import { OPEN_GATE } from './partner-gate.mjs';
import { isPayable } from '../shared/partner-kyc.mjs';

export function createInvoiceService({ invoices, gyms, users, gymPayouts, auditLog, partnerGate = OPEN_GATE, partnerSettlementAccounts = null }) {
  /**
   * Where a gym's payout may go. New partners' gyms are paid only once the
   * owner's KYC is approved and they have a verified payout account past its
   * cooling-off period. Existing partners' gyms (test gyms) and gyms with no
   * owner account are exempt.
   */
  async function payoutDestination(gymId) {
    const owner = await users.findAsync(u => u.userType === 'gym_operator' && (u.gymId === gymId || (u.gymIds || []).includes(gymId)));
    if (!owner || partnerGate.exempt(owner)) return { exempt: true };
    const kyc = await partnerGate.kycCaseFor(owner.id, 'gym_owner');
    if (!kyc || kyc.status !== 'approved') {
      return { error: 'payout_on_hold', status: 409, reason: kyc ? `kyc_${kyc.status}` : 'kyc_not_started' };
    }
    const accounts = partnerSettlementAccounts ? await partnerSettlementAccounts.filterByColumnAsync('caseId', kyc.id) : [];
    const account = accounts.find(a => isPayable(a));
    if (account) return { account };
    const cooling = accounts.find(a => a.status === 'verified' && a.isPrimary);
    return cooling
      ? { error: 'payout_account_cooling_off', status: 409, until: cooling.cooldownUntil }
      : { error: 'payout_account_not_verified', status: 409 };
  }

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
    await auditLog.insertAsync({
      id: randomUUID(), at: inv.createdAt,
      actor: actorId, action: 'invoice_created',
      target: inv.id, before: null, after: inv
    });
    return { invoice: inv };
  }

  async function update({ id, receiptUrl, paymentReference, status, note, actorId }) {
    const inv = await invoices.findAsync(i => i.id === id);
    if (!inv) return { error: 'invoice_not_found', status: 404 };

    let destination = null;
    if (status === 'paid' && inv.status !== 'paid') {
      const check = await payoutDestination(inv.gymId);
      if (check.error) return check;
      if (check.account) {
        const a = check.account;
        destination = { accountId: a.id, method: a.method, provider: a.provider, accountLast4: String(a.accountNumber || '').slice(-4) };
      }
    }

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
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'invoice_updated',
      target: inv.id, before, after: { ...updated, ...(destination ? { payoutDestination: destination } : {}) }
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
