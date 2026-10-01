# Organisation authorisation: migration to OrgMembership (Identity V2 · I5)

Organisation authorisation is moving from structures embedded on the `User` row and in the JWT to `OrgMembership`. It moves **route group by route group**, behind a compatibility layer (`src/auth/org-authz.mjs`). Legacy authorisation is not removed.

## What decides access

| | Legacy (default) | Membership |
|---|---|---|
| **Who** | Persona in the JWT (`sub`, `userType`) | The same persona; its `Person` through `User.personId` |
| **Which gyms** | `gymIds` / `gymId` on the operator's own `User` row | Gyms where the persona has an **active** `OrgMembership` |
| **What staff may do** | `aclPermissions` **in the JWT** (stale until the token expires, up to 7 days) | `aclPermissions` on **that gym's** membership, read on each request |
| **Role** | `userType` (`gym_operator` = everything, `gym_staff` = ACL) | Membership `role` (`owner` = every scope at that gym, `staff` = that membership's scopes) |
| **Status** | Only `User.accountStatus` | Membership `status`: only `active` grants anything; `suspended`, `requested`, `removed`, `left` grant nothing |

A decision under the membership model therefore considers Person + persona + organisation + membership + role + membership status.

## Modes (`V2_ORG_AUTHZ`, under the `IDENTITY_V2` umbrella)

| Value | Behaviour on migrated routes |
|---|---|
| unset / `false` (**default**) | Legacy rules only. No membership read. |
| `shadow` | **Legacy rules decide.** The membership decision is computed alongside. Every disagreement is logged (`[org-authz] mismatch …`, ids only) and counted. |
| `true` | **Membership rules decide.** Disagreements with legacy are still logged. |

- `GET /admin/identity/org-authz` (admin, `settings` scope) returns the mode and the comparison counts per route since the process started.
- If the membership read itself fails, the legacy decision is used.
- Routes that have not been migrated ignore the mode entirely.

## How a route is migrated

1. Replace `requireGymAcl('<scope>')` with `requireGymAccess('<scope>', '<METHOD path>')`. Owner-only routes add `requireGymOwner('<METHOD path>')`.
2. Wrap the operator row: `effectiveOperator(req, await resolveRequestUser(req))`. In `enforce`, its `gymIds` become the gyms the persona's active memberships grant for that scope. Services that scope by `owner.gymIds` are then limited to them without being rewritten.
3. Add the route to the table below and to `specs/identity-i5-membership-authz.specs.mjs`.
4. Run in `shadow` on production until the route shows no unexplained mismatches, then enforce.

## Migrated endpoints

**MIGRATION STATUS** is the same for every row in the two tables below: on the compatibility layer; enforced by membership only when `V2_ORG_AUTHZ=true`.

### Staff administration (`functions/owner-staff.mjs`): grants and removes authority

| Endpoint | OLD AUTHORIZATION | NEW AUTHORIZATION |
|---|---|---|
| `GET /owner/staff` | `requireAuth('gym_operator')`; staff listed for the gyms in the owner row's `gymIds` | Persona is `gym_operator`; gyms = active `owner` memberships |
| `POST /owner/staff` | Same; new staff may only be assigned to the row's `gymIds` | Same; assignable gyms = active `owner` memberships |
| `PUT /owner/staff/:id` | Same; target must share a gym in the row's `gymIds` | Same; target must be at a gym the caller actively owns |
| `POST /owner/staff/:id/remove` | Same | Same |

### Member management (`functions/owner-members.mjs`)

| Endpoint | OLD AUTHORIZATION | NEW AUTHORIZATION |
|---|---|---|
| `POST /owner/members` | `requireAuth('gym_operator','gym_staff')` + `requireGymAcl('members')` (JWT ACL); gyms from the row's `gymIds` | Owner, or staff with an **active** membership whose ACL has `members`; gyms = those memberships' gyms |
| `GET /owner/members` | Same | Same |
| `GET /owner/members/:memberId` | Same | Same |
| `GET /owner/members/:memberId/checkin-summary` | Same | Same |
| `GET /owner/members/:memberId/checkins` | Same | Same |
| `GET /owner/members/:memberId/payments` | Same | Same |
| `POST /owner/members/:memberId/checkin` | Same, with scope `checkins` | Same, with scope `checkins` |
| `POST /owner/members/:memberId/renew` | Same | Same |
| `PATCH /owner/members/:memberId` | Same | Same |
| `POST /owner/members/:memberId/suspend` | Same | Same |

**What changes for these routes under `enforce`:**
- A staff member whose ACL was reduced, or who was suspended or removed at a gym, loses access **on the next request** instead of when their token expires.
- Staff with different permissions at different gyms act only at the gyms where the scope is granted.
- An owner acts only on gyms they actively own.

## Not yet migrated (legacy rules, unaffected by the mode)

| Group | Routes | Current authorization |
|---|---|---|
| Check-in desk (`functions/checkins.mjs`) | 4 | `requireGymAcl('checkins')` + row `gymIds` |
| Gym, trainer and payment management (`functions/owner-gyms.mjs`) | 12 | `requireGymAcl('gyms' \| 'trainers' \| 'payments' \| 'checkins')` + row `gymIds` |
| Communications (`functions/communications.mjs`) | owner routes | `requireGymAcl('communications')` + row `gymIds` |
| Gym sharing, reviews, challenges, social groups | 5 | `requireGymAcl('members' \| 'gyms')` |
| Vendor (`functions/shop.mjs`) | all | `requireVendorPermission` (JWT) and `req.user.vendorId \|\| req.user.sub` |
| Corporate / B2B | all | The B2B module's own organisation-user rules (not `OrgMembership`) |
| Platform admin | all | `requireAcl` (portal staff ACL in the JWT) |

Migrate these one group at a time, each after its predecessor has run clean in `shadow`.
