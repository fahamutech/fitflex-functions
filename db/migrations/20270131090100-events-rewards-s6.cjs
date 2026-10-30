// Marathon & running events · S6 (2 of 3) — medal templates, awards, achievements, reward definitions, ledger deletion path.
// Design: docs/design/events-s6-runs-results-medals-rewards.md §4.2, §7 (D44 entitlement units, D45 digital-only, D53 anonymised ledger).
//
// RULE 6 AREA (owner reviews, D35): this migration replaces the append-only trigger of RewardLedgerEntry. The ONLY update the
// ledger now accepts is "userId goes from a user to NULL with every other column unchanged" (account deletion; the
// ON DELETE SET NULL foreign key performs exactly that update, and the trigger stamps anonymisedAt). DELETE and TRUNCATE
// stay forbidden. Everything else (any other column, any other UPDATE) still raises.
//
// - EventMedalTemplate: tier, built-in artwork key, description, sort order, rule must be an object (artId arrives with
//   the artwork tables in 20270131090200).
// - EventMedalAward: reason code and who revoked. UserAchievement: reason code. Five achievements are seeded (idempotent).
// - RewardDefinition: trigger, reversal policy, redeem mode, cooldown. valueTzs must stay empty at launch (service rule).
// - RewardLedgerEntry / RewardRedemption: userId nullable + SET NULL + anonymisedAt; redemption gets expiry, note, role, review flag.
//
// Down FAILS CLOSED once S6 reward data exists.
// Note: the registration trigger below touches resultsVisibility, which migration 20270131090000 adds; rewards sorts after it.

const BUILT_IN_ART = ['finisher_green', 'finisher_gold', 'podium_gold', 'podium_silver', 'podium_bronze', 'time_blue', 'charity_red', 'virtual_teal'];
const list = values => values.map(v => `'${v}'`).join(', ');

const ACHIEVEMENTS = [
  { key: 'first_event_finish', title: { en: 'First event finished', sw: 'Tukio la kwanza limekamilika' }, criteria: { type: 'event_finishes', count: 1 } },
  { key: 'first_10k_finish', title: { en: 'First 10K finished', sw: '10K ya kwanza imekamilika' }, criteria: { type: 'distance_finish', minMeters: 10000, count: 1 } },
  { key: 'half_marathon_finish', title: { en: 'Half marathon finisher', sw: 'Amemaliza nusu marathoni' }, criteria: { type: 'distance_finish', minMeters: 21000, count: 1 } },
  { key: 'marathon_finish', title: { en: 'Marathon finisher', sw: 'Amemaliza marathoni' }, criteria: { type: 'distance_finish', minMeters: 42000, count: 1 } },
  { key: 'three_events_year', title: { en: '3 events in 12 months', sw: 'Matukio 3 ndani ya miezi 12' }, criteria: { type: 'event_finishes', count: 3, windowDays: 365 } },
];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  // ── Medal templates and awards ──
  await knex.raw(`ALTER TABLE "EventMedalTemplate"
    ADD COLUMN tier text NOT NULL DEFAULT 'finisher',
    ADD COLUMN "artKey" text NOT NULL DEFAULT 'finisher_green',
    ADD COLUMN description jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN "sortOrder" integer NOT NULL DEFAULT 0`);
  await knex.raw(`ALTER TABLE "EventMedalTemplate"
    ADD CONSTRAINT eventmedaltemplate_tier_check CHECK (tier IN ('finisher', 'gold', 'silver', 'bronze', 'time', 'other')),
    ADD CONSTRAINT eventmedaltemplate_art_key_check CHECK ("artKey" IN (${list(BUILT_IN_ART)})),
    ADD CONSTRAINT eventmedaltemplate_rule_object_check CHECK (jsonb_typeof(rule) = 'object'),
    ADD CONSTRAINT eventmedaltemplate_description_check CHECK (jsonb_typeof(description) = 'object')`);

  await knex.raw(`ALTER TABLE "EventMedalAward" ADD COLUMN "reasonCode" text, ADD COLUMN "revokedBy" text`);
  await knex.raw(`ALTER TABLE "EventMedalAward" ADD CONSTRAINT eventmedalaward_reason_code_check CHECK ("reasonCode" IS NULL OR char_length("reasonCode") <= 40)`);
  await knex.raw(`ALTER TABLE "UserAchievement" ADD COLUMN "reasonCode" text`);

  for (const a of ACHIEVEMENTS) {
    await knex.raw(`INSERT INTO "AchievementDefinition" (id, key, title, "ruleVersion", criteria, status)
      VALUES (?, ?, ?::jsonb, 1, ?::jsonb, 'active') ON CONFLICT (key) DO NOTHING`, [`ach_${a.key}`, a.key, JSON.stringify(a.title), JSON.stringify(a.criteria)]);
  }

  // ── Reward definitions ──
  await knex.raw(`ALTER TABLE "RewardDefinition"
    ADD COLUMN "triggerType" text NOT NULL DEFAULT 'event_finish',
    ADD COLUMN "triggerEventId" text REFERENCES "Event"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD COLUMN "triggerRef" text,
    ADD COLUMN "reversalPolicy" text NOT NULL DEFAULT 'revoke_unredeemed',
    ADD COLUMN "redeemMode" text NOT NULL DEFAULT 'certificate',
    ADD COLUMN "perUserCooldownDays" integer`);
  await knex.raw(`ALTER TABLE "RewardDefinition"
    ADD CONSTRAINT rewarddefinition_trigger_check CHECK ("triggerType" IN ('event_finish', 'medal', 'achievement')),
    ADD CONSTRAINT rewarddefinition_reversal_check CHECK ("reversalPolicy" IN ('revoke_unredeemed', 'revoke_all')),
    ADD CONSTRAINT rewarddefinition_redeem_mode_check CHECK ("redeemMode" IN ('certificate', 'perk')),
    ADD CONSTRAINT rewarddefinition_cooldown_check CHECK ("perUserCooldownDays" IS NULL OR "perUserCooldownDays" >= 0),
    ADD CONSTRAINT rewarddefinition_trigger_ref_check CHECK ("triggerType" = 'event_finish' OR "triggerRef" IS NOT NULL)`);
  await knex.raw(`CREATE INDEX rewarddefinition_trigger_idx ON "RewardDefinition" ("triggerType", status)`);

  // ── Ledger: anonymisable, still append-only ──
  await knex.raw(`ALTER TABLE "RewardLedgerEntry" ADD COLUMN "anonymisedAt" timestamptz(3)`);
  await knex.raw(`ALTER TABLE "RewardLedgerEntry" DROP CONSTRAINT IF EXISTS rewardledgerentry_userid_foreign`);
  await knex.raw(`ALTER TABLE "RewardLedgerEntry" ALTER COLUMN "userId" DROP NOT NULL`);
  await knex.raw(`ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT rewardledgerentry_userid_foreign FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE`);
  await knex.raw(`ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT rewardledgerentry_user_or_anonymised_check CHECK ("userId" IS NOT NULL OR "anonymisedAt" IS NOT NULL)`);
  await knex.raw(`CREATE INDEX rewardledgerentry_definition_user_idx ON "RewardLedgerEntry" ("rewardDefinitionId", "userId")`);
  await knex.raw(`CREATE OR REPLACE FUNCTION reward_ledger_entry_immutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE'
         AND OLD."userId" IS NOT NULL AND NEW."userId" IS NULL AND OLD."anonymisedAt" IS NULL
         AND (to_jsonb(NEW) - 'userId' - 'anonymisedAt') = (to_jsonb(OLD) - 'userId' - 'anonymisedAt') THEN
        NEW."anonymisedAt" := COALESCE(NEW."anonymisedAt", now());
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'RewardLedgerEntry rows are append-only (the only allowed update is anonymising the user)' USING ERRCODE = 'P0001';
    END;
  $$ LANGUAGE plpgsql`);

  // ── Account deletion of a participant (rule 6 area) ──
  // eventregistration_claimed_check (S3) says "claimedAt set => participantUserId set". Deleting the user makes the foreign key action set
  // participantUserId NULL, which that check refused, so a member who had claimed an event place could not delete their account at all.
  // The check STAYS; a BEFORE UPDATE trigger clears claimedAt in the same row when the participant is removed (the claim relationship is gone
  // with the person; the person fields follow the separate retention rule).
  await knex.raw(`CREATE OR REPLACE FUNCTION event_registration_participant_removed() RETURNS trigger AS $$
    BEGIN
      IF OLD."participantUserId" IS NOT NULL AND NEW."participantUserId" IS NULL THEN
        NEW."claimedAt" := NULL;
        -- the person is gone: nothing about them may appear on a board (M1)
        NEW."resultsVisibility" := 'hidden'; NEW."resultsVisibilitySetAt" := now();
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER event_registration_participant_removed BEFORE UPDATE OF "participantUserId" ON "EventRegistration" FOR EACH ROW EXECUTE FUNCTION event_registration_participant_removed()`);

  // ── Redemptions ──
  await knex.raw(`ALTER TABLE "RewardRedemption"
    ADD COLUMN "anonymisedAt" timestamptz(3),
    ADD COLUMN "expiresAt" timestamptz(3),
    ADD COLUMN "codeKeyId" text,
    ADD COLUMN "adminNote" text,
    ADD COLUMN "redeemedByRole" text,
    ADD COLUMN "needsReview" boolean NOT NULL DEFAULT false`);
  await knex.raw(`ALTER TABLE "RewardRedemption" DROP CONSTRAINT IF EXISTS rewardredemption_userid_foreign`);
  await knex.raw(`ALTER TABLE "RewardRedemption" ALTER COLUMN "userId" DROP NOT NULL`);
  await knex.raw(`ALTER TABLE "RewardRedemption" ADD CONSTRAINT rewardredemption_userid_foreign FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE`);
  await knex.raw(`ALTER TABLE "RewardRedemption"
    ADD CONSTRAINT rewardredemption_user_or_anonymised_check CHECK ("userId" IS NOT NULL OR "anonymisedAt" IS NOT NULL),
    ADD CONSTRAINT rewardredemption_note_check CHECK ("adminNote" IS NULL OR char_length("adminNote") <= 200)`);
  await knex.raw(`CREATE OR REPLACE FUNCTION reward_redemption_anonymise() RETURNS trigger AS $$
    BEGIN
      IF OLD."userId" IS NOT NULL AND NEW."userId" IS NULL AND NEW."anonymisedAt" IS NULL THEN NEW."anonymisedAt" := now(); END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER reward_redemption_anonymise BEFORE UPDATE ON "RewardRedemption" FOR EACH ROW EXECUTE FUNCTION reward_redemption_anonymise()`);
  await knex.raw(`CREATE INDEX rewardredemption_status_expiry_idx ON "RewardRedemption" (status, "expiresAt") WHERE status = 'reserved'`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const count = async sql => Number((await knex.raw(sql)).rows[0].n);
  const blockers = [
    [await count(`SELECT count(*) AS n FROM "RewardLedgerEntry"`), 'reward ledger entries exist'],
    [await count(`SELECT count(*) AS n FROM "RewardRedemption"`), 'reward redemptions exist'],
    [await count(`SELECT count(*) AS n FROM "RewardDefinition"`), 'reward definitions exist'],
    [await count(`SELECT count(*) AS n FROM "EventMedalAward"`), 'medal awards exist'],
    [await count(`SELECT count(*) AS n FROM "UserAchievement"`), 'user achievements exist'],
    [await count(`SELECT count(*) AS n FROM "EventMedalTemplate"`), 'medal templates exist'],
  ].filter(([n]) => n > 0).map(([, why]) => why);
  if (blockers.length) throw new Error(`events S6 (rewards) down refused (fails closed): ${blockers.join('; ')}.`);

  await knex.raw(`DROP TRIGGER IF EXISTS event_registration_participant_removed ON "EventRegistration"`);
  await knex.raw(`DROP FUNCTION IF EXISTS event_registration_participant_removed()`);
  await knex.raw(`DROP TRIGGER IF EXISTS reward_redemption_anonymise ON "RewardRedemption"`);
  await knex.raw(`DROP FUNCTION IF EXISTS reward_redemption_anonymise()`);
  await knex.raw(`DROP INDEX IF EXISTS rewardredemption_status_expiry_idx`);
  await knex.raw(`ALTER TABLE "RewardRedemption" DROP CONSTRAINT IF EXISTS rewardredemption_note_check, DROP CONSTRAINT IF EXISTS rewardredemption_user_or_anonymised_check`);
  await knex.raw(`ALTER TABLE "RewardRedemption" DROP CONSTRAINT IF EXISTS rewardredemption_userid_foreign`);
  await knex.raw(`ALTER TABLE "RewardRedemption" ALTER COLUMN "userId" SET NOT NULL`);
  await knex.raw(`ALTER TABLE "RewardRedemption" ADD CONSTRAINT rewardredemption_userid_foreign FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE`);
  await knex.raw(`ALTER TABLE "RewardRedemption" DROP COLUMN "needsReview", DROP COLUMN "redeemedByRole", DROP COLUMN "adminNote", DROP COLUMN "expiresAt", DROP COLUMN "anonymisedAt"`);

  await knex.raw(`CREATE OR REPLACE FUNCTION reward_ledger_entry_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'RewardLedgerEntry rows are append-only' USING ERRCODE = 'P0001';
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP INDEX IF EXISTS rewardledgerentry_definition_user_idx`);
  await knex.raw(`ALTER TABLE "RewardLedgerEntry" DROP CONSTRAINT IF EXISTS rewardledgerentry_user_or_anonymised_check`);
  await knex.raw(`ALTER TABLE "RewardLedgerEntry" DROP CONSTRAINT IF EXISTS rewardledgerentry_userid_foreign`);
  await knex.raw(`ALTER TABLE "RewardLedgerEntry" ALTER COLUMN "userId" SET NOT NULL`);
  await knex.raw(`ALTER TABLE "RewardLedgerEntry" ADD CONSTRAINT rewardledgerentry_userid_foreign FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE`);
  await knex.raw(`ALTER TABLE "RewardLedgerEntry" DROP COLUMN "anonymisedAt"`);

  await knex.raw(`DROP INDEX IF EXISTS rewarddefinition_trigger_idx`);
  await knex.raw(`ALTER TABLE "RewardDefinition"
    DROP CONSTRAINT IF EXISTS rewarddefinition_trigger_ref_check, DROP CONSTRAINT IF EXISTS rewarddefinition_cooldown_check, DROP CONSTRAINT IF EXISTS rewarddefinition_redeem_mode_check,
    DROP CONSTRAINT IF EXISTS rewarddefinition_reversal_check, DROP CONSTRAINT IF EXISTS rewarddefinition_trigger_check`);
  await knex.raw(`ALTER TABLE "RewardDefinition" DROP COLUMN "perUserCooldownDays", DROP COLUMN "redeemMode", DROP COLUMN "reversalPolicy", DROP COLUMN "triggerRef", DROP COLUMN "triggerEventId", DROP COLUMN "triggerType"`);
  await knex.raw(`DELETE FROM "AchievementDefinition" WHERE id = ANY(string_to_array(?, ',')) `, [ACHIEVEMENTS.map(a => `ach_${a.key}`).join(',')]);
  await knex.raw(`ALTER TABLE "UserAchievement" DROP COLUMN "reasonCode"`);
  await knex.raw(`ALTER TABLE "EventMedalAward" DROP CONSTRAINT IF EXISTS eventmedalaward_reason_code_check`);
  await knex.raw(`ALTER TABLE "EventMedalAward" DROP COLUMN "revokedBy", DROP COLUMN "reasonCode"`);
  await knex.raw(`ALTER TABLE "EventMedalTemplate"
    DROP CONSTRAINT IF EXISTS eventmedaltemplate_description_check, DROP CONSTRAINT IF EXISTS eventmedaltemplate_rule_object_check,
    DROP CONSTRAINT IF EXISTS eventmedaltemplate_art_key_check, DROP CONSTRAINT IF EXISTS eventmedaltemplate_tier_check`);
  await knex.raw(`ALTER TABLE "EventMedalTemplate" DROP COLUMN "sortOrder", DROP COLUMN description, DROP COLUMN "artKey", DROP COLUMN tier`);
};

exports.BUILT_IN_ART = BUILT_IN_ART;
