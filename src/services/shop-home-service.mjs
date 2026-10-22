// Shop home — loads what the pure rules in shop-recommendations.mjs need and
// shapes the GET /shop/home answer. Persistence and the other services are
// injected; nothing here writes.
//
// What is shared by everyone (the buyer-visible catalogue, 30-day sales, the
// Featured list and which products hold a live promotion) is cached for
// `cacheSeconds`. What is about this shopper (their personas, a declared goal
// or specialty, their own vendor products, the `recent` ids) is read per request
// and never cached or stored. That includes, with SHOP_PERSONALISATION on, their
// "Personalised shop" switch and their own paid orders (purchase history).
import { buildShopHome, parseSectionList, DEFAULT_ASSEMBLY } from './shop-recommendations.mjs';
import { purchaseHistoryFrom, audienceFrom, historyDaysFromEnv } from './shop-personalisation.mjs';
import { shopBannersOn, shopPersonalisationOn } from '../shared/feature-flags.mjs';
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
  logger = console,
  config = () => shopHomeConfigFromEnv(),
  now = () => new Date(),
}) {
  let cache = null;    // { at, value }
  let loading = null;  // the rebuild in flight: concurrent requests wait for it instead of starting their own

  async function loadShared() {
    const cfg = config();
    const at = now().getTime();
    if (cache && at - cache.at < cfg.cacheSeconds * 1000) return cache.value;
    if (!loading) loading = rebuild(at).finally(() => { loading = null; });
    return loading;
  }

  async function rebuild(at) {
    const since = new Date(at - 30 * 86_400_000);
    const [products, orders, discovered] = await Promise.all([
      // With the vendor's target tags (for the gender/age reorder); they are taken off every row before it is sent.
      shopService.listProducts({ includeTargets: true }),
      recentPaidOrders({ since }),
      discoveryService.discover({ entityType: 'product', sort: 'relevance', limit: 1 }),
    ]);
    // Every live product promotion, wherever it is targeted (any area, any radius): none may sit in an organic section.
    const live = await promotionService.listLive({ entityType: 'product', anyLocation: true, checkEntities: false });
    const featured = (discovered?.featured || []).map(card => ({ productId: card.id, promotion: card.promotion }));
    // Vendors suspended on their account (not only in moderation) are left out of the home.
    const vendorIds = [...new Set(products.map(p => p.vendorId).filter(Boolean))];
    const vendors = vendorIds.length ? await users.filterByColumnInAsync('id', vendorIds) : [];
    const value = {
      products,
      suspendedVendorIds: vendors.filter(v => v.accountStatus === 'suspended').map(v => v.id),
      orders,
      featured,
      paidPlacementIds: [...new Set([...live.map(p => p.entityId), ...featured.map(f => f.productId)])],
    };
    cache = { at, value };
    return value;
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

    // Slice 2: read per request for this person only; never cached, never stored as a profile.
    let personalisation = null;
    let state = null;
    if (personalisationOn() && preferences) {
      state = await preferences.stateFor({ claims, user, personas, memberProfile });
      let history = null;
      if (state.enabled && buyerPaidOrders) {
        const since = new Date(at.getTime() - historyDays() * 86_400_000);
        const orders = await buyerPaidOrders({ buyerIds: state.buyerIds, since });
        const categories = new Map(shared.products.map(p => [p.id, p.category]));
        history = purchaseHistoryFrom(orders, { buyerIds: state.buyerIds, now: at, days: historyDays(), categoryOf: id => categories.get(id) || null });
      }
      personalisation = {
        optedOut: state.personalised === false,
        history,
        // Gender/age only with a valid adult date of birth (no date of birth: purchase history only).
        audienceFor: mode => (state.enabled && state.audienceAllowed ? audienceFrom({ mode, memberProfile, age: state.age }) : null),
      };
    }
    const out = buildShopHome({
      mode: query.mode, sessionUserType: claims.userType, heldUserTypes,
      memberProfile, trainerProfile, recentIds: query.recent, ownVendorIds,
      products: shared.products, suspendedVendorIds: shared.suspendedVendorIds, featured: shared.featured, paidPlacementIds: shared.paidPlacementIds, orders: shared.orders,
      config: cfg, now: at, personalisation,
    });
    if (out.error) return { error: out.error, status: 403 };

    // Product rows exactly as GET /shop/products returns them; Featured ones keep their disclosure tag.
    const rows = new Map(shared.products.map(p => [p.id, p]));
    const tags = new Map(shared.featured.map(f => [f.productId, f.promotion]));
    const featuredIds = new Set(out.sections.find(s => s.key === 'featured')?.productIds || []);
    const session = typeof query.session === 'string' ? query.session : null;
    const products = {};
    for (const section of out.sections) {
      for (const id of section.productIds) {
        const row = rows.get(id);
        const tag = featuredIds.has(id) ? tags.get(id) : null;
        if (!tag) { products[id] = withoutTargets(row); continue; }
        const { token, ...promotion } = tag;
        products[id] = {
          ...withoutTargets(row),
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

  return { home, clearCache: () => { cache = null; }, loadShared };
}
