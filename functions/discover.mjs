// Discovery — ranked, filtered lists with promotion applied the way a customer can trust:
// a promotion only ever moves a result that already matches the search and filters,
// Featured and Sponsored are labelled, and an explicit sort switches promotion off.
// Additive: the plain /gyms, /trainers and /shop/products lists are unchanged.
import '../src/bootstrap/init.mjs';
import { requireAuth, bearerFrom, verify } from '../src/auth/jwt.mjs';
import { hideTrainerPass, canSeeTrainerPass } from '../src/shared/trainer-access.mjs';
import { isTokenSession } from '../src/auth/promotion-token.mjs';
import { discoveryService } from '../src/bootstrap/services.mjs';
import { publicGym } from '../src/services/gym-service.mjs';

const created = new Date().toISOString();

const FILTERS = ['tier', 'verified', 'specialty', 'category', 'brand', 'minPrice', 'maxPrice', 'minRating', 'delivery', 'maxDistanceKm'];
const claimsOf = req => { const t = bearerFrom(req); return t ? verify(t) : null; };
const number = v => (v === undefined || v === '' ? undefined : (Number.isFinite(Number(v)) ? Number(v) : undefined));

async function run(entityType, req, res, shape) {
  const claims = claimsOf(req);
  const out = await discoveryService.discover({
    entityType, q: req.query?.q ?? req.query?.search,
    filters: Object.fromEntries(FILTERS.filter(k => req.query?.[k] !== undefined).map(k => [k, req.query[k]])),
    lat: number(req.query?.lat), lng: number(req.query?.lng), areaId: req.query?.areaId,
    sort: req.query?.sort || 'relevance', placement: req.query?.placement, limit: req.query?.limit, cursor: req.query?.cursor,
    rotation: Number.isInteger(number(req.query?.rotation)) ? number(req.query.rotation) : undefined,
    // The app's session id: with it, each promoted card comes with a token proving it was served to that session.
    session: isTokenSession(req.query?.session) ? req.query.session : undefined,
    explain: claims?.userType === 'admin' && req.query?.explain === 'true',
    shape,
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  return res.json(out);
}

const QUERY_DOC = 'Query: ?q= search, ?lat=&lng= or ?areaId= for nearness and local promotions, ?sort=relevance|distance|rating|popularity|name (default relevance: promotions apply; any other sort turns them off), ?limit=&cursor= paging (send back the `rotation` of the first page with the cursor so equal results keep their order), ?session= (8-64 chars of A-Z a-z 0-9 _ -: each promoted card then carries promotion.token, which the app sends back with its events), and the filters. ?placement= overrides where promotions are read from.';

export const discoverGyms = {
  created, method: 'get', path: '/discover/gyms',
  description: `Public: gyms ranked for the viewer, with a Featured section and labelled promotions. Filters: ?tier=standard,premium &verified=true &maxDistanceKm= (needs lat/lng). ${QUERY_DOC}`,
  onRequest: async (req, res) => {
    const trainerPassVisible = canSeeTrainerPass(claimsOf(req)?.userType);
    return run('gym', req, res, g => (trainerPassVisible ? publicGym(g) : hideTrainerPass(publicGym(g))));
  },
};

export const discoverTrainers = {
  created, method: 'get', path: '/discover/trainers',
  description: `Public: trainers ranked for the viewer, with a Featured section and labelled promotions. Filters: ?specialty= &verified=true. ${QUERY_DOC}`,
  onRequest: async (req, res) => run('trainer', req, res, t => t),
};

export const discoverProducts = {
  created, method: 'get', path: '/discover/products',
  description: `Any signed-in user: shop products ranked for the viewer, with a Featured section and labelled promotions. Filters: ?category= &brand= &minPrice= &maxPrice= &minRating= &delivery=true &maxDistanceKm=. Also sorts price_asc and price_desc. ${QUERY_DOC}`,
  onGuard: requireAuth(),
  onRequest: async (req, res) => run('product', req, res, p => p),
};
