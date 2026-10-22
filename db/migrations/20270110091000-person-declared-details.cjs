// Partner date of birth · slice 2 (plan 2026-10-22, docs/partner-dob-api.md).
//
//   Person.dateOfBirth               what the person told FitFlex about themselves (trainers and gym
//                                    owners at onboarding; GET/PUT /me/personal-details). Never copied
//                                    from KYC (partner_people.dateOfBirth stays KYC-only).
//   Person.gender                    male | female | other; NULL = not given / "prefer not to say"
//   Person.declaredProfileUpdatedAt  when either was last written
//
// Additive; existing rows stay NULL (existing accounts are test data, no backfill). Down drops them.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.alterTable('Person', t => {
    t.date('dateOfBirth');
    t.text('gender');
    t.timestamp('declaredProfileUpdatedAt', { useTz: true });
  });
  await knex.raw(`ALTER TABLE "Person"
    ADD CONSTRAINT person_gender_check CHECK (gender IS NULL OR gender IN ('male', 'female', 'other'))`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE "Person" DROP CONSTRAINT IF EXISTS person_gender_check');
  await knex.schema.alterTable('Person', t => {
    t.dropColumn('dateOfBirth');
    t.dropColumn('gender');
    t.dropColumn('declaredProfileUpdatedAt');
  });
};
