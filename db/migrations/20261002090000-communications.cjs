// Communications — the data foundation for gym and FitFlex (platform)
// messages to members: campaigns, a per-recipient delivery ledger,
// templates, member preferences and lifecycle automations.
//
// - CommunicationCampaign: one send (now or scheduled) from a gym, or from
//   FitFlex itself (senderType 'platform', gymId null). Gyms reach only
//   their direct members; that rule lives in the segment service.
// - CommunicationMessage: one row per recipient per channel. It is the
//   delivery ledger and the send queue. The unique keys stop a retried job
//   or a double-tapped Send from messaging anyone twice.
// - Notification (existing inbox) gains optional links back to the gym and
//   campaign, a category and a clickedAt.
// - CommunicationTemplate: FitFlex message templates (system or per gym),
//   with English and Swahili bodies. WhatsAppTemplate is the separate
//   registry of provider-approved WhatsApp templates; a FitFlex template
//   goes out on WhatsApp only when it maps to an approved one.
// - CommunicationPreference: per member, keyed by the member's user id.
//   Transactional in-app and push have no switch. WhatsApp marketing is
//   opt-in and records when and how consent was given.
// - CommunicationAutomation / AutomationRun: lifecycle triggers, and one
//   run row per (automation, member, occurrence) so a trigger fires once.
// - JobRun: start/finish/stats for scheduled jobs, for observability.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });
  const stamps = (t) => {
    ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
    ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
  };
  const ref = (t, col, table, { onDelete = 'CASCADE', required = false } = {}) => {
    const c = t.text(col);
    if (required) c.notNullable();
    c.references('id').inTable(table).onDelete(onDelete).onUpdate('CASCADE');
  };
  const table = async (name, build) => {
    if (!(await knex.schema.hasTable(name))) await knex.schema.createTable(name, build);
  };
  const arrayDefault = knex.raw("'{}'::text[]");

  await table('WhatsAppTemplate', (t) => {
    t.text('id').primary();
    t.text('provider').notNullable();
    t.text('providerTemplateName').notNullable();
    t.text('language').notNullable();
    // utility | marketing | authentication (WhatsApp's own categories)
    t.text('category').notNullable();
    t.specificType('variables', 'TEXT[]').notNullable().defaultTo(arrayDefault);
    // pending | approved | rejected | paused
    t.text('approvalStatus').notNullable().defaultTo('pending');
    ts(t, 'lastSyncedAt');
    stamps(t);
    t.unique(['provider', 'providerTemplateName', 'language']);
  });

  await table('CommunicationTemplate', (t) => {
    t.text('id').primary();
    ref(t, 'gymId', 'Gym'); // null = FitFlex system template
    t.text('key').notNullable();
    t.text('name').notNullable();
    t.text('category').notNullable();
    t.text('purpose').notNullable();
    t.specificType('channels', 'TEXT[]').notNullable().defaultTo(arrayDefault);
    // { en: { title, body }, sw: { title, body } }
    t.jsonb('bodies').notNullable();
    t.specificType('variables', 'TEXT[]').notNullable().defaultTo(arrayDefault);
    ref(t, 'whatsappTemplateId', 'WhatsAppTemplate', { onDelete: 'SET NULL' });
    t.text('status').notNullable().defaultTo('active'); // active | archived
    ref(t, 'createdBy', 'User', { onDelete: 'SET NULL' });
    stamps(t);
    t.unique(['gymId', 'key']);
  });

  await table('CommunicationCampaign', (t) => {
    t.text('id').primary();
    t.text('senderType').notNullable(); // gym | platform
    ref(t, 'gymId', 'Gym');
    t.text('name').notNullable();
    t.text('purpose').notNullable();
    t.text('category').notNullable(); // transactional | marketing
    t.text('status').notNullable().defaultTo('draft');
    t.jsonb('audience');
    t.jsonb('content');
    t.specificType('channels', 'TEXT[]').notNullable().defaultTo(arrayDefault);
    ref(t, 'templateId', 'CommunicationTemplate', { onDelete: 'SET NULL' });
    ts(t, 'scheduledAt');
    // Client-generated key for the Send action: a second tap replays it.
    t.text('sendRequestId').unique();
    t.jsonb('counts');
    ref(t, 'createdBy', 'User', { onDelete: 'SET NULL' });
    ts(t, 'sentAt');
    ts(t, 'cancelledAt');
    stamps(t);
    t.index(['gymId', 'createdAt']);
    t.index(['status', 'scheduledAt']);
  });

  await table('CommunicationAutomation', (t) => {
    t.text('id').primary();
    t.text('senderType').notNullable();
    ref(t, 'gymId', 'Gym');
    t.text('name').notNullable();
    t.text('trigger').notNullable();
    // Days before (+) or after (-) the trigger date; 0 when not relevant.
    t.integer('offsetDays').notNullable().defaultTo(0);
    t.jsonb('conditions');
    ref(t, 'templateId', 'CommunicationTemplate', { onDelete: 'SET NULL' });
    t.specificType('channels', 'TEXT[]').notNullable().defaultTo(arrayDefault);
    t.text('status').notNullable().defaultTo('disabled'); // enabled | disabled
    ref(t, 'createdBy', 'User', { onDelete: 'SET NULL' });
    stamps(t);
    t.unique(['gymId', 'trigger', 'offsetDays']);
  });

  await table('AutomationRun', (t) => {
    t.text('id').primary();
    ref(t, 'automationId', 'CommunicationAutomation', { required: true });
    ref(t, 'gymId', 'Gym');
    ref(t, 'memberId', 'User', { required: true });
    // What this firing is about, e.g. "sub_123:T-7" or "inactive:2026-10-01".
    t.text('occurrenceKey').notNullable();
    t.text('status').notNullable().defaultTo('queued');
    ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
    t.unique(['automationId', 'memberId', 'occurrenceKey']);
  });

  await table('CommunicationMessage', (t) => {
    t.text('id').primary();
    ref(t, 'campaignId', 'CommunicationCampaign');
    ref(t, 'automationRunId', 'AutomationRun');
    t.text('senderType').notNullable();
    ref(t, 'gymId', 'Gym');
    ref(t, 'memberId', 'User', { required: true });
    t.text('channel').notNullable(); // in_app | push | whatsapp
    t.text('category').notNullable();
    t.text('messageType'); // template key or campaign purpose
    t.text('title');
    t.text('body');
    t.text('locale');
    t.text('deepLink');
    ref(t, 'notificationId', 'Notification', { onDelete: 'SET NULL' });
    t.text('status').notNullable().defaultTo('queued');
    t.text('skipReason');
    t.text('providerMessageId');
    t.integer('attempts').notNullable().defaultTo(0);
    ts(t, 'nextAttemptAt');
    ts(t, 'sentAt');
    ts(t, 'deliveredAt');
    ts(t, 'openedAt');
    ts(t, 'clickedAt');
    ts(t, 'failedAt');
    t.text('failureReason');
    t.boolean('failurePermanent').notNullable().defaultTo(false);
    stamps(t);
    // NULLs are distinct in Postgres, so each key only binds its own source.
    t.unique(['campaignId', 'memberId', 'channel']);
    t.unique(['automationRunId', 'channel']);
    t.index(['status', 'nextAttemptAt']);
    t.index(['gymId', 'memberId', 'createdAt']);
    t.index(['memberId', 'createdAt']);
    t.index(['campaignId', 'status']);
    t.index('providerMessageId');
  });

  await table('CommunicationPreference', (t) => {
    // The member's user id — one row per member, absent = defaults.
    t.text('id').primary().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
    t.boolean('inAppMarketing').notNullable().defaultTo(true);
    t.boolean('pushMarketing').notNullable().defaultTo(true);
    t.boolean('whatsappTransactional').notNullable().defaultTo(true);
    t.boolean('whatsappMarketing').notNullable().defaultTo(false);
    ts(t, 'whatsappMarketingConsentAt');
    t.text('whatsappMarketingConsentSource');
    ts(t, 'whatsappOptedOutAt');
    t.text('locale'); // en | sw
    stamps(t);
  });

  await table('JobRun', (t) => {
    t.text('id').primary();
    t.text('job').notNullable();
    t.text('status').notNullable().defaultTo('running'); // running | ok | failed
    ts(t, 'startedAt').notNullable().defaultTo(knex.fn.now());
    ts(t, 'finishedAt');
    t.jsonb('stats');
    t.text('error');
    t.index(['job', 'startedAt']);
  });

  // Invariants the application also enforces; the database is the backstop.
  const checks = [
    ['CommunicationCampaign', 'communication_campaign_sender_chk',
      `("senderType" = 'gym' AND "gymId" IS NOT NULL) OR ("senderType" = 'platform' AND "gymId" IS NULL)`],
    ['CommunicationAutomation', 'communication_automation_sender_chk',
      `("senderType" = 'gym' AND "gymId" IS NOT NULL) OR ("senderType" = 'platform' AND "gymId" IS NULL)`],
    ['CommunicationMessage', 'communication_message_sender_chk',
      `("senderType" = 'gym' AND "gymId" IS NOT NULL) OR ("senderType" = 'platform' AND "gymId" IS NULL)`],
    ['CommunicationCampaign', 'communication_campaign_category_chk', `"category" IN ('transactional', 'marketing')`],
    ['CommunicationMessage', 'communication_message_category_chk', `"category" IN ('transactional', 'marketing')`],
    ['CommunicationMessage', 'communication_message_channel_chk', `"channel" IN ('in_app', 'push', 'whatsapp')`],
  ];
  for (const [tbl, name, expr] of checks) {
    await knex.raw(`ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??`, [tbl, name]);
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${expr})`, [tbl, name]);
  }

  // System rows have gymId NULL, which the plain unique keys don't cover.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS communication_template_system_key_uq
    ON "CommunicationTemplate" ("key") WHERE "gymId" IS NULL`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS communication_automation_platform_uq
    ON "CommunicationAutomation" ("trigger", "offsetDays") WHERE "gymId" IS NULL`);

  // Inbox rows can now say which gym / campaign they came from.
  const notificationColumns = {
    category: (t) => t.text('category'),
    gymId: (t) => ref(t, 'gymId', 'Gym', { onDelete: 'SET NULL' }),
    campaignId: (t) => ref(t, 'campaignId', 'CommunicationCampaign', { onDelete: 'SET NULL' }),
    clickedAt: (t) => ts(t, 'clickedAt'),
  };
  for (const [col, add] of Object.entries(notificationColumns)) {
    if (!(await knex.schema.hasColumn('Notification', col))) {
      await knex.schema.alterTable('Notification', add);
    }
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const col of ['clickedAt', 'campaignId', 'gymId', 'category']) {
    if (await knex.schema.hasColumn('Notification', col)) {
      await knex.schema.alterTable('Notification', (t) => t.dropColumn(col));
    }
  }
  for (const name of [
    'JobRun', 'CommunicationPreference', 'CommunicationMessage', 'AutomationRun',
    'CommunicationAutomation', 'CommunicationCampaign', 'CommunicationTemplate', 'WhatsAppTemplate',
  ]) {
    await knex.schema.dropTableIfExists(name);
  }
};
