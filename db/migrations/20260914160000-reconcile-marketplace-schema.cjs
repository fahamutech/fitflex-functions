// The original marketplace migration was recorded as applied in some UAT
// databases before every column was present. Re-run its idempotent `up`
// checks under a new migration id so those databases converge safely.
const marketplaceRequirements = require('./20260905120000-marketplace-requirements.cjs');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await marketplaceRequirements.up(knex);
};

// This migration repairs an already-released schema. Rolling it back must not
// remove marketplace columns that may have existed before the repair ran.
exports.down = async function down() {};
