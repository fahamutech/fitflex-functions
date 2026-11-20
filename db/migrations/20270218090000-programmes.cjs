// Programmes P1, slice B1 (docs/plans/programmes-p1-plan.md in the parent repo).
//
// Programme: a published, fixed-length, day-by-day plan that FitFlex writes
// in the admin portal. Its days are kept as one jsonb list, like
// TrainingPlan.weeks: [{ day, type: gym | home | rest, workout? }].
// A member who starts one gets an ordinary TrainingPlan (programmeId set)
// with ordinary Workout rows, so Activity, streaks, goals and challenges
// need nothing new.
//
// ProgrammeDayCompletion: a gym day done by a check-in (slice B3), which
// records no Activity. A void sets reversedAt; at most one live row per day.
//
// TrainingExercise.clipUrl / stillUrl: links to an exercise's demo clip and
// still image (FR-P05). Hosting and licence are still open (PD-4).
//
// All additive and reversible. Nothing reads these tables while
// PROGRAMMES_CATALOGUE is off, except the admin authoring screens.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('Programme'))) {
    await knex.schema.createTable('Programme', (t) => {
      t.text('id').primary();
      t.text('title').notNullable();
      t.text('summary');
      // { sw: { title, summary } }: Swahili is entered by staff and marked for native review.
      t.jsonb('i18n');
      // Vocabulary from src/shared/training-taxonomy.mjs.
      t.text('goal').notNullable();
      t.text('level').notNullable();
      t.text('environment').notNullable();
      t.jsonb('equipment').notNullable().defaultTo('[]');
      t.integer('lengthDays').notNullable();
      t.jsonb('days').notNullable().defaultTo('[]');
      t.text('status').notNullable().defaultTo('draft');
      // The live programme this draft was made from ("make a new version").
      t.text('versionOf').references('id').inTable('Programme').onDelete('SET NULL').onUpdate('CASCADE');
      t.text('createdBy');
      t.text('updatedBy');
      t.timestamp('publishedAt', { precision: 3 });
      t.timestamp('retiredAt', { precision: 3 });
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index('status');
    });
    await knex.raw(`ALTER TABLE "Programme" ADD CONSTRAINT "Programme_status_check" CHECK ("status" IN ('draft', 'live', 'retired'))`);
    await knex.raw(`ALTER TABLE "Programme" ADD CONSTRAINT "Programme_lengthDays_check" CHECK ("lengthDays" BETWEEN 7 AND 84)`);
  }

  if (!(await knex.schema.hasColumn('TrainingPlan', 'programmeId'))) {
    await knex.schema.alterTable('TrainingPlan', (t) => {
      // A retired programme is never deleted while enrolled, but a plan must outlive it anyway.
      t.text('programmeId').references('id').inTable('Programme').onDelete('SET NULL').onUpdate('CASCADE');
      // A programme's own length (a plan otherwise counts whole weeks).
      t.integer('lengthDays');
      t.index('programmeId');
    });
  }

  if (!(await knex.schema.hasTable('ProgrammeDayCompletion'))) {
    await knex.schema.createTable('ProgrammeDayCompletion', (t) => {
      t.text('id').primary();
      t.text('planId').notNullable().references('id').inTable('TrainingPlan').onDelete('CASCADE').onUpdate('CASCADE');
      t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      // Local (EAT) calendar day, "YYYY-MM-DD", as on Checkin.businessDate.
      t.text('date').notNullable();
      t.text('source').notNullable();
      t.text('checkinId').references('id').inTable('Checkin').onDelete('SET NULL').onUpdate('CASCADE');
      t.timestamp('completedAt', { precision: 3 }).notNullable();
      t.timestamp('reversedAt', { precision: 3 });
      t.text('reversedReason');
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index(['userId', 'date']);
      t.index('checkinId');
    });
    await knex.raw(`ALTER TABLE "ProgrammeDayCompletion" ADD CONSTRAINT "ProgrammeDayCompletion_source_check" CHECK ("source" IN ('checkin', 'workout'))`);
    await knex.raw(`CREATE UNIQUE INDEX "ProgrammeDayCompletion_live_day" ON "ProgrammeDayCompletion" ("planId", "date") WHERE "reversedAt" IS NULL`);
  }

  for (const column of ['clipUrl', 'stillUrl']) {
    if (!(await knex.schema.hasColumn('TrainingExercise', column))) {
      await knex.schema.alterTable('TrainingExercise', (t) => t.text(column));
    }
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const column of ['clipUrl', 'stillUrl']) {
    if (await knex.schema.hasColumn('TrainingExercise', column)) {
      await knex.schema.alterTable('TrainingExercise', (t) => t.dropColumn(column));
    }
  }
  await knex.schema.dropTableIfExists('ProgrammeDayCompletion');
  if (await knex.schema.hasColumn('TrainingPlan', 'programmeId')) {
    await knex.schema.alterTable('TrainingPlan', (t) => {
      t.dropColumn('programmeId');
      t.dropColumn('lengthDays');
    });
  }
  await knex.schema.dropTableIfExists('Programme');
};
