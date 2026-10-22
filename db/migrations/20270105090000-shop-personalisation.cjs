// Shop home Phase 2 · slice 2: personalisation (docs/shop-personalisation-api.md).
//
// - ShopPreference: one row per Person (or per user id when the account has no Person) holding the
//   "Personalised shop" switch. No row = on (owner decision 2026-10-20: on by default, one opt-out).
//   `source` = where the last change was made (privacy_page | why_sheet). Every change is also
//   written to AuditLog (shop_preference_changed).
// - Product.targetGender (women | men | null = everyone) and Product.targetAgeBands
//   (subset of 18_29, 30_44, 45_59, 60_plus; empty = all ages): optional vendor tags. They only
//   reorder products for adult members in member mode; they are not review fields.
//
// Dormant behind SHOP_PERSONALISATION. Additive and reversible: down drops the table, the checks and
// the two columns (vendor tags set meanwhile are lost).

const BANDS = ['18_29', '30_44', '45_59', '60_plus'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ShopPreference'))) {
    await knex.schema.createTable('ShopPreference', (t) => {
      // A Person id, or the user id of an account without a Person (subjectType says which).
      t.text('personId').primary();
      t.text('subjectType').notNullable().defaultTo('person');
      t.boolean('personalised').notNullable().defaultTo(true);
      t.text('source');
      t.text('updatedBy');
      t.timestamp('createdAt', { precision: 3, useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3, useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`ALTER TABLE "ShopPreference" ADD CONSTRAINT shoppreference_subject_chk CHECK ("subjectType" IN ('person','user'))`);
    await knex.raw(`ALTER TABLE "ShopPreference" ADD CONSTRAINT shoppreference_source_chk CHECK ("source" IS NULL OR "source" IN ('privacy_page','why_sheet'))`);
  }

  if (await knex.schema.hasTable('Product')) {
    if (!(await knex.schema.hasColumn('Product', 'targetGender'))) {
      await knex.schema.alterTable('Product', (t) => { t.text('targetGender'); });
      await knex.raw(`ALTER TABLE "Product" ADD CONSTRAINT product_target_gender_chk CHECK ("targetGender" IS NULL OR "targetGender" IN ('women','men'))`);
    }
    if (!(await knex.schema.hasColumn('Product', 'targetAgeBands'))) {
      await knex.raw(`ALTER TABLE "Product" ADD COLUMN "targetAgeBands" TEXT[] NOT NULL DEFAULT '{}'`);
      await knex.raw(`ALTER TABLE "Product" ADD CONSTRAINT product_target_age_bands_chk CHECK ("targetAgeBands" <@ ARRAY[${BANDS.map(b => `'${b}'`).join(',')}]::text[])`);
    }
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ShopPreference');
  if (await knex.schema.hasTable('Product')) {
    await knex.raw('ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS product_target_gender_chk');
    await knex.raw('ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS product_target_age_bands_chk');
    if (await knex.schema.hasColumn('Product', 'targetGender')) await knex.schema.alterTable('Product', (t) => { t.dropColumn('targetGender'); });
    if (await knex.schema.hasColumn('Product', 'targetAgeBands')) await knex.schema.alterTable('Product', (t) => { t.dropColumn('targetAgeBands'); });
  }
};
