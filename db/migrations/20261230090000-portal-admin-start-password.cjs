// Portal admins created by another admin must change the start password the
// creator chose, the first time they sign in (owner decision 2026-10-19).
//
//   User.passwordChangeRequired  true while the start password set by the
//                                creator is still the working one. Sessions of
//                                such a user carry `pwc: true` and are refused
//                                everywhere except the change-password route.
//   User.startPasswordHash       HMAC-SHA256 (keyed with PIN_PEPPER) of
//                                `start-password:<userId>:<password>`, so the new
//                                password can be refused when it equals the
//                                start one. Never the password itself; cleared
//                                once the password is changed.
//   User.sessionsValidAfter      sessions of this profile issued before this are
//                                no longer accepted (set when the start password
//                                is changed). Person.sessionsValidAfter does the
//                                same for people; portal-only admins have no Person.
//
// Additive: nullable / defaulted columns, nothing backfilled (existing admins are
// unaffected). Down drops the three columns.

const COLUMNS = ['passwordChangeRequired', 'startPasswordHash', 'sessionsValidAfter'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const missing = [];
  for (const c of COLUMNS) if (!(await knex.schema.hasColumn('User', c))) missing.push(c);
  if (!missing.length) return;
  await knex.schema.alterTable('User', (table) => {
    if (missing.includes('passwordChangeRequired')) table.boolean('passwordChangeRequired').notNullable().defaultTo(false);
    if (missing.includes('startPasswordHash')) table.text('startPasswordHash');
    if (missing.includes('sessionsValidAfter')) table.timestamp('sessionsValidAfter', { useTz: true });
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const present = [];
  for (const c of COLUMNS) if (await knex.schema.hasColumn('User', c)) present.push(c);
  if (!present.length) return;
  await knex.schema.alterTable('User', (table) => {
    for (const c of present) table.dropColumn(c);
  });
};
