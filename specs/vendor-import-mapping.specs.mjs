// Vendor smart import V1 — header matching: exact, synonym (English and Swahili), fuzzy, and when a person must confirm. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normHeader, editDistance, suggestMapping, needsConfirmation, autoReady, missingRequired, templateVersionOf, templateCsv, parseWhole,
} from '../src/shared/vendor-import-rules.mjs';

const by = columns => Object.fromEntries(columns.map(c => [c.source, `${c.field}:${c.match}`]));

test('normHeader: lowercase, accents and (TZS) dropped, separators ignored, input capped', () => {
  assert.equal(normHeader('Price (TZS)'), 'price');
  assert.equal(normHeader('  Bei_Ya-Kuuza '), 'beiyakuuza');
  assert.equal(normHeader('Jiná'), 'jina');
  assert.equal(normHeader('price_tzs'), 'pricetzs');
  assert.equal(normHeader('x'.repeat(5000)).length, 200);
  const started = Date.now();
  normHeader(`${'(  '.repeat(60)}tzs`);
  assert.ok(Date.now() - started < 100, 'no catastrophic backtracking');
});

test('editDistance stops early and measures small typos', () => {
  assert.equal(editDistance('stock', 'stock', 1), 0);
  assert.equal(editDistance('stok', 'stock', 1), 1);
  assert.equal(editDistance('abc', 'xyz', 1), 2);
  assert.equal(editDistance('a', 'abcdefgh', 1), 2);
});

test('exact: template headers in English and in Swahili match exactly and the file is ready without a person', () => {
  const en = suggestMapping('products', ['name', 'price_tzs', 'stock', 'category', 'sku']);
  assert.deepEqual(by(en), { name: 'name:exact', price_tzs: 'price_tzs:exact', stock: 'stock:exact', category: 'category:exact', sku: 'sku:exact' });
  assert.ok(en.every(c => c.confirmed));
  assert.equal(autoReady('products', en), true);
  const sw = suggestMapping('products', ['jina', 'bei_tzs', 'idadi', 'aina', 'maelezo', 'chapa']);
  assert.deepEqual(by(sw), { jina: 'name:exact', bei_tzs: 'price_tzs:exact', idadi: 'stock:exact', aina: 'category:exact', maelezo: 'description:exact', chapa: 'brand:exact' });
  assert.equal(autoReady('products', sw), true);
  assert.equal(templateVersionOf('products', ['name', 'price_tzs', 'stock', 'category', 'description', 'brand', 'sku', 'discount_price_tzs', 'cost_tzs', 'reorder_level']), 'v1');
  assert.equal(templateVersionOf('products', ['jina', 'bei_tzs', 'idadi', 'aina', 'maelezo', 'chapa', 'sku', 'bei_punguzo_tzs', 'gharama_tzs', 'kiwango_cha_kuagiza']), 'v1');
  assert.equal(templateVersionOf('products', ['name', 'price_tzs']), null);
});

test('the downloadable templates map back to themselves exactly (every entity, both languages)', () => {
  for (const entity of ['products', 'inventory', 'profile']) {
    for (const lang of ['en', 'sw']) {
      const header = templateCsv(entity, lang, false).replace(/^﻿/, '').trim().split(',');
      const columns = suggestMapping(entity, header);
      assert.ok(columns.every(c => c.field && c.match === 'exact'), `${entity}/${lang}: ${JSON.stringify(columns)}`);
      assert.equal(templateVersionOf(entity, header), 'v1');
      assert.equal(autoReady(entity, columns), true);
    }
  }
});

test('synonyms (English and Swahili) are matched but need a person to confirm a critical column', () => {
  const cols = suggestMapping('products', ['Bidhaa', 'Bei ya kuuza', 'Kiasi', 'Notes']);
  assert.deepEqual(by(cols), { Bidhaa: 'name:synonym', 'Bei ya kuuza': 'price_tzs:synonym', Kiasi: 'stock:synonym', Notes: 'null:none' });
  assert.equal(autoReady('products', cols), false);
  assert.equal(needsConfirmation('products', cols), true);
  assert.equal(needsConfirmation('products', cols.map(c => ({ ...c, confirmed: true }))), false);
  assert.deepEqual(by(suggestMapping('products', ['Product Name', 'Price (TZS)', 'Qty'])), { 'Product Name': 'name:synonym', 'Price (TZS)': 'price_tzs:synonym', Qty: 'stock:synonym' });
  assert.deepEqual(by(suggestMapping('inventory', ['code', 'counted'])), { code: 'sku:synonym', counted: 'quantity:synonym' });
});

test('a synonym on a non-critical field does not stop the auto path; a fuzzy match always does', () => {
  const ok = suggestMapping('products', ['name', 'price_tzs', 'stock', 'details']);
  assert.equal(by(ok).details, 'description:synonym');
  assert.equal(autoReady('products', ok), true);
  const fuzzy = suggestMapping('products', ['name', 'price_tzs', 'stock', 'catgory']);
  assert.equal(by(fuzzy).catgory, 'category:fuzzy');
  assert.equal(autoReady('products', fuzzy), false, 'fuzzy needs confirmation');
  assert.equal(needsConfirmation('products', fuzzy), true);
});

test('fuzzy: edit distance 1 and at least 5 characters only; short typos are not guessed', () => {
  assert.equal(by(suggestMapping('products', ['descriptoin'])).descriptoin, 'null:none', 'a transposition is distance 2');
  assert.equal(by(suggestMapping('products', ['descripton'])).descripton, 'description:fuzzy');
  assert.equal(by(suggestMapping('products', ['nme'])).nme, 'null:none', 'too short for fuzzy');
  assert.equal(by(suggestMapping('products', ['stok'])).stok, 'null:none');
  assert.equal(by(suggestMapping('products', ['stoock'])).stoock, 'stock:fuzzy');
});

test('a field takes one column: an exact match wins over a synonym; the other column stays unmatched', () => {
  const cols = suggestMapping('products', ['price', 'price_tzs', 'name']);
  assert.deepEqual(by(cols), { price: 'null:none', price_tzs: 'price_tzs:exact', name: 'name:exact' });
  const two = suggestMapping('products', ['item', 'product']);
  assert.equal(Object.values(by(two)).filter(v => v.startsWith('name')).length, 1);
});

test('image columns are recognised and ignored by the import (any number of them)', () => {
  const cols = suggestMapping('products', ['name', 'price_tzs', 'stock', 'image_url', 'photo']);
  assert.deepEqual([by(cols).image_url, by(cols).photo], ['image:synonym', 'image:synonym']);
  assert.equal(autoReady('products', cols), true);
});

test('required fields: products need name + price; inventory sku + quantity; critical stock may be missing', () => {
  assert.deepEqual(missingRequired('products', [{ field: 'name' }]), ['price_tzs']);
  assert.deepEqual(missingRequired('products', [{ field: 'name' }, { field: 'price_tzs' }]), []);
  assert.deepEqual(missingRequired('inventory', []), ['sku', 'quantity']);
  const noStock = suggestMapping('products', ['name', 'price_tzs']);
  assert.equal(autoReady('products', noStock), false, 'stock is critical for the no-human path');
});

test('numbers: 1,500 / 1 500 / TSh 1500 / 1500 TZS are whole TZS; decimals and text are refused', () => {
  for (const [text, value] of [['1500', 1500], ['1,500', 1500], ['1 500', 1500], ['TSh 1500', 1500], ['1500 TZS', 1500], ['Tsh. 12,000', 12000], ['0', 0], ['1,234,567', 1234567], [' 2 500', 2500]]) {
    assert.deepEqual(parseWhole(text), { value }, text);
  }
  for (const text of ['1500.50', '1.5', '1,500.00', '1500,50']) assert.deepEqual(parseWhole(text), { reason: 'not_whole' }, text);
  for (const text of ['', 'abc', '12abc', '-5', '1,50,0', '1e3', '١٢٣', '$100']) assert.deepEqual(parseWhole(text), { reason: 'invalid' }, text);
});
