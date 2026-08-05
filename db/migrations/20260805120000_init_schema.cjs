// Consolidated schema migration — replaces the 11 Prisma migrations previously
// under prisma/migrations/. Table and column names are unchanged so this is a
// no-op (each createTable is skipped via hasTable) against databases that were
// already provisioned by Prisma; it also fully provisions a brand-new database
// (e.g. a fresh CI database) from scratch.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const arrayDefault = knex.raw('ARRAY[]::TEXT[]');

  if (!(await knex.schema.hasTable('User'))) {
    await knex.schema.createTable('User', (table) => {
      table.text('id').primary();
      table.text('firebaseUid').unique();
      table.text('phone').unique();
      table.text('email').unique();
      table.text('displayName');
      table.text('photoUrl');
      table.text('userType').notNullable();
      table.text('accountStatus').notNullable().defaultTo('active');
      table.text('approvalStatus').notNullable().defaultTo('approved');
      table.text('passwordHash');
      table.text('approvalNote');
      table.boolean('onboardingCompleted').notNullable().defaultTo(false);
      table.boolean('portalUser').notNullable().defaultTo(false);
      table.specificType('aclPermissions', 'TEXT[]').notNullable().defaultTo(arrayDefault);
      table.jsonb('memberProfile');
      table.text('gymId');
      table.specificType('gymIds', 'TEXT[]').defaultTo(arrayDefault);
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { precision: 3 }).notNullable();

      table.index('userType');
      table.index('accountStatus');
      table.index('phone');
    });
  }

  if (!(await knex.schema.hasTable('Gym'))) {
    await knex.schema.createTable('Gym', (table) => {
      table.text('id').primary();
      table.text('name').notNullable();
      table.text('tier').notNullable();
      table.text('location').notNullable();
      table.text('venueType').notNullable().defaultTo('physical');
      table.text('accessMode').notNullable().defaultTo('paid_visit');
      table.jsonb('operatingHours');
      table.integer('perVisitRate').notNullable().defaultTo(0);
      table.integer('ratePerDay').notNullable().defaultTo(0);
      table.integer('ratePerWeek').notNullable().defaultTo(0);
      table.integer('ratePerMonth').notNullable().defaultTo(0);
      table.integer('commissionRate').notNullable().defaultTo(12);
      table.text('status').notNullable().defaultTo('active');
      table.specificType('images', 'TEXT[]').defaultTo(arrayDefault);
      table.specificType('thumbnails', 'TEXT[]').defaultTo(arrayDefault);
      table.jsonb('coordinates');
      table.specificType('amenities', 'TEXT[]').defaultTo(arrayDefault);
      table.specificType('equipment', 'TEXT[]').defaultTo(arrayDefault);
      table.text('paymentBank');
      table.text('paymentNumber');
      table.text('paymentNotes');
      table.text('tinNumber');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { precision: 3 }).notNullable();

      table.index('status');
      table.index('tier');
    });
  }

  if (!(await knex.schema.hasTable('Subscription'))) {
    await knex.schema.createTable('Subscription', (table) => {
      table.text('id').primary();
      table.text('memberId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      table.text('type').notNullable();
      table.text('tier');
      table.text('status').notNullable();
      table.timestamp('startedAt', { precision: 3 }).notNullable();
      table.timestamp('cycleStartedAt', { precision: 3 }).notNullable();
      table.timestamp('renewsAt', { precision: 3 }).notNullable();
      table.timestamp('expiresAt', { precision: 3 }).notNullable();
      table.text('homeGymId');
      table.text('paymentRef');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());

      table.index(['memberId', 'status']);
      table.index('renewsAt');
    });
  }

  if (!(await knex.schema.hasTable('PaymentRequest'))) {
    await knex.schema.createTable('PaymentRequest', (table) => {
      table.text('id').primary();
      table.text('memberId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      table.text('subscriptionId').notNullable();
      table.text('tier').notNullable();
      table.integer('amountTzs').notNullable();
      table.text('status').notNullable();
      table.text('provider').notNullable();
      table.text('reference');
      table.text('note');
      table.timestamp('requestedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('decidedAt', { precision: 3 });
      table.text('decidedBy');

      table.index('memberId');
      table.index('status');
    });
  }

  if (!(await knex.schema.hasTable('Checkin'))) {
    await knex.schema.createTable('Checkin', (table) => {
      table.text('id').primary();
      table.text('memberId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      table.text('gymId').notNullable().references('id').inTable('Gym').onDelete('CASCADE').onUpdate('CASCADE');
      table.timestamp('timestamp', { precision: 3 }).notNullable();
      table.text('method').notNullable();
      table.text('subscriptionType').notNullable();
      table.text('passTier');
      table.integer('visitNumberInCycle');
      table.text('gymTier').notNullable();
      table.integer('creditsDeductedTzs').notNullable().defaultTo(0);
      table.boolean('visitConsumed').notNullable();

      table.unique(['memberId', 'gymId', 'timestamp']);
      table.index(['gymId', 'timestamp']);
      table.index(['memberId', 'timestamp']);
    });
  }

  if (!(await knex.schema.hasTable('Invoice'))) {
    await knex.schema.createTable('Invoice', (table) => {
      table.text('id').primary();
      table.text('gymId').notNullable().references('id').inTable('Gym').onDelete('CASCADE').onUpdate('CASCADE');
      table.text('gymName').notNullable();
      table.text('ownerId');
      table.text('ownerName');
      table.integer('amount').notNullable();
      table.text('status').notNullable().defaultTo('unpaid');
      table.text('note');
      table.text('periodStart');
      table.text('periodEnd');
      table.text('receiptUrl');
      table.text('paymentReference');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.text('createdBy').notNullable();
      table.timestamp('paidAt', { precision: 3 });

      table.index(['gymId', 'periodStart', 'periodEnd']);
      table.index('status');
    });
  }

  if (!(await knex.schema.hasTable('GymPayout'))) {
    await knex.schema.createTable('GymPayout', (table) => {
      table.text('id').primary();
      table.text('gymId').notNullable().references('id').inTable('Gym').onDelete('CASCADE').onUpdate('CASCADE');
      table.text('invoiceId');
      table.integer('amount').notNullable();
      table.text('status').notNullable();
      table.text('periodStart');
      table.text('periodEnd');
      table.timestamp('paidAt', { precision: 3 });
      table.text('reference');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());

      table.index(['gymId', 'periodStart', 'periodEnd']);
    });
  }

  if (!(await knex.schema.hasTable('TrainerProfile'))) {
    await knex.schema.createTable('TrainerProfile', (table) => {
      table.text('id').primary();
      table.text('userId').unique().references('id').inTable('User').onDelete('SET NULL').onUpdate('CASCADE');
      table.text('email');
      table.text('phone');
      table.text('displayName').notNullable();
      table.text('photoUrl');
      table.text('gender');
      table.specificType('specialties', 'TEXT[]').defaultTo(arrayDefault);
      table.text('bio');
      table.double('rating').notNullable().defaultTo(0);
      table.integer('reviewCount').notNullable().defaultTo(0);
      table.integer('hourlyRateTzs').notNullable().defaultTo(0);
      table.integer('experienceYears').notNullable().defaultTo(0);
      table.text('status').notNullable().defaultTo('active');
      table.text('approvalStatus').notNullable().defaultTo('approved');
      table.specificType('pendingGymIds', 'TEXT[]').notNullable().defaultTo(arrayDefault);
      table.jsonb('availability');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { precision: 3 }).notNullable();

      table.index('status');
    });
  }

  if (!(await knex.schema.hasTable('TrainerProfileGym'))) {
    await knex.schema.createTable('TrainerProfileGym', (table) => {
      table.text('trainerId').notNullable().references('id').inTable('TrainerProfile').onDelete('CASCADE').onUpdate('CASCADE');
      table.text('gymId').notNullable().references('id').inTable('Gym').onDelete('CASCADE').onUpdate('CASCADE');
      table.primary(['trainerId', 'gymId']);
    });
  }

  if (!(await knex.schema.hasTable('TrainerBooking'))) {
    await knex.schema.createTable('TrainerBooking', (table) => {
      table.text('id').primary();
      table.text('memberId').notNullable().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      table.text('trainerId').notNullable().references('id').inTable('TrainerProfile').onDelete('CASCADE').onUpdate('CASCADE');
      table.text('gymId').notNullable().references('id').inTable('Gym').onDelete('CASCADE').onUpdate('CASCADE');
      table.text('date').notNullable();
      table.text('slot').notNullable();
      table.integer('amountTzs').notNullable();
      table.text('status').notNullable().defaultTo('confirmed');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());

      table.index('memberId');
      table.index('trainerId');
    });
  }

  if (!(await knex.schema.hasTable('CreditsWallet'))) {
    await knex.schema.createTable('CreditsWallet', (table) => {
      table.text('id').primary();
      table.text('userId').notNullable().unique().references('id').inTable('User').onDelete('CASCADE').onUpdate('CASCADE');
      table.integer('balanceTzs').notNullable().defaultTo(0);
      table.timestamp('lastTopUpAt', { precision: 3 });
      table.timestamp('expiresAt', { precision: 3 });
    });
  }

  if (!(await knex.schema.hasTable('CreditsTransaction'))) {
    await knex.schema.createTable('CreditsTransaction', (table) => {
      table.text('id').primary();
      table.text('walletId').notNullable().references('id').inTable('CreditsWallet').onDelete('CASCADE').onUpdate('CASCADE');
      table.integer('amountTzs').notNullable();
      table.text('type').notNullable();
      table.text('reference');
      table.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());

      table.index('walletId');
    });
  }

  if (!(await knex.schema.hasTable('PlatformSettings'))) {
    await knex.schema.createTable('PlatformSettings', (table) => {
      table.text('id').primary().defaultTo('platform');
      table.jsonb('subscriptionTiers').notNullable();
      table.jsonb('payoutBands').notNullable();
      table.integer('paymentPeriodDays').notNullable().defaultTo(14);
      table.text('payoutModel').notNullable().defaultTo('commission');
      table.text('currency').notNullable().defaultTo('TZS');
      table.timestamp('updatedAt', { precision: 3 }).notNullable();
    });
  }

  if (!(await knex.schema.hasTable('AuditLog'))) {
    await knex.schema.createTable('AuditLog', (table) => {
      table.text('id').primary();
      table.timestamp('at', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
      table.text('actor');
      table.text('action').notNullable();
      table.text('target').notNullable();
      table.jsonb('before');
      table.jsonb('after');

      table.index('actor');
      table.index('action');
      table.index('at');
    });
  }

  if (!(await knex.schema.hasTable('WebhookSeen'))) {
    await knex.schema.createTable('WebhookSeen', (table) => {
      table.text('id').primary();
      table.timestamp('at', { precision: 3 }).notNullable().defaultTo(knex.fn.now());

      table.index('at');
    });
  }

  if (!(await knex.schema.hasTable('Otp'))) {
    await knex.schema.createTable('Otp', (table) => {
      table.text('phone').primary();
      table.text('code');
      table.text('userType').notNullable();
      table.timestamp('expiresAt', { precision: 3 }).notNullable();

      table.index('expiresAt');
    });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const dropIfExists = (name) => knex.schema.dropTableIfExists(name);
  await dropIfExists('CreditsTransaction');
  await dropIfExists('CreditsWallet');
  await dropIfExists('TrainerBooking');
  await dropIfExists('TrainerProfileGym');
  await dropIfExists('TrainerProfile');
  await dropIfExists('GymPayout');
  await dropIfExists('Invoice');
  await dropIfExists('Checkin');
  await dropIfExists('PaymentRequest');
  await dropIfExists('Subscription');
  await dropIfExists('Otp');
  await dropIfExists('WebhookSeen');
  await dropIfExists('AuditLog');
  await dropIfExists('PlatformSettings');
  await dropIfExists('Gym');
  await dropIfExists('User');
};
