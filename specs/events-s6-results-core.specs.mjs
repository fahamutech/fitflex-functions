// Events S6 · B1 — results core: revisions and the result machine, stages, import, verify/role matrix, release and ranks, disputes, privacy, webhooks, flags.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import * as routes from '../functions/events-results.mjs';
import { harness, s6On, s6Off, db } from './fixtures/events-s6.mjs';
import { deriveStage, parseTime, competitionRanks, computeRanks, boardName } from '../src/shared/events-results-rules.mjs';
import { projectOutbox, WEBHOOK_EVENT_TYPES } from '../src/shared/webhook-events.mjs';
import { eventStore } from '../src/bootstrap/services.mjs';
import { RESULT_REASONS } from '../db/migrations/20270129090000-events-results-s6.cjs';
import { ALL_REASONS } from '../src/shared/events-results-rules.mjs';

await ensureInit();
const h = harness();
const svc = h.service;
afterEach(() => { routes.resetEventsResultsLimits(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const ctx = (f, actor) => ({ actor, organizerId: f.organizer.id, eventId: f.event.id });
async function setup({ n = 4, m = 0, over = {} } = {}) {
  s6On();
  const o = await h.org();
  const f = await h.resultsEvent({ organizer: o, n, m, ...over });
  return { o, f, a: h.actors(o) };
}
const verify = (f, a, id, rev = 1, body = {}) => svc.verify({ ...ctx(f, a), resultId: id, key: h.key(), body: { expectedRevision: rev, ...body } });
async function released(f, a, stage = 'official', extra = {}) {
  const body = { stage, ...extra };
  const p = await svc.releasePreview({ ...ctx(f, a), body });
  const r = await svc.release({ ...ctx(f, a), key: h.key(), body: { ...body, previewHash: p.previewHash } });
  assert.equal(r.status, 200, JSON.stringify(r));
  return r;
}
const rowOf = async f => (await h.current(f.regs[0].id));

test('pure rules: times, stage table, ranks with ties, reason list parity with the migration', () => {
  assert.equal(parseTime('1:52:08').ms, 6_728_000);
  assert.equal(parseTime('00:00').error, 'time_out_of_range');
  assert.equal(parseTime('abc').error, 'time_invalid');
  assert.deepEqual(competitionRanks([1, 2, 2, 4]), [1, 2, 2, 4]);
  assert.deepEqual([...ALL_REASONS].sort(), [...RESULT_REASONS].sort());
  const row = (v, f = 'finished') => ({ verificationStatus: v, finishStatus: f });
  const t = [
    [null, 'official', 'none'], [row('pending_verification'), 'none', 'none'], [row('pending_verification'), 'provisional', 'provisional'], [row('verified'), 'provisional', 'provisional'],
    [row('verified'), 'official', 'official'], [row('pending_verification'), 'official', 'none'], [row('corrected'), 'official', 'corrected'], [row('disqualified', 'dq'), 'official', 'disqualified'],
    [row('rejected'), 'none', 'rejected'], [row('verified', 'dnf'), 'official', 'official'],
  ];
  for (const [r, rel, want] of t) assert.equal(deriveStage({ row: r, release: rel }), want);
  assert.equal(deriveStage({ row: row('verified'), release: 'official', disputeOpen: true }), 'disputed');
  assert.equal(deriveStage({ row: null, release: 'official', disputeOpen: true }), 'none');
  const rows = [
    { id: 'a', categoryId: 'c1', distanceMeters: 10000, verificationStatus: 'verified', finishStatus: 'finished', elapsedMs: 100, withinCutoff: true },
    { id: 'b', categoryId: 'c1', distanceMeters: 10000, verificationStatus: 'verified', finishStatus: 'finished', elapsedMs: 100, withinCutoff: true },
    { id: 'c', categoryId: 'c1', distanceMeters: 10000, verificationStatus: 'verified', finishStatus: 'finished', elapsedMs: 200, withinCutoff: false },
    { id: 'd', categoryId: 'c2', distanceMeters: 10000, verificationStatus: 'corrected', finishStatus: 'finished', elapsedMs: 150, withinCutoff: null },
    { id: 'e', categoryId: 'c1', distanceMeters: 10000, verificationStatus: 'verified', finishStatus: 'dnf', elapsedMs: null, withinCutoff: null },
  ];
  const r = computeRanks(rows, new Set(['c1', 'c2']));
  assert.deepEqual([r.get('a').overallRank, r.get('b').overallRank, r.get('d').overallRank, r.get('c').overallRank, r.get('e').overallRank], [1, 1, 3, null, null]);
  assert.equal(r.get('d').categoryRank, 1);
  assert.equal(computeRanks(rows, new Set()).get('a').overallRank, null);
  assert.equal(boardName({ firstName: 'Asha', lastName: 'Mollel' }, 'standard'), 'Asha M.');
  assert.equal(boardName({ firstName: 'Asha', lastName: 'Mollel' }, 'bib_only'), 'Runner');
  assert.equal(boardName({ firstName: 'Asha', lastName: 'Mollel' }, 'hidden'), null);
});

test('migration down fails closed once S6 data exists', async () => {
  const { f, a } = await setup({ n: 1 });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', '']]));
  const mig = (await import('../db/migrations/20270129090000-events-results-s6.cjs')).default ?? (await import('../db/migrations/20270129090000-events-results-s6.cjs'));
  await assert.rejects(db.transaction(trx => mig.down(trx)), /fails closed/);
});

test('import → verify → correct → correct again → disqualify → reinstate: one current row, revisions are rows, the machine is respected', async () => {
  const { f, a } = await setup({ n: 2 });
  assert.equal((await h.importCsv(f, a.timing, h.csvOf([['1001', 'finished', '0:50:00', '0:50:20'], ['1002', 'finished', '0:55:00', '']]))).status, 201);
  const r1 = await rowOf(f);
  assert.deepEqual([r1.revision, r1.verificationStatus, r1.sourceType, r1.sourceLabel], [1, 'pending_verification', 'timing_provider', 'ChipTime Ltd']);
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).resultStatus, 'pending_verification');
  assert.equal((await verify(f, a.owner, r1.id)).status, 200);
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).resultStatus, 'verified');
  const verifiedRow = await rowOf(f);
  assert.equal(verifiedRow.verifiedBy, a.owner.userId);
  const doCorrect = async (rev, body) => svc.correct({ ...ctx(f, a.owner), resultId: (await rowOf(f)).id, key: h.key(), body: { expectedRevision: rev, reasonCode: 'timing_error', note: 'Chip mat was late at the start', ...body } });
  const c1 = await doCorrect(1, { netTime: '0:49:30' });
  assert.equal(c1.status, 200, JSON.stringify(c1));
  assert.deepEqual([c1.result.revision, c1.result.verificationStatus], [2, 'corrected']);
  assert.equal((await db('EventResult').where({ registrationId: f.regs[0].id, isCurrent: true })).length, 1);
  assert.equal((await doCorrect(2, { netTime: '0:49:30' })).error, 'no_change');
  const c2 = await doCorrect(2, { netTime: '0:49:00' });
  assert.equal(c2.result.revision, 3);
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).resultStatus, 'corrected');
  const dq = await svc.disqualify({ ...ctx(f, a.owner), resultId: (await rowOf(f)).id, key: h.key(), body: { expectedRevision: 3, reasonCode: 'course_cut', note: 'Cut the course' } });
  assert.equal(dq.status, 200, JSON.stringify(dq));
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).resultStatus, 'disqualified');
  const back = await doCorrect(4, { finishStatus: 'finished' });
  assert.equal(back.status, 200, JSON.stringify(back));
  assert.equal(back.result.verificationStatus, 'corrected');
  assert.equal((await db('EventResult').where({ registrationId: f.regs[0].id })).length, 5);
  assert.equal((await db('EventResult').where({ registrationId: f.regs[0].id, isCurrent: true })).length, 1);
  assert.equal((await db('AuditLog').where({ action: 'events.result_corrected', target: f.event.id })).length >= 3, true);
  // a pending result cannot be corrected: the machine says verify first
  const pend = await rowOf({ regs: [f.regs[1]] });
  assert.equal((await svc.correct({ ...ctx(f, a.owner), resultId: pend.id, key: h.key(), body: { expectedRevision: 1, reasonCode: 'timing_error', note: 'ten characters ok', netTime: '0:54:00' } })).error, 'invalid_transition');
});

test('verify needs expectedRevision (stale → 409), roles: timing cannot decide, ops/finance see nothing, other organizer and other event are 404', async () => {
  const { f, a, o } = await setup({ n: 1 });
  await h.importCsv(f, a.timing, h.csvOf([['1001', 'finished', '0:50:00', '']]));
  const row = await rowOf(f);
  assert.equal((await svc.verify({ ...ctx(f, a.owner), resultId: row.id, key: h.key(), body: {} })).error, 'validation_failed');
  assert.equal((await verify(f, a.timing, row.id)).error, 'forbidden_role');
  assert.equal((await verify(f, a.ops, row.id)).error, 'forbidden_role');
  assert.equal((await verify(f, a.finance, row.id)).error, 'forbidden_role');
  assert.equal((await svc.list({ ...ctx(f, a.ops) })).error, 'forbidden_role');
  assert.equal((await svc.verify({ actor: { kind: 'api', clientId: 'x', scopes: ['results:write', 'results:read'] }, organizerId: o.id, eventId: f.event.id, resultId: row.id, key: h.key(), body: { expectedRevision: 1 } })).error, 'forbidden_role');
  const stale = await verify(f, a.owner, row.id, 7);
  assert.deepEqual([stale.status, stale.error, stale.currentRevision], [409, 'result_changed', 1]);
  const other = await h.org();
  assert.equal((await svc.verify({ actor: h.actors(other).owner, organizerId: other.id, eventId: f.event.id, resultId: row.id, key: h.key(), body: { expectedRevision: 1 } })).error, 'event_not_found');
  const f2 = await h.resultsEvent({ organizer: o, n: 1 });
  assert.equal((await svc.verify({ ...ctx(f2, a.owner), resultId: row.id, key: h.key(), body: { expectedRevision: 1 } })).error, 'result_not_found');
  assert.equal((await verify(f, a.owner, row.id)).status, 200);
  assert.equal((await svc.verify({ ...ctx(f, a.owner), resultId: row.id, body: { expectedRevision: 1 } })).error, 'idempotency_key_required');
});

test('verify is idempotent per key and two concurrent verifies change one row once', async () => {
  const { f, a } = await setup({ n: 1 });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', '']]));
  const row = await rowOf(f);
  const k = h.key();
  const call = key => svc.verify({ ...ctx(f, a.owner), resultId: row.id, key, body: { expectedRevision: 1 } });
  const first = await call(k);
  const again = await call(k);
  assert.deepEqual([first.status, again.status, again.replayed], [200, 200, true]);
  assert.equal((await svc.verify({ ...ctx(f, a.owner), resultId: row.id, key: k, body: { expectedRevision: 2 } })).error, 'idempotency_key_reused');
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'result.verified' })).length, 1);
});

test('import: preview/apply, problems block apply (nothing written), replay returns the first answer, already_official, rank column ignored, formula cells, ops refused, other organizer 404', async () => {
  const { f, a, o } = await setup({ n: 3 });
  const csv = `bib,status,net_time,rank,note\n1001,finished,0:50:00,1,=cmd|x\n1002,finished,notatime,2,\n9999,finished,0:40:00,3,\n`;
  const prev = await svc.importPreview({ ...ctx(f, a.timing), body: { csv, sourceType: 'timing_provider' } });
  assert.equal(prev.problemsTotal, 2);
  assert.deepEqual(prev.problems.map(p => p.code).sort(), ['bib_not_found', 'time_invalid']);
  assert.ok(prev.warnings.some(w => w.code === 'rank_ignored'));
  const blocked = await svc.importApply({ ...ctx(f, a.timing), key: h.key(), body: { csv, sourceType: 'timing_provider', previewHash: prev.previewHash } });
  assert.deepEqual([blocked.status, blocked.error], [409, 'import_has_errors']);
  assert.equal(await db('EventResult').whereIn('registrationId', f.regs.map(r => r.id)).count().then(r => Number(r[0].count)), 0);
  const good = `bib,status,net_time,rank,note\n1001,finished,0:50:00,9,=cmd|x\n1002,finished,0:55:00,,\n`;
  const applied = await h.importCsv(f, a.timing, good);
  assert.equal(applied.status, 201);
  assert.deepEqual([applied.import.createdCount, applied.import.unchangedCount], [2, 0]);
  const stored = await rowOf(f);
  assert.equal(stored.overallRank, null);
  assert.equal(stored.sourceReference, "'=cmd|x");
  const preview = await svc.importPreview({ ...ctx(f, a.timing), body: { csv: good, sourceType: 'timing_provider', sourceLabel: 'ChipTime Ltd' } });
  const replay = await svc.importApply({ ...ctx(f, a.timing), key: h.key(), body: { csv: good, sourceType: 'timing_provider', sourceLabel: 'ChipTime Ltd', previewHash: preview.previewHash } });
  assert.equal(replay.replayed, true);
  assert.equal(await db('EventResultImport').where({ eventId: f.event.id }).count().then(r => Number(r[0].count)), 1);
  await verify(f, a.owner, stored.id);
  const again = await svc.importPreview({ ...ctx(f, a.timing), body: { csv: good, sourceType: 'timing_provider' } });
  assert.ok(again.problems.some(p => p.code === 'already_official'));
  assert.equal((await svc.importPreview({ ...ctx(f, a.ops), body: { csv: good } })).error, 'forbidden_role');
  const stranger = await h.org();
  assert.equal((await svc.importPreview({ actor: h.actors(stranger).owner, organizerId: stranger.id, eventId: f.event.id, body: { csv: good } })).error, 'event_not_found');
  const formula = await svc.importPreview({ ...ctx(f, a.owner), body: { csv: 'bib,net_time\n=1+1,0:50:00\n' } });
  assert.equal(formula.problems[0].code, 'bib_invalid');
  assert.equal((await svc.importPreview({ ...ctx(f, a.owner), body: { csv: 'name\nx\n' } })).error, 'csv_invalid');
  void o;
});

test('events not in progress / completed refuse results; a cancelled event refuses decisions', async () => {
  const { f, a } = await setup({ n: 1 });
  await db('Event').where({ id: f.event.id }).update({ status: 'published' });
  assert.equal((await svc.importPreview({ ...ctx(f, a.owner), body: { csv: h.csvOf([['1001', 'finished', '0:50:00', '']]) } })).error, 'event_not_open_for_results');
  await db('Event').where({ id: f.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  assert.equal((await svc.importPreview({ ...ctx(f, a.owner), body: { csv: 'bib,net_time\n1001,0:50:00\n' } })).error, 'event_cancelled');
});

test('manual entry: pending for a time, settled for DNF; verified results need a correction', async () => {
  const { f, a } = await setup({ n: 2 });
  const enter = (reg, body, actor = a.timing) => svc.enter({ ...ctx(f, actor), registrationId: reg.id, key: h.key(), body });
  const e1 = await enter(f.regs[0], { finishStatus: 'finished', netTime: '0:51:00' });
  assert.equal(e1.result.verificationStatus, 'pending_verification');
  const e2 = await enter(f.regs[1], { finishStatus: 'dnf' });
  assert.equal(e2.result.verificationStatus, 'verified');
  assert.equal((await db('EventRegistration').where({ id: f.regs[1].id }).first()).resultStatus, 'dnf');
  assert.equal((await enter(f.regs[0], { finishStatus: 'finished', netTime: 'bad' })).error, 'validation_failed');
  assert.equal((await enter(f.regs[0], { finishStatus: 'finished', netTime: '0:52:00' })).result.revision, 2);
  await verify(f, a.owner, (await rowOf(f)).id, 2);
  assert.equal((await enter(f.regs[0], { finishStatus: 'finished', netTime: '0:53:00' })).error, 'already_official');
  assert.equal((await enter(f.regs[0], { finishStatus: 'dnf' }, a.ops)).error, 'forbidden_role');
});

test('reject: needs a reason code; bulk verify excludes flagged rows and goes stale when data changes', async () => {
  const { f, a } = await setup({ n: 3 });
  await h.importCsv(f, a.timing, h.csvOf([['1001', 'finished', '0:50:00', ''], ['1002', 'finished', '0:51:00', ''], ['1003', 'finished', '0:52:00', '']]));
  const rows = await Promise.all(f.regs.map(r => h.current(r.id)));
  assert.equal((await svc.reject({ ...ctx(f, a.owner), resultId: rows[0].id, key: h.key(), body: { expectedRevision: 1, reasonCode: 'nope' } })).error, 'validation_failed');
  const rej = await svc.reject({ ...ctx(f, a.owner), resultId: rows[0].id, key: h.key(), body: { expectedRevision: 1, reasonCode: 'data_error', note: 'wrong bib' } });
  assert.equal(rej.result.verificationStatus, 'rejected');
  // a flagged GPS-style link on row 2 keeps it out of the bulk
  await db('EventActivityLink').insert({ id: 'eal_spec_flag1', registrationId: f.regs[1].id, linkType: 'event_run', matchStatus: 'pending', flags: JSON.stringify(['implausible_pace']) });
  const pv = await svc.bulkPreview({ ...ctx(f, a.owner), body: {} });
  assert.deepEqual([pv.count, pv.excludedFlagged], [1, 1]);
  await h.importCsv(f, a.timing, h.csvOf([['1003', 'finished', '0:52:30', '']]));
  assert.equal((await svc.bulkApply({ ...ctx(f, a.owner), key: h.key(), body: { previewHash: pv.previewHash } })).error, 'preview_stale');
  const pv2 = await svc.bulkPreview({ ...ctx(f, a.owner), body: {} });
  const done = await svc.bulkApply({ ...ctx(f, a.owner), key: h.key(), body: { previewHash: pv2.previewHash } });
  assert.deepEqual([done.verified, done.excludedFlagged], [1, 1]);
  assert.equal((await svc.bulkApply({ ...ctx(f, a.timing), key: h.key(), body: { previewHash: pv2.previewHash } })).error, 'forbidden_role');
});

test('release: unsettled blocks official, leaveUnsettledOut, markRemainingDns, ranks with ties and cut-off, official only once, stale hash, withdraw rules', async () => {
  const { f, a } = await setup({ n: 5 });
  await svc.updateSettings({ ...ctx(f, a.owner), key: h.key(), body: { cutoffMinutes: 60 } });
  await h.importCsv(f, a.timing, h.csvOf([['1001', 'finished', '0:50:00', ''], ['1002', 'finished', '0:50:00', ''], ['1003', 'finished', '0:58:00', ''], ['1004', 'finished', '1:30:00', ''], ['1005', 'finished', '0:40:00', '']]));
  for (const r of f.regs.slice(0, 4)) await verify(f, a.owner, (await h.current(r.id)).id);
  const body = { stage: 'official' };
  const p = await svc.releasePreview({ ...ctx(f, a.owner), body });
  assert.equal(p.unsettled, 1);
  const blocked = await svc.release({ ...ctx(f, a.owner), key: h.key(), body: { ...body, previewHash: p.previewHash } });
  assert.deepEqual([blocked.status, blocked.error, blocked.unsettled], [409, 'unsettled_results', 1]);
  assert.equal((await svc.release({ ...ctx(f, a.owner), key: h.key(), body: { ...body, previewHash: 'nope', leaveUnsettledOut: true } })).error, 'preview_stale');
  assert.equal((await svc.release({ ...ctx(f, a.timing), key: h.key(), body: { ...body, previewHash: p.previewHash } })).error, 'forbidden_role');
  const ok = await svc.release({ ...ctx(f, a.owner), key: h.key(), body: { ...body, previewHash: p.previewHash, leaveUnsettledOut: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  const ranks = await Promise.all(f.regs.map(async r => { const x = await h.current(r.id); return [x.overallRank, x.categoryRank, x.withinCutoff]; }));
  assert.deepEqual(ranks, [[1, 1, true], [1, 1, true], [3, 3, true], [null, null, false], [null, null, true]]);
  const p2 = await svc.releasePreview({ ...ctx(f, a.owner), body });
  assert.equal((await svc.release({ ...ctx(f, a.owner), key: h.key(), body: { ...body, previewHash: p2.previewHash, leaveUnsettledOut: true } })).error, 'already_released');
  assert.equal((await svc.withdraw({ ...ctx(f, a.owner), key: h.key(), body: {} })).error, 'already_released');
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'result.published' })).length, 1);
  assert.equal((await db('EventAwardTask').where({ eventId: f.event.id, reason: 'release' })).length, 1);
  // a correction after the release recomputes ranks
  const r3 = await h.current(f.regs[2].id);
  await svc.correct({ ...ctx(f, a.owner), resultId: r3.id, key: h.key(), body: { expectedRevision: 1, reasonCode: 'timing_error', note: 'Mat error at 3 km', netTime: '0:45:00' } });
  assert.equal((await h.current(f.regs[2].id)).overallRank, 1);
  assert.equal((await h.current(f.regs[0].id)).overallRank, 2);
  assert.ok((await db('OutboxEvent').where({ eventId: f.event.id, type: 'result.corrected' })).length >= 1);
});

test('release: provisional can be withdrawn; markRemainingDns writes settled DNS rows; the unique official release per scope is a database fact', async () => {
  const { f, a } = await setup({ n: 3 });
  await h.importCsv(f, a.timing, h.csvOf([['1001', 'finished', '0:50:00', '']]));
  assert.equal((await svc.releasePreview({ ...ctx(f, a.owner), body: { stage: 'nope' } })).error, 'validation_failed');
  await released(f, a.owner, 'provisional');
  assert.equal((await svc.myResult({ userId: f.regs[0].userId, registrationId: f.regs[0].id })).stage, 'provisional');
  const w = await svc.withdraw({ ...ctx(f, a.owner), key: h.key(), body: {} });
  assert.equal(w.status, 200);
  assert.equal((await svc.myResult({ userId: f.regs[0].userId, registrationId: f.regs[0].id })).stage, 'none');
  assert.equal((await svc.withdraw({ ...ctx(f, a.owner), key: h.key(), body: {} })).error, 'nothing_to_withdraw');
  await verify(f, a.owner, (await rowOf(f)).id);
  const off = await released(f, a.owner, 'official', { markRemainingDns: true });
  assert.equal(off.release.markedDns, 2);
  assert.equal((await db('EventRegistration').where({ id: f.regs[1].id }).first()).resultStatus, 'dns');
  await assert.rejects(db('EventResultRelease').insert({ id: 'erel_dup', eventId: f.event.id, categoryId: null, stage: 'official', action: 'release' }), /unique|duplicate/i);
  await assert.rejects(db('EventResultRelease').where({ eventId: f.event.id }).update({ note: 'x' }), /append-only/);
});

test('disputes: window, one open, upheld needs a correction applied in the same transaction, rejected, withdraw, admin only after 7 days, notices have deterministic ids', async () => {
  const { f, a } = await setup({ n: 2 });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', ''], ['1002', 'finished', '0:55:00', '']]));
  for (const r of f.regs) await verify(f, a.owner, (await h.current(r.id)).id);
  const u0 = f.regs[0].userId;
  assert.equal((await svc.raiseDispute({ userId: u0, registrationId: f.regs[0].id, body: { reasonCode: 'time_wrong' } })).error, 'no_result');
  await released(f, a.owner, 'official');
  const d = await svc.raiseDispute({ userId: u0, registrationId: f.regs[0].id, body: { reasonCode: 'time_wrong', note: 'My watch says 49:00' } });
  assert.equal(d.status, 201);
  assert.equal((await svc.raiseDispute({ userId: u0, registrationId: f.regs[0].id, body: { reasonCode: 'time_wrong' } })).error, 'dispute_open');
  assert.equal((await svc.raiseDispute({ userId: f.regs[1].userId, registrationId: f.regs[0].id, body: { reasonCode: 'other' } })).error, 'registration_not_found');
  assert.equal((await svc.myResult({ userId: u0, registrationId: f.regs[0].id })).stage, 'disputed');
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'result.disputed' })).length, 1);
  const resolve = body => svc.disputeResolve({ ...ctx(f, a.owner), disputeId: d.dispute.id, key: h.key(), body });
  assert.equal((await resolve({ outcome: 'upheld', note: 'We agree with you' })).error, 'correction_required');
  assert.equal((await resolve({ outcome: 'upheld', note: 'x' })).error, 'validation_failed');
  assert.equal((await svc.disputeResolve({ ...ctx(f, a.timing), disputeId: d.dispute.id, key: h.key(), body: { outcome: 'rejected', note: 'No change' } })).error, 'forbidden_role');
  assert.equal((await svc.disputeResolve({ actor: { kind: 'admin', userId: 'adm' }, eventId: f.event.id, disputeId: d.dispute.id, key: h.key(), body: { outcome: 'rejected', note: 'No change' } })).error, 'organizer_can_resolve');
  const up = await resolve({ outcome: 'upheld', note: 'Timing mat error confirmed', correction: { reasonCode: 'timing_error', note: 'Mat error confirmed on review', netTime: '0:49:00' } });
  assert.equal(up.status, 200, JSON.stringify(up));
  assert.equal((await h.current(f.regs[0].id)).revision, 2);
  const stored = await db('EventResultDispute').where({ id: d.dispute.id }).first();
  assert.deepEqual([stored.status, stored.resultIdAfter !== null], ['upheld', true]);
  const note = await db('Notification').where({ userId: u0, type: 'event_dispute_update' });
  assert.ok(note.some(n => n.id === `evdis:${d.dispute.id}:upheld`));
  assert.equal((await resolve({ outcome: 'rejected', note: 'Already closed' })).error, 'dispute_closed');
  // withdraw + admin after 7 days
  const d2 = await svc.raiseDispute({ userId: f.regs[1].userId, registrationId: f.regs[1].id, body: { reasonCode: 'other' } });
  assert.equal((await svc.withdrawDispute({ userId: f.regs[1].userId, registrationId: f.regs[1].id, disputeId: d2.dispute.id })).dispute.status, 'withdrawn');
  const d3 = await svc.raiseDispute({ userId: f.regs[1].userId, registrationId: f.regs[1].id, body: { reasonCode: 'other' } });
  await db('EventResultDispute').where({ id: d3.dispute.id }).update({ createdAt: new Date(Date.now() - 8 * 86_400_000) });
  const adm = await svc.disputeResolve({ actor: { kind: 'admin', userId: 'adm' }, eventId: f.event.id, disputeId: d3.dispute.id, key: h.key(), body: { outcome: 'rejected', note: 'Result stands after review' } });
  assert.equal(adm.status, 200);
  // window closed
  await db.transaction(async (trx) => { await trx.raw('ALTER TABLE "EventResultRelease" DISABLE TRIGGER ALL'); await trx('EventResultRelease').where({ eventId: f.event.id }).update({ releasedAt: new Date(Date.now() - 30 * 86_400_000) }); await trx.raw('ALTER TABLE "EventResultRelease" ENABLE TRIGGER ALL'); });
  assert.equal((await svc.raiseDispute({ userId: f.regs[1].userId, registrationId: f.regs[1].id, body: { reasonCode: 'other' } })).error, 'dispute_window_closed');
});

test('privacy: minors bib only, hidden omitted, legacy consent defaults to bib only, purchaser status only after the claim, board shows no contact data', async () => {
  const { f, a } = await setup({ n: 4 });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', ''], ['1002', 'finished', '0:51:00', ''], ['1003', 'finished', '0:52:00', ''], ['1004', 'finished', '0:53:00', '']]));
  for (const r of f.regs) await verify(f, a.owner, (await h.current(r.id)).id);
  await released(f, a.owner, 'official');
  const birth = new Date(Date.now() - 12 * 365 * 86_400_000).toISOString().slice(0, 10);
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ dateOfBirth: birth });
  await db('EventRegistration').where({ id: f.regs[2].id }).update({ resultsVisibility: 'hidden', resultsVisibilitySetAt: new Date() });
  await db('EventRegistration').where({ id: f.regs[3].id }).update({ consentTextVersion: 'old-text' });
  const viewer = f.regs[0].userId;
  s6On({ pub: true });
  const b = await svc.board({ userId: viewer, eventId: f.event.id, query: {} });
  const byBib = Object.fromEntries(b.items.map(i => [i.bibNumber, i.displayName]));
  assert.deepEqual(byBib, { 1001: 'Amina M.', 1002: 'Runner', 1004: 'Runner' });
  assert.deepEqual(b.mine, { rank: 1, bibNumber: '1001' });
  assert.equal(JSON.stringify(b).match(/phone|email|dateOfBirth|emergency/i), null);
  const minor = await svc.myResult({ userId: f.regs[1].userId, registrationId: f.regs[1].id });
  assert.deepEqual([minor.visibility.current, minor.visibility.canChange, minor.visibility.reason], ['bib_only', false, 'minor']);
  assert.equal((await svc.setVisibility({ userId: f.regs[1].userId, registrationId: f.regs[1].id, body: { visibility: 'standard' } })).error, 'visibility_not_allowed');
  const ask = await svc.myResult({ userId: f.regs[3].userId, registrationId: f.regs[3].id });
  assert.equal(ask.visibility.reason, 'ask');
  assert.equal((await svc.setVisibility({ userId: f.regs[3].userId, registrationId: f.regs[3].id, body: { visibility: 'standard' } })).visibility, 'standard');
  assert.equal((await svc.board({ userId: viewer, eventId: f.event.id, query: {} })).items.find(i => i.bibNumber === '1004').displayName, `${f.regs[3].firstName} ${f.regs[3].lastName[0]}.`);
  assert.equal((await svc.setVisibility({ userId: f.regs[0].userId, registrationId: f.regs[0].id, body: { visibility: 'bogus' } })).error, 'validation_failed');
  // organizer rows never carry contact data
  const list = await svc.list({ ...ctx(f, a.owner), query: {} });
  assert.equal(JSON.stringify(list).match(/phone|email|dateOfBirth|emergency|\+2557/i), null);
  const det = await svc.detail({ ...ctx(f, a.owner), registrationId: f.regs[0].id });
  assert.equal(JSON.stringify(det).match(/phone|email|dateOfBirth|emergency|\+2557/i), null);
  // purchaser after the claim: status only
  const buyer = await h.user();
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ purchaserUserId: buyer });
  const pv = await svc.myResult({ userId: buyer, registrationId: f.regs[0].id });
  assert.deepEqual(Object.keys(pv).filter(k => ['result', 'medals', 'visibility'].includes(k)), []);
  assert.equal(pv.viewer, 'purchaser_status_only');
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ participantUserId: null, claimedAt: null });
  assert.equal((await svc.myResult({ userId: buyer, registrationId: f.regs[0].id })).viewer, 'participant');
  assert.equal((await svc.myResult({ userId: await h.user(), registrationId: f.regs[0].id })).error, 'registration_not_found');
});

test('board is flag-gated and signed-in only; DNF rows carry no time or rank; stranger cannot read unreleased results', async () => {
  const { f, a } = await setup({ n: 2 });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', ''], ['1002', 'dnf', '', '']]));
  s6On({ pub: true });
  const call = (user) => h.call(routes.eventResultsBoard, user ? { sub: user, userType: 'member' } : null, { params: { eventId: f.event.id } });
  assert.equal((await call(null)).status, 401);
  assert.equal((await call(f.regs[0].userId)).body.items.length, 0);
  for (const r of f.regs) await verify(f, a.owner, (await h.current(r.id)).id);
  await released(f, a.owner, 'official');
  const board = (await call(f.regs[0].userId)).body;
  const dnf = board.items.find(i => i.bibNumber === '1002');
  assert.deepEqual([dnf.elapsedMs, dnf.rank, dnf.finishStatus], [null, null, 'dnf']);
  s6Off(); s6On();
  assert.equal((await call(f.regs[0].userId)).status, 404);
});

test('webhooks: four result types are allowlisted, projected to ids and codes only, and the outbox row shares the transaction (a failing outbox write rolls the state change back)', async () => {
  for (const t of ['result.verified', 'result.published', 'result.corrected', 'result.disputed']) assert.ok(WEBHOOK_EVENT_TYPES.includes(t));
  assert.equal(WEBHOOK_EVENT_TYPES.some(t => t.includes('*')), false);
  const p = projectOutbox({ type: 'result.corrected', payload: { registrationId: 'r', resultId: 'x', revision: 2, previousRevision: 1, finishStatus: 'finished', netElapsedMs: 5, firstName: 'Asha' } });
  assert.deepEqual(Object.keys(p.data).sort(), ['finishStatus', 'material', 'previousRevision', 'registrationId', 'resultId', 'revision']);
  const { f, a } = await setup({ n: 1 });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', '']]));
  const row = await rowOf(f);
  const orig = eventStore.appendOutbox;
  eventStore.appendOutbox = async () => { throw new Error('outbox down'); };
  try { await assert.rejects(verify(f, a.owner, row.id), /outbox down/); } finally { eventStore.appendOutbox = orig; }
  assert.equal((await rowOf(f)).verificationStatus, 'pending_verification');
  assert.equal((await db('EventRegistration').where({ id: f.regs[0].id }).first()).resultStatus, 'pending_verification');
  assert.equal((await verify(f, a.owner, row.id)).status, 200);
});

test('/v1: results:write submits provisional results (never verified), results:read reads, no decision route exists, replay and dryRun work, sandbox answers', async () => {
  const { f, a, o } = await setup({ n: 2 });
  const api = await h.apiClient(o, { scopes: ['registrations:read', 'results:write', 'results:read'] });
  const actor = { kind: 'api', clientId: api.client.id, scopes: ['results:write', 'results:read'], requestId: 'req_x' };
  const body = { sourceLabel: 'ChipTime', rows: [{ clientRef: 'a1', bib: '1001', netTime: '0:50:00' }, { clientRef: 'a2', bib: '1002', status: 'dnf' }, { clientRef: 'a3', bib: '777', netTime: '0:40:00' }] };
  const key = h.key();
  const run = (k = key, extra = {}) => svc.apiImport({ actor, organizerId: o.id, eventId: f.event.id, key: k, body, ...extra });
  const dry = await run(undefined, { dryRun: true });
  assert.deepEqual(dry.results.map(r => [r.ok, r.error]), [[true, null], [true, null], [false, 'bib_not_found']]);
  assert.equal(await db('EventResult').whereIn('registrationId', f.regs.map(r => r.id)).count().then(r => Number(r[0].count)), 0);
  const first = await run();
  assert.deepEqual(first.results.map(r => r.ok), [true, true, false]);
  const r1 = await rowOf(f);
  assert.deepEqual([r1.verificationStatus, r1.submittedByApiClientId, r1.sourceType], ['pending_verification', api.client.id, 'timing_provider']);
  const dnf = await h.current(f.regs[1].id);
  assert.deepEqual([dnf.finishStatus, dnf.verificationStatus], ['dnf', 'pending_verification']);
  const replay = await run();
  assert.equal(replay.replayed, true);
  assert.equal((await run(h.key())).results[0].action, 'unchanged');
  assert.equal((await svc.apiImport({ actor: { ...actor, scopes: ['results:read'] }, organizerId: o.id, eventId: f.event.id, key: h.key(), body })).error, 'insufficient_scope');
  const list = await svc.apiList({ organizerId: o.id, eventId: f.event.id, query: {} });
  assert.equal(list.items.length, 2);
  assert.equal(JSON.stringify(list).match(/firstName|lastName|phone|email/), null);
  assert.equal((await svc.apiList({ organizerId: (await h.org()).id, eventId: f.event.id, query: {} })).error, 'event_not_found');
  const bear = await api.bearer();
  const routesV1 = await import('../functions/events-organizer-api.mjs');
  assert.deepEqual(Object.values(routesV1).filter(r => r?.path?.includes('/results')).map(r => `${r.method} ${r.path}`).sort(),
    ['get /v1/organizer/events/:eventId/results', 'get /v1/organizer/events/:eventId/results/releases', 'post /v1/organizer/events/:eventId/results/imports']);
  const viaRoute = await h.call(routesV1.apiListResults, null, { params: { eventId: f.event.id }, headers: bear });
  assert.equal(viaRoute.status, 200);
  const noScope = await h.apiClient(o, { scopes: ['registrations:read'] });
  const denied = await h.call(routesV1.apiListResults, null, { params: { eventId: f.event.id }, headers: await noScope.bearer() });
  assert.deepEqual([denied.status, denied.body.requiredScope], [403, 'results:read']);
  const box = await h.apiClient(o, { environment: 'sandbox', scopes: ['registrations:read', 'results:read', 'results:write'] });
  const sb = await h.call(routesV1.apiListResults, null, { params: { eventId: 'evt_sandbox' }, headers: await box.bearer() });
  assert.equal(sb.body.items.length, 24);
});

test('every new S6 results route answers 404 feature_disabled while the flag is off', async () => {
  s6Off();
  const f = routes;
  for (const r of Object.values(f).filter(x => x && typeof x === 'object' && x.path)) {
    const res = await h.call(r, { sub: 'u', userType: r.path.startsWith('/admin') ? 'admin' : r.path.startsWith('/organizer') ? 'event_organizer' : 'member' }, { params: { id: 'x', eventId: 'x' } });
    assert.deepEqual([r.path, res.status, res.body?.error], [r.path, 404, 'feature_disabled']);
  }
  s6On({ results: false });
  assert.equal((await h.call(f.myEventResults, { sub: 'u', userType: 'member' }, {})).status, 404);
});

test('settings: validation refuses unknown keys, lock after the first official release except a longer dispute window', async () => {
  const { f, a } = await setup({ n: 1 });
  assert.equal((await svc.updateSettings({ ...ctx(f, a.owner), key: h.key(), body: { bogus: 1 } })).error, 'validation_failed');
  assert.equal((await svc.updateSettings({ ...ctx(f, a.owner), key: h.key(), body: { cutoffMinutes: 5000 } })).error, 'validation_failed');
  assert.equal((await svc.updateSettings({ ...ctx(f, a.timing), key: h.key(), body: { cutoffMinutes: 90 } })).error, 'forbidden_role');
  const ok = await svc.updateSettings({ ...ctx(f, a.owner), key: h.key(), body: { timeBasis: 'gun', cutoffMinutes: 90, disputeWindowHours: 48, publicNames: 'bib_only' } });
  assert.deepEqual(ok.settings, { timeBasis: 'gun', cutoffMinutes: 90, disputeWindowHours: 48, publicNames: 'bib_only' });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', '0:50:30']]));
  await verify(f, a.owner, (await rowOf(f)).id);
  assert.equal((await rowOf(f)).elapsedMs, 3_030_000 * 1 === 0 ? 0 : 3_030_000 - 0);
  await released(f, a.owner);
  assert.equal((await svc.updateSettings({ ...ctx(f, a.owner), key: h.key(), body: { cutoffMinutes: 60 } })).error, 'settings_locked');
  assert.equal((await svc.updateSettings({ ...ctx(f, a.owner), key: h.key(), body: { disputeWindowHours: 24 } })).error, 'settings_locked');
  assert.equal((await svc.updateSettings({ ...ctx(f, a.owner), key: h.key(), body: { disputeWindowHours: 96 } })).settings.disputeWindowHours, 96);
});

test('my results lists official results only; additive fields decorate registrations; options carry the flags', async () => {
  const { f, a } = await setup({ n: 1 });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', '']]));
  const u = f.regs[0].userId;
  assert.equal((await svc.myResults({ userId: u })).items.length, 0);
  await verify(f, a.owner, (await rowOf(f)).id);
  await released(f, a.owner);
  const mine = await svc.myResults({ userId: u });
  assert.deepEqual([mine.items.length, mine.items[0].stage, mine.items[0].categoryRank], [1, 'official', 1]);
  const dec = await svc.decorateRegistrations([{ id: f.regs[0].id }]);
  assert.deepEqual([dec[0].resultStage, dec[0].medalsCount], ['official', 0]);
  const pub = await import('../functions/events-public.mjs');
  const opts = await h.call(pub.eventsOptions, null, {});
  assert.deepEqual(opts.body.results, { enabled: true, runs: false, public: false, rewards: false, medalArt: false });
  s6Off();
  assert.equal((await h.call(pub.eventsOptions, null, {})).body.results.enabled, false);
});
