// One live check-in per member, gym and East Africa Time day.
//
// The check-in service already returns the existing visit when a member is
// scanned again the same day, but it did so by reading first and inserting
// after. Two scans a few milliseconds apart (a double tap, two desks) both
// passed the read and both inserted: two visits, and for a company-funded
// visit two charges to the sponsor. This index makes the database refuse the
// second one; the service then returns the first.
//
// Voided visits are left out, so a visit voided by mistake does not block the
// member's real one. Rows from before `businessDate` existed are left out too.
//
// If duplicates already exist the index is skipped (the deploy must not
// fail) and the rows are named in the log; remove or void them and rerun.

const INDEX = 'checkin_one_visit_per_day_uq';

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const { rows } = await knex.raw(`
    SELECT "memberId", "gymId", "businessDate", count(*)::int AS n
      FROM "Checkin"
     WHERE "businessDate" IS NOT NULL AND "status" <> 'voided'
     GROUP BY 1, 2, 3 HAVING count(*) > 1
     LIMIT 20`);
  if (rows.length) {
    console.warn(`[migration] ${INDEX} NOT created: ${rows.length}${rows.length === 20 ? '+' : ''} member/gym/day groups already hold more than one live check-in:`,
      rows.map((r) => `${r.memberId}@${r.gymId}@${r.businessDate}×${r.n}`).join(', '));
    return;
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON "Checkin" ("memberId", "gymId", "businessDate")
    WHERE "businessDate" IS NOT NULL AND "status" <> 'voided'`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
};
