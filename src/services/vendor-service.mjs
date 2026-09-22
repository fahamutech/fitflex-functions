// FitFlex Af — Vendor B2B Service (clean architecture + DI)
//
// Extends the marketplace vendor module with:
//   - Customer enquiries & 2-way messaging
//   - Earnings ledger & payout management (request early payout, history)
//   - Vendor profile management (update business details, payout info)
//
// Dependencies: marketplace orders (for payout calculation), vendors collection.

import { randomUUID } from 'node:crypto';
import {
  ENQUIRY_STATUS,
  PAYOUT_STATUS,
  PAYOUT_CYCLE,
  MIN_EARLY_PAYOUT_TZS,
  calculateVendorPayoutBalance
} from '../shared/vendor-constants.mjs';
import { VENDOR_STATUS, VENDOR_COMMISSION_RANGE } from '../shared/marketplace-constants.mjs';

export function createVendorService({ users, vendors, marketplaceOrders, enquiries, payouts, auditLog }) {

  // ─── Enquiry Messaging ───────────────────────────────────────────────────

  function createEnquiry({ memberId, vendorId, productId, subject, message }) {
    const vendor = vendors.find(v => v.id === vendorId);
    if (!vendor) return { ok: false, error: 'vendor_not_found' };
    if (vendor.status !== VENDOR_STATUS.ACTIVE)
      return { ok: false, error: 'vendor_not_active' };

    const enquiry = {
      id: `enq_${randomUUID().slice(0, 8)}`,
      memberId,
      vendorId,
      productId: productId || null,
      subject: subject || 'Product enquiry',
      status: ENQUIRY_STATUS.OPEN,
      messages: [{
        id: randomUUID().slice(0, 6),
        sender: 'member',
        text: message,
        timestamp: new Date().toISOString()
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    enquiries.insert(enquiry);
    return { ok: true, enquiry };
  }

  function vendorReplyEnquiry({ enquiryId, vendorId, message }) {
    const enquiry = enquiries.find(e => e.id === enquiryId);
    if (!enquiry) return { ok: false, error: 'enquiry_not_found' };
    if (enquiry.vendorId !== vendorId)
      return { ok: false, error: 'not_authorized' };
    if (!message || message.trim().length < 1)
      return { ok: false, error: 'message_required' };

    enquiry.messages.push({
      id: randomUUID().slice(0, 6),
      sender: 'vendor',
      text: message.trim(),
      timestamp: new Date().toISOString()
    });

    const updated = enquiries.update(e => e.id === enquiryId, {
      messages: enquiry.messages,
      status: ENQUIRY_STATUS.REPLIED,
      updatedAt: new Date().toISOString()
    });

    return { ok: true, enquiry: updated };
  }

  function memberReplyEnquiry({ enquiryId, memberId, message }) {
    const enquiry = enquiries.find(e => e.id === enquiryId);
    if (!enquiry) return { ok: false, error: 'enquiry_not_found' };
    if (enquiry.memberId !== memberId)
      return { ok: false, error: 'not_authorized' };
    if (!message || message.trim().length < 1)
      return { ok: false, error: 'message_required' };

    enquiry.messages.push({
      id: randomUUID().slice(0, 6),
      sender: 'member',
      text: message.trim(),
      timestamp: new Date().toISOString()
    });

    const updated = enquiries.update(e => e.id === enquiryId, {
      messages: enquiry.messages,
      status: ENQUIRY_STATUS.OPEN, // reopen for vendor
      updatedAt: new Date().toISOString()
    });

    return { ok: true, enquiry: updated };
  }

  function closeEnquiry({ enquiryId, closedBy, isVendor }) {
    const enquiry = enquiries.find(e => e.id === enquiryId);
    if (!enquiry) return { ok: false, error: 'enquiry_not_found' };
    if (isVendor && enquiry.vendorId !== closedBy)
      return { ok: false, error: 'not_authorized' };
    if (!isVendor && enquiry.memberId !== closedBy)
      return { ok: false, error: 'not_authorized' };

    const updated = enquiries.update(e => e.id === enquiryId, {
      status: ENQUIRY_STATUS.CLOSED,
      updatedAt: new Date().toISOString()
    });
    return { ok: true, enquiry: updated };
  }

  function listVendorEnquiries(vendorId, { status, limit = 50 } = {}) {
    let list = enquiries.filter(e => e.vendorId === vendorId);
    if (status) list = list.filter(e => e.status === status);
    return list
      .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
      .slice(0, limit)
      .map(e => {
        const user = users.find(u => u.id === e.memberId);
        return { ...e, memberName: user?.displayName || null };
      });
  }

  function listMemberEnquiries(memberId, { limit = 50 } = {}) {
    return enquiries
      .filter(e => e.memberId === memberId)
      .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
      .slice(0, limit)
      .map(e => {
        const vendor = vendors.find(v => v.id === e.vendorId);
        return { ...e, vendorName: vendor?.name || null };
      });
  }

  function getEnquiry(enquiryId) {
    const enquiry = enquiries.find(e => e.id === enquiryId);
    if (!enquiry) return null;
    const user = users.find(u => u.id === enquiry.memberId);
    const vendor = vendors.find(v => v.id === enquiry.vendorId);
    return {
      ...enquiry,
      memberName: user?.displayName || null,
      vendorName: vendor?.name || null
    };
  }

  // ─── Payout Management ────────────────────────────────────────────────────

  function getVendorPayoutBalance(vendorId) {
    return calculateVendorPayoutBalance({
      vendorId,
      orders: marketplaceOrders.all ? marketplaceOrders.all() : marketplaceOrders.filter(() => true),
      payouts: payouts.all ? payouts.all() : payouts.filter(() => true)
    });
  }

  function requestEarlyPayout({ vendorId, requestedBy }) {
    const balance = getVendorPayoutBalance(vendorId);
    if (balance.availableBalance < MIN_EARLY_PAYOUT_TZS)
      return { ok: false, error: 'insufficient_balance', minRequired: MIN_EARLY_PAYOUT_TZS, available: balance.availableBalance };

    const vendor = vendors.find(v => v.id === vendorId);
    if (!vendor) return { ok: false, error: 'vendor_not_found' };

    const payout = {
      id: `pyr_${randomUUID().slice(0, 8)}`,
      vendorId,
      amount: balance.availableBalance,
      commissionDeducted: 0, // already deducted in order breakdown
      netAmount: balance.availableBalance,
      status: PAYOUT_STATUS.PENDING,
      payoutMethod: vendor.payoutMethod || 'mpesa',
      payoutPhone: vendor.payoutPhone || null,
      payoutBankAccount: vendor.payoutBankAccount || null,
      requestedBy,
      requestedAt: new Date().toISOString(),
      processedAt: null,
      completedAt: null,
      reference: null
    };

    payouts.insert(payout);

    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: requestedBy, action: 'payout_requested',
      target: vendorId, before: null, after: payout
    });

    return { ok: true, payout };
  }

  function processPayout({ payoutId, adminId, reference }) {
    const payout = payouts.find(p => p.id === payoutId);
    if (!payout) return { ok: false, error: 'payout_not_found' };
    if (payout.status !== PAYOUT_STATUS.PENDING)
      return { ok: false, error: 'payout_not_pending' };

    const updated = payouts.update(p => p.id === payoutId, {
      status: PAYOUT_STATUS.PROCESSING,
      processedAt: new Date().toISOString(),
      processedBy: adminId,
      reference: reference || null
    });

    return { ok: true, payout: updated };
  }

  function completePayout({ payoutId, adminId, reference }) {
    const payout = payouts.find(p => p.id === payoutId);
    if (!payout) return { ok: false, error: 'payout_not_found' };
    if (payout.status !== PAYOUT_STATUS.PROCESSING)
      return { ok: false, error: 'payout_not_processing' };

    const updated = payouts.update(p => p.id === payoutId, {
      status: PAYOUT_STATUS.COMPLETED,
      completedAt: new Date().toISOString(),
      reference: reference || payout.reference
    });

    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: adminId, action: 'payout_completed',
      target: payoutId, before: payout, after: updated
    });

    return { ok: true, payout: updated };
  }

  function failPayout({ payoutId, adminId, reason }) {
    const payout = payouts.find(p => p.id === payoutId);
    if (!payout) return { ok: false, error: 'payout_not_found' };

    const updated = payouts.update(p => p.id === payoutId, {
      status: PAYOUT_STATUS.FAILED,
      failureReason: reason || null
    });

    return { ok: true, payout: updated };
  }

  function getVendorPayoutHistory(vendorId, { limit = 50 } = {}) {
    return payouts
      .filter(p => p.vendorId === vendorId)
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))
      .slice(0, limit);
  }

  function getVendorEarningsLedger(vendorId) {
    const balance = getVendorPayoutBalance(vendorId);
    const history = getVendorPayoutHistory(vendorId);
    const allOrders = marketplaceOrders.filter
      ? marketplaceOrders.filter(o => o.vendorBreakdown?.some(v => v.vendorId === vendorId))
      : [];

    // Group by month
    const monthly = {};
    for (const order of allOrders) {
      const month = order.createdAt?.slice(0, 7) || 'unknown';
      if (!monthly[month]) monthly[month] = { month, gross: 0, commission: 0, net: 0, orders: 0 };
      const vBreak = order.vendorBreakdown.find(v => v.vendorId === vendorId);
      if (vBreak) {
        monthly[month].gross += vBreak.gross;
        monthly[month].commission += vBreak.commission;
        monthly[month].net += vBreak.payout;
        monthly[month].orders += 1;
      }
    }

    return {
      balance,
      payoutHistory: history,
      monthlyBreakdown: Object.values(monthly).sort((a, b) => b.month.localeCompare(a.month))
    };
  }

  // ─── Vendor Profile Management ─────────────────────────────────────────────

  function getVendorProfile(vendorId) {
    const vendor = vendors.find(v => v.id === vendorId);
    if (!vendor) return null;
    const user = users.find(u => u.id === vendor.userId);
    return {
      ...vendor,
      userName: user?.displayName || null,
      userEmail: user?.email || null,
      userPhone: user?.phone || null
    };
  }

  function updateVendorProfile(vendorId, updates) {
    const vendor = vendors.find(v => v.id === vendorId);
    if (!vendor) return { ok: false, error: 'vendor_not_found' };

    const allowed = ['name', 'businessName', 'email', 'phone', 'city', 'taxId',
                     'payoutMethod', 'payoutPhone', 'payoutBankAccount'];

    // Commission rate can be updated but must be within range
    if (updates.commissionRate !== undefined) {
      const rate = Number(updates.commissionRate);
      if (rate < VENDOR_COMMISSION_RANGE.min || rate > VENDOR_COMMISSION_RANGE.max)
        return { ok: false, error: `commissionRate must be between ${VENDOR_COMMISSION_RANGE.min} and ${VENDOR_COMMISSION_RANGE.max}` };
      allowed.push('commissionRate');
    }

    const patch = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) patch[key] = updates[key];
    }
    patch.updatedAt = new Date().toISOString();

    const updated = vendors.update(v => v.id === vendorId, patch);
    return { ok: true, vendor: updated };
  }

  // ─── Admin: All Vendor Payouts ────────────────────────────────────────────

  function getAllPayouts({ status, limit = 100 } = {}) {
    let list = payouts.all ? payouts.all() : payouts.filter(() => true);
    if (status) list = list.filter(p => p.status === status);
    return list
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))
      .slice(0, limit)
      .map(p => {
        const vendor = vendors.find(v => v.id === p.vendorId);
        return { ...p, vendorName: vendor?.name || null };
      });
  }

  return {
    // Enquiries
    createEnquiry, vendorReplyEnquiry, memberReplyEnquiry, closeEnquiry,
    listVendorEnquiries, listMemberEnquiries, getEnquiry,
    // Payouts
    getVendorPayoutBalance, requestEarlyPayout, processPayout,
    completePayout, failPayout, getVendorPayoutHistory,
    getVendorEarningsLedger, getAllPayouts,
    // Profile
    getVendorProfile, updateVendorProfile,
    // Constants re-export
    _constants: {
      ENQUIRY_STATUS, PAYOUT_STATUS, PAYOUT_CYCLE, MIN_EARLY_PAYOUT_TZS,
      calculateVendorPayoutBalance
    }
  };
}
