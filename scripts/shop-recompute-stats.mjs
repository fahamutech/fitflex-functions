#!/usr/bin/env node
// Recompute Product.rating / reviewCount / soldCount from the records — the same service as
// POST /admin/shop/product-stats/recompute (src/services/product-stats-recompute-service.mjs).
//
//   npm run shop:recompute-stats                          # dry run: prints what would change, writes nothing
//   npm run shop:recompute-stats -- --apply               # write the differences (one transaction, audited)
//   npm run shop:recompute-stats -- --product prd_a --product prd_b   # only these products
//
// Uses DATABASE_URL (FITFLEX_USE_CI_DB=1 for DATABASE_URL_CI). The audit actor is cli:<OS user>.
import 'dotenv/config';
import os from 'node:os';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const productIds = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--product' && argv[i + 1]) productIds.push(argv[(i += 1)]);
  else if (argv[i].startsWith('--product=')) productIds.push(argv[i].slice('--product='.length));
  else if (argv[i] !== '--apply') { console.error(`Unknown argument: ${argv[i]}`); process.exit(2); }
}

const { db } = await import('../src/infra/knex-store.mjs');
const { createProductStatsRecomputeService } = await import('../src/services/product-stats-recompute-service.mjs');

const fmt = s => `${s.rating ?? 'null'} / ${s.reviewCount ?? 'null'} / ${s.soldCount ?? 'null'}`;
try {
  const { rows: [{ name: database }] } = await db.raw('select current_database() as name');
  console.log(`Database: ${database}${apply ? '  (APPLY)' : '  (dry run)'}`);
  let actor = 'cli';
  try { actor = `cli:${os.userInfo().username}`; } catch { /* no user name */ }
  const result = await createProductStatsRecomputeService({ db })
    .recompute({ apply, productIds: productIds.length ? productIds : undefined, actorId: actor });
  if (result.error) {
    console.error(`Refused: ${result.error}`);
    process.exitCode = 1;
  } else {
    if (result.changed.length) {
      console.table(result.changed.map(c => ({
        productId: c.productId, name: c.name, vendorId: c.vendorId,
        'before rating/reviews/sold': fmt(c.before), 'after rating/reviews/sold': fmt(c.after),
      })));
    }
    console.log(`checked ${result.checked}, ${result.dryRun ? 'would change' : 'changed'} ${result.changed.length}, unchanged ${result.unchanged}`);
    if (result.dryRun) console.log('Dry run: nothing written. Re-run with --apply to write.');
    else console.log(`Applied at ${result.appliedAt}; audit ${result.runId}`);
  }
} finally {
  await db.destroy();
}
