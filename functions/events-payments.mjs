// Marathon & running events · S4 — member payments, tickets, cancel previews and the claim resend (spec §3.4–§3.12).
// Payment INTAKE (initiate) needs EVENTS_MODULE + EVENTS_REGISTRATION + EVENTS_PAYMENTS_MANUAL or EVENTS_PAYMENTS_TUNZAA;
// reads, tickets, previews and cancellation need only EVENTS_MODULE + EVENTS_REGISTRATION, so switching intake off later never
// strands a member who already paid or blocks money going back. Every route is wrapped in routeGuard (bfast mounts guards
// method-blind). Rate limits (§3.15) are in memory per server: the unique indexes, not the limiters, protect money.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { requireEventsRegistration, requireEventsPaymentIntake } from '../src/shared/feature-flags.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { eventsPaymentsService as payments, eventsRefundsService as refunds } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const limiters = {
  initiateUser: createVendorLimiter({ perMinute: 10, windowMs: HOUR }),
  initiateOrder: createVendorLimiter({ perMinute: 20, windowMs: HOUR }),
  status: createVendorLimiter({ perMinute: 240, windowMs: HOUR }),   // per ORDER: a 30-second poll is 120 an hour, two screens 240
  ticketRead: createVendorLimiter({ perMinute: 60, windowMs: HOUR }),
  ticketRotate: createVendorLimiter({ perMinute: 5, windowMs: DAY }),
  preview: createVendorLimiter({ perMinute: 60, windowMs: HOUR }),
  resend: createVendorLimiter({ perMinute: 3, windowMs: DAY }),
};
/** For specs: clear every window. */
export const resetEventsPaymentLimits = () => Object.values(limiters).forEach(l => l.reset());

const headerOf = (req, name) => req.headers?.[name] ?? req.headers?.[name.toLowerCase()] ?? (typeof req.get === 'function' ? req.get(name) : undefined) ?? null;

function send(res, result, okStatus = 200) {
  if (result?.error) {
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  if (Number.isInteger(result?.status)) { const { status, ...body } = result; return res.status(status).json(body); }
  res.status(okStatus).json(result);
}
/** Tokens never get cached by an intermediary or the browser (§3.8.3). */
const noStore = res => res.set?.('Cache-Control', 'no-store');

const member = method => routeGuard(method, [requireEventsRegistration, requireAuth('member')]);
const intake = method => routeGuard(method, [requireEventsPaymentIntake, requireAuth('member')]);

// ── Payment ───────────────────────────────────────────────────────────────

export const payForEventOrder = {
  created, method: 'post', path: '/me/event-orders/:id/payment',
  description: 'Member (purchaser only; anyone else 404 order_not_found; EVENTS_PAYMENTS_MANUAL or EVENTS_PAYMENTS_TUNZAA on, else 404 feature_disabled): start paying an awaiting order. Header Idempotency-Key REQUIRED (8–100 chars [A-Za-z0-9._:-]; same key + same body → 200 { …, replayed: true }, same key + other body → 409 idempotency_key_reused). The client never sends an amount, currency or provider (ignored if sent): they come from the order. Body by mode (GET /events/options.payment): manual { reference (the transaction ID), payerPhone } · provider {} (then POST /me/payments/:paymentRequestId/mobile-money). → 201 { payment (PaymentView), order { id, reference, status, totalTzs, currency, holdExpiresAt }, next { payment, paymentRequestId, instructions: null }, late, replayed }. A manual submission extends the hold (24 h, capped 48 h from the order). A free order (total 0) confirms at once (next.payment "none"). 400 idempotency_key_required | payment_reference_required | payment_reference_invalid | payer_phone_required | payer_phone_invalid; 409 payment_mode_mismatch { mode } | order_not_payable { status } | hold_expired | event_not_open | unsupported_currency | payment_in_progress { payment } | payment_reference_duplicate | idempotency_key_reused; 429 too_many_attempts | rate_limited (10/h per user, 20/h per order); 503 tickets_unavailable (EVENT_TICKET_SECRET missing).',
  onGuard: intake('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.initiateUser, `u:${req.user.sub}`, res)) return undefined;
    if (limitOrNull(limiters.initiateOrder, `o:${req.params.id}`, res)) return undefined;
    return send(res, await payments.initiate({ userId: req.user.sub, orderId: req.params.id, body: req.body || {}, idempotencyKey: headerOf(req, 'Idempotency-Key') }), 201);
  },
};

export const eventOrderPaymentStatus = {
  created, method: 'get', path: '/me/event-orders/:id/payment-status',
  description: 'Member (purchaser only): where the payment of one order stands, cheap enough to poll every 30 s (240/h per order) → { order { id, status, holdExpiresAt, totalTzs, currency }, payment: PaymentView | null, refund: RefundView | null }. PaymentView { id, state: submitted | processing | confirmed | rejected | failed | expired | needs_attention | none, method, amountTzs, currency, reference (the member\'s own transaction ID), payerPhoneMasked, submittedAt, decidedAt, confirmTargetAt, rejectCode, memberNote, late, canRetry, refundId }. Never staff names, internal notes, approval stages or provider payloads. Reads need only EVENTS_REGISTRATION.',
  onGuard: member('get'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.status, `s:${req.params.id}`, res)) return undefined;
    return send(res, await payments.paymentStatus({ userId: req.user.sub, orderId: req.params.id }));
  },
};

// ── Tickets (§3.8.4) ─────────────────────────────────────────────────────

export const listMyEventTickets = {
  created, method: 'get', path: '/me/event-tickets',
  description: 'Member: the tickets of places I hold (I am the participant) or bought for someone who has not claimed yet. Soonest event first, revoked after, past last. ?cursor&limit (≤50) → { items [{ registrationId, ticketId, displayCode, state: active | revoked, event, category { name, distanceM, startsAt }, ticketType { name }, participant { firstName, lastName }, relation: self | purchased | claimed, orderReference, issuedAt, kit { state } }], nextCursor }. NO token in the list.',
  onGuard: member('get'),
  onRequest: async (req, res) => send(res, await payments.listTickets({ userId: req.user.sub, query: req.query || {} })),
};

export const getEventTicket = {
  created, method: 'get', path: '/me/event-registrations/:id/ticket',
  description: 'Member (the participant, or the purchaser while the place is unclaimed; anyone else 404 registration_not_found): the ticket with its code → { ticket { id, displayCode, state, issuedAt, rotatedAt }, token, qrPayload ("FFEV1:" + token), event, category, participant, relation, scanning: false, kit }. The token is derived (HMAC under EVENT_TICKET_SECRET) and never stored; Cache-Control: no-store. 409 ticket_revoked { reason } | ticket_not_issued; 429 rate_limited (60/h); 503 tickets_unavailable.',
  onGuard: member('get'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.ticketRead, `t:${req.user.sub}`, res)) return undefined;
    noStore(res);
    return send(res, await payments.getTicket({ userId: req.user.sub, registrationId: req.params.id }));
  },
};

export const rotateEventTicket = {
  created, method: 'post', path: '/me/event-registrations/:id/ticket/rotate',
  description: 'Member (same access as reading the ticket): a new code — the old one stops matching at once → the ticket body of GET …/ticket. 5 per day per ticket (429 rate_limited); 409 ticket_revoked; 404 registration_not_found. Cache-Control: no-store.',
  onGuard: member('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.ticketRotate, `r:${req.user.sub}:${req.params.id}`, res)) return undefined;
    noStore(res);
    return send(res, await payments.rotateTicket({ userId: req.user.sub, registrationId: req.params.id }));
  },
};

// ── Cancel previews (§3.12.2) ─────────────────────────────────────────────

const PREVIEW_DOC = '→ { eligible, mode: auto | none | manual_review | closed, percent, paidTzs, refundTzs, currency, deadlineAt, policy { preset, text { en, sw }, days?, tiers?, generated { en, sw } }, places [{ registrationId, name, paidTzs, refundTzs }], releaseInventory, blocked: null | payment_submitted | refund_in_progress | cancellation_window_closed | event_cancelled | purchaser_only | kit_collected }. Percent never rounds up: floor(paid × percent / 100) per place. 60/h. 409 nothing_to_cancel.';

export const eventRegistrationCancelPreview = {
  created, method: 'get', path: '/me/event-registrations/:id/cancel-preview',
  description: `Member (purchaser or participant): what cancelling one PAID place would refund, read-only ${PREVIEW_DOC}`,
  onGuard: member('get'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.preview, `p:${req.user.sub}`, res)) return undefined;
    return send(res, await refunds.previewRegistration({ userId: req.user.sub, registrationId: req.params.id }));
  },
};

export const eventOrderCancelPreview = {
  created, method: 'get', path: '/me/event-orders/:id/cancel-preview',
  description: `Member (purchaser only): what cancelling the whole PAID order would refund, read-only ${PREVIEW_DOC}`,
  onGuard: member('get'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.preview, `p:${req.user.sub}`, res)) return undefined;
    return send(res, await refunds.previewOrder({ userId: req.user.sub, orderId: req.params.id }));
  },
};

export const resendEventClaimInvitation = {
  created, method: 'post', path: '/me/event-orders/:id/claim-invitations',
  description: 'Member (purchaser): send the claim invitation for one unclaimed, non-self place of a PAID order again. Body { registrationId } → { sent, channel: sms | email | null, nextAllowedAt, invalidatesPreviousLink }. It mints a NEW link: the previous one stops working. 3 per day per place and at most 5 sends (409 resend_limit_reached); 409 order_not_confirmed | not_resendable; 404 order_not_found | registration_not_found.',
  onGuard: member('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(limiters.resend, `c:${req.user.sub}:${req.body?.registrationId}`, res)) return undefined;
    return send(res, await payments.resendClaim({ userId: req.user.sub, orderId: req.params.id, registrationId: req.body?.registrationId }));
  },
};
