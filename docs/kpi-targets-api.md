# KPI targets API (FR-K01)

Spec: parent repo `docs/specs/programmes-nutrition.md` §3 (FR-K01) and `docs/specs/whatsapp-onboarding.md` §3. Plan: `docs/plans/programmes-p1-plan.md` (PD-9).

Admins view and change the KPI targets for Programmes & Nutrition and the WhatsApp funnel. The targets start as the owner's conservative proposals (D-07) and are marked `assumption: true` until an admin confirms them.

Both routes need `requireAuth('admin')` and the `analytics` scope.

| Route | What it does |
|---|---|
| `GET /admin/kpi-targets` | `{ targets: [...] }` in display order |
| `PUT /admin/kpi-targets/:id` | Body (any of): `target`, `baseline`, `confirmed`. Answers `{ target }`.<br>Errors: 400 `invalid_kpi_target` + `field`, 400 `nothing_to_change`, 404 `not_found` |

## A target

| Field | Notes |
|---|---|
| `id` | Fixed per KPI, e.g. `pn_programme_starts`. The portal holds the words (English and Swahili) |
| `area` | `programmes` or `whatsapp` |
| `unit` | `percent`, `percent_change`, `percent_lower`, `points` or `count` |
| `baseline` | Free text as the spec writes it ("To measure", "n/a", "0"), up to 40 characters, or null |
| `draftTarget` | The v0.2 figure, kept for reference; not editable |
| `target` | The current target. Ranges: `percent` and `percent_lower` 0–100, `percent_change` −100–1000, `points` −100–100, `count` 0–1,000,000; at most two decimals |
| `assumption` | True until confirmed (`confirmed: true`); `confirmed: false` makes it an assumption again |
| `confirmedAt`, `confirmedBy`, `updatedAt`, `updatedBy` | Who and when |

## Audit

Every change writes an `AuditLog` row: action `kpi_target_updated`, the KPI id as `target`, the admin as `actor`, and `before` / `after` as `{ target, baseline, assumption }`.

## Seed (migration `20270219090000-kpi-targets`)

| id | KPI | Unit | Baseline | v0.2 | Target (ASSUMPTION) |
|---|---|---|---|---|---|
| `pn_active_days` | App-active days per paying member, per month | percent_change | To measure | +30% | +20% |
| `pn_programme_starts` | Active Pass holders who start a programme | percent | 0 | 35% | 25% |
| `pn_day7_completion` | Programme day-7 completion rate | percent | n/a | 50% | 40% |
| `pn_meal_logging` | Members logging a meal at least 3 days a week | percent | 0 | 20% | 12% |
| `pn_food_count` | Foods in the Tanzanian database | count | 0 | 400 | 400 |
| `pn_month2_renewal` | Month-2 Pass renewal rate | points | To measure | +10 points | +5 points |
| `wa_offer_reach` | WhatsApp conversations that reach a Pass offer | percent | n/a | 40% | 30% |
| `wa_offer_conversion` | WhatsApp offer-to-paid conversion | percent | n/a | 8% | 5% |
| `wa_cost_per_paid` | Cost per paid acquisition, WhatsApp vs paid social | percent_lower | To measure | 40% lower | 25% lower |

The table is additive and the migration can be reversed. Nothing measures these KPIs yet; this stores the targets only.
