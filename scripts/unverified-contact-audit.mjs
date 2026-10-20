#!/usr/bin/env node
// Report only: how many B2B enrolments, organisation users and company
// employee links may have come from an UNVERIFIED email / number (security
// fix, 20 Oct 2026: matching now uses verified LoginIdentifier rows only).
//
// Prints counts, never names, emails, numbers or ids. Changes nothing: every
// query runs in a READ ONLY transaction. Nothing is reversed (owner decision
// D-7: past enrolments are reported, not undone).
//
// Which database is never guessed and .env is not read. Give one of:
//   node scripts/unverified-contact-audit.mjs --database-url=postgres://…
//   FITFLEX_USE_CI_DB=1 DATABASE_URL_CI=postgres://… node scripts/unverified-contact-audit.mjs
//   DATABASE_URL=postgres://… node scripts/unverified-contact-audit.mjs
// The database name is printed before anything else.
//
// What is counted:
//   invite-matched enrolments: beneficiaries enrolled by the invite-matching
//     job / Benefits screen whose person has NOT verified the invite's email
//     or number. Precise: the invite records the contact.
//   rows below record no contact (only the user id), so the check is a
//   proxy: the account's own User.email / User.phone is set but is not one of
//   its person's verified identifiers, which is what a planted contact
//   leaves behind. It also catches honest people who never verified, so read
//   it as an upper bound:
//     beneficiaries (any way of adding, including bulk import),
//     organisation users (HR / finance / admin roles),
//     company employees linked to a member account.
import knex from 'knex';

const arg = process.argv.slice(2).find(a => a.startsWith('--database-url='));
const url = arg ? arg.slice('--database-url='.length)
  : process.env.FITFLEX_USE_CI_DB === '1' ? process.env.DATABASE_URL_CI : process.env.DATABASE_URL;
if (!url) {
  console.error('Refusing to run: give --database-url=… or set DATABASE_URL (or FITFLEX_USE_CI_DB=1 with DATABASE_URL_CI).');
  process.exit(2);
}

const db = knex({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });

// Verified, active email / number of the account's (any-status) person.
const VERIFIED = `SELECT 1 FROM "LoginIdentifier" li
  WHERE li."personId" = u."personId" AND li.status = 'active' AND li."verifiedAt" IS NOT NULL`;
// User.email / User.phone set but not verified by their person.
const UNVERIFIED_ROW_CONTACT = `(
  (u.email IS NOT NULL AND btrim(u.email) <> '' AND NOT EXISTS (${VERIFIED} AND li.type = 'email' AND li."normalizedValue" = lower(btrim(u.email))))
  OR (u.phone IS NOT NULL AND btrim(u.phone) <> '' AND NOT EXISTS (${VERIFIED} AND li.type = 'phone' AND li."normalizedValue" = u.phone))
)`;
const NO_VERIFIED_AT_ALL = `NOT EXISTS (${VERIFIED} AND li.type IN ('email', 'phone'))`;

const count = async (trx, sql) => Number((await trx.raw(sql)).rows[0].n);

try {
  await db.transaction(async trx => {
    await trx.raw('SET TRANSACTION READ ONLY');
    const { rows: [{ name }] } = await trx.raw('SELECT current_database() AS name');
    console.log(`Database: ${name} (read only)`);

    const report = {
      inviteMatchedEnrolments: await count(trx, `SELECT count(*) AS n FROM "B2BBeneficiaryInvite" i
        JOIN "B2BBeneficiary" b ON b.id = i."beneficiaryId" WHERE i.status = 'enrolled'`),
      inviteMatchedWithoutVerifiedContact: await count(trx, `SELECT count(*) AS n FROM "B2BBeneficiaryInvite" i
        JOIN "B2BBeneficiary" b ON b.id = i."beneficiaryId"
        JOIN "User" u ON u.id = b."userId"
        WHERE i.status = 'enrolled'
          AND NOT EXISTS (${VERIFIED} AND ((li.type = 'email' AND li."normalizedValue" = i.email) OR (li.type = 'phone' AND li."normalizedValue" = i.phone)))`),
      beneficiaries: await count(trx, `SELECT count(*) AS n FROM "B2BBeneficiary" b JOIN "User" u ON u.id = b."userId"`),
      beneficiariesWithUnverifiedRowContact: await count(trx, `SELECT count(*) AS n FROM "B2BBeneficiary" b
        JOIN "User" u ON u.id = b."userId" WHERE ${UNVERIFIED_ROW_CONTACT}`),
      beneficiariesWithNoVerifiedContact: await count(trx, `SELECT count(*) AS n FROM "B2BBeneficiary" b
        JOIN "User" u ON u.id = b."userId" WHERE ${NO_VERIFIED_AT_ALL}`),
      organizationUsers: await count(trx, `SELECT count(*) AS n FROM "B2BOrganizationUser" o
        JOIN "User" u ON u.id = o."userId" WHERE o.status <> 'removed'`),
      organizationUsersWithUnverifiedRowContact: await count(trx, `SELECT count(*) AS n FROM "B2BOrganizationUser" o
        JOIN "User" u ON u.id = o."userId" WHERE o.status <> 'removed' AND ${UNVERIFIED_ROW_CONTACT}`),
      linkedCompanyEmployees: await count(trx, `SELECT count(*) AS n FROM "CorporateEmployee" e
        JOIN "User" u ON u.id = e."userId" WHERE e.status <> 'exited'`),
      linkedCompanyEmployeesWithUnverifiedRowContact: await count(trx, `SELECT count(*) AS n FROM "CorporateEmployee" e
        JOIN "User" u ON u.id = e."userId" WHERE e.status <> 'exited' AND ${UNVERIFIED_ROW_CONTACT}`),
    };
    for (const [k, v] of Object.entries(report)) console.log(`${k.padEnd(48)} ${v}`);
    console.log('Counts only. Nothing was changed.');
  });
} finally {
  await db.destroy();
}
