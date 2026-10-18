// Shop home — one call for the landing page of the shop: role-aware sections
// over the existing catalogue. Additive: /shop/products, /discover/products,
// cart and checkout are unchanged. Dormant unless SHOP_HOME_V2 is set.
// Contract: docs/shop-home-api.md.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { isTokenSession } from '../src/auth/promotion-token.mjs';
import { shopHomeService } from '../src/bootstrap/services.mjs';
import { shopHomeV2On } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();

export const shopHome = {
  created, method: 'get', path: '/shop/home',
  description: 'Any signed-in user (SHOP_HOME_V2): the shop landing page. Query: ?mode=member|trainer|owner|vendor_personal (a role this account holds; default = the signed-in role; otherwise 403 mode_not_allowed), ?recent=<comma ids, most recent first, max 20; never stored>, ?session=<promotion session id: Featured cards then carry promotion.token>. → { serverNow, currency, mode, personalised, signalsUsed, categories:[{key,en,sw,count}], sections:[{key,title{en,sw},reason{en,sw},reasonCodes,viewAll{path,query},productIds,hasMore}], products:{ id: product as in GET /shop/products } }. Out of stock and the viewer\'s own products never appear; a product is in one section at most; sections with fewer than SHOP_HOME_MIN_ITEMS (4) products are left out. Flag off: 404 feature_disabled.',
  responseSample: {
    serverNow: '2026-10-19T08:00:00.000Z', currency: 'TZS', mode: 'member', personalised: false, signalsUsed: ['role'],
    categories: [{ key: 'equipment', en: 'Gym & fitness equipment', sw: 'Vifaa vya gym na mazoezi', count: 12 }],
    sections: [{ key: 'best_sellers', title: { en: 'Best sellers', sw: 'Zinazouzwa zaidi' }, reason: { en: 'The most bought on FitFlex in the last 30 days.', sw: 'Zilizonunuliwa zaidi kwenye FitFlex katika siku 30 zilizopita.' }, reasonCodes: ['best_sellers_30d'], viewAll: { path: '/shop/products', query: { sort: 'popularity' } }, productIds: ['prd_1'], hasMore: false }],
    products: { prd_1: { id: 'prd_1', name: 'Whey Protein 1kg', priceTzs: 85000 } },
  },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    if (!shopHomeV2On()) return res.status(404).json({ error: 'feature_disabled' });
    const q = req.query || {};
    const out = await shopHomeService.home({
      claims: req.user,
      query: { mode: q.mode, recent: q.recent, session: isTokenSession(q.session) ? q.session : undefined },
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    return res.json(out.body);
  },
};
