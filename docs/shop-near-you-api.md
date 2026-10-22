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

## Release rule

Switch `SHOP_NEAR_YOU` on only together with (or after) `SHOP_PERSONALISATION`, and only once the app build with the invite card / rationale sheet is live. Near-you needs personalisation to be **available and on** for the person, so with `SHOP_PERSONALISATION` off it never applies, even with `SHOP_NEAR_YOU` on. Older app builds never send `areaId` and ignore the new keys.

## Flag

| Env | Default | Off | On |
|---|---|---|---|
| `SHOP_NEAR_YOU` | off | `GET /shop/home` is **byte-identical** to before (no `nearYou` key, no `popular_near_you` section, no `deliversToViewerArea`, `areaId` ignored). `GET /shop/areas` → `404 feature_disabled`. `/shop/preferences` `uses` never lists `location`. `/vendor/tools/options` says `merch.shopAreas: false`. | Everything below. |

Not flagged (stored either way, like slice 2's product tags): the vendor area fields on the vendor profile and their validation, and the one-off backfill in the migration.

## Areas (`GeoArea`)

Existing table (moderation-promotion migration): `{ id, level: country|region|city|district, name, parentId, lat, lng, radiusKm, active }`. Admins add areas with `POST /admin/geo-areas`. An area is **usable** when it and every ancestor are `active`.

Coverage rule ("an area covers everything beneath it"): a **country** covers every region, city and district in it (= nationwide); a **region** covers its cities and their districts; a **city** covers its districts.

### `GET /shop/areas`

Signed in, any role (members for the device mapping, vendors for the pickers). Flag off → `404 {"error":"feature_disabled"}` (after sign-in: signed out is `401`).
Non-personal; the same for everyone. `Cache-Control: private, max-age=3600`. The app caches it for the session.

```json
{
  "areas": [
    { "id": "tz", "level": "country", "name": "Tanzania", "names": { "en": "Tanzania", "sw": "Tanzania" }, "parentId": null, "lat": -6.369, "lng": 34.889, "radiusKm": null },
    { "id": "tz-dar", "level": "region", "name": "Dar es Salaam", "names": { "en": "Dar es Salaam", "sw": "Dar es Salaam" }, "parentId": "tz", "lat": -6.792, "lng": 39.208, "radiusKm": 40 },
    { "id": "tz-dar-city", "level": "city", "name": "Dar es Salaam", "names": { "en": "Dar es Salaam", "sw": "Dar es Salaam" }, "parentId": "tz-dar", "lat": -6.792, "lng": 39.208, "radiusKm": 25 }
  ]
}
```

- Usable areas only, sorted by level (country, region, city, district) then name.
- `name` is the stored place name. Place names are not translated: `names.en` = `names.sw` = `name` (the key exists so a translated name can be added later without a contract change).
- `lat` / `lng` / `radiusKm` may be `null` (an area without a circle can never be matched on the device; it can still be picked by vendors).

**Device mapping (app, spec §7.1):** pick the **most specific** area (district > city > region) whose centre is within its `radiusKm` of the position. Never pick the country. No match → send no `areaId`. Coordinates stay on the device; nothing location-derived other than `areaId` is sent.

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
- `PUT /admin/vendors/:id` (scope `shop`; additive): also accepts `cityId`, `regionId`, `deliveryAreaIds` with the same rules and errors. Sets `areasSource: "admin"`. Audited in `vendor_management_updated` (before/after area fields).

### Backfill (migration `20270111120000-vendor-shop-areas`)

One-off, best effort, **never overwrites** a field that is already set:
- `cityId` / `regionId` from the free-text `address`: case-insensitive whole-word match of usable city/district names, then region names. More than one different city matched → left empty (no guess).
- `deliveryAreaIds` from `deliveryRegions` (list or comma text): each entry matched by **exact** case-insensitive name; region first, then city, then district; `Tanzania` / `nationwide` / `all of Tanzania` / `Tanzania nzima` → the country id. Entries that match nothing are skipped.
- Rows it fills get `areasSource: "backfill"`. `down` removes the area fields from rows still marked `backfill` only.
- The migration prints `[vendor-shop-areas] backfill: vendors=N, city=…, region=…, delivery=…, none=…`.

## `GET /shop/home?areaId=…`

New optional query `areaId`. Everything else unchanged (`docs/shop-home-api.md`).

**When it is used:** `SHOP_NEAR_YOU` on **and** personalisation `available` **and** the switch on (`personalisation.enabled`). Otherwise it is ignored silently (no error).

**Validation:** must be a usable `GeoArea` id of level region, city or district. Unknown, inactive, malformed, or a country → ignored silently (as if not sent). A **district rolls up to its city** for "based in" and "popular in" (delivery still respects district-level delivery areas, see below).

**Privacy:** the server does not store `areaId` anywhere (no table, no cache key, no audit, no analytics event) and does not log it: the request log line for `/shop/home` has the `areaId` parameter removed before it is written.

### Response additions (flag on only)

```json
{
  "nearYou": { "available": true, "areaId": "tz-dar-city", "areaName": { "en": "Dar es Salaam", "sw": "Dar es Salaam" } },
  "sections": [
    { "key": "popular_near_you", "title": { "en": "Popular near you", "sw": "Maarufu karibu nawe" },
      "reason": { "en": "Popular with shoppers in Dar es Salaam.", "sw": "Maarufu kwa wanunuzi wa Dar es Salaam." },
      "reasonCodes": ["popular_in_area", "delivers_to_area"], "reasonParams": { "areaName": "Dar es Salaam" },
      "viewAll": { "path": "/shop/products", "query": {} }, "productIds": ["prd_1", "prd_2", "prd_3", "prd_4"], "hasMore": false }
  ],
  "products": { "prd_1": { "id": "prd_1", "deliversToViewerArea": true } }
}
```

- `nearYou` (always present with the flag on):
  - `available`: near-you can be used for this person now (personalisation available **and** switch on). `false` → the app shows no invite card, no rail, no badge, and does not read location.
  - `areaId`, `areaName`: only when `available` and the sent `areaId` was valid. `areaId` echoes the id the app sent; `areaName` is that area's name in `{en, sw}`. Absent when the area was ignored → app: "No sellers listed for your area yet" is **not** implied; treat as "area not recognised", hide the rail.
- **Section `popular_near_you`** (only with a valid area):
  - Products whose vendor is **based in** the area or **delivers to** it.
    - Based in: the vendor's `cityId` (district → its city) is the viewer's city; for a viewer area that is a region, the vendor's `regionId` is that region.
    - Delivers to: one of the vendor's `deliveryAreaIds` is the viewer's area **or any area above it** (district → city → region → country). A vendor delivering to one district does not count for a viewer known only at city level.
  - Same eligibility as every rail (in stock, buyer-visible, not own products, vendor not suspended). Organic: products with a live paid or editorial promotion are left out (as `recommended`).
  - Ranking: paid, not cancelled orders in the last 30 days **picked up at a gym in the viewer's city** (region-level viewer: in the region), most first; then all paid orders in the last 30 days (the Best-sellers count); then the usual tie-break (admin priority, newest, id). Home-delivery addresses are free text and are **not** read for this.
  - At least `SHOP_HOME_MIN_ITEMS` (4) products, else left out (no message); at most 12; a product is in one section only.
  - **Display order:** after `recommended`, before `essentials` (spec §7.1). **Allocation order** (who gets a product that fits several): `featured`, `best_sellers`, `recently_viewed`, **`popular_near_you`**, `recommended`, `essentials`, `deals`, `new_arrivals`. Near-you takes products before Recommended because its pool is small (only local vendors): after Recommended had taken its 12 it would rarely reach 4; Recommended draws from the whole catalogue and refills easily. Featured, Best sellers and Recently viewed keep priority (paid disclosure, the global ranking, and the shopper's own explicit history).
  - `viewAll`: `{ path: "/shop/products", query: {} }` with `hasMore: false` (no list filter matches this rule yet; the app shows no "View all").
  - `reasonCodes` (closed list, in this order, only those that apply): `popular_in_area` (at least one product shown has local pickup orders), `delivers_to_area` (at least one product shown is from a vendor delivering to the area), `seller_in_area` (at least one product shown is from a vendor based in the area). `reasonParams: { "areaName": "<name>" }` (same in both languages).
  - `reason` is the first code's text:

| Code | en | sw [SW review] |
|---|---|---|
| `popular_in_area` | Popular with shoppers in {areaName}. | Maarufu kwa wanunuzi wa {areaName}. |
| `delivers_to_area` | It delivers to your current area. | Ina delivery kwenye eneo ulipo sasa. |
| `seller_in_area` | From sellers based in {areaName}. | Kutoka kwa wauzaji walioko {areaName}. |

- **`deliversToViewerArea: true`** on a product row (in `products`, any section) when the area is valid and allowed and the product's vendor **delivers to** the area (the rule above; "based in" alone does not set it). Absent otherwise (never `false`). For the "Delivers to your area" badge on the product sheet opened from the home (spec §7.3).
- `signalsUsed` gains `location` and `personalised` is `true` when the `popular_near_you` section is on the page.
- With the switch off (or not available): no section, no badge, `nearYou: { "available": false }`.

## `GET /shop/preferences`

`uses` gains `location` (between `profile_age` and `goal`) when `SHOP_NEAR_YOU` is on and personalisation is enabled for the person. It means "your current area is used **if you allow location** on this device"; the server cannot know the device choice. Flag off: unchanged.

## `GET /vendor/tools/options` and `GET /vendor/me`

`merch.shopAreas: true|false` (= `SHOP_NEAR_YOU`). Show the "Where you sell" pickers only when true.

## Not in this slice (follow-ups)

- `GET /shop/products?areaId=` / `GET /shop/products/:id?areaId=` (Results tiles and product sheet opened from Results, spec B-P2-10) are **not** built: those rows have no `deliversToViewerArea` yet, so the Results badge cannot show. The product sheet opened from the home can use the home `products` row.
- The server still honours `?maxDistanceKm=` on `/shop/products` (old app builds use it); the app stops sending it once areas exist.
- Buyer home-delivery addresses are not mapped to areas.
