// Consent slice (a), owner decision 22 Oct 2026 (re-confirmed 29 Oct): a
// member must also accept before an organisation adds them by a VERIFIED email
// or mobile number, by bulk import, or when an invite matches them.
//
//   B2BMemberRequest
//     contactType / contactValue  the email or number the organisation typed
//                                 (normalised). Set for adds by contact and
//                                 for invite matches.
//     source        user_id | contact | invite   how the person was named
//     inviteId      the B2BBeneficiaryInvite that matched (source invite)
//     userId        now NULLABLE: an add by contact that names nobody who can
//                   be asked (no verified member, or one who may not be asked
//                   again yet) is stored with no member, so the organisation
//                   sees the same pending entry either way and nobody is told.
//                   It simply expires.
//   The "one open request per member" index now covers adds by user id only;
//   adds by contact are one open request per contact, invite matches one per
//   invite.
//
//   B2BBeneficiaryInvite.memberRequestId  the request a match made (never
//                   shown to the organisation).
//
// Additive. Down drops the new columns and indexes, deletes the rows that have
// no member (they never reached anyone) and restores NOT NULL and the old index.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const has = col => knex.schema.hasColumn('B2BMemberRequest', col);
  if (!(await has('source'))) {
    await knex.schema.alterTable('B2BMemberRequest', (t) => {
      t.text('source').notNullable().defaultTo('user_id');
      t.text('contactType');
      t.text('contactValue');
      t.text('inviteId');
    });
    await knex.raw('ALTER TABLE "B2BMemberRequest" ALTER COLUMN "userId" DROP NOT NULL');
    await knex.raw(`ALTER TABLE "B2BMemberRequest" ADD CONSTRAINT b2b_member_request_source_chk CHECK ("source" IN ('user_id', 'contact', 'invite'))`);
    await knex.raw(`ALTER TABLE "B2BMemberRequest" ADD CONSTRAINT b2b_member_request_user_chk CHECK ("userId" IS NOT NULL OR "source" = 'contact')`);
    await knex.raw('DROP INDEX IF EXISTS b2b_member_request_open_uq');
    await knex.raw(`CREATE UNIQUE INDEX b2b_member_request_open_uq ON "B2BMemberRequest" ("kind", "scopeId", "userId") WHERE "status" = 'pending' AND "source" = 'user_id'`);
    await knex.raw(`CREATE UNIQUE INDEX b2b_member_request_contact_uq ON "B2BMemberRequest" ("kind", "scopeId", "contactType", "contactValue", COALESCE("employeeId", '')) WHERE "status" = 'pending' AND "source" = 'contact'`);
    await knex.raw(`CREATE UNIQUE INDEX b2b_member_request_invite_uq ON "B2BMemberRequest" ("inviteId") WHERE "status" = 'pending' AND "source" = 'invite'`);
    await knex.raw('CREATE INDEX b2b_member_request_contact_idx ON "B2BMemberRequest" ("scopeId", "kind", "contactType", "contactValue")');
  }
  if (!(await knex.schema.hasColumn('B2BBeneficiaryInvite', 'memberRequestId'))) {
    await knex.schema.alterTable('B2BBeneficiaryInvite', (t) => { t.text('memberRequestId'); });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('B2BBeneficiaryInvite', 'memberRequestId')) {
    await knex.schema.alterTable('B2BBeneficiaryInvite', (t) => { t.dropColumn('memberRequestId'); });
  }
  if (await knex.schema.hasColumn('B2BMemberRequest', 'source')) {
    await knex.raw('DROP INDEX IF EXISTS b2b_member_request_contact_idx');
    await knex.raw('DROP INDEX IF EXISTS b2b_member_request_invite_uq');
    await knex.raw('DROP INDEX IF EXISTS b2b_member_request_contact_uq');
    await knex.raw('DROP INDEX IF EXISTS b2b_member_request_open_uq');
    await knex.raw('ALTER TABLE "B2BMemberRequest" DROP CONSTRAINT IF EXISTS b2b_member_request_user_chk');
    await knex.raw('ALTER TABLE "B2BMemberRequest" DROP CONSTRAINT IF EXISTS b2b_member_request_source_chk');
    await knex('B2BMemberRequest').whereNull('userId').del();
    // Two open requests for one member (one by id, one by contact) cannot both stay open under the old index.
    await knex.raw(`UPDATE "B2BMemberRequest" r SET "status" = 'cancelled', "reason" = 'migration_rollback', "decidedAt" = now(), "updatedAt" = now()
      WHERE r."status" = 'pending' AND r."source" <> 'user_id' AND EXISTS (
        SELECT 1 FROM "B2BMemberRequest" o WHERE o."status" = 'pending' AND o."id" <> r."id" AND o."kind" = r."kind" AND o."scopeId" = r."scopeId" AND o."userId" = r."userId"
          AND (o."source" = 'user_id' OR o."createdAt" < r."createdAt" OR (o."createdAt" = r."createdAt" AND o."id" < r."id")))`);
    await knex.raw('ALTER TABLE "B2BMemberRequest" ALTER COLUMN "userId" SET NOT NULL');
    await knex.raw(`CREATE UNIQUE INDEX b2b_member_request_open_uq ON "B2BMemberRequest" ("kind", "scopeId", "userId") WHERE "status" = 'pending'`);
    await knex.schema.alterTable('B2BMemberRequest', (t) => {
      t.dropColumn('inviteId');
      t.dropColumn('contactValue');
      t.dropColumn('contactType');
      t.dropColumn('source');
    });
  }
};
