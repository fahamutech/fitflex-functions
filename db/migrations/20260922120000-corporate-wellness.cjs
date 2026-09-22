/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const addColumn = async (tableName, columnName, callback) => {
    if (!(await knex.schema.hasColumn(tableName, columnName))) {
      await knex.schema.alterTable(tableName, callback);
    }
  };

  // Corporate HR users are scoped to one account, mirroring vendorId on vendor staff.
  await addColumn('User', 'corporateId', table => table.text('corporateId'));

  if (!(await knex.schema.hasTable('CorporateAccount'))) {
    await knex.schema.createTable('CorporateAccount', table => {
      table.text('id').primary();
      table.text('companyName').notNullable();
      table.text('industrySector').notNullable();
      table.text('workforceBracket').notNullable();
      table.text('hrContactName');
      table.text('hrContactPhone');
      table.text('hrContactEmail');
      table.specificType('objectives', 'TEXT[]').defaultTo('{}');
      table.specificType('domainWhitelist', 'TEXT[]').defaultTo('{}');
      table.text('subsidyModel').notNullable();
      table.text('passTier').notNullable();
      table.text('billingCycle').notNullable().defaultTo('monthly');
      table.integer('seatLimit').notNullable().defaultTo(0);
      table.integer('seatsUsed').notNullable().defaultTo(0);
      table.integer('baselineSickDays').notNullable().defaultTo(7);
      table.text('lipaNamba');
      table.text('status').notNullable().defaultTo('pending');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.index('status');
    });
  }

  if (!(await knex.schema.hasTable('CorporateEmployee'))) {
    await knex.schema.createTable('CorporateEmployee', table => {
      table.text('id').primary();
      table.text('corporateId').notNullable();
      table.text('userId');
      table.text('displayName').notNullable();
      table.text('phone');
      table.text('email');
      table.text('department');
      // Activation PIN is stored as a scrypt hash (src/auth/password-credentials.mjs);
      // the plaintext is returned to HR once at provisioning time and never persisted.
      table.text('pinHash');
      table.text('status').notNullable().defaultTo('pending');
      table.timestamp('activatedAt', { precision: 3 });
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.index(['corporateId', 'status']);
    });
  }

  if (!(await knex.schema.hasTable('CorporateBill'))) {
    await knex.schema.createTable('CorporateBill', table => {
      table.text('id').primary();
      table.text('corporateId').notNullable();
      table.text('period').notNullable(); // YYYY-MM
      table.text('passTier').notNullable();
      table.text('subsidyModel').notNullable();
      table.text('billingCycle').notNullable();
      table.integer('seatCount').notNullable();
      table.integer('perSeatMonthlyTzs').notNullable();
      table.integer('grossTzs').notNullable();
      table.integer('employerTzs').notNullable();
      table.integer('employeeTzs').notNullable();
      table.text('status').notNullable().defaultTo('unpaid');
      table.text('paymentReference');
      table.timestamp('paidAt', { precision: 3 });
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.unique(['corporateId', 'period']);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('CorporateBill');
  await knex.schema.dropTableIfExists('CorporateEmployee');
  await knex.schema.dropTableIfExists('CorporateAccount');
  if (await knex.schema.hasColumn('User', 'corporateId')) {
    await knex.schema.alterTable('User', table => table.dropColumn('corporateId'));
  }
};
