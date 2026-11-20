# Programmes API (P1: authoring B1, members B2)

Spec: parent repo `docs/specs/programmes-nutrition.md` §4. Plan: parent repo `docs/plans/programmes-p1-plan.md` (slice B1, decisions PD-1..PD-11).

The member routes answer `404 feature_disabled` while `PROGRAMMES_CATALOGUE` is off. That check runs before the sign-in check. The admin routes work while the flag is off, so programmes can be prepared before launch.

## Member routes (slice B2)

All need the flag and then `requireAuth('member')`. Any signed-in member can see and start free programmes (PD-2).

| Route | What it does |
|---|---|
| `GET /programmes` | Live programmes, newest first, without their days.<br>Filters: `goal`, `level`, `environment` (a programme for `any` place matches every place), `minDays`, `maxDays`, and `lang` (`en`\|`sw`).<br>Each item has `dayCounts { gym, home, rest }`, `dayTypes[]` and `free: true`.<br>A bad filter answers 400 `invalid_filter` + `field` |
| `GET /programmes/:id` | One live programme with `days[]`: `{ day, type, workout: { name, activityType, estimatedDuration, exerciseCount } \| null }`.<br>A draft, retired or missing programme answers 404 |
| `POST /programmes/:id/enrol` | Body: `{ startDate?, replace?, lang? }`. Answers 201 `{ plan }`.<br>Errors:<br>• 409 `active_plan_exists` + `planId` (send `replace: true`)<br>• 409 `already_on_programme` + `planId`<br>• 409 `programme_unavailable` (a draft or retired programme)<br>• 404 `not_found`<br>• 400 `invalid_start_date`, `start_in_past` or `start_too_far` (start must be today to today + 30) |

### The member's programme plan

Starting a programme creates an ordinary `TrainingPlan` with `programmeId`, `lengthDays` and `engine: 'programme'`.
- **Plan name:** the programme title, in Swahili when `lang=sw`.
- **Workouts:** home days and gym days with a suggested workout become planned `Workout` rows, `source: 'programme'`.
- **Replacing a plan:** this ends the member's current plan. Its unstarted workouts are removed; finished ones stay in history. This is the same as the existing plan rules (PD-1).

`GET /me/training-plans/current` and `/me/training-plans/:id` return the plan with extra programme fields. These are additive; other plans are unchanged.
- **Every day is listed**, `weeks[].days[]`, as `{ day (weekday, 1 = Monday), programmeDay, date, type, name, workoutId, status, completedBy }`.
- **`status`** is `rest`, `planned`, `in_progress`, `completed`, `skipped` or `removed`.
- **A gym day** is `completed` when its suggested workout is completed, or when a live `ProgrammeDayCompletion` exists for that date (check-in, slice B3). The check-in wins, and `completedBy` is then `{ source: 'checkin', checkinId, completedAt }`. Otherwise `completedBy` is `{ source: 'workout', workoutId }`.
- **`progress`** adds `currentDay`, `lengthDays`, `byWorkout`, `byCheckin`, `streak` and `bestStreak`.
  - The streak counts training days done in a row.
  - Rest days don't break it, and today doesn't break it while today is still open. A past training day that wasn't done resets it.
- **`today`** is today's day whatever its type, including a rest day. `next` is the next open training day.
- **`GET /me/training-plans`:** for a programme, `sessions` doesn't count rest days.

## Admin routes

All need `requireAuth('admin')` and the `exercises` scope (PD-7, the same scope as the exercise library). Errors are `{ error, field?, reason? }`.

| Route | What it does |
|---|---|
| `GET /admin/programmes` | `{ programmes: [...each with enrolled], catalogueOn }`, newest change first |
| `GET /admin/programmes/:id` | `{ programme, catalogueOn }`, or 404 `not_found` |
| `POST /admin/programmes` | Creates a draft. 201 `{ programme }`; 400 `invalid_programme` + `field` (and `reason` for a bad workout) |
| `PUT /admin/programmes/:id` | Changes a draft; the fields not sent are kept. 409 `not_a_draft` for a live or retired programme |
| `POST /admin/programmes/:id/publish` | Moves a draft to `live`. 400 `not_ready_to_publish` + `field`. Publishing a new version retires the live one it came from |
| `POST /admin/programmes/:id/retire` | Moves a live programme to `retired` (no new starts). 409 `not_live` |
| `POST /admin/programmes/:id/duplicate` | 201 `{ programme }`: a new draft with `versionOf` set. This is the only way to change a live programme |

Each change writes an AuditLog row: `programme_created`, `_updated`, `_published`, `_retired` or `_duplicated`. The before/after summary holds the title, status, vocabulary, length and day types.

## Programme

| Field | Notes |
|---|---|
| `id` | `prg_…` |
| `title`, `summary` | English; at most 80 and 400 characters |
| `i18n.sw.title`, `i18n.sw.summary` | Swahili, entered by staff and marked for native review. Both are required to publish |
| `goal` | `FITNESS_GOAL_IDS` |
| `level` | `EXPERIENCE_LEVELS` |
| `environment` | `ENVIRONMENTS` (`gym`, `home`, `outdoor`, `any`) |
| `equipment[]` | `EQUIPMENT` |
| `lengthDays` | 7–84 (a database check) |
| `days[]` | Exactly `lengthDays` entries, `{ day, type: gym\|home\|rest, workout? }`. Days not sent are rest days. Changing the length drops days or adds rest days |
| `status` | `draft` → `live` → `retired` (a database check) |
| `versionOf` | The programme a draft was copied from |
| `enrolled` | Members' training plans with this `programmeId` (B2 creates them) |

A `workout` is a workout definition, as checked by `validateWorkoutDefinition`: `name`, `activityType`, `estimatedDuration`, and `exercises[]` with `exerciseName`, `libraryId`, `sets`, and `reps` or `duration`.

Rules:
- A rest day never keeps a workout.
- A gym day's workout is an optional suggestion (PD-3).
- Publishing needs:
  - a summary;
  - the Swahili title and summary;
  - at least one gym or home day;
  - a workout on every home day;
  - every `libraryId` to be a live library exercise.

## Exercise clip and still (FR-P05)

`clipUrl` and `stillUrl` are new optional fields on exercises.
- **Set by:** `PUT /admin/exercises/:id` (or create).
- **Returned by:** `/training/exercises` and `/admin/exercises`.
- **Allowed values:** https only, no credentials in the link, at most 500 characters. Sending `""` clears the field.
- **Hosting and licence:** both still open (PD-4), so any https host is accepted for now.
- **CSV:** the export and import don't carry these two columns yet. An import leaves them as they are.

## Check-ins complete gym days (slice B3)

No new endpoint. A recorded visit marks the gym day of the member's active programme done, and the plan answers (`GET /training/plans/current` and the plan list) show it as `completedBy: { source: 'checkin', checkinId, completedAt }`.

- **Which visits:** gym QR, staff scan, web check-in and sponsor-funded visits (`onCheckin` in `checkInService`), and visits the owner records by hand (PD-6; a new `onManualVisit` hook in `memberManagement.checkInMember`).
- **Which days:** only a `gym` day of an active programme plan, on the visit's East Africa business day. A visit on a home or rest day, or outside the programme, is not counted (PD-5).
- **Same day twice:** one completion, for the first visit.
- **Void:** voiding the visit reopens the day (`reversedAt`, `reversedReason`). If another visit that day still stands, the day stays done and points at that visit instead.
- **Safety:** the reaction never throws and runs after the visit is saved, so it cannot fail or hold up a check-in or a void.
- **Flag:** does nothing while `PROGRAMMES_CATALOGUE` is off, including on a void.

## Tables (migration `20270218090000-programmes`)

- **`Programme`.**
- **`TrainingPlan.programmeId`** and **`TrainingPlan.lengthDays`**.
- **`ProgrammeDayCompletion`:**
  - written from slice B3, when a check-in completes a gym day;
  - at most one live row per plan day, with `reversedAt` set on a void.
- **`TrainingExercise.clipUrl`** and **`TrainingExercise.stillUrl`**.

All of these are additive, and the migration can be reversed.

## Draft starter programmes

`docs/programmes-starter-drafts.json` holds three draft programmes for a partner trainer to review (PD-10). They are not live and nothing loads them. Their Swahili values are `[SW]` placeholders. A spec checks that each one would save and publish.
