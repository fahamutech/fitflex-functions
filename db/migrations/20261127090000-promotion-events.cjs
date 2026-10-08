// Promotion analytics — the events behind impressions, clicks, views, saves and
// attributed purchases. Raw rows are kept 13 months (the owner's decision) and
// then deleted by a daily job. A row holds no personal detail beyond the user id
// of a signed-in customer and a random per-launch session id.
//
// Additive only.

const list = values => values.map(v => `'${v}'`).join(', ');
const EVENTS = ['impression', 'click', 'detail_view', 'save', 'booking_click', 'subscription_click', 'purchase', 'booking', 'subscription'];
const ENTITIES = ['gym', 'trainer', 'vendor', 'product'];
const SOURCES = ['mobile', 'web', 'server'];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('PromotionEvent')) return;
  await knex.schema.createTable('PromotionEvent', (t) => {
    t.text('id').primary();
    t.timestamp('at', { precision: 3 }).notNullable();
    t.text('event').notNullable();
    t.text('entityType').notNullable();
    t.text('entityId').notNullable();
    t.text('promotionId');                       // the promotion the customer saw or acted on; no foreign key so a late event never fails
    t.text('campaignId');                        // copied from the promotion so campaign totals need no join
    t.text('placement');
    t.text('userId');                            // set when the customer was signed in
    t.text('sessionId').notNullable();
    t.text('source').notNullable().defaultTo('mobile');
    t.integer('valueTzs');                       // purchases: the amount credited
    t.text('dedupeKey');
    t.timestamp('createdAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.unique(['dedupeKey']);
    t.index(['promotionId', 'event', 'at']);
    t.index(['campaignId', 'at']);
    t.index(['entityType', 'entityId', 'at']);
    t.index(['userId', 'event', 'at']);
    t.index(['at']);
  });
  await knex.raw(`ALTER TABLE "PromotionEvent" ADD CONSTRAINT promoevent_event_chk CHECK ("event" IN (${list(EVENTS)}))`);
  await knex.raw(`ALTER TABLE "PromotionEvent" ADD CONSTRAINT promoevent_entity_chk CHECK ("entityType" IN (${list(ENTITIES)}))`);
  await knex.raw(`ALTER TABLE "PromotionEvent" ADD CONSTRAINT promoevent_source_chk CHECK ("source" IN (${list(SOURCES)}))`);
  await knex.raw(`ALTER TABLE "PromotionEvent" ADD CONSTRAINT promoevent_value_chk CHECK ("valueTzs" IS NULL OR "valueTzs" >= 0)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('PromotionEvent');
};
