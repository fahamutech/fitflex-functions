// Shop home — loads what the pure rules in shop-recommendations.mjs need and
// shapes the GET /shop/home answer. Persistence and the other services are
// injected; nothing here writes.
//
// What is shared by everyone (the buyer-visible catalogue, 30-day sales, the
// Featured list and which products hold a live promotion) is cached for
// `cacheSeconds`. What is about this shopper (their personas, a declared goal
// or specialty, their own vendor products, the `recent` ids) is read per request
// and never cached or stored. That includes, with SHOP_PERSONALISATION on, their
// "Personalised shop" switch and their own paid orders (purchase history), and, with SHOP_NEAR_YOU on,
// the `areaId` the device worked out: used for this one answer only, never cached, stored or logged.
// The areas, vendors' areas and pickup gyms' cities (non-personal) are part of the shared cache.
import { buildShopHome, parseSectionList, DEFAULT_ASSEMBLY } from './shop-recommendations.mjs';
import { purchaseHistoryFrom, audienceFrom, historyDaysFromEnv } from './shop-personalisation.mjs';
import { shopBannersOn, shopPersonalisationOn, shopNearYouOn, shopFlashSalesOn } from '../shared/feature-flags.mjs';
import { saleLiveFor, saleView, withPrice } from '../shared/shop-pricing.mjs';
import { indexAreas, resolveViewerArea, vendorAreasOf, deliversTo, deliversExactly, basedIn, publicAreas, minRadiusFromEnv } from '../shared/shop-areas.mjs';

/**
 * Privacy (review M2, owner 2026-10-22: k = 5): a product counts as popular in a city only when at least
 * this many DISTINCT buyers picked it up at gyms there in the last 30 days, and a city (or region) needs
 * at least this many distinct buyers overall before any local ranking is used. Below that: 0.
 */
export const NEAR_MIN_BUYERS = 5;
import { withoutTargets } from '../shared/product-targets.mjs';

const usable = p => !p.portalOnly && p.accountStatus !== 'suspended' && p.approvalStatus !== 'rejected';
const positiveInt = (v, fallback) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

export const CACHE_SECONDS = Object.freeze({ default: 60, min: 1, max: 300 });

/** Assembly settings from the environment: SHOP_HOME_SECTIONS, SHOP_HOME_MIN_ITEMS, SHOP_HOME_CACHE_SECONDS. */
export function shopHomeConfigFromEnv(env = process.env) {
  return {
    sections: parseSectionList(env.SHOP_HOME_SECTIONS),
    minItems: positiveInt(env.SHOP_HOME_MIN_ITEMS, DEFAULT_ASSEMBLY.minItems),
    maxItems: DEFAULT_ASSEMBLY.maxItems,
    // Bounded both ways: never rebuilt on every request, never stale for more than five minutes.
    cacheSeconds: Math.min(CACHE_SECONDS.max, Math.max(CACHE_SECONDS.min, positiveInt(env.SHOP_HOME_CACHE_SECONDS, CACHE_SECONDS.default))),
  };
}

export function createShopHomeService({
  shopService,          // listProducts(): the buyer-visible catalogue (listing, KYC and moderation rules)
  discoveryService,     // discover(): the existing Featured system for products
  promotionService,     // listLive(): which products hold a live promotion of any kind
  users, trainerService, identityLink,
  recentPaidOrders,     // ({ since }) → paid, not cancelled orders placed since then: [{ buyerRole, items, createdAt }]
  signToken = null,     // ({ promotionId, entityType, entityId, sessionId, now }) → proof that a promoted card was served
  // ({ mode, products, ownVendorIds, at }) → live banners (SHOP_BANNERS). Read on every request, never cached.
  bannerFeed = null,
  bannersOn = shopBannersOn,
  // Slice 2 (SHOP_PERSONALISATION): the switch (shop-preference-service.stateFor) and the person's
  // own orders: ({ buyerIds, since }) → paid, not cancelled orders of those buyers placed since then.
  preferences = null,
  buyerPaidOrders = null,
  personalisationOn = shopPersonalisationOn,
  historyDays = () => historyDaysFromEnv(),
  // Slice 3 (SHOP_NEAR_YOU): GeoArea rows ({ allAsync }) and () → [{ id, cityId, regionId }] of gyms (pickup points).
  geoAreas = null,
  gymAreas = null,
  nearYouOn = shopNearYouOn,
  // M1: the minimum area size the shop uses ({ district, city } km; floors 2 and 5).
  minRadius = () => minRadiusFromEnv(),
  // Slice 4 (SHOP_FLASH_SALES; PRICING PATH): flash-sale-service `pricing` ({ liveByProduct(ids|null, at) → Map }).
  // Read on every request by the server clock, never cached: the shared catalogue cache holds stored prices only.
  flashSales = null,
  flashSalesOn = shopFlashSalesOn,
  logger = console,
  config = () => shopHomeConfigFromEnv(),
  now = () => new Date(),
}) {
  let cache = null;    // { at, value }
  let loading = null;  // the rebuild in flight: concurrent requests wait for it instead of starting their own

  async function loadShared() {
    const cfg = config();
    const at = now().getTime();
    // A cache built while SHOP_NEAR_YOU was off has no area data: rebuild once it is on.
    const fresh = cache && at - cache.at < cfg.cacheSeconds * 1000 && (!nearWanted() || cache.value.near);
    if (fresh) return cache.value;
    if (!loading) loading = rebuild(at).finally(() => { loading = null; });
    return loading;
  }

  const nearWanted = () => Boolean(geoAreas) && nearYouOn();

  /**
   * Non-personal area data for near-you: the area index, each vendor's areas, and per city / region the
   * local pickup counts — distinct buyers per product, kept only at or above NEAR_MIN_BUYERS, and only
   * where the area has at least NEAR_MIN_BUYERS distinct buyers overall. Buyer ids are counted here and
   * then dropped: the cache keeps numbers, never who bought.
   */
  async function loadNear(vendors, orders) {
    const [areaRows, gymRows] = await Promise.all([geoAreas.allAsync(), gymAreas ? gymAreas() : []]);
    const index = indexAreas(areaRows);
    const vendorAreas = new Map(vendors.map(v => [v.id, vendorAreasOf(v.vendorProfile, index)]));
    const gymArea = new Map((gymRows || []).map(g => [g.id, { cityId: g.cityId || null, regionId: g.regionId || null }]));
    const raw = new Map(); // 'city:<id>' | 'region:<id>' → { buyers: Set, products: Map(productId → Set(buyerId)) }
    for (const order of orders || []) {
      if (order.paymentStatus !== undefined && order.paymentStatus !== 'paid') continue;
      const g = order.pickupGymId ? gymArea.get(order.pickupGymId) : null;
      if (order.status === 'cancelled' || !g || !order.buyerId) continue;
      for (const key of [g.cityId && `city:${g.cityId}`, g.regionId && `region:${g.regionId}`].filter(Boolean)) {
        const a = raw.get(key) || { buyers: new Set(), products: new Map() };
        a.buyers.add(order.buyerId);
        for (const id of new Set((order.items || []).map(i => i?.productId).filter(Boolean))) {
          if (!a.products.has(id)) a.products.set(id, new Set());
          a.products.get(id).add(order.buyerId);
        }
        raw.set(key, a);
      }
    }
    const localSales = new Map();
    for (const [key, a] of raw) {
      if (a.buyers.size < NEAR_MIN_BUYERS) continue;
      const counts = new Map([...a.products].filter(([, b]) => b.size >= NEAR_MIN_BUYERS).map(([id, b]) => [id, b.size]));
      if (counts.size) localSales.set(key, counts);
    }
    return { index, vendorAreas, localSales };
  }

  async function rebuild(at) {
    const since = new Date(at - 30 * 86_400_000);
    const [products, orders, discovered] = await Promise.all([
      // With the vendor's target tags (for the gender/age reorder); they are taken off every row before it is sent.
      // applySales false: sale prices are worked out per answer (below), never cached here.
      shopService.listProducts({ includeTargets: true, applySales: false }),
      recentPaidOrders({ since }),
      discoveryService.discover({ entityType: 'product', sort: 'relevance', limit: 1 }),
    ]);
    // Every live product promotion, wherever it is targeted (any area, any radius): none may sit in an organic section.
    const live = await promotionService.listLive({ entityType: 'product', anyLocation: true, checkEntities: false });
    const featured = (discovered?.featured || []).map(card => ({ productId: card.id, promotion: card.promotion }));
    // Vendors suspended on their account (not only in moderation) are left out of the home.
    const vendorIds = [...new Set(products.map(p => p.vendorId).filter(Boolean))];
    const vendors = vendorIds.length ? await users.filterByColumnInAsync('id', vendorIds) : [];
    // M2: the local counts need who bought (distinct buyers); computed once, then buyer ids are not cached.
    const near = nearWanted() ? await loadNear(vendors, orders) : null;
    const value = {
      products,
      suspendedVendorIds: vendors.filter(v => v.accountStatus === 'suspended').map(v => v.id),
      orders: (orders || []).map(({ buyerId, pickupGymId, ...rest }) => rest),
      featured,
      paidPlacementIds: [...new Set([...live.map(p => p.entityId), ...featured.map(f => f.productId)])],
      ...(near ? { near } : {}),
    };
    cache = { at, value };
    return value;
  }

  /**
   * needs.location for this viewer: which vendors are based in or deliver to the area, and the local
   * counts (distinct buyers, k-thresholded in loadNear) for the viewer's city, or region for a
   * region-level viewer. Home-delivery addresses are free text and are not read.
   */
  function nearLocation(shared, viewer) {
    const vendors = new Map();
    for (const [vendorId, areasOfVendor] of shared.near.vendorAreas) {
      const m = { basedIn: basedIn(areasOfVendor, viewer), delivers: deliversTo(areasOfVendor, viewer), deliversExact: deliversExactly(areasOfVendor, viewer) };
      if (m.basedIn || m.delivers) vendors.set(vendorId, m);
    }
    const key = viewer.cityId ? `city:${viewer.cityId}` : viewer.regionId ? `region:${viewer.regionId}` : null;
    const areaSales = (key && shared.near.localSales.get(key)) || new Map();
    return { area: { areaId: viewer.areaId, name: viewer.name, names: viewer.names, rankArea: viewer.rankArea, cityId: viewer.cityId, regionId: viewer.regionId, chain: viewer.chain }, vendors, areaSales };
  }

  const nearYouOf = (state, viewer, shared) => ({
    available: Boolean(state?.enabled && shared.near),
    ...(viewer ? { areaId: viewer.areaId, areaName: { ...viewer.names } } : {}),
  });

  /**
   * QA1: the "Delivers to your area" badge outside the home (GET /shop/products, /shop/products/:id).
   * Same validation and gating as /shop/home: SHOP_NEAR_YOU on, personalisation available and switched
   * on, a usable and locatable area. → null (no badge at all; the caller leaves the body unchanged) or
   * vendorId → true when that vendor delivers to the area. Reads the shared cache (vendor areas may be up
   * to SHOP_HOME_CACHE_SECONDS old); the area is used for this call only, never stored or logged.
   */
  async function deliveryBadge({ claims, areaId }) {
    if (!areaId || !nearWanted() || !personalisationOn() || !preferences) return null;
    const shared = await loadShared();
    if (!shared.near) return null;
    const state = await preferences.stateFor({ claims });
    if (!state.enabled) return null;
    const viewer = resolveViewerArea(shared.near.index, areaId, minRadius());
    if (!viewer) return null;
    return vendorId => deliversTo(shared.near.vendorAreas.get(vendorId), viewer);
  }

  /**
   * QA2 (spec §7.3): once areas exist (SHOP_NEAR_YOU on and at least one usable area), the vendor-typed
   * distance is not used anywhere in the shop, so ?maxDistanceKm= is ignored. Flag off: false (as before).
   */
  async function vendorDistanceIgnored() {
    if (!nearWanted()) return false;
    return (await areas()).length > 0;
  }

  /** GET /shop/areas: the usable areas (non-personal; too-small areas carry no circle). */
  async function areas() {
    if (!geoAreas) return [];
    return publicAreas(await geoAreas.allAsync(), minRadius());
  }

  /** The persona rows of this person (or just the signed-in row for an account without a Person). */
  async function personasOf(user) {
    if (!user?.personId || !identityLink) return [];
    return (await identityLink.personasOf(user.personId)).filter(usable);
  }

  async function home({ claims, query = {} }) {
    const user = await users.findByIdAsync(claims.sub);
    const personas = await personasOf(user);
    const heldUserTypes = personas.map(p => p.userType);
    const personaOf = type => (claims.userType === type ? claims.sub : personas.find(p => p.userType === type)?.id || null);

    // Declared profile fields only: a member's fitness goal, a trainer's specialties.
    const memberId = personaOf('member');
    const memberProfile = memberId ? (memberId === user?.id ? user : await users.findByIdAsync(memberId))?.memberProfile || null : null;
    const trainerUserId = personaOf('trainer');
    const trainerProfile = trainerUserId && trainerService ? trainerService.findProfileByUser(trainerUserId) : null;
    // A vendor never sees their own products on the home, in any mode.
    const ownVendorIds = [...personas.filter(p => p.userType === 'vendor').map(p => p.id), claims.userType === 'vendor' ? claims.sub : null, claims.vendorId || null];

    const shared = await loadShared();
    const cfg = config();
    const at = now();
    const rows0 = new Map(shared.products.map(p => [p.id, p]));

    // Slice 2: read per request for this person only; never cached, never stored as a profile.
    let personalisation = null;
    let state = null;
    let viewer = null;
    if (personalisationOn() && preferences) {
      state = await preferences.stateFor({ claims, user, personas, memberProfile });
      let history = null;
      if (state.enabled && buyerPaidOrders) {
        const since = new Date(at.getTime() - historyDays() * 86_400_000);
        const orders = await buyerPaidOrders({ buyerIds: state.buyerIds, since });
        const categories = new Map(shared.products.map(p => [p.id, p.category]));
        history = purchaseHistoryFrom(orders, { buyerIds: state.buyerIds, now: at, days: historyDays(), categoryOf: id => categories.get(id) || null });
      }
      // Slice 3: the viewer's area only when near-you is on and personalisation is on for this person.
      if (nearYouOn() && state.enabled && shared.near) viewer = resolveViewerArea(shared.near.index, query.areaId, minRadius());
      personalisation = {
        location: viewer ? nearLocation(shared, viewer) : null,
        optedOut: state.personalised === false,
        // Not available (no member persona, invalid date of birth, under 18): no declared goal or
        // specialty either, so the page matches GET /shop/preferences `uses: []` (QA 2026-10-22).
        profileSignals: state.available,
        history,
        // Gender/age only with a valid adult date of birth (no date of birth: purchase history only).
        audienceFor: mode => (state.enabled && state.audienceAllowed ? audienceFrom({ mode, memberProfile, age: state.age }) : null),
      };
    }
    // Slice 4: the sales live now, for products this catalogue lists (its listing, KYC, moderation and
    // suspension gates already applied). A failed read leaves the page at stored prices, with no rail.
    let liveSales = null;
    if (flashSales && flashSalesOn()) {
      liveSales = new Map();
      try {
        const live = await flashSales.liveByProduct(null, at);
        for (const row of shared.products) {
          const sale = live.get(row.id);
          if (sale && saleLiveFor(row, sale, at)) liveSales.set(row.id, sale);
        }
      } catch (err) {
        logger.error?.('[shop-home] flash sales failed:', err?.message);
      }
    }
    const railSales = liveSales ? new Map([...liveSales].map(([id, sale]) => [id, saleView(rows0.get(id), sale)])) : null;
    const out = buildShopHome({
      mode: query.mode, sessionUserType: claims.userType, heldUserTypes,
      memberProfile, trainerProfile, recentIds: query.recent, ownVendorIds,
      products: shared.products, suspendedVendorIds: shared.suspendedVendorIds, featured: shared.featured, paidPlacementIds: shared.paidPlacementIds, orders: shared.orders,
      config: cfg, now: at, personalisation, flashSales: railSales,
    });
    if (out.error) return { error: out.error, status: 403 };

    // Product rows exactly as GET /shop/products returns them; Featured ones keep their disclosure tag.
    const rows = new Map(shared.products.map(p => [p.id, p]));
    const tags = new Map(shared.featured.map(f => [f.productId, f.promotion]));
    const featuredIds = new Set(out.sections.find(s => s.key === 'featured')?.productIds || []);
    const session = typeof query.session === 'string' ? query.session : null;
    const products = {};
    // Slice 3: the "Delivers to your area" badge. Set only to true, never false.
    const delivers = id => Boolean(viewer) && deliversTo(shared.near.vendorAreas.get(rows.get(id)?.vendorId), viewer);
    // Slice 4: + effectivePriceTzs, + sale while live (flag on only; off the rows are exactly as before).
    const priceRow = row => (liveSales ? withPrice(row, id => liveSales.get(id), at) : row);
    const badge = (id, row) => { const r = priceRow(row); return delivers(id) ? { ...r, deliversToViewerArea: true } : r; };
    for (const section of out.sections) {
      for (const id of section.productIds) {
        const row = rows.get(id);
        const tag = featuredIds.has(id) ? tags.get(id) : null;
        if (!tag) { products[id] = badge(id, withoutTargets(row)); continue; }
        const { token, ...promotion } = tag;
        products[id] = {
          ...badge(id, withoutTargets(row)),
          promotion: { ...promotion, ...(signToken && session ? { token: signToken({ promotionId: tag.id, entityType: 'product', entityId: id, sessionId: session, now: at }) } : {}) },
        };
      }
    }
    const body = {
      serverNow: at.toISOString(),
      currency: 'TZS',
      mode: out.mode,
      // True only when a personal signal (slice 2, SHOP_PERSONALISATION) actually changed the page.
      personalised: state ? out.personalised : false,
      // Slice 2: only with SHOP_PERSONALISATION on; off, the body is exactly as before.
      ...(state ? { personalisation: { available: state.available, enabled: state.enabled } } : {}),
      // Slice 3: only with SHOP_NEAR_YOU on; off, the body is exactly as before.
      ...(nearYouOn() ? { nearYou: nearYouOf(state, viewer, shared) } : {}),
      // Slice 4: only with SHOP_FLASH_SALES on; off, the body is exactly as before.
      ...(liveSales ? { flashSales: { enabled: true } } : {}),
      signalsUsed: out.signalsUsed,
      categories: out.categories,
      allProductsCount: out.allProductsCount,
      sections: out.sections,
      products,
    };
    // Phase 2 · slice 1: with SHOP_BANNERS off the body is exactly as before (no `banners` key).
    if (bannerFeed && bannersOn()) {
      try {
        body.banners = await bannerFeed({ mode: out.mode, products: shared.products, ownVendorIds, at });
      } catch (err) {
        // The rest of the page still loads; the app shows its fallback slide.
        logger.error?.('[shop-home] banners failed:', err?.message);
        body.banners = [];
      }
    }
    return { body };
  }

  return { home, clearCache: () => { cache = null; }, loadShared, areas, deliveryBadge, vendorDistanceIgnored };
}
