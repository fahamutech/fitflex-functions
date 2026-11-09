// Marathon & running events · S5 — what organizers may be sent (spec §7.1). A CLOSED allowlist of subscribable
// types, a projector per type (an allowlist of payload keys, so a field added to an outbox payload later cannot
// leak by default), and the envelope. No names, phones, emails, amounts or tokens ever appear in a webhook.
//
// NOT subscribable and never sent to organizers: payment.succeeded / payment.failed (D25: organizers never see payment
// details; registration.paid already says a place is paid), ticket.issued / ticket.revoked (a ticket reference is
// credential-adjacent), registration.reserved (not built, spec decision: an unpaid hold is not a registration).
// refund.* internal rows are mapped to ONE organizer type, refund.updated, at fan-out time; the unfulfilled-payment
// refund (a late payment that was never the organizer's sale) is dropped.

export const WEBHOOK_EVENT_TYPES = Object.freeze([
  'registration.created', 'registration.paid', 'registration.cancelled', 'registration.updated',
  'kit.collected', 'bib.assigned', 'event.updated', 'event.cancelled', 'refund.updated',
  // S6 (results): ids and codes only, never a name or a time; the integration fetches authorised fields with the results API.
  'result.verified', 'result.published', 'result.corrected', 'result.disputed',
]);
export const WEBHOOK_TEST_TYPES = Object.freeze(WEBHOOK_EVENT_TYPES.map(t => `${t}.test`));
export const ENVELOPE_VERSION = '1';
export const MAX_BODY_BYTES = 16 * 1024;

const CANCEL_CODES = new Set(['cancelled', 'expired', 'payment_failed', 'admin', 'changed_mind', 'wrong_details', 'duplicate', 'refunded', 'event_cancelled', 'other']);
const CHANGED = new Set(['claimed', 'details', 'team', 'kit', 'bib', 'anonymised']);
const FINISH = new Set(['finished', 'dnf', 'dns', 'dq']);
const STAGES = new Set(['provisional', 'official']);
const DISPUTE_STATES = new Set(['open', 'upheld', 'rejected', 'withdrawn']);
const iso = v => (v ? new Date(v).toISOString() : null);
const str = (v, max = 100) => (typeof v === 'string' && v.length <= max ? v : null);

const PROJECTORS = {
  'registration.created': p => ({ registrationId: str(p.registrationId), categoryId: str(p.categoryId), ticketTypeId: str(p.ticketTypeId), status: 'confirmed' }),
  'registration.paid': p => ({ registrationId: str(p.registrationId), categoryId: str(p.categoryId), ticketTypeId: str(p.ticketTypeId) }),
  'registration.cancelled': p => ({ registrationId: str(p.registrationId), status: 'cancelled', reasonCode: CANCEL_CODES.has(p.reason) ? p.reason : 'other' }),
  'registration.updated': p => ({ registrationId: str(p.registrationId), changed: (Array.isArray(p.changed) ? p.changed : []).filter(c => CHANGED.has(c)) }),
  'kit.collected': p => ({ registrationId: str(p.registrationId), collectionPointId: str(p.collectionPointId), collectedAt: iso(p.collectedAt) }),
  'bib.assigned': p => ({ registrationId: str(p.registrationId), categoryId: str(p.categoryId), bibNumber: str(p.bibNumber, 12), previousBibNumber: str(p.previousBibNumber, 12) }),
  'event.updated': p => ({ eventId: str(p.eventId), version: Number.isInteger(p.version) ? p.version : null, changedFields: (Array.isArray(p.changedFields) ? p.changedFields : []).filter(f => typeof f === 'string' && f.length <= 120).slice(0, 50), material: p.material === true }),
  'event.cancelled': p => ({ eventId: str(p.eventId), cancelledAt: iso(p.cancelledAt), reasonCode: str(p.reasonCode, 40) }),
  'result.verified': p => ({ registrationId: str(p.registrationId), resultId: str(p.resultId), revision: Number.isInteger(p.revision) ? p.revision : null, finishStatus: FINISH.has(p.finishStatus) ? p.finishStatus : null }),
  'result.published': p => ({ eventId: str(p.eventId), categoryId: str(p.categoryId), stage: STAGES.has(p.stage) ? p.stage : null, releasedAt: iso(p.releasedAt), resultCount: Number.isInteger(p.resultCount) ? p.resultCount : null }),
  'result.corrected': p => ({ registrationId: str(p.registrationId), resultId: str(p.resultId), revision: Number.isInteger(p.revision) ? p.revision : null, previousRevision: Number.isInteger(p.previousRevision) ? p.previousRevision : null, finishStatus: FINISH.has(p.finishStatus) ? p.finishStatus : null, material: true }),
  'result.disputed': p => ({ registrationId: str(p.registrationId), resultId: str(p.resultId), disputeId: str(p.disputeId), status: DISPUTE_STATES.has(p.status) ? p.status : null }),
  'refund.updated': p => ({ orderId: str(p.orderId), eventId: str(p.eventId), scope: str(p.scope, 40), status: ['requested', 'paid'].includes(p.status) ? p.status : null }),
};

/**
 * An outbox row → { type, data } the organizer may be sent, or null when it is internal-only. Refund rows are mapped here
 * so no refund or payment code changes (spec confirmation 9).
 */
export function projectOutbox(row) {
  let type = row.type;
  let payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {});
  if (type === 'refund.requested' || type === 'refund.paid') {
    if (payload.scope === 'unfulfilled_payment') return null;
    payload = { ...payload, status: type === 'refund.paid' ? 'paid' : 'requested' };
    type = 'refund.updated';
  }
  const project = PROJECTORS[type];
  if (!project) return null;
  return { type, data: project(payload) };
}

/** Is this one of the types an endpoint may subscribe to? (No wildcard: new types never reach old endpoints silently.) */
export const isSubscribable = type => WEBHOOK_EVENT_TYPES.includes(type);

/** The envelope as sent. `id` is the outbox id: stable across endpoints and retries, the consumer's dedupe key. */
export function envelopeOf(row, projected) {
  return {
    id: row.id, type: projected.type, version: ENVELOPE_VERSION, createdAt: iso(row.createdAt),
    organizerId: row.organizerId, eventId: row.eventId, data: projected.data,
  };
}

/** The control message of the handshake (never stored in the outbox). */
export const verificationEnvelope = (challenge, now = new Date()) => ({ id: 'obx_verification', type: 'endpoint.verification', version: ENVELOPE_VERSION, createdAt: now.toISOString(), challenge });

/** A synthetic event for test-send: `<type>.test`, `data.test: true`, no real registration. */
export function testEnvelope(type, { organizerId, eventId = null, now = new Date(), id = `obx_test_${Math.random().toString(16).slice(2, 14)}` } = {}) {
  const base = isSubscribable(type) ? type : 'registration.created';
  return { id, type: `${base}.test`, version: ENVELOPE_VERSION, createdAt: now.toISOString(), organizerId, eventId, data: { test: true } };
}

/** Retry schedule in minutes after a failed attempt n (1-based): 1, 5, 15, 60, 180, 360, 720, 1440 (then the last repeats). Jitter ±20 %. */
export const RETRY_MINUTES = Object.freeze([1, 5, 15, 60, 180, 360, 720, 1440]);
export function retryDelayMs(failedAttemptNo, random = Math.random) {
  const base = RETRY_MINUTES[Math.min(Math.max(failedAttemptNo, 1), RETRY_MINUTES.length) - 1] * 60_000;
  return Math.round(base * (0.8 + random() * 0.4));
}
