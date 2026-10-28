// Shared fixture for the S4 payment / ticket / refund specs (CI database only). It wraps the S3 harness: the S4
// flags and the ticket secret, the manual-payment details the admin saves, users, and a cleanup that removes the
// money rows (refunds, payments, requests, tickets) before the S3 cleanup removes the orders they point at.
import assert from 'node:assert/strict';
import { harness as harness3, flagsOn, flagsOff, uid, phone, mail, D, H, participant } from './events-s3.mjs';
import { db } from '../../src/infra/knex-store.mjs';
import { settingsService } from '../../src/bootstrap/services.mjs';

export { uid, phone, mail, D, H, participant };
export const TICKET_SECRET = 'spec-ticket-secret-0123456789abcdef0123456789abcd';
export const DETAILS = { lipaNamba: '5123456', accountName: 'FitFlex Africa Ltd', network: 'M-Pesa', instructions: { en: 'Pay the Lipa Namba, then send the transaction ID.', sw: 'Lipa kwa Lipa Namba, kisha tuma namba ya muamala.' } };
export const S4_ENV = [
  'EVENT_TICKET_SECRET', 'EVENT_TICKET_KEY_ID', 'EVENT_TICKET_SECRET_PREVIOUS', 'EVENTS_PAYMENTS_MANUAL', 'EVENTS_PAYMENTS_TUNZAA', 'MANUAL_PAY_INSTRUCTIONS', 'MONEY_SECOND_APPROVER',
  'EVENT_MANUAL_HOLD_EXTEND_HOURS', 'EVENT_MANUAL_HOLD_MAX_HOURS', 'EVENTS_ORG_HOLD_MAX_HOURS', 'EVENTS_REJECTED_RETRY_MINUTES', 'EVENTS_LATE_PAYMENT_GRACE_HOURS',
  'EVENTS_MANUAL_CONFIRM_SLA_HOURS', 'EVENTS_REFUND_TARGET_DAYS', 'TUNZAA_PAYMENTS', 'TUNZAA_SANDBOX_SETTLES', 'EVENTS_ALLOW_SINGLE_APPROVER',
];

/** EVENTS_MODULE + EVENTS_REGISTRATION + the manual payment path + the ticket secret (+ MONEY_SECOND_APPROVER on request). */
export function s4On({ secondApprover = false, tunzaa = false } = {}) {
  flagsOn();
  process.env.EVENT_TICKET_SECRET = TICKET_SECRET;
  process.env.EVENTS_PAYMENTS_MANUAL = '1';
  process.env.MANUAL_PAY_INSTRUCTIONS = '1';
  if (secondApprover) process.env.MONEY_SECOND_APPROVER = '1';
  else process.env.EVENTS_ALLOW_SINGLE_APPROVER = '1';   // the launch gate (M4); specs of the gate itself clear it
  if (tunzaa) process.env.EVENTS_PAYMENTS_TUNZAA = '1';
}
export function s4Off() {
  flagsOff();
  for (const k of S4_ENV) delete process.env[k];
}
/** The Lipa Namba the admin saves in Settings (global platform settings of the CI database). */
export async function saveManualDetails() {
  const out = await settingsService.adminUpdate({ body: { manualPayment: DETAILS }, actorId: 'spec' });
  assert.ok(!out.error, JSON.stringify(out));
}
export async function clearManualDetails() { await settingsService.adminUpdate({ body: { manualPayment: null }, actorId: 'spec' }); }

let refSeq = Math.floor(Math.random() * 90000) + 10000;
/** A transaction ID the validators accept, unique per call. */
export const txId = () => `QGH${(refSeq += 1)}X${uid('').slice(1, 5).toUpperCase()}`.replace(/[^A-Z0-9]/g, '').slice(0, 14);

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
        await knex('WebhookSeen').where('id', 'like', 'tunzaa:spec%').del();
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
