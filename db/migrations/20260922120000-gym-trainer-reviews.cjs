// Gym & Trainer review tables.
// Members who have visited a gym (check-in) or hold an active direct
// subscription to it may leave a 1-5 star rating + optional text review.
// Members who have completed (or no-showed) a trainer booking may review
// the trainer. One review per member per entity (enforced by unique index).
//
// Rolling average rating + reviewCount are denormalized onto Gym /
// TrainerProfile so list/detail reads never aggregate at query time.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  // ── GymReview ──
  if (!(await knex.schema.hasTable('GymReview'))) {
    await knex.schema.createTable('GymReview', (table) => {
      table.text('id').primary();
      table.text('gymId').notNullable();
      table.text('memberId').notNullable();
      table.integer('rating').notNullable(); // 1-5
      table.text('text');
      table.text('status').notNullable().defaultTo('published'); // published | flagged | hidden
      table.text('moderatedBy');
      table.timestamp('moderatedAt', { precision: 3 });
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.unique(['gymId', 'memberId']); // one review per member per gym
      table.index(['gymId', 'status']);
    });
  }

  // ── TrainerReview ──
  if (!(await knex.schema.hasTable('TrainerReview'))) {
    await knex.schema.createTable('TrainerReview', (table) => {
      table.text('id').primary();
      table.text('trainerId').notNullable();
      table.text('memberId').notNullable();
      table.integer('rating').notNullable(); // 1-5
      table.text('text');
      table.text('status').notNullable().defaultTo('published');
      table.text('moderatedBy');
      table.timestamp('moderatedAt', { precision: 3 });
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.unique(['trainerId', 'memberId']);
      table.index(['trainerId', 'status']);
    });
  }

  // ── Denormalized rating columns on Gym ──
  if (!(await knex.schema.hasColumn('Gym', 'rating'))) {
    await knex.schema.alterTable('Gym', (table) => {
      table.decimal('rating', 3, 2).notNullable().defaultTo(0);
    });
  }
  if (!(await knex.schema.hasColumn('Gym', 'reviewCount'))) {
    await knex.schema.alterTable('Gym', (table) => {
      table.integer('reviewCount').notNullable().defaultTo(0);
    });
  }

  // ── Denormalized rating columns on TrainerProfile ──
  // (TrainerProfile already has `rating` + `reviewCount` from init schema;
  //  guard anyway for safety on partially-migrated databases.)
  if (!(await knex.schema.hasColumn('TrainerProfile', 'rating'))) {
    await knex.schema.alterTable('TrainerProfile', (table) => {
      table.decimal('rating', 3, 2).notNullable().defaultTo(0);
    });
  }
  if (!(await knex.schema.hasColumn('TrainerProfile', 'reviewCount'))) {
    await knex.schema.alterTable('TrainerProfile', (table) => {
      table.integer('reviewCount').notNullable().defaultTo(0);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('GymReview');
  await knex.schema.dropTableIfExists('TrainerReview');
  if (await knex.schema.hasColumn('Gym', 'rating')) {
    await knex.schema.alterTable('Gym', (table) => {
      table.dropColumn('rating');
      table.dropColumn('reviewCount');
    });
  }
  // Leave TrainerProfile.rating / reviewCount — they predate this migration.
};
