// Vendor smart import V1 — every validation code, row status, messages in English and Swahili. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRow, PRICE_REVIEW_THRESHOLD_TZS, matchCategory } from '../src/shared/vendor-import-rules.mjs';
import { ISSUE_SEVERITY, MESSAGES, issueMessage, errorMessage, reasonMessage, rowErrorView, issueView, messageFor } from '../src/shared/vendor-import-messages.mjs';

const ctx = (extra = {}) => ({ costAllowed: false, seenSkus: new Set(), skus: new Map(), names: new Set(), profile: {}, ...extra });
const product = (values, c = ctx(), image = false) => validateRow('products', { name: 'Whey', price_tzs: '45000', stock: '10', ...values }, image, c);
const codes = out => out.issues.map(i => i.code).sort();

test('products: a clean row is valid and its values are read as whole numbers', () => {
  const out = product({ price_tzs: 'TSh 45,000', discount_price_tzs: '40000', sku: 'W1', category: 'Supplements & nutrition', description: 'Choc', brand: 'FitPro' });
  assert.equal(out.status, 'valid');
  assert.deepEqual(out.issues, []);
  assert.deepEqual(out.normalized, { name: 'Whey', priceTzs: 45000, stock: 10, category: 'supplements_nutrition', description: 'Choc', brand: 'FitPro', sku: 'W1', discountPriceTzs: 40000 });
});

test('invalid: name_missing, name_too_long, price_invalid, price_not_whole_tzs, discount_not_below_price, stock_invalid', () => {
  assert.deepEqual(codes(product({ name: '' })), ['name_missing']);
  assert.deepEqual(codes(product({ name: 'x'.repeat(201) })), ['name_too_long']);
  for (const price of ['', 'abc', '0', '-5']) assert.deepEqual(codes(product({ price_tzs: price })), ['price_invalid'], `price "${price}"`);
  assert.deepEqual(codes(product({ price_tzs: '2500.50' })), ['price_not_whole_tzs']);
  assert.deepEqual(codes(product({ discount_price_tzs: '45000' })), ['discount_not_below_price']);
  assert.deepEqual(codes(product({ discount_price_tzs: '50000' })), ['discount_not_below_price']);
  assert.deepEqual(codes(product({ discount_price_tzs: '0' })), [], '0 means no discount price');
  assert.deepEqual(codes(product({ discount_price_tzs: '39.5' })), ['price_not_whole_tzs']);
  for (const stock of ['abc', '1.5', '1000001', '-1']) assert.deepEqual(codes(product({ stock })), ['stock_invalid'], `stock "${stock}"`);
  assert.equal(product({ name: '' }).status, 'invalid');
});

test('invalid: sku_exists (the vendor already has it, any case) and sku_duplicate_in_file (second occurrence only)', () => {
  const c = ctx({ skus: new Map([['w1', [{ id: 'prd_1', sku: 'W1', name: 'Old' }]]]) });
  assert.deepEqual(codes(product({ sku: ' w1 ' }, c)), ['sku_exists']);
  const shared = ctx();
  assert.deepEqual(codes(product({ sku: 'A-1' }, shared)), []);
  assert.deepEqual(codes(product({ sku: 'a-1' }, shared)), ['sku_duplicate_in_file']);
  assert.deepEqual(codes(product({ sku: '' }, shared)), [], 'no SKU is fine');
});

test('needs_review: price_unusually_high (ASSUMPTION cap 5,000,000), stock_missing (starts at 0), name_exists, category_unknown with a suggestion', () => {
  assert.equal(PRICE_REVIEW_THRESHOLD_TZS, 5_000_000);
  assert.deepEqual(codes(product({ price_tzs: '5000000' })), []);
  const high = product({ price_tzs: '5000001' });
  assert.deepEqual([codes(high), high.status], [['price_unusually_high'], 'needs_review']);
  const none = product({ stock: '' });
  assert.deepEqual([codes(none), none.status, none.normalized.stock], [['stock_missing'], 'needs_review', 0]);
  assert.deepEqual(codes(product({}, ctx({ names: new Set(['whey']) }))), ['name_exists']);
  const unknown = product({ category: 'Suplements' });
  assert.deepEqual(codes(unknown), ['category_unknown']);
  assert.equal(unknown.normalized.category, null);
  assert.equal(unknown.issues[0].params.suggestionKey, 'supplements_nutrition');
  assert.equal(matchCategory('Virutubisho na lishe').key, 'supplements_nutrition', 'Swahili label');
  assert.equal(matchCategory('equipment').key, 'equipment', 'key');
});

test('needs_review: formula_like_text keeps the text; cost_not_allowed drops the cost; with permission the cost is kept', () => {
  const formula = product({ name: '=1+1' });
  assert.deepEqual(codes(formula), ['formula_like_text']);
  assert.equal(formula.normalized.name, '=1+1', 'kept as plain text');
  assert.equal(codes(product({ description: '@cmd' })).includes('formula_like_text'), true);
  const denied = product({ cost_tzs: '30000' });
  assert.deepEqual(codes(denied), ['cost_not_allowed']);
  assert.equal('costTzs' in denied.normalized, false);
  const allowed = product({ cost_tzs: '30000', reorder_level: '3' }, ctx({ costAllowed: true }));
  assert.equal(allowed.status, 'valid');
  assert.deepEqual([allowed.normalized.costTzs, allowed.normalized.reorderLevel], [30000, 3]);
  assert.equal(codes(product({ reorder_level: 'x' })).join(), 'stock_invalid');
});

test('info: image_not_supported never changes the row status', () => {
  const out = product({}, ctx(), true);
  assert.deepEqual([codes(out), out.status], [['image_not_supported'], 'valid']);
});

test('inventory: product_not_found, sku_missing, sku_ambiguous, sku_duplicate_in_file, variants, stock_invalid; expected stock is the stock at check time', () => {
  const p1 = { id: 'prd_1', name: 'Whey', sku: 'W1', stock: 7, variants: [] };
  const p2 = { id: 'prd_2', name: 'Shake', sku: 'S1', stock: 0, variants: [{ name: 'Choc', stock: 4 }, { name: 'Van', stock: 2 }] };
  const dup = [{ id: 'a', sku: 'D' }, { id: 'b', sku: 'D' }];
  const c = ctx({ skus: new Map([['w1', [p1]], ['s1', [p2]], ['d', dup]]) });
  const inv = (values, cc = ctx({ skus: c.skus })) => validateRow('inventory', values, false, cc);
  const good = inv({ sku: 'W1', quantity: '12' });
  assert.deepEqual([good.status, good.normalized.productId, good.normalized.quantity, good.normalized.expectedStock], ['valid', 'prd_1', 12, 7]);
  assert.deepEqual(codes(inv({ sku: 'NOPE', quantity: '1' })), ['product_not_found']);
  assert.deepEqual(codes(inv({ sku: '', quantity: '1' })), ['sku_missing']);
  assert.deepEqual(codes(inv({ sku: 'D', quantity: '1' })), ['sku_ambiguous']);
  assert.deepEqual(codes(inv({ sku: 'W1', quantity: '-3' })), ['stock_invalid']);
  assert.deepEqual(codes(inv({ sku: 'W1', quantity: '' })), ['stock_invalid']);
  const sameFile = ctx({ skus: c.skus });
  assert.deepEqual(codes(inv({ sku: 'W1', quantity: '1' }, sameFile)), []);
  assert.deepEqual(codes(inv({ sku: 'w1', quantity: '2' }, sameFile)), ['sku_duplicate_in_file'], 'second W1 line in the same file');
  assert.deepEqual(codes(inv({ sku: 'S1', quantity: '3' }, ctx({ skus: c.skus }))), ['variant_required']);
  assert.deepEqual(codes(inv({ sku: 'S1', quantity: '3', variant: 'Nope' }, ctx({ skus: c.skus }))), ['variant_not_found']);
  const withVariant = inv({ sku: 'S1', quantity: '3', variant: 'choc' }, ctx({ skus: c.skus }));
  assert.deepEqual([withVariant.status, withVariant.normalized.variant, withVariant.normalized.expectedStock], ['valid', 'Choc', 4]);
  assert.deepEqual(codes(inv({ sku: 'W1', quantity: '1', variant: 'x'.repeat(61) }, ctx({ skus: c.skus }))).includes('field_too_long'), true);
});

test('profile: only the allowlist is read; set fields are kept (already_set info); email and length are checked; a phone starting + is not a formula', () => {
  const prof = (values, profile = {}) => validateRow('profile', values, false, ctx({ profile }));
  const out = prof({ businessName: 'Dar Gear', email: 'a@b.co', contactNumber: '+255700000000', address: 'Mikocheni' });
  assert.equal(out.status, 'valid');
  assert.deepEqual(out.normalized, { businessName: 'Dar Gear', contactNumber: '+255700000000', email: 'a@b.co', address: 'Mikocheni' });
  const set = prof({ businessName: 'New', address: 'New place' }, { businessName: 'Old' });
  assert.deepEqual(codes(set), ['already_set']);
  assert.deepEqual(set.normalized, { address: 'New place' });
  assert.equal(set.status, 'valid');
  assert.deepEqual(codes(prof({ email: 'not-an-email' })), ['email_invalid']);
  assert.deepEqual(codes(prof({ businessName: 'x'.repeat(121) })), ['field_too_long']);
  assert.deepEqual(codes(prof({ description: '=cmd' })), ['formula_like_text']);
  // fields outside the allowlist never reach the result, even when a value is supplied for them
  const sneaky = prof({ settlementAccount: '0150001234', logo: 'data:x', commissionPct: '0', businessName: 'N' });
  assert.deepEqual(Object.keys(sneaky.normalized), ['businessName']);
});

test('every issue code has a severity and an English and a Swahili message; every message key is complete', () => {
  for (const code of Object.keys(ISSUE_SEVERITY)) {
    const m = issueMessage(code, { field: 'f', max: 1, found: 1, expected: 2, suggestion: 's' });
    assert.ok(m?.en && m?.sw, `issue ${code}`);
    assert.ok(['error', 'warning', 'info'].includes(ISSUE_SEVERITY[code]));
    assert.doesNotMatch(m.en + m.sw, /\{\w+\}/, `placeholders filled for ${code}`);
  }
  for (const [key, m] of Object.entries(MESSAGES)) {
    assert.match(key, /^vendor_import\.(issue|error|status|entity|field|csv|row_error)\.[A-Za-z0-9_.]+$/);
    assert.ok(m.en && m.sw && m.en !== '', key);
  }
  for (const code of ['file_too_large', 'too_many_rows', 'unsupported_file_type', 'invalid_encoding', 'duplicate_file', 'apply_in_progress', 'import_quota', 'rate_limited', 'mapping_confirmation_required']) {
    assert.ok(errorMessage(code, { maxBytes: 1, maxRows: 1 })?.sw, code);
  }
  for (const status of ['mapping_required', 'ready', 'applying', 'applied', 'partial', 'discarded']) assert.ok(messageFor(`vendor_import.status.${status}`)?.sw);
  for (const entity of ['products', 'inventory', 'profile']) assert.ok(messageFor(`vendor_import.entity.${entity}`)?.sw);
  assert.equal(issueView({ code: 'name_missing', field: 'name', severity: 'error', params: {} }).message.sw, 'Jina la bidhaa halijajazwa.');
});

test('Swahili (glossary): no unresolved placeholder, no raw field key, no TZS, no Hisa, no aina ndogo, no nguzo in any rendered message', () => {
  const FIELDS = Object.keys(MESSAGES).filter(k => k.startsWith('vendor_import.field.')).map(k => k.split('.').pop());
  const params = (field, extra = {}) => ({ field, max: 5, found: 2, expected: 3, suggestion: 'Equipment', suggestionSw: 'Vifaa vya gym na mazoezi', maxBytes: 2097152, maxRows: 2000, maxColumns: 40, maxCellChars: 5000, ...extra });
  const rendered = [];
  for (const key of Object.keys(MESSAGES)) for (const field of FIELDS) rendered.push([key, field, messageFor(key, params(field))]);
  for (const [key, field, m] of rendered) {
    assert.doesNotMatch(m.sw, /\{\w+\}/, `${key}: unresolved placeholder in sw`);
    assert.doesNotMatch(m.en, /\{\w+\}/, `${key}: unresolved placeholder in en`);
    for (const raw of FIELDS) {
      // a field KEY is a snake/camel-case identifier: neither language may show one (labels are words)
      if (/[_A-Z]/.test(raw)) { assert.equal(m.sw.includes(raw), false, `${key} (${field}): raw key ${raw} in sw`); assert.equal(m.en.includes(raw), false, `${key} (${field}): raw key ${raw} in en`); }
    }
    assert.doesNotMatch(m.sw, /TZS|\bHisa\b|\bhisa\b|aina ndogo|\bnguzo\b|Uzito/, `${key}: glossary term in sw`);
  }
  // the label is chosen per language
  const price = issueMessage('price_invalid', { field: 'price_tzs' });
  assert.deepEqual(price, { en: 'The value in Price (TSh) is not a valid amount.', sw: 'Thamani ya Bei (TSh) si kiasi sahihi.' });
  const stock = issueMessage('stock_invalid', { field: 'stock' });
  assert.match(stock.sw, /Thamani ya Stock /, 'Stock stays English in Swahili');
  assert.equal(messageFor('vendor_import.field.variant').sw, 'Chaguo');
  assert.equal(messageFor('vendor_import.csv.severity').sw, 'Kiwango');
  assert.equal(messageFor('vendor_import.csv.row').sw, 'Safu mlalo');
  assert.equal(errorMessage('invalid_multipart').sw, 'Upakiaji haukuweza kusomwa.');
  assert.match(errorMessage('nothing_to_retry').sw, /zilizoshindikana/);
  assert.match(issueMessage('row_shape', { found: 2, expected: 3 }).sw, /safu mlalo.*safu wima.*kichwa cha safu wima/i);
});

test('messages: category_unknown uses the Swahili suggestion; file_too_large says MB; error reasons and row errors exist in both languages', () => {
  const c = issueMessage('category_unknown', { suggestion: 'Equipment', suggestionSw: 'Vifaa vya gym na mazoezi' });
  assert.match(c.sw, /Karibu zaidi: Vifaa vya gym na mazoezi\./);
  assert.match(c.en, /Closest: Equipment\./);
  assert.deepEqual(errorMessage('file_too_large', { maxBytes: 2 * 1024 * 1024 }), { en: 'The file is larger than 2 MB.', sw: 'Faili ni kubwa kuliko MB 2.' });
  for (const reason of ['unterminated_quote', 'empty_name', 'duplicate_name', 'header_only', 'daily', 'open', 'xlsx_not_supported_yet', 'binary_or_utf16', 'unknown_column', 'unknown_field']) {
    assert.ok(reasonMessage(reason, { max: 20 })?.sw, reason);
  }
  assert.equal(reasonMessage(undefined), null);
  assert.deepEqual(rowErrorView('stock_changed'), { code: 'stock_changed', message: { en: 'Stock changed since the file was checked.', sw: 'Stock ilibadilika tangu faili ilipokaguliwa.' } });
  assert.ok(rowErrorView('some_service_error').message.sw, 'unknown codes get the generic text');
  assert.equal(rowErrorView(null), null);
  for (const code of ['stock_changed', 'sku_exists', 'product_not_found', 'product_deleted', 'variant_not_found', 'insufficient_stock', 'internal_error']) assert.ok(messageFor(`vendor_import.row_error.${code}`)?.sw);
});
