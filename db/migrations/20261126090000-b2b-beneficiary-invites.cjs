// B2B Phase 7, slice 2 — adding many people at once, including people who
// have not joined FitFlex yet.
//
//   B2BBeneficiaryInvite   someone an organisation has listed by email or
//                          mobile number who has no member account yet. When
//                          they join with that email or number they are
//                          enrolled and the invite is closed. Holds the email
//                          schedule: the invitation and up to two reminders.
//   B2BBeneficiaryImport   one upload: who did it, how many rows went where,
//                          and the rows that could not be used.
//
// Additive only. Nothing existing changes.

const INVITE_STATUSES = ['invited', 'enrolled', 'cancelled'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });
  const stamps = (t) => {
    ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
    ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
  };
  const org = t => t.text('organizationId').notNullable().references('id').inTable('B2BOrganization').onDelete('RESTRICT').onUpdate('CASCADE');

  if (!(await knex.schema.hasTable('B2BBeneficiaryImport'))) {
    await knex.schema.createTable('B2BBeneficiaryImport', (t) => {
      t.text('id').primary();
      org(t);
      t.text('createdBy').notNullable();
      t.integer('total').notNullable();
      t.integer('enrolled').notNullable().defaultTo(0);
      t.integer('invited').notNullable().defaultTo(0);
      t.integer('unchanged').notNullable().defaultTo(0);     // already on the list or already invited
      t.integer('rejected').notNullable().defaultTo(0);
      t.jsonb('problems').notNullable().defaultTo('[]');     // the rows that could not be used, with the reason
      stamps(t);
      t.index(['organizationId', 'createdAt']);
    });
  }

  if (!(await knex.schema.hasTable('B2BBeneficiaryInvite'))) {
    await knex.schema.createTable('B2BBeneficiaryInvite', (t) => {
      t.text('id').primary();
      org(t);
      t.text('email');                         // lower case
      t.text('phone');                         // normalised, e.g. 255712345678
      t.text('displayName');
      t.text('externalReference');
      t.text('groupName');
      t.text('beneficiaryType').notNullable().defaultTo('member');
      t.text('status').notNullable().defaultTo('invited');
      t.text('importId');
      t.text('invitedBy').notNullable();
      ts(t, 'invitedAt').notNullable().defaultTo(knex.fn.now());
      // Email: how many have gone, when the next is due (null: none), and failures in a row.
      t.integer('emailsSent').notNullable().defaultTo(0);
      ts(t, 'lastEmailAt');
      ts(t, 'nextEmailAt');
      t.integer('emailFailures').notNullable().defaultTo(0);
      t.text('lastEmailError');
      ts(t, 'enrolledAt');
      t.text('beneficiaryId');
      ts(t, 'cancelledAt');
      t.text('cancelledBy');
      stamps(t);
      t.index(['organizationId', 'status']);
      t.index(['status', 'nextEmailAt']);
    });
    await knex.raw(`ALTER TABLE "B2BBeneficiaryInvite" ADD CONSTRAINT b2b_invite_status_chk CHECK ("status" IN (${list(INVITE_STATUSES)}))`);
    await knex.raw(`ALTER TABLE "B2BBeneficiaryInvite" ADD CONSTRAINT b2b_invite_contact_chk CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL)`);
    // One live invite per person and organisation: uploading the same list again adds nobody twice.
    await knex.raw(`CREATE UNIQUE INDEX b2b_invite_email_uq ON "B2BBeneficiaryInvite" ("organizationId", "email") WHERE "status" = 'invited' AND "email" IS NOT NULL`);
    await knex.raw(`CREATE UNIQUE INDEX b2b_invite_phone_uq ON "B2BBeneficiaryInvite" ("organizationId", "phone") WHERE "status" = 'invited' AND "phone" IS NOT NULL`);
    await knex.raw(`CREATE INDEX b2b_invite_email_idx ON "B2BBeneficiaryInvite" ("email") WHERE "status" = 'invited'`);
    await knex.raw(`CREATE INDEX b2b_invite_phone_idx ON "B2BBeneficiaryInvite" ("phone") WHERE "status" = 'invited'`);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('B2BBeneficiaryInvite');
  await knex.schema.dropTableIfExists('B2BBeneficiaryImport');
};
