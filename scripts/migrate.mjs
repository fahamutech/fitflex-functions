#!/usr/bin/env node
/**
 * Auto-migrate script for production startup.
 *
 * Runs `knex migrate:latest` against DATABASE_URL. Knex migrations here are
 * written defensively (each createTable is guarded by `hasTable`), so this
 * is safe to run repeatedly and safe to run against a database that already
 * has the full schema (e.g. one originally provisioned by Prisma).
 */

import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'npx',
  ['knex', '--knexfile', 'knexfile.cjs', 'migrate:latest'],
  { encoding: 'utf8', stdio: 'inherit' },
);

if (result.status !== 0) {
  process.stderr.write('[migrate] knex migrate:latest failed, aborting.\n');
  process.exit(result.status ?? 1);
}

console.log('[migrate] Done.');
