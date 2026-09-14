// Some UAT databases recorded the listing-controls migration without retaining
// its columns. Re-run the original idempotent checks under a fresh migration id.
const homepageListingControls = require('./20260905100000-homepage-listing-controls.cjs');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await homepageListingControls.up(knex);
};

// Schema reconciliation must remain in place if this migration is rolled back.
exports.down = async function down() {};
