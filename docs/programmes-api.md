# Programmes API (P1, slice B1: authoring)

Spec: parent repo `docs/specs/programmes-nutrition.md` §4. Plan: parent repo `docs/plans/programmes-p1-plan.md` (slice B1, decisions PD-1..PD-11).

Members can't see programmes yet. The member routes (catalogue, starting a programme) are slice B2 and answer `404 feature_disabled` while `PROGRAMMES_CATALOGUE` is off. The admin routes below work while it is off, so programmes can be prepared before launch.

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

## Tables (migration `20270218090000-programmes`)

- **`Programme`.**
- **`TrainingPlan.programmeId`** and **`TrainingPlan.lengthDays`**.
- **`ProgrammeDayCompletion`:**
  - used from slice B3, when a check-in completes a gym day;
  - at most one live row per plan day, with `reversedAt` set on a void.
- **`TrainingExercise.clipUrl`** and **`TrainingExercise.stillUrl`**.

All of these are additive, and the migration can be reversed.

## Draft starter programmes

`docs/programmes-starter-drafts.json` holds three draft programmes for a partner trainer to review (PD-10). They are not live and nothing loads them. Their Swahili values are `[SW]` placeholders. A spec checks that each one would save and publish.
