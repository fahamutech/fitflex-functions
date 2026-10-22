# Shop "Popular near you" API (Shop home Phase 2 · slice 3)

Status: branch `feat/shop-near-you` → `release-candidate`. **Dormant**: `SHOP_NEAR_YOU` is off unless set.
Design spec: parent repo `docs/design/shop-home-phase2.md` §7, §10.5–10.7, §13 (B-P2-8..10, B-P2-16), §15 S3-AC.
Builds on `docs/shop-home-api.md` (Phase 1), `docs/shop-banners-api.md` (slice 1) and `docs/shop-personalisation-api.md` (slice 2).

Owner decisions this implements (2026-10-22):
- Location = **device GPS with permission**. The area is worked out **on the device**. The server receives **only an `areaId`**, never coordinates. The `areaId` is **never stored and never logged**.
- The **"Personalised shop" switch also controls location**: switch off → no near-you at all (the app does not read location).
- Personalisation **not available** (under 18, invalid date of birth, no member persona) → no near-you.
- **No checkout delivery block.** Only a "Delivers to your area" badge. Checkout, prices and order rules are unchanged.
- The vendor-typed `distanceKm` is **never used** for near-you. The app hides the "Maximum distance" filter once areas exist (spec §7.3).

The privacy text that describes this is a **draft pending Tanzanian counsel**.

Review round 1 (2026-10-22) changed the contract: **minimum area size** (M1), **k = 5 distinct buyers** for "popular here" (M2, owner), the area moves to the **`X-FF-Area` header** (M3), **Swahili area names** (`GeoArea.nameSw`, `names.sw`, `reasonParams.areaName {en, sw}`), and the `delivers_to_area` text is now plural. Members with **no date of birth may use near-you** (owner, as for purchase history).

QA round 1 (2026-10-22, design-QA + UAT on RC be23f78) changed: **`reasonParams.areaName` names the level the claim is made at** (city / region, the district only for a district-exact delivery match); `popular_near_you.viewAll.query` is always `{}`; the badge (`deliversToViewerArea`) now also comes on **`GET /shop/products`** and **`GET /shop/products/:id`** via `X-FF-Area`.

## Live on merge, whatever the flag

- The backfill migration `20270111120000-vendor-shop-areas` **writes `User.vendorProfile`** (fills absent `cityId` / `regionId` / `deliveryAreaIds`, `areasSource: "backfill"`).
- Migration `20270111120100-geo-area-name-sw` adds `GeoArea.nameSw` and seeds two Swahili names.
- The vendor / admin area fields (`PUT /vendor/profile`, `PUT /admin/vendors/:id`) are validated and stored.
- `GET /admin/geo-areas` is readable with the `shop` scope; `POST /admin/geo-areas` accepts `nameSw`; new `PATCH /admin/geo-areas/:id` (`campaigns`).
- `/vendor/tools/options` and `/vendor/me` carry the new `merch.shopAreas` key (`false` while the flag is off).
- `GET /shop/home` request log lines have `areaId` removed (any spelling).

## Release rule

Switch `SHOP_NEAR_YOU` on only together with (or after) `SHOP_PERSONALISATION`, and only once the app build with the invite card / rationale sheet is live. Near-you needs personalisation to be **available and on** for the person, so with `SHOP_PERSONALISATION` off it never applies, even with `SHOP_NEAR_YOU` on. Older app builds never send `areaId` and ignore the new keys.

## Flag

| Env | Default | Off | On |
|---|---|---|---|
| `SHOP_NEAR_YOU_MIN_RADIUS_KM_DISTRICT` | 2 | Smallest district circle (km) the shop uses as "where you are". Can be raised, never below 2. |
| `SHOP_NEAR_YOU_MIN_RADIUS_KM_CITY` | 5 | Same for cities and regions. Can be raised, never below 5. |
| `SHOP_NEAR_YOU` | off | `GET /shop/home` is **byte-identical** to before (no `nearYou` key, no `popular_near_you` section, no `deliversToViewerArea`, `areaId` ignored). `GET /shop/areas` → `404 feature_disabled`. `/shop/preferences` `uses` never lists `location`. `/vendor/tools/options` says `merch.shopAreas: false`. | Everything below. |

Not flagged (stored either way, like slice 2's product tags): the vendor area fields on the vendor profile and their validation, and the one-off backfill in the migration.

## Areas (`GeoArea`)

Existing table (moderation-promotion migration): `{ id, level: country|region|city|district, name, parentId, lat, lng, radiusKm, active }`, plus **`nameSw`** (text, nullable; new): the Swahili place name, null = same as `name`. Seeded: `tz-znz-city` → "Mji wa Zanzibar", `tz-znz-stone-town` → "Mji Mkongwe" [SW review: native check].

**Locatable** (privacy, M1): an area may stand for "where you are" only if it is a region, city or district **with** `lat`, `lng`, `radiusKm` and `radiusKm` ≥ 2 km (district) / ≥ 5 km (city, region) (env above). The country is never locatable. Admins add areas with `POST /admin/geo-areas`. An area is **usable** when it and every ancestor are `active`.

Coverage rule ("an area covers everything beneath it"): a **country** covers every region, city and district in it (= nationwide); a **region** covers its cities and their districts; a **city** covers its districts.

### `GET /shop/areas`

Signed in, any role (members for the device mapping, vendors for the pickers). Flag off → `404 {"error":"feature_disabled"}` (after sign-in: signed out is `401`).
Non-personal; the same for everyone. `Cache-Control: private, max-age=3600`. The app caches it for the session.

```json
{
  "areas": [
    { "id": "tz", "level": "country", "name": "Tanzania", "names": { "en": "Tanzania", "sw": "Tanzania" }, "parentId": null, "locatable": false, "lat": null, "lng": null, "radiusKm": null },
    { "id": "tz-dar", "level": "region", "name": "Dar es Salaam", "names": { "en": "Dar es Salaam", "sw": "Dar es Salaam" }, "parentId": "tz", "locatable": true, "lat": -6.792, "lng": 39.208, "radiusKm": 40 },
    { "id": "tz-znz-city", "level": "city", "name": "Zanzibar City", "names": { "en": "Zanzibar City", "sw": "Mji wa Zanzibar" }, "parentId": "tz-znz", "locatable": true, "lat": -6.165, "lng": 39.202, "radiusKm": 12 }
  ]
}
```

- Usable areas only, sorted by level (country, region, city, district) then name.
- `name` is the stored (English) place name; `names.en` = `name`, `names.sw` = `nameSw` when set, else `name`. Show `names[lang]`.
- **`locatable`** (new): `false` for the country and for areas without a circle or below the minimum size; then `lat` / `lng` / `radiusKm` are **`null`** (so the device can never map a position to them). They stay in the list because vendors may still pick them in "Based in" / "Delivers to".

**Device mapping (app, spec §7.1):** among `locatable: true` areas only, pick the **most specific** (district > city > region) whose centre is within its `radiusKm` of the position. No match → send no area. Coordinates stay on the device; nothing location-derived other than `areaId` is sent.

## Vendor areas (vendor profile)

Stored in the vendor profile (`User.vendorProfile`, JSON), next to the free-text `address` and `deliveryRegions`, which stay for display.

| Field | Type | Rule |
|---|---|---|
| `cityId` | string \| null | "Based in". A usable area of level **city or district** (a district means "based in that district"; for near-you it counts as its city). |
| `regionId` | string \| null | The region the vendor is based in. A usable **region**. If `cityId` is given and `regionId` is not, the server fills it with the city's region. If both are given, the city must be inside the region. |
| `deliveryAreaIds` | string[] | "Delivers to". Usable areas of **any level**; the **country id = nationwide**; a region covers its cities and districts; a city covers its districts. Up to 50 ids; repeats are removed; ids already covered by another picked area are kept as sent (harmless). `[]` = "I don't deliver" (buyers can still collect). |
| `areasSource` | `"vendor"` \| `"admin"` \| `"backfill"` | Read-only, set by the server: who set the area fields last. `"backfill"` = guessed from the free text by the migration; the app may show the "check where you sell" nudge for it. |

### `PUT /vendor/profile` (vendor account holder; additive)

Accepts `cityId`, `regionId`, `deliveryAreaIds` alongside the existing fields. Leaving a field out keeps the stored value; `null` clears `cityId` / `regionId`; `[]` clears `deliveryAreaIds`. Not required for `publish` (vendors without areas keep selling; they just are not in near-you).

Errors (nothing is saved):
- `400 { "error": "invalid_area", "field": "cityId" | "regionId" | "deliveryAreaIds", "ids": ["…"], "reason": "unknown" | "inactive" | "wrong_level" | "not_in_region" | "too_many" | "not_a_list" }`

### `GET /vendor/profile`

Returns the stored profile as before, now including `cityId`, `regionId`, `deliveryAreaIds`, `areasSource` when set.

### Admin (mapping)

- `GET /admin/vendors`: each vendor's `vendorProfile` carries the same four fields when set (no new top-level keys).
- `GET /admin/geo-areas` (existing): now also readable with the **`shop`** scope (before: `promotions`, `promotions_approve` or `campaigns`), so a shop-only admin can load the area tree for mapping while `SHOP_NEAR_YOU` is off (`/shop/areas` is 404 then). **Read only**: `POST /admin/geo-areas` still needs `campaigns`. No new scope. The response is unchanged (all areas incl. inactive, sorted by name; filter `active` in the portal).
- `POST /admin/geo-areas` (scope `campaigns`): also accepts optional `nameSw` (string ≤ 120). Note for admins: an area is used for "near you" only with `lat`, `lng` and `radiusKm` ≥ 2 km (district) / 5 km (city, region).
- **New** `PATCH /admin/geo-areas/:id` (scope `campaigns`): body `{ "nameSw": "…" | null }` → `{ area }`. `404 area_not_found`; `422 nothing_to_update { allowed: ["nameSw"] }` | `422 invalid_name_sw`. Audited (`promotion.geo_area_updated`). Only `nameSw` can be changed.
- `PUT /admin/vendors/:id` (scope `shop`; additive): also accepts `cityId`, `regionId`, `deliveryAreaIds` with the same rules and errors. Sets `areasSource: "admin"`. Audited in `vendor_management_updated` (before/after area fields).

### Backfill (migration `20270111120000-vendor-shop-areas`)

One-off, best effort, **never overwrites** a field that is already set:
- `cityId` / `regionId` from the free-text `address`: case-insensitive whole-word match of usable city/district names, then region names. More than one different city matched → left empty (no guess).
- `deliveryAreaIds` from `deliveryRegions` (list or comma text): each entry matched by **exact** case-insensitive name; region first, then city, then district; `Tanzania` / `nationwide` / `all of Tanzania` / `Tanzania nzima` → the country id. Entries that match nothing are skipped.
- Rows it fills get `areasSource: "backfill"`. `down` removes the area fields from rows still marked `backfill` only.
- The migration prints `[vendor-shop-areas] backfill: vendors=N, city=…, region=…, delivery=…, none=…`.

## `GET /shop/home` with the viewer's area

Send the area id in the request header **`X-FF-Area: <GeoArea id>`** (M3: headers are not in request log lines). The query `?areaId=` is still accepted **for one release** (old builds of this slice); the header wins when both are sent; a blank header falls back to the query. Everything else unchanged (`docs/shop-home-api.md`). Web: `X-FF-Area` is a custom header, so the browser sends a CORS preflight; the server's CORS setup reflects requested headers.

**When it is used:** `SHOP_NEAR_YOU` on **and** personalisation `available` **and** the switch on (`personalisation.enabled`). Otherwise it is ignored silently (no error).

**Validation:** must be a usable, **locatable** `GeoArea` id (region, city or district with a big enough circle). Unknown, inactive, malformed, the country, or too small → ignored silently (as if not sent). A **district rolls up to its city** for "based in" and "popular in" (delivery still respects district-level delivery areas, see below).

**Privacy:** the server does not store the area anywhere (no table, no cache key, no audit, no analytics event) and does not log it. The in-process request log line for `/shop/home` has every query parameter whose key is `areaId` removed before it is written — matched case-insensitively **after percent-decoding the key** and ignoring a `[...]` suffix (`%61reaId`, `area%49d`, `AREAID`, `areaId[]`, `areaId%5B%5D`). **Platform / ingress logs (BFast hosting) are outside this repo and need confirming** — another reason to use the header.

### Response additions (flag on only)

```json
{
  "nearYou": { "available": true, "areaId": "tz-dar-city", "areaName": { "en": "Dar es Salaam", "sw": "Dar es Salaam" } },
  "sections": [
    { "key": "popular_near_you", "title": { "en": "Popular near you", "sw": "Maarufu karibu nawe" },
      "reason": { "en": "Popular with shoppers in Dar es Salaam.", "sw": "Maarufu kwa wanunuzi wa Dar es Salaam." },
      "reasonCodes": ["popular_in_area", "delivers_to_area"], "reasonParams": { "areaName": { "en": "Dar es Salaam", "sw": "Dar es Salaam" } },
      "viewAll": { "path": "/shop/products", "query": {} }, "productIds": ["prd_1", "prd_2", "prd_3", "prd_4"], "hasMore": false }
  ],
  "products": { "prd_1": { "id": "prd_1", "deliversToViewerArea": true } }
}
```

- `nearYou` (always present with the flag on):
  - `available`: near-you can be used for this person now (personalisation available **and** switch on). `false` → the app shows no invite card, no rail, no badge, and does not read location.
  - `areaId`, `areaName`: only when `available` and the sent area was valid. `areaId` echoes the id the app sent; `areaName` is `{ en: name, sw: nameSw || name }`. Absent when the area was ignored → app: "No sellers listed for your area yet" is **not** implied; treat as "area not recognised", hide the rail.
- **Section `popular_near_you`** (only with a valid area):
  - Products whose vendor is **based in** the area or **delivers to** it.
    - Based in: the vendor's `cityId` (district → its city) is the viewer's city; for a viewer area that is a region, the vendor's `regionId` is that region.
    - Delivers to: one of the vendor's `deliveryAreaIds` is the viewer's area **or any area above it** (district → city → region → country). A vendor delivering to one district does not count for a viewer known only at city level.
  - Same eligibility as every rail (in stock, buyer-visible, not own products, vendor not suspended). Organic: products with a live paid or editorial promotion are left out (as `recommended`).
  - Ranking: the number of **distinct buyers** whose paid, not cancelled orders in the last 30 days were **picked up at a gym in the viewer's city** (region-level viewer: in the region), most first — counted only when **at least 5 distinct buyers** bought that product there (owner 2026-10-22, k = 5; below that the local count is 0, so no "popular here" signal ever rests on one to four people); then all paid orders in the last 30 days (the Best-sellers count); then the usual tie-break (admin priority, newest, id). Home-delivery addresses are free text and are **not** read for this. Buyer ids are used only to count and are not kept in the cache.
  - At least `SHOP_HOME_MIN_ITEMS` (4) products, else left out (no message); at most 12; a product is in one section only.
  - **Display order:** after `recommended`, before `essentials` (spec §7.1). **Allocation order** (who gets a product that fits several): `featured`, `best_sellers`, `recently_viewed`, **`popular_near_you`**, `recommended`, `essentials`, `deals`, `new_arrivals`. Near-you takes products before Recommended because its pool is small (only local vendors): after Recommended had taken its 12 it would rarely reach 4; Recommended draws from the whole catalogue and refills easily. Featured, Best sellers and Recently viewed keep priority (paid disclosure, the global ranking, and the shopper's own explicit history).
  - `viewAll`: always `{ path: "/shop/products", query: {} }` with `hasMore: false` — never a category, even when every product shown shares one (QA1: no list filter matches this rule, and a category would hint at what local vendors sell). The app shows no "View all".
  - `reasonCodes` (closed list, in this order, only those that apply): `popular_in_area` (at least one product shown has a local count, i.e. ≥ 5 distinct local buyers), `delivers_to_area` (at least one product shown is from a vendor delivering to the area), `seller_in_area` (at least one product shown is from a vendor based in the area). **`reasonParams: { "areaName": { "en": "…", "sw": "…" } }`** (changed from a string).
  - **Which area `areaName` names (QA1, truthful reasons)** — the area the claim behind the **first** reason code is computed at, which may differ from `nearYou.areaName` (always the viewer's own area):
    - `popular_in_area`, `seller_in_area`: the viewer's **city** (local counts and "based in" are per city); for a region-level viewer, the **region**. Never the viewer's district. Kinondoni viewer → "Popular with shoppers in Dar es Salaam."; Stone Town viewer → "From sellers based in Zanzibar City." / "Kutoka kwa wauzaji walioko Mji wa Zanzibar."
    - `delivers_to_area`: the viewer's **district** only when every delivering vendor shown lists that district itself in `deliveryAreaIds`; otherwise the city (region for a region-level viewer). The rail text does not print the name, but the Why sheet may.
  - `reason` is the first code's text:

| Code | en | sw [SW review] |
|---|---|---|
| `popular_in_area` | Popular with shoppers in {areaName.en}. | Maarufu kwa wanunuzi wa {areaName.sw}. |
| `delivers_to_area` | These sellers deliver to your current area. | Wauzaji hawa wana delivery hadi eneo ulipo sasa. |
| `seller_in_area` | From sellers based in {areaName.en}. | Kutoka kwa wauzaji walioko {areaName.sw}. |

The per-product Why reason in the product sheet (spec §10.6 `shop.why.deliversToArea`, singular "It delivers to your current area.") is app copy and is unchanged; the rail reason above is plural.

- **`deliversToViewerArea: true`** on a product row (in `products`, any section) when the area is valid and allowed and the product's vendor **delivers to** the area (the rule above; "based in" alone does not set it). Absent otherwise (never `false`). For the "Delivers to your area" badge on the product sheet opened from the home (spec §7.3). Results and the product sheet use the routes below.
- `signalsUsed` gains `location` and `personalised` is `true` when the `popular_near_you` section is on the page.
- With the switch off (or not available): no section, no badge, `nearYou: { "available": false }`.

## Badge outside the home: `GET /shop/products`, `GET /shop/products/:id` (QA1)

Send the same **`X-FF-Area: <GeoArea id>`** header (header only; `?areaId=` is **not** read on these routes). Same validation (usable and locatable), same gating (`SHOP_NEAR_YOU` on, personalisation available and switched on), same privacy (never stored or logged; any `areaId` query key is removed from the request log line, as on `/shop/home`).

- Allowed and valid: each row whose vendor **delivers to** the area carries `deliversToViewerArea: true` (list rows; on details the product itself **and** its `similarProducts` rows). "Based in" alone does not set it. Never `false`.
- Flag off, not allowed (switch off, under 18, invalid date of birth, no member persona), header missing, or area unknown / inactive / country / too small: the field is **absent** and the body is byte-identical to a call without the header.
- Vendor areas are read from the shop home cache, so a vendor's change shows within `SHOP_HOME_CACHE_SECONDS` (default 60 s).
- Nothing else in these responses changes; filters, sorting and checkout are unchanged (no delivery block).

## `GET /shop/preferences`

`uses` gains `location` (between `profile_age` and `goal`) **in every mode** (`?mode=`, functions#246) when `SHOP_NEAR_YOU` is on and personalisation is enabled for the person. It means "your current area is used **if you allow location** on this device"; the server cannot know the device choice. Flag off: unchanged.

## `GET /vendor/tools/options` and `GET /vendor/me`

`merch.shopAreas: true|false` (= `SHOP_NEAR_YOU`). Show the "Where you sell" pickers only when true.

## Not in this slice (follow-ups)

- `GET /shop/vendors/:id` (store page) and `/discover/products` carry no badge yet.
- The server still honours `?maxDistanceKm=` on `/shop/products` (old app builds use it); the app stops sending it once areas exist.
- Buyer home-delivery addresses are not mapped to areas.
