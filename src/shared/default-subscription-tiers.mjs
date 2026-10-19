// The FitFlex Pass tiers written into platform settings when the settings row
// is first created (seed-db on start-up, or settingsService on first read if
// the seed has not run yet). Both use this one list so a fresh database gets
// the same tiers whichever writes first.
//
// This is a first-boot seed only, never a runtime price source: once the
// settings row exists, Settings (edited by admins) is the only source of tier
// prices and visit caps. These values are the ones live today; changing them
// here does not change an existing database.
export const DEFAULT_SUBSCRIPTION_TIERS = Object.freeze([
  Object.freeze({ key: 'basic',     label: 'Basic',     monthlyPrice: 30000,  visits: 12, gymAccess: 'standard' }),
  Object.freeze({ key: 'pro',       label: 'Pro',       monthlyPrice: 60000,  visits: 30, gymAccess: 'midtier' }),
  Object.freeze({ key: 'premium',   label: 'Premium',   monthlyPrice: 100000, visits: 30, gymAccess: 'premium' }),
  Object.freeze({ key: 'executive', label: 'Executive', monthlyPrice: 200000, visits: 30, gymAccess: 'luxury_executive' }),
]);

/** A fresh, mutable copy (settings rows are written and edited). */
export const defaultSubscriptionTiers = () => DEFAULT_SUBSCRIPTION_TIERS.map(t => ({ ...t }));
