// Vendor business tools · S3 — walk-in (counter) sales.
//
// A walk-in sale is the vendor's own business: money never passes through FitFlex, there is no
// commission, no ShopOrder, no PaymentRequest and it is never part of vendor settlement. It uses
// the same stock pool as app orders (stock leaves through a conditional update + a ledger row).
//
// - VendorSale: one sale. number = R-000001… per vendor, gap-free (VendorDocumentSequence, issued
//   inside the sale's transaction). clientRef = the device's idempotency key (unique per vendor).
//   kind cash|credit (credit = S4), status completed|voided. Money is integer TZS:
//   totalTzs = subtotalTzs − lineDiscountTzs − discountTzs; changeTzs = paidTzs − totalTzs.
//   clientSoldAt: the device's soldAt when its clock ran ahead (soldAt was clamped to the server's now).
// - VendorSaleLine: what was sold, with the price the shop lists (listPriceTzs), the price charged
//   (unitPriceTzs), the line discount (total for the line), the share of the sale discount
//   (saleDiscountShareTzs, for S6 profit), the unit cost snapshotted from ProductPrivate
//   (unitCostTzs, null = not known) and who changed the price / gave the discount (O-14 audit).
// - VendorSalePayment: how it was paid (several methods allowed).
// - VendorDocumentSequence: (vendorId, docType) → next number; row-locked by the issuing
//   transaction, so numbers are continuous and a rolled-back sale gives its number back (O-6).
// - ShopStockMovement: unique (sourceId, productId, variant, reason) where sourceId is set, so a
//   sale takes, and a void gives back, each product/variant's units exactly once.
// - Permission `sales`: added to existing vendor staff with vendorRole admin or sales (User,
//   their OrgMembership rows, and pending vendor invitations for those roles) — F8 / Q-15.
//
// Down: drops the new tables and index and removes `sales` from vendor staff permissions.
// Ledger rows of kind sale / sale_void stay (they are valid stock history in the S1 schema).

const METHODS = ['cash', 'mpesa', 'airtel_money', 'mixx', 'halopesa', 'card', 'bank', 'other'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('VendorDocumentSequence', (table) => {
    table.text('vendorId').notNullable();
    table.text('docType').notNullable();
    table.integer('next').notNullable().defaultTo(1);
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.primary(['vendorId', 'docType']);
  });
  await knex.raw(`ALTER TABLE "VendorDocumentSequence" ADD CONSTRAINT vendordocumentsequence_next_positive CHECK ("next" >= 1)`);

  await knex.schema.createTable('VendorSale', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.integer('seq').notNullable();
    table.text('number').notNullable();
    table.text('kind').notNullable().defaultTo('cash');
    table.text('status').notNullable().defaultTo('completed');
    table.text('customerId');
    table.timestamp('soldAt', { precision: 3 }).notNullable();
    table.timestamp('clientSoldAt', { precision: 3 }); // the device's soldAt when it was ahead of the server (clamped to now)
    table.integer('subtotalTzs').notNullable();
    table.integer('lineDiscountTzs').notNullable().defaultTo(0);
    table.integer('discountTzs').notNullable().defaultTo(0);
    table.integer('vatTzs').notNullable().defaultTo(0);
    table.integer('totalTzs').notNullable();
    table.integer('paidTzs').notNullable();
    table.integer('changeTzs').notNullable().defaultTo(0);
    table.integer('balanceTzs').notNullable().defaultTo(0);
    table.date('dueDate');
    table.text('clientRef').notNullable();
    table.text('fingerprint').notNullable();
    table.text('note');
    table.text('createdBy').notNullable();
    table.text('voidedBy');
    table.timestamp('voidedAt', { precision: 3 });
    table.text('voidReason');
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['vendorId', 'clientRef']);
    table.unique(['vendorId', 'number']);
    table.unique(['vendorId', 'seq']);
    table.index(['vendorId', 'soldAt', 'id']);
    table.index(['vendorId', 'createdBy', 'soldAt']);
  });
  await knex.raw(`ALTER TABLE "VendorSale"
    ADD CONSTRAINT vendorsale_kind_check CHECK (kind IN ('cash', 'credit')),
    ADD CONSTRAINT vendorsale_status_check CHECK (status IN ('completed', 'voided')),
    ADD CONSTRAINT vendorsale_money_non_negative CHECK ("subtotalTzs" >= 0 AND "lineDiscountTzs" >= 0 AND "discountTzs" >= 0
      AND "vatTzs" >= 0 AND "totalTzs" >= 0 AND "paidTzs" >= 0 AND "changeTzs" >= 0 AND "balanceTzs" >= 0),
    ADD CONSTRAINT vendorsale_total_adds_up CHECK ("totalTzs" = "subtotalTzs" - "lineDiscountTzs" - "discountTzs" + "vatTzs"),
    ADD CONSTRAINT vendorsale_paid_adds_up CHECK ("paidTzs" - "changeTzs" + "balanceTzs" = "totalTzs"),
    ADD CONSTRAINT vendorsale_note_length CHECK (note IS NULL OR char_length(note) <= 200),
    ADD CONSTRAINT vendorsale_void_reason_length CHECK ("voidReason" IS NULL OR char_length("voidReason") <= 200),
    ADD CONSTRAINT vendorsale_voided_complete CHECK (
      (status = 'voided' AND "voidedAt" IS NOT NULL AND "voidedBy" IS NOT NULL AND "voidReason" IS NOT NULL)
      OR (status = 'completed' AND "voidedAt" IS NULL AND "voidedBy" IS NULL AND "voidReason" IS NULL))`);

  await knex.schema.createTable('VendorSaleLine', (table) => {
    table.text('id').primary();
    table.text('saleId').notNullable().references('id').inTable('VendorSale').onDelete('CASCADE');
    table.text('vendorId').notNullable();
    table.integer('lineNo').notNullable();
    table.text('productId').notNullable();
    table.text('variant').notNullable().defaultTo('');
    table.boolean('variantTracked').notNullable().defaultTo(false);
    table.text('nameSnapshot').notNullable();
    table.integer('qty').notNullable();
    table.integer('listPriceTzs').notNullable();
    table.integer('unitPriceTzs').notNullable();
    table.integer('discountTzs').notNullable().defaultTo(0);
    table.integer('saleDiscountShareTzs').notNullable().defaultTo(0);
    table.integer('lineTotalTzs').notNullable();
    table.integer('unitCostTzs'); // null = the cost price was not known when it was sold
    table.text('priceChangedBy'); // set when unitPriceTzs ≠ listPriceTzs (O-14)
    table.text('discountBy'); // set when discountTzs > 0 (O-14)
    table.text('vatCode');
    table.decimal('vatRatePct', 5, 2).notNullable().defaultTo(0);
    table.integer('vatTzs').notNullable().defaultTo(0);
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['saleId', 'lineNo']);
    table.index(['vendorId', 'productId']);
  });
  await knex.raw(`ALTER TABLE "VendorSaleLine"
    ADD CONSTRAINT vendorsaleline_qty_positive CHECK (qty > 0),
    ADD CONSTRAINT vendorsaleline_price_positive CHECK ("unitPriceTzs" > 0 AND "listPriceTzs" >= 0),
    ADD CONSTRAINT vendorsaleline_discount_range CHECK ("discountTzs" >= 0 AND "discountTzs" <= qty * "unitPriceTzs"),
    ADD CONSTRAINT vendorsaleline_total_adds_up CHECK ("lineTotalTzs" = qty * "unitPriceTzs" - "discountTzs"),
    ADD CONSTRAINT vendorsaleline_share_range CHECK ("saleDiscountShareTzs" >= 0 AND "saleDiscountShareTzs" <= "lineTotalTzs"),
    ADD CONSTRAINT vendorsaleline_cost_non_negative CHECK ("unitCostTzs" IS NULL OR "unitCostTzs" >= 0)`);

  await knex.schema.createTable('VendorSalePayment', (table) => {
    table.text('id').primary();
    table.text('saleId').notNullable().references('id').inTable('VendorSale').onDelete('CASCADE');
    table.text('vendorId').notNullable();
    table.integer('position').notNullable();
    table.text('method').notNullable();
    table.integer('amountTzs').notNullable();
    table.text('reference');
    table.timestamp('paidAt', { precision: 3 }).notNullable();
    table.text('recordedBy').notNullable();
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['saleId', 'position']);
    table.index(['vendorId', 'method']);
  });
  await knex.raw(`ALTER TABLE "VendorSalePayment"
    ADD CONSTRAINT vendorsalepayment_method_check CHECK (method IN (${list(METHODS)})),
    ADD CONSTRAINT vendorsalepayment_amount_positive CHECK ("amountTzs" > 0),
    ADD CONSTRAINT vendorsalepayment_reference_length CHECK (reference IS NULL OR char_length(reference) <= 100)`);

  // A sale (and its void) moves each product/variant once: the ledger refuses a second row.
  await knex.raw(`CREATE UNIQUE INDEX shopstockmovement_source_unique
    ON "ShopStockMovement" ("sourceId", "productId", "variant", "reason") WHERE "sourceId" IS NOT NULL`);

  await exports.addSalesPermission(knex);
};

/**
 * Permission `sales` for staff who already act as the vendor's admins or sellers (F8, Q-15): their
 * User row, their vendor OrgMembership and pending vendor invitations for those roles. Safe to repeat.
 * @param {import('knex').Knex} knex
 */
exports.addSalesPermission = async function addSalesPermission(knex) {
  const users = await knex.raw(`UPDATE "User" SET "vendorPermissions" = array_append(COALESCE("vendorPermissions", '{}'), 'sales')
    WHERE "userType" = 'vendor_staff' AND "vendorRole" IN ('admin', 'sales')
      AND NOT ('sales' = ANY(COALESCE("vendorPermissions", '{}'))) RETURNING id`);
  const memberships = await knex.raw(`UPDATE "OrgMembership" m SET "aclPermissions" = array_append(m."aclPermissions", 'sales'), "updatedAt" = now()
    FROM "User" u WHERE m."orgType" = 'vendor' AND m.role = 'staff' AND m."personaId" = u.id
      AND u."userType" = 'vendor_staff' AND u."vendorRole" IN ('admin', 'sales')
      AND NOT ('sales' = ANY(m."aclPermissions")) RETURNING m.id`);
  const invitations = await knex.raw(`UPDATE "Invitation" SET "aclPermissions" = array_append("aclPermissions", 'sales'), "updatedAt" = now()
    WHERE "orgType" = 'vendor' AND status = 'pending' AND payload->>'vendorRole' IN ('admin', 'sales')
      AND NOT ('sales' = ANY("aclPermissions")) RETURNING id`);
  console.log(`[migrate] vendor walk-in sales: permission 'sales' added to ${users.rows.length} staff, ${memberships.rows.length} membership(s), ${invitations.rows.length} pending invitation(s)`);
  return { users: users.rows.length, memberships: memberships.rows.length, invitations: invitations.rows.length };
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`UPDATE "Invitation" SET "aclPermissions" = array_remove("aclPermissions", 'sales') WHERE "orgType" = 'vendor' AND 'sales' = ANY("aclPermissions")`);
  await knex.raw(`UPDATE "OrgMembership" SET "aclPermissions" = array_remove("aclPermissions", 'sales') WHERE "orgType" = 'vendor' AND 'sales' = ANY("aclPermissions")`);
  await knex.raw(`UPDATE "User" SET "vendorPermissions" = array_remove("vendorPermissions", 'sales') WHERE "userType" = 'vendor_staff' AND 'sales' = ANY(COALESCE("vendorPermissions", '{}'))`);
  await knex.raw('DROP INDEX IF EXISTS shopstockmovement_source_unique');
  const sales = (await knex.raw('SELECT count(*)::int AS n FROM "VendorSale"')).rows[0].n;
  if (sales) console.warn(`[migrate] dropping ${sales} walk-in sale(s); their stock ledger rows stay`);
  await knex.schema.dropTableIfExists('VendorSalePayment');
  await knex.schema.dropTableIfExists('VendorSaleLine');
  await knex.schema.dropTableIfExists('VendorSale');
  await knex.schema.dropTableIfExists('VendorDocumentSequence');
};
