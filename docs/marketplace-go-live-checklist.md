# Marketplace go-live checklist

Status 2026-10-14, after PR 1–5. Each gate says what evidence exists and what
does not. A gate is **PASS** only with evidence; **OPEN** means someone must do
or decide it; **N/A** is stated with a reason. Nothing here is signed off by
anyone but the owner.

**Launch model this checklist supports:** a *controlled* launch where **staff
confirm every payment and send every refund by hand**. There is no payment
provider integration for shop orders; unattended payments are not covered.

## A. Code and tests (functions)

| # | Gate | State | Evidence |
|---|---|---|---|
| A1 | PRs 1–5 merged to `release-candidate` in order and `npm test` green there | OPEN | fitflex-functions #152 → #153 → #154 → PR 5 (number below); not merged |
| A2 | Full suite green on a fresh database | PASS (branch) | 1923 tests, 0 fail on a fresh DB with 95 migrations; 1 first-run failure in an unrelated B2B analytics spec (substring check, passes on re-run) |
| A3 | Overselling impossible under concurrency | PASS | `shop-checkout-integrity` (real Postgres); old code oversold 10× |
| A4 | Retried checkout makes one order | PASS (server) / OPEN (app in field) | server tests; app build must ship |
| A5 | Order transitions enforced, vendors isolated | PASS | `shop-order-lifecycle`, `shop-fulfilment` |
| A6 | Payment confirmed once, checked against the order | PASS | `shop-payments` |
| A7 | Refund raised once, failures recorded and recoverable | PASS | `shop-payments` |
| A8 | Settlement: one live share per order, two-person approval, verified payout account | PASS | `shop-hardening` golden path; `vendor-settlements` |
| A9 | Lint / static analysis | N/A | none configured in this repo |

## B. Deployment (needs access I do not have)

| # | Gate | State |
|---|---|---|
| B1 | Production DB backup/snapshot taken before migrating | OPEN |
| B2 | Migrations run **before** code: `20261224103000`, `…113000`, `…123000` (see readiness §9) | OPEN |
| B3 | Duplicate order references resolved so the unique index is created (migration prints them) — D-11 | OPEN |
| B4 | `Product.stock` constraint validated after a data check — D-5 | OPEN |
| B5 | Mobile build (fitflex-mobile#113) released **before** relying on app retry protection | OPEN |
| B6 | Env decided: `SHOP_RESERVATION_TTL_MINUTES` (default 48 h), `SHOP_RESERVATION_EXPIRY` (off), `SHOP_MAX_UNPAID_ORDERS` (default 5), `SHOP_REQUIRE_VARIANT` (off) | OPEN |
| B7 | Rollback rehearsed on a copy (down-migrations exist and were round-tripped on CI DB only) | OPEN |

## C. Payments and refunds

| # | Gate | State |
|---|---|---|
| C1 | Payment provider chosen, documented, sandbox credentials — D-9 | **OPEN — blocks unattended payments** |
| C2 | If manual: staff trained on the rules (amount must equal the order total; one reference per order; confirmed payments are not edited back; late payment revives or refunds) | OPEN |
| C3 | Who sends refunds, in what time, from which account; refunds waiting > 3 days are flagged | OPEN (flag exists; process does not) |
| C4 | Webhook authentication scheme (Selcom signature, OI-004) — only needed with C1 | OPEN |
| C5 | Refund automation — D-10 | OPEN (optional) |

## D. Financial model decisions

| # | Decision | State |
|---|---|---|
| D-6 | Cancel/return one vendor's part of a mixed order (partial refund). Until decided: FitFlex cancels mixed orders whole; nobody can cancel after any vendor delivered. | OPEN |
| D-7 | Pay each vendor when their own part is delivered. Until decided: paid when every vendor has delivered. **Settlement rules were not changed.** | OPEN |
| — | Returns of delivered orders (a workflow does not exist) | OPEN |
| — | VAT on commission/payouts (platform-wide DR-05) | OPEN |

## E. Operations and monitoring

| # | Gate | State |
|---|---|---|
| E1 | Someone looks at `GET /admin/marketplace/reconciliation` daily; `ok:true` expected | OPEN (no screen yet; API only) |
| E2 | Alert on `[shop-reconciliation] P0|P1` log lines or `ok:false` — D-12 | OPEN (no channel configured) |
| E3 | Repair runbook: `raise-refund`, `repair-payment` endpoints | PASS (exist, tested); runbook text OPEN |
| E4 | `SHOP_RESERVATION_EXPIRY=on` switched on deliberately after deploy | OPEN |
| E5 | Vendor payout runs only with two staff, verified account, real reference | PASS (code); real payout never exercised — **no real payouts were made or simulated against a provider** |

## F. Mobile and portal

| # | Gate | State |
|---|---|---|
| F1 | Checkout recovery, honest payment/refund wording, options | PASS (tests: 1038) |
| F2 | Run on a real device / Flutter web UAT from RC against an isolated backend | **OPEN — not run** |
| F3 | Push on a phone for new orders | OPEN (platform-wide, see comms module notes) |
| F4 | Portal: no vendor-order or reconciliation screens exist; staff use the API | OPEN |
| F5 | Mobile message for `too_many_unpaid_orders` (currently generic "could not place the order") | OPEN (small) |

## G. Security and privacy

| # | Gate | State |
|---|---|---|
| G1 | Customers cannot see commission, payouts, internal fields; public cannot see reviewer ids | PASS (tested) |
| G2 | Input bounds on orders and products; image upload ≤ 10 MB, must decode as an image | PASS (tested; upload route covered by code review, not an automated test) |
| G3 | Unpaid-order cap per buyer (stock hoarding) | PASS (tested) |
| G4 | Generic request rate limiting on shop routes | OPEN — the platform has none outside sign-in/PIN/invitations; the unpaid-order cap and bounds are the only controls |
| G5 | Independent security review of auth, KYC, tenancy and payouts | OPEN — the `security-and-privacy-reviewer` agent was not run; this checklist reflects my own review only |
| G6 | Vendor payout details protected | PASS by inspection (public profile is a whitelist; admin-only otherwise); not separately tested |

## H. Known limits that are accepted until someone decides otherwise

- A vendor editing a product's stock sets an absolute number; an edit made in the same instant as a purchase can overwrite that purchase's deduction (small window; the reconciliation `negative_stock` and ledger would show drift). Fix needs an "adjust by" API, not done.
- One option per product per order in the app; reorder drops options.
- `pickupGymId` is not checked against real gyms (M-17).
- Concurrency tests are single-process.

## Outcome

**CONDITIONALLY READY — for a controlled launch with manual payment confirmation only.**
See `marketplace-production-readiness.md` for the reasoning and what flips it to
NOT READY (any open P0) or READY FOR CONTROLLED LAUNCH (B, C2–C3, E, F2, G5 done).
