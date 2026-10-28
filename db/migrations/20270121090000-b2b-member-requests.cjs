// A member must agree before an organisation adds them by account id
// (security fix, owner decision 22 Oct 2026; privacy ruling A-02).
//
//   B2BMemberRequest   an organisation user or a company's HR asked to add a
//                      member they named only by user id. Nothing happens to
//                      the member until they accept in the app: no
//                      beneficiary row, no staff link, no organisation role,
//                      so no organisation can see their activity and no
//                      sponsor is charged. Accepting performs the add.
//
//   kind      beneficiary    enrol in a B2B organisation
//             org_user       give a role in a B2B organisation's portal
//             employee_link  link a company's staff record to the account
//   status    pending → accepted | declined | expired | cancelled (final)
//
// Additive only; down drops the table.

const KINDS = ['beneficiary', 'org_user', 'employee_link'];
const STATUSES = ['pending', 'accepted', 'declined', 'expired', 'cancelled'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('B2BMemberRequest')) return;
  const ts = (t, col) => t.timestamp(col, { precision: 3 });
  await knex.schema.createTable('B2BMemberRequest', (t) => {
    t.text('id').primary();
    t.text('kind').notNullable();
    // The organisation (beneficiary, org_user) or the company (employee_link) asking.
    t.text('scopeId').notNullable();
    t.text('organizationId');
    t.text('corporateId');
    t.text('employeeId');
    t.text('userId').notNullable();                    // the member who must agree
    t.text('requestedBy').notNullable();
    t.text('requestedByType').notNullable();           // the requester's userType, to check their access again on accept
    t.jsonb('details').notNullable().defaultTo('{}');  // role + permissions, or beneficiaryType, groupName, externalReference, status
    t.text('status').notNullable().defaultTo('pending');
    ts(t, 'expiresAt').notNullable();
    ts(t, 'decidedAt');
    t.text('decidedBy');
    t.text('reason');
    t.text('resultId');                                // the beneficiary / organisation user / employee, on accept
    ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
    ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
    t.index(['userId', 'status']);
    t.index(['scopeId', 'kind', 'status']);
    t.index(['status', 'expiresAt']);
  });
  await knex.raw(`ALTER TABLE "B2BMemberRequest" ADD CONSTRAINT b2b_member_request_kind_chk CHECK ("kind" IN (${list(KINDS)}))`);
  await knex.raw(`ALTER TABLE "B2BMemberRequest" ADD CONSTRAINT b2b_member_request_status_chk CHECK ("status" IN (${list(STATUSES)}))`);
  // One open request per member, kind and organisation / company; one open link request per staff record.
  await knex.raw(`CREATE UNIQUE INDEX b2b_member_request_open_uq ON "B2BMemberRequest" ("kind", "scopeId", "userId") WHERE "status" = 'pending'`);
  await knex.raw(`CREATE UNIQUE INDEX b2b_member_request_employee_uq ON "B2BMemberRequest" ("employeeId") WHERE "status" = 'pending' AND "kind" = 'employee_link'`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('B2BMemberRequest');
};
