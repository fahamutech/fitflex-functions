// FR-K01 against the CI database: the nine KPI targets are seeded as
// assumptions, admins change them within each unit's range, confirm them,
// and every change is written to AuditLog with who and when.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/infra/knex-store.mjs';
import { auditLog } from '../src/bootstrap/collections.mjs';
import { createKpiTargetService } from '../src/services/kpi-target-service.mjs';

const AT = new Date('2026-11-24T08:00:00.000Z');
const svc = createKpiTargetService({ db, auditLog, now: () => AT, logger: { warn() {} } });
let saved;

before(async () => {
  saved = await db('KpiTarget').select('*');
});
after(async () => {
  for (const r of saved) await db('KpiTarget').where({ id: r.id }).update(r);
  await db('AuditLog').where({ action: 'kpi_target_updated', actor: 'admin_kpi_spec' }).del();
});

test('the nine targets are seeded in order, as unconfirmed proposals', async () => {
  const { targets } = await svc.list();
  assert.deepEqual(targets.map(t => t.id), [
    'pn_active_days', 'pn_programme_starts', 'pn_day7_completion', 'pn_meal_logging', 'pn_food_count', 'pn_month2_renewal',
    'wa_offer_reach', 'wa_offer_conversion', 'wa_cost_per_paid',
  ]);
  const starts = targets.find(t => t.id === 'pn_programme_starts');
  assert.deepEqual(
    { area: starts.area, unit: starts.unit, baseline: starts.baseline, draftTarget: starts.draftTarget, target: starts.target, assumption: starts.assumption },
    { area: 'programmes', unit: 'percent', baseline: '0', draftTarget: 35, target: 25, assumption: true },
  );
  assert.equal(targets.find(t => t.id === 'wa_cost_per_paid').unit, 'percent_lower');
  assert.ok(targets.every(t => t.assumption));
});

test('a change is saved, confirmed and audited with who and when', async () => {
  const { target } = await svc.update('admin_kpi_spec', 'pn_programme_starts', { target: 30, baseline: ' 2% ', confirmed: true });
  assert.equal(target.target, 30);
  assert.equal(target.baseline, '2%');
  assert.equal(target.assumption, false);
  assert.equal(target.confirmedBy, 'admin_kpi_spec');
  assert.equal(target.confirmedAt, AT.toISOString());
  assert.equal(target.updatedBy, 'admin_kpi_spec');
  const audit = await db('AuditLog').where({ action: 'kpi_target_updated', target: 'pn_programme_starts', actor: 'admin_kpi_spec' }).first();
  assert.ok(audit);
  assert.equal(new Date(audit.at).toISOString(), AT.toISOString());
  const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);
  assert.deepEqual(parse(audit.before), { target: 25, baseline: '0', assumption: true });
  assert.deepEqual(parse(audit.after), { target: 30, baseline: '2%', assumption: false });

  const back = await svc.update('admin_kpi_spec', 'pn_programme_starts', { confirmed: false });
  assert.equal(back.target.assumption, true);
  assert.equal(back.target.confirmedBy, null);
});

test('targets outside the unit\'s range, or bad fields, are refused', async () => {
  const refuse = async (id, body, field) => assert.deepEqual(
    await svc.update('admin_kpi_spec', id, body), { error: 'invalid_kpi_target', status: 400, field },
  );
  await refuse('pn_programme_starts', { target: 150 }, 'target');
  await refuse('pn_programme_starts', { target: '30' }, 'target');
  await refuse('pn_programme_starts', { target: 12.345 }, 'target');
  await refuse('pn_food_count', { target: -1 }, 'target');
  await refuse('pn_programme_starts', { baseline: 'x'.repeat(41) }, 'baseline');
  await refuse('pn_programme_starts', { confirmed: 'yes' }, 'confirmed');
  assert.equal((await svc.update('admin_kpi_spec', 'pn_food_count', { target: 500 })).target.target, 500);
  assert.equal((await svc.update('admin_kpi_spec', 'pn_active_days', { target: -10 })).target.target, -10);
});

test('nothing to change, or an unknown KPI, is said so', async () => {
  assert.deepEqual(await svc.update('admin_kpi_spec', 'pn_programme_starts', {}), { error: 'nothing_to_change', status: 400 });
  assert.deepEqual(await svc.update('admin_kpi_spec', 'nope', { target: 1 }), { error: 'not_found', status: 404 });
});

test('the database refuses an unknown unit or area', async () => {
  await assert.rejects(db('KpiTarget').insert({ id: 'kpi_spec_bad', area: 'programmes', sort: 99, unit: 'euros', target: 1 }), /kpi_target_unit_ck/);
  await assert.rejects(db('KpiTarget').insert({ id: 'kpi_spec_bad', area: 'shop', sort: 99, unit: 'count', target: 1 }), /kpi_target_area_ck/);
});
