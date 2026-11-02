// Indexes for the audit log viewer (GET /admin/audit-log): newest first, optionally narrowed by actor or target.
// Ascending on purpose: Postgres scans a btree backwards for the viewer's newest-first order, and an ascending index keeps rows
// with the same timestamp in insertion order for ORDER BY at ASC (many specs and reports rely on that); a DESC index would
// reverse them.
// Built CONCURRENTLY so a large AuditLog is not locked against writes while they build, which is why this migration
// is not transactional. If a build is interrupted Postgres leaves an INVALID index behind: drop it and run again
// (up removes an invalid copy first). Reversible: down drops them.
exports.config = { transaction: false };

const INDEXES = {
  auditlog_at_id_idx: '(at, id)',
  auditlog_actor_at_idx: '(actor, at)',
  auditlog_target_at_idx: '(target, at)',
};

exports.up = async function up(knex) {
  for (const [name, cols] of Object.entries(INDEXES)) {
    // An interrupted earlier build leaves an INVALID index of this name: remove only that.
    const { rows } = await knex.raw(`SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ? AND NOT i.indisvalid`, [name]);
    if (rows.length) await knex.raw(`DROP INDEX CONCURRENTLY "${name}"`);
    await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "AuditLog" ${cols}`);
  }
};

exports.down = async function down(knex) {
  for (const name of Object.keys(INDEXES)) await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
};
