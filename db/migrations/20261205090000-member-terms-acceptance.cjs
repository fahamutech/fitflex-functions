// Members agree to the FitFlex Terms and Conditions when they set up their
// account (partners accept their partner agreement, kept in PartnerAgreement).
// The accepted version and time are kept on the member's own account row.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const cols = {
    termsVersion: (t) => t.text('termsVersion'),
    termsAcceptedAt: (t) => t.timestamp('termsAcceptedAt', { precision: 3 }),
  };
  for (const [name, add] of Object.entries(cols)) {
    if (!(await knex.schema.hasColumn('User', name))) await knex.schema.alterTable('User', add);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const name of ['termsVersion', 'termsAcceptedAt']) {
    if (await knex.schema.hasColumn('User', name)) await knex.schema.alterTable('User', (t) => t.dropColumn(name));
  }
};
