#!/usr/bin/env node
// Identity V2 · I4 — reconcile OrgMembership with its sources.
// See src/services/org-membership-service.mjs. Prints counts only.
//
//   node scripts/org-membership-sync.mjs          # dry run = drift check
//   node scripts/org-membership-sync.mjs --apply  # write
//
// In the dry run, inserted / updated / ended above zero means memberships and
// their sources (gymIds, trainer gyms, direct subscriptions, vendorId)
// disagree. Uses DATABASE_URL (FITFLEX_USE_CI_DB=1 for DATABASE_URL_CI).
import 'dotenv/config';

const apply = process.argv.includes('--apply');
const { db } = await import('../src/infra/knex-store.mjs');
const { createOrgMembershipService } = await import('../src/services/org-membership-service.mjs');

try {
  if (!(await db.schema.hasTable('OrgMembership'))) {
    console.error('OrgMembership table missing — run the migrations first (20261105090000-org-membership).');
    process.exitCode = 1;
  } else {
    const report = await createOrgMembershipService({ db }).syncAll({ apply });
    console.log(JSON.stringify(report, null, 2));
    if (!apply) console.log(`\nDry run: nothing written. Drift = ${report.inserted + report.updated + report.ended + report.vendors}.`);
  }
} finally {
  await db.destroy();
}
