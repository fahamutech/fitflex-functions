// What a buyer pays for a shop product. Pure — no I/O. PRICING PATH (CONTRIBUTING rule 6).
//
// standingPrice(product) is the price every buyer path used before flash sales (and still uses with
// SHOP_FLASH_SALES off): the seller's discount price when it is set and below the price, else the price.
//
// effectivePrice(product, sale, now) adds flash sales (Phase 2 · slice 4): the LOWEST of the price, a
// valid discount price, and the sale price of an approved sale of this very product and vendor whose
// window [startsAt, endsAt) contains `now` — the server's clock, to the millisecond. A sale that is not
// below the standing price changes nothing (and is not shown as a sale).
//
// Whether the product may be sold at all (listing, vendor and moderation gates) is decided by the
// caller before it asks for a price: a product that is not sold has no price here.

const int = v => Math.round(Number(v) || 0);
const ms = v => (v == null ? NaN : new Date(v).getTime());

/** The seller's own price: discountPriceTzs when 0 < discount < price, else priceTzs. */
export function standingPrice(product) {
  const price = int(product?.priceTzs);
  const discount = int(product?.discountPriceTzs);
  return discount > 0 && discount < price ? discount : price;
}

/** The standing discount price when it applies (0 < discount < price), else null. */
export function validDiscount(product) {
  const price = int(product?.priceTzs);
  const discount = int(product?.discountPriceTzs);
  return discount > 0 && discount < price ? discount : null;
}

/** Is `sale` live for `product` at `now`? Approved, same product and vendor, inside its window, a real price. */
export function saleLiveFor(product, sale, now = new Date()) {
  if (!product || !sale || sale.status !== 'approved') return false;
  if (sale.productId !== product.id || sale.vendorId !== product.vendorId) return false;
  const t = ms(now);
  const start = ms(sale.startsAt);
  const end = ms(sale.endsAt);
  if (!Number.isFinite(t) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (t < start || t >= end) return false;
  const price = int(sale.salePriceTzs);
  return price > 0 && price < standingPrice(product);
}

/**
 * → { priceTzs, source: 'regular' | 'discount' | 'flash_sale', sale } — the unit price charged now and
 * where it came from; `sale` is the live sale that set it, else null.
 */
export function priceBreakdown(product, sale = null, now = new Date()) {
  const standing = standingPrice(product);
  if (saleLiveFor(product, sale, now)) return { priceTzs: int(sale.salePriceTzs), source: 'flash_sale', sale };
  return { priceTzs: standing, source: validDiscount(product) != null ? 'discount' : 'regular', sale: null };
}

/** The unit price charged now (see priceBreakdown). */
export const effectivePrice = (product, sale = null, now = new Date()) => priceBreakdown(product, sale, now).priceTzs;

/** floor((regular − sale) × 100 / regular), 0 when not a discount. */
export function discountPct(regularTzs, saleTzs) {
  const r = int(regularTzs);
  const s = int(saleTzs);
  if (!(r > 0) || !(s < r)) return 0;
  return Math.floor(((r - s) * 100) / r);
}

/**
 * The `sale` object buyer rows carry while a sale is live:
 * { id, salePriceTzs, wasPriceTzs, regularPriceTzs, discountPct, startsAt, endsAt }.
 */
export function saleView(product, sale) {
  const was = int(sale.wasPriceTzs) || int(product.priceTzs);
  return {
    id: sale.id,
    salePriceTzs: int(sale.salePriceTzs),
    wasPriceTzs: was,
    regularPriceTzs: int(product.priceTzs),
    discountPct: discountPct(was, sale.salePriceTzs),
    startsAt: new Date(sale.startsAt).toISOString(),
    endsAt: new Date(sale.endsAt).toISOString(),
  };
}

/**
 * A buyer row with its price now: + effectivePriceTzs, + sale (only while live). The stored priceTzs
 * and discountPriceTzs are left as they are. `saleOf(productId)` → the approved sale row or null.
 */
export function withPrice(row, saleOf, now) {
  const sale = saleOf(row.id) || null;
  const p = priceBreakdown(row, sale, now);
  return p.sale ? { ...row, effectivePriceTzs: p.priceTzs, sale: saleView(row, p.sale) } : { ...row, effectivePriceTzs: p.priceTzs };
}
