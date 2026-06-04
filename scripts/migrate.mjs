#!/usr/bin/env node
/**
 * Auto-migrate script for production startup.
 *
 * Strategy: attempt `prisma migrate deploy`; if it fails with P3009
 * (failed migration in DB), parse the migration name from the error
 * output, mark it as rolled-back via `prisma migrate resolve`, then
 * retry deploy. Repeats until deploy succeeds or a non-P3009 error occurs.
 */

import { execSync, spawnSync } from 'node:child_process';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

// Prisma P3009 message contains: `The `<name>` migration started at … failed`
const P3009_NAME_RE = /The `(\d{14}_\S+?)` migration\b.*?\bfailed/;

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
  if (!combined.includes('P3009')) {
    // Some other error — surface it and abort.
    process.stderr.write('[migrate] deploy failed with a non-P3009 error, aborting.\n');
    process.exit(1);
  }

  const match = combined.match(P3009_NAME_RE);
  if (!match) {
    process.stderr.write('[migrate] P3009 detected but could not parse migration name, aborting.\n');
    process.exit(1);
  }

  const name = match[1];
  console.warn(`[migrate] P3009: resolving failed migration as rolled-back: ${name}`);
  run(`prisma migrate resolve --rolled-back "${name}"`);
  return false; // caller should retry
}

console.log('[migrate] Running prisma migrate deploy (with auto P3009 recovery)…');
for (let attempt = 1; attempt <= 10; attempt++) {
  if (tryDeploy()) {
    console.log('[migrate] Done.');
    break;
  }
  console.log(`[migrate] Retrying deploy (attempt ${attempt + 1})…`);
}
