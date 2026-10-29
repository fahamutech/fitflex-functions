// Marathon & running events · S5 — webhook fan-out isolation (spec §7.4; follow-up "fan-out strictly on organizerId"). SCENARIO 19 for webhooks.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { harness, s5On, s5Off, db, webhookLab, uid } from './fixtures/events-s5.mjs';
import { eventsOrganizerService, eventsAdminService } from '../src/bootstrap/services.mjs';

await ensureInit();
const h = harness();
afterEach(() => { s5Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });

async function two() {
  s5On();
  await db('WebhookDeliveryAttempt').del();
  await db('WebhookDelivery').del();
  const a = await h.kitEvent({ n: 1 });
  const b = await h.kitEvent({ n: 1 });
  const lab = webhookLab();
  const all = ['kit.collected', 'bib.assigned', 'registration.created', 'registration.cancelled', 'refund.updated', 'event.updated', 'event.cancelled', 'registration.updated', 'registration.paid'];
  const epA = await lab.endpoint(a.organizer, { events: all });
  const epB = await lab.endpoint(b.organizer, { events: all });   // the SAME URL, a different organizer, its own secret
  assert.notEqual(epA.secret, epB.secret);
  return { a, b, lab, epA, epB };
}
const deliveriesOf = async (endpointId) => db('WebhookDelivery').where({ endpointId });

test('SCENARIO 19 — an outbox row of organizer B never produces a delivery for organizer A\'s endpoint (the join is in the SQL), whatever the type', async () => {
  const { a, b, lab, epA, epB } = await two();
  for (const type of ['kit.collected', 'bib.assigned', 'registration.created', 'registration.cancelled', 'registration.paid']) {
    await lab.emit(b.event, b.organizer.id, type, { registrationId: 'ereg_b', categoryId: 'c', ticketTypeId: 't', collectionPointId: 'p', bibNumber: '1', reason: 'cancelled', collectedAt: new Date().toISOString() });
  }
  await lab.svc.fanout();
  assert.equal((await deliveriesOf(epA.id)).length, 0, 'A receives nothing of B\'s');
  assert.equal((await deliveriesOf(epB.id)).length, 5);
  await lab.svc.deliverDue();
  assert.ok(lab.calls.filter(c => c.parsed.type !== 'endpoint.verification').every(c => c.parsed.organizerId === b.organizer.id), 'every body names B');
  // and the other way round
  await lab.emit(a.event, a.organizer.id);
  await lab.svc.fanout();
  assert.deepEqual([(await deliveriesOf(epA.id)).length, (await deliveriesOf(epB.id)).length], [1, 5]);
  // a row whose organizer is NULL is only marked published
  const orphan = await db.transaction(trx => lab.svc && import('../src/bootstrap/services.mjs').then(m => m.eventStore.appendOutbox(trx, { type: 'kit.collected', aggregateType: 'registration', aggregateId: 'ereg_x', organizerId: null, eventId: a.event.id, payload: { registrationId: 'ereg_x' } })));
  await lab.svc.fanout();
  assert.ok((await db('OutboxEvent').where({ id: orphan.id }).first()).publishedAt);
  assert.equal((await db('WebhookDelivery').where({ outboxEventId: orphan.id })).length, 0);
});

test('the deliver step re-checks: a delivery that links A\'s endpoint to B\'s outbox row (planted past the SQL) is dead-lettered with a high-severity audit row, and NOTHING is sent', async () => {
  const { a, b, lab, epA } = await two();
  const evt = await lab.emit(b.event, b.organizer.id);
  await db('WebhookDelivery').insert({ id: uid('whd'), endpointId: epA.id, outboxEventId: evt.id, status: 'pending', attemptCount: 0, nextAttemptAt: new Date(Date.now() - 1000) });
  const before = lab.calls.length;
  const r = await lab.svc.deliverDue();
  assert.equal(r.dead, 1);
  assert.equal(lab.calls.length, before, 'no request was made');
  const d = await db('WebhookDelivery').where({ endpointId: epA.id, outboxEventId: evt.id }).first();
  assert.deepEqual([d.status, d.lastError], ['dead', 'organizer_mismatch']);
  assert.deepEqual((await db('WebhookDeliveryAttempt').where({ deliveryId: d.id })).map(x => x.outcome), ['organizer_mismatch']);
  const audit = await db('AuditLog').where({ action: 'events.webhook_organizer_mismatch', target: d.id });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].after.severity, 'high');
  // an outbox row of A's organizer that names B's EVENT is refused too
  const evt2 = await lab.emit(b.event, a.organizer.id, 'kit.collected', { registrationId: 'ereg_z', collectionPointId: 'p', collectedAt: new Date().toISOString() });
  await lab.svc.fanout();
  await lab.svc.deliverDue();
  assert.ok(!lab.calls.some(c => c.parsed.data?.registrationId === 'ereg_z'), 'nothing about the foreign event was sent');
  assert.equal((await db('WebhookDelivery').where({ endpointId: epA.id, outboxEventId: evt2.id }).first()).lastError, 'organizer_mismatch');
});

test('subscriptions: only subscribed types; an eventIds-restricted endpoint gets only those events; internal types (payment, ticket) and registration.reserved are published but never delivered', async () => {
  s5On();
  await db('WebhookDeliveryAttempt').del(); await db('WebhookDelivery').del();
  const f = await h.kitEvent({ n: 1 });
  const g = await h.kitEvent({ organizer: f.organizer, n: 1 });
  const lab = webhookLab();
  const kitOnly = await lab.endpoint(f.organizer, { events: ['kit.collected'] });
  const restricted = await lab.endpoint(f.organizer, { events: ['kit.collected', 'bib.assigned'], eventIds: [g.event.id], url: 'https://hooks.example.test/restricted' });
  const rows = {};
  for (const [name, event, type, payload] of [
    ['kit-f', f.event, 'kit.collected', {}], ['bib-f', f.event, 'bib.assigned', { bibNumber: '1' }], ['kit-g', g.event, 'kit.collected', {}], ['bib-g', g.event, 'bib.assigned', { bibNumber: '2' }],
    ['pay', f.event, 'payment.succeeded', { paymentId: 'p', orderId: 'o', amountTzs: 20000, currency: 'TZS' }], ['ticket', f.event, 'ticket.issued', { ticketId: 't' }], ['revoked', f.event, 'ticket.revoked', { ticketId: 't' }],
    ['reserved', f.event, 'registration.reserved', { registrationId: 'r' }], ['unfulfilled', f.event, 'refund.requested', { scope: 'unfulfilled_payment', refundId: 'r' }],
  ]) rows[name] = await lab.emit(event, f.organizer.id, type, { registrationId: 'ereg_s', collectionPointId: 'ecp', collectedAt: new Date().toISOString(), ...payload });
  await lab.svc.fanout();
  const idsOf = async ep => new Set((await deliveriesOf(ep.id)).map(d => d.outboxEventId));
  assert.deepEqual([...await idsOf(kitOnly)].sort(), [rows['kit-f'].id, rows['kit-g'].id].sort());
  assert.deepEqual([...await idsOf(restricted)].sort(), [rows['kit-g'].id, rows['bib-g'].id].sort());
  for (const n of ['pay', 'ticket', 'revoked', 'reserved', 'unfulfilled']) {
    assert.ok((await db('OutboxEvent').where({ id: rows[n].id }).first()).publishedAt, `${n} is marked published`);
    assert.equal((await db('WebhookDelivery').where({ outboxEventId: rows[n].id })).length, 0, `${n} is never delivered`);
  }
});

test('refund rows are mapped at fan-out time to refund.updated with ids and a status only — no amounts, no refund id, no payer', async () => {
  const { a, lab, epA } = await two();
  await lab.emit(a.event, a.organizer.id, 'refund.paid', { refundId: 'ref_1', orderId: 'eor_1', eventId: a.event.id, scope: 'order', amountTzs: 15000, destination: '0712 345 678' });
  await lab.svc.fanout(); await lab.svc.deliverDue();
  const body = lab.calls.filter(c => c.parsed.type === 'refund.updated').map(c => c.parsed);
  assert.equal(body.length, 1);
  assert.deepEqual(body[0].data, { orderId: 'eor_1', eventId: a.event.id, scope: 'order', status: 'paid' });
  assert.ok(!/15000|ref_1|0712/.test(JSON.stringify(body[0])));
  void epA;
});

test('no webhook payload carries a name, phone, email, amount, token or user id — even when the outbox payload does', async () => {
  const { a, lab } = await two();
  const dirty = { registrationId: 'ereg_d', categoryId: 'c', ticketTypeId: 't', collectionPointId: 'p', collectedAt: new Date().toISOString(), bibNumber: '9', previousBibNumber: null, reason: 'cancelled',
    firstName: 'Amina', lastName: 'Mollel', phone: '+255712000111', email: 'amina@example.com', amountTzs: 20000, token: 'ev1.k1.etk_x.1.mac', participantUserId: 'usr_1', purchaserUserId: 'usr_2', gender: 'female', dateOfBirth: '1990-01-01', emergencyContact: { name: 'M' }, changed: ['kit'] };
  for (const type of ['registration.created', 'registration.paid', 'registration.cancelled', 'registration.updated', 'kit.collected', 'bib.assigned']) await lab.emit(a.event, a.organizer.id, type, dirty);
  await lab.emit(a.event, a.organizer.id, 'event.updated', { eventId: a.event.id, version: 3, changedFields: ['title', 'categories[x].priceTzs'], material: true, title: 'Secret Title', description: 'text' });
  await lab.emit(a.event, a.organizer.id, 'event.cancelled', { eventId: a.event.id, cancelledAt: new Date().toISOString(), reasonCode: 'weather', note: 'free text' });
  await lab.svc.fanout(); await lab.svc.deliverDue();
  const sent = lab.calls.filter(c => c.parsed.type !== 'endpoint.verification');
  assert.equal(sent.length, 8);
  for (const c of sent) assert.ok(!/Amina|Mollel|255712|amina@|20000|ev1\.k1|usr_|female|1990|emergency|Secret Title|free text/i.test(c.body), `${c.parsed.type}: ${c.body}`);
});

test('the commit lag: fan-out does not touch rows younger than the lag; two fan-outs at once create each delivery once', async () => {
  s5On();
  await db('WebhookDeliveryAttempt').del(); await db('WebhookDelivery').del();
  const f = await h.kitEvent({ n: 1 });
  const lab = webhookLab();
  const ep = await lab.endpoint(f.organizer, { events: ['kit.collected'] });
  const evts = [];
  for (let i = 0; i < 5; i += 1) evts.push(await lab.emit(f.event, f.organizer.id, 'kit.collected', null, `ereg_lag_${i}`));
  const slow = webhookLab();
  slow.svc = (await import('../src/services/events-webhook-service.mjs')).createEventsWebhookService({ db, keyRing: () => (process.env.EVENTS_WEBHOOK_SECRET_KEY ? { keyId: 'k1', key: Buffer.from(process.env.EVENTS_WEBHOOK_SECRET_KEY, 'base64'), previous: {} } : null), config: { lagSeconds: () => 3600 } });
  assert.deepEqual(await slow.svc.fanout(), { rows: 0, deliveries: 0 }, 'rows younger than the lag are left alone');
  await Promise.all([lab.svc.fanout(), lab.svc.fanout(), lab.svc.fanout()]);
  assert.equal((await deliveriesOf(ep.id)).length, 5);
  assert.equal((await db('OutboxEvent').whereIn('id', evts.map(e => e.id)).whereNull('publishedAt')).length, 0);
});

test('event.updated and event.cancelled reach the outbox: a save of a published event (paths only, never values), and the single cancel transition', async () => {
  s5On();
  const f = await h.kitEvent({ n: 0 });
  const ctx = { organizer: { id: f.organizer.id, status: 'active' }, role: 'owner' };
  const ev = await db('Event').where({ id: f.event.id }).first();
  const saved = await eventsOrganizerService.patchEvent({ ctx, eventId: f.event.id, actorId: f.organizer.ownerUserId, body: { version: ev.version, description: { en: 'A fast, flat road race along the Dar es Salaam coast.', sw: 'Mbio za barabarani tambarare kando ya pwani ya Dar es Salaam.' }, accessibility: { en: 'Step-free access to the start line', sw: 'Njia bila ngazi hadi mwanzo' } } });
  assert.equal(saved.error, undefined, JSON.stringify(saved));
  const upd = await db('OutboxEvent').where({ eventId: f.event.id, type: 'event.updated' });
  assert.equal(upd.length, 1);
  assert.deepEqual(upd[0].payload.changedFields.sort(), ['accessibility.en', 'accessibility.sw', 'description.en', 'description.sw']);
  assert.ok(!/Step-free|road race/.test(JSON.stringify(upd[0].payload)), 'paths only, never values');
  assert.equal(upd[0].payload.material, false);
  const admin = h.claimsOf(await h.user({ userType: 'admin' }), 'admin');
  const cancelled = await eventsAdminService.cancel({ eventId: f.event.id, body: { reason: 'weather', refundPaidOrders: false }, actorId: admin.sub });
  assert.equal(cancelled.error, undefined, JSON.stringify(cancelled));
  const can = await db('OutboxEvent').where({ eventId: f.event.id, type: 'event.cancelled' });
  assert.equal(can.length, 1);
  assert.deepEqual([can[0].payload.reasonCode, can[0].organizerId], ['weather', f.organizer.id]);
});
