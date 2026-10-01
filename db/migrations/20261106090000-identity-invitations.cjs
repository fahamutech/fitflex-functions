// Identity V2 · I6 (slice A) — invitations.
//
//   Invitation    an organisation asking a person to take a role with it. It
//                 targets a known Person, or an email/phone that a person
//                 later proves is theirs. It never carries credentials, and
//                 holding its token grants nothing: accepting needs a signed-
//                 in session that owns the target. Only the token's hash is
//                 stored.
//   OrgLookupLog  one row per "does this person use FitFlex?" lookup: the
//                 audit trail, and what the rate limits count. Stores a hash
//                 of the identifier, never the identifier.
//
// Additive; nothing reads these unless IDENTITY_V2 + V2_INVITES are on.

const ROLES = { gym: ['owner', 'staff', 'trainer', 'member'], vendor: ['owner', 'staff'] };
const STATUSES = ['pending', 'claimed', 'accepted', 'declined', 'expired', 'cancelled'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('Invitation', t => {
    t.text('id').primary();
    t.text('orgType').notNullable();
    t.text('gymId').references('id').inTable('Gym').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('vendorId').references('id').inTable('Vendor').onDelete('RESTRICT');
    t.text('role').notNullable();
    // Who it is for: a Person, and/or the identifier it was addressed to.
    t.text('targetPersonId').references('id').inTable('Person').onDelete('RESTRICT');
    t.text('identifierType');
    t.text('identifierValue');                 // normalised (lower-case email, E.164 phone)
    t.text('tokenHash').notNullable().unique();
    t.text('status').notNullable().defaultTo('pending');
    t.boolean('requiresAcceptance').notNullable().defaultTo(true);
    t.specificType('aclPermissions', 'text[]').notNullable().defaultTo('{}');
    t.jsonb('payload');                        // role-specific extras (e.g. a desk-sale plan)
    t.text('message');
    t.text('invitedBy').notNullable();         // persona (User id) that sent it
    t.text('membershipId').references('id').inTable('OrgMembership').onDelete('SET NULL');
    t.integer('resendCount').notNullable().defaultTo(0);
    t.timestamp('lastSentAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expiresAt', { useTz: true }).notNullable();
    t.timestamp('claimedAt', { useTz: true });
    t.timestamp('respondedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['targetPersonId', 'status']);
    t.index(['identifierType', 'identifierValue', 'status']);
    t.index(['gymId', 'status']);
    t.index(['vendorId', 'status']);
  });
  await knex.raw(`ALTER TABLE "Invitation"
    ADD CONSTRAINT invitation_org_type_check CHECK ("orgType" IN ('gym', 'vendor')),
    ADD CONSTRAINT invitation_one_org_check CHECK (
      ("orgType" = 'gym' AND "gymId" IS NOT NULL AND "vendorId" IS NULL) OR
      ("orgType" = 'vendor' AND "vendorId" IS NOT NULL AND "gymId" IS NULL)),
    ADD CONSTRAINT invitation_role_check CHECK (
      ("orgType" = 'gym' AND role IN (${list(ROLES.gym)})) OR
      ("orgType" = 'vendor' AND role IN (${list(ROLES.vendor)}))),
    ADD CONSTRAINT invitation_status_check CHECK (status IN (${list(STATUSES)})),
    ADD CONSTRAINT invitation_target_check CHECK (
      "targetPersonId" IS NOT NULL OR ("identifierType" IS NOT NULL AND "identifierValue" IS NOT NULL)),
    ADD CONSTRAINT invitation_identifier_type_check CHECK ("identifierType" IS NULL OR "identifierType" IN ('email', 'phone')),
    ADD CONSTRAINT invitation_expiry_check CHECK ("expiresAt" > "createdAt")`);
  // One open invitation per organisation, role and target.
  await knex.raw(`CREATE UNIQUE INDEX invitation_open_person_unique
    ON "Invitation" ("orgType", coalesce("gymId", "vendorId"), role, "targetPersonId")
    WHERE status IN ('pending', 'claimed') AND "targetPersonId" IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX invitation_open_identifier_unique
    ON "Invitation" ("orgType", coalesce("gymId", "vendorId"), role, "identifierType", "identifierValue")
    WHERE status IN ('pending', 'claimed') AND "identifierValue" IS NOT NULL`);

  await knex.schema.createTable('OrgLookupLog', t => {
    t.text('id').primary();
    t.text('actorUserId').notNullable();
    t.text('orgType').notNullable();
    t.text('orgId').notNullable();
    t.text('identifierType').notNullable();
    t.text('identifierHash').notNullable();    // sha256 of the normalised identifier
    t.boolean('found').notNullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['actorUserId', 'createdAt']);
    t.index(['orgType', 'orgId', 'createdAt']);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('OrgLookupLog');
  await knex.schema.dropTableIfExists('Invitation');
};
