// Security incident reports (S4b): a member says "this web check-in was not me". Two tables:
//
//   SecurityIncident       one per (member, security event). status open -> acknowledged -> resolved; when resolved,
//                          outcome unauthorised_confirmed | authorised_by_member | inconclusive. `snapshot` is what the
//                          event looked like when it was reported (gym, time); `protection` is what was done for the
//                          member (sessions ended, PIN reset required); `opsExceptionId` links the staff alert.
//                          `userId` and `eventId` are plain references, NOT foreign keys: deleting the account cascades
//                          the SecurityEvent away, but the incident stays as an anonymised record (resolutionReason is
//                          cleared by account erasure). Kept 24 months (resolved ones are purged after that).
//   SecurityIncidentEvent  append-only trail (reported, protection_applied, acknowledged, resolved). No free text: the
//                          admin's reason lives on the incident row so it can be erased. UPDATE and DELETE are refused
//                          by a trigger; deleting the parent incident (retention) is allowed to cascade.
//
// No IP, user agent, session id or PIN is stored. Additive and repeatable (hasTable-guarded). Reports never touch the
// check-in, visits, payouts or settlement.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('SecurityIncident'))) {
    await knex.schema.createTable('SecurityIncident', (t) => {
      t.text('id').primary();
      t.text('userId').notNullable();
      t.text('eventId').notNullable();
      t.text('status').notNullable().defaultTo('open');
      t.text('outcome');
      t.jsonb('snapshot');
      t.jsonb('protection');
      t.text('opsExceptionId');
      t.text('resolutionReason');
      t.text('acknowledgedBy');
      t.timestamp('acknowledgedAt', { useTz: true });
      t.text('resolvedBy');
      t.timestamp('resolvedAt', { useTz: true });
      t.timestamp('reportedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`ALTER TABLE "SecurityIncident" ADD CONSTRAINT security_incident_status_ck CHECK ("status" IN ('open', 'acknowledged', 'resolved'))`);
    await knex.raw(`ALTER TABLE "SecurityIncident" ADD CONSTRAINT security_incident_outcome_ck CHECK ("outcome" IS NULL OR "outcome" IN ('unauthorised_confirmed', 'authorised_by_member', 'inconclusive'))`);
    await knex.raw(`ALTER TABLE "SecurityIncident" ADD CONSTRAINT security_incident_resolved_ck CHECK (("status" = 'resolved') = ("outcome" IS NOT NULL))`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS security_incident_user_event_uq ON "SecurityIncident" ("userId", "eventId") WHERE "eventId" IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS security_incident_user_time_idx ON "SecurityIncident" ("userId", "reportedAt" DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS security_incident_status_idx ON "SecurityIncident" ("status", "reportedAt" DESC)`);

  if (!(await knex.schema.hasTable('SecurityIncidentEvent'))) {
    await knex.schema.createTable('SecurityIncidentEvent', (t) => {
      t.text('id').primary();
      t.text('incidentId').notNullable().references('id').inTable('SecurityIncident').onDelete('CASCADE');
      t.text('kind').notNullable();
      t.text('actor');
      t.jsonb('detail');
      t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['incidentId', 'createdAt']);
    });
  }
  // A direct UPDATE or DELETE is refused. A delete that comes from the parent's ON DELETE CASCADE runs one trigger level
  // deeper and is let through (that is how retention removes a whole incident).
  await knex.raw(`CREATE OR REPLACE FUNCTION security_incident_event_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'SecurityIncidentEvent rows are append-only' USING ERRCODE = 'P0001';
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw('DROP TRIGGER IF EXISTS security_incident_event_no_change ON "SecurityIncidentEvent"');
  await knex.raw(`CREATE TRIGGER security_incident_event_no_change
    BEFORE UPDATE OR DELETE ON "SecurityIncidentEvent"
    FOR EACH ROW EXECUTE FUNCTION security_incident_event_immutable()`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS security_incident_event_no_change ON "SecurityIncidentEvent"');
  await knex.schema.dropTableIfExists('SecurityIncidentEvent');
  await knex.raw('DROP FUNCTION IF EXISTS security_incident_event_immutable()');
  await knex.schema.dropTableIfExists('SecurityIncident');
};
