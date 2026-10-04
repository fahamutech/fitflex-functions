// Start the settlement configuration on 1 June 2026 instead of 1 October.
//
// The app still holds test data only (confirmed 30 Sep 2026; asked for on
// 4 Oct 2026): the test passes all began before October, so no member cycle
// could be settled and a shadow run had nothing to show. Every pass tier
// version, settlement rule and gym rate card that is in force from
// 1 Oct 2026 now starts on 1 Jun 2026. Versions that start on another date
// (anything drafted and activated by hand since) are left alone.
//
// An active version is read-only by design, so the guard is lifted for this
// one change and put back; the overlap guard stays on. No live settlement
// exists yet, so nothing that was calculated for payment changes.

const FROM = '2026-10-01';
const TO = '2026-06-01';
const TABLES = ['PassTierVersion', 'SettlementRule', 'GymRateCard'];

async function move(knex, from, to, note) {
  const moved = {};
  for (const table of TABLES) {
    const guard = `${table.toLowerCase()}_guard_immutable`;
    await knex.raw(`ALTER TABLE "${table}" DISABLE TRIGGER ${guard}`);
    try {
      moved[table] = await knex(table).where({ status: 'active', effectiveFrom: from }).update({ effectiveFrom: to, updatedAt: new Date() });
    } finally {
      await knex.raw(`ALTER TABLE "${table}" ENABLE TRIGGER ${guard}`);
    }
  }
  await knex('AuditLog').insert({
    id: `audit_backdate_${to}_${Date.now()}`, at: new Date(), actor: 'migration:20261121090000', action: 'settlement_config_start_moved', target: 'settlement-config',
    before: JSON.stringify({ effectiveFrom: from }), after: JSON.stringify({ effectiveFrom: to, moved, note }),
  });
}

/** @param {import('knex').Knex} knex */
exports.up = (knex) => move(knex, FROM, TO, 'test data: let earlier test cycles settle');

/** @param {import('knex').Knex} knex */
exports.down = (knex) => move(knex, TO, FROM, 'rollback');
