# Partner date of birth: API contract (slice 2, backend)

Plan: partner DOB personalisation, owner go-ahead 2026-10-22. Trainers and gym owners give a date of birth, and owners can also give a gender, so that slice 4 can use age and gender for shop personalisation in those modes. This slice stores the values, adds the endpoints and gives admins a view-only read. Shop eligibility does not change yet. Communications and challenge targeting do not change.

## Flag

`PARTNER_DOB_REQUIRED` is a server env var and is **off** unless set to `1`, `true`, `on` or `yes` (`src/shared/feature-flags.mjs`, `partnerDobRequiredOn()`).

| | Off (default) | On |
|---|---|---|
| `GET /me/personal-details` | 404 `{"error":"feature_disabled"}` | 200 body below |
| `PUT /me/personal-details` | 404 `{"error":"feature_disabled"}` | saves |
| `GET /admin/trainers/:id/personal-details` | 404 `{"error":"feature_disabled"}` | 200 body below |
| `GET /admin/gym-owners/:id/personal-details` | 404 `{"error":"feature_disabled"}` | 200 body below |
| `POST /trainer/register` `dateOfBirth` | ignored (same as before) | checked and saved |
| `POST /gym-owner/register` `dateOfBirth`, `gender` | ignored (same as before) | checked and saved |

When the flag is off, every existing response is byte-identical to before. When it is on, the server still **never refuses a registration for leaving the date of birth out**, so old app builds keep working. The app makes the field compulsory (`required`/`ask` below).

## Storage

Migration `db/migrations/20270110090700-person-declared-details.cjs` is additive. `down` drops the columns.

| Column | Type | Meaning |
|---|---|---|
| `Person.dateOfBirth` | `date NULL` | the date of birth the person declared |
| `Person.gender` | `text NULL`, CHECK in `male`, `female`, `other` | NULL = not given / "prefer not to say" |
| `Person.declaredProfileUpdatedAt` | `timestamptz NULL` | when either value was last written |

- One value per human, shared by all of their personas (member, trainer, gym owner).
- KYC is never read, copied or backfilled. The KYC date of birth stays KYC-only. Existing accounts are test data and get no backfill.
- The values never appear on the public trainer profile, `/trainers`, `/trainers/:id`, `/trainer/me`, `/me`, `/gyms/:id`, `/admin/trainers`, `/admin/gym-owners` or in any export.
- **Identity merge:** the surviving Person takes the merged-in date of birth and gender, but only for a field it has no value for. A Person left empty (tombstone) keeps neither value.
- **Account deletion:** when the person's last persona is deleted, both values and `declaredProfileUpdatedAt` are cleared. This applies to `DELETE /me` and to the admin `DELETE /admin/gym-owners/:id`. `DELETE /admin/trainers/:id` also runs the step, but it removes only the trainer profile, so the trainer's account and its values normally stay.
- **Audit:** each write is logged as `personal_details_updated` with the target set to the Person. The row records which fields were set and whether each was `set` or `none` before and after, plus `via` (`me` | `trainer_register` | `gym_owner_register`). It never records the values.

## Date and gender rules

These rules are shared with `POST /me/profile` (`src/shared/date-of-birth.mjs`).

- `dateOfBirth` must be exactly `"YYYY-MM-DD"`, a real calendar date, from `1901-01-01` up to today (East Africa day). Anything else gets `400 {"error":"invalid_field","field":"dateOfBirth"}`, including:
  - `2023-02-29`
  - `2011/05/03`
  - `2011-5-3`
  - `" 2011-05-03"`
  - an ISO date-time
  - `1900-12-31`
  - tomorrow
  - numbers, booleans, objects and arrays
- **Under 18 (flag on):** a person who holds or takes a trainer or gym-owner role must be 18 or older today. On their 18th birthday they are accepted. The **effective date of birth** is used:
  1. the value being sent, if one is sent;
  2. otherwise the valid `Person.dateOfBirth`;
  3. otherwise a valid member-profile date of birth of the same Person.

  Sending `""` (clearing) skips step 2. If the effective date is valid and under 18, the request gets `400 {"error":"partner_under_18"}` and nothing is saved. With no date of birth at all the request is accepted, and the app asks for one (`ask`). This is checked on:
  - `PUT /me/personal-details`, when the person holds a trainer or owner role;
  - `POST /trainer/register` and `POST /gym-owner/register`, **even when no date of birth is sent**, before any profile or gym is saved;
  - `POST /me/personas`, when adding a `trainer` or `gym_operator`/`gym_owner` persona (Identity V2 `V2_ADD_PERSONA`). In `src/services/auth-service.mjs` **only `addPersona`** carries this check. Sign-in, OTP, PIN, session and persona-switch code are unchanged;
  - `POST /me/profile`: a member date of birth under 18 for a person who also holds a trainer or owner role.

  Members on their own may give any valid date.
- **Not checked, by design:**
  - Trainers and owners that an admin creates or invites are treated as admin-vetted.
  - An identity merge that brings in an under-18 date of birth is accepted. Slice 4 shop eligibility fails closed on any under-18 date of birth.
- `gender` must be `"male"`, `"female"` or `"other"`. Anything else (including `"Female"`) gets `400 {"error":"invalid_field","field":"gender"}`.

| Sent | `dateOfBirth` | `gender` |
|---|---|---|
| key left out | keep stored value | keep stored value |
| `null` | keep stored value (same as `/me/profile`) | **clear** (prefer not to say) |
| `""` / only spaces | clear | clear |
| valid value | save | save |

## `GET /me/personal-details`

Any signed-in user (`requireAuth()`); 401 without a session.

```json
{
  "dateOfBirth": "1994-03-21",
  "gender": "female",
  "source": "person",
  "ask": false,
  "required": true,
  "genderFrom": "person"
}
```

| Field | Values |
|---|---|
| `dateOfBirth` | `"YYYY-MM-DD"` or `null` |
| `gender` | `"male"` \| `"female"` \| `"other"` \| `null` |
| `source` | `"person"`: a valid `Person.dateOfBirth`, which always wins. `"member"`: otherwise a valid member-profile date of birth of the same Person (the caller's own member persona first). `null`: neither. |
| `ask` | flag on **and** the Person holds a live trainer or gym-owner persona **and** `dateOfBirth` is null. The app should show the DOB step/card. |
| `required` | flag on **and** the Person holds a live trainer or gym-owner persona |
| `genderFrom` | `"trainer_profile"`: the trainer profile's gender, used for trainer mode, so there is no second question. `"person"`: `Person.gender`. `null`: neither. |

Errors: `404 {"error":"feature_disabled"}`, `404 {"error":"user_not_found"}`.

## `PUT /me/personal-details`

Any signed-in user. Request body (both keys optional):

```json
{ "dateOfBirth": "1994-03-21", "gender": "female" }
```

`200` returns the same body as `GET`. Errors (exact bodies):

| Status | Body |
|---|---|
| 400 | `{"error":"invalid_field","field":"dateOfBirth"}` |
| 400 | `{"error":"invalid_field","field":"gender"}` |
| 400 | `{"error":"partner_under_18"}` |
| 404 | `{"error":"feature_disabled"}` |
| 404 | `{"error":"user_not_found"}` / `{"error":"person_not_found"}` |
| 503 | `{"error":"personal_details_unavailable"}`: the migration has not run yet. Nothing is saved. **Run the migration before switching the flag on.** The register routes return the same 503, before saving anything, when they are sent a date of birth or gender. |
| 429 | `{"error":"rate_limited","retryAfterSeconds":N}`, also a `Retry-After` header. The limit is 10 writes per minute per account, held in memory per server. |

Nothing is saved when a 400 is returned.

## Registration: what happens after the check

Both register routes behave the same way:

1. **Check first.** The check runs on the resolved account (`resolveRequestUser`; `/gym-owner/register` first auto-provisions a missing account as before). If no account can be resolved, the request fails closed with `404 {"error":"user_not_found"}`. If a date of birth or gender is sent but the account has no Person, it gets `404 {"error":"person_not_found"}`. Every check (invalid field, under 18, 503, 404) runs **before** any trainer profile or gym is saved.
2. **Save after.** Once the registration has succeeded, saving the date of birth or gender never turns it into an error. If that write fails (very rare, because the checks have already passed), the server logs the route and the database error code, never the value. The route then still answers success with its usual body, and the value is not stored. `GET /me/personal-details` then shows `ask: true`, so the app asks again and saves it through `PUT`.

## `POST /trainer/register` (additive body field)

New optional `dateOfBirth`. Everything else is unchanged. **Trainer gender is still the profile's own `gender`**, which stays required as before. It is not stored on the Person.

```json
{ "displayName": "…", "photoUrl": "…", "gender": "female", "dateOfBirth": "1994-03-21", "…": "…" }
```

When the flag is on, `dateOfBirth` is checked **before** anything is saved: `400 invalid_field` / `400 partner_under_18` as above, and no trainer profile is created. If the registration succeeds, the date is saved on the Person. The response (the trainer profile) does not change and never contains the date. If `dateOfBirth` is left out, the request is accepted, unless the stored date of birth (Person, else member profile) is under 18, in which case it gets `400 partner_under_18`.

## `POST /gym-owner/register` (additive body fields)

New optional `dateOfBirth` and `gender` at the top level (next to `gyms`):

```json
{ "displayName": "…", "gyms": [ { "name": "…" } ], "dateOfBirth": "1979-06-30", "gender": null }
```

When the flag is on, they are checked before any gym is created. Errors are the same as for `PUT`, and `gender` uses the same table: `null` or `""` means nothing is stored. Once the registration succeeds, the values are saved on the Person. The response (`{ gyms, gymIds }`) does not change. If either field is left out, the request is accepted.

## Admin, view only

There is no admin write path. The existing admin trainer and owner pages only use list endpoints, and lists and exports must not carry the date of birth, so the detail read is a separate endpoint per page. The portal calls it when it opens a trainer or owner. It is gated by the same ACL scope as the page: super-admins pass, and portal staff need the scope.

### `GET /admin/trainers/:id/personal-details`

ACL scope `trainers`. `:id` is the **trainer profile id** (`trn_…`, as in `DELETE /admin/trainers/:id`).

```json
{
  "trainerId": "trn_1a2b3c4d",
  "userId": "usr_…",
  "personalDetails": { "dateOfBirth": "1994-03-21", "age": 32, "gender": "female", "genderFrom": "trainer_profile", "source": "person" }
}
```

`userId` is `null` for an admin-made profile nobody has claimed yet, and in that case all `personalDetails` fields are null.

### `GET /admin/gym-owners/:id/personal-details`

ACL scope `owners`. `:id` is the **owner user id** (as in `DELETE /admin/gym-owners/:id`).

```json
{
  "ownerId": "usr_…",
  "personalDetails": { "dateOfBirth": "1979-06-30", "age": 47, "gender": null, "genderFrom": null, "source": "person" }
}
```

The member-profile fallback (`source: "member"`) is member data. It is returned only to super-admins and to staff who also hold the **`members`** scope. Anyone else sees only a date of birth the partner declared (`source: "person"`); when there is none, `dateOfBirth`, `age` and `source` are `null`.

`personalDetails` contains:

- `dateOfBirth`
- `source`
- `gender`
- `genderFrom`, with the same meaning as in `GET /me/personal-details`
- `age`: whole years on today's East Africa day, or `null`

Errors:

- `401 unauthenticated`
- `403 forbidden` when the caller is not an admin
- `403 {"error":"acl_forbidden","requiredScope":"trainers"|"owners"}`
- `404 {"error":"not_found"}`: unknown id, or the id is not a gym owner
- `404 {"error":"feature_disabled"}`

Each successful read is audit-logged as `personal_details_viewed`, with the actor set to the admin, the target set to the persona's user id (or the trainer id), and `after: { subject: { type, id } }`. No values are logged.

## Not in this slice

- Shop eligibility for partners (slice 4, `SHOP_PERSONALISATION_PARTNERS`).
- App onboarding step, home card and settings tile (slice 3).
- Privacy text (slice 5, draft pending counsel).
- Under-18 is not checked for admin-created or invited partners, or for identity merges (see above).
