// Custom gym passes · security-review fixes (PR #355). Additive and reversible; extends 20270210090000-gym-custom-passes.
//
// GymPassBeneficiary
//   suspendedByRole  who suspended the person (owner | buyer | admin): a buyer may resume only what a buyer suspended.
//   contactHash      sha256("<type>:<normalised value>"). Lets limits, blocks and duplicate checks work after the plain
//                    contact is gone. contactValue is now kept ONLY while a person is pending_registration; it is nulled
//                    on claim / activation / removal / account erasure. (A hash of a phone number is still personal data:
//                    the erasure step nulls it too.)
//   contactMask      the masked contact ("+255•••••678") shown to buyer / owner once contactValue is gone.
//   addedBy / addedByRole  who attached the person (user id; role buyer | owner | checkout): the per-actor hourly caps count
//                      buyer / owner adds made after checkout.
//   sendCount        SMS / WhatsApp sends made for this person (capped per purchase).
// GymPassContactBlock  a person who LEFT a purchase cannot be re-attached to it, or to any purchase by the same buyer,
//                      without the person's own later action (there is no unblock route in this version).
//
// Down: drops what this migration added (the earlier migration's own down still refuses while purchases exist).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.alterTable('GymPassBeneficiary', (t) => {
    t.text('suspendedByRole');
    t.text('contactHash');
    t.text('contactMask');
    t.text('addedBy');
    t.text('addedByRole');
    t.integer('sendCount').notNullable().defaultTo(0);
  });
  await knex.raw(`ALTER TABLE "GymPassBeneficiary"
    ADD CONSTRAINT gympassbeneficiary_suspended_by_chk CHECK ("suspendedByRole" IS NULL OR "suspendedByRole" IN ('owner', 'buyer', 'admin'))`);
  // Rows written before this migration keep working: hash what is there.
  await knex.raw(`UPDATE "GymPassBeneficiary"
    SET "contactHash" = encode(sha256(convert_to("contactType" || ':' || "contactValue", 'UTF8')), 'hex')
    WHERE "contactValue" IS NOT NULL AND "contactHash" IS NULL`);
  await knex.raw(`CREATE UNIQUE INDEX gympassbeneficiary_hash_unique ON "GymPassBeneficiary" ("purchaseId", "contactHash") WHERE "contactHash" IS NOT NULL AND "status" <> 'removed'`);
  await knex.raw('CREATE INDEX gympassbeneficiary_hash_created_idx ON "GymPassBeneficiary" ("contactHash", "createdAt") WHERE "contactHash" IS NOT NULL');
  await knex.raw('CREATE INDEX gympassbeneficiary_added_by_idx ON "GymPassBeneficiary" ("addedBy", "createdAt") WHERE "addedBy" IS NOT NULL');

  await knex.schema.createTable('GymPassContactBlock', (t) => {
    t.text('id').primary();
    t.text('buyerId').notNullable();
    t.text('contactHash');
    t.text('userId');
    t.text('purchaseId');
    t.text('reason').notNullable().defaultTo('left');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE "GymPassContactBlock" ADD CONSTRAINT gympasscontactblock_reason_chk CHECK ("reason" IN ('left'))`);
  await knex.raw('CREATE UNIQUE INDEX gympasscontactblock_buyer_hash_unique ON "GymPassContactBlock" ("buyerId", "contactHash") WHERE "contactHash" IS NOT NULL');
  await knex.raw('CREATE INDEX gympasscontactblock_buyer_user_idx ON "GymPassContactBlock" ("buyerId", "userId") WHERE "userId" IS NOT NULL');
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('GymPassContactBlock');
  await knex.raw('DROP INDEX IF EXISTS gympassbeneficiary_added_by_idx');
  await knex.raw('DROP INDEX IF EXISTS gympassbeneficiary_hash_created_idx');
  await knex.raw('DROP INDEX IF EXISTS gympassbeneficiary_hash_unique');
  await knex.raw('ALTER TABLE "GymPassBeneficiary" DROP CONSTRAINT IF EXISTS gympassbeneficiary_suspended_by_chk');
  await knex.schema.alterTable('GymPassBeneficiary', (t) => {
    t.dropColumn('suspendedByRole');
    t.dropColumn('contactHash');
    t.dropColumn('contactMask');
    t.dropColumn('addedBy');
    t.dropColumn('addedByRole');
    t.dropColumn('sendCount');
  });
};
