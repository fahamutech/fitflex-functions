// B2B billing controls.
//
// 1. Maker-checker on sponsor invoices: whoever issued an invoice cannot be
//    the one who records it as paid. Recording a prepaid invoice as paid
//    starts passes and counts as money collected for gym settlement, so one
//    person must not be able to do both. The service refuses it; this
//    constraint is the backstop. NOT VALID: it binds new changes only, so
//    invoices settled before the rule existed do not fail the deploy.
//
// 2. The B2B ledgers are append-only: consumptions, sponsor invoices, their
//    lines and pass entitlements can be reversed, voided or credited, never
//    deleted. Updates were already guarded; deletes are now refused too.
//    Maintenance (and the test suites' clean-up) can opt in for one
//    transaction with:  SET LOCAL fitflex.allow_ledger_delete = 'on'

const LEDGERS = ['B2BBenefitConsumption', 'B2BSponsorInvoice', 'B2BSponsorInvoiceLine', 'B2BPassEntitlement'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE "B2BSponsorInvoice" DROP CONSTRAINT IF EXISTS b2b_invoice_maker_checker_ck');
  await knex.raw(`ALTER TABLE "B2BSponsorInvoice" ADD CONSTRAINT b2b_invoice_maker_checker_ck
    CHECK ("paidBy" IS NULL OR "issuedBy" IS NULL OR "paidBy" <> "issuedBy") NOT VALID`);

  await knex.raw(`CREATE OR REPLACE FUNCTION b2b_ledger_no_delete() RETURNS trigger AS $$
    BEGIN
      IF current_setting('fitflex.allow_ledger_delete', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION '%: ledger rows are never deleted; reverse, void or credit instead', TG_TABLE_NAME USING ERRCODE = 'P0001';
    END;
  $$ LANGUAGE plpgsql`);
  for (const table of LEDGERS) {
    const name = `${table.toLowerCase()}_no_delete`;
    await knex.raw(`DROP TRIGGER IF EXISTS ${name} ON "${table}"`);
    await knex.raw(`CREATE TRIGGER ${name} BEFORE DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION b2b_ledger_no_delete()`);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const table of LEDGERS) await knex.raw(`DROP TRIGGER IF EXISTS ${table.toLowerCase()}_no_delete ON "${table}"`);
  await knex.raw('DROP FUNCTION IF EXISTS b2b_ledger_no_delete()');
  await knex.raw('ALTER TABLE "B2BSponsorInvoice" DROP CONSTRAINT IF EXISTS b2b_invoice_maker_checker_ck');
};
