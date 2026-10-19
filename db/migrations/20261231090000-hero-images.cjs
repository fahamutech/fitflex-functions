// Admin-managed app photos (plan docs/plans/photo-hero-sections-footer-admin-plan.md, slice 4).
//
// - HeroImage: the photo library. `privateKey` is the private Zebra document key of the cleaned
//   master (rotated, metadata stripped); it never leaves the server. `variants` (public WebP/AVIF
//   files) is set only when the photo is first published.
// - HeroSlotDraft: the draft list of photos per slot (a named place in the app). Primary key
//   (slotId, imageId). An empty slot means "use the bundled photo".
// - HeroPublication: frozen snapshots of every slot. The app reads the latest; its id is the
//   manifest version and ETag. Rollback re-publishes an earlier snapshot (rolledBackFrom).
//
// Everything is dormant behind HERO_IMAGES_CMS. Additive and reversible: down drops the three tables.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('HeroImage'))) {
    await knex.schema.createTable('HeroImage', (t) => {
      t.text('id').primary();
      t.text('privateProvider').notNullable().defaultTo('zebra');
      t.text('privateKey').notNullable();
      t.text('sha256').notNullable();
      t.text('status').notNullable().defaultTo('draft');
      t.integer('width').notNullable();
      t.integer('height').notNullable();
      t.float('focalX').notNullable().defaultTo(0);
      t.float('focalY').notNullable().defaultTo(0);
      // { url2x, url1x, urlWide, urlAvif, bytes2x, bytes1x, bytesWide, bytesAvif, width2x, height2x, ... }
      t.jsonb('variants');
      // { vertical: { mean, maxPatch }, horizontal: { mean, maxPatch } } (relative luminance 0..1)
      t.jsonb('textZoneLuminance');
      t.text('source').notNullable();
      t.text('photographer').notNullable();
      t.text('licence').notNullable();
      t.text('licenceRef');
      t.text('people').notNullable();
      t.text('consentRef');
      t.text('rightsConfirmedBy').notNullable();
      t.timestamp('rightsConfirmedAt', { precision: 3 }).notNullable();
      t.text('noFacesConfirmedBy').notNullable();
      t.timestamp('noFacesConfirmedAt', { precision: 3 }).notNullable();
      t.text('createdBy').notNullable();
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`ALTER TABLE "HeroImage" ADD CONSTRAINT heroimage_status_chk CHECK ("status" IN ('draft','published','retired'))`);
    await knex.raw(`ALTER TABLE "HeroImage" ADD CONSTRAINT heroimage_people_chk CHECK ("people" IN ('none','hands_backs','unclear_faces'))`);
    await knex.raw(`ALTER TABLE "HeroImage" ADD CONSTRAINT heroimage_focal_chk CHECK ("focalX" BETWEEN -1 AND 1 AND "focalY" BETWEEN -1 AND 1)`);
    // A published photo always has its public files.
    await knex.raw(`ALTER TABLE "HeroImage" ADD CONSTRAINT heroimage_published_variants_chk CHECK ("status" <> 'published' OR "variants" IS NOT NULL)`);
  }
  if (!(await knex.schema.hasTable('HeroSlotDraft'))) {
    await knex.schema.createTable('HeroSlotDraft', (t) => {
      t.text('slotId').notNullable();
      t.text('imageId').notNullable().references('id').inTable('HeroImage').onDelete('CASCADE');
      t.integer('position').notNullable();
      t.text('updatedBy');
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.primary(['slotId', 'imageId']);
      t.unique(['slotId', 'position']);
    });
  }
  if (!(await knex.schema.hasTable('HeroPublication'))) {
    await knex.schema.createTable('HeroPublication', (t) => {
      t.bigIncrements('id').primary();
      // { [slotId]: [{ id, sourceId, url, url1x, urlWide, urlAvif, width, height, bytes, focal: { x, y } }] }
      t.jsonb('slots').notNullable();
      t.text('publishedBy').notNullable();
      t.timestamp('publishedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.text('note');
      t.bigInteger('rolledBackFrom').references('id').inTable('HeroPublication');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('HeroPublication');
  await knex.schema.dropTableIfExists('HeroSlotDraft');
  await knex.schema.dropTableIfExists('HeroImage');
};
