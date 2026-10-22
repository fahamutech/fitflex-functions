// Shop near-you (Phase 2 · slice 3), i18n review: GeoArea gets an optional Swahili place name.
// Additive: nullable text; null = the Swahili name is the same as `name` (most place names are).
// Seeds the two starting areas whose Swahili name differs. [SW review] both are for native review.
// Reversible: down drops the column.

const SEED = [
  ['tz-znz-city', 'Zanzibar City', 'Mji wa Zanzibar'],
  ['tz-znz-stone-town', 'Stone Town', 'Mji Mkongwe'],
];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('GeoArea'))) return;
  if (!(await knex.schema.hasColumn('GeoArea', 'nameSw'))) {
    await knex.schema.alterTable('GeoArea', (t) => { t.text('nameSw'); });
  }
  // Only rows still carrying the seeded English name and no Swahili name yet.
  for (const [id, name, nameSw] of SEED) {
    await knex('GeoArea').where({ id, name }).whereNull('nameSw').update({ nameSw });
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  if ((await knex.schema.hasTable('GeoArea')) && (await knex.schema.hasColumn('GeoArea', 'nameSw'))) {
    await knex.schema.alterTable('GeoArea', (t) => { t.dropColumn('nameSw'); });
  }
};
