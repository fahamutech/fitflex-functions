// Programmes P1, slice B3: a check-in completes the gym day of the member's
// programme. One ProgrammeDayCompletion row per plan day (the database keeps
// one live row per (planId, date)).
//
//   recordCheckin  — after any recorded visit (QR, web, B2B-funded, owner by hand).
//                    Only a gym day of an active programme plan counts (PD-5, PD-6).
//   reverseCheckin — after a visit is voided. If another visit that day still
//                    stands, the day stays done and points at that visit;
//                    otherwise the day is reopened (reversedAt).
//
// Both are reactions: they never throw, so a check-in or a void is never
// failed or held up by a programme. While PROGRAMMES_CATALOGUE is off they do nothing.
import { randomUUID } from 'node:crypto';
import { localDay } from '../../shared/member-progress.mjs';
import { CHECKIN_STATUS, currentStatus } from '../../shared/checkin-status.mjs';

const isLiveUniqueClash = err => err?.code === '23505'
  && /ProgrammeDayCompletion_live_day/.test(`${err.constraint || ''} ${err.message || ''}`);

export function createProgrammeCheckinService({
  plans, dayCompletions, checkins, enabled = () => false, now = () => new Date(), logger = console,
}) {
  const dayOf = checkin => checkin.businessDate || localDay(checkin.timestamp);

  /** The member's active programme plans (normally one; starting a programme ends the last). */
  async function programmePlansOf(memberId) {
    return (await plans.filterByColumnAsync('userId', memberId))
      .filter(p => p.status === 'active' && p.programmeId);
  }

  const planDayOn = (plan, date) => (plan.weeks || []).flatMap(w => w.days || []).find(d => d.date === date) ?? null;

  async function liveCompletion(planId, date) {
    return (await dayCompletions.filterByColumnAsync('planId', planId)).find(c => c.date === date && !c.reversedAt) ?? null;
  }

  async function record(checkin) {
    if (!enabled()) return { skipped: 'disabled' };
    if (!checkin?.memberId || currentStatus(checkin) === CHECKIN_STATUS.VOIDED) return { skipped: 'not_a_visit' };
    const date = dayOf(checkin);
    const results = [];
    for (const plan of await programmePlansOf(checkin.memberId)) {
      const day = planDayOn(plan, date);
      // PD-5: a visit on a home or rest day (or outside the programme) is not counted.
      if (!day || day.type !== 'gym') { results.push({ planId: plan.id, skipped: day ? 'not_a_gym_day' : 'not_in_programme' }); continue; }
      if (await liveCompletion(plan.id, date)) { results.push({ planId: plan.id, skipped: 'already_done' }); continue; }
      const row = {
        id: randomUUID(), planId: plan.id, userId: checkin.memberId, date, source: 'checkin',
        checkinId: checkin.id ?? null, completedAt: checkin.timestamp || now().toISOString(),
        reversedAt: null, reversedReason: null, createdAt: now().toISOString(),
      };
      try {
        await dayCompletions.insertAsync(row);
        results.push({ planId: plan.id, completed: row.id });
      } catch (err) {
        // A second visit that day, recorded at the same moment: one completion.
        if (!isLiveUniqueClash(err)) throw err;
        results.push({ planId: plan.id, skipped: 'already_done' });
      }
    }
    return { date, results };
  }

  async function reverse(checkin, reason) {
    if (!enabled()) return { skipped: 'disabled' };
    if (!checkin?.id) return { skipped: 'not_a_visit' };
    const rows = (await dayCompletions.filterByColumnAsync('checkinId', checkin.id)).filter(c => !c.reversedAt);
    const results = [];
    for (const row of rows) {
      // Another visit that same day that still stands keeps the day done.
      const other = (await checkins.filterByColumnAsync('memberId', row.userId))
        .filter(c => c.id !== checkin.id && currentStatus(c) !== CHECKIN_STATUS.VOIDED && dayOf(c) === row.date)
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))[0];
      if (other) {
        await dayCompletions.updateByIdAsync(row.id, { checkinId: other.id, completedAt: other.timestamp });
        results.push({ id: row.id, movedTo: other.id });
        continue;
      }
      const text = `check-in voided${reason ? `: ${reason}` : ''}`.slice(0, 500);
      await dayCompletions.updateByIdAsync(row.id, { reversedAt: now().toISOString(), reversedReason: text });
      results.push({ id: row.id, reversed: true });
    }
    return { results };
  }

  // The never-throwing reactions the check-in paths call.
  async function recordCheckin(checkin) {
    try { return await record(checkin); } catch (err) {
      logger.warn?.('[programmes] could not mark the gym day done for a check-in:', err?.message);
      return { error: 'failed' };
    }
  }
  async function reverseCheckin(checkin, reason) {
    try { return await reverse(checkin, reason); } catch (err) {
      logger.warn?.('[programmes] could not reopen the gym day of a voided check-in:', err?.message);
      return { error: 'failed' };
    }
  }

  return { recordCheckin, reverseCheckin };
}
