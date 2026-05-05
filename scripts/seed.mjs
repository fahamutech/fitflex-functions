#!/usr/bin/env node
// Standalone seed runner for postinstall — seeds admin user + platform settings.
import { ensureSeedPrisma } from '../src/infra/seed-prisma.mjs';

try {
  await ensureSeedPrisma();
  process.exit(0);
} catch (err) {
  console.error('[seed] Failed to seed database:', err.message);
  process.exit(1);
}
