// Marathon & running events · S3 — registration modes and checkout orders (spec §3; decisions D14–D21).
//
//   quote / createOrder        POST /me/event-orders/quote, POST /me/event-orders (Idempotency-Key, expectedTotalTzs)
//   listOrders / getOrder      GET /me/event-orders[/:id]
//   cancelOrder                POST /me/event-orders/:id/cancel (releaseOrder, reason from MEMBER_CANCEL_REASONS)
//   listRegistrations / getRegistration / cancelRegistration / claimable
//   claimPreview / claim       GET /event-claims/preview/:token, POST /me/event-registrations/:id/claim, …/claim { token }
//   createTeam / lookupTeam / getTeam
//   organizer*                 GET /organizer/events/:id/registrations[/summary], /orders (masked per status, §3.13)
//   admin*                     GET /admin/events/:id/orders[/:orderId], /registrations; POST …/orders/:id/cancel
//   onOrderExpired             the expireHolds hook (notification 2, analytics order_expired)
//   inviteClaims               BUILT, NOT CALLED in S3: the S4 payment-confirmation seam sends SMS / email claim links
//   placeOrder (internal)      shared by the corporate roster service (events-roster-service.mjs)
//
// Rules the routes rely on: the store is the only writer of money and holds; the service never forwards
// holdTtlMinutes, feeRule, per-line discounts or participantUserId from a body (follow-ups S3); discounts
// come from EVENTS_ORG_DISCOUNTS only; every refusal is { error, status, ...extra } (D5), never thrown.
// Logs carry ids and codes only, never participant fields (spec §7.3).
import { randomUUID } from 'node:crypto';
import { quoteLines } from '../shared/events-pricing.mjs';
import { summaryView, detailView, ticketAvailability, availabilityOf, DEFAULT_CLOSING_SOON_HOURS } from '../shared/events-document.mjs';
import {
  effectiveFields, checkParticipant, findDuplicatesInRequest, consentTextFor, maskName, maskFirstName, lastInitial, maskContactShort,
  canonicalFingerprint, IDEMPOTENCY_KEY_RE, newJoinCode, normaliseJoinCode, formatJoinCode, newClaimToken, hashToken, isClaimTokenShape,
  localTimeIn, localHourMinuteIn, oversizedField, startsLikeFormula, MEMBER_CANCEL_REASONS, TEAM_TYPES_MEMBER, DUPLICATE_POLICIES,
} from '../shared/events-participants.mjs';
import { swahiliTime } from '../shared/vendor-documents.mjs';
import { storeRefusal } from '../infra/event-store-pg.mjs';
import { paginate } from '../shared/pagination.mjs';
import {
  eventsMaxParticipantsPerOrder, eventsCorporateMaxRows, eventsTeamMaxMembers, eventsClaimTokenDays, eventsConsentTextVersion, eventsFeeRule, eventsOrgDiscounts, feeLabelFor, ORG_DISCOUNT_LABEL,
} from '../shared/events-config.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const LIVE_REGISTRATION = ['reserved', 'confirmed'];
const iso = v => (v ? new Date(v).toISOString() : null);
const isInt = n => Number.isInteger(n);
const isStr = v => typeof v === 'string';
const ORDER_STATUS_FILTER = ['awaiting_payment', 'confirmed', 'cancelled', 'expired'];
const pageOpts = query => ({ limit: Math.min(parseInt(query.limit, 10) || 20, 50), cursor: query.cursor });

/** Which of the two contacts a claim notice / preview talks about (phone first, as on the roster). */
const contactOf = reg => maskContactShort({ phone: reg.phoneNormalized, email: reg.emailNormalized });

export function createEventsRegistrationService({
  db, eventStore, catalogue, users, verifiedContacts, auditLog = null,
  notify = async () => {}, localeOf = async () => null, track = async () => {}, now = () => new Date(),
  closingSoonHours = () => DEFAULT_CLOSING_SOON_HOURS,
  claimCodes = () => ({ smsCodes: false, emailCodes: false }),
  senders = { sms: () => ({ configured: false }), email: () => ({ configured: false }) },
  shareBase = () => process.env.FRIEND_INVITE_BASE_URL || process.env.APP_DOWNLOAD_LINK || 'https://fitflex-af-app.web.app',
  config = {},
}) {
  const cfg = {
    maxParticipantsPerOrder: eventsMaxParticipantsPerOrder, corporateMaxRows: eventsCorporateMaxRows, teamMaxMembers: eventsTeamMaxMembers,
    claimTokenDays: eventsClaimTokenDays, consentTextVersion: eventsConsentTextVersion, feeRule: eventsFeeRule, orgDiscounts: eventsOrgDiscounts, ...config,
  };
  const nowIso = () => now().toISOString();
  const viewOpts = () => ({ now: now(), closingSoonHours: closingSoonHours() });

  const audit = async (actor, action, target, before, after) => {
    if (!auditLog) return;
    await auditLog.insertAsync({ id: `aud_${randomUUID().slice(0, 8)}`, at: nowIso(), actor: actor || 'system', action, target, before: before ?? null, after: after ?? null });
  };
  /** Server-side analytics (spec §7.2): named, no personal data; an AuditLog row until a pipeline exists (as S2). */
  const analytics = async (name, payload) => {
    try { await audit('system', `analytics.${name}`, payload.eventId ?? payload.orderId ?? 'events', null, payload); } catch { /* best effort */ }
    try { await track(name, payload); } catch { /* best effort */ }
  };

  // ── Views ──────────────────────────────────────────────────────────────────

  const joinedOf = async eventId => (eventId ? catalogue.loadJoined(eventId) : null);
  const summaryOf = joined => (joined ? summaryView(joined, viewOpts()) : null);
  const namesOf = joined => {
    const categories = new Map();
    const tickets = new Map();
    for (const c of joined?.categories || []) {
      categories.set(c.id, c);
      for (const t of c.ticketTypes || []) tickets.set(t.id, { ...t, categoryName: c.name });
    }
    return { categories, tickets };
  };

  const claimStateOf = reg => (reg.participantUserId ? (reg.purchaserUserId && reg.participantUserId === reg.purchaserUserId && reg.consentBasis === 'self' ? 'self' : 'claimed') : 'unclaimed');

  const orderView = o => ({
    id: o.id, reference: o.reference, eventId: o.eventId, organizationId: o.organizationId ?? null, status: o.status, currency: o.currency,
    subtotalTzs: o.subtotalTzs, discountTzs: o.discountTzs, feesTzs: o.feesTzs, totalTzs: o.totalTzs,
    holdExpiresAt: iso(o.holdExpiresAt), holdCycle: o.holdCycle, createdAt: iso(o.createdAt), updatedAt: iso(o.updatedAt),
    confirmedAt: iso(o.confirmedAt), closedAt: iso(o.closedAt), closeReason: o.closeReason ?? null, teamId: o.teamId ?? null,
    costCentre: o.costCentre ?? null, purchaserReference: o.purchaserReference ?? null,
    termsAcceptedAt: iso(o.termsAcceptedAt), consentTextVersion: o.consentTextVersion ?? null,
  });

  const lineView = (l, names) => {
    const t = names.tickets.get(l.ticketTypeId);
    return {
      ticketTypeId: l.ticketTypeId, ticketTypeName: t?.name ?? null, categoryId: t?.categoryId ?? null, categoryName: t?.categoryName ?? null,
      quantity: l.quantity, unitPriceTzs: l.unitPriceTzs, discountTzs: l.discountTzs, feesTzs: l.feesTzs, lineTotalTzs: l.lineTotalTzs,
    };
  };

  /** A registration as the purchaser / participant sees it; `full` adds the typed participant fields (§3.6). */
  const registrationView = (r, { full = false } = {}) => ({
    id: r.id, ticketTypeId: r.ticketTypeId, categoryId: r.categoryId, orderId: r.orderId, firstName: r.firstName, lastName: r.lastName,
    status: r.status, consentBasis: r.consentBasis, isSelf: claimStateOf(r) === 'self', claimState: claimStateOf(r),
    cancelReason: r.cancelReason ?? null, groupLabel: r.groupLabel ?? null, createdAt: iso(r.createdAt),
    ...(full ? {
      phone: r.phone ?? null, email: r.email ?? null, dateOfBirth: r.dateOfBirth ? String(r.dateOfBirth).slice(0, 10) : null, gender: r.gender ?? null,
      kitSize: r.kitSize ?? null, emergencyContact: r.emergencyContact ?? null, consentAt: iso(r.consentAt), consentTextVersion: r.consentTextVersion ?? null, claimedAt: iso(r.claimedAt),
    } : {}),
  });

  const paymentNext = () => ({ payment: 'none', instructions: null });

  async function teamView(teamId, { viewerUserId = null } = {}) {
    if (!teamId) return null;
    const team = await db('EventTeam').where({ id: teamId }).first();
    if (!team) return null;
    const members = await liveMembers(teamId);
    const captain = team.captainRegistrationId ? members.find(m => m.registrationId === team.captainRegistrationId) : null;
    const isCaptain = Boolean(viewerUserId && ((captain && captain.participantUserId === viewerUserId) || team.createdByUserId === viewerUserId));
    return {
      id: team.id, eventId: team.eventId, name: team.name, teamType: team.teamType, status: team.status, memberCount: members.length,
      maxMembers: team.maxMembers ?? cfg.teamMaxMembers(), captainRegistrationId: team.captainRegistrationId ?? null, createdByUserId: team.createdByUserId ?? null,
      organizationId: team.organizationId ?? null, isCaptain, joinCode: isCaptain ? formatJoinCode(team.joinCode) : undefined,
    };
  }
  const liveMembers = teamId => db('EventTeamMember as m').join('EventRegistration as r', 'r.id', 'm.registrationId')
    .where({ 'm.teamId': teamId }).whereIn('r.status', LIVE_REGISTRATION)
    .select('m.registrationId', 'm.role', 'r.firstName', 'r.lastName', 'r.status', 'r.participantUserId', 'r.purchaserUserId').orderBy('m.createdAt');

  const eventBlock = async (joined, { full = false } = {}) => {
    const s = summaryOf(joined);
    if (!s || !full) return s;
    const d = detailView(joined, viewOpts());
    return { ...s, refundPolicy: d.refundPolicy, contact: d.contact, terms: d.terms };
  };

  // ── Shared preparation (quote and order, member and corporate) ─────────────

  /** Live ticket availability for the quote (same vocabulary as S2 §11.3; remaining null unless ≤ 10). */
  const availabilityMap = joined => {
    const e = joined.event;
    const out = {};
    const eventAvailability = availabilityOf(e, (joined.categories || []).flatMap(c => c.ticketTypes || []), viewOpts());
    for (const c of joined.categories || []) {
      for (const t of c.ticketTypes || []) {
        const remaining = Math.max(Number(t.capacity) - Number(t.sold ?? 0) - Number(t.held ?? 0), 0);
        let availability = ticketAvailability(t, { ...viewOpts(), registrationClosesAt: e.registrationClosesAt });
        if (c.status === 'inactive') availability = 'closed';
        if (['closed', 'in_progress', 'sold_out', 'not_yet_open'].includes(eventAvailability) && availability === 'open') availability = eventAvailability;
        out[t.id] = { availability, remaining: remaining <= 10 ? remaining : null, _remaining: remaining, _status: t.status, _categoryStatus: c.status };
      }
    }
    return out;
  };
  const publicAvailability = map => Object.fromEntries(Object.entries(map).map(([id, a]) => [id, { availability: a.availability, remaining: a.remaining }]));

  /**
   * Everything the order route validates, without locking or holding (spec §3.4, §3.5 steps 1–4, §3.10).
   *   mode 'member' (purchaserUserId) | 'corporate' (organizationId); body as on the wire.
   * → { error } for the 4xx refusals that are not 200-with-problems, else
   *   { joined, event, names, fields, lines, participants (normalised, with categoryId), report, problems, team, quote, availability, discounts }
   */
  async function prepare({ mode, purchaserUserId = null, organizationId = null, body = {} }) {
    const joined = await joinedOf(isStr(body.eventId) ? body.eventId : null);
    if (!joined || !['published', 'registration_closed', 'in_progress', 'completed', 'cancelled'].includes(joined.event.status)) return fail('event_not_found', 404);
    const event = joined.event;
    if (event.status !== 'published') return fail('event_not_open', 409, { eventStatus: event.status });
    const at = now();
    if (event.registrationClosesAt && at > new Date(event.registrationClosesAt)) return fail('registration_closed', 409);
    if (event.registrationOpensAt && at < new Date(event.registrationOpensAt)) return fail('event_not_open', 409, { eventStatus: event.status, registrationOpensAt: iso(event.registrationOpensAt) });
    const names = namesOf(joined);

    // lines
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 200) return fail('invalid_lines', 400);
    const wanted = new Map();
    for (const line of body.lines) {
      if (!line || !isStr(line.ticketTypeId) || wanted.has(line.ticketTypeId) || !isInt(line.quantity) || line.quantity < 1) return fail('invalid_lines', 400, { ticketTypeId: line?.ticketTypeId ?? null });
      if (!names.tickets.has(line.ticketTypeId)) return fail('invalid_lines', 400, { ticketTypeId: line.ticketTypeId, reason: 'ticket_type_not_found' });
      wanted.set(line.ticketTypeId, line.quantity);
    }
    const lines = [...wanted].map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity })).sort((a, b) => (a.ticketTypeId < b.ticketTypeId ? -1 : 1));
    const totalQuantity = lines.reduce((n, l) => n + l.quantity, 0);

    // participants: count per ticket type must match the lines
    const raw = Array.isArray(body.participants) ? body.participants : null;
    if (!raw || raw.length !== totalQuantity) return fail('participants_mismatch', 400, { expected: totalQuantity, received: raw?.length ?? 0 });
    const perType = new Map();
    for (const p of raw) perType.set(p?.ticketTypeId, (perType.get(p?.ticketTypeId) ?? 0) + 1);
    for (const [ticketTypeId, quantity] of wanted) if ((perType.get(ticketTypeId) ?? 0) !== quantity) return fail('participants_mismatch', 400, { ticketTypeId, expected: quantity, received: perType.get(ticketTypeId) ?? 0 });

    // Input caps run before any regex or normaliser (review M4): an oversized field is a 400, nothing else is evaluated.
    for (let i = 0; i < raw.length; i += 1) {
      const big = oversizedField(raw[i]);
      if (big) return fail('field_too_long', 400, { index: i, field: big.field, max: big.max });
    }
    const fields = effectiveFields(event, joined.categories);
    const purchaserContacts = mode === 'member' && purchaserUserId ? await verifiedContacts.contactsFor(purchaserUserId) : [];
    const participants = [];
    const report = [];
    let selfCount = 0;
    raw.forEach((p, index) => {
      const t = names.tickets.get(p?.ticketTypeId);
      const category = t ? names.categories.get(t.categoryId) : null;
      const checked = checkParticipant(p, { fields, category, event, mode, purchaserContacts, now: at });
      const participant = { ...checked.participant, categoryId: category?.id ?? null, index };
      if (participant.consentBasis === 'self' && ++selfCount > 1) checked.problems.push({ field: 'consentBasis', code: 'multiple_self_participants' });
      participants.push(participant);
      report.push({ index, ok: checked.problems.length === 0, problems: checked.problems, warnings: checked.warnings });
    });
    // duplicates: within the request, then against live registrations of the same category (D20)
    const policy = DUPLICATE_POLICIES.includes(event.duplicatePolicy) ? event.duplicatePolicy : 'one_per_category';
    const duplicates = [];
    if (policy === 'one_per_category') {
      for (const d of findDuplicatesInRequest(participants)) {
        report[d.index].problems.push({ field: d.key, code: 'duplicate_participant', otherIndex: d.otherIndex });
        report[d.index].ok = false;
        duplicates.push({ index: d.index, kind: 'in_list', otherIndex: d.otherIndex });
      }
      const phones = participants.map(p => p.phoneNormalized).filter(Boolean);
      const emails = participants.map(p => p.emailNormalized).filter(Boolean);
      if (phones.length || emails.length) {
        const existing = await db('EventRegistration as r').join('EventOrder as o', 'o.id', 'r.orderId').where({ 'r.eventId': event.id }).whereIn('r.status', LIVE_REGISTRATION)
          .where(b => { if (phones.length) b.orWhereIn('r.phoneNormalized', phones); if (emails.length) b.orWhereIn('r.emailNormalized', emails); })
          .select('r.id', 'r.categoryId', 'r.phoneNormalized', 'r.emailNormalized', 'r.status', 'r.purchaserUserId', 'o.organizationId');
        participants.forEach((p, index) => {
          const hit = existing.find(r => r.categoryId === p.categoryId && ((p.phoneNormalized && r.phoneNormalized === p.phoneNormalized) || (p.emailNormalized && r.emailNormalized === p.emailNormalized)));
          if (hit && !report[index].problems.some(x => x.code === 'duplicate_participant')) {
            // Someone else's registration is never identified (review M1): ids and statuses only for the caller's own live orders.
            const own = mode === 'corporate' ? Boolean(organizationId) && hit.organizationId === organizationId : Boolean(purchaserUserId) && hit.purchaserUserId === purchaserUserId;
            const field = p.phoneNormalized && hit.phoneNormalized === p.phoneNormalized ? 'phone' : 'email';
            report[index].problems.push(own ? { field, code: 'duplicate_participant', registrationId: hit.id } : { field, code: 'duplicate_participant' });
            report[index].ok = false;
            duplicates.push(own ? { index, kind: 'already_registered', registrationStatus: hit.status } : { index, kind: 'already_registered' });
          }
        });
      }
    }

    // order-level problems (reported, not refused, so the app shows them all)
    const problems = [];
    const availability = availabilityMap(joined);
    const maxParticipants = mode === 'corporate' ? cfg.corporateMaxRows() : cfg.maxParticipantsPerOrder();
    if (totalQuantity > maxParticipants) problems.push({ code: 'too_many_participants', max: maxParticipants });
    const liveTicketRows = [];
    for (const line of lines) {
      const t = names.tickets.get(line.ticketTypeId);
      const a = availability[line.ticketTypeId];
      liveTicketRows.push({ id: t.id, priceTzs: Number(t.priceTzs), currency: t.currency || 'TZS', name: t.name, categoryId: t.categoryId });
      if (t.status !== 'active') problems.push({ code: 'ticket_type_inactive', ticketTypeId: t.id });
      else if (a._categoryStatus === 'inactive') problems.push({ code: 'category_inactive', ticketTypeId: t.id, categoryId: t.categoryId });
      else if (a.availability === 'not_yet_open') problems.push({ code: 'sale_not_open', ticketTypeId: t.id });
      else if (a.availability === 'closed' || a.availability === 'in_progress') problems.push({ code: 'sale_closed', ticketTypeId: t.id });
      if (line.quantity < t.minPerOrder || (mode !== 'corporate' && line.quantity > t.maxPerOrder)) problems.push({ code: 'quantity_out_of_range', ticketTypeId: t.id, min: t.minPerOrder, max: t.maxPerOrder });
      if (a._remaining < line.quantity) problems.push({ code: 'capacity_unavailable', ticketTypeId: t.id, requested: line.quantity, remaining: a._remaining });
    }

    // discounts: server config only (corporate organisation percentage)
    let discounts = null;
    if (mode === 'corporate' && organizationId) {
      const rules = cfg.orgDiscounts();
      if (rules.error) return fail('invalid_config', 500);
      const pct = rules[organizationId]?.pct ?? 0;
      if (pct > 0) {
        discounts = {};
        for (const line of lines) {
          const t = names.tickets.get(line.ticketTypeId);
          discounts[line.ticketTypeId] = Math.floor(Number(t.priceTzs) * line.quantity * pct / 100 + 0.5);
        }
      }
    }
    const feeRule = cfg.feeRule();
    if (feeRule.error) return fail('invalid_config', 500);
    const priced = quoteLines(liveTicketRows, lines.map(l => ({ ...l, discountTzs: discounts?.[l.ticketTypeId] ?? 0 })), { feeRule });
    if (priced.error) return priced;
    const quote = {
      currency: priced.currency,
      lines: priced.lines.map(l => ({ ...l, ticketTypeName: names.tickets.get(l.ticketTypeId)?.name ?? null, categoryId: names.tickets.get(l.ticketTypeId)?.categoryId ?? null, categoryName: names.tickets.get(l.ticketTypeId)?.categoryName ?? null })),
      subtotalTzs: priced.subtotalTzs, discountTzs: priced.discountTzs, feesTzs: priced.feesTzs, totalTzs: priced.totalTzs,
      feeLabel: feeLabelFor(feeRule), discountLabel: priced.discountTzs > 0 ? { ...ORG_DISCOUNT_LABEL } : null,
    };

    // team (spec §3.9)
    const team = await prepareTeam({ mode, event, body, places: totalQuantity, purchaserUserId });
    if (team?.error) return team;
    if (team && !team.ok) for (const p of team.problems) problems.push(p);

    return { joined, event, names, fields, lines, participants, report, duplicates, problems, team, quote, availability, discounts, feeRule, totalQuantity };
  }

  /** The team part of a quote / order body → null | { mode: 'create'|'join', ok, problems, name, memberCount, maxMembers, teamType, team? }. */
  async function prepareTeam({ mode, event, body, places, purchaserUserId }) {
    const t = body.team;
    if (!t || typeof t !== 'object') return null;
    const maxMembers = cfg.teamMaxMembers();
    if (t.create && typeof t.create === 'object') {
      const name = isStr(t.create.name) ? t.create.name.trim() : '';
      const teamType = mode === 'corporate' ? 'corporate' : (isStr(t.create.teamType) ? t.create.teamType : 'community');
      const problems = [];
      if (name.length < 1 || name.length > 120 || startsLikeFormula(name)) problems.push({ code: 'team_name_invalid' });
      if (mode !== 'corporate' && !TEAM_TYPES_MEMBER.includes(teamType)) problems.push({ code: 'team_type_invalid' });
      if (name && await db('EventTeam').where({ eventId: event.id }).whereRaw('lower(name) = lower(?)', [name]).first('id')) problems.push({ code: 'team_name_taken' });
      if (places > maxMembers) problems.push({ code: 'team_full', maxMembers });
      return { mode: 'create', name, teamType, memberCount: 0, maxMembers, ok: !problems.length, problems };
    }
    if (t.joinCode !== undefined) {
      if (mode === 'corporate') return { mode: 'join', name: null, memberCount: 0, maxMembers, ok: false, problems: [{ code: 'team_not_found' }] };
      const found = await findTeamByCode(event.id, t.joinCode);
      if (found.error) return { mode: 'join', name: null, memberCount: 0, maxMembers, ok: false, problems: [{ code: found.error, ...(found.maxMembers ? { maxMembers: found.maxMembers } : {}) }] };
      const problems = [];
      if (found.memberCount + places > found.maxMembers) problems.push({ code: 'team_full', maxMembers: found.maxMembers, memberCount: found.memberCount });
      return { mode: 'join', name: found.team.name, teamType: found.team.teamType, memberCount: found.memberCount, maxMembers: found.maxMembers, ok: !problems.length, problems, team: found.team };
    }
    return null;
  }

  /** { team, memberCount, maxMembers } by join code within one event, or { error: team_not_found | team_disbanded }. */
  async function findTeamByCode(eventId, joinCode) {
    const code = typeof joinCode === 'string' && joinCode.length <= 32 ? normaliseJoinCode(joinCode) : null;
    if (!code) return fail('team_not_found', 404);
    const team = await db('EventTeam').where({ eventId, joinCode: code }).first();
    if (!team) return fail('team_not_found', 404);
    if (team.status !== 'active') return fail('team_disbanded', 409);
    const memberCount = (await liveMembers(team.id)).length;
    return { team, memberCount, maxMembers: team.maxMembers ?? cfg.teamMaxMembers() };
  }

  const participantsReport = report => report.map(r => ({ index: r.index, ok: r.ok, problems: r.problems, ...(r.warnings.length ? { warnings: r.warnings } : {}) }));

  // ── Quote (§3.4) ───────────────────────────────────────────────────────────

  async function quote({ userId, body = {} }) {
    if (body.organizationId != null) return fail('organization_not_allowed', 400);
    const prep = await prepare({ mode: 'member', purchaserUserId: userId, body });
    if (prep.error) return prep;
    return quoteResponse(prep);
  }

  function quoteResponse(prep) {
    const d = detailView(prep.joined, viewOpts());
    const version = cfg.consentTextVersion();
    const valid = prep.report.every(r => r.ok) && !prep.problems.length && (!prep.team || prep.team.ok);
    return {
      valid,
      quote: prep.quote,
      quoteExpiresAt: new Date(+now() + 5 * 60_000).toISOString(),
      holdTtlMinutes: eventStore.holdTtlMinutes(),
      availability: publicAvailability(prep.availability),
      participants: participantsReport(prep.report),
      problems: prep.problems,
      team: prep.team ? { mode: prep.team.mode, name: prep.team.name, memberCount: prep.team.memberCount, maxMembers: prep.team.maxMembers, ok: prep.team.ok, problems: prep.team.problems } : null,
      fields: prep.fields,
      refundPolicy: d.refundPolicy, termsVersion: prep.event.version,
      consentText: { version, ...consentTextFor(version) },
    };
  }

  // ── Order (§3.5, §3.10) ────────────────────────────────────────────────────

  /** The Idempotency-Key header, checked (400 idempotency_key_required). */
  function readIdempotencyKey(key) {
    if (!isStr(key) || !key.trim()) return fail('idempotency_key_required', 400);
    if (!IDEMPOTENCY_KEY_RE.test(key.trim())) return fail('idempotency_key_required', 400, { reason: 'shape', rule: '8-100 chars [A-Za-z0-9._:-]' });
    return { key: key.trim() };
  }

  /**
   * Place an order (shared by member and corporate routes). The route has already bound the caller to the
   * scope (member → purchaserUserId; corporate → organizationId through the B2B guard).
   *   mode, purchaserUserId | organizationId, createdByUserId, body, idempotencyKey, extra { costCentre, purchaserReference, groupLabels }
   */
  /**
   * The earlier answer for this Idempotency-Key, before any validation runs (the original stands even if the
   * event, the consent text or the duplicate picture has since changed): null when the key is new,
   * { error: idempotency_key_required | idempotency_key_reused } or { status: 200, …order, replayed: true }.
   */
  async function replay({ replayScope, idempotencyKey, rawBody, viewerUserId = null }) {
    const k = readIdempotencyKey(idempotencyKey);
    if (k.error) return k;
    const earlier = await eventStore.replayOrder(replayScope, k.key, canonicalFingerprint(rawBody));
    if (!earlier) return null;
    if (earlier.error) return earlier;
    return { status: 200, ...(await orderResponse(earlier, { viewerUserId })), replayed: true };
  }

  async function placeOrder({ mode, purchaserUserId = null, organizationId = null, createdByUserId = null, body = {}, rawBody = body, idempotencyKey, replayScope }) {
    const k = readIdempotencyKey(idempotencyKey);
    if (k.error) return k;
    // The fingerprint is of the body as the client sent it (corporate rows are transformed before pricing).
    const fingerprint = canonicalFingerprint(rawBody);
    // Replay first: the original answer stands even if the event or the consent text has since changed.
    const earlier = await replay({ replayScope, idempotencyKey, rawBody, viewerUserId: purchaserUserId });
    if (earlier) return earlier;

    if (mode === 'member' && body.organizationId != null) return fail('organization_not_allowed', 400);
    // The total the client was quoted is mandatory (review M2): an order is never placed blind. The quote stays free of it.
    if (body.expectedTotalTzs === undefined || body.expectedTotalTzs === null) return fail('expected_total_required', 400);
    if (!isInt(body.expectedTotalTzs) || body.expectedTotalTzs < 0) return fail('invalid_expected_total', 400);
    for (const field of ['costCentre', 'purchaserReference']) {
      if (body[field] !== undefined && body[field] !== null && (!isStr(body[field]) || body[field].length > 80 || startsLikeFormula(body[field]))) return fail('invalid_text', 400, { field });
    }
    const prep = await prepare({ mode, purchaserUserId, organizationId, body });
    if (prep.error) return prep;
    const bad = prep.report.filter(r => !r.ok);
    if (bad.length) return fail('participant_invalid', 422, { participants: participantsReport(prep.report) });
    if (body.acceptedTerms !== true) return fail('terms_not_accepted', 400);
    const version = cfg.consentTextVersion();
    if (body.consentTextVersion !== version) return fail('consent_version_stale', 409, { current: version });
    const tooMany = prep.problems.find(p => p.code === 'too_many_participants');
    if (tooMany) return fail('too_many_participants', 400, { max: tooMany.max });
    if (prep.team && !prep.team.ok) {
      const p = prep.team.problems[0];
      const status = p.code === 'team_not_found' ? 404 : p.code === 'team_name_invalid' || p.code === 'team_type_invalid' ? 400 : 409;
      return fail(p.code, status, { ...p, code: undefined });
    }

    const at = now();
    const claimExpiresAt = new Date(+at + cfg.claimTokenDays() * 86_400_000);
    const participants = prep.participants.map(p => ({
      ticketTypeId: p.ticketTypeId, firstName: p.firstName, lastName: p.lastName, phone: p.phone, email: p.email, dateOfBirth: p.dateOfBirth, gender: p.gender,
      emergencyContact: p.emergencyContact, consentBasis: p.consentBasis, kitSize: p.kitSize, groupLabel: p.groupLabel ?? null,
      phoneNormalized: p.phoneNormalized, emailNormalized: p.emailNormalized, consentTextVersion: version, consentAt: at,
      // A non-self place gets a claim link lifetime now; the token itself is minted when an invitation is sent (S4).
      ...(p.consentBasis === 'self' ? {} : { claimTokenHash: hashToken(newClaimToken()), claimTokenExpiresAt: claimExpiresAt }),
    }));
    const orderExtra = {
      createdByUserId: createdByUserId ?? purchaserUserId, termsAcceptedAt: at, consentTextVersion: version,
      costCentre: mode === 'corporate' && isStr(body.costCentre) && body.costCentre.trim() ? body.costCentre.trim().slice(0, 80) : null,
      purchaserReference: mode === 'corporate' && isStr(body.purchaserReference) && body.purchaserReference.trim() ? body.purchaserReference.trim().slice(0, 80) : null,
    };
    // Hold abuse (review M3): a member keeps one live unpaid order per event and at most the per-order place limit held.
    if (mode === 'member') {
      const limited = await holdLimit(db, purchaserUserId, prep.event.id, prep.totalQuantity);
      if (limited) return limited;
    }
    const result = await eventStore.createOrderWithHolds({
      eventId: prep.event.id, purchaserUserId, organizationId, lines: prep.lines, participants,
      idempotencyKey: k.key, fingerprint, discounts: prep.discounts, expectedTotalTzs: body.expectedTotalTzs,
      bulk: mode === 'corporate', orderExtra, feeRule: prep.feeRule,
      afterCreate: (mode === 'member' || prep.team) ? async (trx, created) => {
        if (mode === 'member') {
          // Serialise this user's orders for this event; the earlier committed order is then visible (a race loses here).
          await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`evh:${purchaserUserId}:${prep.event.id}`]);
          const limited = await holdLimit(trx, purchaserUserId, prep.event.id, 0, created.order.id);
          if (limited) throw storeRefusal(limited.error, limited.status, { reason: limited.reason });
        }
        if (prep.team) await attachTeam(trx, created, { team: prep.team, organizationId, purchaserUserId: purchaserUserId ?? createdByUserId, at });
      } : null,
    });
    if (result.error) return result;
    if (result.replayed) return { status: 200, ...(await orderResponse(result, { viewerUserId: purchaserUserId })), replayed: true };

    await afterOrderCreated(result, { mode, purchaserUserId, createdByUserId: orderExtra.createdByUserId, joined: prep.joined });
    return { status: 201, ...(await orderResponse(result, { viewerUserId: purchaserUserId, joined: prep.joined })), replayed: false };
  }

  /** hold_limit_reached when the member already holds a live unpaid order for the event, or would hold more places than the per-order limit. */
  async function holdLimit(q, userId, eventId, newPlaces, exceptOrderId = null) {
    const live = q('EventOrder').where({ purchaserUserId: userId, eventId, status: 'awaiting_payment' }).where('holdExpiresAt', '>', now());
    if (exceptOrderId) live.whereNot({ id: exceptOrderId });
    const orders = await live.select('id');
    if (orders.length >= 1) return fail('hold_limit_reached', 409, { reason: 'unpaid_order_exists' });
    const held = orders.length ? Number((await q('EventRegistration').whereIn('orderId', orders.map(o => o.id)).where({ status: 'reserved' }).count({ n: '*' }).first())?.n || 0) : 0;
    if (held + newPlaces > cfg.maxParticipantsPerOrder()) return fail('hold_limit_reached', 409, { reason: 'places', max: cfg.maxParticipantsPerOrder() });
    return null;
  }

  /** In the order's transaction: create / join the team and enrol every registration (spec §3.5 step 6, §3.9). */
  async function attachTeam(trx, created, { team, organizationId, purchaserUserId, at }) {
    let row;
    if (team.mode === 'create') {
      const id = `evtm_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      try {
        [row] = await trx('EventTeam').insert({
          id, eventId: created.order.eventId, organizationId: organizationId ?? null, name: team.name, teamType: team.teamType, status: 'active',
          joinCode: newJoinCode(), maxMembers: null, createdByUserId: purchaserUserId ?? null, captainRegistrationId: null, createdAt: at, updatedAt: at,
        }).returning('*');
      } catch (err) {
        if (err.code === '23505') throw storeRefusal('team_name_taken', 409, { name: team.name });
        throw err;
      }
    } else {
      row = await trx('EventTeam').where({ id: team.team.id }).forUpdate().first();
      if (!row || row.status !== 'active') throw storeRefusal(row ? 'team_disbanded' : 'team_not_found', row ? 409 : 404);
      const count = (await trx('EventTeamMember as m').join('EventRegistration as r', 'r.id', 'm.registrationId').where({ 'm.teamId': row.id }).whereIn('r.status', LIVE_REGISTRATION).count({ n: '*' }).first());
      const memberCount = Number(count?.n || 0);
      const max = row.maxMembers ?? cfg.teamMaxMembers();
      if (memberCount + created.registrations.length > max) throw storeRefusal('team_full', 409, { maxMembers: max, memberCount });
    }
    const self = created.registrations.find(r => r.consentBasis === 'self');
    const captainWanted = !row.captainRegistrationId && (team.mode === 'create' || (row.createdByUserId && row.createdByUserId === purchaserUserId && self));
    const captainId = captainWanted ? (self?.id ?? created.registrations[0]?.id ?? null) : null;
    for (const reg of created.registrations) {
      await trx('EventTeamMember').insert({ id: `evtmm_${randomUUID().replace(/-/g, '').slice(0, 14)}`, teamId: row.id, eventId: reg.eventId, registrationId: reg.id, role: reg.id === captainId ? 'captain' : 'member', createdAt: at });
    }
    if (captainId) await trx('EventTeam').where({ id: row.id }).update({ captainRegistrationId: captainId, updatedAt: at });
    await trx('EventOrder').where({ id: created.order.id }).update({ teamId: row.id, updatedAt: at });
  }

  /** The 201 / 200 body of an order (§3.5). */
  async function orderResponse(result, { viewerUserId = null, joined = null } = {}) {
    const j = joined ?? await joinedOf(result.order.eventId);
    const names = namesOf(j);
    return {
      order: orderView(result.order),
      lines: result.lines.map(l => lineView(l, names)),
      registrations: result.registrations.map(r => registrationView(r)),
      holdExpiresAt: iso(result.order.holdExpiresAt),
      next: paymentNext(),
      event: summaryOf(j),
      team: await teamView(result.order.teamId, { viewerUserId }),
    };
  }

  /** After commit: notifications 1 and 3 (§3.14) and analytics. Failures are logged by id only. */
  async function afterOrderCreated(result, { mode, purchaserUserId, createdByUserId, joined }) {
    const order = result.order;
    try {
      const recipient = purchaserUserId ?? createdByUserId;
      if (recipient) await sendOrderCreated(recipient, order, result.registrations.length, joined.event);
      await notifyMatchingMembers(result.registrations, order, joined.event);
    } catch (err) {
      console.warn('[events] order notifications skipped:', order.id, err?.message);
    }
    await analytics('order_created', { eventId: order.eventId, orderId: order.id, placesCount: result.registrations.length, totalTzs: order.totalTzs, mode, team: Boolean(order.teamId) });
  }

  // ── Notifications (§3.14; bilingual via localeOf, as the trainer / invitation notices) ─────

  async function bilingualNotify(userId, { id, type, en, sw, data }) {
    let locale = null;
    try { locale = await localeOf(userId); } catch { locale = null; }
    const text = locale === 'sw' ? sw : en;
    return notify(userId, { id, type, title: text.title, body: text.body, data: { ...data, locale: locale === 'sw' ? 'sw' : 'en', titleEn: en.title, bodyEn: en.body, titleSw: sw.title, bodySw: sw.body } });
  }

  async function sendOrderCreated(userId, order, n, event) {
    const time = localTimeIn(event.timezone, order.holdExpiresAt);
    // Swahili uses the apps' 12-hour clock with the part of the day ("2:05 mchana"); English keeps 24-hour.
    const hm = localHourMinuteIn(event.timezone, order.holdExpiresAt);
    const timeSw = hm ? swahiliTime(hm.h, hm.min) : time;
    const enBody = n === 1
      ? `Your place for ${event.title} is held until ${time}. Payment instructions follow in the next app update.`
      : `Your ${n} places for ${event.title} are held until ${time}. Payment instructions follow in the next app update.`;
    const swBody = n === 1
      ? `Tiketi yako ya ${event.title} imeshikiliwa hadi ${timeSw}. Maelekezo ya malipo yatafuata kwenye toleo lijalo la app.`
      : `Tiketi zako ${n} za ${event.title} zimeshikiliwa hadi ${timeSw}. Maelekezo ya malipo yatafuata kwenye toleo lijalo la app.`;
    return bilingualNotify(userId, {
      id: `ntf_evo_${order.id}`.slice(0, 60), type: 'event_order_created',
      en: { title: 'Registration received · payment pending', body: enBody },
      sw: { title: 'Usajili umepokelewa · Inasubiri malipo', body: swBody },
      data: { orderId: order.id, eventId: order.eventId, route: `/member/events/orders/${order.id}` },
    });
  }

  /** Notification 3: members whose VERIFIED phone / email matches a non-self place (once per registration). */
  async function notifyMatchingMembers(registrations, order, event) {
    const rows = registrations.filter(r => !r.participantUserId && (r.phoneNormalized || r.emailNormalized));
    if (!rows.length) return;
    const { byPhone, byEmail } = await verifiedContacts.findMembers({ phones: rows.map(r => r.phoneNormalized).filter(Boolean), emails: rows.map(r => r.emailNormalized).filter(Boolean) });
    const purchaserName = order.purchaserUserId ? (await users.findByIdAsync(order.purchaserUserId))?.displayName : null;
    // Separate fallbacks per language: an English word never lands in a Swahili sentence.
    const orgName = !purchaserName && order.organizationId ? ((await db('B2BOrganization').where({ id: order.organizationId }).first('tradingName', 'legalName')) || {}) : null;
    const nameOrNull = purchaserName ? maskName(purchaserName) : (orgName?.tradingName || orgName?.legalName || null);
    const purchaserEn = nameOrNull ?? (order.organizationId ? 'An organisation' : 'Someone');
    const purchaserSw = nameOrNull ?? (order.organizationId ? 'Shirika' : 'Mtu mmoja');
    for (const r of rows) {
      const userId = (r.phoneNormalized && byPhone.get(r.phoneNormalized)) || (r.emailNormalized && byEmail.get(r.emailNormalized)) || null;
      if (!userId || userId === order.purchaserUserId) continue;
      await bilingualNotify(userId, {
        id: `ntf_evc_${r.id}`.slice(0, 60), type: 'event_claim_available',
        en: { title: `Is this you? A place for ${event.title}`, body: `${purchaserEn} registered someone with your number for ${event.title}. Claim it if it's you.` },
        sw: { title: `Ni wewe? Tiketi ya ${event.title}`, body: `${purchaserSw} amesajili mtu mwenye namba yako kwa ${event.title}. Chukua tiketi kama ni wewe.` },
        data: { registrationId: r.id, eventId: order.eventId, route: `/member/events/claim/${r.id}` },
      });
    }
  }

  /** The expireHolds hook: notification 2 to the purchaser (or the corporate coordinator), once; analytics order_expired. */
  async function onOrderExpired(result) {
    const order = result?.order;
    if (!order) return;
    const recipient = order.purchaserUserId ?? order.createdByUserId;
    try {
      const event = (await joinedOf(order.eventId))?.event;
      if (recipient && event) {
        const minutes = eventStore.holdTtlMinutes();
        await bilingualNotify(recipient, {
          id: `ntf_evx_${order.id}`.slice(0, 60), type: 'event_order_expired',
          en: { title: 'Your places were released', body: `The ${minutes}-minute hold for ${event.title} ended before payment. You can register again if places remain.` },
          sw: { title: 'Tiketi zako zimeachiliwa', body: `Muda wa dakika ${minutes} wa kushikilia tiketi za ${event.title} umeisha kabla ya malipo. Unaweza kujisajili tena kama bado kuna tiketi.` },
          data: { orderId: order.id, eventId: order.eventId, route: `/member/events/orders/${order.id}` },
        });
      }
    } catch (err) {
      console.warn('[events] expiry notification skipped:', order.id, err?.message);
    }
    await analytics('order_expired', { eventId: order.eventId, orderId: order.id, placesCount: result.registrations?.length ?? 0 });
  }

  /**
   * S4 SEAM — built, not invoked by any S3 route or job. On payment confirmation S4 calls
   * inviteClaims({ orderId }) to send each unclaimed non-self place an SMS / email with a fresh claim link
   * (${shareBase}/event-claim/#<token>; the token is minted here, its hash replaces the stored one). Returns
   * { invited, skipped } and updates claimInvitedAt / claimInviteCount. Never called before payment (D15).
   */
  async function inviteClaims({ orderId, channels = { sms: true, email: true } }) {
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded) return fail('order_not_found', 404);
    // Invitations go out only for a paid order (D15; review L9).
    if (loaded.order.status !== 'confirmed') return fail('order_not_confirmed', 409, { orderStatus: loaded.order.status });
    const joined = await joinedOf(loaded.order.eventId);
    const names = namesOf(joined);
    const purchaserName = loaded.order.purchaserUserId ? (await users.findByIdAsync(loaded.order.purchaserUserId))?.displayName : null;
    const purchaser = purchaserName || (loaded.order.organizationId ? ((await db('B2BOrganization').where({ id: loaded.order.organizationId }).first('tradingName', 'legalName')) || {}).tradingName : null) || 'FitFlex';
    const base = String(shareBase()).replace(/\/+$/, '');
    let invited = 0; let skipped = 0;
    for (const r of loaded.registrations) {
      if (r.participantUserId || r.consentBasis === 'self' || !LIVE_REGISTRATION.includes(r.status) || (!r.phone && !r.email)) { skipped += 1; continue; }
      const token = newClaimToken();
      const link = `${base}/event-claim/#${token}`;
      const category = names.categories.get(r.categoryId)?.name ?? '';
      const text = claimInvitationText({ purchaser, event: joined.event.title, category, link });
      // SMS follows the recipient's language when FitFlex knows them (a verified member), else carries both; email always both.
      let locale = null;
      if (r.phoneNormalized || r.emailNormalized) {
        try {
          const found = await verifiedContacts.findMembers({ phones: [r.phoneNormalized].filter(Boolean), emails: [r.emailNormalized].filter(Boolean) });
          const uid = (r.phoneNormalized && found.byPhone.get(r.phoneNormalized)) || (r.emailNormalized && found.byEmail.get(r.emailNormalized)) || null;
          locale = uid ? await localeOf(uid) : null;
        } catch { locale = null; }
      }
      const smsText = locale === 'sw' ? text.sms.sw : locale === 'en' ? text.sms.en : `${text.sms.sw}\n${text.sms.en}`;
      let sent = { ok: false, error: 'no_channel' };
      if (r.phone && channels.sms && senders.sms().configured) sent = await senders.sms().send(r.phone, { text: smsText });
      else if (r.email && channels.email && senders.email().configured) sent = await senders.email().send(r.email, { subject: `${text.email.subject.sw} / ${text.email.subject.en}`, text: `${text.email.body.sw}\n\n---\n\n${text.email.body.en}` });
      if (!sent.ok) { skipped += 1; continue; }
      await db('EventRegistration').where({ id: r.id }).update({
        claimTokenHash: hashToken(token), claimTokenExpiresAt: new Date(+now() + cfg.claimTokenDays() * 86_400_000), claimInvitedAt: now(), claimInviteCount: db.raw('"claimInviteCount" + 1'), updatedAt: now(),
      });
      invited += 1;
    }
    return { invited, skipped };
  }

  /** The claim invitation templates (§3.14), EN and SW; SMS ≤ 160 characters with a short host. */
  function claimInvitationText({ purchaser, event, category, link }) {
    const cat = category ? ` (${category})` : '';
    return {
      sms: {
        en: `${purchaser} registered you for ${event}${cat}. Claim your place in the FitFlex app: ${link}`,
        sw: `${purchaser} amekusajili kwa ${event}${cat}. Chukua tiketi yako kwenye app ya FitFlex: ${link}`,
      },
      email: {
        subject: { en: `Your place for ${event}`, sw: `Tiketi yako ya ${event}` },
        body: {
          en: `${purchaser} registered you for ${event}${cat}.\n\nClaim your place in the FitFlex app: ${link}`,
          sw: `${purchaser} amekusajili kwa ${event}${cat}.\n\nChukua tiketi yako kwenye app ya FitFlex: ${link}`,
        },
      },
    };
  }

  // ── Member orders (§3.6, §3.8) ─────────────────────────────────────────────

  async function createOrder({ userId, body = {}, idempotencyKey }) {
    return placeOrder({ mode: 'member', purchaserUserId: userId, body, idempotencyKey, replayScope: { purchaserUserId: userId } });
  }

  const eventCache = () => {
    const cache = new Map();
    return async id => { if (!cache.has(id)) cache.set(id, await joinedOf(id)); return cache.get(id); };
  };

  async function listOrders({ userId, query = {} }) {
    let q = db('EventOrder').where({ purchaserUserId: userId });
    if (ORDER_STATUS_FILTER.includes(query.status)) q = q.where({ status: query.status });
    const rows = await q.orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(500);
    const counts = rows.length ? await db('EventRegistration').whereIn('orderId', rows.map(r => r.id)).whereNot({ status: 'cancelled' }).groupBy('orderId').select('orderId').count({ n: '*' }) : [];
    const placesOf = new Map(counts.map(c => [c.orderId, Number(c.n)]));
    const events = eventCache();
    const items = [];
    for (const o of rows) {
      const j = await events(o.eventId);
      const s = summaryOf(j);
      items.push({
        id: o.id, reference: o.reference, status: o.status,
        event: s ? { id: s.id, slug: s.slug, title: s.title, startsAt: s.startsAt, timezone: s.timezone, utcOffsetMinutes: s.utcOffsetMinutes, timezoneAbbr: s.timezoneAbbr, heroThumbUrl: s.heroThumbUrl } : null,
        placesCount: placesOf.get(o.id) ?? 0, totalTzs: o.totalTzs, currency: o.currency, holdExpiresAt: iso(o.holdExpiresAt), createdAt: iso(o.createdAt), closedAt: iso(o.closedAt), closeReason: o.closeReason ?? null,
      });
    }
    const page = paginate(items, pageOpts(query));
    return { items: page.items, nextCursor: page.nextCursor === null ? null : String(page.nextCursor) };
  }

  async function orderDetail(loaded, { viewerUserId = null, actions = [] } = {}) {
    const j = await joinedOf(loaded.order.eventId);
    const names = namesOf(j);
    return {
      order: orderView(loaded.order),
      lines: loaded.lines.map(l => lineView(l, names)),
      // Once a place is claimed the person it belongs to controls their details: the purchaser sees the masked view (review M5).
      registrations: loaded.registrations.map(r => (isClaimedByOther(r) ? maskedClaimedView(r) : registrationView(r, { full: true }))),
      event: await eventBlock(j, { full: true }),
      team: await teamView(loaded.order.teamId, { viewerUserId }),
      next: paymentNext(),
      allowedActions: actions,
    };
  }

  const isClaimedByOther = r => Boolean(r.claimedAt && r.participantUserId && r.participantUserId !== r.purchaserUserId);
  /** name, category, status, kit size — phone, email, date of birth, gender and emergency contact are null (nullable for the apps). */
  const maskedClaimedView = r => ({
    ...registrationView(r, { full: false }), masked: true, kitSize: r.kitSize ?? null,
    phone: null, email: null, dateOfBirth: null, gender: null, emergencyContact: null, consentAt: iso(r.consentAt), consentTextVersion: r.consentTextVersion ?? null, claimedAt: iso(r.claimedAt),
  });

  /** Tell the people who had claimed these places that the unpaid place was cancelled by the purchaser (bilingual, in-app). */
  async function notifyClaimedCancelled(registrations, event) {
    for (const r of registrations) {
      if (!isClaimedByOther(r) || r.status !== 'reserved') continue;
      try {
        await bilingualNotify(r.participantUserId, {
          id: `ntf_evcc_${r.id}`.slice(0, 60), type: 'event_place_cancelled',
          en: { title: 'Your place was cancelled', body: `The unpaid place for ${event?.title ?? 'the event'} that you claimed was cancelled by the person who registered you.` },
          sw: { title: 'Tiketi yako imeghairiwa', body: `Tiketi ya ${event?.title ?? 'tukio'} uliyochukua, ambayo haijalipiwa, imeghairiwa na aliyekusajili.` },
          data: { registrationId: r.id, orderId: r.orderId, eventId: r.eventId, route: `/member/events/registrations/${r.id}` },
        });
      } catch (err) { console.warn('[events] claimed-cancel notification skipped:', r.id, err?.message); }
    }
  }

  async function getOrder({ userId, orderId }) {
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded || loaded.order.purchaserUserId !== userId) return fail('order_not_found', 404);
    return orderDetail(loaded, { viewerUserId: userId, actions: loaded.order.status === 'awaiting_payment' ? ['cancel'] : [] });
  }

  /** Member / corporate cancel before payment (§3.8): releaseOrder('cancelled') with the person's reason on the rows. */
  async function releaseWholeOrder(loaded, { reason, actor, storeReason = 'cancelled' }) {
    const r = await eventStore.releaseOrder(loaded.order.id, storeReason, { cancelReason: reason ?? null });
    if (r.error) return r;
    if (r.changed) {
      await analytics('order_cancelled', { eventId: r.order.eventId, orderId: r.order.id, reason: reason ?? storeReason, actor });
      await notifyClaimedCancelled(loaded.registrations, (await joinedOf(r.order.eventId))?.event);
    }
    return r;
  }

  async function cancelOrder({ userId, orderId, body = {} }) {
    if (!MEMBER_CANCEL_REASONS.includes(body.reason)) return fail('invalid_reason', 400, { allowed: [...MEMBER_CANCEL_REASONS] });
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded || loaded.order.purchaserUserId !== userId) return fail('order_not_found', 404);
    const r = await releaseWholeOrder(loaded, { reason: body.reason, actor: 'purchaser' });
    if (r.error) return r;
    return { order: orderView(r.order), registrations: r.registrations.map(x => registrationView(x)), changed: r.changed };
  }

  // ── Member registrations (§3.6, §3.8) ─────────────────────────────────────

  const relationOf = (r, me) => (r.participantUserId === me ? (r.purchaserUserId === me ? 'self' : 'claimed') : 'purchased');

  async function registrationRow(r, me, { events, orders, teams }) {
    const j = await events(r.eventId);
    const names = namesOf(j);
    const o = orders.get(r.orderId);
    const c = names.categories.get(r.categoryId);
    const t = names.tickets.get(r.ticketTypeId);
    return {
      id: r.id, relation: relationOf(r, me), participant: { firstName: r.firstName, lastName: r.lastName },
      event: summaryOf(j), category: c ? { id: c.id, name: c.name, distanceM: Number(c.distanceMeters), startsAt: iso(c.startTime) } : null,
      ticketType: t ? { name: t.name } : null, status: r.status, orderId: r.orderId, orderReference: o?.reference ?? null, orderStatus: o?.status ?? null,
      holdExpiresAt: iso(o?.holdExpiresAt), claimState: claimStateOf(r), team: teams.get(r.id) ? { id: teams.get(r.id).id, name: teams.get(r.id).name } : null,
    };
  }

  async function listRegistrations({ userId, query = {} }) {
    const rows = await db('EventRegistration').where(b => b.where({ participantUserId: userId }).orWhere({ purchaserUserId: userId })).orderBy('createdAt', 'desc').limit(500);
    const ctx = await listContext(rows);
    const events = ctx.events;
    const items = [];
    for (const r of rows) items.push(await registrationRow(r, userId, ctx));
    const live = s => !['cancelled', 'expired', 'refunded'].includes(s);
    items.sort((a, b) => {
      const la = live(a.status) && a.orderStatus !== 'expired'; const lb = live(b.status) && b.orderStatus !== 'expired';
      if (la !== lb) return la ? -1 : 1;
      return String(a.event?.startsAt ?? '').localeCompare(String(b.event?.startsAt ?? '')) || a.id.localeCompare(b.id);
    });
    void events;
    const page = paginate(items, pageOpts(query));
    return { items: page.items, nextCursor: page.nextCursor === null ? null : String(page.nextCursor) };
  }

  async function listContext(rows) {
    const orderIds = [...new Set(rows.map(r => r.orderId))];
    const orders = new Map(orderIds.length ? (await db('EventOrder').whereIn('id', orderIds)).map(o => [o.id, o]) : []);
    const regIds = rows.map(r => r.id);
    const teamRows = regIds.length ? await db('EventTeamMember as m').join('EventTeam as t', 't.id', 'm.teamId').whereIn('m.registrationId', regIds).select('m.registrationId', 't.id', 't.name') : [];
    const teams = new Map(teamRows.map(x => [x.registrationId, { id: x.id, name: x.name }]));
    return { events: eventCache(), orders, teams };
  }

  async function getRegistration({ userId, registrationId }) {
    const r = await db('EventRegistration').where({ id: registrationId }).first();
    if (!r || (r.participantUserId !== userId && r.purchaserUserId !== userId)) return fail('registration_not_found', 404);
    const ctx = await listContext([r]);
    const row = await registrationRow(r, userId, ctx);
    const full = registrationView(r, { full: true });
    const o = ctx.orders.get(r.orderId);
    const isPurchaser = r.purchaserUserId === userId;
    // The purchaser of a claimed place sees the masked view only (review M5).
    if (isPurchaser && isClaimedByOther(r)) {
      return { ...row, ...maskedClaimedView(r), id: r.id, purchaser: null, allowedActions: r.status === 'reserved' && o?.status === 'awaiting_payment' ? ['cancel'] : [], ticket: null };
    }
    const purchaser = isPurchaser ? null : { nameMasked: r.purchaserUserId ? maskName((await users.findByIdAsync(r.purchaserUserId))?.displayName) : (o?.organizationId ? 'Organisation' : null) };
    return {
      ...row, kitSize: full.kitSize, dateOfBirth: full.dateOfBirth, gender: full.gender, phone: full.phone, email: full.email, emergencyContact: full.emergencyContact,
      consentBasis: r.consentBasis, consentAt: full.consentAt, consentTextVersion: full.consentTextVersion, claimedAt: full.claimedAt, cancelReason: r.cancelReason ?? null,
      purchaser, allowedActions: isPurchaser && r.status === 'reserved' && o?.status === 'awaiting_payment' ? ['cancel'] : [], ticket: null,
    };
  }

  /** One place out of an unpaid order (§3.8): the purchaser only; the last live place → whole-order cancel. */
  async function cancelRegistration({ userId, registrationId, body = {} }) {
    if (!MEMBER_CANCEL_REASONS.includes(body.reason)) return fail('invalid_reason', 400, { allowed: [...MEMBER_CANCEL_REASONS] });
    const r = await db('EventRegistration').where({ id: registrationId }).first();
    if (!r || r.purchaserUserId !== userId) return fail('registration_not_found', 404);
    const loaded = await eventStore.getOrder(r.orderId);
    if (!loaded) return fail('registration_not_found', 404);
    if (loaded.order.status !== 'awaiting_payment') return fail('invalid_transition', 409, { kind: 'order', from: loaded.order.status, to: 'cancelled', allowed: [] });
    const live = loaded.registrations.filter(x => x.status === 'reserved');
    let result;
    if (live.length <= 1) result = await releaseWholeOrder(loaded, { reason: body.reason, actor: 'purchaser' });
    else {
      result = await eventStore.releaseRegistration(loaded.order.id, registrationId, 'cancelled', { cancelReason: body.reason });
      if (!result.error && result.changed) {
        await analytics('registration_cancelled', { eventId: loaded.order.eventId, orderId: loaded.order.id, registrationId, reason: body.reason });
        await notifyClaimedCancelled([r], (await joinedOf(loaded.order.eventId))?.event);
      }
    }
    if (result.error) return result;
    return { order: orderView(result.order), registrations: result.registrations.map(x => registrationView(x)), registration: registrationView(result.registrations.find(x => x.id === registrationId) ?? r), changed: result.changed };
  }

  // ── Claims (§3.7; D14) ──────────────────────────────────────────────────────

  /** Unclaimed live places whose normalised phone / email equals one of my VERIFIED contacts; never by name. */
  async function claimable({ userId }) {
    const contacts = await verifiedContacts.contactsFor(userId);
    const phones = contacts.filter(c => c.type === 'phone').map(c => c.value);
    const emails = contacts.filter(c => c.type === 'email').map(c => c.value);
    if (!phones.length && !emails.length) return { items: [] };
    const rows = await db('EventRegistration').whereNull('participantUserId').whereIn('status', LIVE_REGISTRATION)
      .where(b => { if (phones.length) b.orWhereIn('phoneNormalized', phones); if (emails.length) b.orWhereIn('emailNormalized', emails); })
      .where(b => b.whereNull('purchaserUserId').orWhereNot('purchaserUserId', userId))
      .orderBy('createdAt', 'desc').limit(50);
    const events = eventCache();
    const items = [];
    for (const r of rows) {
      const j = await events(r.eventId);
      if (!j) continue;
      const c = namesOf(j).categories.get(r.categoryId);
      const matched = (r.phoneNormalized && phones.includes(r.phoneNormalized)) ? maskContactShort({ phone: r.phoneNormalized }) : maskContactShort({ email: r.emailNormalized });
      items.push({
        id: r.id, event: summaryOf(j), category: c ? { id: c.id, name: c.name } : null,
        participant: { firstNameMasked: maskFirstName(r.firstName), lastInitial: lastInitial(r.lastName) },
        purchaser: { nameMasked: await purchaserMasked(r) }, matchedContact: matched, status: r.status,
      });
    }
    return { items };
  }

  async function purchaserMasked(r) {
    if (r.purchaserUserId) return maskName((await users.findByIdAsync(r.purchaserUserId))?.displayName) ?? 'Someone';
    const o = await db('EventOrder').where({ id: r.orderId }).first('organizationId');
    if (o?.organizationId) return ((await db('B2BOrganization').where({ id: o.organizationId }).first('tradingName', 'legalName')) || {}).tradingName ?? 'Organisation';
    return 'Someone';
  }

  /** Public, by link: masked data only (the token proves possession of a link, not identity). */
  async function claimPreview({ token }) {
    if (!isClaimTokenShape(token)) return fail('claim_token_invalid', 404);
    const r = await db('EventRegistration').where({ claimTokenHash: hashToken(token) }).first();
    if (!r) return fail('claim_token_invalid', 404);
    if (r.claimTokenExpiresAt && now() > new Date(r.claimTokenExpiresAt)) return fail('claim_token_expired', 410);
    const j = await joinedOf(r.eventId);
    const c = j ? namesOf(j).categories.get(r.categoryId) : null;
    const o = await db('EventOrder').where({ id: r.orderId }).first('status');
    const s = summaryOf(j);
    return {
      event: s ? { id: s.id, slug: s.slug, title: s.title, startsAt: s.startsAt, timezone: s.timezone, utcOffsetMinutes: s.utcOffsetMinutes, timezoneAbbr: s.timezoneAbbr, heroThumbUrl: s.heroThumbUrl } : null,
      category: c ? { name: c.name } : null,
      participant: { firstNameMasked: maskFirstName(r.firstName), lastInitial: lastInitial(r.lastName) },
      purchaser: { nameMasked: await purchaserMasked(r) },
      contact: contactOf(r),
      status: r.status === 'cancelled' && o?.status === 'expired' ? 'expired' : r.status,
      claimState: claimStateOf(r),
    };
  }

  /** POST /me/event-registrations/claim { token }: the registration is the one behind the token. */
  async function claimByToken({ userId, token }) {
    if (!isClaimTokenShape(token)) return fail('claim_token_invalid', 400);
    const r = await db('EventRegistration').where({ claimTokenHash: hashToken(token) }).first('id');
    if (!r) return fail('claim_token_invalid', 400);
    return claim({ userId, registrationId: r.id, token });
  }

  async function claim({ userId, registrationId, token = null, via = 'in_app' }) {
    const r = await db('EventRegistration').where({ id: registrationId }).first();
    if (!r) return fail('registration_not_found', 404);
    if (token !== null && token !== undefined) {
      if (!isClaimTokenShape(token) || !r.claimTokenHash || hashToken(token) !== r.claimTokenHash) return fail('claim_token_invalid', 400);
      if (r.claimTokenExpiresAt && now() > new Date(r.claimTokenExpiresAt)) return fail('claim_token_expired', 410);
    }
    if (r.participantUserId === userId) return { registration: registrationView(r, { full: true }), changed: false };
    // (b) a verified contact of the caller must equal the registration's contact — mandatory, token or not.
    // Checked BEFORE anything about the registration is revealed (review M1): a caller who does not match learns only
    // "not verified" — no masked contact, no claimed / closed state.
    const contacts = await verifiedContacts.contactsFor(userId);
    const matchedPhone = r.phoneNormalized && contacts.some(c => c.type === 'phone' && c.value === r.phoneNormalized);
    const matchedEmail = r.emailNormalized && contacts.some(c => c.type === 'email' && c.value === r.emailNormalized);
    if (!matchedPhone && !matchedEmail) return fail('claim_not_verified', 403);
    if (!LIVE_REGISTRATION.includes(r.status)) return fail('registration_closed_state', 409, { status: r.status });
    if (r.participantUserId) return fail('already_claimed', 409);
    // (d) the purchaser entered someone else with their own number.
    if (r.purchaserUserId === userId && r.consentBasis === 'purchaser_authorised') return fail('claim_own_contact', 409);
    const at = now();
    const [updated] = await db('EventRegistration').where({ id: r.id }).whereNull('participantUserId')
      .update({ participantUserId: userId, claimedAt: at, claimTokenHash: null, updatedAt: at }).returning('*');
    if (!updated) return fail('already_claimed', 409);
    await analytics('registration_claimed', { eventId: r.eventId, registrationId: r.id, via });
    if (r.purchaserUserId && r.purchaserUserId !== userId) {
      try {
        await bilingualNotify(r.purchaserUserId, {
          id: `ntf_evcl_${r.id}`.slice(0, 60), type: 'event_place_claimed',
          en: { title: `${r.firstName} claimed their place`, body: `${r.firstName} ${r.lastName} now holds the place you registered.` },
          sw: { title: `${r.firstName} amechukua tiketi yake`, body: `${r.firstName} ${r.lastName} sasa ana tiketi uliyosajili.` },
          data: { registrationId: r.id, orderId: r.orderId, eventId: r.eventId, route: `/member/events/registrations/${r.id}` },
        });
      } catch (err) { console.warn('[events] claim notification skipped:', r.id, err?.message); }
    }
    return { registration: registrationView(updated, { full: true }), changed: true };
  }

  // ── Teams (§3.9) ───────────────────────────────────────────────────────────

  async function createTeam({ userId, body = {} }) {
    const joined = await joinedOf(isStr(body.eventId) ? body.eventId : null);
    if (!joined || !['published', 'registration_closed', 'in_progress'].includes(joined.event.status)) return fail('event_not_found', 404);
    if (joined.event.status !== 'published') return fail('event_not_open', 409, { eventStatus: joined.event.status });
    const name = isStr(body.name) ? body.name.trim() : '';
    if (name.length < 1 || name.length > 120 || startsLikeFormula(name)) return fail('team_name_invalid', 400);
    if (!TEAM_TYPES_MEMBER.includes(body.teamType)) return fail('team_type_invalid', 400, { allowed: [...TEAM_TYPES_MEMBER] });
    if (await db('EventTeam').where({ eventId: joined.event.id }).whereRaw('lower(name) = lower(?)', [name]).first('id')) return fail('team_name_taken', 409);
    const at = now();
    const id = `evtm_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    try {
      await db('EventTeam').insert({ id, eventId: joined.event.id, name, teamType: body.teamType, status: 'active', joinCode: newJoinCode(), maxMembers: null, createdByUserId: userId, createdAt: at, updatedAt: at });
    } catch (err) {
      if (err.code === '23505') return fail('team_name_taken', 409);
      throw err;
    }
    return { status: 201, team: await teamView(id, { viewerUserId: userId }) };
  }

  async function lookupTeam({ body = {} }) {
    const joined = await joinedOf(isStr(body.eventId) ? body.eventId : null);
    if (!joined) return fail('team_not_found', 404);
    const found = await findTeamByCode(joined.event.id, body.joinCode);
    if (found.error) return found;
    if (found.memberCount >= found.maxMembers) return fail('team_full', 409, { maxMembers: found.maxMembers });
    const members = await liveMembers(found.team.id);
    const cap = found.team.captainRegistrationId ? members.find(m => m.registrationId === found.team.captainRegistrationId) : null;
    return { team: { id: found.team.id, name: found.team.name, teamType: found.team.teamType, memberCount: found.memberCount, maxMembers: found.maxMembers, captain: cap ? { firstName: cap.firstName, lastInitial: lastInitial(cap.lastName) } : null } };
  }

  async function getTeam({ userId, teamId }) {
    const team = await db('EventTeam').where({ id: teamId }).first();
    if (!team) return fail('team_not_found', 404);
    const members = await liveMembers(teamId);
    const mine = team.createdByUserId === userId || members.some(m => m.participantUserId === userId || m.purchaserUserId === userId);
    if (!mine) return fail('team_not_found', 404);
    const view = await teamView(teamId, { viewerUserId: userId });
    return { team: { ...view, joinCode: view.joinCode ?? null }, members: members.map(m => ({ registrationId: m.registrationId, participant: { firstName: m.firstName, lastInitial: lastInitial(m.lastName) }, role: m.role, status: m.status })), isCaptain: view.isCaptain };
  }

  // ── Organizer reads (§3.13; roles checked by the route) ───────────────────

  async function organizerEvent(ctx, eventId) {
    const joined = await joinedOf(eventId);
    if (!joined || joined.event.organizerId !== ctx.organizer.id) return fail('event_not_found', 404);
    return joined;
  }

  /** Roster rows with the status-based field policy: reserved → masked name, no kit size; after confirmation → full. */
  async function rosterRows(joined, { status = null, categoryId = null, q = null, full = false }) {
    let query = db('EventRegistration as r').join('EventOrder as o', 'o.id', 'r.orderId').where({ 'r.eventId': joined.event.id });
    if (['reserved', 'confirmed', 'cancelled'].includes(status)) query = query.where({ 'r.status': status });
    if (categoryId) query = query.where({ 'r.categoryId': String(categoryId) });
    const rows = await query.select('r.*', 'o.reference as orderReference', 'o.confirmedAt as orderConfirmedAt', 'o.status as orderStatus').orderBy([{ column: 'r.createdAt', order: 'desc' }, { column: 'r.id', order: 'desc' }]).limit(2000);
    const names = namesOf(joined);
    const teams = new Map(rows.length ? (await db('EventTeamMember as m').join('EventTeam as t', 't.id', 'm.teamId').whereIn('m.registrationId', rows.map(r => r.id)).select('m.registrationId', 't.name')).map(x => [x.registrationId, x.name]) : []);
    const text = isStr(q) && q.trim() ? q.trim().toLowerCase() : null;
    const items = [];
    for (const r of rows) {
      const paid = Boolean(r.orderConfirmedAt) || r.status === 'confirmed';
      const fullName = `${r.firstName} ${r.lastName}`.trim();
      if (text && !(full || paid) ) continue; // search covers confirmed rows only
      if (text && !fullName.toLowerCase().includes(text)) continue;
      items.push({
        id: r.id, participant: { name: full || paid ? fullName : maskName(fullName) }, categoryId: r.categoryId, categoryName: names.categories.get(r.categoryId)?.name ?? null,
        ticketTypeName: names.tickets.get(r.ticketTypeId)?.name ?? null, status: r.status, orderId: r.orderId, orderReference: r.orderReference, orderStatus: r.orderStatus,
        teamName: teams.get(r.id) ?? null, kitSize: full || paid ? (r.kitSize ?? null) : null, createdAt: iso(r.createdAt), claimed: Boolean(r.participantUserId),
        consentBasis: r.consentBasis, groupLabel: full ? (r.groupLabel ?? null) : undefined,
      });
    }
    return items;
  }

  async function organizerListRegistrations({ ctx, eventId, query = {} }) {
    const joined = await organizerEvent(ctx, eventId);
    if (joined.error) return joined;
    const page = paginate(await rosterRows(joined, { status: query.status, categoryId: query.categoryId, q: query.q }), pageOpts(query));
    return { items: page.items, nextCursor: page.nextCursor === null ? null : String(page.nextCursor), total: page.total };
  }

  async function registrationsSummaryOf(joined) {
    const byStatusRows = await db('EventRegistration').where({ eventId: joined.event.id }).groupBy('status').select('status').count({ n: '*' });
    const byStatus = { reserved: 0, confirmed: 0, cancelled: 0 };
    for (const r of byStatusRows) if (r.status in byStatus) byStatus[r.status] = Number(r.n);
    const byCategory = (joined.categories || []).filter(c => c.status !== 'inactive').map(c => ({
      categoryId: c.id, name: c.name, capacity: c.capacity ?? null,
      sold: (c.ticketTypes || []).reduce((n, t) => n + Number(t.sold ?? 0), 0), held: (c.ticketTypes || []).reduce((n, t) => n + Number(t.held ?? 0), 0),
    }));
    return { byStatus, byCategory };
  }

  async function organizerRegistrationsSummary({ ctx, eventId }) {
    const joined = await organizerEvent(ctx, eventId);
    if (joined.error) return joined;
    return registrationsSummaryOf(joined);
  }

  async function orderRows(joined, { status = null, full = false }) {
    let q = db('EventOrder').where({ eventId: joined.event.id });
    if (ORDER_STATUS_FILTER.includes(status)) q = q.where({ status });
    const rows = await q.orderBy([{ column: 'createdAt', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(2000);
    const counts = rows.length ? await db('EventRegistration').whereIn('orderId', rows.map(r => r.id)).whereNot({ status: 'cancelled' }).groupBy('orderId').select('orderId').count({ n: '*' }) : [];
    const placesOf = new Map(counts.map(c => [c.orderId, Number(c.n)]));
    const userIds = [...new Set(rows.map(r => r.purchaserUserId).filter(Boolean))];
    const orgIds = [...new Set(rows.map(r => r.organizationId).filter(Boolean))];
    const people = new Map(userIds.length ? (await db('User').whereIn('id', userIds).select('id', 'displayName')).map(u => [u.id, u.displayName]) : []);
    const orgs = new Map(orgIds.length ? (await db('B2BOrganization').whereIn('id', orgIds).select('id', 'tradingName', 'legalName')).map(o => [o.id, o.tradingName || o.legalName]) : []);
    return rows.map(o => ({
      id: o.id, reference: o.reference, status: o.status,
      purchaser: o.organizationId ? { type: 'organization', label: orgs.get(o.organizationId) ?? null } : { type: 'member', label: full ? (people.get(o.purchaserUserId) ?? null) : maskName(people.get(o.purchaserUserId)) },
      placesCount: placesOf.get(o.id) ?? 0, totalTzs: o.totalTzs, feesTzs: o.feesTzs, discountTzs: o.discountTzs, currency: o.currency,
      createdAt: iso(o.createdAt), holdExpiresAt: iso(o.holdExpiresAt), closedAt: iso(o.closedAt), closeReason: o.closeReason ?? null,
      ...(full ? { allowedActions: o.status === 'awaiting_payment' ? ['cancel'] : [], costCentre: o.costCentre ?? null, purchaserReference: o.purchaserReference ?? null } : {}),
    }));
  }

  async function organizerListOrders({ ctx, eventId, query = {} }) {
    const joined = await organizerEvent(ctx, eventId);
    if (joined.error) return joined;
    const page = paginate(await orderRows(joined, { status: query.status }), pageOpts(query));
    return { items: page.items, nextCursor: page.nextCursor === null ? null : String(page.nextCursor), total: page.total };
  }

  /** The organizer overview counters S2 left at 0 (spec §5.1). */
  async function organizerTotals(organizerId) {
    const rows = await db('EventRegistration as r').join('Event as e', 'e.id', 'r.eventId').where({ 'e.organizerId': organizerId }).groupBy('r.status').select('r.status').count({ n: '*' });
    const of = s => Number(rows.find(r => r.status === s)?.n || 0);
    return { registrationsTotal: of('reserved') + of('confirmed'), awaitingPaymentTotal: of('reserved'), confirmedTotal: of('confirmed') };
  }

  // ── Admin reads and cancel (§3.8, §3.13; scope checked by the route) ───────

  async function adminListOrders({ eventId, query = {} }) {
    const joined = await joinedOf(eventId);
    if (!joined) return fail('event_not_found', 404);
    const page = paginate(await orderRows(joined, { status: query.status, full: true }), pageOpts(query));
    return { items: page.items, nextCursor: page.nextCursor === null ? null : String(page.nextCursor), total: page.total };
  }

  async function adminGetOrder({ eventId, orderId }) {
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded || loaded.order.eventId !== eventId) return fail('order_not_found', 404);
    const detail = await orderDetail(loaded, { actions: loaded.order.status === 'awaiting_payment' ? ['cancel'] : [] });
    // Admins see names and statuses, not contact or personal details (§3.13, §7.3; review L7).
    detail.registrations = detail.registrations.map(({ emergencyContact, phone, email, dateOfBirth, gender, ...r }) => r);
    const purchaser = loaded.order.purchaserUserId ? await users.findByIdAsync(loaded.order.purchaserUserId) : null;
    const org = loaded.order.organizationId ? await db('B2BOrganization').where({ id: loaded.order.organizationId }).first('id', 'tradingName', 'legalName') : null;
    const createdBy = loaded.order.createdByUserId ? await users.findByIdAsync(loaded.order.createdByUserId) : null;
    return {
      ...detail,
      purchaser: org ? { type: 'organization', id: org.id, label: org.tradingName || org.legalName } : { type: 'member', id: purchaser?.id ?? null, label: purchaser?.displayName ?? null },
      createdBy: createdBy ? { id: createdBy.id, name: createdBy.displayName ?? null } : null,
    };
  }

  async function adminListRegistrations({ eventId, query = {} }) {
    const joined = await joinedOf(eventId);
    if (!joined) return fail('event_not_found', 404);
    const page = paginate(await rosterRows(joined, { status: query.status, categoryId: query.categoryId, q: query.q, full: true }), pageOpts(query));
    return { items: page.items, nextCursor: page.nextCursor === null ? null : String(page.nextCursor), total: page.total };
  }

  async function adminCancelOrder({ eventId, orderId, body = {}, actorId }) {
    const loaded = await eventStore.getOrder(orderId);
    if (!loaded || loaded.order.eventId !== eventId) return fail('order_not_found', 404);
    const note = isStr(body.note) ? body.note.trim().slice(0, 500) : '';
    const r = await eventStore.releaseOrder(orderId, 'admin', { cancelReason: 'admin' });
    if (r.error) return r;
    if (r.changed) {
      await audit(actorId, 'events.order_cancelled', orderId, { status: loaded.order.status }, { status: r.order.status, reason: 'admin', note: note || null, eventId });
      await notifyClaimedCancelled(loaded.registrations, (await joinedOf(eventId))?.event);
      await analytics('order_cancelled', { eventId, orderId, reason: 'admin', actor: 'admin' });
      const recipient = r.order.purchaserUserId ?? r.order.createdByUserId;
      if (recipient) {
        try {
          const title = (await joinedOf(eventId))?.event?.title ?? '';
          await bilingualNotify(recipient, {
            id: `ntf_evac_${orderId}`.slice(0, 60), type: 'event_order_cancelled',
            en: { title: 'Your order was cancelled by FitFlex', body: `Order ${r.order.reference} for ${title} was cancelled and its places released.` },
            sw: { title: 'Oda yako imeghairiwa na FitFlex', body: `Oda ${r.order.reference} ya ${title} imeghairiwa na tiketi zake zimeachiliwa.` },
            data: { orderId, eventId, route: `/member/events/orders/${orderId}` },
          });
        } catch (err) { console.warn('[events] admin cancel notification skipped:', orderId, err?.message); }
      }
    }
    return { order: orderView(r.order), registrations: r.registrations.map(x => registrationView(x)), changed: r.changed };
  }

  return {
    quote, createOrder, listOrders, getOrder, cancelOrder,
    listRegistrations, getRegistration, cancelRegistration, claimable, claimPreview, claim, claimByToken,
    createTeam, lookupTeam, getTeam,
    organizerListRegistrations, organizerRegistrationsSummary, organizerListOrders, organizerTotals,
    adminListOrders, adminGetOrder, adminListRegistrations, adminCancelOrder,
    onOrderExpired, inviteClaims, claimInvitationText,
    // shared with events-roster-service.mjs (corporate)
    internals: { prepare, placeOrder, replay, quoteResponse, orderDetail, orderView, registrationView, lineView, namesOf, joinedOf, summaryOf, releaseWholeOrder, participantsReport, publicAvailability, eventBlock, teamView, loadOrder: id => eventStore.getOrder(id) },
  };
}
