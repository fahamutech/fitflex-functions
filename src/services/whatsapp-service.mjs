// Direct WhatsApp sends via Africa's Talking (https://africastalking.com):
// one-off service messages tied to something the person did — a sign-in
// code, a booking, an order. Off unless AFRICAS_TALKING_API_KEY is set.
//
// Messages to an audience (campaigns, automations, offers, re-engagement)
// do NOT belong here: they go through the Communications module
// (whatsapp-channel-service.mjs), which checks consent, records every
// message in the ledger and has the kill switch. This service only honours
// the member's WhatsApp opt-out (STOP) and "service updates" switch; a
// sign-in code is always sent, since the person just asked for it.
// Async (Knex/PostgreSQL), DI-injected.

import { randomUUID } from 'node:crypto';
import { channelAllowed } from '../shared/communications.mjs';

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
};

// Validate phone number format (East African: +255, +256, +254, etc.)
function normalizePhone(phone) {
  if (!phone) return null;
  phone = phone.replace(/\D/g, ''); // strip non-digits
  if (phone.startsWith('0')) phone = '255' + phone.slice(1); // 0xxx -> 255xxx (Tanzania)
  if (!phone.startsWith('+')) phone = '+' + phone;
  return /^\+\d{10,15}$/.test(phone) ? phone : null;
}

export function createWhatsAppService({ apiKey, apiUrl = 'https://api.sandbox.africastalking.com', username = 'sandbox', users, auditLog, preferences = null }) {
  // WhatsApp is optional. This service is built when services.mjs is imported,
  // which every function file does, so throwing here took the whole server down
  // (and into a restart loop) whenever AFRICAS_TALKING_API_KEY was unset.
  // Without a key every send is a no-op that reports why.
  const enabled = Boolean(apiKey);
  if (!enabled) {
    console.warn('[whatsapp] AFRICAS_TALKING_API_KEY is not set — WhatsApp messages are disabled.');
  }

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'apiKey': apiKey,
  };

  async function sendTemplate(phoneNumber, templateId, variables = {}) {
    if (!enabled) return { error: 'whatsapp_not_configured', status: 503 };
    const phone = normalizePhone(phoneNumber);
    if (!phone) return { error: 'invalid_phone_format', status: 400 };

    try {
      const response = await fetch(`${apiUrl}/version1/messaging`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          username,
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

  /**
   * Who to send to: the account's phone. (This used to read a `phoneNumber`
   * field that accounts don't have, so nothing was ever sent.) Except for
   * sign-in codes, a member who sent STOP or switched WhatsApp service
   * updates off is left alone.
   */
  async function recipient(userId, noPhone, { always = false } = {}) {
    const user = await users.findByIdAsync(userId);
    const phone = user?.phone;
    if (!phone) return { error: noPhone, status: 400 };
    if (!always && preferences) {
      const prefs = await preferences.findByIdAsync(userId);
      const allowed = channelAllowed(prefs, 'whatsapp', 'transactional');
      if (!allowed.allowed) return { error: allowed.reason, status: 409 };
    }
    return { user, phone };
  }

  async function sendOtp(userId, code, name = null) {
    const to = await recipient(userId, 'user_no_phone', { always: true });
    if (to.error) return to;
    const user = to.user;

    const u = name || user.displayName || 'Member';
    const result = await sendTemplate(to.phone, TEMPLATES.otp, { name: u, code });
    if (result.ok) {
      auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_otp_sent', target: userId });
    }
    return result;
  }

  async function sendBookingConfirmed(trainerId, memberName, date, time) {
    const to = await recipient(trainerId, 'trainer_no_phone');
    if (to.error) return to;
    const trainer = to.user;

    const result = await sendTemplate(to.phone, TEMPLATES.booking_confirmed, { trainerName: trainer.displayName || 'Trainer', memberName, date, time });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_booking_confirmed', target: trainerId });
    return result;
  }

  async function sendBookingReminder(userId, trainerName, minutesUntil = 60) {
    const to = await recipient(userId, 'user_no_phone');
    if (to.error) return to;
    const user = to.user;

    const result = await sendTemplate(to.phone, TEMPLATES.booking_reminder, { name: user.displayName || 'Member', trainer: trainerName });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_booking_reminder', target: userId });
    return result;
  }

  async function sendTrainerMessage(memberId, trainerName, message) {
    const to = await recipient(memberId, 'member_no_phone');
    if (to.error) return to;
    const member = to.user;
    if (!message || message.length > 100) return { error: 'message_too_long', status: 400 };

    const result = await sendTemplate(to.phone, TEMPLATES.trainer_message, { memberName: member.displayName || 'Member', trainerName, message });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_trainer_message', target: memberId });
    return result;
  }

  async function sendOrderPlaced(memberId, orderId, amount) {
    const to = await recipient(memberId, 'member_no_phone');
    if (to.error) return to;
    const member = to.user;

    const result = await sendTemplate(to.phone, TEMPLATES.order_placed, { memberName: member.displayName || 'Member', orderId, amount: Math.floor(amount) });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_order_placed', target: memberId });
    return result;
  }

  async function sendOrderReady(memberId, orderId, gymName, readyBy) {
    const to = await recipient(memberId, 'member_no_phone');
    if (to.error) return to;
    const member = to.user;

    const result = await sendTemplate(to.phone, TEMPLATES.order_ready, { memberName: member.displayName || 'Member', orderId, gymName, date: readyBy });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_order_ready', target: memberId });
    return result;
  }

  async function sendPaymentReceived(userId, amount, orderId) {
    const to = await recipient(userId, 'user_no_phone');
    if (to.error) return to;
    const user = to.user;

    const result = await sendTemplate(to.phone, TEMPLATES.payment_received, { amount: Math.floor(amount), orderId });
    if (result.ok) auditLog?.insertAsync?.({ id: makeId('wa_log'), at: nowIso(), actor: 'system', action: 'whatsapp_payment_received', target: userId });
    return result;
  }

  // Receive & parse inbound WhatsApp messages (from Africa's Talking webhooks).
  // This is called when a user replies to a template or sends a custom message.
  async function handleInboundMessage({ from, text, messageId, timestamp }) {
    const phone = normalizePhone(from);
    if (!phone) return { error: 'invalid_from', status: 400 };

    // Find user by phone number
    const users_list = await users.filterAsync(u => normalizePhone(u.phone) === phone);
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
    enabled,
    sendOtp,
    sendBookingConfirmed,
    sendBookingReminder,
    sendTrainerMessage,
    sendOrderPlaced,
    sendOrderReady,
    sendPaymentReceived,
    handleInboundMessage,
    normalizePhone,
    TEMPLATES,
  };
}
