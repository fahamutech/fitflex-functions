// FitFlex Af — Vendor B2B REST Endpoints
//
//   - Member: create enquiry, reply, close, list own enquiries
//   - Vendor: reply to enquiries, list own enquiries, earnings ledger, request payout
//   - Admin: process/complete/fail payouts, view all payouts
//
// To wire into index.mjs:
//   import { initVendorEndpoints } from './vendor-endpoints.mjs';
//   initVendorEndpoints({ collection, requireAuth, auditLog, users, vendors, marketplaceOrders });

import { randomUUID } from 'node:crypto';
import { createVendorService } from '../src/services/vendor-service.mjs';

let svc = null;
let requireAuth = null;
let auditLog = null;
let users = null;

export function initVendorEndpoints({ collection, requireAuth: ra, auditLog: al, users: u }) {
  svc = createVendorService({
    users: u,
    vendors: collection('vendors'),
    marketplaceOrders: collection('marketplace_orders'),
    enquiries: collection('enquiries'),
    payouts: collection('vendor_payouts'),
    auditLog: al
  });
  requireAuth = ra;
  auditLog = al;
  users = u;
}

const created = new Date().toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// MEMBER: Product Enquiries
// ═══════════════════════════════════════════════════════════════════════════
export const createEnquiry = {
  created, method: 'post', path: '/me/enquiries',
  description: 'Member: send a product enquiry to a vendor. Body: { vendorId, productId?, subject, message }',
  requestSample: { vendorId: 'ven_001', productId: 'prod_001', subject: 'Is this whey protein halal?', message: 'I wanted to ask about the certification.' },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { vendorId, productId, subject, message } = req.body || {};
    if (!vendorId) return res.status(400).json({ error: 'vendorId_required' });
    if (!message) return res.status(400).json({ error: 'message_required' });
    const result = svc.createEnquiry({
      memberId: req.user.sub,
      vendorId,
      productId,
      subject,
      message
    });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const memberReplyEnquiry = {
  created, method: 'post', path: '/me/enquiries/:id/reply',
  description: 'Member: reply to an existing enquiry thread.',
  requestSample: { message: 'Thanks, one more question...' },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message_required' });
    const result = svc.memberReplyEnquiry({
      enquiryId: req.params.id,
      memberId: req.user.sub,
      message
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const memberCloseEnquiry = {
  created, method: 'post', path: '/me/enquiries/:id/close',
  description: 'Member: close an enquiry thread.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = svc.closeEnquiry({
      enquiryId: req.params.id,
      closedBy: req.user.sub,
      isVendor: false
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const memberEnquiries = {
  created, method: 'get', path: '/me/enquiries',
  description: 'Member: list own enquiries (all statuses).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { limit } = req.query || {};
    const list = svc.listMemberEnquiries(req.user.sub, { limit: limit ? Number(limit) : 50 });
    res.json(list);
  }
};

export const memberEnquiryDetail = {
  created, method: 'get', path: '/me/enquiries/:id',
  description: 'Member: view a single enquiry with full message thread.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const enquiry = svc.getEnquiry(req.params.id);
    if (!enquiry) return res.status(404).json({ error: 'enquiry_not_found' });
    if (enquiry.memberId !== req.user.sub) return res.status(403).json({ error: 'not_authorized' });
    res.json(enquiry);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// VENDOR: Enquiries & Earnings
// ═══════════════════════════════════════════════════════════════════════════
export const vendorEnquiries = {
  created, method: 'get', path: '/vendor/enquiries',
  description: 'Vendor: list all enquiries for your store. ?status=open|replied|closed',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { status, vendorId } = req.query || {};
    const list = svc.listVendorEnquiries(vendorId || req.user.sub, {
      status,
      limit: 50
    });
    res.json(list);
  }
};

export const vendorReplyEnquiry = {
  created, method: 'post', path: '/vendor/enquiries/:id/reply',
  description: 'Vendor: reply to a customer enquiry.',
  requestSample: { message: 'Yes, this product is halal-certified. Here is the certificate link...' },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { message, vendorId } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message_required' });
    const result = svc.vendorReplyEnquiry({
      enquiryId: req.params.id,
      vendorId: vendorId || req.user.sub,
      message
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const vendorCloseEnquiry = {
  created, method: 'post', path: '/vendor/enquiries/:id/close',
  description: 'Vendor: close an enquiry thread.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = svc.closeEnquiry({
      enquiryId: req.params.id,
      closedBy: req.body?.vendorId || req.user.sub,
      isVendor: true
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const vendorEarningsLedger = {
  created, method: 'get', path: '/vendor/earnings',
  description: 'Vendor: full earnings ledger — balance, payout history, monthly breakdown.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { vendorId } = req.query || {};
    const ledger = svc.getVendorEarningsLedger(vendorId || req.user.sub);
    if (!ledger) return res.status(404).json({ error: 'vendor_not_found' });
    res.json(ledger);
  }
};

export const vendorRequestPayout = {
  created, method: 'post', path: '/vendor/payouts/request',
  description: 'Vendor: request an early payout of available balance. Minimum 50,000 TZS.',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const result = svc.requestEarlyPayout({
      vendorId: req.body?.vendorId || req.user.sub,
      requestedBy: req.user.sub
    });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const vendorPayoutHistory = {
  created, method: 'get', path: '/vendor/payouts',
  description: 'Vendor: list own payout history (all statuses).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { vendorId } = req.query || {};
    const list = svc.getVendorPayoutHistory(vendorId || req.user.sub);
    res.json(list);
  }
};

export const vendorProfile = {
  created, method: 'get', path: '/vendor/profile',
  description: 'Vendor: view own profile (business details, payout info, commission rate).',
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { vendorId } = req.query || {};
    const profile = svc.getVendorProfile(vendorId || req.user.sub);
    if (!profile) return res.status(404).json({ error: 'vendor_not_found' });
    res.json(profile);
  }
};

export const vendorUpdateProfile = {
  created, method: 'put', path: '/vendor/profile',
  description: 'Vendor: update business details, payout info, or commission rate (10-15%).',
  requestSample: { name: 'Bongo Elite Nutrition', phone: '+255700000001', payoutMethod: 'bank', payoutBankAccount: 'CRDB-123456789' },
  onGuard: requireAuth ? requireAuth('member') : undefined,
  onRequest: (req, res) => {
    const { vendorId, ...updates } = req.body || {};
    const result = svc.updateVendorProfile(vendorId || req.user.sub, updates);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: Payout Processing
// ═══════════════════════════════════════════════════════════════════════════
export const adminAllPayouts = {
  created, method: 'get', path: '/admin/vendor-payouts',
  description: 'Admin: list all vendor payouts. ?status=pending|processing|completed|failed',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { status } = req.query || {};
    const list = svc.getAllPayouts({ status });
    res.json(list);
  }
};

export const adminProcessPayout = {
  created, method: 'post', path: '/admin/vendor-payouts/:id/process',
  description: 'Admin: mark a payout as processing (initiating Selcom/bank transfer).',
  requestSample: { reference: 'SEL-TRF-2026-001' },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { reference } = req.body || {};
    const result = svc.processPayout({
      payoutId: req.params.id,
      adminId: req.user.sub,
      reference
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const adminCompletePayout = {
  created, method: 'post', path: '/admin/vendor-payouts/:id/complete',
  description: 'Admin: mark a payout as completed (funds sent to vendor wallet/bank).',
  requestSample: { reference: 'SEL-TRF-2026-001-CONFIRMED' },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { reference } = req.body || {};
    const result = svc.completePayout({
      payoutId: req.params.id,
      adminId: req.user.sub,
      reference
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const adminFailPayout = {
  created, method: 'post', path: '/admin/vendor-payouts/:id/fail',
  description: 'Admin: mark a payout as failed (transfer rejected by bank/Selcom).',
  requestSample: { reason: 'Bank account verification failed' },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { reason } = req.body || {};
    const result = svc.failPayout({
      payoutId: req.params.id,
      adminId: req.user.sub,
      reason
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};
