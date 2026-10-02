// Cancellations and refunds — members cancel a trainer session or a shop
// order themselves; refunds those cancellations raise, and refunds asked for
// on a pass or plan payment, are decided and paid by FitFlex staff.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { refundService, trainerBookingService, shopService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

const send = (res, result, ok = 200) => {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  res.status(ok).json(result);
};

// ── Cancelling ──────────────────────────────────────────────────────────────

export const memberCancelTrainerBooking = {
  created, method: 'post', path: '/me/trainer-bookings/:id/cancel',
  description: 'Member: cancel one trainer session. Unpaid: any time before it starts. Paid: up to 24 hours before, refunded in full (409 cancellation_window_passed after that). → { booking, refund }',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await trainerBookingService.memberCancelBooking({ memberId: req.user.sub, bookingId: req.params.id })),
};

export const trainerCancelBooking = {
  created, method: 'post', path: '/trainer/bookings/:id/cancel',
  description: 'Trainer: cancel a session any time before it starts. A paid session is refunded to the member in full. → { booking, refund }',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => send(res, await trainerBookingService.trainerCancelBooking({ userId: req.user.sub, bookingId: req.params.id })),
};

export const cancelMyShopOrder = {
  created, method: 'post', path: '/me/shop-orders/:id/cancel',
  description: 'Buyer: cancel my order before it is dispatched or ready for pickup (409 order_already_dispatched after that). Stock is released; a paid order is refunded in full. → { order, refund }',
  onGuard: requireAuth(),
  onRequest: async (req, res) => send(res, await shopService.buyerCancelOrder({ buyerId: req.user.sub, orderId: req.params.id })),
};

// ── Refunds: members ────────────────────────────────────────────────────────

export const myRefunds = {
  created, method: 'get', path: '/me/refunds',
  description: 'Any signed-in user: my refunds and where each stands (requested, approved, paid, rejected).',
  onGuard: requireAuth(),
  onRequest: async (req, res) => send(res, await refundService.listMine(req.user.sub)),
};

export const requestRefund = {
  created, method: 'post', path: '/me/refunds',
  description: 'Member: ask for a pass or plan payment back. Body { paymentRequestId | subscriptionId, reasonCode: charged_twice | not_activated | other, note? } (note required for "other"). Sessions and orders are refunded by cancelling them.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await refundService.requestForPayment({ memberId: req.user.sub, body: req.body || {} }), 201),
};

// ── Refunds: FitFlex staff ──────────────────────────────────────────────────

export const adminListRefunds = {
  created, method: 'get', path: '/admin/refunds',
  description: 'Admin: refunds with who they are for. ?status=requested|approved|paid|rejected',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => send(res, await refundService.adminList({ status: req.query?.status || undefined })),
};

export const adminRaiseRefund = {
  created, method: 'post', path: '/admin/refunds',
  description: 'Admin: raise a refund for a confirmed pass or plan payment (approved at once). Body { paymentRequestId, amountTzs?, reasonCode?, note? }.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => send(res, await refundService.adminRaise({ body: req.body || {}, actorId: req.user.sub }), 201),
};

export const adminDecideRefund = {
  created, method: 'post', path: '/admin/refunds/:id/decision',
  description: 'Admin: approve or reject a requested refund. Body { decision: approve | reject, note? (required to reject; the member sees it), amountTzs? (approve less than asked), endAccess? (end the pass or plan now) }.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => send(res, await refundService.decide({ id: req.params.id, body: req.body || {}, actorId: req.user.sub })),
};

export const adminMarkRefundPaid = {
  created, method: 'post', path: '/admin/refunds/:id/paid',
  description: 'Admin: record that an approved refund was sent. Body { paymentReference, paidTo? }.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => send(res, await refundService.markPaid({ id: req.params.id, body: req.body || {}, actorId: req.user.sub })),
};
