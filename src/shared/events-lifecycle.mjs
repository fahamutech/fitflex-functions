// Marathon & running events — the state machines (PRD §9, ORG-003 organizer statuses, ORG-006 event
// lifecycle). Pure: no I/O, nothing thrown for a business refusal. Each kind has one closed set of
// statuses and one table of allowed moves; the database CHECKs in db/migrations/20270110*.cjs carry the
// same sets, so a status the rules do not know cannot be stored either.
//
//   canTransition(kind, from, to)     → boolean
//   assertTransition(kind, from, to)  → { ok: true, kind, from, to }
//                                     | { error: 'invalid_transition', status: 409, kind, from, to, allowed }
// An unknown kind is a programming error and throws.

const machine = (statuses, moves) => Object.freeze({
  statuses: Object.freeze([...statuses]),
  moves: Object.freeze(Object.fromEntries(statuses.map(s => [s, Object.freeze([...(moves[s] ?? [])])]))),
});

/** ORG-003: organizer verification. Resubmission after a rejection; suspension is reversible. */
export const ORGANIZER_STATUSES = ['draft', 'pending_review', 'active', 'rejected', 'suspended'];
const organizer = machine(ORGANIZER_STATUSES, {
  draft: ['pending_review'],
  pending_review: ['active', 'rejected'],
  rejected: ['pending_review'],
  active: ['suspended'],
  suspended: ['active'],
});

/**
 * ORG-006: the event. A submitted event goes back to draft when FitFlex sends it back. Registration can be
 * closed and reopened while the event has not started. Cancelling is possible from publication until the
 * event is complete; completed and cancelled events are archived.
 */
export const EVENT_STATUSES = ['draft', 'submitted', 'published', 'registration_closed', 'in_progress', 'completed', 'cancelled', 'archived'];
const event = machine(EVENT_STATUSES, {
  draft: ['submitted', 'archived'],
  submitted: ['published', 'draft'],
  published: ['registration_closed', 'in_progress', 'cancelled'],
  registration_closed: ['published', 'in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: ['archived'],
  cancelled: ['archived'],
  archived: [],
});

/**
 * The order (checkout). awaiting_payment holds inventory; it becomes confirmed with payment, expired when
 * the hold lapses, cancelled by the purchaser. A confirmed payment is never edited back: money going back
 * is refund_pending → refunded, and a refused refund returns the order to confirmed.
 */
export const ORDER_STATUSES = ['draft', 'awaiting_payment', 'confirmed', 'partially_cancelled', 'cancelled', 'expired', 'refund_pending', 'refunded'];
const order = machine(ORDER_STATUSES, {
  draft: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['confirmed', 'cancelled', 'expired'],
  confirmed: ['partially_cancelled', 'cancelled', 'refund_pending'],
  partially_cancelled: ['cancelled', 'refund_pending'],
  refund_pending: ['refunded', 'confirmed'],
  cancelled: [],
  expired: [],
  refunded: [],
});

/**
 * One payment attempt. A provider timeout is not a failure: it goes to reconciliation_required and is
 * queried. A duplicate success callback is a no-op (succeeded → succeeded is not a transition). Only a
 * succeeded attempt can be reversed.
 */
export const PAYMENT_ATTEMPT_STATUSES = ['created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired', 'reversed', 'reconciliation_required'];
const paymentAttempt = machine(PAYMENT_ATTEMPT_STATUSES, {
  created: ['pending', 'succeeded', 'failed', 'cancelled', 'expired', 'reconciliation_required'],
  pending: ['succeeded', 'failed', 'cancelled', 'expired', 'reconciliation_required'],
  reconciliation_required: ['succeeded', 'failed', 'expired', 'cancelled'],
  succeeded: ['reversed'],
  failed: [],
  cancelled: [],
  expired: [],
  reversed: [],
});

/**
 * A participant's place. reserved while the order's hold stands, confirmed with payment. A cancelled
 * confirmed place may still be refunded (money follows the refund flow). transferred, refunded and
 * disqualified are final.
 */
export const REGISTRATION_STATUSES = ['draft', 'reserved', 'confirmed', 'cancelled', 'transferred', 'refunded', 'disqualified'];
const registration = machine(REGISTRATION_STATUSES, {
  draft: ['reserved', 'cancelled'],
  reserved: ['confirmed', 'cancelled'],
  confirmed: ['cancelled', 'transferred', 'refunded', 'disqualified'],
  cancelled: ['refunded'],
  transferred: [],
  refunded: [],
  disqualified: [],
});

/** The entry token. A revoked ticket is replaced by a new row, never reactivated. */
export const TICKET_STATUSES = ['not_issued', 'active', 'revoked', 'used_for_entry'];
const ticket = machine(TICKET_STATUSES, {
  not_issued: ['active', 'revoked'],
  active: ['revoked', 'used_for_entry'],
  used_for_entry: ['revoked'],
  revoked: [],
});

/** Kit collection as seen on the registration. A collected kit is corrected through exception. */
export const KIT_STATUSES = ['not_ready', 'ready', 'collected', 'exception'];
const kit = machine(KIT_STATUSES, {
  not_ready: ['ready'],
  ready: ['collected', 'exception', 'not_ready'],
  collected: ['exception'],
  exception: ['collected', 'ready'],
});

/**
 * The result as seen on the registration. A result arrives as pending_verification (or straight as dns /
 * dnf from the organizer); verification settles it; a verified result can be corrected or disqualified
 * (a second correction is a new EventResult revision, not a status move); a rejected, dnf or dns status
 * can be revisited with a new submission.
 */
export const RESULT_STATUSES = ['not_submitted', 'pending_verification', 'verified', 'rejected', 'corrected', 'disqualified', 'dnf', 'dns'];
const result = machine(RESULT_STATUSES, {
  not_submitted: ['pending_verification', 'dnf', 'dns'],
  pending_verification: ['verified', 'rejected', 'disqualified', 'dnf', 'dns'],
  verified: ['corrected', 'disqualified'],
  corrected: ['verified', 'disqualified'],
  rejected: ['pending_verification'],
  dnf: ['pending_verification'],
  dns: ['pending_verification'],
  disqualified: ['corrected'],
});

export const LIFECYCLES = Object.freeze({ organizer, event, order, paymentAttempt, registration, ticket, kit, result });
export const LIFECYCLE_KINDS = Object.freeze(Object.keys(LIFECYCLES));

function machineOf(kind) {
  const m = LIFECYCLES[kind];
  if (!m) throw new Error(`unknown lifecycle kind: ${kind}`);
  return m;
}

/** The statuses `from` may move to (empty for a final status or one the kind does not know). */
export function allowedTransitions(kind, from) {
  return machineOf(kind).moves[from] ?? [];
}

/** True when `from` → `to` is an allowed move of `kind`. Staying put is not a move. */
export function canTransition(kind, from, to) {
  return allowedTransitions(kind, from).includes(to);
}

/**
 * The move as a result: { ok: true, kind, from, to } or the refusal
 * { error: 'invalid_transition', status: 409, kind, from, to, allowed } — never thrown.
 */
export function assertTransition(kind, from, to) {
  const allowed = allowedTransitions(kind, from);
  if (allowed.includes(to)) return { ok: true, kind, from, to };
  return { error: 'invalid_transition', status: 409, kind, from, to, allowed: [...allowed] };
}

/** A status with no way out. */
export function isFinal(kind, status) {
  const m = machineOf(kind);
  return m.statuses.includes(status) && m.moves[status].length === 0;
}
