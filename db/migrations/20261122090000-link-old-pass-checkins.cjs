// Link old Platform Pass check-ins to the pass cycle they were made on.
//
// Check-ins made before 30 Sep 2026 have no subscriptionId (the link was
// added then and old rows were left unlinked), so the settlement engine finds
// no visits for those cycles and a run produces no statements. The app holds
// test data only (confirmed 30 Sep 2026; asked for on 4 Oct 2026), so the old
// rows are linked by the obvious rule: the member's pass whose cycle contains
// the check-in's time. A check-in that fits no pass cycle stays unlinked.
//
// Voided check-ins are left alone. The ids that were linked are kept in the
// audit log so the change can be undone exactly.

const ACTION = 'checkin_pass_cycle_linked';

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const { rows } = await knex.raw(`
    UPDATE "Checkin" c
       SET "subscriptionId" = m."subscriptionId"
      FROM (
        SELECT c2."id" AS "checkinId", (
                 SELECT s."id" FROM "Subscription" s
                  WHERE s."memberId" = c2."memberId" AND s."type" = 'platform_pass'
                    AND COALESCE(s."cycleStartedAt", s."startedAt") <= c2."timestamp" AND c2."timestamp" < s."expiresAt"
                  ORDER BY COALESCE(s."cycleStartedAt", s."startedAt") DESC, s."id" LIMIT 1
               ) AS "subscriptionId"
          FROM "Checkin" c2
         WHERE c2."subscriptionId" IS NULL AND c2."status" <> 'voided'
           AND c2."subscriptionType" = 'platform_pass'
      ) m
     WHERE c."id" = m."checkinId" AND m."subscriptionId" IS NOT NULL
 RETURNING c."id"`);
  await knex('AuditLog').insert({
    id: `audit_link_checkins_${Date.now()}`, at: new Date(), actor: 'migration:20261122090000', action: ACTION, target: 'Checkin',
    before: null, after: JSON.stringify({ linked: rows.length, checkinIds: rows.map((r) => r.id) }),
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const logs = await knex('AuditLog').where({ action: ACTION, actor: 'migration:20261122090000' });
  for (const log of logs) {
    const after = typeof log.after === 'string' ? JSON.parse(log.after) : log.after;
    if (after?.checkinIds?.length) await knex('Checkin').whereIn('id', after.checkinIds).update({ subscriptionId: null });
  }
  await knex('AuditLog').where({ action: ACTION, actor: 'migration:20261122090000' }).del();
};
