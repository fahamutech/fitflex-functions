// WhatsApp delivery (M7): what the dispatcher needs to send a queued
// WhatsApp message through the provider, and the admin kill switch.
// - CommunicationMessage.payload: for WhatsApp rows, the provider template
//   to use and its parameters, worked out when the campaign is sent:
//   { templateName, language, parameters: [..] }.
// - PlatformSettings.communications: FitFlex-wide communication settings,
//   e.g. { whatsappEnabled: false } to stop all WhatsApp sending at once.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('CommunicationMessage', 'payload'))) {
    await knex.schema.alterTable('CommunicationMessage', (t) => t.jsonb('payload'));
  }
  if (!(await knex.schema.hasColumn('PlatformSettings', 'communications'))) {
    await knex.schema.alterTable('PlatformSettings', (t) => t.jsonb('communications'));
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS whatsapp_template_lookup_idx
    ON "WhatsAppTemplate" ("provider", "providerTemplateName", "approvalStatus")`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS whatsapp_template_lookup_idx');
  if (await knex.schema.hasColumn('PlatformSettings', 'communications')) {
    await knex.schema.alterTable('PlatformSettings', (t) => t.dropColumn('communications'));
  }
  if (await knex.schema.hasColumn('CommunicationMessage', 'payload')) {
    await knex.schema.alterTable('CommunicationMessage', (t) => t.dropColumn('payload'));
  }
};
