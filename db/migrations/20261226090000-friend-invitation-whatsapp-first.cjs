// WhatsApp first, SMS if the number has no WhatsApp. WhatsApp accepts a
// message for any number and only reports later that it could not be
// delivered, so the provider's message id is kept and a job checks it:
// waState is 'pending' (waiting to hear), 'delivered', 'failed' (SMS sent
// instead) or 'unknown' (no answer within a day; nothing more is done).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('FriendInvitation', 'waMessageId'))) {
    await knex.schema.alterTable('FriendInvitation', (t) => {
      t.text('waMessageId');
      t.text('waState');
      t.index('waState');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('FriendInvitation', 'waMessageId')) {
    await knex.schema.alterTable('FriendInvitation', (t) => {
      t.dropIndex('waState');
      t.dropColumn('waMessageId');
      t.dropColumn('waState');
    });
  }
};
