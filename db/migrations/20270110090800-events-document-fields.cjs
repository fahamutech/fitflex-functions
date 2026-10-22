// Marathon & running events · S2 — the rest of the event document, favourites, and a richer change log.
// Design: docs/design/events-s2-organizer-and-discovery.md §6.2 (wizard fields), §7.4 / §7.5 (change log),
// §11.7 / §14.5 (favourites), §14.2 (detail shape).
//
// Event — columns added (all nullable; routeMeta is left for route/geometry data only):
//   heroImageUrl, heroThumbUrl, heroImageAlt   text   cover image (WebP from /storage/upload) and its alt text
//   routeUrl, routeImageUrl, routeImageAlt     text   route link (https) and route map image + alt
//   descriptionSw                              text   Swahili description (description = English)
//   venueCity, venueRegion                     text   venueRegion is a code from GET /events/options.regions (filterable)
//   accessibility                              jsonb  { en, sw }        accessibility notes
//   inclusions                                 jsonb  { en, sw }        what the race kit contains
//   kitProvided                                bool   the event hands out a kit (collection points then required)
//   schedule                                   jsonb  [{ at (UTC ISO), label: { en, sw } }]   ≤ 20 rows
//   sponsors                                   jsonb  [{ name, logoUrl, url }]                ≤ 10 rows
//   contact                                    jsonb  { email, phone, whatsapp }
//   terms                                      jsonb  { en, sw }        the editable text; termsSnapshot (S1) is frozen on submit
//   refundPolicy                               jsonb  { preset: no_refund | refund_until_close | custom, text: { en, sw } }
//                                                     refundPolicySnapshot (S1) is frozen on submit
//   registrationOpensAt                        timestamp(3)   null = opens at publication
//   submittedAt                                timestamp(3)   last submission for review
//   rejection                                  jsonb  { reason, note, at } | null   the admin's last send-back
//   cancellation                               jsonb  { reason, note: { en, sw } } | null
//   lastChangeNote                             jsonb  { en, sw } | null  the note of the last material change
// EventCategory: minAge integer (5–99, optional).
// EventChangeLog: fields jsonb (string[] — the paths that changed in one save), note jsonb ({ en, sw }),
//   actorRole text. `field` (S1, text) keeps the comma-joined list so old readers still see something.
// EventFavourite(userId, eventId): a member's saved events (flag EVENTS_FAVOURITES). Cascades with both parents.
// event_cancelled_at_check (S1) is relaxed: a cancelled event keeps its cancelledAt when it is archived
// (cancelled → archived is an ORG-006 move the old CHECK made impossible). Down restores the S1 form.
//
// Dormant: no route reads these until EVENTS_MODULE is on. Down drops the table and every added column.

const REFUND_PRESETS = ['no_refund', 'refund_until_close', 'custom'];
const list = values => values.map(v => `'${v}'`).join(', ');

async function addColumn(knex, table, column, define) {
  if (!(await knex.schema.hasColumn(table, column))) await knex.schema.alterTable(table, define);
}
async function dropColumn(knex, table, column) {
  if (await knex.schema.hasColumn(table, column)) await knex.schema.alterTable(table, t => t.dropColumn(column));
}

const EVENT_TEXT = ['heroImageUrl', 'heroThumbUrl', 'heroImageAlt', 'routeUrl', 'routeImageUrl', 'routeImageAlt', 'descriptionSw', 'venueCity', 'venueRegion'];
const EVENT_JSON = ['accessibility', 'inclusions', 'schedule', 'sponsors', 'contact', 'terms', 'refundPolicy', 'rejection', 'cancellation', 'lastChangeNote'];
const EVENT_TIMES = ['registrationOpensAt', 'submittedAt'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  for (const c of EVENT_TEXT) await addColumn(knex, 'Event', c, t => t.text(c));
  for (const c of EVENT_JSON) await addColumn(knex, 'Event', c, t => t.jsonb(c));
  for (const c of EVENT_TIMES) await addColumn(knex, 'Event', c, t => t.timestamp(c, { precision: 3 }));
  await addColumn(knex, 'Event', 'kitProvided', t => t.boolean('kitProvided').notNullable().defaultTo(false));
  await knex.raw(`ALTER TABLE "Event"
    ADD CONSTRAINT event_refund_preset_check CHECK ("refundPolicy" IS NULL OR "refundPolicy"->>'preset' IS NULL OR "refundPolicy"->>'preset' IN (${list(REFUND_PRESETS)})),
    ADD CONSTRAINT event_registration_window_check CHECK ("registrationOpensAt" IS NULL OR "registrationClosesAt" IS NULL OR "registrationClosesAt" >= "registrationOpensAt")`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS event_region_idx ON "Event" ("venueRegion") WHERE "venueRegion" IS NOT NULL`);
  await knex.raw(`ALTER TABLE "Event" DROP CONSTRAINT IF EXISTS event_cancelled_at_check`);
  await knex.raw(`ALTER TABLE "Event" ADD CONSTRAINT event_cancelled_at_check CHECK (
    (status = 'cancelled' AND "cancelledAt" IS NOT NULL) OR status = 'archived' OR (status <> 'cancelled' AND "cancelledAt" IS NULL))`);

  await addColumn(knex, 'EventCategory', 'minAge', t => t.integer('minAge'));
  await knex.raw(`ALTER TABLE "EventCategory" ADD CONSTRAINT eventcategory_min_age_check CHECK ("minAge" IS NULL OR ("minAge" BETWEEN 5 AND 99))`);

  await addColumn(knex, 'EventChangeLog', 'fields', t => t.jsonb('fields'));
  await addColumn(knex, 'EventChangeLog', 'note', t => t.jsonb('note'));
  await addColumn(knex, 'EventChangeLog', 'actorRole', t => t.text('actorRole'));

  await knex.schema.createTable('EventFavourite', (t) => {
    t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('CASCADE').onUpdate('CASCADE');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.primary(['userId', 'eventId']);
    t.index(['eventId']);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('EventFavourite');
  for (const c of ['fields', 'note', 'actorRole']) await dropColumn(knex, 'EventChangeLog', c);
  await knex.raw('ALTER TABLE "EventCategory" DROP CONSTRAINT IF EXISTS eventcategory_min_age_check');
  await dropColumn(knex, 'EventCategory', 'minAge');
  await knex.raw('DROP INDEX IF EXISTS event_region_idx');
  const archivedCancelled = (await knex.raw(`SELECT count(*)::int AS n FROM "Event" WHERE status = 'archived' AND "cancelledAt" IS NOT NULL`)).rows[0].n;
  if (archivedCancelled) throw new Error(`events-document-fields down: ${archivedCancelled} archived event(s) keep a cancelledAt; the S1 CHECK cannot be restored over them`);
  await knex.raw(`ALTER TABLE "Event" DROP CONSTRAINT IF EXISTS event_cancelled_at_check`);
  await knex.raw(`ALTER TABLE "Event" ADD CONSTRAINT event_cancelled_at_check CHECK ((status = 'cancelled') = ("cancelledAt" IS NOT NULL))`);
  await knex.raw(`ALTER TABLE "Event"
    DROP CONSTRAINT IF EXISTS event_refund_preset_check,
    DROP CONSTRAINT IF EXISTS event_registration_window_check`);
  for (const c of [...EVENT_TEXT, ...EVENT_JSON, ...EVENT_TIMES, 'kitProvided']) await dropColumn(knex, 'Event', c);
};
