// Marathon & running events · S3 (registration modes and checkout orders) — the fields S1/S2 do not have.
// Design: docs/design/events-s3-registration-and-orders.md §3.2; decisions D19 (groupLabel), D20 (duplicate
// policy default one_per_category).
//
// - Event.participantFields (jsonb, {} = the §3.3 defaults): which participant fields an organizer collects
//   (phone, email, dateOfBirth, gender, emergencyContact, kitSize → required | optional | off); name is always
//   required and not configurable. Event.duplicatePolicy: one_per_category (D20) | allow.
// - EventOrder: createdByUserId (the corporate coordinator; purchaserUserId is null on corporate orders),
//   costCentre / purchaserReference (REG-005), termsAcceptedAt / consentTextVersion (PAY-002, REG-010),
//   teamId (an order placed for / into a team; composite FK keeps the team in the order's event).
// - EventRegistration: kitSize (REG-006), consentTextVersion / consentAt (REG-010), claim link lifetime and
//   send bookkeeping (claimTokenExpiresAt, claimInvitedAt, claimInviteCount — S4 sends), phoneNormalized /
//   emailNormalized (duplicate detection and claim matching, indexed with categoryId), groupLabel (D19).
// - EventTeam: joinCode (clear, unique — a low-value invite code like gym codes, not a credential; spec §3.2
//   allows clear or hashed), maxMembers (null = EVENTS_TEAM_MAX_MEMBERS), createdByUserId.
//
// Additive: every column is nullable or defaulted. Down drops them (no data is orphaned by a drop).
// Dormant: nothing reads these until EVENTS_MODULE and EVENTS_REGISTRATION are on.

const DUPLICATE_POLICIES = ['one_per_category', 'allow'];
const KIT_SIZES = ['xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl'];
const list = values => values.map(v => `'${v}'`).join(', ');

async function addColumn(knex, table, column, define) {
  if (!(await knex.schema.hasColumn(table, column))) await knex.schema.alterTable(table, define);
}
async function dropColumn(knex, table, column) {
  if (await knex.schema.hasColumn(table, column)) await knex.schema.alterTable(table, t => t.dropColumn(column));
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  // Event
  await addColumn(knex, 'Event', 'participantFields', t => t.jsonb('participantFields').notNullable().defaultTo('{}'));
  await addColumn(knex, 'Event', 'duplicatePolicy', t => t.text('duplicatePolicy').notNullable().defaultTo('one_per_category'));
  await knex.raw(`ALTER TABLE "Event" DROP CONSTRAINT IF EXISTS event_duplicate_policy_check`);
  await knex.raw(`ALTER TABLE "Event" ADD CONSTRAINT event_duplicate_policy_check CHECK ("duplicatePolicy" IN (${list(DUPLICATE_POLICIES)}))`);

  // EventOrder
  await addColumn(knex, 'EventOrder', 'createdByUserId', t => t.text('createdByUserId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE'));
  await addColumn(knex, 'EventOrder', 'costCentre', t => t.text('costCentre'));
  await addColumn(knex, 'EventOrder', 'purchaserReference', t => t.text('purchaserReference'));
  await addColumn(knex, 'EventOrder', 'termsAcceptedAt', t => t.timestamp('termsAcceptedAt', { precision: 3 }));
  await addColumn(knex, 'EventOrder', 'consentTextVersion', t => t.text('consentTextVersion'));
  await addColumn(knex, 'EventOrder', 'teamId', t => t.text('teamId'));
  await knex.raw(`ALTER TABLE "EventOrder" DROP CONSTRAINT IF EXISTS eventorder_team_fk`);
  await knex.raw(`ALTER TABLE "EventOrder" ADD CONSTRAINT eventorder_team_fk FOREIGN KEY ("teamId", "eventId") REFERENCES "EventTeam" (id, "eventId") ON DELETE SET NULL ("teamId") ON UPDATE CASCADE`);
  await knex.raw(`ALTER TABLE "EventOrder" DROP CONSTRAINT IF EXISTS eventorder_reference_fields_check`);
  await knex.raw(`ALTER TABLE "EventOrder" ADD CONSTRAINT eventorder_reference_fields_check CHECK (
    ("costCentre" IS NULL OR char_length("costCentre") BETWEEN 1 AND 80) AND ("purchaserReference" IS NULL OR char_length("purchaserReference") BETWEEN 1 AND 80))`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS eventorder_created_by_idx ON "EventOrder" ("createdByUserId")`);

  // EventRegistration
  await addColumn(knex, 'EventRegistration', 'kitSize', t => t.text('kitSize'));
  await addColumn(knex, 'EventRegistration', 'consentTextVersion', t => t.text('consentTextVersion'));
  await addColumn(knex, 'EventRegistration', 'consentAt', t => t.timestamp('consentAt', { precision: 3 }));
  await addColumn(knex, 'EventRegistration', 'claimTokenExpiresAt', t => t.timestamp('claimTokenExpiresAt', { precision: 3 }));
  await addColumn(knex, 'EventRegistration', 'claimInvitedAt', t => t.timestamp('claimInvitedAt', { precision: 3 }));
  await addColumn(knex, 'EventRegistration', 'claimInviteCount', t => t.integer('claimInviteCount').notNullable().defaultTo(0));
  await addColumn(knex, 'EventRegistration', 'phoneNormalized', t => t.text('phoneNormalized'));
  await addColumn(knex, 'EventRegistration', 'emailNormalized', t => t.text('emailNormalized'));
  await addColumn(knex, 'EventRegistration', 'groupLabel', t => t.text('groupLabel'));
  await knex.raw(`ALTER TABLE "EventRegistration" DROP CONSTRAINT IF EXISTS eventregistration_kit_size_check`);
  await knex.raw(`ALTER TABLE "EventRegistration" ADD CONSTRAINT eventregistration_kit_size_check CHECK ("kitSize" IS NULL OR "kitSize" IN (${list(KIT_SIZES)}))`);
  await knex.raw(`ALTER TABLE "EventRegistration" DROP CONSTRAINT IF EXISTS eventregistration_claim_invite_count_check`);
  await knex.raw(`ALTER TABLE "EventRegistration" ADD CONSTRAINT eventregistration_claim_invite_count_check CHECK ("claimInviteCount" >= 0)`);
  await knex.raw(`ALTER TABLE "EventRegistration" DROP CONSTRAINT IF EXISTS eventregistration_group_label_check`);
  await knex.raw(`ALTER TABLE "EventRegistration" ADD CONSTRAINT eventregistration_group_label_check CHECK ("groupLabel" IS NULL OR char_length("groupLabel") BETWEEN 1 AND 100)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS eventregistration_category_phone_idx ON "EventRegistration" ("categoryId", "phoneNormalized") WHERE "phoneNormalized" IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS eventregistration_category_email_idx ON "EventRegistration" ("categoryId", "emailNormalized") WHERE "emailNormalized" IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS eventregistration_phone_idx ON "EventRegistration" ("phoneNormalized") WHERE "phoneNormalized" IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS eventregistration_email_idx ON "EventRegistration" ("emailNormalized") WHERE "emailNormalized" IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS eventregistration_purchaser_idx ON "EventRegistration" ("purchaserUserId")`);

  // EventTeam
  await addColumn(knex, 'EventTeam', 'joinCode', t => t.text('joinCode'));
  await addColumn(knex, 'EventTeam', 'maxMembers', t => t.integer('maxMembers'));
  await addColumn(knex, 'EventTeam', 'createdByUserId', t => t.text('createdByUserId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE'));
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS eventteam_join_code_unique ON "EventTeam" ("joinCode") WHERE "joinCode" IS NOT NULL`);
  await knex.raw(`ALTER TABLE "EventTeam" DROP CONSTRAINT IF EXISTS eventteam_max_members_check`);
  await knex.raw(`ALTER TABLE "EventTeam" ADD CONSTRAINT eventteam_max_members_check CHECK ("maxMembers" IS NULL OR "maxMembers" BETWEEN 1 AND 10000)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS eventteam_join_code_unique`);
  await knex.raw(`ALTER TABLE "EventTeam" DROP CONSTRAINT IF EXISTS eventteam_max_members_check`);
  for (const c of ['joinCode', 'maxMembers', 'createdByUserId']) await dropColumn(knex, 'EventTeam', c);

  for (const i of ['eventregistration_category_phone_idx', 'eventregistration_category_email_idx', 'eventregistration_phone_idx', 'eventregistration_email_idx', 'eventregistration_purchaser_idx']) await knex.raw(`DROP INDEX IF EXISTS ${i}`);
  await knex.raw(`ALTER TABLE "EventRegistration"
    DROP CONSTRAINT IF EXISTS eventregistration_kit_size_check,
    DROP CONSTRAINT IF EXISTS eventregistration_claim_invite_count_check,
    DROP CONSTRAINT IF EXISTS eventregistration_group_label_check`);
  for (const c of ['kitSize', 'consentTextVersion', 'consentAt', 'claimTokenExpiresAt', 'claimInvitedAt', 'claimInviteCount', 'phoneNormalized', 'emailNormalized', 'groupLabel']) await dropColumn(knex, 'EventRegistration', c);

  await knex.raw(`DROP INDEX IF EXISTS eventorder_created_by_idx`);
  await knex.raw(`ALTER TABLE "EventOrder" DROP CONSTRAINT IF EXISTS eventorder_team_fk, DROP CONSTRAINT IF EXISTS eventorder_reference_fields_check`);
  for (const c of ['createdByUserId', 'costCentre', 'purchaserReference', 'termsAcceptedAt', 'consentTextVersion', 'teamId']) await dropColumn(knex, 'EventOrder', c);

  await knex.raw(`ALTER TABLE "Event" DROP CONSTRAINT IF EXISTS event_duplicate_policy_check`);
  for (const c of ['participantFields', 'duplicatePolicy']) await dropColumn(knex, 'Event', c);
};
