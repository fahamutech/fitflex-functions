// Vendor business tools · S4 — vendor customers, pay-later (credit) sales, customer payments,
// balances and aging (design spec docs/design/vendor-customers-s4.md; decisions 2026-10-20).
//
// - VendorCustomer: a customer of ONE vendor. source manual (walk-in, entered and owned by the
//   vendor: name, phone, email, address, note) or marketplace (an app buyer). A-02: a marketplace
//   customer holds only buyerUserId + a name snapshot; the CHECK below makes phone, email and
//   address impossible on it. Its id is the buyer's VendorBuyerRef.customerId (S2), so the
//   `buyer.customerId` on a vendor's order opens this record. Archive only (no delete, Q-8).
//   Unique (id, vendorId) lets every child row reference (customerId, vendorId): a sale or a
//   payment can never point at another vendor's customer.
// - VendorSale (S3) gains:
//     allocatedTzs = Σ live customer-payment allocations to the sale.
//   Balance is KEPT ON THE SALE, in the same transaction as each payment, allocation and void:
//   a payment allocation moves money from balanceTzs to paidTzs (and adds it to allocatedTzs), a
//   payment void moves it back. So the S3 CHECK paidTzs − changeTzs + balanceTzs = totalTzs keeps
//   holding unchanged, balanceTzs is always the current outstanding amount, and the money paid at
//   the counter is paidTzs − allocatedTzs. New CHECKs: 0 ≤ allocatedTzs ≤ paidTzs; a cash sale has
//   no balance, no allocations and no due date; a credit sale has a customer, a due date and no
//   change. FK (customerId, vendorId) → VendorCustomer(id, vendorId).
//   A voided credit sale keeps the balance it had when voided; it is never counted as owed.
// - VendorCustomerPayment: money the customer paid the vendor directly (FitFlex never holds it).
//   number = PMT-000001…, continuous per vendor (VendorDocumentSequence docType customer_payment,
//   issued in the payment's transaction). clientRef = idempotency key (unique per vendor).
//   receivedOn = EAT day the vendor received it (≤ 30 days back, Q-4); createdAt = recorded time.
//   status recorded|voided (voidedAt, voidedBy, voidReason).
// - VendorPaymentAllocation: which sales a payment paid, and how much. voidedAt is set when the
//   payment is voided (the row stays as history).
// - VendorOverdueDigest: (vendorId, EAT day) → the overdue digest was sent; once per vendor per day.
//
// Backfill (Q-6, idempotent): a marketplace customer for every (vendor, buyer) with a paid order.
//
// Down: drops the new tables, constraints, column and indexes. Credit sales cannot exist before
// this migration, so down refuses while any credit sale exists (it would break the S3 schema).

const METHODS = ['cash', 'mpesa', 'airtel_money', 'mixx', 'halopesa', 'card', 'bank', 'other'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('VendorCustomer', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.text('source').notNullable();
    table.text('buyerUserId');
    table.text('name');
    table.text('phone');
    table.text('email');
    table.text('address');
    table.text('note');
    table.timestamp('lastPurchaseAt', { precision: 3 });
    table.timestamp('archivedAt', { precision: 3 });
    table.text('archivedBy');
    table.text('createdBy').notNullable();
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['id', 'vendorId']);
    table.index(['vendorId', 'phone']);
  });
  await knex.raw(`ALTER TABLE "VendorCustomer"
    ADD CONSTRAINT vendorcustomer_source_check CHECK (source IN ('manual', 'marketplace')),
    ADD CONSTRAINT vendorcustomer_a02 CHECK (
      (source = 'marketplace' AND "buyerUserId" IS NOT NULL AND phone IS NULL AND email IS NULL AND address IS NULL)
      OR (source = 'manual' AND "buyerUserId" IS NULL AND name IS NOT NULL)),
    ADD CONSTRAINT vendorcustomer_name_length CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 120),
    ADD CONSTRAINT vendorcustomer_phone_format CHECK (phone IS NULL OR phone ~ '^\\+255[0-9]{9}$'),
    ADD CONSTRAINT vendorcustomer_email_length CHECK (email IS NULL OR char_length(email) <= 254),
    ADD CONSTRAINT vendorcustomer_address_length CHECK (address IS NULL OR char_length(address) <= 200),
    ADD CONSTRAINT vendorcustomer_note_length CHECK (note IS NULL OR char_length(note) <= 500),
    ADD CONSTRAINT vendorcustomer_archived_complete CHECK (("archivedAt" IS NULL) = ("archivedBy" IS NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX vendorcustomer_vendor_buyer_unique ON "VendorCustomer" ("vendorId", "buyerUserId") WHERE "buyerUserId" IS NOT NULL`);
  await knex.raw(`CREATE INDEX vendorcustomer_vendor_name_idx ON "VendorCustomer" ("vendorId", lower(name), id)`);

  await knex.schema.alterTable('VendorSale', (table) => {
    table.integer('allocatedTzs').notNullable().defaultTo(0);
  });
  await knex.raw(`ALTER TABLE "VendorSale"
    ADD CONSTRAINT vendorsale_id_vendor_unique UNIQUE (id, "vendorId"),
    ADD CONSTRAINT vendorsale_allocated_range CHECK ("allocatedTzs" >= 0 AND "allocatedTzs" <= "paidTzs"),
    ADD CONSTRAINT vendorsale_kind_rules CHECK (
      (kind = 'cash' AND "balanceTzs" = 0 AND "allocatedTzs" = 0 AND "dueDate" IS NULL)
      OR (kind = 'credit' AND "changeTzs" = 0 AND "customerId" IS NOT NULL AND "dueDate" IS NOT NULL)),
    ADD CONSTRAINT vendorsale_customer_fk FOREIGN KEY ("customerId", "vendorId") REFERENCES "VendorCustomer" (id, "vendorId")`);
  await knex.raw(`CREATE INDEX vendorsale_customer_idx ON "VendorSale" ("vendorId", "customerId", "soldAt") WHERE "customerId" IS NOT NULL`);
  await knex.raw(`CREATE INDEX vendorsale_open_credit_idx ON "VendorSale" ("vendorId", "customerId", "dueDate")
    WHERE kind = 'credit' AND status = 'completed' AND "balanceTzs" > 0`);

  await knex.schema.createTable('VendorCustomerPayment', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.text('customerId').notNullable();
    table.integer('seq').notNullable();
    table.text('number').notNullable();
    table.integer('amountTzs').notNullable();
    table.text('method').notNullable();
    table.text('reference');
    table.date('receivedOn').notNullable();
    table.text('note');
    table.text('clientRef').notNullable();
    table.text('fingerprint').notNullable();
    table.text('status').notNullable().defaultTo('recorded');
    table.text('recordedBy').notNullable();
    table.text('voidedBy');
    table.timestamp('voidedAt', { precision: 3 });
    table.text('voidReason');
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['vendorId', 'clientRef']);
    table.unique(['vendorId', 'number']);
    table.unique(['vendorId', 'seq']);
    table.unique(['id', 'vendorId']);
    table.index(['vendorId', 'customerId', 'receivedOn']);
  });
  await knex.raw(`ALTER TABLE "VendorCustomerPayment"
    ADD CONSTRAINT vendorcustomerpayment_customer_fk FOREIGN KEY ("customerId", "vendorId") REFERENCES "VendorCustomer" (id, "vendorId"),
    ADD CONSTRAINT vendorcustomerpayment_method_check CHECK (method IN (${list(METHODS)})),
    ADD CONSTRAINT vendorcustomerpayment_amount_positive CHECK ("amountTzs" > 0),
    ADD CONSTRAINT vendorcustomerpayment_reference_length CHECK (reference IS NULL OR char_length(reference) <= 100),
    ADD CONSTRAINT vendorcustomerpayment_note_length CHECK (note IS NULL OR char_length(note) <= 200),
    ADD CONSTRAINT vendorcustomerpayment_status_check CHECK (status IN ('recorded', 'voided')),
    ADD CONSTRAINT vendorcustomerpayment_void_reason_length CHECK ("voidReason" IS NULL OR char_length("voidReason") BETWEEN 3 AND 200),
    ADD CONSTRAINT vendorcustomerpayment_voided_complete CHECK (
      (status = 'voided' AND "voidedAt" IS NOT NULL AND "voidedBy" IS NOT NULL AND "voidReason" IS NOT NULL)
      OR (status = 'recorded' AND "voidedAt" IS NULL AND "voidedBy" IS NULL AND "voidReason" IS NULL))`);

  await knex.schema.createTable('VendorPaymentAllocation', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.text('paymentId').notNullable();
    table.text('saleId').notNullable();
    table.integer('position').notNullable();
    table.integer('amountTzs').notNullable();
    table.timestamp('voidedAt', { precision: 3 });
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.unique(['paymentId', 'saleId']);
    table.unique(['paymentId', 'position']);
  });
  await knex.raw(`ALTER TABLE "VendorPaymentAllocation"
    ADD CONSTRAINT vendorpaymentallocation_payment_fk FOREIGN KEY ("paymentId", "vendorId") REFERENCES "VendorCustomerPayment" (id, "vendorId") ON DELETE CASCADE,
    ADD CONSTRAINT vendorpaymentallocation_sale_fk FOREIGN KEY ("saleId", "vendorId") REFERENCES "VendorSale" (id, "vendorId") ON DELETE CASCADE,
    ADD CONSTRAINT vendorpaymentallocation_amount_positive CHECK ("amountTzs" > 0)`);
  await knex.raw(`CREATE INDEX vendorpaymentallocation_live_sale_idx ON "VendorPaymentAllocation" ("saleId") WHERE "voidedAt" IS NULL`);

  await knex.schema.createTable('VendorOverdueDigest', (table) => {
    table.text('vendorId').notNullable();
    table.date('day').notNullable();
    table.integer('count').notNullable();
    table.bigInteger('totalTzs').notNullable();
    table.integer('recipients').notNullable().defaultTo(0);
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.primary(['vendorId', 'day']);
  });

  await exports.backfillMarketplaceCustomers(knex);
};

/**
 * Q-6: a marketplace customer for every (vendor, buyer) pair with a paid order (paid, or paid and
 * later refunded). Its id is the pair's VendorBuyerRef.customerId (created when missing). Holds only
 * buyerUserId + the buyer's display name (A-02). Safe to repeat: the name is refreshed and
 * lastPurchaseAt only moves forward.
 * @param {import('knex').Knex} knex
 */
exports.backfillMarketplaceCustomers = async function backfillMarketplaceCustomers(knex) {
  const PAIRS = `SELECT item->>'vendorId' AS "vendorId", o."buyerId", max(o."createdAt") AS "lastAt"
      FROM "ShopOrder" o
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.items) = 'array' THEN o.items ELSE '[]'::jsonb END) item
     WHERE o."paymentStatus" IN ('paid', 'refund_pending', 'refunded') AND COALESCE(item->>'vendorId', '') <> ''
     GROUP BY 1, 2`;
  const refs = await knex.raw(`INSERT INTO "VendorBuyerRef" ("vendorId", "buyerId", "customerId", "createdAt")
    SELECT p."vendorId", p."buyerId", 'cus_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), now() FROM (${PAIRS}) p
    ON CONFLICT ("vendorId", "buyerId") DO NOTHING RETURNING "customerId"`);
  const customers = await knex.raw(`INSERT INTO "VendorCustomer" (id, "vendorId", source, "buyerUserId", name, "lastPurchaseAt", "createdBy", "createdAt", "updatedAt")
    SELECT r."customerId", p."vendorId", 'marketplace', p."buyerId", left(NULLIF(btrim(u."displayName"), ''), 120), p."lastAt", 'system:backfill', now(), now()
      FROM (${PAIRS}) p
      JOIN "VendorBuyerRef" r ON r."vendorId" = p."vendorId" AND r."buyerId" = p."buyerId"
      LEFT JOIN "User" u ON u.id = p."buyerId"
    ON CONFLICT ("vendorId", "buyerUserId") WHERE "buyerUserId" IS NOT NULL DO UPDATE
      SET name = EXCLUDED.name,
          "lastPurchaseAt" = GREATEST("VendorCustomer"."lastPurchaseAt", EXCLUDED."lastPurchaseAt"),
          "updatedAt" = CASE WHEN "VendorCustomer".name IS DISTINCT FROM EXCLUDED.name THEN now() ELSE "VendorCustomer"."updatedAt" END
    RETURNING (xmax = 0) AS inserted`);
  const inserted = customers.rows.filter(r => r.inserted).length;
  console.log(`[migrate] vendor customers: ${inserted} app customer(s) created, ${customers.rows.length - inserted} refreshed, ${refs.rows.length} buyer ref(s) created`);
  return { created: inserted, refreshed: customers.rows.length - inserted, refs: refs.rows.length };
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const credit = (await knex.raw(`SELECT count(*)::int AS n FROM "VendorSale" WHERE kind = 'credit'`)).rows[0].n;
  if (credit) throw new Error(`vendor-customers down: ${credit} pay-later sale(s) exist; they cannot be kept without this migration`);
  await knex.schema.dropTableIfExists('VendorOverdueDigest');
  await knex.schema.dropTableIfExists('VendorPaymentAllocation');
  await knex.schema.dropTableIfExists('VendorCustomerPayment');
  await knex.raw('DROP INDEX IF EXISTS vendorsale_open_credit_idx');
  await knex.raw('DROP INDEX IF EXISTS vendorsale_customer_idx');
  await knex.raw(`ALTER TABLE "VendorSale"
    DROP CONSTRAINT IF EXISTS vendorsale_customer_fk,
    DROP CONSTRAINT IF EXISTS vendorsale_kind_rules,
    DROP CONSTRAINT IF EXISTS vendorsale_allocated_range,
    DROP CONSTRAINT IF EXISTS vendorsale_id_vendor_unique`);
  await knex.raw(`UPDATE "VendorSale" SET "customerId" = NULL WHERE "customerId" IS NOT NULL`);
  await knex.schema.alterTable('VendorSale', (table) => { table.dropColumn('allocatedTzs'); });
  await knex.schema.dropTableIfExists('VendorCustomer');
  await knex.raw(`DELETE FROM "VendorDocumentSequence" WHERE "docType" = 'customer_payment'`);
};
