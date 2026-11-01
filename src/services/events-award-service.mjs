// Marathon & running events · S6 — the award engine (spec §7.2, §7.3, §7.5; D47). The ONLY writer of medals, achievements and earned
// rewards. Request handlers enqueue EventAwardTask rows; the job event-awards-run takes a batch with FOR UPDATE SKIP LOCKED, so two
// workers never evaluate one task twice and a re-run is a no-op (unique keys: one award per (registration, template), one achievement
// per awardKey, one ledger entry per idempotency key).
//
// For one registration, under its row lock, the engine decides from the CURRENT result:
//   base  = confirmed place, event not cancelled, the category has an OFFICIAL release, the result is verified or corrected, finished,
//           not over the cut-off. No result, an unsettled result, a disqualification or a purchase alone earns nothing.
//   medal = base + the template's rule (finish | placing | time_under). An award flips awarded <-> revoked on the SAME row.
//   achievements and event-finish / medal / achievement rewards follow, only for a CLAIMED place (they need a person); an unclaimed
//   place gets medals only and the claim (seen by the reconcile job) queues the rest.
// Cancellation and refunds are read by the reconcile job, so no payment code is touched.
import { randomUUID } from 'node:crypto';
import { categoryStage, medalQualifies, SETTLED_VERIFICATIONS } from '../shared/events-results-rules.mjs';
import { enqueueAwardTask, enqueueAwardTasks } from '../shared/events-award-queue.mjs';
import { COPY } from '../shared/events-results-copy.mjs';

const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const num = v => (v === null || v === undefined ? null : Number(v));
const MAX_ATTEMPTS = 5;
const sw = t => t?.sw || t?.en || '';

export function createEventsAwardService({ db, results, medals, rewards, notice = async () => {}, now = () => new Date(), batch = () => 200 }) {
  const stamp = () => new Date(now());
  const { audit } = results.internals;

  const revokeReason = ({ reg, event, row }) => (event.status === 'cancelled' ? 'event_cancelled'
    : reg.status !== 'confirmed' ? 'registration_cancelled' : row?.verificationStatus === 'disqualified' ? 'disqualified' : 'result_corrected');

  /** One registration, one transaction. → the notices to send after commit. */
  async function evaluateIn(trx, registrationId) {
    const reg = plain(await trx('EventRegistration').where({ id: registrationId }).forUpdate().first());
    if (!reg) return [];
    const event = plain(await trx('Event').where({ id: reg.eventId }).first());
    const releases = (await trx('EventResultRelease').where({ eventId: event.id }).orderBy('seq')).map(plain);
    const row = plain(await trx('EventResult').where({ registrationId: reg.id, isCurrent: true }).first());
    const at = stamp();
    const base = reg.status === 'confirmed' && event.status !== 'cancelled' && Boolean(row) && categoryStage(releases, reg.categoryId) === 'official'
      && SETTLED_VERIFICATIONS.includes(row.verificationStatus) && row.finishStatus === 'finished' && row.withinCutoff !== false;
    const tell = [];
    const userId = reg.participantUserId;

    // ── medals ──
    const templates = (await trx('EventMedalTemplate').where({ eventId: event.id }).where(function scope() { this.whereNull('categoryId').orWhere('categoryId', reg.categoryId); })).map(plain);
    const awards = new Map((await trx('EventMedalAward').where({ registrationId: reg.id })).map(a => [a.medalTemplateId, plain(a)]));
    const awardedNow = [];
    for (const t of templates) {
      const have = awards.get(t.id);
      const ok = t.status === 'active' && medalQualifies(t.rule, { base, categoryRank: row?.categoryRank, overallRank: row?.overallRank, elapsedMs: num(row?.elapsedMs) });
      if (ok) {
        if (!have) {
          const id = newId('ema');
          await trx('EventMedalAward').insert({ id, registrationId: reg.id, eventId: event.id, medalTemplateId: t.id, awardStatus: 'awarded', sourceResultId: row.id, awardedAt: at, createdAt: at }).onConflict(['registrationId', 'medalTemplateId']).ignore();
          const fresh = plain(await trx('EventMedalAward').where({ registrationId: reg.id, medalTemplateId: t.id }).first());
          await audit('system', 'events.medal_awarded', event.id, null, { awardId: fresh.id, templateId: t.id, registrationId: reg.id }, trx);
          if (fresh.id === id && userId) tell.push({ userId, id: `evmed:${fresh.id}:awarded`, type: 'event_medal_awarded', copy: COPY.medalAwarded({ medal: t.name.en }), swCopy: COPY.medalAwarded({ medal: sw(t.name) }), route: '/member/events/medals' });
          awardedNow.push({ ...fresh, template: t });
        } else if (have.awardStatus === 'revoked') {
          await trx('EventMedalAward').where({ id: have.id }).update({ awardStatus: 'awarded', revokedAt: null, reasonCode: null, revokedBy: null, sourceResultId: row.id, awardedAt: at });
          await audit('system', 'events.medal_awarded', event.id, { status: 'revoked' }, { awardId: have.id, templateId: t.id, registrationId: reg.id, reinstated: true }, trx);
          if (userId) tell.push({ userId, id: `evmed:${have.id}:awarded:${+at}`, type: 'event_medal_awarded', copy: COPY.medalAwarded({ medal: t.name.en }), swCopy: COPY.medalAwarded({ medal: sw(t.name) }), route: '/member/events/medals' });
          awardedNow.push({ ...have, template: t });
        } else {
          if (have.sourceResultId !== row.id) await trx('EventMedalAward').where({ id: have.id }).update({ sourceResultId: row.id });
          awardedNow.push({ ...have, template: t });
        }
      } else if (have && have.awardStatus === 'awarded' && t.status === 'active') {
        const reason = revokeReason({ reg, event, row });
        await trx('EventMedalAward').where({ id: have.id }).update({ awardStatus: 'revoked', revokedAt: at, reasonCode: reason, revokedBy: 'system' });
        await audit('system', 'events.medal_revoked', event.id, { status: 'awarded' }, { awardId: have.id, templateId: t.id, registrationId: reg.id, reason }, trx);
        if (userId) tell.push({ userId, id: `evmed:${have.id}:revoked:${+at}`, type: 'event_medal_revoked', copy: COPY.medalRevoked({ medal: t.name.en, reason }), swCopy: COPY.medalRevoked({ medal: sw(t.name), reason }), route: '/member/events/medals', essential: true });
        for (const r of userId ? await rewards.reverseSourceIn(trx, { userId, sourceType: 'event_medal', sourceId: have.id, reason }) : []) {
          tell.push({ userId, id: `evrw:${r.entryId}`, type: 'event_reward_reversed', copy: COPY.rewardReversed({ reward: r.definition.title.en, reason }), swCopy: COPY.rewardReversed({ reward: sw(r.definition.title), reason }), route: '/member/events/rewards', essential: true });
        }
      }
    }
    if (!userId) return tell;

    // ── achievements (platform-wide, need a person) ──
    const defs = (await trx('AchievementDefinition').where({ status: 'active' })).map(plain);
    const stats = await medals.finishStats(trx, userId);
    const awardedAch = [];
    for (const d of defs) {
      const awardKey = `${d.key}:v${d.ruleVersion}:${userId}`;
      const have = plain(await trx('UserAchievement').where({ awardKey }).first());
      const ok = medals.countFor(d.criteria, stats, at) >= d.criteria.count;
      if (ok) {
        if (!have) {
          const id = newId('uac');
          const ins = await trx('UserAchievement').insert({ id, userId, achievementDefinitionId: d.id, sourceType: 'event_result', sourceId: reg.id, status: 'awarded', awardKey, awardedAt: at, createdAt: at }).onConflict('awardKey').ignore().returning('id');
          if (ins.length) await audit('system', 'events.achievement_awarded', event.id, null, { key: d.key, userId }, trx);
          awardedAch.push({ id: (await trx('UserAchievement').where({ awardKey }).first('id')).id, key: d.key });
        } else if (have.status === 'revoked') {
          await trx('UserAchievement').where({ id: have.id }).update({ status: 'awarded', revokedAt: null, reasonCode: null, awardedAt: at });
          await audit('system', 'events.achievement_awarded', event.id, { status: 'revoked' }, { key: d.key, reinstated: true }, trx);
          awardedAch.push({ id: have.id, key: d.key });
        } else awardedAch.push({ id: have.id, key: d.key });
      } else if (have && have.status === 'awarded') {
        await trx('UserAchievement').where({ id: have.id }).update({ status: 'revoked', revokedAt: at, reasonCode: 'result_corrected' });
        await audit('system', 'events.achievement_revoked', event.id, { status: 'awarded' }, { key: d.key, userId }, trx);
        for (const r of await rewards.reverseSourceIn(trx, { userId, sourceType: 'achievement', sourceId: have.id, reason: 'result_corrected' })) {
          tell.push({ userId, id: `evrw:${r.entryId}`, type: 'event_reward_reversed', copy: COPY.rewardReversed({ reward: r.definition.title.en, reason: 'result_corrected' }), swCopy: COPY.rewardReversed({ reward: sw(r.definition.title), reason: 'result_corrected' }), route: '/member/events/rewards', essential: true });
        }
      }
    }

    // ── rewards: earn what the current standing earns, undo what it no longer does ──
    const active = (await trx('RewardDefinition').where({ status: 'active' })).map(plain);
    const earn = async (def, sourceType, sourceId) => {
      const out = await rewards.earnIn(trx, { definitionId: def.id, userId, sourceType, sourceId, categoryId: reg.categoryId });
      if (out.entry) tell.push({ userId, id: `evrw:${out.entry.id}`, type: 'event_reward_earned', copy: COPY.rewardEarned({ reward: def.title.en }), swCopy: COPY.rewardEarned({ reward: sw(def.title) }), route: '/member/events/rewards' });
    };
    for (const def of active) {
      if (def.triggerType === 'event_finish' && base && (!def.triggerEventId || def.triggerEventId === event.id)) await earn(def, 'event_result', reg.id);
      if (def.triggerType === 'medal') for (const a of awardedNow.filter(x => x.medalTemplateId === def.triggerRef || x.template.id === def.triggerRef)) await earn(def, 'event_medal', a.id);
      if (def.triggerType === 'achievement') for (const a of awardedAch.filter(x => x.key === def.triggerRef)) await earn(def, 'achievement', a.id);
    }
    if (!base) {
      const reason = revokeReason({ reg, event, row });
      for (const r of await rewards.reverseSourceIn(trx, { userId, sourceType: 'event_result', sourceId: reg.id, reason })) {
        tell.push({ userId, id: `evrw:${r.entryId}`, type: 'event_reward_reversed', copy: COPY.rewardReversed({ reward: r.definition.title.en, reason }), swCopy: COPY.rewardReversed({ reward: sw(r.definition.title), reason }), route: '/member/events/rewards', essential: true });
      }
    }
    return tell;
  }

  async function sendAll(tells) {
    for (const t of tells) {
      try { await notice(t.userId, { id: t.id, type: t.type, en: t.copy.en, sw: t.swCopy.sw, data: { route: t.route, essential: t.essential === true } }); } catch (err) { console.warn('[events-awards] notice skipped:', t.type, err?.message); }
    }
  }

  /** Evaluate one registration now (also what a task does). */
  async function evaluate(registrationId) {
    const tells = await db.transaction(trx => evaluateIn(trx, registrationId));
    await sendAll(tells);
    return { notices: tells.length };
  }

  /** An event-level task fans out to one coalesced task per registration that has a result or an award. */
  async function fanOut(task) {
    const ids = (await db.raw(`SELECT DISTINCT id FROM (
        SELECT r.id FROM "EventRegistration" r JOIN "EventResult" e ON e."registrationId" = r.id AND e."isCurrent" WHERE r."eventId" = ?
        UNION SELECT "registrationId" AS id FROM "EventMedalAward" WHERE "eventId" = ?
        UNION SELECT r.id FROM "EventRegistration" r WHERE r."eventId" = ? AND r."participantUserId" IS NOT NULL AND EXISTS (SELECT 1 FROM "RewardLedgerEntry" l WHERE l."userId" = r."participantUserId")
      ) x`, [task.eventId, task.eventId, task.eventId])).rows.map(r => r.id);
    await enqueueAwardTasks(db, { eventId: task.eventId, registrationIds: ids, reason: task.reason, at: stamp() });
    return ids.length;
  }

  /** The job: claim a batch (SKIP LOCKED), run each task, keep failures visible. */
  async function runBatch() {
    const claimed = (await db.raw(
      `UPDATE "EventAwardTask" SET state = 'running', "startedAt" = ?
       WHERE id IN (SELECT id FROM "EventAwardTask" WHERE state = 'pending' AND "runAfter" <= ? ORDER BY "createdAt" LIMIT ? FOR UPDATE SKIP LOCKED) RETURNING *`,
      [stamp(), stamp(), batch()],
    )).rows.map(plain);
    let done = 0; let failed = 0; let retried = 0;
    for (const task of claimed) {
      try {
        if (task.registrationId) await evaluate(task.registrationId); else await fanOut(task);
        await db('EventAwardTask').where({ id: task.id }).update({ state: 'done', finishedAt: stamp(), lastError: null });
        done += 1;
      } catch (err) {
        const attempts = task.attempts + 1;
        const give = attempts >= MAX_ATTEMPTS;
        await db('EventAwardTask').where({ id: task.id }).update({
          state: give ? 'failed' : 'pending', attempts, lastError: String(err?.message ?? 'error').slice(0, 200), runAfter: new Date(+stamp() + 2 ** attempts * 60_000), finishedAt: give ? stamp() : null,
        });
        if (give) { failed += 1; await audit('system', 'events.award_task_failed', task.eventId, null, { taskId: task.id, reason: task.reason }); } else retried += 1;
      }
    }
    return { claimed: claimed.length, done, failed, retried };
  }

  /**
   * Every 10 minutes: look for what changed without a request (a cancelled or refunded place, a cancelled event, a claim) and queue it;
   * lapse reserved perks. Stateless: once a medal is revoked it no longer matches, so a re-run finds nothing new.
   */
  async function reconcile() {
    const at = stamp();
    const stale = (await db('EventMedalAward as a').join('EventRegistration as r', 'r.id', 'a.registrationId').join('Event as e', 'e.id', 'a.eventId')
      .where('a.awardStatus', 'awarded').where(function gone() { this.whereNot('r.status', 'confirmed').orWhere('e.status', 'cancelled'); })
      .select('a.registrationId', 'a.eventId', 'e.status as eventStatus')).map(plain);
    let queued = 0;
    for (const s of stale) if (await enqueueAwardTask(db, { eventId: s.eventId, registrationId: s.registrationId, reason: s.eventStatus === 'cancelled' ? 'event_cancelled' : 'registration_cancelled', at })) queued += 1;
    const claims = (await db('EventRegistration as r').join('EventResult as e', function join() { this.on('e.registrationId', 'r.id').andOn('e.isCurrent', db.raw('true')); })
      .where('r.status', 'confirmed').where('r.claimedAt', '>', new Date(+at - 2 * 3_600_000)).whereRaw('r."claimedAt" > e."updatedAt"').whereIn('e.verificationStatus', SETTLED_VERIFICATIONS)
      .whereNotExists(function seen() { this.select(db.raw('1')).from('EventAwardTask as t').whereRaw('t."registrationId" = r.id').whereRaw('t."createdAt" >= r."claimedAt"'); })
      .select('r.id', 'r.eventId')).map(plain);
    for (const c of claims) if (await enqueueAwardTask(db, { eventId: c.eventId, registrationId: c.id, reason: 'claim', at })) queued += 1;
    const lapsed = await rewards.expireReservations();
    return { queued, ...lapsed };
  }

  return { evaluate, runBatch, reconcile, fanOut };
}
