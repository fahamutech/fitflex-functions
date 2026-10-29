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

### 3a. Company HR in the organisation area (Phase B · B5a, flag `ORG_ONLY_SPONSORS`)

Owner decisions (2026-10-20): convert the HR logins; company staff (`/corporate/staff`) stay the source of people for mapped organisations; `/hr` is deleted two weeks after the flag goes on (a later portal slice). With the flag **off** nothing above changes.

- **Conversion** — `node scripts/hr-to-org.mjs` (dry run; `--apply --db=<name>` to write, refused unless `<name>` is the connected database; `--corporate=<id>`; `--json`). Each `corporate_hr` login gets a `B2BOrganizationUser` row, role `hr`, on its company's organisation (the mirror is created as onboarding does when missing). Additive and re-runnable: the login keeps working, a live row is left alone, a removed row is never re-added, each row added writes `AuditLog` `b2b.org_user.convert_corporate_hr` (actor `system:hr-to-org`), and an applied run that changed anything writes `b2b.hr_to_org.run`. It is an ops script, not a migration: migrations run by themselves at deploy, and this changes who can sign in where, so it needs a dry run and a person deciding when. No schema change. With the flag on, `createHrUser` makes the row at once.
- **Sign-in** — `POST /auth/login`, `/auth/firebase/session`, `/auth/pin/login` (and anything using `sessionForPerson`) and `/auth/switch-persona` add `user.organizationUser: true`, `user.organizationRoles`, `user.organizationIds` for a company HR login that reaches its organisation. The JWT is unchanged; access is still decided per request. A session that is already signed in reads the same fields from `GET /b2b/me/organization-session` → `{ orgOnlySponsors, organizationUser?, organizationRoles?, organizationIds? }`.
- **People** — for a mapped organisation, `POST /b2b/organizations/:id/beneficiaries`, `.../:beneficiaryId/status`, `DELETE .../:beneficiaryId`, the new `POST .../:beneficiaryId/link` and `POST .../beneficiaries/import` write through `corporate-service` (seat limit, seat billing and `corporate.staff.*` audit unchanged). Status maps active→active, suspended→suspended, inactive→exited. Employee rows are no longer `readOnly` and carry `employeeStatus`, `linked`, and (for `beneficiaries.manage` only) `email`/`phone`.
- **Who** (owner decision 2026-10-22): on a company's organisation these company-staff powers (add, status/exit, link/unlink, staff email/phone, activation PINs, import) are for org roles `hr` and `admin` only (plus FitFlex platform admins); every other role gets `403 forbidden` with `requiredRoles: ['hr','admin']`, sees employee rows `readOnly: true` and no contact details. `GET /b2b/organizations/:id` → `access.companyStaffManage` tells the portal.
- **Member consent** (follows the RC enrol-by-ID consent flow, owner decision 2026-10-22): adding or linking a company employee from `/org` by `userId` or by email/phone never links on its own. The staff row gets the name the organisation gives (nothing of the member's is copied) and the member is asked (`employee_link` member request, `202 pending_member_acceptance`); they are linked when they accept, and acceptance re-checks that the requester still has company-staff powers in that organisation. Unknown ids get RC's stub. By email/phone `memberRequest.userId` is always null and the request is stored either way (consent slice (a); `memberRequest.id` is real since then). FitFlex platform admins link directly. Import never links: every row is added unlinked and members behind verified contacts are asked. Rows show `pendingLink` (when/until when, never who) to hr/admin.
- **Adding by contact** needs a name and answers the same whether or not a confirmed member is behind the contact; import returns a PIN for every row added.
- **A converted row decides, flag on or off** — once an HR login has its own row, suspending or removing it closes `/org`; the read-through applies only to logins without one.
- **Tenancy** — a company HR login reaches only its own company's organisation, only while active; once it has a row, that row decides (suspended/removed in `/org` closes `/org`, `/corporate` still works until `/hr` goes); it cannot be added to another organisation (`409 hr_login_other_company`).
- Challenges, rewards and groups already resolve a mapped organisation to its Corporate scope (§8), so `/org/...` and `/corporate/...` show the same ones.

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

### Adding someone by user id needs their consent (22 Oct 2026)

A user id proves nothing: ids show in activity feeds, groups and leaderboards. So when an **organisation user** (or a company's HR, on `POST /corporate/staff/:id/link`) names someone **only by `userId`**, nobody is added. The call answers `202 { outcome: "pending_member_acceptance", memberRequest }` and a `B2BMemberRequest` row waits for the person (kinds `beneficiary`, `org_user`, `employee_link`). Until they accept there is no beneficiary row, no staff link and no role, so the organisation sees none of their activity (every A-02 read goes through those rows) and no sponsor is charged. The person is told in the app (notification type `b2b_member_request`).

- Member: `GET /b2b/me/member-requests`, `POST /b2b/me/member-requests/:requestId/accept`, `POST …/decline` (any signed-in user; their own requests only, otherwise 404). `GET /b2b/me/benefits` also carries `memberRequests`. Accept is single use (409 `member_request_not_pending`); it performs the add with the requester's access as it is then.
- Organisation: list responses carry `pendingMemberAcceptance` (users and beneficiaries); `GET /corporate/staff` gives each employee `pendingLink`. `DELETE /b2b/organizations/:id/member-requests/:requestId` withdraws one; unlinking a staff record withdraws its open link request.
- Requests expire after `B2B_MEMBER_REQUEST_TTL_DAYS` days (default 14); job `b2b-member-request-expiry` closes them hourly.
- Limits (each request is a notification): after a decline or a withdrawal the same organisation / company can't ask the same person again for `B2B_MEMBER_REQUEST_COOLDOWN_DAYS` (default 30; `429 member_request_cooldown { retryAfter, retryAfterSeconds }`); at most `B2B_MEMBER_REQUEST_MAX_PENDING` open requests per organisation / company (default 200; `429 member_request_limit { maxPending }`); at most `B2B_MEMBER_REQUEST_RATE_PER_HOUR` adds by user id per requester per hour (default 60; `429 rate_limited { retryAfterSeconds }`, counted in memory per server for every attempt and from stored requests across servers).
- Probing: the organisation never sees the person's name before they accept (`displayName: null`). An id that names nobody (or, for a beneficiary or staff link, no member) gets the same `202` with `memberRequest.id: null`; nothing is stored and nobody is told. Request, accept, decline, expire and cancel are in `AuditLog` (`b2b.member_request.*`).
- What the member is told says plainly that the organisation also sees activity from **before** they joined (full history, owner decision 22 Oct 2026; `visibility.shown` includes `past_activity`).
- FitFlex platform admins still add by user id directly, and the person is now told (notification `b2b_admin_added`, data `{ kind, organizationId, open: 'b2b_benefits', locale, titleEn, bodyEn, titleSw, bodySw }`; audit `b2b.member.admin_added`).
- **Consent slice (a), 29 Oct 2026** (owner decision 22 Oct, re-confirmed 29 Oct): adds by a **verified** email or number now wait too, and so do bulk import and invite matching. See below.
- Analytics (A-02): a person's own activity (workouts, steps, gym visits, challenge progress) is shown only while they are `active` or `suspended`, not while `pending` or after they leave. The Corporate dashboard (`GET /corporate/dashboard`) counts visits on the same rule.

### Adding someone by email or number, by import or by invite needs their consent too (29 Oct 2026)

Knowing someone's email or number is not their agreement either. Organisation users (`POST /b2b/organizations/:id/beneficiaries`, `POST …/users`), legacy company HR (`POST /corporate/staff/:id/link`) and `/org` company staff adds (B5a) by **email / phone** make a `B2BMemberRequest` with `source: "contact"`; bulk import enrols nobody; an invite that matches a member's verified contact makes one with `source: "invite"`. Kinds are unchanged (`beneficiary`, `org_user`, `employee_link`), so the app's request inbox shows them as before.

- **Same answer whoever is behind the contact.** Every add by contact is stored: with the member when there is a verified member who may be asked, otherwise with nobody (`userId` null; nobody is told; it expires). Reply `202 { outcome: "pending_member_acceptance", memberRequest: { id, source: "contact", contactType, contact, userId: null, displayName: null, … } }`. Asking for the same contact again returns the same request. Nobody behind it covers: no verified member, an unverified profile email, a non-member account, already enrolled / already a portal user / already linked, a member in cooldown or with a request from the same organisation already open. Those reasons are stored in `details.unmatched` (never shown).
- **Refusals never depend on the person:** 400 `invalid_email` / `invalid_phone` / `one_user_contact_only`, 409 `external_reference_in_use` (the organisation's own list), 409 `member_request_pending` for a staff record that already shows a link request, 429 `rate_limited` (per requester, or `scope: "organization"` for the per-organisation hourly cap `B2B_MEMBER_REQUEST_ORG_RATE_PER_HOUR`, default 300) / `member_request_limit` (the open cap counts requests with nobody behind them). `429 member_request_cooldown` is never returned by contact.
- **What the member did is masked:** the organisation sees a request by contact only as `pending_member_acceptance` until it expires, then `expired` (decidedAt = expiresAt), or `cancelled` once it withdraws it (at any time, also on a second DELETE: `409 { requestStatus: "cancelled" }`), or `accepted`. A decline looks exactly like nobody being behind the contact; the decline and its cooldown stay. The member is told after the reply is sent, and the same checks run either way, so timing does not differ.
- **Retention:** the typed `contactValue` is cleared from requests closed (or past expiry) for more than `B2B_MEMBER_REQUEST_CONTACT_RETENTION_DAYS` (default 30) by the hourly `b2b-member-request-expiry` job (PDPA retention note).
- **Lists:** `pendingMemberAcceptance` and `pendingLink` include requests by contact (with `userId` null). Requests from invites are never listed; the organisation sees the invite stay `invited` until the member accepts (then `enrolled`).
- **Import** (`POST …/beneficiaries/import`): accounts are not looked up and nobody is asked during the import; every new row is invited and `enrolled` is always 0 (kept for compatibility). Matching runs every 10 minutes and when a member opens Benefits; it asks once per invite (`requestedByType: "system"`) and never writes to the invite: the link is kept in `B2BBeneficiaryInviteMatch`, so the invite list (status, counters, schedule, `updatedAt`) looks the same whether or not a member is behind it. Someone already on the list is not asked and their invite stays as it is. After a decline (or for someone already on the list) invitation messages are recorded as sent on schedule but not delivered. "Send again" behaves the same for everyone; the same invite is never asked again (cancel it and import again to ask anew). Cancelling an invite withdraws its request. `/org` company staff import adds every row unlinked with a PIN and asks members behind verified contacts.
- **FitFlex platform admins** still add and link directly by email or number too, and the person is now told (`b2b_admin_added`). Imports by an admin also only ask; such a request is carried out on acceptance only while that person is still an active FitFlex admin with the `b2b` scope (`409 request_no_longer_valid { reason: "requester_not_admin" }`).
- Migration `20270128090000-b2b-member-requests-by-contact.cjs`: `B2BMemberRequest.source`, `contactType`, `contactValue`, `inviteId`, `userId` nullable (only for `source = 'contact'`), unique open request per member by id, per contact, per invite; new table `B2BBeneficiaryInviteMatch` (inviteId → memberRequestId or beneficiaryId; never shown).

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

## 8. Challenges, rewards and groups

An organisation runs wellness challenges and groups for its own people, the
same way a company's HR does. One engine serves both; nothing is duplicated.

**Who belongs.** `src/services/company-directory.mjs` answers "who are this
company's people" and "which companies does this member belong to" for both
kinds of company:

| Kind | People list | Counts as a member when |
|---|---|---|
| `corporate` | `CorporateEmployee` | linked to a FitFlex account (`userId`), status `active` or `pending` |
| `organization` | `B2BBeneficiary` | linked to a FitFlex account, status `active` |

Before this, belonging was read from `User.corporateId`, which is set for HR
staff accounts only and never for members. So company-only challenges,
company groups and the "company" sharing audience matched no one. They now
follow the people list. `User.corporateId` is still honoured where it is set.

**Which owner a route acts for.** `src/services/b2b-engagement-access.mjs`
resolves `/b2b/organizations/:organizationId/...`:

- an organisation that mirrors a Company (`legacyCorporateId` set) acts as
  that Company (`corporate`), so its HR portal and its organisation users
  manage the same challenges and groups;
- any other organisation acts as itself (`organization`).

Reads need `engagement.read`; changes need `engagement.manage`.

| Role | engagement |
|---|---|
| owner, admin, manager, hr | read + manage |
| analyst | read |
| finance, viewer | none |

**Routes** (all under `/b2b/organizations/:organizationId`, same request and
response shapes as the `/corporate/...` ones):

- `GET|POST /challenges`, `PATCH /challenges/:id`, `POST /challenges/:id/cancel|close|archive`,
  `GET /challenges/:id/participants|leaderboard`
- `GET /rewards`, `POST /rewards/:id/status`
- `GET|POST /groups`, `GET|PATCH /groups/:id`, `POST /groups/:id/archive`,
  `POST /groups/:id/members/:userId/:action`

**What carries over unchanged.** The organisation sees totals only (groups
under three people are folded together), never a person's activity. A
beneficiary's `groupName` plays the part of a department: "chosen
departments" eligibility and the department format use it. Members see an
organisation's challenge exactly as they see a company one, so the app needs
no change. Rewards an organisation funds (`rewardFunding: company`) are
approved and issued by the organisation; FitFlex-funded ones by FitFlex.

No migration: `creatorType` and `ownerType` are free text columns.
