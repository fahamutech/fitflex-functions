// Marathon & running events · S6 (3 of 3) — organizer-uploaded medal artwork (D54 as changed).
// Design: docs/design/events-s6-runs-results-medals-rewards.md §7.7.
//
// - EventMedalArt: one row per upload, `live` | `replaced` | `removed` | `taken_down` (all but live are final); one live row
//   per template; rights confirmation (version, user, time); sha256 / pixelSha256 / dHash (a 64-bit perceptual hash) are written ONLY when FitFlex takes a file
//   down, so the same file (or a re-saved copy) is refused afterwards.
// - EventMedalArtFile: the bytes (WebP only) in the database like partner media; deleting the rows deletes the image.
// - EventMedalArtUploadAttempt: one row per attempt, written BEFORE the body is read (caps count refusals too).
// - EventMedalTemplate.artId → the live art row (SET NULL = built-in fallback).
//
// Additive; dormant behind EVENTS_MEDAL_ART. Down FAILS CLOSED once any artwork row exists.

const STATUSES = ['live', 'replaced', 'removed', 'taken_down'];
const VARIANTS = ['master', 'm512', 'm256', 'm128', 'p240', 'p480'];
const TAKEDOWN_REASONS = ['inappropriate', 'rights', 'other_brand', 'person_request', 'quality', 'other'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('EventMedalArt', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('organizerId').notNullable().references('id').inTable('EventOrganizer').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('templateId').notNullable();
    t.text('status').notNullable().defaultTo('live');
    t.integer('revision').notNullable().defaultTo(1);
    t.text('reviewState').notNullable().defaultTo('to_review');
    t.text('reviewedBy');
    t.timestamp('reviewedAt', { precision: 3 });
    t.text('reason');
    t.text('reasonNote');
    t.text('decidedBy');
    t.timestamp('decidedAt', { precision: 3 });
    t.text('statusChangedBy');
    t.timestamp('statusChangedAt', { precision: 3 });
    t.integer('width').notNullable();
    t.integer('height').notNullable();
    t.jsonb('altText').notNullable().defaultTo('{}');
    t.text('confirmationVersion').notNullable();
    t.text('confirmedBy');
    t.timestamp('confirmedAt', { precision: 3 }).notNullable();
    t.text('uploadedBy');
    t.text('sha256');
    t.text('pixelSha256');
    t.text('dHash');
    t.timestamp('purgedAt', { precision: 3 });
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.index(['eventId']);
    t.index(['organizerId', 'createdAt']);
  });
  await knex.raw(`ALTER TABLE "EventMedalArt"
    ADD CONSTRAINT eventmedalart_template_fk FOREIGN KEY ("templateId", "eventId") REFERENCES "EventMedalTemplate" (id, "eventId") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT eventmedalart_status_check CHECK (status IN (${list(STATUSES)})),
    ADD CONSTRAINT eventmedalart_review_check CHECK ("reviewState" IN ('to_review', 'reviewed')),
    ADD CONSTRAINT eventmedalart_reason_check CHECK (reason IS NULL OR reason IN (${list(TAKEDOWN_REASONS)})),
    ADD CONSTRAINT eventmedalart_note_check CHECK ("reasonNote" IS NULL OR char_length("reasonNote") <= 200),
    ADD CONSTRAINT eventmedalart_taken_down_check CHECK ((status = 'taken_down') = (reason IS NOT NULL)),
    ADD CONSTRAINT eventmedalart_size_check CHECK (width BETWEEN 512 AND 4000 AND height BETWEEN 512 AND 4000),
    ADD CONSTRAINT eventmedalart_alt_check CHECK (jsonb_typeof("altText") = 'object'),
    ADD CONSTRAINT eventmedalart_revision_check CHECK (revision >= 1)`);
  await knex.raw(`CREATE UNIQUE INDEX eventmedalart_live_template_unique ON "EventMedalArt" ("templateId") WHERE status = 'live'`);
  await knex.raw(`CREATE INDEX eventmedalart_review_idx ON "EventMedalArt" ("createdAt") WHERE status = 'live' AND "reviewState" = 'to_review'`);
  await knex.raw(`CREATE INDEX eventmedalart_blocked_sha_idx ON "EventMedalArt" (sha256) WHERE status = 'taken_down'`);
  await knex.raw(`CREATE INDEX eventmedalart_blocked_pixel_idx ON "EventMedalArt" ("pixelSha256") WHERE status = 'taken_down'`);

  await knex.schema.createTable('EventMedalArtFile', (t) => {
    t.text('artId').notNullable().references('id').inTable('EventMedalArt').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('variant').notNullable();
    t.text('contentType').notNullable().defaultTo('image/webp');
    t.specificType('bytes', 'bytea').notNullable();
    t.integer('byteSize').notNullable();
    t.primary(['artId', 'variant']);
  });
  await knex.raw(`ALTER TABLE "EventMedalArtFile"
    ADD CONSTRAINT eventmedalartfile_variant_check CHECK (variant IN (${list(VARIANTS)})),
    ADD CONSTRAINT eventmedalartfile_type_check CHECK ("contentType" = 'image/webp'),
    ADD CONSTRAINT eventmedalartfile_size_check CHECK ("byteSize" > 0 AND "byteSize" = octet_length(bytes))`);

  await knex.schema.createTable('EventMedalArtUploadAttempt', (t) => {
    t.text('id').primary();
    t.text('userId').notNullable();
    t.text('organizerId');
    t.boolean('succeeded').notNullable().defaultTo(false);
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.index(['userId', 'createdAt']);
    t.index(['organizerId', 'createdAt']);
  });

  await knex.raw(`ALTER TABLE "EventMedalTemplate" ADD COLUMN "artId" text REFERENCES "EventMedalArt"(id) ON DELETE SET NULL ON UPDATE CASCADE`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const count = Number((await knex.raw(`SELECT count(*) AS n FROM "EventMedalArt"`)).rows[0].n);
  if (count) throw new Error(`events S6 (medal art) down refused (fails closed): ${count} artwork row(s) exist.`);
  await knex.raw(`ALTER TABLE "EventMedalTemplate" DROP COLUMN "artId"`);
  await knex.schema.dropTableIfExists('EventMedalArtUploadAttempt');
  await knex.schema.dropTableIfExists('EventMedalArtFile');
  await knex.schema.dropTableIfExists('EventMedalArt');
};

exports.TAKEDOWN_REASONS = TAKEDOWN_REASONS;
