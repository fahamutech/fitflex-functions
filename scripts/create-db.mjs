#!/usr/bin/env node
// Creates the PostgreSQL database if it does not already exist.
// Reads DATABASE_URL from the environment (same format Prisma uses).

import { execSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const parsed = new URL(url);
const dbName = parsed.pathname.replace(/^\//, '');
// Build a connection string pointing to the default "postgres" database
parsed.pathname = '/postgres';
const adminUrl = parsed.toString();

try {
  // Check if database already exists
  const check = execSync(
    `psql "${adminUrl}" -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();

  if (check === '1') {
    console.log(`✓ Database "${dbName}" already exists.`);
  } else {
    execSync(`psql "${adminUrl}" -c "CREATE DATABASE \\"${dbName}\\";"`, {
      stdio: 'inherit',
    });
    console.log(`✓ Database "${dbName}" created.`);
  }
} catch (err) {
  // If psql isn't available, try createdb (comes with PostgreSQL)
  try {
    execSync(`createdb "${dbName}" 2>/dev/null || true`, { stdio: 'inherit' });
    console.log(`✓ Database "${dbName}" ensured via createdb.`);
  } catch {
    console.error(`✗ Could not create database "${dbName}". Ensure PostgreSQL is running and the user has CREATE DATABASE privileges.`);
    console.error(err.message);
    process.exit(1);
  }
}
