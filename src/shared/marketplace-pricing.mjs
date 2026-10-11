// Marketplace commission. Pure logic — no I/O.
//
// FitFlex takes a commission on each marketplace sale. The rate is set per
// vendor by FitFlex staff (10% unless changed) and is fixed on every order
// line when the order is placed, so a later change never alters an order
// already made. A product's sale price is the vendor's own; a vendor who
// discounts a product funds that discount.

export const VENDOR_COMMISSION_PCT = { default: 10, min: 0, max: 30 };

/** A vendor's commission rate: the one staff set, kept inside the allowed range. */
export function vendorCommissionPct(vendor) {
  const set = vendor?.vendorProfile?.commissionPct;
  const pct = Number(set);
  if (set == null || set === '' || !Number.isFinite(pct)) return VENDOR_COMMISSION_PCT.default;
  return Math.min(VENDOR_COMMISSION_PCT.max, Math.max(VENDOR_COMMISSION_PCT.min, pct));
}

/** Commission and vendor payout for one order line. */
export function priceOrderLine({ priceTzs, qty, commissionPct }) {
  const salesTzs = Math.max(0, Math.round(Number(priceTzs) || 0)) * Math.max(0, qty | 0);
  const commissionTzs = Math.round(salesTzs * (Number(commissionPct) || 0) / 100);
  return { salesTzs, commissionPct: Number(commissionPct) || 0, commissionTzs, vendorPayoutTzs: salesTzs - commissionTzs };
}

/**
 * What one vendor earns from an order: their lines only. Lines placed before
 * commission existed carry none, so the vendor is paid their full amount.
 */
export function vendorShareOfOrder(order, vendorId) {
  const lines = (order.items || []).filter(item => item.vendorId === vendorId);
  return lines.reduce((sum, item) => {
    const salesTzs = Number(item.priceTzs || 0) * Number(item.qty || 0);
    const commissionTzs = Number(item.commissionTzs || 0);
    return {
      itemCount: sum.itemCount + Number(item.qty || 0),
      salesTzs: sum.salesTzs + salesTzs,
      commissionTzs: sum.commissionTzs + commissionTzs,
      payoutTzs: sum.payoutTzs + (item.vendorPayoutTzs != null ? Number(item.vendorPayoutTzs) : salesTzs - commissionTzs),
    };
  }, { itemCount: 0, salesTzs: 0, commissionTzs: 0, payoutTzs: 0 });
}
