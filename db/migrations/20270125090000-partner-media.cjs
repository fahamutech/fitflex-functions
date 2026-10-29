// Partner hero photo and logo (plan docs/plans/partner-hero-media-plan.md, design spec
// photo-hero-screens.md §39–§45; owner decisions 2026-10-29). Dormant behind PARTNER_MEDIA.
//
//   PartnerMedia      one uploaded photo ('hero') or logo of one partner: a gym, a trainer
//                     profile or a vendor. Shown at once (post-moderation, D-3):
//                       status        live → replaced (a newer upload) | removed (by the partner)
//                                     | taken_down (by FitFlex). All three are final.
//                       reviewState   to_review | reviewed (FitFlex's "Looks fine"); items FitFlex
//                                     sets itself start reviewed.
//                     The row is kept after the files are gone, for audit and for the partner's
//                     "taken down" notice. sha256 (of the uploaded bytes) is kept only on taken-down
//                     rows, to refuse the same file again (O-P2); it is cleared otherwise.
//   PartnerMediaFile  the cleaned bytes (bytea), one row per variant: master, the band files (x2/x1 or
//                     logo256/logo128) and the review previews (p240/p480/p960, made once at upload).
//                     Deleting the rows really deletes the image (D-1, O-P4: no evidence copy). Ids are
//                     random and never reused.
//   PartnerMediaUploadAttempt
//                     one row per upload attempt (made before the file is read, whatever the outcome):
//                     the per-person and per-partner daily caps count these (O-P5, security review M3).
//                     Rows older than two days are deleted by the nightly sweep.
//
// pixelSha256 is a hash of the decoded cleaned pixels, so a re-saved copy with other metadata is
// still recognised after a takedown (review L1). purgedAt marks rows of a partner that was deleted:
// their bytes, hashes and notes are gone and no read shows them again, even if an id is reused (M2).
//
// At most one live item per (subjectType, subjectId, kind), enforced by a partial unique index.
// Additive only; down drops both tables.

const list = values => values.map(v => `'${v}'`).join(', ');
const SUBJECT_TYPES = ['gym', 'trainer', 'vendor'];
const KINDS = ['hero', 'logo'];
const ORIGINS = ['partner', 'fitflex'];
const STATUSES = ['live', 'replaced', 'removed', 'taken_down'];
const REVIEW_STATES = ['to_review', 'reviewed'];
const PLATES = ['light', 'dark'];
const PLATE_CHOICES = ['auto', 'light', 'dark'];
const REASONS = ['inappropriate', 'rights', 'other_brand', 'not_own_logo', 'person_request', 'quality', 'other'];
const VARIANTS = ['master', 'x2', 'x1', 'logo256', 'logo128', 'p240', 'p480', 'p960'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3, useTz: true });
  if (!(await knex.schema.hasTable('PartnerMedia'))) {
    await knex.schema.createTable('PartnerMedia', (t) => {
      t.text('id').primary();
      t.text('subjectType').notNullable();
      t.text('subjectId').notNullable();
      t.text('kind').notNullable();
      t.text('origin').notNullable();
      t.text('status').notNullable().defaultTo('live');
      t.integer('revision').notNullable().defaultTo(1);
      t.text('reviewState').notNullable().defaultTo('to_review');
      t.text('reviewedBy');
      ts(t, 'reviewedAt');
      // Takedown (FitFlex): reason code, note to the partner, who and when.
      t.text('reason');
      t.text('reasonNote');
      t.text('decidedBy');
      ts(t, 'decidedAt');
      // Who ended a live item and when (replaced, removed or taken down).
      t.text('statusChangedBy');
      ts(t, 'statusChangedAt');
      t.integer('width').notNullable();
      t.integer('height').notNullable();
      t.decimal('focalX', 6, 3);
      t.decimal('focalY', 6, 3);
      // The brighter of the two text zones (photo manager §8.3), hero only.
      t.decimal('textZoneMean', 6, 3);
      t.decimal('textZonePatch', 6, 3);
      // Logo plate: the resolved tone and the uploader's choice; logoLuminance lets "auto" be worked out again.
      t.text('plate');
      t.text('plateChoice');
      t.decimal('logoLuminance', 6, 3);
      t.text('sha256');
      t.text('pixelSha256');
      ts(t, 'purgedAt');
      t.text('confirmationVersion').notNullable();
      t.text('rightsConfirmedBy').notNullable();
      ts(t, 'rightsConfirmedAt').notNullable();
      t.text('ownLogoConfirmedBy');
      ts(t, 'ownLogoConfirmedAt');
      t.text('uploadedBy').notNullable();
      t.text('uploadedByRole').notNullable();
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
      t.index(['subjectType', 'subjectId', 'kind', 'createdAt'], 'partner_media_subject_idx');
      t.index(['status', 'reviewState', 'createdAt'], 'partner_media_queue_idx');
    });
    const chk = (name, sql) => knex.raw(`ALTER TABLE "PartnerMedia" ADD CONSTRAINT ${name} CHECK (${sql})`);
    await chk('partner_media_subject_type_chk', `"subjectType" IN (${list(SUBJECT_TYPES)})`);
    await chk('partner_media_kind_chk', `"kind" IN (${list(KINDS)})`);
    await chk('partner_media_origin_chk', `"origin" IN (${list(ORIGINS)})`);
    await chk('partner_media_status_chk', `"status" IN (${list(STATUSES)})`);
    await chk('partner_media_review_chk', `"reviewState" IN (${list(REVIEW_STATES)})`);
    await chk('partner_media_reason_chk', `"reason" IS NULL OR "reason" IN (${list(REASONS)})`);
    await chk('partner_media_plate_chk', `("kind" = 'logo' AND "plate" IN (${list(PLATES)}) AND "plateChoice" IN (${list(PLATE_CHOICES)})) OR ("kind" <> 'logo' AND "plate" IS NULL AND "plateChoice" IS NULL AND "logoLuminance" IS NULL)`);
    await chk('partner_media_focal_chk', `("kind" = 'hero' AND "focalX" BETWEEN -1 AND 1 AND "focalY" BETWEEN -1 AND 1) OR ("kind" <> 'hero' AND "focalX" IS NULL AND "focalY" IS NULL)`);
    await chk('partner_media_takedown_chk', `"status" <> 'taken_down' OR ("reason" IS NOT NULL AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL)`);
    await chk('partner_media_note_len_chk', `"reasonNote" IS NULL OR char_length("reasonNote") <= 500`);
    // One live photo and one live logo per partner, at any moment.
    await knex.raw(`CREATE UNIQUE INDEX partner_media_one_live_uq ON "PartnerMedia" ("subjectType", "subjectId", "kind") WHERE "status" = 'live'`);
    // The O-P2 check: has this exact file been taken down for this partner before?
    await knex.raw(`CREATE INDEX partner_media_taken_down_sha_idx ON "PartnerMedia" ("subjectType", "subjectId", "sha256") WHERE "status" = 'taken_down'`);
    await knex.raw(`CREATE INDEX partner_media_taken_down_pixels_idx ON "PartnerMedia" ("subjectType", "subjectId", "pixelSha256") WHERE "status" = 'taken_down'`);
    await chk('partner_media_purged_chk', `"purgedAt" IS NULL OR ("status" <> 'live' AND "sha256" IS NULL AND "pixelSha256" IS NULL AND "reasonNote" IS NULL)`);
  }
  if (!(await knex.schema.hasTable('PartnerMediaFile'))) {
    await knex.schema.createTable('PartnerMediaFile', (t) => {
      t.text('id').primary();
      t.text('mediaId').notNullable().references('id').inTable('PartnerMedia').onDelete('CASCADE');
      t.text('variant').notNullable();
      t.text('contentType').notNullable();
      t.integer('byteLength').notNullable();
      t.integer('width').notNullable();
      t.integer('height').notNullable();
      t.binary('data').notNullable();
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      t.unique(['mediaId', 'variant'], { indexName: 'partner_media_file_variant_uq' });
    });
    await knex.raw(`ALTER TABLE "PartnerMediaFile" ADD CONSTRAINT partner_media_file_variant_chk CHECK ("variant" IN (${list(VARIANTS)}))`);
    await knex.raw(`ALTER TABLE "PartnerMediaFile" ADD CONSTRAINT partner_media_file_type_chk CHECK ("contentType" = 'image/webp')`);
    await knex.raw(`ALTER TABLE "PartnerMediaFile" ADD CONSTRAINT partner_media_file_len_chk CHECK ("byteLength" = octet_length("data"))`);
  }
  if (!(await knex.schema.hasTable('PartnerMediaUploadAttempt'))) {
    await knex.schema.createTable('PartnerMediaUploadAttempt', (t) => {
      t.text('id').primary();
      t.text('userId').notNullable();
      t.text('subjectType');
      t.text('subjectId');
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      t.index(['userId', 'createdAt'], 'partner_media_attempt_user_idx');
      t.index(['subjectType', 'subjectId', 'createdAt'], 'partner_media_attempt_subject_idx');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('PartnerMediaUploadAttempt');
  await knex.schema.dropTableIfExists('PartnerMediaFile');
  await knex.schema.dropTableIfExists('PartnerMedia');
};
