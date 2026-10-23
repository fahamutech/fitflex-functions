// Shared fixture for the S3 registration specs (CI database only): users with verified contacts, organizers
// straight from the store, published events with categories and ticket types, a route caller that runs the
// guards, and a cleanup that removes everything made here in dependency order.
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { db } from '../../src/infra/knex-store.mjs';
import { sign } from '../../src/auth/jwt.mjs';
import { eventStore, eventCatalogueStore, b2bService } from '../../src/bootstrap/services.mjs';
import { verifyContacts, purgeIdentity } from './verified-contacts.mjs';

export const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
export const H = 3_600_000;
export const D = 24 * H;
export const FLAGS = ['EVENTS_MODULE', 'EVENTS_REGISTRATION', 'EVENTS_FAVOURITES', 'EVENTS_FEE_RULE', 'EVENTS_ORG_DISCOUNTS', 'EVENTS_MAX_PARTICIPANTS_PER_ORDER', 'EVENTS_TEAM_MAX_MEMBERS', 'EVENT_HOLD_TTL_MINUTES'];
export const flagsOn = () => { process.env.EVENTS_MODULE = '1'; process.env.EVENTS_REGISTRATION = '1'; };
export const flagsOff = () => { for (const f of FLAGS) delete process.env[f]; };

let phoneSeq = Math.floor(Math.random() * 700000) + 100000;
export const phone = () => `+255712${String(phoneSeq += 1).padStart(6, '0')}`;
const tag = randomUUID().slice(0, 6);
export const mail = name => `${name}.${tag}@events.test`;

export function harness() {
  const made = { users: [], organizers: [], events: [], orgs: [] };

  /** A user row (member by default). `verified`: the email / phone become verified LoginIdentifier rows of their Person. */
  async function user({ userType = 'member', email = null, phone: p = null, name = null, verified = true, extra = {} } = {}) {
    const id = uid('usr');
    await db('User').insert({ id, userType, displayName: name ?? `S3 ${userType} ${id.slice(-4)}`, email, phone: p, accountStatus: 'active', updatedAt: new Date(), ...extra });
    made.users.push(id);
    if (verified && (email || p)) await verifyContacts(db, id, { email, phone: p });
    return id;
  }
  const claimsOf = (sub, userType = 'member') => ({ sub, userType });
  const superAdmin = async () => claimsOf(await user({ userType: 'admin' }), 'admin');

  /** An organizer straight from the store with an approved KYC case, active, and its owner staff row. */
  async function organizer({ status = 'active', name = 'Dar Runners' } = {}) {
    const ownerUserId = await user({ userType: 'event_organizer' });
    const row = await eventStore.createOrganizer({ ownerUserId, name });
    made.organizers.push(row.id);
    const caseId = uid('kyc');
    await db('PartnerKycCase').insert({ id: caseId, partnerType: 'event_organizer', userId: ownerUserId, status: 'approved', tier: 3, updatedAt: new Date() });
    await eventCatalogueStore.patchOrganizer(row.id, { kycCaseId: caseId });
    await eventCatalogueStore.setOrganizerStatus(row.id, status, status === 'active' ? null : 'spec');
    await eventCatalogueStore.addStaff({ organizerId: row.id, userId: ownerUserId, role: 'owner' });
    await db('User').where({ id: ownerUserId }).update({ organizerId: row.id, organizerRole: 'owner' });
    const staff = async role => {
      const id = await user({ userType: 'organizer_staff' });
      await eventCatalogueStore.addStaff({ organizerId: row.id, userId: id, role });
      await db('User').where({ id }).update({ organizerId: row.id, organizerRole: role });
      return claimsOf(id, 'organizer_staff');
    };
    return { id: row.id, ownerUserId, caseId, claims: claimsOf(ownerUserId, 'event_organizer'), staff };
  }

  /**
   * A published event. categories: [{ name, distanceMeters, minAge?, tickets: [{ name, priceTzs, capacity, minPerOrder?, maxPerOrder?, saleOpensAt?, saleClosesAt? }] }].
   * event: extra Event columns (participantFields, duplicatePolicy, kitProvided, timezone, startsAt, endsAt, registrationClosesAt).
   */
  async function publishedEvent({ organizer: org = null, categories = null, event = {}, publish = true } = {}) {
    const o = org ?? await organizer();
    const startsAt = event.startsAt ?? new Date(+new Date() + 40 * D);
    const created = await eventStore.createEvent({
      organizerId: o.id, slug: `dar-run-${uid('').slice(1, 11)}`, title: 'Dar Half Marathon', eventType: 'road', timezone: 'Africa/Dar_es_Salaam',
      startsAt, endsAt: new Date(+startsAt + 6 * H), registrationClosesAt: new Date(+startsAt - D), description: 'A race', ...event,
    });
    assert.equal(created.error, undefined, JSON.stringify(created));
    made.events.push(created.id);
    if (publish) {
      assert.equal((await eventStore.transitionEvent(created.id, 'submitted')).to, 'submitted');
      assert.equal((await eventStore.transitionEvent(created.id, 'published')).to, 'published');
    }
    const cats = [];
    for (const c of categories ?? [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early bird', priceTzs: 20000, capacity: 10 }] }]) {
      const { tickets, ...catInput } = c;
      const cat = await eventStore.createCategory({ eventId: created.id, status: 'active', ...catInput });
      assert.equal(cat.error, undefined, JSON.stringify(cat));
      const tts = [];
      for (const t of tickets ?? []) {
        const tt = await eventStore.createTicketType({ eventId: created.id, categoryId: cat.id, ...t });
        assert.equal(tt.error, undefined, JSON.stringify(tt));
        tts.push(tt);
      }
      cats.push({ ...cat, tickets: tts });
    }
    return { organizer: o, event: await eventStore.getEvent(created.id), categories: cats, ticket: cats[0]?.tickets[0] ?? null };
  }

  /** A B2B organisation (active) and a way to add users with a role. */
  async function organization({ name = 'Acme' } = {}) {
    const operator = await user({ userType: 'admin' });
    const adminAccess = async orgId => b2bService.resolveAccess({ organizationId: orgId, userId: operator, userType: 'admin' });
    const { organization: org } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `${name} ${uid('o')}`, tradingName: name }, actorId: operator });
    made.orgs.push(org.id);
    await b2bService.setOrganizationStatus({ organizationId: org.id, status: 'active', actorId: operator });
    const member = async (role, opts = {}) => {
      const sub = await user(opts);
      const out = await b2bService.addOrganizationUser({ access: await adminAccess(org.id), body: { userId: sub, role }, actorId: operator });
      assert.ok(!out.error, JSON.stringify(out));
      return claimsOf(sub);
    };
    return { id: org.id, operator, member, setStatus: status => b2bService.setOrganizationStatus({ organizationId: org.id, status, actorId: operator }) };
  }

  function res() {
    return { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; }, end() { return this; } };
  }
  /** Run a route like the server does: its guards (in order) then the handler. `headers` are lower-cased. */
  async function call(route, claims, { params = {}, query = {}, body = {}, headers = {}, ip = '10.0.0.1' } = {}) {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (claims) h.authorization = `Bearer ${sign(claims)}`;
    const req = { method: route.method.toUpperCase(), headers: h, params, query, body, ip, get: name => h[String(name).toLowerCase()] ?? null };
    const out = res();
    for (const guard of [route.onGuard].flat().filter(Boolean)) {
      let passed = false;
      await guard(req, out, () => { passed = true; });
      if (!passed) return { status: out.statusCode, body: out.body };
    }
    await route.onRequest(req, out);
    return { status: out.statusCode, body: out.body };
  }

  const counters = async id => { const r = await db('EventTicketType').where({ id }).first('sold', 'held', 'capacity'); return { sold: r.sold, held: r.held, capacity: r.capacity }; };
  const movements = orderId => db('EventInventoryMovement').where({ orderId }).orderBy('createdAt');
  const outbox = (eventId, type = null) => db('OutboxEvent').where({ eventId }).modify(q => { if (type) q.where({ type }); }).orderBy('createdAt');
  const notifications = (userId, type = null) => db('Notification').where({ userId }).modify(q => { if (type) q.where({ type }); }).orderBy('createdAt');

  async function cleanup() {
    flagsOff();
    const events = made.events;
    const orderIds = events.length ? (await db('EventOrder').whereIn('eventId', events).select('id')).map(r => r.id) : [];
    if (events.length) {
      await db('EventTeamMember').whereIn('eventId', events).del();
      await db('EventOrder').whereIn('eventId', events).update({ teamId: null });
      await db('EventTeam').whereIn('eventId', events).del();
      await db('OutboxEvent').whereIn('eventId', events).del();
    }
    if (orderIds.length) {
      await db.transaction(async (trx) => {
        await trx.raw('ALTER TABLE "EventInventoryMovement" DISABLE TRIGGER ALL');
        await trx('EventInventoryMovement').whereIn('orderId', orderIds).del();
        await trx.raw('ALTER TABLE "EventInventoryMovement" ENABLE TRIGGER ALL');
      });
      await db('EventRegistration').whereIn('orderId', orderIds).del();
      await db('EventOrderLine').whereIn('orderId', orderIds).del();
      await db('EventOrder').whereIn('id', orderIds).del();
    }
    if (events.length) {
      await db('AuditLog').whereIn('target', events).del();
      await db('AuditLog').whereIn('target', orderIds).del();
      await db('EventChangeLog').whereIn('eventId', events).del();
      await db('EventFavourite').whereIn('eventId', events).del();
      await db('EventTicketType').whereIn('eventId', events).del();
      await db('EventCategory').whereIn('eventId', events).del();
      await db('EventCollectionPoint').whereIn('eventId', events).del();
      await db('Event').whereIn('id', events).del();
    }
    if (made.organizers.length) {
      await db('EventOrganizerStaff').whereIn('organizerId', made.organizers).del();
      await db('OrgMembership').whereIn('organizerId', made.organizers).del();
      await db('EventOrganizer').whereIn('id', made.organizers).del();
    }
    if (made.orgs.length) {
      await db('B2BOrganizationUser').whereIn('organizationId', made.orgs).del();
      await db('B2BOrganization').whereIn('id', made.orgs).del();
    }
    await db('PartnerKycCase').whereIn('userId', made.users).del();
    await db('AuditLog').whereIn('actor', made.users).del();
    await db('Notification').whereIn('userId', made.users).del();
    await db('CommunicationPreference').whereIn('id', made.users).del().catch(() => {});
    await db('OrgMembership').whereIn('personaId', made.users).del().catch(() => {});
    const persons = await purgeIdentity(db, made.users);
    await db('User').whereIn('id', made.users).del();
    if (persons?.length) await db('Person').whereIn('id', persons).del().catch(() => {});
    await db('JobRun').where({ job: 'event-hold-expiry' }).del();
  }

  return { made, user, claimsOf, superAdmin, organizer, publishedEvent, organization, call, counters, movements, outbox, notifications, cleanup, db };
}

/** A wire participant. */
export const participant = (ticketTypeId, over = {}) => ({ ticketTypeId, firstName: 'Asha', lastName: 'Mollel', phone: phone(), consentBasis: 'purchaser_authorised', ...over });
