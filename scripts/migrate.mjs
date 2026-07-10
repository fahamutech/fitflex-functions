#!/usr/bin/env node
/**
 * Auto-migrate script for production startup.
 *
 * Strategy: attempt `prisma migrate deploy`; if it fails with P3009
 * (failed migration in DB), parse the migration name from the error
 * output, mark it as rolled-back via `prisma migrate resolve`, then
 * retry deploy. Repeats until deploy succeeds or a non-P3009 error occurs.
 *
 * Edge case: a migration can be recorded as "failed" in `_prisma_migrations`
 * even though its DDL actually committed — e.g. the process was killed after
 * `ALTER TABLE` succeeded but before Prisma wrote the success record. In that
 * case, resolving it as rolled-back and retrying re-runs the same DDL, which
 * fails with a "already exists" / duplicate-object error (Postgres codes
 * 42701/42P07/42710, surfaced by Prisma as P3018). When we detect that this
 * happened right after we ourselves marked the migration rolled-back, we
 * re-resolve it as `--applied` instead of aborting, since the schema change
 * is in fact already present.
 */

import { execSync, spawnSync } from 'node:child_process';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

// Prisma P3009 message contains: `The `<name>` migration started at … failed`
const P3009_NAME_RE = /The `(\d{14}_\S+?)` migration\b.*?\bfailed/;
// Prisma P3018 message contains: `Migration name: <name>`
const P3018_NAME_RE = /Migration name:\s*(\d{14}_\S+)/;
const ALREADY_EXISTS_RE = /already exists/i;

let lastRolledBack = null;

function tryDeploy() {
  const result = spawnSync(
    'prisma',
    ['migrate', 'deploy'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Print output regardless so server logs stay useful.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status === 0) return true; // success

  const combined = (result.stdout ?? '') + (result.stderr ?? '');

  if (combined.includes('P3009')) {
    const match = combined.match(P3009_NAME_RE);
    if (!match) {
      process.stderr.write('[migrate] P3009 detected but could not parse migration name, aborting.\n');
      process.exit(1);
    }

    const name = match[1];
    console.warn(`[migrate] P3009: resolving failed migration as rolled-back: ${name}`);
    run(`prisma migrate resolve --rolled-back "${name}"`);
    lastRolledBack = name;
    return false; // caller should retry
  }

  if (combined.includes('P3018') && ALREADY_EXISTS_RE.test(combined)) {
    const match = combined.match(P3018_NAME_RE);
    const name = match ? match[1] : lastRolledBack;
    if (name && name === lastRolledBack) {
      // The DDL had actually already committed before the crash that led to
      // the P3009 above; the schema change is present, so mark it applied.
      console.warn(`[migrate] P3018 (already exists) right after rolling back ${name}: resolving as applied instead.`);
      run(`prisma migrate resolve --applied "${name}"`);
      lastRolledBack = null;
      return false; // caller should retry
    }
  }

  // Some other error — surface it and abort.
  process.stderr.write('[migrate] deploy failed with an unrecoverable error, aborting.\n');
  process.exit(1);
}

console.log('[migrate] Running prisma migrate deploy (with auto P3009 recovery)…');
for (let attempt = 1; attempt <= 10; attempt++) {
  if (tryDeploy()) {
    console.log('[migrate] Done.');
    break;
  }
  console.log(`[migrate] Retrying deploy (attempt ${attempt + 1})…`);
}
