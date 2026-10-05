# B2B analytics and reporting

A read layer over the ledgers the earlier phases write. It stores no figures
and decides none. This document is the KPI dictionary: every number on an
analytics screen is defined here.

Code: `src/services/b2b-analytics-service.mjs`, `src/shared/b2b-analytics.mjs`,
routes at the end of `functions/b2b.mjs`, tests `specs/b2b-analytics.specs.mjs`.

> Naming: the work merged on 5 Oct 2026 as "Phase 6" was collections
> (`B2B_COLLECTIONS.md`). This is the analytics phase of the roadmap.

## 1. Decisions this implements (product owner, 5 Oct 2026)

| # | Decision |
|---|---|
| A-01 | A beneficiary is **active** in a period when they used a sponsored benefit in it. |
| A-02 | An organisation sees its own people **individually**, including activity it did not fund. Hidden always: weight, height, and anything another organisation funds or runs. Calories, notes and routes are also left out. |
| A-03 | The product's wording, a notice to members and the privacy policy are changed to say so. |

## 2. Where figures come from

| Figure | Source of truth | Read how |
|---|---|---|
| Sponsored usage | `B2BBenefitConsumption`, status `approved` | SQL aggregation |
| Sponsored-pass visits | `Checkin` (status `valid`) joined to `B2BPassEntitlement` by `subscriptionId` | SQL aggregation |
| Pass fees (flat) | `B2BPassEntitlement.sponsorTzs` / `memberTzs` | SQL aggregation |
| People | `B2BBeneficiary`, and `CorporateEmployee` for a company mirrored into an organisation | `b2bService.allBeneficiaries` |
| Eligibility | programme and benefit rules | `matchesPopulation` (the consumption engine's own function) |
| Invoiced, collected | `B2BSponsorInvoice`, `B2BPayment` | SQL aggregation |
| Outstanding, overdue, aging | invoices and payments | `b2bFinanceService.statement` |
| Activity | `Activity`, `Checkin` | SQL aggregation |
| Challenge progress | challenges the organisation runs | `challengeService.memberProgressForCreator` |
| Settlement progress | `SettlementVisit` (mode `live`) | SQL count, FitFlex staff only |

No summary tables, cache or warehouse. Every screen is **live**: it reads the
ledgers when asked, and `generatedAt` is the time of the read.

## 3. Rules that hold for every figure

- **Verified usage only.** `approved` consumption counts. A hold not yet
  confirmed (`pending`), a rejection, a cancellation and a reversal do not. A
  correction therefore shows as the final state, not as an extra row.
- **Days are East Africa Time** calendar days, inclusive at both ends. Usage
  uses the ledger's `businessDate`; timestamps are converted in SQL.
- **One organisation at a time.** Every query is scoped to the organisation
  the caller's access was resolved for. A programme, benefit or person named
  in a filter must belong to it, or the request is refused.
- **Billing and provider settlement are separate.** They are never added
  together, and what a provider is paid is not shown to an organisation.
- **Filters apply to everything on the screen** (programme, benefit, provider,
  group), except the billing block, which is always the whole account.

## 4. Periods

`?period=` one of `today`, `yesterday`, `last_7_days`, `last_30_days`,
`this_month` (default), `last_month`, `this_quarter`, `last_quarter`,
`year_to_date`, `last_year`; or `?from=&to=`. At most 800 days.

| Period | Compared with |
|---|---|
| Whole month, quarter or year | the one before it |
| Still running (this month, this quarter, year to date) | the same number of days at the start of the one before (1–12 Oct beside 1–12 Sep) |
| Anything else | the same number of days immediately before |

Trend buckets: by day up to 31 days, by week (Monday) up to 183, then by month.

## 5. KPI dictionary

Access levels: **R** = `analytics.read` (owner, admin, manager, hr, finance,
analyst); **P** = `analytics.people` (owner, admin, manager, hr); **B** =
`billing.read` (owner, admin, finance); **S** = FitFlex staff.

### People

| KPI | Definition | Formula | Access |
|---|---|---|---|
| Total beneficiaries | Everyone on the organisation's list, any status | count | R |
| Enrolled | On the list with status `active` | count | R |
| Pending | Added but not yet active | count | R |
| Linked to an account | On the list and joined to a FitFlex account | count with `userId` | R |
| Enrolled in period | Whose enrolment date falls in the period | count | R |
| **Active beneficiaries** | Used a sponsored benefit in the period: a verified funded visit or session, or a valid check-in on a pass this organisation sponsored | distinct people over both sources | R |
| **Utilisation rate** | Share of enrolled people who were active | active ÷ enrolled | R |
| Inactive | Enrolled and not active in the period | enrolled − active | R |

Limitation: enrolled is counted as of now, not as of the period. Looking back
at an old period, people who have since left are not in the base.

### Usage

| KPI | Definition | Formula | Access |
|---|---|---|---|
| Uses | Verified per-use units (visits, sessions) | Σ `quantity` | R |
| Pass check-ins | Valid check-ins on a sponsored pass | count | R |
| Sponsored visits | Both of the above | uses + pass check-ins | R |
| Average per active beneficiary | | sponsored visits ÷ active | R |
| Service value | List value of per-use services used | Σ `grossTzs` | R |

### Spend (what usage cost each side)

| KPI | Definition | Formula | Access |
|---|---|---|---|
| Sponsor per-use | Sponsor's share of verified per-use usage | Σ `sponsorTzs` | R |
| Sponsor pass fees | Flat fees for passes in months overlapping the period | Σ entitlement `sponsorTzs` | R |
| Sponsor total | | per-use + pass fees | R |
| Member per-use / pass shares | The member's own share | Σ `beneficiaryTzs`; Σ entitlement `memberTzs` | R |
| Cost per active beneficiary | **Operational indicator, not ROI** | sponsor total ÷ active | R |
| Cost per sponsored visit | **Operational indicator, not ROI** | sponsor total ÷ sponsored visits | R |

Spend is what was used, before VAT and platform fees. It is not what was
invoiced; see Billing. Pass fees count a whole month when any part of it is
in the period.

### Benefits

| KPI | Definition | Formula | Access |
|---|---|---|---|
| Eligible | Enrolled people the programme's and benefit's rules cover | `matchesPopulation` | R |
| Used it | Distinct people with verified use (for a pass: with a check-in) | count | R |
| **Reach** | Share of eligible people who used it at all. Defined for every benefit | used it ÷ eligible | R |
| Uses per user | | uses ÷ used it | R |
| **Allowance used** | Only for a benefit with a limit, for the window in force today | consumed units ÷ (eligible × limit) | R |
| People at limit / near limit | Used all of, or at least 80% of, the allowance in that window | count | R |

Reach and allowance used answer different questions and are not combined
into one "utilisation" number. A benefit without a limit has no allowance.

### Programmes

| KPI | Definition | Formula | Access |
|---|---|---|---|
| Participation | Share of the programme's eligible people who were active on it | active ÷ eligible | R |
| Budget used | Per-use sponsor money committed over the programme's whole life, including holds, exactly as the consumption engine counts it | Σ `sponsorTzs` (pending + approved) ÷ budget | R |

### Providers

| KPI | Definition | Formula | Access |
|---|---|---|---|
| Visits | Per-use visits plus pass check-ins at the provider | sum | R |
| People | Distinct people who went | count | R |
| Came back | People with two or more visits there in the period | count | R |
| Service value | List value of per-use services there | Σ `grossTzs` | R |
| In live settlement / not yet settled | Per-use gym visits the settlement engine has taken into a live run | count of `SettlementVisit` | S |

### Engagement (activity whoever paid)

| KPI | Definition | Access |
|---|---|---|
| People with activity | Linked people with any logged activity or valid gym check-in | R |
| Activities, steps, distance, active minutes | Totals of what people recorded | R |
| Workouts | Activities other than passive device step counts (the app's own `isWorkout` rule) | R |
| Gym check-ins | Every valid check-in, sponsored or not | R |
| People in challenges | Joined a challenge this organisation runs that overlaps the period | R |

These are counts of recorded activity. They are not health outcomes and no
health or savings claim is derived from them.

### Billing

| KPI | Definition | Formula | Access |
|---|---|---|---|
| Invoiced | Invoices and notes issued in the period | Σ `totalTzs` of billed invoices by issue date | B |
| Collected | Payments received in the period | Σ `amountTzs` by received date | B |
| Outstanding, overdue, credit, aging | As on the statement, as of now | finance service | B |

### Individual level (P)

Per person, for the period: status and group; sponsored uses and what each
side paid; every sponsored visit and session with date and provider; pass
check-ins with date and gym; other gym visits; activities recorded (type,
date, duration, distance, steps, active minutes, intensity); progress in the
organisation's own challenges.

Never returned: weight, height, calories, notes, routes, contact details,
and any visit, benefit, pass, challenge or group another organisation funds
or runs. A person covered by two organisations is two separate views.

## 6. Data-quality checks (`GET /admin/b2b/analytics/data-quality`)

Each reports a count and up to five example ids. Nothing is repaired.

| Check | Severity |
|---|---|
| Usage whose benefit no longer exists | high |
| Verified gym usage whose check-in is missing or voided | high |
| Verified trainer usage whose booking is missing or not completed | high |
| Usage where sponsor and member shares do not add up to the value | high |
| Invoices whose lines do not add up to the total | high |
| Invoices with more applied than they are for | high |
| Payments with more allocated than received | high |
| Active allocations on a reversed payment | high |
| Verified usage with no member account | medium |
| Usage still on hold after two days | medium |
| Verified sponsor usage older than last month that is on no invoice | medium |
| Passes marked started with no pass behind them | medium |
| Active beneficiaries whose account no longer exists | low |

## 7. Reports (`GET /b2b/organizations/:id/analytics/export/:report`)

CSV, for the selected period. Each export is written to the audit log
(`b2b.analytics.export`: who, which report, range, rows).

| Report | For | Access |
|---|---|---|
| `beneficiaries` | Each person with usage and activity totals | P |
| `usage` | Each sponsored visit and session | P |
| `activity` | Each recorded activity | P |
| `benefits` | Benefit utilisation | R |
| `programs` | Programme performance | R |
| `providers` | Provider utilisation | R |
| `invoices`, `payments` | Billing | B |

Row-level reports stop at 50,000 rows. PDF is the browser's print view.
Historical invoice figures do not change (issued invoices are immutable), so
no report snapshots are stored.

## 8. API

Organisation (staff use the same routes for any organisation):
`/b2b/organizations/:id/analytics/dashboard`, `/people`, `/people/:beneficiaryId`,
`/programs`, `/benefits`, `/providers`, `/finance`, `/export/:report`.

FitFlex staff: `GET /admin/b2b/analytics` (scope `b2b`),
`GET /admin/b2b/analytics/data-quality` (`b2b` or any billing scope).

## 9. Telling members

Job `b2bSponsorVisibilityNotice` (daily, 10:00 EAT) sends each covered person
one in-app message per sponsor saying what the sponsor can and cannot see.
The Benefits screen in the app carries the same statement, and the privacy
policy has a section on sponsors. The policy text is a draft for counsel.

## 10. Performance

Aggregation is done in SQL on indexed columns (`organizationId, consumedAt`;
`benefitId, beneficiaryId, businessDate`; `Activity(userId, startedAt)`;
`Checkin(memberId, timestamp)`; `Checkin(subscriptionId)`). The people list of
one organisation is read into memory, as the existing People screen does.
No load test has been run; see limitations.

## 11. Known limitations

- **Enrolled is as of now**, so utilisation for an old period uses today's list.
- **No load test.** Organisations with tens of thousands of people or very
  long ranges have not been measured; summary tables were deliberately not
  added before measuring.
- **Trainer settlement per provider** is not broken out; only gym settlement
  progress is shown to staff. Totals owed to providers remain on the billing
  dashboard (`billedAgainstProviders`).
- **No location or age segmentation.** Segmentation is by group or department,
  programme, benefit and provider.
- **Company seat bills** (old Corporate billing) are in outstanding and aging
  through the statement, but not in "invoiced" by month.
- **No scheduled or emailed reports**, and no Excel output.
- **No ROI or health-outcome figures**, by design.
