// Identity V2 · I3 — a Person holds at most one live persona of each type.
//
// The rule is enforced by a partial unique index on User (personId, userType).
// If existing data already breaks it (it shouldn't: I1 grouped rows by
// Firebase uid, which is unique per type, and I2 linking refuses duplicates),
// the index is NOT created and each case is recorded as an IdentityConflict
// for review, so a deploy never fails or silently rewrites anything. The
// add-persona service checks the rule itself either way.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const { rows: duplicates } = await knex.raw(`
    SELECT "personId", "userType", array_agg(id ORDER BY "createdAt", id) AS "userIds"
      FROM "User"
     WHERE "personId" IS NOT NULL AND "accountStatus" <> 'closed'
     GROUP BY "personId", "userType"
    HAVING count(*) > 1
  `);

  if (duplicates.length) {
    const { randomUUID } = require('node:crypto');
    for (const d of duplicates) {
      const normalizedValue = `${d.personId}:${d.userType}`;
      const open = await knex('IdentityConflict')
        .where({ kind: 'duplicate_persona', identifierType: 'user_type', normalizedValue, status: 'open' }).first('id');
      if (open) continue;
      await knex('IdentityConflict').insert({
        id: `idc_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        kind: 'duplicate_persona', identifierType: 'user_type', normalizedValue,
        personIds: [d.personId], userIds: d.userIds, status: 'open',
        details: JSON.stringify({ source: 'migration 20261103090000' }),
      });
    }
    console.warn(`[migrate] ${duplicates.length} Person(s) hold two live personas of one type; `
      + 'user_person_type_unique was not created. Resolve the IdentityConflict rows, then create it.');
    return;
  }

  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS user_person_type_unique
    ON "User" ("personId", "userType")
    WHERE "personId" IS NOT NULL AND "accountStatus" <> 'closed'`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS user_person_type_unique');
};
