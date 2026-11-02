// Shared fixture for the S5 specs (CI database only). It wraps the S4 harness: the three S5 flags, the webhook key, an organizer with
// staff of every role, a published event that hands out a kit with two collection points, CONFIRMED registrations with active tickets
// (straight from the store, no payment flow), API clients created through the real service, and a cleanup that removes every S5 row
// before the S3/S4 cleanup removes the orders they point at.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { harness as harness4, s4On, s4Off, uid, phone, D, H, TICKET_SECRET } from './events-s4.mjs';
import { db } from '../../src/infra/knex-store.mjs';
import { eventStore, eventsIntegrationsService, eventsWebhookService } from '../../src/bootstrap/services.mjs';
import { ticketKeyRing, deriveToken, newTicketId, sha256hex, displayCodeOf, qrPayloadOf } from '../../src/shared/events-ticket-token.mjs';
import { exchangeClientCredentials, resetApiAuthLimits } from '../../src/auth/organizer-api-auth.mjs';

export { uid, phone, D, H, db, s4Off };

/** For writes the code sends after the response without awaiting (notices, usage counters, rate-limited audits): read until
 *  `until(value)` holds or ~5 s pass, and return the last read. A read-once assertion races those writes on a busy CI database. */
export async function eventually(read, { until = v => (Array.isArray(v) ? v.length > 0 : Boolean(v)), timeoutMs = 5000, stepMs = 50 } = {}) {
  const end = Date.now() + timeoutMs;
  let v = await read();
  while (!until(v) && Date.now() < end) { await new Promise(r => setTimeout(r, stepMs)); v = await read(); }
  return v;
}
export const WEBHOOK_KEY = randomBytes(32).toString('base64');
export const S5_ENV = ['EVENTS_KIT_OPS', 'EVENTS_ORGANIZER_API', 'EVENTS_WEBHOOKS', 'EVENTS_WEBHOOK_SECRET_KEY', 'EVENTS_WEBHOOK_SECRET_KEY_ID', 'EVENTS_WEBHOOK_SECRET_KEY_PREVIOUS',
  'EVENTS_API_ORGANIZER_ALLOWLIST', 'EVENTS_RESULTS', 'EVENTS_API_MAX_CLIENTS', 'EVENTS_API_DEFAULT_RATE', 'EVENTS_WEBHOOK_MAX_ENDPOINTS', 'EVENTS_WEBHOOK_MAX_ATTEMPTS', 'EVENTS_FEED_LAG_SECONDS', 'EVENTS_EXPORT_MAX_ROWS'];

/** EVENTS_MODULE + EVENTS_REGISTRATION (+ the ticket secret) and the three S5 flags (kit / api / webhooks), the webhook key, no feed lag. */
export function s5On({ kit = true, api = true, webhooks = true, key = true } = {}) {
  s4On();
  if (kit) process.env.EVENTS_KIT_OPS = '1';
  if (api) process.env.EVENTS_ORGANIZER_API = '1';
  if (webhooks) process.env.EVENTS_WEBHOOKS = '1';
  if (key) process.env.EVENTS_WEBHOOK_SECRET_KEY = WEBHOOK_KEY;
  process.env.EVENTS_FEED_LAG_SECONDS = '0';
}
export function s5Off() {
  for (const k of S5_ENV) delete process.env[k];
  s4Off();
  resetApiAuthLimits();
}

export const staffEmail = () => `s5.${uid('').slice(1)}@events.test`;

export function harness() {
  const base = harness4();
  const made5 = { events: [], organizers: [] };

  /** An active organizer, its owner and one staff user per role. */
  async function org({ apiAccess = true } = {}) {
    const o = await base.organizer();
    made5.organizers.push(o.id);
    if (apiAccess) await db('EventOrganizer').where({ id: o.id }).update({ apiAccessEnabledAt: new Date() });
    const roles = {};
    for (const role of ['admin', 'ops', 'timing', 'finance']) roles[role] = await o.staff(role);
    return { ...o, owner: o.claims, ...roles };
  }

  /**
   * A published event that hands out a kit, with two collection points (open for 12 hours around now), `n` confirmed registrations with
   * active tickets in the first category. → { organizer, event, categories, ticketType, points, regs: [{ id, firstName, lastName, token, payload, ticket }] }
   */
  async function kitEvent({ organizer = null, n = 3, categories = null, eventOver = {}, apiAccess = true } = {}) {
    const o = organizer ?? await org({ apiAccess });
    const f = await base.sellingEvent({
      organizer: o, event: { kitProvided: true, ...eventOver },
      categories: categories ?? [{ name: '10K', distanceMeters: 10000, tickets: [{ name: 'Early', priceTzs: 20000, capacity: 200 }] }, { name: '5K', distanceMeters: 5000, tickets: [{ name: 'Fun', priceTzs: 10000, capacity: 200 }] }],
    });
    made5.events.push(f.event.id);
    const at = new Date();
    const points = [];
    for (const name of ['Main kit tent', 'Hotel desk']) {
      const id = uid('ecp');
      await db('EventCollectionPoint').insert({
        id, eventId: f.event.id, name, address: 'Dar es Salaam', status: 'active',
        openingWindows: JSON.stringify([{ opensAt: new Date(+at - 6 * H).toISOString(), closesAt: new Date(+at + 6 * H).toISOString() }]), instructions: JSON.stringify({ en: 'Bring ID', sw: 'Lete kitambulisho' }),
      });
      points.push({ id, name });
    }
    const regs = await addRegistrations({ eventId: f.event.id, ticketType: f.ticket, n });
    return { ...f, organizer: o, points, regs, ticketType: f.ticket };
  }

  const names = [['Amina', 'Mollel'], ['Baraka', 'Juma'], ['Zawadi', 'Nyerere'], ['Hamisi', 'Kweka'], ['Neema', 'Abdallah'], ['Saidi', 'Mushi'], ['Rehema', 'Lyimo'], ['Joseph', 'Mwita']];

  /** `n` confirmed registrations (one order each) with active tickets. */
  async function addRegistrations({ eventId, ticketType, n = 1, firstName = null, lastName = null }) {
    const ring = ticketKeyRing({ EVENT_TICKET_SECRET: TICKET_SECRET });
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const buyer = await base.user({ phone: phone() });
      const [fn, ln] = names[(out.length + i) % names.length];
      const placed = await eventStore.createOrderWithHolds({
        eventId, purchaserUserId: buyer, lines: [{ ticketTypeId: ticketType.id, quantity: 1 }],
        participants: [{ ticketTypeId: ticketType.id, firstName: firstName ?? fn, lastName: lastName ?? ln, phone: phone(), consentBasis: 'self' }],
      });
      assert.equal(placed.error, undefined, JSON.stringify(placed));
      const committed = await eventStore.commitOrder(placed.order.id);
      assert.equal(committed.error, undefined, JSON.stringify(committed));
      const reg = await db('EventRegistration').where({ orderId: placed.order.id }).first();
      await db('EventRegistration').where({ id: reg.id }).update({ participantUserId: buyer, claimedAt: new Date(), paidAt: new Date(), paidAmountTzs: 20000 });
      const ticketId = newTicketId();
      const token = deriveToken(ring, { ticketId, tokenVersion: 1, registrationId: reg.id, eventId });
      await db('EventTicket').insert({
        id: ticketId, registrationId: reg.id, tokenHash: sha256hex(token), status: 'active', issuedAt: new Date(), tokenVersion: 1, tokenKeyId: ring.keyId,
        displayCode: displayCodeOf(ticketId, reg.id), issuedForUserId: buyer,
      });
      out.push({ id: reg.id, firstName: reg.firstName, lastName: reg.lastName, ticketId, token, payload: qrPayloadOf(token), userId: buyer, displayCode: displayCodeOf(ticketId, reg.id), orderId: placed.order.id });
    }
    return out;
  }

  /** An API client made through the real service; `token()` runs the real exchange. */
  async function apiClient(organizer, { scopes = ['registrations:read'], environment = 'live', eventIds = undefined, role = 'owner' } = {}) {
    const ctx = { organizer: { id: organizer.id }, role };
    const created = await eventsIntegrationsService.createClient({
      ctx, actorId: organizer.ownerUserId, body: { name: 'Timing partner', environment, scopes, ...(eventIds ? { eventIds } : {}), expiresInDays: 30 },
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const state = { client: created.client, secret: created.clientSecret };
    const exchange = async () => exchangeClientCredentials({ clientId: state.client.clientId, clientSecret: state.secret, ip: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
    const token = async () => { const r = await exchange(); assert.equal(r.ok, true, JSON.stringify(r.body)); return r.accessToken; };
    return { ...state, exchange, token, bearer: async () => ({ authorization: `Bearer ${await token()}` }) };
  }

  async function cleanup() {
    const events = base.made.events;
    const orgs = base.made.organizers;
    if (orgs.length) {
      const clientIds = (await db('ApiClient').whereIn('ownerId', orgs).select('id')).map(r => r.id);
      const endpointIds = (await db('WebhookEndpoint').whereIn('organizerId', orgs).select('id')).map(r => r.id);
      if (endpointIds.length) {
        await db('WebhookDeliveryAttempt').whereIn('endpointId', endpointIds).del();
        await db('WebhookDelivery').whereIn('endpointId', endpointIds).del();
        await db('WebhookEndpoint').whereIn('id', endpointIds).del();
      }
      if (clientIds.length) {
        await db('EventKitCollection').whereIn('apiClientId', clientIds).update({ apiClientId: null });
        await db('EventBibAssignment').whereIn('assignedByApiClientId', clientIds).update({ assignedByApiClientId: null });
        await db('OrganizerIdempotency').whereIn('scopeId', clientIds).del();
        await db('AuditLog').whereIn('target', clientIds).del();
        await db('ApiClientUsageDay').whereIn('apiClientId', clientIds).del();
        await db('ApiClient').whereIn('id', clientIds).del();
      }
      await db('AuditLog').whereIn('target', orgs).del();
    }
    if (events.length) {
      await db('EventBibAssignment').whereIn('eventId', events).del();
      await db('EventKitCollection').whereIn('eventId', events).del();
      const regIds = (await db('EventRegistration').whereIn('eventId', events).select('id')).map(r => r.id);
      if (regIds.length) { await db('EventTicket').whereIn('registrationId', regIds).del(); }
      await db('EventCollectionPoint').whereIn('eventId', events).del();
    }
    await db('OrganizerIdempotency').whereIn('scopeId', base.made.users).del();
    await base.cleanup();
    s5Off();
  }

  return { ...base, org, kitEvent, addRegistrations, apiClient, cleanup, made5, webhookService: eventsWebhookService };
}

// ── A webhook lab: a service instance with a fake clock, an injected resolver and a scripted receiver ──
import { createEventsWebhookService } from '../../src/services/events-webhook-service.mjs';
import { webhookKeyRing } from '../../src/shared/webhook-signing.mjs';

export const PUBLIC_IP = '93.184.216.34';
/**
 * { svc, clock, calls, notes, script, dns } — `script` is a queue of receiver steps: { status, body? } | { throw: 'timeout' | 'tls_error' | 'network_error', cause? };
 * when empty the receiver answers 200. The verification handshake is answered correctly unless `lab.verifyAnswer` says otherwise.
 */
export function webhookLab({ maxAttempts = 10, dns = { 'hooks.example.test': [PUBLIC_IP] } } = {}) {
  // The clock follows real time (rows written by the stores carry real time) plus an offset the spec can advance.
  const lab = { offset: 0, calls: [], notes: [], script: [], dns: { ...dns }, verifyAnswer: 'echo' };
  lab.clock = { get t() { return Date.now() + lab.offset; } };
  const resolve = async (host) => { if (!(host in lab.dns)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return lab.dns[host].map(address => ({ address, family: address.includes(':') ? 6 : 4 })); };
  const sendHttp = async ({ url, addresses, headers, body }) => {
    const parsed = JSON.parse(body);
    lab.calls.push({ url, addresses, headers, body, parsed, at: lab.clock.t });
    if (parsed.type === 'endpoint.verification') {
      if (lab.verifyAnswer === 'echo') return { status: 200, headers: { 'content-type': 'application/json' }, snippet: JSON.stringify({ challenge: parsed.challenge }) };
      if (lab.verifyAnswer === 'wrong') return { status: 200, headers: { 'content-type': 'application/json' }, snippet: JSON.stringify({ challenge: 'nope' }) };
      return { status: 500, headers: {}, snippet: 'down' };
    }
    const step = lab.script.shift() ?? { status: 200 };
    if (step.throw) throw Object.assign(new Error(step.throw), { code: step.throw, cause: step.cause });
    return { status: step.status, headers: { 'content-type': step.contentType ?? 'text/plain' }, snippet: step.body ?? '' };
  };
  lab.svc = createEventsWebhookService({
    db, keyRing: () => webhookKeyRing(process.env), now: () => new Date(lab.clock.t), resolve, sendHttp, random: () => 0.5,
    notify: async (userId, message) => { lab.notes.push({ userId, ...message }); }, localeOf: async () => null,
    config: { lagSeconds: () => 0, maxAttempts: () => maxAttempts, batch: () => 50 },
  });
  lab.advance = ms => { lab.offset += ms; };
  // Timestamps have millisecond precision and a local database answers in under one: pause a few ms around the moments the rules compare
  // (an endpoint is created BEFORE the events it should receive; a row is older than the scan that fans it out), so a fast machine cannot tie them.
  const tick = () => new Promise(r => setTimeout(r, 4));
  lab.endpoint = async (organizer, { events = ['kit.collected', 'bib.assigned', 'registration.created'], url = 'https://hooks.example.test/hook', verify = true, eventIds = undefined } = {}) => {
    await tick();
    const created = await lab.svc.createEndpoint({ organizerId: organizer.id, actorId: organizer.ownerUserId, body: { url, events, ...(eventIds ? { eventIds } : {}) } });
    assert.equal(created.status, 201, JSON.stringify(created));
    if (verify) assert.equal((await lab.svc.verifyEndpoint({ organizerId: organizer.id, id: created.endpoint.id, actorId: organizer.ownerUserId })).ok, true);
    await tick();
    return { id: created.endpoint.id, secret: created.signingSecret, endpoint: created.endpoint };
  };
  lab.emit = async (event, organizerId, type = 'kit.collected', payload = null, regId = 'ereg_lab') => {
    const row = await db.transaction(trx => eventStore.appendOutbox(trx, {
      type, aggregateType: 'registration', aggregateId: regId, organizerId, eventId: event.id,
      payload: payload ?? { registrationId: regId, collectionPointId: 'ecp_lab', collectedAt: new Date().toISOString() },
    }));
    await tick();
    return row;
  };
  return lab;
}
