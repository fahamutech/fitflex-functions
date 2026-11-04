// Vendor Smart Import V1 — import batches and their rows, and the staff permission `import`.
// Design: docs/design/vendor-import-v1.md (owner approved 2026-11-04). Additive and reversible.
//
// - VendorImportBatch: one uploaded CSV (entity products | inventory | profile). The file's bytes are never
//   stored: only its sha256, which is unique per vendor while a batch is open (the same file cannot be
//   in two open batches; once a batch ends (applied, partial, discarded) the same file may be uploaded again:
//   its rows then meet the SKU / name checks against what the first import created).
// - VendorImportRow: one data row: raw cells (unmapped columns are nulled when the batch ends), the checked
//   values, issues, and what applying it did. vendorId is repeated on purpose: every query filters by it.
// - Permission `import`: added to existing vendor staff with vendorRole admin (User.vendorPermissions, their
//   OrgMembership.aclPermissions and pending vendor Invitation.aclPermissions), mirroring S3's `sales` backfill.
//
// Down: removes `import` from staff and drops both tables (rows of past imports are lost; products they created stay).

const ENTITIES = ['products', 'inventory', 'profile'];
const STATUSES = ['mapping_required', 'ready', 'applying', 'applied', 'partial', 'discarded'];
const ROW_STATUSES = ['valid', 'needs_review', 'invalid'];
const APPLY_STATES = ['pending', 'applied', 'failed', 'skipped'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('VendorImportBatch', (table) => {
    table.text('id').primary();
    table.text('vendorId').notNullable();
    table.text('createdBy').notNullable();
    table.text('entity').notNullable();
    table.text('source').notNullable().defaultTo('csv');
    table.text('filename').notNullable();
    table.integer('sizeBytes').notNullable();
    table.text('fileSha256').notNullable();
    table.text('templateVersion');
    table.text('delimiter').notNullable().defaultTo(',');
    table.text('status').notNullable();
    table.jsonb('counts').notNullable().defaultTo('{}');
    table.jsonb('mapping').notNullable().defaultTo('{}');
    // Decided by the FIRST apply and fixed for the batch's life (null until then).
    table.boolean('includeNeedsReview');
    // Who holds the apply right now: every write while applying must carry it, so a request that was taken over stops writing.
    table.text('claimToken');
    // The status the batch had before the current claim (a give-back restores it: partial stays partial).
    table.text('preClaimStatus');
    // When the typed cells were cleared (discard, abandoned, or 30 days after the batch ended). Counts and codes stay.
    table.timestamp('cellsClearedAt', { precision: 3 });
    table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('applyStartedAt', { precision: 3 });
    table.timestamp('finishedAt', { precision: 3 });
    table.index(['vendorId', 'createdAt'], 'vendorimportbatch_vendor_created_idx');
  });
  await knex.raw(`ALTER TABLE "VendorImportBatch"
    ADD CONSTRAINT vendorimportbatch_entity_check CHECK (entity IN (${list(ENTITIES)})),
    ADD CONSTRAINT vendorimportbatch_status_check CHECK (status IN (${list(STATUSES)})),
    ADD CONSTRAINT vendorimportbatch_source_check CHECK (source = 'csv'),
    ADD CONSTRAINT vendorimportbatch_filename_length CHECK (char_length(filename) <= 120),
    ADD CONSTRAINT vendorimportbatch_size_nonneg CHECK ("sizeBytes" >= 0)`);
  await knex.raw(`CREATE UNIQUE INDEX vendorimportbatch_vendor_sha_live
    ON "VendorImportBatch" ("vendorId", "fileSha256") WHERE status IN ('mapping_required', 'ready', 'applying')`);
  await knex.raw('CREATE INDEX vendorimportbatch_vendor_created_desc_idx ON "VendorImportBatch" ("vendorId", "createdAt" DESC, id DESC)');

  await knex.schema.createTable('VendorImportRow', (table) => {
    table.text('id').primary();
    table.text('batchId').notNullable().references('id').inTable('VendorImportBatch').onDelete('CASCADE');
    table.text('vendorId').notNullable();
    table.integer('rowNo').notNullable();
    table.text('entity').notNullable();
    table.jsonb('raw').notNullable().defaultTo('{}');
    table.jsonb('normalized').notNullable().defaultTo('{}');
    table.text('status').notNullable().defaultTo('needs_review');
    table.jsonb('issues').notNullable().defaultTo('[]');
    table.text('applyState').notNullable().defaultTo('pending');
    table.text('resultId');
    table.timestamp('appliedAt', { precision: 3 });
    table.integer('attempts').notNullable().defaultTo(0);
    table.text('lastError');
    table.unique(['batchId', 'rowNo']);
    table.index(['batchId', 'status', 'rowNo'], 'vendorimportrow_batch_status_idx');
    table.index(['vendorId']);
  });
  await knex.raw(`ALTER TABLE "VendorImportRow"
    ADD CONSTRAINT vendorimportrow_status_check CHECK (status IN (${list(ROW_STATUSES)})),
    ADD CONSTRAINT vendorimportrow_apply_state_check CHECK ("applyState" IN (${list(APPLY_STATES)})),
    ADD CONSTRAINT vendorimportrow_entity_check CHECK (entity IN (${list(ENTITIES)}))`);

  await exports.addImportPermission(knex);
};

/**
 * Permission `import` for the vendor's admin staff (vendorRole admin): User row, vendor OrgMembership and pending
 * vendor invitations. Safe to repeat.
 * @param {import('knex').Knex} knex
 */
exports.addImportPermission = async function addImportPermission(knex) {
  const users = await knex.raw(`UPDATE "User" SET "vendorPermissions" = array_append(COALESCE("vendorPermissions", '{}'), 'import')
    WHERE "userType" = 'vendor_staff' AND "vendorRole" = 'admin'
      AND NOT ('import' = ANY(COALESCE("vendorPermissions", '{}'))) RETURNING id`);
  const memberships = await knex.raw(`UPDATE "OrgMembership" m SET "aclPermissions" = array_append(m."aclPermissions", 'import'), "updatedAt" = now()
    FROM "User" u WHERE m."orgType" = 'vendor' AND m.role = 'staff' AND m."personaId" = u.id
      AND u."userType" = 'vendor_staff' AND u."vendorRole" = 'admin'
      AND NOT ('import' = ANY(m."aclPermissions")) RETURNING m.id`);
  const invitations = await knex.raw(`UPDATE "Invitation" SET "aclPermissions" = array_append("aclPermissions", 'import'), "updatedAt" = now()
    WHERE "orgType" = 'vendor' AND status = 'pending' AND payload->>'vendorRole' = 'admin'
      AND NOT ('import' = ANY("aclPermissions")) RETURNING id`);
  console.log(`[migrate] vendor import: permission 'import' added to ${users.rows.length} staff, ${memberships.rows.length} membership(s), ${invitations.rows.length} pending invitation(s)`);
  return { users: users.rows.length, memberships: memberships.rows.length, invitations: invitations.rows.length };
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`UPDATE "Invitation" SET "aclPermissions" = array_remove("aclPermissions", 'import') WHERE "orgType" = 'vendor' AND 'import' = ANY("aclPermissions")`);
  await knex.raw(`UPDATE "OrgMembership" SET "aclPermissions" = array_remove("aclPermissions", 'import') WHERE "orgType" = 'vendor' AND 'import' = ANY("aclPermissions")`);
  await knex.raw(`UPDATE "User" SET "vendorPermissions" = array_remove("vendorPermissions", 'import') WHERE "userType" = 'vendor_staff' AND 'import' = ANY(COALESCE("vendorPermissions", '{}'))`);
  const batches = (await knex.raw('SELECT count(*)::int AS n FROM "VendorImportBatch"')).rows[0].n;
  if (batches) console.warn(`[migrate] dropping ${batches} import batch(es); the products they created stay`);
  await knex.schema.dropTableIfExists('VendorImportRow');
  await knex.schema.dropTableIfExists('VendorImportBatch');
};
