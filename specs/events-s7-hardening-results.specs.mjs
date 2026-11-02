// Marathon & running events · S7 (B4) — the results and rewards side of the hardening: the per-event reward switch (H6), the admin dispute list (H10),
// the redemptions list (H11), the correction preview (H12) and the medal-art take-down read (H13). docs/design/events-s7-hardening-and-pilot.md §6.1.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import { adminSetRewardsEligible } from '../functions/events-admin-s7.mjs';
import { adminResultDisputes, organizerCorrectPreview } from '../functions/events-results.mjs';
import { adminListRewardRedemptions } from '../functions/events-admin-rewards.mjs';
import { harness, s6On, s6Off, db } from './fixtures/events-s6.mjs';
import { eventsAwardService as awards, eventsRewardService as rewards, eventsMedalService as medals } from '../src/bootstrap/services.mjs';

await ensureInit();
const h = harness();
const svc = h.service;
afterEach(() => { s6Off(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const ctx = (f, actor) => ({ actor, organizerId: f.organizer.id, eventId: f.event.id });
const name = en => ({ en, sw: `${en} (sw)` });
const call = (route, claims, req) => h.call(route, claims, req);
async function setup({ n = 4 } = {}) {
  s6On({ rewards: true });
  const o = await h.org();
  const f = await h.resultsEvent({ organizer: o, n, m: 0 });
  return { o, f, a: h.actors(o) };
}
async function official(f, a, rows) {
  await h.importCsv(f, a.owner, h.csvOf(rows.map(([bib, net]) => [bib, 'finished', net, ''])));
  for (const [bib] of rows) {
    const reg = [...f.all].find(r => r.bib === bib);
    const row = await h.current(reg.id);
    assert.equal((await svc.verify({ ...ctx(f, a.owner), resultId: row.id, key: h.key(), body: { expectedRevision: row.revision } })).status, 200);
  }
  const body = { stage: 'official', leaveUnsettledOut: true };
  const p = await svc.releasePreview({ ...ctx(f, a.owner), body });
  const r = await svc.release({ ...ctx(f, a.owner), key: h.key(), body: { ...body, previewHash: p.previewHash } });
  assert.equal(r.status, 200, JSON.stringify(r));
}
const defOf = async (body) => { const out = await rewards.createDefinition({ actor: { userId: 'adm' }, body: { title: name('Certificate'), terms: name('Show this in the app'), fundingNote: 'FitFlex', redeemMode: 'certificate', status: 'active', ...body } }); assert.equal(out.status, 201, JSON.stringify(out)); return out.definition; };
const drain = async () => { let r; do { r = await awards.runBatch(); } while (r.claimed); };
const ledger = (userId, defId) => db('RewardLedgerEntry').where({ userId, rewardDefinitionId: defId });

test('H6: medals are awarded either way, but a reward is EARNED only for an event FitFlex marked rewardsEligible (default false); the switch is audited, needs a reason and tells the organizer', async () => {
  const { o, f, a } = await setup({ n: 2 });
  const def = await defOf({ triggerType: 'event_finish', title: name('Finisher certificate') });
  const t = await medals.create({ ...ctx(f, a.owner), key: h.key(), body: { name: name('Finisher') } });
  assert.equal(t.status, 201);
  await db('Event').where({ id: f.event.id }).update({ rewardsEligible: false });
  await official(f, a, [['1001', '0:50:00'], ['1002', '0:51:00']]);
  await drain();
  const u = f.regs[0].userId;
  assert.equal((await db('EventMedalAward').where({ registrationId: f.regs[0].id, awardStatus: 'awarded' })).length, 1, 'the medal is unaffected');
  assert.equal((await ledger(u, def.id)).length, 0, 'no reward while the event is not eligible');
  const admin = await h.superAdmin();
  const post = (body, claims = admin) => call(adminSetRewardsEligible, claims, { params: { id: f.event.id }, body });
  assert.equal((await post({ eligible: 'yes', reason: 'A long enough reason' })).status, 422);
  assert.equal((await post({ eligible: true, reason: 'short' })).body.error, 'reason_required');
  const on = await post({ eligible: true, reason: 'Organizer verified, event is genuine', reasonSw: 'Mwandaaji amethibitishwa, tukio ni halisi' });
  assert.deepEqual([on.status, on.body], [200, { rewardsEligible: true, changed: true }]);
  assert.deepEqual((await post({ eligible: true, reason: 'Organizer verified, event is genuine' })).body, { rewardsEligible: true, changed: false });
  assert.equal((await db('AuditLog').where({ action: 'events.rewards_eligible_changed', target: f.event.id })).length, 1);
  assert.equal((await h.notifications(o.ownerUserId, 'organizer_rewards_eligibility_changed')).length, 1);
  // the next evaluation of the standing earns the reward
  await db('EventAwardTask').insert({ id: `eat_${Math.random().toString(36).slice(2, 12)}`, eventId: f.event.id, registrationId: f.regs[0].id, reason: 'spec', state: 'pending', runAfter: new Date(), createdAt: new Date() }).catch(async () => {
    await db('EventAwardTask').insert({ id: `eat_${Math.random().toString(36).slice(2, 12)}`, eventId: f.event.id, registrationId: f.regs[0].id, reason: 'result_changed', state: 'pending', runAfter: new Date(), createdAt: new Date() });
  });
  await drain();
  assert.equal((await ledger(u, def.id)).length, 1, 'eligible now: the reward is earned');
  await post({ eligible: false, reason: 'Switched off again for the test run' });
  assert.equal((await db('Event').where({ id: f.event.id }).first()).rewardsEligible, false);
  assert.equal((await post({ eligible: true, reason: 'Organizer verified, event is genuine' }, { sub: admin.sub, userType: 'admin', portalUser: true, aclPermissions: ['users'] })).status, 403);
  s6Off();
  assert.equal((await post({ eligible: true, reason: 'Organizer verified, event is genuine' })).status, 404, 'needs EVENTS_REWARDS');
});

test('H10: the admin dispute list: open by default, adminMayResolve after 7 days or when the organizer is not active, filters, counts', async () => {
  const { o, f, a } = await setup({ n: 2 });
  await official(f, a, [['1001', '0:50:00'], ['1002', '0:51:00']]);
  const d = await svc.raiseDispute({ userId: f.regs[0].userId, registrationId: f.regs[0].id, body: { reasonCode: 'time_wrong', note: 'My watch says 49:00' } });
  assert.equal(d.status, 201, JSON.stringify(d));
  const admin = await h.superAdmin();
  const list = (query = {}, claims = admin) => call(adminResultDisputes, claims, { query });
  const first = await list();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const mine = first.body.items.find(i => i.id === d.dispute.id);
  assert.deepEqual([mine.eventId, mine.status, mine.adminMayResolve, mine.ageDays], [f.event.id, 'open', false, 0]);
  assert.ok(mine.organizerName && mine.eventTitle);
  assert.ok(!/note|phone|email|userId|registrationId/.test(JSON.stringify(mine)), 'no personal data in the row');
  await db('EventResultDispute').where({ id: d.dispute.id }).update({ createdAt: new Date(Date.now() - 8 * 86_400_000) });
  const aged = (await list()).body;
  assert.deepEqual([aged.items.find(i => i.id === d.dispute.id).adminMayResolve, aged.items.find(i => i.id === d.dispute.id).ageDays], [true, 8]);
  assert.ok(aged.counts.olderThan7Days >= 1);
  assert.ok((await list({ olderThanDays: '7' })).body.items.some(i => i.id === d.dispute.id));
  assert.ok(!(await list({ olderThanDays: '30' })).body.items.some(i => i.id === d.dispute.id));
  await db('EventResultDispute').where({ id: d.dispute.id }).update({ createdAt: new Date() });
  await db('EventOrganizer').where({ id: o.id }).update({ status: 'suspended', statusReason: 'spec' });
  const inactive = (await list({ organizerStatus: 'suspended' })).body;
  assert.equal(inactive.items.find(i => i.id === d.dispute.id).adminMayResolve, true);
  assert.ok(inactive.counts.organizerInactive >= 1);
  await db('EventOrganizer').where({ id: o.id }).update({ status: 'active', statusReason: null });
  assert.equal((await list({ olderThanDays: 'abc' })).status, 422);
  assert.equal((await list({}, { sub: admin.sub, userType: 'admin', portalUser: true, aclPermissions: ['users'] })).status, 403);
  assert.deepEqual((await list({ status: 'upheld' })).body.items.filter(i => i.id === d.dispute.id), []);
});

test('H11: recent redemptions for the reward desk: a masked person, the reward, the code STATE and times; never a code, a hash or a user id', async () => {
  const { f, a } = await setup({ n: 2 });
  const perk = await defOf({ triggerType: 'event_finish', redeemMode: 'perk', title: name('Free drink') });
  await db('Event').where({ id: f.event.id }).update({ rewardsEligible: true });
  await official(f, a, [['1001', '0:50:00'], ['1002', '0:51:00']]);
  await drain();
  const claimed = await rewards.claim({ userId: f.regs[0].userId, key: h.key(), body: { rewardDefinitionId: perk.id } });
  assert.equal(claimed.status, 201, JSON.stringify(claimed));
  const admin = await h.superAdmin();
  const out = await call(adminListRewardRedemptions, admin, { query: {} });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const row = out.body.items.find(i => i.id === claimed.redemption.id);
  assert.deepEqual([row.codeState, row.reward.en, row.redeemMode], ['reserved', 'Free drink', 'perk']);
  assert.match(row.person, /^\S+ \S\.$/);
  const json = JSON.stringify(out.body);
  assert.ok(!json.includes(claimed.redemption.code), 'never the code');
  assert.ok(!/codeHash|"userId"|FFR-/.test(json));
  assert.ok((await call(adminListRewardRedemptions, admin, { query: { status: 'reserved' } })).body.items.some(i => i.id === row.id));
  assert.ok(!(await call(adminListRewardRedemptions, admin, { query: { status: 'redeemed' } })).body.items.some(i => i.id === row.id));
  assert.equal((await call(adminListRewardRedemptions, admin, { query: { status: 'nope' } })).status, 400);
  assert.equal((await call(adminListRewardRedemptions, admin, { query: { limit: '999' } })).status, 400);
});

test('H12: the correction preview shows the rank change, how many others shift and the medals re-evaluated, stores nothing, and the real correction then agrees', async () => {
  const { o, f, a } = await setup({ n: 3 });
  await medals.create({ ...ctx(f, a.owner), key: h.key(), body: { name: name('Finisher') } });
  await official(f, a, [['1001', '0:50:00'], ['1002', '0:51:00'], ['1003', '0:52:00']]);
  await drain();
  const row = await h.current(f.regs[2].id);
  assert.equal(row.categoryRank, 3);
  const body = { expectedRevision: row.revision, netTime: '0:49:00', reasonCode: 'timing_error', note: 'The chip read late at the line' };
  const owner = h.claimsOf(o.ownerUserId, 'event_organizer');
  const prev = await call(organizerCorrectPreview, owner, { params: { id: f.event.id, resultId: row.id }, body });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.deepEqual(prev.body.rankBefore, { overall: 3, category: 3 });
  assert.deepEqual(prev.body.rankAfter, { overall: 1, category: 1 });
  assert.equal(prev.body.othersShifted, 2);
  assert.ok(prev.body.medalsAffected >= 1);
  assert.equal(prev.body.revision, row.revision);
  // nothing was stored, queued, announced or audited
  const after = await h.current(f.regs[2].id);
  assert.deepEqual([after.revision, after.categoryRank, after.id], [row.revision, 3, row.id]);
  assert.equal((await db('EventResult').where({ registrationId: f.regs[2].id })).length, 1);
  assert.equal((await db('AuditLog').where({ action: 'events.result_corrected', target: f.event.id })).length, 0);
  assert.equal((await db('OutboxEvent').where({ eventId: f.event.id, type: 'result.corrected' })).length, 0);
  // the same body, really
  const real = await svc.correct({ ...ctx(f, a.owner), resultId: row.id, key: h.key(), body });
  assert.equal(real.status, 200, JSON.stringify(real));
  const fresh = await h.current(f.regs[2].id);
  assert.deepEqual([fresh.categoryRank, fresh.overallRank], [1, 1]);
  // errors are the real correction's errors, and the preview cannot be used by timing or ops
  assert.equal((await call(organizerCorrectPreview, owner, { params: { id: f.event.id, resultId: row.id }, body: { ...body, expectedRevision: 1 } })).body.error, 'result_changed');
  assert.equal((await call(organizerCorrectPreview, owner, { params: { id: f.event.id, resultId: fresh.id }, body: { ...body, expectedRevision: fresh.revision, netTime: '0:49:00' } })).body.error, 'no_change');
  assert.equal((await call(organizerCorrectPreview, owner, { params: { id: f.event.id, resultId: row.id }, body: { netTime: '0:48:00' } })).status, 422);
  assert.equal((await call(organizerCorrectPreview, o.timing, { params: { id: f.event.id, resultId: row.id }, body })).status, 403);
});

test('H13: a medal template says why the built-in design is shown after a FitFlex take-down; a live design says live; none says none', async () => {
  s6On({ rewards: true, medalArt: true });
  const o = await h.org();
  const f = await h.resultsEvent({ organizer: o, n: 1, m: 0 });
  const a = h.actors(o);
  const t = (await medals.create({ ...ctx(f, a.owner), key: h.key(), body: { name: name('Finisher') } })).template;
  assert.equal(t.art.status, 'none');
  assert.equal(t.art.takedown, undefined);
  const at = new Date();
  await db('EventMedalArt').insert({
    id: 'ema_h13spec', eventId: f.event.id, organizerId: o.id, templateId: t.id, status: 'taken_down', revision: 1, reviewState: 'reviewed', reason: 'rights', reasonNote: 'not theirs', decidedBy: 'adm', decidedAt: at,
    width: 800, height: 800, altText: '{}', confirmationVersion: 'v1', confirmedBy: o.ownerUserId, confirmedAt: at, uploadedBy: o.ownerUserId, sha256: 'a'.repeat(64), pixelSha256: 'b'.repeat(64), createdAt: at, updatedAt: at,
  });
  const listed = await medals.list({ ...ctx(f, a.owner) });
  const row = listed.items.find(i => i.id === t.id);
  assert.equal(row.art.source, 'builtin');
  assert.equal(row.art.status, 'taken_down');
  assert.deepEqual(row.art.takedown, { reasonCode: 'rights', at: at.toISOString() });
  assert.ok(!JSON.stringify(row).includes('not theirs'), 'the admin\'s private note is not exposed');
  await db('EventMedalArt').where({ id: 'ema_h13spec' }).del();
});
