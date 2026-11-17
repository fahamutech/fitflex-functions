// Shared fixture for the S4 payment / ticket / refund specs (CI database only). It wraps the S3 harness: the S4
// flags and the ticket secret, AzamPay as the way a member pays (owner decision 2026-11-17: no payment by hand),
// users, and a cleanup that removes the money rows (refunds, payments, requests, tickets) before the S3 cleanup
// removes the orders they point at.
import './azampay-env.mjs';
import { harness as harness3, flagsOn, flagsOff, uid, phone, mail, D, H, participant } from './events-s3.mjs';
import { db } from '../../src/infra/knex-store.mjs';
import { eventMoneyStore } from '../../src/bootstrap/services.mjs';
import { eventManualHoldExtendHours, eventManualHoldMaxHours, eventsOrgHoldMaxHours, eventsProviderHoldExtendMinutes } from '../../src/shared/events-config.mjs';

export { uid, phone, mail, D, H, participant };
export const TICKET_SECRET = 'spec-ticket-secret-0123456789abcdef0123456789abcd';
export const S4_ENV = [
  'EVENT_TICKET_SECRET', 'EVENT_TICKET_KEY_ID', 'EVENT_TICKET_SECRET_PREVIOUS', 'EVENTS_PAYMENTS_MANUAL', 'EVENTS_PAYMENTS_AZAMPAY', 'MONEY_SECOND_APPROVER',
  'EVENT_MANUAL_HOLD_EXTEND_HOURS', 'EVENT_MANUAL_HOLD_MAX_HOURS', 'EVENTS_ORG_HOLD_MAX_HOURS', 'EVENTS_REJECTED_RETRY_MINUTES', 'EVENTS_LATE_PAYMENT_GRACE_HOURS',
  'EVENTS_MANUAL_CONFIRM_SLA_HOURS', 'EVENTS_REFUND_TARGET_DAYS', 'AZAMPAY_PAYMENTS', 'AZAMPAY_SANDBOX_SETTLES', 'AZAMPAY_TRAINER_PRODUCTS', 'EVENTS_ALLOW_SINGLE_APPROVER',
];

/**
 * EVENTS_MODULE + EVENTS_REGISTRATION + the ticket secret + both ways an order is paid: a member through AzamPay
 * (EVENTS_PAYMENTS_AZAMPAY with AZAMPAY_PAYMENTS and the sandbox opt-in) and an organisation by payment notice
 * (EVENTS_PAYMENTS_MANUAL). `azampay: false` leaves only the organisation notice (+ MONEY_SECOND_APPROVER on request).
 */
export function s4On({ secondApprover = false, azampay = true } = {}) {
  flagsOn();
  process.env.EVENT_TICKET_SECRET = TICKET_SECRET;
  process.env.EVENTS_PAYMENTS_MANUAL = '1';
  if (azampay) {
    process.env.EVENTS_PAYMENTS_AZAMPAY = '1';
    process.env.AZAMPAY_PAYMENTS = '1';
    process.env.AZAMPAY_SANDBOX_SETTLES = '1';
  }
  if (secondApprover) process.env.MONEY_SECOND_APPROVER = '1';
  else process.env.EVENTS_ALLOW_SINGLE_APPROVER = '1';   // the launch gate (M4); specs of the gate itself clear it
}
export function s4Off() {
  flagsOff();
  for (const k of S4_ENV) delete process.env[k];
}

let refSeq = Math.floor(Math.random() * 90000) + 10000;
/** A transaction ID the validators accept, unique per call (an organisation's payment notice). */
export const txId = () => `QGH${(refSeq += 1)}X${uid('').slice(1, 5).toUpperCase()}`.replace(/[^A-Z0-9]/g, '').slice(0, 14);

/**
 * A payment submitted by hand: the shape an organisation's payment notice has, and the shape members' payments had
 * before 2026-11-17 (such rows remain, and staff still decide them). Turns the just-started payment of `orderId` into
 * one: EventPayment manual + pending, the transaction ID (and paying phone) on its request, the hold extended as a
 * submission extends it. Specs of the staff tools (approve with the amount received, reject, change, repair) use it;
 * no route creates this for a member any more. Resolves with the payment request.
 */
export async function submittedByHand(orderId, { reference = txId(), payerPhone = null } = {}) {
  const at = new Date();
  const payment = await db('EventPayment').where({ orderId }).orderBy('createdAt', 'desc').first();
  await db('EventPayment').where({ id: payment.id }).update({ method: 'manual', provider: 'manual', status: 'pending', submittedAt: at, updatedAt: at });
  await db('PaymentRequest').where({ id: payment.paymentRequestId }).update({ memberReference: reference, memberReferenceKey: reference.toUpperCase().replace(/[^A-Z0-9]/g, ''), payerPhone });
  // The hold is extended by the store's own rule, exactly as a submitted notice extends it (cap, event start, never shortened).
  await db.transaction(async (trx) => {
    const order = await trx('EventOrder').where({ id: orderId }).forUpdate().first();
    if (order.status !== 'awaiting_payment') return;
    await eventMoneyStore.extendHold(trx, order, {
      mode: 'manual', manualExtendMs: eventManualHoldExtendHours() * H, providerExtendMs: eventsProviderHoldExtendMinutes() * 60_000,
      maxHoursMs: (order.organizationId ? eventsOrgHoldMaxHours() : eventManualHoldMaxHours()) * H,
    });
  });
  return db('PaymentRequest').where({ id: payment.paymentRequestId }).first();
}

export function harness() {
  const base = harness3();
  const { db: knex } = base;

  /** An organizer with commissionPct set. */
  async function sellingEvent({ commissionPct = 10, ...opts } = {}) {
    const f = await base.publishedEvent(opts);
    await knex('EventOrganizer').where({ id: f.organizer.id }).update({ commissionPct });
    return f;
  }

  async function cleanup() {
    const events = base.made.events;
    if (events.length) {
      const orderIds = (await knex('EventOrder').whereIn('eventId', events).select('id')).map(r => r.id);
      await knex('Refund').whereIn('eventId', events).del();
      if (orderIds.length) {
        await knex('Refund').whereIn('eventOrderId', orderIds).del();
        const payIds = (await knex('EventPayment').whereIn('orderId', orderIds).select('id', 'paymentRequestId'));
        await knex('EventPayment').whereIn('orderId', orderIds).del();
        const reqIds = payIds.map(p => p.paymentRequestId).filter(Boolean);
        if (reqIds.length) await knex('PaymentRequest').whereIn('id', reqIds).del();
        await knex('PaymentRequest').whereIn('eventOrderId', orderIds).del();
        await knex('WebhookSeen').where('id', 'like', 'azampay:SPEC_%').del();
      }
      await knex('OpsException').where('dedupeKey', 'like', 'evpay:%').del().catch(() => {});
      await knex('OpsException').where('dedupeKey', 'like', 'evord:%').del().catch(() => {});
    }
    await knex('AuditLog').where('action', 'like', 'analytics.%').whereIn('target', [...events]).del().catch(() => {});
    await base.cleanup();
    s4Off();
  }

  return { ...base, cleanup, sellingEvent };
}

export { db };
