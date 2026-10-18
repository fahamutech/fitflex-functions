# Shop home API (Phase 1)

Status: on `release-candidate`, **dormant** (`SHOP_HOME_V2` off). Design spec: `docs/design/shop-home.md` in the parent repo (fitflex#65).
Scope (owner, 2026-10-19): Phase 1 = UI + foundations, with role-based rules only. Personalisation (purchase history, gender/age, location, the preference switch) is Phase 2.

## `GET /shop/home`

Signed in (any role). With `SHOP_HOME_V2` off the answer is `404 {"error":"feature_disabled"}`; signed out is `401 {"error":"unauthenticated"}`.

### Query

| Param | Meaning |
|---|---|
| `mode` | `member` \| `trainer` \| `owner` \| `vendor_personal`. Must be a role this account holds: the signed-in persona or another usable persona of the same Person (`owner` = a `gym_operator` persona, `vendor_personal` = a `vendor` persona). Anything else, including unknown values, is `403 {"error":"mode_not_allowed"}`. Default: the signed-in role. If that is not a shopping role (e.g. `gym_staff`), the first held one in the order member, trainer, owner, vendor_personal. If none is held: 403. `vendor_staff` has no shopping mode. |
| `recent` | Comma-separated product ids, most recent first. At most 20 are used, and invalid or unknown ids are dropped. The server only reads them for this request and never stores them. |
| `session` | Optional. The same promotion session id the app sends to `/discover/products?session=` (8–64 chars `A-Za-z0-9_-`). When it is given, Featured products carry `promotion.token` for `POST /events`. |
| `region`, `city` | **Accepted and ignored in Phase 1** (location is Phase 2). |

### Response `200`

```json
{
  "serverNow": "2026-10-19T08:00:00.000Z",
  "currency": "TZS",
  "mode": "member",
  "personalised": false,
  "signalsUsed": ["role", "goal", "recently_viewed"],
  "categories": [{ "key": "sportswear_footwear", "en": "Sportswear & footwear", "sw": "Mavazi na viatu vya michezo", "count": 7 }],
  "sections": [{
    "key": "best_sellers",
    "title": { "en": "Best sellers", "sw": "Zinazouzwa zaidi" },
    "reason": { "en": "The most bought on FitFlex in the last 30 days.", "sw": "Zilizonunuliwa zaidi kwenye FitFlex katika siku 30 zilizopita." },
    "reasonCodes": ["best_sellers_30d"],
    "viewAll": { "path": "/shop/products", "query": { "sort": "popularity" } },
    "productIds": ["prd_1", "prd_2", "prd_3", "prd_4"],
    "hasMore": false
  }],
  "products": { "prd_1": { "id": "prd_1", "name": "Whey Protein 1kg", "priceTzs": 85000, "...": "same row as GET /shop/products" } }
}
```

- `personalised` is always `false` in Phase 1.
- `signalsUsed` ⊆ `role`, `goal` (the member's declared `memberProfile.fitnessGoal(s)`, member mode only), `specialty` (the trainer's declared `TrainerProfile.specialties`, trainer mode only), `recently_viewed` (only when that section was shown). Phase 2 will add `purchase_history`, `gender`, `age`, `location`.
- `categories`: the existing 8, ordered for the mode (design spec §5.2). Only categories with at least one eligible product are listed, and `other` is always last. `count` = eligible products on the home (in stock, not the viewer's own).
- `products[id]` is exactly the row `GET /shop/products` returns. Products in the `featured` section also carry `promotion: { id, type, label, commercial, token? }`, the same tag as `/discover/products`. Show the disclosure badge from `label`.
- Ratings: `rating`/`reviewCount` come from real reviews only (see Security below). Show a rating only when `reviewCount ≥ 1`.

### Sections

Default order (and the de-duplication priority): a product appears in **one section at most**, and the first section in order takes it.

| key | What | Title (en / sw [SW review]) | viewAll.query |
|---|---|---|---|
| `featured` | The existing Featured system (`/discover/products`, placement `marketplace`), in its order. | member/vendor_personal "Featured gear" / "Vifaa vilivyoangaziwa"; trainer "Featured coaching gear" / "Vifaa vya ukocha vilivyoangaziwa"; owner "Featured equipment" / "Vifaa vya gym vilivyoangaziwa" | `{}` |
| `recommended` | Organic only: **no product with any live promotion** (featured, promoted, sponsored, recommended, campaign) and nothing from `featured`. The role's categories come first, then paid orders (30 days) by buyers in this role, then all paid orders, then admin priority, newest, id. | "Popular with members / trainers / gym owners" / "Maarufu kwa wanachama / wakufunzi / wamiliki wa gym"; vendor_personal "Popular in the shop" / "Maarufu dukani" | `{category:<first role category>, sort:"popularity"}` |
| `best_sellers` | Products in paid, uncancelled orders placed in the last 30 days, ranked by number of orders, then units. Never `soldCount`. | "Best sellers" / "Zinazouzwa zaidi" | `{sort:"popularity"}` |
| `essentials` | Takes turns across the needed categories (goal/specialty categories first, then role defaults). Within a category: paid orders (30 days), priority, newest. | member/vendor_personal "Training essentials" / "Mahitaji muhimu ya mazoezi"; trainer "Coaching essentials" / "Mahitaji muhimu ya ukocha"; owner "Gym essentials" / "Mahitaji muhimu ya gym" | `{category:<first needed category>}` |
| `recently_viewed` | The `recent` ids in the app's order, eligible ones only. | "Recently viewed" / "Ulizotazama hivi karibuni" | `{}` |
| `deals` | `discountPriceTzs > 0` and `< priceTzs`, biggest % first. | "Deals" / "Ofa" | `{promotions:"true"}` |
| `new_arrivals` | Created in the last 90 days, newest first. | "New arrivals" / "Bidhaa mpya" | `{}` |

- At most 12 products per section; `hasMore` says whether more qualified.
- A section with fewer than `SHOP_HOME_MIN_ITEMS` (default 4) products is left out entirely. Its products stay available to later sections. If no section qualifies, `sections` is `[]`: show the categories and an "All products" grid from `/shop/products`.
- `reasonCodes` come from the closed list in design §8.3 plus `profile_goal`, `trainer_specialty`, `recently_viewed`, `seller_discount`, `new_arrival`, `generic`. Build the Why sheet from these codes. `reason` is a ready-made sentence for simple display.
- `viewAll` targets the existing `GET /shop/products` with the given query. For `featured`, `recently_viewed` and `new_arrivals` there is no exact list filter, so the query is `{}` (all products).

### Eligibility (what never appears on the home)

The base is `shopService.listProducts({})`: active, not pending or rejected, not hidden, `homepageVisible`, the vendor may sell (KYC rule), and the product and vendor are not blocked in moderation. On top of that:
- out of stock (`stock ≤ 0`): never on the home, still in search and results;
- the viewer's own products: excluded in **every** mode when the person holds a vendor persona (design DD-12), not only in `vendor_personal`;
- delivery: products have no buyer-area coverage yet and gym pickup always exists, so nothing is excluded by delivery in Phase 1.

### Caching

The catalogue, 30-day sales, the Featured list and the live-promotion set are cached in memory per server for `SHOP_HOME_CACHE_SECONDS` (default 60). Per-viewer parts (personas, goal, specialty, own products, `recent`) are read on every request and never cached or stored. Sales are read from paid, uncancelled orders of the last 30 days only (newest first, capped at 20,000 orders).

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `SHOP_HOME_V2` | off | Turns on `GET /shop/home`. |
| `SHOP_HOME_SECTIONS` | all, in the order above | Comma list: which sections, in which order. Unknown keys are ignored. |
| `SHOP_HOME_MIN_ITEMS` | 4 | The fewest products a section needs to be shown. |
| `SHOP_HOME_CACHE_SECONDS` | 60 | Shared-data cache lifetime (0 = no cache). |

Role, goal and specialty category maps are config in `src/services/shop-recommendations.mjs` (`DEFAULT_ROLE_CATEGORIES`, `DEFAULT_GOAL_CATEGORIES`, `DEFAULT_SPECIALTY_CATEGORIES`). They reorder only and never restrict what a role can see or buy.

## Security change (product create)

`POST /vendor/products` and `POST /admin/products` (and duplicate) now **ignore** `rating`, `reviewCount` and `soldCount` in the body. A new product starts at 0/0/0. Only `reviewProduct` (from real reviews) and the order store (sales) change them. The update path already ignored them. Rows created before this change are not recomputed.

## Not in Phase 1

- `GET/PATCH /shop/preferences`, the personalisation switch, the `SHOP_PERSONALISATION` flag and any migration for them.
- Purchase-history signals, gender/age reordering, location and `popular_near_you`. The `needs` object (`buildNeeds`) already has `purchaseHistory`, `audience` and `location` set to `null` for these.
- Products have **no gender/age target attribute**. Gender/age reordering needs one first (Phase 2 data-model gap).
- `POST /shop/events`: there is no general analytics sink. `PromotionEvent` only takes promotion events (it needs a `promotionId` and has a fixed event list), so it is not a fit for home funnel events. Promoted Featured cards keep reporting through the existing `POST /events` with the `promotion.token` from this endpoint. Purchases of promoted products are still credited server-side as before.

## Code

- `src/services/shop-recommendations.mjs`: pure rules in four layers: identity `resolveShoppingMode`, needs `buildNeeds`, eligibility `filterEligible`, assembly `assembleSections` (+ `describeSections`, `categoriesFor`, `buildShopHome`).
- `src/services/shop-home-service.mjs`: loads inputs, caches shared data, shapes the response.
- `functions/shop-home.mjs`: the route.
- Specs: `specs/shop-recommendations.specs.mjs` (each layer), `specs/shop-home.specs.mjs` (service + route + create fix, CI DB), `specs/shop-home-regression.specs.mjs` (cart/checkout/orders unchanged with the flag off and on).

Swahili strings are drafts for native review.
