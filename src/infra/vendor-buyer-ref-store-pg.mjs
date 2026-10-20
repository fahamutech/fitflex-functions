// Vendor tools · S2 — vendor-scoped buyer pseudonyms (table VendorBuyerRef).
//
// refsFor(vendorId, buyerIds) → Map(buyerId → customerId). Missing pairs are created (random id,
// ON CONFLICT DO NOTHING, then read back), so two requests at once agree on one customerId.
// S4 (#224): a buyer whose account was deleted gets no new pseudonym (their refs are deleted on account
// deletion): only buyers who still have a User row are created; others stay absent (customerId null).
import { randomUUID } from 'node:crypto';

export const newCustomerId = () => `cus_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

export function createPgVendorBuyerRefStore({ db }) {
  async function read(vendorId, buyerIds) {
    const rows = await db('VendorBuyerRef').where({ vendorId }).whereIn('buyerId', buyerIds).select('buyerId', 'customerId');
    return new Map(rows.map(r => [r.buyerId, r.customerId]));
  }
  async function refsFor(vendorId, buyerIds) {
    const ids = [...new Set((buyerIds || []).filter(Boolean).map(String))];
    if (!vendorId || !ids.length) return new Map();
    const found = await read(vendorId, ids);
    const missing = ids.filter(id => !found.has(id));
    if (!missing.length) return found;
    const existing = new Set((await db('User').whereIn('id', missing).select('id')).map(u => u.id));
    const creatable = missing.filter(id => existing.has(id));
    if (!creatable.length) return found;
    await db('VendorBuyerRef')
      .insert(creatable.map(buyerId => ({ vendorId, buyerId, customerId: newCustomerId() })))
      .onConflict(['vendorId', 'buyerId']).ignore();
    return read(vendorId, ids);
  }
  /** S4: which of these customerIds have a VendorCustomer record at this vendor (so a profile link opens). */
  async function linkedCustomerIds(vendorId, customerIds) {
    const ids = [...new Set((customerIds || []).filter(Boolean).map(String))];
    if (!vendorId || !ids.length) return new Set();
    const rows = await db('VendorCustomer').where({ vendorId }).whereIn('id', ids).select('id');
    return new Set(rows.map(r => r.id));
  }
  return { refsFor, linkedCustomerIds };
}

/** Same contract, in memory (unit specs and wiring without a database). */
export function createMemoryVendorBuyerRefStore() {
  const refs = new Map();
  return {
    async refsFor(vendorId, buyerIds) {
      const out = new Map();
      if (!vendorId) return out;
      for (const buyerId of new Set((buyerIds || []).filter(Boolean).map(String))) {
        const key = `${vendorId}\u0000${buyerId}`;
        if (!refs.has(key)) refs.set(key, newCustomerId());
        out.set(buyerId, refs.get(key));
      }
      return out;
    },
    async linkedCustomerIds() { return new Set(); },
  };
}
