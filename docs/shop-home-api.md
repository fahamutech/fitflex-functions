# Shop home API (Phase 1)

Status: on `release-candidate`, **dormant** (`SHOP_HOME_V2` off). Design spec: `docs/design/shop-home.md` in the parent repo (fitflex#65).
Scope (owner, 2026-10-19): Phase 1 = UI + foundations, with role-based rules only. Personalisation (purchase history, gender/age, location, the preference switch) is Phase 2.

## `GET /shop/home`

Phase 2 · slice 1 adds one key, `banners`, only when `SHOP_BANNERS` is on: see `docs/shop-banners-api.md`. With it off the answer below is unchanged.

Signed in (any role). With `SHOP_HOME_V2` off the answer is `404 {"error":"feature_disabled"}`; signed out is `401 {"error":"unauthenticated"}`. More than 60 calls a minute by one user is `429 {"error":"rate_limited"}`. The limit is kept in memory per server, so with several servers the real allowance is that many times 60.

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
  "allProductsCount": 23,
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
- `allProductsCount` (QA round 1, additive): how many products `GET /shop/products` lists with no filter. It **includes products the home itself leaves out**: out of stock, the viewer's own products, and products of vendors suspended on their account (the list does not check account suspension; see Eligibility). So it can be above 0 while every section is empty, and the "All products" grid can show items the rails never do.
- `products[id]` is exactly the row `GET /shop/products` returns. Products in the `featured` section also carry `promotion: { id, type, label, disclosure, commercial, token? }`, the same tag as `/discover/products`. The order of the Featured set is the mode's category order (the same order as `categories`), and within a category the Featured system's order. Every mode gets the same set.
- **Disclosure** (QA round 1, additive; also on every `/discover/*` promotion tag and on admin promotion views):
  ```json
  "promotion": { "id": "promo_1", "type": "featured", "label": "Featured · Sponsored",
    "disclosure": { "codes": ["featured", "sponsored"], "en": "Featured · Sponsored", "sw": "Iliyoangaziwa · Iliyodhaminiwa" },
    "commercial": true, "token": "…" }
  ```
  `label` is unchanged (English, for older apps). `disclosure.codes` ⊆ `featured`, `promoted`, `sponsored`, `recommended`, `campaign` and maps 1:1 to the app's `promo.<code>` strings. Prefer rendering from the codes joined with " · ". Otherwise use `disclosure.en` / `disclosure.sw` (built from the same words as the app: Iliyoangaziwa, Iliyopandishwa, Iliyodhaminiwa, Imependekezwa na FitFlex, Kampeni). `sponsored` is in `codes` **only when the promotion is paid for** (`commercial: true`). A non-paid label containing "Ad" or "Sponsored" does not get it, and `en` is always exactly `label`. A custom admin wording appears only in `en` (it is free English text), while `sw` is built from the codes.
- Ratings: `rating`/`reviewCount` come from real reviews only (see Security below). Show a rating only when `reviewCount ≥ 1`.

### Sections

Default display order is the table order: Featured, Best sellers, Recommended, … (design §5.1). `SHOP_HOME_SECTIONS` can change which sections show and in what order.

A product appears in **one section at most**. Which section gets it is decided in a **fixed allocation order**, not the display order: `featured` > `best_sellers` > `recently_viewed` > `recommended` > `essentials` > `deals` > `new_arrivals` (design DD-7). Recently viewed is the shopper's own history (at most 20), so it takes its products before the suggestion sections. It is still shown in its display position.

| key | What | Title (en / sw [SW review]) | viewAll.query |
|---|---|---|---|
| `featured` | The existing Featured system (`/discover/products`, placement `marketplace`): the same set for every mode, ordered by the mode's category order, then the Featured system's order. | member/vendor_personal "Featured gear" / "Vifaa vilivyoangaziwa"; trainer "Featured coaching gear" / "Vifaa vya trainer vilivyoangaziwa"; owner "Featured equipment" / "Vifaa vya gym vilivyoangaziwa" | `{category}` if all one category, else `{}`; `hasMore` always false |
| `best_sellers` | Products in paid, uncancelled orders placed in the last 30 days, ranked by number of orders, then units. Never `soldCount`. | "Best sellers" / "Zinazouzwa zaidi" | `{sort:"popularity"}` + `category` only if all one category |
| `recommended` | Organic only: **no product with any live promotion** (featured, promoted, sponsored, recommended, campaign; targeted anywhere, by area or radius) and nothing from `featured`. The role's categories come first, then paid orders (30 days) by buyers in this role, then all paid orders, then admin priority, newest, id. | "Popular with members / trainers / gym owners" / "Maarufu kwa wanachama / ma-trainer / wamiliki wa gym"; vendor_personal "Popular in the shop" / "Maarufu dukani" | `{sort:"popularity"}` + `category` only if all one category |
| `essentials` | Organic like `recommended`: **no product with any live promotion**. Takes turns across the needed categories (goal/specialty categories first, then role defaults). Within a category: paid orders (30 days), priority, newest. | member/vendor_personal "Training essentials" / "Mahitaji muhimu ya mazoezi"; trainer "Coaching essentials" / "Mahitaji muhimu ya trainer"; owner "Gym essentials" / "Mahitaji muhimu ya gym" | `{category}` if all one category (then `hasMore` can be true), else `{}` and `hasMore` false |
| `recently_viewed` | The `recent` ids in the app's order, eligible ones only. | "Recently viewed" / "Ulizotazama hivi karibuni" | `{category}` if all one category, else `{}`; `hasMore` always false |
| `deals` | `discountPriceTzs > 0` and `< priceTzs`, biggest % first. | "Deals" / "Ofa" | `{promotions:"true"}` + `category` only if all one category |
| `new_arrivals` | Created in the last 90 days, newest first. | "New arrivals" / "Bidhaa mpya" | `{category}` if all one category, else `{}`; `hasMore` always false |

- "Live promotion" is read with `promotionService.listLive({ anyLocation: true })`, a new option that skips location matching. A promotion targeted only by a radius is excluded too, even though the viewer sends no position. `best_sellers`, `deals`, `new_arrivals` and `recently_viewed` state facts, so a promoted product can still appear there, without a badge.
- **Ranking differs from the list's `sort=popularity` (known, Phase 2):** `best_sellers`, `recommended` and `essentials` rank by paid orders in the last 30 days. `GET /shop/products?sort=popularity` (the `viewAll` for `recommended` and `best_sellers`) still sorts by the stored all-time `soldCount`, so "View all" can show a different order from the section. Phase 2 should make the list use the same 30-day measure.
- At most 12 products per section. `hasMore` is true only when more qualified **and** `viewAll` can show them (see below), so the app shows "View all" exactly when `hasMore` is true.
- A section with fewer than `SHOP_HOME_MIN_ITEMS` (default **4**, from the build brief) products is left out entirely. The design spec (DD-7, §8.5) says **3**; the owner may choose, and setting `SHOP_HOME_MIN_ITEMS=3` follows the design. Its products stay available to later sections. If no section qualifies, `sections` is `[]`, but `categories` and `allProductsCount` still come back: show the categories and an "All products" grid from `/shop/products`. If `allProductsCount` is 0, show the "getting ready" empty state.
- `reasonCodes` come from the closed list in design §8.3 plus `profile_goal`, `trainer_specialty`, `recently_viewed`, `seller_discount`, `new_arrival`, `generic`. Build the Why sheet from these codes. `reason` is a ready-made sentence for simple display.
- `viewAll` = `{ path: "/shop/products", query }`. The rule: the list for `query` **includes every product the section shows**. `category` is added only when every product shown is in that one category, so a rail that mixes categories never points at one of them. Featured, Recently viewed, New arrivals and multi-category Essentials have no list filter that reproduces them, so their `hasMore` is always false.

### Eligibility (what never appears on the home)

The base is `shopService.listProducts({})`: active, not pending or rejected, not hidden, `homepageVisible`, the vendor may sell (KYC rule), and the product and vendor are not blocked in moderation. On top of that:
- out of stock (`stock ≤ 0`): never on the home, still in search and results;
- products of a vendor whose **account** is suspended (`User.accountStatus = 'suspended'`): excluded. Moderation suspension is already applied by `listProducts`. Note: `GET /shop/products` and checkout do **not** check account suspension today. That is an existing gap, not changed here;
- the viewer's own products: excluded in **every** mode when the person holds a vendor persona (design DD-12), not only in `vendor_personal`;
- delivery: products have no buyer-area coverage yet and gym pickup always exists, so nothing is excluded by delivery in Phase 1.

### Caching

The catalogue, vendor suspension, 30-day sales, the Featured list and the live-promotion set are cached in memory per server for `SHOP_HOME_CACHE_SECONDS` (default 60, kept within 1–300; a value that isn't a positive whole number means 60). One rebuild runs at a time: requests arriving while it runs wait for it. A failed rebuild is not cached. So a listing, moderation or suspension change can take up to that long to show on the home. Per-viewer parts (personas, goal, specialty, own products, `recent`) are read on every request and never cached or stored. Sales are read from paid, uncancelled orders of the last 30 days only (newest first, capped at 20,000 orders).

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `SHOP_HOME_V2` | off | Turns on `GET /shop/home`. |
| `SHOP_HOME_SECTIONS` | `featured,best_sellers,recommended,essentials,recently_viewed,deals,new_arrivals` | Comma list: which sections are shown, in which display order. Unknown keys are ignored. Allocation order is fixed (above). |
| `SHOP_HOME_MIN_ITEMS` | 4 | The fewest products a section needs to be shown. |
| `SHOP_HOME_CACHE_SECONDS` | 60 | Shared-data cache lifetime, 1–300 seconds. |

Role, goal and specialty category maps are config in `src/services/shop-recommendations.mjs` (`DEFAULT_ROLE_CATEGORIES`, `DEFAULT_GOAL_CATEGORIES`, `DEFAULT_SPECIALTY_CATEGORIES`). They reorder only and never restrict what a role can see or buy.

## Security change (product create)

`POST /vendor/products` and `POST /admin/products` (and duplicate) now **ignore** `rating`, `reviewCount` and `soldCount` in the body. A new product starts at 0/0/0. Only `reviewProduct` (from real reviews) and the order store (sales) change them. The update path already ignored them. Rows created before this change are not recomputed.

### Before go-live (not done, do not run without the owner's go-ahead)

A one-off recompute of existing products: `rating` and `reviewCount` from `ProductReview`, and `soldCount` from paid, uncancelled order lines. Products created before this change may still hold values a vendor typed in.

## Dev seed

The dev vendor login (`POST /auth/dev-login`, never in production) seeds `prd_dev_marketplace` with `rating 0, reviewCount 0, soldCount 0` and category `accessories_gear`. Previously it had 4.8 / 12 / 64 with no review rows and the invalid category `Equipment`. The seed overwrites the row, so existing dev/UAT databases are corrected on the next dev vendor login.

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

Swahili strings are drafts for native review. They follow `docs/localization/fitflex-terminology-glossary.md` (parent repo): "trainer" / "ma-trainer", role = "nafasi", and the Sponsored badge is "Iliyodhaminiwa".
