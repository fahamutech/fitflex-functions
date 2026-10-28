// Marathon & running events · S4 — refunds and cancellation of paid places (spec §3.12, §3.13).
//
//   previewRegistration / previewOrder        GET …/cancel-preview    what a cancellation is worth, read-only
//   cancelRegistration / cancelOrder          POST …/cancel           member (purchaser) cancels a paid place or order
//   corporate*                                the organisation's billing roles cancel a paid corporate order (whole order)
//   adminCancelPaidOrder                      POST /admin/events/:id/orders/:orderId/cancel { note, refundMode }
//   eventCancelPreview / runEventBatch        the refund batch of a cancelled event (idempotent, resumable)
//   batchDecision / batchPaid                 helpers that apply the existing per-refund rules row by row
//   adminRaiseForPayment                      POST /admin/refunds { eventPaymentId } (money in, place not possible)
//   onApproved / onPaid / onRejected          the refund-service hooks for kind 'event_order'
//
// A cancellation and its refund row are ONE transaction: there is never a committed cancellation without its
// refund when refundTzs > 0. A place is covered by at most one live refund (EventRegistration.refundId + the
// Refund partial uniques), so member, admin and event cancellation can race without a duplicate refund.
// Percent never rounds up: floor(paid × percent / 100) per place. Money is whole TZS (D4). Payout stays manual.
import { randomUUID } from 'node:crypto';
import { storeRefusal } from '../infra/event-store-pg.mjs';
import { newRefundId } from '../infra/event-money-store-pg.mjs';
import { evaluateRefund, normalisePolicy, describePolicy, refundFor } from '../shared/events-refund-policy.mjs';
import { policyView } from '../shared/events-document.mjs';
import { MEMBER_CANCEL_REASONS } from '../shared/events-participants.mjs';
import { iso, refundView, maskPayerPhone } from '../shared/events-money-views.mjs';
import { formatTsh } from '../shared/money-display.mjs';
import { ORG_BILLING_ROLES } from './events-roster-service.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const refuse = (error, status, extra = {}) => storeRefusal(error, status, extra);
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const json = value => (value === undefined || value === null || typeof value === 'string' ? value : JSON.stringify(value));
const isStr = v => typeof v === 'string';
const UNIQUE_VIOLATION = '23505';
const CHUNK = 200;
const DAY = 86_400_000;
const LIVE_REFUND = ['requested', 'approved', 'paid'];

export function createEventsRefundService({
  db, eventStore, money, registration,
  // Lazy: the services below are declared after this one in bootstrap.
  getPayments = () => null, getRefundService = () => null,
  notice = async () => {}, track = async () => {}, ops = null,
  senders = { sms: () => ({ configured: false }), email: () => ({ configured: false }) },
  now = () => new Date(),
}) {
  const R = () => registration.internals;
  const audit = async (actor, action, target, before, after) => {
    try { await db('AuditLog').insert({ id: randomUUID(), at: now(), actor: actor || 'system', action, target, before: json(before ?? null), after: json(after ?? null) }); } catch { /* best effort */ }
  };
  const analytics = async (name, payload) => {
    await audit('system', `analytics.${name}`, payload.eventId ?? payload.orderId ?? 'events', null, payload);
    try { await track(name, payload); } catch { /* best effort */ }
  };

  // ── Evaluation ─────────────────────────────────────────────────────────────

  async function contextOf(q, order) {
    const event = plain(await q('Event').where({ id: order.eventId }).first());
    const categories = new Map((await q('EventCategory').where({ eventId: order.eventId })).map(c => [c.id, plain(c)]));
    const types = new Map((await q('EventTicketType').where({ eventId: order.eventId })).map(t => [t.id, plain(t)]));
    return { event, categories, types };
  }

  /** Can this place be sold again after a cancellation: the event is still on sale and so is the place's category / ticket type. */
  function canResell(ctx, reg, at) {
    const { event, categories, types } = ctx;
    const c = categories.get(reg.categoryId);
    const t = types.get(reg.ticketTypeId);
    if (!event || event.status !== 'published' || !c || !t) return false;
    if (c.status !== 'active' || t.status !== 'active') return false;
    if (event.registrationClosesAt && +at >= +new Date(event.registrationClosesAt)) return false;
    if (c.registrationClosesAt && +at >= +new Date(c.registrationClosesAt)) return false;
    if (t.saleClosesAt && +at >= +new Date(t.saleClosesAt)) return false;
    return true;
  }

  /** The policy applied to these places at `at`: { mode, percent, paidTzs, refundTzs, deadlineAt, places[] }. */
  function evaluatePlaces(ctx, regs, at) {
    const policy = ctx.event.refundPolicySnapshot ?? ctx.event.refundPolicy ?? null;
    const places = [];
    let closed = false; let review = false; let paid = 0; let refund = 0; let deadlineAt = null;
    const percents = new Set();
    for (const reg of regs) {
      const p = Number(reg.paidAmountTzs ?? 0);
      const ev = evaluateRefund({ policy, event: ctx.event, category: ctx.categories.get(reg.categoryId), now: at, paidTzs: p });
      if (ev.mode === 'closed') closed = true;
      if (ev.mode === 'manual_review') review = true;
      paid += p;
      const place = ev.mode === 'manual_review' ? p : ev.mode === 'closed' ? 0 : refundFor(p, ev.percent);
      refund += place;
      if (ev.percent !== null) percents.add(ev.percent);
      deadlineAt = deadlineAt ?? ev.deadlineAt;
      places.push({ registrationId: reg.id, name: `${reg.firstName} ${reg.lastName}`.trim(), paidTzs: p, refundTzs: place });
    }
    const mode = closed ? 'closed' : review ? 'manual_review' : refund > 0 ? 'auto' : 'none';
    return { mode, percent: percents.size === 1 ? [...percents][0] : null, paidTzs: paid, refundTzs: refund, deadlineAt, places, policy };
  }

  const policySummary = policy => {
    const v = policyView(policy);
    return { preset: v.preset, text: v.text, ...(v.days !== undefined ? { days: v.days } : {}), ...(v.tiers ? { tiers: v.tiers } : {}), generated: describePolicy(policy) };
  };

  /** Why this cancellation cannot go ahead, or null. */
  function blockedOf({ ctx, order, regs, ev, viewerIsPurchaser = true }) {
    if (ctx.event?.status === 'cancelled') return 'event_cancelled';
    if (!viewerIsPurchaser) return 'purchaser_only';
    if (regs.some(r => r.kitStatus === 'collected')) return 'kit_collected';
    if (regs.some(r => r.refundId)) return 'refund_in_progress';
    if (ev.mode === 'closed') return 'cancellation_window_closed';
    void order;
    return null;
  }

  async function previewOf({ order, regs, viewerIsPurchaser = true }) {
    const ctx = await contextOf(db, order);
    const live = regs.filter(r => r.status === 'confirmed');
    if (!live.length) return fail('nothing_to_cancel', 409);
    const at = now();
    const ev = evaluatePlaces(ctx, live, at);
    const blocked = blockedOf({ ctx, order, regs: live, ev, viewerIsPurchaser });
    return {
      eligible: !blocked, mode: ev.mode, percent: ev.percent, paidTzs: ev.paidTzs, refundTzs: ev.mode === 'closed' ? 0 : ev.refundTzs, currency: order.currency, deadlineAt: ev.deadlineAt,
      policy: policySummary(ctx.event.refundPolicySnapshot ?? ctx.event.refundPolicy), places: ev.places,
      releaseInventory: live.some(r => canResell(ctx, r, at)), blocked,
    };
  }

  /** For allowedActions: is there a paid place that can still be cancelled now (and not blocked)? */
  async function cancellable(loaded) {
    const live = loaded.registrations.filter(r => r.status === 'confirmed');
    if (!live.length) return false;
    const p = await previewOf({ order: loaded.order, regs: loaded.registrations });
    return !p.error && p.eligible;
  }

  async function previewRegistration({ userId, registrationId }) {
    const reg = plain(await db('EventRegistration').where({ id: registrationId }).first());
    if (!reg || (reg.purchaserUserId !== userId && reg.participantUserId !== userId)) return fail('registration_not_found', 404);
    const loaded = await eventStore.getOrder(reg.orderId);
    if (reg.status !== 'confirmed') return fail('nothing_to_cancel', 409, { status: reg.status });
    return previewOf({ order: loaded.order, regs: [loaded.registrations.find(r => r.id === registrationId)], viewerIsPurchaser: reg.purchaserUserId === userId });
  }

  async function previewOrder({ userId = null, access = null, orderId }) {
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded) return fail('order_not_found', 404);
    const o = loaded.order;
    if (access ? (o.organizationId !== access.org.id || o.purchaserUserId) : o.purchaserUserId !== userId) return fail('order_not_found', 404);
    if (access && !(access.platformAdmin || ORG_BILLING_ROLES.includes(access.role))) return fail('forbidden', 403, { requiredRole: [...ORG_BILLING_ROLES] });
    return previewOf({ order: o, regs: loaded.registrations });
  }

  // ── The cancellation transaction ───────────────────────────────────────────

  async function insertRefund(trx, row) {
    try {
      const [saved] = await trx('Refund').insert({ ...row, policySnapshot: json(row.policySnapshot ?? null) }).returning('*');
      return plain(saved);
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) throw refuse('refund_in_progress', 409);
      throw err;
    }
  }

  /**
   * Cancel paid places under the order lock. `target` 'registration' (one id) or 'order' (every confirmed place).
   *   actor { id, role: 'member' | 'admin', access? }, `refundMode` 'policy' (members) | 'full' | 'policy' | 'none' (admin)
   */
  async function runCancel({ orderId, registrationId = null, scope, reason, expectedRefundTzs = null, actor, refundMode = 'policy', note = null, corporate = false }) {
    let outcome;
    try {
      outcome = await db.transaction(async (trx) => {
        const order = plain(await trx('EventOrder').where({ id: orderId }).forUpdate().first());
        if (!order) throw refuse('order_not_found', 404);
        const regs = (await trx('EventRegistration').where({ orderId }).orderBy('id').forUpdate()).map(plain);
        const target = registrationId ? regs.filter(r => r.id === registrationId) : regs;
        const live = target.filter(r => r.status === 'confirmed');
        if (!live.length) {
          const existing = plain(await trx('Refund').where({ kind: 'event_order', eventOrderId: orderId }).whereIn('status', LIVE_REFUND).orderBy('createdAt', 'desc').first());
          return { changed: false, order, regs, refund: existing, requested: false };
        }
        const ctx = await contextOf(trx, order);
        const at = now();
        const ev = evaluatePlaces(ctx, live, at);
        const isAdmin = actor.role === 'admin';
        const blocked = blockedOf({ ctx, order, regs: live, ev });
        // Members are blocked by every reason; an admin can still cancel after the window or the kit, but not an event FitFlex
        // already cancelled (its batch handles the refunds) and not a place another refund covers.
        if (blocked && (!isAdmin || ['event_cancelled', 'refund_in_progress'].includes(blocked))) throw refuse(blocked, 409);
        const mode = isAdmin
          ? (refundMode === 'none' ? 'none' : refundMode === 'full' ? 'full' : (ev.mode === 'closed' ? 'none' : ev.mode === 'manual_review' ? 'full' : ev.mode))
          : ev.mode;
        const paid = ev.paidTzs;
        let amount = mode === 'full' ? paid : mode === 'manual_review' ? paid : mode === 'auto' ? ev.refundTzs : 0;
        if (!isAdmin) {
          if (!Number.isInteger(expectedRefundTzs)) throw refuse('expected_refund_required', 400);
          if (expectedRefundTzs !== (ev.mode === 'closed' ? 0 : ev.refundTzs)) throw refuse('refund_changed', 409, { refundTzs: ev.refundTzs });
        }
        const releaseInventory = live.some(r => canResell(ctx, r, at));
        const memberId = corporate ? order.createdByUserId : (order.purchaserUserId ?? order.createdByUserId);
        const base = {
          memberId, kind: 'event_order', scope, eventId: order.eventId, eventOrderId: order.id, eventRegistrationId: scope === 'registration' ? live[0].id : null,
          organizerId: ctx.event.organizerId, organizationId: order.organizationId ?? null, eventPaymentId: (await trx('EventPayment').where({ orderId, status: 'succeeded' }).first('id'))?.id ?? null,
          currency: order.currency, createdAt: at, updatedAt: at,
        };
        const snapshot = { preset: normalisePolicy(ctx.event.refundPolicySnapshot ?? ctx.event.refundPolicy).preset, percent: mode === 'full' ? 100 : ev.percent, deadlineAt: ev.deadlineAt, evaluatedAt: at.toISOString(), mode, registrationIds: live.map(r => r.id) };

        if (mode === 'manual_review') {
          // Nothing is cancelled yet: a person decides. The places are held by this request so nobody can refund them twice.
          const id = newRefundId();
          const refund = await insertRefund(trx, {
            ...base, id, amountTzs: amount, reasonCode: 'member_cancelled', note: reason ?? null, status: 'requested', requestedBy: actor.id, requestedRole: 'member', policySnapshot: snapshot,
          });
          const claimed = await trx('EventRegistration').whereIn('id', live.map(r => r.id)).whereNull('refundId').update({ refundId: id, updatedAt: at });
          if (claimed !== live.length) throw refuse('refund_in_progress', 409);
          await trx('AuditLog').insert({ id: randomUUID(), at, actor: actor.id, action: 'events.registration_cancelled_paid', target: orderId, before: null, after: JSON.stringify({ refundId: id, mode, scope }) });
          return { changed: true, order, regs: (await trx('EventRegistration').where({ orderId }).orderBy('id')).map(plain), refund, requested: true, cancelled: [] };
        }

        const refundId = amount > 0 ? newRefundId() : null;
        const done = await money.cancelPaidPlaces(trx, {
          order, registrations: live, cancelReason: isAdmin ? 'admin' : reason, revokeReason: isAdmin ? 'admin' : (amount > 0 ? 'refunded' : 'cancelled'), releaseInventory, refundId, actorId: actor.id,
        });
        let refund = null;
        if (refundId) {
          refund = await insertRefund(trx, {
            ...base, id: refundId, amountTzs: amount, reasonCode: isAdmin ? 'cancelled_by_fitflex' : 'member_cancelled', note: isAdmin ? note : null,
            status: isAdmin ? 'requested' : 'approved', requestedBy: actor.id, requestedRole: isAdmin ? 'admin' : 'member',
            decidedBy: isAdmin ? null : 'policy', decidedAt: isAdmin ? null : at, policySnapshot: snapshot,
          });
        }
        const derived = await money.deriveAndSetOrderStatus(trx, orderId);
        await trx('AuditLog').insert({
          id: randomUUID(), at, actor: actor.id, action: isAdmin ? 'events.order_cancelled' : 'events.registration_cancelled_paid', target: orderId,
          before: JSON.stringify({ status: order.status }),
          after: JSON.stringify({ status: derived?.order?.status ?? order.status, scope, mode, refundTzs: amount, refundId, releaseInventory, places: done.cancelled.length, note: note ?? null, reason: isAdmin ? 'admin' : reason }),
        });
        return {
          changed: true, order: derived?.order ?? order, regs: (await trx('EventRegistration').where({ orderId }).orderBy('id')).map(plain), refund, requested: false, cancelled: done.cancelled, mode, amount,
        };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      throw err;
    }
    return afterCancel(outcome, { actor, scope, reason, corporate });
  }

  async function afterCancel(outcome, { actor, scope, reason, corporate }) {
    const { order, regs, refund } = outcome;
    const event = plain(await db('Event').where({ id: order.eventId }).first());
    if (outcome.changed && refund) await tellRefund(refund, event, refund.status === 'requested' && refund.requestedRole === 'admin' ? 'requested_by_fitflex' : refund.status === 'approved' ? 'approved' : 'requested');
    if (outcome.changed && (outcome.cancelled?.length)) {
      for (const reg of outcome.cancelled) {
        if (reg.participantUserId && reg.participantUserId !== order.purchaserUserId && reg.claimedAt) {
          await notice(reg.participantUserId, {
            id: `ntf_evpc_${reg.id}`, type: 'event_place_cancelled_by_purchaser',
            en: { title: 'Your place was cancelled', body: `Your place in ${event?.title ?? 'the event'} was cancelled by the person who registered you.` },
            sw: { title: 'Tiketi yako imeghairiwa', body: `Tiketi yako ya ${event?.title ?? 'tukio'} imeghairiwa na aliyekusajili.` },
            data: { registrationId: reg.id, eventId: order.eventId, route: '/member/events/registrations' },
          });
        }
      }
      await analytics(refund ? 'refund_requested' : 'registration_cancelled', { eventId: order.eventId, scope: refund?.scope ?? scope, mode: outcome.mode ?? null });
      if (!refund) await analytics('cancel_no_refund', { eventId: order.eventId, scope });
    }
    void actor; void reason; void corporate;
    const views = await R().viewsOf(regs, order.eventId);
    const out = { order: R().orderView(order), registrations: views, refund: refundView(refund), changed: outcome.changed, ...(outcome.requested ? { requested: true } : {}) };
    return out;
  }

  // Member / corporate entry points ------------------------------------------------

  async function cancelRegistration({ userId, registrationId, body = {} }) {
    if (!MEMBER_CANCEL_REASONS.includes(body.reason)) return fail('invalid_reason', 400, { allowed: [...MEMBER_CANCEL_REASONS] });
    const reg = plain(await db('EventRegistration').where({ id: registrationId }).first());
    if (!reg) return fail('registration_not_found', 404);
    if (reg.purchaserUserId !== userId) return reg.participantUserId === userId ? fail('purchaser_only', 403) : fail('registration_not_found', 404);
    const out = await runCancel({ orderId: reg.orderId, registrationId, scope: 'registration', reason: body.reason, expectedRefundTzs: body.expectedRefundTzs, actor: { id: userId, role: 'member' } });
    if (out.error) return out;
    const view = out.registrations.find(r => r.id === registrationId);
    return { ...out, registration: view };
  }

  async function cancelOrder({ userId, orderId, body = {} }) {
    if (!MEMBER_CANCEL_REASONS.includes(body.reason)) return fail('invalid_reason', 400, { allowed: [...MEMBER_CANCEL_REASONS] });
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded || loaded.order.purchaserUserId !== userId) return fail('order_not_found', 404);
    return runCancel({ orderId, scope: 'order', reason: body.reason, expectedRefundTzs: body.expectedRefundTzs, actor: { id: userId, role: 'member' } });
  }

  async function cancelOrderCorporate({ access, orderId, body = {}, actorId }) {
    if (!(access.platformAdmin || ORG_BILLING_ROLES.includes(access.role))) return fail('forbidden', 403, { requiredRole: [...ORG_BILLING_ROLES] });
    if (!MEMBER_CANCEL_REASONS.includes(body.reason)) return fail('invalid_reason', 400, { allowed: [...MEMBER_CANCEL_REASONS] });
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded || loaded.order.organizationId !== access.org.id || loaded.order.purchaserUserId) return fail('order_not_found', 404);
    return runCancel({ orderId, scope: 'order', reason: body.reason, expectedRefundTzs: body.expectedRefundTzs, actor: { id: actorId, role: 'member' }, corporate: true });
  }

  /** Admin: cancel a paid order with a refund mode (the refund is then a `payments` step, approved by a second admin). */
  async function adminCancelPaidOrder({ eventId, orderId, body = {}, actorId }) {
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded || loaded.order.eventId !== eventId) return fail('order_not_found', 404);
    const note = isStr(body.note) ? body.note.trim().slice(0, 500) : '';
    if (note.length < 5) return fail('note_required', 400, { min: 5 });
    if (!['full', 'policy', 'none'].includes(body.refundMode)) return fail('refund_mode_required', 400, { allowed: ['full', 'policy', 'none'] });
    return runCancel({ orderId, scope: 'order', reason: 'admin', actor: { id: actorId, role: 'admin' }, refundMode: body.refundMode, note, corporate: Boolean(loaded.order.organizationId && !loaded.order.purchaserUserId) });
  }

  /** A pending manual payment on an unpaid order the admin cancels: the request and EventPayment are cancelled with it (never silent). */
  async function cancelPendingPaymentOf(orderId, actorId) {
    const payments = await db('EventPayment').where({ orderId }).whereIn('status', ['created', 'pending']);
    for (const p of payments) {
      await db.transaction(async (trx) => {
        await trx('EventPayment').where({ id: p.id }).whereIn('status', ['created', 'pending']).update({ status: 'cancelled', updatedAt: now() });
        if (p.paymentRequestId) await trx('PaymentRequest').where({ id: p.paymentRequestId, status: 'pending' }).update({ status: 'cancelled', decidedAt: now(), decidedBy: actorId, note: 'event_order: order cancelled by FitFlex' });
      });
      await audit(actorId, 'events.payment_cancelled', orderId, { paymentId: p.id }, { reason: 'order_cancelled_by_admin' });
    }
    return payments.length;
  }

  // ── Refund notifications (bilingual; kind event_order) ─────────────────────

  async function tellRefund(refund, event, type, extra = {}) {
    const to = refund.memberId;
    const money_ = formatTsh(refund.amountTzs);
    const title = event?.title ?? 'the event';
    const texts = {
      requested: { t: ['Refund request received', 'Ombi la marejesho limepokelewa'], b: [`We have your request for ${money_} for ${title}. FitFlex will reply soon.`, `Tumepokea ombi lako la ${money_} la ${title}. FitFlex itajibu hivi karibuni.`], type: 'event_refund_requested' },
      requested_by_fitflex: { t: ['Refund being prepared', 'Marejesho yanaandaliwa'], b: [`FitFlex is preparing a refund of ${money_} for ${title}. We will tell you when it is sent.`, `FitFlex inaandaa marejesho ya ${money_} ya ${title}. Tutakuarifu yatakapotumwa.`], type: 'event_refund_requested' },
      approved: { t: ['Refund approved', 'Marejesho yameidhinishwa'], b: [`Your refund of ${money_} is approved. FitFlex will send it to the account you paid from.`, `Marejesho yako ya ${money_} yameidhinishwa. FitFlex itayatuma kwenye akaunti uliyolipia.`], type: 'event_refund_approved' },
      paid: { t: ['Refund sent', 'Marejesho yametumwa'], b: [`We sent ${money_} back to you. Reference: ${extra.reference ?? refund.paymentReference ?? ''}.`, `Tumekutumia ${money_}. Namba ya kumbukumbu: ${extra.reference ?? refund.paymentReference ?? ''}.`], type: 'event_refund_paid' },
      rejected: { t: ['Refund not approved', 'Marejesho hayajaidhinishwa'], b: [extra.note ?? refund.decisionNote ?? 'Contact support.', extra.note ?? refund.decisionNote ?? 'Wasiliana na msaada.'], type: 'event_refund_rejected' },
    };
    const c = texts[type];
    if (!c) return;
    await notice(to, {
      id: `ntf_${c.type}_${refund.id}`, type: c.type, en: { title: c.t[0], body: c.b[0] }, sw: { title: c.t[1], body: c.b[1] },
      data: { refundId: refund.id, kind: refund.kind, orderId: refund.eventOrderId, eventId: refund.eventId, route: `/member/events/orders/${refund.eventOrderId}` },
    });
  }

  // ── Hooks for refund-service ───────────────────────────────────────────────

  /** Approved: a manual-review request cancels the places now (the approved amount is already on the row). */
  async function onApproved(refund) {
    if (refund.kind !== 'event_order' || refund.scope === 'unfulfilled_payment') return;
    const snapshot = typeof refund.policySnapshot === 'string' ? JSON.parse(refund.policySnapshot) : refund.policySnapshot;
    if (snapshot?.mode !== 'manual_review') return;
    await db.transaction(async (trx) => {
      const order = plain(await trx('EventOrder').where({ id: refund.eventOrderId }).forUpdate().first());
      const regs = (await trx('EventRegistration').where({ orderId: order.id, refundId: refund.id }).orderBy('id').forUpdate()).map(plain);
      const live = regs.filter(r => r.status === 'confirmed');
      if (!live.length) return;
      const ctx = await contextOf(trx, order);
      const at = now();
      await money.cancelPaidPlaces(trx, {
        order, registrations: live, cancelReason: 'member_review_approved', revokeReason: 'refunded', releaseInventory: live.some(r => canResell(ctx, r, at)), refundId: refund.id, existingRefund: true,
      });
      await money.deriveAndSetOrderStatus(trx, order.id);
    });
  }

  /** Paid: places cancelled → refunded (their share in refundedTzs), order refundedTzs and status, unfulfilled payment → failed. */
  async function onPaid(refund) {
    if (refund.kind !== 'event_order') return;
    await db.transaction(async trx => money.applyRefundPaid(trx, refund));
    const event = plain(await db('Event').where({ id: refund.eventId }).first());
    void event;
    await analytics('refund_completed', { eventId: refund.eventId, scope: refund.scope });
  }

  /** Refused: the places it covered are free for another refund; the cancellation (if any) stands. */
  async function onRejected(refund) {
    if (refund.kind !== 'event_order') return;
    await db.transaction(async trx => money.applyRefundRejected(trx, refund));
  }

  /** The sweep: paid refunds whose places were not updated (a crash between the refund write and the hook). */
  async function repairPaid({ limit = 100 } = {}) {
    const rows = (await db('Refund as f').where('f.kind', 'event_order').where('f.status', 'paid').whereNot('f.scope', 'unfulfilled_payment')
      .whereExists(db('EventRegistration as r').whereRaw('r."refundId" = f.id').where('r.status', 'cancelled')).limit(limit).select('f.*')).map(plain);
    const unfulfilled = (await db('Refund as f').where('f.kind', 'event_order').where('f.status', 'paid').where('f.scope', 'unfulfilled_payment')
      .whereExists(db('EventPayment as p').whereRaw('p.id = f."eventPaymentId"').where('p.status', 'reconciliation_required')).limit(limit).select('f.*')).map(plain);
    let n = 0;
    for (const r of [...rows, ...unfulfilled]) {
      try { await onPaid(r); n += 1; } catch (err) { console.warn('[events] refund re-apply failed:', r.id, err?.message); }
    }
    return n;
  }

  /** Rows for GET /admin/refunds and GET /me/refunds: event, order reference, scope, batch, policy, payer phone, organisation. */
  async function enrich(rows) {
    const events = rows.filter(r => r.kind === 'event_order');
    if (!events.length) return new Map();
    const eventRows = new Map((await db('Event').whereIn('id', [...new Set(events.map(r => r.eventId).filter(Boolean))]).select('id', 'title')).map(e => [e.id, e]));
    const orders = new Map((await db('EventOrder').whereIn('id', [...new Set(events.map(r => r.eventOrderId).filter(Boolean))]).select('id', 'reference', 'organizationId')).map(o => [o.id, o]));
    const orgIds = [...new Set([...orders.values()].map(o => o.organizationId).filter(Boolean))];
    const orgs = new Map(orgIds.length ? (await db('B2BOrganization').whereIn('id', orgIds).select('id', 'tradingName', 'legalName')).map(o => [o.id, o.tradingName || o.legalName]) : []);
    const payers = new Map();
    const payIds = events.map(r => r.eventPaymentId).filter(Boolean);
    if (payIds.length) {
      for (const p of await db('EventPayment as p').leftJoin('PaymentRequest as q', 'q.id', 'p.paymentRequestId').whereIn('p.id', payIds).select('p.id', 'q.payerPhone')) payers.set(p.id, p.payerPhone);
    }
    const out = new Map();
    for (const r of events) {
      const o = orders.get(r.eventOrderId);
      out.set(r.id, {
        event: eventRows.has(r.eventId) ? { id: r.eventId, title: eventRows.get(r.eventId).title } : null, orderReference: o?.reference ?? null,
        scope: r.scope ?? null, batchId: r.batchId ?? null, policySnapshot: typeof r.policySnapshot === 'string' ? JSON.parse(r.policySnapshot) : r.policySnapshot ?? null,
        payerPhone: payers.get(r.eventPaymentId) ?? null, organizationName: o?.organizationId ? orgs.get(o.organizationId) ?? null : null,
      });
    }
    return out;
  }

  // ── Admin: unfulfilled payment refund ──────────────────────────────────────

  /** POST /admin/refunds { eventPaymentId, amountTzs?, reasonCode: 'payment_error', note }: money in, the place is not possible. */
  async function adminRaiseForPayment({ body = {}, actorId, secondApprover = false }) {
    const payment = plain(await db('EventPayment').where({ id: body.eventPaymentId }).first());
    if (!payment) return fail('payment_not_found', 404);
    const request = payment.paymentRequestId ? plain(await db('PaymentRequest').where({ id: payment.paymentRequestId }).first()) : null;
    if (!request || request.status !== 'approved') return fail('payment_not_confirmed', 409);
    const order = plain(await db('EventOrder').where({ id: payment.orderId }).first());
    if (order.status === 'confirmed') return fail('payment_not_unfulfilled', 409);
    if (body.reasonCode && body.reasonCode !== 'payment_error') return fail('invalid_reason', 400, { allowed: ['payment_error'] });
    const amount = body.amountTzs == null ? Number(payment.amountTzs) : Math.round(Number(body.amountTzs));
    if (!Number.isFinite(amount) || amount <= 0) return fail('nothing_to_refund', 409);
    if (amount > Number(payment.amountTzs)) return fail('amount_exceeds_payment', 400);
    const memberId = order.purchaserUserId ?? order.createdByUserId;
    const event = plain(await db('Event').where({ id: order.eventId }).first());
    const id = newRefundId();
    const at = now();
    let refund;
    try {
      refund = await db.transaction(async (trx) => {
        const row = await insertRefund(trx, {
          id, memberId, kind: 'event_order', scope: 'unfulfilled_payment', eventId: order.eventId, eventOrderId: order.id, organizerId: event.organizerId, organizationId: order.organizationId ?? null,
          eventPaymentId: payment.id, amountTzs: amount, currency: payment.currency, reasonCode: 'payment_error', note: isStr(body.note) ? body.note.trim().slice(0, 500) : null,
          status: secondApprover ? 'requested' : 'approved', requestedBy: actorId, requestedRole: 'admin', decidedBy: secondApprover ? null : 'policy', decidedAt: secondApprover ? null : at,
          policySnapshot: { reason: 'admin_raised' }, createdAt: at, updatedAt: at,
        });
        await trx('EventPayment').where({ id: payment.id }).whereIn('status', ['pending', 'reconciliation_required', 'succeeded', 'failed']).update({ refundId: id, updatedAt: at });
        return row;
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      throw err;
    }
    await audit(actorId, 'refund_raised', id, null, { id, kind: 'event_order', scope: 'unfulfilled_payment' });
    await tellRefund(refund, event, refund.status === 'approved' ? 'approved' : 'requested_by_fitflex');
    return { refund };
  }

  // ── Event cancellation: the refund batch (scenario 10) ─────────────────────

  async function eventCancelPreview({ eventId }) {
    const event = plain(await db('Event').where({ id: eventId }).first());
    if (!event) return fail('event_not_found', 404);
    const awaiting = (await db('EventOrder').where({ eventId, status: 'awaiting_payment' }).select('id')).map(o => o.id);
    const withSubmitted = awaiting.length ? await db('EventPayment').whereIn('orderId', awaiting).where({ status: 'pending' }).countDistinct({ n: 'orderId' }) : [{ n: 0 }];
    const live = await db('EventRegistration as r').join('EventOrder as o', 'o.id', 'r.orderId').where('r.eventId', eventId).where('r.status', 'confirmed')
      .select(db.raw('count(distinct r."orderId")::int as orders'), db.raw('count(*)::int as places'), db.raw('coalesce(sum(r."paidAmountTzs"), 0)::int as total'));
    const refunds = (await db('Refund').where({ kind: 'event_order', eventId }).whereNot({ scope: 'unfulfilled_payment' }).whereIn('status', ['requested', 'approved', 'paid']).select('status', 'amountTzs')).map(plain);
    const total = Number(live[0].total);
    return {
      awaitingOrders: awaiting.length, awaitingWithSubmittedPayment: Number(withSubmitted[0].n), paidOrders: Number(live[0].orders), paidPlaces: Number(live[0].places), totalPaidTzs: total,
      alreadyRefundedTzs: refunds.filter(r => r.status === 'paid').reduce((a, r) => a + Number(r.amountTzs), 0), refundableTzs: total, openRefunds: refunds.filter(r => r.status !== 'paid').length,
    };
  }

  async function batchIdFor(eventId) {
    const existing = await db('Refund').where({ kind: 'event_order', eventId, scope: 'event_cancelled' }).whereNotNull('batchId').orderBy('createdAt').first('batchId');
    return existing?.batchId ?? `evb_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  /**
   * Run (or resume) the refund batch of a cancelled event: awaiting orders released, every live paid place cancelled with its
   * tickets revoked, one `event_cancelled` refund per order (full amount paid, fee included), orders refund_pending. Chunks of
   * 200 orders; the per-order unique live index makes a second run create nothing new.
   */
  async function runEventBatch({ eventId, actorId, note = null, expectedRefundableTzs = null }) {
    const event = plain(await db('Event').where({ id: eventId }).first());
    if (!event) return fail('event_not_found', 404);
    if (event.status !== 'cancelled') return fail('event_not_cancelled', 409, { eventStatus: event.status });
    if (expectedRefundableTzs != null) {
      const p = await eventCancelPreview({ eventId });
      if (Number(expectedRefundableTzs) !== p.refundableTzs) return fail('refundable_changed', 409, { refundableTzs: p.refundableTzs });
    }
    const batchId = await batchIdFor(eventId);
    let created = 0; let existing = 0; let amountTzs = 0; let released = 0;
    // 1. unpaid orders go back on the shelf (a pending manual payment stays for staff).
    const awaiting = await db('EventOrder').where({ eventId, status: 'awaiting_payment' }).orderBy('id').limit(CHUNK).select('id', 'purchaserUserId', 'createdByUserId');
    for (const o of awaiting) {
      const r = await eventStore.releaseOrder(o.id, 'admin', { cancelReason: 'event_cancelled' });
      if (!r.error && r.changed) {
        released += 1;
        await notice(o.purchaserUserId ?? o.createdByUserId, {
          id: `ntf_evcr_${o.id}`, type: 'event_cancelled_refund',
          en: { title: `${event.title} has been cancelled`, body: 'Your reserved places were released. You have not been charged.' },
          sw: { title: `${event.title} imeghairiwa`, body: 'Tiketi ulizoshikilia zimeachiliwa. Hujakatwa pesa.' },
          data: { orderId: o.id, eventId, route: `/member/events/orders/${o.id}` },
        });
      }
    }
    // 2. paid orders: one transaction each.
    const paidOrders = await db('EventRegistration').where({ eventId, status: 'confirmed' }).distinct('orderId').orderBy('orderId').limit(CHUNK).pluck('orderId');
    for (const orderId of paidOrders) {
      const out = await cancelEventOrder({ orderId, event, batchId, actorId, note });
      if (out.error) { console.warn('[events] event-cancel refund failed for order:', orderId, out.error); continue; }
      // Places with nothing paid (free tickets) are cancelled without a refund row; an order with nothing live is not counted.
      if (out.skipped || out.noRefund) continue;
      if (out.created) created += 1; else existing += 1;
      amountTzs += out.amountTzs;
    }
    const remaining = Number((await db('EventRegistration').where({ eventId, status: 'confirmed' }).countDistinct({ n: 'orderId' }))[0].n)
      + Number((await db('EventOrder').where({ eventId, status: 'awaiting_payment' }).count({ n: '*' }))[0].n);
    if (created || existing || released) await audit(actorId, 'events.refund_batch_created', eventId, null, { batchId, created, existing, released, amountTzs });
    return { batchId, created, existing, remaining, amountTzs, released, touched: Boolean(created || existing || released) };
  }

  async function cancelEventOrder({ orderId, event, batchId, actorId, note }) {
    let result;
    try {
      result = await db.transaction(async (trx) => {
        const order = plain(await trx('EventOrder').where({ id: orderId }).forUpdate().first());
        const regs = (await trx('EventRegistration').where({ orderId }).orderBy('id').forUpdate()).map(plain);
        const live = regs.filter(r => r.status === 'confirmed');
        if (!live.length) return { created: false, amountTzs: 0, order, regs, skipped: true };
        const covered = live.filter(r => r.refundId);
        if (covered.length) return { created: false, amountTzs: 0, order, regs };
        const total = live.reduce((a, r) => a + Number(r.paidAmountTzs ?? 0), 0);
        const at = now();
        const memberId = order.purchaserUserId ?? order.createdByUserId;
        const refundId = total > 0 ? newRefundId() : null;
        const done = await money.cancelPaidPlaces(trx, { order, registrations: live, cancelReason: 'event_cancelled', revokeReason: 'event_cancelled', releaseInventory: false, refundId, actorId });
        let refund = null;
        if (refundId) {
          refund = await insertRefund(trx, {
            id: refundId, memberId, kind: 'event_order', scope: 'event_cancelled', eventId: order.eventId, eventOrderId: order.id, organizerId: event.organizerId, organizationId: order.organizationId ?? null,
            eventPaymentId: (await trx('EventPayment').where({ orderId, status: 'succeeded' }).first('id'))?.id ?? null, amountTzs: total, currency: order.currency, reasonCode: 'cancelled_by_fitflex',
            note: note ?? null, status: 'requested', requestedBy: actorId, requestedRole: 'admin', batchId, policySnapshot: { preset: 'event_cancelled', percent: 100, evaluatedAt: at.toISOString() }, createdAt: at, updatedAt: at,
          });
        }
        const derived = await money.deriveAndSetOrderStatus(trx, orderId);
        return { created: Boolean(refund), amountTzs: total, order: derived?.order ?? order, regs, refund, cancelled: done.cancelled, noRefund: !refund };
      });
    } catch (err) {
      if (err.refusal) {
        // Another path already covers a place (a member's own cancellation raced): the unique index held; leave it for the next run.
        return err.refusal;
      }
      throw err;
    }
    if (result.refund) {
      // One notice for the purchaser (#8): the cancellation and the refund promise together, not two pushes.
      await notice(result.refund.memberId, {
        id: `ntf_evcl_${orderId}`, type: 'event_cancelled_refund',
        en: { title: `${event.title} has been cancelled`, body: `FitFlex will refund what you paid for this event (${formatTsh(result.refund.amountTzs)}). We'll tell you when it is sent.` },
        sw: { title: `${event.title} imeghairiwa`, body: `FitFlex itarejesha ulicholipa kwa tukio hili (${formatTsh(result.refund.amountTzs)}). Tutakuarifu itakapotumwa.` },
        data: { orderId, eventId: event.id, refundId: result.refund.id, route: `/member/events/orders/${orderId}` },
      });
    }
    for (const reg of result.cancelled ?? []) await notifyCancelledParticipant(reg, event, result.order);
    return result;
  }

  /** KIT-010: claimed participants hear in the app; unclaimed places with a contact get one bounded SMS or email (counts audited). */
  async function notifyCancelledParticipant(reg, event, order) {
    if (reg.participantUserId && reg.participantUserId !== order.purchaserUserId) {
      await notice(reg.participantUserId, {
        id: `ntf_evcp_${reg.id}`, type: 'event_cancelled_refund',
        en: { title: `${event.title} has been cancelled`, body: `Your place in ${event.title} was cancelled.` },
        sw: { title: `${event.title} imeghairiwa`, body: `Tiketi yako ya ${event.title} imeghairiwa.` },
        data: { registrationId: reg.id, eventId: event.id, route: '/member/events/registrations' },
      });
      return;
    }
    if (reg.participantUserId) return;
    const text = {
      en: `${event.title} has been cancelled. The person who registered you will be refunded by FitFlex.`,
      sw: `${event.title} imeghairiwa. Aliyekusajili atarejeshewa pesa na FitFlex.`,
    };
    let sent = null;
    try {
      if (reg.phone && senders.sms().configured) sent = (await senders.sms().send(reg.phone, { text: `${text.sw}\n${text.en}` }))?.ok ? 'sms' : null;
      else if (reg.email && senders.email().configured) sent = (await senders.email().send(reg.email, { subject: `${event.title}`, text: `${text.sw}\n\n---\n\n${text.en}` }))?.ok ? 'email' : null;
    } catch { sent = null; }
    if (sent) await audit('system', 'events.cancellation_notified', reg.id, null, { channel: sent });
  }

  // ── Batch helpers ──────────────────────────────────────────────────────────

  async function batchDecision({ batchId, decision, expectedTotalTzs, expectedCount, actorId }) {
    if (decision !== 'approve') return fail('invalid_decision', 400, { allowed: ['approve'] });
    const rows = (await db('Refund').where({ kind: 'event_order', batchId, status: 'requested' }).orderBy('id')).map(plain);
    const total = rows.reduce((a, r) => a + Number(r.amountTzs), 0);
    if (expectedTotalTzs == null || expectedCount == null) return fail('expected_totals_required', 400);
    if (Number(expectedTotalTzs) !== total || Number(expectedCount) !== rows.length) return fail('batch_changed', 409, { totalTzs: total, count: rows.length });
    const refunds = getRefundService();
    const results = [];
    for (const r of rows) {
      const out = await refunds.decide({ id: r.id, body: { decision: 'approve' }, actorId });
      results.push(out.error ? { refundId: r.id, ok: false, error: out.error } : { refundId: r.id, ok: true });
    }
    const failed = results.filter(r => !r.ok);
    if (rows.length && failed.length === rows.length && failed.every(f => f.error === 'cannot_approve_own_request')) return fail('cannot_approve_own_request', 403, { results });
    return { approved: results.length - failed.length, failed: failed.length, results };
  }

  async function batchPaid({ batchId, items = [], actorId }) {
    if (!Array.isArray(items) || !items.length || items.length > CHUNK) return fail('invalid_items', 400, { max: CHUNK });
    const refunds = getRefundService();
    const results = [];
    for (const item of items) {
      const row = plain(await db('Refund').where({ id: item?.refundId, batchId, kind: 'event_order' }).first());
      if (!row) { results.push({ refundId: item?.refundId ?? null, ok: false, error: 'refund_not_found' }); continue; }
      const out = await refunds.markPaid({ id: row.id, body: { paymentReference: item.paymentReference, paidTo: item.paidTo }, actorId });
      results.push(out.error ? { refundId: row.id, ok: false, error: out.error } : { refundId: row.id, ok: true });
    }
    return { paid: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
  }

  return {
    previewRegistration, previewOrder, cancellable, cancelRegistration, cancelOrder, cancelOrderCorporate, adminCancelPaidOrder, cancelPendingPaymentOf,
    eventCancelPreview, runEventBatch, batchDecision, batchPaid, adminRaiseForPayment,
    onApproved, onPaid, onRejected, repairPaid, enrich, tellRefund,
    internals: { evaluatePlaces, canResell, maskPayerPhone, iso },
  };
}
