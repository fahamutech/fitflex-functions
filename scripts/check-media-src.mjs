#!/usr/bin/env node
// Report only: stored image sources that the media rule (src/shared/media-src.mjs, security fix
// 2026-10-28) would refuse if they were sent as NEW values today — anything that is not a
// data:image/(png|jpeg|webp) URI that decodes, or our own /storage/<cid>/<file> path.
//
// Such values are still accepted unchanged on the record that holds them (so saves keep working);
// this report is how the owner decides whether to clear them. It changes nothing: every query runs
// in a READ ONLY transaction.
//
// Checked: vendor logo / banner (User.vendorProfile), account photo (User.photoUrl), trainer
// photoUrl / images / imageThumbnails (TrainerProfile), gym images / thumbnails (Gym), product
// images (Product).
//
// Prints counts per field and reason, and the HOSTS of refused http(s) values (never the full URL
// and never data). --list also prints the record ids per refused value.
//
// The database is never guessed and .env is not read:
//   DATABASE_URL=postgres://… node scripts/check-media-src.mjs [--list]
//   FITFLEX_USE_CI_DB=1 DATABASE_URL_CI=postgres://… node scripts/check-media-src.mjs [--list]
// The database name is printed before anything else.
import knex from 'knex';
import { mediaSrcProblem } from '../src/shared/media-src.mjs';

const list = process.argv.includes('--list');
const url = process.env.FITFLEX_USE_CI_DB === '1' ? process.env.DATABASE_URL_CI : process.env.DATABASE_URL;
if (!url) {
  console.error('Refusing to run: set DATABASE_URL (or FITFLEX_USE_CI_DB=1 with DATABASE_URL_CI).');
  process.exit(2);
}
const db = knex({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });

const asList = (v) => {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.startsWith('[')) { try { const p = JSON.parse(v); return Array.isArray(p) ? p : [v]; } catch { return [v]; } }
  return [v];
};
const asObject = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
};
const hostOf = (v) => { try { return new URL(v).host || '(none)'; } catch { return null; } };

// [table, columns, (row) → { field: values[] }]
const SOURCES = [
  ['User', ['id', 'photoUrl', 'vendorProfile'], row => {
    const vp = asObject(row.vendorProfile);
    return { 'User.photoUrl': asList(row.photoUrl), 'vendorProfile.logo': asList(vp.logo), 'vendorProfile.banner': asList(vp.banner) };
  }],
  ['TrainerProfile', ['id', 'photoUrl', 'images', 'imageThumbnails'], row => ({
    'TrainerProfile.photoUrl': asList(row.photoUrl), 'TrainerProfile.images': asList(row.images), 'TrainerProfile.imageThumbnails': asList(row.imageThumbnails),
  })],
  ['Gym', ['id', 'images', 'thumbnails'], row => ({ 'Gym.images': asList(row.images), 'Gym.thumbnails': asList(row.thumbnails) })],
  ['Product', ['id', 'images'], row => ({ 'Product.images': asList(row.images) })],
];
const BATCH = 100;

try {
  await db.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    const { rows: [{ name }] } = await trx.raw('SELECT current_database() AS name');
    console.log(`Database: ${name} (read only)`);
    const report = {};
    for (const [table, columns, pick] of SOURCES) {
      let lastId = '';
      for (;;) {
        const rows = await trx(table).select(columns).where('id', '>', lastId).orderBy('id').limit(BATCH);
        if (!rows.length) break;
        lastId = rows[rows.length - 1].id;
        for (const row of rows) {
          for (const [field, values] of Object.entries(pick(row))) {
            const r = (report[field] ||= { values: 0, ok: 0, refused: {}, hosts: {}, ids: {} });
            for (const value of values) {
              if (value == null || value === '') continue;
              r.values += 1;
              const reason = await mediaSrcProblem(value);
              if (!reason) { r.ok += 1; continue; }
              r.refused[reason] = (r.refused[reason] || 0) + 1;
              const host = typeof value === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('data:') ? hostOf(value) : null;
              if (host) r.hosts[host] = (r.hosts[host] || 0) + 1;
              if (list) (r.ids[reason] ||= new Set()).add(row.id);
            }
          }
        }
      }
    }
    let refusedTotal = 0;
    for (const [field, r] of Object.entries(report)) {
      const refused = Object.values(r.refused).reduce((a, b) => a + b, 0);
      refusedTotal += refused;
      console.log(`${field}: ${r.values} value(s), ${r.ok} ok, ${refused} would be refused as new`);
      for (const [reason, n] of Object.entries(r.refused)) console.log(`  ${reason}: ${n}${list ? ` — ids: ${[...r.ids[reason]].join(', ')}` : ''}`);
      for (const [host, n] of Object.entries(r.hosts)) console.log(`  host ${host}: ${n}`);
    }
    console.log(refusedTotal ? `Total refused-as-new values: ${refusedTotal} (kept on their records; nothing changed).` : 'No stored value would be refused.');
  });
} finally {
  await db.destroy();
}
