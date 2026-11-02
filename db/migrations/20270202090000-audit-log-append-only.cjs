// Admin-portal audit S2 (2026-10-29), slice B. RULE 6 AREA: changes the AuditLog schema.
//
// 1. AuditLog.reason (nullable text): why an admin did it. Optional unless ADMIN_REASONS_REQUIRED is on.
// 2. AuditLog is append-only in the database: UPDATE, DELETE and TRUNCATE raise (SQLSTATE P0001), whatever code or
//    person tries them. Two narrow exceptions, both explicit:
//    - Account erasure scrubs personal keys out of before/after (account-erasure-store-pg.mjs scrubAuditTrail). It sets the
//      transaction-local setting fitflex.audit_scrub = 'on' and may then change ONLY the before/after columns.
//    - Test cleanup. A session that sets fitflex.audit_test_bypass = 'on' may delete/update, but ONLY when the database name
//      contains "_ci" (the isolated CI databases). src/infra/knex-store.mjs sets it on every pooled connection when
//      FITFLEX_USE_CI_DB=1. On any other database name the setting is ignored.
// 3. An index for the keyset-paginated viewer (GET /admin/audit-log), newest first.
//
// Reversible: down drops the triggers, the function, the index and the column.
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS reason text`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS auditlog_at_id_idx ON "AuditLog" (at DESC, id DESC)`);

  await knex.raw(`CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
    BEGIN
      IF current_setting('fitflex.audit_test_bypass', true) = 'on' AND current_database() LIKE '%\\_ci%' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        RETURN NULL;
      END IF;
      IF TG_OP = 'UPDATE' AND current_setting('fitflex.audit_scrub', true) = 'on'
         AND (to_jsonb(NEW) - 'before' - 'after') = (to_jsonb(OLD) - 'before' - 'after') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'AuditLog rows are append-only (% refused)', TG_OP USING ERRCODE = 'P0001';
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS auditlog_no_change ON "AuditLog"`);
  await knex.raw(`CREATE TRIGGER auditlog_no_change BEFORE UPDATE OR DELETE ON "AuditLog"
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only()`);
  await knex.raw(`DROP TRIGGER IF EXISTS auditlog_no_truncate ON "AuditLog"`);
  await knex.raw(`CREATE TRIGGER auditlog_no_truncate BEFORE TRUNCATE ON "AuditLog"
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only()`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS auditlog_no_change ON "AuditLog"`);
  await knex.raw(`DROP TRIGGER IF EXISTS auditlog_no_truncate ON "AuditLog"`);
  await knex.raw(`DROP FUNCTION IF EXISTS audit_log_append_only()`);
  await knex.raw(`DROP INDEX IF EXISTS auditlog_at_id_idx`);
  await knex.raw(`ALTER TABLE "AuditLog" DROP COLUMN IF EXISTS reason`);
};
