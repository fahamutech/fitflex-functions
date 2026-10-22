// Marathon & running events · S2 — organizer identity (decision D3; follow-ups.md S2).
//
// The vendor pattern, mirrored: a vendor persona is a User row (userType vendor) and its staff are User
// rows (vendor_staff) carrying vendorId / vendorRole. Organizers do the same with two new user types,
// event_organizer (the owner persona, created by POST /me/organizer) and organizer_staff (created when a
// staff invitation is accepted), both carrying organizerId / organizerRole on the User row. The
// authoritative role record is EventOrganizerStaff (S1); the User columns are the session copy, exactly
// as vendorId / vendorRole are for vendor staff.
//
// - User.organizerId, User.organizerRole: nullable text columns (no FK, like vendorId: the persona row
//   outlives the organisation record and account deletion paths are owned elsewhere).
// - OrgMembership.organizerId → EventOrganizer (RESTRICT, like vendorId): the organizer link S1 left out.
//   org_membership_one_org_check and org_membership_role_check now accept ('organizer', owner | staff);
//   org_membership_organizer_live_unique mirrors the gym and vendor live-uniqueness indexes.
// - Invitation.organizerId → EventOrganizer (RESTRICT): invitation_org_type_check, invitation_one_org_check
//   and invitation_role_check accept ('organizer', staff); the two open-invitation unique indexes are
//   rebuilt over coalesce(gymId, vendorId, organizerId), keeping the statuses
//   20261227090000-invitation-atomic-accept.cjs gave them (pending, claimed, accepting).
//
// Dormant: nothing writes organizer rows until EVENTS_MODULE is on.
// Down: refuses while any row uses the organizer values (the old CHECKs could not be restored over them),
// then restores every constraint and index exactly as 20261105090000-org-membership.cjs and
// 20261106090000-identity-invitations.cjs wrote them and drops the four columns.

const MEMBERSHIP_ROLES = { gym: ['owner', 'staff', 'trainer', 'member'], vendor: ['owner', 'staff'], organizer: ['owner', 'staff'] };
const MEMBERSHIP_LIVE = ['requested', 'invited', 'active', 'suspended'];
const INVITATION_ROLES = { gym: ['owner', 'staff', 'trainer', 'member'], vendor: ['owner', 'staff'], organizer: ['staff'] };
// As 20261227090000-invitation-atomic-accept.cjs left them: an invitation being accepted is still 'open'.
const INVITATION_OPEN = ['pending', 'claimed', 'accepting'];
const list = values => values.map(v => `'${v}'`).join(', ');

async function addColumn(knex, table, column, define) {
  if (!(await knex.schema.hasColumn(table, column))) await knex.schema.alterTable(table, define);
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await addColumn(knex, 'User', 'organizerId', t => t.text('organizerId'));
  await addColumn(knex, 'User', 'organizerRole', t => t.text('organizerRole'));
  await knex.raw(`CREATE INDEX IF NOT EXISTS user_organizer_idx ON "User" ("organizerId") WHERE "organizerId" IS NOT NULL`);

  // ── OrgMembership ─────────────────────────────────────────────────────────
  // org_membership_org_type_check was widened to include 'organizer' by 20270110090000-events-organizers.cjs;
  // re-asserted here (idempotent) so a round-trip of the identity migrations alone leaves it widened too.
  await knex.raw(`ALTER TABLE "OrgMembership" DROP CONSTRAINT IF EXISTS org_membership_org_type_check`);
  await knex.raw(`ALTER TABLE "OrgMembership" ADD CONSTRAINT org_membership_org_type_check CHECK ("orgType" IN ('gym', 'vendor', 'organizer'))`);
  await addColumn(knex, 'OrgMembership', 'organizerId', t => {
    t.text('organizerId').references('id').inTable('EventOrganizer').onDelete('RESTRICT').onUpdate('CASCADE');
    t.index(['organizerId', 'role', 'status']);
  });
  await knex.raw(`ALTER TABLE "OrgMembership"
    DROP CONSTRAINT IF EXISTS org_membership_one_org_check,
    DROP CONSTRAINT IF EXISTS org_membership_role_check`);
  await knex.raw(`ALTER TABLE "OrgMembership"
    ADD CONSTRAINT org_membership_one_org_check CHECK (
      ("orgType" = 'gym' AND "gymId" IS NOT NULL AND "vendorId" IS NULL AND "organizerId" IS NULL) OR
      ("orgType" = 'vendor' AND "vendorId" IS NOT NULL AND "gymId" IS NULL AND "organizerId" IS NULL) OR
      ("orgType" = 'organizer' AND "organizerId" IS NOT NULL AND "gymId" IS NULL AND "vendorId" IS NULL)),
    ADD CONSTRAINT org_membership_role_check CHECK (
      ("orgType" = 'gym' AND role IN (${list(MEMBERSHIP_ROLES.gym)})) OR
      ("orgType" = 'vendor' AND role IN (${list(MEMBERSHIP_ROLES.vendor)})) OR
      ("orgType" = 'organizer' AND role IN (${list(MEMBERSHIP_ROLES.organizer)})))`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS org_membership_organizer_live_unique
    ON "OrgMembership" ("organizerId", "personId", role)
    WHERE "orgType" = 'organizer' AND status IN (${list(MEMBERSHIP_LIVE)})`);

  // ── Invitation ────────────────────────────────────────────────────────────
  await addColumn(knex, 'Invitation', 'organizerId', t => {
    t.text('organizerId').references('id').inTable('EventOrganizer').onDelete('RESTRICT').onUpdate('CASCADE');
    t.index(['organizerId', 'status']);
  });
  await knex.raw(`ALTER TABLE "Invitation"
    DROP CONSTRAINT IF EXISTS invitation_org_type_check,
    DROP CONSTRAINT IF EXISTS invitation_one_org_check,
    DROP CONSTRAINT IF EXISTS invitation_role_check`);
  await knex.raw(`ALTER TABLE "Invitation"
    ADD CONSTRAINT invitation_org_type_check CHECK ("orgType" IN ('gym', 'vendor', 'organizer')),
    ADD CONSTRAINT invitation_one_org_check CHECK (
      ("orgType" = 'gym' AND "gymId" IS NOT NULL AND "vendorId" IS NULL AND "organizerId" IS NULL) OR
      ("orgType" = 'vendor' AND "vendorId" IS NOT NULL AND "gymId" IS NULL AND "organizerId" IS NULL) OR
      ("orgType" = 'organizer' AND "organizerId" IS NOT NULL AND "gymId" IS NULL AND "vendorId" IS NULL)),
    ADD CONSTRAINT invitation_role_check CHECK (
      ("orgType" = 'gym' AND role IN (${list(INVITATION_ROLES.gym)})) OR
      ("orgType" = 'vendor' AND role IN (${list(INVITATION_ROLES.vendor)})) OR
      ("orgType" = 'organizer' AND role IN (${list(INVITATION_ROLES.organizer)})))`);
  await knex.raw('DROP INDEX IF EXISTS invitation_open_person_unique');
  await knex.raw('DROP INDEX IF EXISTS invitation_open_identifier_unique');
  await knex.raw(`CREATE UNIQUE INDEX invitation_open_person_unique
    ON "Invitation" ("orgType", coalesce("gymId", "vendorId", "organizerId"), role, "targetPersonId")
    WHERE status IN (${list(INVITATION_OPEN)}) AND "targetPersonId" IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX invitation_open_identifier_unique
    ON "Invitation" ("orgType", coalesce("gymId", "vendorId", "organizerId"), role, "identifierType", "identifierValue")
    WHERE status IN (${list(INVITATION_OPEN)}) AND "identifierValue" IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const [table, what] of [['OrgMembership', 'membership'], ['Invitation', 'invitation']]) {
    const n = (await knex.raw(`SELECT count(*)::int AS n FROM "${table}" WHERE "orgType" = 'organizer'`)).rows[0].n;
    if (n) throw new Error(`events-organizer-identity down: ${n} ${what} row(s) have orgType organizer; the old CHECKs cannot be restored over them`);
  }
  const users = (await knex.raw(`SELECT count(*)::int AS n FROM "User" WHERE "userType" IN ('event_organizer', 'organizer_staff')`)).rows[0].n;
  if (users) throw new Error(`events-organizer-identity down: ${users} User row(s) are event_organizer / organizer_staff personas; remove them first`);

  await knex.raw('DROP INDEX IF EXISTS invitation_open_person_unique');
  await knex.raw('DROP INDEX IF EXISTS invitation_open_identifier_unique');
  await knex.raw(`ALTER TABLE "Invitation"
    DROP CONSTRAINT IF EXISTS invitation_org_type_check,
    DROP CONSTRAINT IF EXISTS invitation_one_org_check,
    DROP CONSTRAINT IF EXISTS invitation_role_check`);
  await knex.raw(`ALTER TABLE "Invitation"
    ADD CONSTRAINT invitation_org_type_check CHECK ("orgType" IN ('gym', 'vendor')),
    ADD CONSTRAINT invitation_one_org_check CHECK (
      ("orgType" = 'gym' AND "gymId" IS NOT NULL AND "vendorId" IS NULL) OR
      ("orgType" = 'vendor' AND "vendorId" IS NOT NULL AND "gymId" IS NULL)),
    ADD CONSTRAINT invitation_role_check CHECK (
      ("orgType" = 'gym' AND role IN (${list(INVITATION_ROLES.gym)})) OR
      ("orgType" = 'vendor' AND role IN (${list(INVITATION_ROLES.vendor)})))`);
  await knex.raw(`CREATE UNIQUE INDEX invitation_open_person_unique
    ON "Invitation" ("orgType", coalesce("gymId", "vendorId"), role, "targetPersonId")
    WHERE status IN (${list(INVITATION_OPEN)}) AND "targetPersonId" IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX invitation_open_identifier_unique
    ON "Invitation" ("orgType", coalesce("gymId", "vendorId"), role, "identifierType", "identifierValue")
    WHERE status IN (${list(INVITATION_OPEN)}) AND "identifierValue" IS NOT NULL`);
  if (await knex.schema.hasColumn('Invitation', 'organizerId')) {
    await knex.schema.alterTable('Invitation', t => t.dropColumn('organizerId'));
  }

  await knex.raw('DROP INDEX IF EXISTS org_membership_organizer_live_unique');
  await knex.raw(`ALTER TABLE "OrgMembership"
    DROP CONSTRAINT IF EXISTS org_membership_one_org_check,
    DROP CONSTRAINT IF EXISTS org_membership_role_check`);
  await knex.raw(`ALTER TABLE "OrgMembership"
    ADD CONSTRAINT org_membership_one_org_check CHECK (
      ("orgType" = 'gym' AND "gymId" IS NOT NULL AND "vendorId" IS NULL) OR
      ("orgType" = 'vendor' AND "vendorId" IS NOT NULL AND "gymId" IS NULL)),
    ADD CONSTRAINT org_membership_role_check CHECK (
      ("orgType" = 'gym' AND role IN (${list(MEMBERSHIP_ROLES.gym)})) OR
      ("orgType" = 'vendor' AND role IN (${list(MEMBERSHIP_ROLES.vendor)})))`);
  if (await knex.schema.hasColumn('OrgMembership', 'organizerId')) {
    await knex.schema.alterTable('OrgMembership', t => t.dropColumn('organizerId'));
  }

  await knex.raw('DROP INDEX IF EXISTS user_organizer_idx');
  for (const column of ['organizerRole', 'organizerId']) {
    if (await knex.schema.hasColumn('User', column)) await knex.schema.alterTable('User', t => t.dropColumn(column));
  }
};
