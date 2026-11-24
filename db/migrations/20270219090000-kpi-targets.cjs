// FR-K01 (parent repo docs/specs/programmes-nutrition.md §3, plan PD-9): the
// KPI targets admins can view and change in the portal.
//
// Seeded with the conservative v0.3 targets from the two specs
// (programmes-nutrition.md §3 and whatsapp-onboarding.md §3). They are owner
// proposals, not facts: `assumption` stays true until an admin confirms a
// target. Every change is written to AuditLog by the service.
//
// Additive and reversible. Nothing else reads this table.

const SEED = [
  // area, id, unit, baseline, v0.2 draft, v0.3 target (ASSUMPTION)
  ['programmes', 'pn_active_days', 'percent_change', 'To measure', 30, 20],
  ['programmes', 'pn_programme_starts', 'percent', '0', 35, 25],
  ['programmes', 'pn_day7_completion', 'percent', 'n/a', 50, 40],
  ['programmes', 'pn_meal_logging', 'percent', '0', 20, 12],
  ['programmes', 'pn_food_count', 'count', '0', 400, 400],
  ['programmes', 'pn_month2_renewal', 'points', 'To measure', 10, 5],
  ['whatsapp', 'wa_offer_reach', 'percent', 'n/a', 40, 30],
  ['whatsapp', 'wa_offer_conversion', 'percent', 'n/a', 8, 5],
  ['whatsapp', 'wa_cost_per_paid', 'percent_lower', 'To measure', 40, 25],
];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('KpiTarget')) return;
  await knex.schema.createTable('KpiTarget', (t) => {
    // A fixed id per KPI; the portal holds its words (English and Swahili).
    t.text('id').primary();
    t.text('area').notNullable();
    t.integer('sort').notNullable();
    // percent | percent_change | percent_lower | points | count
    t.text('unit').notNullable();
    // Free text as the spec writes it ("To measure", "n/a", "0").
    t.text('baseline');
    t.decimal('draftTarget', 12, 2);
    t.decimal('target', 12, 2).notNullable();
    // True until an admin confirms the target (D-07: these are proposals).
    t.boolean('assumption').notNullable().defaultTo(true);
    t.timestamp('confirmedAt', { useTz: true });
    t.text('confirmedBy');
    t.text('updatedBy');
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE "KpiTarget" ADD CONSTRAINT kpi_target_area_ck CHECK (area IN ('programmes', 'whatsapp'))`);
  await knex.raw(`ALTER TABLE "KpiTarget" ADD CONSTRAINT kpi_target_unit_ck CHECK (unit IN ('percent', 'percent_change', 'percent_lower', 'points', 'count'))`);
  await knex('KpiTarget').insert(SEED.map(([area, id, unit, baseline, draftTarget, target], i) => ({
    id, area, sort: i + 1, unit, baseline, draftTarget, target, assumption: true,
  })));
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('KpiTarget');
};
