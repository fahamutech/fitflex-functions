// WhatsApp integration service via Africa's Talking (https://africastalking.com).
// Sends OTP, notifications, trainer-member chat, marketplace commerce messages,
// and re-engagement campaigns via WhatsApp Business API.
// Async (Knex/PostgreSQL), DI-injected.

import { randomUUID } from 'node:crypto';

const nowIso = () => new Date().toISOString();
const makeId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;

// Template IDs for Africa's Talking (registered with them; you configure these in AT dashboard).
// Each template must be pre-approved by Africa's Talking (WhatsApp Business approval required).
const TEMPLATES = {
  otp: 'fitflex_otp',                          // Hi {{name}}, your FitFlex OTP is {{code}}. Valid for 10 mins.
  booking_confirmed: 'fitflex_booking_confirmed', // {{trainerName}}, you have a new booking from {{memberName}} on {{date}} at {{time}}.
  booking_reminder: 'fitflex_booking_reminder',   // Hi {{name}}, reminder: your session with {{trainer}} is in 1 hour.
  trainer_message: 'fitflex_trainer_message',     // {{memberName}}, your trainer {{trainerName}} sent: {{message}}
  order_placed: 'fitflex_order_placed',           // {{memberName}}, order #{{orderId}} placed. Total: {{amount}} TZS.
  order_ready: 'fitflex_order_ready',             // {{memberName}}, order #{{orderId}} is ready at {{gymName}}. Pick up by {{date}}.
  payment_received: 'fitflex_payment_received',   // Payment {{amount}} TZS received for order #{{orderId}}.
  vendor_reengagement: 'fitflex_vendor_reengagement', // Hey {{name}}, you haven't had sales in 7 days. Check your FitFlex dashboard!
  member_reengagement: 'fitflex_member_reengagement', // {{name}}, your favorite trainers have new availability. Book now!
};

// Validate phone number format (East African: +255, +256, +254, etc.)
function normalizePhone(phone) {
  if (!phone) return null;
  phone = phone.replace(/\D/g, ''); // strip non-digits
  if (phone.startsWith('0')) phone = '255' + phone.slice(1); // 0xxx -> 255xxx (Tanzania)
  if (!phone.startsWith('+')) phone = '+' + phone;
  return /^\+\d{10,15}$/.test(phone) ? phone : null;
}

export function createWhatsAppService({ apiKey, apiUrl = 'https://api.sandbox.africastalking.com', users, auditLog }) {
  if (!apiKey) throw new Error('WhatsApp service requires Africa\'s Talking API key');

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'apiKey': apiKey,
  };

  async function sendTemplate(phoneNumber, templateId, variables = {}) {
    const phone = normalizePhone(phoneNumber);
    if (!phone) return { error: 'invalid_phone_format', status: 400 };

    try {
      const response = await fetch(`${apiUrl}/version1/messaging`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          username: 'sandbox', // sandbox for testing; use real username in production
          to: phone,
          type: 'WhatsApp',
          templateId,
          templateParameters: JSON.stringify(variables),
        }).toString(),
      });

      const result = await response.json();
      if (!response.ok) {
        return {
          error: result.errorMessage || 'failed_to_send',
          status: response.status,
          atResponse: result,
        };
      }

      return {
        ok: true,
        messageId: result.data?.message?.[0]?.id || null,
        cost: result.data?.message?.[0]?.cost || '0.08',
        status: 'sent',
      };
    } catch (err) {
      return { error: 'network_error', status: 500, message: err.message };
    }
  }

  async function sendOtp(userId, code, name = null) {
    const user = await users.findByIdAsync(userId);
    if (!user?.phoneNumber) return { error: 'user_no_phone', status: 400 };

    const u = name || user.displayName || 'Member';
    const result = await sendTemplate(user.phoneNumber, TEMPLATES.otp, { name: u, code });
    if (result.ok) {
      auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_otp_sent', target: userId });
    }
    return result;
  }

  async function sendBookingConfirmed(trainerId, memberName, date, time) {
    const trainer = await users.findByIdAsync(trainerId);
    if (!trainer?.phoneNumber) return { error: 'trainer_no_phone', status: 400 };

    const result = await sendTemplate(trainer.phoneNumber, TEMPLATES.booking_confirmed, { trainerName: trainer.displayName || 'Trainer', memberName, date, time });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_booking_confirmed', target: trainerId });
    return result;
  }

  async function sendBookingReminder(userId, trainerName, minutesUntil = 60) {
    const user = await users.findByIdAsync(userId);
    if (!user?.phoneNumber) return { error: 'user_no_phone', status: 400 };

    const result = await sendTemplate(user.phoneNumber, TEMPLATES.booking_reminder, { name: user.displayName || 'Member', trainer: trainerName });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_booking_reminder', target: userId });
    return result;
  }

  async function sendTrainerMessage(memberId, trainerName, message) {
    const member = await users.findByIdAsync(memberId);
    if (!member?.phoneNumber) return { error: 'member_no_phone', status: 400 };
    if (!message || message.length > 100) return { error: 'message_too_long', status: 400 };

    const result = await sendTemplate(member.phoneNumber, TEMPLATES.trainer_message, { memberName: member.displayName || 'Member', trainerName, message });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_trainer_message', target: memberId });
    return result;
  }

  async function sendOrderPlaced(memberId, orderId, amount) {
    const member = await users.findByIdAsync(memberId);
    if (!member?.phoneNumber) return { error: 'member_no_phone', status: 400 };

    const result = await sendTemplate(member.phoneNumber, TEMPLATES.order_placed, { memberName: member.displayName || 'Member', orderId, amount: Math.floor(amount) });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_order_placed', target: memberId });
    return result;
  }

  async function sendOrderReady(memberId, orderId, gymName, readyBy) {
    const member = await users.findByIdAsync(memberId);
    if (!member?.phoneNumber) return { error: 'member_no_phone', status: 400 };

    const result = await sendTemplate(member.phoneNumber, TEMPLATES.order_ready, { memberName: member.displayName || 'Member', orderId, gymName, date: readyBy });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_order_ready', target: memberId });
    return result;
  }

  async function sendPaymentReceived(userId, amount, orderId) {
    const user = await users.findByIdAsync(userId);
    if (!user?.phoneNumber) return { error: 'user_no_phone', status: 400 };

    const result = await sendTemplate(user.phoneNumber, TEMPLATES.payment_received, { amount: Math.floor(amount), orderId });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_payment_received', target: userId });
    return result;
  }

  async function sendVendorReengagement(vendorId) {
    const vendor = await users.findByIdAsync(vendorId);
    if (!vendor?.phoneNumber) return { error: 'vendor_no_phone', status: 400 };

    const result = await sendTemplate(vendor.phoneNumber, TEMPLATES.vendor_reengagement, { name: vendor.displayName || 'Vendor' });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_vendor_reengagement', target: vendorId });
    return result;
  }

  async function sendMemberReengagement(memberId) {
    const member = await users.findByIdAsync(memberId);
    if (!member?.phoneNumber) return { error: 'member_no_phone', status: 400 };

    const result = await sendTemplate(member.phoneNumber, TEMPLATES.member_reengagement, { name: member.displayName || 'Member' });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_member_reengagement', target: memberId });
    return result;
  }

  // Receive & parse inbound WhatsApp messages (from Africa's Talking webhooks).
  // This is called when a user replies to a template or sends a custom message.
  async function handleInboundMessage({ from, text, messageId, timestamp }) {
    const phone = normalizePhone(from);
    if (!phone) return { error: 'invalid_from', status: 400 };

    // Find user by phone number
    const users_list = await users.filterAsync(u => normalizePhone(u.phoneNumber) === phone);
    if (!users_list.length) return { error: 'user_not_found', status: 404 };

    const user = users_list[0];
    const parsed = {
      id: messageId,
      userId: user.id,
      from: phone,
      text,
      receivedAt: new Date(timestamp * 1000).toISOString(),
      type: 'inbound',
    };

    auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: user.id, action: 'whatsapp_inbound', target: 'chat', data: { text: text.slice(0, 50) } });
    return { ok: true, message: parsed };
  }

  return {
    sendOtp,
    sendBookingConfirmed,
    sendBookingReminder,
    sendTrainerMessage,
    sendOrderPlaced,
    sendOrderReady,
    sendPaymentReceived,
    sendVendorReengagement,
    sendMemberReengagement,
    handleInboundMessage,
    normalizePhone,
    TEMPLATES,
  };
}
