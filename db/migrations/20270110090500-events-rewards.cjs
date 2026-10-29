// Marathon & running events · S1 (foundation) — medals, achievements and the reward ledger (skeleton).
// Design: PRD §5.8, §7; D9 (FitFlex-funded digital-only rewards at launch; issuer + funding fields
// modelled for sponsors, unused). Nothing here awards anything yet (S6).
//
// - EventMedalTemplate: a digital medal an event (optionally one category) gives; name {en, sw};
//   rule jsonb says who earns it (e.g. { finish: true }).
// - EventMedalAward: one medal per registration per template (unique); awarded | revoked with the result
//   it came from, so a corrected or disqualified result can revoke it traceably.
// - AchievementDefinition / UserAchievement: platform-wide achievements ("first 10K", "3 events in a
//   year"); criteria jsonb + ruleVersion. awardKey is unique: the same source can never award twice.
// - RewardDefinition: a redeemable reward (issuerType fitflex | partner | sponsor; points and/or TZS
//   value; caps; eligibility; expiry; fundingNote for who pays — D9).
// - RewardLedgerEntry: APPEND-ONLY. earn | redeem | expire | reverse; a reversal is a new row pointing at
//   the entry it undoes (reversesEntryId); the balance is Σ points. idempotencyKey is unique so a retry
//   cannot add a second entry. A trigger refuses UPDATE, DELETE and TRUNCATE (the PartnerKycEvent pattern),
//   which also means a user with ledger rows cannot be deleted through the FK (RESTRICT) — account
//   deletion for such users is an S6 decision (called out in the PR).
// - RewardRedemption: a claim of a reward: reserved → redeemed | cancelled | expired; codeHash unique
//   (the code itself is never stored); idempotencyKey unique.
//
// Medal templates and awards are fenced to one event by composite FKs; awards are ON DELETE RESTRICT on
// the registration (review #242).
//
// Dormant: no route reads these tables (EVENTS_MODULE off). Down drops the triggers, their function and
// the seven tables, and refuses while any RewardLedgerEntry exists (fail closed).

const AWARD_STATUSES = ['awarded', 'revoked'];
const DEFINITION_STATUSES = ['draft', 'active', 'paused', 'ended'];
const ISSUER_TYPES = ['fitflex', 'partner', 'sponsor'];
const ENTRY_TYPES = ['earn', 'redeem', 'expire', 'reverse'];
const REDEMPTION_STATUSES = ['reserved', 'redeemed', 'cancelled', 'expired'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const stamps = (t) => {
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  };

  await knex.schema.createTable('EventMedalTemplate', (t) => {
    t.text('id').primary();
    t.text('eventId').notNullable().references('id').inTable('Event').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('categoryId');
    t.jsonb('name').notNullable().defaultTo('{}');
    t.text('imageUrl');
    t.jsonb('rule').notNullable().defaultTo('{}');
    t.text('status').notNullable().defaultTo('active');
    stamps(t);
    t.unique(['id', 'eventId']);
    t.index(['eventId']);
  });
  await knex.raw(`ALTER TABLE "EventMedalTemplate"
    ADD CONSTRAINT eventmedaltemplate_category_fk FOREIGN KEY ("categoryId", "eventId") REFERENCES "EventCategory" (id, "eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT eventmedaltemplate_status_check CHECK (status IN ('active', 'inactive'))`);

  await knex.schema.createTable('EventMedalAward', (t) => {
    t.text('id').primary();
    t.text('registrationId').notNullable();
    t.text('eventId').notNullable();
    t.text('medalTemplateId').notNullable();
    t.text('awardStatus').notNullable().defaultTo('awarded');
    t.text('sourceResultId').references('id').inTable('EventResult').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('awardedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('revokedAt', { precision: 3 });
    t.text('reason');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['registrationId', 'medalTemplateId']);
  });
  await knex.raw(`ALTER TABLE "EventMedalAward"
    ADD CONSTRAINT eventmedalaward_registration_fk FOREIGN KEY ("registrationId", "eventId") REFERENCES "EventRegistration" (id, "eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT eventmedalaward_template_fk FOREIGN KEY ("medalTemplateId", "eventId") REFERENCES "EventMedalTemplate" (id, "eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT eventmedalaward_status_check CHECK ("awardStatus" IN (${list(AWARD_STATUSES)})),
    ADD CONSTRAINT eventmedalaward_revoked_check CHECK (("awardStatus" = 'revoked') = ("revokedAt" IS NOT NULL))`);

  await knex.schema.createTable('AchievementDefinition', (t) => {
    t.text('id').primary();
    t.text('key').notNullable();
    t.jsonb('title').notNullable().defaultTo('{}');
    t.integer('ruleVersion').notNullable().defaultTo(1);
    t.jsonb('criteria').notNullable().defaultTo('{}');
    t.text('status').notNullable().defaultTo('active');
    stamps(t);
    t.unique(['key']);
  });
  await knex.raw(`ALTER TABLE "AchievementDefinition"
    ADD CONSTRAINT achievementdefinition_status_check CHECK (status IN ('active', 'inactive')),
    ADD CONSTRAINT achievementdefinition_key_format_check CHECK (key ~ '^[a-z0-9_]{3,80}$'),
    ADD CONSTRAINT achievementdefinition_rule_version_check CHECK ("ruleVersion" >= 1)`);

  await knex.schema.createTable('UserAchievement', (t) => {
    t.text('id').primary();
    t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('achievementDefinitionId').notNullable().references('id').inTable('AchievementDefinition').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('sourceType').notNullable();
    t.text('sourceId');
    t.text('status').notNullable().defaultTo('awarded');
    t.text('awardKey').notNullable();
    t.timestamp('awardedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('revokedAt', { precision: 3 });
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['awardKey']);
    t.index(['userId', 'status']);
  });
  await knex.raw(`ALTER TABLE "UserAchievement"
    ADD CONSTRAINT userachievement_status_check CHECK (status IN (${list(AWARD_STATUSES)})),
    ADD CONSTRAINT userachievement_revoked_check CHECK ((status = 'revoked') = ("revokedAt" IS NOT NULL))`);

  await knex.schema.createTable('RewardDefinition', (t) => {
    t.text('id').primary();
    t.text('issuerType').notNullable();
    t.text('issuerId');
    t.jsonb('title').notNullable().defaultTo('{}');
    t.text('rewardType').notNullable();
    t.integer('valueTzs');
    t.integer('points');
    t.jsonb('terms').notNullable().defaultTo('{}');
    t.timestamp('startsAt', { precision: 3 });
    t.timestamp('endsAt', { precision: 3 });
    t.integer('capTotal');
    t.integer('capPerUser');
    t.jsonb('eligibility').notNullable().defaultTo('{}');
    t.integer('expiryDays');
    t.text('fundingNote');
    t.text('status').notNullable().defaultTo('draft');
    stamps(t);
    t.index(['status', 'startsAt']);
  });
  await knex.raw(`ALTER TABLE "RewardDefinition"
    ADD CONSTRAINT rewarddefinition_issuer_check CHECK ("issuerType" IN (${list(ISSUER_TYPES)})),
    ADD CONSTRAINT rewarddefinition_issuer_id_check CHECK ("issuerType" = 'fitflex' OR "issuerId" IS NOT NULL),
    ADD CONSTRAINT rewarddefinition_status_check CHECK (status IN (${list(DEFINITION_STATUSES)})),
    ADD CONSTRAINT rewarddefinition_amounts_check CHECK (("valueTzs" IS NULL OR "valueTzs" >= 0) AND (points IS NULL OR points >= 0)
      AND ("capTotal" IS NULL OR "capTotal" >= 0) AND ("capPerUser" IS NULL OR "capPerUser" >= 0) AND ("expiryDays" IS NULL OR "expiryDays" >= 1)),
    ADD CONSTRAINT rewarddefinition_window_check CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" >= "startsAt")`);

  await knex.schema.createTable('RewardLedgerEntry', (t) => {
    t.text('id').primary();
    t.text('userId').notNullable().references('id').inTable('User').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('rewardDefinitionId').references('id').inTable('RewardDefinition').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('entryType').notNullable();
    t.integer('points').notNullable();
    t.integer('valueTzs');
    t.text('sourceType').notNullable();
    t.text('sourceId');
    t.text('reversesEntryId').references('id').inTable('RewardLedgerEntry').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('idempotencyKey').notNullable();
    t.timestamp('occurredAt', { precision: 3 }).notNullable();
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['idempotencyKey']);
    t.index(['userId', 'occurredAt']);
  });
  await knex.raw(`ALTER TABLE "RewardLedgerEntry"
    ADD CONSTRAINT rewardledgerentry_type_check CHECK ("entryType" IN (${list(ENTRY_TYPES)})),
    ADD CONSTRAINT rewardledgerentry_sign_check CHECK (
      ("entryType" = 'earn' AND points >= 0) OR ("entryType" IN ('redeem', 'expire') AND points <= 0) OR "entryType" = 'reverse'),
    ADD CONSTRAINT rewardledgerentry_reverse_check CHECK (("entryType" = 'reverse') = ("reversesEntryId" IS NOT NULL)),
    ADD CONSTRAINT rewardledgerentry_value_check CHECK ("valueTzs" IS NULL OR "valueTzs" >= 0)`);
  // Append-only: rows can be added, never rewritten or removed (same pattern as PartnerKycEvent).
  await knex.raw(`CREATE OR REPLACE FUNCTION reward_ledger_entry_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'RewardLedgerEntry rows are append-only' USING ERRCODE = 'P0001';
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS reward_ledger_entry_no_update ON "RewardLedgerEntry"`);
  await knex.raw(`CREATE TRIGGER reward_ledger_entry_no_update
    BEFORE UPDATE OR DELETE ON "RewardLedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION reward_ledger_entry_immutable()`);
  await knex.raw(`CREATE TRIGGER reward_ledger_entry_no_truncate
    BEFORE TRUNCATE ON "RewardLedgerEntry"
    FOR EACH STATEMENT EXECUTE FUNCTION reward_ledger_entry_immutable()`);

  await knex.schema.createTable('RewardRedemption', (t) => {
    t.text('id').primary();
    t.text('userId').notNullable().references('id').inTable('User').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('rewardDefinitionId').notNullable().references('id').inTable('RewardDefinition').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('ledgerEntryId').references('id').inTable('RewardLedgerEntry').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('codeHash').notNullable();
    t.text('status').notNullable().defaultTo('reserved');
    t.timestamp('reservedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('redeemedAt', { precision: 3 });
    t.text('redeemedBy').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('idempotencyKey');
    stamps(t);
    t.unique(['codeHash']);
    t.unique(['idempotencyKey']);
    t.index(['userId', 'status']);
  });
  await knex.raw(`ALTER TABLE "RewardRedemption"
    ADD CONSTRAINT rewardredemption_status_check CHECK (status IN (${list(REDEMPTION_STATUSES)})),
    ADD CONSTRAINT rewardredemption_redeemed_check CHECK ((status = 'redeemed') = ("redeemedAt" IS NOT NULL))`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasTable('RewardLedgerEntry')) {
    const entries = (await knex.raw(`SELECT count(*)::int AS n FROM "RewardLedgerEntry"`)).rows[0].n;
    if (entries) throw new Error(`events-rewards down: ${entries} RewardLedgerEntry row(s) exist; the ledger cannot be dropped`);
  }
  await knex.schema.dropTableIfExists('RewardRedemption');
  await knex.raw(`DROP TRIGGER IF EXISTS reward_ledger_entry_no_truncate ON "RewardLedgerEntry"`);
  await knex.raw(`DROP TRIGGER IF EXISTS reward_ledger_entry_no_update ON "RewardLedgerEntry"`);
  await knex.schema.dropTableIfExists('RewardLedgerEntry');
  await knex.raw(`DROP FUNCTION IF EXISTS reward_ledger_entry_immutable()`);
  await knex.schema.dropTableIfExists('RewardDefinition');
  await knex.schema.dropTableIfExists('UserAchievement');
  await knex.schema.dropTableIfExists('AchievementDefinition');
  await knex.schema.dropTableIfExists('EventMedalAward');
  await knex.schema.dropTableIfExists('EventMedalTemplate');
};
