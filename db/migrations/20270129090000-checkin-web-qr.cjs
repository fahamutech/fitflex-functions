// Browser gym QR check-in (S2): a member scans the printed gym QR with the phone camera, the page opens in the
// browser, and a confirmed check-in is recorded exactly like the in-app scan, with a new source.
//
// Additive and idempotent:
//   - checkin_source_ck also allows 'web_gym_qr_by_member' (NULL stays allowed). The list below is a frozen copy of
//     CHECKIN_SOURCE_VALUES in src/shared/checkin-status.mjs; specs/checkin-source-migration.specs.mjs checks they agree.
//   - Checkin.authSessionId, clientMeta (jsonb), intentId: nullable, filled only by web check-ins.
//   - A partial unique index on intentId, so one preview/confirm intent records at most one visit.
// Down refuses while any web_gym_qr_by_member row exists (it would break the constraint and lose the audit trail).

const OLD_SOURCES = ['member_qr_by_staff', 'gym_qr_by_member', 'owner_manual', 'admin_backfill'];
const NEW_SOURCES = [...OLD_SOURCES, 'web_gym_qr_by_member'];
const list = (xs) => xs.map((x) => `'${x}'`).join(', ');
const COLUMNS = ['authSessionId', 'clientMeta', 'intentId'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const add = {
    authSessionId: (t) => t.text('authSessionId'),
    clientMeta: (t) => t.jsonb('clientMeta'),
    intentId: (t) => t.text('intentId'),
  };
  for (const name of COLUMNS) {
    if (!(await knex.schema.hasColumn('Checkin', name))) await knex.schema.alterTable('Checkin', add[name]);
  }
  await knex.raw(`ALTER TABLE "Checkin" DROP CONSTRAINT IF EXISTS checkin_source_ck`);
  await knex.raw(`ALTER TABLE "Checkin" ADD CONSTRAINT checkin_source_ck CHECK ("source" IS NULL OR "source" IN (${list(NEW_SOURCES)}))`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS checkin_intent_id_uq ON "Checkin" ("intentId") WHERE "intentId" IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM "Checkin" WHERE "source" = 'web_gym_qr_by_member'`);
  if (rows[0].n > 0) {
    throw new Error(`Cannot roll back: ${rows[0].n} check-in(s) have source web_gym_qr_by_member. Re-source or remove them first.`);
  }
  await knex.raw(`DROP INDEX IF EXISTS checkin_intent_id_uq`);
  await knex.raw(`ALTER TABLE "Checkin" DROP CONSTRAINT IF EXISTS checkin_source_ck`);
  await knex.raw(`ALTER TABLE "Checkin" ADD CONSTRAINT checkin_source_ck CHECK ("source" IS NULL OR "source" IN (${list(OLD_SOURCES)}))`);
  for (const name of COLUMNS) {
    if (await knex.schema.hasColumn('Checkin', name)) await knex.schema.alterTable('Checkin', (t) => t.dropColumn(name));
  }
};
