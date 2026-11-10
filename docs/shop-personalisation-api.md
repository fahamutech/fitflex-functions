# Shop personalisation API (Shop home Phase 2 · slice 2)

Status: branch `feat/shop-personalisation` → `release-candidate`. **Dormant**: `SHOP_PERSONALISATION` is off unless set.
Design spec: parent repo `docs/design/shop-home-phase2.md` §6, §10.5–10.6, §13 (B-P2-5..7), §15 S2-AC; Phase 1 `docs/design/shop-home.md` §8.
Builds on `docs/shop-home-api.md` (Phase 1) and `docs/shop-banners-api.md` (slice 1).

Owner decisions this implements (final, 2026-10-20): purchase history and gender/age are **on by default with one opt-out** ("Personalised shop"); gender/age only **reorder** products a vendor tagged, **member mode only**, never filter, never in a title; **under-18 → personalisation fully off** (spec Q-6 recommendation accepted); nothing is ever inferred from activity, health, training, sponsor/company or KYC data; the flag may go on right after QA. The privacy text describing this is a **draft pending Tanzanian counsel**.
Owner decision 2026-10-22: an account with **no date of birth** gets **purchase history only** (never gender or age) until a valid adult date of birth is set; trainer/owner-only accounts stay without personalisation for now (date of birth at their onboarding is a separate fix).
Owner go-ahead 2026-11-10 (partner DOB slice 4): **trainer and owner mode** are personalised from the Person's own declared details behind `SHOP_PERSONALISATION_PARTNERS` (off by default). See [Trainer and owner mode](#trainer-and-owner-mode-shop_personalisation_partners). The privacy text that describes it is still a **draft pending Tanzanian counsel** (partner DOB slice 5).

## Release rule (must hold before the flag goes on)

**`SHOP_PERSONALISATION` must not be switched on until the app build with the "Personalised shop" switch (mobile#214) is live** for members. Older builds have no opt-out (the owner's one opt-out would not exist for them) and cannot render the `bought_category` / `bought_product` reasons. The backend side may be deployed dormant at any time.

## Flag and settings

| Env | Default | Meaning |
|---|---|---|
| `SHOP_PERSONALISATION` | off | Turns on everything below. Off: `GET /shop/home` is **byte-identical** to before (no `personalisation` key, no new reasons), `PUT /shop/preferences` is `404 feature_disabled`, `GET /shop/preferences` says `available: false`, `/vendor/tools/options` says `merch.productTargets: false`. |
| `SHOP_PERSONALISATION_PARTNERS` | off | Partner DOB slice 4. Has an effect **only while `SHOP_PERSONALISATION` is on too**. Off: every `/shop/home` and `/shop/preferences` body is **byte-identical** to before (trainer/owner-only accounts `available: false`; gender/age member mode only). On: trainer and owner mode follow [Trainer and owner mode](#trainer-and-owner-mode-shop_personalisation_partners). |
| `SHOP_HISTORY_DAYS` | 365 | How far back purchase history is read (whole days, 1–730; anything else = 365). |

Fixed in code (`src/services/shop-personalisation.mjs`): non-consumables bought in the last **30 days** are not suggested again; consumable categories = `supplements_nutrition`, `food_drinks`.

## Who can be personalised (`available`)

`available` = flag on **and** the Person holds a usable **member** persona (or the signed-in account is a member) **and** that member's `memberProfile.dateOfBirth` allows it. Age is whole years on today's East Africa day.

| Member's stored `dateOfBirth` | `available` | Purchase history | Gender / age |
|---|---|---|---|
| absent (missing, null, `""`, blanks) | true | yes | **never** |
| present but not valid (not strict `YYYY-MM-DD`, not a real day, before 1901-01-01, after today) | **false (fail closed)** | no | no |
| valid, under 18 | false | no | no |
| valid, 18 or over | true | yes | yes (member mode only) |

Examples that count as **not valid** (fail closed): `2011/05/03`, `03/05/2011`, `2011-5-3`, ` 2011-05-03`, `2027-01-01` (future), `2023-02-30`.
- No member persona (e.g. a trainer-only or owner-only account) → `available: false` (no date of birth to rule out a minor). **Deviation from spec §6.3**, which shows the switch with the partner hint in every mode: with this rule a trainer/owner sees personalisation only if the same Person also holds a member persona that allows it (table above). Then purchase history applies in trainer/owner/vendor_personal mode too; gender/age never do. Owner 2026-10-22: stays so in this PR.

`enabled` = `available` **and** the stored preference is on.

The table above is **member mode** (and vendor_personal; and every mode while `SHOP_PERSONALISATION_PARTNERS` is off). With `SHOP_PERSONALISATION_PARTNERS` on, `available` in trainer and owner mode follows the next section instead, so `available` can differ per `?mode`.

## Trainer and owner mode (`SHOP_PERSONALISATION_PARTNERS`)

Applies only when **both** `SHOP_PERSONALISATION` and `SHOP_PERSONALISATION_PARTNERS` are on. Trainer and owner mode (the `?mode` the caller holds, defaulting to the signed-in role) are then personalised from the Person's own declared details. With `SHOP_PERSONALISATION_PARTNERS` off, nothing in this section applies and every body is byte-identical to before.

### One date-of-birth verdict per Person (security review M1)

While the flag is on, the shop gives **one** answer per Person, and that answer is the same **in every mode, member mode and vendor_personal included**. It is built from `Person.dateOfBirth` **and every member persona's** `memberProfile.dateOfBirth`, including suspended personas (the same rows `memberDateOfBirth` in `personal-details-service` reads). An account without a Person uses only its own member profile.

| Dates found (Person + all member personas) | Verdict | Effect |
|---|---|---|
| none present | absent | trainer/owner: `available: true`, purchase history only (never gender or age). Member/vendor_personal: the member rules as before. |
| **any** present date invalid (not strict `YYYY-MM-DD`, not a real day, before 1901, in the future) | invalid | **nothing, in every mode** (fail closed; `available: false`, `uses: []`) |
| **any** present date under 18 | under 18 | **nothing, in every mode** |
| all present dates adult | adult | trainer/owner: purchase history plus gender and age. The age comes from `Person.dateOfBirth`, or from the first valid member date (the signed-in member's first) when the Person has none. Member/vendor_personal: the member rules as before (member mode still takes its age and gender from the member profile). |

Both conflict directions block: an adult Person with an under-18 member persona, and an under-18 (or invalid) Person with an adult member persona. A present but invalid `Person.dateOfBirth` never falls through to the member profile. **Difference from `/me/personal-details`**: that endpoint treats an invalid stored `Person.dateOfBirth` as absent (unchanged). The shop treats it as invalid, so the shop gives nothing.

**Gender** (adults, trainer/owner mode): trainer mode uses `TrainerProfile.gender` (the gender shown to clients), else `Person.gender`. Owner mode uses `Person.gender` and never a trainer profile. `female` maps to women and `male` to men. `other` or `NULL` ("prefer not to say") gives **no gender signal**, but the age band still applies. A declared `other` on the trainer profile is not overridden by `Person.gender`.

Gender and age **only reorder** `recommended` and `essentials` (the same `reorderForAudience` as member mode). They never filter, and they never appear in a title or reason text. The shop reads only `Person.dateOfBirth`, `Person.gender`, `TrainerProfile.gender`, the member personas' dates of birth, and the person's own paid orders. It never reads activity, health, training, KYC, sponsor or company data. The one opt-out per Person applies in every mode.

| Mode (enabled) | `uses` |
|---|---|
| trainer, adult | `purchase_history`, `profile_gender` (declared `female`/`male`), `profile_age`, `location` (SHOP_NEAR_YOU), `specialty` (declared specialties that map to categories) |
| trainer, no date of birth | `purchase_history`, `location`, `specialty` |
| owner, adult | `purchase_history`, `profile_gender` (declared `female`/`male`), `profile_age`, `location` |
| owner, no date of birth | `purchase_history`, `location` |
| any mode, verdict invalid or under 18 | `[]` |
| switched off | `[]` |

### `profileSignals` (contract check 1)

`GET /shop/preferences` and the `PUT` answer carry **`"profileSignals": true` in trainer and owner mode, only while both flags are on**, whatever the availability. In every other case the key is **absent**: member or vendor_personal mode, or either flag off. That keeps flag-off bodies byte-identical. The app shows its "add your date of birth" hint only when the key is `true`.

```json
{ "personalised": true, "available": true, "historyDays": 365, "mode": "trainer", "uses": ["purchase_history", "specialty"], "profileSignals": true }
```

### `GET /shop/home` in these modes

`personalisation: { available, enabled }` follows the tables above. `signalsUsed` may now hold `profile_gender` / `profile_age`, and `recommended` / `essentials` may carry the `reasonCodes` `profile_gender` / `profile_age`. These are the existing codes and reason sentences: there is **no new user-facing text**. A trainer- or owner-only account is no longer `no_member` in those modes. A `?mode` the person does not hold is answered `403 mode_not_allowed` **before** any profile, preference, Person detail or order is read (security review L2).

`GET /shop/products` and `/shop/products/:id` take no `?mode`, so their "Delivers to your area" badge uses the **session's default shopping mode** (security review L3, contract check 3: accepted as is).

### Release rule

`SHOP_PERSONALISATION_PARTNERS` stays **off** until all three are true:
1. **mobile#299** is widely installed. mobile#233 alone is not enough.
2. The slice 2 Person migration (`20270110091000-person-declared-details`) is confirmed in production.
3. The slice 5 privacy text, currently a **draft pending Tanzanian counsel**, has been approved by counsel.

## `GET /shop/preferences`

Signed in, any role. Always `200` (also with the flag off), except a refused mode.

| Query | Meaning |
|---|---|
| `mode` | `member` \| `trainer` \| `owner` \| `vendor_personal`, checked exactly as on `GET /shop/home` (a role this person holds; default = the signed-in role, or the first shopping role held). Anything else → `403 {"error":"mode_not_allowed"}`. Send the mode the shop is open in, so `uses` matches the page. (QA round 1, 2026-10-22.) |

```json
{ "personalised": true, "available": true, "historyDays": 365, "mode": "member", "uses": ["purchase_history", "profile_gender", "profile_age", "goal"] }
```

- `personalised`: the stored choice; **no row = `true`** (on by default, new and existing accounts).
- `historyDays`: the configured purchase-history window (`SHOP_HISTORY_DAYS`), for the privacy text ("in the last year").
- `mode`: the shopping mode `uses` describes (added in QA round 1).
- `uses`: the signals the shop **actually uses now, in that mode**, in this order: `purchase_history`, `profile_gender`, `profile_age`, `location`, `goal`, `specialty`. Build the "What we use" list from this. `location` (slice 3) is listed in **every mode** while `SHOP_NEAR_YOU` is on and personalisation is enabled; it means the current area is used if the person allows location on the device (`docs/shop-near-you-api.md`).

  | Situation | `uses` |
  |---|---|
  | flag on, switched off | `[]` (every mode) |
  | flag on, not available (no member persona, invalid date of birth, under 18) | `[]` (every mode; a 16-year-old never gets `specialty` or `goal`) |
  | member mode | `purchase_history`; `profile_gender` (valid adult DOB and gender `female`/`male`); `profile_age` (valid adult DOB); `goal` (a declared fitness goal that maps to categories) |
  | trainer mode | `purchase_history`; `specialty` (declared specialties that map to categories). Never gender or age (with `SHOP_PERSONALISATION_PARTNERS` on: see [Trainer and owner mode](#trainer-and-owner-mode-shop_personalisation_partners)). |
  | owner, vendor_personal | `purchase_history` (owner mode with `SHOP_PERSONALISATION_PARTNERS` on: see the same section) |
  | flag off | what the Phase 1 page uses: `goal` in member mode, `specialty` in trainer mode |
- The setting belongs to the **Person** (all roles of the account share it). An account with no Person uses its own user id.
- **Person link / merge** (verified sign-in links personas onto one Person): the switch follows the moved personas, and **an opt-out on either side wins** (the merged Person is opted out). The change is audited with `source: "identity_link"` (a server-only value; PUT does not accept it). The old Person's row goes when it becomes a tombstone.
- **Account deletion**: the row is deleted once the Person has no personas left.

## `PUT /shop/preferences`

Signed in, any role. Flag off → `404 {"error":"feature_disabled"}`.

```json
{ "personalised": false, "source": "why_sheet" }
```

| Field | Rule | Error |
|---|---|---|
| `personalised` | boolean, required | `400 {"error":"invalid_field","field":"personalised"}` |
| `source` | `privacy_page` \| `why_sheet`, required | `400 {"error":"invalid_field","field":"source","allowed":["privacy_page","why_sheet"]}` |

→ `200` same shape as GET (incl. `historyDays`, `mode`, `uses`). Takes the same optional `?mode`; a refused mode is `403 mode_not_allowed` and nothing is saved. More than 30 calls a minute per user → `429 {"error":"rate_limited"}` (in memory per server).
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
- `recommended` title becomes **"Recommended for you" / "Zilizopendekezwa kwako"** (P1 `shop.home.recommended`) when history changed it; reason `bought_product {productName}` ("Suggested because you bought {product}." / "Imependekezwa kwa sababu ulinunua {product}.") when the rail shows a product the person bought before (a consumable at any time, anything else only once 30 days have passed), else `bought_category {category}` ("You've bought {category} before." / "Uliwahi kununua {category}.") (the top bought category **that the rail actually shows** after allocation). If history changed the rail but it shows neither a re-bought product nor a bought category (e.g. a just-bought item was left out), the title and reason stay the normal ones and no `bought_*` code or `reasonParams` is given; `purchase_history` is still in `signalsUsed`. (QA round 1.)
- `essentials` keeps its title; reason gets `bought_category {category}` when history changed it **and** the rail shows a product of that category after allocation.
- Paid placements are still never in `recommended` or `essentials`.

**Gender / age** (`profile_gender`, `profile_age`): **member mode only**, **only with a valid adult date of birth** (none at all when it is absent), declared `memberProfile.gender` (`female` → `women`, `male` → `men`; `other`/unset → not used) and `memberProfile.dateOfBirth` (band `18_29`, `30_44`, `45_59`, `60_plus`).
- `profile_gender` / `profile_age` are reported only when the **final** order of that rail differs from the order without gender/age; if both tags point the same way both are reported, if they cancel out neither is.
- Applied **after** the sections are filled, within `recommended` and `essentials` only: a stable reorder that moves products whose vendor tag matches (gender match +1, age band match +1) earlier. The **set of products in every section is identical with or without it**; untagged products and products tagged for another group stay where they are relative to each other.
- Never in trainer, owner or vendor_personal mode — except trainer and owner mode with `SHOP_PERSONALISATION_PARTNERS` on (from the Person's declared details; see [Trainer and owner mode](#trainer-and-owner-mode-shop_personalisation_partners)).

### Switch off (stored `personalised: false`, flag on)

`personalisation.enabled: false`, and (spec P1 §8.2):
- `recommended` title **"Popular in the shop" / "Maarufu dukani"**, reason "Suggested from what's popular on FitFlex." codes `["generic","role_context"]`;
- no purchase history, gender or age; **also no declared goal or trainer specialty** (`profile_goal`, `trainer_specialty` and the `goal`/`specialty` signals disappear): the page only uses the role;
- `recently_viewed` still shows (it is the ids the app itself sends; the app may stop sending them when off);
- `personalised: false`, `signalsUsed` ⊆ `role`, `recently_viewed`.

### Not available (flag on; no member persona, invalid date of birth, or under 18)

`personalisation: { "available": false, "enabled": false }`; the page uses only the role and recently viewed: never purchase history, gender or age, **and (QA round 1) no declared goal or trainer specialty either**, so it matches `uses: []`. Titles stay the Phase 1 ones ("Popular with …"). With the flag off the page is the Phase 1 page, goal and specialty included. If such an account also stored `personalised: false`, the switch-off rules above apply.

## Product target fields

Migration `20270105090000-shop-personalisation`: `Product.targetGender` text (`women` | `men` | null = everyone) and `Product.targetAgeBands` text[] (subset of `18_29`, `30_44`, `45_59`, `60_plus`; empty = all ages). Existing products: null / empty.

| Where | Behaviour |
|---|---|
| `POST /vendor/products`, `PUT /vendor/products/:id` | Accepted (vendor + vendor_staff with `products`). Create: missing = null / `[]`. Update: missing = unchanged; `null` clears gender; `[]` clears bands. **Not review fields**: changing them never sends an approved product back to pending. Accepted whether or not the flag is on. |
| Validation | `targetGender` not one of `women`, `men`, null → `400 {"error":"invalid_field","field":"targetGender","allowed":["women","men",null]}`. `targetAgeBands` not an array, an unknown value, or a repeat → `400 {"error":"invalid_field","field":"targetAgeBands","allowed":["18_29","30_44","45_59","60_plus"]}`. **All four bands = all ages: stored and returned as `[]`** (the app should show "All ages" selected). |
| Vendor rows | `GET /vendor/products` and the create/update/duplicate responses carry `targetGender` and `targetAgeBands`. Duplicate copies them. |
| `GET /admin/products` | Rows carry both fields, **read-only**. Filters: `?targetGender=women|men|everyone` (everyone = null), `?targetAgeBand=18_29|30_44|45_59|60_plus|all` (a band = products whose list contains it; `all` = empty list). Bad value → `400 {"error":"invalid_filter","field":"targetGender"|"targetAgeBand","allowed":[...]}`. |
| `POST /admin/products`, `PUT /admin/products/:id/listing` | Do **not** accept them (ignored; spec Q-7 says editing is in the vendor app). |
| Buyer rows | `/shop/products`, `/shop/products/:id` (incl. `similarProducts`), `/shop/vendors/:id`, `/discover/products`, `/shop/home` **never** carry them. |
| `GET /vendor/tools/options` | `merch.productTargets: true` when `SHOP_PERSONALISATION` is on. The app shows the "Who it's for (optional)" section only then. |

## Date of birth on write (endpoint behaviour change, 2026-10-22)

`POST /me/profile` (members) and `POST /admin/members` (`memberProfile.dateOfBirth`) now check the date of birth:
- strict `"YYYY-MM-DD"`, a real calendar date, from `1901-01-01` to today (East Africa day) → saved;
- anything else → `400 {"error":"invalid_field","field":"dateOfBirth"}` and **nothing is saved**;
- `""` (or only spaces) → clears it (stored as null); `null` or leaving it out keeps the stored value (as before).

Before this, any text was stored. Dates already stored in another format are not changed; for personalisation they count as "present but not valid" (fail closed) until the member saves a valid one. The app's free-text field (hint `YYYY-MM-DD`) must show the error for this code.

## Deviations from the design spec (stated)

1. Endpoints are `GET/PUT /shop/preferences` (spec B-P2-5 suggested `/me/shop-preferences`; P1 suggested `/me/...`).
2. The preference belongs to the Person (`ShopPreference.personId`), not a single user row, so all roles share it (P1 D-2).
3. `available` needs an adult member persona (see above); spec §6.3 shows the switch in every mode. With `SHOP_PERSONALISATION_PARTNERS` on, trainer and owner mode no longer need one (partner DOB slice 4).
4. Switch off also drops the declared goal and specialty (stricter reading of "no personal reasons").
5. `reasonParams` is a new optional object; `reasonCodes` stays a string array.

## Data model

`ShopPreference { personId text PK, subjectType 'person'|'user', personalised boolean, source 'privacy_page'|'why_sheet', updatedBy text, updatedAt timestamptz }`. No row = on. Migration is additive; `down` drops the table and the two Product columns.

## Code

- `src/services/shop-personalisation.mjs`: pure signal rules (history, rebuy window, audience, stable reorder; slice 4: `partnerEligibility`, `partnerDateOfBirth`, `partnerGender`, `partnerAudienceFrom`).
- `src/services/shop-preference-service.mjs` + `src/infra/shop-preference-store-pg.mjs`: the preference and its audit.
- `src/services/shop-home-service.mjs` / `shop-recommendations.mjs`: wiring into the page.
- `functions/shop-preferences.mjs`: routes.
- Specs: `specs/shop-personalisation*.specs.mjs`.

Swahili strings are drafts for native review and reuse the P1 spec §10.6 wording (`shop.home.recommended`, `shop.why.boughtCategory`, `shop.why.boughtProduct`, `shop.why.gender`, Phase 2 `shop.why.age`).
