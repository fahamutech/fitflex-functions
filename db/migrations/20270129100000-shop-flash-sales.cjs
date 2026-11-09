// Shop home Phase 2 · slice 4: flash sales (contract docs/shop-flash-sales-api.md; design spec
// docs/design/shop-home-phase2.md §8 in the parent repo).
//
// - FlashSale: a time-limited sale price on one product, proposed by its vendor (origin 'vendor') or
//   created by FitFlex staff (origin 'staff'; no vendor consent needed, owner 2026-10-20). Same
//   stored states as ShopBanner: draft | pending_approval | approved | ended | rejected | withdrawn |
//   expired. "live" is never stored: an approved sale is live while now is inside [startsAt, endsAt).
//   wasPriceTzs = the product's priceTzs when it was approved (the struck "was" price).
// - One APPROVED sale per product at a time, enforced here: an exclusion constraint on
//   (productId, [startsAt, endsAt)) for approved rows (btree_gist). Where that extension cannot be
//   created, an equivalent trigger (per-product advisory lock + overlap check) raises the same
//   SQLSTATE 23P01.
// - ProductPriceChange: every change of Product.priceTzs / discountPriceTzs, written by a trigger so
//   no code path can skip it (the 14-day "price raised recently" rule and the admin price history).
//   Bookkeeping only: written whether or not SHOP_FLASH_SALES is on.
// - History baseline (owner ruling 2026-10-29 (b)): a sale may not start until 14 days after the
//   product's FIRST price row. Every product that exists when this runs gets one baseline row
//   (source 'migration_baseline', at = now), so existing products are treated like new ones: no
//   sale before 14 days after this migration. AuditLog cannot be used to backdate it safely —
//   vendor price edits were never audited (only admin-created products are), so it would miss raises.
//
// Dormant behind SHOP_FLASH_SALES. Additive and reversible: down drops both tables, the triggers and
// their functions (btree_gist is left installed; it changes nothing on its own).

const EXCLUDE = `ALTER TABLE "FlashSale" ADD CONSTRAINT flashsale_one_approved_per_product
  EXCLUDE USING gist ("productId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("status" = 'approved')`;

const OVERLAP_FN = `CREATE OR REPLACE FUNCTION fitflex_flash_sale_no_overlap() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'approved' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('flash_sale_overlap:' || NEW."productId"));
  IF EXISTS (SELECT 1 FROM "FlashSale" f WHERE f."productId" = NEW."productId" AND f."id" <> NEW."id"
      AND f."status" = 'approved' AND f."startsAt" < NEW."endsAt" AND NEW."startsAt" < f."endsAt") THEN
    RAISE EXCEPTION 'flash sale overlaps another approved sale of product %', NEW."productId"
      USING ERRCODE = '23P01', CONSTRAINT = 'flashsale_one_approved_per_product';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql`;

const PRICE_FN = `CREATE OR REPLACE FUNCTION fitflex_product_price_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "ProductPriceChange" ("productId", "field", "fromTzs", "toTzs", "at")
      VALUES (NEW."id", 'priceTzs', NULL, NEW."priceTzs", clock_timestamp());
    IF COALESCE(NEW."discountPriceTzs", 0) <> 0 THEN
      INSERT INTO "ProductPriceChange" ("productId", "field", "fromTzs", "toTzs", "at")
        VALUES (NEW."id", 'discountPriceTzs', NULL, NEW."discountPriceTzs", clock_timestamp());
    END IF;
    RETURN NULL;
  END IF;
  IF OLD."priceTzs" IS DISTINCT FROM NEW."priceTzs" THEN
    INSERT INTO "ProductPriceChange" ("productId", "field", "fromTzs", "toTzs", "at")
      VALUES (NEW."id", 'priceTzs', OLD."priceTzs", NEW."priceTzs", clock_timestamp());
  END IF;
  IF OLD."discountPriceTzs" IS DISTINCT FROM NEW."discountPriceTzs" THEN
    INSERT INTO "ProductPriceChange" ("productId", "field", "fromTzs", "toTzs", "at")
      VALUES (NEW."id", 'discountPriceTzs', OLD."discountPriceTzs", NEW."discountPriceTzs", clock_timestamp());
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ProductPriceChange'))) {
    await knex.schema.createTable('ProductPriceChange', (t) => {
      t.bigIncrements('id').primary();
      t.text('productId').notNullable();
      t.text('field').notNullable();
      t.integer('fromTzs');
      t.integer('toTzs');
      t.timestamp('at', { precision: 3, useTz: true }).notNullable().defaultTo(knex.fn.now());
      // 'trigger' (a real change) | 'migration_baseline' (the price a product already had when history began).
      t.text('source').notNullable().defaultTo('trigger');
      t.index(['productId', 'at']);
    });
    await knex.raw(`ALTER TABLE "ProductPriceChange" ADD CONSTRAINT productpricechange_field_chk CHECK ("field" IN ('priceTzs','discountPriceTzs'))`);
    await knex.raw(`ALTER TABLE "ProductPriceChange" ADD CONSTRAINT productpricechange_source_chk CHECK ("source" IN ('trigger','migration_baseline'))`);
    await knex.raw(`INSERT INTO "ProductPriceChange" ("productId", "field", "fromTzs", "toTzs", "at", "source")
      SELECT "id", 'priceTzs', NULL, "priceTzs", now(), 'migration_baseline' FROM "Product"`);
  }
  await knex.raw(PRICE_FN);
  await knex.raw('DROP TRIGGER IF EXISTS product_price_change ON "Product"');
  await knex.raw(`CREATE TRIGGER product_price_change AFTER INSERT OR UPDATE OF "priceTzs", "discountPriceTzs" ON "Product"
    FOR EACH ROW EXECUTE FUNCTION fitflex_product_price_change()`);

  if (!(await knex.schema.hasTable('FlashSale'))) {
    await knex.schema.createTable('FlashSale', (t) => {
      t.text('id').primary();
      t.text('origin').notNullable();
      t.text('vendorId').notNullable();
      t.text('productId').notNullable().references('id').inTable('Product');
      t.integer('salePriceTzs').notNullable();
      // The product's priceTzs when approved: the struck "was" price. Null until approved.
      t.integer('wasPriceTzs');
      // The product's prices when the sale was last sent: approval is refused if they moved since.
      t.integer('regularPriceTzsAtSubmit');
      t.integer('discountPriceTzsAtSubmit');
      t.timestamp('startsAt', { precision: 3, useTz: true }).notNullable();
      t.timestamp('endsAt', { precision: 3, useTz: true }).notNullable();
      t.text('status').notNullable().defaultTo('draft');
      t.text('statusReason');
      t.text('statusReasonNote');
      t.timestamp('statusChangedAt', { precision: 3, useTz: true });
      t.timestamp('expiresAt', { precision: 3, useTz: true });
      // +1 on every edit: approve/reject must name the revision reviewed.
      t.integer('revision').notNullable().defaultTo(1);
      // Everyone who created, edited or sent it: none of them may approve or reject it.
      t.jsonb('editors').notNullable().defaultTo('[]');
      t.text('createdBy').notNullable();
      t.text('submittedBy');
      t.timestamp('submittedAt', { precision: 3, useTz: true });
      t.text('approvedBy');
      t.timestamp('approvedAt', { precision: 3, useTz: true });
      t.text('decidedBy');
      t.timestamp('decidedAt', { precision: 3, useTz: true });
      t.text('endedBy');
      t.timestamp('endedAt', { precision: 3, useTz: true });
      t.timestamp('createdAt', { precision: 3, useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3, useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['productId', 'status']);
      t.index(['vendorId', 'createdAt']);
      t.index(['status', 'endsAt']);
    });
    await knex.raw(`ALTER TABLE "FlashSale" ADD CONSTRAINT flashsale_origin_chk CHECK ("origin" IN ('vendor','staff'))`);
    await knex.raw(`ALTER TABLE "FlashSale" ADD CONSTRAINT flashsale_status_chk CHECK ("status" IN ('draft','pending_approval','approved','ended','rejected','withdrawn','expired'))`);
    await knex.raw(`ALTER TABLE "FlashSale" ADD CONSTRAINT flashsale_price_chk CHECK ("salePriceTzs" > 0)`);
    await knex.raw(`ALTER TABLE "FlashSale" ADD CONSTRAINT flashsale_window_chk CHECK ("endsAt" > "startsAt")`);
    await knex.raw(`ALTER TABLE "FlashSale" ADD CONSTRAINT flashsale_approved_complete_chk CHECK ("status" <> 'approved' OR ("approvedBy" IS NOT NULL AND "wasPriceTzs" IS NOT NULL AND "salePriceTzs" < "wasPriceTzs"))`);

    // One approved sale per product at a time. Prefer the exclusion constraint; fall back to the trigger.
    await knex.raw('SAVEPOINT flash_sale_gist');
    try {
      await knex.raw('CREATE EXTENSION IF NOT EXISTS btree_gist');
      await knex.raw(EXCLUDE);
      await knex.raw('RELEASE SAVEPOINT flash_sale_gist');
    } catch (err) {
      await knex.raw('ROLLBACK TO SAVEPOINT flash_sale_gist');
      console.warn(`[migrate] flash sales: btree_gist unavailable (${err.message}); using the overlap trigger instead`);
      await knex.raw(OVERLAP_FN);
      await knex.raw(`CREATE TRIGGER flash_sale_no_overlap BEFORE INSERT OR UPDATE ON "FlashSale"
        FOR EACH ROW EXECUTE FUNCTION fitflex_flash_sale_no_overlap()`);
    }
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS flash_sale_no_overlap ON "FlashSale"');
  await knex.schema.dropTableIfExists('FlashSale');
  await knex.raw('DROP FUNCTION IF EXISTS fitflex_flash_sale_no_overlap()');
  await knex.raw('DROP TRIGGER IF EXISTS product_price_change ON "Product"');
  await knex.raw('DROP FUNCTION IF EXISTS fitflex_product_price_change()');
  await knex.schema.dropTableIfExists('ProductPriceChange');
};

// For specs: the fallback trigger used where btree_gist is unavailable (tested on its own).
exports.OVERLAP_FALLBACK_SQL = OVERLAP_FN;
