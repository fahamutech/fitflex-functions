// B2B sponsor billing — what organisations and their beneficiaries are charged.
//
// Two bases, per benefit (decided 2026-10-01):
//   flat fee   a `sponsored_pass` benefit: the sponsor pays a fee per covered
//              person per calendar month, in advance, for everyone it
//              nominates; the member pays their own share once to unlock a
//              real platform pass for that month.
//   per use    every other benefit: the sponsor's share of each approved
//              consumption, invoiced after the month ends.
//
//   B2BPassEntitlement      one covered person, one month, one sponsored pass
//   B2BSponsorInvoice       an invoice to an organisation for one programme and
//                           month: `prepaid` (flat fees) or `usage` (per use)
//   B2BSponsorInvoiceLine   what the invoice is made of; a consumption or an
//                           entitlement is invoiced at most once
//
// This is the SPONSOR side only. What gyms are paid is the settlement engine's
// job: a covered member holds an ordinary platform pass whose approved
// payments (sponsor share + member share) are what settlement caps against.
//
// Money is whole TZS and VAT-inclusive; an invoice records the VAT rate and
// the VAT contained in its total when it is issued. Periods are EAT calendar
// months "YYYY-MM". Rows are never deleted: an invoice is voided.

const INVOICE_KINDS = ['prepaid', 'usage'];
const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'void'];
const LINE_KINDS = ['pass', 'usage', 'credit'];
const ENTITLEMENT_STATUSES = ['invoiced', 'scheduled', 'awaiting_link', 'awaiting_member', 'active', 'void'];
const MONTH = `'^[0-9]{4}-(0[1-9]|1[0-2])$'`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });
  const stamps = (t) => {
    ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
    ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
  };
  const ref = (t, col, table) => t.text(col).notNullable().references('id').inTable(table).onDelete('RESTRICT').onUpdate('CASCADE');
  const addColumn = async (table, column, build) => {
    if (!(await knex.schema.hasColumn(table, column))) await knex.schema.alterTable(table, build);
  };

  // A sponsored pass names the pass tier it gives; a programme may carry a
  // discount on the tier's price, set by FitFlex.
  await addColumn('B2BBenefit', 'passTier', t => t.text('passTier'));
  await addColumn('B2BWellnessProgram', 'discountBps', t => t.integer('discountBps').notNullable().defaultTo(0));

  if (!(await knex.schema.hasTable('B2BSponsorInvoice'))) {
    await knex.schema.createTable('B2BSponsorInvoice', (t) => {
      t.text('id').primary();
      t.text('number').notNullable().unique();
      ref(t, 'organizationId', 'B2BOrganization');
      ref(t, 'programId', 'B2BWellnessProgram');
      t.text('period').notNullable();
      t.text('kind').notNullable();
      t.text('status').notNullable().defaultTo('draft');
      t.integer('totalTzs').notNullable().defaultTo(0);   // VAT-inclusive
      t.integer('vatRateBps');                            // set when issued
      t.integer('vatTzs');                                // VAT contained in totalTzs
      ts(t, 'issuedAt'); t.text('issuedBy');
      ts(t, 'paidAt'); t.text('paidBy'); t.text('paymentReference');
      ts(t, 'voidedAt'); t.text('voidedBy'); t.text('voidReason');
      t.text('createdBy');
      stamps(t);
      t.index(['organizationId', 'period']);
      t.index(['programId', 'period', 'kind']);
      t.index('status');
    });
  }

  if (!(await knex.schema.hasTable('B2BPassEntitlement'))) {
    await knex.schema.createTable('B2BPassEntitlement', (t) => {
      t.text('id').primary();
      ref(t, 'organizationId', 'B2BOrganization');
      ref(t, 'programId', 'B2BWellnessProgram');
      ref(t, 'benefitId', 'B2BBenefit');
      t.text('beneficiaryId').notNullable();      // B2BBeneficiary.id or CorporateEmployee.id
      t.text('beneficiarySource').notNullable();
      t.text('userId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
      t.text('period').notNullable();
      t.text('passTier').notNullable();
      t.integer('listPriceTzs').notNullable();    // the tier's price when nominated
      t.integer('discountBps').notNullable().defaultTo(0);
      t.integer('feeTzs').notNullable();          // list price less the programme discount
      t.integer('sponsorTzs').notNullable();
      t.integer('memberTzs').notNullable();
      t.text('status').notNullable().defaultTo('invoiced');
      t.text('subscriptionId');                   // the member's pass for the month
      t.text('memberPaymentRequestId');
      ts(t, 'activatedAt');
      stamps(t);
      t.index(['programId', 'period']);
      t.index(['userId', 'period']);
      t.index('subscriptionId');
    });
  }

  if (!(await knex.schema.hasTable('B2BSponsorInvoiceLine'))) {
    await knex.schema.createTable('B2BSponsorInvoiceLine', (t) => {
      t.text('id').primary();
      ref(t, 'invoiceId', 'B2BSponsorInvoice');
      t.text('kind').notNullable();
      t.text('benefitId');
      t.text('beneficiaryId');
      t.text('userId');
      t.text('entitlementId');      // pass lines
      t.text('consumptionId');      // usage lines; credit lines name the consumption they give back
      t.text('creditOfLineId');     // credit lines
      t.text('description').notNullable();
      t.integer('quantity').notNullable().defaultTo(1);
      t.integer('unitTzs').notNullable();
      t.integer('amountTzs').notNullable();   // negative on a credit
      t.boolean('active').notNullable().defaultTo(true);   // false once its invoice is voided
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      t.index('invoiceId');
    });
  }

  const inList = (col, values) => `"${col}" IN (${values.map(v => `'${v}'`).join(', ')})`;
  const checks = [
    ['B2BWellnessProgram', 'b2b_program_discount_chk', `"discountBps" BETWEEN 0 AND 9999`],
    ['B2BBenefit', 'b2b_benefit_pass_tier_chk', `("benefitType" = 'sponsored_pass') = ("passTier" IS NOT NULL)`],
    ['B2BSponsorInvoice', 'b2b_invoice_kind_chk', inList('kind', INVOICE_KINDS)],
    ['B2BSponsorInvoice', 'b2b_invoice_status_chk', inList('status', INVOICE_STATUSES)],
    ['B2BSponsorInvoice', 'b2b_invoice_period_chk', `"period" ~ ${MONTH}`],
    ['B2BSponsorInvoice', 'b2b_invoice_vat_chk',
      `("vatRateBps" IS NULL AND "vatTzs" IS NULL) OR ("vatRateBps" BETWEEN 0 AND 10000 AND "vatTzs" IS NOT NULL AND "vatTzs" >= 0 AND "vatTzs" <= GREATEST("totalTzs", 0))`],
    ['B2BSponsorInvoice', 'b2b_invoice_issued_chk',
      `"status" NOT IN ('issued', 'paid') OR ("issuedAt" IS NOT NULL AND "issuedBy" IS NOT NULL AND "vatRateBps" IS NOT NULL)`],
    ['B2BSponsorInvoice', 'b2b_invoice_paid_chk',
      `("status" = 'paid') = ("paidAt" IS NOT NULL) AND ("status" <> 'paid' OR ("paidBy" IS NOT NULL AND "paymentReference" IS NOT NULL AND btrim("paymentReference") <> ''))`],
    ['B2BSponsorInvoice', 'b2b_invoice_void_chk',
      `("status" = 'void') = ("voidedAt" IS NOT NULL) AND ("status" <> 'void' OR ("voidedBy" IS NOT NULL AND "voidReason" IS NOT NULL))`],
    ['B2BSponsorInvoiceLine', 'b2b_invoice_line_kind_chk', inList('kind', LINE_KINDS)],
    ['B2BSponsorInvoiceLine', 'b2b_invoice_line_shape_chk', `
      ("kind" = 'pass' AND "entitlementId" IS NOT NULL AND "amountTzs" >= 0)
      OR ("kind" = 'usage' AND "consumptionId" IS NOT NULL AND "amountTzs" >= 0)
      OR ("kind" = 'credit' AND "creditOfLineId" IS NOT NULL AND "amountTzs" <= 0)`],
    ['B2BSponsorInvoiceLine', 'b2b_invoice_line_amount_chk', `"quantity" > 0 AND "amountTzs" = "unitTzs" * "quantity"`],
    ['B2BPassEntitlement', 'b2b_entitlement_status_chk', inList('status', ENTITLEMENT_STATUSES)],
    ['B2BPassEntitlement', 'b2b_entitlement_period_chk', `"period" ~ ${MONTH}`],
    ['B2BPassEntitlement', 'b2b_entitlement_money_chk',
      `"listPriceTzs" >= 0 AND "feeTzs" >= 0 AND "sponsorTzs" >= 0 AND "memberTzs" >= 0
       AND "sponsorTzs" + "memberTzs" = "feeTzs" AND "feeTzs" <= "listPriceTzs" AND "discountBps" BETWEEN 0 AND 9999`],
    ['B2BPassEntitlement', 'b2b_entitlement_active_chk', `"status" <> 'active' OR ("subscriptionId" IS NOT NULL AND "activatedAt" IS NOT NULL)`],
  ];
  for (const [tbl, name, expr] of checks) {
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [tbl, name]);
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${expr})`, [tbl, name]);
  }

  // A person is covered once per benefit and month; a consumption, an
  // entitlement and a credit each appear on one live invoice only.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_entitlement_live_uq
    ON "B2BPassEntitlement" ("benefitId", "beneficiaryId", "period") WHERE "status" <> 'void'`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_invoice_line_consumption_uq
    ON "B2BSponsorInvoiceLine" ("consumptionId") WHERE "kind" = 'usage' AND "active"`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_invoice_line_entitlement_uq
    ON "B2BSponsorInvoiceLine" ("entitlementId") WHERE "kind" = 'pass' AND "active"`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_invoice_line_credit_uq
    ON "B2BSponsorInvoiceLine" ("creditOfLineId") WHERE "kind" = 'credit' AND "active"`);
  // One open draft per programme, month and kind: new items join it.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_invoice_one_draft_uq
    ON "B2BSponsorInvoice" ("programId", "period", "kind") WHERE "status" = 'draft'`);

  // An invoice's figures freeze when it is issued; its status only moves
  // forward; paid and void are final.
  await knex.raw(`CREATE OR REPLACE FUNCTION b2b_sponsor_invoice_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD."status" <> 'draft' AND (NEW."totalTzs" IS DISTINCT FROM OLD."totalTzs"
        OR NEW."vatRateBps" IS DISTINCT FROM OLD."vatRateBps" OR NEW."vatTzs" IS DISTINCT FROM OLD."vatTzs"
        OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."programId" IS DISTINCT FROM OLD."programId"
        OR NEW."period" IS DISTINCT FROM OLD."period" OR NEW."kind" IS DISTINCT FROM OLD."kind") THEN
        RAISE EXCEPTION 'B2BSponsorInvoice: an issued invoice cannot be changed' USING ERRCODE = 'P0001';
      END IF;
      IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'draft' AND NEW."status" IN ('issued', 'void'))
        OR (OLD."status" = 'issued' AND NEW."status" IN ('paid', 'void'))) THEN
        RAISE EXCEPTION 'B2BSponsorInvoice: % -> % is not allowed', OLD."status", NEW."status" USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw('DROP TRIGGER IF EXISTS b2b_sponsor_invoice_guard ON "B2BSponsorInvoice"');
  await knex.raw(`CREATE TRIGGER b2b_sponsor_invoice_guard BEFORE UPDATE ON "B2BSponsorInvoice"
    FOR EACH ROW EXECUTE FUNCTION b2b_sponsor_invoice_guard()`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('B2BSponsorInvoiceLine');
  await knex.schema.dropTableIfExists('B2BPassEntitlement');
  await knex.schema.dropTableIfExists('B2BSponsorInvoice');
  await knex.raw('DROP FUNCTION IF EXISTS b2b_sponsor_invoice_guard()');
  await knex.raw('ALTER TABLE "B2BBenefit" DROP CONSTRAINT IF EXISTS b2b_benefit_pass_tier_chk');
  await knex.raw('ALTER TABLE "B2BWellnessProgram" DROP CONSTRAINT IF EXISTS b2b_program_discount_chk');
  if (await knex.schema.hasColumn('B2BBenefit', 'passTier')) await knex.schema.alterTable('B2BBenefit', t => t.dropColumn('passTier'));
  if (await knex.schema.hasColumn('B2BWellnessProgram', 'discountBps')) await knex.schema.alterTable('B2BWellnessProgram', t => t.dropColumn('discountBps'));
};
