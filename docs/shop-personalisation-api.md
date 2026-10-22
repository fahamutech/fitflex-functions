# Shop personalisation API (Shop home Phase 2 · slice 2)

Status: branch `feat/shop-personalisation` → `release-candidate`. **Dormant**: `SHOP_PERSONALISATION` is off unless set.
Design spec: parent repo `docs/design/shop-home-phase2.md` §6, §10.5–10.6, §13 (B-P2-5..7), §15 S2-AC; Phase 1 `docs/design/shop-home.md` §8.
Builds on `docs/shop-home-api.md` (Phase 1) and `docs/shop-banners-api.md` (slice 1).

Owner decisions this implements (final, 2026-10-20): purchase history and gender/age are **on by default with one opt-out** ("Personalised shop"); gender/age only **reorder** products a vendor tagged, **member mode only**, never filter, never in a title; **under-18 → personalisation fully off** (spec Q-6 recommendation accepted); nothing is ever inferred from activity, health, training, sponsor/company or KYC data; the flag may go on right after QA. The privacy text describing this is a **draft pending Tanzanian counsel**.

## Flag and settings

| Env | Default | Meaning |
|---|---|---|
| `SHOP_PERSONALISATION` | off | Turns on everything below. Off: `GET /shop/home` is **byte-identical** to before (no `personalisation` key, no new reasons), `PUT /shop/preferences` is `404 feature_disabled`, `GET /shop/preferences` says `available: false`, `/vendor/tools/options` says `merch.productTargets: false`. |
| `SHOP_HISTORY_DAYS` | 365 | How far back purchase history is read (whole days, 1–730; anything else = 365). |

Fixed in code (`src/services/shop-personalisation.mjs`): non-consumables bought in the last **30 days** are not suggested again; consumable categories = `supplements_nutrition`, `food_drinks`.

## Who can be personalised (`available`)

`available` = flag on **and** the Person holds a usable **member** persona (or the signed-in account is a member) **and** that member is **not under 18**. Age is whole years on today's East Africa day from `memberProfile.dateOfBirth` of the member persona.
- Under 18 → `available: false`: no purchase history, no gender, no age, anywhere, in every mode.
- No date of birth → still available; only the age signal is never used.
- No member persona (e.g. a trainer-only or owner-only account) → `available: false` (no date of birth to rule out a minor). **Deviation from spec §6.3**, which shows the switch with the partner hint in every mode: with this rule a trainer/owner sees personalisation only if the same Person also holds an adult member persona. Then purchase history applies in trainer/owner/vendor_personal mode too; gender/age never do.

`enabled` = `available` **and** the stored preference is on.

## `GET /shop/preferences`

Signed in, any role. Always `200` (also with the flag off):

```json
{ "personalised": true, "available": true }
```

- `personalised`: the stored choice; **no row = `true`** (on by default, new and existing accounts).
- The setting belongs to the **Person** (all roles of the account share it). An account with no Person uses its own user id.

## `PUT /shop/preferences`

Signed in, any role. Flag off → `404 {"error":"feature_disabled"}`.

```json
{ "personalised": false, "source": "why_sheet" }
```

| Field | Rule | Error |
|---|---|---|
| `personalised` | boolean, required | `400 {"error":"invalid_field","field":"personalised"}` |
| `source` | `privacy_page` \| `why_sheet`, required | `400 {"error":"invalid_field","field":"source","allowed":["privacy_page","why_sheet"]}` |

→ `200` same shape as GET. More than 30 calls a minute per user → `429 {"error":"rate_limited"}` (in memory per server).
Saving is allowed even when `available` is false (it is just never applied). Each **change** writes an audit row `shop_preference_changed` (actor = signed-in user, target = person/user key, before `{personalised}`, after `{personalised, source}`); saving the same value again writes nothing.

## `GET /shop/home` (flag on)

Everything from `docs/shop-home-api.md` stays. Additions, **only with the flag on**:

```json
{
  "personalisation": { "available": true, "enabled": true },
  "personalised": true,
  "signalsUsed": ["role", "purchase_history", "profile_gender"],
  "sections": [{
    "key": "recommended",
    "title": { "en": "Recommended for you", "sw": "Zilizopendekezwa kwako" },
    "reason": { "en": "You've bought Sportswear & footwear before.", "sw": "Uliwahi kununua Mavazi na viatu vya michezo." },
    "reasonCodes": ["bought_category", "profile_gender", "role_context"],
    "reasonParams": { "category": "sportswear_footwear" },
    "...": "viewAll, productIds, hasMore as before"
  }]
}
```

- `personalisation` is always present with the flag on.
- `personalised` is `true` **only when a personal signal actually changed the page** (a section's products or their order differ from the page without it). Otherwise `false`.
- `signalsUsed` may now also hold `purchase_history`, `profile_gender`, `profile_age`, each only when it actually changed something.
- New `reasonCodes`: `bought_category`, `bought_product`, `profile_gender`, `profile_age`, on the section they changed only.
- New optional `reasonParams` on a section: `{ "category": "<category key>" }` with `bought_category`, `{ "productName": "<name>" }` with `bought_product`. Absent otherwise. Build the Why sheet from codes + params (the category's name comes from `categories`/`GET /shop/categories`); `reason` is a ready sentence. `profile_gender` / `profile_age` carry **no parameter** and the text never names a gender or an age group ("The gender in your profile." / "The age in your profile.").
- `products[id]` rows are unchanged: **no `targetGender` / `targetAgeBands` on buyer rows**.

### What each signal does (enabled only)

**Purchase history** (`purchase_history`): the Person's own orders, all their personas, `paymentStatus = paid`, `status ≠ cancelled`, placed in the last `SHOP_HISTORY_DAYS`. Read per request, never stored as a profile, never cached, never shared between users. Another user's orders are never read.
- `recommended` and `essentials`: bought categories come first (most orders, then most recent first); within that, the Phase 1 order.
- A **non-consumable** product bought in the last 30 days is not shown again in `recommended` / `essentials`. Consumables may come back (and are then the `bought_product` reason).
- `recommended` title becomes **"Recommended for you" / "Zilizopendekezwa kwako"** (P1 `shop.home.recommended`) when history changed it; reason `bought_product {productName}` ("Suggested because you bought {product}." / "Imependekezwa kwa sababu ulinunua {product}.") when the rail shows a product the person bought before (a consumable at any time, anything else only once 30 days have passed), else `bought_category {category}` ("You've bought {category} before." / "Uliwahi kununua {category}.") (the top bought category in the rail).
- `essentials` keeps its title; reason gets `bought_category {category}` when history changed it.
- Paid placements are still never in `recommended` or `essentials`.

**Gender / age** (`profile_gender`, `profile_age`): **member mode only**, declared `memberProfile.gender` (`female` → `women`, `male` → `men`; `other`/unset → not used) and `memberProfile.dateOfBirth` (band `18_29`, `30_44`, `45_59`, `60_plus`).
- `profile_gender` / `profile_age` are reported only when the **final** order of that rail differs from the order without gender/age; if both tags point the same way both are reported, if they cancel out neither is.
- Applied **after** the sections are filled, within `recommended` and `essentials` only: a stable reorder that moves products whose vendor tag matches (gender match +1, age band match +1) earlier. The **set of products in every section is identical with or without it**; untagged products and products tagged for another group stay where they are relative to each other.
- Never in trainer, owner or vendor_personal mode.

### Switch off (stored `personalised: false`, flag on)

`personalisation.enabled: false`, and (spec P1 §8.2):
- `recommended` title **"Popular in the shop" / "Maarufu dukani"**, reason "Suggested from what's popular on FitFlex." codes `["generic","role_context"]`;
- no purchase history, gender or age; **also no declared goal or trainer specialty** (`profile_goal`, `trainer_specialty` and the `goal`/`specialty` signals disappear): the page only uses the role;
- `recently_viewed` still shows (it is the ids the app itself sends; the app may stop sending them when off);
- `personalised: false`, `signalsUsed` ⊆ `role`, `recently_viewed`.

### Not available (flag on; under 18, or no member persona)

`personalisation: { "available": false, "enabled": false }`; the page is the Phase 1 page (role, declared goal/specialty, recently viewed), never purchase history, gender or age. If such an account also stored `personalised: false`, the switch-off rules above apply.

## Product target fields

Migration `20270105090000-shop-personalisation`: `Product.targetGender` text (`women` | `men` | null = everyone) and `Product.targetAgeBands` text[] (subset of `18_29`, `30_44`, `45_59`, `60_plus`; empty = all ages). Existing products: null / empty.

| Where | Behaviour |
|---|---|
| `POST /vendor/products`, `PUT /vendor/products/:id` | Accepted (vendor + vendor_staff with `products`). Create: missing = null / `[]`. Update: missing = unchanged; `null` clears gender; `[]` clears bands. **Not review fields**: changing them never sends an approved product back to pending. Accepted whether or not the flag is on. |
| Validation | `targetGender` not one of `women`, `men`, null → `400 {"error":"invalid_field","field":"targetGender","allowed":["women","men",null]}`. `targetAgeBands` not an array, an unknown value, or a repeat → `400 {"error":"invalid_field","field":"targetAgeBands","allowed":["18_29","30_44","45_59","60_plus"]}`. |
| Vendor rows | `GET /vendor/products` and the create/update/duplicate responses carry `targetGender` and `targetAgeBands`. Duplicate copies them. |
| `GET /admin/products` | Rows carry both fields, **read-only**. Filters: `?targetGender=women|men|everyone` (everyone = null), `?targetAgeBand=18_29|30_44|45_59|60_plus|all` (a band = products whose list contains it; `all` = empty list). Bad value → `400 {"error":"invalid_filter","field":"targetGender"|"targetAgeBand","allowed":[...]}`. |
| `POST /admin/products`, `PUT /admin/products/:id/listing` | Do **not** accept them (ignored; spec Q-7 says editing is in the vendor app). |
| Buyer rows | `/shop/products`, `/shop/products/:id` (incl. `similarProducts`), `/shop/vendors/:id`, `/discover/products`, `/shop/home` **never** carry them. |
| `GET /vendor/tools/options` | `merch.productTargets: true` when `SHOP_PERSONALISATION` is on. The app shows the "Who it's for (optional)" section only then. |

## Deviations from the design spec (stated)

1. Endpoints are `GET/PUT /shop/preferences` (spec B-P2-5 suggested `/me/shop-preferences`; P1 suggested `/me/...`).
2. The preference belongs to the Person (`ShopPreference.personId`), not a single user row, so all roles share it (P1 D-2).
3. `available` needs an adult member persona (see above); spec §6.3 shows the switch in every mode.
4. Switch off also drops the declared goal and specialty (stricter reading of "no personal reasons").
5. `reasonParams` is a new optional object; `reasonCodes` stays a string array.

## Data model

`ShopPreference { personId text PK, subjectType 'person'|'user', personalised boolean, source 'privacy_page'|'why_sheet', updatedBy text, updatedAt timestamptz }`. No row = on. Migration is additive; `down` drops the table and the two Product columns.

## Code

- `src/services/shop-personalisation.mjs`: pure signal rules (history, rebuy window, audience, stable reorder).
- `src/services/shop-preference-service.mjs` + `src/infra/shop-preference-store-pg.mjs`: the preference and its audit.
- `src/services/shop-home-service.mjs` / `shop-recommendations.mjs`: wiring into the page.
- `functions/shop-preferences.mjs`: routes.
- Specs: `specs/shop-personalisation*.specs.mjs`.

Swahili strings are drafts for native review and reuse the P1 spec §10.6 wording (`shop.home.recommended`, `shop.why.boughtCategory`, `shop.why.boughtProduct`, `shop.why.gender`, Phase 2 `shop.why.age`).
