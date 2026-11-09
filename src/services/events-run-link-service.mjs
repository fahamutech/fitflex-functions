// Marathon & running events · S6 — run links (spec §5, §8.3). A link ties one FitFlex GPS run (an Activity recorded by recordRun) to one
// registration. It is EVIDENCE for in-person events (shown next to the official result, sent to nobody) and the basis of a PENDING result
// for virtual events only (an organizer verifies or rejects it; there is no auto-accept, D49). A link never changes an official result and
// never creates one for an in-person event. Nothing here reads a route for an organizer, admin or the API: the track stays member-only.
//
// The combined route claims the link row FIRST (unique clientRef per registration), then records the run, then fills the link, so a crash
// in between is repaired by replaying with the same clientRef (the activity store is not transactional with this one).
import { randomUUID } from 'node:crypto';
import { cleanTrack } from '../shared/run-metrics.mjs';
import { analyseRun } from '../shared/events-run-checks.mjs';
import { registrationStatusOf, rulesOf, sha256hex } from '../shared/events-results-rules.mjs';
import { fingerprintOf } from '../shared/events-ops-rules.mjs';
import { createIdempotency } from '../shared/organizer-idempotency.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v ? new Date(v).toISOString() : null);
const newId = () => `eal_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const LIVE_EVENT = ['published', 'registration_closed', 'in_progress', 'completed'];
const UNIQUE = '23505';
const H = 3_600_000;
const DAY = 86_400_000;
const EVIDENCE_MAX = 3;
const DAILY_ATTEMPTS = 10;

export function createEventsRunLinkService({ db, results, recordRun, now = () => new Date(), toleranceBps = () => 200, maxDaysAfter = () => 7 }) {
  const stamp = () => new Date(now());
  const idempotent = createIdempotency({ db, now });
  const { load, lockEvent, writeRevision, audit, outbox } = results.internals;

  const view = (l, { canUnlink }) => ({
    id: l.id, linkType: l.linkType, matchStatus: l.matchStatus, distanceMeters: l.distanceMeters, movingSeconds: l.movingSeconds, elapsedMs: l.elapsedMs === null ? null : Number(l.elapsedMs),
    flags: Array.isArray(l.flags) ? l.flags : [], activityId: l.activityId ?? null, startedAt: l.checks?.startedAt ?? null, canUnlink,
  });
  const unlinkable = l => !l.unlinkedAt && (l.linkType === 'evidence' || l.matchStatus === 'pending');

  /** The registration of the caller as participant, with event, category and ticket state. */
  async function mine(userId, registrationId) {
    const reg = plain(await db('EventRegistration').where({ id: String(registrationId) }).first());
    if (!reg || reg.participantUserId !== userId) return fail('registration_not_found', 404);
    if (reg.status !== 'confirmed') return fail('registration_not_confirmed', 409);
    const ctx = await load({ eventId: reg.eventId });
    const ticket = plain(await db('EventTicket').where({ registrationId: reg.id }).whereIn('status', ['active', 'used_for_entry']).first());
    if (!ticket) return fail('ticket_revoked', 409);
    return { reg, event: ctx.event, categories: ctx.categories, category: ctx.categories.find(c => c.id === reg.categoryId) };
  }

  function rulesFor(event, category, startedAtMs) {
    const virtual = event.eventType === 'virtual';
    const startsAt = +new Date(event.startsAt); const endsAt = +new Date(event.endsAt);
    if (!LIVE_EVENT.includes(event.status)) return fail(event.status === 'cancelled' ? 'event_cancelled' : 'event_not_open', 409);
    if (+stamp() > endsAt + maxDaysAfter() * DAY) return fail('linking_closed', 409);
    const window = virtual ? { startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() }
      : { startsAt: new Date(+new Date(category.startTime ?? event.startsAt) - 2 * H).toISOString(), endsAt: new Date(endsAt + 12 * H).toISOString() };
    if (startedAtMs < +new Date(window.startsAt) || startedAtMs > +new Date(window.endsAt)) return fail('run_outside_window', 422, { window });
    return { virtual, window };
  }

  async function dailyLimit(userId) {
    const n = Number((await db('EventActivityLink as l').join('EventRegistration as r', 'r.id', 'l.registrationId').where('r.participantUserId', userId).where('l.createdAt', '>', new Date(+stamp() - DAY)).count({ n: '*' }).first()).n);
    return n >= DAILY_ATTEMPTS ? fail('rate_limited', 429, { retryAfterSeconds: 3600 }) : null;
  }

  /** Common live-link conflicts, read under the caller's locks. */
  async function conflicts(q, { reg, virtual, activityId }) {
    if (virtual) {
      if (await q('EventActivityLink').where({ registrationId: reg.id, linkType: 'event_run' }).whereNull('unlinkedAt').whereNot({ matchStatus: 'rejected' }).first()) return fail('run_already_linked', 409);
      if (activityId && await q('EventActivityLink').where({ activityId, linkType: 'event_run' }).whereNull('unlinkedAt').whereNot({ matchStatus: 'rejected' }).first()) return fail('activity_already_linked', 409);
    } else {
      const live = await q('EventActivityLink').where({ registrationId: reg.id, linkType: 'evidence' }).whereNull('unlinkedAt').select('activityId');
      if (activityId && live.some(l => l.activityId === activityId)) return fail('activity_already_linked', 409);
      if (live.length >= EVIDENCE_MAX) return fail('evidence_limit', 409, { max: EVIDENCE_MAX });
    }
    return null;
  }

  /** Flag a copied run on BOTH rows without naming either person. */
  async function flagDuplicates(trx, { link, event, userId }) {
    if (!link.routeFingerprint) return [];
    const twins = (await trx('EventActivityLink as l').join('EventRegistration as r', 'r.id', 'l.registrationId')
      .where('r.eventId', event.id).where('l.routeFingerprint', link.routeFingerprint).whereNot('l.id', link.id).whereNull('l.unlinkedAt').whereNot('r.participantUserId', userId)
      .select('l.id', 'l.flags')).map(plain);
    for (const t of twins) if (!t.flags.includes('duplicate_route')) await trx('EventActivityLink').where({ id: t.id }).update({ flags: JSON.stringify([...t.flags, 'duplicate_route']) });
    return twins.length ? ['duplicate_route'] : [];
  }

  /** Fill/insert the link and (virtual) the pending result, in one transaction. */
  async function commit(trx, { ctx, userId, linkId, activity, analysis, clientRef, requestSha, virtual, newLink }) {
    const { reg, event, category } = ctx;
    await lockEvent(trx, event.id);
    const flagsBase = [...analysis.flags];
    const row = {
      activityId: activity.id, distanceMeters: analysis.distanceMeters, movingSeconds: analysis.movingSeconds, elapsedMs: virtual ? analysis.elapsedMs : null,
      checks: JSON.stringify({ ...analysis.checks, startedAt: new Date(analysis.startedAt).toISOString() }), flags: JSON.stringify(flagsBase), routeFingerprint: analysis.fingerprint,
    };
    let link;
    if (newLink) {
      [link] = await trx('EventActivityLink').insert({ id: linkId, registrationId: reg.id, linkType: virtual ? 'event_run' : 'evidence', matchStatus: 'pending', clientRef, requestSha256: requestSha, submittedAt: stamp(), createdAt: stamp(), ...row }).returning('*');
    } else {
      [link] = await trx('EventActivityLink').where({ id: linkId }).update(row).returning('*');
    }
    link = plain(link);
    const dup = await flagDuplicates(trx, { link, event, userId });
    if (dup.length) { link.flags = [...flagsBase, ...dup]; await trx('EventActivityLink').where({ id: link.id }).update({ flags: JSON.stringify(link.flags) }); }
    let result = null;
    if (virtual) {
      const prev = plain(await trx('EventResult').where({ registrationId: reg.id, isCurrent: true }).first());
      if (prev && ['verified', 'corrected', 'disqualified'].includes(registrationStatusOf(prev))) throw Object.assign(new Error('result_exists'), { refusal: fail('result_exists', 409) });
      const live = plain(await trx('EventRegistration').where({ id: reg.id }).forUpdate().first());
      result = await writeRevision(trx, {
        category, reg: live, prev,
        input: { sourceType: 'fitflex_gps', finishStatus: 'finished', netMs: analysis.elapsedMs, gunMs: null, basis: 'net', verificationStatus: 'pending_verification', submittedByUserId: userId, activityLinkId: link.id, distanceMeters: analysis.distanceMeters },
      });
    }
    await audit(userId, 'events.run_linked', event.id, null, { registrationId: reg.id, linkId: link.id, linkType: link.linkType, flags: link.flags }, trx);
    void outbox; void rulesOf;
    return { link, result };
  }

  const resultView = r => (r ? { id: r.id, revision: r.revision, verificationStatus: r.verificationStatus, finishStatus: r.finishStatus, elapsedMs: r.elapsedMs === null ? null : Number(r.elapsedMs) } : null);

  /** Eligibility + analysis for a stored activity. → { analysis, virtual } or an error. */
  async function assess(ctx, userId, activity) {
    if (!activity || activity.userId !== userId) return fail('activity_not_found', 404);
    if (activity.type !== 'running' || activity.source !== 'fitflex' || !activity.hasRoute) return fail('activity_not_recorded_in_app', 422);
    const route = plain(await db('ActivityRoute').where({ id: activity.id }).first());
    if (!route) return fail('activity_not_recorded_in_app', 422);
    return assessTrack(ctx, route.segments, {});
  }
  function assessTrack(ctx, segments, { rawPoints = null, cleanPoints = null }) {
    const { event, category } = ctx;
    const virtual = event.eventType === 'virtual';
    const analysis = analyseRun(segments, { categoryMeters: virtual ? Number(category.distanceMeters) : null, startsAtMs: +new Date(event.startsAt), rawPoints, cleanPoints });
    if (analysis.startedAt === null) return fail('activity_not_recorded_in_app', 422);
    const rules = rulesFor(event, category, analysis.startedAt);
    if (rules.error) return rules;
    if (virtual) {
      const tol = rulesOf(category).virtualDistanceToleranceBps ?? toleranceBps();
      const required = Math.round(Number(category.distanceMeters) * (1 - tol / 10_000));
      if (analysis.distanceMeters < required) return fail('distance_too_short', 422, { measuredMeters: analysis.distanceMeters, requiredMeters: required });
    }
    // Inside the tolerance but short of the exact distance: the whole moving time counts (the 2 % allowance, D51).
    if (virtual && analysis.elapsedMs === null) analysis.elapsedMs = analysis.movingSeconds * 1000;
    return { analysis, virtual };
  }

  async function linkExisting({ userId, registrationId, key, body = {} }) {
    const ctx = await mine(userId, registrationId);
    if (ctx.error) return ctx;
    if (typeof body.activityId !== 'string' || !body.activityId) return fail('validation_failed', 422, { fields: [{ path: 'activityId', code: 'required' }] });
    return idempotent({ actor: { kind: 'staff', userId }, route: `runs.link:${registrationId}`, key, body }, async () => {
      const limited = await dailyLimit(userId);
      if (limited) return limited;
      const activity = plain(await db('Activity').where({ id: body.activityId }).first());
      const a = await assess(ctx, userId, activity);
      if (a.error) return a;
      try {
        const out = await db.transaction(async (trx) => {
          await trx('EventRegistration').where({ id: ctx.reg.id }).forUpdate().first();
          const clash = await conflicts(trx, { reg: ctx.reg, virtual: a.virtual, activityId: activity.id });
          if (clash) return clash;
          const done = await commit(trx, { ctx, userId, linkId: newId(), activity, analysis: a.analysis, clientRef: null, requestSha: null, virtual: a.virtual, newLink: true });
          return { link: view(done.link, { canUnlink: true }), result: resultView(done.result), status: 201 };
        });
        return out;
      } catch (err) {
        if (err.refusal) return err.refusal;
        if (err.code === UNIQUE) return fail(/activity/.test(String(err.constraint)) ? 'activity_already_linked' : 'run_already_linked', 409);
        throw err;
      }
    });
  }

  async function createAndLink({ userId, registrationId, body = {} }) {
    const ctx = await mine(userId, registrationId);
    if (ctx.error) return ctx;
    const clientRef = body.clientRef;
    if (typeof clientRef !== 'string' || clientRef.length < 8 || clientRef.length > 100) return fail('validation_failed', 422, { fields: [{ path: 'clientRef', code: 'invalid' }] });
    if (!Array.isArray(body.segments) || !body.segments.length) return fail('invalid_route', 400);
    const requestSha = sha256hex(fingerprintOf({ segments: body.segments, notes: body.notes ?? null, shareWith: body.shareWith ?? null }));
    const existing = plain(await db('EventActivityLink').where({ registrationId: ctx.reg.id, clientRef }).first());
    if (existing && existing.requestSha256 !== requestSha) return fail('idempotency_key_reused', 409);
    const rawPoints = body.segments.reduce((n, s) => n + (Array.isArray(s) ? s.length : 0), 0);
    const clean = cleanTrack(body.segments);
    const cleanPoints = clean.reduce((n, s) => n + s.length, 0);

    if (existing?.activityId) {
      const activity = plain(await db('Activity').where({ id: existing.activityId }).first());
      return { link: view(existing, { canUnlink: unlinkable(existing) }), activity, result: resultView(plain(await db('EventResult').where({ activityLinkId: existing.id, isCurrent: true }).first())), status: 200, replayed: true };
    }
    let linkId = existing?.id ?? null;
    if (!existing) {
      const limited = await dailyLimit(userId);
      if (limited) return limited;
      const pre = assessTrack(ctx, clean, { rawPoints, cleanPoints });
      if (pre.error) return pre;
      const clash = await conflicts(db, { reg: ctx.reg, virtual: pre.virtual, activityId: null });
      if (clash) return clash;
      if (pre.virtual) {
        const cur = plain(await db('EventResult').where({ registrationId: ctx.reg.id, isCurrent: true }).first());
        if (cur && ['verified', 'corrected', 'disqualified'].includes(registrationStatusOf(cur))) return fail('result_exists', 409);
      }
      linkId = newId();
      try {
        await db('EventActivityLink').insert({ id: linkId, registrationId: ctx.reg.id, linkType: pre.virtual ? 'event_run' : 'evidence', matchStatus: 'pending', clientRef, requestSha256: requestSha, submittedAt: stamp(), createdAt: stamp() });
      } catch (err) {
        if (err.code === UNIQUE) return fail(/clientref|client_ref/i.test(String(err.constraint)) ? 'request_in_progress' : 'run_already_linked', 409);
        throw err;
      }
    }
    // The claim row exists: record the run (or find the one a crashed attempt already recorded), then fill the link.
    const firstT = clean[0]?.[0]?.[3];
    let activity = null;
    let recordedHere = false;
    if (existing && firstT) {
      activity = plain(await db('Activity').where({ userId, source: 'fitflex', startedAt: new Date(firstT) }).whereNotIn('id', db('EventActivityLink').whereNotNull('activityId').select('activityId')).first());
    }
    if (!activity) {
      const saved = await recordRun(userId, { type: 'running', segments: body.segments, notes: body.notes, shareWith: body.shareWith });
      if (saved.error) { if (!existing) await db('EventActivityLink').where({ id: linkId }).del(); return fail(saved.error, saved.status || 400); }
      activity = saved.activity;
      recordedHere = true;
    }
    // A refusal after the run was recorded here must not leave the run behind: the app then saves it itself, once (no orphan, no duplicate).
    const dropOrphan = async () => { if (recordedHere) { await db('ActivityRoute').where({ id: activity.id }).del(); await db('Activity').where({ id: activity.id }).del(); } };
    const a = await assess(ctx, userId, activity);
    if (a.error) { await db('EventActivityLink').where({ id: linkId }).del(); await dropOrphan(); return a; }
    try {
      return await db.transaction(async (trx) => {
        const done = await commit(trx, { ctx, userId, linkId, activity, analysis: { ...a.analysis, checks: { ...a.analysis.checks, droppedPointsPct: rawPoints ? Math.max(0, Math.round(((rawPoints - cleanPoints) / rawPoints) * 100)) : null }, flags: [...new Set([...a.analysis.flags, ...(rawPoints && Math.round(((rawPoints - cleanPoints) / rawPoints) * 100) > 15 ? ['many_dropped_points'] : [])])] }, clientRef, requestSha, virtual: a.virtual, newLink: false });
        return { link: view(done.link, { canUnlink: true }), activity, result: resultView(done.result), status: 201 };
      });
    } catch (err) {
      if (err.refusal) { await db('EventActivityLink').where({ id: linkId }).del(); await dropOrphan(); return err.refusal; }
      throw err;
    }
  }

  async function list({ userId, registrationId }) {
    const reg = plain(await db('EventRegistration').where({ id: String(registrationId) }).first());
    if (!reg || reg.participantUserId !== userId) return fail('registration_not_found', 404);
    const rows = (await db('EventActivityLink').where({ registrationId: reg.id }).whereNull('unlinkedAt').whereNotNull('activityId').orderBy('createdAt', 'desc')).map(plain);
    return { items: rows.map(l => view(l, { canUnlink: unlinkable(l) })) };
  }

  async function unlink({ userId, registrationId, linkId }) {
    const reg = plain(await db('EventRegistration').where({ id: String(registrationId) }).first());
    if (!reg || reg.participantUserId !== userId) return fail('registration_not_found', 404);
    const ctx = await load({ eventId: reg.eventId });
    return db.transaction(async (trx) => {
      await lockEvent(trx, reg.eventId);
      const l = plain(await trx('EventActivityLink').where({ id: String(linkId), registrationId: reg.id }).forUpdate().first());
      if (!l || l.unlinkedAt) return fail('link_not_found', 404);
      if (!unlinkable(l)) return fail('link_locked', 409, { matchStatus: l.matchStatus });
      const at = stamp();
      await trx('EventActivityLink').where({ id: l.id }).update({ unlinkedAt: at, unlinkedReason: 'participant' });
      if (l.linkType === 'event_run') {
        const row = plain(await trx('EventResult').where({ activityLinkId: l.id, isCurrent: true, verificationStatus: 'pending_verification' }).forUpdate().first());
        if (row) {
          await trx('EventResult').where({ id: row.id }).update({ verificationStatus: 'rejected', reasonCode: 'replaced_by_participant', updatedAt: at });
          await trx('EventRegistration').where({ id: reg.id }).update({ resultStatus: 'rejected', updatedAt: at });
        }
      }
      await audit(userId, 'events.run_unlinked', ctx.event.id, { linkId: l.id }, { registrationId: reg.id, linkType: l.linkType }, trx);
      return { unlinked: { id: l.id }, status: 200 };
    });
  }

  /** For the result page: the live links of a registration. */
  async function linksFor(registrationId) {
    const rows = (await db('EventActivityLink').where({ registrationId }).whereNull('unlinkedAt').whereNotNull('activityId').orderBy('createdAt', 'desc')).map(plain);
    return rows.map(l => view(l, { canUnlink: unlinkable(l) }));
  }
  results.hooks.runLinksFor = linksFor;

  return { linkExisting, createAndLink, list, unlink, linksFor };
}
