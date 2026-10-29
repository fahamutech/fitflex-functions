// Marathon & running events · S5 (1 of 2) — venue operations and the payout schedule.
// Design: docs/design/events-s5-venue-api-and-webhooks.md §3 (payout schedule, D33), §4 (kit, bibs, feed), §6
// (idempotency), §11.2; D40 (bib numbers unique across the whole event).
//
// - Event.payoutSchedule: 'biweekly' | 'monthly' | NULL. A label the later settlement slice reads; no default and
//   no backfill (existing events stay NULL). Required at submit by the service, not by the database.
// - EventKitCollection: how the handover was recorded (scan | manual | api), why a manual one was needed, a
//   note, and the API client that wrote it. A row has a staff user OR an API client, never both.
// - EventBibAssignment: the API client that assigned it, and a LIVE unique on (eventId, bibNumber) so one number
//   identifies one person at the finish line (D40). The migration stops with a clear message when existing live
//   data would violate it (the module is dormant, none is expected).
// - EventRegistration: index for `updatedSince` keyset reads.
// - OutboxEvent.seq: a monotonic identity used as the change-feed cursor and the fan-out order.
// - OrganizerIdempotency: one row per (scope, key, route) so a retried write returns the first answer. The
//   database uniques stay the real guarantee; this table makes the replay clean. Rows live 7 days.
//
// Additive. Down FAILS CLOSED: it refuses while any payout schedule is set, any S5 kit/bib row, idempotency row
// or published outbox row exists. On an empty module it restores the S4 shape exactly. Treat down as dev-only once
// real data exists.

const KIT_METHODS = ['scan', 'manual', 'api'];
const MANUAL_REASONS = ['phone_lost', 'no_signal', 'screen_damaged', 'other'];
const SCHEDULES = ['biweekly', 'monthly'];
const IDEM_SCOPES = ['staff', 'api'];
const IDEM_STATES = ['in_progress', 'done'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const clash = await knex.raw(`SELECT "eventId", "bibNumber", count(*)::int AS n FROM "EventBibAssignment" WHERE "releasedAt" IS NULL GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 1`);
  if (clash.rows.length) throw new Error('events S5: live bib numbers repeat across categories of one event; resolve them before this migration (D40).');

  await knex.raw(`ALTER TABLE "Event" ADD COLUMN "payoutSchedule" text`);
  await knex.raw(`ALTER TABLE "Event" ADD CONSTRAINT event_payout_schedule_check CHECK ("payoutSchedule" IS NULL OR "payoutSchedule" IN (${list(SCHEDULES)}))`);

  await knex.raw(`ALTER TABLE "EventKitCollection"
    ADD COLUMN method text NOT NULL DEFAULT 'scan',
    ADD COLUMN "manualReason" text,
    ADD COLUMN note text,
    ADD COLUMN "apiClientId" text REFERENCES "ApiClient"(id) ON DELETE SET NULL ON UPDATE CASCADE`);
  await knex.raw(`ALTER TABLE "EventKitCollection"
    ADD CONSTRAINT eventkitcollection_method_check CHECK (method IN (${list(KIT_METHODS)})),
    ADD CONSTRAINT eventkitcollection_manual_reason_check CHECK ("manualReason" IS NULL OR "manualReason" IN (${list(MANUAL_REASONS)})),
    ADD CONSTRAINT eventkitcollection_manual_check CHECK (method <> 'manual' OR "manualReason" IS NOT NULL OR status IN ('corrected', 'exception')),
    ADD CONSTRAINT eventkitcollection_note_check CHECK (note IS NULL OR char_length(note) <= 300),
    ADD CONSTRAINT eventkitcollection_actor_check CHECK (NOT ("staffUserId" IS NOT NULL AND "apiClientId" IS NOT NULL))`);
  await knex.raw(`CREATE INDEX eventkitcollection_event_collected_idx ON "EventKitCollection" ("eventId", "collectedAt")`);

  await knex.raw(`ALTER TABLE "EventBibAssignment" ADD COLUMN "assignedByApiClientId" text REFERENCES "ApiClient"(id) ON DELETE SET NULL ON UPDATE CASCADE`);
  await knex.raw(`CREATE UNIQUE INDEX eventbibassignment_live_event_bib_unique ON "EventBibAssignment" ("eventId", "bibNumber") WHERE "releasedAt" IS NULL`);
  await knex.raw(`CREATE INDEX eventbibassignment_event_registration_idx ON "EventBibAssignment" ("eventId", "registrationId")`);

  await knex.raw(`CREATE INDEX eventregistration_event_updated_idx ON "EventRegistration" ("eventId", "updatedAt", id)`);

  await knex.raw(`ALTER TABLE "OutboxEvent" ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY`);
  await knex.raw(`CREATE UNIQUE INDEX outboxevent_seq_unique ON "OutboxEvent" (seq)`);
  await knex.raw(`CREATE INDEX outboxevent_event_seq_idx ON "OutboxEvent" ("eventId", seq)`);
  await knex.raw(`CREATE INDEX outboxevent_organizer_seq_idx ON "OutboxEvent" ("organizerId", seq)`);

  await knex.schema.createTable('OrganizerIdempotency', (t) => {
    t.text('id').primary();
    t.text('scopeType').notNullable();
    t.text('scopeId').notNullable();
    t.text('key').notNullable();
    t.text('route').notNullable();
    t.text('fingerprint').notNullable();
    t.text('state').notNullable().defaultTo('in_progress');
    t.integer('status');
    t.jsonb('response');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expiresAt', { precision: 3 }).notNullable();
    t.unique(['scopeType', 'scopeId', 'key', 'route']);
    t.index(['expiresAt']);
  });
  await knex.raw(`ALTER TABLE "OrganizerIdempotency"
    ADD CONSTRAINT organizeridempotency_scope_check CHECK ("scopeType" IN (${list(IDEM_SCOPES)})),
    ADD CONSTRAINT organizeridempotency_state_check CHECK (state IN (${list(IDEM_STATES)})),
    ADD CONSTRAINT organizeridempotency_key_check CHECK (char_length(key) BETWEEN 8 AND 100),
    ADD CONSTRAINT organizeridempotency_done_check CHECK ((state = 'done') = (status IS NOT NULL))`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const count = async (sql) => Number((await knex.raw(sql)).rows[0].n);
  const blockers = [
    [await count(`SELECT count(*) AS n FROM "Event" WHERE "payoutSchedule" IS NOT NULL`), 'a payout schedule is set'],
    [await count(`SELECT count(*) AS n FROM "EventKitCollection" WHERE method <> 'scan' OR "apiClientId" IS NOT NULL OR note IS NOT NULL OR "manualReason" IS NOT NULL`), 'S5 kit collections exist'],
    [await count(`SELECT count(*) AS n FROM "EventBibAssignment" WHERE "assignedByApiClientId" IS NOT NULL`), 'API bib assignments exist'],
    [await count(`SELECT count(*) AS n FROM "OrganizerIdempotency"`), 'idempotency rows exist'],
    [await count(`SELECT count(*) AS n FROM "OutboxEvent" WHERE "publishedAt" IS NOT NULL`), 'published outbox rows exist'],
  ].filter(([n]) => n > 0).map(([, why]) => why);
  if (blockers.length) throw new Error(`events S5 down refused (fails closed): ${blockers.join('; ')}.`);

  await knex.schema.dropTableIfExists('OrganizerIdempotency');
  await knex.raw(`DROP INDEX IF EXISTS outboxevent_organizer_seq_idx`);
  await knex.raw(`DROP INDEX IF EXISTS outboxevent_event_seq_idx`);
  await knex.raw(`DROP INDEX IF EXISTS outboxevent_seq_unique`);
  await knex.raw(`ALTER TABLE "OutboxEvent" DROP COLUMN seq`);
  await knex.raw(`DROP INDEX IF EXISTS eventregistration_event_updated_idx`);
  await knex.raw(`DROP INDEX IF EXISTS eventbibassignment_event_registration_idx`);
  await knex.raw(`DROP INDEX IF EXISTS eventbibassignment_live_event_bib_unique`);
  await knex.raw(`ALTER TABLE "EventBibAssignment" DROP COLUMN "assignedByApiClientId"`);
  await knex.raw(`DROP INDEX IF EXISTS eventkitcollection_event_collected_idx`);
  await knex.raw(`ALTER TABLE "EventKitCollection"
    DROP CONSTRAINT eventkitcollection_actor_check, DROP CONSTRAINT eventkitcollection_note_check, DROP CONSTRAINT eventkitcollection_manual_check,
    DROP CONSTRAINT eventkitcollection_manual_reason_check, DROP CONSTRAINT eventkitcollection_method_check,
    DROP COLUMN "apiClientId", DROP COLUMN note, DROP COLUMN "manualReason", DROP COLUMN method`);
  await knex.raw(`ALTER TABLE "Event" DROP CONSTRAINT event_payout_schedule_check`);
  await knex.raw(`ALTER TABLE "Event" DROP COLUMN "payoutSchedule"`);
};
