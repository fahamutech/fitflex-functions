// Vendor business tools · S9 — suppliers, receiving stock (GRN) and payables with instalments.
// Design: docs/design/vendor-purchases-s9.md §2.1 (approved 2026-11-04, Q-1..Q-7 as recommended).
// RULE 6 AREA: new money records (payables), cost-price writes, a new staff permission and its backfill.
//
// FitFlex moves no money for payables: these rows record what the vendor owes a supplier and what they say
// they paid. No PaymentRequest, no commission, no settlement row.
//
// - VendorSupplier: the vendor's suppliers (name unique among ACTIVE suppliers, case-insensitive). Archive only,
//   never delete; archiving is refused while the supplier is owed anything (service rule P-12).
// - VendorPurchase: one goods received note (GRN-000001… per vendor from VendorDocumentSequence docType
//   `purchase`, gap-free, issued inside the receive transaction). status received | voided. totalTzs =
//   Σ line totals; paidTzs + balanceTzs = totalTzs (CHECK). Something left owing needs a supplier (CHECK).
// - VendorPurchaseLine: what came in (one line per product + variant), unit cost, and the cost-price change it
//   made (P-6: costUpdated, previousCostTzs, previousCostSourceId; costRestoredOnVoid after a void).
// - VendorPurchaseInstalment: the payment plan (a schedule only). Active rows add up to the total. A plan
//   change keeps paid rows and marks the rest `replaced` (kept for history). `seq` is the plan order in which
//   payments cover instalments (oldest due first at creation; after a change, kept paid rows come first).
// - VendorPurchasePayment: what the vendor paid the supplier (at receipt, or later). recorded | voided.
//   Voided with its purchase when the purchase is voided (voidedWithPurchase).
// - ProductPrivate gains costSourceId (the purchase that set the cost; null = set by hand or unknown) and
//   costUpdatedAt. Existing rows: both null.
// - Permission `purchases` backfilled onto vendorRole admin staff only (Q-2): their User row, their vendor
//   OrgMembership and pending vendor invitations for the admin role.
//
// Down: REFUSES while any VendorPurchase row exists (prints the count). Otherwise removes the permission,
// drops the ProductPrivate columns and the five tables, and deletes the `purchase` sequence rows. Ledger rows
// of kind stock_in / stock_in_void cannot exist then (they are only written with a purchase).

const METHODS = ['cash', 'mpesa', 'airtel_money', 'mixx', 'halopesa', 'card', 'bank', 'other'];
const list = values => values.map(v => `'${v}'`).join(', ');
const CLIENT_REF = '^[A-Za-z0-9._:-]{8,100}$';

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('VendorSupplier', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.text('name').notNullable();
    table.text('phone');
    table.text('email');
    table.text('contactPerson');
    table.text('address');
    table.text('tin');
    table.text('note');
    table.timestamp('archivedAt', { precision: 3 });
    table.text('archivedBy');
    table.text('createdBy').notNullable();
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['id', 'vendorId']);
  });
  await knex.raw(`ALTER TABLE "VendorSupplier"
    ADD CONSTRAINT vendorsupplier_name_length CHECK (char_length(name) BETWEEN 2 AND 120),
    ADD CONSTRAINT vendorsupplier_phone_length CHECK (phone IS NULL OR char_length(phone) <= 20),
    ADD CONSTRAINT vendorsupplier_email_length CHECK (email IS NULL OR char_length(email) <= 254),
    ADD CONSTRAINT vendorsupplier_contact_length CHECK ("contactPerson" IS NULL OR char_length("contactPerson") <= 120),
    ADD CONSTRAINT vendorsupplier_address_length CHECK (address IS NULL OR char_length(address) <= 300),
    ADD CONSTRAINT vendorsupplier_tin_length CHECK (tin IS NULL OR char_length(tin) <= 20),
    ADD CONSTRAINT vendorsupplier_note_length CHECK (note IS NULL OR char_length(note) <= 500),
    ADD CONSTRAINT vendorsupplier_archived_complete CHECK (("archivedAt" IS NULL) = ("archivedBy" IS NULL))`);
  await knex.raw('CREATE INDEX vendorsupplier_name_idx ON "VendorSupplier" ("vendorId", lower(name))');
  await knex.raw('CREATE UNIQUE INDEX vendorsupplier_active_name_unique ON "VendorSupplier" ("vendorId", lower(name)) WHERE "archivedAt" IS NULL');

  await knex.schema.createTable('VendorPurchase', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.integer('seq').notNullable();
    table.text('number').notNullable();
    table.text('supplierId');
    table.text('status').notNullable().defaultTo('received');
    table.date('receivedOn').notNullable();
    table.text('supplierInvoiceRef');
    table.text('note');
    table.integer('totalTzs').notNullable();
    table.integer('paidTzs').notNullable().defaultTo(0);
    table.integer('balanceTzs').notNullable().defaultTo(0);
    table.text('clientRef').notNullable();
    table.text('fingerprint').notNullable();
    table.text('createdBy').notNullable();
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.text('voidedBy');
    table.timestamp('voidedAt', { precision: 3 });
    table.text('voidReason');
    table.unique(['vendorId', 'seq']);
    table.unique(['vendorId', 'number']);
    table.unique(['vendorId', 'clientRef']);
    table.unique(['id', 'vendorId']);
    table.index(['vendorId', 'receivedOn', 'id']);
    table.index(['vendorId', 'supplierId', 'receivedOn']);
  });
  await knex.raw(`ALTER TABLE "VendorPurchase"
    ADD CONSTRAINT vendorpurchase_supplier_fk FOREIGN KEY ("supplierId", "vendorId") REFERENCES "VendorSupplier" (id, "vendorId"),
    ADD CONSTRAINT vendorpurchase_status_check CHECK (status IN ('received', 'voided')),
    ADD CONSTRAINT vendorpurchase_invoice_ref_length CHECK ("supplierInvoiceRef" IS NULL OR char_length("supplierInvoiceRef") <= 60),
    ADD CONSTRAINT vendorpurchase_note_length CHECK (note IS NULL OR char_length(note) <= 200),
    ADD CONSTRAINT vendorpurchase_money_non_negative CHECK ("totalTzs" >= 0 AND "paidTzs" >= 0 AND "balanceTzs" >= 0),
    ADD CONSTRAINT vendorpurchase_adds_up CHECK ("paidTzs" + "balanceTzs" = "totalTzs"),
    ADD CONSTRAINT vendorpurchase_total_cap CHECK ("totalTzs" <= 1000000000),
    ADD CONSTRAINT vendorpurchase_debt_needs_supplier CHECK ("supplierId" IS NOT NULL OR "balanceTzs" = 0 OR status = 'voided'),
    ADD CONSTRAINT vendorpurchase_client_ref CHECK ("clientRef" ~ '${CLIENT_REF}'),
    ADD CONSTRAINT vendorpurchase_void_reason_length CHECK ("voidReason" IS NULL OR char_length("voidReason") BETWEEN 3 AND 200),
    ADD CONSTRAINT vendorpurchase_voided_complete CHECK (
      (status = 'voided' AND "voidedBy" IS NOT NULL AND "voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL)
      OR (status = 'received' AND "voidedBy" IS NULL AND "voidedAt" IS NULL AND "voidReason" IS NULL))`);
  await knex.raw(`CREATE INDEX vendorpurchase_open_idx ON "VendorPurchase" ("vendorId") WHERE status = 'received' AND "balanceTzs" > 0`);

  await knex.schema.createTable('VendorPurchaseLine', (table) => {
    table.text('id').primary();
    table.text('purchaseId').notNullable().references('id').inTable('VendorPurchase').onDelete('CASCADE');
    table.text('vendorId').notNullable();
    table.integer('lineNo').notNullable();
    table.text('productId').notNullable();
    table.text('variant').notNullable().defaultTo('');
    table.boolean('variantTracked').notNullable().defaultTo(false);
    table.text('nameSnapshot').notNullable();
    table.integer('qty').notNullable();
    table.integer('unitCostTzs').notNullable();
    table.integer('lineTotalTzs').notNullable();
    table.boolean('costUpdated').notNullable().defaultTo(false);
    table.integer('previousCostTzs');
    table.text('previousCostSourceId');
    table.boolean('costRestoredOnVoid');
    table.unique(['purchaseId', 'lineNo']);
    table.unique(['purchaseId', 'productId', 'variant']);
    table.index(['vendorId', 'productId', 'variant']);
  });
  await knex.raw(`ALTER TABLE "VendorPurchaseLine"
    ADD CONSTRAINT vendorpurchaseline_qty_range CHECK (qty BETWEEN 1 AND 100000),
    ADD CONSTRAINT vendorpurchaseline_cost_range CHECK ("unitCostTzs" BETWEEN 0 AND 100000000),
    ADD CONSTRAINT vendorpurchaseline_total_exact CHECK ("lineTotalTzs"::bigint = qty::bigint * "unitCostTzs"::bigint),
    ADD CONSTRAINT vendorpurchaseline_previous_only_when_updated CHECK ("costUpdated" OR ("previousCostTzs" IS NULL AND "previousCostSourceId" IS NULL)),
    ADD CONSTRAINT vendorpurchaseline_previous_cost_range CHECK ("previousCostTzs" IS NULL OR "previousCostTzs" >= 0)`);

  await knex.schema.createTable('VendorPurchaseInstalment', (table) => {
    table.text('id').primary();
    table.text('purchaseId').notNullable().references('id').inTable('VendorPurchase').onDelete('CASCADE');
    table.text('vendorId').notNullable();
    table.integer('seq').notNullable();
    table.date('dueDate').notNullable();
    table.integer('amountTzs').notNullable();
    table.text('status').notNullable().defaultTo('active');
    table.timestamp('replacedAt', { precision: 3 });
    table.text('replacedBy');
    table.text('createdBy').notNullable();
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['purchaseId', 'seq']);
  });
  await knex.raw(`ALTER TABLE "VendorPurchaseInstalment"
    ADD CONSTRAINT vendorpurchaseinstalment_amount_positive CHECK ("amountTzs" >= 1),
    ADD CONSTRAINT vendorpurchaseinstalment_status_check CHECK (status IN ('active', 'replaced')),
    ADD CONSTRAINT vendorpurchaseinstalment_replaced_complete CHECK (
      (status = 'replaced' AND "replacedAt" IS NOT NULL AND "replacedBy" IS NOT NULL)
      OR (status = 'active' AND "replacedAt" IS NULL AND "replacedBy" IS NULL))`);
  await knex.raw(`CREATE INDEX vendorpurchaseinstalment_due_idx ON "VendorPurchaseInstalment" ("vendorId", "dueDate") WHERE status = 'active'`);

  await knex.schema.createTable('VendorPurchasePayment', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.text('purchaseId').notNullable();
    table.text('supplierId');
    table.integer('amountTzs').notNullable();
    table.date('paidOn').notNullable();
    table.text('method').notNullable();
    table.text('reference');
    table.text('note');
    table.boolean('atReceipt').notNullable().defaultTo(false);
    table.text('status').notNullable().defaultTo('recorded');
    table.text('clientRef').notNullable();
    table.text('fingerprint').notNullable();
    table.text('recordedBy').notNullable();
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.text('voidedBy');
    table.timestamp('voidedAt', { precision: 3 });
    table.text('voidReason');
    table.boolean('voidedWithPurchase').notNullable().defaultTo(false);
    table.unique(['vendorId', 'clientRef']);
    table.index(['vendorId', 'paidOn']);
    table.index(['purchaseId']);
  });
  await knex.raw(`ALTER TABLE "VendorPurchasePayment"
    ADD CONSTRAINT vendorpurchasepayment_purchase_fk FOREIGN KEY ("purchaseId", "vendorId") REFERENCES "VendorPurchase" (id, "vendorId") ON DELETE CASCADE,
    ADD CONSTRAINT vendorpurchasepayment_amount_positive CHECK ("amountTzs" >= 1),
    ADD CONSTRAINT vendorpurchasepayment_method_check CHECK (method IN (${list(METHODS)})),
    ADD CONSTRAINT vendorpurchasepayment_reference_length CHECK (reference IS NULL OR char_length(reference) <= 100),
    ADD CONSTRAINT vendorpurchasepayment_note_length CHECK (note IS NULL OR char_length(note) <= 200),
    ADD CONSTRAINT vendorpurchasepayment_status_check CHECK (status IN ('recorded', 'voided')),
    ADD CONSTRAINT vendorpurchasepayment_client_ref CHECK ("clientRef" ~ '^[A-Za-z0-9._:-]{8,106}$'),
    ADD CONSTRAINT vendorpurchasepayment_voided_complete CHECK (
      (status = 'voided' AND "voidedBy" IS NOT NULL AND "voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL)
      OR (status = 'recorded' AND "voidedBy" IS NULL AND "voidedAt" IS NULL AND "voidReason" IS NULL AND NOT "voidedWithPurchase"))`);

  await knex.raw(`ALTER TABLE "ProductPrivate"
    ADD COLUMN "costSourceId" text,
    ADD COLUMN "costUpdatedAt" timestamptz(3)`);

  await exports.addPurchasesPermission(knex);
};

/**
 * Permission `purchases` for staff who already act as the vendor's admins (Q-2: vendorRole admin only): their
 * User row, their vendor OrgMembership and pending vendor invitations for the admin role. Safe to repeat.
 * @param {import('knex').Knex} knex
 */
exports.addPurchasesPermission = async function addPurchasesPermission(knex) {
  const users = await knex.raw(`UPDATE "User" SET "vendorPermissions" = array_append(COALESCE("vendorPermissions", '{}'), 'purchases')
    WHERE "userType" = 'vendor_staff' AND "vendorRole" = 'admin'
      AND NOT ('purchases' = ANY(COALESCE("vendorPermissions", '{}'))) RETURNING id`);
  const memberships = await knex.raw(`UPDATE "OrgMembership" m SET "aclPermissions" = array_append(m."aclPermissions", 'purchases'), "updatedAt" = now()
    FROM "User" u WHERE m."orgType" = 'vendor' AND m.role = 'staff' AND m."personaId" = u.id
      AND u."userType" = 'vendor_staff' AND u."vendorRole" = 'admin'
      AND NOT ('purchases' = ANY(m."aclPermissions")) RETURNING m.id`);
  const invitations = await knex.raw(`UPDATE "Invitation" SET "aclPermissions" = array_append("aclPermissions", 'purchases'), "updatedAt" = now()
    WHERE "orgType" = 'vendor' AND status = 'pending' AND payload->>'vendorRole' = 'admin'
      AND NOT ('purchases' = ANY("aclPermissions")) RETURNING id`);
  console.log(`[migrate] vendor purchases: permission 'purchases' added to ${users.rows.length} admin staff, ${memberships.rows.length} membership(s), ${invitations.rows.length} pending invitation(s)`);
  return { users: users.rows.length, memberships: memberships.rows.length, invitations: invitations.rows.length };
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const purchases = Number((await knex.raw('SELECT count(*)::int AS n FROM "VendorPurchase"')).rows[0].n);
  if (purchases) {
    console.error(`[migrate] vendor-purchases down refused: ${purchases} purchase(s) exist`);
    throw new Error(`vendor-purchases down: ${purchases} purchase(s) exist; the stock and cost prices they changed cannot be explained without this migration`);
  }
  await knex.raw(`UPDATE "Invitation" SET "aclPermissions" = array_remove("aclPermissions", 'purchases') WHERE "orgType" = 'vendor' AND 'purchases' = ANY("aclPermissions")`);
  await knex.raw(`UPDATE "OrgMembership" SET "aclPermissions" = array_remove("aclPermissions", 'purchases') WHERE "orgType" = 'vendor' AND 'purchases' = ANY("aclPermissions")`);
  await knex.raw(`UPDATE "User" SET "vendorPermissions" = array_remove("vendorPermissions", 'purchases') WHERE "userType" = 'vendor_staff' AND 'purchases' = ANY(COALESCE("vendorPermissions", '{}'))`);
  await knex.raw('ALTER TABLE "ProductPrivate" DROP COLUMN IF EXISTS "costSourceId", DROP COLUMN IF EXISTS "costUpdatedAt"');
  await knex.schema.dropTableIfExists('VendorPurchasePayment');
  await knex.schema.dropTableIfExists('VendorPurchaseInstalment');
  await knex.schema.dropTableIfExists('VendorPurchaseLine');
  await knex.schema.dropTableIfExists('VendorPurchase');
  await knex.schema.dropTableIfExists('VendorSupplier');
  await knex.raw(`DELETE FROM "VendorDocumentSequence" WHERE "docType" = 'purchase'`);
};
