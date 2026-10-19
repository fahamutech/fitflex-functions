// Two admins on B2B money (owner decision 19 Oct 2026; security review 19 Oct).
//
//   B2BCommercialAgreement.updatedBy
//       the admin who last changed a draft agreement. The agreement is put in
//       force by someone other than its creator and its last editor
//       (403 cannot_activate_own_agreement).
//   B2BPaymentInstruction.pendingChange / changeRequestedBy / changeRequestedAt
//       a requested change to where organisations pay FitFlex (bank account,
//       Lipa Namba). It takes effect only when a different admin confirms it
//       (403 cannot_confirm_own_request). Both steps are in the AuditLog.
//
// Additive: nullable columns only, nothing backfilled. Down drops them (a
// pending change is lost; the payment details in force are untouched).

const COLUMNS = {
  B2BCommercialAgreement: { updatedBy: t => t.text('updatedBy') },
  B2BPaymentInstruction: {
    pendingChange: t => t.jsonb('pendingChange'),
    changeRequestedBy: t => t.text('changeRequestedBy'),
    changeRequestedAt: t => t.timestamp('changeRequestedAt', { precision: 3 }),
  },
};

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    for (const [column, build] of Object.entries(columns)) {
      if (!(await knex.schema.hasColumn(table, column))) await knex.schema.alterTable(table, build);
    }
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    for (const column of Object.keys(columns)) {
      if (await knex.schema.hasColumn(table, column)) await knex.schema.alterTable(table, t => t.dropColumn(column));
    }
  }
};
