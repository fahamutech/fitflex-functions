// Knex-backed store that exposes the same collection() API as json-store.mjs.
// Reads go through PG via Knex; writes sync to PG immediately.
// This is the production data layer — replaces json-store.mjs (and the former
// prisma-store.mjs).

import dotenv from 'dotenv';
dotenv.config();

import knexFactory from 'knex';
import pg from 'pg';

// pg returns NUMERIC/DECIMAL as strings to avoid precision loss. Ours are all
// small measurements (ratings, weightKg, distanceKm — never money), so parse
// them as numbers; otherwise Gym.rating reads back as '4.50'.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));

const connectionString = process.env.FITFLEX_USE_CI_DB === '1'
  ? process.env.DATABASE_URL_CI
  : process.env.DATABASE_URL;
if (!connectionString) throw new Error('FATAL: DATABASE_URL must be set. Create a .env file or export it.');

const db = knexFactory({
  client: 'pg',
  connection: connectionString,
  pool: { min: 0, max: 10 },
});
export { db };

// Map collection names → PG table names + special handling
const TABLE_MAP = {
  users:             { table: 'User' },
  gyms:              { table: 'Gym' },
  subscriptions:     { table: 'Subscription' },
  checkins:          { table: 'Checkin' },
  otps:              { table: 'Otp' },
  audit_log:         { table: 'AuditLog' },
  payment_requests:  { table: 'PaymentRequest' },
  trainers:          { table: 'TrainerProfile', transform: trainerFromDb, hasGymJoin: true },
  trainer_bookings:  { table: 'TrainerBooking' },
  invoices:          { table: 'Invoice' },
  platform_settings: { table: 'PlatformSettings' },
  gym_payouts:       { table: 'GymPayout' },
  webhook_seen:      { table: 'WebhookSeen' },
  gym_owners:        { table: 'User', defaultFilter: { userType: 'gym_operator' } },
  trainer_engagements: { table: 'TrainerEngagement' },
  trainer_sessions:  { table: 'TrainerSession' },
  products:          { table: 'Product' },
  shop_orders:       { table: 'ShopOrder' },
  marketplace_enquiries: { table: 'MarketplaceEnquiry' },
  marketplace_notifications: { table: 'MarketplaceNotification' },
  product_reviews:   { table: 'ProductReview' },
  gym_reviews:       { table: 'GymReview' },
  trainer_reviews:   { table: 'TrainerReview' },
  device_tokens:     { table: 'DeviceToken' },
  notifications:     { table: 'Notification' },
  activities:        { table: 'Activity' },
  activity_routes:   { table: 'ActivityRoute' },
  follows:           { table: 'Follow' },
  blocks:            { table: 'Block' },
  social_profiles:   { table: 'SocialProfile' },
  social_groups:     { table: 'SocialGroup' },
  social_group_members: { table: 'SocialGroupMember' },
  activity_kudos:    { table: 'ActivityKudos' },
  activity_comments: { table: 'ActivityComment' },
  activity_views:    { table: 'ActivityView' },
  social_reports:    { table: 'SocialReport' },
  goals:             { table: 'Goal' },
  workouts:          { table: 'Workout' },
  trainer_member_relationships: { table: 'TrainerMemberRelationship' },
  workout_plans:     { table: 'WorkoutPlan' },
  gym_member_sharing: { table: 'GymMemberSharing' },
  challenges:        { table: 'Challenge' },
  challenge_participants: { table: 'ChallengeParticipant' },
  challenge_teams:   { table: 'ChallengeTeam' },
  challenge_rewards: { table: 'ChallengeReward' },
  corporate_accounts:  { table: 'CorporateAccount' },
  corporate_employees: { table: 'CorporateEmployee' },
  corporate_bills:     { table: 'CorporateBill' },
  b2b_organizations:      { table: 'B2BOrganization' },
  b2b_organization_users: { table: 'B2BOrganizationUser' },
  b2b_beneficiaries:      { table: 'B2BBeneficiary' },
  b2b_programs:           { table: 'B2BWellnessProgram' },
  b2b_benefits:           { table: 'B2BBenefit' },
  communication_campaigns:   { table: 'CommunicationCampaign' },
  communication_messages:    { table: 'CommunicationMessage' },
  communication_templates:   { table: 'CommunicationTemplate' },
  whatsapp_templates:        { table: 'WhatsAppTemplate' },
  communication_preferences: { table: 'CommunicationPreference' },
  communication_automations: { table: 'CommunicationAutomation' },
  automation_runs:           { table: 'AutomationRun' },
  job_runs:                  { table: 'JobRun' },
  partner_kyc_cases:           { table: 'PartnerKycCase' },
  partner_people:              { table: 'PartnerPerson' },
  partner_settlement_accounts: { table: 'PartnerSettlementAccount' },
  partner_documents:           { table: 'PartnerDocument' },
  partner_checks:              { table: 'PartnerCheck' },
  partner_agreements:          { table: 'PartnerAgreement' },
  partner_kyc_events:          { table: 'PartnerKycEvent' },
  // Settlement configuration (settlement Phase 2). Database-authoritative:
  // never primed into the in-memory cache.
  pass_tier_versions:          { table: 'PassTierVersion' },
  settlement_rules:            { table: 'SettlementRule' },
  gym_rate_cards:              { table: 'GymRateCard' },
  // Settlement results (settlement Phase 2, PR 3). Financial records:
  // database-authoritative, never cached; written in transactions.
  settlement_runs:             { table: 'SettlementRun' },
  member_cycle_settlements:    { table: 'MemberCycleSettlement' },
  gym_settlements:             { table: 'GymSettlement' },
  gym_settlement_lines:        { table: 'GymSettlementLine' },
  settlement_visits:           { table: 'SettlementVisit' },
  settlement_adjustments:      { table: 'SettlementAdjustment' },
};

const TRAINER_GYM_TABLE = 'TrainerProfileGym';

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
  // node-postgres serializes JS arrays as Postgres ARRAY literals, not JSON —
  // `availability` is a jsonb column holding array-shaped data, so it must be
  // stringified explicitly before it reaches the driver.
  if (rest.availability !== undefined && rest.availability !== null && typeof rest.availability !== 'string') {
    rest.availability = JSON.stringify(rest.availability);
  }
  // Keep parity with the generic Knex writer: the deployed TrainerProfile
  // schema may lag optional API fields (for example sessionRateCurrency).
  // Sending those fields makes every trainer upsert fail.
  const allowed = ALLOWED_FIELDS.trainers;
  const fields = Object.fromEntries(
    Object.entries(rest).filter(([key, value]) => allowed.has(key) && value !== undefined),
  );
  return { fields, gymIds: gymIds ?? null };
}

// OTP uses phone as PK — need special handling for upsert
const PHONE_PK_COLLECTIONS = new Set(['otps']);

// Models where the `updatedAt` column has no DB-level default and must be
// (re)computed on every write — mirrors Prisma's `@updatedAt` behaviour,
// which only auto-generates the value when the caller does not supply one.
const AUTO_UPDATED_AT = new Set([
  'users', 'gyms', 'trainers', 'platform_settings',
  'communication_campaigns', 'communication_messages', 'communication_templates',
  'whatsapp_templates', 'communication_preferences', 'communication_automations',
  'partner_kyc_cases', 'partner_people', 'partner_settlement_accounts', 'partner_documents',
  'partner_checks', 'partner_agreements',
  'pass_tier_versions', 'settlement_rules', 'gym_rate_cards',
  'settlement_runs', 'gym_settlements', 'settlement_adjustments',
]);

// Collections retained for legacy synchronous service call sites. New service
// reads must use the *Async methods below, which always query PostgreSQL.
const PRIMED_COLLECTIONS = new Set([
  'platform_settings', // single row
  'otps',              // small, ephemeral
  'gyms',              // small catalogue, frequently accessed
  'trainers',          // small set, frequently accessed
]);

async function fetchTrainerGymLinks(trainerIds) {
  if (!trainerIds.length) return new Map();
  const links = await db(TRAINER_GYM_TABLE).select('trainerId', 'gymId').whereIn('trainerId', trainerIds);
  const byTrainer = new Map();
  for (const link of links) {
    if (!byTrainer.has(link.trainerId)) byTrainer.set(link.trainerId, []);
    byTrainer.get(link.trainerId).push({ trainerId: link.trainerId, gymId: link.gymId });
  }
  return byTrainer;
}

async function loadAll(name, meta) {
  let query = db(meta.table).select('*');
  if (meta.defaultFilter) query = query.where(meta.defaultFilter);
  let rows = await query;

  if (meta.hasGymJoin) {
    const byTrainer = await fetchTrainerGymLinks(rows.map(r => r.id));
    rows = rows.map(r => ({ ...r, gyms: byTrainer.get(r.id) || [] }));
  }

  if (meta.transform) rows = rows.map(meta.transform);
  // Convert dates and BigInts to plain values for compatibility
  rows = rows.map(r => JSON.parse(JSON.stringify(r, (_, v) => typeof v === 'bigint' ? Number(v) : v)));
  return rows;
}

// Async reads are never cached. Kept as a no-op while legacy synchronous
// collection methods are migrated away from their startup snapshots.
function invalidate(_) {}

function pkField(name) {
  if (PHONE_PK_COLLECTIONS.has(name)) return 'phone';
  return 'id';
}

/**
 * Returns a collection handle with the same sync-looking API as json-store,
 * but backed by async Knex calls under the hood.
 *
 * IMPORTANT: all methods now return Promises. Callers that were synchronous
 * need to be updated to await. For the migration period, we provide both
 * sync (cached) and async versions.
 */
export function collection(name) {
  const meta = TABLE_MAP[name];
  if (!meta) {
    throw new Error(`knex-store: unknown collection "${name}". Add it to TABLE_MAP.`);
  }

  const isPrimed = PRIMED_COLLECTIONS.has(name);

  // ─── Shared DB-persist helpers (used by both primed and db-only modes) ───

  async function _persistInsert(row) {
    if (name === 'trainers') {
      const { fields, gymIds } = trainerToDb(row);
      await db.transaction(async (trx) => {
        await trx(meta.table).insert({ id: row.id, ...fields, updatedAt: new Date() });
        if (gymIds && gymIds.length) {
          await trx(TRAINER_GYM_TABLE).insert(gymIds.map(gId => ({ trainerId: row.id, gymId: gId })));
        }
      });
    } else if (name === 'otps') {
      await db(meta.table)
        .insert({ phone: row.phone, code: row.code, userType: row.userType, expiresAt: new Date(row.expiresAt) })
        .onConflict('phone')
        .merge({ code: row.code, userType: row.userType, expiresAt: new Date(row.expiresAt) });
    } else {
      const writeData = prepareForKnex(name, row);
      await db(meta.table).insert(writeData);
    }
  }

  async function _persistUpdate(pk, id, patch) {
    if (name === 'trainers') {
      const { fields, gymIds } = trainerToDb(patch);
      const updateData = { ...fields, updatedAt: new Date() };
      Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
      await db.transaction(async (trx) => {
        await trx(meta.table).where({ id }).update(updateData);
        if (gymIds) {
          await trx(TRAINER_GYM_TABLE).where({ trainerId: id }).del();
          if (gymIds.length) {
            await trx(TRAINER_GYM_TABLE).insert(gymIds.map(gId => ({ trainerId: id, gymId: gId })));
          }
        }
      });
    } else {
      const writeData = prepareForKnex(name, patch, true);
      if (Object.keys(writeData).length) {
        await db(meta.table).where({ [pk]: id }).update(writeData);
      }
    }
  }

  async function _persistUpsert(row) {
    if (name === 'otps') {
      await db(meta.table)
        .insert({ phone: row.phone, code: row.code, userType: row.userType, expiresAt: new Date(row.expiresAt) })
        .onConflict('phone')
        .merge({ code: row.code, userType: row.userType, expiresAt: new Date(row.expiresAt) });
    } else if (name === 'platform_settings') {
      const writeData = prepareForKnex(name, row);
      await db(meta.table).insert(writeData).onConflict('id').merge(writeData);
    } else if (name === 'trainers') {
      // Trainer profiles use a jsonb availability column and a gym join
      // table, so they cannot use the generic upsert serializer.
      const { fields, gymIds } = trainerToDb(row);
      const updateData = { ...fields, updatedAt: new Date() };
      await db.transaction(async (trx) => {
        await trx(meta.table)
          .insert({ id: row.id, ...fields, updatedAt: new Date() })
          .onConflict('id')
          .merge(updateData);
        if (gymIds) {
          await trx(TRAINER_GYM_TABLE).where({ trainerId: row.id }).del();
          if (gymIds.length) {
            await trx(TRAINER_GYM_TABLE).insert(
              gymIds.map((gymId) => ({ trainerId: row.id, gymId })),
            );
          }
        }
      });
    } else {
      const pk = pkField(name);
      const id = row[pk];
      if (!id) return;
      const writeData = prepareForKnex(name, row);
      const { [pk]: _omit, createdAt: _ca, ...updateData } = writeData;
      await db(meta.table).insert(writeData).onConflict(pk).merge(updateData);
    }
  }

  async function _findByIdFromDb(id) {
    let row = await db(meta.table).where({ id }).first();
    if (row && meta.hasGymJoin) {
      const links = await db(TRAINER_GYM_TABLE).select('trainerId', 'gymId').where({ trainerId: id });
      row = { ...row, gyms: links };
    }
    if (row && meta.transform) row = meta.transform(row);
    if (row) row = JSON.parse(JSON.stringify(row, (_, v) => typeof v === 'bigint' ? Number(v) : v));
    return row ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRIMED MODE — small/static collections loaded into memory at startup
  // ═══════════════════════════════════════════════════════════════════════════
  if (isPrimed) {
    let _syncData = [];
    let _primed = false;

    const primePromise = loadAll(name, meta).then(rows => {
      const pkF = pkField(name);
      const inMemoryPks = new Set(_syncData.map(r => r[pkF]));
      for (const row of rows) {
        if (!inMemoryPks.has(row[pkF])) {
          _syncData.push(row);
        }
      }
      _primed = true;
    }).catch(err => {
      console.error(`[knex-store] Failed to prime "${name}":`, err.message);
      _primed = true;
    });

    function getSyncData() { return _syncData; }

    const col = {
      ready: primePromise,

      all:    () => getSyncData().slice(),
      find:   (pred) => getSyncData().find(pred) ?? null,
      filter: (pred) => getSyncData().filter(pred),

      allAsync:  async () => { const rows = await loadAll(name, meta); return rows.slice(); },
      findAsync: async (pred) => { const rows = await loadAll(name, meta); return rows.find(pred) ?? null; },
      filterAsync: async (pred) => { const rows = await loadAll(name, meta); return rows.filter(pred); },
      findByIdAsync: _findByIdFromDb,

      insert: (row) => {
        getSyncData().push(row);
        invalidate(name);
        _persistInsert(row).catch(err => console.error(`[knex-store] insert ${name} (id=${row.id || row.phone || '?'}):`, err.message));
        return row;
      },

      insertAsync: async (row) => {
        getSyncData().push(row);
        invalidate(name);
        await _persistInsert(row);
        return row;
      },

      update: (pred, patch) => {
        const data = getSyncData();
        const i = data.findIndex(pred);
        if (i < 0) return null;
        data[i] = { ...data[i], ...patch };
        const updated = data[i];
        invalidate(name);
        const pk = pkField(name);
        const id = updated[pk];
        if (id) _persistUpdate(pk, id, patch).catch(err => console.error(`[knex-store] update ${name} (id=${id}):`, err.message));
        return updated;
      },

      updateAsync: async (pred, patch) => {
        const data = getSyncData();
        const i = data.findIndex(pred);
        if (i < 0) return null;
        data[i] = { ...data[i], ...patch };
        const updated = data[i];
        invalidate(name);
        const pk = pkField(name);
        const id = updated[pk];
        if (id) await _persistUpdate(pk, id, patch);
        return updated;
      },

      // Write-through by id for rows the in-memory cache may not hold yet
      // (e.g. created by another instance after priming). Updates the DB row
      // directly, then caches the fresh row. Returns null if no row has that id.
      persistUpdateByIdAsync: async (id, patch) => {
        const pk = pkField(name);
        await _persistUpdate(pk, id, patch);
        const fresh = await _findByIdFromDb(id);
        if (!fresh) return null;
        const data = getSyncData();
        const i = data.findIndex(r => r[pk] === id);
        if (i < 0) data.push(fresh); else data[i] = fresh;
        invalidate(name);
        return fresh;
      },

      remove: (pred) => {
        const data = getSyncData();
        const i = data.findIndex(pred);
        if (i < 0) return null;
        const [row] = data.splice(i, 1);
        invalidate(name);
        const pk = pkField(name);
        const id = row[pk];
        if (id) db(meta.table).where({ [pk]: id }).del().catch(err => console.error(`[knex-store] remove ${name}:`, err.message));
        return row;
      },

      removeAsync: async (pred) => {
        const data = getSyncData();
        const i = data.findIndex(pred);
        if (i < 0) return null;
        const [row] = data.splice(i, 1);
        invalidate(name);
        const pk = pkField(name);
        const id = row[pk];
        if (id) await db(meta.table).where({ [pk]: id }).del();
        return row;
      },

      upsert: (pred, row) => {
        const data = getSyncData();
        const i = data.findIndex(pred);
        if (i < 0) data.push(row); else data[i] = { ...data[i], ...row };
        invalidate(name);
        _persistUpsert(row).catch(err => console.error(`[knex-store] upsert ${name} (id=${row[pkField(name)]}):`, err.message));
        return row;
      },

      upsertAsync: async (pred, row) => {
        const data = getSyncData();
        const i = data.findIndex(pred);
        if (i < 0) data.push(row); else data[i] = { ...data[i], ...row };
        invalidate(name);
        await _persistUpsert(row);
        return row;
      },
    };
    return col;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DB-ONLY MODE — large/dynamic collections queried from PG on demand
  //  No in-memory array; all reads go to the database.
  // ═══════════════════════════════════════════════════════════════════════════
  const col = {
    /** No priming needed — resolves immediately */
    ready: Promise.resolve(),

    // Sync-shaped methods now async — callers MUST await them.
    all:    async () => { const rows = await loadAll(name, meta); return rows.slice(); },
    find:   async (pred) => { const rows = await loadAll(name, meta); return rows.find(pred) ?? null; },
    filter: async (pred) => { const rows = await loadAll(name, meta); return rows.filter(pred); },

    allAsync:    async () => { const rows = await loadAll(name, meta); return rows.slice(); },
    findAsync:   async (pred) => { const rows = await loadAll(name, meta); return rows.find(pred) ?? null; },
    filterAsync: async (pred) => { const rows = await loadAll(name, meta); return rows.filter(pred); },
    findByIdAsync: _findByIdFromDb,

    /** Find by a single column = value directly from DB (efficient indexed lookup) */
    findByColumnAsync: async (column, value) => {
      const where = { [column]: value };
      if (meta.defaultFilter) Object.assign(where, meta.defaultFilter);
      let row = await db(meta.table).where(where).first();
      if (row && meta.hasGymJoin) {
        const links = await db(TRAINER_GYM_TABLE).select('trainerId', 'gymId').where({ trainerId: row.id });
        row = { ...row, gyms: links };
      }
      if (row && meta.transform) row = meta.transform(row);
      if (row) row = JSON.parse(JSON.stringify(row, (_, v) => typeof v === 'bigint' ? Number(v) : v));
      return row ?? null;
    },

    /** Filter by a single column = value directly from DB */
    filterByColumnAsync: async (column, value) => {
      const where = { [column]: value };
      if (meta.defaultFilter) Object.assign(where, meta.defaultFilter);
      let rows = await db(meta.table).where(where).select('*');
      if (meta.hasGymJoin && rows.length) {
        const byTrainer = await fetchTrainerGymLinks(rows.map(r => r.id));
        rows = rows.map(r => ({ ...r, gyms: byTrainer.get(r.id) || [] }));
      }
      if (meta.transform) rows = rows.map(meta.transform);
      rows = rows.map(r => JSON.parse(JSON.stringify(r, (_, v) => typeof v === 'bigint' ? Number(v) : v)));
      return rows;
    },

    /** Filter by column IN (values) directly from DB */
    filterByColumnInAsync: async (column, values) => {
      if (!values.length) return [];
      let query = db(meta.table).whereIn(column, values).select('*');
      if (meta.defaultFilter) query = query.andWhere(meta.defaultFilter);
      let rows = await query;
      if (meta.hasGymJoin && rows.length) {
        const byTrainer = await fetchTrainerGymLinks(rows.map(r => r.id));
        rows = rows.map(r => ({ ...r, gyms: byTrainer.get(r.id) || [] }));
      }
      if (meta.transform) rows = rows.map(meta.transform);
      rows = rows.map(r => JSON.parse(JSON.stringify(r, (_, v) => typeof v === 'bigint' ? Number(v) : v)));
      return rows;
    },

    insert: (row) => {
      _persistInsert(row).then(() => invalidate(name)).catch(err => console.error(`[knex-store] insert ${name} (id=${row.id || row.phone || '?'}):`, err.message));
      return row;
    },

    /** Awaitable insert — use for critical paths */
    insertAsync: async (row) => {
      await _persistInsert(row);
      invalidate(name);
      return row;
    },

    update: (pred, patch) => {
      // For DB-only collections we can't do predicate-based sync update.
      // Return the patch and persist asynchronously — callers should prefer updateByIdAsync.
      console.warn(`[knex-store] sync update() on db-only collection "${name}" — prefer updateByIdAsync()`);
      return null;
    },

    /** Update a record by its PK value — awaitable */
    updateByIdAsync: async (id, patch) => {
      const pk = pkField(name);
      await _persistUpdate(pk, id, patch);
      invalidate(name);
      // Return the updated row from DB
      return _findByIdFromDb(id);
    },

    remove: (pred) => {
      console.warn(`[knex-store] sync remove() on db-only collection "${name}" — prefer removeByIdAsync()`);
      return null;
    },

    removeAsync: async (pred) => {
      // For DB-only: find the row first, then delete
      const rows = await loadAll(name, meta);
      const row = rows.find(pred);
      if (!row) return null;
      const pk = pkField(name);
      const id = row[pk];
      if (id) await db(meta.table).where({ [pk]: id }).del();
      invalidate(name);
      return row;
    },

    /** Remove by PK — awaitable */
    removeByIdAsync: async (id) => {
      const pk = pkField(name);
      const row = await _findByIdFromDb(id);
      if (!row) return null;
      await db(meta.table).where({ [pk]: id }).del();
      invalidate(name);
      return row;
    },

    upsert: (pred, row) => {
      _persistUpsert(row).catch(err => console.error(`[knex-store] upsert ${name} (id=${row[pkField(name)]}):`, err.message));
      return row;
    },

    upsertAsync: async (pred, row) => {
      await _persistUpsert(row);
      invalidate(name);
      return row;
    },
  };

  return col;
}

// Known scalar columns per model — only these are written to PG.
// Unknown fields are silently dropped (preserving JSON-store compat).
const ALLOWED_FIELDS = {
  users:            new Set(['id','firebaseUid','phone','email','displayName','photoUrl','userType','accountStatus','approvalStatus','passwordHash','approvalNote','onboardingCompleted','portalUser','aclPermissions','memberProfile','gymId','gymIds','vendorProfile','vendorId','vendorRole','vendorPermissions','corporateId','createdAt','updatedAt']),
  gyms:            new Set(['id','name','tier','location','venueType','accessMode','operatingHours','perVisitRate','ratePerDay','ratePerWeek','ratePerMonth','commissionRate','status','homepageVisible','homepagePriority','images','thumbnails','coordinates','amenities','equipment','verified','classes','trainerPass','paymentBank','paymentNumber','paymentNotes','tinNumber','rating','reviewCount','createdAt','updatedAt']),
  subscriptions:    new Set(['id','memberId','type','tier','plan','status','startedAt','cycleStartedAt','renewsAt','expiresAt','homeGymId','paymentRef','createdAt']),
  checkins:         new Set(['id','memberId','gymId','timestamp','method','subscriptionType','passTier','visitNumberInCycle','gymTier','creditsDeductedTzs','visitConsumed',
                              'status','statusReason','statusChangedBy','statusChangedAt','voidedAt','voidedBy','voidReason','subscriptionId','businessDate','source']),
  payment_requests: new Set(['id','memberId','subscriptionId','bookingGroupId','orderId','currency','tier','plan','gymId','amountTzs','status','provider','reference','note','requestedAt','decidedAt','decidedBy']),
  invoices:         new Set(['id','gymId','gymName','ownerId','ownerName','amount','status','note','periodStart','periodEnd','receiptUrl','paymentReference','createdAt','createdBy','paidAt']),
  gym_payouts:      new Set(['id','gymId','invoiceId','amount','status','periodStart','periodEnd','paidAt','reference','createdAt','gymSettlementId','gymSettlementMode']),
  trainers:         new Set(['id','userId','email','phone','displayName','photoUrl','images','imageThumbnails','gender','specialties','bio','rating','reviewCount','hourlyRateTzs','sessionRateCurrency','experienceYears','status','approvalStatus','verified','homepageVisible','homepagePriority','pendingGymIds','availability','socialLinks','createdAt','updatedAt']),
  trainer_bookings: new Set(['id','groupId','memberId','trainerId','gymId','date','slot','currency','listPriceTzs','discountPct','amountTzs','commissionPct','commissionTzs','trainerPayoutTzs','paymentRequestId','status','createdAt','updatedAt']),
  audit_log:        new Set(['id','at','actor','action','target','before','after']),
  platform_settings: new Set(['id','subscriptionTiers','payoutBands','paymentPeriodDays','payoutModel','currency','updatedAt']),
  webhook_seen:     new Set(['id','at']),
  otps:             new Set(['phone','code','userType','expiresAt']),
  gym_owners:       new Set(['id','firebaseUid','phone','email','displayName','photoUrl','userType','accountStatus','approvalStatus','passwordHash','approvalNote','gymId','gymIds','createdAt','updatedAt']),
  trainer_engagements: new Set(['id','memberId','trainerId','type','message','gymId','status','messages','lastMessageAt','lastMessageFrom','trainerReadAt','memberReadAt','createdAt','updatedAt']),
  trainer_sessions: new Set(['id','trainerId','memberId','customerName','customerEmail','customerPhone','gymId','locationType','locationLabel','date','slot','source','status','amountTzs','createdAt']),
  products:         new Set(['id','vendorId','name','description','category','brand','priceTzs','discountPriceTzs','stock','sku','weightKg','distanceKm','variants','images','visibility','deliveryAvailable','status','approvalStatus','rating','reviewCount','soldCount','homepageVisible','homepagePriority','deletedAt','createdAt','updatedAt']),
  shop_orders:      new Set(['id','buyerId','buyerRole','items','totalTzs','status','deliveryMethod','pickupGymId','deliveryAddress','paymentMethod','paymentStatus','paymentReference','timeline','settlementStatus','note','createdAt','updatedAt']),
  marketplace_enquiries: new Set(['id','buyerId','vendorId','productId','subject','status','messages','createdAt','updatedAt']),
  marketplace_notifications: new Set(['id','userId','type','data','read','createdAt']),
  product_reviews:  new Set(['id','buyerId','orderId','productId','rating','comment','createdAt']),
  gym_reviews:      new Set(['id','gymId','memberId','rating','text','status','moderatedBy','moderatedAt','createdAt','updatedAt']),
  trainer_reviews:  new Set(['id','trainerId','memberId','rating','text','status','moderatedBy','moderatedAt','createdAt','updatedAt']),
  device_tokens:    new Set(['id','userId','token','platform','createdAt','lastSeenAt']),
  notifications:    new Set(['id','userId','type','title','body','data','readAt','createdAt','category','gymId','campaignId','clickedAt']),
  activities:       new Set(['id','userId','type','source','startedAt','durationMinutes','distanceKm','steps','activeMinutes','calories','intensity','workoutId','gymId','trainerId','notes','devicePlatform','externalId','deviceName','movingSeconds','elevationGainM','splits','hasRoute','shareWith','createdAt']),
  activity_routes:  new Set(['id','userId','segments','createdAt']),
  follows:          new Set(['id','followerId','followeeId','createdAt']),
  blocks:           new Set(['id','blockerId','blockedId','createdAt']),
  social_profiles:  new Set(['id','defaultShare','inviteCode','publicProfile','createdAt','updatedAt']),
  activity_views:   new Set(['id','activityId','userId','createdAt']),
  social_groups:    new Set(['id','name','description','ownerType','ownerId','corporateId','joinPolicy','discoverable','inviteCode','status','createdBy','createdAt','updatedAt']),
  social_group_members: new Set(['id','groupId','userId','role','status','createdAt','updatedAt']),
  activity_kudos:   new Set(['id','activityId','userId','createdAt']),
  activity_comments: new Set(['id','activityId','userId','text','createdAt','deletedAt']),
  social_reports:   new Set(['id','reporterId','targetType','targetId','reason','status','resolvedBy','resolvedAt','createdAt']),
  goals:            new Set(['id','userId','type','period','target','startDate','endDate','source','trainerId','challengeId','status','createdByType','createdById','title','completions','createdAt','updatedAt']),
  workouts:         new Set(['id','userId','trainerId','gymId','templateId','source','name','description','activityType','scheduledDate','estimatedDuration','status','exercises','notes','startedAt','completedAt','activityId','createdAt','updatedAt']),
  trainer_member_relationships: new Set(['id','trainerId','memberId','status','permissions','requestedAt','connectedAt','endedAt','endedBy','createdAt','updatedAt']),
  workout_plans:    new Set(['id','trainerId','name','description','activityType','estimatedDuration','exercises','createdAt','updatedAt']),
  gym_member_sharing: new Set(['id','gymId','memberId','permissions','createdAt','updatedAt']),
  challenges:       new Set(['id','name','description','type','target','startDate','endDate','creatorType','creatorId','createdBy','rewards','visibility','status','mode','eligibility','rewardFunding','rewardItems','rewardsSettledAt','createdAt','updatedAt']),
  challenge_participants: new Set(['id','challengeId','memberId','status','joinedAt','leftAt','teamId','leaderboardOptIn']),
  challenge_teams:  new Set(['id','challengeId','name','gymId','department','createdAt']),
  challenge_rewards: new Set(['id','challengeId','rewardId','memberId','creatorType','creatorId','funder','type','label','value','rule','rank','teamId','status','earnedAt','reference','note','decidedBy','decidedAt','issuedBy','issuedAt','history','createdAt','updatedAt']),
  corporate_accounts:  new Set(['id','companyName','industrySector','workforceBracket','hrContactName','hrContactPhone','hrContactEmail','objectives','domainWhitelist','subsidyModel','passTier','billingCycle','seatLimit','seatsUsed','baselineSickDays','lipaNamba','billingContactName','billingContactPhone','billingContactEmail','status','createdAt','updatedAt']),
  corporate_employees: new Set(['id','corporateId','userId','displayName','phone','email','department','pinHash','status','activatedAt','createdAt','updatedAt']),
  corporate_bills:     new Set(['id','corporateId','period','passTier','subsidyModel','billingCycle','seatCount','perSeatMonthlyTzs','grossTzs','employerTzs','employeeTzs','status','paymentReference','paidAt','createdAt']),
  b2b_organizations:      new Set(['id','organizationType','legalName','tradingName','industrySector','registrationNumber','taxIdentificationNumber','email','phone','address','status','statusReason','statusChangedAt','legacyCorporateId','createdBy','createdAt','updatedAt']),
  b2b_organization_users: new Set(['id','organizationId','userId','role','permissions','status','removedAt','createdBy','createdAt','updatedAt']),
  b2b_beneficiaries:      new Set(['id','organizationId','userId','externalReference','beneficiaryType','groupName','status','enrolledAt','statusChangedAt','createdBy','createdAt','updatedAt']),
  b2b_programs:           new Set(['id','organizationId','name','description','programType','status','statusReason','statusChangedAt','startDate','endDate','eligibility','budgetTzs','discountBps','activatedAt','activatedBy','createdBy','createdAt','updatedAt']),
  b2b_benefits:           new Set(['id','programId','name','description','benefitType','status','fundingType','sponsorAmountTzs','sponsorShareBps','sponsorCapTzs','beneficiaryAmountTzs','usageLimit','usagePeriod','periodSponsorCapTzs','eligibility','providerRules','startDate','endDate','terms','passTier','createdBy','createdAt','updatedAt']),
  communication_campaigns:   new Set(['id','senderType','gymId','name','purpose','category','status','audience','content','channels','templateId','scheduledAt','sendRequestId','counts','createdBy','sentAt','cancelledAt','createdAt','updatedAt']),
  communication_messages:    new Set(['id','campaignId','automationRunId','senderType','gymId','memberId','channel','category','messageType','title','body','locale','deepLink','notificationId','status','skipReason','providerMessageId','payload','attempts','nextAttemptAt','sentAt','deliveredAt','openedAt','clickedAt','failedAt','failureReason','failurePermanent','createdAt','updatedAt']),
  communication_templates:   new Set(['id','gymId','key','name','category','purpose','channels','bodies','variables','whatsappTemplateId','status','createdBy','createdAt','updatedAt','group','deepLink','basedOn']),
  whatsapp_templates:        new Set(['id','provider','providerTemplateName','language','category','variables','approvalStatus','lastSyncedAt','createdAt','updatedAt']),
  communication_preferences: new Set(['id','inAppMarketing','pushMarketing','whatsappTransactional','whatsappMarketing','whatsappMarketingConsentAt','whatsappMarketingConsentSource','whatsappOptedOutAt','locale','createdAt','updatedAt']),
  communication_automations: new Set(['id','senderType','gymId','name','trigger','offsetDays','conditions','templateId','channels','status','createdBy','createdAt','updatedAt','pausedReason','lastRunAt','updatedBy']),
  automation_runs:           new Set(['id','automationId','gymId','memberId','occurrenceKey','status','createdAt','subscriptionId','context']),
  job_runs:                  new Set(['id','job','status','startedAt','finishedAt','stats','error']),
  partner_kyc_cases:           new Set(['id','partnerType','userId','corporateId','status','tier','round','legalName','tradingName','entityType','registrationNumber','registrationAuthority','incorporatedOn','registeredAddress','businessActivity','tin','submittedAt','reviewerId','decidedAt','decidedBy','reasonCode','reasonNote','reverifyAt','createdAt','updatedAt']),
  partner_people:              new Set(['id','caseId','role','userId','fullName','dateOfBirth','nationality','idType','idNumber','idExpiresOn','phone','email','position','relationship','authority','address','ownershipPct','isPoliticallyExposed','status','createdAt','updatedAt']),
  partner_settlement_accounts: new Set(['id','caseId','method','provider','accountName','accountNumber','branch','swiftCode','currency','status','isPrimary','requestedBy','verifiedBy','verifiedAt','cooldownUntil','disabledAt','legacySource','createdAt','updatedAt']),
  partner_documents:           new Set(['id','caseId','round','requirementKey','docType','issuer','details','personId','settlementAccountId','gymId','storageProvider','storageKey','fileName','mimeType','sizeBytes','sha256','documentNumber','issuedOn','expiresOn','status','supersedesId','reviewNote','reviewedBy','reviewedAt','uploadedBy','createdAt','updatedAt']),
  partner_checks:              new Set(['id','caseId','round','checkType','targetType','targetId','method','provider','result','evidence','note','performedBy','performedAt','expiresAt','createdAt','updatedAt']),
  partner_agreements:          new Set(['id','caseId','agreementType','version','status','acceptedBy','acceptedAt','acceptedIp','acceptedUserAgent','signedDocumentId','effectiveFrom','expiresAt','revokedAt','createdAt','updatedAt']),
  pass_tier_versions:          new Set(['id','tierKey','version','priceTzs','visitAllowance','status','effectiveFrom','effectiveTo','reason','createdBy','approvedBy','approvedAt','createdAt','updatedAt']),
  settlement_rules:            new Set(['id','name','version','scopeType','scopeId','networkPayoutBps','dailyDiscountBps','weeklyDiscountBps','monthlyDiscountBps','dailyCeilingTzs','weeklyCeilingTzs','monthlyCeilingTzs','contractRef','status','effectiveFrom','effectiveTo','reason','createdBy','approvedBy','approvedAt','createdAt','updatedAt']),
  gym_rate_cards:              new Set(['id','gymId','version','gymTier','retailDailyTzs','retailWeeklyTzs','retailMonthlyTzs','dailyDiscountBps','weeklyDiscountBps','monthlyDiscountBps','dailyCeilingTzs','weeklyCeilingTzs','monthlyCeilingTzs','ruleSources','status','effectiveFrom','effectiveTo','reason','createdBy','approvedBy','approvedAt','createdAt','updatedAt']),
  settlement_runs:             new Set(['id','mode','periodStartDate','periodEndDate','status','engineVersion','inputsHash','configurationSnapshot','jobRunId','error','createdBy','lockedBy','lockedAt','createdAt','updatedAt']),
  member_cycle_settlements:    new Set(['id','runId','mode','memberId','subscriptionId','cycleStart','cycleEnd','passTier','passTierVersion','catalogPriceTzs','visitAllowance','collectedApprovedAmountTzs','networkPayoutBps','networkCapTzs','totalPreliminaryTzs','totalFinalTzs','networkAdjustmentTzs','capApplied','payableVisitCount','heldVisitCount','excludedVisitCount','engineVersion','explanation','active','createdAt','fundingType']),
  gym_settlements:             new Set(['id','runId','mode','gymId','periodStartDate','periodEndDate','memberCycleCount','qualifyingVisitCount','heldVisitCount','preliminaryTzs','networkAdjustmentTzs','adjustmentsTzs','carryForwardTzs','finalNetTzs','status','holdReason','destinationSnapshot','submittedBy','submittedAt','approvedBy','approvedAt','paidBy','paidAt','paymentReference','receiptUrl','voidedBy','voidedAt','voidReason','createdAt','updatedAt','heldBy','heldAt','rejectedBy','rejectedAt','rejectReason','payableAt']),
  gym_settlement_lines:        new Set(['id','runId','mode','gymSettlementId','memberCycleSettlementId','memberId','gymId','qualifyingVisitCount','heldVisitCount','bracket','rawPreliminaryTzs','preliminaryTzs','monotonicGuardApplied','networkAdjustmentTzs','finalTzs','rateCardSnapshot','calculationBasis','createdAt']),
  settlement_visits:           new Set(['id','runId','mode','memberCycleSettlementId','lineId','checkinId','gymId','businessDate','outcome','eligibility','allowanceSlot','active','createdAt']),
  settlement_adjustments:      new Set(['id','gymSettlementId','amountTzs','type','reason','status','sourceSettlementId','sourceCheckinId','createdBy','approvedBy','approvedAt','createdAt','updatedAt','appliedAt','rejectedBy','rejectReason','sourceMemberCycleSettlementId']),
  partner_kyc_events:          new Set(['id','caseId','round','eventType','fromStatus','toStatus','targetType','targetId','actorId','actorRole','reasonCode','note','data','at']),
};

// jsonb columns that may hold array-shaped (or otherwise non-object) JSON —
// node-postgres serializes plain JS arrays as Postgres ARRAY literals rather
// than JSON text, so these must be explicitly JSON.stringify'd before being
// handed to the driver. (Plain object values, e.g. `coordinates`, are
// serialized correctly by node-postgres automatically and don't strictly
// need this, but stringifying them too is harmless and keeps this uniform.)
const JSON_FIELDS = {
  users: ['memberProfile', 'vendorProfile'],
  gyms: ['operatingHours', 'coordinates', 'classes', 'trainerPass'],
  platform_settings: ['subscriptionTiers', 'payoutBands'],
  audit_log: ['before', 'after'],
  shop_orders: ['items', 'timeline'],
  trainer_engagements: ['messages'],
  products: ['variants'],
  marketplace_enquiries: ['messages'],
  marketplace_notifications: ['data'],
  notifications: ['data'],
  workouts: ['exercises'],
  activities: ['splits', 'shareWith'],
  social_profiles: ['defaultShare'],
  activity_routes: ['segments'],
  goals: ['completions'],
  trainer_member_relationships: ['permissions'],
  workout_plans: ['exercises'],
  gym_member_sharing: ['permissions'],
  challenges: ['rewards', 'eligibility', 'rewardItems'],
  challenge_rewards: ['history'],
  communication_campaigns: ['audience', 'content', 'counts'],
  communication_messages: ['payload'],
  communication_templates: ['bodies'],
  communication_automations: ['conditions'],
  automation_runs: ['context'],
  job_runs: ['stats'],
  partner_kyc_cases: ['registeredAddress'],
  partner_people: ['address'],
  partner_documents: ['details'],
  partner_checks: ['evidence'],
  partner_kyc_events: ['data'],
  gym_rate_cards: ['ruleSources'],
  settlement_runs: ['configurationSnapshot'],
  member_cycle_settlements: ['explanation'],
  gym_settlements: ['destinationSnapshot'],
  gym_settlement_lines: ['rateCardSnapshot', 'calculationBasis'],
  b2b_organizations: ['address'],
  b2b_programs: ['eligibility'],
  b2b_benefits: ['eligibility', 'providerRules'],
};

// Collections whose effectiveFrom / effectiveTo are EAT calendar days stored
// as "YYYY-MM-DD" text (settlement configuration), not timestamps: they must
// skip the DATE_FIELDS conversion below, which would turn them into instants.
const CALENDAR_DATE_COLLECTIONS = new Set(['pass_tier_versions', 'settlement_rules', 'gym_rate_cards']);
const CALENDAR_DATE_FIELDS = new Set(['effectiveFrom', 'effectiveTo']);

/**
 * Prepare a plain object for a Knex insert/update by keeping only known
 * columns and converting types.
 */
function prepareForKnex(name, data, isUpdate = false) {
  const allowed = ALLOWED_FIELDS[name];
  const cleaned = {};

  // Only keep fields that are known columns
  for (const [k, v] of Object.entries(data)) {
    if (allowed && !allowed.has(k)) continue;
    if (v === undefined) continue;
    cleaned[k] = v;
  }

  // Convert date strings to Date objects for timestamp columns
  const DATE_FIELDS = ['createdAt', 'updatedAt', 'startedAt', 'cycleStartedAt', 'renewsAt', 'expiresAt',
    'requestedAt', 'decidedAt', 'timestamp', 'paidAt', 'lastTopUpAt', 'at', 'moderatedAt', 'lastSeenAt', 'readAt',
    'completedAt', 'connectedAt', 'endedAt', 'joinedAt', 'leftAt',
    'scheduledAt', 'sentAt', 'cancelledAt', 'nextAttemptAt', 'deliveredAt', 'openedAt', 'clickedAt', 'failedAt',
    'lastSyncedAt', 'whatsappMarketingConsentAt', 'whatsappOptedOutAt', 'finishedAt',
    'submittedAt', 'decidedAt', 'reverifyAt', 'verifiedAt', 'cooldownUntil', 'disabledAt', 'reviewedAt',
    'performedAt', 'acceptedAt', 'effectiveFrom', 'revokedAt',
    'lastMessageAt', 'trainerReadAt', 'memberReadAt', 'statusChangedAt', 'voidedAt',
    'cycleStart', 'cycleEnd', 'lockedAt', 'approvedAt', 'enrolledAt', 'removedAt',
    'heldAt', 'rejectedAt', 'payableAt'];
  for (const f of DATE_FIELDS) {
    if (CALENDAR_DATE_COLLECTIONS.has(name) && CALENDAR_DATE_FIELDS.has(f)) continue;
    if (cleaned[f] !== undefined && cleaned[f] !== null && !(cleaned[f] instanceof Date)) {
      const val = cleaned[f];
      cleaned[f] = typeof val === 'number' ? new Date(val) : new Date(val);
    }
  }

  const jsonFields = JSON_FIELDS[name] || [];
  for (const f of jsonFields) {
    if (cleaned[f] !== undefined && cleaned[f] !== null && typeof cleaned[f] !== 'string') {
      cleaned[f] = JSON.stringify(cleaned[f]);
    }
  }

  // Mirror Prisma's `@updatedAt`: auto-generate only when the caller didn't
  // already supply a value (some callers pass their own for consistency).
  if (AUTO_UPDATED_AT.has(name) && cleaned.updatedAt === undefined) {
    cleaned.updatedAt = new Date();
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
  const names = Object.keys(TABLE_MAP);
  await Promise.all(names.map(name => loadAll(name, TABLE_MAP[name])));
  console.log(`[knex-store] Primed ${names.length} collections from PostgreSQL.`);
}

/**
 * Gracefully disconnect from the database.
 */
export async function disconnect() {
  await db.destroy();
}
