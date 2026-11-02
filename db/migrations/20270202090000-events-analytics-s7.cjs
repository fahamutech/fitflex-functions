// Marathon & running events · S7 (1 of 4) — aggregate analytics counters and the roll-up cursor.
// Design: docs/design/events-s7-hardening-and-pilot.md §5.1, §5.2, §7.3 (D77).
//
// EventAnalyticsDaily holds COUNTS only: (day in Africa/Dar_es_Salaam, name, event or none, dimension key) -> count.
// There is no user, registration, order, session or device id, no IP and nothing finer than the day (privacy rules §5.2).
// AnalyticsRollupCursor remembers how far the roll-up has read the existing `analytics.%` AuditLog rows, so a rerun is exactly-once.
//
// Also adds JobControl.lastOkAt (a heartbeat for quiet event jobs, see below).
// Additive. Down FAILS CLOSED: it refuses while any counter row exists (a dev database can clear the table first).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('EventAnalyticsDaily', (t) => {
    t.text('id').primary();
    t.date('day').notNullable();
    t.text('name').notNullable();
    t.text('eventId');
    t.text('dimsKey').notNullable().defaultTo('');
    t.jsonb('dims').notNullable().defaultTo('{}');
    t.bigInteger('count').notNullable().defaultTo(0);
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.index(['name', 'day']);
    t.index(['eventId', 'day']);
  });
  await knex.raw(`ALTER TABLE "EventAnalyticsDaily"
    ADD CONSTRAINT eventanalyticsdaily_count_check CHECK (count >= 0),
    ADD CONSTRAINT eventanalyticsdaily_name_check CHECK (char_length(name) BETWEEN 1 AND 60),
    ADD CONSTRAINT eventanalyticsdaily_dims_key_check CHECK (char_length("dimsKey") <= 200)`);
  await knex.raw(`CREATE UNIQUE INDEX eventanalyticsdaily_unique ON "EventAnalyticsDaily" (day, name, COALESCE("eventId", ''), "dimsKey")`);

  await knex.schema.createTable('AnalyticsRollupCursor', (t) => {
    t.text('name').primary();
    t.timestamp('lastAt', { precision: 3 });
    t.text('lastId');
    t.timestamp('rolledUpAt', { precision: 3 });
  });

  // A quiet job writes a JobRun row only when it had work, so "no success in three cadences" (alert A5) cannot be read from JobRun for the
  // event jobs. Jobs registered with `heartbeat: true` stamp this column on every successful run instead (one cheap upsert).
  await knex.raw(`ALTER TABLE "JobControl" ADD COLUMN "lastOkAt" timestamp(3) with time zone`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const n = Number((await knex.raw(`SELECT count(*) AS n FROM "EventAnalyticsDaily"`)).rows[0].n);
  if (n > 0) throw new Error('events S7 analytics down refused (fails closed): counter rows exist.');
  await knex.raw(`ALTER TABLE "JobControl" DROP COLUMN "lastOkAt"`);
  await knex.schema.dropTableIfExists('AnalyticsRollupCursor');
  await knex.schema.dropTableIfExists('EventAnalyticsDaily');
};
