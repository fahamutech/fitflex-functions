// Marathon & running events · S7 (4 of 4) — hardening columns.
// Design: docs/design/events-s7-hardening-and-pilot.md §6.1 (H3, H6), §6.2 (D79, D80).
//
// - Event.rewardsEligible: a FitFlex admin switch (default false) that decides whether an event may EARN rewards. Medals are unaffected, so no
//   event can farm rewards until FitFlex says so (D80, S6 open item M6). RULE 6 AREA (the award engine reads it).
// - EventRegistration.anonymisedAt: set by the retention job (event-registration-anonymise) when it has cleared a registration's contact and
//   sensitive fields. The job ships UNSET (EVENTS_RETENTION_MONTHS) and does nothing until configured. RULE 6 AREA.
// - OutboxEvent("createdAt") index: the outbox retention (H3) now deletes rows older than 90 days whether published or not, in batches.
//
// Additive. Down FAILS CLOSED while any event has rewardsEligible = true or any registration was anonymised (that data cannot be restored).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE "Event" ADD COLUMN "rewardsEligible" boolean NOT NULL DEFAULT false`);
  await knex.raw(`ALTER TABLE "EventRegistration" ADD COLUMN "anonymisedAt" timestamp(3) with time zone`);
  await knex.raw(`CREATE INDEX eventregistration_anonymised_idx ON "EventRegistration" ("eventId") WHERE "anonymisedAt" IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS outboxevent_created_idx ON "OutboxEvent" ("createdAt")`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const count = async sql => Number((await knex.raw(sql)).rows[0].n);
  const blockers = [
    [await count(`SELECT count(*) AS n FROM "Event" WHERE "rewardsEligible" = true`), 'events are marked rewardsEligible'],
    [await count(`SELECT count(*) AS n FROM "EventRegistration" WHERE "anonymisedAt" IS NOT NULL`), 'anonymised registrations exist'],
  ].filter(([n]) => n > 0).map(([, why]) => why);
  if (blockers.length) throw new Error(`events S7 hardening down refused (fails closed): ${blockers.join('; ')}.`);
  await knex.raw(`DROP INDEX IF EXISTS outboxevent_created_idx`);
  await knex.raw(`DROP INDEX IF EXISTS eventregistration_anonymised_idx`);
  await knex.raw(`ALTER TABLE "EventRegistration" DROP COLUMN "anonymisedAt"`);
  await knex.raw(`ALTER TABLE "Event" DROP COLUMN "rewardsEligible"`);
};
