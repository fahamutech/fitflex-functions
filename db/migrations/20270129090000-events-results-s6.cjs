// Marathon & running events · S6 (1 of 3) — results, run links, disputes, release history, award work queue.
// Design: docs/design/events-s6-runs-results-medals-rewards.md §4.1 (accepted decisions D44–D62).
//
// - EventResult: net / gun time, provider label, import and submitter, the activity link behind a GPS result,
//   cut-off flag, a closed reason-code list, rank stamp. Revisions stay rows of this table (no EventResultRevision).
//   eventresult_verifiedby_fkey is DROPPED: verifiedBy stays an opaque id so deleting an organizer staff user
//   (Play Store account deletion) cannot violate eventresult_verified_check; the audit trail keeps the id.
// - EventResultRelease: append-only history of provisional / official releases per event or category (trigger).
// - EventResultImport: one row per applied import; unique (eventId, contentSha256) so a file applies once.
// - EventResultDispute: one open dispute per registration.
// - EventActivityLink: snapshots of the run, checks / flags, duplicate-route fingerprint, unlink, request hash for
//   the create-and-link replay, and the live-link partial uniques.
// - EventRegistration.resultsVisibility, Event.resultsPolicy, EventAwardTask (coalescing work queue).
//
// Additive. Nothing here is read until EVENTS_RESULTS is on. Down FAILS CLOSED once S6 data exists.
// Sorts after 20270128090000-gym-payout-invoice-unique (the design named 20270128…; that stamp was taken on RC).

const RESULT_REASONS = [
  'not_a_valid_run', 'data_error', 'duplicate', 'other', 'replaced_by_participant',
  'timing_error', 'wrong_bib', 'late_finish_data',
  'rule_violation', 'course_cut', 'wrong_category', 'equipment', 'identity', 'virtual_evidence',
];
const DISPUTE_REASONS = ['time_wrong', 'not_my_result', 'wrong_category', 'missing_split', 'dq_challenge', 'other'];
const DISPUTE_STATUSES = ['open', 'upheld', 'rejected', 'withdrawn'];
const TASK_REASONS = ['release', 'result_changed', 'claim', 'registration_cancelled', 'event_cancelled', 'template_added', 'definition_changed'];
const TASK_STATES = ['pending', 'running', 'done', 'failed'];
const VISIBILITIES = ['standard', 'bib_only', 'hidden'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const stamps = (t) => {
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  };

  // ── EventResultImport ──
  await knex.schema.createTable('EventResultImport', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('organizerId').notNullable().references('id').inTable('EventOrganizer').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('sourceType').notNullable();
    t.text('sourceLabel');
    t.text('fileName');
    t.text('contentSha256').notNullable();
    t.integer('rowCount').notNullable().defaultTo(0);
    t.integer('createdCount').notNullable().defaultTo(0);
    t.integer('revisedCount').notNullable().defaultTo(0);
    t.integer('unchangedCount').notNullable().defaultTo(0);
    t.jsonb('summary').notNullable().defaultTo('{}');
    t.text('createdBy').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('apiClientId').references('id').inTable('ApiClient').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['eventId', 'contentSha256']);
    t.index(['eventId', 'createdAt']);
  });
  await knex.raw(`ALTER TABLE "EventResultImport"
    ADD CONSTRAINT eventresultimport_source_check CHECK ("sourceType" IN ('timing_provider', 'organizer_verified')),
    ADD CONSTRAINT eventresultimport_actor_check CHECK (NOT ("createdBy" IS NOT NULL AND "apiClientId" IS NOT NULL)),
    ADD CONSTRAINT eventresultimport_counts_check CHECK ("rowCount" >= 0 AND "createdCount" >= 0 AND "revisedCount" >= 0 AND "unchangedCount" >= 0),
    ADD CONSTRAINT eventresultimport_file_name_check CHECK ("fileName" IS NULL OR char_length("fileName") <= 120)`);

  // ── EventActivityLink (before EventResult.activityLinkId points at it) ──
  await knex.raw(`ALTER TABLE "EventActivityLink"
    ADD COLUMN "distanceMeters" integer,
    ADD COLUMN "movingSeconds" integer,
    ADD COLUMN "elapsedMs" bigint,
    ADD COLUMN checks jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN flags jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN "routeFingerprint" text,
    ADD COLUMN "requestSha256" text,
    ADD COLUMN "submittedAt" timestamptz(3) NOT NULL DEFAULT now(),
    ADD COLUMN "unlinkedAt" timestamptz(3),
    ADD COLUMN "unlinkedReason" text`);
  await knex.raw(`ALTER TABLE "EventActivityLink"
    ADD CONSTRAINT eventactivitylink_measures_check CHECK (("distanceMeters" IS NULL OR "distanceMeters" >= 0) AND ("movingSeconds" IS NULL OR "movingSeconds" >= 0) AND ("elapsedMs" IS NULL OR "elapsedMs" >= 0)),
    ADD CONSTRAINT eventactivitylink_flags_check CHECK (jsonb_typeof(flags) = 'array' AND jsonb_typeof(checks) = 'object'),
    ADD CONSTRAINT eventactivitylink_unlink_check CHECK (("unlinkedAt" IS NULL) = ("unlinkedReason" IS NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX eventactivitylink_live_run_registration ON "EventActivityLink" ("registrationId") WHERE "linkType" = 'event_run' AND "unlinkedAt" IS NULL AND "matchStatus" <> 'rejected'`);
  await knex.raw(`CREATE UNIQUE INDEX eventactivitylink_live_run_activity ON "EventActivityLink" ("activityId") WHERE "linkType" = 'event_run' AND "unlinkedAt" IS NULL AND "matchStatus" <> 'rejected' AND "activityId" IS NOT NULL`);
  await knex.raw(`CREATE INDEX eventactivitylink_fingerprint_idx ON "EventActivityLink" ("routeFingerprint") WHERE "routeFingerprint" IS NOT NULL`);

  // ── EventResult ──
  await knex.raw(`ALTER TABLE "EventResult"
    ADD COLUMN "netElapsedMs" bigint,
    ADD COLUMN "gunElapsedMs" bigint,
    ADD COLUMN "sourceLabel" text,
    ADD COLUMN "importId" text REFERENCES "EventResultImport"(id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN "submittedByUserId" text REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN "submittedByApiClientId" text REFERENCES "ApiClient"(id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN "activityLinkId" text REFERENCES "EventActivityLink"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD COLUMN "withinCutoff" boolean,
    ADD COLUMN "reasonCode" text,
    ADD COLUMN "ranksComputedAt" timestamptz(3)`);
  await knex.raw(`ALTER TABLE "EventResult" DROP CONSTRAINT IF EXISTS eventresult_verifiedby_fkey`);
  await knex.raw(`ALTER TABLE "EventResult"
    ADD CONSTRAINT eventresult_net_gun_check CHECK (("netElapsedMs" IS NULL OR "netElapsedMs" >= 0) AND ("gunElapsedMs" IS NULL OR "gunElapsedMs" >= 0)),
    ADD CONSTRAINT eventresult_source_label_check CHECK ("sourceLabel" IS NULL OR char_length("sourceLabel") BETWEEN 1 AND 60),
    ADD CONSTRAINT eventresult_submitter_check CHECK (NOT ("submittedByUserId" IS NOT NULL AND "submittedByApiClientId" IS NOT NULL)),
    ADD CONSTRAINT eventresult_gps_link_check CHECK ("sourceType" <> 'fitflex_gps' OR "activityLinkId" IS NOT NULL),
    ADD CONSTRAINT eventresult_reason_check CHECK ("reasonCode" IS NULL OR "reasonCode" IN (${list(RESULT_REASONS)}))`);
  await knex.raw(`CREATE INDEX eventresult_import_idx ON "EventResult" ("importId")`);
  await knex.raw(`CREATE INDEX eventresult_current_status_idx ON "EventResult" ("verificationStatus") WHERE "isCurrent"`);

  // ── EventResultRelease (append-only) ──
  await knex.raw(`CREATE TABLE "EventResultRelease" (
    id text PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY,
    "eventId" text NOT NULL REFERENCES "Event"(id) ON DELETE NO ACTION ON UPDATE CASCADE,
    "categoryId" text,
    stage text NOT NULL,
    action text NOT NULL,
    "resultCount" integer NOT NULL DEFAULT 0,
    "unsettledCount" integer NOT NULL DEFAULT 0,
    "releasedBy" text,
    "releasedAt" timestamptz(3) NOT NULL DEFAULT now(),
    note text,
    CONSTRAINT eventresultrelease_category_fk FOREIGN KEY ("categoryId", "eventId") REFERENCES "EventCategory" (id, "eventId") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT eventresultrelease_stage_check CHECK (stage IN ('provisional', 'official')),
    CONSTRAINT eventresultrelease_action_check CHECK (action IN ('release', 'withdraw')),
    CONSTRAINT eventresultrelease_official_no_withdraw CHECK (NOT (stage = 'official' AND action = 'withdraw')),
    CONSTRAINT eventresultrelease_counts_check CHECK ("resultCount" >= 0 AND "unsettledCount" >= 0),
    CONSTRAINT eventresultrelease_note_check CHECK (note IS NULL OR char_length(note) <= 300)
  )`);
  await knex.raw(`CREATE UNIQUE INDEX eventresultrelease_official_unique ON "EventResultRelease" ("eventId", COALESCE("categoryId", '')) WHERE stage = 'official' AND action = 'release'`);
  await knex.raw(`CREATE UNIQUE INDEX eventresultrelease_seq_unique ON "EventResultRelease" (seq)`);
  await knex.raw(`CREATE INDEX eventresultrelease_event_idx ON "EventResultRelease" ("eventId", seq)`);
  await knex.raw(`CREATE OR REPLACE FUNCTION event_result_release_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'EventResultRelease rows are append-only' USING ERRCODE = 'P0001';
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER event_result_release_no_update BEFORE UPDATE OR DELETE ON "EventResultRelease" FOR EACH ROW EXECUTE FUNCTION event_result_release_immutable()`);
  await knex.raw(`CREATE TRIGGER event_result_release_no_truncate BEFORE TRUNCATE ON "EventResultRelease" FOR EACH STATEMENT EXECUTE FUNCTION event_result_release_immutable()`);

  // ── EventResultDispute ──
  await knex.schema.createTable('EventResultDispute', (t) => {
    t.text('id').primary();
    t.text('registrationId').notNullable().references('id').inTable('EventRegistration').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('resultId').notNullable().references('id').inTable('EventResult').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('raisedByUserId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('reasonCode').notNullable();
    t.text('note');
    t.text('status').notNullable().defaultTo('open');
    t.text('resolutionNote');
    t.text('resolvedBy');
    t.timestamp('resolvedAt', { precision: 3 });
    t.text('resultIdAfter').references('id').inTable('EventResult').onDelete('SET NULL').onUpdate('CASCADE');
    stamps(t);
    t.index(['registrationId', 'createdAt']);
  });
  await knex.raw(`ALTER TABLE "EventResultDispute"
    ADD CONSTRAINT eventresultdispute_reason_check CHECK ("reasonCode" IN (${list(DISPUTE_REASONS)})),
    ADD CONSTRAINT eventresultdispute_status_check CHECK (status IN (${list(DISPUTE_STATUSES)})),
    ADD CONSTRAINT eventresultdispute_note_check CHECK ((note IS NULL OR char_length(note) <= 500) AND ("resolutionNote" IS NULL OR char_length("resolutionNote") <= 500)),
    ADD CONSTRAINT eventresultdispute_resolved_check CHECK (
      (status IN ('upheld', 'rejected') AND "resolvedAt" IS NOT NULL AND "resolvedBy" IS NOT NULL AND "resolutionNote" IS NOT NULL)
      OR (status NOT IN ('upheld', 'rejected') AND "resolvedAt" IS NULL AND "resolvedBy" IS NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX eventresultdispute_open_unique ON "EventResultDispute" ("registrationId") WHERE status = 'open'`);
  await knex.raw(`CREATE INDEX eventresultdispute_open_idx ON "EventResultDispute" (status, "createdAt") WHERE status = 'open'`);

  // ── Event, EventRegistration ──
  await knex.raw(`ALTER TABLE "Event" ADD COLUMN "resultsPolicy" jsonb NOT NULL DEFAULT '{}'`);
  await knex.raw(`ALTER TABLE "Event" ADD CONSTRAINT event_results_policy_check CHECK (jsonb_typeof("resultsPolicy") = 'object')`);
  await knex.raw(`ALTER TABLE "EventCategory" ADD CONSTRAINT eventcategory_result_rules_check CHECK (jsonb_typeof("resultRules") = 'object')`);
  await knex.raw(`ALTER TABLE "EventRegistration"
    ADD COLUMN "resultsVisibility" text NOT NULL DEFAULT 'standard',
    ADD COLUMN "resultsVisibilitySetAt" timestamptz(3)`);
  await knex.raw(`ALTER TABLE "EventRegistration" ADD CONSTRAINT eventregistration_results_visibility_check CHECK ("resultsVisibility" IN (${list(VISIBILITIES)}))`);
  // Backfill (spec §4.1.6): a registration made under a consent text without the public-results clause, or by someone under
  // 18 on the event's start day, is bib-only. EVENTS_RESULTS_CONSENT_VERSIONS lists the consent versions that carry the clause
  // (comma separated; unset = none does, so every existing row becomes bib_only). The module is dormant: expected to touch no real rows.
  const clause = String(process.env.EVENTS_RESULTS_CONSENT_VERSIONS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  await knex.raw(`UPDATE "EventRegistration" r SET "resultsVisibility" = 'bib_only'
    FROM "Event" e
    WHERE e.id = r."eventId" AND r."resultsVisibility" = 'standard'
      AND (r."consentTextVersion" IS NULL OR NOT (r."consentTextVersion" = ANY(string_to_array(?, ',')))
        OR (r."dateOfBirth" IS NOT NULL AND date_part('year', age((e."startsAt" AT TIME ZONE e.timezone)::date, r."dateOfBirth")) < 18))`, [clause.join(',')]);

  // ── EventAwardTask ──
  await knex.schema.createTable('EventAwardTask', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('registrationId');
    t.text('releaseId');
    t.text('reason').notNullable();
    t.text('state').notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('lastError');
    t.timestamp('runAfter', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('startedAt', { precision: 3 });
    t.timestamp('finishedAt', { precision: 3 });
    t.index(['state', 'runAfter']);
  });
  await knex.raw(`ALTER TABLE "EventAwardTask"
    ADD CONSTRAINT eventawardtask_reason_check CHECK (reason IN (${list(TASK_REASONS)})),
    ADD CONSTRAINT eventawardtask_state_check CHECK (state IN (${list(TASK_STATES)})),
    ADD CONSTRAINT eventawardtask_error_check CHECK ("lastError" IS NULL OR char_length("lastError") <= 200),
    ADD CONSTRAINT eventawardtask_registration_fk FOREIGN KEY ("registrationId", "eventId") REFERENCES "EventRegistration" (id, "eventId") ON DELETE CASCADE ON UPDATE CASCADE`);
  await knex.raw(`CREATE UNIQUE INDEX eventawardtask_open_unique ON "EventAwardTask" ("eventId", COALESCE("registrationId", ''), reason) WHERE state IN ('pending', 'running')`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const count = async sql => Number((await knex.raw(sql)).rows[0].n);
  const blockers = [
    [await count(`SELECT count(*) AS n FROM "EventResultRelease"`), 'result releases exist'],
    [await count(`SELECT count(*) AS n FROM "EventResultImport"`), 'result imports exist'],
    [await count(`SELECT count(*) AS n FROM "EventResultDispute"`), 'result disputes exist'],
    [await count(`SELECT count(*) AS n FROM "EventAwardTask"`), 'award tasks exist'],
    [await count(`SELECT count(*) AS n FROM "EventResult"`), 'event results exist'],
    [await count(`SELECT count(*) AS n FROM "EventActivityLink"`), 'event activity links exist'],
    [await count(`SELECT count(*) AS n FROM "EventRegistration" WHERE "resultsVisibilitySetAt" IS NOT NULL`), 'a participant chose a results visibility'],
    [await count(`SELECT count(*) AS n FROM "Event" WHERE "resultsPolicy" <> '{}'::jsonb`), 'a results policy is set'],
  ].filter(([n]) => n > 0).map(([, why]) => why);
  if (blockers.length) throw new Error(`events S6 (results) down refused (fails closed): ${blockers.join('; ')}.`);

  await knex.schema.dropTableIfExists('EventAwardTask');
  await knex.raw(`ALTER TABLE "EventRegistration" DROP CONSTRAINT IF EXISTS eventregistration_results_visibility_check`);
  await knex.raw(`ALTER TABLE "EventRegistration" DROP COLUMN "resultsVisibilitySetAt", DROP COLUMN "resultsVisibility"`);
  await knex.raw(`ALTER TABLE "EventCategory" DROP CONSTRAINT IF EXISTS eventcategory_result_rules_check`);
  await knex.raw(`ALTER TABLE "Event" DROP CONSTRAINT IF EXISTS event_results_policy_check`);
  await knex.raw(`ALTER TABLE "Event" DROP COLUMN "resultsPolicy"`);
  await knex.schema.dropTableIfExists('EventResultDispute');
  await knex.raw(`DROP TRIGGER IF EXISTS event_result_release_no_truncate ON "EventResultRelease"`);
  await knex.raw(`DROP TRIGGER IF EXISTS event_result_release_no_update ON "EventResultRelease"`);
  await knex.schema.dropTableIfExists('EventResultRelease');
  await knex.raw(`DROP FUNCTION IF EXISTS event_result_release_immutable()`);
  await knex.raw(`DROP INDEX IF EXISTS eventresult_current_status_idx`);
  await knex.raw(`DROP INDEX IF EXISTS eventresult_import_idx`);
  await knex.raw(`ALTER TABLE "EventResult"
    DROP CONSTRAINT IF EXISTS eventresult_reason_check, DROP CONSTRAINT IF EXISTS eventresult_gps_link_check, DROP CONSTRAINT IF EXISTS eventresult_submitter_check,
    DROP CONSTRAINT IF EXISTS eventresult_source_label_check, DROP CONSTRAINT IF EXISTS eventresult_net_gun_check`);
  await knex.raw(`ALTER TABLE "EventResult"
    DROP COLUMN "ranksComputedAt", DROP COLUMN "reasonCode", DROP COLUMN "withinCutoff", DROP COLUMN "activityLinkId", DROP COLUMN "submittedByApiClientId",
    DROP COLUMN "submittedByUserId", DROP COLUMN "importId", DROP COLUMN "sourceLabel", DROP COLUMN "gunElapsedMs", DROP COLUMN "netElapsedMs"`);
  await knex.raw(`ALTER TABLE "EventResult" ADD CONSTRAINT eventresult_verifiedby_fkey FOREIGN KEY ("verifiedBy") REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE`);
  await knex.raw(`DROP INDEX IF EXISTS eventactivitylink_fingerprint_idx`);
  await knex.raw(`DROP INDEX IF EXISTS eventactivitylink_live_run_activity`);
  await knex.raw(`DROP INDEX IF EXISTS eventactivitylink_live_run_registration`);
  await knex.raw(`ALTER TABLE "EventActivityLink"
    DROP CONSTRAINT IF EXISTS eventactivitylink_unlink_check, DROP CONSTRAINT IF EXISTS eventactivitylink_flags_check, DROP CONSTRAINT IF EXISTS eventactivitylink_measures_check`);
  await knex.raw(`ALTER TABLE "EventActivityLink"
    DROP COLUMN "unlinkedReason", DROP COLUMN "unlinkedAt", DROP COLUMN "submittedAt", DROP COLUMN "requestSha256", DROP COLUMN "routeFingerprint",
    DROP COLUMN flags, DROP COLUMN checks, DROP COLUMN "elapsedMs", DROP COLUMN "movingSeconds", DROP COLUMN "distanceMeters"`);
  await knex.schema.dropTableIfExists('EventResultImport');
};

exports.RESULT_REASONS = RESULT_REASONS;
