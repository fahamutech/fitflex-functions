// Friend invitations (Friends & Groups → People).
//
// One row is one person asking another to connect. It is either aimed at an
// existing member (recipientUserId set; the request shows in their
// Notifications with Approve / Reject) or at someone not on FitFlex yet
// (identifierType + identifierValue set, and a token hash for the share
// link). The friendship — a follow each way — is only created on Approve.
//
// status: pending | accepted | rejected | expired | revoked
//
// Creating a row is not the same as delivering a message: FitFlex sends
// nothing outside the app; the inviter shares the link themselves.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('FriendInvitation')) return;
  await knex.schema.createTable('FriendInvitation', (t) => {
    t.text('id').primary();
    t.text('inviterId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('recipientUserId').references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
    // email | phone, normalised; only for invitations to someone not (yet) attached to a member.
    t.text('identifierType');
    t.text('identifierValue');
    t.text('tokenHash').unique();
    t.text('status').notNullable().defaultTo('pending');
    t.text('notificationId');
    t.timestamp('expiresAt', { precision: 3 }).notNullable();
    t.timestamp('respondedAt', { precision: 3 });
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.index('recipientUserId');
    t.index('inviterId');
    t.index(['identifierType', 'identifierValue']);
  });
  // At most one open invitation per inviter and target.
  await knex.raw(`CREATE UNIQUE INDEX "FriendInvitation_open_member" ON "FriendInvitation" ("inviterId", "recipientUserId") WHERE "status" = 'pending' AND "recipientUserId" IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX "FriendInvitation_open_contact" ON "FriendInvitation" ("inviterId", "identifierType", "identifierValue") WHERE "status" = 'pending' AND "recipientUserId" IS NULL AND "identifierValue" IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('FriendInvitation');
};
