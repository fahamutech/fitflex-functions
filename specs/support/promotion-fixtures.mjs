// A small in-memory world for the moderation & promotion service specs:
// collections that behave like the store's, a controllable clock, a few
// entities and a geography. No database.
import { createEntityResolver } from '../../src/services/promotion-entities.mjs';
import { createModerationService } from '../../src/services/moderation-service.mjs';
import { createPromotionService } from '../../src/services/promotion-service.mjs';

export function memStore(rows = []) {
  return {
    rows,
    async allAsync() { return rows.map(r => ({ ...r })); },
    async filterAsync(fn) { return rows.filter(fn).map(r => ({ ...r })); },
    async findAsync(fn) { const r = rows.find(fn); return r ? { ...r } : null; },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? { ...r } : null; },
    async insertAsync(row) { rows.push({ ...row }); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] ? { ...rows[i] } : null;
    },
    async removeAsync(fn) { const i = rows.findIndex(fn); if (i >= 0) rows.splice(i, 1); },
  };
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = new Date('2026-10-10T09:00:00.000Z');

export function makeClock(start = T0) {
  let t = start.getTime();
  return { now: () => new Date(t), set: d => { t = new Date(d).getTime(); }, advance: ms => { t += ms; } };
}

export const iso = (clock, offsetMs) => new Date(clock.now().getTime() + offsetMs).toISOString();

export function makeWorld({ operational = () => true } = {}) {
  const clock = makeClock();
  const stores = {
    gyms: memStore([
      { id: 'gym_a', name: 'Gym A', location: 'Stone Town, Zanzibar', status: 'active', homepageVisible: true, regionId: 'tz-znz', cityId: 'tz-znz-city' },
      { id: 'gym_b', name: 'Gym B', location: 'Dar es Salaam', status: 'active', homepageVisible: true, regionId: 'tz-dar', cityId: 'tz-dar-city' },
      { id: 'gym_c', name: 'Gym C', location: 'Arusha', status: 'active', homepageVisible: true },
      { id: 'gym_off', name: 'Closed Gym', status: 'inactive', homepageVisible: true },
    ]),
    trainers: memStore([{ id: 'tr_1', userId: 'usr_t1', displayName: 'Trainer One', specialties: ['boxing'], status: 'active', approvalStatus: 'approved' }]),
    users: memStore([
      { id: 'usr_v1', userType: 'vendor', approvalStatus: 'approved', accountStatus: 'active', vendorProfile: { businessName: 'Vendor One', status: 'published' } },
      { id: 'usr_v_draft', userType: 'vendor', approvalStatus: 'approved', accountStatus: 'active', vendorProfile: { businessName: 'Draft Vendor', status: 'draft' } },
    ]),
    products: memStore([{ id: 'prod_1', vendorId: 'usr_v1', name: 'Whey', category: 'supplements', status: 'active', approvalStatus: 'approved', visibility: 'visible' }]),
    moderationStates: memStore(),
    moderationEvents: memStore(),
    geoAreas: memStore([
      { id: 'tz', level: 'country', name: 'Tanzania', parentId: null },
      { id: 'tz-dar', level: 'region', name: 'Dar es Salaam', parentId: 'tz' },
      { id: 'tz-dar-city', level: 'city', name: 'Dar es Salaam', parentId: 'tz-dar' },
      { id: 'tz-znz', level: 'region', name: 'Zanzibar', parentId: 'tz' },
      { id: 'tz-znz-city', level: 'city', name: 'Zanzibar City', parentId: 'tz-znz' },
      { id: 'tz-znz-stone-town', level: 'district', name: 'Stone Town', parentId: 'tz-znz-city' },
    ]),
    organizations: memStore([
      { id: 'org_1', legalName: 'Safari Insurance Ltd', tradingName: 'Safari Cover', organizationType: 'insurer', status: 'active' },
      { id: 'org_2', legalName: 'Kilimo Bank', tradingName: null, organizationType: 'employer', status: 'active' },
    ]),
    campaigns: memStore(),
    promotions: memStore(),
    placements: memStore(),
    configs: memStore(),
    auditLog: memStore(),
  };
  const auditLog = stores.auditLog;
  const partnerGate = { isOperational: async userId => operational(userId) };
  const entities = createEntityResolver({ gyms: stores.gyms, trainers: stores.trainers, users: stores.users, products: stores.products, partnerGate });
  let promotionService;
  const moderationService = createModerationService({
    states: stores.moderationStates, events: stores.moderationEvents, entities, auditLog, now: clock.now,
    onEntityBlocked: (...a) => promotionService.holdForEntity(...a),
  });
  promotionService = createPromotionService({
    promotions: stores.promotions, placements: stores.placements, campaigns: stores.campaigns, configs: stores.configs,
    geoAreas: stores.geoAreas, entities, moderation: moderationService, auditLog, organizations: stores.organizations, now: clock.now,
  });
  return { clock, stores, entities, moderationService, promotionService };
}

/** A valid promotion body for a gym, starting in an hour and running a week. */
export function promoBody(clock, over = {}) {
  return {
    entityType: 'gym', entityId: 'gym_a', type: 'featured', placements: ['gym_discovery'],
    startsAt: iso(clock, HOUR), endsAt: iso(clock, 7 * DAY), priority: 3, ...over,
  };
}

/** Create, submit (as `maker`) and approve (as `checker`) a promotion. */
export async function approved(world, over = {}, { maker = 'admin_maker', checker = 'admin_checker' } = {}) {
  const { promotionService: svc, clock } = world;
  const created = await svc.create({ body: promoBody(clock, over), actorId: maker });
  if (created.error) throw new Error(`create: ${JSON.stringify(created)}`);
  const id = created.promotion.id;
  const submitted = await svc.submit({ id, actorId: maker });
  if (submitted.error) throw new Error(`submit: ${JSON.stringify(submitted)}`);
  const ok = await svc.approve({ id, actorId: checker });
  if (ok.error) throw new Error(`approve: ${JSON.stringify(ok)}`);
  return ok.promotion;
}
