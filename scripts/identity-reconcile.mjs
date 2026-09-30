#!/usr/bin/env node
// Identity V2 · I1 — email/phone LoginIdentifiers and identity conflicts.
// See src/infra/identity-reconcile.mjs. Prints counts only, never identifiers.
//
//   node scripts/identity-reconcile.mjs                    # dry run, no Firebase
//   node scripts/identity-reconcile.mjs --firebase         # dry run with Firebase evidence
//   node scripts/identity-reconcile.mjs --firebase --apply # write
//
// Without --firebase nothing can be marked verified. Uses DATABASE_URL
// (FITFLEX_USE_CI_DB=1 for DATABASE_URL_CI) and the usual Firebase Admin env.
import 'dotenv/config';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const useFirebase = args.has('--firebase');

const { db } = await import('../src/infra/knex-store.mjs');
const { reconcileIdentities, firebaseUsersLookup } = await import('../src/infra/identity-reconcile.mjs');

let lookupFirebaseUsers = null;
if (useFirebase) {
  const { initFirebaseAdmin, getAdminAuth } = await import('../src/auth/firebase.mjs');
  initFirebaseAdmin();
  lookupFirebaseUsers = uids => firebaseUsersLookup(getAdminAuth, uids);
}

try {
  if (!(await db.schema.hasTable('LoginIdentifier'))) {
    console.error('LoginIdentifier table missing — run the migrations first (20261030090000-identity-foundation).');
    process.exitCode = 1;
  } else {
    const report = await reconcileIdentities({ db, lookupFirebaseUsers, apply });
    const byKind = report.conflicts.reduce((acc, c) => ({ ...acc, [c.kind]: (acc[c.kind] || 0) + 1 }), {});
    console.log(JSON.stringify({ ...report, conflicts: { total: report.conflicts.length, byKind } }, null, 2));
    if (!apply) console.log('\nDry run: nothing written. Re-run with --apply to write.');
  }
} finally {
  await db.destroy();
}
