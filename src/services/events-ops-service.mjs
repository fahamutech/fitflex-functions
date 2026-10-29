// Marathon & running events · S5 — venue operations (spec §4, §6): ticket verification, kit handover, corrections,
// bib numbers (single, bulk, CSV), manual lookup, the desk summary. One service behind two front doors: the portal
// routes (a signed-in organizer staff user) and the /v1 routes (an API client). The caller is an `actor`:
//   { kind: 'staff', userId, role }            role from EventOrganizerStaff (owner | admin | ops | timing | finance)
//   { kind: 'api', clientId, scopes }          scopes read from the ApiClient row on this very request
// Role and scope are checked HERE as well as in the route guard (least privilege, spec §2).
//
// Rules this file owns:
//  - Verification never writes except an audit row for failures; the write path re-resolves the payload itself.
//  - One handover per registration is a DATABASE fact (eventkitcollection_collected_unique); the application check
//    runs under the registration row lock so the loser of a race gets 409 already_collected, never a 500.
//  - Bib numbers are unique across the whole event (D40): eventbibassignment_live_event_bib_unique.
//  - Every write is idempotent through OrganizerIdempotency (spec §6) and appends its outbox row in the same transaction.
//  - Organizers never receive phone, email, date of birth, gender or emergency contact here (D36, D37).
import { randomUUID } from 'node:crypto';
import { parseToken, verifyToken, sha256hex, QR_PREFIX } from '../shared/events-ticket-token.mjs';
import { kitStateOf, KIT_OPEN_STATUSES, insideWindows } from '../shared/events-kit-view.mjs';
import {
  normaliseBib, cardName, encodeCursor, decodeCursor, parseLimit, fingerprintOf, idempotencyKeyValid, parseCsv, neutralise, bulkNumbers,
  MANUAL_REASONS, REVOKE_REASONS, BULK_MAX, sha256hex as sha, BIB_RE,
} from '../shared/events-ops-rules.mjs';

const UNIQUE = '23505';
const KIT_SIZES = ['xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl'];
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v ? new Date(v).toISOString() : null);
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const refusal = (error, status, extra) => Object.assign(new Error(error), { refusal: fail(error, status, extra) });

export const STAFF_KIT_ROLES = Object.freeze(['owner', 'admin', 'ops']);
export const STAFF_OVERRIDE_ROLES = Object.freeze(['owner', 'admin']);

const actorKey = a => (a.kind === 'api' ? `api:${a.clientId}` : a.userId);
const canCollect = a => (a.kind === 'api' ? a.scopes?.includes('kit:write') : STAFF_KIT_ROLES.includes(a.role));
const canOverride = a => a.kind === 'staff' && STAFF_OVERRIDE_ROLES.includes(a.role);
const canAssign = a => (a.kind === 'api' ? a.scopes?.includes('bibs:write') : STAFF_KIT_ROLES.includes(a.role));
const canReplaceBib = a => (a.kind === 'api' ? a.scopes?.includes('bibs:write') : STAFF_OVERRIDE_ROLES.includes(a.role));

export function createEventsOpsService({ db, eventStore, ticketRing = () => null, notify = async () => {}, localeOf = async () => null, now = () => new Date(), kitOpsOn = () => true }) {
  const stamp = () => new Date(now());
  const verifyFailLog = new Map();

  // The request id (spec §6) rides along in `after.requestId` when the caller is an actor object that carries one. Never a secret or a payload.
  const audit = (actor, action, target, before, after, trx = db) => trx('AuditLog').insert({
    id: `aud_${randomUUID().slice(0, 12)}`, at: stamp(), actor: typeof actor === 'string' ? actor : actorKey(actor), action, target,
    before: before == null ? null : JSON.stringify(before),
    after: after == null ? null : JSON.stringify(typeof actor !== 'string' && actor.requestId ? { ...after, requestId: actor.requestId } : after),
  });
  const outbox = (trx, event, type, aggregateId, payload) => eventStore.appendOutbox(trx, { type, aggregateType: 'registration', aggregateId, organizerId: event.organizerId, eventId: event.id, payload });
  /** M3: many outbox rows in ONE multi-row INSERT (up to 5,000 x 9 columns, under the 65,535 parameter limit), the LAST statement before commit, so the sequence lock is held briefly. */
  const outboxMany = (trx, event, type, payloads) => (payloads.length
    ? trx('OutboxEvent').insert(payloads.map(payload => ({ id: newId('obx'), type, aggregateType: 'registration', aggregateId: payload.registrationId, organizerId: event.organizerId, eventId: event.id, payload: JSON.stringify(payload), version: '1', createdAt: stamp() })))
    : Promise.resolve());
  const analytics = async (name, payload) => { try { await audit('system', `analytics.${name}`, payload.eventId ?? 'events', null, payload); } catch { /* best effort */ } };

  const eventOf = async (organizerId, eventId) => plain(await db('Event').where({ id: String(eventId), organizerId }).first());

  // ── Idempotency (spec §6) ─────────────────────────────────────────────────

  /** Run `work` once per (caller, key, route). 2xx answers are stored and replayed (as 200 + replayed); anything else releases the key. */
  async function idempotent({ actor, route, key, body }, work) {
    if (key === undefined || key === null || key === '') return fail('idempotency_key_required', 400);
    if (!idempotencyKeyValid(key)) return fail('invalid_idempotency_key', 400);
    const scopeType = actor.kind === 'api' ? 'api' : 'staff';
    const scopeId = actor.kind === 'api' ? actor.clientId : actor.userId;
    const fingerprint = fingerprintOf(body);
    const at = stamp();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const id = newId('oid');
      const inserted = await db('OrganizerIdempotency').insert({ id, scopeType, scopeId, key, route, fingerprint, state: 'in_progress', createdAt: at, expiresAt: new Date(+at + 7 * 86_400_000) })
        .onConflict(['scopeType', 'scopeId', 'key', 'route']).ignore().returning('id');
      if (inserted.length) {
        let result;
        try { result = await work(); } catch (err) { await db('OrganizerIdempotency').where({ id }).del(); throw err; }
        if (!result || result.error || (Number.isInteger(result.status) && result.status >= 300)) { await db('OrganizerIdempotency').where({ id }).del(); return result; }
        const { status = 200, ...payload } = result;
        await db('OrganizerIdempotency').where({ id }).update({ state: 'done', status, response: JSON.stringify(payload) });
        return result;
      }
      const row = plain(await db('OrganizerIdempotency').where({ scopeType, scopeId, key, route }).first());
      if (!row) continue;
      if (row.fingerprint !== fingerprint) return fail('idempotency_key_reused', 409);
      if (row.state === 'done') return { ...row.response, status: 200, replayed: true };
      // A first attempt that died mid-flight must not block the key for a week.
      if (+at - +new Date(row.createdAt) > 60_000) { await db('OrganizerIdempotency').where({ id: row.id, state: 'in_progress' }).del(); continue; }
      return fail('request_in_progress', 409);
    }
    return fail('request_in_progress', 409);
  }

  // ── Cards ─────────────────────────────────────────────────────────────────

  /** Batch-load what the masked cards of `regs` (same event) need. */
  async function cardContext(event, regs) {
    const ids = regs.map(r => r.id);
    const [cats, types, tickets, teams, collected, bibs] = await Promise.all([
      db('EventCategory').where({ eventId: event.id }).select('id', 'name', 'distanceMeters'),
      db('EventTicketType').where({ eventId: event.id }).select('id', 'name'),
      ids.length ? db('EventTicket').whereIn('registrationId', ids).orderBy([{ column: 'issuedAt', order: 'desc' }, { column: 'id', order: 'desc' }]) : [],
      ids.length ? db('EventTeamMember as m').join('EventTeam as t', 't.id', 'm.teamId').whereIn('m.registrationId', ids).select('m.registrationId', 't.name') : [],
      ids.length ? db('EventKitCollection').whereIn('registrationId', ids).where({ status: 'collected' }) : [],
      ids.length ? db('EventBibAssignment').whereIn('registrationId', ids).whereNull('releasedAt').select('id', 'registrationId', 'assignedAt') : [],
    ]);
    const pointIds = [...new Set(collected.map(c => c.collectionPointId).filter(Boolean))];
    const staffIds = [...new Set(collected.map(c => c.staffUserId).filter(Boolean))];
    const [points, staff] = await Promise.all([
      pointIds.length ? db('EventCollectionPoint').whereIn('id', pointIds).select('id', 'name') : [],
      staffIds.length ? db('User').whereIn('id', staffIds).select('id', 'displayName') : [],
    ]);
    const ticketBy = new Map();
    for (const t of tickets) if (!ticketBy.has(t.registrationId) || t.status === 'active') ticketBy.set(t.registrationId, plain(t));
    return {
      cats: new Map(cats.map(c => [c.id, plain(c)])), types: new Map(types.map(t => [t.id, t.name])), ticketBy,
      teamBy: new Map(teams.map(t => [t.registrationId, t.name])),
      collectedBy: new Map(collected.map(c => [c.registrationId, plain(c)])),
      pointName: new Map(points.map(p => [p.id, p.name])),
      staffFirst: new Map(staff.map(s => [s.id, String(s.displayName ?? '').trim().split(/\s+/)[0] || null])),
      bibAssignedAt: new Map(bibs.map(b => [b.registrationId, b.assignedAt])),
      bibAssignmentId: new Map(bibs.map(b => [b.registrationId, b.id])),
    };
  }

  const paymentOf = r => (r.status === 'confirmed' ? 'paid' : r.status === 'refunded' || Number(r.refundedTzs) > 0 ? 'refunded' : 'unpaid');

  function cardOf(event, r, c) {
    const ticket = c.ticketBy.get(r.id) ?? null;
    const taken = c.collectedBy.get(r.id) ?? null;
    const cat = c.cats.get(r.categoryId);
    const kit = { state: kitStateOf({ reg: r, hasActiveTicket: ticket?.status === 'active', event }) };
    if (taken) { kit.collectedAt = iso(taken.collectedAt); kit.collectionPointName = c.pointName.get(taken.collectionPointId) ?? null; }
    return {
      displayName: cardName(r.firstName, r.lastName), assignmentId: c.bibAssignmentId.get(r.id) ?? null, ticketCode: ticket?.displayCode ?? null, categoryName: cat?.name ?? null, distanceM: cat ? Number(cat.distanceMeters) : null,
      ticketTypeName: c.types.get(r.ticketTypeId) ?? null, teamName: c.teamBy.get(r.id) ?? null, bibNumber: r.bibNumber ?? null, kitSize: r.kitSize ?? null, kit, payment: paymentOf(r),
    };
  }

  function warningsOf(event, r, c, { point = null, at = stamp() } = {}) {
    const w = [];
    if (!r.bibNumber) w.push('bib_missing');
    if (event.kitProvided === true && !r.kitSize) w.push('kit_size_missing');
    if (point && !insideWindows(point.openingWindows, at)) w.push('outside_collection_window');
    const taken = c.collectedBy.get(r.id);
    const assigned = c.bibAssignedAt.get(r.id);
    if (taken && assigned && +new Date(assigned) > +new Date(taken.collectedAt)) w.push('bib_changed_after_collection');
    if (!r.participantUserId && r.consentBasis !== 'self') w.push('claim_pending');
    return w;
  }

  // ── Resolving a payload (shared by verify and the kit write) ──────────────

  /** → { outcome: 'not_event_ticket' | 'invalid_payload' | 'tickets_unavailable' } | { outcome: 'unknown' | 'wrong_event' | 'revoked' | 'ok', reg?, ticket?, ... } */
  async function resolvePayload(organizerId, event, payload) {
    if (typeof payload !== 'string' || !payload.trim() || payload.length > 200) return { outcome: 'invalid_payload' };
    const parts = parseToken(payload);
    if (!parts) return { outcome: 'not_event_ticket' };
    const ring = ticketRing();
    if (!ring) return { outcome: 'tickets_unavailable' };
    const token = payload.trim().startsWith(QR_PREFIX) ? payload.trim().slice(QR_PREFIX.length) : payload.trim();
    const ticket = plain(await db('EventTicket').where({ tokenHash: sha256hex(token) }).first());
    if (!ticket) return { outcome: 'unknown' };
    const reg = plain(await db('EventRegistration').where({ id: ticket.registrationId }).first());
    if (!reg || !verifyToken(ring, token, { registrationId: reg.id, eventId: reg.eventId })) return { outcome: 'unknown', integrity: true, ticketId: ticket.id };
    if (reg.eventId !== event.id) {
      // Another event of the SAME organizer is told apart; another organizer's ticket is just unknown (spec §4.1, scenario 19).
      const other = plain(await db('Event').where({ id: reg.eventId }).first('organizerId', 'title'));
      return other && other.organizerId === organizerId ? { outcome: 'wrong_event', otherEvent: { title: other.title } } : { outcome: 'unknown' };
    }
    if (ticket.status !== 'active' || reg.status !== 'confirmed') {
      const reason = ticket.status === 'revoked' ? (REVOKE_REASONS.includes(ticket.revokeReason) ? ticket.revokeReason : 'admin') : reg.status === 'refunded' ? 'refunded' : 'cancelled';
      return { outcome: 'revoked', reason, reg, ticket };
    }
    return { outcome: 'ok', reg, ticket };
  }

  function noteFailure(actor, event, outcome, extra = {}) {
    const k = `${actorKey(actor)}:${outcome}`;
    const t = +stamp();
    if (t - (verifyFailLog.get(k) ?? 0) < 60_000) return;
    if (verifyFailLog.size > 5000) verifyFailLog.clear();
    verifyFailLog.set(k, t);
    audit(actor, extra.integrity ? 'events.ticket_integrity_failed' : 'events.ticket_verify_failed', event.id, null, { outcome }).catch(() => {});
  }

  // ── Verify ────────────────────────────────────────────────────────────────

  async function verifyTicket({ actor, organizerId, eventId, body = {} }) {
    if (!canCollect(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    const r = await resolvePayload(organizerId, event, body.payload);
    if (r.outcome === 'invalid_payload') return fail('invalid_payload', 400);
    if (r.outcome === 'not_event_ticket') return fail('not_event_ticket', 400);
    if (r.outcome === 'tickets_unavailable') return fail('tickets_unavailable', 503);
    if (r.outcome === 'unknown') { noteFailure(actor, event, 'unknown', r); return { result: 'unknown', warnings: [], canCollect: false, canOverride: false }; }
    if (r.outcome === 'wrong_event') { noteFailure(actor, event, 'wrong_event'); return { result: 'wrong_event', otherEvent: r.otherEvent, warnings: [], canCollect: false, canOverride: false }; }
    const c = await cardContext(event, [r.reg]);
    const card = cardOf(event, r.reg, c);
    if (r.outcome === 'revoked') {
      noteFailure(actor, event, 'revoked');
      return { result: 'revoked', registrationId: r.reg.id, card, revokedReason: r.reason, warnings: [], canCollect: false, canOverride: false };
    }
    let point = null;
    if (body.collectionPointId) point = plain(await db('EventCollectionPoint').where({ id: String(body.collectionPointId), eventId: event.id }).first());
    const taken = c.collectedBy.get(r.reg.id);
    if (taken) {
      return {
        result: 'already_collected', registrationId: r.reg.id, card, warnings: warningsOf(event, r.reg, c, { point }),
        collectionId: taken.id, collectedAt: iso(taken.collectedAt), collectionPointName: c.pointName.get(taken.collectionPointId) ?? null, byFirstName: c.staffFirst.get(taken.staffUserId) ?? null,
        canCollect: false, canOverride: canOverride(actor),
      };
    }
    return { result: 'valid', registrationId: r.reg.id, card, warnings: warningsOf(event, r.reg, c, { point }), canCollect: canCollect(actor) && KIT_OPEN_STATUSES.includes(event.status), canOverride: false };
  }

  // ── Kit handover ──────────────────────────────────────────────────────────

  const alreadyCollected = async (event, regId, actor) => {
    const taken = plain(await db('EventKitCollection').where({ registrationId: regId, status: 'collected' }).first());
    const point = taken?.collectionPointId ? plain(await db('EventCollectionPoint').where({ id: taken.collectionPointId }).first('name')) : null;
    const who = taken?.staffUserId ? plain(await db('User').where({ id: taken.staffUserId }).first('displayName')) : null;
    return fail('already_collected', 409, { collectionId: taken?.id ?? null, collectedAt: iso(taken?.collectedAt), collectionPointName: point?.name ?? null, byFirstName: String(who?.displayName ?? '').trim().split(/\s+/)[0] || null, canOverride: canOverride(actor) });
  };

  function parseKitBody(body, event, activePoints) {
    const method = body.method;
    if (!['scan', 'manual'].includes(method)) return fail('validation_failed', 422, { fields: [{ path: 'method', code: 'invalid' }] });
    const status = body.status === undefined ? 'collected' : body.status;
    if (!['collected', 'exception'].includes(status)) return fail('validation_failed', 422, { fields: [{ path: 'status', code: 'invalid' }] });
    const note = text(body.note, 300);
    if (body.note !== undefined && body.note !== null && typeof body.note === 'string' && body.note.trim().length > 300) return fail('validation_failed', 422, { fields: [{ path: 'note', code: 'tooLong' }] });
    if (status === 'exception' && !note) return fail('note_required', 422);
    if (method === 'scan' && typeof body.payload !== 'string') return fail('validation_failed', 422, { fields: [{ path: 'payload', code: 'required' }] });
    if (method === 'manual') {
      if (typeof body.registrationId !== 'string' || !body.registrationId) return fail('validation_failed', 422, { fields: [{ path: 'registrationId', code: 'required' }] });
      if (!MANUAL_REASONS.includes(body.manualReason)) return fail('manual_reason_required', 422, { allowed: [...MANUAL_REASONS] });
    }
    if (activePoints.length && !body.collectionPointId) return fail('collection_point_required', 422);
    if (body.collectionPointId && !activePoints.some(p => p.id === String(body.collectionPointId))) return fail('collection_point_invalid', 422);
    let kitSize = null;
    if (body.kitSize !== undefined && body.kitSize !== null) {
      kitSize = String(body.kitSize).trim().toLowerCase();
      if (!KIT_SIZES.includes(kitSize)) return fail('validation_failed', 422, { fields: [{ path: 'kitSize', code: 'invalid' }] });
    }
    let bibNumber = null;
    if (body.bibNumber !== undefined && body.bibNumber !== null && body.bibNumber !== '') {
      bibNumber = normaliseBib(body.bibNumber);
      if (!bibNumber) return fail('bib_invalid', 422);
    }
    return { method, status, note, kitSize, bibNumber, manualReason: method === 'manual' ? body.manualReason : null, collectionPointId: body.collectionPointId ? String(body.collectionPointId) : null };
  }

  /** POST …/kit-collections — see the header of this file for the rules. */
  async function collectKit({ actor, organizerId, eventId, key, body = {} }) {
    if (!canCollect(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    return idempotent({ actor, route: `POST kit-collections|${event.id}`, key, body }, async () => {
      if (event.status === 'cancelled') return fail('event_cancelled', 409);
      if (!KIT_OPEN_STATUSES.includes(event.status)) return fail('event_not_open', 409, { eventStatus: event.status });
      const points = (await db('EventCollectionPoint').where({ eventId: event.id, status: 'active' }).select('id')).map(plain);
      const parsed = parseKitBody(body, event, points);
      if (parsed.error) return parsed;

      let reg; let ticket;
      if (parsed.method === 'scan') {
        const r = await resolvePayload(organizerId, event, body.payload);
        if (r.outcome === 'invalid_payload') return fail('invalid_payload', 400);
        if (r.outcome === 'not_event_ticket') return fail('not_event_ticket', 400);
        if (r.outcome === 'tickets_unavailable') return fail('tickets_unavailable', 503);
        if (r.outcome === 'unknown' || r.outcome === 'wrong_event') return fail('registration_not_found', 404);
        if (r.outcome === 'revoked') return fail('ticket_revoked', 409, { reason: r.reason });
        ({ reg, ticket } = r);
      } else {
        reg = plain(await db('EventRegistration').where({ id: String(body.registrationId), eventId: event.id }).first());
        if (!reg) return fail('registration_not_found', 404);
        if (['draft', 'reserved'].includes(reg.status)) return fail('registration_unpaid', 409);
        const tickets = await db('EventTicket').where({ registrationId: reg.id }).orderBy('issuedAt', 'desc');
        ticket = plain(tickets.find(t => t.status === 'active') ?? null);
        if (reg.status !== 'confirmed' || !ticket) return tickets.length ? fail('ticket_revoked', 409, { reason: reg.status === 'refunded' ? 'refunded' : 'cancelled' }) : fail('ticket_not_issued', 409);
      }

      let result;
      try {
        result = await db.transaction(async (trx) => {
          const locked = plain(await trx('EventRegistration').where({ id: reg.id, eventId: event.id }).forUpdate().first());
          const live = plain(await trx('EventTicket').where({ registrationId: reg.id, status: 'active' }).first('id'));
          if (!locked || locked.status !== 'confirmed' || !live) throw refusal('ticket_revoked', 409, { reason: 'cancelled' });
          const existing = await trx('EventKitCollection').where({ registrationId: reg.id, status: 'collected' }).first('id');
          if (existing) throw refusal('already_collected', 409);
          const at = stamp();
          const id = newId('ekc');
          await trx('EventKitCollection').insert({
            id, registrationId: reg.id, eventId: event.id, collectionPointId: parsed.collectionPointId, status: parsed.status, collectedAt: at,
            staffUserId: actor.kind === 'staff' ? actor.userId : null, apiClientId: actor.kind === 'api' ? actor.clientId : null,
            bibNumber: locked.bibNumber ?? null, kitSize: parsed.kitSize ?? locked.kitSize ?? null, method: actor.kind === 'api' ? 'api' : parsed.method,
            manualReason: parsed.manualReason, note: parsed.note, createdAt: at,
          });
          const patch = { kitStatus: parsed.status, updatedAt: at };
          const warnings = [];
          if (parsed.kitSize) { if (!locked.kitSize) patch.kitSize = parsed.kitSize; else if (locked.kitSize !== parsed.kitSize) warnings.push('kit_size_differs'); }
          await trx('EventRegistration').where({ id: reg.id }).update(patch);
          let bib = null;
          if (parsed.bibNumber && !locked.bibNumber) {
            if (!canAssign(actor)) throw refusal('forbidden_role', 403);
            bib = await assignBibTx(trx, { event, reg: locked, bibNumber: parsed.bibNumber, actor, replace: false, reason: null, at });
          } else if (parsed.bibNumber && locked.bibNumber && locked.bibNumber !== parsed.bibNumber) warnings.push('bib_differs');
          if (parsed.status === 'collected') {
            await outbox(trx, event, 'kit.collected', reg.id, { registrationId: reg.id, collectionPointId: parsed.collectionPointId, collectedAt: at });
            await audit(actor, parsed.method === 'manual' ? 'events.kit_manual_collected' : 'events.kit_collected', event.id, null, { registrationId: reg.id, collectionId: id, method: parsed.method, ...(parsed.manualReason ? { manualReason: parsed.manualReason } : {}) }, trx);
          } else {
            await audit(actor, 'events.kit_exception_recorded', event.id, null, { registrationId: reg.id, collectionId: id }, trx);
          }
          return { id, at, bib, warnings };
        });
      } catch (err) {
        if (err.refusal) return err.refusal.error === 'already_collected' ? alreadyCollected(event, reg.id, actor) : err.refusal;
        if (err.code === UNIQUE && /collected_unique/.test(err.constraint ?? '')) return alreadyCollected(event, reg.id, actor);
        if (err.code === UNIQUE && /bib/.test(err.constraint ?? '')) return fail('bib_taken', 409);
        throw err;
      }
      const fresh = plain(await db('EventRegistration').where({ id: reg.id }).first());
      const c = await cardContext(event, [fresh]);
      if (parsed.status === 'collected') {
        noticeKit(event, fresh).catch(() => {});
        if (result.bib?.assignment) noticeBib(event, fresh, result.bib.assignment.bibNumber).catch(() => {});
      }
      await analytics('kit_collected', { eventId: event.id, categoryId: fresh.categoryId, method: actor.kind === 'api' ? 'api' : parsed.method, collectionPointId: parsed.collectionPointId });
      return {
        status: 201, collection: { id: result.id, status: parsed.status, collectedAt: iso(result.at), collectionPointId: parsed.collectionPointId },
        card: cardOf(event, fresh, c), warnings: result.warnings,
      };
    });
  }

  /** Owner/admin only: void a handover, or void it and record a new one. */
  async function correctKit({ actor, organizerId, eventId, collectionId, key, body = {} }) {
    if (!canOverride(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    return idempotent({ actor, route: `POST kit-collections/corrections|${event.id}|${collectionId}`, key, body }, async () => {
      if (!['void', 'recollect'].includes(body.action)) return fail('validation_failed', 422, { fields: [{ path: 'action', code: 'invalid' }] });
      const reason = text(body.reason, 300);
      if (!reason || reason.length < 10) return fail('reason_required', 422, { min: 10, max: 300 });
      const row = plain(await db('EventKitCollection').where({ id: String(collectionId), eventId: event.id }).first());
      if (!row) return fail('collection_not_found', 404);
      if (event.status === 'cancelled') return fail('event_cancelled', 409);
      if (!KIT_OPEN_STATUSES.includes(event.status)) return fail('event_not_open', 409, { eventStatus: event.status });
      try {
        return await db.transaction(async (trx) => {
          const reg = plain(await trx('EventRegistration').where({ id: row.registrationId, eventId: event.id }).forUpdate().first());
          const swapped = await trx('EventKitCollection').where({ id: row.id, status: 'collected' }).update({ status: 'exception' });
          if (!swapped) throw refusal('already_corrected', 409);
          const at = stamp();
          await trx('EventKitCollection').insert({
            id: newId('ekc'), registrationId: row.registrationId, eventId: event.id, collectionPointId: row.collectionPointId, status: 'corrected', collectedAt: at,
            staffUserId: actor.userId, bibNumber: row.bibNumber, kitSize: row.kitSize, method: 'manual', manualReason: 'other', note: reason,
            correctionReason: reason, supersedesId: row.id, createdAt: at,
          });
          let newRow = null;
          if (body.action === 'recollect') {
            newRow = newId('ekc');
            await trx('EventKitCollection').insert({
              id: newRow, registrationId: row.registrationId, eventId: event.id, collectionPointId: row.collectionPointId, status: 'collected', collectedAt: at,
              staffUserId: actor.userId, bibNumber: reg.bibNumber ?? null, kitSize: reg.kitSize ?? null, method: 'manual', manualReason: 'other', note: reason, createdAt: at,
            });
          }
          await trx('EventRegistration').where({ id: reg.id }).update({ kitStatus: body.action === 'recollect' ? 'collected' : 'ready', updatedAt: at });
          if (body.action === 'recollect') await outbox(trx, event, 'kit.collected', reg.id, { registrationId: reg.id, collectionPointId: row.collectionPointId, collectedAt: at });
          else await outbox(trx, event, 'registration.updated', reg.id, { registrationId: reg.id, changed: ['kit'] });
          await audit(actor, 'events.kit_corrected', event.id, { collectionId: row.id, status: 'collected' }, { action: body.action, reason, collectionId: row.id, registrationId: reg.id }, trx);
          return { status: 200, corrected: { collectionId: row.id, action: body.action, ...(newRow ? { newCollectionId: newRow } : {}) } };
        });
      } catch (err) {
        if (err.refusal) return err.refusal;
        if (err.code === UNIQUE) return fail('already_collected', 409);
        throw err;
      }
    });
  }

  async function kitHistory({ organizerId, eventId, query = {} }) {
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    const limit = parseLimit(query.limit, { dflt: 50, max: 200 });
    if (limit === null) return fail('invalid_limit', 400);
    let q = db('EventKitCollection as k').join('EventRegistration as r', 'r.id', 'k.registrationId').where('k.eventId', event.id);
    if (['collected', 'exception', 'corrected'].includes(query.status)) q = q.where('k.status', query.status);
    if (query.collectionPointId) q = q.where('k.collectionPointId', String(query.collectionPointId));
    if (query.cursor) {
      const cur = decodeCursor(query.cursor);
      if (!cur?.c || !cur?.i) return fail('invalid_cursor', 400);
      q = q.whereRaw('(k."collectedAt", k.id) < (?, ?)', [new Date(cur.c), String(cur.i)]);
    }
    const rows = await q.orderBy([{ column: 'k.collectedAt', order: 'desc' }, { column: 'k.id', order: 'desc' }]).limit(limit + 1)
      .select('k.*', 'r.firstName', 'r.lastName', 'r.bibNumber as regBib');
    const page = rows.slice(0, limit).map(plain);
    const pointIds = [...new Set(page.map(k => k.collectionPointId).filter(Boolean))];
    const staffIds = [...new Set(page.map(k => k.staffUserId).filter(Boolean))];
    const points = new Map(pointIds.length ? (await db('EventCollectionPoint').whereIn('id', pointIds).select('id', 'name')).map(p => [p.id, p.name]) : []);
    const staff = new Map(staffIds.length ? (await db('User').whereIn('id', staffIds).select('id', 'displayName')).map(u => [u.id, String(u.displayName ?? '').trim().split(/\s+/)[0] || null]) : []);
    const items = page.map(k => ({
      id: k.id, registrationId: k.registrationId, displayName: cardName(k.firstName, k.lastName), bibNumber: k.bibNumber ?? k.regBib ?? null, status: k.status, collectedAt: iso(k.collectedAt),
      collectionPointName: points.get(k.collectionPointId) ?? null, byFirstName: staff.get(k.staffUserId) ?? null, method: k.method,
      ...(k.manualReason ? { manualReason: k.manualReason } : {}), ...(k.correctionReason ? { correctionReason: k.correctionReason } : {}),
    }));
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ c: iso(last.collectedAt), i: last.id }) : null };
  }

  async function kitSummary({ organizerId, eventId }) {
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    const regs = await db('EventRegistration').where({ eventId: event.id, status: 'confirmed' }).groupBy('categoryId', 'kitStatus').select('categoryId', 'kitStatus').count({ n: '*' });
    const cats = new Map((await db('EventCategory').where({ eventId: event.id }).select('id', 'name')).map(c => [c.id, c.name]));
    const by = new Map();
    let confirmed = 0; let collected = 0; let exceptions = 0;
    for (const r of regs) {
      const n = Number(r.n);
      confirmed += n;
      if (r.kitStatus === 'collected') collected += n;
      if (r.kitStatus === 'exception') exceptions += n;
      const b = by.get(r.categoryId) ?? { categoryId: r.categoryId, name: cats.get(r.categoryId) ?? null, confirmed: 0, collected: 0 };
      b.confirmed += n; if (r.kitStatus === 'collected') b.collected += n;
      by.set(r.categoryId, b);
    }
    const perPoint = await db('EventKitCollection as k').leftJoin('EventCollectionPoint as p', 'p.id', 'k.collectionPointId').where({ 'k.eventId': event.id, 'k.status': 'collected' })
      .groupBy('k.collectionPointId', 'p.name').select('k.collectionPointId', 'p.name').count({ n: '*' });
    return {
      confirmed, collected, remaining: Math.max(confirmed - collected - exceptions, 0), exceptions, byCategory: [...by.values()],
      byCollectionPoint: perPoint.map(p => ({ collectionPointId: p.collectionPointId, name: p.name ?? null, collected: Number(p.n) })),
    };
  }

  // ── Notices ───────────────────────────────────────────────────────────────

  async function notice(userId, { id, type, en, sw, data }) {
    if (!userId) return;
    let locale = null;
    try { locale = await localeOf(userId); } catch { locale = null; }
    const t = locale === 'sw' ? sw : en;
    await notify(userId, { id: id.slice(0, 60), type, title: t.title, body: t.body, data: { ...data, locale: locale === 'sw' ? 'sw' : 'en', titleEn: en.title, bodyEn: en.body, titleSw: sw.title, bodySw: sw.body } });
  }
  const recipientOf = r => r.participantUserId ?? r.purchaserUserId ?? null;
  const ticketRoute = r => `/member/events/registrations/${r.id}/ticket`;

  const noticeKit = (event, r) => notice(recipientOf(r), {
    id: `ntf_evkit_${r.id}`, type: 'event_kit_collected',
    en: { title: 'Kit collected', body: `You collected your kit for ${event.title}.` }, sw: { title: 'Vifaa vimechukuliwa', body: `Umechukua vifaa vya mbio vya ${event.title}.` },
    data: { registrationId: r.id, eventId: event.id, route: ticketRoute(r) },
  });
  const noticeBib = (event, r, bibNumber) => notice(recipientOf(r), {
    id: `ntf_evbib_${r.id}_${bibNumber}`, type: 'event_bib_assigned',
    en: { title: 'Your bib number is ready', body: `Your bib for ${event.title} is ${bibNumber}.` }, sw: { title: 'Namba yako ya mbio iko tayari', body: `Namba yako ya ${event.title} ni ${bibNumber}.` },
    data: { registrationId: r.id, eventId: event.id, bibNumber, route: ticketRoute(r) },
  });
  /** Bulk and import: an inbox row each, NO push (a push storm of thousands is not wanted, spec §4.3). */
  async function inboxOnlyBibNotices(event, regs) {
    const locales = new Map();
    const localeFor = async (userId) => { if (!locales.has(userId)) { let l = null; try { l = await localeOf(userId); } catch { l = null; } locales.set(userId, l === 'sw' ? 'sw' : 'en'); } return locales.get(userId); };
    const rows = [];
    for (const r of regs.filter(x => recipientOf(x))) {
      const userId = recipientOf(r);
      const en = { title: 'Your bib number is ready', body: `Your bib for ${event.title} is ${r.bibNumber}.` };
      const sw = { title: 'Namba yako ya mbio iko tayari', body: `Namba yako ya ${event.title} ni ${r.bibNumber}.` };
      const t = (await localeFor(userId)) === 'sw' ? sw : en;   // the recipient's language at the top level, both kept in data (like notice())
      rows.push({
        id: `ntf_evbib_${r.id}_${r.bibNumber}`.slice(0, 60), userId, type: 'event_bib_assigned', title: t.title, body: t.body,
        data: JSON.stringify({ type: 'event_bib_assigned', registrationId: r.id, eventId: event.id, bibNumber: r.bibNumber, route: ticketRoute(r), locale: t === sw ? 'sw' : 'en', titleEn: en.title, bodyEn: en.body, titleSw: sw.title, bodySw: sw.body }),
      });
    }
    for (let i = 0; i < rows.length; i += 500) await db('Notification').insert(rows.slice(i, i + 500)).onConflict('id').ignore();
  }

  // ── Bib numbers ───────────────────────────────────────────────────────────

  /** Inside a transaction, with the registration row already locked. → { assignment, previous }. Throws refusals (bib_taken, bib_already_assigned, reason_required). */
  async function assignBibTx(trx, { event, reg, bibNumber, actor, replace, reason, at, silent = false }) {
    const live = plain(await trx('EventBibAssignment').where({ registrationId: reg.id }).whereNull('releasedAt').first());
    if (live && live.bibNumber === bibNumber) return { assignment: live, previous: live.bibNumber, unchanged: true };
    if (live && !replace) throw refusal('bib_already_assigned', 409, { current: live.bibNumber });
    if (live && !canReplaceBib(actor)) throw refusal('forbidden_role', 403);
    if (live && (!reason || reason.length < 10)) throw refusal('reason_required', 422, { min: 10, max: 300 });
    const holder = plain(await trx('EventBibAssignment').where({ eventId: event.id, bibNumber }).whereNull('releasedAt').first('registrationId'));
    if (holder) throw refusal('bib_taken', 409);
    if (live) await trx('EventBibAssignment').where({ id: live.id }).update({ releasedAt: at, reason });
    const id = newId('ebn');
    await trx('EventBibAssignment').insert({
      id, eventId: event.id, categoryId: reg.categoryId, registrationId: reg.id, bibNumber, assignedBy: actor.kind === 'staff' ? actor.userId : null,
      assignedByApiClientId: actor.kind === 'api' ? actor.clientId : null, assignedAt: at, reason: live ? reason : null, createdAt: at,
    });
    await trx('EventRegistration').where({ id: reg.id }).update({ bibNumber, updatedAt: at });
    if (!silent) {
      await outbox(trx, event, 'bib.assigned', reg.id, { registrationId: reg.id, eventId: event.id, categoryId: reg.categoryId, bibNumber, previousBibNumber: live?.bibNumber ?? null });
      await audit(actor, live ? 'events.bib_reassigned' : 'events.bib_assigned', event.id, live ? { bibNumber: live.bibNumber } : null, { registrationId: reg.id, bibNumber, ...(live ? { reason } : {}) }, trx);
    }
    return { assignment: { id, registrationId: reg.id, bibNumber, assignedAt: iso(at) }, previous: live?.bibNumber ?? null };
  }

  const bibErrors = err => {
    if (err.refusal) return err.refusal;
    if (err.code === UNIQUE && /live_(event_)?bib_unique/.test(err.constraint ?? '')) return fail('bib_taken', 409);
    if (err.code === UNIQUE && /live_registration_unique/.test(err.constraint ?? '')) return fail('bib_already_assigned', 409);
    return null;
  };

  async function assignBib({ actor, organizerId, eventId, key, body = {} }) {
    if (!canAssign(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    return idempotent({ actor, route: `POST bib-assignments|${event.id}`, key, body }, async () => {
      const bibNumber = normaliseBib(body.bibNumber);
      if (!bibNumber) return fail('bib_invalid', 422);
      if (typeof body.registrationId !== 'string' || !body.registrationId) return fail('validation_failed', 422, { fields: [{ path: 'registrationId', code: 'required' }] });
      if (event.status === 'cancelled') return fail('event_cancelled', 409);
      const reason = text(body.reason, 300);
      const reg0 = plain(await db('EventRegistration').where({ id: body.registrationId, eventId: event.id }).first());
      if (!reg0) return fail('registration_not_found', 404);
      if (reg0.status !== 'confirmed') return fail(['draft', 'reserved'].includes(reg0.status) ? 'registration_unpaid' : 'ticket_revoked', 409);
      const replace = body.replace === true;
      if (replace && !canReplaceBib(actor)) return fail('forbidden_role', 403);
      const at = stamp();
      try {
        const out = await db.transaction(async (trx) => {
          const reg = plain(await trx('EventRegistration').where({ id: reg0.id }).forUpdate().first());
          if (reg.status !== 'confirmed') throw refusal('ticket_revoked', 409);
          const done = await assignBibTx(trx, { event, reg, bibNumber, actor, replace, reason, at });
          const collected = await trx('EventKitCollection').where({ registrationId: reg.id, status: 'collected' }).first('id');
          return { ...done, warnings: collected && !done.unchanged ? ['bib_changed_after_collection'] : [] };
        });
        if (!out.unchanged) {
          const fresh = plain(await db('EventRegistration').where({ id: reg0.id }).first());
          noticeBib(event, fresh, bibNumber).catch(() => {});
          await analytics('bib_assigned', { eventId: event.id, mode: actor.kind === 'api' ? 'api' : 'single', count: 1 });
        }
        return { status: out.unchanged ? 200 : 201, assignment: out.assignment, previousBibNumber: out.previous, warnings: out.warnings };
      } catch (err) { const e = bibErrors(err); if (e) return e; throw err; }
    });
  }

  /** API batch: each item its own result, NOT atomic; the Idempotency-Key covers the whole batch. */
  async function assignBibBatch({ actor, organizerId, eventId, key, body = {} }) {
    if (!canAssign(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    return idempotent({ actor, route: `POST bib-assignments/batch|${event.id}`, key, body }, async () => {
      if (event.status === 'cancelled') return fail('event_cancelled', 409);
      const items = Array.isArray(body.items) ? body.items : null;
      if (!items || !items.length) return fail('validation_failed', 422, { fields: [{ path: 'items', code: 'required' }] });
      if (items.length > 500) return fail('payload_too_large', 413, { max: 500 });
      const results = [];
      for (const [i, it] of items.entries()) {
        const clientRef = typeof it?.clientRef === 'string' ? it.clientRef.slice(0, 100) : `#${i}`;
        const bibNumber = normaliseBib(it?.bibNumber);
        if (!bibNumber || typeof it?.registrationId !== 'string') { results.push({ clientRef, ok: false, error: bibNumber ? 'registration_not_found' : 'bib_invalid' }); continue; }
        const reg0 = plain(await db('EventRegistration').where({ id: it.registrationId, eventId: event.id }).first());
        if (!reg0) { results.push({ clientRef, ok: false, error: 'registration_not_found' }); continue; }
        if (reg0.status !== 'confirmed') { results.push({ clientRef, ok: false, error: 'registration_unpaid' }); continue; }
        try {
          const out = await db.transaction(async (trx) => {
            const reg = plain(await trx('EventRegistration').where({ id: reg0.id }).forUpdate().first());
            return assignBibTx(trx, { event, reg, bibNumber, actor, replace: false, reason: null, at: stamp() });
          });
          results.push({ clientRef, ok: true, bibNumber });
          if (!out.unchanged) noticeBib(event, reg0, bibNumber).catch(() => {});
        } catch (err) { const e = bibErrors(err); if (!e) throw err; results.push({ clientRef, ok: false, error: e.error }); }
      }
      await analytics('bib_assigned', { eventId: event.id, mode: 'api', count: results.filter(r => r.ok).length });
      return { status: 200, results };
    });
  }

  async function releaseBib({ actor, organizerId, eventId, assignmentId, key, body = {} }) {
    if (!canOverride(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    return idempotent({ actor, route: `POST bib-assignments/release|${event.id}|${assignmentId}`, key, body }, async () => {
      const reason = text(body.reason, 300);
      if (!reason || reason.length < 10) return fail('reason_required', 422, { min: 10, max: 300 });
      const row = plain(await db('EventBibAssignment').where({ id: String(assignmentId), eventId: event.id }).first());
      if (!row) return fail('assignment_not_found', 404);
      if (row.releasedAt) return fail('already_released', 409);
      return db.transaction(async (trx) => {
        const at = stamp();
        await trx('EventRegistration').where({ id: row.registrationId }).forUpdate().first('id');
        const freed = await trx('EventBibAssignment').where({ id: row.id }).whereNull('releasedAt').update({ releasedAt: at, reason });
        if (!freed) return fail('already_released', 409);
        await trx('EventRegistration').where({ id: row.registrationId }).update({ bibNumber: null, updatedAt: at });
        const collected = await trx('EventKitCollection').where({ registrationId: row.registrationId, status: 'collected' }).first('id');
        await outbox(trx, event, 'registration.updated', row.registrationId, { registrationId: row.registrationId, changed: ['bib'] });
        await audit(actor, 'events.bib_released', event.id, { bibNumber: row.bibNumber, registrationId: row.registrationId }, { reason }, trx);
        return { status: 200, released: { id: row.id, registrationId: row.registrationId, bibNumber: row.bibNumber }, warnings: collected ? ['bib_changed_after_collection'] : [] };
      });
    });
  }

  async function listBibs({ organizerId, eventId, query = {} }) {
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    const limit = parseLimit(query.limit, { dflt: 50, max: 200 });
    if (limit === null) return fail('invalid_limit', 400);
    const base = () => {
      let q = db('EventRegistration as r').where({ 'r.eventId': event.id, 'r.status': 'confirmed' });
      if (query.categoryId) q = q.where('r.categoryId', String(query.categoryId));
      return q;
    };
    let q = base();
    if (query.filter === 'assigned') q = q.whereNotNull('r.bibNumber');
    if (query.filter === 'unassigned') q = q.whereNull('r.bibNumber');
    const term = typeof query.q === 'string' ? query.q.trim() : '';
    if (term) {
      const like = `${term.replace(/[\\%_]/g, m => `\\${m}`)}%`;
      q = q.where(b => b.whereILike('r.firstName', like).orWhereILike('r.lastName', like).orWhere('r.bibNumber', term.toUpperCase())
        .orWhereIn('r.id', db('EventTicket').where('displayCode', term.toUpperCase()).select('registrationId')));
    }
    if (query.cursor) {
      const cur = decodeCursor(query.cursor);
      if (!cur?.c || !cur?.i) return fail('invalid_cursor', 400);
      q = q.whereRaw('(r."createdAt", r.id) > (?, ?)', [new Date(cur.c), String(cur.i)]);
    }
    const rows = (await q.orderBy([{ column: 'r.createdAt', order: 'asc' }, { column: 'r.id', order: 'asc' }]).limit(limit + 1).select('r.*')).map(plain);
    const page = rows.slice(0, limit);
    const c = await cardContext(event, page);
    const items = page.map(r => ({
      registrationId: r.id, displayName: `${r.firstName} ${r.lastName}`.trim(), categoryName: c.cats.get(r.categoryId)?.name ?? null, bibNumber: r.bibNumber ?? null,
      assignmentId: c.bibAssignmentId.get(r.id) ?? null, assignedAt: iso(c.bibAssignedAt.get(r.id)), kit: { state: kitStateOf({ reg: r, hasActiveTicket: c.ticketBy.get(r.id)?.status === 'active', event }) },
    }));
    const counts = await base().select(db.raw('count(*) FILTER (WHERE r."bibNumber" IS NOT NULL)::int AS assigned'), db.raw('count(*) FILTER (WHERE r."bibNumber" IS NULL)::int AS unassigned')).first();
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ c: iso(last.createdAt), i: last.id }) : null, counts: { assigned: counts.assigned, unassigned: counts.unassigned } };
  }

  // ── Bulk by rule ──────────────────────────────────────────────────────────

  function parseBulk(body) {
    const start = Number(body.start);
    const end = body.end === undefined || body.end === null || body.end === '' ? null : Number(body.end);
    const padTo = body.padTo === undefined ? 0 : Number(body.padTo);
    const prefix = body.prefix === undefined || body.prefix === null ? '' : String(body.prefix).toUpperCase();
    const fields = [];
    if (!Number.isInteger(start) || start < 0) fields.push({ path: 'start', code: 'invalid' });
    if (end !== null && (!Number.isInteger(end) || end < start)) fields.push({ path: 'end', code: 'invalid' });
    if (!Number.isInteger(padTo) || padTo < 0 || padTo > 8) fields.push({ path: 'padTo', code: 'invalid' });
    if (!/^[A-Z0-9-]{0,8}$/.test(prefix)) fields.push({ path: 'prefix', code: 'invalid' });
    if (!['registered_at', 'last_name'].includes(body.order ?? 'registered_at')) fields.push({ path: 'order', code: 'invalid' });
    if (fields.length) return fail('validation_failed', 422, { fields });
    return { start, end, padTo, prefix, order: body.order ?? 'registered_at', categoryId: body.categoryId ? String(body.categoryId) : null };
  }

  /** The plan a rule yields right now: [{ registrationId, bibNumber }], the conflicts and the shortfall. Optionally under row locks. */
  async function bulkPlan(q, event, p) {
    let cands = q('EventRegistration as r').where({ 'r.eventId': event.id, 'r.status': 'confirmed' }).whereNull('r.bibNumber');
    if (p.categoryId) cands = cands.where('r.categoryId', p.categoryId);
    cands = cands.orderBy(p.order === 'last_name'
      ? [{ column: 'r.lastName' }, { column: 'r.firstName' }, { column: 'r.id' }] : [{ column: 'r.createdAt' }, { column: 'r.id' }]).limit(BULK_MAX + 1).select('r.id');
    const ids = (await cands).map(r => r.id);
    if (ids.length > BULK_MAX) return fail('too_many_rows', 413, { max: BULK_MAX });
    const { numbers, shortfall } = bulkNumbers({ start: p.start, end: p.end, prefix: p.prefix, padTo: p.padTo, count: ids.length });
    const bad = numbers.find(n => !BIB_RE.test(n));
    if (bad) return fail('bib_invalid', 422);
    const taken = numbers.length ? new Set((await q('EventBibAssignment').where({ eventId: event.id }).whereNull('releasedAt').whereIn('bibNumber', numbers).select('bibNumber')).map(r => r.bibNumber)) : new Set();
    const plan = numbers.map((bibNumber, i) => ({ registrationId: ids[i], bibNumber }));
    return { plan, conflicts: [...taken], shortfall, count: ids.length, previewHash: sha(JSON.stringify([p, plan])) };
  }

  async function bulkPreview({ actor, organizerId, eventId, body = {} }) {
    if (!canOverride(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    const p = parseBulk(body);
    if (p.error) return p;
    const out = await bulkPlan(db, event, p);
    if (out.error) return out;
    return { previewHash: out.previewHash, count: out.count, first: out.plan[0]?.bibNumber ?? null, last: out.plan[out.plan.length - 1]?.bibNumber ?? null, conflicts: out.conflicts, shortfall: out.shortfall };
  }

  async function bulkApply({ actor, organizerId, eventId, key, body = {} }) {
    if (!canOverride(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    return idempotent({ actor, route: `POST bib-assignments/bulk|${event.id}`, key, body }, async () => {
      const p = parseBulk(body);
      if (p.error) return p;
      if (typeof body.previewHash !== 'string') return fail('validation_failed', 422, { fields: [{ path: 'previewHash', code: 'required' }] });
      if (event.status === 'cancelled') return fail('event_cancelled', 409);
      try {
        return await db.transaction(async (trx) => {
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`events-bibs:${event.id}`]);
          const out = await bulkPlan(trx, event, p);
          if (out.error) return out;
          if (out.previewHash !== body.previewHash) return fail('preview_stale', 409);
          if (out.conflicts.length || out.shortfall) return fail('bulk_not_applicable', 409, { conflicts: out.conflicts, shortfall: out.shortfall });
          if (!out.plan.length) return { status: 200, assigned: 0 };
          const at = stamp();
          const ids = out.plan.map(x => x.registrationId).sort();
          const regs = new Map((await trx('EventRegistration').whereIn('id', ids).orderBy('id').forUpdate()).map(r => [r.id, plain(r)]));
          const rows = [];
          for (const { registrationId, bibNumber } of out.plan) {
            const reg = regs.get(registrationId);
            if (reg.bibNumber || reg.status !== 'confirmed') throw refusal('preview_stale', 409);   // THROW: a return would commit the rows already written
            await assignBibTx(trx, { event, reg, bibNumber, actor, replace: false, reason: null, at, silent: true });
            rows.push({ registrationId: reg.id, eventId: event.id, categoryId: reg.categoryId, bibNumber, previousBibNumber: null });
          }
          await audit(actor, 'events.bibs_bulk_assigned', event.id, null, { count: out.plan.length, first: out.plan[0].bibNumber, last: out.plan[out.plan.length - 1].bibNumber }, trx);
          await outboxMany(trx, event, 'bib.assigned', rows);   // last statement before commit (M3)
          return { status: 200, assigned: out.plan.length, first: out.plan[0].bibNumber, last: out.plan[out.plan.length - 1].bibNumber, plan: out.plan };
        }).then(async (res) => {
          if (res.plan) {
            const regs = (await db('EventRegistration').whereIn('id', res.plan.map(x => x.registrationId)).select('id', 'participantUserId', 'purchaserUserId', 'bibNumber')).map(plain);
            await inboxOnlyBibNotices(event, regs);
            await analytics('bib_assigned', { eventId: event.id, mode: 'bulk', count: res.assigned });
            const { plan, ...rest } = res;
            return rest;
          }
          return res;
        });
      } catch (err) { const e = bibErrors(err); if (e) return e; throw err; }
    });
  }

  // ── CSV import ────────────────────────────────────────────────────────────

  /** Read a CSV and judge every row against the current data. → { rows, pairs, ok, bad } or a refusal. */
  async function importPlan(q, event, csv) {
    const parsed = parseCsv(csv);
    if (parsed.error) return fail(parsed.error === 'too_large' ? 'payload_too_large' : parsed.error === 'too_many_rows' ? 'too_many_rows' : 'csv_invalid', parsed.error === 'too_large' || parsed.error === 'too_many_rows' ? 413 : 422, { reason: parsed.error });
    const col = name => parsed.header.findIndex(h => h.toLowerCase() === name.toLowerCase());
    const idCol = col('registrationId') >= 0 ? col('registrationId') : col('ticketCode');
    const byCode = col('registrationId') < 0;
    const bibCol = col('bibNumber');
    if (idCol < 0 || bibCol < 0) return fail('csv_header_invalid', 422, { required: ['registrationId|ticketCode', 'bibNumber'] });
    const idsInFile = parsed.rows.map(r => String(r.cells[idCol] ?? '').trim()).filter(v => v && !/^[=+\-@\t\r]/.test(v));
    const regs = new Map();
    if (idsInFile.length) {
      const found = byCode
        ? await q('EventTicket as t').join('EventRegistration as r', 'r.id', 't.registrationId').where('r.eventId', event.id).whereIn('t.displayCode', idsInFile.map(v => v.toUpperCase())).where('t.status', 'active').select('r.*', 't.displayCode as code')
        : await q('EventRegistration as r').where('r.eventId', event.id).whereIn('r.id', idsInFile).select('r.*');
      // A ticket code is a support aid, not a key: two places of one event can share it (8 characters). An ambiguous code is refused, never guessed.
      for (const r of found) { const k = byCode ? r.code : r.id; regs.set(k, [...(regs.get(k) ?? []), plain(r)]); }
    }
    const bibs = parsed.rows.map(r => normaliseBib(String(r.cells[bibCol] ?? '')));
    const wanted = [...new Set(bibs.filter(Boolean))];
    const taken = new Map();
    if (wanted.length) for (const b of await q('EventBibAssignment').where({ eventId: event.id }).whereNull('releasedAt').whereIn('bibNumber', wanted).select('bibNumber', 'registrationId')) taken.set(b.bibNumber, b.registrationId);
    const seenBib = new Set(); const seenReg = new Set();
    const rows = []; const pairs = [];
    parsed.rows.forEach((r, i) => {
      const rawId = String(r.cells[idCol] ?? '').trim();
      const bibNumber = bibs[i];
      const echo = neutralise(String(r.cells[bibCol] ?? '').trim().slice(0, 40));
      const reject = code => rows.push({ line: r.line, status: 'error', code, bibNumber: echo });
      if (!rawId || /^[=+\-@\t\r]/.test(rawId)) return reject('registration_not_found');
      const hits = regs.get(byCode ? rawId.toUpperCase() : rawId) ?? [];
      if (hits.length > 1) return reject('ticket_code_ambiguous');
      const reg = hits[0];
      if (!reg) return reject('registration_not_found');
      if (reg.status !== 'confirmed') return reject('registration_not_confirmed');
      if (!bibNumber) return reject('bib_invalid');
      if (seenReg.has(reg.id)) return reject('registration_duplicate_in_file');
      if (seenBib.has(bibNumber)) return reject('bib_duplicate_in_file');
      seenReg.add(reg.id); seenBib.add(bibNumber);
      if (reg.bibNumber) return reject('already_assigned');
      if (taken.has(bibNumber)) return reject('bib_taken');
      rows.push({ line: r.line, status: 'ok', code: null, bibNumber });
      pairs.push({ registrationId: reg.id, bibNumber });
    });
    return { rows, pairs, ok: rows.filter(r => r.status === 'ok').length, bad: rows.filter(r => r.status === 'error').length, previewHash: sha(JSON.stringify(pairs)) };
  }

  async function importPreview({ actor, organizerId, eventId, body = {} }) {
    if (!canOverride(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    const out = await importPlan(db, event, body.csv);
    if (out.error) return out;
    return { total: out.rows.length, ok: out.ok, bad: out.bad, rows: out.rows, previewHash: out.previewHash };
  }

  async function importApply({ actor, organizerId, eventId, key, body = {} }) {
    if (!canOverride(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    return idempotent({ actor, route: `POST bib-assignments/import|${event.id}`, key, body: { csvHash: sha(String(body.csv ?? '')), previewHash: body.previewHash } }, async () => {
      if (typeof body.previewHash !== 'string') return fail('validation_failed', 422, { fields: [{ path: 'previewHash', code: 'required' }] });
      if (event.status === 'cancelled') return fail('event_cancelled', 409);
      try {
        const res = await db.transaction(async (trx) => {
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`events-bibs:${event.id}`]);
          const out = await importPlan(trx, event, body.csv);
          if (out.error) return out;
          // ALL OR NOTHING: one bad row and nothing is written.
          if (out.bad) return fail('import_has_errors', 409, { bad: out.bad, rows: out.rows.filter(r => r.status === 'error') });
          if (out.previewHash !== body.previewHash) return fail('preview_stale', 409);
          const at = stamp();
          const ids = out.pairs.map(x => x.registrationId).sort();
          const regs = new Map(ids.length ? (await trx('EventRegistration').whereIn('id', ids).orderBy('id').forUpdate()).map(r => [r.id, plain(r)]) : []);
          const rows = [];
          for (const { registrationId, bibNumber } of out.pairs) {
            const reg = regs.get(registrationId);
            if (reg.bibNumber || reg.status !== 'confirmed') throw refusal('preview_stale', 409);   // THROW: a return would commit the rows already written
            await assignBibTx(trx, { event, reg, bibNumber, actor, replace: false, reason: null, at, silent: true });
            rows.push({ registrationId: reg.id, eventId: event.id, categoryId: reg.categoryId, bibNumber, previousBibNumber: null });
          }
          await audit(actor, 'events.bibs_imported', event.id, null, { count: out.pairs.length }, trx);
          await outboxMany(trx, event, 'bib.assigned', rows);   // last statement before commit (M3)
          return { status: 200, imported: out.pairs.length, pairs: out.pairs };
        });
        if (res.pairs) {
          const regs = (await db('EventRegistration').whereIn('id', res.pairs.map(x => x.registrationId)).select('id', 'participantUserId', 'purchaserUserId', 'bibNumber')).map(plain);
          await inboxOnlyBibNotices(event, regs);
          await analytics('bib_assigned', { eventId: event.id, mode: 'import', count: res.imported });
          return { status: 200, imported: res.imported };
        }
        return res;
      } catch (err) { const e = bibErrors(err); if (e) return e; throw err; }
    });
  }

  // ── Manual lookup ─────────────────────────────────────────────────────────

  async function lookup({ actor, organizerId, eventId, query = {} }) {
    if (!canCollect(actor)) return fail('forbidden_role', 403);
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q.length < 3) return fail('query_too_short', 400, { min: 3 });
    if (q.length > 80) return fail('query_too_long', 400, { max: 80 });
    const like = `${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    const found = new Map();
    // An exact registration id may return an unpaid place (as `unpaid`); no name search ever lists one.
    const byId = plain(await db('EventRegistration').where({ id: q, eventId: event.id }).first());
    if (byId) found.set(byId.id, byId);
    const confirmed = () => db('EventRegistration').where({ eventId: event.id, status: 'confirmed' });
    const bib = normaliseBib(q);
    if (bib) for (const r of await confirmed().where({ bibNumber: bib }).limit(10)) found.set(r.id, plain(r));
    if (/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(q)) {
      for (const r of await confirmed().whereIn('id', db('EventTicket').where({ displayCode: q.toUpperCase() }).select('registrationId')).limit(10)) found.set(r.id, plain(r));
    }
    for (const r of await confirmed().where(b => b.whereILike('firstName', like).orWhereILike('lastName', like)).orderBy([{ column: 'lastName' }, { column: 'id' }]).limit(10)) found.set(r.id, plain(r));
    const regs = [...found.values()].slice(0, 10);
    const c = await cardContext(event, regs);
    return { items: regs.map(r => ({ registrationId: r.id, card: cardOf(event, r, c), warnings: warningsOf(event, r, c), canCollect: r.status === 'confirmed' && canCollect(actor) })) };
  }

  return {
    verifyTicket, collectKit, correctKit, kitHistory, kitSummary, assignBib, assignBibBatch, releaseBib, listBibs,
    bulkPreview, bulkApply, importPreview, importApply, lookup,
    internals: { idempotent, cardContext, cardOf, eventOf, audit, canOverride, canCollect, canAssign },
  };
}
