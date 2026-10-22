// Marathon & running events · S1 (foundation) — the integration platform: API clients, the transactional
// outbox, webhook endpoints and deliveries.
// Design: PRD §5.6, §8 (webhook envelope, API-012: a change and its outbox row commit together), §10;
// reuse-map §1.1 (no outbox, outbound webhooks or third-party API keys exist today); D5 (`/v1/organizer/…`
// reserved for API-key callers).
//
// - ApiClient: a credential an organizer's systems call FitFlex with. ownerType is 'organizer' only for
//   now (CHECK; a second owner kind needs a migration). clientId is public and unique; only the hash of
//   the secret is stored (the secret is shown once, S5); scopes jsonb (registrations:read, kit:write …);
//   status active | revoked; expiresAt / rotatedAt / lastUsedAt for rotation and audit.
// - OutboxEvent: a durable fact written IN THE SAME TRANSACTION as the change it describes (the store's
//   appendOutbox(trx, …)). type is the webhook event name (registration.created …), aggregateType/Id
//   what it is about, organizerId/eventId who may receive it, payload the envelope body, version the
//   payload version. publishedAt is set by the dispatcher (S5) once deliveries are fanned out; the partial
//   index finds unpublished rows.
// - WebhookEndpoint: an organizer's HTTPS URL, the hash of its signing secret, the event types it
//   subscribes to (jsonb array), active | disabled, lastSuccessAt.
// - WebhookDelivery: one endpoint × one outbox event (unique), ON DELETE RESTRICT on the endpoint
//   (endpoints are disabled, never deleted — the delivery log is history; review #242), pending → delivered | failed → dead after
//   retries; attemptCount, nextAttemptAt (backoff), responseCode, lastError. The dispatcher claims rows by
//   (status, nextAttemptAt) with SKIP LOCKED (S5).
//
// Dormant: no route reads these tables and nothing dispatches (EVENTS_MODULE off). Down drops the four.

const OWNER_TYPES = ['organizer'];
const CLIENT_STATUSES = ['active', 'revoked'];
const ENDPOINT_STATUSES = ['active', 'disabled'];
const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const stamps = (t) => {
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  };

  await knex.schema.createTable('ApiClient', (t) => {
    t.text('id').primary();
    t.text('ownerType').notNullable();
    t.text('ownerId').notNullable();
    t.text('clientId').notNullable();
    t.text('secretHash').notNullable();
    t.jsonb('scopes').notNullable().defaultTo('[]');
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('expiresAt', { precision: 3 });
    t.timestamp('rotatedAt', { precision: 3 });
    t.timestamp('lastUsedAt', { precision: 3 });
    t.timestamp('revokedAt', { precision: 3 });
    stamps(t);
    t.unique(['clientId']);
    t.index(['ownerType', 'ownerId', 'status']);
  });
  await knex.raw(`ALTER TABLE "ApiClient"
    ADD CONSTRAINT apiclient_owner_type_check CHECK ("ownerType" IN (${list(OWNER_TYPES)})),
    ADD CONSTRAINT apiclient_status_check CHECK (status IN (${list(CLIENT_STATUSES)})),
    ADD CONSTRAINT apiclient_revoked_check CHECK ((status = 'revoked') = ("revokedAt" IS NOT NULL)),
    ADD CONSTRAINT apiclient_scopes_array_check CHECK (jsonb_typeof(scopes) = 'array')`);

  await knex.schema.createTable('OutboxEvent', (t) => {
    t.text('id').primary();
    t.text('type').notNullable();
    t.text('aggregateType').notNullable();
    t.text('aggregateId').notNullable();
    t.text('organizerId');
    t.text('eventId');
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.text('version').notNullable().defaultTo('1');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('publishedAt', { precision: 3 });
    t.index(['aggregateType', 'aggregateId']);
    t.index(['organizerId', 'createdAt']);
  });
  await knex.raw(`ALTER TABLE "OutboxEvent"
    ADD CONSTRAINT outboxevent_type_format_check CHECK (type ~ '^[a-z_]+(\\.[a-z_]+)+$')`);
  await knex.raw(`CREATE INDEX outboxevent_unpublished_idx ON "OutboxEvent" ("createdAt") WHERE "publishedAt" IS NULL`);

  await knex.schema.createTable('WebhookEndpoint', (t) => {
    t.text('id').primary();
    t.text('organizerId').notNullable().references('id').inTable('EventOrganizer').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('url').notNullable();
    t.text('secretHash').notNullable();
    t.jsonb('events').notNullable().defaultTo('[]');
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('lastSuccessAt', { precision: 3 });
    stamps(t);
    t.index(['organizerId', 'status']);
  });
  await knex.raw(`ALTER TABLE "WebhookEndpoint"
    ADD CONSTRAINT webhookendpoint_status_check CHECK (status IN (${list(ENDPOINT_STATUSES)})),
    ADD CONSTRAINT webhookendpoint_url_https_check CHECK (url ~ '^https://' AND char_length(url) <= 2000),
    ADD CONSTRAINT webhookendpoint_events_array_check CHECK (jsonb_typeof(events) = 'array')`);

  await knex.schema.createTable('WebhookDelivery', (t) => {
    t.text('id').primary();
    t.text('endpointId').notNullable().references('id').inTable('WebhookEndpoint').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('outboxEventId').notNullable().references('id').inTable('OutboxEvent').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('status').notNullable().defaultTo('pending');
    t.integer('attemptCount').notNullable().defaultTo(0);
    t.timestamp('nextAttemptAt', { precision: 3 });
    t.integer('responseCode');
    t.text('lastError');
    t.timestamp('deliveredAt', { precision: 3 });
    stamps(t);
    t.unique(['endpointId', 'outboxEventId']);
    t.index(['status', 'nextAttemptAt']);
  });
  await knex.raw(`ALTER TABLE "WebhookDelivery"
    ADD CONSTRAINT webhookdelivery_status_check CHECK (status IN (${list(DELIVERY_STATUSES)})),
    ADD CONSTRAINT webhookdelivery_attempts_check CHECK ("attemptCount" >= 0),
    ADD CONSTRAINT webhookdelivery_delivered_check CHECK ((status = 'delivered') = ("deliveredAt" IS NOT NULL))`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('WebhookDelivery');
  await knex.schema.dropTableIfExists('WebhookEndpoint');
  await knex.schema.dropTableIfExists('OutboxEvent');
  await knex.schema.dropTableIfExists('ApiClient');
};
