# B2B automation and operations (Phase 7)

How the recurring B2B work is run reliably, what happens when it goes wrong,
and how an operator recovers. Slice 1 is the foundation (§1–§10); slice 2
adds bulk import and invitations (§11); slice 3 adds lifecycle notices and
programme renewal (§12).

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
| `b2b-lifecycle-notices` | 08:00 | benefit starting, ending and ended notices to members; programme ending and ended notices to organisations | operations |
| `b2b-allowance-notices` | every 10 min | allowance nearly used and used up notices to members | operations |
| `b2b-beneficiary-invites` | every 10 min | enrols invited people who have joined; sends invitation emails that are due | operations |
| `b2b-billing-watch` | 07:30 | raises an exception for billing work left too long (§13) | finance |
| `ops-alerts` | every 10 min | emails staff about new high-severity exceptions (§13) | operations |
| `ops-daily-summary` | 08:30 | emails staff a summary of what is still waiting (§13) | operations |
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
- **Not yet built (later slices):** benefit and programme lifecycle notices and renewal drafts; alerts when
  drafts sit unissued; exceptions for the provider side of reconciliation.

## 11. Bulk import and invitations (slice 2)

Code: `src/services/b2b-beneficiary-import-service.mjs`, routes in
`functions/b2b.mjs`, migration `20261202090000-b2b-beneficiary-invites.cjs`,
tests `specs/b2b-beneficiary-import.specs.mjs`.

**Decision (P7-03, product owner, 8 Oct 2026):** invitations go by email and
by SMS. Someone listed with an email address gets the email; someone listed
with a mobile number gets the SMS; someone listed with both gets both.
WhatsApp is not sent: there is no WhatsApp Business account, provider or
approved template yet (see `src/integrations/whatsapp/provider.mjs`).

### Import

`POST /b2b/organizations/:id/beneficiaries/import` with `rawText` (CSV) or
`rows`. Up to 2,000 people. `dryRun: true` checks without changing anything.

| A row for… | Becomes |
|---|---|
| someone with a member account (matched by email, else mobile number) | enrolled now, through the same service a single "add person" uses |
| someone already on the list, or already invited | left as is (an invite's name, group and reference are updated) |
| someone who has not joined FitFlex | an invite (`B2BBeneficiaryInvite`) |
| no email or number, a bad email or number, an unknown type, the same person twice in the file | rejected, with the line and the reason |

Each import is recorded (`B2BBeneficiaryImport`: counts and rejected rows) and
audited. Uploading the same list twice, or two uploads at once, adds nobody
twice (unique indexes on a live invite's email and number per organisation).
A company managed under Corporate is refused here and keeps
`/corporate/staff/bulk`.

### Joining

An invite waits for a **member** account with its email or number. Matching
runs every 10 minutes, and at once when a member opens their benefits. The
person is enrolled as active with the group, reference and type the
organisation listed, the invite is closed, and they get one in-app message.
Enrolment goes through `b2bService.enrollBeneficiary`, so "already on the
list" closes the invite without a second row. A cancelled invite enrols nobody.

Matching trusts the email or number on the account, exactly as adding a
person by email or number already does.

### Messages

| Channel | Invitation | Reminders | Most per invite ("send again" included) |
|---|---|---|---|
| Email | within 10 minutes of the import | 3 and 10 days after | 6 |
| SMS | within 10 minutes of the import | 3 days after | 3 |

Then no more. None after the person joins or the invite is cancelled. Each
message is claimed before it is sent, so overlapping runs send one. Three
failures in a row stop that channel for that invite. "Send again" starts it
over, not within an hour of the last message of that kind.

**Email** says who added the person, to sign up as a member with that
address, a link to the app when `FITFLEX_APP_LINK` is set (none is invented),
and what the organisation will be able to see of their activity. English only.

**SMS** is one segment (160 plain characters): who added them and to join as a
member with that number, with the app link when it fits. It has no room for
the visibility statement; the person gets that in the app once they join.
SMS goes through the shared SMS service (`SMS.md`): it is sent only when
`SMS_PROVIDER` is set, is written to `SmsLog` as kind `invitation`, and
**each SMS is paid for**. `B2B_INVITE_SMS=off` turns invitation SMS off
without touching reminders, campaigns or sign-in codes.

With no email sender configured, invites still work (people are enrolled when
they join); the emails wait, the People page says so, and the job raises one
low-severity exception until a sender is set up. With SMS switched off or not
set up, no SMS is sent and nothing is raised: that is a choice, not a fault.

### Permissions

Import, cancel and send again need `beneficiaries.manage` (owner, admin,
manager, hr). Seeing invites and past imports needs `beneficiaries.read`.
An invite belongs to one organisation; another organisation cannot see or
change it. The same person invited by two organisations is enrolled in both.

### Runbook

**"N invitation email(s) are waiting: the email sender is not set up."** Set
`VERIFICATION_EMAIL_PROVIDER=mailgun` with its key and domain. The next run
sends what is waiting and the exception clears.

**"N invitation SMS were not accepted."** Beem refused them (a wrong number,
no credit on the account, or the sender name not approved for this kind of
message). Each is retried hourly, three times. Check the Beem account.

**"N invitation email(s) were not accepted."** The provider refused them
(often a mistyped address). Each is retried hourly, three times. The
organisation sees "Email not delivered" on the invite and can correct the
address by cancelling and re-adding the person.

**"N invited people could not be enrolled after joining."** Enrolment was
refused for a reason in the detail (for example the organisation is no longer
active). Nothing is lost: the invite stays and is tried again every run.

### Limitations

- No WhatsApp (no account or approved template). SMS is sent to the number the
  organisation supplied; whether that needs the person's prior consent under
  Tanzanian rules is a question for counsel.
- An account whose email was saved in mixed case before emails were
  normalised is matched when its owner opens Benefits, not by the 10-minute run.
- Invited people are not counted in analytics until they join.
- The invitation email has no Swahili version.

## 12. Lifecycle notices and programme renewal (slice 3)

Code: `src/services/b2b-lifecycle-service.mjs`, migration
`20261207090000-b2b-program-renewal.cjs`, tests `specs/b2b-lifecycle.specs.mjs`.

### Notices

When each goes out is set in one place (`NOTICE` in the service). There is no
per-organisation setting.

| To | Notice | When |
|---|---|---|
| Member | a benefit starts | the day before it starts |
| Member | a benefit is ending | once, from 7 days before its end |
| Member | a benefit has ended | the day after (up to 3 days after, if the job was not running) |
| Member | allowance running low | on reaching 80% of a limit |
| Member | allowance used | on reaching the limit |
| Organisation | a programme is ending | once within 30 days of its end, once within 7 |
| Organisation | a programme has ended | the day after (up to 3 days after) |

- **Members** are told in the app (inbox and push), not by SMS or email.
  Only people who are active, linked to an account and covered by that
  benefit's rules. Benefits ending or starting on the same day are one notice.
- **Organisations** are told in the app (owners, admins and managers) and at
  the organisation's contact email when the email sender is configured.
- Every notice has an id built from what it is about (programme, date,
  person; or benefit, person, allowance window), so it is written once however
  often the job runs. A missed day is made up by the next run. Old news is not
  announced: an end more than 3 days past says nothing.
- An allowance notice is sent once per window, so a monthly allowance can
  produce one "running low" and one "used" each month. A limit of 1 or 2 goes
  straight to "used".
- Nothing here decides eligibility, usage or expiry. It reads the programme
  and consumption services.

### Renewal

`POST /b2b/organizations/:id/programs/:programId/renewal` (`programs.manage`)
prepares a **draft** programme for the period that follows:

- **Dates.** Whole calendar months stay whole calendar months (a calendar
  year is followed by the next calendar year); otherwise the same number of
  days. A benefit with dates of its own is moved by the same amount.
- **Copied.** Name, description, type, who it covers, budget, and every
  benefit that is not archived, as drafts. A benefit that can no longer be set
  up (its gym has left, say) is left out and named in `skipped`.
- **Not copied.** A price concession FitFlex gave (`discountBps`), unless
  FitFlex staff prepare the renewal. An organisation cannot renew its own
  discount.
- **Once.** A programme has one live renewal: asking again returns it (an
  advisory lock and a unique index). Cancel the draft to prepare another.
- **Nothing happens by itself.** No renewal is created automatically, and a
  draft changes nothing: nobody is covered and nothing is billed until it is
  submitted and FitFlex activates it, exactly like a new programme. No
  commercial agreement is renewed or extended.

`GET /b2b/organizations/:id/program-lifecycle` gives each programme's days
left, whether it is ending soon, whether it can be renewed, and its renewal.
The operations page counts renewal drafts waiting for FitFlex to review.

### Runbook

**"N benefit notice(s) could not be sent."** The inbox write failed for some
people. The next run sends what is missing; nothing is sent twice.

**An organisation says it was not told its programme was ending.** Check it
has an active owner, admin or manager, and a contact email. The notice ids
start `b2bn_prog_`; emails that went are in the audit log as
`b2b.program.notice_emailed`.

**A renewal draft is waiting.** Open the organisation's programmes, check
the dates, benefits and price, then submit and activate it like any programme.

### Limitations

- Notice timings are fixed in code, not configurable per organisation.
- Member notices are English only.
- A paused programme sends no "ending" notices.
- Nothing tells beneficiaries when their organisation is suspended; there is
  no policy for that yet.
- There is no automatic renewal, by design.

## 13. Billing watch, provider checks and staff alerts (slice 4)

Three things the earlier slices left to a person looking at the operations
page: noticing that billing work has been left too long, checking that the
provider side agrees with what sponsors were charged, and finding out that
something went wrong without opening the page.

Code: `src/services/b2b-watch-service.mjs`. Nothing in it changes a record,
approves anything or decides a policy.

### Billing watch (`b2b-billing-watch`, daily 07:30 EAT, finance)

One exception (type `billing_watch`) per organisation and kind. It is raised
again each day it still applies (the count of occurrences goes up; no
duplicate), and it resolves itself on the first run where the work is done.

| Kind | Raised when | Severity |
|---|---|---|
| `drafts_not_issued` | a non-zero draft invoice is more than 7 days old | medium |
| `payment_notices_unchecked` | a payment notice has waited more than 3 days | high |
| `long_overdue` | an issued invoice is more than 30 days past due | high |
| `payment_not_applied` | money received more than 3 days ago is not fully applied while the organisation has open invoices | medium |
| `agreement_ending` | the active agreement ends within 30 days and none follows it | medium |
| `long_on_hold` | an organisation has been on hold more than 30 days | low |

These day counts (`WATCH` in the service) say when something deserves a
person's attention. They are not credit control: nothing is put on hold,
charged, released or cancelled. What to do stays with staff.

### Provider checks (part of `b2b-integrity-check`)

The provider side of the chain, read only:

| Check | Meaning | Severity |
|---|---|---|
| `gym_usage_missing_from_settlement` | an approved sponsored gym visit falls in a month with a locked live settlement run, and no live settlement visit exists for it | medium |
| `settled_visit_without_usage` | a sponsored visit settled as payable or held has no approved usage behind it (reversed or cancelled since) | high |
| `trainer_usage_missing_from_settlement` | an approved sponsored trainer session, completed more than 14 days ago, is on no trainer statement line | medium |

They are raised and cleared as `dq:<check>` exceptions like the other
integrity checks. The settlement tables are only read; a correction is made in
the settlement tools by the people who own settlement.

Only locked **live** runs count as settled. While gym settlement runs in
shadow mode the two gym checks have nothing to compare against and stay at
zero. Sponsored passes are not checked: a pass nobody used may rightly have
nothing settled.

### Staff alerts

| Job | When | What |
|---|---|---|
| `ops-alerts` | every 10 minutes | one email listing exceptions that are high severity, or where retrying was given up, and that have not been announced before |
| `ops-daily-summary` | daily 08:30 EAT | one email listing everything still waiting, most severe first, with the counts of work waiting. Not sent when nothing is waiting |

Settings (server environment):

- `OPS_ALERT_EMAILS` — comma-separated addresses. **Unset by default: nobody
  is emailed**, and the operations page says so. No address is assumed.
- `OPS_PORTAL_LINK` — optional link to the operations page for the email.
- The email sender is the platform's existing one (`VERIFICATION_EMAIL_PROVIDER`).

An exception is marked announced (`OpsException.alertedAt`) only once at least
one address accepted the email, so alerts raised before the addresses are set
go out when they are. Emails carry the exception titles only: organisation
names, counts and amounts; no personal details of beneficiaries.

### Runbook

**"Payment notices unchecked".** Open B2B billing → Collections for the
organisation, compare each notice with the bank or mobile-money statement, and
confirm or reject it. The exception clears on the next morning's run (or use
*Run now* on Billing watch).

**"Draft invoices not issued".** Open B2B billing, review the drafts and issue
or void them.

**"More than 30 days overdue".** Information only. Whether to put the
organisation on hold, agree a plan or wait is a commercial decision.

**"Received but not applied".** Open the organisation's payments and apply the
remaining amount to its open invoices.

**"Agreement ends with nothing to follow it".** Agree new terms and put a new
agreement in force, or leave it: FitFlex's standard terms then apply.

**A provider check found something.** Do not edit settlement rows. Give the
example ids in the exception to whoever runs settlement; a missed visit is
normally picked up by a correction or the next run, and a settled visit whose
usage was reversed by a clawback.

**No alert emails arrive.** The operations page shows why: no addresses, or
the email sender not set up. Then check the last run of *Staff alerts* in its
history (`skipped` says `no_recipients`, `email_not_configured` or
`not_accepted`).

### Limitations

- Alerts are email only; no SMS, push or chat alerts.
- One list of addresses for everything; no routing by type or severity.
- The watch thresholds are fixed in code.
- Vendor (marketplace) settlement is not cross-checked: sponsors do not fund
  marketplace purchases.
