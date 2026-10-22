// Marathon & running events · S2 — the catalogue side of the Postgres store: organizer staff, joined event
// documents, nested upserts, listings, the change log, favourites and the lifecycle sweep. It composes
// with the S1 store (src/infra/event-store-pg.mjs), which keeps the compare-and-set edit, the status
// transitions and the order / hold primitive; nothing there is rewritten.
//
// Business refusals come back as { error, status, ...extra } (D5). Timestamps are timestamp(3); money is
// whole TZS (D4). Nested upserts run in one transaction: a category or ticket type that already carries
// inventory (sold + held > 0) is never deleted, only made inactive, so the ledger keeps its anchor.
import { randomUUID } from 'node:crypto';
import { UNLIMITED_CAPACITY } from '../shared/events-document.mjs';

export const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const json = value => (value === undefined || value === null ? null : JSON.stringify(value));
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

export function createPgEventCatalogueStore({ db, now = () => new Date() }) {
  // ── Organizers and staff ──────────────────────────────────────────────────

  /** The active organizer role of a user: { organizer, role, staffId } or null. */
  async function organizerForUser(userId) {
    if (!userId) return null;
    const row = await db('EventOrganizerStaff as s').join('EventOrganizer as o', 'o.id', 's.organizerId')
      .where({ 's.userId': userId, 's.status': 'active' }).orderBy('s.createdAt').first('s.id as staffId', 's.role', 'o.*');
    if (!row) return null;
    const { staffId, role, ...organizer } = plain(row);
    return { organizer, role, staffId };
  }

  const getOrganizer = async id => plain(await db('EventOrganizer').where({ id }).first());
  const organizerByKycCase = async kycCaseId => (kycCaseId ? plain(await db('EventOrganizer').where({ kycCaseId }).first()) : null);
  const organizerOfOwner = async ownerUserId => plain(await db('EventOrganizer').where({ ownerUserId }).first());

  /**
   * Set the organizer's status directly: it is derived from the KYC case (spec §2), so the case's
   * history is the audit trail and the ORG-003 machine of S1 is not consulted (a case reopened after a
   * rejection takes the organizer back to draft, a move the explicit machine does not have).
   */
  async function setOrganizerStatus(id, status, reason = null) {
    const [row] = await db('EventOrganizer').where({ id }).update({ status, statusReason: ['rejected', 'suspended'].includes(status) ? (reason || 'kyc') : null, updatedAt: now() }).returning('*');
    return plain(row);
  }

  async function patchOrganizer(id, patch) {
    const [row] = await db('EventOrganizer').where({ id }).update({ ...patch, updatedAt: now() }).returning('*');
    return plain(row);
  }

  async function addStaff({ organizerId, userId, role, addedBy = null }) {
    const at = now();
    // One active row per (organizer, user): re-adding a removed person makes a new active row.
    const existing = await db('EventOrganizerStaff').where({ organizerId, userId, status: 'active' }).first();
    if (existing) return plain(existing);
    const [row] = await db('EventOrganizerStaff').insert({ id: newId('eos'), organizerId, userId, role, status: 'active', addedBy, createdAt: at, updatedAt: at }).returning('*');
    return plain(row);
  }

  async function staffOf(organizerId) {
    return (await db('EventOrganizerStaff as s').leftJoin('User as u', 'u.id', 's.userId').where({ 's.organizerId': organizerId, 's.status': 'active' })
      .orderByRaw(`CASE s.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, s."createdAt"`)
      .select('s.*', 'u.displayName', 'u.email', 'u.phone')).map(plain);
  }

  const getStaff = async (organizerId, id) => plain(await db('EventOrganizerStaff').where({ organizerId, id, status: 'active' }).first());

  async function setStaffRole(organizerId, id, role) {
    const [row] = await db('EventOrganizerStaff').where({ organizerId, id, status: 'active' }).update({ role, updatedAt: now() }).returning('*');
    return plain(row);
  }

  async function removeStaff(organizerId, id) {
    const at = now();
    const [row] = await db('EventOrganizerStaff').where({ organizerId, id, status: 'active' }).update({ status: 'removed', removedAt: at, updatedAt: at }).returning('*');
    return plain(row);
  }

  // ── Events: joined documents ──────────────────────────────────────────────

  async function childrenOf(q, eventIds) {
    if (!eventIds.length) return { categories: new Map(), points: new Map() };
    const [cats, tts, pts] = await Promise.all([
      q('EventCategory').whereIn('eventId', eventIds).orderBy(['createdAt', 'id']),
      q('EventTicketType').whereIn('eventId', eventIds).orderBy(['createdAt', 'id']),
      q('EventCollectionPoint').whereIn('eventId', eventIds).orderBy(['createdAt', 'id']),
    ]);
    const ticketsByCategory = new Map();
    for (const t of tts.map(plain)) { if (!ticketsByCategory.has(t.categoryId)) ticketsByCategory.set(t.categoryId, []); ticketsByCategory.get(t.categoryId).push(t); }
    const categories = new Map();
    for (const c of cats.map(plain)) { if (!categories.has(c.eventId)) categories.set(c.eventId, []); categories.get(c.eventId).push({ ...c, ticketTypes: ticketsByCategory.get(c.id) || [] }); }
    const points = new Map();
    for (const p of pts.map(plain)) { if (!points.has(p.eventId)) points.set(p.eventId, []); points.get(p.eventId).push(p); }
    return { categories, points };
  }

  /** Join rows → [{ event, categories (with ticketTypes), collectionPoints, organizer }]. */
  async function join(q, eventRows) {
    const events = eventRows.map(plain);
    const { categories, points } = await childrenOf(q, events.map(e => e.id));
    const organizerIds = [...new Set(events.map(e => e.organizerId))];
    const organizers = new Map((organizerIds.length ? (await q('EventOrganizer').whereIn('id', organizerIds)).map(plain) : []).map(o => [o.id, o]));
    return events.map(event => ({ event, categories: categories.get(event.id) || [], collectionPoints: points.get(event.id) || [], organizer: organizers.get(event.organizerId) || null }));
  }

  /** One event, joined, by id or by slug; with `statuses`, only when it is in one of them (else null). */
  async function loadJoined(idOrSlug, { statuses = null } = {}) {
    if (!idOrSlug) return null;
    let q = db('Event').where(builder => builder.where({ id: idOrSlug }).orWhere({ slug: idOrSlug }));
    if (statuses) q = q.whereIn('status', statuses);
    const row = await q.first();
    if (!row) return null;
    const [joined] = await join(db, [row]);
    return joined;
  }

  /** The joined events of one organizer (every status unless filtered), newest start first. */
  async function listForOrganizer(organizerId, { status = null, type = null } = {}) {
    let q = db('Event').where({ organizerId });
    if (status) q = q.whereIn('status', [status].flat());
    if (type) q = q.where({ eventType: type });
    return join(db, await q.orderBy([{ column: 'startsAt', order: 'desc' }, { column: 'id' }]));
  }

  /** The joined events for the admin queue: by status, soonest submitted first. */
  async function listForAdmin({ status = null, limit = 500 } = {}) {
    let q = db('Event');
    if (status) q = q.whereIn('status', [status].flat());
    return join(db, await q.orderByRaw(`CASE status WHEN 'submitted' THEN 0 ELSE 1 END, coalesce("submittedAt", "updatedAt") ASC, id ASC`).limit(limit));
  }

  async function countByStatus(status) {
    const r = await db('Event').where({ status }).count({ n: '*' }).first();
    return Number(r?.n || 0);
  }

  /**
   * Public candidates (§14.1): status, type, region, date range and free-text in SQL, soonest first;
   * the service computes availability / price / distance filters and the final order. Capped.
   */
  async function listPublicCandidates({ statuses, types = null, region = null, from = null, to = null, q: text = null, ids = null, limit = 500 } = {}) {
    let q = db('Event').whereIn('status', statuses);
    if (types?.length) q = q.whereIn('eventType', types);
    if (region) q = q.where({ venueRegion: region });
    if (from) q = q.where('endsAt', '>=', from);
    if (to) q = q.where('startsAt', '<=', to);
    if (ids) q = q.whereIn('id', ids);
    if (text) {
      // `%` and `_` in the search text are literal characters, not wildcards (Postgres' default ESCAPE is backslash).
      const pattern = `%${String(text).replace(/[\\%_]/g, m => `\\${m}`)}%`;
      q = q.where(b => b.whereILike('title', pattern).orWhereILike('venueName', pattern).orWhereILike('venueCity', pattern));
    }
    return join(db, await q.orderBy([{ column: 'startsAt' }, { column: 'id' }]).limit(limit));
  }

  /** Lifecycle side fields (snapshots, submittedAt, rejection, cancellation …): no version bump, no status change. */
  async function patchEventRaw(id, patch) {
    const row = {};
    for (const [k, v] of Object.entries(patch)) row[k] = ['termsSnapshot', 'refundPolicySnapshot', 'rejection', 'cancellation', 'lastChangeNote'].includes(k) ? json(v) : v;
    const [saved] = await db('Event').where({ id }).update({ ...row, updatedAt: now() }).returning('*');
    return plain(saved);
  }

  /** A draft is deleted outright (its children cascade); anything else is refused. */
  async function deleteDraft(id) {
    return db.transaction(async (trx) => {
      const current = plain(await trx('Event').where({ id }).forUpdate().first());
      if (!current) return fail('event_not_found', 404);
      if (current.status !== 'draft') return fail('invalid_transition', 409, { from: current.status, to: 'deleted', allowed: [] });
      const logs = await trx('EventChangeLog').where({ eventId: id }).count({ n: '*' }).first();
      if (Number(logs?.n || 0)) return fail('invalid_transition', 409, { from: current.status, to: 'deleted', reason: 'has_history', allowed: [] });
      await trx('EventFavourite').where({ eventId: id }).del();
      await trx('Event').where({ id }).del();
      return { deleted: true, id };
    });
  }

  /** D12: any confirmed registration blocks the organizer's own cancel. */
  async function hasConfirmedRegistrations(eventId) {
    const r = await db('EventRegistration').where({ eventId, status: 'confirmed' }).count({ n: '*' }).first();
    return Number(r?.n || 0) > 0;
  }

  // ── Nested upsert (categories → ticket types, collection points) ─────────

  const capacityIn = c => (c === null || c === undefined ? UNLIMITED_CAPACITY : Number(c));

  /**
   * Replace the event's categories (with their ticket types) and/or collection points with `nested`
   * (parsed by parseEventPatch). Rows with an id are updated, rows without are created, rows not listed
   * are deleted — or made inactive when they carry inventory. Ticket counters (sold / held) are never
   * touched. One transaction; a CHECK violation names its constraint.
   */
  async function upsertNested(eventId, nested = {}) {
    return db.transaction(async (trx) => {
      const at = now();
      try {
        if (nested.categories) {
          const existing = (await trx('EventCategory').where({ eventId })).map(plain);
          const keep = new Set();
          let order = 0; // new rows get createdAt = at + n ms so the list keeps the order they were sent in
          for (const c of nested.categories) {
            const row = {
              name: c.name, distanceMeters: Math.round(Number(c.distanceM)), startTime: c.startsAt ?? null, capacity: c.capacity === null ? null : Number(c.capacity),
              eligibility: json(c.eligibility || {}), minAge: c.minAge === null ? null : Number(c.minAge), status: 'active', updatedAt: at,
            };
            let id = c.id && existing.some(e => e.id === c.id) ? c.id : null;
            if (id) await trx('EventCategory').where({ id, eventId }).update(row);
            else { id = newId('evc'); await trx('EventCategory').insert({ ...row, id, eventId, createdAt: new Date(+at + (order += 1)) }); }
            keep.add(id);
            const ticketsExisting = (await trx('EventTicketType').where({ eventId, categoryId: id })).map(plain);
            const keepTickets = new Set();
            for (const t of c.ticketTypes || []) {
              const trow = {
                name: t.name, priceTzs: Number(t.priceTzs), capacity: capacityIn(t.capacity), saleOpensAt: t.saleOpensAt ?? null, saleClosesAt: t.saleClosesAt ?? null,
                minPerOrder: Number(t.minPerOrder ?? 1), maxPerOrder: Number(t.maxPerOrder ?? 10), status: 'active', updatedAt: at,
              };
              let tid = t.id && ticketsExisting.some(e => e.id === t.id) ? t.id : null;
              if (tid) await trx('EventTicketType').where({ id: tid, eventId }).update(trow);
              else { tid = newId('ett'); await trx('EventTicketType').insert({ ...trow, id: tid, eventId, categoryId: id, currency: 'TZS', createdAt: new Date(+at + (order += 1)) }); }
              keepTickets.add(tid);
            }
            for (const t of ticketsExisting.filter(e => !keepTickets.has(e.id))) {
              if ((t.sold ?? 0) + (t.held ?? 0) > 0) await trx('EventTicketType').where({ id: t.id }).update({ status: 'inactive', updatedAt: at });
              else await trx('EventTicketType').where({ id: t.id }).del();
            }
          }
          for (const c of existing.filter(e => !keep.has(e.id))) {
            const used = await trx('EventTicketType').where({ categoryId: c.id }).where(b => b.where('sold', '>', 0).orWhere('held', '>', 0)).first('id');
            if (used) {
              await trx('EventCategory').where({ id: c.id }).update({ status: 'inactive', updatedAt: at });
              await trx('EventTicketType').where({ categoryId: c.id }).update({ status: 'inactive', updatedAt: at });
            } else {
              await trx('EventTicketType').where({ categoryId: c.id }).del();
              await trx('EventCategory').where({ id: c.id }).del();
            }
          }
        }
        if (nested.collectionPoints) {
          const existing = (await trx('EventCollectionPoint').where({ eventId })).map(plain);
          const keep = new Set();
          let order = 0;
          for (const p of nested.collectionPoints) {
            const row = {
              name: p.name, address: p.address || null, lat: p.lat ?? null, lng: p.lng ?? null,
              openingWindows: json((p.windows || []).map(w => ({ opensAt: w.opensAt ? new Date(w.opensAt).toISOString() : null, closesAt: w.closesAt ? new Date(w.closesAt).toISOString() : null }))),
              instructions: json(p.instructions || {}), status: 'active', updatedAt: at,
            };
            let id = p.id && existing.some(e => e.id === p.id) ? p.id : null;
            if (id) await trx('EventCollectionPoint').where({ id, eventId }).update(row);
            else { id = newId('ecp'); await trx('EventCollectionPoint').insert({ ...row, id, eventId, createdAt: new Date(+at + (order += 1)) }); }
            keep.add(id);
          }
          for (const p of existing.filter(e => !keep.has(e.id))) await trx('EventCollectionPoint').where({ id: p.id }).del();
        }
        return { ok: true };
      } catch (err) {
        if (err.code === CHECK_VIOLATION) throw Object.assign(new Error('event_invalid'), { refusal: fail('event_invalid', 422, { fields: [{ path: 'nested', code: 'range', constraint: err.constraint ?? null }] }) });
        if (err.code === UNIQUE_VIOLATION) throw Object.assign(new Error('event_invalid'), { refusal: fail('event_invalid', 422, { fields: [{ path: 'categories', code: 'unique' }] }) });
        throw err;
      }
    }).catch(err => (err?.refusal ? err.refusal : Promise.reject(err)));
  }

  // ── Change log ────────────────────────────────────────────────────────────

  async function appendChangeLog({ eventId, actorUserId = null, actorRole = null, fields = [], before = null, after = null, note = null, material = false, reason = null }) {
    const [row] = await db('EventChangeLog').insert({
      id: newId('ecl'), eventId, actorUserId, actorRole, field: fields.join(',').slice(0, 2000) || '-', fields: json(fields),
      before: json(before), after: json(after), note: json(note), material, reason, createdAt: now(),
    }).returning('*');
    return plain(row);
  }

  async function listChangeLog(eventId) {
    return (await db('EventChangeLog as l').leftJoin('User as u', 'u.id', 'l.actorUserId').where({ 'l.eventId': eventId })
      .orderBy([{ column: 'l.createdAt', order: 'desc' }, { column: 'l.id', order: 'desc' }]).select('l.*', 'u.displayName as actorName')).map(plain);
  }

  async function countChangeLog(eventId) {
    const r = await db('EventChangeLog').where({ eventId }).count({ n: '*' }).first();
    return Number(r?.n || 0);
  }

  // ── Favourites ────────────────────────────────────────────────────────────

  async function saveFavourite(userId, eventId) {
    await db('EventFavourite').insert({ userId, eventId, createdAt: now() }).onConflict(['userId', 'eventId']).ignore();
    return { saved: true };
  }
  async function removeFavourite(userId, eventId) {
    await db('EventFavourite').where({ userId, eventId }).del();
    return { saved: false };
  }
  async function savedEventIds(userId, eventIds = null) {
    if (!userId) return new Set();
    let q = db('EventFavourite').where({ userId });
    if (eventIds) q = q.whereIn('eventId', eventIds);
    return new Set((await q.select('eventId')).map(r => r.eventId));
  }

  // ── Lifecycle sweep (automatic transitions, §7.1) ─────────────────────────

  /** Events whose automatic move is due at `at`: [{ id, status, to }]. */
  async function dueTransitions({ at = now(), graceMs = 0 } = {}) {
    const close = await db('Event').where({ status: 'published' }).whereNotNull('registrationClosesAt').where('registrationClosesAt', '<=', at).where('startsAt', '>', at).select('id', 'status');
    const start = await db('Event').whereIn('status', ['published', 'registration_closed']).where('startsAt', '<=', at).select('id', 'status');
    const finish = await db('Event').where({ status: 'in_progress' }).where('endsAt', '<=', new Date(+at - graceMs)).select('id', 'status');
    return [
      ...close.map(r => ({ id: r.id, from: r.status, to: 'registration_closed' })),
      ...start.map(r => ({ id: r.id, from: r.status, to: 'in_progress' })),
      ...finish.map(r => ({ id: r.id, from: r.status, to: 'completed' })),
    ];
  }

  return {
    organizerForUser, getOrganizer, organizerByKycCase, organizerOfOwner, setOrganizerStatus, patchOrganizer,
    addStaff, staffOf, getStaff, setStaffRole, removeStaff,
    loadJoined, listForOrganizer, listForAdmin, countByStatus, listPublicCandidates, patchEventRaw, deleteDraft, hasConfirmedRegistrations, upsertNested,
    appendChangeLog, listChangeLog, countChangeLog,
    saveFavourite, removeFavourite, savedEventIds,
    dueTransitions,
  };
}
