# B2B Foundation V1

The first step in growing FitFlex from corporate wellness into a general B2B wellness benefits platform:

> Organisation → (later: Wellness Programme → Benefits) → Beneficiaries → FitFlex ecosystem

V1 adds **organisations, organisation users and beneficiaries**. It deliberately stops short of programmes, benefits, sponsorship rules, billing and settlement (see "Next phase").

## 1. Corporate today (unchanged)

| Piece | Where |
|---|---|
| `CorporateAccount` (company, subsidy model, pass tier, seats, status `pending/active/suspended/terminated`) | migration `20260922120000-corporate-wellness` |
| `CorporateEmployee` (seat; `userId` is never written today, so most employees aren't linked to a FitFlex user) | same |
| `CorporateBill` (per-period seat bill) | same |
| HR logins: `User` rows with `userType = 'corporate_hr'` and `User.corporateId` | `corporate-service.createHrUser` |
| Routes `/corporate/*` (HR) and `/admin/corporate/*` (admin, ACL `corporate`) | `functions/corporate.mjs` |
| `corporateId` consumers: challenges (`creatorType = 'corporate'`), challenge rewards, social groups (`SocialGroup.corporateId`, `User.corporateId`), auth claims, KYB (`PartnerKycCase.corporateId`) | services listed in the PR |

None of these tables, columns, routes or response shapes change. The only code change on the Corporate side is an optional `onAccountCreated` hook in `corporateService.onboard`. It runs after the account is saved, and any error is logged and swallowed, so it can never fail onboarding.

## 2. The B2B abstraction

```
B2BOrganization ──< B2BOrganizationUser >── User   (who administers it: role + status)
      │
      └──────────< B2BBeneficiary >──────── User   (who receives its benefits: a relationship)
      │
      └── legacyCorporateId ──► CorporateAccount   (employer organisations only, unique)
```

| Table | Key columns | Notes |
|---|---|---|
| `B2BOrganization` | `organizationType`, `legalName`, `tradingName`, `industrySector`, `registrationNumber`, `taxIdentificationNumber`, `email`, `phone`, `address` (jsonb), `status`, `statusReason`, `statusChangedAt`, `legacyCorporateId` | Registration and TIN are normalised the same way as KYC (`normalizeIdentifier`) and unique when set. |
| `B2BOrganizationUser` | `organizationId`, `userId`, `role`, `permissions` (text[] extra grants), `status`, `removedAt` | One live seat per user per organisation. Removal keeps the row. |
| `B2BBeneficiary` | `organizationId`, `userId`, `externalReference`, `beneficiaryType`, `groupName`, `status`, `enrolledAt`, `statusChangedAt` | One row per member per organisation, and `externalReference` is unique within the organisation. |

Conventions follow the existing schema: text ids with prefixes (`b2bo_`, `b2bu_`, `b2bb_`), `createdAt`/`updatedAt` timestamp(3), CHECK constraints for closed status sets, and partial unique indexes. Foreign keys cascade from the organisation. `legacyCorporateId` is `RESTRICT`, so a mapped company can't be deleted out from under its organisation. `B2BBeneficiary.userId` is `SET NULL`, so the organisation keeps its record if the persona is deleted.

### Organisation types

`employer, insurer, club, association, bank, ngo, institution, other` (`src/shared/b2b.mjs`). The database only checks a type's *shape* (a lowercase slug). Adding a type is a code change, not a migration.

### Lifecycles

| Entity | Statuses | Transitions |
|---|---|---|
| Organisation | pending, active, suspended, inactive | pending→active/inactive · active→suspended/inactive · suspended→active/inactive · inactive→active (FitFlex reopens) |
| Organisation user | active, suspended, removed | any → removed (final); active ↔ suspended |
| Beneficiary | pending, active, suspended, inactive | same shape as organisations; `enrolledAt` is set on first activation and kept on re-activation |

Organisation status is FitFlex-only (`POST /admin/b2b/organizations/:id/status`). Users of a **pending** organisation get read permissions only. Users of a **suspended** or **inactive** organisation get no access, and beneficiaries can only be enrolled or activated while the organisation is active.

### Roles and permissions

| Role | organization.read | organization.update | users.read | users.manage | beneficiaries.read | beneficiaries.manage |
|---|---|---|---|---|---|---|
| owner, admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| manager | ✓ | | ✓ | | ✓ | ✓ |
| hr | ✓ | | | | ✓ | ✓ |
| analyst | ✓ | | | | ✓ | |
| finance, viewer | ✓ | | | | | |

`permissions` on the row adds extra grants. Nobody can grant more than they hold themselves. Only owners (or FitFlex) can create or change an owner, and an organisation can't lose its last active owner except through FitFlex.

### Authorisation and isolation

This reuses the existing mechanisms: `requireAuth`, `requireAcl`, the per-request suspended-account check, and `AuditLog` for every write.

- **FitFlex admins**: `requireAuth('admin')`. Portal staff also need the new ACL scope `b2b`, which is added to `PORTAL_ACL_SCOPES` and the portal Users page.
- **Organisation users**: any signed-in persona. `b2bService.resolveAccess` derives the role from an **active** `B2BOrganizationUser` row for *that* organisation, and never from anything the caller sends. A caller with no role in the organisation gets `404 organization_not_found`, so the existence of other organisations isn't revealed. Every user or beneficiary id is also checked against the resolved organisation.
- **Corporate HR logins** get role `hr` in their own mapped organisation only, and only while their login is active.

## 3. Corporate → B2B compatibility

| Question | Answer |
|---|---|
| Which organisation represents this `CorporateAccount`? | `B2BOrganization.legacyCorporateId = corporateId` (unique). The id is deterministic, `b2bo_ + md5('corporate:' + corporateId)[0..12]`. `GET /admin/b2b/corporate/:corporateId` returns it. |
| What type is it? | Always `employer`, enforced by a CHECK constraint. |
| Which `CorporateEmployee` rows are its beneficiaries? | All of that company's employees, **read through** as `beneficiaryType = 'employee'`, `groupName = department`, `source = 'corporate_employee'`, `readOnly = true`. Status maps pending→pending, active→active, suspended→suspended, exited→inactive. |
| Who administers it? | Its `corporate_hr` logins, read through as role `hr` (`source = 'corporate_hr'`, read-only), plus any native B2B users you add (for example finance or analyst). |
| KYB? | The existing `PartnerKycCase` (`partnerType = 'corporate'`, `corporateId`). The organisation view shows `kyc: { supported, caseId, status }` and reads registration number and TIN from that case. |

**Corporate stays the source of truth for a mapped organisation.** Name, sector, contact and status are read live from `CorporateAccount`, so a change made on the Companies page shows up immediately. B2B writes to those fields, to status, to beneficiaries and to HR users are refused with `409 managed_by_corporate`, which names the corporate route to use instead. Only the B2B-only fields (`tradingName`, `address`) and native B2B users are editable. Employees are never copied, so seat limits, the subsidy split and `CorporateBill` keep a single source of truth, and nothing can drift.

Non-employer organisations have no KYB workflow yet (`kyc.supported = false`). The planned extension is a nullable `PartnerKycCase.organizationId` plus a new `partnerType`, which reuses the requirement evaluator, documents and review queue. No KYC logic is duplicated here.

## 4. Migration strategy

1. `20261101090000-b2b-foundation`: the schema only. `down` drops the three new tables.
2. `20261101091000-b2b-corporate-backfill`: one insert-only statement that creates an employer organisation for each `CorporateAccount`, using `ON CONFLICT DO NOTHING` and the same deterministic id, so re-running it adds nothing. It only **reads** Corporate tables. `down` removes mapped organisations nobody has started using (no B2B users or beneficiaries), and leaves anything else for a person to look at.
3. New companies are mapped at onboarding by the `onAccountCreated` hook. `POST /admin/b2b/corporate-sync` (the **Sync companies** button) repairs any gap, idempotently.

## 5. API

All B2B list endpoints return `{ items, total, nextCursor }`, taking `limit` (max 100) and `cursor`. Errors are `{ error, ...context }`, the same as Corporate.

| Method & path | Who |
|---|---|
| `GET /b2b/reference` | public |
| `POST /admin/b2b/organizations` · `GET /admin/b2b/organizations?type&status&search` | admin (`b2b`) |
| `POST /admin/b2b/organizations/:id/status` | admin (`b2b`) |
| `POST /admin/b2b/corporate-sync` · `GET /admin/b2b/corporate/:corporateId` | admin (`b2b`) |
| `GET /b2b/me/organizations` | any signed-in user |
| `GET` / `PUT /b2b/organizations/:id` | organization.read / organization.update |
| `GET` / `POST /b2b/organizations/:id/users` · `PUT` / `DELETE …/users/:orgUserId` | users.read / users.manage |
| `GET` / `POST /b2b/organizations/:id/beneficiaries` · `GET …/:beneficiaryId` · `POST …/:beneficiaryId/status` · `DELETE …/:beneficiaryId` | beneficiaries.read / beneficiaries.manage |

`DELETE` never deletes. It sets `removed` for a user and `inactive` for a beneficiary.

## 6. Relationship to Identity V2

`B2BOrganizationUser` and `B2BBeneficiary` are organisation relationships, which is the role Identity V2 plans for `OrgMembership` in phase I4. They key on `User.id` like every existing foreign key. When I4 lands, they can either become `OrgMembership` rows (`orgType = 'b2b'`) or reference `Person` through `User.personId`. A member's B2B relationships are always separate rows and never change their persona, so one member can be an employee of A, a policyholder of B and a personal subscriber at the same time.

## 7. Wellness programmes

Built in Phase 2: see [B2B_PROGRAMS.md](B2B_PROGRAMS.md). The original sketch:

```
B2BOrganization ──< WellnessProgram ──< Benefit (sponsored / subsidised access, challenge, service)
                          │                  └─ rules: eligibility, sponsor share vs beneficiary co-pay, caps
                          └──< ProgramEnrolment >── B2BBeneficiary
Usage events (check-ins, bookings, activities) ──► usage ledger ──► sponsor invoice / provider settlement
```

Corporate's subsidy model and seat billing become the first programme template ("employer seat programme"). The settlement engine (`settlement-*`) provides provider payouts.
