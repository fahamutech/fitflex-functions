// B2B Phase 7, slice 1 — running the recurring B2B work reliably.
//
//   JobRun         the existing run record, extended: the slot a scheduled
//                  run belongs to (so a slot succeeds once), what triggered
//                  it, who, which attempt, and how many items it handled
//   JobControl     a job paused by an operator, with a reason
//   OpsException   something that went wrong and needs a person: a failed
//                  job, an item a job could not process, a record that does
//                  not add up. Never deleted; resolved, ignored or given up on.
//
// Additive only. Existing JobRun rows (communications, settlement) keep
// working: the new columns are nullable or defaulted.

const EXCEPTION_STATUSES = ['open', 'investigating', 'retrying', 'resolved', 'ignored', 'permanently_failed'];
const SEVERITIES = ['low', 'medium', 'high'];
const TRIGGERS = ['schedule', 'catch_up', 'retry', 'manual'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });
  const addColumn = async (table, column, build) => {
    if (!(await knex.schema.hasColumn(table, column))) await knex.schema.alterTable(table, build);
  };

  await addColumn('JobRun', 'slot', t => t.text('slot'));                       // e.g. "2026-10-07" for a daily job
  await addColumn('JobRun', 'trigger', t => t.text('trigger'));
  await addColumn('JobRun', 'triggeredBy', t => t.text('triggeredBy'));
  await addColumn('JobRun', 'attempt', t => t.integer('attempt').notNullable().defaultTo(1));
  await addColumn('JobRun', 'processed', t => t.integer('processed'));
  await addColumn('JobRun', 'succeeded', t => t.integer('succeeded'));
  await addColumn('JobRun', 'failed', t => t.integer('failed'));
  await knex.raw(`ALTER TABLE "JobRun" DROP CONSTRAINT IF EXISTS jobrun_trigger_chk`);
  await knex.raw(`ALTER TABLE "JobRun" ADD CONSTRAINT jobrun_trigger_chk CHECK ("trigger" IS NULL OR "trigger" IN (${list(TRIGGERS)}))`);
  // A slot is done once: the backstop behind the lock, should two servers ever both get through.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS jobrun_slot_ok_uq ON "JobRun" ("job", "slot") WHERE "status" = 'ok' AND "slot" IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS jobrun_job_slot_idx ON "JobRun" ("job", "slot")`);

  if (!(await knex.schema.hasTable('JobControl'))) {
    await knex.schema.createTable('JobControl', (t) => {
      t.text('job').primary();
      t.boolean('paused').notNullable().defaultTo(false);
      t.text('reason');
      t.text('changedBy');
      ts(t, 'changedAt').notNullable().defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable('OpsException'))) {
    await knex.schema.createTable('OpsException', (t) => {
      t.text('id').primary();
      t.text('type').notNullable();              // job_failed | job_item_failed | data_quality | ...
      t.text('severity').notNullable();
      t.text('status').notNullable().defaultTo('open');
      t.text('title').notNullable();
      t.text('job');                             // the job that raised it, if any
      t.text('jobRunId');
      t.text('entityType');                      // program | invoice | organization | check | ...
      t.text('entityId');
      t.text('organizationId');
      t.jsonb('detail');
      // The same problem seen again is the same exception, not a new one.
      t.text('dedupeKey').notNullable();
      t.integer('occurrences').notNullable().defaultTo(1);
      t.integer('retryCount').notNullable().defaultTo(0);
      ts(t, 'detectedAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'lastSeenAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'lastAttemptAt');
      ts(t, 'resolvedAt');
      t.text('resolution');
      t.text('resolvedBy');                      // a staff id, or system:<job> when it cleared by itself
      ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
      t.index(['status', 'severity']);
      t.index(['organizationId']);
      t.index(['type', 'entityId']);
    });
    await knex.raw(`ALTER TABLE "OpsException" ADD CONSTRAINT ops_exception_status_chk CHECK ("status" IN (${list(EXCEPTION_STATUSES)}))`);
    await knex.raw(`ALTER TABLE "OpsException" ADD CONSTRAINT ops_exception_severity_chk CHECK ("severity" IN (${list(SEVERITIES)}))`);
    await knex.raw(`ALTER TABLE "OpsException" ADD CONSTRAINT ops_exception_closed_chk CHECK (("status" IN ('resolved', 'ignored')) = ("resolvedAt" IS NOT NULL))`);
    // One live exception per problem.
    await knex.raw(`CREATE UNIQUE INDEX ops_exception_live_uq ON "OpsException" ("dedupeKey") WHERE "status" IN ('open', 'investigating', 'retrying', 'permanently_failed')`);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('OpsException');
  await knex.schema.dropTableIfExists('JobControl');
  await knex.raw('DROP INDEX IF EXISTS jobrun_slot_ok_uq');
  await knex.raw('DROP INDEX IF EXISTS jobrun_job_slot_idx');
  await knex.raw('ALTER TABLE "JobRun" DROP CONSTRAINT IF EXISTS jobrun_trigger_chk');
  // The added JobRun columns are left in place: rows may use them.
};
