// Vendor business tools · S8 — barcodes on products (design docs/design/vendor-barcodes-s8.md §2.1, approved
// 2026-11-09 with Q-1..Q-5 as recommended). Additive.
//
// - ProductCode: a barcode the vendor put on one of their products, or on one variant of it (variant '' = the
//   whole product). `code` is what was typed or scanned (trimmed, for display); `codeKey` is the normalised key
//   (src/shared/vendor-barcode.mjs codeKey: UPC-A 12 → leading 0, GTIN-14 with a leading 0 → drop it, letters upper
//   case) and is what uniqueness and every lookup use. One codeKey per vendor; two vendors may hold the same code.
//   Codes are the vendor's private shop data: they are never on Product or Product.variants, never on /shop/*.
// - No backfill: no code exists before S8; SKUs stay SKUs (the lookup's SKU fallback finds them, B-9).
//
// The code reads this table only while VENDOR_TOOLS + VENDOR_STOCK_LEDGER + VENDOR_BARCODES are on, but the
// migration must run before the flag is switched on (run it with the deploy, before the code).
//
// Down: REFUSES while any ProductCode row exists (prints the count; S4/S7/S9 pattern), otherwise drops the table.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('ProductCode', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.text('productId').notNullable().references('id').inTable('Product').onDelete('CASCADE');
    table.text('variant').notNullable().defaultTo('');
    table.text('code').notNullable();
    table.text('codeKey').notNullable();
    table.text('createdBy').notNullable();
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE "ProductCode"
    ADD CONSTRAINT productcode_variant_length CHECK (char_length(variant) <= 60),
    ADD CONSTRAINT productcode_code_length CHECK (char_length(code) BETWEEN 4 AND 48),
    ADD CONSTRAINT productcode_codekey_length CHECK (char_length("codeKey") BETWEEN 4 AND 48)`);
  await knex.raw('CREATE UNIQUE INDEX productcode_vendor_codekey_unique ON "ProductCode" ("vendorId", "codeKey")');
  await knex.raw('CREATE INDEX productcode_vendor_product_idx ON "ProductCode" ("vendorId", "productId")');
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const exists = (await knex.raw(`SELECT to_regclass('"ProductCode"') AS t`)).rows[0].t;
  if (exists) {
    const n = Number((await knex.raw('SELECT count(*)::int AS n FROM "ProductCode"')).rows[0].n);
    if (n) {
      console.error(`[migrate] vendor-barcodes down refused: ${n} product code(s) exist`);
      throw new Error(`vendor-barcodes down: ${n} product code(s) exist; delete them first if they are really to be lost`);
    }
  }
  await knex.schema.dropTableIfExists('ProductCode');
};
