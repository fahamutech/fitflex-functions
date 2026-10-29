// Marathon & running events — pricing an order from a price snapshot (D4: whole TZS integers, one
// currency per order). Pure: no I/O, nothing thrown for a business refusal.
//
//   quoteLines(ticketTypes, lines, { feeRule })
//     ticketTypes  the snapshot the order is priced from: [{ id, priceTzs, currency, name?, categoryId? }]
//                  (the rows as they were read under lock — NEVER re-read live prices for an existing order)
//     lines        [{ ticketTypeId, quantity, discountTzs? }] — discountTzs is SERVER-SIDE only: the store
//                  merges route-computed discounts in; a client's lines never carry it (review #242)
//     feeRule      how FitFlex's fee is worked out (configuration, not code):
//                    { type: 'none' }                                  (default: no fee)
//                    { type: 'percent', pct, minTzs?, maxTzs? }        per line: round(gross × pct / 100)
//                    { type: 'flat', perTicketTzs?, perOrderTzs? }     per ticket and/or per order
//   → { currency, lines: [{ ticketTypeId, quantity, unitPriceTzs, discountTzs, feesTzs, lineTotalTzs }],
//       subtotalTzs, discountTzs, feesTzs, totalTzs, snapshot: { ticketTypes, feeRule } }
//   → { error, status, ...extra } on a refusal (ticket_type_not_found 404, invalid_quantity 400,
//       invalid_discount 400, invalid_fee_rule 400, currency_mismatch 409, invalid_price_snapshot 500).
//
// Rounding: half up to the whole shilling (there are no cents). Every output is an integer.

const roundTzs = n => Math.floor(n + 0.5);
const isInt = n => Number.isInteger(n);
const fail = (error, status, extra = {}) => ({ error, status, ...extra });

export const NO_FEE = Object.freeze({ type: 'none' });

/**
 * The fee rule as it will be applied. null / undefined / { type: 'none' } = no fee. Anything else must be
 * well formed — percent 0..100 with sane bounds, flat with non-negative whole amounts — or it comes back as
 * { error: 'invalid_fee_rule', status: 400, reason } (review #242: a bad config value is never silently
 * turned into "no fee"). Exported so a config value can be checked.
 */
export function normaliseFeeRule(rule) {
  const bad = reason => ({ error: 'invalid_fee_rule', status: 400, reason });
  if (rule == null) return NO_FEE;
  if (typeof rule !== 'object') return bad('shape');
  if (rule.type === 'none') return NO_FEE;
  if (rule.type === 'percent') {
    const pct = Number(rule.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return bad('pct');
    if (rule.minTzs != null && (!isInt(rule.minTzs) || rule.minTzs < 0)) return bad('minTzs');
    const minTzs = rule.minTzs ?? 0;
    if (rule.maxTzs != null && (!isInt(rule.maxTzs) || rule.maxTzs < minTzs)) return bad('maxTzs');
    return { type: 'percent', pct, minTzs, maxTzs: rule.maxTzs ?? null };
  }
  if (rule.type === 'flat') {
    for (const key of ['perTicketTzs', 'perOrderTzs']) if (rule[key] != null && (!isInt(rule[key]) || rule[key] < 0)) return bad(key);
    return { type: 'flat', perTicketTzs: rule.perTicketTzs ?? 0, perOrderTzs: rule.perOrderTzs ?? 0 };
  }
  return bad('type');
}

/** The fee on one line's net amount (gross − discount), in whole TZS. */
function lineFee(rule, { net, quantity }) {
  if (rule.type === 'percent') {
    let fee = roundTzs(net * rule.pct / 100);
    if (net > 0 && fee < rule.minTzs) fee = rule.minTzs;
    if (rule.maxTzs != null && fee > rule.maxTzs) fee = rule.maxTzs;
    return fee;
  }
  if (rule.type === 'flat') return rule.perTicketTzs * quantity;
  return 0;
}

export function quoteLines(ticketTypes, lines, { feeRule = NO_FEE } = {}) {
  if (!Array.isArray(ticketTypes) || !Array.isArray(lines) || lines.length === 0) return fail('invalid_lines', 400);
  const rule = normaliseFeeRule(feeRule);
  if (rule.error) return rule;
  const byId = new Map();
  for (const tt of ticketTypes) {
    if (!tt || typeof tt.id !== 'string' || !isInt(tt.priceTzs) || tt.priceTzs < 0) return fail('invalid_price_snapshot', 500, { ticketTypeId: tt?.id ?? null });
    byId.set(tt.id, { id: tt.id, priceTzs: tt.priceTzs, currency: tt.currency || 'TZS', name: tt.name ?? null, categoryId: tt.categoryId ?? null });
  }
  const currencies = new Set([...byId.values()].map(t => t.currency));
  if (currencies.size > 1) return fail('currency_mismatch', 409, { currencies: [...currencies] });
  const currency = currencies.size ? [...currencies][0] : 'TZS';

  const out = [];
  const seen = new Set();
  let subtotalTzs = 0;
  let discountTzs = 0;
  let feesTzs = 0;
  for (const line of lines) {
    const ticketTypeId = line?.ticketTypeId;
    const tt = byId.get(ticketTypeId);
    if (!tt) return fail('ticket_type_not_found', 404, { ticketTypeId: ticketTypeId ?? null });
    if (seen.has(ticketTypeId)) return fail('duplicate_line', 400, { ticketTypeId });
    seen.add(ticketTypeId);
    const quantity = line.quantity;
    if (!isInt(quantity) || quantity < 1) return fail('invalid_quantity', 400, { ticketTypeId });
    const gross = tt.priceTzs * quantity;
    const discount = line.discountTzs ?? 0;
    if (!isInt(discount) || discount < 0 || discount > gross) return fail('invalid_discount', 400, { ticketTypeId });
    const net = gross - discount;
    const fee = lineFee(rule, { net, quantity });
    out.push({ ticketTypeId, quantity, unitPriceTzs: tt.priceTzs, discountTzs: discount, feesTzs: fee, lineTotalTzs: net + fee });
    subtotalTzs += gross;
    discountTzs += discount;
    feesTzs += fee;
  }
  if (rule.type === 'flat' && rule.perOrderTzs) feesTzs += rule.perOrderTzs;
  return {
    currency,
    lines: out,
    subtotalTzs,
    discountTzs,
    feesTzs,
    totalTzs: subtotalTzs - discountTzs + feesTzs,
    snapshot: { ticketTypes: [...byId.values()], feeRule: rule },
  };
}
