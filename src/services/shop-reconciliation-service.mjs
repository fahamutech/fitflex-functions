// Marketplace reconciliation: the internal books checked against themselves.
//
// There is no payment-provider ledger to compare with (shop payments are confirmed
// by hand, refunds are sent by hand), so this reconciles what FitFlex itself
// recorded: orders ↔ confirmed payments ↔ refunds ↔ stock ↔ vendor statements.
// Every check is read-only and returns the rows that need a person. When a
// provider integration exists, its transaction list is one more source here.
//
// Severity: P0 = money or goods may be wrong now; P1 = a recoverable state is
// waiting for staff; P2 = informational / housekeeping.

export function createShopReconciliationService({ db, now = () => new Date(), sampleSize = 25, staleRefundDays = 3 }) {
  const CHECKS = [
    {
      id: 'paid_without_confirmed_payment', severity: 'P0',
      description: 'Orders marked paid with no confirmed payment (and a price above zero).',
      query: () => db('ShopOrder as o').where('o.paymentStatus', 'paid').where('o.totalTzs', '>', 0)
        .whereNotExists(db('PaymentRequest as p').select(db.raw('1')).whereRaw('p."orderId" = o.id').where('p.status', 'approved'))
        .select('o.id', 'o.buyerId', 'o.totalTzs', 'o.status', 'o.createdAt'),
    },
    {
      id: 'confirmed_payment_order_not_paid', severity: 'P1',
      description: 'A payment was confirmed but its order was never marked paid (the system stopped part-way). Repair: POST /admin/marketplace/orders/:id/repair-payment.',
      query: () => db('PaymentRequest as p').join('ShopOrder as o', 'o.id', 'p.orderId').where('p.status', 'approved')
        .whereNotIn('o.paymentStatus', ['paid', 'refund_pending', 'refunded'])
        .select('o.id', 'o.buyerId', 'o.totalTzs', 'o.status', 'o.paymentStatus', 'p.id as paymentRequestId', 'p.decidedAt'),
    },
    {
      id: 'confirmed_payment_amount_differs', severity: 'P0',
      description: 'The confirmed payment is not the order total.',
      query: () => db('PaymentRequest as p').join('ShopOrder as o', 'o.id', 'p.orderId').where('p.status', 'approved')
        .whereRaw('p."amountTzs" <> o."totalTzs"')
        .select('o.id', 'o.totalTzs', 'p.amountTzs as paidTzs', 'p.id as paymentRequestId'),
    },
    {
      id: 'refund_owed_none_raised', severity: 'P1',
      description: 'The customer is owed money (refund_pending) but no refund exists. Repair: POST /admin/marketplace/orders/:id/raise-refund.',
      query: () => db('ShopOrder as o').where('o.paymentStatus', 'refund_pending')
        .whereNotExists(db('Refund as r').select(db.raw('1')).whereRaw('r."orderId" = o.id').whereNot('r.status', 'rejected'))
        .select('o.id', 'o.buyerId', 'o.totalTzs', 'o.updatedAt'),
    },
    {
      id: 'refund_paid_order_not_refunded', severity: 'P1',
      description: 'A refund was recorded as paid but its order still says refund_pending.',
      query: () => db('Refund as r').join('ShopOrder as o', 'o.id', 'r.orderId').where('r.kind', 'shop_order').where('r.status', 'paid')
        .whereNot('o.paymentStatus', 'refunded')
        .select('o.id', 'o.paymentStatus', 'r.id as refundId', 'r.paidAt'),
    },
    {
      id: 'refund_approved_not_paid', severity: 'P1',
      description: `An approved refund has waited more than ${staleRefundDays} days to be sent.`,
      query: () => db('Refund as r').where('r.kind', 'shop_order').where('r.status', 'approved')
        .where('r.createdAt', '<', new Date(+now() - staleRefundDays * 86_400_000))
        .select('r.id as refundId', 'r.orderId', 'r.amountTzs', 'r.createdAt'),
    },
    {
      id: 'refund_exceeds_payment', severity: 'P0',
      description: 'Refunds on an order add up to more than its confirmed payment.',
      query: () => db('Refund as r').join('ShopOrder as o', 'o.id', 'r.orderId').where('r.kind', 'shop_order').whereNot('r.status', 'rejected')
        .groupBy('o.id', 'o.totalTzs').havingRaw('SUM(r."amountTzs") > o."totalTzs"')
        .select('o.id', 'o.totalTzs', db.raw('SUM(r."amountTzs")::int as "refundedTzs"')),
    },
    {
      id: 'stock_state_inconsistent', severity: 'P0',
      description: 'A cancelled order still holds stock, or a live order has given its stock back.',
      query: () => db('ShopOrder as o').where((q) => q
        .where((c) => c.where('o.status', 'cancelled').where('o.stockState', 'reserved'))
        .orWhere((c) => c.whereNot('o.status', 'cancelled').where('o.stockState', 'released')))
        .select('o.id', 'o.status', 'o.stockState', 'o.paymentStatus'),
    },
    {
      id: 'negative_stock', severity: 'P0',
      description: 'A product has negative stock.',
      query: () => db('Product').where('stock', '<', 0).select('id', 'vendorId', 'name', 'stock'),
    },
    {
      id: 'refunded_order_in_vendor_statement', severity: 'P0',
      description: 'A cancelled or refunded order is on a vendor statement that has not been voided.',
      query: () => db('VendorSettlementLine as l').join('VendorSettlement as s', 's.id', 'l.vendorSettlementId').join('ShopOrder as o', 'o.id', 'l.orderId')
        .whereNot('s.status', 'voided').where('l.voided', false)
        .where((q) => q.where('o.status', 'cancelled').orWhereIn('o.paymentStatus', ['refund_pending', 'refunded']))
        .select('o.id as orderId', 'o.status', 'o.paymentStatus', 's.id as statementId', 's.status as statementStatus', 's.vendorId'),
    },
    {
      id: 'vendor_statement_total_mismatch', severity: 'P0',
      description: 'A vendor statement\'s net total is not the sum of its live lines.',
      query: () => db('VendorSettlement as s')
        .leftJoin('VendorSettlementLine as l', function join() { this.on('l.vendorSettlementId', 's.id').andOn('l.voided', db.raw('false')); })
        .whereNot('s.status', 'voided')
        .groupBy('s.id', 's.vendorId', 's.finalNetTzs', 's.status')
        .havingRaw('s."finalNetTzs" <> COALESCE(SUM(l."payoutTzs"), 0)')
        .select('s.id as statementId', 's.vendorId', 's.status', 's.finalNetTzs', db.raw('COALESCE(SUM(l."payoutTzs"), 0)::int as "linesTzs"')),
    },
    {
      id: 'order_share_on_two_live_statements', severity: 'P0',
      description: 'A vendor\'s share of an order is on more than one live statement (it would be paid twice).',
      query: () => db('VendorSettlementLine as l').join('VendorSettlement as s', 's.id', 'l.vendorSettlementId')
        .where('l.voided', false).whereNot('s.status', 'voided')
        .groupBy('l.orderId', 'l.vendorId').havingRaw('COUNT(*) > 1')
        .select('l.orderId', 'l.vendorId', db.raw('COUNT(*)::int as n')),
    },
    {
      id: 'settled_order_not_delivered_and_paid', severity: 'P0',
      description: 'An order marked settled that is not both delivered and paid.',
      query: () => db('ShopOrder as o').where('o.settlementStatus', 'settled')
        .where((q) => q.whereNotIn('o.status', ['delivered', 'fulfilled']).orWhereNot('o.paymentStatus', 'paid'))
        .select('o.id', 'o.status', 'o.paymentStatus', 'o.settlementStatus'),
    },
    {
      id: 'unpaid_past_reservation', severity: 'P2',
      description: 'Unpaid orders still holding stock after their reservation lapsed (the expiry job is off or behind).',
      query: () => db('ShopOrder as o').where({ 'o.status': 'pending', 'o.paymentStatus': 'pending', 'o.stockState': 'reserved' })
        .where('o.reservationExpiresAt', '<', now())
        .select('o.id', 'o.buyerId', 'o.totalTzs', 'o.reservationExpiresAt'),
    },
  ];

  /** Run every check. `ok` is true only when no P0 or P1 finding is open. */
  async function report() {
    const checks = [];
    for (const check of CHECKS) {
      const rows = await check.query().limit(sampleSize + 1);
      checks.push({
        id: check.id, severity: check.severity, description: check.description,
        count: rows.length > sampleSize ? `${sampleSize}+` : rows.length,
        sample: rows.slice(0, sampleSize),
      });
    }
    return {
      generatedAt: now().toISOString(),
      ok: checks.every(c => c.count === 0 || c.severity === 'P2'),
      open: checks.filter(c => c.count !== 0).map(c => `${c.severity} ${c.id}`),
      checks,
    };
  }

  return { report, checkIds: CHECKS.map(c => c.id) };
}
