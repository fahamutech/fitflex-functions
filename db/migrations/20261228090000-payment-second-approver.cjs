// A1 · second approver on money (flag MONEY_SECOND_APPROVER).
//
//   PaymentRequest.verifiedBy / verifiedAt
//       the admin who checked that a manual payment arrived, and when. With the
//       flag on, a different admin approves it (which activates the plan).
//   PaymentRequest.changeRequestedStatus / changeRequestedBy /
//   changeRequestedAt / changeRequestReason
//       a request to change an already-decided payment (approved → rejected,
//       cancelled …). A different admin confirms it before it takes effect.
//
// Additive: nullable columns only, nothing backfilled; the payment status values
// do not change. Down drops the columns (any pending change request and the
// verification record are lost; the payment's own status is untouched).

const COLUMNS = ['verifiedBy', 'verifiedAt', 'changeRequestedStatus', 'changeRequestedBy', 'changeRequestedAt', 'changeRequestReason'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const missing = [];
  for (const c of COLUMNS) if (!(await knex.schema.hasColumn('PaymentRequest', c))) missing.push(c);
  if (!missing.length) return;
  await knex.schema.alterTable('PaymentRequest', (table) => {
    if (missing.includes('verifiedBy')) table.text('verifiedBy');
    if (missing.includes('verifiedAt')) table.timestamp('verifiedAt', { precision: 3 });
    if (missing.includes('changeRequestedStatus')) table.text('changeRequestedStatus');
    if (missing.includes('changeRequestedBy')) table.text('changeRequestedBy');
    if (missing.includes('changeRequestedAt')) table.timestamp('changeRequestedAt', { precision: 3 });
    if (missing.includes('changeRequestReason')) table.text('changeRequestReason');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const present = [];
  for (const c of COLUMNS) if (await knex.schema.hasColumn('PaymentRequest', c)) present.push(c);
  if (!present.length) return;
  await knex.schema.alterTable('PaymentRequest', (table) => {
    for (const c of present) table.dropColumn(c);
  });
};
