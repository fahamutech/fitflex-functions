// Identity V2 · I6 — accepting an invitation happens exactly once.
//
//   Invitation.status     gains 'accepting': the short-lived state an accept
//                         holds while it creates the role. Only one caller can
//                         move an open invitation into it (a conditional
//                         update), so two concurrent accepts cannot both run
//                         the side effects. A failed accept moves it back.
//   Invitation.tokenHash  becomes nullable: once an invitation is accepted,
//                         declined or cancelled its link hash is cleared, so an
//                         old link finds nothing. The unique index stays
//                         (Postgres allows many NULLs).
//
// Additive. Down: rows still 'accepting' go back to their open state, and
// cleared hashes get an unguessable placeholder so NOT NULL can return.

const OLD = ['pending', 'claimed', 'accepted', 'declined', 'expired', 'cancelled'];
const NEW = [...OLD, 'accepting'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE "Invitation" DROP CONSTRAINT IF EXISTS invitation_status_check`);
  await knex.raw(`ALTER TABLE "Invitation" ADD CONSTRAINT invitation_status_check CHECK (status IN (${list(NEW)}))`);
  await knex.raw(`ALTER TABLE "Invitation" ALTER COLUMN "tokenHash" DROP NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw(`UPDATE "Invitation"
    SET status = CASE WHEN "claimedAt" IS NULL THEN 'pending' ELSE 'claimed' END, "updatedAt" = now()
    WHERE status = 'accepting'`);
  await knex.raw(`UPDATE "Invitation" SET "tokenHash" = 'cleared:' || id || ':' || md5(random()::text)
    WHERE "tokenHash" IS NULL`);
  await knex.raw(`ALTER TABLE "Invitation" ALTER COLUMN "tokenHash" SET NOT NULL`);
  await knex.raw(`ALTER TABLE "Invitation" DROP CONSTRAINT IF EXISTS invitation_status_check`);
  await knex.raw(`ALTER TABLE "Invitation" ADD CONSTRAINT invitation_status_check CHECK (status IN (${list(OLD)}))`);
};
