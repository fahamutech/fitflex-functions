// Marathon & running events · S5 — reading the roster out of FitFlex (spec §4.5, §5.4): the dashboard roster with a
// keyset cursor, the change feed over the outbox, the minimised registration record the API serves, and the audited CSV
// export. One service behind the portal routes and the /v1 routes.
//
// The privacy line (D25, D36, D37): an organizer sees name, category, ticket type, status, bib, kit, kit size, team and
// group labels. NEVER phone, email, date of birth (only `ageOnEventDay` under the demographics scope), gender (same
// scope), emergency contact, payer or payment data, user ids, claim tokens, ticket tokens or hashes.
import { randomUUID } from 'node:crypto';
import { kitStateOf } from '../shared/events-kit-view.mjs';
import { maskName } from '../shared/events-participants.mjs';
import { encodeCursor, decodeCursor, parseLimit, csvLine, sha256hex } from '../shared/events-ops-rules.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v ? new Date(v).toISOString() : null);
export const FEED_TYPES = Object.freeze(['registration.created', 'registration.updated', 'registration.paid', 'registration.cancelled', 'kit.collected', 'bib.assigned']);
export const FEED_RETENTION_DAYS = 90;
export const EXPORT_COLUMNS = Object.freeze(['registrationId', 'ticketCode', 'firstName', 'lastName', 'categoryName', 'ticketTypeName', 'status', 'bibNumber', 'kitStatus', 'kitCollectedAt', 'kitSize', 'teamName', 'groupLabel', 'claimed']);
const PUBLIC_STATUS = r => (r.status === 'confirmed' ? 'confirmed' : (['cancelled', 'refunded'].includes(r.status) && r.paidAt ? 'cancelled' : null));

/** Completed years on the event's start date, in the event's own time zone. */
export function ageOnEventDay(dateOfBirth, startsAt, timezone = 'Africa/Dar_es_Salaam') {
  if (!dateOfBirth || !startsAt) return null;
  const dob = (dateOfBirth instanceof Date ? dateOfBirth.toISOString() : String(dateOfBirth)).slice(0, 10);
  let day;
  try { day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startsAt)); } catch { return null; }
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ey, em, ed] = day.split('-').map(Number);
  if (![by, bm, bd, ey, em, ed].every(Number.isFinite)) return null;
  return ey - by - (em < bm || (em === bm && ed < bd) ? 1 : 0);
}

export function createEventsSyncService({ db, now = () => new Date(), feedLagSeconds = () => 5, exportMaxRows = () => 20_000, audit = null }) {
  const stamp = () => new Date(now());
  const writeAudit = async (actor, action, target, after) => db('AuditLog').insert({ id: `aud_${randomUUID().slice(0, 12)}`, at: stamp(), actor, action, target, before: null, after: JSON.stringify(after) });
  void audit;
  const eventOf = async (organizerId, eventId, allowed = null) => {
    if (allowed && !allowed.includes(String(eventId))) return null;
    return plain(await db('Event').where({ id: String(eventId), organizerId }).first());
  };

  async function context(event, regs) {
    const ids = regs.map(r => r.id);
    const [cats, types, tickets, teams, collected] = await Promise.all([
      db('EventCategory').where({ eventId: event.id }).select('id', 'name'),
      db('EventTicketType').where({ eventId: event.id }).select('id', 'name'),
      ids.length ? db('EventTicket').whereIn('registrationId', ids).orderBy([{ column: 'issuedAt', order: 'desc' }, { column: 'id', order: 'desc' }]) : [],
      ids.length ? db('EventTeamMember as m').join('EventTeam as t', 't.id', 'm.teamId').whereIn('m.registrationId', ids).select('m.registrationId', 't.id as teamId', 't.name') : [],
      ids.length ? db('EventKitCollection').whereIn('registrationId', ids).where({ status: 'collected' }).select('registrationId', 'collectedAt') : [],
    ]);
    const ticketBy = new Map();
    for (const t of tickets) if (!ticketBy.has(t.registrationId) || t.status === 'active') ticketBy.set(t.registrationId, plain(t));
    return {
      cats: new Map(cats.map(c => [c.id, c.name])), types: new Map(types.map(t => [t.id, t.name])), ticketBy,
      teamBy: new Map(teams.map(t => [t.registrationId, { id: t.teamId, name: t.name }])), collectedAt: new Map(collected.map(c => [c.registrationId, c.collectedAt])),
    };
  }

  const kitOf = (event, r, c) => {
    const state = kitStateOf({ reg: r, hasActiveTicket: c.ticketBy.get(r.id)?.status === 'active', event });
    return { state, ...(c.collectedAt.get(r.id) ? { collectedAt: iso(c.collectedAt.get(r.id)) } : {}) };
  };

  // ── The dashboard roster (replaces the in-memory 2,000-row cut-off; follow-up S3-L3) ─────────────

  /** Same item shape as the S3 roster plus bibNumber / kit / updatedAt. Names are masked before payment. */
  async function rosterPage({ organizerId, eventId, query = {} }) {
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    const limit = parseLimit(query.limit, { dflt: 50, max: 200 });
    if (limit === null) return fail('invalid_limit', 400);
    let base = db('EventRegistration as r').join('EventOrder as o', 'o.id', 'r.orderId').where({ 'r.eventId': event.id });
    if (['reserved', 'confirmed', 'cancelled'].includes(query.status)) base = base.where({ 'r.status': query.status });
    if (query.categoryId) base = base.where({ 'r.categoryId': String(query.categoryId) });
    if (query.bib === 'assigned') base = base.whereNotNull('r.bibNumber');
    if (query.bib === 'unassigned') base = base.whereNull('r.bibNumber');
    if (query.kit === 'collected') base = base.where({ 'r.kitStatus': 'collected' });
    if (query.kit === 'exception') base = base.where({ 'r.kitStatus': 'exception' });
    if (query.kit === 'remaining') base = base.where({ 'r.status': 'confirmed' }).whereNot({ 'r.kitStatus': 'collected' });
    if (query.updatedSince) {
      const since = new Date(String(query.updatedSince));
      if (Number.isNaN(+since)) return fail('invalid_request', 400, { field: 'updatedSince' });
      base = base.where('r.updatedAt', '>', since);
    }
    const term = typeof query.q === 'string' ? query.q.trim() : '';
    if (term) {
      // Search covers paid places only (a name search never lists an unpaid person).
      base = base.where(b => b.where('r.status', 'confirmed').orWhereNotNull('o.confirmedAt'))
        .whereRaw(`lower(r."firstName" || ' ' || r."lastName") LIKE ?`, [`%${term.toLowerCase().replace(/[\\%_]/g, m => `\\${m}`)}%`]);
    }
    const total = Number((await base.clone().count({ n: '*' }).first()).n);
    let page = base.clone();
    if (query.cursor) {
      const cur = decodeCursor(query.cursor);
      if (!cur?.c || !cur?.i) return fail('invalid_cursor', 400);
      page = page.whereRaw('(r."createdAt", r.id) < (?, ?)', [new Date(cur.c), String(cur.i)]);
    }
    const rows = (await page.orderBy([{ column: 'r.createdAt', order: 'desc' }, { column: 'r.id', order: 'desc' }]).limit(limit + 1)
      .select('r.*', 'o.reference as orderReference', 'o.confirmedAt as orderConfirmedAt', 'o.status as orderStatus')).map(plain);
    const slice = rows.slice(0, limit);
    const c = await context(event, slice);
    const items = slice.map((r) => {
      const paid = Boolean(r.orderConfirmedAt) || r.status === 'confirmed';
      const full = `${r.firstName} ${r.lastName}`.trim();
      return {
        id: r.id, participant: { name: paid ? full : maskName(full) }, categoryId: r.categoryId, categoryName: c.cats.get(r.categoryId) ?? null,
        ticketTypeName: c.types.get(r.ticketTypeId) ?? null, status: r.status, orderId: r.orderId, orderReference: r.orderReference, orderStatus: r.orderStatus,
        teamName: c.teamBy.get(r.id)?.name ?? null, kitSize: paid ? (r.kitSize ?? null) : null, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
        claimed: Boolean(r.participantUserId), consentBasis: r.consentBasis, bibNumber: r.bibNumber ?? null, kit: kitOf(event, r, c),
      };
    });
    const last = slice[slice.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ c: iso(last.createdAt), i: last.id }) : null, total };
  }

  // ── The minimised record (the API and the feed's ?expand=registration) ───────────────────────────

  function recordOf(event, r, c, { demographics = false } = {}) {
    const status = PUBLIC_STATUS(r);
    const cancelled = status === 'cancelled';
    const out = {
      id: r.id, eventId: r.eventId, categoryId: r.categoryId, categoryName: c.cats.get(r.categoryId) ?? null, ticketTypeId: r.ticketTypeId, ticketTypeName: c.types.get(r.ticketTypeId) ?? null,
      orderId: r.orderId, status, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
      firstName: cancelled ? null : r.firstName, lastName: cancelled ? null : r.lastName,
      bibNumber: cancelled ? null : (r.bibNumber ?? null), kit: kitOf(event, r, c), kitSize: cancelled ? null : (r.kitSize ?? null), ticketCode: c.ticketBy.get(r.id)?.displayCode ?? null,
      teamId: cancelled ? null : (c.teamBy.get(r.id)?.id ?? null), teamName: cancelled ? null : (c.teamBy.get(r.id)?.name ?? null), groupLabel: cancelled ? null : (r.groupLabel ?? null), claimed: Boolean(r.participantUserId),
    };
    if (demographics) { out.gender = cancelled ? null : (r.gender ?? null); out.ageOnEventDay = cancelled ? null : ageOnEventDay(r.dateOfBirth, event.startsAt, event.timezone); }
    return out;
  }

  /** GET /v1/organizer/events/:eventId/registrations — confirmed and cancelled-after-confirmed places only. */
  async function listRecords({ organizerId, eventId, allowedEventIds = null, query = {}, demographics = false }) {
    const event = await eventOf(organizerId, eventId, allowedEventIds);
    if (!event) return fail('event_not_found', 404);
    const limit = parseLimit(query.limit, { dflt: 50, max: 200 });
    if (limit === null) return fail('invalid_limit', 400);
    let q = db('EventRegistration as r').where({ 'r.eventId': event.id }).where(b => b.where('r.status', 'confirmed').orWhere(c => c.whereIn('r.status', ['cancelled', 'refunded']).whereNotNull('r.paidAt')));
    if (query.status === 'confirmed') q = q.where('r.status', 'confirmed');
    else if (query.status === 'cancelled') q = q.whereIn('r.status', ['cancelled', 'refunded']);
    else if (query.status !== undefined && query.status !== '') return fail('invalid_request', 400, { field: 'status' });
    if (query.categoryId) q = q.where('r.categoryId', String(query.categoryId));
    if (query.bib === 'assigned') q = q.whereNotNull('r.bibNumber');
    if (query.bib === 'unassigned') q = q.whereNull('r.bibNumber');
    if (query.kit === 'collected') q = q.where({ 'r.kitStatus': 'collected' });
    if (query.kit === 'exception') q = q.where({ 'r.kitStatus': 'exception' });
    if (query.kit === 'remaining') q = q.where({ 'r.status': 'confirmed' }).whereNot({ 'r.kitStatus': 'collected' });
    if (query.updatedSince) {
      const since = new Date(String(query.updatedSince));
      if (Number.isNaN(+since)) return fail('invalid_request', 400, { field: 'updatedSince' });
      q = q.where('r.updatedAt', '>', since);
    }
    if (query.cursor) {
      const cur = decodeCursor(query.cursor);
      if (!cur?.c || !cur?.i) return fail('invalid_cursor', 400);
      q = q.whereRaw('(r."createdAt", r.id) > (?, ?)', [new Date(cur.c), String(cur.i)]);
    }
    const rows = (await q.orderBy([{ column: 'r.createdAt', order: 'asc' }, { column: 'r.id', order: 'asc' }]).limit(limit + 1).select('r.*')).map(plain);
    const slice = rows.slice(0, limit);
    const c = await context(event, slice);
    const last = slice[slice.length - 1];
    return { items: slice.map(r => recordOf(event, r, c, { demographics })), nextCursor: rows.length > limit && last ? encodeCursor({ c: iso(last.createdAt), i: last.id }) : null };
  }

  /** GET /v1/organizer/registrations/:registrationId — 404 unless it belongs to an event of the client's organizer and restriction. */
  async function getRecord({ organizerId, registrationId, allowedEventIds = null, demographics = false }) {
    const r = plain(await db('EventRegistration').where({ id: String(registrationId) }).first());
    const event = r ? await eventOf(organizerId, r.eventId, allowedEventIds) : null;
    if (!r || !event || !PUBLIC_STATUS(r)) return fail('registration_not_found', 404);
    const c = await context(event, [r]);
    return { registration: recordOf(event, r, c, { demographics }) };
  }

  /** GET /v1/organizer/events — the organizer's events (restricted by eventIds): no pricing, payout or terms. */
  async function listEvents({ organizerId, allowedEventIds = null, query = {} }) {
    const limit = parseLimit(query.limit, { dflt: 50, max: 200 });
    if (limit === null) return fail('invalid_limit', 400);
    let q = db('Event').where({ organizerId }).whereNot({ status: 'draft' });
    if (allowedEventIds) q = q.whereIn('id', allowedEventIds);
    if (query.cursor) {
      const cur = decodeCursor(query.cursor);
      if (!cur?.c || !cur?.i) return fail('invalid_cursor', 400);
      q = q.whereRaw('("createdAt", id) > (?, ?)', [new Date(cur.c), String(cur.i)]);
    }
    const rows = (await q.orderBy([{ column: 'createdAt', order: 'asc' }, { column: 'id', order: 'asc' }]).limit(limit + 1)).map(plain);
    const slice = rows.slice(0, limit);
    const ids = slice.map(e => e.id);
    const [cats, points] = await Promise.all([
      ids.length ? db('EventCategory').whereIn('eventId', ids).where({ status: 'active' }).orderBy('id').select('id', 'eventId', 'name', 'distanceMeters') : [],
      ids.length ? db('EventCollectionPoint').whereIn('eventId', ids).where({ status: 'active' }).orderBy('id').select('id', 'eventId', 'name') : [],
    ]);
    const items = slice.map(e => ({
      id: e.id, title: e.title, slug: e.slug, status: e.status, startsAt: iso(e.startsAt), endsAt: iso(e.endsAt), timezone: e.timezone,
      categories: cats.filter(x => x.eventId === e.id).map(x => ({ id: x.id, name: x.name, distanceM: Number(x.distanceMeters) })),
      collectionPoints: points.filter(x => x.eventId === e.id).map(x => ({ id: x.id, name: x.name })),
    }));
    const last = slice[slice.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ c: iso(last.createdAt), i: last.id }) : null };
  }

  // ── The change feed (spec §4.5) ───────────────────────────────────────────

  /**
   * Committed outbox rows of the registration-scoped types for one event, ordered by `seq`. `seq` is assigned before commit,
   * so only rows older than EVENTS_FEED_LAG_SECONDS are served: a slow transaction cannot commit "behind" a cursor. Consumers
   * dedupe on the outbox `id` and may overlap cursors. A cursor older than the outbox retention is 410 cursor_expired.
   */
  async function changeFeed({ organizerId, eventId, allowedEventIds = null, query = {}, demographics = false }) {
    const event = await eventOf(organizerId, eventId, allowedEventIds);
    if (!event) return fail('event_not_found', 404);
    const limit = parseLimit(query.limit, { dflt: 50, max: 200 });
    if (limit === null) return fail('invalid_limit', 400);
    const expand = query.expand === 'registration';
    if (query.expand !== undefined && query.expand !== '' && !expand) return fail('invalid_request', 400, { field: 'expand' });
    if (expand && limit > 100) return fail('invalid_limit', 400, { max: 100 });
    let after = 0;
    if (query.cursor !== undefined && query.cursor !== '') {
      const cur = decodeCursor(query.cursor);
      if (!cur || !Number.isSafeInteger(cur.s) || cur.s < 0) return fail('invalid_cursor', 400);
      if (+stamp() - Number(cur.t ?? 0) > FEED_RETENTION_DAYS * 86_400_000) return fail('cursor_expired', 410);
      after = cur.s;
    }
    const horizon = new Date(+stamp() - feedLagSeconds() * 1000);
    const rows = (await db('OutboxEvent').where({ eventId: event.id }).whereIn('type', FEED_TYPES).where('seq', '>', after).where('createdAt', '<=', horizon)
      .orderBy('seq').limit(limit + 1).select('id', 'seq', 'type', 'aggregateId', 'payload', 'createdAt')).map(plain);
    const slice = rows.slice(0, limit);
    let records = new Map();
    if (expand && slice.length) {
      const regs = (await db('EventRegistration').whereIn('id', [...new Set(slice.map(r => r.aggregateId))])).map(plain);
      const c = await context(event, regs);
      records = new Map(regs.map(r => [r.id, recordOf(event, r, c, { demographics })]));
    }
    const items = slice.map((row) => {
      const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload ?? {};
      const base = { seq: Number(row.seq), id: row.id, eventType: row.type, registrationId: row.aggregateId, changedAt: iso(row.createdAt) };
      if (row.type === 'registration.cancelled') return { ...base, status: 'cancelled', cancelledAt: iso(row.createdAt), reasonCode: typeof p.reason === 'string' ? p.reason : 'other', ...(expand ? { registration: records.get(row.aggregateId) ?? null } : {}) };
      return {
        ...base, status: 'confirmed', ...(row.type === 'registration.updated' ? { changed: Array.isArray(p.changed) ? p.changed : [] } : {}),
        ...(expand ? { registration: records.get(row.aggregateId) ?? null } : {}),
      };
    });
    const nextSeq = slice.length ? Number(slice[slice.length - 1].seq) : after;
    return { items, nextCursor: encodeCursor({ s: nextSeq, t: +stamp() }), hasMore: rows.length > limit };
  }

  // ── CSV export (audited, fixed columns, formula-injection safe) ───────────

  /**
   * Owner/admin only (the route checks the role and the 5/hour limit). The audit row is written BEFORE the first byte, so an
   * aborted download still leaves it. → { filename, rowCount, chunks: async generator of strings } or a refusal.
   */
  async function startExport({ actor, organizerId, eventId }) {
    const event = await eventOf(organizerId, eventId);
    if (!event) return fail('event_not_found', 404);
    const visible = () => db('EventRegistration as r').where({ 'r.eventId': event.id }).where(b => b.where('r.status', 'confirmed').orWhere(c => c.whereIn('r.status', ['cancelled', 'refunded']).whereNotNull('r.paidAt')));
    const rowCount = Number((await visible().count({ n: '*' }).first()).n);
    if (rowCount > exportMaxRows()) return fail('export_too_large', 413, { rows: rowCount, max: exportMaxRows() });
    await writeAudit(actor, 'events.roster_exported', event.id, { eventId: event.id, rowCount, columnsHash: sha256hex(EXPORT_COLUMNS.join(',')), actor });
    const day = stamp().toISOString().slice(0, 10).replace(/-/g, '');
    const slug = String(event.slug ?? 'event').replace(/[^a-z0-9-]/gi, '').slice(0, 60) || 'event';
    async function* chunks() {
      yield `﻿${csvLine(EXPORT_COLUMNS)}\r\n`;
      let last = '';
      for (;;) {
        const rows = (await visible().where('r.id', '>', last).orderBy('r.id').limit(500).select('r.*')).map(plain);
        if (!rows.length) return;
        const c = await context(event, rows);
        let out = '';
        for (const r of rows) {
          const cancelled = PUBLIC_STATUS(r) === 'cancelled';
          const kit = kitOf(event, r, c);
          out += `${csvLine([
            r.id, c.ticketBy.get(r.id)?.displayCode ?? '', cancelled ? '' : r.firstName, cancelled ? '' : r.lastName, c.cats.get(r.categoryId) ?? '', c.types.get(r.ticketTypeId) ?? '', PUBLIC_STATUS(r),
            cancelled ? '' : (r.bibNumber ?? ''), kit.state, kit.collectedAt ?? '', cancelled ? '' : (r.kitSize ?? ''), cancelled ? '' : (c.teamBy.get(r.id)?.name ?? ''), cancelled ? '' : (r.groupLabel ?? ''), r.participantUserId ? 'yes' : 'no',
          ])}\r\n`;
        }
        last = rows[rows.length - 1].id;
        yield out;
      }
    }
    return { filename: `${slug}-participants-${day}.csv`, rowCount, chunks: chunks() };
  }

  return { rosterPage, listRecords, getRecord, listEvents, changeFeed, startExport, internals: { context, recordOf } };
}
