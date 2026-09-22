// Unit tests for the vendor B2B service (enquiries, payouts, profile).
// Run with: node --test specs/vendor.specs.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVendorService } from '../src/services/vendor-service.mjs';
import {
  ENQUIRY_STATUS,
  PAYOUT_STATUS,
  MIN_EARLY_PAYOUT_TZS,
  calculateVendorPayoutBalance
} from '../src/shared/vendor-constants.mjs';
import { VENDOR_STATUS } from '../src/shared/marketplace-constants.mjs';

// ─── Mock store ──────────────────────────────────────────────────────────────
function createStore() {
  const data = {
    users: [], gyms: [], vendors: [], products: [],
    marketplace_orders: [], product_reviews: [],
    enquiries: [], vendor_payouts: [], audit_log: [],
    cart: [], checkins: [], subscriptions: [], trainers: [],
    bookings: [], trainer_reviews: []
  };
  function collection(name) {
    return {
      _data: data[name],
      all: () => data[name],
      find: pred => data[name].find(pred),
      filter: pred => data[name].filter(pred),
      some: pred => data[name].some(pred),
      insert: row => { data[name].push(row); return row; },
      update: (pred, patch) => {
        const i = data[name].findIndex(pred);
        if (i >= 0) data[name][i] = { ...data[name][i], ...patch };
        return data[name].find(pred);
      },
      remove: pred => {
        const i = data[name].findIndex(pred);
        if (i >= 0) return data[name].splice(i, 1)[0];
        return null;
      }
    };
  }
  return { data, collection };
}

function setupTestEnv() {
  const { data, collection } = createStore();

  data.users = [
    { id: 'usr_member1', displayName: 'Aisha', userType: 'member' },
    { id: 'usr_vendor', displayName: 'Bongo Elite', userType: 'member' }
  ];

  data.vendors = [{
    id: 'ven_001', userId: 'usr_vendor', name: 'Bongo Elite',
    status: VENDOR_STATUS.ACTIVE, commissionRate: 0.12,
    payoutMethod: 'mpesa', payoutPhone: '+255712345678'
  }];

  // A completed marketplace order with vendor breakdown
  data.marketplace_orders = [{
    id: 'ord_001', memberId: 'usr_member1', status: 'collected',
    createdAt: '2026-09-01T10:00:00.000Z',
    vendorBreakdown: [{
      vendorId: 'ven_001', items: [], gross: 120000, commission: 14400, payout: 105600
    }],
    items: [{ productId: 'prod_001', vendorId: 'ven_001', isDigital: false, quantity: 1, unitPrice: 120000, itemTotal: 120000 }]
  }];

  const svc = createVendorService({
    users: collection('users'),
    vendors: collection('vendors'),
    marketplaceOrders: collection('marketplace_orders'),
    enquiries: collection('enquiries'),
    payouts: collection('vendor_payouts'),
    auditLog: collection('audit_log')
  });

  return { data, svc };
}

// ═══════════════════════════════════════════════════════════════════════════
// ENQUIRY TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Member can create an enquiry to a vendor', () => {
  const { svc } = setupTestEnv();
  const result = svc.createEnquiry({
    memberId: 'usr_member1', vendorId: 'ven_001',
    subject: 'Is this whey halal?',
    message: 'I wanted to ask about the certification.'
  });
  assert.ok(result.ok);
  assert.equal(result.enquiry.status, ENQUIRY_STATUS.OPEN);
  assert.equal(result.enquiry.messages.length, 1);
  assert.equal(result.enquiry.messages[0].sender, 'member');
});

test('Cannot create enquiry to non-existent vendor', () => {
  const { svc } = setupTestEnv();
  const result = svc.createEnquiry({
    memberId: 'usr_member1', vendorId: 'ven_nonexistent',
    message: 'Hello?'
  });
  assert.ok(!result.ok);
  assert.equal(result.error, 'vendor_not_found');
});

test('Cannot create enquiry to inactive vendor', () => {
  const { data, svc } = setupTestEnv();
  data.vendors[0].status = VENDOR_STATUS.SUSPENDED;
  const result = svc.createEnquiry({
    memberId: 'usr_member1', vendorId: 'ven_001',
    message: 'Hello?'
  });
  assert.ok(!result.ok);
  assert.equal(result.error, 'vendor_not_active');
});

test('Vendor can reply to an enquiry', () => {
  const { svc } = setupTestEnv();
  const { enquiry } = svc.createEnquiry({
    memberId: 'usr_member1', vendorId: 'ven_001', message: 'Question about product'
  });
  const result = svc.vendorReplyEnquiry({
    enquiryId: enquiry.id, vendorId: 'ven_001',
    message: 'Yes, it is certified!'
  });
  assert.ok(result.ok);
  assert.equal(result.enquiry.status, ENQUIRY_STATUS.REPLIED);
  assert.equal(result.enquiry.messages.length, 2);
  assert.equal(result.enquiry.messages[1].sender, 'vendor');
});

test('Member can reply to a replied enquiry (reopens it)', () => {
  const { svc } = setupTestEnv();
  const { enquiry } = svc.createEnquiry({
    memberId: 'usr_member1', vendorId: 'ven_001', message: 'Question'
  });
  svc.vendorReplyEnquiry({ enquiryId: enquiry.id, vendorId: 'ven_001', message: 'Answer' });
  const result = svc.memberReplyEnquiry({
    enquiryId: enquiry.id, memberId: 'usr_member1', message: 'One more question'
  });
  assert.ok(result.ok);
  assert.equal(result.enquiry.status, ENQUIRY_STATUS.OPEN); // reopened
  assert.equal(result.enquiry.messages.length, 3);
});

test('Cannot reply to enquiry from wrong vendor', () => {
  const { svc } = setupTestEnv();
  const { enquiry } = svc.createEnquiry({
    memberId: 'usr_member1', vendorId: 'ven_001', message: 'Question'
  });
  const result = svc.vendorReplyEnquiry({
    enquiryId: enquiry.id, vendorId: 'ven_other', message: 'Hacked reply'
  });
  assert.ok(!result.ok);
  assert.equal(result.error, 'not_authorized');
});

test('Either party can close an enquiry', () => {
  const { svc } = setupTestEnv();
  const { enquiry } = svc.createEnquiry({
    memberId: 'usr_member1', vendorId: 'ven_001', message: 'Question'
  });

  // Member closes
  const result = svc.closeEnquiry({
    enquiryId: enquiry.id, closedBy: 'usr_member1', isVendor: false
  });
  assert.ok(result.ok);
  assert.equal(result.enquiry.status, ENQUIRY_STATUS.CLOSED);
});

test('List vendor enquiries shows member names', () => {
  const { svc } = setupTestEnv();
  svc.createEnquiry({ memberId: 'usr_member1', vendorId: 'ven_001', message: 'Test' });
  const list = svc.listVendorEnquiries('ven_001');
  assert.equal(list.length, 1);
  assert.equal(list[0].memberName, 'Aisha');
});

test('List member enquiries shows vendor names', () => {
  const { svc } = setupTestEnv();
  svc.createEnquiry({ memberId: 'usr_member1', vendorId: 'ven_001', message: 'Test' });
  const list = svc.listMemberEnquiries('usr_member1');
  assert.equal(list.length, 1);
  assert.equal(list[0].vendorName, 'Bongo Elite');
});

// ═══════════════════════════════════════════════════════════════════════════
// PAYOUT BALANCE TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Payout balance calculation: earned - disbursed - pending = available', () => {
  const { data, svc } = setupTestEnv();

  // Vendor has earned 105600 from 1 collected order
  // Add a completed payout of 50000
  data.vendor_payouts.push({
    id: 'pyr_001', vendorId: 'ven_001', netAmount: 50000,
    status: PAYOUT_STATUS.COMPLETED, requestedAt: '2026-09-05T10:00:00.000Z'
  });

  const balance = svc.getVendorPayoutBalance('ven_001');
  assert.equal(balance.totalEarned, 105600);
  assert.equal(balance.totalDisbursed, 50000);
  assert.equal(balance.availableBalance, 55600);
});

test('Payout balance with pending payout reduces available', () => {
  const { data, svc } = setupTestEnv();

  data.vendor_payouts.push({
    id: 'pyr_001', vendorId: 'ven_001', netAmount: 30000,
    status: PAYOUT_STATUS.PENDING, requestedAt: '2026-09-05T10:00:00.000Z'
  });

  const balance = svc.getVendorPayoutBalance('ven_001');
  assert.equal(balance.totalEarned, 105600);
  assert.equal(balance.pendingDisbursement, 30000);
  assert.equal(balance.availableBalance, 75600); // 105600 - 30000
});

test('Request early payout with sufficient balance', () => {
  const { svc } = setupTestEnv();
  // Vendor has 105600 available
  const result = svc.requestEarlyPayout({ vendorId: 'ven_001', requestedBy: 'usr_vendor' });
  assert.ok(result.ok);
  assert.equal(result.payout.amount, 105600);
  assert.equal(result.payout.status, PAYOUT_STATUS.PENDING);
  assert.equal(result.payout.payoutMethod, 'mpesa');
  assert.equal(result.payout.payoutPhone, '+255712345678');
});

test('Request early payout below minimum is rejected', () => {
  const { data, svc } = setupTestEnv();

  // Add a completed payout for most of the balance
  data.vendor_payouts.push({
    id: 'pyr_001', vendorId: 'ven_001', netAmount: 100000,
    status: PAYOUT_STATUS.COMPLETED, requestedAt: '2026-09-05T10:00:00.000Z'
  });

  // Only 5600 left — below MIN_EARLY_PAYOUT_TZS (50000)
  const result = svc.requestEarlyPayout({ vendorId: 'ven_001', requestedBy: 'usr_vendor' });
  assert.ok(!result.ok);
  assert.equal(result.error, 'insufficient_balance');
  assert.equal(result.minRequired, MIN_EARLY_PAYOUT_TZS);
  assert.equal(result.available, 5600);
});

test('Admin can process and complete a payout', () => {
  const { svc } = setupTestEnv();
  const { payout } = svc.requestEarlyPayout({ vendorId: 'ven_001', requestedBy: 'usr_vendor' });

  // Process
  const processed = svc.processPayout({ payoutId: payout.id, adminId: 'admin', reference: 'SEL-001' });
  assert.ok(processed.ok);
  assert.equal(processed.payout.status, PAYOUT_STATUS.PROCESSING);

  // Complete
  const completed = svc.completePayout({ payoutId: payout.id, adminId: 'admin', reference: 'SEL-001-CONFIRMED' });
  assert.ok(completed.ok);
  assert.equal(completed.payout.status, PAYOUT_STATUS.COMPLETED);
  assert.ok(completed.payout.completedAt);
});

test('Cannot complete payout without processing first', () => {
  const { svc } = setupTestEnv();
  const { payout } = svc.requestEarlyPayout({ vendorId: 'ven_001', requestedBy: 'usr_vendor' });

  // Try to complete directly (skipping process step)
  const result = svc.completePayout({ payoutId: payout.id, adminId: 'admin' });
  assert.ok(!result.ok);
  assert.equal(result.error, 'payout_not_processing');
});

test('Admin can mark payout as failed', () => {
  const { svc } = setupTestEnv();
  const { payout } = svc.requestEarlyPayout({ vendorId: 'ven_001', requestedBy: 'usr_vendor' });
  const result = svc.failPayout({ payoutId: payout.id, adminId: 'admin', reason: 'Bank rejected' });
  assert.ok(result.ok);
  assert.equal(result.payout.status, PAYOUT_STATUS.FAILED);
  assert.equal(result.payout.failureReason, 'Bank rejected');
});

// ═══════════════════════════════════════════════════════════════════════════
// VENDOR PROFILE TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Get vendor profile with user info', () => {
  const { svc } = setupTestEnv();
  const profile = svc.getVendorProfile('ven_001');
  assert.ok(profile);
  assert.equal(profile.name, 'Bongo Elite');
  assert.equal(profile.userName, 'Bongo Elite');
});

test('Update vendor profile fields', () => {
  const { svc } = setupTestEnv();
  const result = svc.updateVendorProfile('ven_001', {
    name: 'Bongo Elite Nutrition',
    phone: '+255700000001',
    payoutMethod: 'bank',
    payoutBankAccount: 'CRDB-123456789'
  });
  assert.ok(result.ok);
  assert.equal(result.vendor.name, 'Bongo Elite Nutrition');
  assert.equal(result.vendor.payoutMethod, 'bank');
  assert.equal(result.vendor.payoutBankAccount, 'CRDB-123456789');
});

test('Update vendor commission rate within 10-15%', () => {
  const { svc } = setupTestEnv();
  assert.ok(svc.updateVendorProfile('ven_001', { commissionRate: 0.10 }).ok);
  assert.ok(svc.updateVendorProfile('ven_001', { commissionRate: 0.15 }).ok);
  assert.ok(!svc.updateVendorProfile('ven_001', { commissionRate: 0.05 }).ok);
  assert.ok(!svc.updateVendorProfile('ven_001', { commissionRate: 0.20 }).ok);
});

test('Cannot update non-existent vendor profile', () => {
  const { svc } = setupTestEnv();
  const result = svc.updateVendorProfile('ven_nonexistent', { name: 'New Name' });
  assert.ok(!result.ok);
  assert.equal(result.error, 'vendor_not_found');
});

// ═══════════════════════════════════════════════════════════════════════════
// EARNINGS LEDGER TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Earnings ledger shows balance + history + monthly breakdown', () => {
  const { svc } = setupTestEnv();
  const ledger = svc.getVendorEarningsLedger('ven_001');
  assert.ok(ledger);
  assert.ok(ledger.balance);
  assert.ok(Array.isArray(ledger.payoutHistory));
  assert.ok(Array.isArray(ledger.monthlyBreakdown));
  assert.equal(ledger.monthlyBreakdown.length, 1);
  assert.equal(ledger.monthlyBreakdown[0].month, '2026-09');
  assert.equal(ledger.monthlyBreakdown[0].gross, 120000);
  assert.equal(ledger.monthlyBreakdown[0].net, 105600);
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS TESTS
// ═══════════════════════════════════════════════════════════════════════════
test('Enquiry status values are correct', () => {
  assert.equal(ENQUIRY_STATUS.OPEN, 'open');
  assert.equal(ENQUIRY_STATUS.REPLIED, 'replied');
  assert.equal(ENQUIRY_STATUS.CLOSED, 'closed');
});

test('Payout status values are correct', () => {
  assert.equal(PAYOUT_STATUS.PENDING, 'pending');
  assert.equal(PAYOUT_STATUS.PROCESSING, 'processing');
  assert.equal(PAYOUT_STATUS.COMPLETED, 'completed');
  assert.equal(PAYOUT_STATUS.FAILED, 'failed');
  assert.equal(PAYOUT_STATUS.CANCELLED, 'cancelled');
});

test('Min early payout threshold is 50,000 TZS', () => {
  assert.equal(MIN_EARLY_PAYOUT_TZS, 50000);
});

test('calculateVendorPayoutBalance handles empty data', () => {
  const balance = calculateVendorPayoutBalance({
    vendorId: 'ven_001',
    orders: [],
    payouts: []
  });
  assert.equal(balance.totalEarned, 0);
  assert.equal(balance.totalDisbursed, 0);
  assert.equal(balance.availableBalance, 0);
});
