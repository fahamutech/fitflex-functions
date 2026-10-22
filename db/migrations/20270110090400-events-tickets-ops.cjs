// Marathon & running events · S1 (foundation) — tickets, kit collection, bibs, results and run links.
// Design: PRD §5.5, §5.7, §7, §9 (ticket / kit / result state machines); reuse-map §5.1; D7 (offline kit
// scanning deferred: offlineBatchId is modelled, unused); D8 (CSV import first: sourceType/sourceReference).
//
// - EventTicket: the entry token of one registration. Only the token's hash is stored (unique); the
//   token itself is shown once / rendered as a QR by the app. One ACTIVE ticket per registration
//   (partial unique); a revoked one stays as history and a replacement is a new row.
// - EventKitCollection: the record that a kit was handed over. One `collected` row per registration
//   (partial unique) — scanning twice cannot hand over twice. A mistake is not edited: a `corrected` row
//   supersedes it (supersedesId + correctionReason) and the earlier row becomes `exception`.
// - EventBibAssignment: bib history. One live bib per (event, category, bibNumber) and one live bib per
//   registration (partial uniques on releasedAt IS NULL); releasing keeps the row.
// - EventResult: an official result for a registration with its provenance (timing_provider,
//   organizer_verified, fitflex_gps, manual_unverified — never shown as equal). Revisions are rows:
//   one current row per registration (partial unique on isCurrent); a correction inserts revision n+1
//   and clears isCurrent on the old one, in one transaction (S6). verificationStatus pending_verification
//   → verified | rejected | disqualified; verified → corrected.
// - EventActivityLink: ties a FitFlex Activity (a recorded run) to a registration as the event run or
//   as evidence. unique (registrationId, activityId); clientRef makes the app's upload idempotent per
//   registration (run upload has no idempotency key today — reuse-map §1.1).
//
// Dormant: no route reads these tables (EVENTS_MODULE off). Down drops the five tables.

const TICKET_STATUSES = ['not_issued', 'active', 'revoked', 'used_for_entry'];
const KIT_COLLECTION_STATUSES = ['collected', 'exception', 'corrected'];
const RESULT_SOURCES = ['timing_provider', 'organizer_verified', 'fitflex_gps', 'manual_unverified'];
const FINISH_STATUSES = ['finished', 'dnf', 'dns', 'dq'];
const VERIFICATION_STATUSES = ['pending_verification', 'verified', 'rejected', 'corrected', 'disqualified'];
const LINK_TYPES = ['event_run', 'evidence'];
const MATCH_STATUSES = ['pending', 'matched', 'rejected'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const stamps = (t) => {
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  };

  await knex.schema.createTable('EventTicket', (t) => {
    t.text('id').primary();
    t.text('registrationId').notNullable().references('id').inTable('EventRegistration').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('tokenHash').notNullable();
    t.text('status').notNullable().defaultTo('not_issued');
    t.timestamp('issuedAt', { precision: 3 });
    t.timestamp('revokedAt', { precision: 3 });
    t.text('revokeReason');
    t.timestamp('usedAt', { precision: 3 });
    stamps(t);
    t.unique(['tokenHash']);
    t.index(['registrationId']);
  });
  await knex.raw(`ALTER TABLE "EventTicket"
    ADD CONSTRAINT eventticket_status_check CHECK (status IN (${list(TICKET_STATUSES)})),
    ADD CONSTRAINT eventticket_issued_check CHECK (status = 'not_issued' OR "issuedAt" IS NOT NULL),
    ADD CONSTRAINT eventticket_revoked_check CHECK ((status = 'revoked') = ("revokedAt" IS NOT NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX eventticket_active_unique ON "EventTicket" ("registrationId") WHERE status = 'active'`);

  await knex.schema.createTable('EventKitCollection', (t) => {
    t.text('id').primary();
    t.text('registrationId').notNullable().references('id').inTable('EventRegistration').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('collectionPointId').references('id').inTable('EventCollectionPoint').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('status').notNullable().defaultTo('collected');
    t.timestamp('collectedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.text('staffUserId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('bibNumber');
    t.text('kitSize');
    t.text('offlineBatchId');
    t.text('correctionReason');
    t.text('supersedesId').references('id').inTable('EventKitCollection').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.index(['registrationId']);
  });
  await knex.raw(`ALTER TABLE "EventKitCollection"
    ADD CONSTRAINT eventkitcollection_status_check CHECK (status IN (${list(KIT_COLLECTION_STATUSES)})),
    ADD CONSTRAINT eventkitcollection_correction_check CHECK (status <> 'corrected' OR ("correctionReason" IS NOT NULL AND "supersedesId" IS NOT NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX eventkitcollection_collected_unique ON "EventKitCollection" ("registrationId") WHERE status = 'collected'`);

  await knex.schema.createTable('EventBibAssignment', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable();
    t.text('categoryId').notNullable();
    t.text('registrationId').notNullable();
    t.text('bibNumber').notNullable();
    t.text('assignedBy').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('assignedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('releasedAt', { precision: 3 });
    t.text('reason');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.index(['eventId', 'categoryId']);
  });
  await knex.raw(`ALTER TABLE "EventBibAssignment"
    ADD CONSTRAINT eventbibassignment_registration_fk FOREIGN KEY ("registrationId", "eventId") REFERENCES "EventRegistration" (id, "eventId") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT eventbibassignment_category_fk FOREIGN KEY ("categoryId", "eventId") REFERENCES "EventCategory" (id, "eventId") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT eventbibassignment_bib_length_check CHECK (char_length("bibNumber") BETWEEN 1 AND 12)`);
  await knex.raw(`CREATE UNIQUE INDEX eventbibassignment_live_bib_unique ON "EventBibAssignment" ("eventId", "categoryId", "bibNumber") WHERE "releasedAt" IS NULL`);
  await knex.raw(`CREATE UNIQUE INDEX eventbibassignment_live_registration_unique ON "EventBibAssignment" ("registrationId") WHERE "releasedAt" IS NULL`);

  await knex.schema.createTable('EventResult', (t) => {
    t.text('id').primary();
    t.text('registrationId').notNullable().references('id').inTable('EventRegistration').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('sourceType').notNullable();
    t.text('sourceReference');
    t.integer('distanceMeters');
    t.bigInteger('elapsedMs');
    t.text('finishStatus').notNullable();
    t.integer('overallRank');
    t.integer('categoryRank');
    t.text('verificationStatus').notNullable().defaultTo('pending_verification');
    t.text('verifiedBy').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('verifiedAt', { precision: 3 });
    t.text('correctionReason');
    t.integer('revision').notNullable().defaultTo(1);
    t.boolean('isCurrent').notNullable().defaultTo(true);
    stamps(t);
    t.unique(['registrationId', 'revision']);
  });
  await knex.raw(`ALTER TABLE "EventResult"
    ADD CONSTRAINT eventresult_source_check CHECK ("sourceType" IN (${list(RESULT_SOURCES)})),
    ADD CONSTRAINT eventresult_finish_check CHECK ("finishStatus" IN (${list(FINISH_STATUSES)})),
    ADD CONSTRAINT eventresult_verification_check CHECK ("verificationStatus" IN (${list(VERIFICATION_STATUSES)})),
    ADD CONSTRAINT eventresult_measures_check CHECK (("distanceMeters" IS NULL OR "distanceMeters" >= 0) AND ("elapsedMs" IS NULL OR "elapsedMs" >= 0)),
    ADD CONSTRAINT eventresult_finished_check CHECK ("finishStatus" <> 'finished' OR "elapsedMs" IS NOT NULL),
    ADD CONSTRAINT eventresult_ranks_check CHECK (("overallRank" IS NULL OR "overallRank" >= 1) AND ("categoryRank" IS NULL OR "categoryRank" >= 1)),
    ADD CONSTRAINT eventresult_revision_check CHECK (revision >= 1),
    ADD CONSTRAINT eventresult_verified_check CHECK ("verificationStatus" NOT IN ('verified', 'corrected') OR ("verifiedBy" IS NOT NULL AND "verifiedAt" IS NOT NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX eventresult_current_unique ON "EventResult" ("registrationId") WHERE "isCurrent"`);

  await knex.schema.createTable('EventActivityLink', (t) => {
    t.text('id').primary();
    t.text('registrationId').notNullable().references('id').inTable('EventRegistration').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('activityId').notNullable().references('id').inTable('Activity').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('linkType').notNullable().defaultTo('event_run');
    t.text('matchStatus').notNullable().defaultTo('pending');
    t.text('clientRef');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['registrationId', 'activityId']);
    t.index(['activityId']);
  });
  await knex.raw(`ALTER TABLE "EventActivityLink"
    ADD CONSTRAINT eventactivitylink_type_check CHECK ("linkType" IN (${list(LINK_TYPES)})),
    ADD CONSTRAINT eventactivitylink_match_check CHECK ("matchStatus" IN (${list(MATCH_STATUSES)})),
    ADD CONSTRAINT eventactivitylink_client_ref_check CHECK ("clientRef" IS NULL OR char_length("clientRef") BETWEEN 8 AND 100)`);
  await knex.raw(`CREATE UNIQUE INDEX eventactivitylink_client_ref_unique ON "EventActivityLink" ("registrationId", "clientRef") WHERE "clientRef" IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('EventActivityLink');
  await knex.schema.dropTableIfExists('EventResult');
  await knex.schema.dropTableIfExists('EventBibAssignment');
  await knex.schema.dropTableIfExists('EventKitCollection');
  await knex.schema.dropTableIfExists('EventTicket');
};
