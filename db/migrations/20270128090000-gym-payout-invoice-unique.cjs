// Admin-portal audit M4 backstop: one GymPayout per legacy invoice.
//
// A partial unique index on GymPayout(invoiceId) (only rows that name an invoice; settlement-engine
// payouts leave it null). The service already pays an invoice once with a conditional UPDATE; this
// makes the database refuse a second row too.
//
// SAFE WITH EXISTING DUPLICATES: earlier builds inserted a payout on every "paid" call, so some
// invoices may already have 2+ rows. This migration NEVER deletes data. If duplicates exist it
// creates no index, logs the invoice ids and counts, and succeeds; clean them up by hand (keep
// the first, per owner decision) and re-run `knex migrate:up`-equivalent by creating the index
// named below. Additive and reversible: down drops the index.

const INDEX = 'gympayout_invoiceid_unique';

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const dupes = await knex('GymPayout').whereNotNull('invoiceId').groupBy('invoiceId')
    .havingRaw('count(*) > 1').select('invoiceId').count({ n: '*' });
  if (dupes.length) {
    console.warn(`[migrate] GymPayout: ${dupes.length} invoice(s) already have duplicate payout rows; unique index ${INDEX} NOT created (nothing deleted). Invoices: ${dupes.map(d => `${d.invoiceId}x${d.n}`).join(', ')}`);
    return;
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON "GymPayout" ("invoiceId") WHERE "invoiceId" IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
};
