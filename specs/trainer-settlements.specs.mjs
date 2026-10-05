// Trainer payouts: a weekly statement per trainer for sessions that were
// completed or took place, approved by a second person and paid only to a
// verified payout account. A session is paid once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { trainers, gyms, users, partnerGate, gymService } from '../src/bootstrap/services.mjs';
import { partnerSettlementAccounts } from '../src/bootstrap/collections.mjs';
import { ensureInit } from '../functions/index.mjs';
import { createPayoutEligibility } from '../src/services/payout-eligibility.mjs';
import {
  createTrainerSettlementService, weekOf, lastEndedWeek, payableBasis, eatToday, TOOK_PLACE_AFTER_HOURS,
} from '../src/services/trainer-settlement-service.mjs';
import { deliveredTo } from './fixtures/notification-language.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const NOW = new Date('2026-10-14T09:00:00Z'); // a Wednesday; last ended week = 5–11 Oct
const WEEK = { periodStartDate: '2026-10-05', periodEndDate: '2026-10-11' };
const made = { users: [], trainers: [], gyms: [] };
const inbox = [];
let clock = NOW;

const eligibility = createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers });
const svc = createTrainerSettlementService({
  trainers, users, payoutEligibility: eligibility, now: () => clock,
  notify: async (userId, message) => { inbox.push({ userId, ...message }); },
});

async function user(userType) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Payout ${userType}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}

async function gym() {
  const id = uid('gym');
  await gyms.upsertAsync(g => g.id === id, gymService.normalizeGymPayload({ id, name: `Payout Gym ${id}`, tier: 'standard', location: 'Masaki' }, {}));
  made.gyms.push(id);
  return id;
}

/** A trainer; `verified` gives them approved KYC and a payout account past its hold. */
async function trainer(gymId, { verified = true } = {}) {
  const userId = await user('trainer');
  const id = uid('trn');
  await trainers.insertAsync({ id, userId, displayName: `Coach ${id}`, status: 'active', approvalStatus: 'approved', gymIds: [gymId], hourlyRateTzs: 20000 });
  made.trainers.push(id);
  if (verified) {
    const caseId = uid('kyc');
    await db('PartnerKycCase').insert({ id: caseId, partnerType: 'trainer', userId, status: 'approved', tier: 2, updatedAt: new Date() });
    await db('PartnerSettlementAccount').insert({
      id: uid('psa'), caseId, method: 'mobile_money', provider: 'mpesa', accountName: 'Coach', accountNumber: '0754000777',
      status: 'verified', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z'), cooldownUntil: new Date('2026-09-03T00:00:00Z'), updatedAt: new Date(),
    });
  }
  return { id, userId };
}

/** A session priced the current way: member pays 18,000 of 20,000 (FitFlex funds the rest), trainer earns 17,000. */
async function booking({ trainerId, memberId, gymId, date, slot = '10:00', status = 'confirmed', payout = 17000 }) {
  const id = uid('tbk');
  await db('TrainerBooking').insert({
    id, memberId, trainerId, gymId, date, slot, status,
    listPriceTzs: payout ? 20000 : 0, amountTzs: payout ? 18000 : 0, commissionTzs: payout ? 3000 : 0, trainerPayoutTzs: payout,
    discountPct: payout ? 10 : 0, discountFundedBy: payout ? 'fitflex' : null,
  });
  return id;
}

const mine = (statements, trainerId) => statements.filter(s => s.trainerId === trainerId);
const statementOf = async (trainerId, periodStartDate = WEEK.periodStartDate) =>
  db('TrainerSettlement').where({ trainerId, periodStartDate }).whereNot({ status: 'voided' }).first();

after(async () => {
  // Paid and voided statements are final by design, so they stay; everything they point at goes.
  await db('TrainerSettlement').whereIn('trainerId', made.trainers).where({ status: 'draft' }).del();
  for (const id of made.trainers) await trainers.removeAsync(t => t.id === id);
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  if (made.users.length) {
    await db('AuditLog').whereIn('actor', made.users).del();
    await db('User').whereIn('id', made.users).del();
  }
});

// ── Weeks and what is payable ───────────────────────────────────────────────

test('a week runs Monday to Sunday in East Africa Time; the last ended week is the one before this one', () => {
  assert.deepEqual(weekOf('2026-10-08'), WEEK);
  assert.deepEqual(weekOf('2026-10-05'), WEEK);
  assert.deepEqual(weekOf('2026-10-11'), WEEK);
  assert.deepEqual(lastEndedWeek(NOW), WEEK);
  // 22:30 UTC on Sunday is already Monday in EAT.
  assert.equal(eatToday(new Date('2026-10-11T22:30:00Z')), '2026-10-12');
  assert.deepEqual(lastEndedWeek(new Date('2026-10-11T22:30:00Z')), WEEK);
});

test('a session is payable once completed, or 48 hours after a paid session that was never cancelled', () => {
  assert.equal(TOOK_PLACE_AFTER_HOURS, 48);
  const b = (extra) => ({ date: '2026-10-08', slot: '10:00', status: 'confirmed', trainerPayoutTzs: 17000, ...extra });
  assert.equal(payableBasis(b({ status: 'completed' }), NOW), 'completed');
  assert.equal(payableBasis(b({}), NOW), 'took_place');
  assert.equal(payableBasis(b({ date: '2026-10-13' }), NOW), null, 'only 26 hours ago');
  assert.equal(payableBasis(b({ status: 'cancelled' }), NOW), null);
  assert.equal(payableBasis(b({ status: 'payment_pending' }), NOW), null);
  assert.equal(payableBasis(b({ status: 'completed', trainerPayoutTzs: 0 }), NOW), null, 'a free session pays nothing');
});

// ── The whole path ──────────────────────────────────────────────────────────

test('prepare, submit, approve by a second person, clear and pay; the trainer is told and sees it', async () => {
  clock = NOW;
  const gymId = await gym();
  const memberId = await user('member');
  const a = await trainer(gymId);
  const [maker, checker] = [await user('admin'), await user('admin')];
  const done = await booking({ trainerId: a.id, memberId, gymId, date: '2026-10-06', status: 'completed' });
  const tookPlace = await booking({ trainerId: a.id, memberId, gymId, date: '2026-10-08' });
  await booking({ trainerId: a.id, memberId, gymId, date: '2026-10-13', slot: '08:00' });            // next week
  await booking({ trainerId: a.id, memberId, gymId, date: '2026-10-07', status: 'cancelled' });       // cancelled
  await booking({ trainerId: a.id, memberId, gymId, date: '2026-10-07', slot: '12:00', status: 'completed', payout: 0 }); // free

  assert.deepEqual(await svc.prepare({ periodStart: '2026-10-06', actorId: maker }), { error: 'period_must_start_on_monday', status: 400, monday: '2026-10-05' });
  assert.equal((await svc.prepare({ periodStart: '2026-10-12', actorId: maker })).error, 'week_not_ended');
  assert.equal((await svc.prepare({})).error, 'actor_required');

  const prepared = await svc.prepare({ actorId: maker });
  assert.deepEqual([prepared.periodStartDate, prepared.periodEndDate], [WEEK.periodStartDate, WEEK.periodEndDate]);
  const [draft] = mine(prepared.statements, a.id);
  assert.deepEqual([draft.sessionCount, draft.finalNetTzs], [2, 34000]);

  // Preparing again rebuilds the draft rather than adding a second one.
  const again = await svc.prepare({ actorId: maker });
  assert.equal(mine(again.statements, a.id)[0].id, draft.id);
  assert.equal((await db('TrainerSettlementLine').where({ trainerSettlementId: draft.id })).length, 2);

  const detail = await svc.get(draft.id);
  assert.deepEqual([detail.statement.status, detail.statement.listTzs, detail.statement.commissionTzs, detail.statement.trainer.id], ['draft', 40000, 6000, a.id]);
  assert.deepEqual(detail.lines.map(l => [l.bookingId, l.basis, l.payoutTzs]).sort(), [[done, 'completed', 17000], [tookPlace, 'took_place', 17000]].sort());
  assert.equal(detail.payout.ok, true);
  // A draft is not shown to the trainer yet.
  assert.equal((await svc.listMine({ trainerId: a.id })).statements.length, 0);

  assert.equal((await svc.approve({ id: draft.id, actorId: checker })).error, 'invalid_status');
  assert.equal((await svc.submit({ id: draft.id, actorId: maker })).statement.status, 'submitted');
  assert.deepEqual(await svc.approve({ id: draft.id, actorId: maker }), { error: 'cannot_approve_own_submission', status: 403 });
  assert.equal((await svc.approve({ id: draft.id, actorId: checker })).statement.status, 'approved');

  // A hold blocks payment and pulls a payable statement back.
  assert.equal((await svc.hold({ id: draft.id, actorId: maker })).error, 'reason_required');
  await svc.hold({ id: draft.id, reason: 'Member disputes a session', actorId: maker });
  assert.deepEqual(await svc.markPayable({ id: draft.id, actorId: checker }), { error: 'on_hold', status: 409, holdReason: 'Member disputes a session' });
  await svc.release({ id: draft.id, actorId: checker });
  const payable = await svc.markPayable({ id: draft.id, actorId: checker });
  assert.equal(payable.statement.status, 'payable');
  assert.equal((await svc.hold({ id: draft.id, reason: 'Wait', actorId: maker })).statement.status, 'approved');
  await svc.release({ id: draft.id, actorId: checker });
  await svc.markPayable({ id: draft.id, actorId: checker });

  assert.equal((await svc.pay({ id: draft.id, actorId: checker })).error, 'payment_reference_required');
  const paid = await svc.pay({ id: draft.id, paymentReference: 'MPESA-TR1', actorId: checker });
  assert.deepEqual([paid.statement.status, paid.statement.paymentReference, paid.statement.paidBy], ['paid', 'MPESA-TR1', checker]);
  const note = inbox.find(n => n.userId === a.userId);
  assert.equal(note.type, 'trainer_payout_paid');
  assert.match(note.body, /TZS 34,000 for 2 session\(s\).*MPESA-TR1/);
  // A trainer who reads Swahili gets it in Swahili; without a chosen language, the English above.
  const sw = await deliveredTo(note, 'sw');
  assert.equal(sw.title, 'Malipo yako yametumwa');
  assert.match(sw.body, /^FitFlex imekutumia TZS 34,000 kwa vipindi 2, \d{4}-\d\d-\d\d hadi \d{4}-\d\d-\d\d\. Kumbukumbu: MPESA-TR1\.$/);
  const en = await deliveredTo(note, null);
  assert.deepEqual([en.title, en.body], ['Payout sent', note.body]);

  // The trainer sees it, without staff ids, and with where it went.
  const view = await svc.listMine({ trainerId: a.id });
  assert.equal(view.payoutReady, true);
  assert.deepEqual([view.statements[0].status, view.statements[0].finalNetTzs, view.statements[0].paidTo.accountLast4], ['paid', 34000, '0777']);
  assert.ok(!('paidBy' in view.statements[0]) && !('destinationSnapshot' in view.statements[0]));
  assert.equal((await svc.getMine({ trainerId: a.id, id: draft.id })).lines.length, 2);
  assert.equal((await svc.getMine({ trainerId: 'trn_other', id: draft.id })).error, 'statement_not_found');

  // Paid is final, in the service and in the database.
  assert.equal((await svc.voidStatement({ id: draft.id, reason: 'x', actorId: checker })).error, 'invalid_status');
  await assert.rejects(db('TrainerSettlement').where({ id: draft.id }).update({ finalNetTzs: 1 }), /final/);

  // Next week: the paid sessions are not paid again; the 13 Oct session now is.
  clock = new Date(+NOW + 7 * 86_400_000);
  const next = await svc.prepare({ actorId: maker });
  assert.equal(next.periodStartDate, '2026-10-12');
  const [second] = mine(next.statements, a.id);
  assert.deepEqual([second.sessionCount, second.finalNetTzs], [1, 17000]);
});

test('a trainer without approved KYC and a verified payout account cannot be cleared for payment', async () => {
  clock = NOW;
  const gymId = await gym();
  const memberId = await user('member');
  const b = await trainer(gymId, { verified: false });
  const [maker, checker] = [await user('admin'), await user('admin')];
  await booking({ trainerId: b.id, memberId, gymId, date: '2026-10-09', status: 'completed', payout: 8500 });
  await svc.prepare({ actorId: maker });
  const draft = await statementOf(b.id);
  await svc.submit({ id: draft.id, actorId: maker });
  await svc.approve({ id: draft.id, actorId: checker });
  assert.deepEqual(await svc.markPayable({ id: draft.id, actorId: checker }), { error: 'not_payable', status: 409, reason: 'kyc_not_started' });
  const view = await svc.listMine({ trainerId: b.id });
  assert.deepEqual([view.payoutReady, view.payoutBlockedBy, view.statements[0].status], [false, 'kyc_not_started', 'approved']);

  // An account still inside its 48-hour hold is not enough either.
  const caseId = uid('kyc');
  await db('PartnerKycCase').insert({ id: caseId, partnerType: 'trainer', userId: b.userId, status: 'approved', tier: 2, updatedAt: new Date() });
  await db('PartnerSettlementAccount').insert({
    id: uid('psa'), caseId, method: 'mobile_money', provider: 'mpesa', accountName: 'Coach', accountNumber: '0754000888',
    status: 'verified', isPrimary: true, verifiedAt: new Date('2026-10-13T12:00:00Z'), cooldownUntil: new Date('2026-10-15T12:00:00Z'), updatedAt: new Date(),
  });
  const cooling = await svc.markPayable({ id: draft.id, actorId: checker });
  assert.deepEqual([cooling.error, cooling.reason], ['not_payable', 'payout_account_cooling_off']);
  clock = new Date('2026-10-16T09:00:00Z');
  assert.equal((await svc.markPayable({ id: draft.id, actorId: checker })).statement.status, 'payable');
});

test('voiding a statement releases its sessions for the next one; a submitted statement is not rebuilt', async () => {
  clock = NOW;
  const gymId = await gym();
  const memberId = await user('member');
  const c = await trainer(gymId);
  const [maker, checker] = [await user('admin'), await user('admin')];
  const first = await booking({ trainerId: c.id, memberId, gymId, date: '2026-10-06', status: 'completed' });
  await svc.prepare({ actorId: maker });
  const draft = await statementOf(c.id);
  await svc.submit({ id: draft.id, actorId: maker });

  // A session completed after submission waits for the next statement.
  const late = await booking({ trainerId: c.id, memberId, gymId, date: '2026-10-07', status: 'completed' });
  const rerun = await svc.prepare({ actorId: maker });
  assert.equal(mine(rerun.statements, c.id).length, 0);
  assert.equal((await db('TrainerSettlementLine').where({ trainerSettlementId: draft.id })).length, 1);

  assert.equal((await svc.reject({ id: draft.id, actorId: checker })).error, 'reason_required');
  assert.equal((await svc.voidStatement({ id: draft.id, actorId: checker })).error, 'reason_required');
  const voided = await svc.voidStatement({ id: draft.id, reason: 'Prepared with the wrong sessions', actorId: checker });
  assert.equal(voided.statement.status, 'voided');

  const redo = await svc.prepare({ actorId: maker });
  const [fresh] = mine(redo.statements, c.id);
  assert.notEqual(fresh.id, draft.id);
  assert.deepEqual([fresh.sessionCount, fresh.finalNetTzs], [2, 34000]);
  const lines = await db('TrainerSettlementLine').where({ trainerSettlementId: fresh.id });
  assert.deepEqual(lines.map(l => l.bookingId).sort(), [first, late].sort());

  // The database refuses to put a session on two live statements, or to skip steps.
  await assert.rejects(db('TrainerSettlementLine').insert({ id: randomUUID(), trainerSettlementId: fresh.id, bookingId: first, date: '2026-10-06', basis: 'completed', payoutTzs: 17000 }), /trainer_settlement_line_booking_ux/);
  await assert.rejects(db('TrainerSettlement').where({ id: fresh.id }).update({ status: 'paid', paidAt: new Date(), paymentReference: 'X', destinationSnapshot: '{}' }), /not an allowed transition/);

  // A draft whose sessions were all cancelled since is removed when prepared again.
  await db('TrainerBooking').whereIn('id', [first, late]).update({ status: 'cancelled' });
  const cleared = await svc.prepare({ actorId: maker });
  assert.equal(mine(cleared.statements, c.id).length, 0);
  assert.equal(await statementOf(c.id), undefined);
});

test('admin list filters by status and names the trainer', async () => {
  const all = await svc.list({ status: 'paid' });
  assert.ok(all.statements.length >= 1);
  assert.ok(all.statements.every(s => s.status === 'paid'));
  const one = all.statements.find(s => made.trainers.includes(s.trainerId));
  assert.match(one.trainer.displayName, /^Coach /);
  assert.equal((await svc.list({ status: 'nope' })).error, 'invalid_status');
  assert.equal((await svc.get('tst_missing')).error, 'statement_not_found');
});
