// Marathon & running events · S7 (2 of 4) — the offline kit desk: desk registry, provisional scan records, offline bib recording.
// Design: docs/design/events-s7-hardening-and-pilot.md §3 (D63 to D69, D66 changed) and §7.3.
//
// RULE 6 AREA (owner reviews, D35): a SECOND WRITER of EventKitCollection (method `offline`) and of EventBibAssignment (the offline bib path).
//  - EventKitOfflineDevice is a registry entry, NOT a credential. Every call still uses the staff member's normal sign-in.
//  - EventKitOfflineScan holds one row per scan a desk sent, unique on (deviceId, clientRef): the second send of a scan returns the stored
//    outcome. No token, no token hash and no payload text is stored (the payload is resolved on the server and discarded).
//  - EventKitCollection.method gains `offline`; `offlineBatchId` (exists, unused since S5) is set for those rows.
//  - EventBibAssignment.sourceScanId traces a bib written by the offline path to its scan. The two live-bib unique indexes of S5 stay the arbiters.
//
// Additive. Down FAILS CLOSED once any S7 offline data exists (devices, scans, `offline` collections, traced bibs).

const OUTCOMES = ['accepted', 'duplicate', 'revoked_after_scan', 'event_closed', 'after_revoke', 'organizer_suspended', 'invalid_token', 'unknown_ticket', 'wrong_event', 'validation_failed'];
const BIB_OUTCOMES = ['assigned', 'same_already', 'not_applied', 'format_invalid', 'out_of_range', 'no_range', 'taken', 'registration_has_other'];
const MANUAL_REASONS = ['phone_lost', 'no_signal', 'screen_damaged', 'other'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('EventKitOfflineDevice', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable();
    t.text('organizerId').notNullable();
    t.text('staffUserId').notNullable().references('id').inTable('User').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('label').notNullable();
    t.text('clientKind').notNullable().defaultTo('web');
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('issuedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expiresAt', { precision: 3 }).notNullable();
    t.timestamp('revokedAt', { precision: 3 });
    t.text('revokedBy');
    t.text('revokeReason');
    t.text('revokeReasonSw');
    t.timestamp('lastSyncAt', { precision: 3 });
    t.timestamp('lastHeartbeatAt', { precision: 3 });
    t.integer('pendingReported').notNullable().defaultTo(0);
    t.integer('discardedReported').notNullable().defaultTo(0);
    t.bigInteger('snapshotSeq');
    t.timestamp('snapshotTakenAt', { precision: 3 });
    t.integer('snapshotRows');
    t.text('deskBuild');
    t.text('bibPrefix');
    t.specificType('bibPadTo', 'smallint');
    t.integer('bibRangeStart');
    t.integer('bibRangeEnd');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.index(['eventId', 'status']);
  });
  await knex.raw(`ALTER TABLE "EventKitOfflineDevice"
    ADD CONSTRAINT eventkitofflinedevice_event_fk FOREIGN KEY ("eventId", "organizerId") REFERENCES "Event" (id, "organizerId") ON UPDATE CASCADE ON DELETE CASCADE,
    ADD CONSTRAINT eventkitofflinedevice_label_check CHECK (char_length(label) BETWEEN 1 AND 40),
    ADD CONSTRAINT eventkitofflinedevice_kind_check CHECK ("clientKind" IN ('web')),
    ADD CONSTRAINT eventkitofflinedevice_status_check CHECK (status IN ('active', 'revoked', 'expired')),
    ADD CONSTRAINT eventkitofflinedevice_revoked_check CHECK ((status = 'revoked') = ("revokedAt" IS NOT NULL)),
    ADD CONSTRAINT eventkitofflinedevice_reason_check CHECK ("revokeReason" IS NULL OR char_length("revokeReason") <= 300),
    ADD CONSTRAINT eventkitofflinedevice_prefix_check CHECK ("bibPrefix" IS NULL OR (char_length("bibPrefix") <= 4 AND "bibPrefix" ~ '^[A-Z0-9-]*$')),
    ADD CONSTRAINT eventkitofflinedevice_pad_check CHECK ("bibPadTo" IS NULL OR "bibPadTo" BETWEEN 0 AND 6),
    ADD CONSTRAINT eventkitofflinedevice_range_check CHECK (
      ("bibRangeStart" IS NULL AND "bibRangeEnd" IS NULL AND "bibPrefix" IS NULL AND "bibPadTo" IS NULL)
      OR ("bibRangeStart" IS NOT NULL AND "bibRangeEnd" IS NOT NULL AND "bibRangeStart" >= 0 AND "bibRangeEnd" >= "bibRangeStart" AND "bibRangeEnd" - "bibRangeStart" < 5000)),
    ADD CONSTRAINT eventkitofflinedevice_counts_check CHECK ("pendingReported" >= 0 AND "discardedReported" >= 0)`);
  await knex.raw(`CREATE INDEX eventkitofflinedevice_staff_active_idx ON "EventKitOfflineDevice" ("staffUserId", "eventId") WHERE status = 'active'`);

  await knex.schema.createTable('EventKitOfflineScan', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('deviceId').notNullable().references('id').inTable('EventKitOfflineDevice').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('clientRef').notNullable();
    t.text('batchId').notNullable();
    t.text('method').notNullable();
    t.text('registrationId');
    t.text('outcome').notNullable();
    t.text('collectionId').references('id').inTable('EventKitCollection').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('winnerCollectionId').references('id').inTable('EventKitCollection').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('manualReason');
    t.timestamp('claimedAt', { precision: 3 });
    t.timestamp('correctedAt', { precision: 3 });
    t.timestamp('receivedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.integer('clockOffsetMs').notNullable().defaultTo(0);
    t.jsonb('flags').notNullable().defaultTo('{}');
    t.text('bibClaimed');
    t.text('bibOutcome');
    t.text('bibAssignmentId');
    t.text('outcomeOnDevice');
    t.text('reviewStatus').notNullable().defaultTo('none');
    t.text('checkedBy');
    t.timestamp('checkedAt', { precision: 3 });
    t.text('note');
    t.unique(['deviceId', 'clientRef']);
    t.index(['eventId', 'reviewStatus']);
    t.index(['registrationId']);
  });
  await knex.raw(`ALTER TABLE "EventKitOfflineScan"
    ADD CONSTRAINT eventkitofflinescan_registration_fk FOREIGN KEY ("registrationId", "eventId") REFERENCES "EventRegistration" (id, "eventId") ON UPDATE CASCADE ON DELETE RESTRICT,
    ADD CONSTRAINT eventkitofflinescan_method_check CHECK (method IN ('scan', 'manual')),
    ADD CONSTRAINT eventkitofflinescan_outcome_check CHECK (outcome IN (${list(OUTCOMES)})),
    ADD CONSTRAINT eventkitofflinescan_bib_outcome_check CHECK ("bibOutcome" IS NULL OR "bibOutcome" IN (${list(BIB_OUTCOMES)})),
    ADD CONSTRAINT eventkitofflinescan_manual_reason_check CHECK ("manualReason" IS NULL OR "manualReason" IN (${list(MANUAL_REASONS)})),
    ADD CONSTRAINT eventkitofflinescan_review_check CHECK ("reviewStatus" IN ('none', 'needs_review', 'checked')),
    ADD CONSTRAINT eventkitofflinescan_note_check CHECK (note IS NULL OR char_length(note) <= 300),
    ADD CONSTRAINT eventkitofflinescan_clientref_check CHECK (char_length("clientRef") BETWEEN 8 AND 64)`);

  await knex.raw(`ALTER TABLE "EventKitCollection" DROP CONSTRAINT eventkitcollection_method_check`);
  await knex.raw(`ALTER TABLE "EventKitCollection" ADD CONSTRAINT eventkitcollection_method_check CHECK (method IN ('scan', 'manual', 'api', 'offline'))`);

  await knex.raw(`ALTER TABLE "EventBibAssignment" ADD COLUMN "sourceScanId" text REFERENCES "EventKitOfflineScan"(id) ON DELETE SET NULL ON UPDATE CASCADE`);
  await knex.raw(`CREATE INDEX eventbibassignment_source_scan_idx ON "EventBibAssignment" ("sourceScanId") WHERE "sourceScanId" IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const count = async sql => Number((await knex.raw(sql)).rows[0].n);
  const blockers = [
    [await count(`SELECT count(*) AS n FROM "EventKitOfflineDevice"`), 'offline desks exist'],
    [await count(`SELECT count(*) AS n FROM "EventKitOfflineScan"`), 'offline scans exist'],
    [await count(`SELECT count(*) AS n FROM "EventKitCollection" WHERE method = 'offline' OR "offlineBatchId" IS NOT NULL`), 'offline kit collections exist'],
    [await count(`SELECT count(*) AS n FROM "EventBibAssignment" WHERE "sourceScanId" IS NOT NULL`), 'offline bib assignments exist'],
  ].filter(([n]) => n > 0).map(([, why]) => why);
  if (blockers.length) throw new Error(`events S7 offline kit down refused (fails closed): ${blockers.join('; ')}.`);
  await knex.raw(`DROP INDEX IF EXISTS eventbibassignment_source_scan_idx`);
  await knex.raw(`ALTER TABLE "EventBibAssignment" DROP COLUMN "sourceScanId"`);
  await knex.raw(`ALTER TABLE "EventKitCollection" DROP CONSTRAINT eventkitcollection_method_check`);
  await knex.raw(`ALTER TABLE "EventKitCollection" ADD CONSTRAINT eventkitcollection_method_check CHECK (method IN ('scan', 'manual', 'api'))`);
  await knex.schema.dropTableIfExists('EventKitOfflineScan');
  await knex.schema.dropTableIfExists('EventKitOfflineDevice');
};
