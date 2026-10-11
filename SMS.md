# SMS

Everything FitFlex sends by text message is in this backend. It replaces the
three Supabase edge functions (`send-sms-hook`, `sms-dispatch`, `sms-promo`)
and their shared Beem client, which can be removed once this is deployed and
checked.

| Was (Supabase) | Is (here) |
|---|---|
| `_shared/beem.ts` — Beem client, `sms_logs`, send-once keys | `src/integrations/sms/beem.mjs` (the one Beem call), `src/integrations/sms/provider.mjs` (provider seam), `src/services/sms-service.mjs` (`send`, the `SmsLog` table) |
| `send-sms-hook` — login codes | Verification codes already went through Beem here (`src/infra/verification-senders.mjs`). They now use the shared Beem client and are written, redacted, to `SmsLog`. Their limits are the identity module's (`VERIFY_CODE_*`). |
| `sms-dispatch` — hourly session and renewal reminders | The `smsReminders` job (`functions/jobs.mjs`, hourly) → `smsService.sendDueReminders()` |
| `sms-promo` — a promotion by SMS to members who opted in | SMS is a channel of the Communication Center: a gym or FitFlex campaign (or a gym automation) with `channels: ['sms']`. It gets the audience rules, consent, weekly marketing cap, large-send confirmation, scheduling, retries and history every other channel has. |

## Settings

Credentials come from the environment only.

| Variable | Meaning |
|---|---|
| `SMS_PROVIDER` | `beem`, or unset for off. Reminders and campaigns send nothing until it is set, so a deploy on its own never starts sending. (`fake` is for tests and is ignored in production.) |
| `BEEM_API_KEY`, `BEEM_SECRET_KEY` | The Beem API pair. Shared with verification codes. |
| `BEEM_SENDER_ID` | The sender name members see. `INFO` (Beem's shared name, the default) until Beem approves FitFlex's own. |
| `VERIFICATION_SMS_PROVIDER`, `VERIFICATION_SMS_SENDER_ID` | Verification codes only — unchanged. The sender name falls back to `BEEM_SENDER_ID`. |

## What is sent

- **Reminders** (hourly job, Swahili unless the member chose English):
  - a confirmed trainer session starting within 3 hours;
  - a pass ending in 3 days. A gym membership whose gym has its own expiry
    reminders switched on is left to the gym.
- **Campaigns and automations** that include the `sms` channel. The text is
  `FitFlex: <body>` or `FitFlex x <gym>: <body>`, on one line, cut to two SMS
  parts (306 characters); offers end with how to stop them.
- **Invitations** to people an organisation has listed by mobile number who
  have not joined yet (B2B bulk import): the invitation and one reminder after
  3 days, one SMS part each. `B2B_INVITE_SMS=off` turns these off on their
  own. See `B2B_AUTOMATION.md` §11.
- **Verification codes** (identity).

Each SMS is one row in `SmsLog`: number, kind (`otp`, `reminder`, `campaign`,
`invitation`, `test`), text (codes are stored as "Verification code [redacted]"), status
(`queued`, `accepted`, `failed`) and what the provider answered. A reminder's
`dedupeKey` makes it go out once however often the job runs; one that failed
is tried again by the next runs, three times in all, instead of being lost.

## A member's choices

`CommunicationPreference`, read and changed through the existing preference
routes:

- `smsTransactional` (default on) — reminders and service messages by SMS;
- `smsMarketing` (default off) — offers by SMS. Turning it on records when
  and where the member agreed (`smsMarketingConsentAt`, `…Source`);
- `smsOptedOutAt` — set, it blocks every SMS.

Until the apps show these switches, no member can opt in to offers by SMS,
so marketing campaigns reach no one on this channel.

## Admin routes

`communications` scope.

| Route | Does |
|---|---|
| `GET /admin/sms/status` | Provider, whether it is configured (and which settings are missing — names only), sender name, counts for the last 24 hours. |
| `POST /admin/sms/test` `{ phone }` | Sends one real test SMS. On failure returns what the provider said, e.g. Beem `120` "Invalid Authentication Parameters" for a wrong key or secret. |
| `GET /admin/sms/logs` | The log, newest first, numbers masked. `?status&category&before&limit` |
