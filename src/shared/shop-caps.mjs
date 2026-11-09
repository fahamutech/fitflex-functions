// What a shop client says it can show (contract revision 2, docs/shop-flash-sales-api.md).
//
// Header `X-FF-Shop-Caps: flash_sale[, other…]` — a list of capability tokens. Parsing is tolerant:
// commas, semicolons or spaces separate tokens; case and surrounding spaces are ignored; a repeated
// header is joined; unknown tokens are ignored. Only clients that send `flash_sale` get the
// `flash_sale` home section and the `sale` object on product rows. EVERYONE is charged the effective
// price (lowest-price rule) and sees `effectivePriceTzs`: a client that cannot show a sale still pays
// the lower price.
export const SHOP_CAPS_HEADER = 'x-ff-shop-caps';
export const CAP_FLASH_SALE = 'flash_sale';
const MAX_TOKENS = 20;
const MAX_TOKEN_LENGTH = 40;

/** The capability tokens a request names (lower case). */
export function shopCapsOf(req) {
  const raw = req?.get?.(SHOP_CAPS_HEADER) ?? req?.headers?.[SHOP_CAPS_HEADER];
  const text = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
  return new Set(text.split(/[\s,;]+/).map(t => t.trim().toLowerCase()).filter(t => t && t.length <= MAX_TOKEN_LENGTH).slice(0, MAX_TOKENS));
}

export const canShowFlashSales = req => shopCapsOf(req).has(CAP_FLASH_SALE);

/** A product row without its `sale` object (for clients that cannot show one). */
export function withoutSale(row) {
  if (!row || typeof row !== 'object' || !('sale' in row)) return row;
  const { sale, ...rest } = row;
  return rest;
}
