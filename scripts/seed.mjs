#!/usr/bin/env node
// Standalone seed runner for postinstall — seeds admin user + platform settings.
import { ensureSeedDb } from '../src/infra/seed-db.mjs';

try {
  await ensureSeedDb();
  process.exit(0);
} catch (err) {
  console.error('[seed] Failed to seed database:', err.message);
  process.exit(1);
}
