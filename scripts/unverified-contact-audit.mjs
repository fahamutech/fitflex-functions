#!/usr/bin/env node
// Report only: how many B2B enrolments, organisation users and company
// employee links may have come from an UNVERIFIED email / number (security
// fix, 20 Oct 2026: matching now uses verified LoginIdentifier rows only).
//
// Prints counts, never names, emails, numbers or ids. Changes nothing: every
// query runs in a READ ONLY transaction. Nothing is reversed (owner decision
// D-7: past enrolments are reported, not undone).
//
// Which database is never guessed and .env is not read. Prefer the
// environment (export it from a file or a prompt, so the password doesn't end
// up in shell history):
//   DATABASE_URL=postgres://… node scripts/unverified-contact-audit.mjs
//   FITFLEX_USE_CI_DB=1 DATABASE_URL_CI=postgres://… node scripts/unverified-contact-audit.mjs
// --database-url=postgres://… also works, but leaves the password in shell
// history and the process list; the script warns when it is used.
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
const fromEnv = process.env.FITFLEX_USE_CI_DB === '1' ? process.env.DATABASE_URL_CI : process.env.DATABASE_URL;
const url = fromEnv || (arg ? arg.slice('--database-url='.length) : null);
if (!fromEnv && arg) {
  console.warn('Warning: --database-url= leaves the password in shell history and the process list. Prefer DATABASE_URL in the environment.');
} else if (fromEnv && arg) {
  console.warn('Note: using the database from the environment; --database-url= was ignored.');
}
if (!url) {
  console.error('Refusing to run: give --database-url=… or set DATABASE_URL (or FITFLEX_USE_CI_DB=1 with DATABASE_URL_CI).');
  process.exit(2);
}

const db = knex({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });

// Verified, active email / number of the account's (any-status) person.
const VERIFIED = `SELECT 1 FROM "LoginIdentifier" li
  WHERE li."personId" = u."personId" AND li.status = 'active' AND li."verifiedAt" IS NOT NULL`;
// User.phone normalised the way src/shared/identifiers.mjs normalizePhone
// does (Tanzania default): strip spaces, dots, dashes and brackets; 00… → +…;
// 255 + 9 digits, 0 + 9 digits and bare 9 digits → +255…. Anything else is
// compared as it is (and so counts as unverified).
const PHONE_DIGITS = `regexp_replace(btrim(u.phone), '[[:space:]().-]', '', 'g')`;
const NORMALIZED_PHONE = `(CASE
  WHEN ${PHONE_DIGITS} ~ '^00[0-9]+$' THEN '+' || substr(${PHONE_DIGITS}, 3)
  WHEN ${PHONE_DIGITS} ~ '^\\+[0-9]+$' THEN ${PHONE_DIGITS}
  WHEN ${PHONE_DIGITS} ~ '^255[0-9]{9}$' THEN '+' || ${PHONE_DIGITS}
  WHEN ${PHONE_DIGITS} ~ '^0[0-9]{9}$' THEN '+255' || substr(${PHONE_DIGITS}, 2)
  WHEN ${PHONE_DIGITS} ~ '^[1-9][0-9]{8}$' THEN '+255' || ${PHONE_DIGITS}
  ELSE btrim(u.phone) END)`;
// User.email / User.phone set but not verified by their person.
const UNVERIFIED_ROW_CONTACT = `(
  (u.email IS NOT NULL AND btrim(u.email) <> '' AND NOT EXISTS (${VERIFIED} AND li.type = 'email' AND li."normalizedValue" = lower(btrim(u.email))))
  OR (u.phone IS NOT NULL AND btrim(u.phone) <> '' AND NOT EXISTS (${VERIFIED} AND li.type = 'phone' AND li."normalizedValue" = ${NORMALIZED_PHONE}))
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
