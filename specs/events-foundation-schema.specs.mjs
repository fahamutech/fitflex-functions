// Marathon & running events · S1 — the seven foundation migrations against the CI database: each one
// goes up, down and up again; the CHECKs refuse bad statuses and broken money; the widened
// OrgMembership / PartnerKycCase CHECKs accept the new values; the reward ledger is append-only.
//
// Every data test runs inside a transaction that is rolled back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';

const require = createRequire(import.meta.url);
const MIGRATIONS = [
  '20270110090000-events-organizers.cjs',
  '20270110090100-events-core.cjs',
  '20270110090200-events-orders.cjs',
  '20270110090300-events-payments.cjs',
  '20270110090400-events-tickets-ops.cjs',
  '20270110090500-events-rewards.cjs',
  '20270110090600-integration-platform.cjs',
  // S2 builds on the organizer and event tables (FKs from OrgMembership / Invitation / EventFavourite), so
  // its two migrations are part of the same up/down set.
  '20270110090700-events-organizer-identity.cjs',
  '20270110090800-events-document-fields.cjs',
  // S3: registration fields (additive; its EventOrder.teamId → EventTeam FK must come down before events-orders).
  '20270110090900-events-registration-fields.cjs',
  // S4: payments, tickets and event refunds (additive columns / indexes on EventPayment, EventOrder, EventRegistration, EventTicket,
  // EventInventoryMovement and Refund; it must come down BEFORE the tables it widens).
  '20270110091100-events-payments-tickets.cjs',
  // S5: venue operations / payout schedule and the API + webhook columns. Down FAILS CLOSED on data; the suite's tables hold none at this point.
  '20270126090000-events-ops-s5.cjs',
  '20270126090100-events-integrations-s5.cjs',
  // S6: results, rewards and medal artwork (they reference ApiClient, EventRegistration and the S1 reward tables, so they come down first).
  '20270129090000-events-results-s6.cjs',
  '20270129090100-events-rewards-s6.cjs',
  '20270129090200-events-medal-art-s6.cjs',
].map(file => ({ file, ...require(`../db/migrations/${file}`) }));

const ROLLBACK = Symbol('rollback');
const uid = p => `${p}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

async function inRollback(fn) {
  try {
    await db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

/** Expect a Postgres error inside a savepoint, so the outer transaction survives. */
async function rejects(trx, fn, ...codes) {
  await assert.rejects(trx.transaction(fn), err => codes.includes(err.code), `expected Postgres error ${codes.join(' or ')}`);
}

const TABLES = [
  'EventOrganizer', 'EventOrganizerStaff', 'Event', 'EventCategory', 'EventTicketType', 'EventCollectionPoint', 'EventChangeLog',
  'EventOrder', 'EventOrderLine', 'EventRegistration', 'EventTeam', 'EventTeamMember', 'EventInventoryMovement',
  'EventPayment', 'EventTicket', 'EventKitCollection', 'EventBibAssignment', 'EventResult', 'EventActivityLink',
  'EventMedalTemplate', 'EventMedalAward', 'AchievementDefinition', 'UserAchievement', 'RewardDefinition', 'RewardLedgerEntry', 'RewardRedemption',
  'ApiClient', 'OutboxEvent', 'WebhookEndpoint', 'WebhookDelivery', 'OrganizerIdempotency', 'ApiClientUsageDay', 'WebhookDeliveryAttempt',
];

test('each foundation migration goes up, down and up again (newest first on the way down)', async () => {
  // The suite's database already has every migration applied: take the whole set down, then exercise each.
  for (const m of [...MIGRATIONS].reverse()) await m.down(db);
  for (const t of TABLES) assert.equal(await db.schema.hasTable(t), false, `${t} dropped`);
  assert.equal(await db.schema.hasColumn('PaymentRequest', 'eventOrderId'), false, 'PaymentRequest.eventOrderId dropped');
  for (const m of MIGRATIONS) {
    await m.up(db);
    await m.down(db);
    await m.up(db);
  }
  for (const t of TABLES) assert.equal(await db.schema.hasTable(t), true, `${t} present`);
  assert.equal(await db.schema.hasColumn('PaymentRequest', 'eventOrderId'), true);
  // Down restored the two widened CHECKs on the way, and up widened them again.
  const defs = Object.fromEntries((await db.raw(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conname IN ('org_membership_org_type_check', 'partner_kyc_case_type_chk')`)).rows.map(r => [r.conname, r.def]));
  assert.match(defs.org_membership_org_type_check, /'organizer'/);
  assert.match(defs.partner_kyc_case_type_chk, /'event_organizer'/);
});

test('rolling the organizer migration back restores the old CHECKs and refuses while a new value is in use', async () => {
  // The later migrations depend on EventOrganizer, so they come down first (as knex rollback would do).
  const [organizers, ...later] = MIGRATIONS;
  for (const m of [...later].reverse()) await m.down(db);
  await organizers.down(db);
  const defs = async () => Object.fromEntries((await db.raw(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conname IN ('org_membership_org_type_check', 'partner_kyc_case_type_chk')`)).rows.map(r => [r.conname, r.def]));
  const before = await defs();
  assert.doesNotMatch(before.partner_kyc_case_type_chk, /event_organizer/);
  assert.doesNotMatch(before.org_membership_org_type_check, /organizer/);
  assert.match(before.org_membership_org_type_check, /'gym'.*'vendor'/);
  await organizers.up(db);
  try {
    await inRollback(async (trx) => {
      const userId = uid('usr');
      await trx('User').insert({ id: userId, userType: 'member', displayName: 'Organizer owner', updatedAt: new Date() });
      await trx('PartnerKycCase').insert({ id: uid('kyc'), partnerType: 'event_organizer', userId, status: 'draft', tier: 0, updatedAt: new Date() });
      await assert.rejects(organizers.down(trx), /event_organizer/);
    });
  } finally {
    // Whatever happened above, the rest of the suite needs the whole schema back.
    for (const m of later) await m.up(db);
  }
  for (const t of TABLES) assert.equal(await db.schema.hasTable(t), true, `${t} present again`);
  const after = await defs();
  assert.match(after.partner_kyc_case_type_chk, /event_organizer/);
  assert.match(after.org_membership_org_type_check, /'organizer'/);
});

async function fixture(trx) {
  const userId = uid('usr');
  await trx('User').insert({ id: userId, userType: 'member', displayName: 'Schema runner', updatedAt: new Date() });
  const organizerId = uid('evo');
  await trx('EventOrganizer').insert({ id: organizerId, ownerUserId: userId, name: 'Dar Runners', status: 'active' });
  const eventId = uid('evt');
  await trx('Event').insert({
    id: eventId, organizerId, slug: `dar-half-${eventId.slice(-6)}`, title: 'Dar Half', eventType: 'road', status: 'published',
    startsAt: new Date('2027-03-06T04:00:00Z'), endsAt: new Date('2027-03-06T10:00:00Z'), publishedAt: new Date(),
  });
  const categoryId = uid('evc');
  await trx('EventCategory').insert({ id: categoryId, eventId, name: '21K', distanceMeters: 21097 });
  const ticketTypeId = uid('ett');
  await trx('EventTicketType').insert({ id: ticketTypeId, eventId, categoryId, name: 'Early bird', priceTzs: 30000, capacity: 10 });
  return { userId, organizerId, eventId, categoryId, ticketTypeId };
}

test('organizer and event CHECKs: statuses, slug, window, version, reasons', () => inRollback(async (trx) => {
  const f = await fixture(trx);
  await rejects(trx, t => t('EventOrganizer').insert({ id: uid('evo'), ownerUserId: f.userId, name: 'X', status: 'approved' }), '23514');
  await rejects(trx, t => t('EventOrganizer').insert({ id: uid('evo'), ownerUserId: f.userId, name: 'X', status: 'rejected' }), '23514'); // no reason
  await rejects(trx, t => t('EventOrganizer').insert({ id: uid('evo'), ownerUserId: f.userId, name: 'X', commissionPct: 101 }), '23514');
  await rejects(trx, t => t('EventOrganizerStaff').insert({ id: uid('eos'), organizerId: f.organizerId, userId: f.userId, role: 'boss' }), '23514');
  await trx('EventOrganizerStaff').insert({ id: uid('eos'), organizerId: f.organizerId, userId: f.userId, role: 'ops' });
  await rejects(trx, t => t('EventOrganizerStaff').insert({ id: uid('eos'), organizerId: f.organizerId, userId: f.userId, role: 'finance' }), '23505'); // one active per user
  const base = { organizerId: f.organizerId, title: 'T', eventType: 'road', startsAt: new Date('2027-01-01T00:00:00Z'), endsAt: new Date('2027-01-02T00:00:00Z') };
  await rejects(trx, t => t('Event').insert({ ...base, id: uid('evt'), slug: 'ok-slug-1', status: 'live' }), '23514');
  await rejects(trx, t => t('Event').insert({ ...base, id: uid('evt'), slug: 'Bad Slug' }), '23514');
  await rejects(trx, t => t('Event').insert({ ...base, id: uid('evt'), slug: 'ok-slug-2', eventType: 'swim' }), '23514');
  await rejects(trx, t => t('Event').insert({ ...base, id: uid('evt'), slug: 'ok-slug-3', endsAt: new Date('2026-12-31T00:00:00Z') }), '23514');
  await rejects(trx, t => t('Event').insert({ ...base, id: uid('evt'), slug: 'ok-slug-4', version: 0 }), '23514');
  await rejects(trx, t => t('Event').insert({ ...base, id: uid('evt'), slug: 'ok-slug-5', status: 'published' }), '23514'); // no publishedAt
  await rejects(trx, t => t('Event').insert({ ...base, id: uid('evt'), slug: 'ok-slug-6', status: 'cancelled' }), '23514'); // no cancelledAt
  await trx('Event').insert({ ...base, id: uid('evt'), slug: 'ok-slug-7' });
  await rejects(trx, t => t('Event').insert({ ...base, id: uid('evt'), slug: 'ok-slug-7' }), '23505');
}));

test('ticket type CHECKs: inventory, price, per-order limits, and the composite category FK', () => inRollback(async (trx) => {
  const f = await fixture(trx);
  const tt = extra => ({ id: uid('ett'), eventId: f.eventId, categoryId: f.categoryId, name: 'T', priceTzs: 1000, capacity: 5, ...extra });
  await rejects(trx, t => t('EventTicketType').insert(tt({ sold: 3, held: 3 })), '23514');
  await rejects(trx, t => t('EventTicketType').insert(tt({ held: -1 })), '23514');
  await rejects(trx, t => t('EventTicketType').insert(tt({ priceTzs: -1 })), '23514');
  await rejects(trx, t => t('EventTicketType').insert(tt({ minPerOrder: 3, maxPerOrder: 2 })), '23514');
  await rejects(trx, t => t('EventTicketType').insert(tt({ status: 'sold_out' })), '23514');
  await rejects(trx, t => t('EventTicketType').insert(tt({ currency: 'tzs' })), '23514');
  // A category of another event cannot be used.
  const other = await fixture(trx);
  await rejects(trx, t => t('EventTicketType').insert(tt({ categoryId: other.categoryId })), '23503');
  await trx('EventTicketType').insert(tt({ sold: 2, held: 3 }));
  await rejects(trx, t => t('EventTicketType').where({ id: f.ticketTypeId }).update({ held: 11 }), '23514');
}));

async function orderFixture(trx) {
  const f = await fixture(trx);
  const orderId = uid('eor');
  await trx('EventOrder').insert({ id: orderId, eventId: f.eventId, purchaserUserId: f.userId, status: 'awaiting_payment', subtotalTzs: 30000, totalTzs: 30000, holdExpiresAt: new Date(), holdCycle: 1, reference: `EV-${orderId.slice(-10).toUpperCase()}` });
  const lineId = uid('eol');
  await trx('EventOrderLine').insert({ id: lineId, orderId, eventId: f.eventId, ticketTypeId: f.ticketTypeId, quantity: 1, unitPriceTzs: 30000, lineTotalTzs: 30000 });
  const reg = extra => ({
    id: uid('erg'), eventId: f.eventId, categoryId: f.categoryId, ticketTypeId: f.ticketTypeId, orderId, orderLineId: lineId,
    purchaserUserId: f.userId, firstName: 'Asha', lastName: 'Juma', consentBasis: 'self', status: 'reserved', ...extra,
  });
  return { ...f, orderId, lineId, reg };
}

test('order, line, registration and movement CHECKs: statuses, money arithmetic, idempotency shape, tenancy', () => inRollback(async (trx) => {
  const f = await orderFixture(trx);
  const order = extra => ({ id: uid('eor'), eventId: f.eventId, status: 'draft', subtotalTzs: 1000, totalTzs: 1000, reference: uid('EV'), ...extra });
  await rejects(trx, t => t('EventOrder').insert(order({ status: 'paid' })), '23514');
  await rejects(trx, t => t('EventOrder').insert(order({ totalTzs: 900 })), '23514');                       // subtotal − discount + fees ≠ total
  await rejects(trx, t => t('EventOrder').insert(order({ discountTzs: 100 })), '23514');
  await trx('EventOrder').insert(order({ discountTzs: 100, feesTzs: 50, totalTzs: 950 }));
  await rejects(trx, t => t('EventOrder').insert(order({ status: 'awaiting_payment' })), '23514');          // no holdExpiresAt
  await rejects(trx, t => t('EventOrder').insert(order({ idempotencyKey: 'short' })), '23514');
  await rejects(trx, t => t('EventOrder').insert(order({ idempotencyKey: 'long-enough-key' })), '23514');   // no fingerprint
  await trx('EventOrder').insert(order({ purchaserUserId: f.userId, idempotencyKey: 'long-enough-key', idempotencyFingerprint: 'fp' }));
  await rejects(trx, t => t('EventOrder').insert(order({ purchaserUserId: f.userId, idempotencyKey: 'long-enough-key', idempotencyFingerprint: 'fp2' })), '23505');
  await rejects(trx, t => t('EventOrderLine').insert({ id: uid('eol'), orderId: f.orderId, eventId: f.eventId, ticketTypeId: f.ticketTypeId, quantity: 0, unitPriceTzs: 1, lineTotalTzs: 0 }), '23514');
  await rejects(trx, t => t('EventOrderLine').insert({ id: uid('eol'), orderId: f.orderId, eventId: f.eventId, ticketTypeId: f.ticketTypeId, quantity: 2, unitPriceTzs: 100, lineTotalTzs: 150 }), '23514');
  // A line / registration cannot point at a ticket type of another event.
  const other = await fixture(trx);
  await rejects(trx, t => t('EventOrderLine').insert({ id: uid('eol'), orderId: f.orderId, eventId: f.eventId, ticketTypeId: other.ticketTypeId, quantity: 1, unitPriceTzs: 1, lineTotalTzs: 1 }), '23503');
  await rejects(trx, t => t('EventRegistration').insert(f.reg({ ticketTypeId: other.ticketTypeId })), '23503');
  await rejects(trx, t => t('EventRegistration').insert(f.reg({ status: 'paid' })), '23514');
  await rejects(trx, t => t('EventRegistration').insert(f.reg({ consentBasis: 'parent' })), '23514');
  await rejects(trx, t => t('EventRegistration').insert(f.reg({ kitStatus: 'lost' })), '23514');
  await rejects(trx, t => t('EventRegistration').insert(f.reg({ resultStatus: 'won' })), '23514');
  await rejects(trx, t => t('EventRegistration').insert(f.reg({ firstName: '' })), '23514');
  await rejects(trx, t => t('EventRegistration').insert(f.reg({ claimedAt: new Date() })), '23514');        // claimed needs a participant
  await trx('EventRegistration').insert(f.reg({ claimTokenHash: 'h1' }));
  await rejects(trx, t => t('EventRegistration').insert(f.reg({ claimTokenHash: 'h1' })), '23505');
  const mv = extra => ({ id: uid('eim'), ticketTypeId: f.ticketTypeId, orderId: f.orderId, kind: 'hold', quantity: 1, cycle: 1, movementKey: `${f.orderId}:1:hold:${f.ticketTypeId}`, ...extra });
  await trx('EventInventoryMovement').insert(mv());
  await rejects(trx, t => t('EventInventoryMovement').insert(mv({ id: uid('eim') })), '23505');              // movementKey unique
  await rejects(trx, t => t('EventInventoryMovement').insert(mv({ id: uid('eim'), movementKey: 'k2', kind: 'sell' })), '23514');
  await rejects(trx, t => t('EventInventoryMovement').insert(mv({ id: uid('eim'), movementKey: 'k3', quantity: 0 })), '23514');
  await rejects(trx, t => t('EventInventoryMovement').insert(mv({ id: uid('eim'), movementKey: 'k4', cycle: 0 })), '23514');
  // The ledger is append-only (review #242).
  await rejects(trx, t => t('EventInventoryMovement').where({ movementKey: `${f.orderId}:1:hold:${f.ticketTypeId}` }).update({ quantity: 2 }), 'P0001');
  await rejects(trx, t => t('EventInventoryMovement').where({ movementKey: `${f.orderId}:1:hold:${f.ticketTypeId}` }).del(), 'P0001');
  await rejects(trx, t => t.raw('TRUNCATE "EventInventoryMovement"'), 'P0001');
  // Guest / corporate idempotency scopes (review #242).
  await trx('EventOrder').insert(order({ idempotencyKey: 'guest-key-0001', idempotencyFingerprint: 'fp' }));
  await rejects(trx, t => t('EventOrder').insert(order({ idempotencyKey: 'guest-key-0001', idempotencyFingerprint: 'fp' })), '23505');   // same event, no purchaser
  await trx('EventOrder').insert(order({ purchaserUserId: f.userId, idempotencyKey: 'guest-key-0001', idempotencyFingerprint: 'fp' }));  // a purchaser's own scope
  const orgId = uid('b2bo');
  await trx('B2BOrganization').insert({ id: orgId, organizationType: 'employer', legalName: 'Guest Corp' });
  await trx('EventOrder').insert(order({ organizationId: orgId, idempotencyKey: 'guest-key-0001', idempotencyFingerprint: 'fp' }));      // the organisation's scope
  await rejects(trx, t => t('EventOrder').insert(order({ organizationId: orgId, idempotencyKey: 'guest-key-0001', idempotencyFingerprint: 'fp' })), '23505');
}));

test('registration history is never cascaded away: kit, bibs, results, medals, team membership RESTRICT; endpoints and audited events too (review #242)', () => inRollback(async (trx) => {
  const f = await orderFixture(trx);
  const [reg] = await trx('EventRegistration').insert(f.reg({ status: 'confirmed' })).returning('id');
  const registrationId = reg.id;
  await trx('EventKitCollection').insert({ id: uid('ekc'), registrationId, eventId: f.eventId, status: 'collected' });
  await trx('EventBibAssignment').insert({ id: uid('ebb'), eventId: f.eventId, categoryId: f.categoryId, registrationId, bibNumber: '7' });
  await trx('EventResult').insert({ id: uid('ers'), registrationId, sourceType: 'organizer_verified', finishStatus: 'dnf' });
  const [tpl] = await trx('EventMedalTemplate').insert({ id: uid('emt'), eventId: f.eventId, name: JSON.stringify({ en: 'Finisher', sw: 'Mmalizaji' }) }).returning('id');
  await trx('EventMedalAward').insert({ id: uid('ema'), registrationId, eventId: f.eventId, medalTemplateId: tpl.id });
  const [team] = await trx('EventTeam').insert({ id: uid('etm'), eventId: f.eventId, name: 'Team A', teamType: 'club', captainRegistrationId: registrationId }).returning('id');
  await trx('EventTeamMember').insert({ id: uid('etmm'), teamId: team.id, eventId: f.eventId, registrationId, role: 'captain' });
  await rejects(trx, t => t('EventRegistration').where({ id: registrationId }).del(), '23503', '23001');
  await rejects(trx, t => t('EventMedalTemplate').where({ id: tpl.id }).del(), '23503', '23001');
  await trx('EventChangeLog').insert({ id: uid('ecl'), eventId: f.eventId, field: 'title', before: JSON.stringify('a'), after: JSON.stringify('b') });
  await rejects(trx, t => t('Event').where({ id: f.eventId }).del(), '23503', '23001');
  const [ep] = await trx('WebhookEndpoint').insert({ id: uid('whe'), organizerId: f.organizerId, url: 'https://hooks.example.org/x', secretHash: 'h' }).returning('id');
  const [ob] = await trx('OutboxEvent').insert({ id: uid('obx'), type: 'registration.created', aggregateType: 'registration', aggregateId: registrationId }).returning('id');
  await trx('WebhookDelivery').insert({ id: uid('whd'), endpointId: ep.id, outboxEventId: ob.id });
  await rejects(trx, t => t('WebhookEndpoint').where({ id: ep.id }).del(), '23503', '23001');
  // An activity link survives its activity (SET NULL), keeping the evidence row.
  const activityId = uid('act');
  await trx('Activity').insert({ id: activityId, userId: f.userId, type: 'running', source: 'fitflex', startedAt: new Date() });
  const [link] = await trx('EventActivityLink').insert({ id: uid('eal'), registrationId, activityId, clientRef: 'client-ref-0002' }).returning('id');
  await trx('Activity').where({ id: activityId }).del();
  const kept = await trx('EventActivityLink').where({ id: link.id }).first();
  assert.equal(kept.activityId, null);
  assert.equal(kept.clientRef, 'client-ref-0002');
}));

test('tenancy fences: a kit collection, bib, medal, team member or collection point of another event is refused (review #242)', () => inRollback(async (trx) => {
  const f = await orderFixture(trx);
  const other = await orderFixture(trx);
  const [reg] = await trx('EventRegistration').insert(f.reg({ status: 'confirmed' })).returning('id');
  const [foreignReg] = await trx('EventRegistration').insert(other.reg({ status: 'confirmed' })).returning('id');
  const [point] = await trx('EventCollectionPoint').insert({ id: uid('ecp'), eventId: other.eventId, name: 'Expo' }).returning('id');
  await rejects(trx, t => t('EventKitCollection').insert({ id: uid('ekc'), registrationId: reg.id, eventId: other.eventId, status: 'collected' }), '23503');
  await rejects(trx, t => t('EventKitCollection').insert({ id: uid('ekc'), registrationId: reg.id, eventId: f.eventId, collectionPointId: point.id, status: 'collected' }), '23503');
  await rejects(trx, t => t('EventBibAssignment').insert({ id: uid('ebb'), eventId: f.eventId, categoryId: f.categoryId, registrationId: foreignReg.id, bibNumber: '9' }), '23503');
  // A registration's bib must be in the registration's own category.
  const [cat2] = await trx('EventCategory').insert({ id: uid('evc'), eventId: f.eventId, name: '5K', distanceMeters: 5000 }).returning('id');
  await rejects(trx, t => t('EventBibAssignment').insert({ id: uid('ebb'), eventId: f.eventId, categoryId: cat2.id, registrationId: reg.id, bibNumber: '9' }), '23503');
  await rejects(trx, t => t('EventMedalTemplate').insert({ id: uid('emt'), eventId: f.eventId, categoryId: other.categoryId }), '23503');
  const [tpl] = await trx('EventMedalTemplate').insert({ id: uid('emt'), eventId: other.eventId }).returning('id');
  await rejects(trx, t => t('EventMedalAward').insert({ id: uid('ema'), registrationId: reg.id, eventId: f.eventId, medalTemplateId: tpl.id }), '23503');
  await rejects(trx, t => t('EventTeam').insert({ id: uid('etm'), eventId: f.eventId, name: 'T', teamType: 'club', captainRegistrationId: foreignReg.id }), '23503');
  const [team] = await trx('EventTeam').insert({ id: uid('etm'), eventId: f.eventId, name: 'T', teamType: 'club' }).returning('id');
  await rejects(trx, t => t('EventTeamMember').insert({ id: uid('etmm'), teamId: team.id, eventId: f.eventId, registrationId: foreignReg.id }), '23503');
  await rejects(trx, t => t('EventTeamMember').insert({ id: uid('etmm'), teamId: team.id, eventId: other.eventId, registrationId: foreignReg.id }), '23503');
  await trx('EventTeamMember').insert({ id: uid('etmm'), teamId: team.id, eventId: f.eventId, registrationId: reg.id });
}));

test('rolling back over data fails closed: orders, payments, ledger entries and event payment requests block their down (review #242)', async () => {
  const [, , orders, payments, , rewards] = MIGRATIONS;
  await inRollback(async (trx) => {
    const f = await orderFixture(trx);
    await assert.rejects(orders.down(trx), /1 EventOrder row/);
    await trx('EventPayment').insert({ id: uid('epy'), orderId: f.orderId, provider: 'manual', merchantReference: uid('MR'), amountTzs: 1 });
    await assert.rejects(payments.down(trx), /EventPayment row/);
  });
  await inRollback(async (trx) => {
    const f = await orderFixture(trx);
    await trx('PaymentRequest').insert({ id: uid('pay'), memberId: f.userId, tier: 'event', amountTzs: 1, status: 'pending', provider: 'manual', eventOrderId: f.orderId });
    await assert.rejects(payments.down(trx), /PaymentRequest row/);
    await trx('RewardLedgerEntry').insert({ id: uid('rle'), userId: f.userId, entryType: 'earn', points: 1, sourceType: 'test', idempotencyKey: uid('idem'), occurredAt: new Date() });
    await assert.rejects(rewards.down(trx), /RewardLedgerEntry row/);
  });
  for (const t of TABLES) assert.equal(await db.schema.hasTable(t), true, `${t} still present`);
  assert.equal(await db.schema.hasColumn('PaymentRequest', 'eventOrderId'), true);
});

test('payment CHECKs and PaymentRequest.eventOrderId', () => inRollback(async (trx) => {
  const f = await orderFixture(trx);
  // S4: one live attempt per order (eventpayment_one_live_per_order), so these rows are earlier, failed attempts.
  const pay = extra => ({ id: uid('epy'), orderId: f.orderId, provider: 'manual', merchantReference: uid('MR'), amountTzs: 30000, status: 'failed', ...extra });
  await rejects(trx, t => t('EventPayment').insert(pay({ status: 'paid' })), '23514');
  await rejects(trx, t => t('EventPayment').insert(pay({ status: 'succeeded' })), '23514');                 // succeeded needs verifiedAt
  await rejects(trx, t => t('EventPayment').insert(pay({ amountTzs: -1 })), '23514');
  await trx('EventPayment').insert(pay({ providerTransactionId: 'TX1' }));
  await rejects(trx, t => t('EventPayment').insert(pay({ providerTransactionId: 'TX1' })), '23505');       // one row per provider transaction
  await trx('EventPayment').insert(pay({ provider: 'tunzaa', providerTransactionId: 'TX1' }));              // another provider may reuse the id
  const mr = uid('MR');
  await trx('EventPayment').insert(pay({ merchantReference: mr }));
  await rejects(trx, t => t('EventPayment').insert(pay({ merchantReference: mr })), '23505');
  // S4: a second live attempt and a second success for one order are refused by the database.
  await trx('EventPayment').insert(pay({ status: 'pending' }));
  await rejects(trx, t => t('EventPayment').insert(pay({ status: 'created' })), '23505');
  await rejects(trx, t => t('EventPayment').insert(pay({ status: 'reconciliation_required' })), '23505');
  await trx('EventPayment').where({ orderId: f.orderId, status: 'pending' }).update({ status: 'succeeded', verifiedAt: new Date() });
  await rejects(trx, t => t('EventPayment').insert(pay({ status: 'succeeded', verifiedAt: new Date() })), '23505');
  await trx('PaymentRequest').insert({ id: uid('pay'), memberId: f.userId, tier: 'event', amountTzs: 30000, status: 'pending', provider: 'manual', eventOrderId: f.orderId });
  await rejects(trx, t => t('PaymentRequest').insert({ id: uid('pay'), memberId: f.userId, tier: 'event', amountTzs: 1, status: 'pending', provider: 'manual', eventOrderId: 'eor_missing' }), '23503');
}));

test('ticket, kit, bib, result and activity-link CHECKs and partial uniques', () => inRollback(async (trx) => {
  const f = await orderFixture(trx);
  const [reg] = await trx('EventRegistration').insert(f.reg({ status: 'confirmed' })).returning('id');
  const registrationId = reg.id;
  const tk = extra => ({ id: uid('etk'), registrationId, tokenHash: uid('th'), status: 'active', issuedAt: new Date(), ...extra });
  await rejects(trx, t => t('EventTicket').insert(tk({ status: 'valid' })), '23514');
  await rejects(trx, t => t('EventTicket').insert(tk({ issuedAt: null })), '23514');
  await rejects(trx, t => t('EventTicket').insert(tk({ status: 'revoked' })), '23514');                     // revoked needs revokedAt
  await trx('EventTicket').insert(tk());
  await rejects(trx, t => t('EventTicket').insert(tk()), '23505');                                           // one active ticket
  await trx('EventTicket').insert(tk({ status: 'revoked', revokedAt: new Date() }));
  const kit = extra => ({ id: uid('ekc'), registrationId, eventId: f.eventId, status: 'collected', ...extra });
  await rejects(trx, t => t('EventKitCollection').insert(kit({ status: 'handed' })), '23514');
  await rejects(trx, t => t('EventKitCollection').insert(kit({ status: 'corrected' })), '23514');           // needs reason + supersedes
  const [first] = await trx('EventKitCollection').insert(kit()).returning('id');
  await rejects(trx, t => t('EventKitCollection').insert(kit()), '23505');                                   // collected once
  await trx('EventKitCollection').insert(kit({ status: 'corrected', correctionReason: 'wrong size', supersedesId: first.id }));
  const bib = extra => ({ id: uid('ebb'), eventId: f.eventId, categoryId: f.categoryId, registrationId, bibNumber: '101', ...extra });
  await trx('EventBibAssignment').insert(bib());
  await rejects(trx, t => t('EventBibAssignment').insert(bib({ id: uid('ebb') })), '23505');                 // one live bib per registration
  const [reg2] = await trx('EventRegistration').insert(f.reg({ status: 'confirmed' })).returning('id');
  await rejects(trx, t => t('EventBibAssignment').insert(bib({ registrationId: reg2.id })), '23505');        // bib 101 live already
  await trx('EventBibAssignment').insert(bib({ registrationId: reg2.id, bibNumber: '102' }));
  await trx('EventBibAssignment').insert(bib({ registrationId: reg2.id, bibNumber: '103', releasedAt: new Date() })); // history is fine
  const other = await fixture(trx);
  const [reg3] = await trx('EventRegistration').insert(f.reg({ status: 'confirmed' })).returning('id');
  await rejects(trx, t => t('EventBibAssignment').insert(bib({ registrationId: reg3.id, bibNumber: '104', categoryId: other.categoryId })), '23503'); // another event's category
  const res = extra => ({ id: uid('ers'), registrationId, sourceType: 'timing_provider', finishStatus: 'finished', elapsedMs: 5400000, ...extra });
  await rejects(trx, t => t('EventResult').insert(res({ sourceType: 'guess' })), '23514');
  await rejects(trx, t => t('EventResult').insert(res({ finishStatus: 'finished', elapsedMs: null })), '23514');
  await rejects(trx, t => t('EventResult').insert(res({ verificationStatus: 'verified' })), '23514');       // verified needs who + when
  await rejects(trx, t => t('EventResult').insert(res({ overallRank: 0 })), '23514');
  await trx('EventResult').insert(res());
  await rejects(trx, t => t('EventResult').insert(res({ revision: 2 })), '23505');                           // one current result
  await trx('EventResult').insert(res({ revision: 2, isCurrent: false }));
  const activityId = uid('act');
  await trx('Activity').insert({ id: activityId, userId: f.userId, type: 'running', source: 'fitflex', startedAt: new Date() });
  const link = extra => ({ id: uid('eal'), registrationId, activityId, ...extra });
  await rejects(trx, t => t('EventActivityLink').insert(link({ linkType: 'proof' })), '23514');
  await rejects(trx, t => t('EventActivityLink').insert(link({ clientRef: 'short' })), '23514');
  await trx('EventActivityLink').insert(link({ clientRef: 'client-ref-0001' }));
  await rejects(trx, t => t('EventActivityLink').insert(link()), '23505');                                   // one link per activity
}));

test('reward tables: CHECKs, unique award keys, and the append-only ledger trigger', () => inRollback(async (trx) => {
  const f = await fixture(trx);
  await rejects(trx, t => t('AchievementDefinition').insert({ id: uid('ach'), key: 'Bad Key' }), '23514');
  const [def] = await trx('AchievementDefinition').insert({ id: uid('ach'), key: 'first_half_marathon', title: JSON.stringify({ en: 'First half', sw: 'Nusu ya kwanza' }) }).returning('id');
  const ua = extra => ({ id: uid('uac'), userId: f.userId, achievementDefinitionId: def.id, sourceType: 'registration', awardKey: `k:${f.userId}:first`, ...extra });
  await trx('UserAchievement').insert(ua());
  await rejects(trx, t => t('UserAchievement').insert(ua({ id: uid('uac') })), '23505');
  await rejects(trx, t => t('UserAchievement').insert(ua({ id: uid('uac'), awardKey: 'k2', status: 'revoked' })), '23514');
  await rejects(trx, t => t('RewardDefinition').insert({ id: uid('rwd'), issuerType: 'bank', rewardType: 'voucher' }), '23514');
  await rejects(trx, t => t('RewardDefinition').insert({ id: uid('rwd'), issuerType: 'sponsor', rewardType: 'voucher' }), '23514'); // sponsor needs issuerId
  const [reward] = await trx('RewardDefinition').insert({ id: uid('rwd'), issuerType: 'fitflex', rewardType: 'points', points: 100, status: 'active' }).returning('id');
  const entry = extra => ({ id: uid('rle'), userId: f.userId, rewardDefinitionId: reward.id, entryType: 'earn', points: 100, sourceType: 'event_result', idempotencyKey: uid('idem'), occurredAt: new Date(), ...extra });
  await rejects(trx, t => t('RewardLedgerEntry').insert(entry({ entryType: 'spend' })), '23514');
  await rejects(trx, t => t('RewardLedgerEntry').insert(entry({ entryType: 'redeem', points: 10 })), '23514');  // a redeem takes points away
  await rejects(trx, t => t('RewardLedgerEntry').insert(entry({ entryType: 'reverse' })), '23514');             // a reversal names its entry
  const [earned] = await trx('RewardLedgerEntry').insert(entry()).returning('*');
  await rejects(trx, t => t('RewardLedgerEntry').insert(entry({ id: uid('rle'), idempotencyKey: earned.idempotencyKey })), '23505');
  await trx('RewardLedgerEntry').insert(entry({ entryType: 'reverse', points: -100, reversesEntryId: earned.id }));
  // Append-only: the trigger refuses UPDATE and DELETE.
  await rejects(trx, t => t('RewardLedgerEntry').where({ id: earned.id }).update({ points: 1 }), 'P0001');
  await rejects(trx, t => t('RewardLedgerEntry').where({ id: earned.id }).del(), 'P0001');
  await rejects(trx, t => t.raw('TRUNCATE "RewardLedgerEntry" CASCADE'), 'P0001');
  await rejects(trx, t => t('RewardRedemption').insert({ id: uid('rrd'), userId: f.userId, rewardDefinitionId: reward.id, codeHash: 'c1', status: 'used' }), '23514');
  await trx('RewardRedemption').insert({ id: uid('rrd'), userId: f.userId, rewardDefinitionId: reward.id, codeHash: 'c1' });
  await rejects(trx, t => t('RewardRedemption').insert({ id: uid('rrd'), userId: f.userId, rewardDefinitionId: reward.id, codeHash: 'c1' }), '23505');
  await rejects(trx, t => t('EventMedalAward').insert({ id: uid('ema'), registrationId: 'erg_none', eventId: f.eventId, medalTemplateId: 'emt_none' }), '23503');
}));

test('integration platform: API client, outbox, webhook endpoint and delivery CHECKs', () => inRollback(async (trx) => {
  const f = await fixture(trx);
  const client = extra => ({ id: uid('apc'), ownerType: 'organizer', ownerId: f.organizerId, clientId: uid('ck'), secretHash: 'h', ...extra });
  await rejects(trx, t => t('ApiClient').insert(client({ ownerType: 'vendor' })), '23514');
  await rejects(trx, t => t('ApiClient').insert(client({ status: 'paused' })), '23514');
  await rejects(trx, t => t('ApiClient').insert(client({ scopes: JSON.stringify({ a: 1 }) })), '23514');
  const [c] = await trx('ApiClient').insert(client({ scopes: JSON.stringify(['registrations:read']) })).returning('clientId');
  await rejects(trx, t => t('ApiClient').insert(client({ clientId: c.clientId })), '23505');
  await rejects(trx, t => t('OutboxEvent').insert({ id: uid('obx'), type: 'RegistrationCreated', aggregateType: 'registration', aggregateId: 'x' }), '23514');
  await trx('OutboxEvent').insert({ id: uid('obx'), type: 'registration.created', aggregateType: 'registration', aggregateId: 'x', organizerId: f.organizerId });
  const ep = extra => ({ id: uid('whe'), organizerId: f.organizerId, url: 'https://hooks.example.org/fitflex', secretHash: 'h', ...extra });
  await rejects(trx, t => t('WebhookEndpoint').insert(ep({ url: 'http://hooks.example.org' })), '23514');
  await rejects(trx, t => t('WebhookEndpoint').insert(ep({ status: 'paused' })), '23514');
  const [endpoint] = await trx('WebhookEndpoint').insert(ep()).returning('id');
  const [outbox] = await trx('OutboxEvent').insert({ id: uid('obx'), type: 'registration.cancelled', aggregateType: 'registration', aggregateId: 'y' }).returning('id');
  const delivery = extra => ({ id: uid('whd'), endpointId: endpoint.id, outboxEventId: outbox.id, ...extra });
  await rejects(trx, t => t('WebhookDelivery').insert(delivery({ status: 'sent' })), '23514');
  await rejects(trx, t => t('WebhookDelivery').insert(delivery({ status: 'delivered' })), '23514');          // delivered needs deliveredAt
  await trx('WebhookDelivery').insert(delivery());
  await rejects(trx, t => t('WebhookDelivery').insert(delivery({ id: uid('whd') })), '23505');               // one delivery per endpoint × event
}));
