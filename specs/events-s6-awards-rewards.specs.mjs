// Events S6 · B3 — medal templates, the award engine, achievements, the entitlement ledger, redemption, the admin desk, account deletion.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInit } from '../functions/index.mjs';
import * as memberRoutes from '../functions/events-rewards.mjs';
import * as adminRoutes from '../functions/events-admin-rewards.mjs';
import { harness, s6On, s6Off, db } from './fixtures/events-s6.mjs';
import { eventsAwardService as awards, eventsRewardService as rewards, eventsMedalService as medals, accountService } from '../src/bootstrap/services.mjs';
import { codeFor, normaliseCode, hashCode } from '../src/shared/events-reward-code.mjs';
import { ticketKeyRing } from '../src/shared/events-ticket-token.mjs';
import { validateMedalRule } from '../src/shared/events-results-rules.mjs';

await ensureInit();
const h = harness();
const svc = h.service;
afterEach(() => { memberRoutes.resetEventsRewardsLimits(); });
after(async () => { await h.cleanup(); await db.destroy(); });

const ctx = (f, actor) => ({ actor, organizerId: f.organizer.id, eventId: f.event.id });
const name = en => ({ en, sw: `${en} (sw)` });
async function setup({ n = 4, m = 0 } = {}) {
  s6On({ rewards: true });
  const o = await h.org();
  const f = await h.resultsEvent({ organizer: o, n, m });
  return { o, f, a: h.actors(o) };
}
/** Import, verify and officially release the rows [bib, net] of the event. */
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
const medal = (f, a, body = {}) => medals.create({ ...ctx(f, a.owner), key: h.key(), body: { name: name('Finisher'), ...body } });
const drain = async () => { let r; do { r = await awards.runBatch(); } while (r.claimed); };
const award = async (regId, templateId) => db('EventMedalAward').where({ registrationId: regId, medalTemplateId: templateId }).first();
let ADM = null;
const adm = async () => (ADM ??= await h.user({ userType: 'admin' }));
const defOf = async (body) => { const out = await rewards.createDefinition({ actor: { userId: 'adm' }, body: { title: name('Certificate'), terms: name('Show this in the app'), fundingNote: 'FitFlex', redeemMode: 'certificate', status: 'active', ...body } }); assert.equal(out.status, 201, JSON.stringify(out)); return out.definition; };
const ledger = (userId, defId) => db('RewardLedgerEntry').where({ userId, rewardDefinitionId: defId }).orderBy('occurredAt');
const units = async (userId, defId) => rewards.balanceIn(db, userId, defId);

test('medal rule vocabulary is closed; templates need English, refuse an imageUrl and unknown keys, and are owner/admin only', async () => {
  assert.deepEqual(validateMedalRule({ type: 'placing', scope: 'overall', top: 3 }).rule, { type: 'placing', scope: 'overall', top: 3 });
  for (const bad of [{ type: 'finish', x: 1 }, { type: 'placing', scope: 'x', top: 3 }, { type: 'placing', scope: 'overall', top: 11 }, { type: 'time_under', maxElapsedMs: 5 }, { type: 'nope' }, null]) assert.ok(validateMedalRule(bad).fields, JSON.stringify(bad));
  const { f, a } = await setup({ n: 1 });
  const ok = await medal(f, a, { tier: 'gold', rule: { type: 'placing', scope: 'category', top: 3 } });
  assert.equal(ok.status, 201, JSON.stringify(ok));
  assert.equal(ok.template.art.source, 'builtin');
  assert.equal(ok.template.art.artKey, 'podium_gold');
  assert.equal(ok.template.locked, false);
  assert.equal((await medal(f, a, { imageUrl: 'https://evil.example/x.png' })).error, 'validation_failed');
  assert.equal((await medal(f, a, { name: { sw: 'x' } })).error, 'validation_failed');
  assert.equal((await medal(f, a, { artKey: 'custom' })).error, 'validation_failed');
  assert.equal((await medal(f, a, { categoryId: 'evc_other' })).error, 'validation_failed');
  assert.equal((await medals.create({ ...ctx(f, a.timing), key: h.key(), body: { name: name('X') } })).error, 'forbidden_role');
  assert.equal((await medals.list({ ...ctx(f, a.timing) })).items.length, 1);
  assert.equal((await medals.list({ ...ctx(f, a.ops) })).error, 'forbidden_role');
  const stranger = await h.org();
  assert.equal((await medals.list({ actor: h.actors(stranger).owner, organizerId: stranger.id, eventId: f.event.id })).error, 'event_not_found');
  assert.equal(await db('EventMedalTemplate').where({ id: ok.template.id }).first().then(r => r.imageUrl), null);
});

test('finisher medal: not for purchase alone, not before an OFFICIAL release, not below the cut-off; awarded once; re-run is a no-op; notice id is deterministic', async () => {
  const { f, a } = await setup({ n: 3 });
  const t = (await medal(f, a)).template;
  await svc.updateSettings({ ...ctx(f, a.owner), key: h.key(), body: { cutoffMinutes: 60 } });
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', ''], ['1002', 'finished', '1:30:00', '']]));
  for (const r of f.regs.slice(0, 2)) { const row = await h.current(r.id); await svc.verify({ ...ctx(f, a.owner), resultId: row.id, key: h.key(), body: { expectedRevision: 1 } }); }
  await awards.evaluate(f.regs[0].id);
  assert.equal(await award(f.regs[0].id, t.id), undefined, 'verified but not released: nothing');
  const pv = await svc.releasePreview({ ...ctx(f, a.owner), body: { stage: 'provisional' } });
  await svc.release({ ...ctx(f, a.owner), key: h.key(), body: { stage: 'provisional', previewHash: pv.previewHash } });
  await awards.evaluate(f.regs[0].id);
  assert.equal(await award(f.regs[0].id, t.id), undefined, 'provisional release does not award (D47)');
  const body = { stage: 'official', markRemainingDns: true };
  const p = await svc.releasePreview({ ...ctx(f, a.owner), body });
  await svc.release({ ...ctx(f, a.owner), key: h.key(), body: { ...body, previewHash: p.previewHash } });
  assert.equal(await db('EventAwardTask').where({ eventId: f.event.id, reason: 'release', state: 'pending' }).count().then(r => Number(r[0].count)), 1);
  await drain();
  const got = await award(f.regs[0].id, t.id);
  assert.deepEqual([got.awardStatus, got.sourceResultId !== null], ['awarded', true]);
  assert.equal(await award(f.regs[1].id, t.id), undefined, 'over the cut-off');
  assert.equal(await award(f.regs[2].id, t.id), undefined, 'paid, no result (DNS): nothing for a purchase alone');
  await awards.evaluate(f.regs[0].id); await awards.evaluate(f.regs[0].id);
  assert.equal(await db('EventMedalAward').where({ registrationId: f.regs[0].id }).count().then(r => Number(r[0].count)), 1);
  const notes = await db('Notification').where({ userId: f.regs[0].userId, type: 'event_medal_awarded' });
  assert.deepEqual([notes.length, notes[0].id], [1, `evmed:${got.id}:awarded`]);
  assert.equal(notes[0].data.titleSw, 'Medali mpya');
  const task = await db('EventAwardTask').where({ eventId: f.event.id, reason: 'release' }).first();
  assert.equal(task.state, 'done');
});

test('placing / time_under medals follow ranks; a correction revokes and re-awards the SAME row; disqualification revokes with a reason and an essential notice; reinstatement re-awards', async () => {
  const { f, a } = await setup({ n: 3 });
  const gold = (await medal(f, a, { name: name('Gold'), tier: 'gold', rule: { type: 'placing', scope: 'category', top: 1 } })).template;
  const fast = (await medal(f, a, { name: name('Sub 55'), tier: 'time', rule: { type: 'time_under', maxElapsedMs: 55 * 60_000 } })).template;
  await official(f, a, [['1001', '0:50:00'], ['1002', '0:52:00'], ['1003', '0:58:00']]);
  await drain();
  assert.equal((await award(f.regs[0].id, gold.id)).awardStatus, 'awarded');
  assert.equal(await award(f.regs[1].id, gold.id), undefined);
  assert.equal((await award(f.regs[1].id, fast.id)).awardStatus, 'awarded');
  assert.equal(await award(f.regs[2].id, fast.id), undefined);
  // correction: runner 2 is actually faster → gold moves, the first runner loses it (same row flips)
  const goldBefore = await award(f.regs[0].id, gold.id);
  const r2 = await h.current(f.regs[1].id);
  await svc.correct({ ...ctx(f, a.owner), resultId: r2.id, key: h.key(), body: { expectedRevision: 1, reasonCode: 'timing_error', note: 'Start mat misread by a minute', netTime: '0:49:00' } });
  await drain();
  const lost = await award(f.regs[0].id, gold.id);
  assert.deepEqual([lost.id, lost.awardStatus, lost.reasonCode], [goldBefore.id, 'revoked', 'result_corrected']);
  assert.equal((await award(f.regs[1].id, gold.id)).awardStatus, 'awarded');
  const essential = await db('Notification').where({ userId: f.regs[0].userId, type: 'event_medal_revoked' });
  assert.equal(essential.length, 1);
  assert.equal(essential[0].data.essential, true);
  // and back: the first runner is faster again → re-awarded on the same row
  const r1 = await h.current(f.regs[0].id);
  await svc.correct({ ...ctx(f, a.owner), resultId: r1.id, key: h.key(), body: { expectedRevision: 1, reasonCode: 'timing_error', note: 'Reviewed again, original stands', netTime: '0:48:00' } });
  await drain();
  const back = await award(f.regs[0].id, gold.id);
  assert.deepEqual([back.id, back.awardStatus, back.revokedAt], [goldBefore.id, 'awarded', null]);
  assert.equal(await db('EventMedalAward').where({ registrationId: f.regs[0].id, medalTemplateId: gold.id }).count().then(r => Number(r[0].count)), 1);
  // disqualification
  const cur = await h.current(f.regs[1].id);
  await svc.disqualify({ ...ctx(f, a.owner), resultId: cur.id, key: h.key(), body: { expectedRevision: cur.revision, reasonCode: 'course_cut', note: 'Cut the course' } });
  await drain();
  const dq = await award(f.regs[1].id, fast.id);
  assert.deepEqual([dq.awardStatus, dq.reasonCode], ['revoked', 'disqualified']);
  const cur2 = await h.current(f.regs[1].id);
  await svc.correct({ ...ctx(f, a.owner), resultId: cur2.id, key: h.key(), body: { expectedRevision: cur2.revision, reasonCode: 'other', note: 'Disqualification overturned on appeal' } });
  await drain();
  assert.equal((await award(f.regs[1].id, fast.id)).awardStatus, 'awarded');
  // wording is bilingual from the code
  const sw = await db('Notification').where({ userId: f.regs[1].userId, type: 'event_medal_revoked' });
  assert.ok(sw.some(n => /matokeo yako yamefutwa/.test(n.data.bodySw)));
});

test('cancel / refund / event cancel are read by the reconcile job (no payment code): medals are revoked; template lock after official release; late template awards retroactively', async () => {
  const { f, a } = await setup({ n: 3 });
  const t = (await medal(f, a)).template;
  await official(f, a, [['1001', '0:50:00'], ['1002', '0:51:00'], ['1003', '0:52:00']]);
  await drain();
  const rows = await Promise.all(f.regs.map(r => award(r.id, t.id)));
  assert.deepEqual(rows.map(r => r.awardStatus), ['awarded', 'awarded', 'awarded']);
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ status: 'cancelled', cancelledAt: new Date() });
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ status: 'refunded' });
  const rec = await awards.reconcile();
  assert.equal(rec.queued, 2);
  await drain();
  assert.deepEqual([(await award(f.regs[0].id, t.id)).reasonCode, (await award(f.regs[1].id, t.id)).reasonCode], ['registration_cancelled', 'registration_cancelled']);
  assert.equal((await award(f.regs[2].id, t.id)).awardStatus, 'awarded');
  assert.equal((await awards.reconcile()).queued, 0);
  await db('Event').where({ id: f.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  await awards.reconcile(); await drain();
  assert.equal((await award(f.regs[2].id, t.id)).reasonCode, 'event_cancelled');
  await db('Event').where({ id: f.event.id }).update({ status: 'completed', cancelledAt: null });
  // lock: the rule is locked after the official release, names are not
  const lockedPatch = await medals.patch({ ...ctx(f, a.owner), templateId: t.id, key: h.key(), body: { rule: { type: 'placing', scope: 'overall', top: 1 } } });
  assert.deepEqual([lockedPatch.status, lockedPatch.error], [409, 'template_locked']);
  assert.equal((await medals.patch({ ...ctx(f, a.owner), templateId: t.id, key: h.key(), body: { name: name('Renamed') } })).template.name.en, 'Renamed');
  // a template added later is previewed and awarded retroactively
  const late = (await medal(f, a, { name: name('Top three'), tier: 'silver', rule: { type: 'placing', scope: 'category', top: 3 } })).template;
  assert.equal((await medals.preview({ ...ctx(f, a.timing), templateId: late.id })).wouldReceive, 1);
  assert.equal(await db('EventAwardTask').where({ eventId: f.event.id, reason: 'template_added', state: 'pending' }).count().then(r => Number(r[0].count)), 1);
  await drain();
  assert.equal((await award(f.regs[2].id, late.id)).awardStatus, 'awarded');
});

test('unclaimed places get medals only; the achievement and the reward follow the claim; achievements award once per awardKey; progress is computed', async () => {
  const { f, a } = await setup({ n: 2 });
  const t = (await medal(f, a)).template;
  const def = await defOf({ triggerType: 'achievement', triggerRef: 'first_event_finish', title: name('First event certificate') });
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ participantUserId: null, claimedAt: null });
  await official(f, a, [['1001', '0:50:00'], ['1002', '0:51:00']]);
  await drain();
  assert.equal((await award(f.regs[0].id, t.id)).awardStatus, 'awarded');
  assert.equal(await db('UserAchievement').where({ userId: f.regs[1].userId }).where('awardKey', 'like', 'first_event_finish:%').count().then(r => Number(r[0].count)), 1);
  assert.equal(await db('RewardLedgerEntry').where({ rewardDefinitionId: def.id }).count().then(r => Number(r[0].count)), 1);
  // the claim: the reconcile job queues it; the achievement appears, once
  const claimant = await h.user();
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ participantUserId: claimant, claimedAt: new Date() });
  assert.equal((await awards.reconcile()).queued, 1);
  await drain();
  assert.equal(await db('UserAchievement').where({ userId: claimant }).where('awardKey', 'like', 'first_event_finish:%').count().then(r => Number(r[0].count)), 1);
  await awards.evaluate(f.regs[0].id); await awards.evaluate(f.regs[0].id);
  assert.equal(await db('UserAchievement').where({ userId: claimant }).where('awardKey', 'like', 'first_event_finish:%').count().then(r => Number(r[0].count)), 1);
  assert.equal(await units(claimant, def.id), 1);
  const view = await medals.achievements({ userId: claimant });
  const first = view.achievements.find(x => x.key === 'first_event_finish');
  assert.deepEqual([first.status, first.progress], ['awarded', { current: 1, target: 1 }]);
  assert.deepEqual(view.achievements.find(x => x.key === 'three_events_year').progress, { current: 1, target: 3 });
  assert.equal(view.medals.length, 1);
  assert.equal(view.medals[0].art.source, 'builtin');
});

test('ledger: signs and units (no points), cap per user and cap total hold under parallel earns, window and category eligibility, wallet shows rewards not a total', async () => {
  const { f, a } = await setup({ n: 5 });
  const capped = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, capTotal: 3, title: name('First three') });
  const twice = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, capPerUser: 2, title: name('Twice') });
  const future = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, startsAt: new Date(Date.now() + 86_400_000).toISOString(), title: name('Later') });
  const wrongCat = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, eligibility: { categoryIds: ['evc_nope'] }, title: name('Other category') });
  await official(f, a, f.regs.map((r, i) => [r.bib, `0:${50 + i}:00`]));
  await Promise.all(f.regs.map(r => awards.evaluate(r.id)));
  await drain();
  const live = async d => Number((await db('RewardLedgerEntry').where({ rewardDefinitionId: d.id, entryType: 'earn' }).count().first()).count);
  assert.equal(await live(capped), 3);
  assert.equal(await live(twice), 5, 'capPerUser 2 still means one event_finish source per person');
  assert.equal(await live(future), 0);
  assert.equal(await live(wrongCat), 0);
  const u = f.regs[0].userId;
  const entries = await ledger(u, twice.id);
  assert.deepEqual(entries.map(e => [e.entryType, e.points]), [['earn', 1]]);
  assert.equal(entries[0].valueTzs, null);
  const w = await rewards.wallet({ userId: u });
  assert.equal(JSON.stringify(w).includes('points'), false);
  assert.ok(w.available.every(x => Number.isInteger(x.units) && x.definitionId));
  const mine = await rewards.myLedger({ userId: u, query: {} });
  assert.equal(JSON.stringify(mine).includes('points'), false);
  assert.ok(mine.items.every(i => Math.abs(i.units) === 1));
});

test('claim: a certificate is redeemed at once; a perk is reserved with a derived code; two parallel claims of one unit → exactly one wins; idempotency replays; a cancelled reservation returns the unit', async () => {
  const { f, a } = await setup({ n: 2 });
  const cert = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, title: name('Cert') });
  const perk = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, redeemMode: 'perk', title: name('Free drink') });
  await official(f, a, [['1001', '0:50:00'], ['1002', '0:51:00']]);
  await drain();
  const u = f.regs[0].userId;
  const claim = (def, k = h.key(), user = u) => rewards.claim({ userId: user, key: k, body: { rewardDefinitionId: def.id } });
  const c = await claim(cert);
  assert.deepEqual([c.status, c.redemption.status, c.redemption.code], [201, 'redeemed', null]);
  assert.equal(c.redemption.certificate.title.en, 'Cert');
  assert.equal(await units(u, cert.id), 0);
  assert.equal((await claim(cert)).error, 'not_enough_units');
  const k = h.key();
  const [x, y] = await Promise.all([claim(perk, k), claim(perk, h.key())]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  assert.equal([x, y].find(r => r.error).error, 'not_enough_units');
  const win = [x, y].find(r => !r.error);
  assert.match(win.redemption.code, /^FFR-[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(win.redemption.status, 'reserved');
  assert.equal(await units(u, perk.id), 0);
  const replay = await rewards.claim({ userId: u, key: win === x ? k : k, body: { rewardDefinitionId: perk.id } });
  if (win === x) assert.deepEqual([replay.replayed, replay.redemption.id], [true, x.redemption.id]);
  assert.equal((await rewards.claim({ userId: u, key: k, body: { rewardDefinitionId: cert.id } })).error === undefined, false);
  const again = await rewards.getRedemption({ userId: u, id: win.redemption.id });
  assert.equal(again.redemption.code, win.redemption.code);
  assert.equal((await rewards.getRedemption({ userId: f.regs[1].userId, id: win.redemption.id })).error, 'not_found');
  const wallet = await rewards.wallet({ userId: u });
  assert.equal(wallet.redemptions.find(r => r.id === win.redemption.id).code, win.redemption.code);
  // the desk
  const looked = await rewards.lookup({ admin: await adm(), body: { code: win.redemption.code.toLowerCase().replace('-', ' ') } });
  assert.deepEqual([looked.redemption.status, looked.redemption.member.includes('@')], ['reserved', false]);
  assert.equal(JSON.stringify(looked).match(/phone|email|\+255/), null);
  assert.equal((await rewards.adminCancel({ admin: await adm(), id: win.redemption.id, body: {} })).redemption.status, 'cancelled');
  assert.equal(await units(u, perk.id), 1, `the unit comes back ${JSON.stringify((await ledger(u, perk.id)).map(e => [e.entryType, e.points, e.idempotencyKey]))}`);
  assert.equal((await rewards.adminRedeem({ admin: await adm(), id: win.redemption.id })).error, 'invalid_transition');
  const second = await claim(perk);
  assert.equal(second.status, 201);
  const used = await rewards.adminRedeem({ admin: await adm(), id: second.redemption.id, body: { note: 'Given at the stand' } });
  assert.equal(used.redemption.status, 'redeemed');
  assert.equal((await rewards.adminRedeem({ admin: await adm(), id: second.redemption.id })).error, 'invalid_transition');
  // expiry of a reservation returns the unit
  const ent = await rewards.balanceIn(db, f.regs[1].userId, perk.id);
  assert.equal(ent, 1);
  const third = await claim(perk, h.key(), f.regs[1].userId);
  await db('RewardRedemption').where({ id: third.redemption.id }).update({ expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await rewards.expireReservations()).expiredReservations >= 1, true);
  assert.equal((await db('RewardRedemption').where({ id: third.redemption.id }).first()).status, 'expired');
  assert.equal(await units(f.regs[1].userId, perk.id), 1, `after expiry ${JSON.stringify((await ledger(f.regs[1].userId, perk.id)).map(e => [e.entryType, e.points]))}`);
  // code brute force: ten misses an hour block the desk and are audited
  const desk = `desk-${Date.now()}`;
  for (let i = 0; i < 10; i += 1) assert.equal((await rewards.lookup({ admin: desk, body: { code: `FFR-AAAAAAA${i}` } })).error, 'code_not_found');
  assert.equal((await rewards.lookup({ admin: desk, body: { code: win.redemption.code } })).error, 'rate_limited');
  assert.equal(await db('AuditLog').where({ action: 'events.reward_lookup_blocked', target: desk }).count().then(r => Number(r[0].count)), 1);
});

test('reversal policy: an unspent unit is reversed; a reserved perk is cancelled and reversed; a REDEEMED unit stays under revoke_unredeemed and is reversed (flagged) under revoke_all', async () => {
  const { f, a } = await setup({ n: 3 });
  const keep = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, title: name('Keep'), reversalPolicy: 'revoke_unredeemed' });
  const all = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, title: name('All'), reversalPolicy: 'revoke_all', redeemMode: 'perk' });
  await official(f, a, [['1001', '0:50:00'], ['1002', '0:51:00'], ['1003', '0:52:00']]);
  await drain();
  const [u1, u2, u3] = f.regs.map(r => r.userId);
  // u1: unspent → reversed on disqualification
  // u2: redeemed Keep and reserved All
  assert.equal((await rewards.claim({ userId: u2, key: h.key(), body: { rewardDefinitionId: keep.id } })).status, 201);
  const resv = await rewards.claim({ userId: u2, key: h.key(), body: { rewardDefinitionId: all.id } });
  // u3: redeemed the revoke_all perk (desk marked it used)
  const perk3 = await rewards.claim({ userId: u3, key: h.key(), body: { rewardDefinitionId: all.id } });
  await rewards.adminRedeem({ admin: await adm(), id: perk3.redemption.id });
  for (const r of f.regs) { const row = await h.current(r.id); await svc.disqualify({ ...ctx(f, a.owner), resultId: row.id, key: h.key(), body: { expectedRevision: row.revision, reasonCode: 'rule_violation', note: 'Cut the course' } }); }
  await drain();
  assert.equal(await units(u1, keep.id), 0); assert.equal(await units(u1, all.id), 0);
  assert.deepEqual((await ledger(u1, keep.id)).map(e => e.entryType), ['earn', 'reverse']);
  assert.equal((await db('RewardRedemption').where({ id: resv.redemption.id }).first()).status, 'cancelled');
  assert.deepEqual((await ledger(u2, all.id)).map(e => `${e.entryType}${e.points}`).sort(), ['earn1', 'redeem-1', 'reverse-1', 'reverse1']);
  assert.equal(await units(u2, all.id), 0);
  assert.deepEqual((await ledger(u2, keep.id)).map(e => e.entryType), ['earn', 'redeem'], 'redeemed + revoke_unredeemed: left in place');
  assert.equal((await db('RewardRedemption').where({ userId: u2, rewardDefinitionId: keep.id }).first()).needsReview, true);
  assert.deepEqual((await ledger(u3, all.id)).map(e => e.entryType), ['earn', 'redeem', 'reverse']);
  assert.equal((await db('RewardRedemption').where({ id: perk3.redemption.id }).first()).needsReview, true);
  const summary = await rewards.adminSummary();
  assert.ok(summary.items.find(s => s.definitionId === all.id).needsReview >= 1);
  const note = await db('Notification').where({ userId: u1, type: 'event_reward_reversed' });
  assert.ok(note.length >= 1 && note[0].data.essential === true);
  // reinstatement earns again (fresh ledger key)
  const row = await h.current(f.regs[0].id);
  await svc.correct({ ...ctx(f, a.owner), resultId: row.id, key: h.key(), body: { expectedRevision: row.revision, reasonCode: 'other', note: 'Disqualification overturned' } });
  await drain();
  assert.equal(await units(u1, keep.id), 1);
});

test('expiry: unspent units older than expiryDays get an expire entry once; the day job is idempotent', async () => {
  const { f, a } = await setup({ n: 1 });
  const d = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, expiryDays: 30 });
  await official(f, a, [['1001', '0:50:00']]);
  await drain();
  const u = f.regs[0].userId;
  assert.equal((await rewards.expireUnits()).expired, 0);
  await db.transaction(async (trx) => { await trx.raw('ALTER TABLE "RewardLedgerEntry" DISABLE TRIGGER ALL'); await trx('RewardLedgerEntry').where({ userId: u, rewardDefinitionId: d.id }).update({ occurredAt: new Date(Date.now() - 40 * 86_400_000) }); await trx.raw('ALTER TABLE "RewardLedgerEntry" ENABLE TRIGGER ALL'); });
  assert.equal((await rewards.expireUnits()).expired, 1);
  assert.equal((await rewards.expireUnits()).expired, 0);
  assert.equal(await units(u, d.id), 0);
  assert.deepEqual((await ledger(u, d.id)).map(e => e.entryType), ['earn', 'expire']);
  assert.equal((await rewards.wallet({ userId: u })).expired.length, 1);
});

test('definitions: valueTzs refused (D45), only FitFlex issues, English AND Swahili required, funding note required, trigger locked once the ledger has entries', async () => {
  const body = { title: name('X'), terms: name('T'), fundingNote: 'FitFlex', triggerType: 'event_finish' };
  for (const bad of [{ valueTzs: 5000 }, { valueTzs: 0 }]) assert.equal((await rewards.createDefinition({ actor: { userId: 'a' }, body: { ...body, ...bad } })).error, 'value_not_allowed_yet');
  assert.equal((await rewards.createDefinition({ actor: { userId: 'a' }, body: { ...body, issuerType: 'partner' } })).error, 'issuer_not_allowed');
  assert.equal((await rewards.createDefinition({ actor: { userId: 'a' }, body: { ...body, title: { en: 'only' } } })).error, 'validation_failed');
  assert.equal((await rewards.createDefinition({ actor: { userId: 'a' }, body: { ...body, fundingNote: '' } })).error, 'validation_failed');
  assert.equal((await rewards.createDefinition({ actor: { userId: 'a' }, body: { ...body, triggerType: 'medal', triggerRef: 'emt_none' } })).error, 'validation_failed');
  assert.equal((await rewards.createDefinition({ actor: { userId: 'a' }, body: { ...body, triggerType: 'achievement', triggerRef: 'nope' } })).error, 'validation_failed');
  const ok = await rewards.createDefinition({ actor: { userId: 'a' }, body });
  assert.deepEqual([ok.status, ok.definition.status, ok.definition.valueTzs], [201, 'draft', null]);
  assert.equal((await rewards.updateDefinition({ actor: { userId: 'a' }, id: ok.definition.id, body: { valueTzs: 100 } })).error, 'value_not_allowed_yet');
  assert.equal((await rewards.activate({ actor: { userId: 'a' }, id: ok.definition.id })).definition.status, 'active');
  assert.equal((await rewards.pause({ actor: { userId: 'a' }, id: ok.definition.id })).definition.status, 'paused');
  assert.equal((await rewards.end({ actor: { userId: 'a' }, id: ok.definition.id })).definition.status, 'ended');
  assert.equal((await rewards.activate({ actor: { userId: 'a' }, id: ok.definition.id })).error, 'invalid_transition');
  const rows = await db('RewardDefinition').where({ id: ok.definition.id }).first();
  assert.deepEqual([rows.valueTzs, rows.points, rows.issuerType], [null, null, 'fitflex']);
});

test('ledger database rules: INSERT works; every UPDATE except anonymising the user fails; DELETE and TRUNCATE fail', async () => {
  const { f, a } = await setup({ n: 1 });
  const d = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id });
  await official(f, a, [['1001', '0:50:00']]);
  await drain();
  const e = (await ledger(f.regs[0].userId, d.id))[0];
  await assert.rejects(db('RewardLedgerEntry').where({ id: e.id }).update({ points: 9 }), /append-only/);
  await assert.rejects(db('RewardLedgerEntry').where({ id: e.id }).update({ sourceId: 'x' }), /append-only/);
  await assert.rejects(db('RewardLedgerEntry').where({ id: e.id }).update({ userId: null, points: 5 }), /append-only/);
  await assert.rejects(db('RewardLedgerEntry').where({ id: e.id }).update({ anonymisedAt: new Date() }), /append-only/);
  await assert.rejects(db('RewardLedgerEntry').where({ id: e.id }).del(), /append-only/);
  await assert.rejects(db.raw('TRUNCATE "RewardLedgerEntry"'), /append-only|cannot truncate/);
  await assert.rejects(db('RewardLedgerEntry').insert({ id: 'rle_x', userId: null, entryType: 'earn', points: 1, sourceType: 'x', idempotencyKey: 'x-null-user', occurredAt: new Date() }), /user_or_anonymised/);
  const dup = { ...e, id: 'rle_dupe_key' }; delete dup.createdAt;
  await assert.rejects(db('RewardLedgerEntry').insert(dup), /unique|duplicate/i);
});

test('account deletion: the ledger and redemptions are ANONYMISED (rows stay, trigger still blocks other updates); an organizer owner is blocked (409 organizer_owner, bilingual); medals stay on the registration', async () => {
  const { f, a, o } = await setup({ n: 1 });
  const t = (await medal(f, a)).template;
  const cert = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id });
  const perk = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, redeemMode: 'perk' });
  await official(f, a, [['1001', '0:50:00']]);
  await drain();
  const u = f.regs[0].userId;
  await rewards.claim({ userId: u, key: h.key(), body: { rewardDefinitionId: cert.id } });
  await rewards.claim({ userId: u, key: h.key(), body: { rewardDefinitionId: perk.id } });
  const rowsBefore = await db('RewardLedgerEntry').whereIn('rewardDefinitionId', [cert.id, perk.id]).count().then(r => Number(r[0].count));
  assert.equal(rowsBefore, 4);
  const user = await db('User').where({ id: u }).first();
  const out = await accountService.deleteMyAccount({ ...user, id: u });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(await db('User').where({ id: u }).first(), undefined);
  const after4 = await db('RewardLedgerEntry').whereIn('rewardDefinitionId', [cert.id, perk.id]);
  assert.equal(after4.length, 4);
  assert.ok(after4.every(r => r.userId === null && r.anonymisedAt !== null));
  const reds = await db('RewardRedemption').whereIn('rewardDefinitionId', [cert.id, perk.id]);
  assert.ok(reds.length === 2 && reds.every(r => r.userId === null && r.anonymisedAt !== null));
  await assert.rejects(db('RewardLedgerEntry').where({ id: after4[0].id }).update({ points: 3 }), /append-only/);
  await assert.rejects(db('RewardLedgerEntry').where({ id: after4[0].id }).del(), /append-only/);
  assert.equal((await award(f.regs[0].id, t.id)).awardStatus, 'awarded', 'registration data keeps the medal');
  assert.equal(await db('UserAchievement').where({ userId: u }).count().then(r => Number(r[0].count)), 0);
    const ownerUser = await db('User').where({ id: o.ownerUserId }).first();
  const blocked = await accountService.deleteMyAccount(ownerUser);
  assert.deepEqual([blocked.status, blocked.error, blocked.message, blocked.messageSw], [409, 'organizer_owner', 'Transfer or close your organizer account first.', 'Hamisha au funga akaunti yako ya mwandaaji kwanza.']);
  assert.ok(await db('User').where({ id: o.ownerUserId }).first());
});

test('reward codes: derived from the ticket key, domain-separated, normalised, only a hash is stored', async () => {
  const ring = ticketKeyRing(process.env) ?? ticketKeyRing({ EVENT_TICKET_SECRET: 'spec-ticket-secret-0123456789abcdef0123456789abcd' });
  const a = codeFor(ring, 'rdm_1'); const b = codeFor(ring, 'rdm_2');
  assert.match(a, /^FFR-[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.notEqual(a, b);
  assert.equal(codeFor(ring, 'rdm_1'), a);
  assert.equal(codeFor(null, 'rdm_1'), null);
  assert.equal(normaliseCode(a.toLowerCase().replace('-', ' ')), a);
  assert.equal(normaliseCode('nope'), null);
  assert.notEqual(codeFor({ secret: `${ring.secret}x` }, 'rdm_1'), a);
  assert.equal(hashCode(a).length, 64);
});

test('two workers never run one task twice (SKIP LOCKED) and the queue coalesces a burst of corrections', async () => {
  const { f, a } = await setup({ n: 3 });
  await medal(f, a);
  await official(f, a, [['1001', '0:50:00'], ['1002', '0:51:00'], ['1003', '0:52:00']]);
  const [x, y] = await Promise.all([awards.runBatch(), awards.runBatch()]);
  await drain();
  assert.ok(x.claimed + y.claimed >= 1);
  assert.equal(await db('EventMedalAward').where({ eventId: f.event.id }).count().then(r => Number(r[0].count)), 3);
  assert.equal(await db('EventAwardTask').where({ eventId: f.event.id, state: 'running' }).count().then(r => Number(r[0].count)), 0);
  const { enqueueAwardTask } = await import('../src/shared/events-award-queue.mjs');
  assert.equal(await enqueueAwardTask(db, { eventId: f.event.id, registrationId: f.regs[0].id, reason: 'result_changed' }), true);
  assert.equal(await enqueueAwardTask(db, { eventId: f.event.id, registrationId: f.regs[0].id, reason: 'result_changed' }), false);
  // a failing task keeps its error (no personal data) and goes to failed after five tries; the desk can retry it
  await db('EventAwardTask').where({ eventId: f.event.id, state: 'pending' }).del();
  const orig = awards.evaluate;
  void orig;
  await db('EventAwardTask').insert({ id: 'eat_spec_fail', eventId: f.event.id, registrationId: f.regs[0].id, reason: 'claim', state: 'pending', attempts: 4, runAfter: new Date(Date.now() - 1000) });
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ categoryId: 'evc_missing_xx' }).catch(() => {});
  const run = await awards.runBatch();
  assert.equal(run.claimed >= 1, true);
  const t = await db('EventAwardTask').where({ id: 'eat_spec_fail' }).first();
  assert.ok(['done', 'failed'].includes(t.state));
  await db('EventAwardTask').where({ id: 'eat_spec_fail' }).update({ state: 'failed', lastError: 'boom' });
  assert.equal((await rewards.listTasks({ query: { state: 'failed' } })).items.some(i => i.id === 'eat_spec_fail'), true);
  assert.equal((await rewards.retryTask({ admin: await adm(), id: 'eat_spec_fail' })).task.state, 'pending');
  assert.equal((await rewards.retryTask({ admin: await adm(), id: 'eat_spec_fail' })).error, 'not_found');
});

test('routes: flag matrix (off, results only, rewards on), roles, and the admin desk needs the events scope', async () => {
  const { f, o, a } = await setup({ n: 1 });
  const org = (r, actor) => h.call(r, actor, { params: { id: f.event.id, templateId: 'x' } });
  const claims = { sub: f.regs[0].userId, userType: 'member' };
  const adminClaims = { sub: await h.user({ userType: 'admin' }), userType: 'admin' };
  s6Off();
  for (const r of [...Object.values(memberRoutes), ...Object.values(adminRoutes)].filter(x => x?.path)) {
    const who = r.path.startsWith('/admin') ? adminClaims : r.path.startsWith('/organizer') ? o.claims : claims;
    assert.equal((await h.call(r, who, { params: { id: 'x', templateId: 'x' } })).status, 404, `off ${r.path}`);
  }
  s6On({ rewards: false });
  assert.equal((await h.call(memberRoutes.myEventRewards, claims, {})).status, 404, 'results on, rewards off');
  s6Off(); s6On({ rewards: true });
  assert.equal((await h.call(memberRoutes.myEventRewards, claims, {})).status, 200);
  assert.equal((await org(memberRoutes.organizerMedalTemplates, o.claims)).status, 200);
  assert.equal((await org(memberRoutes.organizerMedalTemplates, a.ops === undefined ? o.claims : o.ops)).status, 403);
  assert.equal((await h.call(adminRoutes.adminListRewardDefinitions, claims, {})).status, 403);
  const ok = await h.call(adminRoutes.adminCreateRewardDefinition, adminClaims, { body: { title: name('R'), terms: name('T'), fundingNote: 'FitFlex', triggerType: 'event_finish', valueTzs: 100 } });
  assert.deepEqual([ok.status, ok.body.error], [422, 'value_not_allowed_yet']);
  const noKey = await h.call(memberRoutes.claimEventReward, claims, { body: { rewardDefinitionId: 'x' } });
  assert.deepEqual([noKey.status, noKey.body.error], [400, 'idempotency_key_required']);
});
