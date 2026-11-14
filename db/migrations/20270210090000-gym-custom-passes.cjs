// Custom gym passes & flexible membership · phase 2 (backend + database). Additive; ships dormant behind the
// GYM_CUSTOM_PASSES flag (nothing reads or writes these tables while it is off).
//
// - GymPassPlan        a pass a gym owner designs: individual (1 person), couples (2) or group (3+), any duration in
//                      days / weeks / months, one price in TZS. Editing a plan never touches purchases (they keep a snapshot).
// - GymPassPurchase    one sale. ONE PaymentRequest for the full price (PaymentRequest.passPurchaseId). `snapshot` is what
//                      the buyer saw and paid for (name, price, currency, duration, category, beneficiary limit, terms).
// - GymPassBeneficiary one person covered by a sale (the purchaser holds slot 1). A person without a FitFlex account is
//                      stored as pending_registration with the contact the purchaser gave and is claimed on sign-up with
//                      that VERIFIED contact. A removed row keeps its history but releases its slot (slot becomes NULL).
// - Subscription.passPurchaseId / passBeneficiaryId: every covered person gets their OWN child `direct_sub` row (own QR
//   eligibility, own check-ins), same expiresAt as the sale. Child rows have no PaymentRequest, so finance counts the
//   money once. Settlement does not settle direct_sub; nothing here changes that.
// - PaymentRequest.passPurchaseId, Checkin.passPurchaseId / beneficiaryId: which sale a payment / visit belongs to.
//
// Down: REFUSES while any GymPassPurchase exists (prints the count), otherwise drops everything added here.

const PLAN_CHECK_SHAPE = `(
    ("category" = 'individual' AND "beneficiaryLimit" = 1)
 OR ("category" = 'couples' AND "beneficiaryLimit" = 2)
 OR ("category" = 'group' AND "beneficiaryLimit" > 2))`;

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.schema.createTable('GymPassPlan', (t) => {
    t.text('id').primary();
    t.text('gymId').notNullable().references('id').inTable('Gym').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('name').notNullable();
    t.text('description');
    t.text('category').notNullable();
    t.integer('durationValue').notNullable();
    t.text('durationUnit').notNullable();
    t.integer('beneficiaryLimit').notNullable();
    t.integer('priceTzs').notNullable();
    t.text('status').notNullable().defaultTo('active');
    t.text('startPolicy').notNullable().defaultTo('immediate');
    t.text('terms');
    t.integer('termsVersion').notNullable().defaultTo(1);
    t.text('createdBy').notNullable();
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE "GymPassPlan"
    ADD CONSTRAINT gympassplan_category_chk CHECK ("category" IN ('individual', 'couples', 'group')),
    ADD CONSTRAINT gympassplan_unit_chk CHECK ("durationUnit" IN ('days', 'weeks', 'months')),
    ADD CONSTRAINT gympassplan_status_chk CHECK ("status" IN ('active', 'inactive')),
    ADD CONSTRAINT gympassplan_start_policy_chk CHECK ("startPolicy" = 'immediate'),
    ADD CONSTRAINT gympassplan_price_chk CHECK ("priceTzs" > 0),
    ADD CONSTRAINT gympassplan_duration_chk CHECK ("durationValue" > 0),
    ADD CONSTRAINT gympassplan_shape_chk CHECK ${PLAN_CHECK_SHAPE}`);
  await knex.raw('CREATE INDEX gympassplan_gym_status_idx ON "GymPassPlan" ("gymId", "status")');

  await knex.schema.createTable('GymPassPurchase', (t) => {
    t.text('id').primary();
    t.text('planId').references('id').inTable('GymPassPlan').onDelete('SET NULL').onUpdate('CASCADE');
    // No foreign key on gym / purchaser: a sale is a money record and outlives both.
    t.text('gymId').notNullable();
    t.text('purchaserId').notNullable();
    t.text('paymentRequestId').references('id').inTable('PaymentRequest').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('status').notNullable().defaultTo('pending_payment');
    t.jsonb('snapshot').notNullable();
    t.timestamp('startsAt', { precision: 3 });
    t.timestamp('expiresAt', { precision: 3 });
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE "GymPassPurchase"
    ADD CONSTRAINT gympasspurchase_status_chk CHECK ("status" IN ('pending_payment', 'active', 'expired', 'cancelled'))`);
  // One open (unpaid) purchase per member and plan: a double tap or a retry must not create a second payment.
  await knex.raw(`CREATE UNIQUE INDEX gympasspurchase_open_unique ON "GymPassPurchase" ("purchaserId", "planId") WHERE "status" = 'pending_payment'`);
  await knex.raw('CREATE UNIQUE INDEX gympasspurchase_payment_unique ON "GymPassPurchase" ("paymentRequestId") WHERE "paymentRequestId" IS NOT NULL');
  await knex.raw('CREATE INDEX gympasspurchase_gym_status_idx ON "GymPassPurchase" ("gymId", "status")');
  await knex.raw('CREATE INDEX gympasspurchase_purchaser_idx ON "GymPassPurchase" ("purchaserId")');

  await knex.schema.createTable('GymPassBeneficiary', (t) => {
    t.text('id').primary();
    t.text('purchaseId').notNullable().references('id').inTable('GymPassPurchase').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('userId');
    t.text('contactType');
    t.text('contactValue');
    t.boolean('isPurchaser').notNullable().defaultTo(false);
    t.integer('slot');
    t.text('subscriptionId').references('id').inTable('Subscription').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('status').notNullable().defaultTo('pending_registration');
    t.text('inviteTokenHash');
    t.timestamp('inviteExpiresAt', { precision: 3 });
    t.timestamp('inviteSentAt', { precision: 3 });
    t.text('notifiedVia');
    t.timestamp('notifiedAt', { precision: 3 });
    t.timestamp('claimedAt', { precision: 3 });
    t.timestamp('removedAt', { precision: 3 });
    t.text('removedBy');
    t.text('removedByRole');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE "GymPassBeneficiary"
    ADD CONSTRAINT gympassbeneficiary_status_chk CHECK ("status" IN ('pending_registration', 'active', 'removed', 'suspended')),
    ADD CONSTRAINT gympassbeneficiary_contact_type_chk CHECK ("contactType" IS NULL OR "contactType" IN ('phone', 'email')),
    ADD CONSTRAINT gympassbeneficiary_slot_chk CHECK ("slot" IS NULL OR "slot" >= 1),
    ADD CONSTRAINT gympassbeneficiary_slot_held_chk CHECK ("slot" IS NOT NULL OR "status" = 'removed'),
    ADD CONSTRAINT gympassbeneficiary_pending_chk CHECK ("status" <> 'pending_registration' OR ("userId" IS NULL AND "contactValue" IS NOT NULL))`);
  // A person holds one slot per purchase; a removed row no longer counts (it can be added again).
  await knex.raw(`CREATE UNIQUE INDEX gympassbeneficiary_user_unique ON "GymPassBeneficiary" ("purchaseId", "userId") WHERE "userId" IS NOT NULL AND "status" <> 'removed'`);
  await knex.raw('CREATE UNIQUE INDEX gympassbeneficiary_slot_unique ON "GymPassBeneficiary" ("purchaseId", "slot")');
  await knex.raw(`CREATE UNIQUE INDEX gympassbeneficiary_contact_unique ON "GymPassBeneficiary" ("purchaseId", "contactType", "contactValue") WHERE "contactValue" IS NOT NULL AND "status" <> 'removed'`);
  await knex.raw('CREATE UNIQUE INDEX gympassbeneficiary_token_unique ON "GymPassBeneficiary" ("inviteTokenHash") WHERE "inviteTokenHash" IS NOT NULL');
  await knex.raw(`CREATE INDEX gympassbeneficiary_pending_contact_idx ON "GymPassBeneficiary" ("contactType", "contactValue") WHERE "status" = 'pending_registration'`);
  await knex.raw('CREATE INDEX gympassbeneficiary_user_idx ON "GymPassBeneficiary" ("userId") WHERE "userId" IS NOT NULL');

  await knex.schema.alterTable('Subscription', (t) => {
    t.text('passPurchaseId').references('id').inTable('GymPassPurchase').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('passBeneficiaryId');
  });
  await knex.raw('CREATE INDEX subscription_passpurchaseid_idx ON "Subscription" ("passPurchaseId") WHERE "passPurchaseId" IS NOT NULL');

  await knex.schema.alterTable('PaymentRequest', (t) => { t.text('passPurchaseId'); });
  await knex.raw('CREATE INDEX paymentrequest_passpurchaseid_idx ON "PaymentRequest" ("passPurchaseId") WHERE "passPurchaseId" IS NOT NULL');

  await knex.schema.alterTable('Checkin', (t) => {
    t.text('passPurchaseId');
    t.text('beneficiaryId');
  });
  await knex.raw('CREATE INDEX checkin_passpurchaseid_idx ON "Checkin" ("passPurchaseId") WHERE "passPurchaseId" IS NOT NULL');
  await knex.raw('CREATE INDEX checkin_beneficiaryid_idx ON "Checkin" ("beneficiaryId") WHERE "beneficiaryId" IS NOT NULL');
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const exists = (await knex.raw(`SELECT to_regclass('"GymPassPurchase"') AS t`)).rows[0].t;
  if (exists) {
    const n = Number((await knex.raw('SELECT count(*)::int AS n FROM "GymPassPurchase"')).rows[0].n);
    if (n) {
      console.error(`[migrate] gym-custom-passes down refused: ${n} pass purchase(s) exist`);
      throw new Error(`gym-custom-passes down: ${n} pass purchase(s) exist; delete them first if they are really to be lost`);
    }
  }
  await knex.raw('DROP INDEX IF EXISTS checkin_beneficiaryid_idx');
  await knex.raw('DROP INDEX IF EXISTS checkin_passpurchaseid_idx');
  await knex.schema.alterTable('Checkin', (t) => { t.dropColumn('passPurchaseId'); t.dropColumn('beneficiaryId'); });
  await knex.raw('DROP INDEX IF EXISTS paymentrequest_passpurchaseid_idx');
  await knex.schema.alterTable('PaymentRequest', (t) => { t.dropColumn('passPurchaseId'); });
  await knex.raw('DROP INDEX IF EXISTS subscription_passpurchaseid_idx');
  await knex.schema.alterTable('Subscription', (t) => { t.dropColumn('passPurchaseId'); t.dropColumn('passBeneficiaryId'); });
  await knex.schema.dropTableIfExists('GymPassBeneficiary');
  await knex.schema.dropTableIfExists('GymPassPurchase');
  await knex.schema.dropTableIfExists('GymPassPlan');
};
