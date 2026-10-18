// Shop home — loads what the pure rules in shop-recommendations.mjs need and
// shapes the GET /shop/home answer. Persistence and the other services are
// injected; nothing here writes.
//
// What is shared by everyone (the buyer-visible catalogue, 30-day sales, the
// Featured list and which products hold a live promotion) is cached for
// `cacheSeconds`. What is about this shopper (their personas, a declared goal
// or specialty, their own vendor products, the `recent` ids) is read per request
// and never cached or stored.
import { buildShopHome, parseSectionList, DEFAULT_ASSEMBLY } from './shop-recommendations.mjs';

const usable = p => !p.portalOnly && p.accountStatus !== 'suspended' && p.approvalStatus !== 'rejected';
const positiveInt = (v, fallback) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

/** Assembly settings from the environment: SHOP_HOME_SECTIONS, SHOP_HOME_MIN_ITEMS, SHOP_HOME_CACHE_SECONDS. */
export function shopHomeConfigFromEnv(env = process.env) {
  return {
    sections: parseSectionList(env.SHOP_HOME_SECTIONS),
    minItems: positiveInt(env.SHOP_HOME_MIN_ITEMS, DEFAULT_ASSEMBLY.minItems),
    maxItems: DEFAULT_ASSEMBLY.maxItems,
    cacheSeconds: env.SHOP_HOME_CACHE_SECONDS !== undefined && Number.isInteger(Number(env.SHOP_HOME_CACHE_SECONDS)) && Number(env.SHOP_HOME_CACHE_SECONDS) >= 0
      ? Number(env.SHOP_HOME_CACHE_SECONDS) : 60,
  };
}

export function createShopHomeService({
  shopService,          // listProducts(): the buyer-visible catalogue (listing, KYC and moderation rules)
  discoveryService,     // discover(): the existing Featured system for products
  promotionService,     // listLive(): which products hold a live promotion of any kind
  geoAreas,             // so area-targeted promotions are counted as paid placements too
  users, trainerService, identityLink,
  recentPaidOrders,     // ({ since }) → paid, not cancelled orders placed since then: [{ buyerRole, items, createdAt }]
  signToken = null,     // ({ promotionId, entityType, entityId, sessionId, now }) → proof that a promoted card was served
  config = () => shopHomeConfigFromEnv(),
  now = () => new Date(),
}) {
  let cache = null; // { at, value }

  async function loadShared() {
    const cfg = config();
    const at = now().getTime();
    if (cache && at - cache.at < cfg.cacheSeconds * 1000) return cache.value;
    const since = new Date(at - 30 * 86_400_000);
    const [products, orders, discovered, areas] = await Promise.all([
      shopService.listProducts({}),
      recentPaidOrders({ since }),
      discoveryService.discover({ entityType: 'product', sort: 'relevance', limit: 1 }),
      geoAreas.allAsync(),
    ]);
    // Every live product promotion, wherever it is targeted: none of them may sit in the organic section.
    const live = await promotionService.listLive({ entityType: 'product', viewer: { areaIds: areas.map(a => a.id) }, checkEntities: false });
    const featured = (discovered?.featured || []).map(card => ({ productId: card.id, promotion: card.promotion }));
    const value = {
      products,
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
    const out = buildShopHome({
      mode: query.mode, sessionUserType: claims.userType, heldUserTypes,
      memberProfile, trainerProfile, recentIds: query.recent, ownVendorIds,
      products: shared.products, featured: shared.featured, paidPlacementIds: shared.paidPlacementIds, orders: shared.orders,
      config: cfg, now: at,
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
        if (!tag) { products[id] = row; continue; }
        const { token, ...promotion } = tag;
        products[id] = {
          ...row,
          promotion: { ...promotion, ...(signToken && session ? { token: signToken({ promotionId: tag.id, entityType: 'product', entityId: id, sessionId: session, now: at }) } : {}) },
        };
      }
    }
    return {
      body: {
        serverNow: at.toISOString(),
        currency: 'TZS',
        mode: out.mode,
        // Phase 1 uses no personal signals (purchase history, gender/age, location are Phase 2).
        personalised: false,
        signalsUsed: out.signalsUsed,
        categories: out.categories,
        sections: out.sections,
        products,
      },
    };
  }

  return { home, clearCache: () => { cache = null; } };
}
