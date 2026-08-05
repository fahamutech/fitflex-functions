// Seed admin user + default platform settings into PostgreSQL via Knex.
// All other data (gyms, operators, trainers) is managed by the admin portal.
// Idempotent — safe to call on every startup.
import { db } from './knex-store.mjs';

const PILOT_ADMIN_EMAIL = process.env.FITFLEX_ADMIN_EMAILS?.split(',')[0]?.trim() || 'mama27j@gmail.com';

const DEFAULT_SETTINGS = {
  id: 'platform',
  subscriptionTiers: [
    { key: 'basic',     label: 'Basic',     monthlyPrice: 30000,  visits: 12, gymAccess: 'standard' },
    { key: 'pro',       label: 'Pro',        monthlyPrice: 60000,  visits: 30, gymAccess: 'midtier' },
    { key: 'premium',   label: 'Premium',   monthlyPrice: 100000, visits: 30, gymAccess: 'premium' },
    { key: 'executive', label: 'Executive', monthlyPrice: 200000, visits: 30, gymAccess: 'luxury_executive' },
  ],
  payoutBands: [
    { key: 'band1', label: 'Band 1 (0-49)',    minVisits: 0,   maxVisits: 49,  payoutTiming: 'monthly',  commissionPct: 20 },
    { key: 'band2', label: 'Band 2 (50-99)',   minVisits: 50,  maxVisits: 99,  payoutTiming: 'biweekly', commissionPct: 15 },
    { key: 'band3', label: 'Band 3 (100-299)', minVisits: 100, maxVisits: 299, payoutTiming: 'weekly',   commissionPct: 12 },
    { key: 'band4', label: 'Band 4 (300-499)', minVisits: 300, maxVisits: 499, payoutTiming: 'daily',    commissionPct: 10 },
    { key: 'band5', label: 'Band 5 (500+)',    minVisits: 500, maxVisits: 99999, payoutTiming: 'daily',  commissionPct: 0 },
  ],
  paymentPeriodDays: 14,
  payoutModel: 'commission',
  currency: 'TZS',
};

export async function ensureSeedDb() {
  const now = new Date();

  // Admin user
  await db('User')
    .insert({
      id: 'usr_admin_1', userType: 'admin', email: PILOT_ADMIN_EMAIL,
      passwordHash: 'demo:admin123', accountStatus: 'active', approvalStatus: 'approved',
      updatedAt: now,
    })
    .onConflict('id')
    .merge({ passwordHash: 'demo:admin123', userType: 'admin', updatedAt: now });

  // Platform settings
  await db('PlatformSettings')
    .insert({
      id: DEFAULT_SETTINGS.id,
      subscriptionTiers: JSON.stringify(DEFAULT_SETTINGS.subscriptionTiers),
      payoutBands: JSON.stringify(DEFAULT_SETTINGS.payoutBands),
      paymentPeriodDays: DEFAULT_SETTINGS.paymentPeriodDays,
      payoutModel: DEFAULT_SETTINGS.payoutModel,
      currency: DEFAULT_SETTINGS.currency,
      updatedAt: now,
    })
    .onConflict('id')
    .ignore();

  console.log('[seed] Admin user + platform settings seeded.');
}
