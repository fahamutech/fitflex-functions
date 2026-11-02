# Events S7: follow-ups (Lows left after the fix round on functions#306)

Logged by the backend builder; none blocks the flags-off merge. Each is small, known and safe to leave until the pilot.

1. **Alert A10 window.** "5xx above 20 in 15 minutes for one group" is evaluated on the daily `api_error` counter (more than 20 in the Dar day). A 15 minute window needs a finer store (hourly counters) or an in-process sliding window per server.
2. **Missing S7 counters.** `medal_awarded`, `reward_earned`, `reward_redeemed`, `reward_duplicate_blocked` and `run_saved` are allowlisted but not emitted: the emit points are in S6 award and run code (rule 6 areas) and were left untouched.
3. **In-memory rate limits.** Waitlist join, sync, heartbeat, snapshot and analytics limits are per server instance, like the rest of the events module. With N servers the real allowance is up to N times the figure.
4. **Sync has no whole-response replay.** Exactly-once is per item through `(deviceId, clientRef)`; the batch response is rebuilt on a retry (items come back with `replayed: true`).
5. **Review list cursor is unsigned.** It is a plain `(receivedAt, id)` keyset on an owner/admin-only, same-event list; it is validated (finite, not in the future) but not signed.
6. **Waitlist `contactKey` falls back to the user id** when a participant has neither a phone nor an email. The participant checks normally refuse that, so it is only a defensive default.
7. **Offline sync notices.** `event_kit_collected` is sent per accepted item after the batch, so a 200-item batch sends up to 200 pushes. Revisit if the pilot shows a push storm.
8. **Admin pause and the lifecycle job.** After a pause, `event-lifecycle` still moves `registration_closed` to `in_progress` at the start time as before; a pause does not move the event.
9. **Offline scan rows** are removed only by the keep-days purge (180 days); there is no per-event "forget" action.
10. **Retention covers registration rows only.** Payment requests, order references and result names are out of its scope (D55 keeps results).
11. **Expired desks send to review.** Because the server judges by receipt time, every scan a desk sends after its 36 h life goes to a person (`after_expiry`). If pilots show many honest late syncs, consider a short grace window after `expiresAt` (a product decision, not a security one).
