#!/usr/bin/env node
// Phase B · B5a — make every company HR login an organisation user (role hr)
// on its company's employer organisation. See
// src/services/hr-org-conversion-service.mjs.
//
//   node scripts/hr-to-org.mjs                       # dry run: says what it would do
//   node scripts/hr-to-org.mjs --apply               # write
//   node scripts/hr-to-org.mjs --corporate=<id>      # one company only
//   node scripts/hr-to-org.mjs --json                # the full report as JSON
//
// Additive and safe to run again: the corporate_hr login keeps working, a
// live organisation-user row is left alone, a removed one is never brought
// back, and each row added writes an AuditLog entry
// (b2b.org_user.convert_corporate_hr). A missing employer organisation is
// created the way onboarding creates it. Nothing here reads ORG_ONLY_SPONSORS:
// the rows give the same access the read-through rule already gives, and the
// flag decides what the portal is told at sign-in.
//
// Uses DATABASE_URL (FITFLEX_USE_CI_DB=1 for DATABASE_URL_CI) and prints the
// database name first so you can stop if it is the wrong one.
import dotenv from 'dotenv';

// Quiet: dotenv's banner goes to stdout and would break --json output.
process.env.DOTENV_CONFIG_QUIET = 'true';   // modules imported below load dotenv too
dotenv.config({ quiet: true });

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const asJson = args.includes('--json');
const corporateId = args.find(a => a.startsWith('--corporate='))?.slice('--corporate='.length) || null;

const url = process.env.FITFLEX_USE_CI_DB === '1' ? process.env.DATABASE_URL_CI : process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const dbName = new URL(url).pathname.replace(/^\//, '');

const { db, collection } = await import('../src/infra/knex-store.mjs');
const { createB2BService } = await import('../src/services/b2b-service.mjs');
const { createHrOrgConversionService } = await import('../src/services/hr-org-conversion-service.mjs');

try {
  console.error(`[hr-to-org] database: ${dbName} · ${apply ? 'APPLY (writes)' : 'dry run (no writes)'}${corporateId ? ` · company ${corporateId}` : ''}`);
  const users = collection('users');
  const corporateAccounts = collection('corporate_accounts');
  const organizations = collection('b2b_organizations');
  const organizationUsers = collection('b2b_organization_users');
  const auditLog = collection('audit_log');
  const b2bService = createB2BService({
    users, corporateAccounts, corporateEmployees: collection('corporate_employees'),
    partnerKycCases: collection('partner_kyc_cases'),
    organizations, organizationUsers, beneficiaries: collection('b2b_beneficiaries'), auditLog,
  });
  const conversion = createHrOrgConversionService({ users, corporateAccounts, organizations, organizationUsers, auditLog, b2bService });
  const report = await conversion.run({ dryRun: !apply, corporateId });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const verb = apply ? '' : 'would be ';
    for (const i of report.items) {
      console.log(`${i.outcome.padEnd(24)} ${i.userId} ${i.email ?? ''} company=${i.corporateId ?? '-'} org=${i.organizationId ?? (i.mirrorCreated ? '(new mirror)' : '-')}${i.mirrorCreated ? ' mirror ' + verb + 'created' : ''}`);
    }
    console.log(`\n${report.total} HR login(s): ${Object.entries(report.counts).map(([k, v]) => `${k}=${v}`).join(', ')}; mirrors ${verb}created: ${report.mirrorsCreated}.`);
    if (!apply) console.log('Dry run: nothing written. Run again with --apply to write.');
  }
} finally {
  await db.destroy();
}
