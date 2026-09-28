// Trainer enquiries become two-way conversations: the trainer can reply and
// close, the member can follow up. `message` stays as the first message for
// older clients; the thread lives in `messages` [{ id, from, text, at }].

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const cols = {
    messages: (t) => t.jsonb('messages').notNullable().defaultTo('[]'),
    lastMessageAt: (t) => t.timestamp('lastMessageAt', { precision: 3 }),
    lastMessageFrom: (t) => t.text('lastMessageFrom'), // member | trainer
    trainerReadAt: (t) => t.timestamp('trainerReadAt', { precision: 3 }),
    memberReadAt: (t) => t.timestamp('memberReadAt', { precision: 3 }),
    updatedAt: (t) => t.timestamp('updatedAt', { precision: 3 }),
  };
  for (const [name, add] of Object.entries(cols)) {
    if (!(await knex.schema.hasColumn('TrainerEngagement', name))) {
      await knex.schema.alterTable('TrainerEngagement', add);
    }
  }
  // Older enquiries: their single message is from the member.
  await knex('TrainerEngagement')
    .whereNull('lastMessageAt')
    .update({ lastMessageAt: knex.ref('createdAt'), lastMessageFrom: 'member', updatedAt: knex.ref('createdAt') });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const name of ['messages', 'lastMessageAt', 'lastMessageFrom', 'trainerReadAt', 'memberReadAt', 'updatedAt']) {
    if (await knex.schema.hasColumn('TrainerEngagement', name)) {
      await knex.schema.alterTable('TrainerEngagement', (t) => t.dropColumn(name));
    }
  }
};
