// Events S6 · B2 — run links: eligibility matrix, evidence vs virtual result, clientRef replay and repair, duplicate-route flag, privacy of the track.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import * as runs from '../functions/events-runs.mjs';
import { harness, s6On, s6Off, db, H } from './fixtures/events-s6.mjs';
import { activityService } from '../src/bootstrap/services.mjs';
import { analyseRun } from '../src/shared/events-run-checks.mjs';
import { sha256hex } from '../src/shared/events-results-rules.mjs';
import { fingerprintOf } from '../src/shared/events-ops-rules.mjs';

await ensureInit();
const h = harness();
const svc = (await import('../src/bootstrap/services.mjs')).eventsRunLinkService;
afterEach(() => { runs.resetEventsRunsLimits(); });
after(async () => { await h.cleanup(); await db.destroy(); });

/** A straight run north: a point every ~15 m at `speed` m/s from `startMs`, ~`meters` long. `lat0` shifts the route. */
function track({ startMs, meters, speed = 3, lat0 = -6.8, pauseAtM = null }) {
  const pts = []; const seg2 = [];
  const n = Math.round(meters / 15);
  let t = startMs;
  for (let i = 0; i <= n; i += 1) {
    if (pauseAtM !== null && i * 15 > pauseAtM && seg2.length === 0) t += 120_000; // the pause sits BETWEEN the segments
    const p = [lat0 + (i * 15) / 111_320, 39.28, 10, t, 5];
    if (pauseAtM !== null && i * 15 > pauseAtM) seg2.push(p); else pts.push(p);
    t += (15 / speed) * 1000;
  }
  return seg2.length ? [pts, seg2] : [pts];
}
const key = () => h.key();
async function setup({ virtual = false, n = 2 } = {}) {
  s6On({ runs: true });
  const o = await h.org();
  const categories = [{ name: '5K', distanceMeters: 5000, tickets: [{ name: 'Std', priceTzs: 10000, capacity: 100 }] }, { name: '10K', distanceMeters: 10000, tickets: [{ name: 'Std', priceTzs: 20000, capacity: 100 }] }];
  const f = await h.resultsEvent({ organizer: o, n, categories, eventOver: virtual ? { eventType: 'virtual' } : {} });
  return { o, f, a: h.actors(o), u: f.regs[0].userId, reg: f.regs[0] };
}
const record = async (userId, segments) => { const r = await activityService.recordRun(userId, { type: 'running', segments }); assert.ok(r.activity, `recordRun: ${JSON.stringify(r)}`); return r; };
const startOf = f => Date.now() - 1.5 * H;

test('analysis: time to the category distance excludes pauses, a copied route fingerprints identically, implausible pace is flagged', () => {
  const t = track({ startMs: 1_000_000, meters: 5200, pauseAtM: 2000 });
  const a = analyseRun(t, { categoryMeters: 5000 });
  assert.ok(Math.abs(a.elapsedMs - (5000 / 3) * 1000) < 3000, `elapsed ${a.elapsedMs}`);
  assert.equal(a.flags.length, 0);
  const copy = analyseRun(track({ startMs: 9_000_000, meters: 5200, pauseAtM: 2000 }), { categoryMeters: 5000 });
  assert.equal(copy.fingerprint, a.fingerprint);
  assert.notEqual(analyseRun(track({ startMs: 1, meters: 5200, lat0: -6.9 }), { categoryMeters: 5000 }).fingerprint, a.fingerprint);
  assert.ok(analyseRun(track({ startMs: 1, meters: 5200, speed: 8 }), { categoryMeters: 5000 }).flags.includes('implausible_pace'));
  assert.ok(analyseRun(track({ startMs: 1, meters: 3000 }), { categoryMeters: 5000 }).checks.distanceCoveragePct < 100);
});

test('in-person event: a run is EVIDENCE only, no result is created, the share setting is untouched, a link never makes an official time', async () => {
  const { f, u, reg } = await setup();
  const segs = track({ startMs: startOf(f), meters: 5100 });
  const out = await svc.createAndLink({ userId: u, registrationId: reg.id, body: { clientRef: 'cref-evidence-1', segments: segs, shareWith: { groups: true } } });
  assert.equal(out.status, 201, JSON.stringify(out));
  assert.equal(out.link.linkType, 'evidence');
  assert.equal(out.result, null);
  assert.equal(await db('EventResult').where({ registrationId: reg.id }).count().then(r => Number(r[0].count)), 0);
  assert.equal((await db('EventRegistration').where({ id: reg.id }).first()).resultStatus, 'not_submitted');
  const act = await db('Activity').where({ id: out.activity.id }).first();
  assert.deepEqual(act.shareWith, out.activity.shareWith);
  // the database refuses a GPS result without a link, and the service never writes one for a road event
  await assert.rejects(db('EventResult').insert({ id: 'eres_gps_x', registrationId: reg.id, sourceType: 'fitflex_gps', finishStatus: 'finished', elapsedMs: 1, verificationStatus: 'pending_verification', revision: 1 }), /eventresult_gps_link_check/);
});

test('virtual event: a run becomes a PENDING fitflex_gps result for the organizer; the organizer never sees the route; verify marks the link matched', async () => {
  const { f, a, u, reg, o } = await setup({ virtual: true });
  const out = await svc.createAndLink({ userId: u, registrationId: reg.id, body: { clientRef: 'cref-virtual-01', segments: track({ startMs: startOf(f), meters: 5100 }) } });
  assert.equal(out.status, 201, JSON.stringify(out));
  assert.equal(out.link.linkType, 'event_run');
  const row = await h.current(reg.id);
  assert.deepEqual([row.sourceType, row.verificationStatus, row.activityLinkId], ['fitflex_gps', 'pending_verification', out.link.id]);
  assert.ok(Math.abs(Number(row.elapsedMs) - 5000 / 3 * 1000) < 3000);
  const detail = await h.service.detail({ actor: a.owner, organizerId: o.id, eventId: f.event.id, registrationId: reg.id });
  assert.equal(detail.linkedRun.distanceMeters > 4900, true);
  assert.equal(JSON.stringify(detail).match(/segments|"lat"|"lng"|route"/i), null);
  const v = await h.service.verify({ actor: a.owner, organizerId: o.id, eventId: f.event.id, resultId: row.id, key: key(), body: { expectedRevision: 1 } });
  assert.equal(v.status, 200);
  assert.equal((await db('EventActivityLink').where({ id: out.link.id }).first()).matchStatus, 'matched');
  assert.equal((await svc.unlink({ userId: u, registrationId: reg.id, linkId: out.link.id })).error, 'link_locked');
});

test('virtual: unlink until verified rejects the pending result (replaced_by_participant) and allows a new run; one live run per registration', async () => {
  const { f, u, reg } = await setup({ virtual: true });
  const first = await svc.createAndLink({ userId: u, registrationId: reg.id, body: { clientRef: 'cref-virtual-a1', segments: track({ startMs: startOf(f), meters: 5100 }) } });
  const second = await svc.createAndLink({ userId: u, registrationId: reg.id, body: { clientRef: 'cref-virtual-a2', segments: track({ startMs: startOf(f) + 3_600_000, meters: 5100, lat0: -6.7 }) } });
  assert.equal(second.error, 'run_already_linked');
  assert.equal(await db('Activity').where({ userId: u }).count().then(r => Number(r[0].count)), 1);
  assert.equal((await svc.unlink({ userId: u, registrationId: reg.id, linkId: first.link.id })).status, 200);
  const rej = await h.current(reg.id);
  assert.deepEqual([rej.verificationStatus, rej.reasonCode], ['rejected', 'replaced_by_participant']);
  const again = await svc.createAndLink({ userId: u, registrationId: reg.id, body: { clientRef: 'cref-virtual-a3', segments: track({ startMs: startOf(f) + 3_600_000, meters: 5100, lat0: -6.7 }) } });
  assert.equal(again.status, 201, JSON.stringify(again));
  assert.equal((await h.current(reg.id)).revision, 2);
  assert.equal((await db('EventActivityLink').where({ id: first.link.id }).first()).unlinkedReason, 'participant');
});

test('eligibility matrix: window, distance tolerance, source, owner, participant, state, limits', async () => {
  const { f, u, reg } = await setup({ virtual: true, n: 3 });
  const link = (userId, registrationId, activityId, k = key()) => svc.linkExisting({ userId, registrationId, key: k, body: { activityId } });
  const good = (await record(u, track({ startMs: startOf(f), meters: 5100 }))).activity;
  // window: before the event started (virtual: must START inside)
  const early = (await record(u, track({ startMs: +new Date(f.event.startsAt) - 3 * H, meters: 5100, lat0: -6.6 }))).activity;
  const e = await link(u, reg.id, early.id);
  assert.deepEqual([e.status, e.error, Object.keys(e.window)], [422, 'run_outside_window', ['startsAt', 'endsAt']]);
  // distance: 4,000 m for a 5K needs 4,900
  const short = (await record(u, track({ startMs: startOf(f), meters: 4000, lat0: -6.5 }))).activity;
  const s = await link(u, reg.id, short.id);
  assert.deepEqual([s.error, s.requiredMeters, s.measuredMeters > 3900], ['distance_too_short', 4900, true]);
  // 2 % tolerance: 4,930 m passes
  const edge = (await record(u, track({ startMs: startOf(f), meters: 4950, lat0: -6.4 }))).activity;
  assert.equal((await link(u, reg.id, edge.id)).status, 201);
  assert.equal((await svc.unlink({ userId: u, registrationId: reg.id, linkId: (await db('EventActivityLink').where({ registrationId: reg.id }).first()).id })).status, 200);
  // source and type
  for (const [source, type] of [['manual', 'running'], ['device', 'running'], ['fitflex', 'walking']]) {
    const id = `act_spec_${source}_${type}`;
    await db('Activity').insert({ id, userId: u, type, source, startedAt: new Date(startOf(f)), hasRoute: true, shareWith: JSON.stringify({}), createdAt: new Date() });
    assert.equal((await link(u, reg.id, id)).error, 'activity_not_recorded_in_app', `${source}/${type}`);
  }
  // somebody else's run, a stranger's registration, an unconfirmed place
  const theirs = (await record(f.regs[1].userId, track({ startMs: startOf(f), meters: 5100, lat0: -6.3 }))).activity;
  assert.equal((await link(u, reg.id, theirs.id)).error, 'activity_not_found');
  assert.equal((await link(f.regs[1].userId, reg.id, theirs.id)).error, 'registration_not_found');
  assert.equal((await link(u, reg.id, 'act_missing')).error, 'activity_not_found');
  await db('EventRegistration').where({ id: f.regs[2].id }).update({ status: 'cancelled', cancelledAt: new Date() });
  assert.equal((await link(f.regs[2].userId, f.regs[2].id, good.id)).error, 'registration_not_confirmed');
  // the same activity cannot be the run of two registrations
  assert.equal((await link(u, reg.id, good.id)).status, 201);
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ participantUserId: u });
  assert.equal((await link(u, f.regs[1].id, good.id)).error, 'activity_already_linked');
  // revoked ticket
  await db('EventTicket').where({ registrationId: reg.id }).update({ status: 'revoked', revokedAt: new Date(), revokeReason: 'admin' });
  assert.equal((await link(u, reg.id, good.id)).error, 'ticket_revoked');
  // event cancelled
  await db('EventTicket').where({ registrationId: reg.id }).update({ status: 'active', revokedAt: null, revokeReason: null });
  await db('Event').where({ id: f.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  assert.equal((await svc.createAndLink({ userId: u, registrationId: reg.id, body: { clientRef: 'cref-cancelled-1', segments: track({ startMs: startOf(f), meters: 5100 }) } })).error, 'event_cancelled');
});

test('in-person windows: 2 h before to 12 h after; at most three evidence runs; duplicates refused; linking closes after the grace', async () => {
  const { f, u, reg } = await setup();
  const mk = async (offsetMs, lat0) => (await record(u, track({ startMs: offsetMs, meters: 1200, lat0 }))).activity;
  const start = +new Date(f.event.startsAt);
  const before = await mk(start - 3 * H, -6.1);
  const w = await svc.linkExisting({ userId: u, registrationId: reg.id, key: key(), body: { activityId: before.id } });
  assert.equal(w.error, 'run_outside_window');
  const ids = [];
  for (let i = 0; i < 3; i += 1) { const a = await mk(start + (i + 1) * 600_000, -6.2 - i / 100); ids.push(a.id); assert.equal((await svc.linkExisting({ userId: u, registrationId: reg.id, key: key(), body: { activityId: a.id } })).status, 201); }
  assert.equal((await svc.linkExisting({ userId: u, registrationId: reg.id, key: key(), body: { activityId: ids[0] } })).error, 'activity_already_linked');
  const fourth = await mk(start + 4 * 600_000, -6.0);
  assert.equal((await svc.linkExisting({ userId: u, registrationId: reg.id, key: key(), body: { activityId: fourth.id } })).error, 'evidence_limit');
  const links = await svc.list({ userId: u, registrationId: reg.id });
  assert.equal(links.items.length, 3);
  assert.equal((await svc.unlink({ userId: u, registrationId: reg.id, linkId: links.items[0].id })).status, 200);
  assert.equal((await svc.linkExisting({ userId: u, registrationId: reg.id, key: key(), body: { activityId: fourth.id } })).status, 201);
  await db('Event').where({ id: f.event.id }).update({ endsAt: new Date(Date.now() - 9 * 86_400_000), startsAt: new Date(Date.now() - 9.2 * 86_400_000) });
  const late = (await record(u, track({ startMs: Date.now() - 2 * H, meters: 1200, lat0: -5.9 }))).activity;
  assert.equal((await svc.linkExisting({ userId: u, registrationId: reg.id, key: key(), body: { activityId: late.id } })).error, 'linking_closed');
});

test('clientRef: replay returns the first answer, a different body is idempotency_key_reused, a crash between the claim and recordRun is repaired by replay', async () => {
  const { f, u, reg } = await setup();
  const segs = track({ startMs: startOf(f), meters: 5100 });
  const body = { clientRef: 'cref-replay-001', segments: segs };
  const first = await svc.createAndLink({ userId: u, registrationId: reg.id, body });
  assert.equal(first.status, 201);
  const replay = await svc.createAndLink({ userId: u, registrationId: reg.id, body });
  assert.deepEqual([replay.status, replay.replayed, replay.link.id, replay.activity.id], [200, true, first.link.id, first.activity.id]);
  assert.equal(await db('Activity').where({ userId: u }).count().then(r => Number(r[0].count)), 1);
  const other = await svc.createAndLink({ userId: u, registrationId: reg.id, body: { ...body, segments: track({ startMs: startOf(f), meters: 5300 }) } });
  assert.equal(other.error, 'idempotency_key_reused');
  // crash: the claim row exists, nothing was recorded
  const reg2 = f.regs[1];
  const segs2 = track({ startMs: startOf(f) + 1000, meters: 5100, lat0: -6.45 });
  await db('EventActivityLink').insert({ id: 'eal_spec_crash1', registrationId: reg2.id, linkType: 'evidence', matchStatus: 'pending', clientRef: 'cref-crash-0001', requestSha256: sha256hex(fingerprintOf({ segments: segs2, notes: null, shareWith: null })) });
  const repaired = await svc.createAndLink({ userId: reg2.userId, registrationId: reg2.id, body: { clientRef: 'cref-crash-0001', segments: segs2 } });
  assert.equal(repaired.status, 201, JSON.stringify(repaired));
  assert.equal(repaired.link.id, 'eal_spec_crash1');
  assert.equal(await db('Activity').where({ userId: reg2.userId }).count().then(r => Number(r[0].count)), 1);
  // a refused run (outside the window) records nothing and leaves no claim row
  const refused = await svc.createAndLink({ userId: reg2.userId, registrationId: reg2.id, body: { clientRef: 'cref-refused-01', segments: track({ startMs: Date.now() - 5 * 86_400_000, meters: 5100 }) } });
  assert.equal(refused.error, 'run_outside_window');
  assert.equal(await db('EventActivityLink').where({ clientRef: 'cref-refused-01' }).count().then(r => Number(r[0].count)), 0);
  assert.equal((await svc.createAndLink({ userId: u, registrationId: reg.id, body: { clientRef: 'x', segments: segs } })).error, 'validation_failed');
});

test('a copied run is flagged on BOTH links without naming either runner, and flagged runs are kept out of bulk approval', async () => {
  s6On({ runs: true });
  const o = await h.org();
  const f = await h.resultsEvent({ organizer: o, n: 2, categories: [{ name: '5K', distanceMeters: 5000, tickets: [{ name: 'Std', priceTzs: 10000, capacity: 100 }] }], eventOver: { eventType: 'virtual' } });
  const a = h.actors(o);
  const segs = track({ startMs: Date.now() - 1.5 * H, meters: 5100 });
  const one = await svc.createAndLink({ userId: f.regs[0].userId, registrationId: f.regs[0].id, body: { clientRef: 'cref-dupe-0001', segments: segs } });
  assert.deepEqual(one.link.flags, []);
  const two = await svc.createAndLink({ userId: f.regs[1].userId, registrationId: f.regs[1].id, body: { clientRef: 'cref-dupe-0002', segments: segs.map(s => s.map(p => [...p])) } });
  assert.ok(two.link.flags.includes('duplicate_route'));
  assert.equal(JSON.stringify(two).includes(f.regs[0].userId), false);
  const mine = await svc.list({ userId: f.regs[0].userId, registrationId: f.regs[0].id });
  assert.ok(mine.items[0].flags.includes('duplicate_route'));
  const pv = await h.service.bulkPreview({ actor: a.owner, organizerId: o.id, eventId: f.event.id, body: {} });
  assert.deepEqual([pv.count, pv.excludedFlagged], [0, 2]);
  const list = await h.service.list({ actor: a.owner, organizerId: o.id, eventId: f.event.id, query: { flag: 'duplicate_route' } });
  assert.equal(list.total, 2);
});

test('rate limit: ten link attempts a day per person', async () => {
  const { f, u, reg } = await setup();
  for (let i = 0; i < 10; i += 1) await db('EventActivityLink').insert({ id: `eal_spec_rl${i}`, registrationId: reg.id, linkType: 'evidence', matchStatus: 'pending', createdAt: new Date() });
  const a = (await record(u, track({ startMs: startOf(f), meters: 1200, lat0: -5.5 }))).activity;
  assert.equal((await svc.linkExisting({ userId: u, registrationId: reg.id, key: key(), body: { activityId: a.id } })).error, 'rate_limited');
});

test('routes answer 404 feature_disabled unless EVENTS_RUNS (and results) are on, and need Idempotency-Key on the link-existing route', async () => {
  const { f, u, reg } = await setup();
  const claims = { sub: u, userType: 'member' };
  const a = (await record(u, track({ startMs: startOf(f), meters: 1200, lat0: -5.4 }))).activity;
  const noKey = await h.call(runs.linkEventRun, claims, { params: { id: reg.id }, body: { activityId: a.id } });
  assert.deepEqual([noKey.status, noKey.body.error], [400, 'idempotency_key_required']);
  const ok = await h.call(runs.linkEventRun, claims, { params: { id: reg.id }, body: { activityId: a.id }, headers: { 'Idempotency-Key': 'spec-key-0001' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const replay = await h.call(runs.linkEventRun, claims, { params: { id: reg.id }, body: { activityId: a.id }, headers: { 'Idempotency-Key': 'spec-key-0001' } });
  assert.deepEqual([replay.status, replay.body.link.id], [200, ok.body.link.id]);
  for (const mode of ['runsOff', 'resultsOff']) {
    s6Off(); s6On({ runs: mode === 'resultsOff', results: mode !== 'resultsOff' });
    for (const r of Object.values(runs).filter(x => x?.path)) assert.equal((await h.call(r, claims, { params: { id: reg.id, linkId: 'x' } })).status, 404, `${mode} ${r.path}`);
  }
});
