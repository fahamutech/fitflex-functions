// Vendor smart import · pure rules: limits, entities and their columns, header matching, number reading,
// row validation and the downloadable templates. No I/O: the service passes in what it knows (existing SKUs,
// names, the vendor's profile). Design: docs/design/vendor-import-v1.md.
import { PRODUCT_CATEGORIES } from './product-categories.mjs';
import { csvDocument } from './csv-export.mjs';
import { ISSUE_SEVERITY } from './vendor-import-messages.mjs';
import { VENDOR_IMPORT_LIMITS } from './feature-flags.mjs';

export const TEMPLATE_VERSION = 'v1';
export const IMPORT_ENTITIES = Object.freeze(['products', 'inventory', 'profile']);
export const IMPORT_LIMITS = Object.freeze({ ...VENDOR_IMPORT_LIMITS, maxColumns: 40, maxCellChars: 5000 });
/** ASSUMPTION (owner to confirm): a price above this is flagged for review, never refused. */
export const PRICE_REVIEW_THRESHOLD_TZS = 5_000_000;
export const MAX_MONEY_TZS = 2_000_000_000;
export const MAX_STOCK = 1_000_000;
export const MAX_NAME_CHARS = 200;
const TEXT_MAX = { name: 200, description: 5000, brand: 100, sku: 100, category: 100, variant: 60 };
export const PROFILE_TEXT_MAX = { businessName: 120, description: 2000, businessCategory: 100, contactNumber: 30, email: 120, address: 300, businessHours: 200 };
/** The ONLY profile fields an import may fill. Payout account, logo, banner, commission and areas are never importable. */
export const PROFILE_IMPORT_FIELDS = Object.freeze(['businessName', 'description', 'businessCategory', 'contactNumber', 'email', 'address', 'businessHours']);

// ── entity definitions ───────────────────────────────────────────────────────
// key: canonical field; sw: the Swahili template header; syn: accepted other names (normalised on load).

const F = (key, sw, syn = [], extra = {}) => ({ key, sw, syn, ...extra });

export const ENTITY_FIELDS = Object.freeze({
  products: [
    F('name', 'jina', ['productname', 'item', 'itemname', 'title', 'product', 'bidhaa', 'jinalabidhaa']),
    F('price_tzs', 'bei_tzs', ['price', 'unitprice', 'sellingprice', 'retailprice', 'bei', 'beiyakuuza', 'beiyarejareja']),
    F('stock', 'idadi', ['quantity', 'qty', 'stockqty', 'onhand', 'instock', 'kiasi', 'hisa', 'stoo', 'idadiyahisa']),
    F('category', 'aina', ['type', 'group', 'categoryname', 'kategoria', 'ainayabidhaa']),
    F('description', 'maelezo', ['details', 'desc', 'about', 'maelezoyabidhaa']),
    F('brand', 'chapa', ['make', 'manufacturer', 'brandname', 'kampuni']),
    F('sku', 'sku', ['code', 'itemcode', 'productcode', 'barcode', 'msimbo']),
    F('discount_price_tzs', 'bei_punguzo_tzs', ['discountprice', 'saleprice', 'offerprice', 'beiyapunguzo', 'punguzo']),
    F('cost_tzs', 'gharama_tzs', ['cost', 'costprice', 'buyingprice', 'purchaseprice', 'gharama', 'beiyakununua']),
    F('reorder_level', 'kiwango_cha_kuagiza', ['reorderpoint', 'minstock', 'minimumstock', 'lowstock', 'kiwangochakuagiza']),
    F('image', 'picha', ['imageurl', 'image', 'photo', 'photos', 'picture', 'pictures', 'imagelink', 'images', 'picha'], { ignored: true, multiple: true }),
  ],
  inventory: [
    F('sku', 'sku', ['code', 'itemcode', 'productcode', 'barcode', 'msimbo']),
    F('quantity', 'idadi', ['qty', 'stock', 'count', 'counted', 'onhand', 'stockcount', 'kiasi', 'hisa', 'hesabu']),
    F('variant', 'aina_ndogo', ['option', 'size', 'flavour', 'flavor', 'colour', 'color', 'ainandogo', 'ukubwa', 'rangi']),
  ],
  profile: [
    F('businessName', 'jina_la_biashara', ['name', 'shopname', 'storename', 'company', 'jinalabiashara', 'bizname']),
    F('description', 'maelezo', ['about', 'details', 'bio', 'maelezoyabiashara']),
    F('businessCategory', 'aina_ya_biashara', ['category', 'type', 'businesstype', 'ainayabiashara']),
    F('contactNumber', 'namba_ya_mawasiliano', ['phone', 'phonenumber', 'mobile', 'tel', 'telephone', 'contact', 'simu', 'namba', 'nambayasimu']),
    F('email', 'barua_pepe', ['emailaddress', 'mail', 'baruapepe']),
    F('address', 'anwani', ['location', 'streetaddress', 'mahali', 'eneo']),
    F('businessHours', 'saa_za_kazi', ['hours', 'openinghours', 'openinghoursdaily', 'workinghours', 'saazakazi', 'saazakufungua']),
  ],
});

/** Needed for a file to be accepted as "all exact" without a person confirming. */
export const CRITICAL_FIELDS = Object.freeze({ products: ['name', 'price_tzs', 'stock'], inventory: ['sku', 'quantity'], profile: [] });
/** Must be mapped before rows can be checked at all (stock may be missing: its rows only need review). */
export const REQUIRED_FIELDS = Object.freeze({ products: ['name', 'price_tzs'], inventory: ['sku', 'quantity'], profile: [] });

export const fieldKeys = entity => ENTITY_FIELDS[entity].map(f => f.key);
export const fieldDef = (entity, key) => ENTITY_FIELDS[entity].find(f => f.key === key) || null;

// ── header matching ──────────────────────────────────────────────────────────

/** lowercase, accents off, "(TZS)" off, everything that is not a letter or digit off. Linear; input capped. */
export function normHeader(value) {
  return String(value ?? '').slice(0, 200).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/\(\s*tzs\s*\)/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Edit distance, stopping early once it must exceed `max`. */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const exactNames = def => new Set([normHeader(def.key), normHeader(def.sw)]);
const synonymNames = def => new Set(def.syn.map(normHeader));

/**
 * Suggest a field for every source column: exact (field name, EN or SW template header) → synonym →
 * fuzzy (edit distance ≤ 1, both ≥ 5 characters). A field takes one column (image: any number); earlier columns win.
 * → [{ source, field|null, match: exact|synonym|fuzzy|none, confirmed }]. Exact matches are confirmed; the rest are not.
 */
export function suggestMapping(entity, header) {
  const defs = ENTITY_FIELDS[entity];
  const columns = header.map(source => ({ source, norm: normHeader(source), field: null, match: 'none', confirmed: false }));
  const taken = new Set();
  const take = (column, def, match) => {
    column.field = def.key; column.match = match; column.confirmed = match === 'exact';
    if (!def.multiple) taken.add(def.key);
  };
  const open = def => def.multiple || !taken.has(def.key);
  for (const column of columns) {
    const def = defs.find(d => open(d) && exactNames(d).has(column.norm));
    if (def && column.norm) take(column, def, 'exact');
  }
  for (const column of columns) {
    if (column.field) continue;
    const def = defs.find(d => open(d) && synonymNames(d).has(column.norm));
    if (def && column.norm) take(column, def, 'synonym');
  }
  for (const column of columns) {
    if (column.field || column.norm.length < 5) continue;
    const def = defs.find(d => open(d) && [...exactNames(d), ...synonymNames(d)].some(name => name.length >= 5 && editDistance(column.norm, name, 1) <= 1));
    if (def) take(column, def, 'fuzzy');
  }
  return columns.map(({ norm, ...rest }) => rest);
}

/** Does this mapping need a person's confirmation? A critical field that is not an exact match, or any fuzzy match. */
export function needsConfirmation(entity, columns) {
  const critical = new Set(CRITICAL_FIELDS[entity]);
  return columns.some(c => c.field && !c.confirmed && ((critical.has(c.field) && c.match !== 'exact') || c.match === 'fuzzy'));
}
export const missingRequired = (entity, columns) => REQUIRED_FIELDS[entity].filter(key => !columns.some(c => c.field === key));
export const missingCritical = (entity, columns) => CRITICAL_FIELDS[entity].filter(key => !columns.some(c => c.field === key && c.match === 'exact'));
/** Mapped well enough to check rows with no human step: every critical field exact, nothing fuzzy, something mapped. */
export function autoReady(entity, columns) {
  const mapped = columns.filter(c => c.field && !fieldDef(entity, c.field)?.ignored);
  if (!mapped.length) return false;
  return !missingCritical(entity, columns).length && !columns.some(c => c.match === 'fuzzy');
}

/** 'v1' when the header is exactly one of our templates (English or Swahili), in any order. */
export function templateVersionOf(entity, header) {
  const norm = new Set(header.map(normHeader));
  const defs = ENTITY_FIELDS[entity].filter(d => !d.ignored);
  for (const pick of [d => normHeader(d.key), d => normHeader(d.sw)]) {
    const want = new Set(defs.map(pick));
    if (want.size === norm.size && [...want].every(n => norm.has(n))) return TEMPLATE_VERSION;
  }
  return null;
}

// ── reading values ───────────────────────────────────────────────────────────

/** "1500", "1,500", "1 500", "TSh 1500", "1500 TZS" → whole TZS. { value } | { reason: 'invalid' | 'not_whole' }. */
export function parseWhole(raw, { currency = true } = {}) {
  let s = String(raw ?? '').toLowerCase().replace(/[\s  ]+/g, '');
  if (currency) s = s.replace(/^(?:tshs?|tzs|shs?)\.?/, '').replace(/(?:tshs?|tzs|shs?)\.?$/, '');
  if (/^\d{1,10}$/.test(s)) return { value: Number(s) };
  if (/^\d{1,3}(?:,\d{3})+$/.test(s) && s.length <= 14) return { value: Number(s.replaceAll(',', '')) };
  if (/^\d[\d,]*\.\d+$/.test(s) || /^\d+,\d{1,2}$/.test(s)) return { reason: 'not_whole' };
  return { reason: 'invalid' };
}

/** A cell that a spreadsheet would run as a formula. */
export const formulaLike = value => /^[=+\-@]/.test(String(value ?? ''));

const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
export const lowerKey = value => clean(value).toLowerCase();

const issue = (code, field = null, params = {}) => ({ code, field, severity: ISSUE_SEVERITY[code], params });

const categoryIndex = (() => {
  const map = new Map();
  for (const c of PRODUCT_CATEGORIES) for (const name of [c.key, c.en, c.sw]) map.set(normHeader(name), c);
  return map;
})();
/** → { key } | { suggestion: { key, en, sw } }. */
export function matchCategory(raw) {
  const norm = normHeader(raw);
  const hit = categoryIndex.get(norm);
  if (hit) return { key: hit.key };
  let best = null;
  let bestDistance = Infinity;
  for (const [name, category] of categoryIndex) {
    // a half-typed word counts: compare with the whole name and with its start of the same length
    const d = Math.min(editDistance(norm, name, 40), editDistance(norm, name.slice(0, norm.length), 40));
    if (d < bestDistance) { bestDistance = d; best = category; }
  }
  const category = best && bestDistance <= Math.max(3, Math.floor(norm.length / 2)) ? best : PRODUCT_CATEGORIES.find(c => c.key === 'other');
  return { suggestion: { key: category.key, en: category.en, sw: category.sw } };
}

/** Values by field from one raw row ({ source → cell }) through the confirmed mapping. Images: just whether one was given. */
export function valuesOf(entity, columns, raw) {
  const values = {};
  let hasImage = false;
  for (const column of columns) {
    if (!column.field) continue;
    const cell = raw[column.source];
    if (fieldDef(entity, column.field)?.ignored) { if (clean(cell)) hasImage = true; continue; }
    values[column.field] = clean(cell);
  }
  return { values, hasImage };
}

/** Row status from its issues: any error → invalid; else any warning → needs_review; else valid. */
export function rowStatusOf(issues) {
  if (issues.some(i => i.severity === 'error')) return 'invalid';
  return issues.some(i => i.severity === 'warning') ? 'needs_review' : 'valid';
}

/**
 * ctx: { skus: Map<lowerSku, product[]> (the vendor's live products), names: Set<lowerName>, seenSkus: Set (mutated: in-file
 * duplicates), costAllowed, profile }.
 * → { normalized, issues, status }
 */
export function validateRow(entity, values, hasImage, ctx) {
  const issues = [];
  const normalized = ENTITY_VALIDATORS[entity](values, issues, ctx);
  if (hasImage) issues.push(issue('image_not_supported', 'image'));
  return { normalized, issues, status: rowStatusOf(issues) };
}

function textField(values, key, issues) {
  const value = values[key];
  if (!value) return null;
  if (value.length > TEXT_MAX[key]) issues.push(issue('field_too_long', key, { field: key, max: TEXT_MAX[key] }));
  if (formulaLike(value)) issues.push(issue('formula_like_text', key));
  return value;
}

function moneyField(values, key, issues, { required = false } = {}) {
  const value = values[key];
  if (value === undefined || value === '') {
    if (required) issues.push(issue('price_invalid', key, { field: key }));
    return null;
  }
  const parsed = parseWhole(value);
  if (parsed.reason === 'not_whole') { issues.push(issue('price_not_whole_tzs', key, { field: key })); return null; }
  if (parsed.reason || parsed.value > MAX_MONEY_TZS) { issues.push(issue('price_invalid', key, { field: key })); return null; }
  return parsed.value;
}

function countField(values, key, issues) {
  const value = values[key];
  if (value === undefined || value === '') return undefined;
  const parsed = parseWhole(value, { currency: false });
  if (parsed.reason || parsed.value > MAX_STOCK) { issues.push(issue('stock_invalid', key, { field: key })); return null; }
  return parsed.value;
}

const ENTITY_VALIDATORS = {
  products(values, issues, ctx) {
    const name = values.name || '';
    if (!name) issues.push(issue('name_missing', 'name'));
    else if (name.length > MAX_NAME_CHARS) issues.push(issue('name_too_long', 'name', { max: MAX_NAME_CHARS }));
    if (name && formulaLike(name)) issues.push(issue('formula_like_text', 'name'));
    const priceTzs = moneyField(values, 'price_tzs', issues, { required: true });
    if (priceTzs === 0) { issues.push(issue('price_invalid', 'price_tzs', { field: 'price_tzs' })); }
    else if (priceTzs > PRICE_REVIEW_THRESHOLD_TZS) issues.push(issue('price_unusually_high', 'price_tzs'));
    let discountPriceTzs = moneyField(values, 'discount_price_tzs', issues);
    if (discountPriceTzs === 0) discountPriceTzs = null; // 0 = no discount price
    if (discountPriceTzs != null && priceTzs != null && discountPriceTzs >= priceTzs) issues.push(issue('discount_not_below_price', 'discount_price_tzs'));
    let stock = countField(values, 'stock', issues);
    if (stock === undefined) { issues.push(issue('stock_missing', 'stock')); stock = 0; }
    let costTzs = moneyField(values, 'cost_tzs', issues);
    if (costTzs != null && !ctx.costAllowed) { issues.push(issue('cost_not_allowed', 'cost_tzs')); costTzs = null; }
    const reorderLevel = countField(values, 'reorder_level', issues);
    const description = textField(values, 'description', issues);
    const brand = textField(values, 'brand', issues);
    const sku = textField(values, 'sku', issues);
    const rawCategory = textField(values, 'category', issues);
    let category = null;
    if (rawCategory) {
      const match = matchCategory(rawCategory);
      if (match.key) category = match.key;
      else issues.push(issue('category_unknown', 'category', { suggestion: match.suggestion.en, suggestionSw: match.suggestion.sw, suggestionKey: match.suggestion.key }));
    }
    if (sku) {
      const key = lowerKey(sku);
      if (ctx.skus.has(key)) issues.push(issue('sku_exists', 'sku'));
      else if (ctx.seenSkus.has(key)) issues.push(issue('sku_duplicate_in_file', 'sku'));
      ctx.seenSkus.add(key);
    }
    if (name && ctx.names.has(lowerKey(name))) issues.push(issue('name_exists', 'name'));
    return {
      name, priceTzs, stock, category, description, brand, sku,
      discountPriceTzs, ...(costTzs != null ? { costTzs } : {}), ...(reorderLevel != null ? { reorderLevel } : {}),
      ...(rawCategory && !category ? { categoryRaw: rawCategory } : {}),
    };
  },

  inventory(values, issues, ctx) {
    const sku = values.sku || '';
    const variant = values.variant || null;
    const quantity = countField(values, 'quantity', issues);
    if (quantity === undefined) issues.push(issue('stock_invalid', 'quantity', { field: 'quantity' }));
    if (variant && variant.length > TEXT_MAX.variant) issues.push(issue('field_too_long', 'variant', { field: 'variant', max: TEXT_MAX.variant }));
    if (formulaLike(sku)) issues.push(issue('formula_like_text', 'sku'));
    if (!sku) { issues.push(issue('sku_missing', 'sku')); return { sku, variant, quantity: quantity ?? null }; }
    const key = `${lowerKey(sku)}\u0000${lowerKey(variant || '')}`;
    if (ctx.seenSkus.has(key)) issues.push(issue('sku_duplicate_in_file', 'sku'));
    ctx.seenSkus.add(key);
    const matches = ctx.skus.get(lowerKey(sku)) || [];
    if (!matches.length) { issues.push(issue('product_not_found', 'sku')); return { sku, variant, quantity: quantity ?? null }; }
    if (matches.length > 1) { issues.push(issue('sku_ambiguous', 'sku')); return { sku, variant, quantity: quantity ?? null }; }
    const product = matches[0];
    const tracked = (Array.isArray(product.variants) ? product.variants : []).filter(v => v && Number.isInteger(v.stock));
    let expectedStock = Number(product.stock || 0);
    if (tracked.length && !variant) issues.push(issue('variant_required', 'variant'));
    else if (variant) {
      const hit = tracked.find(v => v.name === variant) || tracked.find(v => lowerKey(v.name) === lowerKey(variant));
      if (!hit) issues.push(issue('variant_not_found', 'variant'));
      else expectedStock = hit.stock;
    }
    const resolvedVariant = variant ? (tracked.find(v => lowerKey(v.name) === lowerKey(variant))?.name ?? variant) : null;
    return { sku, variant: resolvedVariant, quantity: quantity ?? null, productId: product.id, productName: product.name, expectedStock };
  },

  profile(values, issues, ctx) {
    const out = {};
    const prior = ctx.profile || {};
    for (const key of PROFILE_IMPORT_FIELDS) {
      const value = values[key];
      if (!value) continue;
      if (value.length > PROFILE_TEXT_MAX[key]) { issues.push(issue('field_too_long', key, { field: key, max: PROFILE_TEXT_MAX[key] })); continue; }
      if (key === 'email' && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/.test(value)) { issues.push(issue('email_invalid', key)); continue; }
      const isPhone = key === 'contactNumber' && /^\+[\d\s()-]+$/.test(value); // +255 ... is a phone number, not a formula
      if (formulaLike(value) && !isPhone) issues.push(issue('formula_like_text', key));
      const current = prior[key];
      if (current != null && String(current).trim() !== '') { issues.push(issue('already_set', key, { field: key })); continue; }
      out[key] = value;
    }
    return out;
  },
};

// ── templates ────────────────────────────────────────────────────────────────

const EXAMPLES = {
  products: {
    en: [['Whey Protein 1kg', '85000', '20', 'Supplements & nutrition', 'Chocolate flavour', 'FitPro', 'WHEY-1KG', '79000', '60000', '5'],
      ['Yoga mat', '25000', '40', 'Gym & fitness equipment', '', '', 'YOGA-MAT', '', '', '']],
    sw: [['Protini ya Whey 1kg', '85000', '20', 'Virutubisho na lishe', 'Ladha ya chokoleti', 'FitPro', 'WHEY-1KG', '79000', '60000', '5'],
      ['Mkeka wa yoga', '25000', '40', 'Vifaa vya gym na mazoezi', '', '', 'YOGA-MAT', '', '', '']],
  },
  inventory: { en: [['WHEY-1KG', '18', ''], ['YOGA-MAT', '35', '']], sw: [['WHEY-1KG', '18', ''], ['YOGA-MAT', '35', '']] },
  profile: {
    en: [['Dar Fitness Gear', 'Gym equipment and supplements', 'Sports & fitness', '0700000000', 'shop@example.com', 'Mikocheni, Dar es Salaam', 'Mon-Sat 08:00-18:00']],
    sw: [['Dar Fitness Gear', 'Vifaa vya gym na virutubisho', 'Michezo na mazoezi', '0700000000', 'shop@example.com', 'Mikocheni, Dar es Salaam', 'Jumatatu-Jumamosi 08:00-18:00']],
  },
};

/** The CSV a vendor fills in: the template header (English or Swahili), plus example rows when asked. */
export function templateCsv(entity, lang, example) {
  const defs = ENTITY_FIELDS[entity].filter(d => !d.ignored);
  const header = defs.map(d => (lang === 'sw' ? d.sw : d.key));
  return csvDocument(header, example ? EXAMPLES[entity][lang] : []);
}
