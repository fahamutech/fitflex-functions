// A trainer who already has a trainer profile is onboarded.
//
// Trainers are approved at once since 3 Oct 2026, so the app can only tell a
// registered trainer from one who still has to register by
// User.onboardingCompleted. Some trainers with a profile (linked or made by an
// admin) had it false; set it true for those. Trainers with no profile stay
// false and are taken through registration. Data only; nothing is dropped.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    UPDATE "User" u SET "onboardingCompleted" = true, "updatedAt" = now()
    WHERE u."userType" = 'trainer' AND u."onboardingCompleted" IS NOT TRUE
      AND EXISTS (SELECT 1 FROM "TrainerProfile" t WHERE t."userId" = u.id)
  `);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down() {
  // The earlier flag values are not kept; nothing to restore.
};
