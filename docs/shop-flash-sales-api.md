# Shop flash sales API (Phase 2 · slice 4)

**Revision 2 (2026-10-29, review round 1).** Changes from revision 1 are listed at the end ("Revision 2 changes") — portal and app: read that section first.

Status: on `feat/shop-flash-sales` → `release-candidate`, **dormant** (`SHOP_FLASH_SALES` off). Design spec: `docs/design/shop-home-phase2.md` §4, §8, §10.4, §10.8, §13 (B-P2-11..16), S4-AC in the parent repo, plus Phase 1 `docs/design/shop-home.md` (flash sale rail, countdown, states).

**This is a pricing-path change** (CONTRIBUTING rule 6): it changes the price a buyer is charged at checkout while the flag is on. A security review follows the PR.

Owner decisions this implements (final, 2026-10-20 / 2026-10-29):
- Vendors **propose** (vendor app + vendor web portal); FitFlex staff can also **create** on any vendor's product, **without the vendor's consent**.
- Staff with `promotions_approve` **approve**, two-person rule: anyone who created, edited or sent a sale can't decide it (`403 cannot_approve_own_submission`); decisions name the `revision` they reviewed (`409 sale_changed`).
- Discount **at least 5 %**, **no maximum** (the sale price must still be ≥ TSh 1).
- **Refused if the product's regular price (`priceTzs`) was raised in the 14 days before the sale starts** (`422 price_raised_recently`). Regular price only: discount-price changes never count (ruling 2026-10-29 (a)).
- **New or copied products**: a sale may not start until **14 days after the product's first price row** (`422 price_history_too_short`). Products that existed before this migration get a baseline row at migration time, so they are treated the same: no sale before 14 days after the migration (ruling (b); AuditLog was not used to backdate — vendor price edits were never audited).
- The struck "was" price is the **regular** price (ruling (c)).
- The sale price must be **below the current effective price** (regular price, or the standing seller discount when there is one).
- Length **1 hour to 7 days**. **One approved sale per product at a time** (database-enforced).
- While a sale is **scheduled or live** the product's price and discount price **can't be changed** (`409 sale_conflict`).
- The vendor can **end early any scheduled or live sale on its own products**, FitFlex-made ones included (ruling (d); audited). Proposals **expire after 14 days or at their start**, whichever is first.
- **The vendor bears the discount**: commission is worked out on the sale price; **no payout or settlement rule changes**.
- **Once an order is placed its price is fixed**, even if it is paid after the sale ends.
- **Walk-in (POS) prices are not affected.**

Portal and mobile build against this file. Anything not written here is not part of the contract.

## Flags and settings

| Env | Default | Effect |
|---|---|---|
| `SHOP_FLASH_SALES` | off | **Off: every price, list, product, store, home and checkout answer is byte-identical to before this slice.** Every route below answers `404 {"error":"feature_disabled"}` before sign-in is checked; `GET /admin/shop-merch?kind=flash_sale` → `404 feature_disabled`; no `sale` / `effectivePriceTzs` fields anywhere; no `flash_sale` section; `items[].expectedPriceTzs` is ignored; no price lock; the lifecycle job does nothing; `GET /vendor/tools/options` says `merch.flashSales: false`. Approved sales stay in the database and apply again when the flag comes back on. |
| `SHOP_PROPOSAL_EXPIRY_DAYS` | `14` | Shared with banners. A pending proposal expires at the earlier of *sent + N days* and its `startsAt`. |
| `SHOP_FLASH_SALE_MAX_OPEN` | `10` | Abuse limit: a vendor's drafts + pending (not expired) flash sales at once. Beyond it → `409 too_many_open_proposals { max, open }`. Staff are not limited. |

Rate limits per vendor, per minute, in memory per server (with several servers the real allowance is servers × this): create 20, send for approval 20, price check 60. Over → `429 rate_limited { retryAfterSeconds }` with a `Retry-After` header.

Product price history (`ProductPriceChange`) is **written whether or not the flag is on** (a database trigger on every change of `priceTzs` or `discountPriceTzs`), so the 14-day rule has history from the day this migration runs. It is bookkeeping only.

## Rules (the numbers)

| Rule | Value | Error |
|---|---|---|
| Sale price | whole TSh, ≥ 1 | `400 invalid_field { field: "salePriceTzs" }` |
| Minimum discount | `floor((regular − sale) × 100 / regular) ≥ 5`, i.e. `sale ≤ floor(regular × 95 / 100)` | `422 discount_out_of_range { reason: "below_minimum", minDiscountPct: 5, maxSalePriceTzs, regularPriceTzs }` |
| Below the effective price | `sale < min(priceTzs, discountPriceTzs when 0 < discount < price)` | `422 discount_out_of_range { reason: "not_below_effective", effectivePriceTzs, discountPriceTzs }` |
| Length | 1 h ≤ `endsAt − startsAt` ≤ 7 days | `422 sale_length_out_of_range { minMs: 3600000, maxMs: 604800000 }`; `endsAt ≤ startsAt` → `422 end_before_start` |
| Lead time | on create and submit: `startsAt ≥ now + 1 h`; on an edit **only when the edit moves `startsAt`** | `422 start_too_soon { earliestStart }` |
| Price history | `startsAt ≥ listedAt + 14 days`, `listedAt` = the product's first `priceTzs` row (listing, copy, or migration baseline) | `422 price_history_too_short { listedAt, earliestStart }` |
| 14-day rule | no raise of `priceTzs` at any time after `startsAt − 14 days` | `422 price_raised_recently { raisedAt, raisedOn, earliestStart, fromTzs, toTzs }` (`raisedOn` = Tanzania date `YYYY-MM-DD`; `earliestStart` = `raisedAt + 14 days`) |
| One sale per product | no overlap with another **approved** sale, or another **pending** (not expired) one, of the same product | `409 sale_overlap { saleId, startsAt, endsAt, effectiveStatus }` |
| Product | the vendor's own, not deleted, `active`, approved, not hidden. Out of stock is allowed (it simply won't show until stock is added). | `404 product_not_found` · `403 not_your_product` · `422 product_not_eligible { reason }` |
| Vendor | approved, operational (KYC gate), not suspended | Vendor side (create / edit / submit): `403 vendor_suspended` · `403 vendor_not_approved` — app wording "Available once your business is approved" · `404 vendor_not_found` (the product's vendor account no longer exists). Admin side (approve): `409 vendor_suspended` · `409 vendor_not_approved` — portal wording "The seller can't run sales right now (not approved or not verified)" · `409 vendor_not_found`. |

"Regular price" is the product's `priceTzs`. The discount % is always against it (DD-P2-5). Live means `startsAt ≤ now < endsAt` by the **server clock**, to the millisecond.

## States

Same as banners. Stored `status`: `draft` · `pending_approval` · `approved` · `ended` · `rejected` · `withdrawn` · `expired`. Every view also has `effectiveStatus` from the clock on every read: `approved` → `live` inside `[startsAt, endsAt)` → `ended` after; `pending_approval` → `expired` from `expiresAt`. **`statusReason` is worked out at read time too** (QA D7): an expired proposal reads `start_passed` or `not_reviewed_in_time`, and a finished sale `window_passed`, as soon as time says so — never `null` while waiting for the lifecycle job, which later stores the same value. `expiresAt` is shown while `pending_approval` and once `expired`.

| effectiveStatus | Label EN / SW (draft) | `statusReason` |
|---|---|---|
| `draft` | Draft / Rasimu | null |
| `pending_approval` | Waiting for approval / Inasubiri idhini | null |
| `approved` | Scheduled / Imepangwa | null |
| `live` | Live / Inaendelea | null |
| `ended` | Ended / Imeisha | `window_passed` · `ended_by_vendor` (also when the vendor ended a FitFlex-made sale) · `ended_by_fitflex` (+ `statusReasonNote`) · `vendor_suspended` (FitFlex suspended the seller; `endedByFitflex` true) |
| `rejected` | Rejected / Imekataliwa | `price_not_credible` · `product` · `timing` · `other` (+ `statusReasonNote`) |
| `expired` | Expired / Imeisha muda | `not_reviewed_in_time` · `start_passed` |
| `withdrawn` | Withdrawn / Imeondolewa | null |

| From (effective) | Action | To |
|---|---|---|
| draft | submit | pending_approval (`expiresAt` = earlier of now + 14 days and `startsAt`) |
| draft · pending_approval | edit | unchanged (pending keeps its sent time; `expiresAt` re-dated if `startsAt` moves) |
| rejected | edit | **draft** (send it again) |
| approved (scheduled) | edit | **pending_approval** (needs approval again; `wasPriceTzs` and approval fields cleared) |
| live · ended · expired · withdrawn | edit | `409 not_editable { currentStatus }` (a live sale can only be ended) |
| draft · pending_approval · approved | withdraw | withdrawn |
| live | withdraw | `409 invalid_transition { hint: "end" }` |
| live · approved | vendor end (own sale, `origin: vendor`) | ended (`ended_by_vendor`) — scheduled ones may also be withdrawn |
| pending_approval | approve / reject (an admin with no hand in it) | approved / rejected |
| approved · live | admin end | ended (`ended_by_fitflex`, note required) |
| pending past `expiresAt` | time | expired |
| approved past `endsAt` | time | ended (`window_passed`) |

Every edit adds 1 to `revision`; its author joins `editors`. `productId` can't change after create (`400 product_not_editable`): make a new sale instead.

## Sale view

```jsonc
{
  "id": "fls_ab12cd34ef56",
  "origin": "vendor",              // vendor | staff (staff = created by FitFlex on the vendor's product)
  "vendorId": "usr_…",
  "productId": "prd_…",
  "productName": "Whey Protein 1kg",
  "productImage": "…" ,            // first product image or null
  "salePriceTzs": 69000,
  "regularPriceTzs": 85000,        // the product's priceTzs now
  "discountPriceTzs": 79000,       // the product's standing discount now, or null
  "wasPriceTzs": 85000,            // priceTzs snapshot at approval; null until approved
  "discountPct": 18,               // floor((regular − sale) × 100 / regular), regular = wasPriceTzs once approved
  "savingTzs": 16000,
  "startsAt": "…", "endsAt": "…",
  "status": "approved", "effectiveStatus": "live",
  "statusReason": null, "statusReasonNote": null,
  "expiresAt": null,               // only while pending_approval
  "revision": 3,
  "submittedAt": "…", "approvedAt": "…", "decidedAt": "…", "endedAt": null,
  "createdAt": "…", "updatedAt": "…",
  "endedByFitflex": false,         // vendor view only
  "allowedActions": ["end"]        // edit | submit | withdraw | end | approve | reject (for this caller, now)
}
```

Admin view adds: `vendorName`, `sellerSuspended`, `createdBy(+Name)`, `submittedBy(+Name)`, `approvedBy(+Name)`, `decidedBy(+Name)`, `endedBy(+Name)`, `editedBy` (ids), `ownItem` (this admin had a hand in it → can't decide), `regularPriceTzsAtSubmit`, `discountPriceTzsAtSubmit`, `priceChangedSinceSubmit` (true → approve refused). Vendor view never has staff ids or names.

## Vendor endpoints

Vendor account, or vendor staff with the `products` permission (read from the stored staff record; otherwise `403 vendor_permission_forbidden`). A vendor sees and acts on **its own products' sales only**; another vendor's id reads as `404 sale_not_found`. Vendors also see sales FitFlex staff created on their products once sent (`origin: "staff"`): they can't edit them, but may **end** them while scheduled or live (`allowedActions: ["end"]`; ruling (d)).

| Method & path | Body / query | Answer |
|---|---|---|
| `GET /vendor/flash-sales` | `?status=` (effective), `?productId=`, `?limit` (≤100, default 25), `?cursor` | `{ items: [sale], total, nextCursor, vendor: { canPropose, reason: null\|vendor_suspended\|vendor_not_approved }, proposalExpiryDays, openProposals: { open, max }, rules: { minDiscountPct: 5, minLengthMs, maxLengthMs, minLeadMs, priceRaiseLookbackDays: 14 } }` |
| `POST /vendor/flash-sales` | `{ productId, salePriceTzs, startsAt, endsAt }` (all required) | `201 { sale }` (a **draft**). Every rule above is checked now. |
| `GET /vendor/flash-sales/price-check` | `?productId=&startsAt=` (startsAt optional; default now + 1 h) | `{ ok, productId, regularPriceTzs, discountPriceTzs, effectivePriceTzs, maxSalePriceTzs, raisedAt, raisedOn, earliestStart, listedAt, historyEarliestStart, lockedBy }` — `ok` false when the 14-day raise rule fails (`raisedAt` / `earliestStart` set), the price history is too short (`historyEarliestStart` set; `listedAt` = first price row), or another sale holds the product (`lockedBy` = `{ saleId, startsAt, endsAt, effectiveStatus }`). The earliest valid start is the later of `earliestStart` and `historyEarliestStart`. |
| `GET /vendor/flash-sales/:id` | — | `{ sale }` |
| `PATCH /vendor/flash-sales/:id` | any of `{ salePriceTzs, startsAt, endsAt }` | `{ sale }` (see the transitions table; every rule re-checked) |
| `POST /vendor/flash-sales/:id/submit` | — | `{ sale }` (pending_approval) |
| `POST /vendor/flash-sales/:id/withdraw` | — | `{ sale }` |
| `POST /vendor/flash-sales/:id/end` | — | `{ sale }` (any live or scheduled sale on my products, FitFlex-made ones included → ended `ended_by_vendor`; leaves the shop on the next request; audited — `flash_sale.ended`, plus `flash_sale.ended_by_vendor_on_staff_sale` for a FitFlex-made one; FitFlex sees it in the queue with `endedBy` = the vendor user) |

Unknown body fields → `400 unknown_field { fields }`. Dates not ISO → `400 invalid_date { field }`.

## Admin endpoints

`promotions` or `promotions_approve` to read; `promotions` to create/edit/submit/withdraw FitFlex-created sales; `promotions_approve` to approve, reject, end. Super-admins pass.

| Method & path | Body / query | Answer |
|---|---|---|
| `GET /admin/shop-merch?kind=flash_sale` | `?tab=requests\|scheduled\|live\|closed\|drafts`, `?status=`, `?origin=vendor\|staff`, `?vendorId=`, `?productId=`, `?q=` (product or seller), `?limit`, `?cursor` | `{ items: [sale (admin view)], total, nextCursor, counts: { requests, scheduled, live, closed, drafts } }`. Vendor drafts are never listed. Requests are oldest-expiring first. (`kind=banner`, the default, is unchanged and still needs `SHOP_BANNERS`.) |
| `GET /admin/flash-sale-products` | `?q=` (name contains), `?vendorId=`, `?limit` (≤ 50, default 20) | **Staff product picker for "Create sale"** with `promotions` or `promotions_approve` (no `shop` scope needed; read-only): `{ items: [{ id, name, vendorId, vendorName, priceTzs, discountPriceTzs, effectivePriceTzs, maxSalePriceTzs, stock, image }] }` — only products a buyer can find, of vendors allowed to run a sale. |
| `GET /admin/flash-sales/:id` | — | `{ sale, history: [AuditLog flash_sale.* rows + actorName], priceCheck }` — `priceCheck = { passes14DayRule, raisedAt, raisedOn, earliestStart, lastRaiseAt, passesHistoryRule, listedAt, historyEarliestStart, priceHistory: [{ at, on, field: "priceTzs"\|"discountPriceTzs", fromTzs, toTzs, raised, source: "trigger"\|"migration_baseline" }] (last 30 days, newest first), discountLine: { pct, savingTzs, sellerPays: true }, priceChangedSinceSubmit }`. `on` = the Tanzania date (`YYYY-MM-DD`) of `at`; `raised` = a `priceTzs` change to a higher known price; `lastRaiseAt` = the latest raise in the 14 days before `startsAt` (null if none; `raisedAt` is the same instant when the rule fails); `fromTzs` null = the product's first price (or the baseline). |
| `POST /admin/flash-sales` | `{ productId, salePriceTzs, startsAt, endsAt }` | `201 { sale }` (origin `staff`, vendorId = the product's vendor, a draft; no vendor consent needed) |
| `PATCH /admin/flash-sales/:id` | as the vendor PATCH | `{ sale }` — FitFlex-created sales only; a vendor's sale → `404 sale_not_found` |
| `POST /admin/flash-sales/:id/submit` · `/withdraw` | — | `{ sale }` (FitFlex-created only) |
| `POST /admin/flash-sales/:id/approve` | `{ revision }` (required; `400 revision_required`; stale → `409 sale_changed { revision }`) | `{ sale }`. Refused: own item `403 cannot_approve_own_submission`; past expiry `409 proposal_expired`; product price changed since sending `409 sale_changed { reason: "product_price_changed", regularPriceTzs, regularPriceTzsAtSubmit }`; any rule above failing now (`422 price_raised_recently`, `422 discount_out_of_range`, `409 sale_overlap`, `409 vendor_suspended`, …). Sets `wasPriceTzs`. The vendor is notified. |
| `POST /admin/flash-sales/:id/reject` | `{ revision, code: price_not_credible\|product\|timing\|other, note }` (note required for `other`, ≤ 500) | `{ sale }`. Own item → `403`. The vendor is notified. |
| `POST /admin/flash-sales/:id/end` | `{ note }` (1–500; `reason` accepted too) | `{ sale }` (approved or live → ended `ended_by_fitflex`). Allowed on one's own. The vendor is notified. |

## Where the price changes (buyers; flag on only)

`effectivePrice(product, sale, now)` (`src/shared/shop-pricing.mjs`) = the **lowest** of `priceTzs`, a valid `discountPriceTzs` (0 < discount < price) and the sale price of an **approved** sale of this product and vendor whose window contains `now` (server clock). Products that buyers can't see (hidden, paused, deleted, unapproved, vendor suspended / not operational / blocked) never get a sale price, because they are not listed or sold at all.

**Product rows** on `GET /shop/products`, `GET /shop/products/:id` (and its `similarProducts`), `GET /shop/vendors/:id` (store products), `GET /discover/products` (Explore cards; `sort=price_*` uses the effective price) and `GET /shop/home` (`products{}`) gain:
- `effectivePriceTzs` (every row) — what checkout charges now;
- `sale` (only while live, **and only for clients that send `X-FF-Shop-Caps: flash_sale`**): `{ id, salePriceTzs, wasPriceTzs, regularPriceTzs, discountPct, startsAt, endsAt, serverNow }` — `wasPriceTzs` is the regular price (ruling (c)); `serverNow` = the server time the price was worked out at.

### Capability header (contract revision 2)

`X-FF-Shop-Caps: flash_sale` — a list of tokens; commas, semicolons or spaces separate them; case and spaces are ignored; unknown tokens are ignored (`flash-sale`, `flashsale`, `flash_sales` are **not** `flash_sale`). Send it on `GET /shop/products`, `/shop/products/:id`, `/shop/vendors/:id`, `/discover/products` and `/shop/home`.
- **With it**: `sale` objects on rows and the `flash_sale` home section.
- **Without it** (old builds): no `sale` object and no `flash_sale` section — but rows still carry `effectivePriceTzs`, Deals still leaves out products in a live sale, and **checkout charges everyone the effective price** (lowest-price rule): a client that can't show a sale still pays the lower price.

### Server time (contract revision 2)

With the flag on: `GET /shop/products` and `GET /shop/vendors/:id` send header `X-FF-Server-Now` (ISO); `GET /shop/products/:id` and `GET /shop/vendors/:id` also carry a top-level `serverNow`; every `sale` object carries `serverNow` (use it on lists — Flutter web may not read custom response headers without CORS expose rules); `/shop/home` already has `serverNow`. Flag off: none of these.

`priceTzs` and `discountPriceTzs` on the row are **unchanged** (the stored values). During a live sale show the sale price and the struck `wasPriceTzs`; don't show `discountPriceTzs` (spec §8.4).

**`GET /shop/products` query**: `minPrice` / `maxPrice` / `sort=price_asc|price_desc` use the effective price; `promotions=true` also includes products in a live sale; new `flashSale=true` → only products in a live sale.

**`GET /shop/home`** adds `flashSales: { enabled: true }` and, for clients sending `X-FF-Shop-Caps: flash_sale`, when at least `SHOP_HOME_MIN_ITEMS` (4) products are in live sales, a section `{ key: "flash_sale", title: { en: "Flash sale", sw: "Ofa ya muda mfupi" }, reason: { en: "The seller has set a discount for a limited time.", sw: "Muuzaji ameweka punguzo kwa muda mfupi." }, reasonCodes: ["flash_sale_seller_discount"], endsAt, productIds, hasMore, viewAll: { path: "/shop/products", query: { flashSale: "true" } } }`. It is **first** in display order and **first in allocation** (flash_sale > featured > best_sellers > …), so its products appear in no other rail; `deals` never takes a product in a live sale. `endsAt` = the earliest end among the products shown; count down against `serverNow`, not the device clock. With 1–3 live sales there is **no rail**, but those products still carry `sale` and the sale price wherever they appear. Members never see scheduled sales.

**`POST /me/shop-orders`** (checkout): each `items[]` may carry `expectedPriceTzs` (the unit price the app showed). Optional: old clients that don't send it are priced exactly as now. A line is charged its effective price at the moment of pricing; when a sale applies the order line has `priceTzs` = the sale price and `flashSaleId`. Commission is worked out on that price by the vendor's rate (`priceOrderLine`, unchanged). Errors:

```jsonc
// 409 — some expectedPriceTzs differs from the current price, or the sale window closed / a sale started
// between pricing and the stock lock. Nothing is reserved. Resend with the new expected prices.
{
  "error": "price_changed",
  "productId": "prd_…",            // the first changed line (older clients read only this)
  "currentPriceTzs": 85000,         // its current unit price
  "lines": [{ "productId": "prd_…", "variant": null, "expectedPriceTzs": 69000, "currentPriceTzs": 85000, "reason": "sale_ended" }],
  "expectedTotalTzs": 138000,       // with the expected prices (lines without one at their current price)
  "totalTzs": 170000                // at current prices
}
```

`reason`: `sale_ended` (the price the app had was this product's sale price and no sale is live now) · `sale_started` (a sale is live now) · `price_changed` (anything else). The lock-race case (window closed between pricing and the lock) has `expectedPriceTzs` null when the app sent none. `expectedPriceTzs` not a whole number ≥ 0 → `400 invalid_expected_price { productId }`.

**Once placed, the order's prices are fixed**: paying later (after the sale ended), a reservation revived by a late payment, refunds and vendor settlement all use the line prices stored on the order.

**Vendor product edits** (`PUT /vendor/products/:id`, both with and without the stock ledger): while an **approved** sale of the product has not ended (scheduled or live), a body that changes `priceTzs` or `discountPriceTzs` → `409 sale_conflict { reason: "price_locked_by_flash_sale", saleId, startsAt, endsAt, effectiveStatus, fields }`. Sending the same values (old app builds send the whole form) is fine. Other fields (stock, variants, text) stay editable. `GET /vendor/products` rows carry `priceLock: { saleId, startsAt, endsAt, effectiveStatus }` while locked (absent otherwise).

**Products taken off the shop** (admin `homepageVisible: false`; security review L1): still sold by id at their own price as before, **never** at a sale price (the checkout and the lock-time re-check both follow the catalogue gate).

**Suspended vendors** (security review L2): when an admin suspends a vendor its scheduled and live sales end at once (`statusReason: vendor_suspended`, audited `flash_sale.ended`, vendor notified with `vendor_flash_sale_ended`); the lifecycle job ends any left over (moderation suspensions too).

**Not changed**: walk-in (POS) prices (`POST /vendor/sales`, `walkInPrice`), vendor settlement and payout rules, `GET /admin/products`, vendor reports.

## Vendor notifications (inbox + push, EN + SW; SW drafts for native review)

| Event (`type`) | EN | SW | data |
|---|---|---|---|
| `vendor_flash_sale_approved` | Flash sale approved — Your flash sale on "{product}" is approved. It goes live {date}. | Ofa ya muda mfupi imeidhinishwa — Ofa yako ya muda mfupi kwa "{product}" imeidhinishwa. Itaanza {date}. | `{ saleId, open: "merch", tab: "sales", item, titleSw, bodySw }` |
| `vendor_flash_sale_rejected` | Flash sale rejected — Your flash sale on "{product}" wasn't approved. See why. | Ofa ya muda mfupi imekataliwa — Ofa yako ya muda mfupi kwa "{product}" imekataliwa. Tazama sababu. | + `reason` |
| `vendor_flash_sale_expired` | Flash sale expired — Your flash sale on "{product}" expired before review. | Ofa ya muda mfupi imeisha muda — Ofa yako ya muda mfupi kwa "{product}" imeisha muda kabla ya kukaguliwa. | |
| `vendor_flash_sale_ended` | Flash sale ended by FitFlex — FitFlex ended your flash sale on "{product}". | Ofa ya muda mfupi imesitishwa na FitFlex — FitFlex imesitisha ofa yako ya muda mfupi kwa "{product}". | + `reason` |

`{date}`: English `31/10/2026 18:00` (24-hour); Swahili `31/10/2026 6:00 jioni` (12-hour clock + time of day: 05–11 asubuhi, 12–15 mchana, 16–18 jioni, 19–04 usiku) [SW review]. Banner notices use the same date format now. Staff-created sales notify the vendor on approve and end too (they pay the discount). Natural end of a window and the vendor's own end send nothing.

## `GET /vendor/tools/options`

`merch.flashSales: true|false` (follows `SHOP_FLASH_SALES`).

## Data

- `FlashSale` (migration `20270129100000-shop-flash-sales.cjs`): the columns of the views above plus `editors` (jsonb), `endedBy`, `statusChangedAt`. One approved sale per product at a time is enforced by an exclusion constraint on `(productId, tstzrange(startsAt, endsAt))` for `status = 'approved'` (btree_gist), or, where that extension can't be created, by an equivalent trigger. Both raise SQLSTATE `23P01`.
- `ProductPriceChange { id, productId, field, fromTzs, toTzs, at, source: trigger | migration_baseline }`, written by a trigger on `Product`; the migration adds one `migration_baseline` row (`fromTzs` null, `at` = migration time) for every product that already existed.
- Down migration drops both tables and the triggers. Orders keep `flashSaleId` on their lines (plain JSON; harmless).

## Known gaps

- Shop payments are still **manual confirmation only**; a flash sale adds urgency to a flow that waits for a person. The price is protected, the payment timing is not.
- **Vendor settlement is built but has never been exercised with real accounts**; flash-sale commission on the sale price relies on it (no settlement code changed).
- The 14-day rule looks at `priceTzs` raises only (owner ruling 2026-10-29 (a)). Removing a standing discount and then running a sale against the regular price is not blocked; the admin price history shows it.
- A sale price of TSh 1 is allowed (no maximum discount). TSh 0 is not (a zero-total order would be marked paid at once).
- Swahili strings are drafts for native review.

## Revision 2 changes (2026-10-29) — portal and app must follow

1. **New error `422 price_history_too_short { listedAt, earliestStart }`** on create / edit / submit / approve (new or copied products, and every product for 14 days after the migration). `price-check` adds `listedAt`, `historyEarliestStart`; admin `priceCheck` adds `passesHistoryRule`, `listedAt`, `historyEarliestStart`.
2. **Vendors may end FitFlex-made sales** on their products: vendor `allowedActions` includes `end` for them; `POST /vendor/flash-sales/:id/end` accepts them.
3. **`X-FF-Shop-Caps: flash_sale`** request header now required to receive `sale` objects and the `flash_sale` home section. Everyone is charged the effective price.
4. **`serverNow`**: inside every `sale`; top-level on `GET /shop/products/:id` and `GET /shop/vendors/:id`; header `X-FF-Server-Now` on lists (flag on only).
5. **`sale_overlap` from a lost approval race** now carries `{ saleId, startsAt, endsAt, effectiveStatus }` of the winning sale (previously empty).
6. **Edit lead time**: the 1-hour lead is checked on an edit only when `startsAt` moves.
7. **New `GET /admin/flash-sale-products`** (staff product picker; `promotions` or `promotions_approve`). The portal does not need the `shop` scope to create a sale.
8. New `statusReason: vendor_suspended` (ended because the seller was suspended; `endedByFitflex` true); `priceHistory[].source`; documented `priceHistory[].on`, `priceCheck.lastRaiseAt`, `vendor_not_found`, and vendor vs admin wording for `vendor_not_approved`.
9. Swahili: reject push body now "…imekataliwa. Tazama sababu."; dates in Swahili notices "31/10/2026 6:00 jioni"; flash rail reason "Muuzaji ameweka punguzo kwa muda mfupi." [SW review].
