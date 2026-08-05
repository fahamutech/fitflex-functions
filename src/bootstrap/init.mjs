// Lazy init: seed + prime on first request (no top-level await for bfast compat).
// Only small/static collections are primed into memory; large/dynamic ones are
// queried directly from PostgreSQL on demand (see src/infra/knex-store.mjs).
import { ensureSeedDb } from '../infra/seed-db.mjs';
import { gyms, otps, trainers, platformSettings } from './collections.mjs';

let _initDone = false;
let _initPromise = null;

export function ensureInit() {
  if (_initDone) return Promise.resolve();
  if (!_initPromise) {
    _initPromise = (async () => {
      await ensureSeedDb();
      await Promise.all([gyms.ready, otps.ready, trainers.ready, platformSettings.ready]);
      _initDone = true;
      console.log('[fitflex] Static collections primed from PostgreSQL (users/subs/checkins/audit queried on demand).');
    })();
  }
  return _initPromise;
}

// Fire init eagerly (non-blocking) so it's ready before first request.
ensureInit().catch(err => {
  console.warn('[fitflex] Background collection priming failed:', err?.message || err);
});
