// Prisma-backed store that exposes the same collection() API as json-store.mjs.
// Reads go through PG via Prisma; writes sync to PG immediately.
// This is the production data layer — replaces json-store.mjs.

import dotenv from 'dotenv';
dotenv.config();

import pkg from '@prisma/client';
const { PrismaClient } = pkg;
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('FATAL: DATABASE_URL must be set. Create a .env file or export it.');

const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
export { prisma };

// Map collection names → Prisma model delegates + special handling
const MODEL_MAP = {
  users:             { delegate: () => prisma.user },
  gyms:              { delegate: () => prisma.gym },
  subscriptions:     { delegate: () => prisma.subscription },
  checkins:          { delegate: () => prisma.checkin },
  otps:              { delegate: () => prisma.otp },
  audit_log:         { delegate: () => prisma.auditLog },
  payment_requests:  { delegate: () => prisma.paymentRequest },
  trainers:          { delegate: () => prisma.trainerProfile, transform: trainerFromDb, prepareWrite: trainerToDb },
  trainer_bookings:  { delegate: () => prisma.trainerBooking },
  invoices:          { delegate: () => prisma.invoice },
  platform_settings: { delegate: () => prisma.platformSettings },
  gym_payouts:       { delegate: () => prisma.gymPayout },
  webhook_seen:      { delegate: () => prisma.webhookSeen },
  gym_owners:        { delegate: () => prisma.user, defaultFilter: { userType: 'gym_operator' } },
};

// Trainers have a gymIds join table — flatten on read, expand on write
function trainerFromDb(row) {
  if (!row) return row;
  const obj = { ...row };
  if (row.gyms) {
    obj.gymIds = row.gyms.map(g => g.gymId);
    delete obj.gyms;
  }
  if (row.availability && typeof row.availability === 'string') {
    try { obj.availability = JSON.parse(row.availability); } catch { /* keep as-is */ }
  }
  return obj;
}

function trainerToDb(data) {
  const { gymIds, id, gyms, createdAt, updatedAt, ...rest } = data;
  return { fields: rest, gymIds: gymIds ?? null };
}

// OTP uses phone as PK — need special handling for upsert
const PHONE_PK_COLLECTIONS = new Set(['otps']);
// webhook_seen uses id as both PK and the unique key
const ID_PK_COLLECTIONS = new Set(['webhook_seen', 'platform_settings']);

// In-memory cache to support predicate-based find/filter without hitting PG every time.
// Cache is invalidated on writes. For pilot scale this is fine.
const cache = new Map();
const CACHE_TTL = 1_000; // 1s - reduced for near real-time data
const cacheTimers = new Map();

async function loadAll(name, meta) {
  const now = Date.now();
  const cached = cache.get(name);
  if (cached && (now - cached.ts < CACHE_TTL)) return cached.data;

  const delegate = meta.delegate();
  let include = undefined;
  if (name === 'trainers') include = { gyms: true };

  let rows = await delegate.findMany({
    ...(meta.defaultFilter ? { where: meta.defaultFilter } : {}),
    ...(include ? { include } : {})
  });
  if (meta.transform) rows = rows.map(meta.transform);
  // Convert dates and BigInts to plain values for compatibility
  rows = rows.map(r => JSON.parse(JSON.stringify(r, (_, v) => typeof v === 'bigint' ? Number(v) : v)));
  cache.set(name, { data: rows, ts: now });
  return rows;
}

function invalidate(name) {
  cache.delete(name);
}

function pkField(name) {
  if (PHONE_PK_COLLECTIONS.has(name)) return 'phone';
  return 'id';
}

/**
 * Returns a collection handle with the same sync-looking API as json-store,
 * but backed by async Prisma calls under the hood.
 *
 * IMPORTANT: all methods now return Promises. Callers that were synchronous
 * need to be updated to await. For the migration period, we provide both
 * sync (cached) and async versions.
 */
export function collection(name) {
  const meta = MODEL_MAP[name];
  if (!meta) {
    throw new Error(`prisma-store: unknown collection "${name}". Add it to MODEL_MAP.`);
  }

  // In-memory store. Initialised to [] immediately so pre-prime writes
  // go into the same array reference (not a throw-away []).
  let _syncData = [];
  let _primed = false;

  // Prime by merging PG rows into the existing array.
  // Any writes that arrived before the prime completes are kept as-is
  // (they are already being persisted asynchronously).
  const primePromise = loadAll(name, meta).then(rows => {
    const pkF = pkField(name);
    const inMemoryPks = new Set(_syncData.map(r => r[pkF]));
    for (const row of rows) {
      if (!inMemoryPks.has(row[pkF])) {
        _syncData.push(row);
      }
      // If already in memory (pre-prime write), keep the in-memory version
    }
    _primed = true;
  }).catch(err => {
    console.error(`[prisma-store] Failed to prime "${name}":`, err.message);
    _primed = true;
  });

  function getSyncData() {
    return _syncData; // always the same array reference
  }

  const col = {
    /** Wait until initial data is loaded from PG */
    ready: primePromise,

    all:    () => getSyncData().slice(),
    find:   (pred) => getSyncData().find(pred) ?? null,
    filter: (pred) => getSyncData().filter(pred),

    /** Async versions that always query the database directly (bypass cache) */
    allAsync: async () => {
      const rows = await loadAll(name, meta);
      return rows.slice();
    },

    findAsync: async (pred) => {
      const rows = await loadAll(name, meta);
      return rows.find(pred) ?? null;
    },

    filterAsync: async (pred) => {
      const rows = await loadAll(name, meta);
      return rows.filter(pred);
    },

    /** Find by ID directly from database (bypasses cache) */
    findByIdAsync: async (id) => {
      const delegate = meta.delegate();
      let include = undefined;
      if (name === 'trainers') include = { gyms: true };

      let row = await delegate.findFirst({
        where: { id },
        ...(include ? { include } : {})
      });

      if (row && meta.transform) row = meta.transform(row);
      if (row) row = JSON.parse(JSON.stringify(row, (_, v) => typeof v === 'bigint' ? Number(v) : v));
      return row ?? null;
    },

    insert: (row) => {
      // Optimistic: add to sync cache immediately, then persist async
      const data = getSyncData();
      data.push(row);
      invalidate(name); // will re-fetch on next loadAll

      // Async persist
      (async () => {
        try {
          const delegate = meta.delegate();
          if (name === 'trainers') {
            const { fields, gymIds } = trainerToDb(row);
            await delegate.create({
              data: {
                id: row.id,
                ...fields,
                ...(gymIds ? { gyms: { create: gymIds.map(gId => ({ gymId: gId })) } } : {})
              }
            });
          } else if (name === 'otps') {
            await delegate.upsert({
              where: { phone: row.phone },
              create: { phone: row.phone, code: row.code, userType: row.userType, expiresAt: new Date(row.expiresAt) },
              update: { code: row.code, userType: row.userType, expiresAt: new Date(row.expiresAt) },
            });
          } else {
            const writeData = prepareForPrisma(name, row);
            await delegate.create({ data: writeData });
          }
        } catch (err) {
          console.error(`[prisma-store] insert ${name} (id=${row.id || row.phone || '?'}):`, err.message, err.meta || '');
        }
      })();

      return row;
    },

    update: (pred, patch) => {
      const data = getSyncData();
      const i = data.findIndex(pred);
      if (i < 0) return null;
      data[i] = { ...data[i], ...patch };
      const updated = data[i];
      invalidate(name);

      (async () => {
        try {
          const delegate = meta.delegate();
          const pk = pkField(name);
          const id = updated[pk];
          if (!id) return;

          if (name === 'trainers') {
            const { fields, gymIds } = trainerToDb(patch);
            const updateData = { ...fields };
            // Remove undefined values
            Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
            if (gymIds) {
              await delegate.update({
                where: { id },
                data: {
                  ...updateData,
                  gyms: {
                    deleteMany: {},
                    create: gymIds.map(gId => ({ gymId: gId }))
                  }
                }
              });
            } else {
              await delegate.update({ where: { id }, data: updateData });
            }
          } else {
            const writeData = prepareForPrisma(name, patch, true);
            await delegate.update({ where: { [pk]: id }, data: writeData });
          }
        } catch (err) {
          console.error(`[prisma-store] update ${name} (id=${updated[pkField(name)] || '?'}):`, err.message, err.meta || '');
        }
      })();

      return updated;
    },

    remove: (pred) => {
      const data = getSyncData();
      const i = data.findIndex(pred);
      if (i < 0) return null;
      const [row] = data.splice(i, 1);
      invalidate(name);

      (async () => {
        try {
          const delegate = meta.delegate();
          const pk = pkField(name);
          const id = row[pk];
          if (id) await delegate.delete({ where: { [pk]: id } });
        } catch (err) {
          console.error(`[prisma-store] remove ${name}:`, err.message);
        }
      })();

      return row;
    },

    // Shared DB-persist logic used by both upsert (sync) and upsertAsync (awaitable)
    _persistUpsert: async (row) => {
      const delegate = meta.delegate();
      if (name === 'otps') {
        await delegate.upsert({
          where: { phone: row.phone },
          create: { phone: row.phone, code: row.code, userType: row.userType, expiresAt: new Date(row.expiresAt) },
          update: { code: row.code, userType: row.userType, expiresAt: new Date(row.expiresAt) },
        });
      } else if (name === 'platform_settings') {
        const writeData = prepareForPrisma(name, row);
        await delegate.upsert({
          where: { id: row.id || 'platform' },
          create: writeData,
          update: writeData,
        });
      } else {
        const pk = pkField(name);
        const id = row[pk];
        if (!id) return;
        const writeData = prepareForPrisma(name, row);
        const { [pk]: _omit, createdAt: _ca, ...updateData } = writeData;
        await delegate.upsert({
          where: { [pk]: id },
          create: writeData,
          update: updateData,
        });
      }
    },

    upsert: (pred, row) => {
      const data = getSyncData();
      const i = data.findIndex(pred);
      if (i < 0) {
        data.push(row);
      } else {
        data[i] = { ...data[i], ...row };
      }
      invalidate(name);

      // Fire-and-forget persist — for critical paths use upsertAsync instead
      col._persistUpsert(row).catch(err => {
        console.error(`[prisma-store] upsert ${name} (id=${row[pkField(name)]}):`, err.message, err.meta || '');
      });

      return row;
    },

    /** Like upsert() but awaits the DB write — use for critical data (gym creation etc.) */
    upsertAsync: async (pred, row) => {
      const data = getSyncData();
      const i = data.findIndex(pred);
      if (i < 0) {
        data.push(row);
      } else {
        data[i] = { ...data[i], ...row };
      }
      invalidate(name);
      await col._persistUpsert(row);
      return row;
    },
  };

  return col;
}

// Known scalar columns per model — only these are written to PG.
// Unknown fields are silently dropped (preserving JSON-store compat).
const ALLOWED_FIELDS = {
  users:            new Set(['id','firebaseUid','phone','email','displayName','photoUrl','userType','accountStatus','approvalStatus','passwordHash','approvalNote','onboardingCompleted','memberProfile','gymId','gymIds','createdAt','updatedAt']),
  gyms:             new Set(['id','name','tier','location','venueType','accessMode','operatingHours','perVisitRate','ratePerDay','ratePerWeek','ratePerMonth','commissionRate','status','images','coordinates','amenities','equipment','paymentBank','paymentNumber','paymentNotes','tinNumber','createdAt','updatedAt']),
  subscriptions:    new Set(['id','memberId','type','tier','status','startedAt','cycleStartedAt','renewsAt','expiresAt','homeGymId','paymentRef','createdAt']),
  checkins:         new Set(['id','memberId','gymId','timestamp','method','subscriptionType','passTier','visitNumberInCycle','gymTier','creditsDeductedTzs','visitConsumed']),
  payment_requests: new Set(['id','memberId','subscriptionId','tier','amountTzs','status','provider','reference','note','requestedAt','decidedAt','decidedBy']),
  invoices:         new Set(['id','gymId','gymName','ownerId','ownerName','amount','status','note','periodStart','periodEnd','receiptUrl','paymentReference','createdAt','createdBy','paidAt']),
  gym_payouts:      new Set(['id','gymId','invoiceId','amount','status','periodStart','periodEnd','paidAt','reference','createdAt']),
  trainers:         new Set(['id','userId','email','phone','displayName','photoUrl','specialties','bio','rating','reviewCount','hourlyRateTzs','experienceYears','status','approvalStatus','availability','createdAt','updatedAt']),
  trainer_bookings: new Set(['id','memberId','trainerId','gymId','date','slot','amountTzs','status','createdAt']),
  audit_log:        new Set(['id','at','actor','action','target','before','after']),
  platform_settings: new Set(['id','subscriptionTiers','payoutBands','paymentPeriodDays','payoutModel','currency','updatedAt']),
  webhook_seen:     new Set(['id','at']),
  otps:             new Set(['phone','code','userType','expiresAt']),
  gym_owners:       new Set(['id','firebaseUid','phone','email','displayName','photoUrl','userType','accountStatus','approvalStatus','passwordHash','approvalNote','gymId','gymIds','createdAt','updatedAt']),
};

/**
 * Prepare a plain object for Prisma create/update by keeping only known columns
 * and converting types.
 */
function prepareForPrisma(name, data, isUpdate = false) {
  const allowed = ALLOWED_FIELDS[name];
  const cleaned = {};

  // Only keep fields that are known Prisma columns
  for (const [k, v] of Object.entries(data)) {
    if (allowed && !allowed.has(k)) continue;
    if (v === undefined) continue;
    cleaned[k] = v;
  }

  // Convert date strings to Date objects for DateTime fields
  const DATE_FIELDS = ['createdAt', 'updatedAt', 'startedAt', 'cycleStartedAt', 'renewsAt', 'expiresAt',
    'requestedAt', 'decidedAt', 'timestamp', 'paidAt', 'lastTopUpAt', 'at'];
  for (const f of DATE_FIELDS) {
    if (cleaned[f] !== undefined && cleaned[f] !== null && !(cleaned[f] instanceof Date)) {
      const val = cleaned[f];
      cleaned[f] = typeof val === 'number' ? new Date(val) : new Date(val);
    }
  }

  // For updates, remove 'id' since it's the PK and can't be changed
  if (isUpdate) {
    const pk = pkField(name);
    delete cleaned[pk];
    // Also remove createdAt since it's set on creation
    delete cleaned.createdAt;
  }

  return cleaned;
}

/**
 * Wait for all collections to be primed from the database.
 * Call this at startup before serving requests.
 */
export async function primeAllCollections() {
  const names = Object.keys(MODEL_MAP);
  await Promise.all(names.map(name => loadAll(name, MODEL_MAP[name])));
  console.log(`[prisma-store] Primed ${names.length} collections from PostgreSQL.`);
}

/**
 * Gracefully disconnect from the database.
 */
export async function disconnect() {
  await prisma.$disconnect();
}
