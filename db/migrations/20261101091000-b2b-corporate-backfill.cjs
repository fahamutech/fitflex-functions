// B2B Foundation V1 — map every existing CorporateAccount to an employer
// B2BOrganization.
//
// Insert-only and idempotent: the id is derived from the corporate id (same
// derivation as src/services/b2b-service.mjs corporateOrganizationId) and
// legacyCorporateId is unique, so re-running adds nothing. CorporateAccount,
// CorporateEmployee, CorporateBill and User are only read. Employees and HR
// logins are not copied — the service reads them through from Corporate.
//
// Accounts created after this migration are mapped by corporateService's
// onAccountCreated hook; POST /admin/b2b/corporate-sync repairs any gap.
//
// down removes only mapped organisations nobody has added B2B users or
// beneficiaries to; anything else is left for a person to look at.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO "B2BOrganization"
      ("id", "organizationType", "legalName", "industrySector", "email", "phone",
       "status", "statusChangedAt", "legacyCorporateId", "createdBy", "createdAt", "updatedAt")
    SELECT
      'b2bo_' || substr(md5('corporate:' || c."id"), 1, 12),
      'employer',
      c."companyName",
      c."industrySector",
      c."hrContactEmail",
      c."hrContactPhone",
      CASE c."status" WHEN 'terminated' THEN 'inactive'
                      WHEN 'active' THEN 'active'
                      WHEN 'suspended' THEN 'suspended'
                      ELSE 'pending' END,
      c."updatedAt",
      c."id",
      'migration:b2b-corporate-backfill',
      c."createdAt",
      now()
    FROM "CorporateAccount" c
    WHERE btrim(coalesce(c."companyName", '')) <> ''
    ON CONFLICT DO NOTHING`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM "B2BOrganization" o
    WHERE o."legacyCorporateId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "B2BOrganizationUser" u WHERE u."organizationId" = o."id")
      AND NOT EXISTS (SELECT 1 FROM "B2BBeneficiary" b WHERE b."organizationId" = o."id")`);
};
