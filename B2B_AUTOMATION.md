# B2B automation and operations (Phase 7)

How the recurring B2B work is run reliably, what happens when it goes wrong,
and how an operator recovers. This is slice 1 of Phase 7: the foundation.

Code: `src/services/ops-service.mjs` (runs, locks, catch-up, exceptions),
`src/services/b2b-jobs.mjs` (the jobs), scheduler entries in
`functions/jobs.mjs`, routes at the end of `functions/b2b.mjs`, migration
`20261125090000-b2b-automation.cjs`, tests `specs/b2b-automation.specs.mjs`.

## 1. What existed, and what was missing

| | Before | Now |
|---|---|---|
| Scheduler | bfast runs a function at a time of day, in the server process | unchanged |
| Run record | `JobRun`, written by three jobs (communications ×2, gym settlement) | every B2B job, with slot, trigger, attempt and item counts |
| One at a time | advisory lock in those three jobs | every B2B job |
| Missed run (server restarting at that minute) | silently skipped until the next day | caught up within about ten minutes |
| Failed run | a line in the server log | recorded, retried up to three times, then left for a person |
| An item a job could not process | a line in the server log | an exception record that clears itself when the item goes through |
| Records that do not add up | a staff page you had to open | checked nightly; each problem is an exception |
| A person stopping a job | not possible | pause and resume, with a reason |

The domain services are unchanged. The jobs call them; no business rule lives
in this layer.

## 2. How a run works

```
scheduler fires ──▶ opsService.runJob(name)
                      │ paused?                     → skipped: paused
                      │ this slot already succeeded? → skipped: already_ran
                      │ take the job's lock          → skipped: running_elsewhere
                      │ write JobRun (running)
                      │ run the job (calls the domain services)
                      ├─ finished → JobRun ok + counts; clear "job did not finish"
                      └─ threw    → JobRun failed + error; raise "job did not finish"
```

- **Slot.** The scheduled instant a run belongs to, e.g. `2026-10-07T21:20Z`
  for a daily job. A slot succeeds once (a unique index backs this up).
- **Lock.** `pg_try_advisory_xact_lock(hashtext('fitflex:job:<name>'))`, held
  for the length of the run. Two servers, or the scheduler and an operator,
  never run the same job together.
- **Idempotency.** This layer reduces repeats; it does not make them safe.
  That is the domain services' job, and they already do it: one invoice per
  organisation, programme and month; one reminder per invoice and stage; one
  payment per reference; one pass per entitlement. Every job here may run
  twice with no harm, which is what makes catch-up and "Run now" safe.
- **Interrupted runs.** A server that stops mid-run leaves a record saying
  `running`. The next run of that job (which holds the lock, so nothing is
  running) marks it failed: "Interrupted: the server stopped during this run."

## 3. Catch-up and retries

Job `opsSweeper`, every 10 minutes. For each daily job, if the current slot has
no successful run and the scheduled time is more than two minutes past:

| Situation | What happens |
|---|---|
| Never ran (server was down) | run now, trigger `catch_up` |
| Failed once | run again after 5 minutes, trigger `retry` |
| Failed twice | run again after 15 minutes |
| Failed three times | stop; the exception becomes "gave up retrying" |
| Paused | nothing |

Jobs that run every few minutes are not caught up; their next tick does that.
There is no retry beyond three attempts per slot, and an operator may retry an
exception at most five times.

A run is not classified as retryable or not: every failure of a whole job is
retried, because a job that fails as a whole has done so on infrastructure
(database, network), not on one record. A bad record is an item failure, which
never fails the job.

## 4. The jobs

Times are East Africa Time.

| Job | When | Does | Domain |
|---|---|---|---|
| `b2b-program-expiry` | 00:05 | marks programmes past their end date expired | operations |
| `b2b-hold-reconciler` | every 5 min | settles benefit holds left behind by a check-in | operations |
| `b2b-sponsor-billing` | 00:20 | starts passes that can start; keeps draft invoices current (passes, usage, platform fees) | finance |
| `b2b-integrity-check` | 01:00 | runs the data-quality checks; one exception per failing check | finance |
| `b2b-collections` | 09:00 | payment reminders | finance |
| `b2b-sponsor-visibility-notice` | 10:00 | tells newly covered people what their sponsor sees | operations |
| `opsSweeper` | every 10 min | catch-up and retries (not itself recorded) | — |

Not run through this layer, and unchanged: member renewals, gym
communications, challenge rewards, KYC reminders, trainer settlement drafts
and gym settlement close. Gym and trainer settlement belong to the settlement
engine and keep their own run records and approvals.

**Drafts only.** The billing job prepares draft invoices. Issuing one, which
sets the VAT rate and gives it a number, is still done by a person, and so is
confirming a payment and approving a settlement. Nothing here approves or pays.

## 5. Exceptions (`OpsException`)

| Type | Raised when | Clears itself when |
|---|---|---|
| `job_failed` | a job did not finish | the job next finishes |
| `job_item_failed` | a job could not handle one item (a programme's invoice, a batch of reminders) | that item next goes through |
| `data_quality` | an integrity check finds something | the check comes back clean |

Fields: type, severity (low, medium, high), status, title, the job and run that
raised it, what it is about (entity type and id, organisation), detail (the
error, counts, examples), occurrences, retry count, first and last seen, and
who closed it with what reason.

The same problem seen again is the same exception: its count and last-seen
time go up. A failed finance job or item is high severity.

```
open ──▶ investigating ──▶ resolved (reason)      ◀── clears itself
  │            │       └──▶ ignored  (reason)
  │            └── retrying ──▶ open (still there) / resolved (went through)
  └──▶ permanently_failed  (three scheduled attempts failed; needs a person)
resolved / ignored ──▶ open (reopened)
```

Closing an exception records a reason and changes nothing in the records it is
about. Exceptions are never deleted.

## 6. Who may do what

| Action | Needs |
|---|---|
| See the operations page, runs and exceptions | `b2b`, or any billing scope |
| Run a job now, pause, resume | `b2b` |
| Mark as being looked at, resolve, ignore, reopen, retry | `b2b` |
| …for a finance exception (billing, collections, integrity) | `b2b` **and** `b2b_billing_approve` |

Organisation users have no access. Manual actions are in the audit log
(`ops.job.run`, `ops.job.pause`, `ops.job.resume`, `ops.exception.*`) under the
operator's id. Automated work is recorded as `system:<job-name>`, with the run
id on the run record and on any exception it raised.

## 7. API

- `GET  /admin/b2b/ops` — jobs, exception counts, work waiting on a person
- `GET  /admin/b2b/ops/jobs/:job/runs`
- `POST /admin/b2b/ops/jobs/:job/run` → `{ outcome: ok | failed, failure, processed, succeeded, failed }` or `{ skipped }`
- `POST /admin/b2b/ops/jobs/:job/pause` `{ paused, reason }`
- `GET  /admin/b2b/ops/exceptions?status=live|all|…&severity=&type=&job=&organizationId=`
- `POST /admin/b2b/ops/exceptions/:id/status` `{ status, resolution }`
- `POST /admin/b2b/ops/exceptions/:id/retry`

## 8. Runbook

**A job shows Failed or Retrying.** Open its History. The error is on the run.
It is retried automatically at 5 and 15 minutes. If the cause is fixed sooner,
"Run now". Once a run finishes, the exception clears itself.

**A job shows Delayed.** Its scheduled time passed with no run. The sweeper
will run it within ten minutes. If it stays delayed, the sweeper itself is not
running: check the server is up, then "Run now".

**A job shows Running for more than half an hour.** The server probably
stopped mid-run. "Run now": if the old run is dead the new one takes the lock
and marks the old one interrupted. If it answers "already running", it really
is; wait.

**An exception says "gave up retrying".** Three attempts failed. Fix the
cause, then "Retry" on the exception (or "Run now" on the job). Do not resolve
it by hand unless the work was done another way; say how.

**"Could not prepare the invoice for…".** One programme's draft failed; the
rest were prepared. The detail has the programme, month and error. After
fixing the cause, "Retry": the job prepares only what is missing and never a
second invoice for the same month.

**A "records do not add up" exception.** The detail has a count and example
ids. Nothing was changed. Investigate from B2B insights → records that need a
second look, correct the records through the normal screens (a reversal, a
credit note, a payment reversal), and the exception clears on the next nightly
check, or run the integrity check now.

**Reminders or notices could not be sent.** Usually the email sender. The
in-app message is separate and normally still went. Fix the sender; the next
run sends what is still owed. A reminder stage is sent once, so nothing is
sent twice.

**Stopping a job.** "Pause" with a reason. It is skipped by the schedule and
by catch-up until resumed. It can still be run by hand.

## 9. Data kept

`JobRun` and `OpsException` rows are kept indefinitely; nothing is deleted.
The every-5-minutes reconciler keeps a run only when it did something or
failed, so the table grows by about six rows a day. No retention period has
been set; that is a business decision.

## 10. Known limitations (slice 1)

- **Staff are not notified** of a new exception. They see it on the
  operations page. (The app's inbox reaches members, not portal staff.)
- **First deploy.** The current slot of each daily job has no recorded run, so
  the sweeper runs each once as a catch-up. That is harmless.
- **The scheduler is still in-process.** If the server is down for a whole
  day, that day's slot is not run later; the next day's is.
- **Only B2B jobs** go through this layer. The other jobs are unchanged.
- **Not yet built (later slices):** bulk beneficiary import and invitations;
  benefit and programme lifecycle notices and renewal drafts; alerts when
  drafts sit unissued; exceptions for the provider side of reconciliation.
