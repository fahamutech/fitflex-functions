// Marathon & running events · S4 — the money primitives of the event store (spec §3.8, §3.9, §3.12, §3.6).
//
// event-store-pg.mjs keeps S1 as it was: `commitOrder` runs its OWN transaction and cannot be composed into a
// larger one, and no route may call it for payment. Everything that moves money-bearing state lives here as
// COMPOSABLE primitives that take the caller's transaction (`trx`), so a decision (PaymentRequest approved +
// EventPayment succeeded + order confirmed + places confirmed + tickets issued + outbox + audit) commits together
// or not at all:
//
//   confirmPaidOrder(trx, …)       the confirmation transaction: commit inventory, or rehold a lapsed order, or —
//                                  when the places cannot be honoured — an `unfulfilled_payment` refund. Idempotent.
//   cancelPaidPlaces(trx, …)       confirmed places → cancelled, tickets revoked, `uncommit` movements when the place can be sold again
//   applyRefundPaid / applyRefundRejected(trx, refund)   what a paid / refused refund does to places, order and payment
//   deriveAndSetOrderStatus(trx, orderId)                 the order status from its places and refunds (events-lifecycle deriveOrderStatus)
//   extendHold / resetHoldAfterRejection(trx, …)          the manual-payment hold rules (§3.6)
//
// Business refusals are thrown as `storeRefusal` (the transaction rolls back) and returned by the callers.
// Inventory invariants (checked by specs): sold + held <= capacity always; Σhold − Σrelease − Σcommit = held;
// Σcommit − Σuncommit = sold. Money is whole TZS (D4). Nothing here logs a reference, phone or token.
import { randomUUID } from 'node:crypto';
import { storeRefusal, newId, movementKeyOf } from './event-store-pg.mjs';
import { canTransition, deriveOrderStatus } from '../shared/events-lifecycle.mjs';
import { apportion } from '../shared/events-refund-policy.mjs';
import { deriveToken, newTicketId, sha256hex, displayCodeOf } from '../shared/events-ticket-token.mjs';
import { eventTicketKeyRing } from '../shared/events-config.mjs';

const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const json = value => (value === undefined || value === null || typeof value === 'string' ? value : JSON.stringify(value));
export const newRefundId = () => `rfd_${randomUUID().slice(0, 10)}`;
const UNIQUE_VIOLATION = '23505';

/** Payments that may still be turned into a success. `failed` only for a manual payment through a two-person change. */
const CONFIRMABLE = ['created', 'pending', 'reconciliation_required'];
const LIVE_REGISTRATION = ['reserved', 'confirmed'];

export function createPgEventMoneyStore({ db, eventStore, now = () => new Date(), keyRing = eventTicketKeyRing }) {
  const audit = (trx, actor, action, target, before, after, at) => trx('AuditLog').insert({
    id: randomUUID(), at, actor: actor || 'system', action, target, before: json(before ?? null), after: json(after ?? null),
  });

  const outbox = (trx, event, type, aggregateType, aggregateId, payload) => eventStore.appendOutbox(trx, {
    type, aggregateType, aggregateId, organizerId: event?.organizerId ?? null, eventId: event?.id ?? null, payload,
  });

  async function lockTicketTypes(trx, ids) {
    const rows = await trx('EventTicketType').whereIn('id', [...new Set(ids)]).orderBy('id').forUpdate();
    return new Map(rows.map(r => [r.id, plain(r)]));
  }

  /** Is the event still one a place can be bought for / kept: published or registration_closed and not started. */
  const eventOpen = (event, at) => Boolean(event) && ['published', 'registration_closed'].includes(event.status) && +new Date(event.startsAt) > +at;

  // ── Order status ────────────────────────────────────────────────────────────

  /** Recompute the order's status from its places and refunds and apply it when the machine allows the move. */
  async function deriveAndSetOrderStatus(trx, orderId) {
    const order = plain(await trx('EventOrder').where({ id: orderId }).first());
    if (!order) return null;
    const regs = (await trx('EventRegistration').where({ orderId })).map(plain);
    const refunds = (await trx('Refund').where({ kind: 'event_order', eventOrderId: orderId })).map(plain);
    const next = deriveOrderStatus(order, regs, refunds);
    if (next === order.status || !canTransition('order', order.status, next)) return { order, changed: false };
    const at = now();
    const [saved] = await trx('EventOrder').where({ id: orderId }).update({ status: next, updatedAt: at, ...(['cancelled', 'refunded'].includes(next) ? { closedAt: order.closedAt ?? at } : {}) }).returning('*');
    return { order: plain(saved), changed: true, from: order.status };
  }

  // ── The confirmation transaction ────────────────────────────────────────────

  /**
   * Payment succeeded for the order. Under FOR UPDATE on the order, the payment and the ticket types:
   *   awaiting_payment → commit (held → sold, one `commit` movement per line);
   *   expired          → rehold (cycle + 1, conditional capacity) then commit — `capacity_unavailable` falls through to
   *                      the unfulfilled-payment refund;
   *   cancelled family / event unavailable / already paid → no commit: payment `reconciliation_required` and a full
   *                      `unfulfilled_payment` refund (approved by policy) in this same transaction.
   * Input: { orderId, eventPaymentId, source: 'admin' | 'provider' | 'free' | 'repair', actorId, allowFailed, rawRedacted, expectedAmountTzs }.
   * Returns { changed, outcome: 'confirmed' | 'reheld' | 'refund_raised', reason?, refundId?, order, payment, registrations, tickets }.
   * Throws storeRefusal: payment_row_mismatch, payment_not_confirmable, payment_amount_mismatch, tickets_unavailable (503),
   * order_integrity. A second call for a confirmed order with a succeeded payment changes nothing.
   */
  async function confirmPaidOrder(trx, { orderId, eventPaymentId, source = 'admin', actorId = null, allowFailed = false, rawRedacted = undefined, expectedAmountTzs = null }) {
    const at = now();
    const order = plain(await trx('EventOrder').where({ id: orderId }).forUpdate().first());
    if (!order) throw storeRefusal('order_not_found', 404);
    const payment = plain(await trx('EventPayment').where({ id: eventPaymentId, orderId }).forUpdate().first());
    if (!payment) throw storeRefusal('payment_row_mismatch', 409);
    const event = plain(await trx('Event').where({ id: order.eventId }).first());

    if (payment.status === 'succeeded' && order.status === 'confirmed') {
      const regs = (await trx('EventRegistration').where({ orderId }).orderBy('id')).map(plain);
      return { changed: false, outcome: 'confirmed', order, payment, registrations: regs, tickets: [] };
    }
    const confirmable = CONFIRMABLE.includes(payment.status) || (allowFailed && payment.status === 'failed' && payment.method === 'manual') || payment.status === 'succeeded';
    if (!confirmable) throw storeRefusal('payment_not_confirmable', 409, { paymentStatus: payment.status });
    // Order commit is driven only by a payment whose amount and currency equal the order's (follow-ups S4).
    if (Number(payment.amountTzs) !== Number(order.totalTzs) || payment.currency !== order.currency
      || (expectedAmountTzs != null && Number(expectedAmountTzs) !== Number(order.totalTzs))) {
      throw storeRefusal('payment_amount_mismatch', 409, { expectedTzs: Number(order.totalTzs) });
    }

    const lines = (await trx('EventOrderLine').where({ orderId }).orderBy('ticketTypeId')).map(plain);
    const regs = (await trx('EventRegistration').where({ orderId }).orderBy('id').forUpdate()).map(plain);

    // Why the places cannot be honoured, if they cannot.
    let reason = null;
    let rehold = false;
    if (order.status === 'awaiting_payment') {
      if (!eventOpen(event, at)) reason = 'event_unavailable';
    } else if (order.status === 'expired') {
      if (!eventOpen(event, at)) reason = 'event_unavailable';
      else rehold = true;
    } else if (order.status === 'confirmed') reason = 'order_already_paid';
    else reason = 'order_cancelled';

    if (rehold) {
      const check = await reholdCapacity(trx, order, lines, regs);
      if (check.error) { reason = check.error; rehold = false; }
    }
    if (reason) return unfulfilled(trx, { order, payment, event, reason, at, actorId, source });

    // Tickets need the secret: abort the whole transaction (nothing half-written) when it is missing.
    const ring = keyRing();
    if (!ring) throw storeRefusal('tickets_unavailable', 503);

    let cycle = order.holdCycle;
    let toConfirm;
    if (rehold) {
      cycle += 1;
      toConfirm = await reholdApply(trx, { order, lines, regs, cycle, at });
    } else {
      toConfirm = regs.filter(r => r.status === 'reserved');
      await lockTicketTypes(trx, lines.map(l => l.ticketTypeId));
    }
    // held → sold, one `commit` movement per line, idempotent through the movement key.
    for (const line of lines) {
      const inserted = await trx('EventInventoryMovement').insert({
        id: newId('eim'), ticketTypeId: line.ticketTypeId, orderId, kind: 'commit', quantity: line.quantity, cycle,
        movementKey: movementKeyOf(orderId, cycle, 'commit', line.ticketTypeId), createdAt: at,
      }).onConflict('movementKey').ignore().returning('id');
      if (!inserted.length) continue;
      await trx('EventTicketType').where({ id: line.ticketTypeId }).update({ held: trx.raw('held - ?', [line.quantity]), sold: trx.raw('sold + ?', [line.quantity]), updatedAt: at });
    }

    const organizer = await trx('EventOrganizer').where({ id: event.organizerId }).first('commissionPct');
    const method = payment.method ?? (payment.provider === 'tunzaa' ? 'provider' : payment.provider === 'free' ? 'free' : 'manual');
    const [savedOrder] = await trx('EventOrder').where({ id: orderId }).update({
      status: 'confirmed', holdExpiresAt: null, confirmedAt: at, closedAt: null, closeReason: null, holdCycle: cycle,
      organizerId: event.organizerId, commissionPctSnapshot: organizer?.commissionPct ?? null, paymentMethod: method, updatedAt: at,
    }).returning('*');

    const [savedPayment] = await trx('EventPayment').where({ id: payment.id }).update({
      status: 'succeeded', verifiedAt: payment.verifiedAt ?? at, failureReason: null, rejectCode: null, settledNote: null,
      eventId: order.eventId, organizerId: event.organizerId, method,
      ...(rawRedacted !== undefined ? { rawRedacted: json(rawRedacted) } : {}), updatedAt: at,
    }).returning('*');

    // Per-place paid amount: floor(T / q) each, the first T mod q places one shilling more; written once.
    const confirmed = [];
    const byLine = new Map();
    for (const r of toConfirm) byLine.set(r.orderLineId, [...(byLine.get(r.orderLineId) ?? []), r]);
    for (const line of lines) {
      const places = (byLine.get(line.id) ?? []).sort((a, b) => (a.id < b.id ? -1 : 1));
      if (places.length !== line.quantity) throw storeRefusal('order_integrity', 500, { orderId });
      const parts = apportion(line.lineTotalTzs, places.length);
      for (let i = 0; i < places.length; i += 1) {
        if (!canTransition('registration', 'reserved', 'confirmed') || places[i].status !== 'reserved') throw storeRefusal('order_integrity', 500, { orderId });
        const [saved] = await trx('EventRegistration').where({ id: places[i].id }).update({
          status: 'confirmed', paidAmountTzs: parts[i], paidAt: at, cancelledAt: null, cancelReason: null, updatedAt: at,
        }).returning('*');
        confirmed.push(plain(saved));
      }
    }

    const tickets = [];
    for (const reg of confirmed) {
      const ticketId = newTicketId();
      const token = deriveToken(ring, { ticketId, tokenVersion: 1, registrationId: reg.id, eventId: order.eventId });
      await trx('EventTicket').insert({
        id: ticketId, registrationId: reg.id, tokenHash: sha256hex(token), status: 'active', issuedAt: at, tokenVersion: 1,
        tokenKeyId: ring.keyId, displayCode: displayCodeOf(ticketId, reg.id), issuedForUserId: reg.participantUserId ?? null, createdAt: at, updatedAt: at,
      });
      tickets.push({ id: ticketId, registrationId: reg.id, participantUserId: reg.participantUserId ?? null });
      await outbox(trx, event, 'registration.created', 'registration', reg.id, { registrationId: reg.id, orderId, eventId: order.eventId, categoryId: reg.categoryId, ticketTypeId: reg.ticketTypeId, status: 'confirmed' });
      await outbox(trx, event, 'registration.paid', 'registration', reg.id, { registrationId: reg.id, orderId, eventId: order.eventId, categoryId: reg.categoryId, ticketTypeId: reg.ticketTypeId });
      await outbox(trx, event, 'ticket.issued', 'ticket', ticketId, { ticketId, registrationId: reg.id, eventId: order.eventId });
    }
    await outbox(trx, event, 'payment.succeeded', 'payment', payment.id, { paymentId: payment.id, orderId, eventId: order.eventId, amountTzs: Number(payment.amountTzs), currency: payment.currency });
    await audit(trx, actorId, 'events.order_confirmed', orderId, { status: order.status, paymentStatus: payment.status }, { status: 'confirmed', paymentId: payment.id, source, places: confirmed.length, tickets: tickets.length, rehold }, at);
    if (rehold) await audit(trx, actorId, 'events.order_reheld', orderId, { holdCycle: order.holdCycle }, { holdCycle: cycle, places: confirmed.length }, at);

    return { changed: true, outcome: rehold ? 'reheld' : 'confirmed', rehold, order: plain(savedOrder), payment: plain(savedPayment), registrations: confirmed, tickets };
  }

  /** Capacity for every line of a lapsed order, read under the ticket-type locks. Writes nothing. */
  async function reholdCapacity(trx, order, lines, regs) {
    const types = await lockTicketTypes(trx, lines.map(l => l.ticketTypeId));
    for (const line of lines) {
      const t = types.get(line.ticketTypeId);
      if (!t || Number(t.capacity) - Number(t.sold) - Number(t.held) < line.quantity) return { error: 'capacity_unavailable', ticketTypeId: line.ticketTypeId };
    }
    // Only places the expiry cancelled come back; a place a person removed stays removed.
    const revivable = regs.filter(r => r.status === 'cancelled' && r.cancelReason === 'expired');
    if (revivable.length !== lines.reduce((n, l) => n + l.quantity, 0)) return { error: 'order_cancelled' };
    return {};
  }

  /** The rehold writes: held + qty per line (one `hold` movement each at cycle + 1), places cancelled → reserved. */
  async function reholdApply(trx, { order, lines, regs, cycle, at }) {
    for (const line of lines) {
      const updated = await trx('EventTicketType').where({ id: line.ticketTypeId }).whereRaw('sold + held + ? <= capacity', [line.quantity])
        .update({ held: trx.raw('held + ?', [line.quantity]), updatedAt: at });
      if (!updated) throw storeRefusal('capacity_unavailable', 409, { ticketTypeId: line.ticketTypeId });
      await trx('EventInventoryMovement').insert({
        id: newId('eim'), ticketTypeId: line.ticketTypeId, orderId: order.id, kind: 'hold', quantity: line.quantity, cycle,
        movementKey: movementKeyOf(order.id, cycle, 'hold', line.ticketTypeId), createdAt: at,
      }).onConflict('movementKey').ignore();
    }
    const revived = regs.filter(r => r.status === 'cancelled' && r.cancelReason === 'expired');
    for (const r of revived) {
      if (!canTransition('registration', 'cancelled', 'reserved')) throw storeRefusal('order_integrity', 500);
      await trx('EventRegistration').where({ id: r.id, status: 'cancelled' }).update({ status: 'reserved', cancelledAt: null, cancelReason: null, updatedAt: at });
    }
    return revived.map(r => ({ ...r, status: 'reserved' }));
  }

  /** Money in, the places cannot be honoured: payment reconciliation_required + a full approved refund, same transaction. */
  async function unfulfilled(trx, { order, payment, event, reason, at, actorId, source }) {
    const memberId = order.purchaserUserId ?? order.createdByUserId;
    if (!memberId) throw storeRefusal('refund_recipient_missing', 409);
    const refundId = newRefundId();
    try {
      await trx('Refund').insert({
        id: refundId, memberId, kind: 'event_order', scope: 'unfulfilled_payment', eventId: order.eventId, eventOrderId: order.id, organizerId: event?.organizerId ?? null,
        organizationId: order.organizationId ?? null, eventPaymentId: payment.id, amountTzs: Number(payment.amountTzs), currency: payment.currency,
        reasonCode: 'payment_error', note: null, status: 'approved', requestedBy: 'system', requestedRole: 'system', decidedBy: 'policy', decidedAt: at,
        policySnapshot: json({ reason, source }), createdAt: at, updatedAt: at,
      });
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) throw storeRefusal('refund_in_progress', 409);
      throw err;
    }
    const move = payment.status === 'reconciliation_required' || canTransition('paymentAttempt', payment.status, 'reconciliation_required');
    if (!move) throw storeRefusal('payment_not_confirmable', 409, { paymentStatus: payment.status });
    const [savedPayment] = await trx('EventPayment').where({ id: payment.id }).update({
      status: 'reconciliation_required', failureReason: reason, refundId, eventId: order.eventId, organizerId: event?.organizerId ?? null,
      lateOrder: order.status === 'expired' || payment.lateOrder === true, updatedAt: at,
    }).returning('*');
    await audit(trx, actorId, 'events.payment_reconciliation_required', order.id, { paymentStatus: payment.status }, { paymentId: payment.id, reason, refundId, source }, at);
    await outbox(trx, event, 'refund.requested', 'refund', refundId, { refundId, orderId: order.id, eventId: order.eventId, scope: 'unfulfilled_payment' });
    return { changed: true, outcome: 'refund_raised', reason, refundId, order, payment: plain(savedPayment), registrations: [], tickets: [] };
  }

  // ── Cancelling paid places ──────────────────────────────────────────────────

  /**
   * Confirmed places → cancelled under the caller's order lock: tickets revoked, `uncommit` movements (sold − 1) when
   * `releaseInventory`, outbox rows. `refundId` (when given) is set on every place by a conditional update (`existingRefund`:
 * the places already carry it — an approved manual-review refund); zero rows
   * updated means another refund already covers the place and the whole transaction aborts with 409 refund_in_progress.
   * The caller then inserts the Refund row (same transaction) and calls deriveAndSetOrderStatus.
   */
  async function cancelPaidPlaces(trx, { order, registrations, cancelReason, revokeReason = 'cancelled', releaseInventory = false, refundId = null, existingRefund = false, actorId = null }) {
    const at = now();
    const event = plain(await trx('Event').where({ id: order.eventId }).first());
    const live = registrations.filter(r => r.status === 'confirmed');
    if (releaseInventory && live.length) await lockTicketTypes(trx, live.map(r => r.ticketTypeId));
    const cancelled = [];
    for (const reg of live) {
      let q = trx('EventRegistration').where({ id: reg.id, status: 'confirmed' });
      // A fresh refund claims places nobody else covers; an approved manual-review refund already holds them.
      if (refundId) q = existingRefund ? q.where({ refundId }) : q.whereNull('refundId');
      const [saved] = await q.update({ status: 'cancelled', cancelledAt: at, cancelReason, ...(refundId ? { refundId } : {}), updatedAt: at }).returning('*');
      if (!saved) throw storeRefusal('refund_in_progress', 409, { registrationId: reg.id });
      cancelled.push(plain(saved));
      const tickets = await trx('EventTicket').where({ registrationId: reg.id, status: 'active' }).update({ status: 'revoked', revokedAt: at, revokeReason: revokeReason, updatedAt: at }).returning('id');
      for (const t of tickets) await outbox(trx, event, 'ticket.revoked', 'ticket', t.id, { ticketId: t.id, registrationId: reg.id, eventId: order.eventId, reason: revokeReason });
      if (releaseInventory) {
        const inserted = await trx('EventInventoryMovement').insert({
          id: newId('eim'), ticketTypeId: reg.ticketTypeId, orderId: order.id, kind: 'uncommit', quantity: 1, cycle: order.holdCycle,
          movementKey: movementKeyOf(order.id, order.holdCycle, 'uncommit', reg.ticketTypeId, reg.id), createdAt: at,
        }).onConflict('movementKey').ignore().returning('id');
        if (inserted.length) await trx('EventTicketType').where({ id: reg.ticketTypeId }).whereRaw('sold >= 1').update({ sold: trx.raw('sold - 1'), updatedAt: at });
      }
      await outbox(trx, event, 'registration.cancelled', 'registration', reg.id, { registrationId: reg.id, orderId: order.id, eventId: order.eventId, status: 'cancelled', reason: cancelReason });
    }
    return { cancelled, actorId };
  }

  // ── What a paid or refused refund does ─────────────────────────────────────

  /** Proportional shares of `amount` over `weights`, whole shillings, the remainder one by one from the first. */
  function shares(amount, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    if (!total) return weights.map(() => 0);
    const out = weights.map(w => Math.floor((amount * w) / total));
    let rest = amount - out.reduce((a, b) => a + b, 0);
    for (let i = 0; rest > 0 && i < out.length; i += 1, rest -= 1) if (out[i] < weights[i]) out[i] += 1;
    return out;
  }

  /**
   * A refund was marked paid (idempotent; callable again by the sweep). registration/order/event_cancelled scopes:
   * the covered places cancelled → refunded with their share in `refundedTzs`; the order's `refundedTzs` is
   * re-summed from its places; the order status is derived. unfulfilled_payment: the EventPayment
   * reconciliation_required → failed ('refunded_after_late_payment'); organizer money is untouched.
   */
  async function applyRefundPaid(trx, refund) {
    const at = now();
    const order = plain(await trx('EventOrder').where({ id: refund.eventOrderId }).forUpdate().first());
    if (!order) return { applied: false };
    if (refund.scope === 'unfulfilled_payment') {
      const moved = await trx('EventPayment').where({ id: refund.eventPaymentId, status: 'reconciliation_required' })
        .update({ status: 'failed', failureReason: 'refunded_after_late_payment', updatedAt: at });
      if (moved) {
        const event = plain(await trx('Event').where({ id: order.eventId }).first());
        await outbox(trx, event, 'refund.paid', 'refund', refund.id, { refundId: refund.id, orderId: order.id, eventId: order.eventId, scope: refund.scope });
      }
      return { applied: true, order };
    }
    const covered = (await trx('EventRegistration').where({ orderId: order.id, refundId: refund.id }).orderBy('id').forUpdate()).map(plain);
    const owed = covered.filter(r => r.status === 'cancelled');
    // The shares are worked out over every place the refund covers, so a re-run (the sweep) gives the same numbers.
    const everyShare = shares(Number(refund.amountTzs), covered.map(r => Number(r.paidAmountTzs ?? 0)));
    let moved = 0;
    for (const reg of owed) {
      if (!canTransition('registration', 'cancelled', 'refunded')) break;
      const share = Math.min(everyShare[covered.findIndex(c => c.id === reg.id)], Number(reg.paidAmountTzs ?? 0));
      moved += await trx('EventRegistration').where({ id: reg.id, status: 'cancelled' }).update({ status: 'refunded', refundedTzs: share, updatedAt: at });
    }
    const [{ sum }] = await trx('EventRegistration').where({ orderId: order.id }).sum({ sum: 'refundedTzs' });
    await trx('EventOrder').where({ id: order.id }).update({ refundedTzs: Math.min(Number(sum ?? 0), Number(order.totalTzs)), updatedAt: at });
    const derived = await deriveAndSetOrderStatus(trx, order.id);
    if (moved) {
      const event = plain(await trx('Event').where({ id: order.eventId }).first());
      await outbox(trx, event, 'refund.paid', 'refund', refund.id, { refundId: refund.id, orderId: order.id, eventId: order.eventId, scope: refund.scope });
    }
    return { applied: true, order: derived?.order ?? order };
  }

  /** A refund was refused: the places it covered are free for another refund, and the order status follows. */
  async function applyRefundRejected(trx, refund) {
    const at = now();
    if (!refund.eventOrderId) return { applied: false };
    await trx('EventOrder').where({ id: refund.eventOrderId }).forUpdate().first();
    await trx('EventRegistration').where({ orderId: refund.eventOrderId, refundId: refund.id }).update({ refundId: null, updatedAt: at });
    const derived = await deriveAndSetOrderStatus(trx, refund.eventOrderId);
    return { applied: true, order: derived?.order ?? null };
  }

  // ── Hold rules while a payment waits (§3.6) ─────────────────────────────────

  /**
   * Extend the hold of an awaiting order. `mode` 'manual' → max(current, now + manualExtendMs) ; 'provider' → max(current, now + providerExtendMs);
   * always capped at holdCapAt (set once: createdAt + maxHoursMs) and at the event's start; never shortened.
   */
  async function extendHold(trx, order, { mode, manualExtendMs, providerExtendMs, maxHoursMs }) {
    const at = now();
    const event = plain(await trx('Event').where({ id: order.eventId }).first('startsAt'));
    const cap = order.holdCapAt ? new Date(order.holdCapAt) : new Date(+new Date(order.createdAt) + maxHoursMs);
    const current = order.holdExpiresAt ? new Date(order.holdExpiresAt) : at;
    const wanted = new Date(+at + (mode === 'provider' ? providerExtendMs : manualExtendMs));
    const next = new Date(Math.max(+current, Math.min(+cap, +new Date(event.startsAt), Math.max(+current, +wanted))));
    const [saved] = await trx('EventOrder').where({ id: order.id }).update({
      holdExpiresAt: next, holdCapAt: cap, holdExtendedAt: at, holdExtensions: trx.raw('"holdExtensions" + 1'), updatedAt: at,
    }).returning('*');
    await audit(trx, order.purchaserUserId ?? order.createdByUserId, 'events.hold_extended', order.id, { holdExpiresAt: order.holdExpiresAt }, { holdExpiresAt: next.toISOString(), holdCapAt: cap.toISOString(), mode }, at);
    return plain(saved);
  }

  /** After a rejection: min(cap, max(current, now + retry)), so the member can fix a typo; never past the cap or the start. */
  async function resetHoldAfterRejection(trx, order, { retryMs, maxHoursMs }) {
    if (order.status !== 'awaiting_payment') return order;
    const at = now();
    const event = plain(await trx('Event').where({ id: order.eventId }).first('startsAt'));
    const cap = order.holdCapAt ? new Date(order.holdCapAt) : new Date(+new Date(order.createdAt) + maxHoursMs);
    const current = order.holdExpiresAt ? new Date(order.holdExpiresAt) : at;
    const next = new Date(Math.max(+current, Math.min(+cap, +new Date(event.startsAt), Math.max(+current, +at + retryMs))));
    const [saved] = await trx('EventOrder').where({ id: order.id }).update({ holdExpiresAt: next, holdCapAt: cap, updatedAt: at }).returning('*');
    return plain(saved);
  }

  return {
    confirmPaidOrder, cancelPaidPlaces, applyRefundPaid, applyRefundRejected, deriveAndSetOrderStatus, extendHold, resetHoldAfterRejection,
    eventOpen, LIVE_REGISTRATION,
  };
}
