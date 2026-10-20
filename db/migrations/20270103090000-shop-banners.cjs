// Shop home Phase 2 · slice 1: hero banners (design spec docs/design/shop-home-phase2.md §5, parent repo).
//
// - ShopBanner: a banner proposed by a vendor (origin 'vendor') or created by FitFlex staff
//   (origin 'staff'). Texts are { en, sw } (both required). `status` is the stored state:
//   draft | pending_approval | approved | ended | rejected | withdrawn | expired. "live" is never
//   stored: it is an approved banner inside its window, worked out on every read.
//   `expiresAt` = when an undecided proposal expires: the earlier of submittedAt +
//   SHOP_PROPOSAL_EXPIRY_DAYS (14) and startsAt; set at each submit.
//   `position` is set by the approver (lower first; null = after the numbered ones).
// - HeroImage gets two nullable columns so banner photos go through the same cleaning pipeline
//   (rotated upright, EXIF/GPS stripped, private until approved): `purpose` (null or 'hero' =
//   an app photo, 'shop_banner' = a banner photo) and `vendorId` (who uploaded it, vendor banners).
//   `people` may now also be 'product_models' (models showing a product), only on banner photos.
//   The hero library never lists or accepts banner photos.
//
// Dormant behind SHOP_BANNERS. Additive and reversible: down drops ShopBanner, removes the banner
// photo rows (their private files stay on Zebra, which cannot delete) and the two columns, and
// puts the people check back.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const hasHero = await knex.schema.hasTable('HeroImage');
  if (hasHero) {
    if (!(await knex.schema.hasColumn('HeroImage', 'purpose'))) {
      await knex.schema.alterTable('HeroImage', (t) => { t.text('purpose'); });
      await knex.raw(`ALTER TABLE "HeroImage" ADD CONSTRAINT heroimage_purpose_chk CHECK ("purpose" IS NULL OR "purpose" IN ('hero','shop_banner'))`);
    }
    if (!(await knex.schema.hasColumn('HeroImage', 'vendorId'))) {
      await knex.schema.alterTable('HeroImage', (t) => { t.text('vendorId'); });
    }
    await knex.raw('ALTER TABLE "HeroImage" DROP CONSTRAINT IF EXISTS heroimage_people_chk');
    await knex.raw(`ALTER TABLE "HeroImage" ADD CONSTRAINT heroimage_people_chk CHECK ("people" IN ('none','hands_backs','unclear_faces','product_models'))`);
    // Models in product shots are a banner rule only; app photos keep their own list.
    await knex.raw('ALTER TABLE "HeroImage" DROP CONSTRAINT IF EXISTS heroimage_models_banner_only_chk');
    await knex.raw(`ALTER TABLE "HeroImage" ADD CONSTRAINT heroimage_models_banner_only_chk CHECK ("people" <> 'product_models' OR COALESCE("purpose", 'hero') = 'shop_banner')`);
    await knex.raw('CREATE INDEX IF NOT EXISTS heroimage_purpose_idx ON "HeroImage" ("purpose")');
  }

  if (!(await knex.schema.hasTable('ShopBanner'))) {
    await knex.schema.createTable('ShopBanner', (t) => {
      t.text('id').primary();
      t.text('origin').notNullable();
      t.text('vendorId');
      t.text('imageId');
      if (hasHero) t.foreign('imageId').references('id').inTable('HeroImage');
      t.jsonb('headlineLead');
      t.jsonb('headlineAccent');
      t.jsonb('subline');
      t.jsonb('ctaLabel');
      t.jsonb('imageAlt');
      // { type: product | vendor_store | category | results, value }
      t.jsonb('target');
      t.jsonb('audienceRoles').notNullable().defaultTo(JSON.stringify(['member', 'trainer', 'owner']));
      t.timestamp('startsAt', { precision: 3, useTz: true });
      t.timestamp('endsAt', { precision: 3, useTz: true });
      t.integer('position');
      t.text('status').notNullable().defaultTo('draft');
      t.text('statusReason');
      t.text('statusReasonCode');
      t.timestamp('statusChangedAt', { precision: 3, useTz: true });
      t.timestamp('expiresAt', { precision: 3, useTz: true });
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
      t.index(['status', 'endsAt']);
      t.index(['vendorId', 'createdAt']);
    });
    await knex.raw(`ALTER TABLE "ShopBanner" ADD CONSTRAINT shopbanner_origin_chk CHECK ("origin" IN ('vendor','staff'))`);
    await knex.raw(`ALTER TABLE "ShopBanner" ADD CONSTRAINT shopbanner_vendor_chk CHECK (("origin" = 'vendor') = ("vendorId" IS NOT NULL))`);
    await knex.raw(`ALTER TABLE "ShopBanner" ADD CONSTRAINT shopbanner_status_chk CHECK ("status" IN ('draft','pending_approval','approved','ended','rejected','withdrawn','expired'))`);
    await knex.raw(`ALTER TABLE "ShopBanner" ADD CONSTRAINT shopbanner_window_chk CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt")`);
    // Approved banners always have their photo and both dates.
    await knex.raw(`ALTER TABLE "ShopBanner" ADD CONSTRAINT shopbanner_approved_complete_chk CHECK ("status" <> 'approved' OR ("imageId" IS NOT NULL AND "startsAt" IS NOT NULL AND "endsAt" IS NOT NULL AND "approvedBy" IS NOT NULL))`);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ShopBanner');
  if (!(await knex.schema.hasTable('HeroImage'))) return;
  if (await knex.schema.hasColumn('HeroImage', 'purpose')) {
    // Banner photos only exist for banners; app photos are untouched.
    await knex('HeroImage').where({ purpose: 'shop_banner' }).del();
  }
  // 'product_models' does not exist before this migration.
  await knex('HeroImage').where({ people: 'product_models' }).del();
  await knex.raw('ALTER TABLE "HeroImage" DROP CONSTRAINT IF EXISTS heroimage_models_banner_only_chk');
  await knex.raw('ALTER TABLE "HeroImage" DROP CONSTRAINT IF EXISTS heroimage_people_chk');
  await knex.raw(`ALTER TABLE "HeroImage" ADD CONSTRAINT heroimage_people_chk CHECK ("people" IN ('none','hands_backs','unclear_faces'))`);
  await knex.raw('DROP INDEX IF EXISTS heroimage_purpose_idx');
  await knex.raw('ALTER TABLE "HeroImage" DROP CONSTRAINT IF EXISTS heroimage_purpose_chk');
  if (await knex.schema.hasColumn('HeroImage', 'purpose')) await knex.schema.alterTable('HeroImage', (t) => { t.dropColumn('purpose'); });
  if (await knex.schema.hasColumn('HeroImage', 'vendorId')) await knex.schema.alterTable('HeroImage', (t) => { t.dropColumn('vendorId'); });
};
