// Identity V2 — invitation sign-in with a start PIN (agreed 3 Oct 2026).
//
//   Invitation.startPinHash      keyed hash of the four-digit start PIN sent
//                                to a person who is new to FitFlex; null when
//                                none was sent, once it is used, or once it
//                                has been guessed wrong too often
//   Invitation.startPinAttempts  wrong start PINs so far
//   Invitation.startPinUsedAt    when the person signed in with it
//   Person.displayName           the name a person gives before they have any
//                                profile (someone who was invited, or who
//                                declined and has not chosen a role yet)
//
// Additive.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.alterTable('Invitation', t => {
    t.text('startPinHash');
    t.integer('startPinAttempts').notNullable().defaultTo(0);
    t.timestamp('startPinUsedAt', { useTz: true });
  });
  await knex.schema.alterTable('Person', t => {
    t.text('displayName');
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.alterTable('Person', t => { t.dropColumn('displayName'); });
  await knex.schema.alterTable('Invitation', t => {
    t.dropColumn('startPinHash');
    t.dropColumn('startPinAttempts');
    t.dropColumn('startPinUsedAt');
  });
};
