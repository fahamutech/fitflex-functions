// Where device activity came from, ready for Apple Health / Health Connect /
// wearable sync.
// - Activity.devicePlatform: apple_health | health_connect | fitbit | garmin
//   | other. Set only for source = 'device'.
// - Activity.externalId: the platform's own record id, so a re-sync updates
//   rather than duplicates. Unique per member and platform.
// - Activity.deviceName: e.g. "Apple Watch", for display only.

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const cols = ['devicePlatform', 'externalId', 'deviceName'];
  const missing = [];
  for (const c of cols) {
    if (!(await knex.schema.hasColumn('Activity', c))) missing.push(c);
  }
  if (missing.length) {
    await knex.schema.alterTable('Activity', (t) => {
      for (const c of missing) t.text(c);
    });
  }
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS "activity_device_external_unique" ' +
      'ON "Activity" ("userId", "devicePlatform", "externalId") ' +
      'WHERE "externalId" IS NOT NULL',
  );
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS "activity_device_external_unique"');
  for (const c of ['deviceName', 'externalId', 'devicePlatform']) {
    if (await knex.schema.hasColumn('Activity', c)) {
      await knex.schema.alterTable('Activity', (t) => t.dropColumn(c));
    }
  }
};
