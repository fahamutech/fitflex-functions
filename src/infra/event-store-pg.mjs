// Postgres store for the marathon & running events module (S1 foundation): organizers, events,
// categories, ticket types, and the order / hold / registration primitive.
//
// The hold model (also in db/migrations/20270110090200-events-orders.cjs):
//   createOrderWithHolds  ONE transaction — ticket-type rows locked FOR UPDATE in id order, sale window and
//                         per-order limits checked, `held` raised with a conditional UPDATE
//                         (sold + held + q <= capacity; zero rows = capacity_unavailable, nothing written),
//                         then the order (awaiting_payment, holdExpiresAt), its lines, its registrations
//                         (reserved) and one `hold` movement per line.
//   commitOrder           held → sold per line, one `commit` movement per line, order confirmed,
//                         registrations confirmed, one OutboxEvent per registration — all in one transaction.
//   releaseOrder          held lowered per line, one `release` movement per line, order expired or
//                         cancelled, registrations cancelled, one OutboxEvent per registration.
//   expireHolds           every awaiting_payment order whose hold lapsed, released one by one
//                         (FOR UPDATE SKIP LOCKED, so two servers never release the same order).
//   releaseRegistration   S3: one place out of an unpaid multi-place order — held − 1 on that line's ticket
//                         type, the line reduced (never to 0: remove_whole_line), totals re-derived from the
//                         price snapshot, the registration cancelled, one release movement keyed per registration.
// Each movement's key `${orderId}:${cycle}:${kind}:${ticketTypeId}` is UNIQUE: a second commit or release
// inserts nothing (ON CONFLICT DO NOTHING) and touches no counter, so retries are no-ops. A single-place
// release appends `:${registrationId}` so several single releases in one cycle stay unique.
//
// Business refusals come back as { error, status, ...extra } (D5); inside a transaction they are thrown
// as `refusal` so the transaction rolls back, then returned. Postgres errors 23505 (idempotency replay)
// and 23514 (the inventory CHECK, the last line of defence) are mapped; anything else is rethrown.
// Timestamps are timestamp(3) like the rest of the schema; money is whole TZS (D4).
import { randomUUID } from 'node:crypto';
import { assertTransition } from '../shared/events-lifecycle.mjs';
import { quoteLines, normaliseFeeRule, NO_FEE } from '../shared/events-pricing.mjs';
import { updateIf } from '../shared/conditional-update.mjs';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
/** How long an unpaid order keeps its places: EVENT_HOLD_TTL_MINUTES (default 30), like SHOP_RESERVATION_TTL_MINUTES. */
export const DEFAULT_HOLD_TTL_MINUTES = 30;
export const holdTtlMinutes = () => {
  const n = parseInt(process.env.EVENT_HOLD_TTL_MINUTES ?? '', 10);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_HOLD_TTL_MINUTES;
};
const CONSENT_BASES = ['self', 'purchaser_authorised', 'organisation'];
/** Why an unpaid order gives its places back (closed set; 'expired' makes the order expired, the rest cancelled). */
export const RELEASE_REASONS = Object.freeze(['cancelled', 'expired', 'payment_failed', 'admin']);

export const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const json = value => (value === undefined || value === null || typeof value === 'string' ? value : JSON.stringify(value));
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
/** Thrown inside a transaction so that it rolls back, then returned to the caller. */
const refusal = (error, status, extra = {}) => Object.assign(new Error(error), { refusal: fail(error, status, extra) });
const isInt = n => Number.isInteger(n);
const nonEmpty = s => typeof s === 'string' && s.trim().length > 0;
/** The short order number people see: EV- + 10 hex characters of the id. */
export const referenceOf = orderId => `EV-${orderId.slice(4, 14).toUpperCase()}`;
export const movementKeyOf = (orderId, cycle, kind, ticketTypeId, suffix = null) => `${orderId}:${cycle}:${kind}:${ticketTypeId}${suffix ? `:${suffix}` : ''}`;
/** A refusal a store hook (afterCreate) may throw so the surrounding transaction rolls back and the caller gets { error, status }. */
export const storeRefusal = (error, status, extra = {}) => Object.assign(new Error(error), { refusal: { error, status, ...extra } });

const ORGANIZER_COLUMNS = ['id', 'ownerUserId', 'name', 'legalName', 'contactPhone', 'contactEmail', 'status', 'statusReason', 'kycCaseId', 'settlementAccountId', 'commissionPct', 'timezone'];
// S2 (20270110090800-events-document-fields.cjs) adds the rest of the document; the same rowOf() rules apply.
const EVENT_COLUMNS = ['id', 'organizerId', 'slug', 'title', 'description', 'eventType', 'status', 'startsAt', 'endsAt', 'timezone', 'venueName', 'venueAddress', 'lat', 'lng', 'routeMeta', 'termsSnapshot', 'refundPolicySnapshot', 'registrationClosesAt', 'publishedAt', 'cancelledAt', 'version',
  'heroImageUrl', 'heroThumbUrl', 'heroImageAlt', 'routeUrl', 'routeImageUrl', 'routeImageAlt', 'descriptionSw', 'venueCity', 'venueRegion', 'accessibility', 'inclusions', 'kitProvided',
  'schedule', 'sponsors', 'contact', 'terms', 'refundPolicy', 'registrationOpensAt',
  'participantFields', 'duplicatePolicy',
  // S5 (20270126090000): the payout schedule label (D33); the service decides who may set it and when.
  'payoutSchedule'];
/** S3 (20270110090900): what a route may set on the order besides what the store derives; never money, status or the hold. */
const ORDER_EXTRA_COLUMNS = ['createdByUserId', 'costCentre', 'purchaserReference', 'termsAcceptedAt', 'consentTextVersion'];
/** S3: per-registration columns the service computes (normalised contacts, consent proof, claim token hash, kit size, D19 group label). */
const REGISTRATION_EXTRA_COLUMNS = ['kitSize', 'consentTextVersion', 'consentAt', 'phoneNormalized', 'emailNormalized', 'claimTokenHash', 'claimTokenExpiresAt', 'groupLabel'];
const CATEGORY_COLUMNS = ['id', 'eventId', 'name', 'distanceMeters', 'routeType', 'startTime', 'eligibility', 'capacity', 'registrationClosesAt', 'resultRules', 'status', 'minAge'];
const TICKET_TYPE_COLUMNS = ['id', 'eventId', 'categoryId', 'name', 'priceTzs', 'currency', 'capacity', 'saleOpensAt', 'saleClosesAt', 'minPerOrder', 'maxPerOrder', 'status'];
const JSON_COLUMNS = new Set(['routeMeta', 'termsSnapshot', 'refundPolicySnapshot', 'eligibility', 'resultRules', 'priceSnapshot', 'emergencyContact', 'payload',
  'accessibility', 'inclusions', 'schedule', 'sponsors', 'contact', 'terms', 'refundPolicy', 'participantFields']);

/** Only the known columns of a table, JSON columns serialised; unknown keys are dropped, never sent to SQL. */
function rowOf(columns, input) {
  const row = {};
  for (const key of columns) {
    if (input[key] === undefined) continue;
    row[key] = JSON_COLUMNS.has(key) ? json(input[key]) : input[key];
  }
  return row;
}

export function createPgEventStore({ db, now = () => new Date(), feeRule = NO_FEE, hooks = {} }) {
  /**
   * A compare-and-set view of one table for src/shared/conditional-update.mjs updateIf():
   * UPDATE ... WHERE id = ? AND <where> RETURNING *, or null when the row is missing or has moved on.
   */
  const conditional = (table, q = db) => ({
    updateByIdWhereAsync: async (id, where, patch) => {
      let query = q(table).where({ id });
      for (const [column, expected] of Object.entries(where || {})) {
        query = Array.isArray(expected) ? query.whereIn(column, expected) : expected === null ? query.whereNull(column) : query.where(column, expected);
      }
      const rows = await query.update({ ...patch, updatedAt: now() }).returning('*');
      return rows.length ? plain(rows[0]) : null;
    },
  });

  // ── organizers ────────────────────────────────────────────────────────────

  async function createOrganizer(input) {
    if (!nonEmpty(input?.ownerUserId)) return fail('owner_required', 400);
    if (!nonEmpty(input?.name)) return fail('name_required', 400);
    const at = now();
    // status is never taken from input: every organizer starts in draft and moves through transitionOrganizer.
    const row = rowOf(ORGANIZER_COLUMNS, { ...input, id: input.id || newId('evo'), status: 'draft', statusReason: null });
    const [saved] = await db('EventOrganizer').insert({ ...row, createdAt: at, updatedAt: at }).returning('*');
    return plain(saved);
  }

  const getOrganizer = async id => plain(await db('EventOrganizer').where({ id }).first());

  /** Patch an organizer only while it is still in `fromStatus` (when given). null = it moved on or is missing. */
  function updateOrganizer(id, patch, { fromStatus = null } = {}) {
    const where = fromStatus ? { status: fromStatus } : {};
    return updateIf(conditional('EventOrganizer'), id, where, rowOf(ORGANIZER_COLUMNS.filter(c => c !== 'id'), patch));
  }

  /** Move an organizer along ORG-003 under its row lock; a refusal names what would have been allowed. */
  async function transitionOrganizer(id, to, { reason = null } = {}) {
    return db.transaction(async (trx) => {
      const current = plain(await trx('EventOrganizer').where({ id }).forUpdate().first());
      if (!current) return fail('organizer_not_found', 404);
      const move = assertTransition('organizer', current.status, to);
      if (move.error) return { ...move, organizerId: id };
      if (['rejected', 'suspended'].includes(to) && !nonEmpty(reason)) return fail('reason_required', 400, { to });
      const [saved] = await trx('EventOrganizer').where({ id }).update({ status: to, statusReason: reason, updatedAt: now() }).returning('*');
      return { organizer: plain(saved), from: current.status, to };
    });
  }

  // ── events, categories, ticket types ──────────────────────────────────────

  async function createEvent(input) {
    for (const key of ['organizerId', 'slug', 'title', 'eventType']) if (!nonEmpty(input?.[key])) return fail(`${key}_required`, 400);
    if (!input.startsAt || !input.endsAt) return fail('window_required', 400);
    const at = now();
    // status, version, publishedAt and cancelledAt are never taken from input: an event starts as draft v1
    // and moves through transitionEvent (review #242).
    const row = rowOf(EVENT_COLUMNS, { ...input, id: input.id || newId('evt'), status: 'draft', version: 1, publishedAt: null, cancelledAt: null });
    try {
      const [saved] = await db('Event').insert({ ...row, createdAt: at, updatedAt: at }).returning('*');
      return plain(saved);
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION && /slug/.test(err.constraint || '')) return fail('slug_taken', 409, { slug: input.slug });
      throw err;
    }
  }

  const getEvent = async id => plain(await db('Event').where({ id }).first());

  /** Fields that are frozen once an event is past submitted: participants agreed to them (review #242). */
  const FROZEN_AFTER_SUBMISSION = ['slug', 'termsSnapshot', 'refundPolicySnapshot'];

  /**
   * Patch an event only if it is still at `expectedVersion`; the version is bumped with the patch.
   * { event } or { error: 'version_conflict', status: 409 } when someone else edited it first;
   * { error: 'event_frozen_field', status: 409, field } when slug / terms / refund policy are patched on
   * an event that is no longer draft or submitted. Status, version, publishedAt, cancelledAt never change here.
   */
  async function updateEvent(id, patch, { expectedVersion, inTransaction = null }) {
    if (!isInt(expectedVersion) || expectedVersion < 1) return fail('expected_version_required', 400);
    const current = await getEvent(id);
    if (!current) return fail('event_not_found', 404);
    if (!['draft', 'submitted'].includes(current.status)) {
      const frozen = FROZEN_AFTER_SUBMISSION.find(f => patch?.[f] !== undefined);
      if (frozen) return fail('event_frozen_field', 409, { eventId: id, field: frozen, eventStatus: current.status });
    }
    const columns = EVENT_COLUMNS.filter(c => !['id', 'organizerId', 'status', 'version', 'publishedAt', 'cancelledAt'].includes(c));
    // The status is re-checked in the same statement, so a publish racing this edit cannot let a frozen field through.
    // S5 (M4): `inTransaction(trx, event)` runs in the SAME transaction as the update (an outbox row that commits with the change).
    const run = q => updateIf(conditional('Event', q), id, { version: expectedVersion, status: current.status }, { ...rowOf(columns, patch), version: expectedVersion + 1 });
    const saved = inTransaction
      ? await db.transaction(async (trx) => { const row = await run(trx); if (row) await inTransaction(trx, row); return row; })
      : await run(db);
    if (saved) return { event: saved };
    return (await getEvent(id)) ? fail('version_conflict', 409, { eventId: id }) : fail('event_not_found', 404);
  }

  /** Move an event along ORG-006 under its row lock; publishedAt / cancelledAt follow the move. */
  async function transitionEvent(id, to, { inTransaction = null } = {}) {
    return db.transaction(async (trx) => {
      const current = plain(await trx('Event').where({ id }).forUpdate().first());
      if (!current) return fail('event_not_found', 404);
      const move = assertTransition('event', current.status, to);
      if (move.error) return { ...move, eventId: id };
      const at = now();
      const patch = { status: to, version: current.version + 1, updatedAt: at };
      if (to === 'published' && !current.publishedAt) patch.publishedAt = at;
      if (to === 'cancelled') patch.cancelledAt = at;
      const [saved] = await trx('Event').where({ id }).update(patch).returning('*');
      if (inTransaction) await inTransaction(trx, plain(saved), current.status);   // S5 (M4): same transaction as the move
      return { event: plain(saved), from: current.status, to };
    });
  }

  async function createCategory(input) {
    for (const key of ['eventId', 'name']) if (!nonEmpty(input?.[key])) return fail(`${key}_required`, 400);
    if (!isInt(input.distanceMeters) || input.distanceMeters <= 0) return fail('invalid_distance', 400);
    const at = now();
    const row = rowOf(CATEGORY_COLUMNS, { status: 'active', ...input, id: input.id || newId('evc') });
    try {
      const [saved] = await db('EventCategory').insert({ ...row, createdAt: at, updatedAt: at }).returning('*');
      return plain(saved);
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) return fail('category_name_taken', 409, { name: input.name });
      throw err;
    }
  }

  async function createTicketType(input) {
    for (const key of ['eventId', 'categoryId', 'name']) if (!nonEmpty(input?.[key])) return fail(`${key}_required`, 400);
    if (!isInt(input.priceTzs) || input.priceTzs < 0) return fail('invalid_price', 400);
    if (!isInt(input.capacity) || input.capacity < 0) return fail('invalid_capacity', 400);
    const at = now();
    const row = rowOf(TICKET_TYPE_COLUMNS, { status: 'active', currency: 'TZS', minPerOrder: 1, maxPerOrder: 10, ...input, id: input.id || newId('ett') });
    try {
      const [saved] = await db('EventTicketType').insert({ ...row, createdAt: at, updatedAt: at }).returning('*');
      return plain(saved);
    } catch (err) {
      if (err.code === '23503') return fail('category_not_in_event', 409, { categoryId: input.categoryId, eventId: input.eventId });
      if (err.code === CHECK_VIOLATION) return fail('invalid_ticket_type', 400, { constraint: err.constraint ?? null });
      throw err;
    }
  }

  const getTicketType = async id => plain(await db('EventTicketType').where({ id }).first());

  /** Patch a ticket type's settings (never its counters) only while it has `expectedStatus` (when given). */
  function updateTicketType(id, patch, { expectedStatus = null } = {}) {
    const columns = TICKET_TYPE_COLUMNS.filter(c => !['id', 'eventId', 'categoryId'].includes(c));
    return updateIf(conditional('EventTicketType'), id, expectedStatus ? { status: expectedStatus } : {}, rowOf(columns, patch));
  }

  // ── outbox ────────────────────────────────────────────────────────────────

  /**
   * Write a durable fact in the caller's transaction (API-012: the change and its outbox row commit
   * together, or neither does). The dispatcher (S5) publishes it later.
   */
  async function appendOutbox(trx, { type, aggregateType, aggregateId, organizerId = null, eventId = null, payload = {}, version = '1' }) {
    if (!nonEmpty(type) || !nonEmpty(aggregateType) || !nonEmpty(aggregateId)) throw new Error('appendOutbox: type, aggregateType and aggregateId are required');
    const [row] = await trx('OutboxEvent').insert({
      id: newId('obx'), type, aggregateType, aggregateId, organizerId, eventId, payload: json(payload), version: String(version), createdAt: now(),
    }).returning('*');
    return plain(row);
  }

  // ── orders ────────────────────────────────────────────────────────────────

  async function loadOrder(q, orderId) {
    const order = plain(await q('EventOrder').where({ id: orderId }).first());
    if (!order) return null;
    const lines = (await q('EventOrderLine').where({ orderId }).orderBy('ticketTypeId')).map(plain);
    const registrations = (await q('EventRegistration').where({ orderId }).orderBy('id')).map(plain);
    return { order, lines, registrations };
  }

  const getOrder = orderId => loadOrder(db, orderId);

  /**
   * Where an Idempotency-Key lives: per purchaser; without one (guest / corporate) per organisation;
   * without either per event (the three partial unique indexes of the orders migration).
   */
  const keyScope = ({ purchaserUserId, organizationId, eventId }, key) => (
    purchaserUserId ? { purchaserUserId, idempotencyKey: key }
      : organizationId ? { purchaserUserId: null, organizationId, idempotencyKey: key }
        : { purchaserUserId: null, organizationId: null, eventId, idempotencyKey: key });

  async function replay(scope, fingerprint) {
    const existing = await db('EventOrder').where(scope).first('id', 'idempotencyFingerprint');
    if (!existing) return null;
    if (existing.idempotencyFingerprint !== fingerprint) return fail('idempotency_key_reused', 409);
    return { ...(await loadOrder(db, existing.id)), replayed: true };
  }

  /**
   * S3: the earlier answer for an Idempotency-Key in its scope ({ purchaserUserId } | { organizationId } | { eventId }),
   * before any validation runs — null when the key is new, { error: 'idempotency_key_reused' } when the body differs.
   */
  async function replayOrder({ purchaserUserId = null, organizationId = null, eventId = null } = {}, key, fingerprint) {
    if (!nonEmpty(key) || !nonEmpty(fingerprint)) return null;
    return replay(keyScope({ purchaserUserId, organizationId, eventId }, String(key)), fingerprint);
  }

  /** Validate the request shape before any SQL. Returns a refusal or { lines, participants, totalQuantity }. */
  function parseOrderInput({ lines, participants, discounts }) {
    if (!Array.isArray(lines) || !lines.length) return fail('invalid_lines', 400);
    if (discounts != null && (typeof discounts !== 'object' || Array.isArray(discounts))) return fail('invalid_discounts', 400);
    const seen = new Set();
    const wanted = new Map();
    for (const line of lines) {
      if (!nonEmpty(line?.ticketTypeId)) return fail('invalid_lines', 400);
      if (seen.has(line.ticketTypeId)) return fail('duplicate_line', 400, { ticketTypeId: line.ticketTypeId });
      seen.add(line.ticketTypeId);
      if (!isInt(line.quantity) || line.quantity < 1) return fail('invalid_quantity', 400, { ticketTypeId: line.ticketTypeId });
      wanted.set(line.ticketTypeId, line.quantity);
    }
    const totalQuantity = [...wanted.values()].reduce((a, b) => a + b, 0);
    if (!Array.isArray(participants)) return fail('participants_required', 400);
    if (participants.length !== totalQuantity) return fail('participants_mismatch', 400, { expected: totalQuantity, received: participants.length });
    const perType = new Map();
    let selfCount = 0;
    for (let i = 0; i < participants.length; i += 1) {
      const p = participants[i];
      if (!p || !wanted.has(p.ticketTypeId)) return fail('invalid_participant', 400, { index: i, reason: 'ticket_type' });
      if (!nonEmpty(p.firstName) || !nonEmpty(p.lastName)) return fail('invalid_participant', 400, { index: i, reason: 'name' });
      if (!CONSENT_BASES.includes(p.consentBasis)) return fail('invalid_participant', 400, { index: i, reason: 'consent_basis' });
      if (p.consentBasis === 'self' && ++selfCount > 1) return fail('multiple_self_participants', 400, { index: i });
      perType.set(p.ticketTypeId, (perType.get(p.ticketTypeId) ?? 0) + 1);
    }
    for (const [ticketTypeId, quantity] of wanted) {
      if ((perType.get(ticketTypeId) ?? 0) !== quantity) return fail('participants_mismatch', 400, { ticketTypeId, expected: quantity, received: perType.get(ticketTypeId) ?? 0 });
    }
    // Discounts come only from the server-side `discounts` map; whatever a client put on its lines is dropped.
    for (const [ticketTypeId, discount] of Object.entries(discounts ?? {})) {
      if (!wanted.has(ticketTypeId)) return fail('invalid_discounts', 400, { ticketTypeId });
      if (!isInt(discount) || discount < 0) return fail('invalid_discount', 400, { ticketTypeId });
    }
    return { lines: [...wanted].map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity, discountTzs: discounts?.[ticketTypeId] ?? 0 })).sort((a, b) => (a.ticketTypeId < b.ticketTypeId ? -1 : 1)), participants, totalQuantity };
  }

  /**
   * Place an order and hold its places — all or nothing. See the file comment for the hold model.
   *   eventId, purchaserUserId (null for an approved guest/corporate flow), organizationId,
   *   lines [{ ticketTypeId, quantity }] — a client's lines carry NO price or discount,
   *   participants [{ ticketTypeId, firstName, lastName, phone?, email?, dateOfBirth?, gender?,
   *   emergencyContact?, consentBasis }] — one per place; participantUserId is never taken from input: the
   *   one `self` participant (at most one per order) is the purchaser, everyone else is claimed later,
   *   idempotencyKey + fingerprint (scoped per purchaser, else per organisation, else per event),
   *   SERVER-SIDE ONLY (a route must never forward these from the request body): discounts
   *   { [ticketTypeId]: discountTzs } worked out by the route, holdTtlMinutes (default
   *   EVENT_HOLD_TTL_MINUTES), feeRule (default the store's).
   *   S3 additions (spec §3.5, §3.10, §8.3), all server-side:
   *     expectedTotalTzs  the total the client was quoted; after pricing the locked rows and before any hold is
   *                       written, a mismatch is 409 price_changed { quotedTotalTzs, totalTzs } and nothing is written.
   *                       It never influences the price.
   *     bulk              corporate orders: the per-line maxPerOrder check is skipped (the service caps rows itself).
   *     orderExtra        { createdByUserId, costCentre, purchaserReference, termsAcceptedAt, consentTextVersion }.
   *     participants may carry kitSize, consentTextVersion, consentAt, phoneNormalized, emailNormalized,
   *                       claimTokenHash, claimTokenExpiresAt, groupLabel (REGISTRATION_EXTRA_COLUMNS); never participantUserId.
   *     afterCreate(trx, result)  runs in the same transaction after the rows are written (teams); throw storeRefusal() to refuse.
   * → { order, lines, registrations, replayed } or { error, status, ... }.
   */
  async function createOrderWithHolds({
    eventId, purchaserUserId = null, organizationId = null, lines = [], participants = [],
    idempotencyKey = null, fingerprint = null, discounts = null, holdTtlMinutes: ttl = holdTtlMinutes(), feeRule: orderFeeRule = feeRule,
    expectedTotalTzs = null, bulk = false, orderExtra = null, afterCreate = null,
  }) {
    if (expectedTotalTzs != null && (!isInt(expectedTotalTzs) || expectedTotalTzs < 0)) return fail('invalid_expected_total', 400);
    if (!nonEmpty(eventId)) return fail('event_required', 400);
    const parsed = parseOrderInput({ lines, participants, discounts });
    if (parsed.error) return parsed;
    if (!isInt(ttl) || ttl < 1) return fail('invalid_hold_ttl', 400);
    const rule = normaliseFeeRule(orderFeeRule);
    if (rule.error) return rule;
    const key = idempotencyKey == null ? null : String(idempotencyKey);
    if (key && (key.length < 8 || key.length > 100 || !nonEmpty(fingerprint))) return fail('invalid_idempotency_key', 400);
    const scope = key ? keyScope({ purchaserUserId, organizationId, eventId }, key) : null;
    if (scope) {
      const earlier = await replay(scope, fingerprint);
      if (earlier) return earlier;
    }
    const at = now();
    const holdExpiresAt = new Date(+at + ttl * 60_000);
    const ids = parsed.lines.map(l => l.ticketTypeId);
    try {
      return await db.transaction(async (trx) => {
        const event = plain(await trx('Event').where({ id: eventId }).first());
        if (!event) throw refusal('event_not_found', 404);
        if (event.status !== 'published') throw refusal('event_not_open', 409, { eventStatus: event.status });
        if (event.registrationClosesAt && at > new Date(event.registrationClosesAt)) throw refusal('registration_closed', 409);

        // Always in id order, so two checkouts never wait on each other in a circle.
        const types = (await trx('EventTicketType').whereIn('id', ids).where({ eventId }).orderBy('id').forUpdate()).map(plain);
        const byId = new Map(types.map(t => [t.id, t]));
        for (const id of ids) if (!byId.has(id)) throw refusal('ticket_type_not_found', 404, { ticketTypeId: id });
        const categories = new Map((await trx('EventCategory').whereIn('id', [...new Set(types.map(t => t.categoryId))])).map(c => [c.id, plain(c)]));
        for (const line of parsed.lines) {
          const tt = byId.get(line.ticketTypeId);
          const category = categories.get(tt.categoryId);
          if (tt.status !== 'active') throw refusal('ticket_type_inactive', 409, { ticketTypeId: tt.id });
          if (!category || category.status !== 'active') throw refusal('category_inactive', 409, { ticketTypeId: tt.id, categoryId: tt.categoryId });
          if (category.registrationClosesAt && at > new Date(category.registrationClosesAt)) throw refusal('registration_closed', 409, { categoryId: category.id });
          if (tt.saleOpensAt && at < new Date(tt.saleOpensAt)) throw refusal('sale_not_open', 409, { ticketTypeId: tt.id, saleOpensAt: tt.saleOpensAt });
          if (tt.saleClosesAt && at > new Date(tt.saleClosesAt)) throw refusal('sale_closed', 409, { ticketTypeId: tt.id, saleClosesAt: tt.saleClosesAt });
          if (line.quantity < tt.minPerOrder || (!bulk && line.quantity > tt.maxPerOrder)) throw refusal('quantity_out_of_range', 400, { ticketTypeId: tt.id, min: tt.minPerOrder, max: tt.maxPerOrder });
        }

        const quote = quoteLines(types, parsed.lines, { feeRule: rule });
        if (quote.error) throw refusal(quote.error, quote.status, quote);
        // Price drift (S3 §3.5): the client's quoted total must equal what the locked rows price to — before any hold.
        if (expectedTotalTzs != null && quote.totalTzs !== expectedTotalTzs) throw refusal('price_changed', 409, { quotedTotalTzs: expectedTotalTzs, totalTzs: quote.totalTzs });

        const orderId = newId('eor');
        const cycle = 1;
        for (const line of parsed.lines) {
          const updated = await trx('EventTicketType')
            .where({ id: line.ticketTypeId })
            .whereRaw('sold + held + ? <= capacity', [line.quantity])
            .update({ held: trx.raw('held + ?', [line.quantity]), updatedAt: at });
          if (!updated) {
            const t = byId.get(line.ticketTypeId);
            const now_ = plain(await trx('EventTicketType').where({ id: t.id }).first('sold', 'held', 'capacity'));
            throw refusal('capacity_unavailable', 409, { ticketTypeId: line.ticketTypeId, requested: line.quantity, remaining: Math.max(Number(now_.capacity) - Number(now_.sold) - Number(now_.held), 0) });
          }
        }
        await trx('EventOrder').insert({
          ...rowOf(ORDER_EXTRA_COLUMNS, orderExtra || {}),
          id: orderId, eventId, purchaserUserId, organizationId, status: 'awaiting_payment', currency: quote.currency,
          subtotalTzs: quote.subtotalTzs, discountTzs: quote.discountTzs, feesTzs: quote.feesTzs, totalTzs: quote.totalTzs,
          priceSnapshot: json(quote.snapshot), idempotencyKey: key, idempotencyFingerprint: key ? fingerprint : null,
          holdExpiresAt, holdCycle: cycle, reference: referenceOf(orderId), createdAt: at, updatedAt: at,
        });
        const lineIds = new Map();
        for (const q of quote.lines) {
          const id = newId('eol');
          lineIds.set(q.ticketTypeId, id);
          await trx('EventOrderLine').insert({ id, orderId, eventId, ...q, createdAt: at });
          await trx('EventInventoryMovement').insert({
            id: newId('eim'), ticketTypeId: q.ticketTypeId, orderId, kind: 'hold', quantity: q.quantity, cycle,
            movementKey: movementKeyOf(orderId, cycle, 'hold', q.ticketTypeId), createdAt: at,
          });
        }
        for (const p of parsed.participants) {
          const tt = byId.get(p.ticketTypeId);
          await trx('EventRegistration').insert({
            ...rowOf(REGISTRATION_EXTRA_COLUMNS, p),
            id: newId('erg'), eventId, categoryId: tt.categoryId, ticketTypeId: tt.id, orderId, orderLineId: lineIds.get(tt.id),
            participantUserId: p.consentBasis === 'self' ? purchaserUserId : null, purchaserUserId,
            firstName: p.firstName.trim(), lastName: p.lastName.trim(), phone: p.phone ?? null, email: p.email ?? null,
            dateOfBirth: p.dateOfBirth ?? null, gender: p.gender ?? null, emergencyContact: json(p.emergencyContact ?? null),
            consentBasis: p.consentBasis, status: 'reserved', createdAt: at, updatedAt: at,
          });
        }
        const result = { ...(await loadOrder(trx, orderId)), replayed: false };
        if (afterCreate) {
          await afterCreate(trx, result);
          return { ...(await loadOrder(trx, orderId)), replayed: false };
        }
        return result;
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      // The same key arrived twice at once: the other request won; this one rolled back whole.
      if (err.code === UNIQUE_VIOLATION && scope) {
        const earlier = await replay(scope, fingerprint);
        if (earlier) return earlier;
      }
      // The table CHECK is the last line of defence.
      if (err.code === CHECK_VIOLATION && /eventtickettype_inventory_check/.test(err.constraint || err.message)) return fail('capacity_unavailable', 409);
      throw err;
    }
  }

  /** The organizer an order's event belongs to (for the outbox envelope). */
  const organizerOf = async (trx, eventId) => (await trx('Event').where({ id: eventId }).first('organizerId'))?.organizerId ?? null;

  /**
   * Payment confirmed: held → sold, order confirmed, registrations confirmed, one registration.created
   * outbox row each — in one transaction. A second call changes nothing (changed: false). An order that
   * is not awaiting payment is refused with invalid_transition.
   */
  async function commitOrder(orderId) {
    return db.transaction(async (trx) => {
      const order = plain(await trx('EventOrder').where({ id: orderId }).forUpdate().first());
      if (!order) return fail('order_not_found', 404);
      if (order.status === 'confirmed') return { ...(await loadOrder(trx, orderId)), changed: false };
      const move = assertTransition('order', order.status, 'confirmed');
      if (move.error) return { ...move, orderId };
      const at = now();
      const cycle = order.holdCycle;
      const lines = (await trx('EventOrderLine').where({ orderId }).orderBy('ticketTypeId')).map(plain);
      for (const line of lines) {
        const inserted = await trx('EventInventoryMovement').insert({
          id: newId('eim'), ticketTypeId: line.ticketTypeId, orderId, kind: 'commit', quantity: line.quantity, cycle,
          movementKey: movementKeyOf(orderId, cycle, 'commit', line.ticketTypeId), createdAt: at,
        }).onConflict('movementKey').ignore().returning('id');
        if (!inserted.length) continue;
        await trx('EventTicketType').where({ id: line.ticketTypeId })
          .update({ held: trx.raw('held - ?', [line.quantity]), sold: trx.raw('sold + ?', [line.quantity]), updatedAt: at });
      }
      if (hooks.afterCommitMovements) await hooks.afterCommitMovements(trx, order);
      await trx('EventOrder').where({ id: orderId }).update({ status: 'confirmed', holdExpiresAt: null, confirmedAt: at, updatedAt: at });
      const registrations = (await trx('EventRegistration').where({ orderId }).whereIn('status', ['draft', 'reserved'])
        .update({ status: 'confirmed', updatedAt: at }).returning('*')).map(plain);
      const organizerId = await organizerOf(trx, order.eventId);
      for (const reg of registrations) {
        await appendOutbox(trx, {
          type: 'registration.created', aggregateType: 'registration', aggregateId: reg.id, organizerId, eventId: order.eventId,
          payload: { registrationId: reg.id, orderId, eventId: order.eventId, categoryId: reg.categoryId, ticketTypeId: reg.ticketTypeId, status: reg.status },
        });
      }
      return { ...(await loadOrder(trx, orderId)), changed: true };
    });
  }

  /** The release itself, under the caller's row lock on the order. `cancelReason` (S3) is the person's own reason, stored on the registrations; the order keeps the store reason. */
  async function releaseInTrx(trx, order, to, reason, at, cancelReason = null) {
    const cycle = order.holdCycle;
    const lines = (await trx('EventOrderLine').where({ orderId: order.id }).orderBy('ticketTypeId')).map(plain);
    for (const line of lines) {
      const inserted = await trx('EventInventoryMovement').insert({
        id: newId('eim'), ticketTypeId: line.ticketTypeId, orderId: order.id, kind: 'release', quantity: line.quantity, cycle,
        movementKey: movementKeyOf(order.id, cycle, 'release', line.ticketTypeId), createdAt: at,
      }).onConflict('movementKey').ignore().returning('id');
      if (!inserted.length) continue;
      await trx('EventTicketType').where({ id: line.ticketTypeId }).update({ held: trx.raw('held - ?', [line.quantity]), updatedAt: at });
    }
    await trx('EventOrder').where({ id: order.id }).update({ status: to, holdExpiresAt: null, closedAt: at, closeReason: reason, updatedAt: at });
    const registrations = (await trx('EventRegistration').where({ orderId: order.id }).whereIn('status', ['draft', 'reserved'])
      .update({ status: 'cancelled', cancelledAt: at, cancelReason: cancelReason ?? reason, updatedAt: at }).returning('*')).map(plain);
    const organizerId = await organizerOf(trx, order.eventId);
    for (const reg of registrations) {
      await appendOutbox(trx, {
        type: 'registration.cancelled', aggregateType: 'registration', aggregateId: reg.id, organizerId, eventId: order.eventId,
        payload: { registrationId: reg.id, orderId: order.id, eventId: order.eventId, status: 'cancelled', reason },
      });
    }
    return { ...(await loadOrder(trx, order.id)), changed: true };
  }

  /**
   * S3 (§3.8, D17): one place out of an unpaid order. Under FOR UPDATE on the order and the line's ticket type:
   * held − 1, one release movement of quantity 1 keyed `${orderId}:${cycle}:release:${ticketTypeId}:${registrationId}`,
   * the line's quantity − 1 with its money re-derived from the price snapshot (same discount per unit, fee rule
   * re-applied), order totals updated, the registration cancelled with `cancelReason`, one registration.cancelled
   * outbox row. Refused: order_not_found 404, registration_not_found 404 (not in this order), invalid_transition 409
   * (order not awaiting payment), already_closed → { changed: false } (the registration is not reserved any more),
   * remove_whole_line 409 (the last place of a line while other lines remain — cancel the whole order instead).
   * The last live place of the whole order is also refused with remove_whole_line: callers use releaseOrder.
   */
  async function releaseRegistration(orderId, registrationId, reason = 'cancelled', { cancelReason = null } = {}) {
    if (!RELEASE_REASONS.includes(reason) || reason === 'expired') return fail('invalid_reason', 400, { reason, allowed: RELEASE_REASONS.filter(r => r !== 'expired') });
    try {
      return await db.transaction(async (trx) => {
        const order = plain(await trx('EventOrder').where({ id: orderId }).forUpdate().first());
        if (!order) throw refusal('order_not_found', 404);
        const reg = plain(await trx('EventRegistration').where({ id: registrationId, orderId }).first());
        if (!reg) throw refusal('registration_not_found', 404);
        if (order.status !== 'awaiting_payment') throw refusal('invalid_transition', 409, { kind: 'order', from: order.status, to: 'cancelled', allowed: [], reason: 'not_awaiting_payment', orderId });
        if (reg.status !== 'reserved') return { ...(await loadOrder(trx, orderId)), changed: false };
        const lines = (await trx('EventOrderLine').where({ orderId }).orderBy('ticketTypeId')).map(plain);
        const line = lines.find(l => l.id === reg.orderLineId);
        if (!line) throw refusal('registration_not_found', 404);
        // A line is only ever reduced, never emptied (quantity > 0, registrations RESTRICT the line).
        if (line.quantity <= 1) throw refusal('remove_whole_line', 409, { ticketTypeId: line.ticketTypeId, orderId });
        await trx('EventTicketType').where({ id: line.ticketTypeId }).forUpdate().first();
        const at = now();
        const cycle = order.holdCycle;
        const inserted = await trx('EventInventoryMovement').insert({
          id: newId('eim'), ticketTypeId: line.ticketTypeId, orderId, kind: 'release', quantity: 1, cycle,
          movementKey: movementKeyOf(orderId, cycle, 'release', line.ticketTypeId, registrationId), createdAt: at,
        }).onConflict('movementKey').ignore().returning('id');
        if (!inserted.length) return { ...(await loadOrder(trx, orderId)), changed: false };
        await trx('EventTicketType').where({ id: line.ticketTypeId }).update({ held: trx.raw('held - 1'), updatedAt: at });
        // Re-price every line from the snapshot with this line one place shorter; the per-unit discount is kept.
        const snapshot = typeof order.priceSnapshot === 'string' ? JSON.parse(order.priceSnapshot) : order.priceSnapshot;
        const perUnitDiscount = line.discountTzs / line.quantity;
        const repriced = quoteLines(snapshot.ticketTypes, lines.map(l => (l.id === line.id
          ? { ticketTypeId: l.ticketTypeId, quantity: l.quantity - 1, discountTzs: Math.round(perUnitDiscount * (l.quantity - 1)) }
          : { ticketTypeId: l.ticketTypeId, quantity: l.quantity, discountTzs: l.discountTzs })), { feeRule: snapshot.feeRule });
        if (repriced.error) throw refusal(repriced.error, repriced.status, repriced);
        for (const q of repriced.lines) {
          const current = lines.find(l => l.ticketTypeId === q.ticketTypeId);
          await trx('EventOrderLine').where({ id: current.id }).update({ quantity: q.quantity, discountTzs: q.discountTzs, feesTzs: q.feesTzs, lineTotalTzs: q.lineTotalTzs });
        }
        await trx('EventOrder').where({ id: orderId }).update({ subtotalTzs: repriced.subtotalTzs, discountTzs: repriced.discountTzs, feesTzs: repriced.feesTzs, totalTzs: repriced.totalTzs, updatedAt: at });
        await trx('EventRegistration').where({ id: registrationId }).update({ status: 'cancelled', cancelledAt: at, cancelReason: cancelReason ?? reason, updatedAt: at });
        await appendOutbox(trx, {
          type: 'registration.cancelled', aggregateType: 'registration', aggregateId: registrationId, organizerId: await organizerOf(trx, order.eventId), eventId: order.eventId,
          payload: { registrationId, orderId, eventId: order.eventId, status: 'cancelled', reason },
        });
        return { ...(await loadOrder(trx, orderId)), changed: true };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      if (err.code === CHECK_VIOLATION) return fail('invalid_transition', 409, { constraint: err.constraint ?? null });
      throw err;
    }
  }

  /**
   * Give an unpaid order's places back. `reason` is one of RELEASE_REASONS: 'expired' (the hold lapsed)
   * makes the order expired, 'cancelled' / 'payment_failed' / 'admin' make it cancelled; anything else is
   * invalid_reason. Only an order awaiting payment can be released; a confirmed order's places are sold and
   * go back through the refund flow (invalid_transition). A second call changes nothing.
   */
  async function releaseOrder(orderId, reason = 'cancelled', { cancelReason = null } = {}) {
    if (!RELEASE_REASONS.includes(reason)) return fail('invalid_reason', 400, { reason, allowed: [...RELEASE_REASONS] });
    const to = reason === 'expired' ? 'expired' : 'cancelled';
    return db.transaction(async (trx) => {
      const order = plain(await trx('EventOrder').where({ id: orderId }).forUpdate().first());
      if (!order) return fail('order_not_found', 404);
      if (['expired', 'cancelled'].includes(order.status)) return { ...(await loadOrder(trx, orderId)), changed: false };
      if (order.status !== 'awaiting_payment') {
        return { error: 'invalid_transition', status: 409, kind: 'order', from: order.status, to, allowed: [], reason: 'inventory_committed', orderId };
      }
      return releaseInTrx(trx, order, to, reason, now(), cancelReason);
    });
  }

  /**
   * Release every awaiting_payment order whose hold lapsed before `at`. Each order in its own transaction
   * under FOR UPDATE SKIP LOCKED, so a concurrent run (or a payment confirming at that moment) simply
   * skips it. Safe to rerun: an order is released once. → { due, released, skipped }.
   */
  async function expireHolds({ at = now(), limit = 200 } = {}) {
    const due = await db('EventOrder').where({ status: 'awaiting_payment' }).where('holdExpiresAt', '<', at).orderBy('holdExpiresAt').limit(limit).select('id');
    let released = 0;
    let skipped = 0;
    for (const { id } of due) {
      const done = await db.transaction(async (trx) => {
        const order = plain(await trx('EventOrder').where({ id, status: 'awaiting_payment' }).where('holdExpiresAt', '<', at).forUpdate().skipLocked().first());
        if (!order) return false;
        return releaseInTrx(trx, order, 'expired', 'expired', now());
      });
      if (done) {
        released += 1;
        // S3: after the commit, tell the purchaser (notification 2) — a failure here never undoes the release.
        if (hooks.afterExpire) { try { await hooks.afterExpire(done); } catch (err) { console.warn('[events] afterExpire hook failed:', err?.message); } }
      } else skipped += 1;
    }
    return { due: due.length, released, skipped };
  }

  /** The inventory ledger of one order, oldest first. */
  const movementsOf = async orderId => (await db('EventInventoryMovement').where({ orderId }).orderBy(['createdAt', 'movementKey'])).map(plain);

  return {
    createOrganizer, getOrganizer, updateOrganizer, transitionOrganizer,
    createEvent, getEvent, updateEvent, transitionEvent, createCategory, createTicketType, getTicketType, updateTicketType,
    appendOutbox, createOrderWithHolds, replayOrder, getOrder, commitOrder, releaseOrder, releaseRegistration, expireHolds, movementsOf, holdTtlMinutes,
  };
}
