// Promotion performance bench. Seeds a large synthetic catalogue, promotions and
// events into the CI database, then times the hot paths. Run:
//   FITFLEX_USE_CI_DB=1 KYC_ENFORCEMENT=off node scripts/promotion-bench.mjs [gyms] [promotions] [events]
// It only ever writes rows whose ids start with "bench_" and removes them at the end.
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { promotionService, discoveryService, promotionAnalyticsService, moderationGate } from '../src/bootstrap/services.mjs';
import { listGyms } from '../functions/gyms.mjs';

const N_GYMS = Number(process.argv[2] || 3000);
const N_PROMOS = Number(process.argv[3] || 300);
const N_EVENTS = Number(process.argv[4] || 500000);
const HOUR = 3_600_000;
const t = async (label, fn, runs = 5) => {
  const times = [];
  let out;
  for (let i = 0; i < runs; i += 1) { const s = performance.now(); out = await fn(); times.push(performance.now() - s); }
  times.sort((a, b) => a - b);
  console.log(`${label.padEnd(58)} median ${times[Math.floor(times.length / 2)].toFixed(0).padStart(6)} ms   max ${times[times.length - 1].toFixed(0).padStart(6)} ms`);
  return out;
};
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

async function cleanup() {
  await db('PromotionEvent').where('promotionId', 'like', 'bench_%').del();
  await db('PromotionPlacement').where('promotionId', 'like', 'bench_%').del();
  await db('Promotion').where('id', 'like', 'bench_%').del();
  await db('ModerationState').where('entityId', 'like', 'bench_%').del();
  await db('Gym').where('id', 'like', 'bench_%').del();
}
await cleanup();
const names = ['Iron', 'Zen', 'Power', 'Knockout', 'Flex', 'Calm', 'Titan', 'Coast', 'Peak', 'Urban'];
const kinds = ['Boxing Gym', 'Yoga Studio', 'Fitness', 'CrossFit', 'Health Club'];
const gyms = Array.from({ length: N_GYMS }, (_, i) => ({
  id: `bench_gym_${i}`, name: `${names[i % 10]} ${kinds[i % 5]} ${i}`, tier: ['standard', 'midtier', 'premium'][i % 3], location: i % 2 ? 'Dar es Salaam' : 'Zanzibar',
  status: 'active', amenities: ['sauna', 'pool'].slice(0, (i % 3)), coordinates: JSON.stringify({ lat: -6.8 + (i % 100) * 0.01, lng: 39.2 + (i % 50) * 0.01 }),
  rating: (i % 50) / 10, reviewCount: i % 40, homepagePriority: i % 5, updatedAt: new Date(),
}));
for (let i = 0; i < gyms.length; i += 500) await db('Gym').insert(gyms.slice(i, i + 500));
const hidden = gyms.slice(0, Math.floor(N_GYMS / 15)).map(g => ({ id: `gym:${g.id}`, entityType: 'gym', entityId: g.id, status: i => 'hidden' }));
await db('ModerationState').insert(hidden.map(h => ({ ...h, status: 'hidden' })));
const placements = ['gym_discovery', 'search_results', 'home'];
const promos = Array.from({ length: N_PROMOS }, (_, i) => ({
  id: `bench_promo_${i}`, entityType: 'gym', entityId: gyms[N_GYMS - 1 - i].id, type: ['featured', 'promoted', 'sponsored', 'recommended'][i % 4],
  status: 'active', startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + 30 * 24 * HOUR), priority: 1 + (i % 20), boostWeight: 1,
  geoScope: JSON.stringify({ areaIds: i % 3 ? [] : ['tz-znz'] }), audience: '{}', categories: '[]', isCommercial: i % 4 === 2, relationshipType: i % 4 === 2 ? 'paid_advertising' : null,
  createdBy: 'bench', updatedAt: new Date(),
}));
await db('Promotion').insert(promos);
await db('PromotionPlacement').insert(promos.flatMap((p, i) => [{ id: `${p.id}:${placements[i % 3]}`, promotionId: p.id, placement: placements[i % 3] }]));
// Events in bulk with SQL generate_series: realistic skew (impressions >> clicks).
await db.raw(`
  insert into "PromotionEvent" (id, at, event, "entityType", "entityId", "promotionId", placement, "userId", "sessionId", source)
  select 'bench_ev_' || g, now() - (random() * interval '30 days'),
         (array['impression','impression','impression','impression','impression','impression','click','detail_view','save','booking_click'])[1 + floor(random()*10)::int],
         'gym', 'bench_gym_' || ((?::int - 1) - (g % ?::int)), 'bench_promo_' || (g % ?::int), (array['gym_discovery','search_results','home'])[1 + (g % 3)],
         case when g % 3 = 0 then 'bench_user_' || (g % 5000) else null end, 'bench_sess_' || (g % 20000), 'mobile'
  from generate_series(1, ?::int) g`, [N_GYMS, N_PROMOS, N_PROMOS, N_EVENTS]);
await db.raw('analyze "PromotionEvent"');
console.log(`seeded ${N_GYMS} gyms, ${N_PROMOS} live promotions, ${N_EVENTS} events\n`);

await t('GET /gyms (existing list, with moderation filter)', async () => { const r = res(); await listGyms.onRequest({ headers: {}, query: {} }, r); return r.body.length; });
await t('moderationGate.blocked(gym)', () => moderationGate.blocked('gym'));
await t('promotionService.listLive (gym_discovery)', () => promotionService.listLive({ placement: 'gym_discovery', entityType: 'gym', viewer: { areaIds: ['tz-znz'] } }));
await t('promotionService.listLive (search_results)', () => promotionService.listLive({ placement: 'search_results', entityType: 'gym', viewer: {} }));
await t('discover gyms: browse, no filters', () => discoveryService.discover({ entityType: 'gym', limit: 20 }));
await t('discover gyms: browse + position', () => discoveryService.discover({ entityType: 'gym', lat: -6.8, lng: 39.2, limit: 20 }));
await t('discover gyms: search "boxing gym"', () => discoveryService.discover({ entityType: 'gym', q: 'boxing gym', limit: 20 }));
await t('discover gyms: search "zen" + tier filter', () => discoveryService.discover({ entityType: 'gym', q: 'zen', filters: { tier: 'premium' }, limit: 20 }));
await t('discover gyms: sort=rating (promotion off)', () => discoveryService.discover({ entityType: 'gym', sort: 'rating', limit: 20 }));
await t('analytics summary (30 days, all promotions)', () => promotionAnalyticsService.summary({}), 3);
await t('analytics summary (filtered to one type)', () => promotionAnalyticsService.summary({ type: 'featured' }), 3);
await t('analytics detail (one promotion, 30 days)', () => promotionAnalyticsService.detail('bench_promo_1', {}), 3);
await t('analytics detail (one promotion, 399 days)', () => promotionAnalyticsService.detail('bench_promo_1', { from: new Date(Date.now() - 398 * 24 * HOUR).toISOString().slice(0, 10) }), 3);
await t('events purge (nothing old)', () => import('../src/bootstrap/services.mjs').then(m => m.promotionEventsService.purge()), 3);
await cleanup();
await db.destroy();
