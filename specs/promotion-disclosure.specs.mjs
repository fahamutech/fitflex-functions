// Disclosure labels in English and Swahili, and the dev seed product (QA round 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disclosureLabel, disclosureText, DISCLOSURE_WORDS } from '../src/shared/promotion-rules.mjs';
import { PROMOTION_TYPES } from '../src/shared/promotion-config.mjs';
import { devMarketplaceProduct } from '../src/shared/dev-login.mjs';
import { PRODUCT_CATEGORY_KEYS } from '../src/shared/product-categories.mjs';
import { makeWorld, approved, HOUR } from './support/promotion-fixtures.mjs';

test('disclosure: codes and both languages; English is exactly the existing label', () => {
  const cases = [
    [{ type: 'featured', isCommercial: true }, ['featured', 'sponsored'], 'Iliyoangaziwa · Iliyodhaminiwa'],
    [{ type: 'featured', isCommercial: false }, ['featured'], 'Iliyoangaziwa'],
    [{ type: 'promoted', isCommercial: true }, ['promoted', 'sponsored'], 'Iliyopandishwa · Iliyodhaminiwa'],
    [{ type: 'sponsored', isCommercial: true }, ['sponsored'], 'Iliyodhaminiwa'],
    [{ type: 'recommended', isCommercial: false }, ['recommended'], 'Imependekezwa na FitFlex'],
    [{ type: 'campaign', isCommercial: true }, ['campaign', 'sponsored'], 'Kampeni · Iliyodhaminiwa'],
    // Custom admin wording is English free text: Swahili still says what it is, and that it was paid for.
    [{ type: 'promoted', isCommercial: true, disclosureLabel: 'Top pick' }, ['promoted', 'sponsored'], 'Iliyopandishwa · Iliyodhaminiwa'],
    // Not paid for: no Sponsored code, whatever the wording says. English stays exactly the label.
    [{ type: 'promoted', isCommercial: false, disclosureLabel: 'Sponsored pick' }, ['promoted'], 'Iliyopandishwa'],
    [{ type: 'campaign', isCommercial: false, disclosureLabel: 'Ad' }, ['campaign'], 'Kampeni'],
    [{ type: 'recommended', isCommercial: false, disclosureLabel: 'Advert-free pick' }, ['recommended'], 'Imependekezwa na FitFlex'],
    [{ type: 'featured', disclosureLabel: 'Ad' }, ['featured'], 'Iliyoangaziwa'],
  ];
  for (const [p, codes, sw] of cases) {
    const d = disclosureText(p);
    assert.deepEqual(d.codes, codes, JSON.stringify(p));
    assert.equal(d.en, disclosureLabel(p));
    assert.equal(d.sw, sw);
  }
  assert.equal(disclosureText({ type: 'featured', isCommercial: true }).en, 'Featured · Sponsored');
  // Every promotion type has words, and Sponsored matches the app's promo.sponsored.
  for (const t of Object.keys(PROMOTION_TYPES)) assert.ok(DISCLOSURE_WORDS[t]?.en && DISCLOSURE_WORDS[t]?.sw, t);
  assert.equal(DISCLOSURE_WORDS.sponsored.sw, 'Iliyodhaminiwa');
});

test('disclosure: live promotions carry it next to the old English label (additive)', async () => {
  const world = makeWorld();
  const promo = await approved(world, { entityType: 'product', entityId: 'prod_1', type: 'featured', placements: ['marketplace'], isCommercial: true, relationshipType: 'paid_advertising', commercialRef: 'INV-TEST-1' });
  assert.ok(!(await world.promotionService.schedule({ id: promo.id, actorId: 'admin_checker' })).error);
  world.clock.advance(2 * HOUR);
  await world.promotionService.runLifecycle();
  const [live] = await world.promotionService.listLive({ entityType: 'product', checkEntities: false });
  assert.equal(live.label, 'Featured · Sponsored');
  assert.deepEqual(live.disclosure, { codes: ['featured', 'sponsored'], en: 'Featured · Sponsored', sw: 'Iliyoangaziwa · Iliyodhaminiwa' });
});

test('dev seed: the dev vendor product claims no rating, reviews or sales and uses a real category', () => {
  const p = devMarketplaceProduct('usr_dev_vendor', '2026-10-19T00:00:00.000Z');
  assert.deepEqual([p.rating, p.reviewCount, p.soldCount], [0, 0, 0]);
  assert.ok(PRODUCT_CATEGORY_KEYS.has(p.category), p.category);
  assert.equal(p.vendorId, 'usr_dev_vendor');
});
