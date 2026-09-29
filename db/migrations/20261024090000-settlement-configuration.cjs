// Commercial configuration for gym settlement (settlement Phase 2, PR 2).
//
// Three effective-dated tables, each read by the Phase 1 resolvers in
// src/shared/settlement-config.mjs, and resolved on a member cycle's start
// date in EAT (DR-10):
//
//   PassTierVersion  pass price and visit allowance per tier (DR-22)
//   SettlementRule   network payout % (GLOBAL, PASS_TIER — DR-07) and gym
//                    reimbursement discounts and ceilings (GLOBAL, GYM_TIER,
//                    GYM — DR-06); SPECIAL_CONTRACT is reserved and can't be
//                    activated
//   GymRateCard      a gym's retail rates plus the discounts and ceilings
//                    copied in from the rules when the card is approved
//                    (DR-23 snapshot)
//
// Dates are EAT calendar days "YYYY-MM-DD"; a row applies on day D when
// effectiveFrom <= D < effectiveTo (NULL = open-ended). Money is integer TZS,
// percentages integer basis points (2500 = 25%).
//
// The database enforces what must never happen: two active rows for the same
// target overlapping in time, an active row edited (only closing an open end
// date is allowed), an active pass version or rule deleted, an approver
// approving their own draft, a network % on a gym rule or a discount on a
// pass rule, and an active special contract.
//
// Seeds: the approved Dar values as DRAFTS with no effective date. Nothing
// resolves until an admin activates them with a date (the pass price date and
// the cutover date are still open decisions).

const DATE_RE = `'^\\d{4}-\\d{2}-\\d{2}$'`;
const SEEDED_BY = 'migration:20261024090000';

async function commonChecks(knex, table, prefix, requiredWhenActive) {
  const add = async (name, sql) => {
    await knex.raw(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS ${prefix}_${name}`);
    await knex.raw(`ALTER TABLE "${table}" ADD CONSTRAINT ${prefix}_${name} CHECK (${sql})`);
  };
  await add('status_ck', `"status" IN ('draft', 'active', 'rejected')`);
  await add('from_ck', `"effectiveFrom" IS NULL OR "effectiveFrom" ~ ${DATE_RE}`);
  await add('to_ck', `"effectiveTo" IS NULL OR "effectiveTo" ~ ${DATE_RE}`);
  await add('range_ck', `"effectiveTo" IS NULL OR "effectiveFrom" IS NULL OR "effectiveTo" > "effectiveFrom"`);
  await add('maker_checker_ck', `"approvedBy" IS NULL OR "createdBy" IS NULL OR "approvedBy" <> "createdBy"`);
  await add('active_ck', `"status" <> 'active' OR ("effectiveFrom" IS NOT NULL AND "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL${requiredWhenActive.map((c) => ` AND "${c}" IS NOT NULL`).join('')})`);
}

async function guards(knex, table, keySql, { blockDelete }) {
  const fn = `${table.toLowerCase()}_guard`;
  // One active row per target at any time. The advisory lock serialises
  // concurrent activations of the same target so two can't slip past the check.
  await knex.raw(`CREATE OR REPLACE FUNCTION ${fn}_overlap() RETURNS trigger AS $$
    BEGIN
      IF NEW."status" = 'active' THEN
        PERFORM pg_advisory_xact_lock(hashtext('${table}:' || ${keySql.replace(/ROW\./g, 'NEW.')}));
        IF EXISTS (
          SELECT 1 FROM "${table}" o
          WHERE o."id" <> NEW."id" AND o."status" = 'active'
            AND ${keySql.replace(/ROW\./g, 'o.')} = ${keySql.replace(/ROW\./g, 'NEW.')}
            AND daterange(o."effectiveFrom"::date, o."effectiveTo"::date, '[)')
             && daterange(NEW."effectiveFrom"::date, NEW."effectiveTo"::date, '[)')
        ) THEN
          RAISE EXCEPTION '${table}: overlapping active versions for %', ${keySql.replace(/ROW\./g, 'NEW.')} USING ERRCODE = '23P01';
        END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS ${fn}_overlap ON "${table}"`);
  await knex.raw(`CREATE TRIGGER ${fn}_overlap BEFORE INSERT OR UPDATE ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${fn}_overlap()`);

  // An active row is history: nothing changes except closing an open end date.
  await knex.raw(`CREATE OR REPLACE FUNCTION ${fn}_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD."status" = 'active' THEN
          RAISE EXCEPTION '${table}: an active version can''t be deleted' USING ERRCODE = 'P0001';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD."status" = 'active' THEN
        IF (to_jsonb(NEW) - 'effectiveTo' - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'effectiveTo' - 'updatedAt')
           OR (OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo") THEN
          RAISE EXCEPTION '${table}: an active version is read-only (only an open end date may be closed)' USING ERRCODE = 'P0001';
        END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS ${fn}_immutable ON "${table}"`);
  await knex.raw(`CREATE TRIGGER ${fn}_immutable BEFORE UPDATE${blockDelete ? ' OR DELETE' : ''} ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${fn}_immutable()`);
}

const bps = (t, name) => t.integer(name);
const tzs = (t, name) => t.integer(name);

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('PassTierVersion'))) {
    await knex.schema.createTable('PassTierVersion', (t) => {
      t.text('id').primary();
      t.text('tierKey').notNullable();
      t.integer('version').notNullable();
      t.integer('priceTzs').notNullable();
      t.integer('visitAllowance').notNullable();
      t.text('status').notNullable().defaultTo('draft');
      t.text('effectiveFrom');
      t.text('effectiveTo');
      t.text('reason');
      t.text('createdBy');
      t.text('approvedBy');
      t.timestamp('approvedAt', { precision: 3 });
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 });
      t.unique(['tierKey', 'version']);
      t.index(['tierKey', 'effectiveFrom']);
    });
  }
  await knex.raw(`ALTER TABLE "PassTierVersion" DROP CONSTRAINT IF EXISTS ptv_amounts_ck`);
  await knex.raw(`ALTER TABLE "PassTierVersion" ADD CONSTRAINT ptv_amounts_ck CHECK ("priceTzs" >= 0 AND "visitAllowance" >= 0 AND "version" >= 1)`);
  await commonChecks(knex, 'PassTierVersion', 'ptv', []);
  await guards(knex, 'PassTierVersion', 'ROW."tierKey"', { blockDelete: true });

  if (!(await knex.schema.hasTable('SettlementRule'))) {
    await knex.schema.createTable('SettlementRule', (t) => {
      t.text('id').primary();
      t.text('name');
      t.integer('version').notNullable();
      t.text('scopeType').notNullable();
      t.text('scopeId');
      bps(t, 'networkPayoutBps');
      bps(t, 'dailyDiscountBps'); bps(t, 'weeklyDiscountBps'); bps(t, 'monthlyDiscountBps');
      tzs(t, 'dailyCeilingTzs'); tzs(t, 'weeklyCeilingTzs'); tzs(t, 'monthlyCeilingTzs');
      t.text('contractRef');
      t.text('status').notNullable().defaultTo('draft');
      t.text('effectiveFrom');
      t.text('effectiveTo');
      t.text('reason');
      t.text('createdBy');
      t.text('approvedBy');
      t.timestamp('approvedAt', { precision: 3 });
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 });
      t.index(['scopeType', 'scopeId']);
    });
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS settlement_rule_version_uq ON "SettlementRule" ("scopeType", COALESCE("scopeId", ''), "version")`);
  const ruleChecks = {
    rule_scope_ck: `"scopeType" IN ('global', 'pass_tier', 'gym_tier', 'gym', 'special_contract')`,
    rule_scope_id_ck: `("scopeType" = 'global') = ("scopeId" IS NULL)`,
    rule_bps_ck: ['networkPayoutBps', 'dailyDiscountBps', 'weeklyDiscountBps', 'monthlyDiscountBps']
      .map((c) => `("${c}" IS NULL OR "${c}" BETWEEN 0 AND 10000)`).join(' AND '),
    rule_tzs_ck: ['dailyCeilingTzs', 'weeklyCeilingTzs', 'monthlyCeilingTzs'].map((c) => `("${c}" IS NULL OR "${c}" >= 0)`).join(' AND '),
    // DR-07: network % only at GLOBAL or PASS_TIER; DR-06/DR-10: reimbursement never at PASS_TIER.
    rule_network_scope_ck: `"networkPayoutBps" IS NULL OR "scopeType" IN ('global', 'pass_tier', 'special_contract')`,
    rule_reimbursement_scope_ck: `"scopeType" <> 'pass_tier' OR ("dailyDiscountBps" IS NULL AND "weeklyDiscountBps" IS NULL AND "monthlyDiscountBps" IS NULL AND "dailyCeilingTzs" IS NULL AND "weeklyCeilingTzs" IS NULL AND "monthlyCeilingTzs" IS NULL)`,
    rule_has_value_ck: `COALESCE("networkPayoutBps", "dailyDiscountBps", "weeklyDiscountBps", "monthlyDiscountBps", "dailyCeilingTzs", "weeklyCeilingTzs", "monthlyCeilingTzs") IS NOT NULL`,
    rule_special_contract_ck: `"scopeType" <> 'special_contract' OR "status" <> 'active'`,
    rule_version_ck: `"version" >= 1`,
  };
  for (const [name, sql] of Object.entries(ruleChecks)) {
    await knex.raw(`ALTER TABLE "SettlementRule" DROP CONSTRAINT IF EXISTS ${name}`);
    await knex.raw(`ALTER TABLE "SettlementRule" ADD CONSTRAINT ${name} CHECK (${sql})`);
  }
  await commonChecks(knex, 'SettlementRule', 'rule', []);
  await guards(knex, 'SettlementRule', `ROW."scopeType" || ':' || COALESCE(ROW."scopeId", '')`, { blockDelete: true });

  if (!(await knex.schema.hasTable('GymRateCard'))) {
    await knex.schema.createTable('GymRateCard', (t) => {
      t.text('id').primary();
      // A gym's cards go with the gym, like its check-ins (admin gym delete).
      t.text('gymId').notNullable().references('id').inTable('Gym').onDelete('CASCADE').onUpdate('CASCADE');
      t.integer('version').notNullable();
      t.text('gymTier').notNullable();
      tzs(t, 'retailDailyTzs'); tzs(t, 'retailWeeklyTzs'); tzs(t, 'retailMonthlyTzs');
      bps(t, 'dailyDiscountBps'); bps(t, 'weeklyDiscountBps'); bps(t, 'monthlyDiscountBps');
      tzs(t, 'dailyCeilingTzs'); tzs(t, 'weeklyCeilingTzs'); tzs(t, 'monthlyCeilingTzs');
      t.jsonb('ruleSources');
      t.text('status').notNullable().defaultTo('draft');
      t.text('effectiveFrom');
      t.text('effectiveTo');
      t.text('reason');
      t.text('createdBy');
      t.text('approvedBy');
      t.timestamp('approvedAt', { precision: 3 });
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 });
      t.unique(['gymId', 'version']);
      t.index(['gymId', 'effectiveFrom']);
      t.index(['gymTier', 'effectiveFrom']);
    });
  }
  const cardChecks = {
    rate_card_retail_ck: ['retailDailyTzs', 'retailWeeklyTzs', 'retailMonthlyTzs'].map((c) => `"${c}" IS NOT NULL AND "${c}" >= 0`).join(' AND '),
    rate_card_bps_ck: ['dailyDiscountBps', 'weeklyDiscountBps', 'monthlyDiscountBps'].map((c) => `("${c}" IS NULL OR "${c}" BETWEEN 0 AND 10000)`).join(' AND '),
    rate_card_tzs_ck: ['dailyCeilingTzs', 'weeklyCeilingTzs', 'monthlyCeilingTzs'].map((c) => `("${c}" IS NULL OR "${c}" >= 0)`).join(' AND '),
    rate_card_tier_ck: `"gymTier" IN ('online', 'standard', 'midtier', 'premium', 'luxury_executive')`,
    rate_card_version_ck: `"version" >= 1`,
  };
  for (const [name, sql] of Object.entries(cardChecks)) {
    await knex.raw(`ALTER TABLE "GymRateCard" DROP CONSTRAINT IF EXISTS ${name}`);
    await knex.raw(`ALTER TABLE "GymRateCard" ADD CONSTRAINT ${name} CHECK (${sql})`);
  }
  await commonChecks(knex, 'GymRateCard', 'rate_card', [
    'dailyDiscountBps', 'weeklyDiscountBps', 'monthlyDiscountBps', 'dailyCeilingTzs', 'weeklyCeilingTzs', 'monthlyCeilingTzs', 'ruleSources',
  ]);
  await guards(knex, 'GymRateCard', 'ROW."gymId"', { blockDelete: false });

  // Approved Dar values (DR-06, DR-07, DR-22) as drafts: activated later with a date.
  const seed = { status: 'draft', createdBy: SEEDED_BY, reason: 'Approved initial Dar es Salaam configuration (decision register DR-06, DR-07, DR-22)' };
  await knex('PassTierVersion').insert([
    { id: 'ptv-basic-1', tierKey: 'basic', version: 1, priceTzs: 60000, visitAllowance: 16, ...seed },
    { id: 'ptv-pro-1', tierKey: 'pro', version: 1, priceTzs: 150000, visitAllowance: 18, ...seed },
    { id: 'ptv-premium-1', tierKey: 'premium', version: 1, priceTzs: 250000, visitAllowance: 20, ...seed },
    { id: 'ptv-executive-1', tierKey: 'executive', version: 1, priceTzs: 400000, visitAllowance: 24, ...seed },
  ]).onConflict('id').ignore();
  await knex('SettlementRule').insert([
    { id: 'rule-global-1', name: 'Global defaults', version: 1, scopeType: 'global', scopeId: null,
      dailyDiscountBps: 2500, weeklyDiscountBps: 2000, monthlyDiscountBps: 2000, networkPayoutBps: 7500, ...seed },
    { id: 'rule-ceil-standard-1', name: 'Standard gym ceilings', version: 1, scopeType: 'gym_tier', scopeId: 'standard', dailyCeilingTzs: 3500, weeklyCeilingTzs: 12000, monthlyCeilingTzs: 42000, ...seed },
    { id: 'rule-ceil-midtier-1', name: 'Mid-tier gym ceilings', version: 1, scopeType: 'gym_tier', scopeId: 'midtier', dailyCeilingTzs: 7500, weeklyCeilingTzs: 30000, monthlyCeilingTzs: 105000, ...seed },
    { id: 'rule-ceil-premium-1', name: 'Premium gym ceilings', version: 1, scopeType: 'gym_tier', scopeId: 'premium', dailyCeilingTzs: 12000, weeklyCeilingTzs: 50000, monthlyCeilingTzs: 175000, ...seed },
    { id: 'rule-ceil-luxury-1', name: 'Luxury/Executive gym ceilings', version: 1, scopeType: 'gym_tier', scopeId: 'luxury_executive', dailyCeilingTzs: 18000, weeklyCeilingTzs: 75000, monthlyCeilingTzs: 270000, ...seed },
  ]).onConflict('id').ignore();
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const table of ['GymRateCard', 'SettlementRule', 'PassTierVersion']) {
    await knex.schema.dropTableIfExists(table);
    const fn = `${table.toLowerCase()}_guard`;
    await knex.raw(`DROP FUNCTION IF EXISTS ${fn}_overlap()`);
    await knex.raw(`DROP FUNCTION IF EXISTS ${fn}_immutable()`);
  }
};
