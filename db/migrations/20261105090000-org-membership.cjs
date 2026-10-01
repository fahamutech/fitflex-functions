// Identity V2 · I4 — organisation memberships.
//
//   Vendor         a thin organisation record for each vendor. Its id IS the
//                  vendor persona's existing User.id, so Product.vendorId,
//                  enquiries and notifications keep pointing at the same id.
//                  The store profile stays on the vendor's User row.
//   OrgMembership  one Person's relationship with one gym or vendor in one
//                  role, with an explicit lifecycle status. Corporate
//                  relationships are not stored here: the B2B tables
//                  (B2BOrganizationUser, B2BBeneficiary) already hold them.
//
// Nothing existing is changed or removed. User.gymIds, TrainerProfileGym,
// direct subscriptions and User.vendorId stay the source of truth; memberships
// are derived from them (src/services/org-membership-service.mjs) until a
// later phase reads authority from memberships.

const ROLES = { gym: ['owner', 'staff', 'trainer', 'member'], vendor: ['owner', 'staff'] };
const STATUSES = ['requested', 'invited', 'active', 'suspended', 'declined', 'left', 'removed'];
const LIVE = ['requested', 'invited', 'active', 'suspended'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('Vendor', t => {
    t.text('id').primary();                        // = the vendor persona's User.id
    t.text('name').notNullable();
    t.text('status').notNullable().defaultTo('active');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE "Vendor"
    ADD CONSTRAINT vendor_status_check CHECK (status IN ('active', 'suspended', 'closed'))`);

  await knex.schema.createTable('OrgMembership', t => {
    t.text('id').primary();
    t.text('personId').notNullable().references('id').inTable('Person').onDelete('RESTRICT');
    // The persona (User row) the role acts through; kept if the persona goes.
    t.text('personaId').references('id').inTable('User').onDelete('SET NULL');
    t.text('orgType').notNullable();
    // Exactly one, matching orgType. Gyms cascade like every other gym-owned row.
    t.text('gymId').references('id').inTable('Gym').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('vendorId').references('id').inTable('Vendor').onDelete('RESTRICT');
    t.text('role').notNullable();
    t.text('status').notNullable();
    t.specificType('aclPermissions', 'text[]').notNullable().defaultTo('{}');
    t.text('source').notNullable().defaultTo('sync'); // sync | invite | application
    t.text('invitedBy');
    t.timestamp('startedAt', { useTz: true });
    t.timestamp('endedAt', { useTz: true });
    t.text('endedBy');
    t.text('endReason');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['personId', 'status']);
    t.index(['personaId']);
    t.index(['gymId', 'role', 'status']);
    t.index(['vendorId', 'role', 'status']);
  });
  await knex.raw(`ALTER TABLE "OrgMembership"
    ADD CONSTRAINT org_membership_org_type_check CHECK ("orgType" IN ('gym', 'vendor')),
    ADD CONSTRAINT org_membership_one_org_check CHECK (
      ("orgType" = 'gym' AND "gymId" IS NOT NULL AND "vendorId" IS NULL) OR
      ("orgType" = 'vendor' AND "vendorId" IS NOT NULL AND "gymId" IS NULL)),
    ADD CONSTRAINT org_membership_role_check CHECK (
      ("orgType" = 'gym' AND role IN (${list(ROLES.gym)})) OR
      ("orgType" = 'vendor' AND role IN (${list(ROLES.vendor)}))),
    ADD CONSTRAINT org_membership_status_check CHECK (status IN (${list(STATUSES)}))`);
  // One live membership per Person, organisation and role.
  await knex.raw(`CREATE UNIQUE INDEX org_membership_gym_live_unique
    ON "OrgMembership" ("gymId", "personId", role)
    WHERE "orgType" = 'gym' AND status IN (${list(LIVE)})`);
  await knex.raw(`CREATE UNIQUE INDEX org_membership_vendor_live_unique
    ON "OrgMembership" ("vendorId", "personId", role)
    WHERE "orgType" = 'vendor' AND status IN (${list(LIVE)})`);

  // Backfill from today's sources, using the same code that keeps memberships
  // in step afterwards. A failure here must not fail the deploy: the sync is
  // re-runnable (scripts/org-membership-sync.mjs).
  try {
    const { createOrgMembershipService } = await import('../../src/services/org-membership-service.mjs');
    const report = await createOrgMembershipService({ db: knex }).syncAll({ apply: true });
    console.log(`[migrate] org memberships: ${report.inserted} created, ${report.vendors} vendor record(s)`);
  } catch (err) {
    console.warn('[migrate] org membership backfill skipped:', err?.message);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  // Derived data only: the sources it was built from are untouched.
  await knex.schema.dropTableIfExists('OrgMembership');
  await knex.schema.dropTableIfExists('Vendor');
};
