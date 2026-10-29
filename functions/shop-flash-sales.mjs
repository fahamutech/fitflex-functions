// Shop flash sales — REST surface (Phase 2 · slice 4). Contract: docs/shop-flash-sales-api.md.
// PRICING PATH (CONTRIBUTING rule 6): an approved sale changes what buyers pay inside its window.
//
// Dormant unless SHOP_FLASH_SALES is set: every route here answers 404 feature_disabled before sign-in
// is checked, so the surface is invisible.
//
//   Vendors: the vendor account, or vendor staff holding `products` (read from the stored staff record).
//   They act on their own proposals only; FitFlex-made sales on their products are read-only to them.
//   Admins: list (GET /admin/shop-merch?kind=flash_sale, in shop-banners.mjs) and detail with
//   `promotions` or `promotions_approve`; create, edit, send and withdraw FitFlex sales with
//   `promotions`; approve, reject and end with `promotions_approve` (never one's own: 403
//   cannot_approve_own_submission). Super-admins pass.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { flashSaleService as svc, shopService } from '../src/bootstrap/services.mjs';
import { shopFlashSalesOn } from '../src/shared/feature-flags.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';

const created = new Date().toISOString();

/** First guard on every route: with the flag off the routes do not exist. */
export const flashSalesEnabled = (_req, res, next) => (shopFlashSalesOn() ? next() : res.status(404).json({ error: 'feature_disabled' }));

/** vendor_staff must hold `products` on their stored staff record; the vendor account passes. */
async function requireProductsPermission(req, res, next) {
  if (req.user?.userType !== 'vendor_staff') return next();
  try {
    if (await shopService.authorizeStaff(req.user, 'products')) return next();
  } catch (error) {
    console.error('[flash-sales] staff authorization lookup failed', { staffId: req.user.sub, error: error.message });
    return res.status(503).json({ error: 'authorization_unavailable' });
  }
  return res.status(403).json({ error: 'vendor_permission_forbidden', requiredPermission: 'products' });
}

const vendorGuard = method => routeGuard(method, [flashSalesEnabled, requireAuth('vendor', 'vendor_staff'), requireProductsPermission]);
const adminView = method => routeGuard(method, [flashSalesEnabled, requireAuth('admin'), requireAcl('promotions', 'promotions_approve')]);
const adminManage = method => routeGuard(method, [flashSalesEnabled, requireAuth('admin'), requireAcl('promotions')]);
const adminApprove = method => routeGuard(method, [flashSalesEnabled, requireAuth('admin'), requireAcl('promotions_approve')]);

// Per vendor, per minute, in memory per server: 429 rate_limited { retryAfterSeconds }.
export const FLASH_SALE_RATE_LIMITS = Object.freeze({ create: 20, submit: 20, priceCheck: 60 });
const limiters = Object.fromEntries(Object.entries(FLASH_SALE_RATE_LIMITS).map(([k, perMinute]) => [k, createVendorLimiter({ perMinute })]));
export const resetFlashSaleLimits = () => Object.values(limiters).forEach(l => l.reset());
const vendorIdOf = req => (req.user.userType === 'vendor' ? req.user.sub : req.user.vendorId);
const limited = (kind, req, res) => limitOrNull(limiters[kind], vendorIdOf(req), res);
const vendorScope = req => ({ origin: 'vendor', vendorId: vendorIdOf(req) });
const STAFF = Object.freeze({ origin: 'staff' });
const hasScope = (req, scope) => !req.user?.portalUser || (req.user.aclPermissions || []).includes(scope);
export const flashSaleViewerOf = req => ({ actorId: req.user.sub, canManage: hasScope(req, 'promotions'), canApprove: hasScope(req, 'promotions_approve') });

function send(res, result, okStatus = 200) {
  const { error, status, ...payload } = result;
  if (error) return res.status(status || 400).json({ error, ...payload });
  return res.status(okStatus).json(payload);
}
/** { sale } out of an act() result ({ saved } → the caller's view). */
async function sendSale(res, result, read) {
  if (result.error) return send(res, result);
  return send(res, await read(result.saved.id));
}

const BODY = 'Body: productId (create only; fixed afterwards → 400 product_not_editable), salePriceTzs (whole TSh ≥ 1), startsAt, endsAt (ISO). Rules: ≥ 5 % below the regular price (422 discount_out_of_range { reason: below_minimum, maxSalePriceTzs }), below the current effective price incl. a standing discount (422 discount_out_of_range { reason: not_below_effective, effectivePriceTzs }), 1 hour to 7 days (422 sale_length_out_of_range | end_before_start), start ≥ 1 h ahead (422 start_too_soon { earliestStart }), no priceTzs raise after startsAt − 14 days (422 price_raised_recently { raisedAt, raisedOn, earliestStart }), no overlap with another approved or pending sale of the product (409 sale_overlap { saleId, startsAt, endsAt }).';

// ── Vendor ───────────────────────────────────────────────────────────────────

const vendorRead = req => id => svc.vendorGet({ vendorId: vendorIdOf(req), id });
const priceCheck = async (req, res) => limited('priceCheck', req, res)
  || send(res, await svc.priceCheck({ vendorId: vendorIdOf(req), productId: req.query?.productId, startsAt: req.query?.startsAt }));

export const vendorListFlashSales = {
  created, method: 'get', path: '/vendor/flash-sales',
  description: 'Vendor / staff with `products` (SHOP_FLASH_SALES): sales on my products, newest first — my proposals and (read-only) the ones FitFlex made once sent. ?status= (effective), ?productId=, ?limit (≤100, default 25), ?cursor. → { items: [sale], total, nextCursor, vendor: { canPropose, reason }, proposalExpiryDays, openProposals: { open, max }, rules }.',
  onGuard: vendorGuard('get'),
  onRequest: async (req, res) => send(res, await svc.vendorList({ vendorId: vendorIdOf(req), query: req.query || {} })),
};

export const vendorFlashSalePriceCheck = {
  created, method: 'get', path: '/vendor/flash-sales/price-check',
  description: 'Vendor / staff with `products` (SHOP_FLASH_SALES): the 14-day rule and price limits for one of my products. ?productId=&startsAt= (default now + 1 h). → { ok, productId, regularPriceTzs, discountPriceTzs, effectivePriceTzs, maxSalePriceTzs, raisedAt, raisedOn, earliestStart, lockedBy }. 60 a minute per vendor.',
  onGuard: vendorGuard('get'),
  onRequest: priceCheck,
};

export const vendorCreateFlashSale = {
  created, method: 'post', path: '/vendor/flash-sales',
  description: `Vendor / staff with \`products\` (SHOP_FLASH_SALES): start a flash sale on one of my products (a draft only I see). ${BODY} Another vendor's product → 403 not_your_product; not on sale → 422 product_not_eligible { reason }; vendor suspended / not approved → 403. More than SHOP_FLASH_SALE_MAX_OPEN (10) drafts + pending → 409 too_many_open_proposals. 20 a minute per vendor. → 201 { sale }.`,
  onGuard: vendorGuard('post'),
  onRequest: async (req, res) => limited('create', req, res) || send(res, await svc.create({ scope: vendorScope(req), actorId: req.user.sub, body: req.body || {} }), 201),
};

export const vendorGetFlashSale = {
  created, method: 'get', path: '/vendor/flash-sales/:id',
  description: 'Vendor / staff with `products` (SHOP_FLASH_SALES): one sale on my products. → { sale }. Not mine → 404 sale_not_found.',
  onGuard: vendorGuard('get'),
  // If this route is matched before /price-check, answer it here (same guard, same answer).
  onRequest: async (req, res) => (req.params.id === 'price-check' ? priceCheck(req, res) : send(res, await vendorRead(req)(req.params.id))),
};

export const vendorUpdateFlashSale = {
  created, method: 'patch', path: '/vendor/flash-sales/:id',
  description: `Vendor / staff with \`products\` (SHOP_FLASH_SALES): change my sale (any of salePriceTzs, startsAt, endsAt). ${BODY} Draft stays draft; pending stays pending; rejected → draft; scheduled → pending_approval (needs approval again). live | ended | expired | withdrawn → 409 not_editable. → { sale }.`,
  onGuard: vendorGuard('patch'),
  onRequest: async (req, res) => send(res, await svc.update({ scope: vendorScope(req), id: req.params.id, actorId: req.user.sub, body: req.body || {} })),
};

export const vendorSubmitFlashSale = {
  created, method: 'post', path: '/vendor/flash-sales/:id/submit',
  description: 'Vendor / staff with `products` (SHOP_FLASH_SALES): send a draft for approval (every rule re-checked). → { sale } (pending_approval; expiresAt = the earlier of now + 14 days and startsAt). Not a draft → 409 invalid_transition. 20 a minute per vendor.',
  onGuard: vendorGuard('post'),
  onRequest: async (req, res) => limited('submit', req, res) || sendSale(res, await svc.submit({ scope: vendorScope(req), id: req.params.id, actorId: req.user.sub }), vendorRead(req)),
};

export const vendorWithdrawFlashSale = {
  created, method: 'post', path: '/vendor/flash-sales/:id/withdraw',
  description: 'Vendor / staff with `products` (SHOP_FLASH_SALES): take my sale back before it goes live (draft, pending or scheduled → withdrawn). Live → 409 invalid_transition { hint: "end" }. → { sale }.',
  onGuard: vendorGuard('post'),
  onRequest: async (req, res) => sendSale(res, await svc.withdraw({ scope: vendorScope(req), id: req.params.id, actorId: req.user.sub }), vendorRead(req)),
};

export const vendorEndFlashSale = {
  created, method: 'post', path: '/vendor/flash-sales/:id/end',
  description: 'Vendor / staff with `products` (SHOP_FLASH_SALES): "End now" on my scheduled or live sale (→ ended, ended_by_vendor; buyers pay the normal price from the next request). FitFlex-made sales → 404 sale_not_found. → { sale }.',
  onGuard: vendorGuard('post'),
  onRequest: async (req, res) => sendSale(res, await svc.vendorEnd({ scope: vendorScope(req), id: req.params.id, actorId: req.user.sub }), vendorRead(req)),
};

// ── Admin ────────────────────────────────────────────────────────────────────

const adminRead = req => id => svc.adminGet({ id, viewer: flashSaleViewerOf(req) });

export const adminGetFlashSale = {
  created, method: 'get', path: '/admin/flash-sales/:id',
  description: 'Admin (promotions or promotions_approve; SHOP_FLASH_SALES): one sale with its history and price check. → { sale (admin view), history: [AuditLog flash_sale.* + actorName], priceCheck: { passes14DayRule, raisedAt, raisedOn, earliestStart, priceHistory (30 days), discountLine, priceChangedSinceSubmit } }.',
  onGuard: adminView('get'),
  onRequest: async (req, res) => send(res, await adminRead(req)(req.params.id)),
};

export const adminCreateFlashSale = {
  created, method: 'post', path: '/admin/flash-sales',
  description: `Admin (promotions; SHOP_FLASH_SALES): start a FitFlex flash sale on any vendor's product (origin staff, a draft; no vendor consent needed). ${BODY} → 201 { sale }.`,
  onGuard: adminManage('post'),
  onRequest: async (req, res) => send(res, await svc.create({ scope: STAFF, actorId: req.user.sub, body: req.body || {}, viewer: flashSaleViewerOf(req) }), 201),
};

export const adminUpdateFlashSale = {
  created, method: 'patch', path: '/admin/flash-sales/:id',
  description: 'Admin (promotions; SHOP_FLASH_SALES): change a FitFlex sale (same rules as the vendor PATCH). A vendor\'s sale → 404 sale_not_found. → { sale }.',
  onGuard: adminManage('patch'),
  onRequest: async (req, res) => send(res, await svc.update({ scope: STAFF, id: req.params.id, actorId: req.user.sub, body: req.body || {}, viewer: flashSaleViewerOf(req) })),
};

export const adminSubmitFlashSale = {
  created, method: 'post', path: '/admin/flash-sales/:id/submit',
  description: 'Admin (promotions; SHOP_FLASH_SALES): send a FitFlex sale for approval by ANOTHER admin. → { sale }.',
  onGuard: adminManage('post'),
  onRequest: async (req, res) => sendSale(res, await svc.submit({ scope: STAFF, id: req.params.id, actorId: req.user.sub }), adminRead(req)),
};

export const adminWithdrawFlashSale = {
  created, method: 'post', path: '/admin/flash-sales/:id/withdraw',
  description: 'Admin (promotions; SHOP_FLASH_SALES): take a FitFlex sale back before it goes live. → { sale }.',
  onGuard: adminManage('post'),
  onRequest: async (req, res) => sendSale(res, await svc.withdraw({ scope: STAFF, id: req.params.id, actorId: req.user.sub }), adminRead(req)),
};

export const adminApproveFlashSale = {
  created, method: 'post', path: '/admin/flash-sales/:id/approve',
  description: 'Admin (promotions_approve; SHOP_FLASH_SALES): approve a pending sale { revision (as reviewed; missing → 400 revision_required; changed → 409 sale_changed { revision }) }. Not one\'s own (403 cannot_approve_own_submission). Product price changed since it was sent → 409 sale_changed { reason: product_price_changed }; vendor suspended / not operational → 409 vendor_suspended | vendor_not_approved; past expiry → 409 proposal_expired; every rule re-checked (422 price_raised_recently, 422 discount_out_of_range, 409 sale_overlap, …). Sets wasPriceTzs; the vendor is notified. → { sale }.',
  onGuard: adminApprove('post'),
  onRequest: async (req, res) => sendSale(res, await svc.approve({ id: req.params.id, actorId: req.user.sub, revision: req.body?.revision }), adminRead(req)),
};

export const adminRejectFlashSale = {
  created, method: 'post', path: '/admin/flash-sales/:id/reject',
  description: 'Admin (promotions_approve; SHOP_FLASH_SALES): reject a pending sale { revision, code: price_not_credible|product|timing|other, note (the vendor sees it; required for other; ≤ 500) }. Not one\'s own. The vendor is notified. → { sale }.',
  onGuard: adminApprove('post'),
  onRequest: async (req, res) => sendSale(res, await svc.reject({ id: req.params.id, actorId: req.user.sub, revision: req.body?.revision, code: req.body?.code, note: req.body?.note }), adminRead(req)),
};

export const adminEndFlashSale = {
  created, method: 'post', path: '/admin/flash-sales/:id/end',
  description: 'Admin (promotions_approve; SHOP_FLASH_SALES): end a scheduled or live sale { note (1–500, the vendor sees it; `reason` accepted too) } → ended_by_fitflex. Allowed on one\'s own. The vendor is notified. → { sale }.',
  onGuard: adminApprove('post'),
  onRequest: async (req, res) => sendSale(res, await svc.end({ id: req.params.id, actorId: req.user.sub, reason: req.body?.note ?? req.body?.reason }), adminRead(req)),
};
