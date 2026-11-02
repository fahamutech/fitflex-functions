// Marathon & running events · S7 — the waitlist (REG-015; docs/design/events-s7-hardening-and-pilot.md §4, D70 to D76).
//
// RULE 6 AREA (owner reviews, D35). The model in five lines:
//  1. Waiting costs nothing and takes no money: an entry is a row with the registration details the member gave (`intent`), nothing is held.
//  2. First come, first offered per ticket type by a database identity (`seq`), never by clock time. Organizers see counts only.
//  3. An OFFER IS A NORMAL ORDER created for the member by the registration service with a system actor (`placeSystemOrder`): every validator
//     runs again, the hold is the offer window, and from there it is the S3/S4 flow (manual payment, 24 h confirmation, refund rules). No
//     inventory primitive, payment code or ledger rule is touched or copied here.
//  4. The queue gate: while anyone waits for a ticket type, nobody else can create an order for it (409 waitlist_active), checked inside the
//     creation transaction while the ticket type rows are locked, so no buyer slips between two promoter runs.
//  5. Entries end by reconciliation (the order is confirmed / expired / cancelled), never inside payment code.
import { createHash, randomUUID } from 'node:crypto';
import { storeRefusal } from '../infra/event-store-pg.mjs';
import { localHourMinuteIn, localTimeIn } from '../shared/events-participants.mjs';
import { swahiliTime } from '../shared/vendor-documents.mjs';
import { cardName, encodeCursor, decodeCursor, parseLimit } from '../shared/events-ops-rules.mjs';
import { tzInfo } from '../shared/events-document.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v ? new Date(v).toISOString() : null);
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const newId = () => `ewl_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const HOUR = 3_600_000;
const LIVE = ['waiting', 'offered'];
const MAX_PER_RUN = 10;
const MAX_SKIPS = 3;
// M4: only a TIME-based close ends the line. A paused event (event_not_open), an organizer who switched a ticket type or category off for now: the
// entries stay waiting and promotion just stops until it comes back.
const SALE_CLOSED_ERRORS = new Set(['registration_closed', 'sale_closed']);
const PAUSED_ERRORS = new Set(['event_not_open', 'ticket_type_inactive', 'category_inactive', 'sale_not_open']);
// M3: the member's own limits (an unpaid order elsewhere, too many unpaid places) are not their fault and not a failure: the entry waits, keeps its place.
const LIMIT_ERRORS = new Set(['hold_limit_reached', 'unpaid_places_limit']);
const INTENT_FIELDS = ['firstName', 'lastName', 'phone', 'email', 'dateOfBirth', 'gender', 'emergencyContact', 'kitSize', 'groupLabel'];

export function createEventsWaitlistService({
  db, registration, eventStore, users, verifiedContacts, now = () => new Date(), track = async () => {}, notice = async () => {}, audit = null,
  paymentsMode = () => 'manual', consentVersion = () => 'v', config = {}, localeOf = async () => null,
}) {
  const cfg = {
    offerHours: () => 12, minOfferMinutes: () => 120, maxActivePerUser: () => 5, maxQueue: () => 500, maxLapses: () => 2,
    quietHours: () => ({ off: true }), keepDays: () => 90, ...config,
  };
  const stamp = () => new Date(now());
  const writeAudit = async (actor, action, target, after, q = db) => {
    try { await q('AuditLog').insert({ id: `aud_${randomUUID().slice(0, 12)}`, at: stamp(), actor: actor || 'system', action, target, before: null, after: after == null ? null : JSON.stringify(after) }); } catch { /* best effort */ }
  };
  void audit; void localeOf;

  // ── Text helpers ───────────────────────────────────────────────────────────

  const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_SW = ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ago', 'Sep', 'Okt', 'Nov', 'Des'];
  /** "29 Oct 14:05" / "29 Okt 2:05 mchana" in the event timezone. */
  function whenTexts(event, at) {
    const tz = event.timezone || 'Africa/Dar_es_Salaam';
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
    const [, m, d] = day.split('-').map(Number);
    const en = localTimeIn(tz, at);
    const hm = localHourMinuteIn(tz, at);
    return { en: `${d} ${MONTHS_EN[m - 1]} ${en}`, sw: `${d} ${MONTHS_SW[m - 1]} ${hm ? swahiliTime(hm.h, hm.min) : en}`, timeEn: en, timeSw: hm ? swahiliTime(hm.h, hm.min) : en };
  }
  const withReason = (reason, reasonSw) => ({ en: reason, sw: reasonSw ?? `(kwa Kiingereza) ${reason}` });

  /** An inbox row without a push (the optional class, §4.8). */
  async function inboxOnly(userId, { id, type, en, sw, data }) {
    try {
      let locale = null;
      try { locale = await localeOf(userId); } catch { locale = null; }
      const t = locale === 'sw' ? sw : en;
      await db('Notification').insert({
        id: id.slice(0, 60), userId, type, title: t.title, body: t.body,
        data: JSON.stringify({ ...data, type, locale: locale === 'sw' ? 'sw' : 'en', titleEn: en.title, bodyEn: en.body, titleSw: sw.title, bodySw: sw.body }),
      }).onConflict('id').ignore();
    } catch (err) { console.warn('[events] waitlist inbox notice skipped:', type, err?.message); }
  }
  const routeOf = { order: id => `/member/events/orders/${id}`, list: () => '/member/events/waitlist' };

  // ── Views and discovery hooks ──────────────────────────────────────────────

  const view = () => ({ on: true, paymentsOk: paymentsMode() !== 'none' });
  /** Registration service hook: refuse a new order for a ticket type with a live queue (runs while the ticket type rows are locked). */
  async function gate(trx, created) {
    const ids = [...new Set((created.lines ?? []).map(l => l.ticketTypeId))];
    if (!ids.length) return;
    const q = await trx('EventWaitlistEntry').whereIn('ticketTypeId', ids).whereIn('status', LIVE).first('ticketTypeId');
    if (q) throw storeRefusal('waitlist_active', 409, { ticketTypeId: q.ticketTypeId });
  }
  async function source(orderIds) {
    const rows = await db('EventWaitlistEntry').whereIn('orderId', orderIds).select('orderId');
    return new Map(rows.map(r => [r.orderId, 'waitlist']));
  }

  const positionOf = async entry => (entry.status === 'waiting'
    ? Number((await db('EventWaitlistEntry').where({ ticketTypeId: entry.ticketTypeId, status: 'waiting' }).where('seq', '<=', entry.seq).count({ n: '*' }).first()).n)
    : null);

  // ── Joining ────────────────────────────────────────────────────────────────

  async function join({ userId, eventId, body = {} }) {
    const ticketTypeId = typeof body.ticketTypeId === 'string' ? body.ticketTypeId : null;
    if (!ticketTypeId) return fail('validation_failed', 422, { fields: [{ field: 'ticketTypeId', code: 'required' }] });
    const event = plain(await db('Event').where({ id: String(eventId) }).first());
    if (!event || !['published', 'registration_closed', 'in_progress', 'completed', 'cancelled'].includes(event.status)) return fail('event_not_found', 404);
    const tt = plain(await db('EventTicketType').where({ id: ticketTypeId, eventId: event.id }).first());
    if (!tt) return fail('event_not_found', 404);
    const cat = plain(await db('EventCategory').where({ id: tt.categoryId }).first());
    const at = stamp();
    const unavailable = reason => fail('waitlist_unavailable', 409, { reason });
    if (event.status !== 'published') return unavailable('registration_closed');
    if ((event.registrationClosesAt && at > new Date(event.registrationClosesAt)) || (event.registrationOpensAt && at < new Date(event.registrationOpensAt))) return unavailable('registration_closed');
    if (event.waitlistEnabled === false || event.waitlistClosedAt) return unavailable('waitlist_closed');
    if (tt.status !== 'active' || !cat || cat.status !== 'active' || (cat.registrationClosesAt && at > new Date(cat.registrationClosesAt))) return unavailable('sale_closed');
    if ((tt.saleOpensAt && at < new Date(tt.saleOpensAt)) || (tt.saleClosesAt && at > new Date(tt.saleClosesAt))) return unavailable('sale_closed');
    if (Number(tt.priceTzs) > 0 && paymentsMode() === 'none') return unavailable('payments_unavailable');

    const contacts = await verifiedContacts.contactsFor(userId);
    if (!contacts?.length) return fail('verification_required', 403);
    const consent = body.consent;
    if (!consent || consent.accepted !== true || consent.textVersion !== consentVersion()) return fail('consent_required', 422, { current: consentVersion() });

    const checked = await registration.validateWaitlistJoin({ userId, eventId: event.id, ticketTypeId, participants: body.participants });
    if (checked.error) return checked.error === 'participants_mismatch' ? fail('validation_failed', 422, { fields: [{ field: 'participants', code: 'exactly_one' }] }) : checked;
    if (checked.duplicate) return fail('already_registered', 409);
    if (checked.problems.length) return fail('validation_failed', 422, { fields: checked.problems });
    const blocking = checked.orderProblems.find(p => ['too_many_participants', 'quantity_out_of_range', 'ticket_type_inactive', 'category_inactive', 'sale_closed', 'sale_not_open'].includes(p.code));
    if (blocking) return unavailable(blocking.code);

    const p = checked.participant;
    const contactKey = createHash('sha256').update(String(p.phoneNormalized || p.emailNormalized || userId)).digest('hex');
    const raw = body.participants[0];
    const intent = { participant: { ...Object.fromEntries(INTENT_FIELDS.filter(k => raw[k] !== undefined).map(k => [k, raw[k]])), consentBasis: 'self' }, locale: body.locale === 'sw' ? 'sw' : 'en' };

    try {
      const entry = await db.transaction(async (trx) => {
        // Low: one join per member at a time, so the per-category and per-member limits cannot be raced past by two parallel requests.
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`wlj:${userId}`]);
        const locked = plain(await trx('EventTicketType').where({ id: tt.id }).forUpdate().first());
        const queued = await trx('EventWaitlistEntry').where({ ticketTypeId: tt.id }).whereIn('status', LIVE).first('id');
        if (Number(locked.sold) + Number(locked.held) < Number(locked.capacity) && !queued) throw storeRefusal('not_sold_out', 409);
        const sameCategory = trx('EventWaitlistEntry').where({ eventId: event.id, categoryId: tt.categoryId }).whereIn('status', LIVE).where(b => b.where({ userId }).orWhere({ contactKey }));
        if (await sameCategory.first('id')) throw storeRefusal('already_registered', 409);
        const lapses = Number((await trx('EventWaitlistEntry').where({ eventId: event.id, userId, status: 'expired' }).count({ n: '*' }).first()).n);
        if (lapses >= cfg.maxLapses()) throw storeRefusal('waitlist_lapse_limit', 409);
        const mine = Number((await trx('EventWaitlistEntry').where({ userId }).whereIn('status', LIVE).count({ n: '*' }).first()).n);
        if (mine >= cfg.maxActivePerUser()) throw storeRefusal('waitlist_limit_reached', 409, { max: cfg.maxActivePerUser() });
        const inType = Number((await trx('EventWaitlistEntry').where({ ticketTypeId: tt.id }).whereIn('status', LIVE).count({ n: '*' }).first()).n);
        if (inType >= cfg.maxQueue()) throw storeRefusal('waitlist_full', 409);
        const [row] = await trx('EventWaitlistEntry').insert({
          id: newId(), eventId: event.id, categoryId: tt.categoryId, ticketTypeId: tt.id, userId, status: 'waiting', intent: JSON.stringify(intent),
          consentTextVersion: consent.textVersion, contactKey, joinedAt: at, createdAt: at, updatedAt: at,
        }).returning('*');
        await writeAudit(userId, 'events.waitlist_joined', event.id, { entryId: row.id, ticketTypeId: tt.id }, trx);
        return plain(row);
      });
      track('waitlist_joined', {}, { eventId: event.id });
      inboxOnly(userId, {
        id: `ntf_ewj_${entry.id}`, type: 'event_waitlist_joined',
        en: { title: "You're on the waitlist", body: `${event.title}: we will tell you if a ticket is held for you.` },
        sw: { title: 'Uko kwenye orodha ya kusubiri', body: `${event.title}: tutakuambia tiketi ikishikiliwa kwa ajili yako.` },
        data: { eventId: event.id, entryId: entry.id, route: routeOf.list() },
      });
      return {
        status: 201,
        entry: { id: entry.id, status: 'waiting', position: await positionOf(entry), ticketTypeId: tt.id, ticketTypeName: tt.name, categoryName: cat.name, priceTzs: Number(tt.priceTzs), currency: tt.currency || 'TZS', joinedAt: iso(entry.joinedAt) },
      };
    } catch (err) {
      if (err.refusal) return err.refusal;
      if (err.code === '23505') return fail('already_registered', 409);
      throw err;
    }
  }

  // ── The member's own list, leaving, reconfirming ───────────────────────────

  async function list({ userId }) {
    const since = new Date(+stamp() - cfg.keepDays() * 24 * HOUR);
    const rows = (await db('EventWaitlistEntry as w').join('Event as e', 'e.id', 'w.eventId').join('EventTicketType as t', 't.id', 'w.ticketTypeId').join('EventCategory as c', 'c.id', 'w.categoryId')
      .leftJoin('EventOrder as o', 'o.id', 'w.orderId').where('w.userId', userId).where(b => b.whereIn('w.status', LIVE).orWhere('w.endedAt', '>=', since))
      .orderBy([{ column: 'w.joinedAt', order: 'desc' }, { column: 'w.id' }])
      .select('w.*', 'e.title as eventTitle', 'e.startsAt', 'e.timezone', 't.name as ticketTypeName', 't.priceTzs as ticketPriceTzs', 't.currency as ticketCurrency', 'c.name as categoryName', 'o.holdExpiresAt as orderHoldExpiresAt', 'o.totalTzs as orderTotal', 'o.currency as orderCurrency')).map(plain);
    const items = [];
    for (const r of rows) {
      items.push({
        id: r.id, eventId: r.eventId, eventTitle: r.eventTitle, startsAt: iso(r.startsAt), timezone: r.timezone, ...tzInfo(r.timezone, r.startsAt),
        ticketTypeId: r.ticketTypeId, ticketTypeName: r.ticketTypeName, priceTzs: Number(r.ticketPriceTzs), currency: r.ticketCurrency || 'TZS', categoryName: r.categoryName,
        status: r.status, ...(r.status === 'waiting' ? { position: await positionOf(r) } : {}), joinedAt: iso(r.joinedAt), ...(r.blockedReason ? { blockedReason: r.blockedReason } : {}),
        ...(r.status === 'offered' && r.orderId ? { offer: { orderId: r.orderId, expiresAt: iso(r.orderHoldExpiresAt ?? r.offerExpiresAt), amountTzs: r.orderTotal ?? 0, currency: r.orderCurrency || 'TZS' } } : {}),
        ...(r.endedAt ? { endedAt: iso(r.endedAt), endedReason: r.endedReason } : {}),
      });
    }
    return { items, serverTime: stamp().toISOString() };
  }

  const paymentWaiting = async orderId => Boolean(await db('EventPayment').where({ orderId }).whereIn('status', ['pending', 'reconciliation_required']).first('id'));

  async function leave({ userId, entryId }) {
    const entry = plain(await db('EventWaitlistEntry').where({ id: String(entryId), userId }).first());
    if (!entry) return fail('entry_not_found', 404);
    if (!LIVE.includes(entry.status)) return fail('already_ended', 409);
    const at = stamp();
    if (entry.status === 'waiting') {
      const done = await db('EventWaitlistEntry').where({ id: entry.id, status: 'waiting' }).update({ status: 'left', endedAt: at, endedReason: 'left', updatedAt: at });
      if (!done) return fail('already_ended', 409);
      track('waitlist_left', {}, { eventId: entry.eventId });
      await writeAudit(userId, 'events.waitlist_left', entry.eventId, { entryId: entry.id });
      return { entry: { id: entry.id, status: 'left' } };
    }
    if (entry.orderId && await paymentWaiting(entry.orderId)) return fail('payment_pending', 409);
    const loaded = entry.orderId ? await eventStore.getOrder(entry.orderId) : null;
    if (loaded && loaded.order.status === 'awaiting_payment') {
      const released = await registration.internals.releaseWholeOrder(loaded, { reason: 'changed_mind', actor: 'purchaser' });
      if (released.error) return released;
    }
    await db('EventWaitlistEntry').where({ id: entry.id, status: 'offered' }).update({ status: 'declined', endedAt: at, endedReason: 'offer_declined', updatedAt: at });
    track('waitlist_left', {}, { eventId: entry.eventId });
    await writeAudit(userId, 'events.waitlist_left', entry.eventId, { entryId: entry.id, offered: true });
    return { entry: { id: entry.id, status: 'declined' } };
  }

  async function reconfirm({ userId, entryId, body = {} }) {
    const entry = plain(await db('EventWaitlistEntry').where({ id: String(entryId), userId }).first());
    if (!entry) return fail('entry_not_found', 404);
    if (entry.blockedReason !== 'reconsent' || entry.status !== 'waiting') return fail('not_blocked', 409);
    const c = body.consent;
    if (!c || c.accepted !== true || c.textVersion !== consentVersion()) return fail('consent_required', 422, { current: consentVersion() });
    await db('EventWaitlistEntry').where({ id: entry.id }).update({ consentTextVersion: c.textVersion, blockedReason: null, updatedAt: stamp() });
    return { entry: { id: entry.id, status: 'waiting', position: await positionOf(entry) } };
  }

  // ── Ending entries ─────────────────────────────────────────────────────────

  async function endEntries(ids, { status = 'closed', reason, notify = true } = {}) {
    if (!ids.length) return 0;
    const at = stamp();
    const rows = await db('EventWaitlistEntry as w').join('Event as e', 'e.id', 'w.eventId').whereIn('w.id', ids).where('w.status', 'waiting').select('w.id', 'w.userId', 'w.eventId', 'e.title');
    if (!rows.length) return 0;
    await db('EventWaitlistEntry').whereIn('id', rows.map(r => r.id)).where({ status: 'waiting' }).update({ status, endedAt: at, endedReason: reason, updatedAt: at });
    for (const r of rows) {
      track('waitlist_closed', { reason: ['sale_closed', 'event_cancelled', 'organizer_closed'].includes(reason) ? reason : 'other' }, { eventId: r.eventId });
      if (notify) {
        notice(r.userId, {
          id: `ntf_ewc_${r.id}`, type: 'event_waitlist_closed',
          en: { title: 'Waitlist closed', body: `The waitlist for ${r.title} has closed.` },
          sw: { title: 'Orodha ya kusubiri imefungwa', body: `Orodha ya kusubiri ya ${r.title} imefungwa.` },
          data: { eventId: r.eventId, entryId: r.id, route: routeOf.list() },
        }).catch(() => {});
      }
    }
    return rows.length;
  }

  /**
   * Waiting entries end only for a TERMINAL reason (M4): the event was cancelled, or registration is over for good (the event moved on to
   * in_progress / completed / archived, or the registration close time of the event, category or ticket type has passed). A pause by FitFlex
   * (registration_closed before its time), an organizer who closed new sign-ups for now, or a ticket type or category switched off leave the
   * entries waiting; promotion simply does not run until the sale is back.
   */
  async function closeStale() {
    const at = stamp();
    const rows = await db('EventWaitlistEntry as w').join('Event as e', 'e.id', 'w.eventId').join('EventCategory as c', 'c.id', 'w.categoryId').join('EventTicketType as t', 't.id', 'w.ticketTypeId')
      .where('w.status', 'waiting')
      .where(b => b.whereIn('e.status', ['cancelled', 'in_progress', 'completed', 'archived']).orWhere('e.registrationClosesAt', '<=', at).orWhere('c.registrationClosesAt', '<=', at).orWhere('t.saleClosesAt', '<=', at))
      .select('w.id', 'e.status as eventStatus');
    const cancelled = rows.filter(r => r.eventStatus === 'cancelled').map(r => r.id);
    const closed = rows.filter(r => r.eventStatus !== 'cancelled').map(r => r.id);
    return (await endEntries(cancelled, { reason: 'event_cancelled' })) + (await endEntries(closed, { reason: 'sale_closed' }));
  }

  // ── The promoter ───────────────────────────────────────────────────────────

  const registrationCloseOf = (event, cat, tt) => {
    const times = [event.registrationClosesAt, cat?.registrationClosesAt, tt.saleClosesAt].filter(Boolean).map(t => +new Date(t));
    return times.length ? Math.min(...times) : +new Date(event.startsAt);
  };
  /** clamp(hours until registration closes / 4, 2 h, offerHours), never past the close. → minutes (integer ≥ 1). */
  function offerMinutes(untilCloseMs) {
    const quarter = untilCloseMs / 4;
    const window = Math.min(Math.max(quarter, 2 * HOUR), cfg.offerHours() * HOUR, untilCloseMs);
    return Math.max(Math.floor(window / 60_000), 1);
  }
  function quietNow(event, atMs, closeMs) {
    const q = cfg.quietHours();
    if (q.off) return false;
    const hm = localHourMinuteIn(event.timezone || 'Africa/Dar_es_Salaam', new Date(atMs));
    if (!hm) return false;
    const inQuiet = q.from > q.to ? (hm.h >= q.from || hm.h < q.to) : (hm.h >= q.from && hm.h < q.to);
    if (!inQuiet) return false;
    const hoursLeft = hm.h >= q.from && q.from > q.to ? (24 - hm.h) + q.to : q.to - hm.h;
    const quietEnd = atMs + hoursLeft * HOUR - hm.min * 60_000;
    // Promotion waits for the end of the quiet hours unless registration would close before an offer could still be made after it.
    return closeMs - quietEnd >= cfg.minOfferMinutes() * 60_000;
  }

  const classify = (res) => {
    if (res.error === 'capacity_unavailable') return { act: 'stop_type' };
    if (res.error === 'participant_invalid') {
      const dup = (res.participants ?? []).some(p => (p.problems ?? []).some(x => x.code === 'duplicate_participant'));
      return { act: 'close', reason: dup ? 'registered_elsewhere' : 'not_eligible' };
    }
    if (SALE_CLOSED_ERRORS.has(res.error)) return { act: 'close_all' };
    if (PAUSED_ERRORS.has(res.error)) return { act: 'stop_type' };
    if (LIMIT_ERRORS.has(res.error)) return { act: 'defer', error: res.error };
    if (res.error === 'consent_version_stale') return { act: 'block' };
    return { act: 'skip', error: res.error };
  };

  async function offer(entry, ctx) {
    const { event, tt, cat, closeMs } = ctx;
    const at = stamp();
    const minutes = offerMinutes(closeMs - +at);
    const intent = typeof entry.intent === 'string' ? JSON.parse(entry.intent) : entry.intent;
    if (!intent?.participant) return { act: 'close', reason: 'not_eligible' };
    const body = {
      eventId: event.id, lines: [{ ticketTypeId: tt.id, quantity: 1 }], participants: [{ ...intent.participant, ticketTypeId: tt.id, consentBasis: 'self' }],
      acceptedTerms: true, consentTextVersion: entry.consentTextVersion,
    };
    const res = await registration.placeSystemOrder({
      userId: entry.userId, body, idempotencyKey: `wl:${entry.id}`,
      system: {
        holdTtlMinutes: minutes,
        afterCreate: async (trx, created) => {
          const done = await trx('EventWaitlistEntry').where({ id: entry.id, status: 'waiting' })
            .update({ status: 'offered', offeredAt: at, offerExpiresAt: created.order.holdExpiresAt, orderId: created.order.id, updatedAt: at });
          if (!done) throw storeRefusal('waitlist_entry_gone', 409);
        },
      },
    });
    if (res.error) return classify(res);
    const order = res.order;
    track('waitlist_offer_made', {}, { eventId: event.id });
    await writeAudit('system', 'events.waitlist_offered', event.id, { entryId: entry.id, orderId: order.id, minutes });
    const t = whenTexts(event, order.holdExpiresAt);
    notice(entry.userId, {
      id: `ntf_ewo_${entry.id}`, type: 'event_waitlist_offer',
      en: { title: 'A ticket is held for you', body: `A ticket for ${event.title} is held for you. Pay before ${t.en} to keep it.` },
      sw: { title: 'Tiketi imeshikiliwa kwa ajili yako', body: `Tiketi ya ${event.title} imeshikiliwa kwa ajili yako. Lipa kabla ya ${t.sw} ili kuipata.` },
      data: { eventId: event.id, entryId: entry.id, orderId: order.id, route: routeOf.order(order.id), essential: true },
    }).catch(() => {});
    void cat;
    return { act: 'offered' };
  }

  const ctxEventTitle = (entry, event) => event.title;

  async function promoteType(typeId, stats) {
    // One promoter per ticket type at a time (the nudge and the job can overlap). A transaction-scoped advisory lock, NOT a row lock: the
    // order creation takes its own FOR UPDATE on the ticket type row from another connection.
    await db.transaction(async (lock) => {
      const { rows: [{ ok }] } = await lock.raw('select pg_try_advisory_xact_lock(hashtext(?)) as ok', [`wlp:${typeId}`]);
      if (!ok) return;
      const attempted = new Set();
      for (let i = 0; i < MAX_PER_RUN; i += 1) {
        const tt = plain(await db('EventTicketType').where({ id: typeId }).first());
        if (!tt || Number(tt.capacity) - Number(tt.sold) - Number(tt.held) < 1) return;
        const event = plain(await db('Event').where({ id: tt.eventId }).first());
        const cat = plain(await db('EventCategory').where({ id: tt.categoryId }).first());
        if (!event || event.status !== 'published' || tt.status !== 'active' || cat?.status !== 'active') return;
        const closeMs = registrationCloseOf(event, cat, tt);
        const at = +stamp();
        if (closeMs <= at) return;
        if (Number(tt.priceTzs) > 0 && paymentsMode() === 'none') return;
        if (closeMs - at < cfg.minOfferMinutes() * 60_000) return;
        if (quietNow(event, at, closeMs)) return;
        const entry = plain(await db('EventWaitlistEntry').where({ ticketTypeId: typeId, status: 'waiting' }).whereNull('blockedReason').whereNotIn('id', attempted.size ? [...attempted] : ['']).orderBy('seq').first());
        if (!entry) return;
        attempted.add(entry.id);
        const user = await users.findByIdAsync(entry.userId).catch(() => null);
        if (!user || (user.accountStatus && user.accountStatus !== 'active')) { await endEntries([entry.id], { reason: 'not_eligible', notify: false }); continue; }
        if (entry.consentTextVersion !== consentVersion()) { await db('EventWaitlistEntry').where({ id: entry.id }).update({ blockedReason: 'reconsent', updatedAt: stamp() }); continue; }
        let out;
        try { out = await offer(entry, { event, tt, cat, closeMs }); } catch (err) { out = { act: 'skip', error: err?.message }; }
        stats.attempted += 1;
        if (out.act === 'offered') { stats.offered += 1; continue; }
        if (out.act === 'stop_type') return;
        if (out.act === 'close') { await endEntries([entry.id], { reason: out.reason, notify: true }); stats.closed += 1; continue; }
        if (out.act === 'close_all') {
          const ids = (await db('EventWaitlistEntry').where({ ticketTypeId: typeId, status: 'waiting' }).select('id')).map(r => r.id);
          stats.closed += await endEntries(ids, { reason: 'sale_closed' });
          return;
        }
        if (out.act === 'defer') {
          // M3: the member's own limit. The entry keeps its seq, is NOT counted toward the skips, and is told once (deterministic notice id).
          stats.deferred += 1;
          notice(entry.userId, {
            id: `ntf_ewd_${entry.id}`, type: 'event_waitlist_deferred',
            en: { title: 'A ticket is waiting for you', body: `A ticket for ${ctxEventTitle(entry, event)} is available for you, but you already hold unpaid places. Pay for them or cancel them and we will offer you this one. Your place in the line is kept.` },
            sw: { title: 'Tiketi inakusubiri', body: `Tiketi ya ${ctxEventTitle(entry, event)} inapatikana kwa ajili yako, lakini tayari una tiketi ambazo hazijalipiwa. Lipia au ghairi hizo nasi tutakupa hii. Namba yako kwenye orodha inabaki.` },
            data: { eventId: entry.eventId, entryId: entry.id, route: routeOf.list() },
          }).catch(() => {});
          continue;
        }
        if (out.act === 'block') { await db('EventWaitlistEntry').where({ id: entry.id }).update({ blockedReason: 'reconsent', updatedAt: stamp() }); continue; }
        // A transient failure never moves the entry behind the others; after MAX_SKIPS it ends (not_eligible).
        const skips = entry.skipCount + 1;
        if (skips >= MAX_SKIPS) { await endEntries([entry.id], { reason: 'not_eligible' }); stats.closed += 1; } else await db('EventWaitlistEntry').where({ id: entry.id }).update({ skipCount: skips, updatedAt: stamp() });
        stats.skippedEntries += 1;
      }
    });
  }

  /** The job (every minute) and, with `eventId`, the nudge after a hold expires. */
  async function promote({ eventId = null } = {}) {
    const stats = { types: 0, attempted: 0, offered: 0, closed: 0, skippedEntries: 0, deferred: 0 };
    stats.closed += await closeStale();
    const types = await db('EventWaitlistEntry as w').join('EventTicketType as t', 't.id', 'w.ticketTypeId').join('Event as e', 'e.id', 'w.eventId')
      .where('w.status', 'waiting').whereNull('w.blockedReason').where('e.status', 'published').whereRaw('t.capacity - t.sold - t.held >= 1')
      .modify(q => { if (eventId) q.where('w.eventId', eventId); }).distinct('w.ticketTypeId').orderBy('w.ticketTypeId');
    for (const t of types) { stats.types += 1; await promoteType(t.ticketTypeId, stats); }
    return stats;
  }

  // ── Reconciliation (no payment code is involved) ───────────────────────────

  async function reconcile() {
    const at = stamp();
    const stats = { converted: 0, expired: 0, declined: 0, reminded: 0 };
    const offered = (await db('EventWaitlistEntry as w').join('EventOrder as o', 'o.id', 'w.orderId').join('Event as e', 'e.id', 'w.eventId').where('w.status', 'offered')
      .select('w.id', 'w.userId', 'w.eventId', 'w.remindedAt', 'o.status as orderStatus', 'o.confirmedAt', 'o.holdExpiresAt', 'o.id as orderId', 'e.title', 'e.timezone')).map(plain);
    for (const r of offered) {
      if (r.confirmedAt) {
        const done = await db('EventWaitlistEntry').where({ id: r.id, status: 'offered' }).update({ status: 'converted', endedAt: at, endedReason: 'paid', updatedAt: at });
        if (done) { stats.converted += 1; track('waitlist_offer_converted', {}, { eventId: r.eventId }); }
      } else if (r.orderStatus === 'expired') {
        const done = await db('EventWaitlistEntry').where({ id: r.id, status: 'offered' }).update({ status: 'expired', endedAt: at, endedReason: 'offer_expired', updatedAt: at });
        if (done) {
          stats.expired += 1; track('waitlist_offer_expired', {}, { eventId: r.eventId });
          notice(r.userId, {
            id: `ntf_ewe_${r.id}`, type: 'event_waitlist_offer_expired',
            en: { title: 'Your turn has passed', body: `The held ticket for ${r.title} was not paid in time. If you already paid, we will refund you.` },
            sw: { title: 'Zamu yako imepita', body: `Tiketi iliyoshikiliwa ya ${r.title} haikulipiwa kwa wakati. Ikiwa ulishalipa, tutakurejeshea pesa.` },
            data: { eventId: r.eventId, entryId: r.id, orderId: r.orderId, route: routeOf.list() },
          }).catch(() => {});
        }
      } else if (['cancelled'].includes(r.orderStatus)) {
        const done = await db('EventWaitlistEntry').where({ id: r.id, status: 'offered' }).update({ status: 'declined', endedAt: at, endedReason: 'offer_declined', updatedAt: at });
        if (done) stats.declined += 1;
      } else if (!r.remindedAt && r.holdExpiresAt && +new Date(r.holdExpiresAt) - +at <= HOUR && r.orderStatus === 'awaiting_payment') {
        const claimed = await db('EventWaitlistEntry').where({ id: r.id, status: 'offered' }).whereNull('remindedAt').update({ remindedAt: at, updatedAt: at });
        if (claimed) {
          stats.reminded += 1;
          const t = whenTexts({ timezone: r.timezone }, r.holdExpiresAt);
          notice(r.userId, {
            id: `ntf_ewr_${r.id}`, type: 'event_waitlist_offer_reminder',
            en: { title: '1 hour left to pay', body: `Your held ticket for ${r.title} goes to the next person at ${t.timeEn}.` },
            sw: { title: 'Saa 1 imebaki kulipa', body: `Tiketi yako iliyoshikiliwa ya ${r.title} itapewa mtu anayefuata ifikapo ${t.timeSw}.` },
            data: { eventId: r.eventId, entryId: r.id, orderId: r.orderId, route: routeOf.order(r.orderId) },
          }).catch(() => {});
        }
      }
    }
    // A late payment that re-reserved the place (S4 rehold) turns an expired entry into a converted one; only reconciliation does this.
    const late = await db('EventWaitlistEntry as w').join('EventOrder as o', 'o.id', 'w.orderId').where('w.status', 'expired').whereNotNull('o.confirmedAt').select('w.id', 'w.eventId');
    for (const r of late) {
      const done = await db('EventWaitlistEntry').where({ id: r.id, status: 'expired' }).update({ status: 'converted', endedReason: 'paid', updatedAt: at });
      if (done) { stats.converted += 1; track('waitlist_offer_converted', {}, { eventId: r.eventId }); }
    }
    return stats;
  }

  /** The expireHolds hook: reconcile now and offer the freed place without waiting for the next minute (best effort; the job is the guarantee). */
  async function nudge(result) {
    try {
      await reconcile();
      const eventId = result?.order?.eventId;
      if (eventId) await promote({ eventId });
    } catch (err) { console.warn('[events] waitlist nudge skipped:', err?.message); }
  }

  async function purge() {
    const at = stamp();
    const cleared = await db('EventWaitlistEntry').whereNotIn('status', LIVE).whereNotNull('intent').where('endedAt', '<', new Date(+at - 24 * HOUR)).update({ intent: null });
    const deleted = await db('EventWaitlistEntry').whereNotIn('status', LIVE).where('endedAt', '<', new Date(+at - cfg.keepDays() * 24 * HOUR)).del();
    return { cleared, deleted };
  }

  // ── Organizer and admin ────────────────────────────────────────────────────

  async function organizerCounts({ organizerId, eventId }) {
    const event = plain(await db('Event').where({ id: String(eventId), organizerId }).first());
    if (!event) return fail('event_not_found', 404);
    const rows = await db('EventWaitlistEntry').where({ eventId: event.id }).groupBy('ticketTypeId', 'status').select('ticketTypeId', 'status').count({ n: '*' });
    const types = await db('EventTicketType').where({ eventId: event.id }).orderBy('createdAt').select('id', 'name');
    const by = new Map();
    for (const r of rows) { if (!by.has(r.ticketTypeId)) by.set(r.ticketTypeId, {}); by.get(r.ticketTypeId)[r.status] = Number(r.n); }
    const byTicketType = types.map((t) => {
      const c = by.get(t.id) ?? {};
      return { ticketTypeId: t.id, name: t.name, waiting: c.waiting ?? 0, offered: c.offered ?? 0, converted: c.converted ?? 0, expired: c.expired ?? 0, left: (c.left ?? 0) + (c.declined ?? 0) };
    });
    const totals = byTicketType.reduce((a, t) => ({ waiting: a.waiting + t.waiting, offered: a.offered + t.offered, converted: a.converted + t.converted, expired: a.expired + t.expired, left: a.left + t.left }), { waiting: 0, offered: 0, converted: 0, expired: 0, left: 0 });
    return { enabled: event.waitlistEnabled !== false, closedAt: iso(event.waitlistClosedAt), byTicketType, totals };
  }

  async function organizerToggle({ actorId, organizerId, eventId, body = {} }) {
    if (typeof body.enabled !== 'boolean') return fail('validation_failed', 422, { fields: [{ field: 'enabled', code: 'boolean' }] });
    const event = plain(await db('Event').where({ id: String(eventId), organizerId }).first());
    if (!event) return fail('event_not_found', 404);
    if (event.waitlistClosedAt) return fail('waitlist_closed', 409);
    await db('Event').where({ id: event.id }).update({ waitlistEnabled: body.enabled, updatedAt: stamp() });
    await writeAudit(actorId, 'events.waitlist_organizer_toggled', event.id, { enabled: body.enabled });
    return { enabled: body.enabled, closedAt: null };
  }

  async function organizerClose({ actorId, organizerId, eventId }) {
    const event = plain(await db('Event').where({ id: String(eventId), organizerId }).first());
    if (!event) return fail('event_not_found', 404);
    if (event.waitlistClosedAt) return { enabled: false, closedAt: iso(event.waitlistClosedAt), closed: 0 };
    const at = stamp();
    await db('Event').where({ id: event.id, }).whereNull('waitlistClosedAt').update({ waitlistClosedAt: at, waitlistEnabled: false, updatedAt: at });
    const ids = (await db('EventWaitlistEntry').where({ eventId: event.id, status: 'waiting' }).select('id')).map(r => r.id);
    const closed = await endEntries(ids, { reason: 'organizer_closed' });
    await writeAudit(actorId, 'events.waitlist_closed', event.id, { closed });
    return { enabled: false, closedAt: at.toISOString(), closed };
  }

  async function adminList({ eventId, query = {} }) {
    const event = plain(await db('Event').where({ id: String(eventId) }).first());
    if (!event) return fail('event_not_found', 404);
    const limit = parseLimit(query.limit, { dflt: 50, max: 200 });
    if (limit === null) return fail('invalid_limit', 400);
    let q = db('EventWaitlistEntry as w').leftJoin('User as u', 'u.id', 'w.userId').where('w.eventId', event.id);
    if (query.ticketTypeId) q = q.where('w.ticketTypeId', String(query.ticketTypeId));
    if (query.status) q = q.where('w.status', String(query.status));
    if (query.cursor) { const cur = decodeCursor(query.cursor); if (!cur || !Number.isSafeInteger(cur.s)) return fail('invalid_cursor', 400); q = q.where('w.seq', '>', cur.s); }
    const rows = (await q.orderBy('w.seq').limit(limit + 1).select('w.id', 'w.seq', 'w.status', 'w.ticketTypeId', 'w.joinedAt', 'w.intent', 'u.displayName')).map(plain);
    const page = rows.slice(0, limit);
    const items = page.map((r) => {
      const intent = typeof r.intent === 'string' ? JSON.parse(r.intent) : r.intent;
      const name = intent?.participant ? cardName(intent.participant.firstName, intent.participant.lastName) : cardName(String(r.displayName ?? '').split(/\s+/)[0], String(r.displayName ?? '').split(/\s+/).slice(1).join(' '));
      return { id: r.id, seq: r.seq, status: r.status, ticketTypeId: r.ticketTypeId, joinedAt: iso(r.joinedAt), name };
    });
    return { items, nextCursor: rows.length > limit ? encodeCursor({ s: page[page.length - 1].seq }) : null };
  }

  async function adminRemove({ actorId, eventId, entryId, body = {} }) {
    const reason = text(body.reason, 300);
    if (!reason || reason.length < 10) return fail('reason_required', 422, { min: 10, max: 300 });
    const reasonSw = body.reasonSw ? text(body.reasonSw, 300) : null;
    if (body.reasonSw && (!reasonSw || reasonSw.length < 10)) return fail('reason_required', 422, { min: 10, max: 300, field: 'reasonSw' });
    const entry = plain(await db('EventWaitlistEntry').where({ id: String(entryId), eventId: String(eventId) }).first());
    if (!entry) return fail('entry_not_found', 404);
    if (!LIVE.includes(entry.status)) return fail('already_ended', 409);
    const event = plain(await db('Event').where({ id: entry.eventId }).first('title'));
    const at = stamp();
    if (entry.status === 'offered' && entry.orderId) {
      if (await paymentWaiting(entry.orderId)) return fail('payment_pending', 409);
      const loaded = await eventStore.getOrder(entry.orderId);
      if (loaded?.order.status === 'awaiting_payment') {
        const r = await registration.internals.releaseWholeOrder(loaded, { reason: 'admin', actor: 'admin', storeReason: 'admin' });
        if (r.error) return r;
      }
    }
    const done = await db('EventWaitlistEntry').where({ id: entry.id }).whereIn('status', LIVE).update({ status: 'removed', endedAt: at, endedReason: 'removed', updatedAt: at });
    if (!done) return fail('already_ended', 409);
    await writeAudit(actorId, 'events.waitlist_removed', entry.eventId, { entryId: entry.id, reason });
    track('waitlist_closed', { reason: 'admin' }, { eventId: entry.eventId });
    const r = withReason(reason, reasonSw);
    notice(entry.userId, {
      id: `ntf_ewx_${entry.id}`, type: 'event_waitlist_removed',
      en: { title: 'Removed from the waitlist', body: `FitFlex removed you from the waitlist for ${event?.title ?? 'the event'}. ${r.en}` },
      sw: { title: 'Umeondolewa kwenye orodha ya kusubiri', body: `FitFlex imekuondoa kwenye orodha ya kusubiri ya ${event?.title ?? 'tukio'}. ${r.sw}` },
      data: { eventId: entry.eventId, route: routeOf.list() },
    }).catch(() => {});
    return { entry: { id: entry.id, status: 'removed' } };
  }

  return {
    join, list, leave, reconfirm, promote, reconcile, nudge, purge, closeStale,
    organizerCounts, organizerToggle, organizerClose, adminList, adminRemove, gate, source, view,
    internals: { offerMinutes, quietNow, classify },
  };
}
