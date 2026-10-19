// Vendor stock rules (vendor business tools · S1). Pure functions: no storage.
//
// - A product's `variants` is a list of { name, stock? }. A variant with a numeric `stock` keeps
//   its own count ("tracked"). With the stock ledger on, either every variant is tracked or none
//   is (Q-6), and when they are, Product.stock is the sum of the variants (O-1).
// - Cost price and reorder level are private to the vendor: they live in ProductPrivate, never
//   in Product.variants (the public shop returns Product rows as they are).

export const MAX_STOCK = 1_000_000;
export const MAX_COST_TZS = 100_000_000;
export const MAX_NOTE = 200;

/** Reasons a vendor may give for an adjustment (POST /vendor/products/:id/stock-adjustments). */
export const ADJUST_REASONS = ['count', 'damaged', 'expired', 'lost', 'found', 'returned', 'restock', 'other'];
const IN_REASONS = new Set(['found', 'returned', 'restock']);
const OUT_REASONS = new Set(['damaged', 'expired', 'lost']);

/** Keys that are the vendor's own business and never stored on the public Product row. */
const PRIVATE_KEYS = ['costTzs', 'reorderLevel', 'effectiveCostTzs', 'effectiveReorderLevel'];
export function stripPrivate(variant) {
  const copy = { ...(variant || {}) };
  for (const key of PRIVATE_KEYS) delete copy[key];
  return copy;
}

export const isTracked = variant => typeof variant?.stock === 'number';

export function variantsOf(product) {
  const raw = typeof product?.variants === 'string' ? JSON.parse(product.variants) : product?.variants;
  return Array.isArray(raw) ? raw.filter(v => v && typeof v === 'object') : [];
}

const isWhole = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;

/** Cost and reorder level: absent, null (clear) or a whole number in range. null when fine, else the field. */
export function invalidPrivateField(body) {
  if (body.costTzs !== undefined && body.costTzs !== null && !isWhole(body.costTzs, MAX_COST_TZS)) return 'costTzs';
  if (body.reorderLevel !== undefined && body.reorderLevel !== null && !isWhole(body.reorderLevel, MAX_STOCK)) return 'reorderLevel';
  return null;
}

const blank = value => (value === undefined || value === null || value === '' ? null : value);
const publicShape = variant => {
  const { stock, ...rest } = stripPrivate(variant);
  return JSON.stringify(Object.keys(rest).sort().map(key => [key, rest[key]]));
};

/**
 * Did the vendor change what FitFlex reviews? Only a value that differs from the stored one counts
 * (F1: the app sends every field on every save). `variants` is the merged list about to be stored.
 */
export function reviewChanged(current, input, variants = null) {
  if (input.name !== undefined && String(input.name).trim() !== String(current.name ?? '').trim()) return true;
  for (const field of ['description', 'category', 'brand']) {
    if (input[field] !== undefined && blank(input[field]) !== blank(current[field])) return true;
  }
  if (input.priceTzs !== undefined && Number(input.priceTzs) !== Number(current.priceTzs ?? 0)) return true;
  if (input.discountPriceTzs !== undefined && Number(input.discountPriceTzs || 0) !== Number(current.discountPriceTzs || 0)) return true;
  if (Array.isArray(input.images) && JSON.stringify(input.images) !== JSON.stringify(Array.isArray(current.images) ? current.images : [])) return true;
  if (variants) {
    const before = variantsOf(current).map(publicShape);
    const after = variants.map(publicShape);
    if (before.length !== after.length || before.some((v, i) => v !== after[i])) return true;
  }
  return false;
}

/**
 * The stock side of a product save.
 *   current  the stored product (locked when `ledger`), or null when creating
 *   input    the request body
 *   ledger   the stock ledger is on (VENDOR_TOOLS + VENDOR_STOCK_LEDGER)
 * Returns { error, status, ... } or
 *   { variants?, stock?, movements: [{ variant, delta, stockBefore, stockAfter, note }], removed: [names] }
 * `variants` / `stock` are present only when they are to be written.
 *
 * Always (F3): incoming variants are merged with the stored ones by name; a variant whose body has
 * no `stock` keeps its stored count; private keys never reach the Product row.
 * Ledger on: removing a variant that still has stock is refused (Q-2); tracked and untracked
 * variants may not be mixed (Q-6) — on an edit of a tracked product a new variant starts at 0;
 * tracked variants set Product.stock to their sum (O-1); every count that changes is returned as a
 * `count` movement so the caller records it in the ledger.
 */
export function planStock(current, input, { ledger = false } = {}) {
  const creating = !current;
  const stored = creating ? [] : variantsOf(current);
  const byName = new Map(stored.map(v => [v.name, v]));
  const currentStock = creating ? 0 : Number(current.stock || 0);
  let merged = null;
  let removed = [];

  if (Array.isArray(input.variants)) {
    if (ledger) {
      const seen = new Set();
      for (const v of input.variants) {
        const key = String(v.name).trim().toLowerCase();
        if (seen.has(key)) return { error: 'duplicate_variant', status: 400, variant: String(v.name).trim() };
        seen.add(key);
      }
    }
    merged = input.variants.map((v) => {
      const name = String(v.name).trim();
      const old = byName.get(name);
      const { stock: oldStock, ...oldRest } = stripPrivate(old || {});
      const { stock, ...rest } = stripPrivate(v);
      const next = { ...oldRest, ...rest, name };
      if (stock != null) next.stock = Number(stock);
      else if (isTracked(old)) next.stock = oldStock;
      return next;
    });
    const names = new Set(merged.map(v => v.name));
    removed = stored.filter(v => !names.has(v.name));
    if (ledger) {
      const holding = removed.find(v => isTracked(v) && v.stock > 0);
      if (holding) return { error: 'variant_has_stock', status: 409, variant: holding.name, stock: holding.stock };
      const tracked = merged.filter(isTracked).length;
      if (tracked && tracked < merged.length) {
        if (creating || !stored.some(isTracked)) return { error: 'variant_stock_mixed', status: 400 };
        merged = merged.map(v => (isTracked(v) ? v : { ...v, stock: 0 }));
      }
    }
  }

  const finalVariants = merged ?? stored;
  const out = { movements: [], removed: removed.map(v => v.name) };
  if (merged) out.variants = merged;

  if (!ledger) {
    if (input.stock !== undefined) out.stock = Number(input.stock);
    return out;
  }

  const allTracked = finalVariants.length > 0 && finalVariants.every(isTracked);
  const nextStock = allTracked ? finalVariants.reduce((sum, v) => sum + v.stock, 0) : input.stock !== undefined ? Number(input.stock) : currentStock;
  if (creating || nextStock !== currentStock) out.stock = nextStock;

  const note = creating ? 'product_created' : 'product_form';
  const move = (variant, before, after, why = note) => {
    if (before !== after) out.movements.push({ variant, delta: after - before, stockBefore: before, stockAfter: after, note: why });
  };
  if (allTracked) {
    const wasTracked = stored.some(isTracked);
    // The product's own count gives way to its variants' counts.
    if (!creating && !wasTracked) move('', currentStock, 0, 'variants_tracked');
    for (const v of finalVariants) {
      const old = byName.get(v.name);
      move(v.name, !creating && wasTracked && isTracked(old) ? old.stock : 0, v.stock);
    }
  } else {
    move('', currentStock, nextStock);
  }
  return out;
}

/**
 * Validate an adjustment request and turn it into what to apply once the current count is known.
 * Returns { error, status } or { reason, variant, kind: 'count'|'in'|'out', quantity, expectedStock, note, clientRef }.
 */
export function parseAdjustment(body = {}) {
  const reason = body.reason;
  if (!ADJUST_REASONS.includes(reason)) return { error: 'invalid_reason', status: 400, allowed: ADJUST_REASONS };
  const clientRef = body.clientRef;
  if (typeof clientRef !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(clientRef)) return { error: 'invalid_client_ref', status: 400 };
  const quantity = body.quantity;
  if (!Number.isInteger(quantity) || quantity < (reason === 'count' ? 0 : 1) || quantity > MAX_STOCK) return { error: 'invalid_quantity', status: 400 };
  if (body.note != null && typeof body.note !== 'string') return { error: 'invalid_field', status: 400, field: 'note' };
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
  if (note && note.length > MAX_NOTE) return { error: 'note_too_long', status: 400, max: MAX_NOTE };
  if (reason === 'other' && !note) return { error: 'note_required', status: 400 };
  if (body.variant != null && (typeof body.variant !== 'string' || body.variant.length > 60)) return { error: 'invalid_field', status: 400, field: 'variant' };
  const variant = typeof body.variant === 'string' && body.variant.trim() ? body.variant.trim() : null;
  let kind;
  let expectedStock = null;
  if (reason === 'count') {
    if (!Number.isInteger(body.expectedStock) || body.expectedStock < 0) return { error: 'expected_stock_required', status: 400 };
    kind = 'count';
    expectedStock = body.expectedStock;
  } else if (reason === 'other') {
    if (!['in', 'out'].includes(body.direction)) return { error: 'invalid_direction', status: 400, allowed: ['in', 'out'] };
    kind = body.direction;
  } else {
    kind = IN_REASONS.has(reason) ? 'in' : OUT_REASONS.has(reason) ? 'out' : null;
  }
  return { reason, variant, kind, quantity, expectedStock, note, clientRef };
}

/** EAT calendar day (YYYY-MM-DD) → the instant it starts. null when not a valid day. */
export function eatDayStart(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const utc = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(+utc) || utc.toISOString().slice(0, 10) !== day) return null;
  return new Date(`${day}T00:00:00+03:00`);
}

/** The level a unit is "low" at: the variant's own, else the product's (Q-1). */
export const effectiveLevel = (own, productLevel) => (own ?? productLevel ?? null);
