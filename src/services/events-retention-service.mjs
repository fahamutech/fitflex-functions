// Marathon & running events · S7 — retention and anonymisation of registration personal data
// (docs/design/events-s7-hardening-and-pilot.md §6.2, D55, D79). RULE 6 AREA (owner reviews, D35): this job REWRITES participant personal data.
//
// It ships UNSET: with EVENTS_RETENTION_MONTHS and EVENTS_DELETED_USER_ANONYMISE_DAYS both unset it does nothing at all (no audit row either) and
// the Health tab shows "Retention not configured". No period is encoded here; the number of months is for counsel and the owner (D55).
//
// What it clears: phone, email, their normalised forms, date of birth, gender, emergency contact and the claim token data. What it KEEPS: first
// name, last initial, bib, category, kit and result data (D55: results stay and a person can hide their name; the board hides a name when the date of
// birth is unknown in a category that allows under-18s). Each registration is cleared once (`anonymisedAt`); a rerun finds nothing to do.
import { randomUUID } from 'node:crypto';

const BATCH = 2000;
const CLEARED = { phone: null, email: null, phoneNormalized: null, emailNormalized: null, dateOfBirth: null, gender: null, emergencyContact: null, claimTokenHash: null, claimTokenExpiresAt: null };

export function createEventsRetentionService({ db, now = () => new Date(), months = () => null, deletedUserDays = () => null }) {
  const stamp = () => new Date(now());
  const monthsAgo = (n) => { const d = stamp(); d.setUTCMonth(d.getUTCMonth() - n); return d; };

  /** Clear one batch of registrations chosen by `pick(q)`; → { rows, events }. */
  async function clearBatches(pick) {
    let rows = 0; const events = new Set();
    for (;;) {
      const ids = (await pick(db('EventRegistration as r').join('Event as e', 'e.id', 'r.eventId').whereNull('r.anonymisedAt').limit(BATCH).select('r.id', 'r.eventId'))).map(r => ({ id: r.id, eventId: r.eventId }));
      if (!ids.length) break;
      const at = stamp();
      const done = await db('EventRegistration').whereIn('id', ids.map(i => i.id)).whereNull('anonymisedAt').update({ ...CLEARED, anonymisedAt: at, updatedAt: at });
      rows += done; ids.forEach(i => events.add(i.eventId));
      if (ids.length < BATCH) break;
    }
    return { rows, events: events.size };
  }

  async function run() {
    const m = months(); const d = deletedUserDays();
    if (m === null && d === null) return { skipped: 'not_configured', rows: 0, events: 0 };
    let rows = 0; let events = 0; const detail = {};
    if (m !== null) {
      const cutoff = monthsAgo(m);
      const r = await clearBatches(q => q.whereIn('e.status', ['completed', 'cancelled', 'archived']).whereRaw('COALESCE(e."cancelledAt", e."endsAt") < ?', [cutoff]));
      rows += r.rows; events += r.events; detail.afterMonths = r.rows;
    }
    if (d !== null) {
      // Places whose purchaser account is gone and that nobody claimed (a deleted participant is erased at deletion time): later of N days and the event end.
      const cutoff = new Date(+stamp() - d * 86_400_000);
      const r = await clearBatches(q => q.whereNull('r.purchaserUserId').whereNull('r.participantUserId').whereIn('r.consentBasis', ['self', 'purchaser_authorised']).where('e.endsAt', '<', cutoff));
      rows += r.rows; events += r.events; detail.deletedUsers = r.rows;
    }
    await db('AuditLog').insert({ id: `aud_${randomUUID().slice(0, 12)}`, at: stamp(), actor: 'system', action: 'events.registration_anonymised', target: 'events', before: null, after: JSON.stringify({ events, rows, ...detail }) });
    return { rows, events, ...detail };
  }

  return { run };
}
