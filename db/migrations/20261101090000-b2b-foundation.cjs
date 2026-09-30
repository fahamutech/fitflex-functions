// B2B Foundation V1 — generalised organisations, their users and beneficiaries.
//
// Adds a B2B layer next to (never instead of) Corporate wellness:
//
//   B2BOrganization      any organisation that sponsors wellness for a population
//                        (employer, insurer, club, association, bank, NGO, ...)
//   B2BOrganizationUser  a FitFlex user who administers an organisation (role + status)
//   B2BBeneficiary       a FitFlex member who receives, or may receive, the
//                        organisation's benefits — a relationship, not an identity
//
// Corporate stays exactly as it is. CorporateAccount, CorporateEmployee,
// CorporateBill, User.corporateId and every corporate route are untouched. A
// CorporateAccount is represented by one employer B2BOrganization through
// B2BOrganization.legacyCorporateId (unique); its employees and HR logins are
// read through from the Corporate tables by the service, never copied here, so
// seat limits, billing and HR tools keep a single source of truth.
//
// Organisation types, user roles and beneficiary types are validated in
// src/shared/b2b.mjs (adding a type is a code change, not a migration). The
// lifecycle statuses are closed sets and are enforced here.

const ORG_STATUSES = ['pending', 'active', 'suspended', 'inactive'];
const ORG_USER_STATUSES = ['active', 'suspended', 'removed'];
const BENEFICIARY_STATUSES = ['pending', 'active', 'suspended', 'inactive'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });
  const stamps = (t) => {
    ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
    ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
  };
  const table = async (name, build) => {
    if (!(await knex.schema.hasTable(name))) await knex.schema.createTable(name, build);
  };

  await table('B2BOrganization', (t) => {
    t.text('id').primary();
    t.text('organizationType').notNullable();
    t.text('legalName').notNullable();
    t.text('tradingName');
    t.text('industrySector');
    t.text('registrationNumber');
    t.text('taxIdentificationNumber');
    t.text('email');
    t.text('phone');
    t.jsonb('address');
    t.text('status').notNullable().defaultTo('pending');
    t.text('statusReason');
    ts(t, 'statusChangedAt');
    // The CorporateAccount this organisation represents (employer only). RESTRICT:
    // a mapped company can't be deleted out from under its organisation.
    t.text('legacyCorporateId').unique()
      .references('id').inTable('CorporateAccount').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('createdBy');
    stamps(t);
    t.index('organizationType');
    t.index('status');
  });

  await table('B2BOrganizationUser', (t) => {
    t.text('id').primary();
    t.text('organizationId').notNullable()
      .references('id').inTable('B2BOrganization').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('userId').notNullable()
      .references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('role').notNullable();
    // Grants on top of the role's defaults (src/shared/b2b.mjs PERMISSIONS).
    t.specificType('permissions', 'TEXT[]').notNullable().defaultTo('{}');
    t.text('status').notNullable().defaultTo('active');
    ts(t, 'removedAt');
    t.text('createdBy');
    stamps(t);
    t.index('userId');
    t.index(['organizationId', 'status']);
  });

  await table('B2BBeneficiary', (t) => {
    t.text('id').primary();
    t.text('organizationId').notNullable()
      .references('id').inTable('B2BOrganization').onDelete('CASCADE').onUpdate('CASCADE');
    // The FitFlex member. SET NULL keeps the organisation's record if the
    // persona is deleted; enrolment itself always requires a member.
    t.text('userId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('externalReference');            // staff number, policy number, membership number
    t.text('beneficiaryType').notNullable();
    t.text('groupName');                    // department, branch, scheme, class
    t.text('status').notNullable().defaultTo('pending');
    ts(t, 'enrolledAt');
    ts(t, 'statusChangedAt');
    t.text('createdBy');
    stamps(t);
    t.index('userId');
    t.index(['organizationId', 'status']);
  });

  const inList = (col, values) => `"${col}" IN (${values.map(v => `'${v}'`).join(', ')})`;
  const checks = [
    ['B2BOrganization', 'b2b_org_status_chk', inList('status', ORG_STATUSES)],
    // Lowercase slug, so new types need code, not DDL.
    ['B2BOrganization', 'b2b_org_type_chk', `"organizationType" ~ '^[a-z][a-z0-9_]{1,39}$'`],
    ['B2BOrganization', 'b2b_org_legal_name_chk', `btrim("legalName") <> ''`],
    // A CorporateAccount is always an employer.
    ['B2BOrganization', 'b2b_org_legacy_corporate_chk', `"legacyCorporateId" IS NULL OR "organizationType" = 'employer'`],
    ['B2BOrganizationUser', 'b2b_org_user_status_chk', inList('status', ORG_USER_STATUSES)],
    ['B2BOrganizationUser', 'b2b_org_user_removed_chk', `("status" = 'removed') = ("removedAt" IS NOT NULL)`],
    ['B2BBeneficiary', 'b2b_beneficiary_status_chk', inList('status', BENEFICIARY_STATUSES)],
  ];
  for (const [tbl, name, expr] of checks) {
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [tbl, name]);
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${expr})`, [tbl, name]);
  }

  // One legal entity per registration / tax number (the service normalises them).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_org_registration_uq
    ON "B2BOrganization" ("registrationNumber") WHERE "registrationNumber" IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_org_tin_uq
    ON "B2BOrganization" ("taxIdentificationNumber") WHERE "taxIdentificationNumber" IS NOT NULL`);
  // One live admin seat per user per organisation; a removed row may be re-added.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_org_user_live_uq
    ON "B2BOrganizationUser" ("organizationId", "userId") WHERE "status" <> 'removed'`);
  // One relationship row per member per organisation (re-enrolment changes its status).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_beneficiary_user_uq
    ON "B2BBeneficiary" ("organizationId", "userId") WHERE "userId" IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS b2b_beneficiary_external_ref_uq
    ON "B2BBeneficiary" ("organizationId", "externalReference") WHERE "externalReference" IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('B2BBeneficiary');
  await knex.schema.dropTableIfExists('B2BOrganizationUser');
  await knex.schema.dropTableIfExists('B2BOrganization');
};
