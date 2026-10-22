// Marathon & running events · S1 (foundation) — the event catalogue.
// Design: PRD §7 (data model), §9 (ORG-006 event lifecycle); docs/marathon/reuse-map.md §5.1; D4 (money =
// integer whole TZS in *Tzs columns + currency column, default TZS — there are no minor units).
//
// - Event: one race day of one organizer. slug is the public address (unique, lower-case kebab).
//   status draft → submitted → published → registration_closed → in_progress → completed → archived,
//   with cancelled reachable from published/registration_closed/in_progress (rules in
//   src/shared/events-lifecycle.mjs). startsAt/endsAt are UTC instants; timezone is the IANA zone they are
//   shown in. termsSnapshot / refundPolicySnapshot are the texts a participant agreed to, frozen at publish
//   time. version is bumped by every organizer edit (compare-and-set in the store) and EventChangeLog
//   keeps what changed, by whom and whether it was material (a published event's material change tells
//   participants). unique (id, organizerId) lets children be fenced to the organizer later.
// - EventCategory: a distance/route within the event (5K, 21K …) with its own start time, eligibility
//   (jsonb: age, gender, licence …), optional capacity and registration cut-off, and result rules
//   (jsonb: cut-off time, chip vs gun). unique (id, eventId) is the tenancy anchor every child
//   references, so a ticket type or registration can never point at another event's category.
// - EventTicketType: what is sold for a category: priceTzs (whole shillings) and the inventory counters
//   capacity / sold / held. The CHECK sold + held <= capacity is the last line of defence for overselling;
//   the store moves the counters only with conditional UPDATEs (see 20270110090200-events-orders.cjs for
//   the hold model). saleOpensAt/saleClosesAt is the sale window; min/maxPerOrder bound one order's quantity.
// - EventCollectionPoint: where kits are collected (opening windows jsonb, instructions {en, sw}).
// - EventChangeLog: field-level audit of organizer edits (before/after jsonb, reason, material).
//
// Dormant: no route reads these tables (EVENTS_MODULE off). Down drops the five tables.

const EVENT_TYPES = ['road', 'trail', 'fun', 'charity', 'virtual'];
const EVENT_STATUSES = ['draft', 'submitted', 'published', 'registration_closed', 'in_progress', 'completed', 'cancelled', 'archived'];
const ACTIVE_INACTIVE = ['active', 'inactive'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const stamps = (t) => {
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  };

  await knex.schema.createTable('Event', (t) => {
    t.text('id').primary();
    t.text('organizerId').notNullable().references('id').inTable('EventOrganizer').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('slug').notNullable().unique();
    t.text('title').notNullable();
    t.text('description');
    t.text('eventType').notNullable();
    t.text('status').notNullable().defaultTo('draft');
    t.timestamp('startsAt', { precision: 3 }).notNullable();
    t.timestamp('endsAt', { precision: 3 }).notNullable();
    t.text('timezone').notNullable().defaultTo('Africa/Dar_es_Salaam');
    t.text('venueName');
    t.text('venueAddress');
    t.decimal('lat', 9, 6);
    t.decimal('lng', 9, 6);
    t.jsonb('routeMeta').notNullable().defaultTo('{}');
    t.jsonb('termsSnapshot');
    t.jsonb('refundPolicySnapshot');
    t.timestamp('registrationClosesAt', { precision: 3 });
    t.timestamp('publishedAt', { precision: 3 });
    t.timestamp('cancelledAt', { precision: 3 });
    t.integer('version').notNullable().defaultTo(1);
    stamps(t);
    t.unique(['id', 'organizerId']);
    t.index(['status', 'startsAt']);
    t.index(['organizerId']);
  });
  await knex.raw(`ALTER TABLE "Event"
    ADD CONSTRAINT event_type_check CHECK ("eventType" IN (${list(EVENT_TYPES)})),
    ADD CONSTRAINT event_status_check CHECK (status IN (${list(EVENT_STATUSES)})),
    ADD CONSTRAINT event_slug_format_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 80),
    ADD CONSTRAINT event_title_length_check CHECK (char_length(title) BETWEEN 1 AND 200),
    ADD CONSTRAINT event_window_check CHECK ("endsAt" >= "startsAt"),
    ADD CONSTRAINT event_version_check CHECK (version >= 1),
    ADD CONSTRAINT event_published_at_check CHECK (status IN ('draft', 'submitted') OR status = 'cancelled' OR status = 'archived' OR "publishedAt" IS NOT NULL),
    ADD CONSTRAINT event_cancelled_at_check CHECK ((status = 'cancelled') = ("cancelledAt" IS NOT NULL))`);

  await knex.schema.createTable('EventCategory', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('name').notNullable();
    t.integer('distanceMeters').notNullable();
    t.text('routeType');
    t.timestamp('startTime', { precision: 3 });
    t.jsonb('eligibility').notNullable().defaultTo('{}');
    t.integer('capacity');
    t.timestamp('registrationClosesAt', { precision: 3 });
    t.jsonb('resultRules').notNullable().defaultTo('{}');
    t.text('status').notNullable().defaultTo('active');
    stamps(t);
    t.unique(['eventId', 'name']);
    t.unique(['id', 'eventId']);
  });
  await knex.raw(`ALTER TABLE "EventCategory"
    ADD CONSTRAINT eventcategory_status_check CHECK (status IN (${list(ACTIVE_INACTIVE)})),
    ADD CONSTRAINT eventcategory_distance_check CHECK ("distanceMeters" > 0),
    ADD CONSTRAINT eventcategory_capacity_check CHECK (capacity IS NULL OR capacity >= 0),
    ADD CONSTRAINT eventcategory_name_length_check CHECK (char_length(name) BETWEEN 1 AND 120)`);

  await knex.schema.createTable('EventTicketType', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable();
    t.text('categoryId').notNullable();
    t.text('name').notNullable();
    t.integer('priceTzs').notNullable();
    t.text('currency').notNullable().defaultTo('TZS');
    t.integer('capacity').notNullable();
    t.integer('sold').notNullable().defaultTo(0);
    t.integer('held').notNullable().defaultTo(0);
    t.timestamp('saleOpensAt', { precision: 3 });
    t.timestamp('saleClosesAt', { precision: 3 });
    t.integer('minPerOrder').notNullable().defaultTo(1);
    t.integer('maxPerOrder').notNullable().defaultTo(10);
    t.text('status').notNullable().defaultTo('active');
    stamps(t);
    t.unique(['id', 'eventId']);
    t.index(['eventId', 'categoryId']);
  });
  await knex.raw(`ALTER TABLE "EventTicketType"
    ADD CONSTRAINT eventtickettype_event_fk FOREIGN KEY ("eventId") REFERENCES "Event" (id) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT eventtickettype_category_fk FOREIGN KEY ("categoryId", "eventId") REFERENCES "EventCategory" (id, "eventId") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT eventtickettype_status_check CHECK (status IN (${list(ACTIVE_INACTIVE)})),
    ADD CONSTRAINT eventtickettype_price_check CHECK ("priceTzs" >= 0),
    ADD CONSTRAINT eventtickettype_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT eventtickettype_capacity_check CHECK (capacity >= 0),
    ADD CONSTRAINT eventtickettype_inventory_check CHECK (sold >= 0 AND held >= 0 AND sold + held <= capacity),
    ADD CONSTRAINT eventtickettype_per_order_check CHECK ("minPerOrder" >= 1 AND "maxPerOrder" >= "minPerOrder"),
    ADD CONSTRAINT eventtickettype_sale_window_check CHECK ("saleOpensAt" IS NULL OR "saleClosesAt" IS NULL OR "saleClosesAt" >= "saleOpensAt"),
    ADD CONSTRAINT eventtickettype_name_length_check CHECK (char_length(name) BETWEEN 1 AND 120)`);

  await knex.schema.createTable('EventCollectionPoint', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('name').notNullable();
    t.text('address');
    t.decimal('lat', 9, 6);
    t.decimal('lng', 9, 6);
    t.jsonb('openingWindows').notNullable().defaultTo('[]');
    t.jsonb('instructions').notNullable().defaultTo('{}');
    t.text('status').notNullable().defaultTo('active');
    stamps(t);
    t.unique(['id', 'eventId']);
    t.index(['eventId']);
  });
  await knex.raw(`ALTER TABLE "EventCollectionPoint"
    ADD CONSTRAINT eventcollectionpoint_status_check CHECK (status IN (${list(ACTIVE_INACTIVE)})),
    ADD CONSTRAINT eventcollectionpoint_name_length_check CHECK (char_length(name) BETWEEN 1 AND 120)`);

  await knex.schema.createTable('EventChangeLog', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('actorUserId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('field').notNullable();
    t.jsonb('before');
    t.jsonb('after');
    t.text('reason');
    t.boolean('material').notNullable().defaultTo(false);
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.index(['eventId', 'createdAt']);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('EventChangeLog');
  await knex.schema.dropTableIfExists('EventCollectionPoint');
  await knex.schema.dropTableIfExists('EventTicketType');
  await knex.schema.dropTableIfExists('EventCategory');
  await knex.schema.dropTableIfExists('Event');
};
