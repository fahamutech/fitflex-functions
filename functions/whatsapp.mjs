// WhatsApp messaging REST surface — OTP delivery, notifications, chat, commerce messages.
// Integrates with Africa's Talking API. Webhooks receive inbound replies.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { timingSafeEqual } from 'node:crypto';
import { whatsAppService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// System-to-system routes must not be callable by the public: anyone could
// otherwise make FitFlex send an arbitrary "OTP" to any member's WhatsApp.
// Callers present FITFLEX_INTERNAL_TOKEN; with no token configured the route
// is closed.
function hasInternalToken(req) {
  const expected = process.env.FITFLEX_INTERNAL_TOKEN;
  const given = req.headers?.['x-fitflex-internal-token'];
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Public (system) ──
export const sendOtp = {
  created, method: 'post', path: '/whatsapp/send-otp',
  description: 'System: send OTP via WhatsApp to user. POST { userId, code }. Requires x-fitflex-internal-token.',
  onRequest: async (req, res) => {
    if (!hasInternalToken(req)) return res.status(403).json({ error: 'forbidden' });
    const { userId, code } = req.body || {};
    if (!userId || !code) return res.status(400).json({ error: 'userId_code_required' });
    const result = await whatsAppService.sendOtp(userId, code);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const whatsappWebhook = {
  created, method: 'post', path: '/whatsapp/webhook',
  description: 'Africa\'s Talking: inbound messages & delivery status. Do NOT require auth.',
  onRequest: async (req, res) => {
    const { from, text, id, timestamp } = req.body || {};
    if (!from || !text) return res.status(400).json({ error: 'from_text_required' });
    const result = await whatsAppService.handleInboundMessage({ from, text, messageId: id, timestamp });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

// ── Trainer ──
export const sendBookingReminder = {
  created, method: 'post', path: '/trainer/send-booking-reminder/:bookingId',
  description: 'Trainer: send booking reminder to member. Requires active booking.',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    // TODO: Fetch booking by ID, validate it's assigned to this trainer, extract member + time.
    // For now, accept { memberId, trainerName, minutesUntil }
    const { memberId, trainerName, minutesUntil } = req.body || {};
    if (!memberId || !trainerName) return res.status(400).json({ error: 'memberId_trainerName_required' });
    const result = await whatsAppService.sendBookingReminder(memberId, trainerName, minutesUntil || 60);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const sendTrainerMessage = {
  created, method: 'post', path: '/trainer/send-message/:memberId',
  description: 'Trainer: send a message to a member via WhatsApp (≤100 chars).',
  onGuard: requireAuth('trainer'),
  onRequest: async (req, res) => {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message_required' });
    const trainerName = req.user?.displayName || 'Your Trainer';
    const result = await whatsAppService.sendTrainerMessage(req.params.memberId, trainerName, message);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

// ── Vendor (shop) ──
export const sendOrderConfirmation = {
  created, method: 'post', path: '/vendor/send-order-confirmation/:orderId',
  description: 'Vendor: send order placement confirmation to customer via WhatsApp.',
  onGuard: requireAuth('vendor'),
  onRequest: async (req, res) => {
    // TODO: Fetch order by ID, extract memberId, amount, validate vendor ownership.
    const { memberId, amount } = req.body || {};
    if (!memberId || !amount) return res.status(400).json({ error: 'memberId_amount_required' });
    const result = await whatsAppService.sendOrderPlaced(memberId, req.params.orderId, amount);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const sendOrderReady = {
  created, method: 'post', path: '/vendor/send-order-ready/:orderId',
  description: 'Vendor: notify customer order is ready for pickup at gym.',
  onGuard: requireAuth('vendor'),
  onRequest: async (req, res) => {
    const { memberId, gymName, readyBy } = req.body || {};
    if (!memberId || !gymName) return res.status(400).json({ error: 'memberId_gymName_required' });
    const result = await whatsAppService.sendOrderReady(memberId, req.params.orderId, gymName, readyBy);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

// ── Gym Operator ──
export const sendPaymentNotification = {
  created, method: 'post', path: '/operator/send-payment-notification',
  description: 'Gym operator: send payment confirmation to member.',
  onGuard: requireAuth('gym_operator'),
  onRequest: async (req, res) => {
    const { userId, amount, orderId } = req.body || {};
    if (!userId || !amount) return res.status(400).json({ error: 'userId_amount_required' });
    const result = await whatsAppService.sendPaymentReceived(userId, amount, orderId || null);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

// ── Admin ──
export const adminSendReengagementVendor = {
  created, method: 'post', path: '/admin/send-reengagement/vendor/:vendorId',
  description: 'Admin: send re-engagement campaign to inactive vendor.',
  onGuard: [requireAuth('admin'), requireAcl('vendors')],
  onRequest: async (req, res) => {
    const result = await whatsAppService.sendVendorReengagement(req.params.vendorId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const adminSendReengagementMember = {
  created, method: 'post', path: '/admin/send-reengagement/member/:memberId',
  description: 'Admin: send re-engagement campaign to inactive member (highlight trainer availability).',
  onGuard: [requireAuth('admin'), requireAcl('members')],
  onRequest: async (req, res) => {
    const result = await whatsAppService.sendMemberReengagement(req.params.memberId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  },
};

export const adminSendBulkReengagement = {
  created, method: 'post', path: '/admin/send-bulk-reengagement',
  description: 'Admin: bulk re-engagement to inactive users. POST { role: vendor|member, limit: 100 }.',
  onGuard: [requireAuth('admin'), requireAcl('users')],
  onRequest: async (req, res) => {
    const { role, limit = 100 } = req.body || {};
    if (!['vendor', 'member'].includes(role)) return res.status(400).json({ error: 'role_must_be_vendor_or_member' });
    // TODO: Query inactive users, batch send reengagement messages.
    // For now, return placeholder.
    res.json({ ok: true, message: 'Bulk reengagement queued', role, limit, status: 'todo' });
  },
};

// ── Testing (development) ──
export const testSendWhatsApp = {
  created, method: 'post', path: '/test/whatsapp',
  description: '[DEV] Test WhatsApp delivery. POST { userId, templateId }.',
  onRequest: async (req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'not_available_in_production' });
    const { userId, templateId } = req.body || {};
    if (!userId || !templateId) return res.status(400).json({ error: 'userId_templateId_required' });
    // TODO: Implement test template sender.
    res.json({ ok: true, message: 'Test endpoint not yet implemented', userId, templateId });
  },
};
