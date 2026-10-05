// Identity V2 · account recovery — someone who has lost every verified number
// and email AND forgot the PIN (design confirmed 5 Oct 2026).
//
//   AccountRecovery        one request to move an account to a new number or
//                          email. The new value is proved with a code when the
//                          request is made. The request waits (24 hours for a
//                          member) before a FitFlex admin can decide it, and
//                          the real owner can cancel it meanwhile.
//   AccountRecoveryEvent   append-only trail of what happened to a request.
//
// At most one open request per person. Additive; nothing reads these unless
// IDENTITY_V2 + V2_RECOVERY are on.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('AccountRecovery', t => {
    t.text('id').primary();
    t.text('personId').notNullable().references('id').inTable('Person').onDelete('RESTRICT');
    t.text('status').notNullable().defaultTo('open');        // open | cancelled | refused | completed
    t.text('tier').notNullable().defaultTo('member');        // the proof asked for (partners: later)
    t.text('oldIdentifierType').notNullable();
    t.text('oldIdentifierValue').notNullable();
    t.text('newIdentifierType').notNullable();
    t.text('newIdentifierValue').notNullable();
    t.text('claimedName');
    t.jsonb('evidence').notNullable().defaultTo('{}');
    t.timestamp('waitUntil', { useTz: true }).notNullable();
    t.text('cancelKeyHash');                                   // the key in the cancel link sent to the owner
    t.text('requestIp');
    t.text('cancelledBy');                                     // requester | owner_device | owner_link
    t.text('decidedBy');
    t.text('decisionReason');                                  // a code the person is shown
    t.text('decisionNote');                                    // private to FitFlex staff
    t.timestamp('decidedAt', { useTz: true });
    t.timestamp('completedAt', { useTz: true });
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['personId', 'status']);
    t.index(['status', 'createdAt']);
  });
  await knex.raw(`ALTER TABLE "AccountRecovery"
    ADD CONSTRAINT account_recovery_status_check CHECK (status IN ('open', 'cancelled', 'refused', 'completed'))`);
  await knex.raw(`CREATE UNIQUE INDEX account_recovery_one_open ON "AccountRecovery" ("personId") WHERE status = 'open'`);

  await knex.schema.createTable('AccountRecoveryEvent', t => {
    t.text('id').primary();
    t.text('recoveryId').notNullable().references('id').inTable('AccountRecovery').onDelete('RESTRICT');
    t.text('kind').notNullable();
    t.text('actor');
    t.jsonb('detail');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['recoveryId', 'createdAt']);
  });
  await knex.raw(`CREATE OR REPLACE FUNCTION account_recovery_event_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'AccountRecoveryEvent rows are append-only' USING ERRCODE = 'P0001';
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw('DROP TRIGGER IF EXISTS account_recovery_event_no_change ON "AccountRecoveryEvent"');
  await knex.raw(`CREATE TRIGGER account_recovery_event_no_change
    BEFORE UPDATE OR DELETE ON "AccountRecoveryEvent"
    FOR EACH ROW EXECUTE FUNCTION account_recovery_event_immutable()`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS account_recovery_event_no_change ON "AccountRecoveryEvent"');
  await knex.schema.dropTableIfExists('AccountRecoveryEvent');
  await knex.raw('DROP FUNCTION IF EXISTS account_recovery_event_immutable()');
  await knex.schema.dropTableIfExists('AccountRecovery');
};
