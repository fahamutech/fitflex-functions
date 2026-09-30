// Identity V2 · I2 — verified sign-in linking and persona-aware sessions.
//
//   IdentityEvent        append-only audit of every link / merge, holding the
//                        previous personId of each moved row so any link can
//                        be reversed without touching history tables
//   Person.lastPersonaId the persona restored at the next sign-in
//
// Additive; nothing reads these unless V2_LINKING / V2_PERSONAS are on.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('IdentityEvent', t => {
    t.text('id').primary();
    t.text('kind').notNullable();                 // link | merge
    t.text('personId').notNullable().references('id').inTable('Person').onDelete('RESTRICT');
    t.text('fromPersonId').references('id').inTable('Person').onDelete('RESTRICT');
    t.specificType('userIds', 'text[]').notNullable().defaultTo('{}');
    t.text('identifierType');                     // the verified evidence used
    t.text('normalizedValue');
    t.text('trigger').notNullable();              // e.g. firebase_session
    t.text('actorUserId');
    t.jsonb('details');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['personId']);
    t.index(['fromPersonId']);
  });
  await knex.raw(`ALTER TABLE "IdentityEvent"
    ADD CONSTRAINT identity_event_kind_check CHECK (kind IN ('link', 'merge'))`);
  await knex.raw(`CREATE OR REPLACE FUNCTION identity_event_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'IdentityEvent rows are append-only' USING ERRCODE = 'P0001';
    END;
  $$ LANGUAGE plpgsql`);
  await knex.raw('DROP TRIGGER IF EXISTS identity_event_no_change ON "IdentityEvent"');
  await knex.raw(`CREATE TRIGGER identity_event_no_change
    BEFORE UPDATE OR DELETE ON "IdentityEvent"
    FOR EACH ROW EXECUTE FUNCTION identity_event_immutable()`);

  await knex.schema.alterTable('Person', t => {
    t.text('lastPersonaId').references('id').inTable('User').onDelete('SET NULL');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('Person', t => {
    t.dropForeign(['lastPersonaId']);
    t.dropColumn('lastPersonaId');
  });
  await knex.raw('DROP TRIGGER IF EXISTS identity_event_no_change ON "IdentityEvent"');
  await knex.raw('DROP FUNCTION IF EXISTS identity_event_immutable()');
  await knex.schema.dropTableIfExists('IdentityEvent');
};
