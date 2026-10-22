// Marathon & running events · S1 (foundation) — orders, registrations, teams and the inventory ledger.
// Design: PRD §7, §9 (order and registration state machines, payment safety rules); reuse-map §5.1; D4
// (whole TZS integers + currency); D5 (error envelope { error, status }). Rules: src/shared/events-lifecycle.mjs,
// prices: src/shared/events-pricing.mjs, writes: src/infra/event-store-pg.mjs.
//
// THE HOLD MODEL (capacity that cannot be oversold):
//   EventTicketType carries three counters: capacity, sold, held, with CHECK sold + held <= capacity.
//   1. hold    — placing an order increments `held` by the line quantity with ONE conditional UPDATE
//                (`... SET held = held + q WHERE id = ? AND sold + held + q <= capacity`), under FOR UPDATE on
//                the ticket-type row. Zero rows updated = capacity_unavailable; nothing is written.
//   2. commit  — payment confirmed: `held` is moved to `sold` (held - q, sold + q); the order becomes
//                confirmed and its registrations confirmed.
//   3. release — the hold lapses (holdExpiresAt passed) or the order is cancelled before payment:
//                `held` is decremented; the order becomes expired or cancelled, its registrations cancelled.
//   Every counter change writes exactly one EventInventoryMovement row (kind hold | release | commit, with
//   the quantity and the order's holdCycle) in the same transaction. Its movementKey
//   `${orderId}:${cycle}:${kind}:${ticketTypeId}` is UNIQUE, so a second commit or release of the same order
//   and cycle is a no-op (the insert is ON CONFLICT DO NOTHING and the counter is only touched when the
//   movement row was new). holdCycle counts how many times the order held inventory (1 on creation; a
//   later re-hold — e.g. a payment arriving after expiry — would be cycle 2) so the ledger stays unique
//   per attempt. The ledger is the audit trail: Σ(hold) − Σ(release) − Σ(commit) per ticket type = held.
//
// - EventOrder: one checkout. purchaserUserId is null for an approved guest/corporate flow; organizationId
//   (B2BOrganization) for corporate bulk registration. Money: subtotal − discount + fees = total (CHECK),
//   all whole TZS; priceSnapshot keeps the prices the order was quoted at, so a later price change never
//   touches it. Idempotency: (purchaserUserId, idempotencyKey) is unique when a key is given;
//   idempotencyFingerprint is the hash of the request body (same key + different body → 409
//   idempotency_key_reused). holdExpiresAt is read by the eventHoldExpiry job (partial index on
//   awaiting_payment orders). reference is the short human order number shown to people.
// - EventOrderLine: one ticket type × quantity, with the unit price, discount and fees it was priced at.
//   Composite FKs (orderId, eventId) and (ticketTypeId, eventId) keep a line inside its order's event.
// - EventRegistration: one participant place, made with the order (status reserved while the hold
//   stands, confirmed with payment). participantUserId is null until claimed (claimTokenHash); the
//   participant fields are the roster as entered; consentBasis records who gave consent for them.
//   bibNumber, kitStatus and resultStatus are denormalised views of the ops tables (S5/S6); their own
//   history lives there. Composite FKs fence the registration to its order's / category's event.
// - EventTeam / EventTeamMember: club, corporate or community team of registrations (one team per
//   registration).
//
// Dormant: no route reads these tables (EVENTS_MODULE off). Down drops the six tables.

const ORDER_STATUSES = ['draft', 'awaiting_payment', 'confirmed', 'partially_cancelled', 'cancelled', 'expired', 'refund_pending', 'refunded'];
const REGISTRATION_STATUSES = ['draft', 'reserved', 'confirmed', 'cancelled', 'transferred', 'refunded', 'disqualified'];
const CONSENT_BASES = ['self', 'purchaser_authorised', 'organisation'];
const KIT_STATUSES = ['not_ready', 'ready', 'collected', 'exception'];
const RESULT_STATUSES = ['not_submitted', 'pending_verification', 'verified', 'rejected', 'corrected', 'disqualified', 'dnf', 'dns'];
const TEAM_TYPES = ['club', 'corporate', 'community'];
const TEAM_STATUSES = ['active', 'disbanded'];
const MOVEMENT_KINDS = ['hold', 'release', 'commit'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const stamps = (t) => {
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  };

  await knex.schema.createTable('EventOrder', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('purchaserUserId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('organizationId').references('id').inTable('B2BOrganization').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('status').notNullable().defaultTo('draft');
    t.text('currency').notNullable().defaultTo('TZS');
    t.integer('subtotalTzs').notNullable().defaultTo(0);
    t.integer('discountTzs').notNullable().defaultTo(0);
    t.integer('feesTzs').notNullable().defaultTo(0);
    t.integer('totalTzs').notNullable().defaultTo(0);
    t.jsonb('priceSnapshot').notNullable().defaultTo('{}');
    t.text('idempotencyKey');
    t.text('idempotencyFingerprint');
    t.timestamp('holdExpiresAt', { precision: 3 });
    t.integer('holdCycle').notNullable().defaultTo(0);
    t.text('reference').notNullable();
    t.timestamp('confirmedAt', { precision: 3 });
    t.timestamp('closedAt', { precision: 3 });
    t.text('closeReason');
    stamps(t);
    t.unique(['id', 'eventId']);
    t.unique(['reference']);
    t.index(['eventId', 'status']);
    t.index(['purchaserUserId']);
    t.index(['organizationId']);
  });
  await knex.raw(`ALTER TABLE "EventOrder"
    ADD CONSTRAINT eventorder_status_check CHECK (status IN (${list(ORDER_STATUSES)})),
    ADD CONSTRAINT eventorder_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT eventorder_money_check CHECK ("subtotalTzs" >= 0 AND "discountTzs" >= 0 AND "feesTzs" >= 0 AND "totalTzs" >= 0
      AND "totalTzs" = "subtotalTzs" - "discountTzs" + "feesTzs"),
    ADD CONSTRAINT eventorder_hold_cycle_check CHECK ("holdCycle" >= 0),
    ADD CONSTRAINT eventorder_idempotency_check CHECK ("idempotencyKey" IS NULL OR ("idempotencyFingerprint" IS NOT NULL AND char_length("idempotencyKey") BETWEEN 8 AND 100)),
    ADD CONSTRAINT eventorder_awaiting_hold_check CHECK (status <> 'awaiting_payment' OR "holdExpiresAt" IS NOT NULL)`);
  await knex.raw(`CREATE UNIQUE INDEX eventorder_purchaser_idempotency_unique ON "EventOrder" ("purchaserUserId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`);
  await knex.raw(`CREATE INDEX eventorder_hold_expiry_idx ON "EventOrder" ("holdExpiresAt") WHERE status = 'awaiting_payment'`);

  await knex.schema.createTable('EventOrderLine', (t) => {
    t.text('id').primary();
    t.text('orderId').notNullable();
    t.text('eventId').notNullable();
    t.text('ticketTypeId').notNullable();
    t.integer('quantity').notNullable();
    t.integer('unitPriceTzs').notNullable();
    t.integer('discountTzs').notNullable().defaultTo(0);
    t.integer('feesTzs').notNullable().defaultTo(0);
    t.integer('lineTotalTzs').notNullable();
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['orderId', 'ticketTypeId']);
    t.unique(['id', 'orderId']);
    t.index(['ticketTypeId']);
  });
  await knex.raw(`ALTER TABLE "EventOrderLine"
    ADD CONSTRAINT eventorderline_order_fk FOREIGN KEY ("orderId", "eventId") REFERENCES "EventOrder" (id, "eventId") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT eventorderline_ticket_type_fk FOREIGN KEY ("ticketTypeId", "eventId") REFERENCES "EventTicketType" (id, "eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT eventorderline_quantity_check CHECK (quantity > 0),
    ADD CONSTRAINT eventorderline_money_check CHECK ("unitPriceTzs" >= 0 AND "discountTzs" >= 0 AND "feesTzs" >= 0 AND "lineTotalTzs" >= 0
      AND "lineTotalTzs" = quantity * "unitPriceTzs" - "discountTzs" + "feesTzs")`);

  await knex.schema.createTable('EventRegistration', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable();
    t.text('categoryId').notNullable();
    t.text('ticketTypeId').notNullable();
    t.text('orderId').notNullable();
    t.text('orderLineId').notNullable();
    t.text('participantUserId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('purchaserUserId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('firstName').notNullable();
    t.text('lastName').notNullable();
    t.text('phone');
    t.text('email');
    t.date('dateOfBirth');
    t.text('gender');
    t.jsonb('emergencyContact');
    t.text('consentBasis').notNullable();
    t.text('status').notNullable().defaultTo('draft');
    t.text('bibNumber');
    t.text('kitStatus').notNullable().defaultTo('not_ready');
    t.text('resultStatus').notNullable().defaultTo('not_submitted');
    t.text('claimTokenHash');
    t.timestamp('claimedAt', { precision: 3 });
    t.timestamp('cancelledAt', { precision: 3 });
    t.text('cancelReason');
    stamps(t);
    t.unique(['id', 'eventId']);
    t.unique(['claimTokenHash']);
    t.index(['eventId', 'status']);
    t.index(['orderId']);
    t.index(['participantUserId']);
    t.index(['categoryId']);
  });
  await knex.raw(`ALTER TABLE "EventRegistration"
    ADD CONSTRAINT eventregistration_order_fk FOREIGN KEY ("orderId", "eventId") REFERENCES "EventOrder" (id, "eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT eventregistration_order_line_fk FOREIGN KEY ("orderLineId", "orderId") REFERENCES "EventOrderLine" (id, "orderId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT eventregistration_ticket_type_fk FOREIGN KEY ("ticketTypeId", "eventId") REFERENCES "EventTicketType" (id, "eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT eventregistration_category_fk FOREIGN KEY ("categoryId", "eventId") REFERENCES "EventCategory" (id, "eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT eventregistration_status_check CHECK (status IN (${list(REGISTRATION_STATUSES)})),
    ADD CONSTRAINT eventregistration_consent_check CHECK ("consentBasis" IN (${list(CONSENT_BASES)})),
    ADD CONSTRAINT eventregistration_kit_status_check CHECK ("kitStatus" IN (${list(KIT_STATUSES)})),
    ADD CONSTRAINT eventregistration_result_status_check CHECK ("resultStatus" IN (${list(RESULT_STATUSES)})),
    ADD CONSTRAINT eventregistration_name_check CHECK (char_length("firstName") BETWEEN 1 AND 80 AND char_length("lastName") BETWEEN 1 AND 80),
    ADD CONSTRAINT eventregistration_claimed_check CHECK ("claimedAt" IS NULL OR "participantUserId" IS NOT NULL)`);

  await knex.schema.createTable('EventTeam', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('organizationId').references('id').inTable('B2BOrganization').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('name').notNullable();
    t.text('teamType').notNullable();
    t.text('captainRegistrationId').references('id').inTable('EventRegistration').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('status').notNullable().defaultTo('active');
    stamps(t);
    t.unique(['eventId', 'name']);
    t.unique(['id', 'eventId']);
  });
  await knex.raw(`ALTER TABLE "EventTeam"
    ADD CONSTRAINT eventteam_type_check CHECK ("teamType" IN (${list(TEAM_TYPES)})),
    ADD CONSTRAINT eventteam_status_check CHECK (status IN (${list(TEAM_STATUSES)})),
    ADD CONSTRAINT eventteam_name_length_check CHECK (char_length(name) BETWEEN 1 AND 120)`);

  await knex.schema.createTable('EventTeamMember', (t) => {
    t.text('id').primary();
    t.text('teamId').notNullable().references('id').inTable('EventTeam').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('registrationId').notNullable().references('id').inTable('EventRegistration').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('role').notNullable().defaultTo('member');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['registrationId']);
    t.index(['teamId']);
  });
  await knex.raw(`ALTER TABLE "EventTeamMember"
    ADD CONSTRAINT eventteammember_role_check CHECK (role IN ('captain', 'member'))`);

  await knex.schema.createTable('EventInventoryMovement', (t) => {
    t.text('id').primary();
    t.text('ticketTypeId').notNullable().references('id').inTable('EventTicketType').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('orderId').notNullable().references('id').inTable('EventOrder').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('kind').notNullable();
    t.integer('quantity').notNullable();
    t.integer('cycle').notNullable();
    t.text('movementKey').notNullable();
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['movementKey']);
    t.index(['orderId']);
    t.index(['ticketTypeId', 'createdAt']);
  });
  await knex.raw(`ALTER TABLE "EventInventoryMovement"
    ADD CONSTRAINT eventinventorymovement_kind_check CHECK (kind IN (${list(MOVEMENT_KINDS)})),
    ADD CONSTRAINT eventinventorymovement_quantity_check CHECK (quantity > 0),
    ADD CONSTRAINT eventinventorymovement_cycle_check CHECK (cycle >= 1)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('EventInventoryMovement');
  await knex.schema.dropTableIfExists('EventTeamMember');
  await knex.schema.dropTableIfExists('EventTeam');
  await knex.schema.dropTableIfExists('EventRegistration');
  await knex.schema.dropTableIfExists('EventOrderLine');
  await knex.schema.dropTableIfExists('EventOrder');
};
