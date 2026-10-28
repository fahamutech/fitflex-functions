// Marathon & running events · S4 — payments, ticket issuance and the finance view (spec §3.4–§3.11, §3.14, §3.15).
//
//   mode()                          'none' | 'manual' | 'provider' — the one way an order can be paid right now (fail closed: no ticket secret → 'none')
//   initiate / initiateCorporate    POST /me/event-orders/:id/payment, POST /b2b/organizations/:id/event-orders/:orderId/payment
//   paymentStatus                   GET …/payment-status (cheap, safe to poll)
//   beforeEventOrderPayment         read-only checks run inside admin-payment-service.checkConfirmation
//   writeEventDecision              the decision TRANSACTION: PaymentRequest write + EventPayment + confirmPaidOrder (tickets,
//                                   outbox, audit) commit together; the outcome (confirmed | reheld | refund_raised) is returned
//   onEventOrderPayment             idempotent re-apply (repair) of an approved request whose order is not confirmed
//   repairOrder / sweep             POST …/repair-payment and the hourly eventPaymentReconciliation job
//   tickets                         list / read / rotate (token derived, never stored; static; hash only at rest)
//   resendClaim                     POST …/claim-invitations
//   organizerFinance / adminFinance totals only for organizers; never payer details
//
// Rules: amounts and currency come from the order row read under its lock, never from the client; one success per order
// is a database fact (eventpayment_one_succeeded_per_order); logs carry ids and codes only — never a reference, phone,
// token or provider payload (PAY-013). Every refusal is { error, status, ...extra } (D5), never thrown.
import { randomUUID } from 'node:crypto';
import { storeRefusal } from '../infra/event-store-pg.mjs';
import {
  canonicalFingerprint, IDEMPOTENCY_KEY_RE, localTimeIn, localHourMinuteIn,
} from '../shared/events-participants.mjs';
import { normalizePaymentReference, normalizePayerPhone, DUPLICATE_ATTEMPT_ACTION, DUPLICATE_ATTEMPT_LIMIT } from '../shared/manual-payment.mjs';
import { redactProviderPayload } from '../shared/events-payment-redact.mjs';
import { deriveToken, sha256hex, qrPayloadOf, displayCodeOf } from '../shared/events-ticket-token.mjs';
import { paginate } from '../shared/pagination.mjs';
import { swahiliTime } from '../shared/vendor-documents.mjs';
import { iso, maskPayerPhone, refundView, REJECT_CODES, MEMBER_NOTE_MAX, paymentStateOf } from '../shared/events-money-views.mjs';
import { formatTsh } from '../shared/money-display.mjs';
import {
  eventManualHoldExtendHours, eventManualHoldMaxHours, eventsOrgHoldMaxHours, eventsProviderHoldExtendMinutes, eventsRejectedRetryMinutes,
  eventsLatePaymentGraceHours, eventsManualConfirmSlaHours, eventTicketKeyRing,
} from '../shared/events-config.mjs';
import { ORG_BILLING_ROLES } from './events-roster-service.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const LIVE_PAYMENT = ['created', 'pending', 'reconciliation_required'];
const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const UNIQUE_VIOLATION = '23505';
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const json = value => (value === undefined || value === null || typeof value === 'string' ? value : JSON.stringify(value));
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const isStr = v => typeof v === 'string';
const pageOpts = query => ({ limit: Math.min(parseInt(query?.limit, 10) || 20, 50), cursor: query?.cursor });
/** A refusal thrown inside a transaction so it rolls back; the caller returns `err.refusal`. */
const refuse = (error, status, extra = {}) => storeRefusal(error, status, extra);

/** Outcomes of an event decision, handed from the decision transaction to the admin service (keyed by the updated request row). */
const outcomes = new WeakMap();
export const eventOutcomeOf = request => (request && typeof request === 'object' ? outcomes.get(request) ?? null : null);

export function createEventsPaymentService({
  db, eventStore, money, registration, users, references,
  manualPayment = { required: () => false, options: () => ({ enabled: false }) },
  flags = { manual: () => false, tunzaa: () => false },
  // The Tunzaa path is effective (flag, TUNZAA_PAYMENTS, client configured and allowed to settle). Read on every call.
  providerEffective = () => false,
  providerSettle = async () => ({ state: 'none' }),
  notify = async () => {}, localeOf = async () => null, track = async () => {},
  ops = null, now = () => new Date(), keyRing = eventTicketKeyRing,
  shareBase = () => process.env.FRIEND_INVITE_BASE_URL || process.env.APP_DOWNLOAD_LINK || 'https://fitflex-af-app.web.app',
}) {
  const nowIso = () => now().toISOString();
  const R = () => registration.internals;
  const intakeOn = () => Boolean(flags.manual() || flags.tunzaa());

  const audit = async (actor, action, target, before, after) => {
    try { await db('AuditLog').insert({ id: randomUUID(), at: now(), actor: actor || 'system', action, target, before: json(before ?? null), after: json(after ?? null) }); } catch { /* best effort */ }
  };
  /** Server-side analytics (§3.15): named, no personal data; an AuditLog row until a pipeline exists. */
  const analytics = async (name, payload) => {
    await audit('system', `analytics.${name}`, payload.eventId ?? payload.orderId ?? 'events', null, payload);
    try { await track(name, payload); } catch { /* best effort */ }
  };

  // ── Mode ────────────────────────────────────────────────────────────────────

  /**
   * The one way an order can be paid right now (§3.1). 'provider' only when the Tunzaa event flag is effective; else 'manual'
   * when EVENTS_PAYMENTS_MANUAL, MANUAL_PAY_INSTRUCTIONS and the Lipa Namba are all set; else 'none'. Always 'none' without a
   * usable EVENT_TICKET_SECRET: a payment that cannot produce tickets must not be taken.
   */
  function mode() {
    if (!keyRing()) return 'none';
    if (flags.tunzaa() && providerEffective()) return 'provider';
    if (flags.manual() && manualPayment.required()) return 'manual';
    return 'none';
  }

  /** The keys GET /events/options adds while EVENTS_REGISTRATION is on (§3.1). */
  function optionsBlock() {
    const payment = mode();
    return {
      payment,
      ...(payment === 'manual' ? { manualConfirmHours: eventsManualConfirmSlaHours() } : {}),
      hold: { manualExtendHours: eventManualHoldExtendHours(), manualMaxHours: eventManualHoldMaxHours(), providerExtendMinutes: eventsProviderHoldExtendMinutes(), lateGraceHours: eventsLatePaymentGraceHours() },
      tickets: { qr: true, scanning: false },
    };
  }

  // ── Views ───────────────────────────────────────────────────────────────────

  async function paymentView(payment, { request = null, order = null, mayRetry = null } = {}) {
    if (!payment) return null;
    const req = request ?? (payment.paymentRequestId ? plain(await db('PaymentRequest').where({ id: payment.paymentRequestId }).first()) : null);
    const state = paymentStateOf(payment);
    const manual = payment.method === 'manual' || payment.provider === 'manual';
    const o = order ?? plain(await db('EventOrder').where({ id: payment.orderId }).first());
    let canRetry = false;
    if (mayRetry !== null) canRetry = mayRetry;
    else if (o && o.status === 'awaiting_payment' && ['rejected', 'failed', 'expired'].includes(state) && mode() !== 'none') {
      canRetry = !o.holdExpiresAt || +new Date(o.holdExpiresAt) > +now();
    }
    const submittedAt = payment.submittedAt ?? (manual ? payment.createdAt : null);
    return {
      id: payment.id, state, method: payment.method ?? (payment.provider === 'tunzaa' ? 'provider' : payment.provider === 'free' ? 'free' : 'manual'),
      amountTzs: Number(payment.amountTzs), currency: payment.currency,
      reference: req?.memberReference ?? null, payerPhoneMasked: maskPayerPhone(req?.payerPhone),
      submittedAt: iso(submittedAt), decidedAt: ['succeeded', 'failed', 'cancelled'].includes(payment.status) ? iso(payment.verifiedAt ?? payment.updatedAt) : null,
      confirmTargetAt: state === 'submitted' && submittedAt ? new Date(+new Date(submittedAt) + eventsManualConfirmSlaHours() * HOUR).toISOString() : null,
      rejectCode: state === 'rejected' ? (payment.rejectCode ?? null) : null,
      memberNote: state === 'rejected' ? (payment.settledNote ?? null) : null,
      late: payment.lateOrder === true, canRetry, refundId: payment.refundId ?? null,
    };
  }

  const latestPayment = async orderId => plain(await db('EventPayment').where({ orderId }).orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }]).first());

  /** The org payment details (bank + Lipa Namba) maintained by admins; embedded because no organisation-readable route exists. */
  async function orgInstructions(order) {
    const row = await db('B2BPaymentInstruction').where({ id: 'default' }).first();
    const has = Boolean(row && (row.accountNumber || row.lipaNamba));
    if (!has) return { kind: 'organisation', configured: false };
    return {
      kind: 'organisation', configured: true, bankName: row.bankName ?? null, accountName: row.accountName ?? null, accountNumber: row.accountNumber ?? null, branch: row.branch ?? null,
      lipaNamba: row.lipaNamba ?? null, lipaNambaName: row.lipaNambaName ?? null, notes: row.notes ?? null, reference: order.reference, amountTzs: Number(order.totalTzs),
    };
  }

  /** `next` of an order response (§3.5): the way to pay it now, with the instructions the member pays first and submits after. */
  async function nextFor(order, { access = null, payment = undefined } = {}) {
    const live = payment === undefined ? await latestPayment(order.id) : payment;
    const paymentRequestId = live && LIVE_PAYMENT.includes(live.status) ? live.paymentRequestId ?? null : null;
    const awaiting = order.status === 'awaiting_payment' || (order.status === 'expired' && lateWindow(order));
    // Nothing to pay (or paying is off): exactly the S3 shape.
    if (!awaiting) return { payment: 'none', instructions: null };
    if (access) {
      if (!(intakeOn() && keyRing())) return { payment: 'none', instructions: null };
      return { payment: 'manual', paymentRequestId, instructions: await orgInstructions(order) };
    }
    const m = mode();
    if (m === 'none') return { payment: 'none', instructions: null };
    if (Number(order.totalTzs) === 0) return { payment: m, paymentRequestId, instructions: null };
    if (m === 'manual') {
      const o = manualPayment.options();
      return {
        payment: 'manual', paymentRequestId,
        instructions: o.enabled ? {
          lipaNamba: o.lipaNamba, accountName: o.accountName, network: o.network ?? null, instructions: o.instructions ?? null, amountTzs: Number(order.totalTzs),
          reference: order.reference, referenceRequired: o.referenceRequired, payerPhoneRequired: o.payerPhoneRequired,
        } : null,
      };
    }
    return { payment: 'provider', paymentRequestId, instructions: null };
  }

  const lateWindow = order => order.status === 'expired' && order.closeReason === 'expired' && order.closedAt
    && +now() - +new Date(order.closedAt) <= eventsLatePaymentGraceHours() * HOUR;

  /** Add the S4 keys to an S3 order detail (payment, next, refunds, per-place ticket, allowedActions). */
  async function decorateOrderDetail(detail, loaded, { viewerUserId = null, access = null, refundsService = null } = {}) {
    const order = loaded.order;
    const payment = await latestPayment(order.id);
    const refunds = (await db('Refund').where({ kind: 'event_order', eventOrderId: order.id }).orderBy('createdAt', 'desc')).map(plain);
    const tickets = await db('EventTicket').whereIn('registrationId', loaded.registrations.map(r => r.id)).orderBy('createdAt', 'desc');
    const ticketOf = new Map();
    for (const t of tickets) if (!ticketOf.has(t.registrationId) || t.status === 'active') ticketOf.set(t.registrationId, t);
    const next = await nextFor(order, { access, payment });
    const view = await paymentView(payment, { order });
    const regs = detail.registrations.map((r) => {
      const src = loaded.registrations.find(x => x.id === r.id);
      const t = ticketOf.get(r.id);
      // No token ever here; a place claimed by someone else is the masked view and carries no ticket for the purchaser (§3.8.5).
      const hidden = access || !src || r.masked === true;
      return {
        ...r,
        ticket: hidden ? null : t ? { state: t.status === 'active' ? 'active' : 'revoked', displayCode: t.displayCode ?? null } : { state: 'none', displayCode: null },
        invitation: invitationOf(src),
      };
    });
    const actions = [];
    const live = payment && LIVE_PAYMENT.includes(payment.status);
    if (order.status === 'awaiting_payment' && next.payment !== 'none' && !live && (!order.holdExpiresAt || +new Date(order.holdExpiresAt) > +now())) actions.push('pay');
    if (order.status === 'expired' && lateWindow(order) && next.payment !== 'none' && !live) actions.push('pay');
    const canCancelUnpaid = order.status === 'awaiting_payment' && !(payment && payment.status === 'pending');
    if (canCancelUnpaid && (!access || detail.allowedActions.includes('cancel'))) actions.push('cancel');
    if (['confirmed', 'partially_cancelled'].includes(order.status) && (!access || detail.allowedActions.includes('cancel_refund') || access.platformAdmin || ORG_BILLING_ROLES.includes(access.role))) {
      const open = loaded.registrations.some(r => r.status === 'confirmed' && !r.refundId);
      if (open && refundsService?.cancellable) { if (await refundsService.cancellable(loaded)) actions.push('cancel_refund'); } else if (open) actions.push('cancel_refund');
    }
    return { ...detail, registrations: regs, payment: view, next, refunds: refunds.map(refundView), allowedActions: actions };
  }

  const invitationOf = r => (r && !r.participantUserId && r.consentBasis !== 'self' && r.status === 'confirmed'
    ? { sentAt: iso(r.claimInvitedAt), count: Number(r.claimInviteCount ?? 0), hasContact: Boolean(r.phone || r.email) } : null);

  // ── Notifications (§3.16; bilingual with localeOf, ids so retries never duplicate) ──────────────

  async function notice(userId, { id, type, en, sw, data }) {
    if (!userId) return;
    try {
      let locale = null;
      try { locale = await localeOf(userId); } catch { locale = null; }
      const text = locale === 'sw' ? sw : en;
      await notify(userId, { id: id.slice(0, 60), type, title: text.title, body: text.body, data: { ...data, locale: locale === 'sw' ? 'sw' : 'en', titleEn: en.title, bodyEn: en.body, titleSw: sw.title, bodySw: sw.body } });
    } catch (err) { console.warn('[events] payment notification skipped:', type, err?.message); }
  }

  const timeTexts = (event, at) => {
    const en = localTimeIn(event.timezone, at);
    const hm = localHourMinuteIn(event.timezone, at);
    return { en, sw: hm ? swahiliTime(hm.h, hm.min) : en };
  };
  const route = {
    order: id => `/member/events/orders/${id}`,
    pay: id => `/member/events/orders/${id}/pay`,
    tickets: () => '/member/events/tickets',
    ticket: id => `/member/events/registrations/${id}/ticket`,
  };
  const REASON_TEXT = {
    reference_not_found: { en: "We couldn't find that transaction ID in our payment records.", sw: 'Hatukuipata namba hiyo ya muamala kwenye rekodi zetu za malipo.' },
    amount_mismatch: { en: 'The amount we received was different from the order total.', sw: 'Kiasi tulichopokea ni tofauti na jumla ya oda.' },
    wrong_account: { en: 'The payment went to a different account.', sw: 'Malipo yalitumwa kwenye akaunti nyingine.' },
    duplicate_reference: { en: 'That transaction ID was already used for another payment.', sw: 'Namba hiyo ya muamala imeshatumika kwa malipo mengine.' },
  };

  async function eventOf(eventId) { return plain(await db('Event').where({ id: eventId }).first()); }
  const recipientOf = order => order.purchaserUserId ?? order.createdByUserId ?? null;

  async function notifySubmitted(order, event, payment) {
    const t = timeTexts(event, order.holdExpiresAt);
    const hours = eventsManualConfirmSlaHours();
    await notice(recipientOf(order), {
      id: `ntf_evps_${payment.id}`, type: 'event_payment_submitted',
      en: { title: 'Payment received · being checked', body: `We have your transaction ID. FitFlex confirms payments within ${hours} hours. Your places for ${event.title} are held until ${t.en}.` },
      sw: { title: 'Malipo yamepokelewa · yanakaguliwa', body: `Tumepokea namba yako ya muamala. FitFlex huthibitisha malipo ndani ya saa ${hours}. Tiketi zako za ${event.title} zimeshikiliwa hadi ${t.sw}.` },
      data: { orderId: order.id, eventId: order.eventId, paymentId: payment.id, route: route.order(order.id) },
    });
  }

  async function notifyLateReceived(order, event, payment) {
    await notice(recipientOf(order), {
      id: `ntf_evpl_${payment.id}`, type: 'event_payment_late_received',
      en: { title: 'Payment received after your hold ended', body: `We'll try to re-reserve your places for ${event.title}; if they are gone we'll refund you in full.` },
      sw: { title: 'Malipo yamepokelewa baada ya muda kuisha', body: `Tutajaribu kukuwekea tiketi za ${event.title} tena; zikiwa zimeisha tutakurejeshea pesa zote.` },
      data: { orderId: order.id, eventId: order.eventId, paymentId: payment.id, route: route.order(order.id) },
    });
  }

  async function notifyRejected(order, event, payment) {
    const reason = REASON_TEXT[payment.rejectCode] ?? null;
    const canRetry = order.status === 'awaiting_payment' && order.holdExpiresAt && +new Date(order.holdExpiresAt) > +now();
    const t = order.holdExpiresAt ? timeTexts(event, order.holdExpiresAt) : { en: '', sw: '' };
    const note = payment.settledNote ? ` ${payment.settledNote}` : '';
    await notice(recipientOf(order), {
      id: `ntf_evpr_${payment.id}`, type: 'event_payment_rejected',
      en: { title: "We couldn't confirm your payment", body: `${(reason ?? { en: '' }).en}${note}${canRetry ? ` You can try again until ${t.en}.` : ''}`.trim() },
      sw: { title: 'Hatukuweza kuthibitisha malipo yako', body: `${(reason ?? { sw: '' }).sw}${note}${canRetry ? ` Unaweza kujaribu tena hadi ${t.sw}.` : ''}`.trim() },
      data: { orderId: order.id, eventId: order.eventId, paymentId: payment.id, route: canRetry ? route.pay(order.id) : route.order(order.id) },
    });
  }

  /** After the confirmation transaction committed: notices, claim invitations, analytics. Failures are logged by id and never undo. */
  async function afterDecision(result, { source = 'admin' } = {}) {
    if (!result) return;
    const order = result.order;
    const event = await eventOf(order.eventId);
    if (result.outcome === 'refund_raised') {
      const refund = plain(await db('Refund').where({ id: result.refundId }).first());
      await notice(recipientOf(order), {
        id: `ntf_evpf_${result.payment.id}`, type: 'event_payment_refund_due',
        en: { title: "Your places weren't available", body: `We received your payment of ${formatTsh(result.payment.amountTzs)} but could not keep your places for ${event?.title ?? 'the event'}. A full refund is being prepared.` },
        sw: { title: 'Tiketi hazikuwepo', body: `Tumepokea malipo yako ya ${formatTsh(result.payment.amountTzs)} lakini hatukuweza kuhifadhi tiketi zako za ${event?.title ?? 'tukio'}. Marejesho kamili yanaandaliwa.` },
        data: { orderId: order.id, eventId: order.eventId, refundId: result.refundId, route: route.order(order.id) },
      });
      if (ops) {
        try {
          await ops.raise({ type: 'events_payment_reconciliation', severity: 'high', title: 'An event payment arrived but the places could not be kept', dedupeKey: `evpay:${result.payment.id}`, entityType: 'EventPayment', entityId: result.payment.id, detail: { orderId: order.id, reason: result.reason, refundId: refund?.id ?? null } });
        } catch (err) { console.warn('[events] ops exception not raised:', result.payment.id, err?.message); }
      }
      await analytics('payment_failed', { orderId: order.id, eventId: order.eventId, method: result.payment.method ?? 'manual', code: result.reason });
      return;
    }
    if (!result.changed) return;
    const purchaser = recipientOf(order);
    const n = result.tickets.length;
    await notice(purchaser, {
      id: `ntf_evpc_${result.payment.id}`, type: 'event_payment_confirmed',
      en: { title: 'Payment confirmed · tickets ready', body: `${n} ticket${n === 1 ? '' : 's'} for ${event?.title ?? 'the event'} ${n === 1 ? 'is' : 'are'} ready.` },
      sw: { title: 'Malipo yamethibitishwa · tiketi ziko tayari', body: `Tiketi ${n} za ${event?.title ?? 'tukio'} ziko tayari.` },
      data: { orderId: order.id, eventId: order.eventId, route: order.purchaserUserId ? route.tickets() : route.order(order.id) },
    });
    for (const t of result.tickets) {
      if (!t.participantUserId || t.participantUserId === order.purchaserUserId) continue;
      await notice(t.participantUserId, {
        id: `ntf_evtr_${t.registrationId}`, type: 'event_ticket_ready',
        en: { title: 'Your ticket is ready', body: `Your ticket for ${event?.title ?? 'the event'} is ready.` },
        sw: { title: 'Tiketi yako iko tayari', body: `Tiketi yako ya ${event?.title ?? 'tukio'} iko tayari.` },
        data: { registrationId: t.registrationId, eventId: order.eventId, route: route.ticket(t.registrationId) },
      });
    }
    // D15: claim invitations go out only now that the order is confirmed; a send failure never undoes the confirmation.
    try {
      const sent = await registration.inviteClaims({ orderId: order.id });
      if (!sent.error) await audit('system', 'events.claim_invitations_sent', order.id, null, { invited: sent.invited, skipped: sent.skipped });
    } catch (err) { console.warn('[events] claim invitations skipped:', order.id, err?.message); }
    await analytics('payment_confirmed', { orderId: order.id, eventId: order.eventId, method: result.payment.method ?? 'manual', source, rehold: result.rehold === true });
    await analytics('ticket_issued', { eventId: order.eventId, count: n });
  }

  // ── Initiation ──────────────────────────────────────────────────────────────

  function readKey(key) {
    if (!isStr(key) || !key.trim() || !IDEMPOTENCY_KEY_RE.test(key.trim())) return fail('idempotency_key_required', 400, { rule: '8-100 chars [A-Za-z0-9._:-]' });
    return { key: key.trim() };
  }

  /** The earlier answer for this key on this order, before anything is validated. */
  async function replayFor(orderId, key, fingerprint, loaded, access) {
    const row = plain(await db('EventPayment').where({ idempotencyKey: `${orderId}:${key}` }).first());
    if (!row) return null;
    if (row.idempotencyFingerprint !== fingerprint) return fail('idempotency_key_reused', 409);
    const o = (await eventStore.getOrder(orderId))?.order ?? loaded.order;
    return {
      status: 200, payment: await paymentView(row, { order: o }), order: orderSummary(o),
      next: { payment: access ? 'manual' : (row.method === 'provider' ? 'provider' : row.method === 'free' ? 'none' : 'manual'), paymentRequestId: row.paymentRequestId ?? null, instructions: null },
      late: row.lateOrder === true, replayed: true,
    };
  }

  const orderSummary = o => ({ id: o.id, reference: o.reference, status: o.status, totalTzs: Number(o.totalTzs), currency: o.currency, holdExpiresAt: iso(o.holdExpiresAt) });

  /** Member route: the caller must be the order's purchaser (404 for anyone else, never 403). */
  async function initiate({ userId, orderId, body = {}, idempotencyKey }) {
    const k = readKey(idempotencyKey);
    if (k.error) return k;
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded || loaded.order.purchaserUserId !== userId) return fail('order_not_found', 404);
    return initiateFor({ loaded, actorId: userId, body, key: k.key, access: null });
  }

  /** Corporate route: billing roles of the order's organisation; Idempotency scoped (organisation, order, key). */
  async function initiateCorporate({ access, orderId, body = {}, idempotencyKey, actorId }) {
    if (!(access.platformAdmin || ORG_BILLING_ROLES.includes(access.role))) return fail('forbidden', 403, { requiredRole: [...ORG_BILLING_ROLES] });
    const k = readKey(idempotencyKey);
    if (k.error) return k;
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded || loaded.order.organizationId !== access.org.id || loaded.order.purchaserUserId) return fail('order_not_found', 404);
    if (access.org.status !== 'active') return fail('organization_not_active', 409, { organizationStatus: access.org.status });
    return initiateFor({ loaded, actorId, body, key: k.key, access });
  }

  const eatDay = d => new Date(+d + 3 * HOUR).toISOString().slice(0, 10);

  async function auditDuplicate(memberId, key) {
    await audit(memberId, DUPLICATE_ATTEMPT_ACTION, memberId, null, { referenceKey: key, product: 'EVENT_ORDER' });
  }

  async function initiateFor({ loaded, actorId, body, key, access }) {
    if (!intakeOn()) return fail('feature_disabled', 404);
    if (!keyRing()) return fail('tickets_unavailable', 503);
    const order0 = loaded.order;
    const free = Number(order0.totalTzs) === 0;
    const m = access ? 'manual' : mode();
    if (!free && m === 'none') return fail('payment_mode_mismatch', 409, { mode: 'none' });
    if (!access && !free && m === 'manual' && body.reference == null && body.payerPhone == null) return fail('payment_mode_mismatch', 409, { mode: m });
    if (!access && !free && m === 'provider' && (body.reference != null || body.payerPhone != null)) return fail('payment_mode_mismatch', 409, { mode: m });

    // Manual fields: the same validators as passes (one transaction ID confirms one payment across every product).
    let fields = {};
    let paidOn = null; let payerMethod = null; let orgNote = null;
    if (!free && (m === 'manual' || access)) {
      const ref = normalizePaymentReference(body.reference);
      if (ref.error) return fail(ref.error, 400);
      fields = { memberReference: ref.reference, memberReferenceKey: ref.key };
      if (access) {
        if (!['bank_transfer', 'mobile_money'].includes(body.method)) return fail('invalid_method', 400, { allowed: ['bank_transfer', 'mobile_money'] });
        payerMethod = body.method;
        if (!isStr(body.paidOn) || !/^\d{4}-\d{2}-\d{2}$/.test(body.paidOn) || Number.isNaN(+new Date(`${body.paidOn}T00:00:00Z`))) return fail('invalid_paid_on', 400);
        if (body.paidOn > eatDay(now())) return fail('invalid_paid_on', 400, { reason: 'future' });
        paidOn = body.paidOn;
        orgNote = isStr(body.note) && body.note.trim() ? body.note.trim().slice(0, 300) : null;
        if (isStr(body.note) && body.note.trim().length > 300) return fail('note_too_long', 400, { max: 300 });
      } else {
        const phone = normalizePayerPhone(body.payerPhone);
        if (phone.error) return fail(phone.error, 400);
        fields.payerPhone = phone.phone;
      }
    }
    const fingerprint = canonicalFingerprint({ orderId: order0.id, reference: fields.memberReference ?? null, payerPhone: fields.payerPhone ?? null, method: payerMethod, paidOn, note: orgNote, free });
    const earlier = await replayFor(order0.id, key, fingerprint, loaded, access);
    if (earlier) return earlier;

    const buyerId = access ? order0.createdByUserId : order0.purchaserUserId;
    // A corporate payment is recorded against the coordinator who placed the order (PaymentRequest.memberId is a User).
    if (!buyerId) return fail('order_not_payable', 409, { status: order0.status, reason: 'coordinator_missing' });
    if (fields.memberReferenceKey) {
      const since = new Date(+now() - DUPLICATE_ATTEMPT_LIMIT.windowMs);
      if (await references.duplicateAttemptsSince(buyerId, since) >= DUPLICATE_ATTEMPT_LIMIT.max) return fail('too_many_attempts', 429);
      if ((await references.holders(fields.memberReferenceKey)).length) {
        await auditDuplicate(buyerId, fields.memberReferenceKey);
        return fail('payment_reference_duplicate', 409);
      }
    }

    const paymentId = newId('evp');
    let confirmed = null;
    let created;
    try {
      created = await db.transaction(async (trx) => {
        const at = now();
        const order = plain(await trx('EventOrder').where({ id: order0.id }).forUpdate().first());
        let late = false;
        if (order.status === 'awaiting_payment') { /* normal */ }
        else if (order.status === 'expired' && order.closeReason === 'expired' && order.closedAt && +at - +new Date(order.closedAt) <= eventsLatePaymentGraceHours() * HOUR && !free) late = true;
        else if (order.status === 'expired' && order.closeReason === 'expired') throw refuse('hold_expired', 409);
        else throw refuse('order_not_payable', 409, { status: order.status });
        const event = plain(await trx('Event').where({ id: order.eventId }).first());
        if (!event || !['published', 'registration_closed'].includes(event.status) || +new Date(event.startsAt) <= +at) throw refuse('event_not_open', 409, { eventStatus: event?.status ?? null });
        if (order.currency !== 'TZS') throw refuse('unsupported_currency', 409);
        // A late payment is a manual one: the provider prompt is not offered once the hold has ended.
        if (late && m === 'provider' && !access) throw refuse('hold_expired', 409);
        const live = plain(await trx('EventPayment').where({ orderId: order.id }).whereIn('status', LIVE_PAYMENT).first());
        if (live) throw refuse('payment_in_progress', 409, { payment: await paymentView(live, { order }) });

        const method = free ? 'free' : (m === 'provider' && !access) ? 'provider' : 'manual';
        const organizerId = event.organizerId;
        const base = {
          id: paymentId, orderId: order.id, eventId: order.eventId, organizerId, provider: free ? 'free' : method === 'provider' ? 'tunzaa' : 'manual', method,
          merchantReference: paymentId, amountTzs: Number(order.totalTzs), currency: order.currency, idempotencyKey: `${order.id}:${key}`, idempotencyFingerprint: fingerprint,
          lateOrder: late, organizationId: access ? access.org.id : null, payerMethod, paidOn, createdAt: at, updatedAt: at,
        };
        if (free) {
          await trx('EventPayment').insert({ ...base, status: 'created' });
          confirmed = await money.confirmPaidOrder(trx, { orderId: order.id, eventPaymentId: paymentId, source: 'free', actorId: buyerId });
          return { order: confirmed.order, late: false, free: true };
        }
        const requestId = `pay_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        await trx('PaymentRequest').insert({
          id: requestId, memberId: buyerId, amountTzs: Number(order.totalTzs), currency: 'TZS', status: 'pending', provider: 'admin_approved',
          memberReference: fields.memberReference ?? null, memberReferenceKey: fields.memberReferenceKey ?? null, payerPhone: fields.payerPhone ?? null,
          requestedAt: at, note: `event_order:${order.reference}${orgNote ? ` · ${orgNote}` : ''}`, eventOrderId: order.id,
        });
        await trx('EventPayment').insert({ ...base, paymentRequestId: requestId, status: method === 'manual' ? 'pending' : 'created', submittedAt: method === 'manual' ? at : null });
        let latest = order;
        if (method === 'manual' && !late) {
          latest = await money.extendHold(trx, order, {
            mode: 'manual', manualExtendMs: eventManualHoldExtendHours() * HOUR, providerExtendMs: eventsProviderHoldExtendMinutes() * MINUTE,
            maxHoursMs: (access ? eventsOrgHoldMaxHours() : eventManualHoldMaxHours()) * HOUR,
          });
        }
        await trx('AuditLog').insert({ id: randomUUID(), at, actor: buyerId, action: 'events.payment_submitted', target: order.id, before: null, after: JSON.stringify({ paymentId, method, late, orderId: order.id }) });
        return { order: latest, late, free: false };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      if (err.code === UNIQUE_VIOLATION) {
        const c = String(err.constraint || '');
        if (/member_reference_key/.test(c)) { await auditDuplicate(buyerId, fields.memberReferenceKey); return fail('payment_reference_duplicate', 409); }
        if (/idempotencykey/.test(c)) { const again = await replayFor(order0.id, key, fingerprint, loaded, access); if (again) return again; }
        if (/one_live_per_order/.test(c)) return fail('payment_in_progress', 409);
      }
      throw err;
    }

    const payment = plain(await db('EventPayment').where({ id: paymentId }).first());
    const event = await eventOf(created.order.eventId);
    if (created.free) {
      await afterDecision(confirmed, { source: 'free' });
    } else if (payment.method === 'manual') {
      if (created.late) await notifyLateReceived(created.order, event, payment);
      else await notifySubmitted(created.order, event, payment);
    }
    await analytics('payment_initiated', { orderId: created.order.id, eventId: created.order.eventId, method: payment.method, late: created.late });
    const fresh = plain(await db('EventOrder').where({ id: created.order.id }).first());
    return {
      status: 201, payment: await paymentView(payment, { order: fresh }), order: orderSummary(fresh),
      next: { payment: created.free ? 'none' : (access ? 'manual' : m), paymentRequestId: payment.paymentRequestId ?? null, instructions: null },
      late: created.late, replayed: false,
    };
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  async function paymentStatus({ orderId, userId = null, access = null }) {
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded) return fail('order_not_found', 404);
    const o = loaded.order;
    if (access ? (o.organizationId !== access.org.id || o.purchaserUserId) : o.purchaserUserId !== userId) return fail('order_not_found', 404);
    if (access && !(access.platformAdmin || ORG_BILLING_ROLES.includes(access.role))) return fail('forbidden', 403, { requiredRole: [...ORG_BILLING_ROLES] });
    const payment = await latestPayment(orderId);
    let refund = null;
    if (payment?.refundId) refund = plain(await db('Refund').where({ id: payment.refundId }).first());
    if (!refund) refund = plain(await db('Refund').where({ kind: 'event_order', eventOrderId: orderId }).orderBy('createdAt', 'desc').first());
    return {
      order: { id: o.id, status: o.status, holdExpiresAt: iso(o.holdExpiresAt), totalTzs: Number(o.totalTzs), currency: o.currency },
      payment: await paymentView(payment, { order: o }), refund: refundView(refund),
    };
  }

  // ── Admin confirmation hooks (admin-payment-service) ───────────────────────

  /** Read-only checks before an event payment is confirmed (§3.7.3). null or { error, status, … }. */
  async function beforeEventOrderPayment(request, { amountTzs = null } = {}) {
    const order = plain(await db('EventOrder').where({ id: request.eventOrderId }).first());
    if (!order) return { error: 'order_not_found', status: 409 };
    const buyer = order.purchaserUserId ?? order.createdByUserId;
    if (request.memberId !== buyer) return { error: 'order_buyer_mismatch', status: 409 };
    if ((request.currency || 'TZS') !== 'TZS') return { error: 'currency_mismatch', status: 409 };
    if (Number(request.amountTzs) !== Number(order.totalTzs)) return { error: 'order_amount_mismatch', status: 409, expectedTzs: Number(order.totalTzs) };
    const payment = plain(await db('EventPayment').where({ paymentRequestId: request.id }).first());
    if (!payment || !['pending', 'reconciliation_required', 'failed', 'created'].includes(payment.status)
      || Number(payment.amountTzs) !== Number(order.totalTzs) || Number(payment.amountTzs) !== Number(request.amountTzs) || payment.currency !== order.currency) {
      return { error: 'payment_row_mismatch', status: 409 };
    }
    if (payment.status === 'failed' && payment.method !== 'manual') return { error: 'payment_row_mismatch', status: 409 };
    if (payment.status === 'failed') {
      const other = await db('EventPayment').where({ orderId: order.id }).whereIn('status', LIVE_PAYMENT).whereNot({ id: payment.id }).first('id');
      if (other) return { error: 'payment_in_progress', status: 409 };
    }
    // The amount actually received is mandatory for event payments: a person reads the statement.
    if (amountTzs == null || amountTzs === '') return { error: 'amount_required', status: 400 };
    if (Number(amountTzs) !== Number(request.amountTzs)) return { error: 'amount_mismatch', status: 409, expectedTzs: Number(request.amountTzs) };
    return null;
  }

  /** Reject input for event requests: a closed reason code and an optional member note (§3.7.5). null or a refusal. */
  function checkRejectInput({ reasonCode, memberNote }) {
    if (!REJECT_CODES.includes(reasonCode)) return fail('reason_code_required', 400, { allowed: [...REJECT_CODES] });
    const note = isStr(memberNote) ? memberNote.trim() : '';
    if (reasonCode === 'other' && !note) return fail('note_required', 400);
    if (note.length > MEMBER_NOTE_MAX) return fail('note_too_long', 400, { max: MEMBER_NOTE_MAX });
    return null;
  }

  /**
   * The decision transaction (§3.7, §3.8): the PaymentRequest write and everything that follows from it commit together.
   * Returns the updated request row (its outcome is in eventOutcomeOf(row)), null (lost the compare-and-set),
   * 'reference_already_used', or a refusal { error, status }.
   *   patch  the fields admin-payment-service wants written; guard  the compare-and-set values besides status;
   *   meta   { actorId, automated, reasonCode, memberNote, amountTzs, providerPayload }
   */
  async function writeEventDecision(request, patch, guard = {}, meta = {}) {
    const status = patch.status;
    let result = null;
    let rejection = null;
    let updated;
    try {
      updated = await db.transaction(async (trx) => {
        let q = trx('PaymentRequest').where({ id: request.id, status: request.status });
        for (const [column, expected] of Object.entries(guard || {})) {
          q = expected === null ? q.whereNull(column) : Array.isArray(expected) ? q.whereIn(column, expected) : q.where(column, expected);
        }
        const [row] = await q.update(patch).returning('*');
        if (!row) return null;
        const upd = plain(row);
        // A note-only edit (status unchanged) touches the request and nothing else.
        if (status === request.status) return upd;
        // Lock order first, payment second: the order every other path takes (a repair running at the same time cannot deadlock with a decision).
        const ref = await trx('EventPayment').where({ paymentRequestId: request.id }).first('id', 'orderId');
        if (!ref) throw refuse('payment_row_mismatch', 409);
        await trx('EventOrder').where({ id: ref.orderId }).forUpdate().first('id');
        const payment = plain(await trx('EventPayment').where({ id: ref.id }).forUpdate().first());
        const at = now();
        if (status === 'approved') {
          const revived = payment.status === 'failed';
          result = await money.confirmPaidOrder(trx, {
            orderId: payment.orderId, eventPaymentId: payment.id, source: meta.automated ? 'provider' : 'admin', actorId: meta.actorId ?? null, allowFailed: revived,
            rawRedacted: meta.providerPayload ? redactProviderPayload('tunzaa', meta.providerPayload) : undefined, expectedAmountTzs: request.amountTzs,
          });
        } else if (status === 'rejected') {
          if (!['pending', 'created'].includes(payment.status)) throw refuse('event_payment_change_not_allowed', 409, { paymentStatus: payment.status });
          const code = meta.reasonCode;
          const [saved] = await trx('EventPayment').where({ id: payment.id }).update({
            status: 'failed', rejectCode: code, failureReason: `rejected:${code}`, settledNote: isStr(meta.memberNote) && meta.memberNote.trim() ? meta.memberNote.trim().slice(0, MEMBER_NOTE_MAX) : null, updatedAt: at,
          }).returning('*');
          const order = plain(await trx('EventOrder').where({ id: payment.orderId }).forUpdate().first());
          const reset = await money.resetHoldAfterRejection(trx, order, { retryMs: eventsRejectedRetryMinutes() * MINUTE, maxHoursMs: (order.organizationId ? eventsOrgHoldMaxHours() : eventManualHoldMaxHours()) * HOUR });
          rejection = { payment: plain(saved), order: reset };
          await trx('AuditLog').insert({ id: randomUUID(), at, actor: meta.actorId ?? 'system', action: 'events.payment_rejected', target: payment.orderId, before: null, after: JSON.stringify({ paymentId: payment.id, code }) });
        } else if (status === 'cancelled') {
          if (!['pending', 'created'].includes(payment.status)) throw refuse('event_payment_change_not_allowed', 409, { paymentStatus: payment.status });
          await trx('EventPayment').where({ id: payment.id }).update({ status: 'cancelled', updatedAt: at });
        } else {
          throw refuse('event_payment_change_not_allowed', 409, { paymentStatus: payment.status });
        }
        return upd;
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      if (err.code === UNIQUE_VIOLATION) return /eventpayment/.test(String(err.constraint || '')) ? null : 'reference_already_used';
      throw err;
    }
    if (!updated) return null;
    if (result) {
      outcomes.set(updated, outcomeOf(result));
      await afterDecision(result, { source: meta.automated ? 'provider' : 'admin' });
    }
    if (rejection) {
      const event = await eventOf(rejection.order.eventId);
      await notifyRejected(rejection.order, event, rejection.payment);
      await analytics('payment_failed', { orderId: rejection.order.id, eventId: rejection.order.eventId, method: rejection.payment.method ?? 'manual', code: rejection.payment.rejectCode });
    }
    return updated;
  }

  const outcomeOf = result => ({
    outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}), ...(result.refundId ? { refundId: result.refundId } : {}),
    orderId: result.order.id, ticketsIssued: result.tickets?.length ?? 0, changed: result.changed,
  });

  /** The admin list's event projection, one query per kind for all rows (§3.7.1). Map<requestId, projection>. */
  async function projectRequests(requests) {
    const rows = requests.filter(r => r.eventOrderId);
    const out = new Map();
    if (!rows.length) return out;
    const orders = new Map((await db('EventOrder').whereIn('id', [...new Set(rows.map(r => r.eventOrderId))])).map(o => [o.id, plain(o)]));
    const events = new Map((await db('Event').whereIn('id', [...new Set([...orders.values()].map(o => o.eventId))]).select('id', 'title', 'status', 'startsAt')).map(e => [e.id, plain(e)]));
    const places = new Map((await db('EventRegistration').whereIn('orderId', [...orders.keys()]).groupBy('orderId').select('orderId').count({ n: '*' })).map(r => [r.orderId, Number(r.n)]));
    const orgs = new Map();
    const orgIds = [...new Set([...orders.values()].map(o => o.organizationId).filter(Boolean))];
    if (orgIds.length) for (const o of await db('B2BOrganization').whereIn('id', orgIds).select('id', 'tradingName', 'legalName')) orgs.set(o.id, o.tradingName || o.legalName);
    const payments = new Map((await db('EventPayment').whereIn('paymentRequestId', rows.map(r => r.id))).map(p => [p.paymentRequestId, plain(p)]));
    for (const r of rows) {
      const o = orders.get(r.eventOrderId);
      if (!o) continue;
      const e = events.get(o.eventId);
      const p = payments.get(r.id);
      out.set(r.id, {
        orderId: o.id, reference: o.reference, status: o.status, eventId: o.eventId, eventTitle: e?.title ?? null, eventStatus: e?.status ?? null, placesCount: places.get(o.id) ?? 0,
        holdExpiresAt: iso(o.holdExpiresAt), totalTzs: Number(o.totalTzs), expectedTzs: Number(o.totalTzs), organizationName: o.organizationId ? orgs.get(o.organizationId) ?? null : null,
        paymentStatus: p?.status ?? null, failureReason: p?.failureReason ?? null, refundId: p?.refundId ?? null,
        lateOutcome: await lateOutcomeOf(o, e, r, p),
        repairable: r.status === 'approved' && Boolean(p) && !(p.status === 'succeeded' && o.status !== 'awaiting_payment') && !(p.status === 'reconciliation_required' && p.refundId),
      });
    }
    return out;
  }

  /** A non-locking preview for the approve dialog only; the decision re-checks under lock. */
  async function lateOutcomeOf(order, event, request, payment) {
    if (request.status !== 'pending' || !payment) return 'none';
    const eventGone = !event || !['published', 'registration_closed'].includes(event.status) || +new Date(event.startsAt) <= +now();
    if (order.status === 'expired') {
      if (eventGone) return 'would_refund';
      const lines = await db('EventOrderLine').where({ orderId: order.id });
      for (const l of lines) {
        const t = await db('EventTicketType').where({ id: l.ticketTypeId }).first('capacity', 'sold', 'held');
        if (!t || Number(t.capacity) - Number(t.sold) - Number(t.held) < l.quantity) return 'would_refund';
      }
      return 'would_rehold';
    }
    if (order.status === 'awaiting_payment' && eventGone) return 'would_refund';
    if (['cancelled', 'refunded', 'refund_pending', 'partially_cancelled'].includes(order.status)) return 'would_refund';
    return 'none';
  }

  /** GET /me pendingPayments: the event and order a request is for (no amounts, no staff data). Map<requestId, { eventTitle, eventOrderReference }>. */
  async function paymentLabels(requests) {
    const rows = requests.filter(r => r.eventOrderId);
    const out = new Map();
    if (!rows.length) return out;
    const orders = new Map((await db('EventOrder as o').join('Event as e', 'e.id', 'o.eventId').whereIn('o.id', [...new Set(rows.map(r => r.eventOrderId))]).select('o.id', 'o.reference', 'e.title')).map(o => [o.id, o]));
    for (const r of rows) {
      const o = orders.get(r.eventOrderId);
      if (o) out.set(r.id, { eventTitle: o.title, eventOrderReference: o.reference });
    }
    return out;
  }

  /** Event requests for the Payments page filter (?productType=EVENT_ORDER), newest first, bounded. */
  async function listRequests({ limit = 500, status = null } = {}) {
    let q = db('PaymentRequest').whereNotNull('eventOrderId');
    if (status) q = q.where({ status });
    return (await q.orderBy('requestedAt', 'desc').limit(Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000))).map(plain);
  }

  // ── Repair, sweep, provider hooks ──────────────────────────────────────────

  /** Re-apply an approved request whose order is not confirmed. Idempotent; never confirms an unapproved payment. */
  async function repairOrder({ orderId, actorId = null, eventId = null }) {
    const order = plain(await db('EventOrder').where({ id: orderId }).first());
    if (!order || (eventId && order.eventId !== eventId)) return fail('order_not_found', 404);
    const request = plain(await db('PaymentRequest').where({ eventOrderId: orderId, status: 'approved' }).orderBy('decidedAt', 'desc').first());
    if (!request) return fail('nothing_to_repair', 409);
    const payment = plain(await db('EventPayment').where({ paymentRequestId: request.id }).first());
    if (!payment) return fail('payment_row_mismatch', 409);
    if (payment.status === 'succeeded' && order.status !== 'awaiting_payment') return { repaired: false, outcome: payment.status === 'succeeded' ? 'confirmed' : null };
    if (payment.status === 'reconciliation_required' && payment.refundId) return { repaired: false, outcome: 'refund_raised', refundId: payment.refundId };
    let result;
    try {
      result = await db.transaction(async trx => money.confirmPaidOrder(trx, {
        orderId, eventPaymentId: payment.id, source: 'repair', actorId, allowFailed: payment.method === 'manual', expectedAmountTzs: request.amountTzs,
      }));
    } catch (err) {
      if (err.refusal) return err.refusal;
      throw err;
    }
    await audit(actorId, 'events.order_repaired', orderId, { orderStatus: order.status, paymentStatus: payment.status }, { outcome: result.outcome });
    await afterDecision(result, { source: 'repair' });
    return { repaired: result.changed, ...outcomeOf(result) };
  }

  /** admin-payment-service's applyPaymentStatusToSubscription branch: idempotent; the decision transaction already did the work. */
  async function onEventOrderPayment(request, status) {
    if (status !== 'approved') return;
    const payment = plain(await db('EventPayment').where({ paymentRequestId: request.id }).first('status', 'orderId', 'refundId'));
    if (!payment || payment.status === 'succeeded' || (payment.status === 'reconciliation_required' && payment.refundId)) return;
    await repairOrder({ orderId: payment.orderId, actorId: null });
  }

  const hooks = {
    /** mobile-money-service: is this event request payable by prompt right now? null or a refusal. */
    async beforePrompt(request) {
      const order = plain(await db('EventOrder').where({ id: request.eventOrderId }).first());
      if (!order) return { error: 'order_not_found', status: 409 };
      const payment = plain(await db('EventPayment').where({ paymentRequestId: request.id }).first());
      if (!payment || payment.method !== 'provider' || !['created', 'pending'].includes(payment.status)) return { error: 'payment_row_mismatch', status: 409 };
      if (order.status !== 'awaiting_payment' || !order.holdExpiresAt || +new Date(order.holdExpiresAt) <= +now()) return { error: 'hold_expired', status: 409 };
      const event = await eventOf(order.eventId);
      if (!event || !['published', 'registration_closed'].includes(event.status) || +new Date(event.startsAt) <= +now()) return { error: 'event_not_open', status: 409 };
      if (Number(request.amountTzs) !== Number(order.totalTzs) || Number(payment.amountTzs) !== Number(order.totalTzs) || (request.currency || 'TZS') !== 'TZS') return { error: 'order_amount_mismatch', status: 409, expectedTzs: Number(order.totalTzs) };
      return null;
    },
    /** A prompt is on the phone: EventPayment created → pending, the provider transaction recorded, the hold extended. */
    async afterPrompt(request, transactionId) {
      await db.transaction(async (trx) => {
        const payment = plain(await trx('EventPayment').where({ paymentRequestId: request.id }).forUpdate().first());
        if (!payment) return;
        const at = now();
        await trx('EventPayment').where({ id: payment.id, status: 'created' }).update({ status: 'pending', providerTransactionId: String(transactionId), submittedAt: at, updatedAt: at });
        if (payment.status !== 'created') await trx('EventPayment').where({ id: payment.id }).update({ providerTransactionId: String(transactionId), updatedAt: at });
        const order = plain(await trx('EventOrder').where({ id: payment.orderId }).forUpdate().first());
        if (order.status === 'awaiting_payment') {
          await money.extendHold(trx, order, { mode: 'provider', manualExtendMs: eventManualHoldExtendHours() * HOUR, providerExtendMs: eventsProviderHoldExtendMinutes() * MINUTE, maxHoursMs: eventManualHoldMaxHours() * HOUR });
        }
      });
    },
    /** Money confirmed but not accepted (amount / transaction mismatch, ticket secret missing): hold for people, no ticket, no commit. */
    async onHeld(request, reason, detail = {}) {
      const payment = plain(await db('EventPayment').where({ paymentRequestId: request.id }).first());
      if (!payment) return;
      const code = ['amount_mismatch', 'transaction_mismatch'].includes(reason) ? reason : (reason === 'tickets_unavailable' ? 'provider_unknown' : reason);
      if (payment.status === 'pending' || payment.status === 'created') {
        await db('EventPayment').where({ id: payment.id }).whereIn('status', ['pending', 'created']).update({ status: 'reconciliation_required', failureReason: code, updatedAt: now() });
      }
      await audit('tunzaa', 'events.payment_reconciliation_required', payment.orderId, null, { paymentId: payment.id, reason: code });
      if (ops) {
        try { await ops.raise({ type: 'events_payment_reconciliation', severity: 'high', title: 'An event mobile-money payment needs a person', dedupeKey: `evpay:${payment.id}`, entityType: 'EventPayment', entityId: payment.id, detail: { orderId: payment.orderId, reason: code, ...detail } }); } catch { /* best effort */ }
      }
    },
    /** The provider answered FAILED: the attempt is over (EventPayment failed, the request cancelled); the hold keeps running and the member can retry. */
    async onFailed(request, remark = null) {
      await db.transaction(async (trx) => {
        await trx('PaymentRequest').where({ id: request.id, status: 'pending' }).update({ status: 'cancelled', decidedAt: now(), decidedBy: 'tunzaa', note: 'event_order: provider reported failed' });
        await trx('EventPayment').where({ paymentRequestId: request.id }).whereIn('status', ['created', 'pending']).update({ status: 'failed', failureReason: 'provider_failed', updatedAt: now() });
      });
      void remark;
    },
  };

  /**
   * The hourly job (§3.11.7, §3.7.8, §3.10): repair approved-but-unconfirmed requests; settle provider prompts whose callback
   * was lost and expire stale ones; retry unsent claim invitations once; re-apply paid refunds whose places were not updated.
   * Bounded per run; safe to run twice and on two servers (confirmPaidOrder and every step are idempotent).
   */
  async function sweep({ limit = 100, refunds = null } = {}) {
    const stats = { repaired: 0, settled: 0, expired: 0, invited: 0, refundsApplied: 0, failed: 0 };
    const at = now();
    // (a) approved requests whose payment is not succeeded
    const stuck = await db('PaymentRequest as r').join('EventPayment as p', 'p.paymentRequestId', 'r.id').where('r.status', 'approved')
      .whereNot('p.status', 'succeeded').whereNot(b => b.where('p.status', 'reconciliation_required').whereNotNull('p.refundId')).limit(limit).select('p.orderId', 'r.id as requestId');
    for (const row of stuck) {
      const out = await repairOrder({ orderId: row.orderId });
      if (out.error) {
        stats.failed += 1;
        if (ops) { try { await ops.raise({ type: 'events_order_unconfirmed', severity: 'high', title: 'An approved event payment has not confirmed its order', dedupeKey: `evord:${row.orderId}`, entityType: 'EventOrder', entityId: row.orderId, detail: { error: out.error } }); } catch { /* best effort */ } }
      } else if (out.repaired) {
        stats.repaired += 1;
        if (ops) { try { await ops.clear(`evord:${row.orderId}`); } catch { /* best effort */ } }
      }
    }
    // (b) provider prompts: pending > 5 minutes, or unknown after a timeout
    const prompts = await db('EventPayment').where({ provider: 'tunzaa' }).where(b => b.where(c => c.where('status', 'pending').where('updatedAt', '<', new Date(+at - 5 * MINUTE)))
      .orWhere(c => c.where('status', 'reconciliation_required').where({ failureReason: 'provider_unknown' }))).whereNotNull('paymentRequestId').orderBy('updatedAt').limit(limit);
    for (const p of prompts) {
      try {
        const out = await providerSettle(p.paymentRequestId);
        if (out?.state === 'completed') stats.settled += 1;
        else if (out?.state !== 'held' && +at - +new Date(p.submittedAt ?? p.createdAt) > 30 * MINUTE) {
          await db.transaction(async (trx) => {
            await trx('PaymentRequest').where({ id: p.paymentRequestId, status: 'pending' }).update({ status: 'cancelled', decidedAt: at, decidedBy: 'tunzaa', note: 'event_order: prompt not completed in time' });
            await trx('EventPayment').where({ id: p.id }).whereIn('status', ['created', 'pending']).update({ status: 'expired', failureReason: 'prompt_expired', updatedAt: at });
          });
          stats.expired += 1;
        }
      } catch (err) { stats.failed += 1; console.warn('[events] provider settle failed:', p.id, err?.message); }
    }
    // (c) claim invitations never sent, once, an hour after confirmation
    const orders = await db('EventOrder as o').where('o.status', 'confirmed').where('o.confirmedAt', '<', new Date(+at - HOUR)).where('o.confirmedAt', '>', new Date(+at - 14 * DAY))
      .whereExists(db('EventRegistration as r').whereRaw('r."orderId" = o.id').where('r.status', 'confirmed').whereNull('r.claimInvitedAt').whereNull('r.participantUserId').whereNot('r.consentBasis', 'self').where(b => b.whereNotNull('r.phone').orWhereNotNull('r.email')))
      .whereNotExists(db('AuditLog as a').whereRaw('a.target = o.id').where('a.action', 'events.claim_invitation_retry')).limit(limit).select('o.id');
    for (const o of orders) {
      await audit('system', 'events.claim_invitation_retry', o.id, null, {});
      try { const sent = await registration.inviteClaims({ orderId: o.id }); if (!sent.error) stats.invited += sent.invited; } catch { stats.failed += 1; }
    }
    // (d) paid refunds whose places were not updated (a crash between the two writes)
    if (refunds) stats.refundsApplied = await refunds.repairPaid({ limit });
    return stats;
  }

  // ── Tickets ─────────────────────────────────────────────────────────────────

  const relationOf = (r, me) => (r.participantUserId === me ? (r.purchaserUserId === me ? 'self' : 'claimed') : 'purchased');

  /** Who may see a ticket (§3.8.5): the participant, or the purchaser while the place is unclaimed or their own. */
  function mayViewTicket(reg, userId) {
    if (reg.participantUserId === userId) return true;
    return reg.purchaserUserId === userId && !reg.participantUserId;
  }

  async function ticketRows(registrationId) {
    return (await db('EventTicket').where({ registrationId }).orderBy([{ column: 'issuedAt', order: 'desc' }, { column: 'id', order: 'desc' }])).map(plain);
  }

  async function listTickets({ userId, query = {} }) {
    const regs = (await db('EventRegistration').where(b => b.where({ participantUserId: userId }).orWhere(c => c.where({ purchaserUserId: userId }).whereNull('participantUserId'))).whereIn('status', ['confirmed', 'cancelled', 'refunded']).orderBy('createdAt', 'desc').limit(500)).map(plain);
    const visible = regs.filter(r => mayViewTicket(r, userId));
    if (!visible.length) return { items: [], nextCursor: null };
    const tickets = await db('EventTicket').whereIn('registrationId', visible.map(r => r.id));
    const byReg = new Map();
    for (const t of tickets.map(plain)) if (!byReg.has(t.registrationId) || t.status === 'active') byReg.set(t.registrationId, t);
    const orders = new Map((await db('EventOrder').whereIn('id', [...new Set(visible.map(r => r.orderId))]).select('id', 'reference')).map(o => [o.id, o.reference]));
    const cache = new Map();
    const joinedOf = async id => { if (!cache.has(id)) cache.set(id, await R().joinedOf(id)); return cache.get(id); };
    const items = [];
    for (const r of visible) {
      const t = byReg.get(r.id);
      if (!t) continue;
      const j = await joinedOf(r.eventId);
      const names = R().namesOf(j);
      const c = names.categories.get(r.categoryId);
      const tt = names.tickets.get(r.ticketTypeId);
      items.push({
        registrationId: r.id, ticketId: t.id, displayCode: t.displayCode ?? null, state: t.status === 'active' ? 'active' : 'revoked',
        event: R().summaryOf(j), category: c ? { name: c.name, distanceM: Number(c.distanceMeters), startsAt: iso(c.startTime) } : null, ticketType: tt ? { name: tt.name } : null,
        participant: { firstName: r.firstName, lastName: r.lastName }, relation: relationOf(r, userId), orderReference: orders.get(r.orderId) ?? null, issuedAt: iso(t.issuedAt),
        kit: { state: r.kitStatus === 'exception' ? 'not_ready' : r.kitStatus },
      });
    }
    // Soonest event first; revoked after; past last.
    const nowMs = +now();
    const rank = i => (i.state === 'revoked' ? 1 : +new Date(i.event?.startsAt ?? 0) < nowMs ? 2 : 0);
    items.sort((a, b) => rank(a) - rank(b) || String(a.event?.startsAt ?? '').localeCompare(String(b.event?.startsAt ?? '')) || a.registrationId.localeCompare(b.registrationId));
    const page = paginate(items, pageOpts(query));
    return { items: page.items, nextCursor: page.nextCursor === null ? null : String(page.nextCursor) };
  }

  async function ticketBody(reg, ticket, userId) {
    const ring = keyRing();
    if (!ring) return fail('tickets_unavailable', 503);
    const token = deriveToken(ring, { ticketId: ticket.id, tokenVersion: ticket.tokenVersion, registrationId: reg.id, eventId: reg.eventId, keyId: ticket.tokenKeyId ?? ring.keyId });
    // Integrity: the derived token must hash to what is stored; never return a token that does not.
    if (!token || sha256hex(token) !== ticket.tokenHash) {
      await audit('system', 'events.ticket_integrity_failed', ticket.id, null, { registrationId: reg.id });
      return fail('ticket_integrity_failed', 500);
    }
    const j = await R().joinedOf(reg.eventId);
    const names = R().namesOf(j);
    const c = names.categories.get(reg.categoryId);
    return {
      ticket: { id: ticket.id, displayCode: ticket.displayCode ?? displayCodeOf(ticket.id, reg.id), state: 'active', issuedAt: iso(ticket.issuedAt), rotatedAt: iso(ticket.rotatedAt) },
      token, qrPayload: qrPayloadOf(token), event: R().summaryOf(j),
      category: c ? { id: c.id, name: c.name, distanceM: Number(c.distanceMeters), startsAt: iso(c.startTime) } : null,
      participant: { firstName: reg.firstName, lastName: reg.lastName }, relation: relationOf(reg, userId), scanning: false,
      kit: { state: reg.kitStatus === 'exception' ? 'not_ready' : reg.kitStatus },
    };
  }

  async function ticketContext(userId, registrationId) {
    const reg = plain(await db('EventRegistration').where({ id: registrationId }).first());
    if (!reg || !mayViewTicket(reg, userId)) return fail('registration_not_found', 404);
    const tickets = await ticketRows(registrationId);
    const active = tickets.find(t => t.status === 'active');
    if (!active) {
      const revoked = tickets.find(t => t.status === 'revoked');
      if (revoked) return fail('ticket_revoked', 409, { reason: revoked.revokeReason ?? 'cancelled' });
      return fail('ticket_not_issued', 409);
    }
    return { reg, ticket: active };
  }

  async function getTicket({ userId, registrationId }) {
    const ctx = await ticketContext(userId, registrationId);
    if (ctx.error) return ctx;
    return ticketBody(ctx.reg, ctx.ticket, userId);
  }

  /** New code: tokenVersion + 1, new hash; the old token matches no hash any more. */
  async function rotateTicket({ userId, registrationId, by = 'holder' }) {
    const ctx = await ticketContext(userId, registrationId);
    if (ctx.error) return ctx;
    const ring = keyRing();
    if (!ring) return fail('tickets_unavailable', 503);
    const rotated = await rotateRow(ctx.reg, ctx.ticket, ring, by, userId);
    if (!rotated) return fail('ticket_revoked', 409, { reason: 'cancelled' });
    return ticketBody(ctx.reg, rotated, userId);
  }

  async function rotateRow(reg, ticket, ring, by, actor) {
    const at = now();
    const version = Number(ticket.tokenVersion) + 1;
    const token = deriveToken(ring, { ticketId: ticket.id, tokenVersion: version, registrationId: reg.id, eventId: reg.eventId });
    const [saved] = await db('EventTicket').where({ id: ticket.id, status: 'active', tokenVersion: ticket.tokenVersion })
      .update({ tokenVersion: version, tokenHash: sha256hex(token), tokenKeyId: ring.keyId, rotatedAt: at, updatedAt: at }).returning('*');
    if (!saved) return null;
    await audit(actor, 'events.ticket_rotated', ticket.id, { tokenVersion: ticket.tokenVersion }, { tokenVersion: version, by });
    return plain(saved);
  }

  /** A place was claimed by someone other than the purchaser: its code changes at that moment, so screenshots the purchaser holds die. */
  async function onClaimed(registration_) {
    try {
      const ring = keyRing();
      if (!ring) return;
      const reg = plain(await db('EventRegistration').where({ id: registration_.id }).first());
      if (!reg) return;
      const active = (await ticketRows(reg.id)).find(t => t.status === 'active');
      if (active) await rotateRow(reg, active, ring, 'claim', reg.participantUserId);
    } catch (err) { console.warn('[events] ticket rotation on claim failed:', registration_?.id, err?.message); }
  }

  /** The per-registration ticket summary for the registration detail page. */
  async function ticketSummary(registrationId) {
    const t = (await ticketRows(registrationId))[0];
    return t ? { state: t.status === 'active' ? 'active' : 'revoked', displayCode: t.displayCode ?? null } : null;
  }

  // ── Claim invitations: resend ──────────────────────────────────────────────

  async function resendClaim({ userId = null, access = null, orderId, registrationId }) {
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded) return fail('order_not_found', 404);
    const o = loaded.order;
    if (access ? (o.organizationId !== access.org.id || o.purchaserUserId) : o.purchaserUserId !== userId) return fail('order_not_found', 404);
    if (access && !(access.platformAdmin || ORG_BILLING_ROLES.includes(access.role))) return fail('forbidden', 403, { requiredRole: [...ORG_BILLING_ROLES] });
    if (o.status !== 'confirmed' && o.status !== 'partially_cancelled') return fail('order_not_confirmed', 409, { orderStatus: o.status });
    const reg = loaded.registrations.find(r => r.id === registrationId);
    if (!reg) return fail('registration_not_found', 404);
    if (reg.participantUserId || reg.consentBasis === 'self' || reg.status !== 'confirmed' || (!reg.phone && !reg.email)) return fail('not_resendable', 409);
    if (Number(reg.claimInviteCount) >= 5) return fail('resend_limit_reached', 409);
    const since = new Date(+now() - DAY);
    const [{ n }] = await db('AuditLog').where({ action: 'events.claim_invitation_resent', target: registrationId }).where('at', '>=', since).count({ n: '*' });
    if (Number(n) >= 3) return fail('resend_limit_reached', 409, { nextAllowedAt: new Date(+now() + DAY).toISOString() });
    const r = await registration.inviteClaims({ orderId, registrationIds: [registrationId] });
    if (r.error) return r;
    await audit(userId ?? 'organisation', 'events.claim_invitation_resent', registrationId, null, { orderId });
    const sent = r.results?.find(x => x.registrationId === registrationId);
    return { sent: Boolean(sent?.sent), channel: sent?.channel ?? null, nextAllowedAt: new Date(+now() + 60_000).toISOString(), invalidatesPreviousLink: Boolean(sent?.sent) };
  }

  // ── Finance (§3.14) ────────────────────────────────────────────────────────

  /** Round half up, whole shillings. */
  const commissionOf = (keptTzs, pct) => Math.floor((keptTzs * pct + 50) / 100);

  async function financeFor(eventId, { admin = false } = {}) {
    const event = plain(await db('Event').where({ id: eventId }).first());
    if (!event) return fail('event_not_found', 404);
    const orders = (await db('EventOrder').where({ eventId }).select('id', 'status', 'totalTzs', 'commissionPctSnapshot', 'refundedTzs')).map(plain);
    const paidRows = await db('EventPayment as p').join('EventOrder as o', 'o.id', 'p.orderId').where('o.eventId', eventId).where('p.status', 'succeeded').groupBy('o.id').select('o.id').sum({ paid: 'p.amountTzs' });
    const paidByOrder = new Map(paidRows.map(r => [r.id, Number(r.paid)]));
    const refunds = (await db('Refund').where({ kind: 'event_order', eventId }).select('eventOrderId', 'scope', 'status', 'amountTzs')).map(plain);
    let refunded = 0; let pending = 0; let unfulfilled = 0;
    const heldByOrder = new Map();
    for (const r of refunds) {
      if (r.scope === 'unfulfilled_payment') { if (r.status !== 'rejected') unfulfilled += Number(r.amountTzs); continue; }
      if (r.status === 'paid') refunded += Number(r.amountTzs);
      if (['requested', 'approved'].includes(r.status)) pending += Number(r.amountTzs);
      if (r.status !== 'rejected') heldByOrder.set(r.eventOrderId, (heldByOrder.get(r.eventOrderId) ?? 0) + Number(r.amountTzs));
    }
    let paidTzs = 0; let commissionTzs = 0; let awaiting = 0; let paidOrders = 0; let refundedOrders = 0; let partly = 0;
    for (const o of orders) {
      const paid = paidByOrder.get(o.id) ?? 0;
      if (o.status === 'awaiting_payment') awaiting += Number(o.totalTzs);
      if (!paid) continue;
      // An unfulfilled order's money was never the organizer's sale.
      if (['cancelled', 'expired'].includes(o.status) && !o.commissionPctSnapshot && !(heldByOrder.get(o.id))) { /* counted below only when confirmed once */ }
      const confirmedOnce = ['confirmed', 'partially_cancelled', 'refund_pending', 'refunded'].includes(o.status) || heldByOrder.has(o.id);
      if (!confirmedOnce) continue;
      paidTzs += paid; paidOrders += 1;
      if (o.status === 'refunded') refundedOrders += 1;
      else if (Number(o.refundedTzs) > 0) partly += 1;
      const kept = Math.max(paid - (heldByOrder.get(o.id) ?? 0), 0);
      commissionTzs += commissionOf(kept, Number(o.commissionPctSnapshot ?? 0));
    }
    const organizer = await db('EventOrganizer').where({ id: event.organizerId }).first('commissionPct');
    const types = (await db('EventTicketType as t').where('t.eventId', eventId).orderBy('t.id').select('t.id', 't.name', 't.sold')).map(plain);
    const gross = new Map((await db('EventRegistration').where({ eventId }).whereNotNull('paidAt').groupBy('ticketTypeId').select('ticketTypeId').sum({ gross: 'paidAmountTzs' })).map(r => [r.ticketTypeId, Number(r.gross)]));
    const out = {
      eventId, currency: 'TZS', asOf: nowIso(), paidTzs, refundedTzs: refunded, refundPendingTzs: pending, awaitingPaymentTzs: awaiting,
      commissionPct: organizer?.commissionPct ?? null, commissionTzs, expectedNetTzs: paidTzs - refunded - pending - commissionTzs,
      orders: { paid: paidOrders, refunded: refundedOrders, partlyRefunded: partly },
      byTicketType: types.map(t => ({ ticketTypeId: t.id, name: t.name, sold: Number(t.sold), grossTzs: gross.get(t.id) ?? 0 })),
      settlement: { state: 'not_started' },
    };
    if (admin) {
      const [{ n: open }] = await db('EventPayment').where({ eventId, status: 'reconciliation_required' }).count({ n: '*' });
      return { ...out, unfulfilledTzs: unfulfilled, openReconciliations: Number(open) };
    }
    return out;
  }

  async function organizerFinance({ ctx, eventId }) {
    const event = plain(await db('Event').where({ id: eventId, organizerId: ctx.organizer.id }).first('id'));
    if (!event) return fail('event_not_found', 404);
    return financeFor(eventId);
  }

  const adminFinance = ({ eventId }) => financeFor(eventId, { admin: true });

  /** The admin order panel's payment block (full phone only with the payments scope). */
  async function adminOrderPanel(orderId, { withPayments = false } = {}) {
    const payments = (await db('EventPayment').where({ orderId }).orderBy('createdAt')).map(plain);
    const out = [];
    for (const p of payments) {
      const req = p.paymentRequestId ? plain(await db('PaymentRequest').where({ id: p.paymentRequestId }).first()) : null;
      out.push({
        id: p.id, status: p.status, method: p.method, provider: p.provider, amountTzs: Number(p.amountTzs), currency: p.currency, late: p.lateOrder === true, failureReason: p.failureReason ?? null,
        rejectCode: p.rejectCode ?? null, submittedAt: iso(p.submittedAt), verifiedAt: iso(p.verifiedAt), refundId: p.refundId ?? null, paymentRequestId: p.paymentRequestId ?? null,
        reference: req?.memberReference ?? null, payerPhone: withPayments ? (req?.payerPhone ?? null) : maskPayerPhone(req?.payerPhone), requestStatus: req?.status ?? null,
        organizationId: p.organizationId ?? null, payerMethod: p.payerMethod ?? null, paidOn: p.paidOn ? String(p.paidOn).slice(0, 10) : null,
      });
    }
    const tickets = await db('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.orderId', orderId).select('t.id', 't.status', 'r.id as registrationId');
    const refunds = (await db('Refund').where({ kind: 'event_order', eventOrderId: orderId }).orderBy('createdAt')).map(plain);
    return {
      payments: out,
      tickets: { issued: tickets.filter(t => t.status === 'active').length, cancelled: tickets.filter(t => t.status === 'revoked').length, rows: tickets.map(t => ({ registrationId: t.registrationId, state: t.status === 'active' ? 'active' : 'revoked' })) },
      refunds: refunds.map(r => ({ ...refundView(r), batchId: r.batchId ?? null, kind: 'event_order' })),
    };
  }

  return {
    mode, optionsBlock, nextFor, decorateOrderDetail, paymentView,
    initiate, initiateCorporate, paymentStatus,
    beforeEventOrderPayment, checkRejectInput, writeEventDecision, projectRequests, paymentLabels, listRequests, onEventOrderPayment, repairOrder, sweep, hooks,
    listTickets, getTicket, rotateTicket, onClaimed, ticketSummary, mayViewTicket, resendClaim,
    organizerFinance, adminFinance, adminOrderPanel,
    internals: { afterDecision, notice, latestPayment, lateWindow, timeTexts, route },
  };
}
