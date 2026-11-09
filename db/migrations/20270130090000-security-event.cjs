// Security events (S3): a record that a security-relevant thing happened to a member's account, so the member can
// review it later. First kind: 'web_checkin' (a gym check-in made from a web browser, not the app).
//
// Personal data kept is minimal on purpose: who, which visit and gym, when, and a gym-name snapshot. NO IP address,
// user agent, clientMeta, session id or intent id is stored here.
// Additive and idempotent (hasTable). One event per check-in: partial unique index on (kind, checkinId).
// Deleting the User cascades to its events. Down drops the table (it only holds derived alert records).

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('SecurityEvent'))) {
    await knex.schema.createTable('SecurityEvent', (t) => {
      t.text('id').primary();
      t.text('userId').notNullable().references('id').inTable('User').onDelete('CASCADE');
      t.text('kind').notNullable();
      t.text('checkinId');
      t.text('gymId');
      t.timestamp('occurredAt', { useTz: true }).notNullable();
      t.text('businessDate');
      t.text('channel');
      t.timestamp('notifiedAt', { useTz: true });
      t.text('notifyState').notNullable().defaultTo('none');
      t.jsonb('details');
      t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`ALTER TABLE "SecurityEvent" ADD CONSTRAINT security_event_kind_ck CHECK ("kind" IN ('web_checkin'))`);
    await knex.raw(`ALTER TABLE "SecurityEvent" ADD CONSTRAINT security_event_notify_state_ck CHECK ("notifyState" IN ('queued', 'none'))`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS security_event_user_time_idx ON "SecurityEvent" ("userId", "occurredAt" DESC)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS security_event_kind_checkin_uq ON "SecurityEvent" ("kind", "checkinId") WHERE "checkinId" IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS security_event_occurred_idx ON "SecurityEvent" ("occurredAt")`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('SecurityEvent');
};
