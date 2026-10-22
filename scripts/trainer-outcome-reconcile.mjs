#!/usr/bin/env node
// Read-only: compares trainer booking outcomes with sponsor benefit usage, live
// refunds and statement lines (src/services/trainer-outcome-reconciliation.mjs).
// Prints counts and up to 50 booking ids per check; changes nothing.
//
//   node scripts/trainer-outcome-reconcile.mjs            # human-readable
//   node scripts/trainer-outcome-reconcile.mjs --json     # JSON
//
// Uses DATABASE_URL (FITFLEX_USE_CI_DB=1 for DATABASE_URL_CI). Exit code 2 when a check finds rows.
import 'dotenv/config';

const json = process.argv.includes('--json');
const { db } = await import('../src/infra/knex-store.mjs');
const { createTrainerOutcomeReconciliation } = await import('../src/services/trainer-outcome-reconciliation.mjs');

try {
  // Read-only all the way: the whole run is one READ ONLY transaction.
  const report = await db.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    return createTrainerOutcomeReconciliation({ db: trx }).run();
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Trainer outcome reconciliation — ${report.checkedAt}`);
    for (const c of report.checks) {
      console.log(`${c.count === 0 ? 'ok  ' : 'FIND'} [${c.severity}] ${c.key}: ${c.count}${c.count ? ` — ${c.sample.join(', ')}` : ''}`);
    }
  }
  if (!report.ok) process.exitCode = 2;
} finally {
  await db.destroy();
}
