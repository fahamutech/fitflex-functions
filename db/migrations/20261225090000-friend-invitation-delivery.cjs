// When FitFlex itself sent a friend invitation by SMS / WhatsApp (flags
// FRIEND_INVITE_SMS / FRIEND_INVITE_WHATSAPP). Used for the resend wait and
// the daily cap; "sent" means the provider accepted it, not that it arrived.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('FriendInvitation', 'sentAt'))) {
    await knex.schema.alterTable('FriendInvitation', (t) => {
      t.timestamp('sentAt', { precision: 3 });
      t.text('sentVia');
      t.index(['inviterId', 'sentAt']);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('FriendInvitation', 'sentAt')) {
    await knex.schema.alterTable('FriendInvitation', (t) => {
      t.dropIndex(['inviterId', 'sentAt']);
      t.dropColumn('sentAt');
      t.dropColumn('sentVia');
    });
  }
};
