#!/usr/bin/env node
// Report only: how many stored member dates of birth (User.memberProfile.dateOfBirth) fail the
// strict rule in src/shared/date-of-birth.mjs (a real "YYYY-MM-DD" day, 1901-01-01 to today in
// Dar es Salaam). Since 2026-10-22 such a date counts as "no date of birth": it no longer matches
// age conditions in communications audiences, and shop personalisation fails closed on it.
// Nothing is repaired here.
//
// Prints counts, never names, ids or the dates themselves. Every query runs in a READ ONLY
// transaction. Which database is never guessed and .env is not read:
//   DATABASE_URL=postgres://… node scripts/member-dob-audit.mjs
//   FITFLEX_USE_CI_DB=1 DATABASE_URL_CI=postgres://… node scripts/member-dob-audit.mjs
// The database name is printed before anything else.
import knex from 'knex';
import { classifyStoredDateOfBirth } from '../src/shared/date-of-birth.mjs';

const url = process.env.FITFLEX_USE_CI_DB === '1' ? process.env.DATABASE_URL_CI : process.env.DATABASE_URL;
if (!url) {
  console.error('Refusing to run: set DATABASE_URL (or FITFLEX_USE_CI_DB=1 with DATABASE_URL_CI).');
  process.exit(2);
}

const db = knex({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
try {
  await db.transaction(async trx => {
    await trx.raw('SET TRANSACTION READ ONLY');
    const { rows: [{ name }] } = await trx.raw('SELECT current_database() AS name');
    console.log(`Database: ${name} (read only)`);
    // The raw JSON value, so numbers or objects stored by mistake are counted too.
    const { rows } = await trx.raw(`SELECT "memberProfile"->'dateOfBirth' AS dob FROM "User"
      WHERE "memberProfile" IS NOT NULL AND "memberProfile" \\? 'dateOfBirth'`);
    const counts = {
      valid: 0, absent: 0, invalid_format: 0, invalid_impossible_day: 0, invalid_before_1901: 0,
      invalid_in_future: 0, invalid_not_text: 0,
    };
    for (const r of rows) counts[classifyStoredDateOfBirth(r.dob)] += 1;
    const invalid = Object.entries(counts).filter(([k]) => k.startsWith('invalid')).reduce((n, [, v]) => n + v, 0);
    console.log(`${'users_with_dateOfBirth_key'.padEnd(28)} ${rows.length}`);
    for (const [k, v] of Object.entries(counts)) console.log(`${k.padEnd(28)} ${v}`);
    console.log(`${'invalid_total'.padEnd(28)} ${invalid}`);
    console.log('Counts only. Nothing was changed.');
  });
} finally {
  await db.destroy();
}
