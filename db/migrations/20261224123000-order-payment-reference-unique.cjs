// Marketplace PR 3: a payment reference (mobile-money or bank transaction id) confirms
// one shop order only. The service already refuses reuse; this is the database's guard
// for two confirmations at the same moment.
//
// The index is created only when the existing data allows it. If confirmed order
// payments already share a reference, the migration leaves the index out and prints
// the references, so nothing is rejected silently and nothing fails the deploy. Fix the
// duplicates, then create the index by hand (statement in the message).

const INDEX = 'paymentrequest_order_reference_confirmed_unique';

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const dupes = await knex.raw(`
    SELECT reference, COUNT(*)::int AS n FROM "PaymentRequest"
    WHERE status = 'approved' AND "orderId" IS NOT NULL AND reference IS NOT NULL
    GROUP BY reference HAVING COUNT(*) > 1 LIMIT 20`);
  if (dupes.rows.length) {
    console.warn(`[migrate] ${INDEX} NOT created: ${dupes.rows.length} reference(s) confirm more than one order:`,
      dupes.rows.map(r => `${r.reference} x${r.n}`).join(', '));
    console.warn(`[migrate] after resolving them: CREATE UNIQUE INDEX ${INDEX} ON "PaymentRequest" (reference) WHERE status = 'approved' AND "orderId" IS NOT NULL AND reference IS NOT NULL`);
    return;
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON "PaymentRequest" (reference)
    WHERE status = 'approved' AND "orderId" IS NOT NULL AND reference IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
};
