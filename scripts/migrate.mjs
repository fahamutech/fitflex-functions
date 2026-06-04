#!/usr/bin/env node
/**
 * Auto-migrate script for production startup.
 *
 * Steps:
 *  1. Run `prisma migrate status` and collect any migration name that is
 *     recorded as "failed" (Prisma error P3009).
 *  2. For each failed migration, run `prisma migrate resolve --rolled-back`
 *     to clear the failed state so deploy can proceed.
 *  3. Run `prisma migrate deploy`.
 */

import { execSync } from 'node:child_process';

const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: 'inherit', ...opts });

const capture = (cmd) =>
  execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

console.log('[migrate] Checking migration status…');

let statusOut = '';
try {
  statusOut = capture('prisma migrate status');
} catch (err) {
  statusOut = (err.stdout ?? '') + (err.stderr ?? '');
}

const failedPattern = /^.*?(\d{14}_\S+)\s+migration.*?failed/gim;
const failed = [...statusOut.matchAll(failedPattern)].map((m) => m[1]);

if (failed.length) {
  console.warn(`[migrate] Found ${failed.length} failed migration(s), resolving as rolled-back:`);
  for (const name of failed) {
    console.warn(`  ↩  ${name}`);
    run(`prisma migrate resolve --rolled-back "${name}"`);
  }
}

console.log('[migrate] Running prisma migrate deploy…');
run('prisma migrate deploy');
console.log('[migrate] Done.');
