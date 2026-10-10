// B2B Phase 7, slice 3 — a programme prepared as the renewal of another.
//
// `renewedFromProgramId` links a renewal to the programme it follows, so a
// programme has one live renewal however often "prepare renewal" is pressed.
// Additive only.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('B2BWellnessProgram', 'renewedFromProgramId'))) {
    await knex.schema.alterTable('B2BWellnessProgram', (t) => {
      t.text('renewedFromProgramId').references('id').inTable('B2BWellnessProgram').onDelete('RESTRICT').onUpdate('CASCADE');
    });
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_program_renewal_uq ON "B2BWellnessProgram" ("renewedFromProgramId") WHERE "renewedFromProgramId" IS NOT NULL AND "status" <> 'cancelled'`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS b2b_program_renewal_uq');
  if (await knex.schema.hasColumn('B2BWellnessProgram', 'renewedFromProgramId')) {
    await knex.schema.alterTable('B2BWellnessProgram', t => t.dropColumn('renewedFromProgramId'));
  }
};
