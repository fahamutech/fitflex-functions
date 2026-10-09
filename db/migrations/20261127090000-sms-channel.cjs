// SMS, moved from the Supabase edge functions into this backend.
// - SmsLog: one row per SMS FitFlex tried to send — who to, what kind, what
//   the provider said. `dedupeKey` (unique) is what makes a reminder go out
//   once however often its job runs.
// - CommunicationPreference: a member's SMS choices. Service messages by SMS
//   are on unless switched off; offers are opt-in, with when and where the
//   member agreed.
// - CommunicationMessage.channel may now be 'sms'.

const CHANNEL_CHECK = 'communication_message_channel_chk';

const preferenceColumns = {
  smsTransactional: (t) => t.boolean('smsTransactional').notNullable().defaultTo(true),
  smsMarketing: (t) => t.boolean('smsMarketing').notNullable().defaultTo(false),
  smsMarketingConsentAt: (t) => t.timestamp('smsMarketingConsentAt', { precision: 3 }),
  smsMarketingConsentSource: (t) => t.text('smsMarketingConsentSource'),
  smsOptedOutAt: (t) => t.timestamp('smsOptedOutAt', { precision: 3 }),
};

async function setChannelCheck(knex, channels) {
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', ['CommunicationMessage', CHANNEL_CHECK]);
  await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK ("channel" IN (${channels.map(c => `'${c}'`).join(', ')}))`,
    ['CommunicationMessage', CHANNEL_CHECK]);
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('SmsLog'))) {
    await knex.schema.createTable('SmsLog', (t) => {
      t.text('id').primary();
      t.text('userId').references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
      t.text('phone').notNullable(); // E.164
      t.text('category').notNullable(); // otp | reminder | campaign | test
      t.text('dedupeKey').unique();
      t.text('message').notNullable(); // verification codes are stored redacted
      t.text('status').notNullable().defaultTo('queued'); // queued | accepted | failed
      t.text('provider');
      t.text('providerMessageId');
      t.integer('providerCode');
      t.text('error');
      t.boolean('retryable').notNullable().defaultTo(false);
      t.integer('attempts').notNullable().defaultTo(1);
      t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      t.index('createdAt');
      t.index(['phone', 'createdAt']);
      t.index(['userId', 'createdAt']);
    });
  }
  for (const [col, add] of Object.entries(preferenceColumns)) {
    if (!(await knex.schema.hasColumn('CommunicationPreference', col))) {
      await knex.schema.alterTable('CommunicationPreference', add);
    }
  }
  await setChannelCheck(knex, ['in_app', 'push', 'whatsapp', 'sms']);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex('CommunicationMessage').where({ channel: 'sms' }).del();
  await setChannelCheck(knex, ['in_app', 'push', 'whatsapp']);
  for (const col of Object.keys(preferenceColumns)) {
    if (await knex.schema.hasColumn('CommunicationPreference', col)) {
      await knex.schema.alterTable('CommunicationPreference', (t) => t.dropColumn(col));
    }
  }
  await knex.schema.dropTableIfExists('SmsLog');
};
