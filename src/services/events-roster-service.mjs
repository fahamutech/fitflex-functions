// Marathon & running events · S3 — corporate bulk registration (spec §3.10; decisions D18, D19).
//
//   validate({ access, body })             POST /b2b/organizations/:id/event-orders/roster/validate — CSV text or rows,
//                                          per-row problems, duplicates (in_list / already_registered), a quote for the
//                                          ok rows only, capacity shortfalls. Nothing is written.
//   placeOrder({ access, body, … })        POST /b2b/organizations/:id/event-orders — every row re-validated, consent
//                                          basis forced to 'organisation', discounts from EVENTS_ORG_DISCOUNTS only,
//                                          idempotency scoped (organizationId, key) by the store, bulk lifts maxPerOrder.
//   listOrders / getOrder / cancelOrder    the organisation's orders (order-level cancel only; no per-row removal).
//
// Permissions (D18): validating and reading need the roster permission `beneficiaries.manage`; placing and cancelling
// need an ORG_BILLING role (owner | admin | finance, as the portal's Shell.tsx) — platform admins pass both.
// Parsing copies b2b-beneficiary-import-service (splitCsv, header aliases) with event columns.
import { splitCsv } from './b2b-beneficiary-import-service.mjs';
import { distanceBucket, ticketAvailability } from '../shared/events-document.mjs';
import { MEMBER_CANCEL_REASONS } from '../shared/events-participants.mjs';
import { paginate } from '../shared/pagination.mjs';
import { eventsCorporateMaxRows } from '../shared/events-config.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const isStr = v => typeof v === 'string';
const iso = v => (v ? new Date(v).toISOString() : null);
export const ORG_BILLING_ROLES = Object.freeze(['owner', 'admin', 'finance']);
export const ROSTER_PERMISSION = 'beneficiaries.manage';

const COLUMNS = ['firstName', 'lastName', 'phone', 'email', 'category', 'dateOfBirth', 'gender', 'kitSize', 'group'];
const HEADER_ALIASES = {
  'first name': 'firstName', firstname: 'firstName', 'given name': 'firstName', givenname: 'firstName',
  'last name': 'lastName', lastname: 'lastName', surname: 'lastName', 'family name': 'lastName', familyname: 'lastName',
  name: 'name', 'full name': 'name', fullname: 'name', displayname: 'name',
  phone: 'phone', mobile: 'phone', 'mobile number': 'phone', 'phone number': 'phone', msisdn: 'phone',
  email: 'email', 'email address': 'email', 'e-mail': 'email',
  category: 'category', distance: 'category', race: 'category', event: 'category',
  'ticket type': 'ticketType', tickettype: 'ticketType', ticket: 'ticketType',
  'date of birth': 'dateOfBirth', dateofbirth: 'dateOfBirth', dob: 'dateOfBirth', birthday: 'dateOfBirth',
  gender: 'gender', sex: 'gender',
  'kit size': 'kitSize', kitsize: 'kitSize', 't-shirt': 'kitSize', tshirt: 'kitSize', 'shirt size': 'kitSize', 'shirt': 'kitSize', size: 'kitSize',
  group: 'group', department: 'group', team: 'group', unit: 'group',
};

/** Rows from pasted or uploaded text. With a header line its names decide the columns; without one the order is COLUMNS. */
export function parseRosterText(raw) {
  const lines = String(raw ?? '').replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const first = splitCsv(lines[0]).map(c => HEADER_ALIASES[c.toLowerCase().trim()]);
  const hasHeader = first.filter(Boolean).length >= 2;
  const order = hasHeader ? first : COLUMNS;
  return lines.slice(hasHeader ? 1 : 0).map((line, i) => {
    const cells = splitCsv(line);
    const row = { line: i + (hasHeader ? 2 : 1) };
    order.forEach((key, c) => { if (key && cells[c]) row[key] = cells[c]; });
    return row;
  });
}

/** "DD/MM/YYYY" → "YYYY-MM-DD"; "YYYY-MM-DD" unchanged; anything else returned as given (the participant check rejects it). */
export function normaliseRosterDate(value) {
  const v = String(value ?? '').trim();
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return v;
}

/** The category a roster cell names: by name (case-insensitive) or by distance ("10K", "21 km", "5km"). */
export function matchCategory(cell, categories) {
  const v = String(cell ?? '').trim().toLowerCase();
  if (!v) return null;
  const live = categories.filter(c => c.status !== 'inactive');
  const byName = live.find(c => String(c.name).trim().toLowerCase() === v);
  if (byName) return byName;
  const d = /^(\d+(?:[.,]\d+)?)\s*(k|km|kms|kilometers|kilometres|m|meters|metres)?$/.exec(v);
  if (d) {
    const n = parseFloat(d[1].replace(',', '.'));
    const metres = !d[2] || d[2].startsWith('k') ? n * 1000 : n;
    const exact = live.filter(c => Math.abs(Number(c.distanceMeters) - metres) <= 150);
    if (exact.length === 1) return exact[0];
    const bucket = distanceBucket(metres);
    const same = bucket === 'other' ? [] : live.filter(c => distanceBucket(c.distanceMeters) === bucket);
    if (same.length === 1) return same[0];
  }
  return null;
}

export function createEventsRosterService({ db, registration, users, now = () => new Date(), closingSoonHours = () => 72, maxRows = eventsCorporateMaxRows }) {
  const R = registration.internals;

  const canValidate = access => access.platformAdmin || access.permissions.includes(ROSTER_PERMISSION);
  const canPlace = access => access.platformAdmin || ORG_BILLING_ROLES.includes(access.role);
  const canRead = access => canValidate(access) || canPlace(access);
  const activeOrg = access => (access.org?.status === 'active' ? null : fail('organization_not_active', 409, { organizationStatus: access.org?.status ?? null }));

  /** Rows from the body: `rows` (objects) or `rawText` (CSV). */
  function rowsOf(body) {
    if (Array.isArray(body.rows)) return body.rows.filter(r => r && typeof r === 'object').map((r, i) => ({ line: i + 1, ...r }));
    if (isStr(body.rawText)) return parseRosterText(body.rawText);
    return [];
  }

  /** One raw row → { index, participant (wire, consentBasis organisation), categoryId, ticketTypeId, problems } — category / ticket resolution only; the participant rules run in prepare(). */
  function readRow(raw, index, joined) {
    const problems = [];
    let firstName = isStr(raw.firstName) ? raw.firstName.trim() : '';
    let lastName = isStr(raw.lastName) ? raw.lastName.trim() : '';
    if (!firstName && !lastName && isStr(raw.name)) {
      const parts = raw.name.trim().split(/\s+/).filter(Boolean);
      if (parts.length < 2) problems.push({ field: 'name', code: 'name_incomplete' });
      else { lastName = parts.pop(); firstName = parts.join(' '); }
    }
    const category = matchCategory(raw.category, joined.categories || []);
    let ticketType = null;
    if (!category) problems.push({ field: 'category', code: 'category_unknown' });
    else {
      const at = now();
      const opts = { now: at, closingSoonHours: closingSoonHours(), registrationClosesAt: joined.event.registrationClosesAt };
      const onSale = (category.ticketTypes || []).filter(t => t.status === 'active' && ['open', 'closing_soon'].includes(ticketAvailability(t, opts)));
      const closed = category.status === 'inactive' || (category.registrationClosesAt && at > new Date(category.registrationClosesAt));
      if (isStr(raw.ticketType) && raw.ticketType.trim()) {
        ticketType = (category.ticketTypes || []).find(t => String(t.name).trim().toLowerCase() === raw.ticketType.trim().toLowerCase()) ?? null;
        if (!ticketType) problems.push({ field: 'ticketType', code: 'ticket_type_unknown' });
        else if (closed || ticketType.status !== 'active') { problems.push({ field: 'category', code: 'category_closed' }); ticketType = null; }
      } else if (closed || !onSale.length) problems.push({ field: 'category', code: 'category_closed' });
      else ticketType = onSale.slice().sort((a, b) => Number(a.priceTzs) - Number(b.priceTzs) || String(a.id).localeCompare(b.id))[0];
    }
    const participant = {
      ticketTypeId: ticketType?.id ?? null, firstName, lastName,
      phone: isStr(raw.phone) ? raw.phone : raw.phone != null ? String(raw.phone) : undefined,
      email: isStr(raw.email) ? raw.email : undefined,
      dateOfBirth: raw.dateOfBirth != null && String(raw.dateOfBirth).trim() ? normaliseRosterDate(raw.dateOfBirth) : undefined,
      gender: isStr(raw.gender) && raw.gender.trim() ? raw.gender.trim() : undefined,
      kitSize: isStr(raw.kitSize) && raw.kitSize.trim() ? raw.kitSize.trim() : undefined,
      groupLabel: isStr(raw.group) && raw.group.trim() ? raw.group.trim() : (isStr(raw.groupLabel) && raw.groupLabel.trim() ? raw.groupLabel.trim() : undefined),
      consentBasis: 'organisation',
    };
    return { index, line: raw.line ?? index + 1, participant, categoryId: category?.id ?? null, ticketTypeId: ticketType?.id ?? null, problems };
  }

  /** Run the shared preparation over a subset of rows; maps every report back to the roster index. */
  async function prepareRows(rows, { organizationId, eventId, team = undefined }) {
    const usable = rows.filter(r => r.ticketTypeId);
    if (!usable.length) return { prep: null, usable };
    const lines = [...usable.reduce((m, r) => m.set(r.ticketTypeId, (m.get(r.ticketTypeId) ?? 0) + 1), new Map())].map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity }));
    const body = { eventId, lines, participants: usable.map(r => r.participant), ...(team ? { team } : {}) };
    const prep = await R.prepare({ mode: 'corporate', organizationId, body });
    return { prep, usable, lines };
  }

  /** Read, resolve and check every row; → { error } | { joined, rows, duplicates, usable, prep } with problems merged in. */
  async function checkRoster({ access, body }) {
    const inactive = activeOrg(access);
    if (inactive) return inactive;
    const joined = await R.joinedOf(isStr(body.eventId) ? body.eventId : null);
    if (!joined || !['published', 'registration_closed', 'in_progress', 'completed', 'cancelled'].includes(joined.event.status)) return fail('event_not_found', 404);
    if (joined.event.status !== 'published') return fail('event_not_open', 409, { eventStatus: joined.event.status });
    const raws = rowsOf(body);
    if (!raws.length) return fail('invalid_rows', 400);
    if (raws.length > maxRows()) return fail('too_many_rows', 413, { max: maxRows(), received: raws.length });
    const rows = raws.map((raw, i) => readRow(raw, i, joined));
    const first = await prepareRows(rows, { organizationId: access.org.id, eventId: joined.event.id });
    if (first.prep?.error) return first.prep;
    const duplicates = [];
    if (first.prep) {
      first.usable.forEach((row, k) => {
        const rep = first.prep.report[k];
        row.participant = { ...row.participant, ...first.prep.participants[k], ticketTypeId: row.ticketTypeId };
        for (const p of rep.problems) row.problems.push(p);
        if (rep.warnings.length) row.warnings = rep.warnings;
      });
      for (const d of first.prep.duplicates) duplicates.push({ index: first.usable[d.index].index, kind: d.kind, ...(d.otherIndex !== undefined ? { otherIndex: first.usable[d.otherIndex].index } : {}), ...(d.registrationStatus ? { registrationStatus: d.registrationStatus } : {}) });
    }
    for (const row of rows) row.ok = row.problems.length === 0;
    return { joined, rows, duplicates };
  }

  const rowOut = r => ({
    index: r.index, line: r.line, ok: r.ok,
    participant: {
      firstName: r.participant.firstName || null, lastName: r.participant.lastName || null, phone: r.participant.phoneNormalized ?? r.participant.phone ?? null, email: r.participant.emailNormalized ?? r.participant.email ?? null,
      dateOfBirth: r.participant.dateOfBirth ?? null, gender: r.participant.gender ?? null, kitSize: r.participant.kitSize ?? null, groupLabel: r.participant.groupLabel ?? null, consentBasis: 'organisation',
    },
    categoryId: r.categoryId, ticketTypeId: r.ticketTypeId, problems: r.problems, ...(r.warnings ? { warnings: r.warnings } : {}),
  });

  async function validate({ access, body = {} }) {
    if (!canValidate(access)) return fail('forbidden', 403, { requiredPermission: ROSTER_PERMISSION });
    const checked = await checkRoster({ access, body });
    if (checked.error) return checked;
    const { joined, rows, duplicates } = checked;
    const okRows = rows.filter(r => r.ok);
    const second = await prepareRows(okRows, { organizationId: access.org.id, eventId: joined.event.id, team: body.team });
    if (second.prep?.error) return second.prep;
    const q = second.prep ? R.quoteResponse(second.prep) : null;
    const capacityShort = (second.prep?.problems ?? []).filter(p => p.code === 'capacity_unavailable').map(p => ({ ticketTypeId: p.ticketTypeId, requested: p.requested, remaining: p.remaining }));
    const d = q ?? null;
    return {
      rows: rows.map(rowOut),
      duplicates,
      summary: { total: rows.length, ok: okRows.length, problems: rows.length - okRows.length, duplicates: duplicates.length },
      lines: second.lines ?? [],
      quote: d?.quote ?? null,
      availability: d?.availability ?? {},
      problems: (second.prep?.problems ?? []).filter(p => p.code !== 'capacity_unavailable'),
      team: d?.team ?? null,
      fields: d?.fields ?? null,
      consentText: d?.consentText ?? null,
      refundPolicy: d?.refundPolicy ?? null,
      termsVersion: joined.event.version,
      capacityShort,
    };
  }

  async function placeOrder({ access, body = {}, idempotencyKey, actorId }) {
    if (!canPlace(access)) return fail('forbidden', 403, { requiredRole: [...ORG_BILLING_ROLES] });
    const inactive = activeOrg(access);
    if (inactive) return inactive;
    // Replay / reuse is answered before the roster is re-validated: the first order's own places would otherwise
    // look like already_registered duplicates. The store scopes the key (organizationId, key).
    const scope = { purchaserUserId: null, organizationId: access.org.id };
    const earlier = await R.replay({ replayScope: scope, idempotencyKey, rawBody: body });
    if (earlier) return earlier.error ? earlier : { ...earlier, organizationId: access.org.id };
    const checked = await checkRoster({ access, body });
    if (checked.error) return checked;
    const bad = checked.rows.filter(r => !r.ok);
    if (bad.length) return fail('participant_invalid', 422, { participants: checked.rows.map(r => ({ index: r.index, ok: r.ok, problems: r.problems })), duplicates: checked.duplicates });
    const lines = [...checked.rows.reduce((m, r) => m.set(r.ticketTypeId, (m.get(r.ticketTypeId) ?? 0) + 1), new Map())].map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity }));
    const team = body.team && typeof body.team === 'object' && body.team.create ? { create: { name: body.team.create.name } } : undefined;
    const transformed = {
      eventId: checked.joined.event.id, lines, participants: checked.rows.map(r => r.participant), ...(team ? { team } : {}),
      acceptedTerms: body.acceptedTerms, consentTextVersion: body.consentTextVersion, expectedTotalTzs: body.expectedTotalTzs,
      costCentre: body.costCentre, purchaserReference: body.purchaserReference,
    };
    const r = await R.placeOrder({
      mode: 'corporate', purchaserUserId: null, organizationId: access.org.id, createdByUserId: actorId, body: transformed, rawBody: body, idempotencyKey, replayScope: scope,
    });
    if (r.error) return r;
    return { ...r, organizationId: access.org.id };
  }

  async function listOrders({ access, query = {} }) {
    if (!canRead(access)) return fail('forbidden', 403, { requiredPermission: ROSTER_PERMISSION });
    let q = db('EventOrder').where({ organizationId: access.org.id }).whereNull('purchaserUserId');
    if (['awaiting_payment', 'confirmed', 'cancelled', 'expired'].includes(query.status)) q = q.where({ status: query.status });
    const rows = await q.orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(500);
    const counts = rows.length ? await db('EventRegistration').whereIn('orderId', rows.map(r => r.id)).whereNot({ status: 'cancelled' }).groupBy('orderId').select('orderId').count({ n: '*' }) : [];
    const placesOf = new Map(counts.map(c => [c.orderId, Number(c.n)]));
    const creators = new Map();
    const items = [];
    for (const o of rows) {
      const j = await R.joinedOf(o.eventId);
      const s = R.summaryOf(j);
      if (o.createdByUserId && !creators.has(o.createdByUserId)) creators.set(o.createdByUserId, (await users.findByIdAsync(o.createdByUserId))?.displayName ?? null);
      items.push({
        id: o.id, reference: o.reference, status: o.status,
        event: s ? { id: s.id, slug: s.slug, title: s.title, startsAt: s.startsAt, timezone: s.timezone, utcOffsetMinutes: s.utcOffsetMinutes, timezoneAbbr: s.timezoneAbbr, heroThumbUrl: s.heroThumbUrl } : null,
        placesCount: placesOf.get(o.id) ?? 0, totalTzs: o.totalTzs, discountTzs: o.discountTzs, feesTzs: o.feesTzs, currency: o.currency, holdExpiresAt: iso(o.holdExpiresAt), createdAt: iso(o.createdAt), closedAt: iso(o.closedAt), closeReason: o.closeReason ?? null,
        createdBy: { id: o.createdByUserId ?? null, name: creators.get(o.createdByUserId) ?? null }, costCentre: o.costCentre ?? null, purchaserReference: o.purchaserReference ?? null,
        allowedActions: o.status === 'awaiting_payment' && canPlace(access) ? ['cancel'] : [],
      });
    }
    const page = paginate(items, { limit: Math.min(parseInt(query.limit, 10) || 20, 50), cursor: query.cursor });
    return { items: page.items, nextCursor: page.nextCursor === null ? null : String(page.nextCursor) };
  }

  async function ownOrder(access, orderId) {
    const loaded = await R.loadOrder(orderId);
    if (!loaded || loaded.order.organizationId !== access.org.id || loaded.order.purchaserUserId) return fail('order_not_found', 404);
    return loaded;
  }

  async function getOrder({ access, orderId }) {
    if (!canRead(access)) return fail('forbidden', 403, { requiredPermission: ROSTER_PERMISSION });
    const loaded = await ownOrder(access, orderId);
    if (loaded.error) return loaded;
    const detail = await R.orderDetail(loaded, { actions: loaded.order.status === 'awaiting_payment' && canPlace(access) ? ['cancel'] : [] });
    const creator = loaded.order.createdByUserId ? await users.findByIdAsync(loaded.order.createdByUserId) : null;
    return { ...detail, organizationId: access.org.id, createdBy: creator ? { id: creator.id, name: creator.displayName ?? null } : null };
  }

  async function cancelOrder({ access, orderId, body = {}, actorId }) {
    if (!canPlace(access)) return fail('forbidden', 403, { requiredRole: [...ORG_BILLING_ROLES] });
    if (!MEMBER_CANCEL_REASONS.includes(body.reason)) return fail('invalid_reason', 400, { allowed: [...MEMBER_CANCEL_REASONS] });
    const loaded = await ownOrder(access, orderId);
    if (loaded.error) return loaded;
    const r = await R.releaseWholeOrder(loaded, { reason: body.reason, actor: `organization:${actorId}` });
    if (r.error) return r;
    return { order: R.orderView(r.order), registrations: r.registrations.map(x => R.registrationView(x)), changed: r.changed };
  }

  return { validate, placeOrder, listOrders, getOrder, cancelOrder, parseRosterText, matchCategory };
}
