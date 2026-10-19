// A real settings service over in-memory platform settings, for specs that
// need FitFlex Pass tiers. Settings is the only runtime source of tier prices
// and visit caps, so specs configure the tiers they use here.
import { createSettingsService } from '../../src/services/settings-service.mjs';

/** Tiers as an admin might configure them (visits -1 = unlimited). */
export const TEST_TIERS = Object.freeze([
  { key: 'basic',     label: 'Basic',     monthlyPrice: 60_000,  visits: 20, gymAccess: 'standard' },
  { key: 'pro',       label: 'Pro',       monthlyPrice: 120_000, visits: 30, gymAccess: 'midtier' },
  { key: 'premium',   label: 'Premium',   monthlyPrice: 200_000, visits: 40, gymAccess: 'premium' },
  { key: 'executive', label: 'Executive', monthlyPrice: 350_000, visits: -1, gymAccess: 'luxury_executive' },
]);

/** In-memory platform settings with the given tiers (or none: a fresh install). */
export function memoryPlatformSettings(subscriptionTiers = TEST_TIERS) {
  const rows = subscriptionTiers === null ? [] : [{ id: 'platform', subscriptionTiers: subscriptionTiers.map(t => ({ ...t })) }];
  return {
    rows,
    find: (fn) => rows.find(fn) || null,
    insert: (row) => { rows.push(row); return row; },
    async updateAsync(fn, patch) {
      const i = rows.findIndex(fn);
      if (i < 0) return null;
      rows[i] = { ...rows[i], ...patch };
      return rows[i];
    },
  };
}

export function settingsWithTiers(subscriptionTiers = TEST_TIERS) {
  const platformSettings = memoryPlatformSettings(subscriptionTiers);
  const auditLog = { async insertAsync(row) { return row; } };
  return createSettingsService({ platformSettings, auditLog });
}
