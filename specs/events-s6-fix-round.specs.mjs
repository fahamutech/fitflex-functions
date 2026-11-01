// Events S6 · fix round — security review findings H1, M1-M5, M8, L3, L4, L6, L8, L10; contract additions; Swahili copy; the orphan run.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ensureInit } from '../functions/index.mjs';
import * as runs from '../functions/events-runs.mjs';
import * as artRoutes from '../functions/events-medal-art.mjs';
import { harness, s6On, s6Off, db, H } from './fixtures/events-s6.mjs';
import { eventsRewardService as rewards, eventsMedalService as medals, eventsAwardService as awards, eventsMedalArtService, accountService } from '../src/bootstrap/services.mjs';
import { createEventsRunLinkService } from '../src/services/events-run-link-service.mjs';
import { MEDAL_ART_CONFIRMATION } from '../src/services/events-medal-art-service.mjs';
import { COPY, errorText, REASON_WORD } from '../src/shared/events-results-copy.mjs';
import { SAMPLE_CSV } from '../src/shared/events-results-csv.mjs';
import { codeFor } from '../src/shared/events-reward-code.mjs';
import { ticketKeyRing } from '../src/shared/events-ticket-token.mjs';

await ensureInit();
const h = harness();
const svc = h.service;
afterEach(() => { artRoutes.resetEventsMedalArtLimits(); delete process.env.EVENTS_RESULTS_PUSH_MAX; });
after(async () => { await h.cleanup(); await db.destroy(); });

const ctx = (f, actor) => ({ actor, organizerId: f.organizer.id, eventId: f.event.id });
const name = en => ({ en, sw: `${en} (sw)` });
async function setup({ n = 3, over = {} } = {}) {
  s6On({ rewards: true, medalArt: true, pub: true, runs: true });
  const o = await h.org();
  const f = await h.resultsEvent({ organizer: o, n, ...over });
  return { o, f, a: h.actors(o) };
}
async function official(f, a, rows, stage = 'official') {
  await h.importCsv(f, a.owner, h.csvOf(rows.map(([bib, net]) => [bib, 'finished', net, ''])));
  for (const [bib] of rows) {
    const reg = f.all.find(r => r.bib === bib);
    const row = await h.current(reg.id);
    await svc.verify({ ...ctx(f, a.owner), resultId: row.id, key: h.key(), body: { expectedRevision: row.revision } });
  }
  const body = { stage, leaveUnsettledOut: true };
  const p = await svc.releasePreview({ ...ctx(f, a.owner), body });
  const r = await svc.release({ ...ctx(f, a.owner), key: h.key(), body: { ...body, previewHash: p.previewHash } });
  assert.equal(r.status, 200, JSON.stringify(r));
}
const drain = async () => { let r; do { r = await awards.runBatch(); } while (r.claimed); };
const board = (f, viewer) => svc.board({ userId: viewer, eventId: f.event.id, query: {} });
const defOf = async body => (await rewards.createDefinition({ actor: { userId: 'adm' }, body: { title: name('Cert'), terms: name('Terms'), fundingNote: 'FitFlex', status: 'active', ...body } })).definition;
const checker = (size, cell, seed = 0) => {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) { const v = ((Math.floor(x / cell) + Math.floor(y / cell) + seed) % 2) ? 235 : 25; const i = (y * size + x) * 3; raw[i] = v; raw[i + 1] = v; raw[i + 2] = v; }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
};

test('H1 a minor who chose hidden stays hidden on the board; M2 default is bib-only unless the participant registered themself with the clause; L10 anonymous rows are bilingual', async () => {
  const { f, a } = await setup({ n: 4 });
  await official(f, a, f.regs.map((r, i) => [r.bib, `0:${50 + i}:00`]));
  const birth = new Date(Date.now() - 12 * 365 * 86_400_000).toISOString().slice(0, 10);
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ dateOfBirth: birth, resultsVisibility: 'hidden', resultsVisibilitySetAt: new Date() });
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ dateOfBirth: birth }); // a minor who never chose
  await db('EventRegistration').where({ id: f.regs[2].id }).update({ consentBasis: 'purchaser_authorised' }); // bought for them
  const viewer = f.regs[3].userId;
  const b = await board(f, viewer);
  const rows = Object.fromEntries(b.items.map(i => [i.bibNumber, i]));
  assert.equal(rows['1001'], undefined, 'the minor who chose hidden is not on the board');
  assert.deepEqual([rows['1002'].displayName, rows['1002'].anonymous], [null, true]);
  assert.deepEqual([rows['1003'].displayName, rows['1003'].anonymous], [null, true], 'a place bought by someone else is bib-only until the participant chooses');
  assert.equal(rows['1004'].displayName.endsWith('.'), true, 'self + clause: first name and last initial');
  assert.deepEqual(b.anonymousLabel, { en: 'Runner', sw: 'Mkimbiaji' });
  const bought = await svc.myResult({ userId: f.regs[2].userId, registrationId: f.regs[2].id });
  assert.deepEqual([bought.visibility.current, bought.visibility.reason], ['bib_only', 'ask']);
  assert.equal((await svc.setVisibility({ userId: f.regs[2].userId, registrationId: f.regs[2].id, body: { visibility: 'standard' } })).visibility, 'standard');
  assert.equal((await board(f, viewer)).items.find(i => i.bibNumber === '1003').anonymous, false);
  const minorView = await svc.myResult({ userId: f.regs[0].userId, registrationId: f.regs[0].id });
  assert.deepEqual([minorView.visibility.current, minorView.visibility.canChange], ['hidden', false]);
});

test('M1 removing the participant (account deletion) hides the place for good and clears the claim', async () => {
  const { f, a } = await setup({ n: 2 });
  await official(f, a, f.regs.map((r, i) => [r.bib, `0:${50 + i}:00`]));
  const u = f.regs[0].userId;
  assert.ok((await board(f, f.regs[1].userId)).items.some(i => i.bibNumber === '1001'));
  const user = await db('User').where({ id: u }).first();
  assert.equal((await accountService.deleteMyAccount({ ...user, id: u })).ok, true);
  const reg = await db('EventRegistration').where({ id: f.regs[0].id }).first();
  assert.deepEqual([reg.participantUserId, reg.claimedAt, reg.resultsVisibility, reg.resultsVisibilitySetAt !== null], [null, null, 'hidden', true]);
  assert.equal((await board(f, f.regs[1].userId)).items.some(i => i.bibNumber === '1001'), false);
});

test('L3 a pending DNF / DNS / DQ from an API client shows as "pending" on the board, never as dq; no time, no rank', async () => {
  const { f, a, o } = await setup({ n: 3 });
  const api = await h.apiClient(o, { scopes: ['registrations:read', 'results:write'] });
  const actor = { kind: 'api', clientId: api.client.id, scopes: ['results:write'], requestId: 'req_l3' };
  await h.importCsv(f, a.owner, h.csvOf([['1001', 'finished', '0:50:00', '']]));
  const row = await h.current(f.regs[0].id);
  await svc.verify({ ...ctx(f, a.owner), resultId: row.id, key: h.key(), body: { expectedRevision: 1 } });
  const out = await svc.apiImport({ actor, organizerId: o.id, eventId: f.event.id, key: h.key(), body: { rows: [{ clientRef: 'a', bib: '1002', status: 'dq' }, { clientRef: 'b', bib: '1003', status: 'dnf' }] } });
  assert.deepEqual(out.results.map(r => r.ok), [true, true]);
  const pv = await svc.releasePreview({ ...ctx(f, a.owner), body: { stage: 'provisional' } });
  await svc.release({ ...ctx(f, a.owner), key: h.key(), body: { stage: 'provisional', previewHash: pv.previewHash } });
  const b = await board(f, f.regs[0].userId);
  const by = Object.fromEntries(b.items.map(i => [i.bibNumber, i]));
  for (const bib of ['1002', '1003']) assert.deepEqual([by[bib].finishStatus, by[bib].elapsedMs, by[bib].rank], ['pending', null, null], bib);
  assert.equal(by['1001'].finishStatus, 'finished');
});

test('M3 the list row of a place I bought but somebody else claimed carries a status chip only', async () => {
  const { f, a } = await setup({ n: 2 });
  await official(f, a, f.regs.map((r, i) => [r.bib, `0:${50 + i}:00`]));
  const buyer = await h.user();
  await db('EventRegistration').where({ id: f.regs[0].id }).update({ purchaserUserId: buyer });
  const mine = await svc.decorateRegistrations([{ id: f.regs[0].id }], f.regs[0].userId);
  assert.deepEqual(Object.keys(mine[0]).sort(), ['id', 'medalsCount', 'resultStage', 'resultsVisibility']);
  const bought = await svc.decorateRegistrations([{ id: f.regs[0].id }], buyer);
  assert.deepEqual(Object.keys(bought[0]).sort(), ['id', 'resultStage']);
});

test('M4 FitFlex admin may correct / disqualify only when the organizer is not active or a question has been open for more than 7 days', async () => {
  const { f, a, o } = await setup({ n: 1 });
  await official(f, a, [['1001', '0:50:00']]);
  const row = await h.current(f.regs[0].id);
  const admin = { kind: 'admin', userId: await h.user({ userType: 'admin' }), requestId: 'req_m4' };
  const body = { expectedRevision: 1, reasonCode: 'timing_error', note: 'Reviewed on behalf of the organizer', netTime: '0:49:00' };
  const call = (kind = 'correct', b = body) => svc[kind]({ actor: admin, eventId: f.event.id, resultId: row.id, key: h.key(), body: b });
  assert.deepEqual([(await call()).status, (await call()).error], [409, 'organizer_can_resolve']);
  assert.equal((await call('disqualify', { expectedRevision: 1, reasonCode: 'course_cut', note: 'Reviewed on behalf of the organizer' })).error, 'organizer_can_resolve');
  const d = await svc.raiseDispute({ userId: f.regs[0].userId, registrationId: f.regs[0].id, body: { reasonCode: 'time_wrong' } });
  assert.equal((await call()).error, 'organizer_can_resolve', 'a fresh question is the organizer\'s to answer');
  await db('EventResultDispute').where({ id: d.dispute.id }).update({ createdAt: new Date(Date.now() - 8 * 86_400_000) });
  assert.equal((await call()).status, 200, 'open for more than 7 days');
  await db('EventResultDispute').where({ id: d.dispute.id }).update({ status: 'withdrawn' });
  await db('EventOrganizer').where({ id: o.id }).update({ status: 'suspended', statusReason: 'spec' });
  const row2 = await h.current(f.regs[0].id);
  assert.equal((await svc.disqualify({ actor: admin, eventId: f.event.id, resultId: row2.id, key: h.key(), body: { expectedRevision: row2.revision, reasonCode: 'course_cut', note: 'Organizer is suspended; FitFlex steps in' } })).status, 200, 'organizer not active');
  await db('EventOrganizer').where({ id: o.id }).update({ status: 'active', statusReason: null });
});

test('M5 a reservation whose member is gone just expires (no ledger row without a user); admin cancel the same; one bad row does not stop the sweep', async () => {
  const { f, a } = await setup({ n: 2 });
  const perk = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, redeemMode: 'perk' });
  await official(f, a, f.regs.map((r, i) => [r.bib, `0:${50 + i}:00`]));
  await drain();
  const claim = u => rewards.claim({ userId: u, key: h.key(), body: { rewardDefinitionId: perk.id } });
  const [r1, r2] = [await claim(f.regs[0].userId), await claim(f.regs[1].userId)];
  const ledgerRows = () => db('RewardLedgerEntry').where({ rewardDefinitionId: perk.id }).count().then(r => Number(r[0].count));
  const before = await ledgerRows();
  await db('RewardRedemption').whereIn('id', [r1.redemption.id, r2.redemption.id]).update({ userId: null });
  assert.ok((await db('RewardRedemption').where({ id: r1.redemption.id }).first()).anonymisedAt);
  await db('RewardRedemption').where({ id: r1.redemption.id }).update({ expiresAt: new Date(Date.now() - 1000) });
  const out = await rewards.expireReservations();
  assert.equal(out.expiredReservations >= 1, true);
  assert.equal((await db('RewardRedemption').where({ id: r1.redemption.id }).first()).status, 'expired');
  assert.equal(await ledgerRows(), before, 'nothing written for a person who no longer exists');
  const admin = await h.user({ userType: 'admin' });
  assert.equal((await rewards.adminCancel({ admin, id: r2.redemption.id, body: {} })).redemption.status, 'cancelled');
  assert.equal(await ledgerRows(), before);
});

test('M8 a taken-down design stays blocked when re-sized or re-compressed (perceptual hash); an unrelated design and flat colours are not caught', async () => {
  const { o, f } = await setup({ n: 1 });
  const t = (await medals.create({ actor: h.actors(o).owner, organizerId: o.id, eventId: f.event.id, key: h.key(), body: { name: name('Art') } })).template;
  const V = MEDAL_ART_CONFIRMATION.version;
  const up = (buf, who = o.claims) => h.call(artRoutes.uploadMedalArt, who, { params: { id: f.event.id, templateId: t.id }, body: buf, query: { confirmationVersion: V }, headers: { 'Idempotency-Key': h.key() } });
  const reset = () => db('EventMedalArtUploadAttempt').del();
  const original = await checker(640, 80);
  const live = await up(original);
  assert.equal(live.status, 201, JSON.stringify(live.body));
  const admin = { sub: await h.user({ userType: 'admin' }), userType: 'admin' };
  assert.equal((await h.call(artRoutes.adminTakeDownMedalArt, admin, { params: { id: live.body.art.id }, body: { reason: 'rights' } })).status, 200);
  const stored = await db('EventMedalArt').where({ id: live.body.art.id }).first();
  assert.match(stored.dHash, /^[0-9a-f]{16}$/);
  await reset();
  const smaller = await sharp(original).resize(520, 520).jpeg({ quality: 60 }).toBuffer();
  assert.equal((await up(smaller)).body.error, 'file_not_allowed', 'a re-sized, re-compressed copy');
  await reset();
  const shifted = await sharp(original).blur(1.2).png().toBuffer();
  assert.equal((await up(shifted)).body.error, 'file_not_allowed', 'a softened copy');
  await reset();
  assert.equal((await up(await checker(640, 53, 1))).status, 201, 'a different design is fine');
  // flat colours all hash alike, so a flat design can never block (or be blocked by) another flat design
  await reset();
  const flat = c => sharp({ create: { width: 600, height: 600, channels: 3, background: c } }).png().toBuffer();
  const a1 = await up(await flat({ r: 10, g: 100, b: 10 }));
  assert.equal(a1.status, 201);
  assert.equal((await h.call(artRoutes.adminTakeDownMedalArt, admin, { params: { id: a1.body.art.id }, body: { reason: 'quality' } })).status, 200);
  assert.equal((await db('EventMedalArt').where({ id: a1.body.art.id }).first()).dHash, null);
  await reset();
  assert.equal((await up(await flat({ r: 200, g: 20, b: 20 }))).status, 201);
  void eventsMedalArtService;
});

test('L4 a timing partner cannot settle a DNF / DNS, nor overwrite someone else\'s pending row or a settled one; its own pending rows it may revise', async () => {
  const { f, a } = await setup({ n: 3 });
  const enter = (reg, body, actor) => svc.enter({ ...ctx(f, actor), registrationId: reg.id, key: h.key(), body });
  assert.equal((await enter(f.regs[0], { finishStatus: 'dns' }, a.timing)).result.verificationStatus, 'pending_verification');
  assert.equal((await enter(f.regs[0], { finishStatus: 'finished', netTime: '0:51:00' }, a.timing)).result.revision, 2, 'its own pending row');
  await enter(f.regs[1], { finishStatus: 'finished', netTime: '0:52:00' }, a.owner);
  assert.equal((await enter(f.regs[1], { finishStatus: 'finished', netTime: '0:40:00' }, a.timing)).error, 'not_your_entry');
  const csv = h.csvOf([['1002', 'finished', '0:40:00', '']]);
  const prev = await svc.importPreview({ ...ctx(f, a.timing), body: { csv, sourceType: 'timing_provider' } });
  assert.deepEqual(prev.problems.map(p => p.code), ['not_your_entry']);
  assert.equal((await svc.importApply({ ...ctx(f, a.timing), key: h.key(), body: { csv, sourceType: 'timing_provider', previewHash: prev.previewHash } })).error, 'import_has_errors');
  await enter(f.regs[2], { finishStatus: 'dnf' }, a.owner);
  assert.equal((await enter(f.regs[2], { finishStatus: 'finished', netTime: '0:45:00' }, a.timing)).error, 'not_your_entry', 'a settled row');
  assert.equal((await enter(f.regs[1], { finishStatus: 'finished', netTime: '0:41:00' }, a.owner)).result.revision, 2, 'the owner may');
  const imp = await h.importCsv(f, a.timing, h.csvOf([['1001', 'dnf', '', '']]));
  assert.equal(imp.status, 201);
  assert.equal((await h.current(f.regs[0].id)).verificationStatus, 'pending_verification');
});

test('L8 a reserved perk code survives a ticket-secret rotation; a same-key claim that loses the lock race replays instead of 409', async () => {
  const { f, a } = await setup({ n: 1 });
  const perk = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id, redeemMode: 'perk' });
  await official(f, a, [['1001', '0:50:00']]);
  await drain();
  const u = f.regs[0].userId;
  const key = h.key();
  const [x, y] = await Promise.all([rewards.claim({ userId: u, key, body: { rewardDefinitionId: perk.id } }), rewards.claim({ userId: u, key, body: { rewardDefinitionId: perk.id } })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 201]);
  assert.equal(x.redemption.id, y.redemption.id);
  const id = x.redemption.id;
  const code = x.redemption.code;
  assert.ok(code);
  assert.equal((await db('RewardRedemption').where({ id }).first()).codeKeyId, 'k1');
  const old = process.env.EVENT_TICKET_SECRET;
  try {
    process.env.EVENT_TICKET_SECRET_PREVIOUS = JSON.stringify({ k1: old });
    process.env.EVENT_TICKET_SECRET = 'rotated-ticket-secret-0123456789abcdef0123456789';
    process.env.EVENT_TICKET_KEY_ID = 'k2';
    assert.equal((await rewards.getRedemption({ userId: u, id })).redemption.code, code, 'same code after the rotation');
    assert.equal((await rewards.wallet({ userId: u })).redemptions.find(r => r.id === id).code, code);
    const admin = await h.user({ userType: 'admin' });
    assert.equal((await rewards.lookup({ admin, body: { code } })).redemption.id, id, 'the desk finds it by hash');
    delete process.env.EVENT_TICKET_SECRET_PREVIOUS;
    assert.equal((await rewards.getRedemption({ userId: u, id })).redemption.code, null, 'only when the old key is dropped too');
  } finally {
    process.env.EVENT_TICKET_SECRET = old; delete process.env.EVENT_TICKET_SECRET_PREVIOUS; delete process.env.EVENT_TICKET_KEY_ID;
  }
  assert.equal(codeFor(ticketKeyRing(process.env), id, 'k1'), code);
});

test('contract: result header carries registrationStatus / eventCancelled / claimNeeded, medals carry organizerName, redemptions carry eventTitle and resultLine, errors carry message + messageSw', async () => {
  const { f, a, o } = await setup({ n: 2 });
  await medals.create({ actor: a.owner, organizerId: o.id, eventId: f.event.id, key: h.key(), body: { name: name('Finisher') } });
  const cert = await defOf({ triggerType: 'event_finish', triggerEventId: f.event.id });
  await official(f, a, f.regs.map((r, i) => [r.bib, `0:${50 + i}:00`]));
  await drain();
  const u = f.regs[0].userId;
  const res = await svc.myResult({ userId: u, registrationId: f.regs[0].id });
  assert.deepEqual([res.registrationStatus, res.eventCancelled, res.claimNeeded], ['confirmed', false, false]);
  assert.equal(res.medals[0].organizerName, o.name ?? (await db('EventOrganizer').where({ id: o.id }).first()).name);
  assert.equal(typeof res.medals[0].organizerName, 'string');
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ participantUserId: null, claimedAt: null });
  const buyer = await h.user();
  await db('EventRegistration').where({ id: f.regs[1].id }).update({ purchaserUserId: buyer });
  assert.equal((await svc.myResult({ userId: buyer, registrationId: f.regs[1].id })).claimNeeded, true);
  await db('Event').where({ id: f.event.id }).update({ status: 'cancelled', cancelledAt: new Date() });
  assert.equal((await svc.myResult({ userId: u, registrationId: f.regs[0].id })).eventCancelled, true);
  await db('Event').where({ id: f.event.id }).update({ status: 'in_progress', cancelledAt: null });
  const claimed = await rewards.claim({ userId: u, key: h.key(), body: { rewardDefinitionId: cert.id } });
  assert.equal(claimed.redemption.eventTitle, 'Dar Half Marathon');
  assert.deepEqual(claimed.redemption.resultLine, { en: 'Finished 10K in 0:50:00', sw: 'Alimaliza 10K kwa 0:50:00' });
  const wallet = await rewards.wallet({ userId: u });
  assert.deepEqual([wallet.redemptions[0].eventTitle, wallet.redemptions[0].resultLine.sw], ['Dar Half Marathon', 'Alimaliza 10K kwa 0:50:00']);
  assert.equal((await rewards.getRedemption({ userId: u, id: claimed.redemption.id })).redemption.eventTitle, 'Dar Half Marathon');
  const view = await medals.achievements({ userId: u });
  assert.deepEqual(Object.keys(view.achievements[0].progress), ['current', 'target']);
  const err = await h.call(runs.linkEventRun, { sub: u, userType: 'member' }, { params: { id: f.regs[0].id }, body: { activityId: 'x' } });
  assert.deepEqual([err.status, err.body.error, err.body.message, err.body.messageSw], [400, 'idempotency_key_required', 'The request is missing its unique key.', 'Ombi halina ufunguo wake wa kipekee.']);
  assert.deepEqual(errorText('dispute_open'), { message: 'You already have a question open for this result.', messageSw: 'Tayari una swali lililo wazi kuhusu matokeo haya.' });
  assert.deepEqual(errorText('no_such_code'), {});
  // the organizer detail keeps its nested shape; the filter and reason code names stay
  const det = await svc.detail({ ...ctx(f, a.owner), registrationId: f.regs[0].id });
  assert.deepEqual(Object.keys(det).sort(), ['disputes', 'linkedRun', 'result', 'revisions']);
  assert.equal((await svc.list({ ...ctx(f, a.owner), query: { status: 'needs_review' } })).items.length, 0);
  const row = await h.current(f.regs[0].id);
  assert.equal((await svc.correct({ ...ctx(f, a.owner), resultId: row.id, key: h.key(), body: { expectedRevision: row.revision, reasonCode: 'late_finish_data', note: 'Late finish line data arrived', netTime: '0:49:50' } })).status, 200);
});

test('Swahili and wording: no doubled "kwa sababu", "ilighairiwa", "ya awali", short dispute titles, finisher achievements, "kundi" not "kategoria", neutral sample note, inbox-only notices follow the language', async () => {
  const revoked = COPY.medalRevoked({ medal: 'X', reason: 'other' });
  assert.equal(revoked.sw.body, 'Medali ya X imeondolewa kwa sababu nyingine.');
  assert.equal(COPY.rewardReversed({ reward: 'Z', reason: 'other' }).sw.body.includes('kwa sababu kwa sababu'), false);
  assert.match(COPY.artTakenDown({ event: 'E', reason: 'other' }).sw.body, /kwa sababu nyingine\.$/);
  assert.match(COPY.medalRevoked({ medal: 'X', reason: 'registration_cancelled' }).sw.body, /tiketi yako ilighairiwa/);
  assert.match(COPY.medalRevoked({ medal: 'X', reason: 'event_cancelled' }).sw.body, /tukio lilighairiwa/);
  assert.equal(REASON_WORD.registration_cancelled.sw.includes('futwa'), false);
  assert.match(COPY.resultPublished({ event: 'E', stage: 'provisional' }).sw.body, /ni ya awali\.$/);
  for (const o of ['upheld', 'rejected', 'open', 'withdrawn']) assert.ok(COPY.disputeUpdate({ outcome: o }).sw.title.length <= 28 && COPY.disputeUpdate({ outcome: o }).en.title.length <= 28, o);
  const defs = await db('AchievementDefinition').whereIn('key', ['half_marathon_finish', 'marathon_finish']).orderBy('key');
  assert.deepEqual(defs.map(d => d.title.sw), ['Amemaliza nusu marathoni', 'Amemaliza marathoni']);
  assert.equal(medals && true, true);
  assert.equal(SAMPLE_CSV.includes('Withdrew'), false);
  const { f, a, o } = await setup({ n: 2 });
  const t = (await medals.create({ actor: a.owner, organizerId: o.id, eventId: f.event.id, key: h.key(), body: { name: name('Top'), rule: { type: 'placing', scope: 'category', top: 1 } } })).template;
  assert.equal(t.ruleSummary.sw.includes('kategoria'), false);
  assert.match(t.ruleSummary.sw, /\(kundi\)/);
  assert.match((await medals.create({ actor: a.owner, organizerId: o.id, eventId: f.event.id, key: h.key(), body: { name: name('Top all'), rule: { type: 'placing', scope: 'overall', top: 1 } } })).template.ruleSummary.sw, /\(jumla\)/);
  // inbox-only release notices (above the push cap) use the person's language at the top level and keep both in data
  await db('CommunicationPreference').insert({ id: f.regs[0].userId, locale: 'sw' }).onConflict('id').merge({ locale: 'sw' });
  process.env.EVENTS_RESULTS_PUSH_MAX = '0';
  await official(f, a, f.regs.map((r, i) => [r.bib, `0:${50 + i}:00`]), 'provisional');
  const sw = await db('Notification').where({ userId: f.regs[0].userId, type: 'event_result_published' }).first();
  const en = await db('Notification').where({ userId: f.regs[1].userId, type: 'event_result_published' }).first();
  assert.deepEqual([sw.title, sw.data.locale, sw.data.titleEn, en.title, en.data.locale, en.data.titleSw], ['Matokeo yametoka', 'sw', 'Results are out', 'Results are out', 'en', 'Matokeo yametoka']);
  assert.match(sw.body, /ni ya awali\.$/);
});

test('an orphan run is not left behind: a run recorded for a combined create that is then refused is deleted again, and a verified result is refused before anything is recorded', async () => {
  const { f, a } = await setup({ n: 2, over: { eventOver: { eventType: 'virtual' }, categories: [{ name: '5K', distanceMeters: 5000, tickets: [{ name: 'Std', priceTzs: 10000, capacity: 100 }] }] } });
  const startMs = Date.now() - 1.5 * H;
  const track = (meters, lat0 = -6.8) => [Array.from({ length: Math.round(meters / 15) + 1 }, (_, i) => [lat0 + (i * 15) / 111_320, 39.28, 10, startMs + i * 5000, 5])];
  const u = f.regs[0].userId;
  // a stub recorder that stores a SHORT run although the upload looked long enough: the assessment after recording refuses it
  const stub = new Map();
  const recordShort = async (userId) => {
    const id = `act_orphan_${Math.random().toString(36).slice(2, 10)}`;
    await db('Activity').insert({ id, userId, type: 'running', source: 'fitflex', startedAt: new Date(startMs), hasRoute: true, shareWith: JSON.stringify({}), createdAt: new Date() });
    await db('ActivityRoute').insert({ id, userId, segments: JSON.stringify(track(1000)), createdAt: new Date() });
    stub.set(userId, id);
    return { activity: { id, userId, type: 'running', source: 'fitflex', hasRoute: true } };
  };
  const svcWithStub = createEventsRunLinkService({ db, results: svc, recordRun: recordShort });
  const out = await svcWithStub.createAndLink({ userId: u, registrationId: f.regs[0].id, body: { clientRef: 'cref-orphan-01', segments: track(5100) } });
  assert.equal(out.error, 'distance_too_short', JSON.stringify(out).slice(0, 300));
  assert.equal(await db('Activity').where({ id: stub.get(u) }).first(), undefined, 'the orphan run is deleted');
  assert.equal(await db('ActivityRoute').where({ id: stub.get(u) }).first(), undefined);
  assert.equal(await db('EventActivityLink').where({ clientRef: 'cref-orphan-01' }).first(), undefined);
  // a verified result: refused up front, nothing recorded
  await official(f, a, [['1002', '0:50:00']]);
  const before = await db('Activity').where({ userId: f.regs[1].userId }).count().then(r => Number(r[0].count));
  const refused = await (await import('../src/bootstrap/services.mjs')).eventsRunLinkService.createAndLink({ userId: f.regs[1].userId, registrationId: f.regs[1].id, body: { clientRef: 'cref-exists-01', segments: track(5100, -6.7) } });
  assert.equal(refused.error, 'result_exists');
  assert.equal(await db('Activity').where({ userId: f.regs[1].userId }).count().then(r => Number(r[0].count)), before);
});
