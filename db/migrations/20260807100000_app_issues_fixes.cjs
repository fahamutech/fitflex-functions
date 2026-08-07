// FitFlex App Issues 25.07.2026 — schema additions.
// A6: Gym.verified · A7: Subscription.plan + PaymentRequest.plan/gymId (tier nullable)
// B11/B12: Gym.classes + Gym.trainerPass (jsonb)
// A4: TrainerEngagement (enquiries / interest)
// C3: TrainerSession (manual sessions alongside bookings)
// D1: Product + ShopOrder (vendor e-commerce)

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  // ── Gym: verified flag + classes + trainer pass ──
  if (!(await knex.schema.hasColumn('Gym', 'verified'))) {
    await knex.schema.alterTable('Gym', (table) => {
      table.boolean('verified').notNullable().defaultTo(false);
    });
  }
  if (!(await knex.schema.hasColumn('Gym', 'classes'))) {
    await knex.schema.alterTable('Gym', (table) => {
      table.jsonb('classes');
    });
  }
  if (!(await knex.schema.hasColumn('Gym', 'trainerPass'))) {
    await knex.schema.alterTable('Gym', (table) => {
      table.jsonb('trainerPass');
    });
  }

  // ── Subscription: direct plan id (daily|weekly|monthly) ──
  if (!(await knex.schema.hasColumn('Subscription', 'plan'))) {
    await knex.schema.alterTable('Subscription', (table) => {
      table.text('plan');
    });
  }

  // ── PaymentRequest: direct-sub payments carry plan + gym, tier optional ──
  if (!(await knex.schema.hasColumn('PaymentRequest', 'plan'))) {
    await knex.schema.alterTable('PaymentRequest', (table) => {
      table.text('plan');
      table.text('gymId');
    });
  }
  await knex.schema.alterTable('PaymentRequest', (table) => {
    table.text('tier').nullable().alter();
  });

  // ── TrainerEngagement: member → trainer enquiries / interest (A4) ──
  if (!(await knex.schema.hasTable('TrainerEngagement'))) {
    await knex.schema.createTable('TrainerEngagement', (table) => {
      table.text('id').primary();
      table.text('memberId').notNullable();
      table.text('trainerId').notNullable();
      table.text('type').notNullable(); // enquiry | interest
      table.text('message');
      table.text('gymId');
      table.text('status').notNullable().defaultTo('new');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());

      table.index(['trainerId', 'type']);
      table.index('memberId');
    });
  }

  // ── TrainerSession: manual sessions recorded by the trainer (C3) ──
  if (!(await knex.schema.hasTable('TrainerSession'))) {
    await knex.schema.createTable('TrainerSession', (table) => {
      table.text('id').primary();
      table.text('trainerId').notNullable();
      table.text('memberId');
      table.text('customerName');
      table.text('customerEmail');
      table.text('customerPhone');
      table.text('gymId');
      table.text('date').notNullable(); // YYYY-MM-DD
      table.text('slot');
      table.text('source').notNullable().defaultTo('manual'); // manual | booking
      table.text('status').notNullable().defaultTo('scheduled');
      table.integer('amountTzs').notNullable().defaultTo(0);
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());

      table.index(['trainerId', 'date']);
    });
  }

  // ── Shop: products + orders (D1) ──
  if (!(await knex.schema.hasTable('Product'))) {
    await knex.schema.createTable('Product', (table) => {
      table.text('id').primary();
      table.text('vendorId').notNullable();
      table.text('name').notNullable();
      table.text('description');
      table.text('category');
      table.integer('priceTzs').notNullable().defaultTo(0);
      table.integer('stock').notNullable().defaultTo(0);
      table.specificType('images', 'TEXT[]').defaultTo('{}');
      table.text('status').notNullable().defaultTo('active'); // active | archived
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());

      table.index(['vendorId', 'status']);
      table.index('category');
    });
  }
  if (!(await knex.schema.hasTable('ShopOrder'))) {
    await knex.schema.createTable('ShopOrder', (table) => {
      table.text('id').primary();
      table.text('buyerId').notNullable();
      table.text('buyerRole').notNullable().defaultTo('member');
      table.jsonb('items').notNullable(); // [{productId, name, qty, priceTzs}]
      table.integer('totalTzs').notNullable().defaultTo(0);
      table.text('status').notNullable().defaultTo('pending'); // pending|confirmed|fulfilled|cancelled
      table.text('note');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());

      table.index(['buyerId', 'status']);
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ShopOrder');
  await knex.schema.dropTableIfExists('Product');
  await knex.schema.dropTableIfExists('TrainerSession');
  await knex.schema.dropTableIfExists('TrainerEngagement');
  if (await knex.schema.hasColumn('PaymentRequest', 'plan')) {
    await knex.schema.alterTable('PaymentRequest', (table) => {
      table.dropColumn('plan');
      table.dropColumn('gymId');
    });
  }
  if (await knex.schema.hasColumn('Subscription', 'plan')) {
    await knex.schema.alterTable('Subscription', (table) => table.dropColumn('plan'));
  }
  if (await knex.schema.hasColumn('Gym', 'verified')) {
    await knex.schema.alterTable('Gym', (table) => {
      table.dropColumn('verified');
      table.dropColumn('classes');
      table.dropColumn('trainerPass');
    });
  }
};
