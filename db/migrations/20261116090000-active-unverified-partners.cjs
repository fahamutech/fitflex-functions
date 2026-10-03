// Partner verification rule of 3 Oct 2026: trainers and gym owners are active
// at once and shown as "not verified" until their KYC is approved, instead of
// waiting behind an approval screen. Verification (the KYC case) now decides
// what they can do; approvalStatus no longer holds them back.
//
//   User            trainers and gym owners waiting for approval → approved
//   TrainerProfile  the same flag on the trainer's profile
//   Gym             gyms waiting for the owner's KYC → active
//
// Vendors are untouched: they still wait for approval. Rejected profiles stay
// rejected. There is nothing to undo: the previous value cannot be told apart
// from an approval, so down() leaves the rows as they are.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex('User')
    .whereIn('userType', ['trainer', 'gym_operator']).where({ approvalStatus: 'pending_approval' })
    .update({ approvalStatus: 'approved', updatedAt: knex.fn.now() });
  if (await knex.schema.hasColumn('TrainerProfile', 'approvalStatus')) {
    await knex('TrainerProfile').where({ approvalStatus: 'pending_approval' }).update({ approvalStatus: 'approved' });
  }
  await knex('Gym').where({ status: 'pending_verification' }).update({ status: 'active' });
};

exports.down = async function down() {};
