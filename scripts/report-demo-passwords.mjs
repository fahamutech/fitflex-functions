#!/usr/bin/env node
// Read-only dry run for db/migrations/20261021090000-rehash-demo-passwords.cjs.
// Counts User rows whose password is still stored as `demo:<plaintext>`,
// grouped by role. Prints counts only — never ids, emails or passwords.
//
//   node scripts/report-demo-passwords.mjs          # DATABASE_URL
//   FITFLEX_USE_CI_DB=1 node scripts/report-demo-passwords.mjs

import 'dotenv/config';
import knexFactory from 'knex';

const connection = process.env.FITFLEX_USE_CI_DB === '1'
  ? process.env.DATABASE_URL_CI
  : process.env.DATABASE_URL;
if (!connection) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const db = knexFactory({ client: 'pg', connection });
const dbName = new URL(connection).pathname.slice(1);
try {
  if (!(await db.schema.hasTable('User'))) {
    console.error(`database "${dbName}" has no "User" table — is DATABASE_URL pointing at the right database?`);
    process.exitCode = 1;
  } else {
    const rows = await db('User')
      .select('userType')
      .count({ n: '*' })
      .where('passwordHash', 'like', 'demo:%')
      .groupBy('userType')
      .orderBy('userType');
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    console.log(`database: ${dbName}`);
    console.log(`rows the migration would rehash: ${total}`);
    for (const r of rows) console.log(`  ${r.userType}: ${r.n}`);
  }
} finally {
  await db.destroy();
}
