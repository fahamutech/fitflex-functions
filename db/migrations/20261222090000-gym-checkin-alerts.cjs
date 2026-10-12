// Gym owners and staff can switch off the notification sent each time a
// member checks in. Null means on, which is how everyone starts.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('CommunicationPreference', 'gymCheckinAlerts'))) {
    await knex.schema.alterTable('CommunicationPreference', (t) => {
      t.boolean('gymCheckinAlerts');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('CommunicationPreference', 'gymCheckinAlerts')) {
    await knex.schema.alterTable('CommunicationPreference', (t) => t.dropColumn('gymCheckinAlerts'));
  }
};
