// Identity V2 · I0. Rows written before this migration could hold a password
// as `demo:<plaintext>` (owner-created trainer PINs, the seeded dev admin).
// Replace each with the same scrypt encoding src/auth/password-credentials.mjs
// produces, so the plaintext stops existing while the password keeps working.
//
// Dry run first: `node scripts/report-demo-passwords.mjs` (read-only counts).
//
// Irreversible by design: the plaintext is not kept anywhere to restore.
const { randomBytes, scryptSync } = require('node:crypto');

function scryptEncode(password) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${key}`;
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const rows = await knex('User')
    .select('id', 'passwordHash')
    .where('passwordHash', 'like', 'demo:%');
  for (const row of rows) {
    await knex('User')
      .where({ id: row.id, passwordHash: row.passwordHash })
      .update({ passwordHash: scryptEncode(row.passwordHash.slice('demo:'.length)) });
  }
  if (rows.length) console.log(`[migrate] rehashed ${rows.length} demo password(s)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down() {
  // Intentionally irreversible: restoring plaintext passwords is the thing this removes.
};
