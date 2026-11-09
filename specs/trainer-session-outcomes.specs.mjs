// Phase B · B1a — trainer session outcomes (Complete + No-show), against the CI database.
//
//  - Completing a session needs it confirmed and started — always, flag or not
//    (completing made a future session payable at once).
//  - TRAINER_SESSION_OUTCOMES on: the trainer may record a no-show from the
//    start until 48h after it; the trainer is paid in full (basis no_show), the
//    member is not refunded, a sponsor benefit is used as if the session took
//    place, the member is told and may still review the trainer.
//  - Admin may overturn (no_show ⇄ completed / cancelled), except once the
//    session is on a submitted/approved/payable/paid trainer statement.
//  - Bookings carry actions { canComplete, canMarkNoShow } only with the flag on.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { withLedgerDelete } from './fixtures/ledger-cleanup.mjs';
import { notifications, trainerReviews } from '../src/bootstrap/collections.mjs';
import {
  gyms, trainers, b2bService, b2bProgramService, trainerBookingService, trainerSettlementService, trainerReviewService,
} from '../src/bootstrap/services.mjs';
import { trainerSessionsForDate } from '../functions/trainer-engagements.mjs';
import { adminDecidePaymentRequest, adminUpdatePaymentRequest } from '../functions/admin-payments.mjs';
import {
  createTrainerBooking, trainerCompleteBooking, trainerNoShowBooking, trainerMyBookings, memberMyBookings, adminListTrainerBookings, adminUpdateTrainerBooking,
} from '../functions/trainer-bookings.mjs';
import { sessionActions, NO_SHOW_WINDOW_HOURS } from '../src/services/trainer-booking-service.mjs';
import { payableBasis } from '../src/services/trainer-settlement-service.mjs';

await ensureInit();

const FLAG = 'TRAINER_SESSION_OUTCOMES';
const flagOn = () => { process.env[FLAG] = 'on'; };
const flagOff = () => { delete process.env[FLAG]; };
afterEach(flagOff);

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const made = { users: [], orgs: [], gyms: [], trainers: [] };

/** `date` + `slot` (EAT, whole minutes) for a moment `offsetMs` from now. */
function eatSlot(offsetMs) {
  const t = new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000 + 3 * HOUR).toISOString();
  return { date: t.slice(0, 10), slot: t.slice(11, 16) };
}

async function user(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Outcome ${userType} ${id.slice(-4)}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}

async function scene() {
  const gymId = uid('gym');
  await gyms.insertAsync({ id: gymId, name: `Outcome Gym ${gymId.slice(-4)}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000 });
  made.gyms.push(gymId);
  const trainerUserId = await user('trainer');
  const trainerId = uid('trn');
  await trainers.insertAsync({ id: trainerId, userId: trainerUserId, displayName: 'Coach Outcome', status: 'active', approvalStatus: 'approved', gymIds: [gymId], hourlyRateTzs: 20000 });
  made.trainers.push(trainerId);
  const memberId = await user('member');
  const adminId = await user('admin');
  return {
    gymId, trainerId, trainerUserId, memberId, adminId,
    trainer: { sub: trainerUserId, userType: 'trainer' },
    member: { sub: memberId, userType: 'member' },
    admin: { sub: adminId, userType: 'admin' },
  };
}

/** A paid session: member pays 18,000, trainer earns 17,000. */
async function booking(s, { offsetMs = -2 * HOUR, at = null, status = 'confirmed', memberId = s.memberId } = {}) {
  const id = uid('tbk');
  const when = at || eatSlot(offsetMs);
  await db('TrainerBooking').insert({
    id, groupId: id, memberId, trainerId: s.trainerId, gymId: s.gymId, date: when.date, slot: when.slot, status,
    listPriceTzs: 20000, amountTzs: 18000, commissionTzs: 3000, trainerPayoutTzs: 17000, discountPct: 10, discountFundedBy: 'fitflex',
    createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

const statusOf = async id => (await db('TrainerBooking').where({ id }).first()).status;
const auditFor = (id, action) => db('AuditLog').where({ target: id, action });

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(route, { claims, params = {}, body = {}, query = {} } = {}) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

after(async () => {
  flagOff();
  if (made.orgs.length) {
    const ids = await db('B2BBenefitConsumption').whereIn('organizationId', made.orgs).pluck('id');
    await db('AuditLog').whereIn('target', ids).del();
    await withLedgerDelete(db, trx => trx('B2BBenefitConsumption').whereIn('organizationId', made.orgs).del());
    await db('B2BOrganization').whereIn('id', made.orgs).del();
  }
  await db('TrainerSettlement').whereIn('trainerId', made.trainers).where({ status: 'draft' }).del();
  for (const id of made.users) await trainerReviews.removeAsync(r => r.memberId === id);
  await db('AuditLog').whereIn('target', db('Refund').whereIn('memberId', made.users).select('id')).del();
  await db('Refund').whereIn('memberId', made.users).del();
  await db('AuditLog').whereIn('target', db('TrainerBooking').whereIn('memberId', made.users).select('id')).del();
  await db('TrainerBooking').whereIn('memberId', made.users).del();
  for (const id of made.users) await notifications.removeAsync(n => n.userId === id);
  await db('CommunicationPreference').whereIn('id', made.users).del();
  for (const id of made.trainers) await trainers.removeAsync(t => t.id === id);
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('AuditLog').whereIn('actor', made.users).del();
  await db('User').whereIn('id', made.users).del();
});

// ── The rules, without the database ─────────────────────────────────────────

test('actions: trainer Complete once started; No-show from the start until 48h after; members never; admins by status', () => {
  const now = new Date('2026-10-20T09:00:00Z'); // 12:00 EAT
  const b = extra => ({ date: '2026-10-20', slot: '12:00', status: 'confirmed', ...extra });
  assert.equal(NO_SHOW_WINDOW_HOURS, 48);
  assert.deepEqual(sessionActions(b({ slot: '12:01' }), { now }), { canComplete: false, canMarkNoShow: false }, 'not started');
  assert.deepEqual(sessionActions(b(), { now }), { canComplete: true, canMarkNoShow: true }, 'at the start');
  assert.deepEqual(sessionActions(b({ date: '2026-10-18' }), { now }), { canComplete: true, canMarkNoShow: true }, 'exactly 48h after');
  assert.deepEqual(sessionActions(b({ date: '2026-10-18', slot: '11:59' }), { now }), { canComplete: true, canMarkNoShow: false }, 'past 48h');
  for (const status of ['payment_pending', 'completed', 'no_show', 'cancelled']) {
    assert.deepEqual(sessionActions(b({ status }), { now }), { canComplete: false, canMarkNoShow: false }, status);
  }
  assert.deepEqual(sessionActions(b(), { viewer: 'member', now }), { canComplete: false, canMarkNoShow: false });
  assert.deepEqual(sessionActions(b({ status: 'no_show' }), { viewer: 'admin', now }), { canComplete: true, canMarkNoShow: false });
  assert.deepEqual(sessionActions(b({ status: 'completed', date: '2026-09-01' }), { viewer: 'admin', now }), { canComplete: false, canMarkNoShow: true });
  assert.deepEqual(sessionActions(b({ slot: '13:00' }), { viewer: 'admin', now }), { canComplete: true, canMarkNoShow: false });
  assert.deepEqual(sessionActions(b(), { viewer: 'admin', now, locked: true }), { canComplete: false, canMarkNoShow: false });
});

test('a no-show is paid on basis no_show; other statuses are unchanged', () => {
  const b = extra => ({ date: '2026-10-08', slot: '10:00', trainerPayoutTzs: 17000, ...extra });
  const now = new Date('2026-10-09T00:00:00Z');
  assert.equal(payableBasis(b({ status: 'no_show' }), now), 'no_show');
  assert.equal(payableBasis(b({ status: 'no_show', trainerPayoutTzs: 0 }), now), null, 'a free session pays nothing');
  assert.equal(payableBasis(b({ status: 'completed' }), now), 'completed');
  assert.equal(payableBasis(b({ status: 'confirmed' }), now), null);
});

// ── Flag off ────────────────────────────────────────────────────────────────

test('flag off: Complete refuses a session that has not started, completes a started one with an audit row; no no-show, no actions', async () => {
  flagOff();
  const s = await scene();
  const future = await booking(s, { offsetMs: 3 * HOUR });
  const started = await booking(s, { offsetMs: -1 * HOUR });

  const early = await call(trainerCompleteBooking, { claims: s.trainer, params: { id: future } });
  assert.equal(early.statusCode, 409);
  assert.equal(early.body.error, 'session_not_started');
  assert.ok(Date.parse(early.body.startsAt) > Date.now(), JSON.stringify(early.body));
  assert.equal(await statusOf(future), 'confirmed', 'the future session is not payable');

  const done = await call(trainerCompleteBooking, { claims: s.trainer, params: { id: started } });
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'completed');
  assert.equal('actions' in done.body, false);
  const [row] = await auditFor(started, 'trainer_booking_completed_by_trainer');
  assert.equal(row.actor, s.trainerUserId);

  assert.deepEqual([(await call(trainerCompleteBooking, { claims: s.trainer, params: { id: started } })).body.error], ['booking_not_confirmable']);

  const noShow = await call(trainerNoShowBooking, { claims: s.trainer, params: { id: future } });
  assert.deepEqual([noShow.statusCode, noShow.body.error], [404, 'feature_disabled']);

  const mine = await call(trainerMyBookings, { claims: s.trainer });
  assert.ok(mine.body.length >= 2 && mine.body.every(b => !('actions' in b)));
  const member = await call(memberMyBookings, { claims: s.member });
  assert.ok(member.body.every(b => !('actions' in b)));
  const admin = await call(adminListTrainerBookings, { claims: s.admin });
  assert.ok(admin.body.filter(b => b.trainerId === s.trainerId).every(b => !('actions' in b)));

  const adminNoShow = await call(adminUpdateTrainerBooking, { claims: s.admin, params: { id: future }, body: { status: 'no_show' } });
  assert.deepEqual([adminNoShow.statusCode, adminNoShow.body.error], [400, 'invalid_status']);
  // Owner decision 2026-10-20: admins can't complete a session before it starts either.
  const adminDone = await call(adminUpdateTrainerBooking, { claims: s.admin, params: { id: future }, body: { status: 'completed' } });
  assert.deepEqual([adminDone.statusCode, adminDone.body.error], [409, 'session_not_started']);
});

// ── Flag on: the trainer ────────────────────────────────────────────────────

test('flag on: no-show only for a confirmed session from its start until 48h after; the member is told; actions follow', async () => {
  flagOn();
  const s = await scene();
  const before = await booking(s, { offsetMs: 3 * HOUR });
  const during = await booking(s, { offsetMs: -2 * HOUR });
  const late = await booking(s, { offsetMs: -50 * HOUR });
  const unpaid = await booking(s, { offsetMs: -2 * HOUR, status: 'payment_pending' });

  const early = await call(trainerNoShowBooking, { claims: s.trainer, params: { id: before } });
  assert.deepEqual([early.statusCode, early.body.error], [409, 'session_not_started']);
  assert.ok(early.body.startsAt);
  const tooLate = await call(trainerNoShowBooking, { claims: s.trainer, params: { id: late } });
  assert.deepEqual([tooLate.statusCode, tooLate.body.error], [409, 'no_show_window_passed']);
  assert.ok(Date.parse(tooLate.body.closedAt) < Date.now());
  const notPaid = await call(trainerNoShowBooking, { claims: s.trainer, params: { id: unpaid } });
  assert.deepEqual([notPaid.statusCode, notPaid.body.error], [409, 'booking_not_confirmed']);
  const other = await scene();
  const notMine = await call(trainerNoShowBooking, { claims: other.trainer, params: { id: during } });
  assert.deepEqual([notMine.statusCode, notMine.body.error], [404, 'booking_not_found']);
  assert.deepEqual(await Promise.all([before, late, unpaid, during].map(statusOf)), ['confirmed', 'confirmed', 'payment_pending', 'confirmed']);

  // Actions in every list say what the caller can do.
  const actionsOf = list => Object.fromEntries(list.filter(b => b.trainerId === s.trainerId).map(b => [b.id, b.actions]));
  const t = actionsOf((await call(trainerMyBookings, { claims: s.trainer })).body);
  assert.deepEqual(t[before], { canComplete: false, canMarkNoShow: false });
  assert.deepEqual(t[during], { canComplete: true, canMarkNoShow: true });
  assert.deepEqual(t[late], { canComplete: true, canMarkNoShow: false });
  assert.deepEqual(t[unpaid], { canComplete: false, canMarkNoShow: false });
  const m = actionsOf(await (await call(memberMyBookings, { claims: s.member })).body);
  assert.ok(Object.values(m).length === 4 && Object.values(m).every(a => !a.canComplete && !a.canMarkNoShow));
  const a = actionsOf((await call(adminListTrainerBookings, { claims: s.admin })).body);
  assert.deepEqual(a[during], { canComplete: true, canMarkNoShow: true });

  const marked = await call(trainerNoShowBooking, { claims: s.trainer, params: { id: during } });
  assert.equal(marked.statusCode, 200, JSON.stringify(marked.body));
  assert.equal(marked.body.status, 'no_show');
  assert.deepEqual(marked.body.actions, { canComplete: false, canMarkNoShow: false });
  const [row] = await auditFor(during, 'trainer_booking_no_show');
  assert.deepEqual([row.actor, row.before.status, row.after.status], [s.trainerUserId, 'confirmed', 'no_show']);
  const again = await call(trainerNoShowBooking, { claims: s.trainer, params: { id: during } });
  assert.deepEqual([again.statusCode, again.body.error], [409, 'booking_not_confirmed']);

  const inbox = await notifications.filterAsync(n => n.userId === s.memberId && n.type === 'trainer_booking_no_show');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].data.bookingId, during);
  assert.equal(inbox[0].data.titleSw, 'Hukuhudhuria kipindi');
  assert.match(inbox[0].body, /not refunded/);
  assert.match(inbox[0].data.bodySw, /Hutarejeshewa pesa/);

  // No refund for a no-show, and it still counts as the trainer's earnings.
  assert.equal((await db('Refund').where({ bookingId: during })).length, 0);
  const earned = await trainerBookingService.trainerEarnings({ userId: s.trainerUserId, from: null, to: null });
  assert.ok(earned.earnings.bookingCount >= 1);

  // Complete keeps its rules with the flag on.
  const earlyDone = await call(trainerCompleteBooking, { claims: s.trainer, params: { id: before } });
  assert.deepEqual([earlyDone.statusCode, earlyDone.body.error], [409, 'session_not_started']);
  const lateDone = await call(trainerCompleteBooking, { claims: s.trainer, params: { id: late } });
  assert.equal(lateDone.body.status, 'completed');
  assert.deepEqual(lateDone.body.actions, { canComplete: false, canMarkNoShow: false });
});

test('flag on: the member can still review the trainer after a no-show', async () => {
  flagOn();
  const s = await scene();
  assert.equal((await trainerReviewService.isEligible(s.memberId, s.trainerId)).eligible, false);
  const id = await booking(s, { offsetMs: -1 * HOUR });
  assert.ok((await trainerBookingService.trainerMarkNoShow({ userId: s.trainerUserId, bookingId: id })).booking);
  assert.equal((await trainerReviewService.isEligible(s.memberId, s.trainerId)).eligible, true);
  const review = await trainerReviewService.submit({ memberId: s.memberId, trainerId: s.trainerId, rating: 2, text: 'I could not make it' });
  assert.ok(!review.error, JSON.stringify(review));
});

// ── Payout ──────────────────────────────────────────────────────────────────

test('a no-show goes on the trainer statement in full on basis no_show', async () => {
  const s = await scene();
  // An old week nobody else's spec uses: Monday 2025-03-03 to Sunday 2025-03-09.
  const noShow = await booking(s, { at: { date: '2025-03-04', slot: '10:00' }, status: 'no_show' });
  const done = await booking(s, { at: { date: '2025-03-05', slot: '10:00' }, status: 'completed' });
  const prepared = await trainerSettlementService.prepare({ periodStart: '2025-03-03', actorId: s.adminId });
  assert.ok(!prepared.error, JSON.stringify(prepared));
  const mine = prepared.statements.find(x => x.trainerId === s.trainerId);
  assert.deepEqual([mine.sessionCount, mine.finalNetTzs], [2, 34000]);
  const lines = await db('TrainerSettlementLine').where({ trainerSettlementId: mine.id }).orderBy('date');
  assert.deepEqual(lines.map(l => [l.bookingId, l.basis, l.payoutTzs, l.memberPaidTzs]), [[noShow, 'no_show', 17000, 18000], [done, 'completed', 17000, 18000]]);
});

// ── Sponsor benefit ─────────────────────────────────────────────────────────

async function sponsoredMember(trainerId) {
  const actor = await user('admin');
  const access = orgId => b2bService.resolveAccess({ organizationId: orgId, userType: 'admin', userId: actor });
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'insurer', legalName: `Outcome insurer ${uid('o')}` }, actorId: actor });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: actor });
  const memberId = await user('member');
  const enrolled = await b2bService.enrollBeneficiary({ access: await access(organization.id), body: { userId: memberId, status: 'active' }, actorId: actor });
  assert.ok(enrolled.beneficiary, JSON.stringify(enrolled));
  const a = await access(organization.id);
  const { program } = await b2bProgramService.createProgram({ access: a, body: { name: 'Outcome programme', startDate: '2026-01-01' }, actorId: actor });
  const { benefit } = await b2bProgramService.createBenefit({
    access: a, programId: program.id, actorId: actor,
    body: { name: '4 trainer sessions a month', benefitType: 'trainer_session', fundingType: 'full', usageLimit: 4, usagePeriod: 'month', providerRules: { scope: 'selected', trainerIds: [trainerId] } },
  });
  await b2bProgramService.setBenefitStatus({ access: a, programId: program.id, benefitId: benefit.id, status: 'active', actorId: actor });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'pending', actorId: actor });
  const live = await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'active', actorId: actor });
  assert.equal(live.program?.status, 'active', JSON.stringify(live));
  return memberId;
}

test('flag on: a no-show uses the sponsor benefit as if the session happened; overturning to cancelled gives it back', async () => {
  flagOn();
  const s = await scene();
  const memberId = await sponsoredMember(s.trainerId);
  const id = await booking(s, { offsetMs: -2 * HOUR, memberId });
  const ledger = () => db('B2BBenefitConsumption').where({ sourceType: 'trainer_booking', sourceId: id });

  assert.equal((await ledger()).length, 0);
  const marked = await trainerBookingService.trainerMarkNoShow({ userId: s.trainerUserId, bookingId: id });
  assert.equal(marked.booking.status, 'no_show');
  const [row] = await ledger();
  assert.deepEqual([row.status, row.providerId, row.grossTzs, row.sponsorTzs], ['approved', s.trainerId, 18000, 18000]);
  // As for a completed session: the sponsor covers it, so what the member paid goes back (sponsor_paid) — not a no-show refund.
  assert.deepEqual((await db('Refund').where({ bookingId: id })).map(r => r.reasonCode), ['sponsor_paid']);

  // Admin: no_show → completed keeps the one consumption; completed → no_show too.
  assert.equal((await trainerBookingService.adminUpdateStatus({ id, status: 'completed', actorId: s.adminId })).booking.status, 'completed');
  assert.equal((await trainerBookingService.adminUpdateStatus({ id, status: 'no_show', actorId: s.adminId })).booking.status, 'no_show');
  assert.deepEqual((await ledger()).map(r => r.status), ['approved']);
  // no_show → cancelled: the sponsor is no longer charged.
  assert.equal((await trainerBookingService.adminUpdateStatus({ id, status: 'cancelled', actorId: s.adminId })).booking.status, 'cancelled');
  assert.deepEqual((await ledger()).map(r => r.status), ['reversed']);
});

// ── Admin overturn ──────────────────────────────────────────────────────────

test('flag on: admin overturns within the rules, and not once the session is on a submitted or paid statement', async () => {
  flagOn();
  const s = await scene();
  const id = await booking(s, { offsetMs: -3 * HOUR });
  const set = (bookingId, status) => call(adminUpdateTrainerBooking, { claims: s.admin, params: { id: bookingId }, body: { status } });

  assert.equal((await trainerBookingService.trainerMarkNoShow({ userId: s.trainerUserId, bookingId: id })).booking.status, 'no_show');
  const toDone = await set(id, 'completed');
  assert.equal(toDone.statusCode, 200, JSON.stringify(toDone.body));
  assert.deepEqual([toDone.body.status, toDone.body.actions], ['completed', { canComplete: false, canMarkNoShow: true }]);
  const back = await set(id, 'no_show');
  assert.equal(back.body.status, 'no_show');
  assert.equal((await auditFor(id, 'trainer_booking_no_show')).length, 2, 'the trainer and the admin');

  const future = await booking(s, { offsetMs: 5 * HOUR });
  const early = await set(future, 'no_show');
  assert.deepEqual([early.statusCode, early.body.error], [409, 'session_not_started']);
  const unpaid = await booking(s, { offsetMs: -1 * HOUR, status: 'payment_pending' });
  const wrong = await set(unpaid, 'no_show');
  assert.deepEqual([wrong.statusCode, wrong.body.error, wrong.body.from], [409, 'invalid_transition', 'payment_pending']);

  // Admin cancelling a paid no-show refunds it, as cancelling a completed session does.
  const cancelled = await call(adminUpdateTrainerBooking, { claims: s.admin, params: { id }, body: { status: 'cancelled' } });
  assert.equal(cancelled.body.status, 'cancelled');
  assert.deepEqual((await db('Refund').where({ bookingId: id })).map(r => r.reasonCode), ['cancelled_by_fitflex']);

  // On a statement: a draft is still open; submitted, approved, payable and paid freeze the outcome.
  const onStatement = await booking(s, { at: { date: '2025-03-06', slot: '09:00' }, status: 'no_show' });
  const prepared = await trainerSettlementService.prepare({ periodStart: '2025-03-03', actorId: s.adminId });
  const statementId = prepared.statements.find(x => x.trainerId === s.trainerId).id;
  assert.equal((await set(onStatement, 'completed')).body.status, 'completed', 'a draft does not lock');
  assert.equal((await set(onStatement, 'no_show')).body.status, 'no_show');

  await db('TrainerSettlement').where({ id: statementId }).update({ status: 'submitted' });
  const listed = (await call(adminListTrainerBookings, { claims: s.admin })).body.find(b => b.id === onStatement);
  assert.deepEqual(listed.actions, { canComplete: false, canMarkNoShow: false });
  const refused = await set(onStatement, 'completed');
  assert.deepEqual([refused.statusCode, refused.body], [409, { error: 'booking_on_trainer_statement', statementId, statementStatus: 'submitted' }]);
  assert.equal((await set(onStatement, 'cancelled')).statusCode, 409);
  assert.equal((await set(onStatement, 'no_show')).statusCode, 200, 'setting the same status changes nothing');

  // Moved along the path directly (the payout checks are covered by trainer-settlements.specs).
  await db('TrainerSettlement').where({ id: statementId }).update({ status: 'approved' });
  await db('TrainerSettlement').where({ id: statementId }).update({ status: 'payable', destinationSnapshot: JSON.stringify({ method: 'mobile_money', accountLast4: '0777' }) });
  await db('TrainerSettlement').where({ id: statementId }).update({ status: 'paid', paidAt: new Date(), paymentReference: 'MPESA-B1A' });
  const paid = await set(onStatement, 'cancelled');
  assert.deepEqual([paid.statusCode, paid.body.error, paid.body.statementStatus], [409, 'booking_on_trainer_statement', 'paid']);
  assert.equal(await statusOf(onStatement), 'no_show');
  assert.equal((await db('Refund').where({ bookingId: onStatement })).length, 0);

  // Flag off: today's behaviour (no statement lock; no_show not settable).
  flagOff();
  assert.equal((await set(onStatement, 'no_show')).statusCode, 400);
});

// ── Security review of functions#231 ────────────────────────────────────────

const set = (s, id, status) => call(adminUpdateTrainerBooking, { claims: s.admin, params: { id }, body: { status } });
const prepareWeek = async (s, periodStart) => {
  const out = await trainerSettlementService.prepare({ periodStart, actorId: s.adminId });
  assert.ok(!out.error, JSON.stringify(out));
  return out.statements.find(x => x.trainerId === s.trainerId)?.id || null;
};

test('HIGH 1: a cancelled session is final for admins — no no-show, completion or reinstatement (flag on or off)', async () => {
  for (const flag of [flagOn, flagOff]) {
    flag();
    const s = await scene();
    const id = await booking(s, { offsetMs: -3 * HOUR });
    const cancelled = await set(s, id, 'cancelled');
    assert.equal(cancelled.body.status, 'cancelled');
    assert.deepEqual((await db('Refund').where({ bookingId: id })).map(r => [r.reasonCode, r.status]), [['cancelled_by_fitflex', 'approved']]);
    for (const to of [...(process.env[FLAG] ? ['no_show'] : []), 'completed', 'confirmed']) {
      const out = await set(s, id, to);
      assert.deepEqual([out.statusCode, out.body.error], [409, 'booking_cancelled'], `${to} (flag ${process.env[FLAG] || 'off'})`);
    }
    assert.equal(await statusOf(id), 'cancelled');
    assert.equal((await set(s, id, 'cancelled')).statusCode, 200, 'cancelling again changes nothing');
    assert.equal((await db('Refund').where({ bookingId: id })).length, 1);
  }
});

test('M2: an admin overturn keeps the draft statement in step — re-based, line removed, empty draft removed', async () => {
  flagOn();
  const s = await scene();
  const a = await booking(s, { at: { date: '2025-03-11', slot: '10:00' }, status: 'no_show' });
  const b = await booking(s, { at: { date: '2025-03-12', slot: '10:00' }, status: 'completed' });
  const draftId = await prepareWeek(s, '2025-03-10');
  const lineOf = id => db('TrainerSettlementLine').where({ bookingId: id, voided: false }).first();
  const draft = () => db('TrainerSettlement').where({ id: draftId }).first();
  assert.deepEqual([(await draft()).sessionCount, (await draft()).finalNetTzs], [2, 34000]);

  assert.equal((await set(s, a, 'completed')).body.status, 'completed');
  assert.equal((await lineOf(a)).basis, 'completed', 're-based with the session');

  const out = await trainerBookingService.adminUpdateStatus({ id: a, status: 'cancelled', actorId: s.adminId });
  assert.deepEqual(out.draftLine, { statementId: draftId, removed: true, statementRemoved: false });
  assert.equal(await lineOf(a), undefined, 'the cancelled session is off the draft');
  assert.deepEqual([(await draft()).sessionCount, (await draft()).finalNetTzs, (await draft()).listTzs], [1, 17000, 20000]);
  const [audit] = await auditFor(a, 'trainer_booking_cancelled');
  assert.deepEqual(audit.after.draftLine, { statementId: draftId, removed: true, statementRemoved: false });

  // completed → confirmed: a session 48h+ past stays payable as took_place; one that is not yet is removed.
  assert.equal((await set(s, b, 'confirmed')).body.status, 'confirmed');
  assert.equal((await lineOf(b)).basis, 'took_place');
});

test('M2: an emptied draft is removed', async () => {
  flagOn();
  const s = await scene();
  const only = await booking(s, { at: { date: '2025-03-19', slot: '10:00' }, status: 'no_show' });
  const draftId = await prepareWeek(s, '2025-03-17');
  const out = await trainerBookingService.adminUpdateStatus({ id: only, status: 'cancelled', actorId: s.adminId });
  assert.deepEqual(out.draftLine, { statementId: draftId, removed: true, statementRemoved: true });
  assert.equal(await db('TrainerSettlement').where({ id: draftId }).first(), undefined);
});

test('M2: submit refuses a draft whose session no longer pays as prepared, and says which lines', async () => {
  const s = await scene();
  const ok = await booking(s, { at: { date: '2025-03-25', slot: '10:00' }, status: 'completed' });
  const gone = await booking(s, { at: { date: '2025-03-26', slot: '10:00' }, status: 'no_show' });
  const draftId = await prepareWeek(s, '2025-03-24');
  // Changed behind the draft's back (e.g. a write that raced the prepare).
  await db('TrainerBooking').where({ id: gone }).update({ status: 'cancelled' });
  const refused = await trainerSettlementService.submit({ id: draftId, actorId: s.adminId });
  assert.deepEqual(refused, {
    error: 'stale_statement_lines', status: 409,
    lines: [{ bookingId: gone, basis: 'no_show', bookingStatus: 'cancelled', payableBasis: null }],
  });
  assert.equal((await db('TrainerSettlement').where({ id: draftId }).first()).status, 'draft');
  // Preparing again rebuilds the draft without it; then it submits.
  assert.equal(await prepareWeek(s, '2025-03-24'), draftId);
  assert.deepEqual((await db('TrainerSettlementLine').where({ trainerSettlementId: draftId })).map(l => l.bookingId), [ok]);
  assert.equal((await trainerSettlementService.submit({ id: draftId, actorId: s.adminId })).statement.status, 'submitted');
});

test('M3 + L4: neither a trainer nor an admin can change a session on a submitted statement', async () => {
  flagOn();
  const s = await scene();
  // Confirmed and long past: on the statement as took_place.
  const id = await booking(s, { at: { date: '2025-04-01', slot: '10:00' } });
  const draftId = await prepareWeek(s, '2025-03-31');
  assert.equal((await trainerSettlementService.submit({ id: draftId, actorId: s.adminId })).statement.status, 'submitted');
  const locked = { error: 'booking_on_trainer_statement', statementId: draftId, statementStatus: 'submitted' };
  const done = await call(trainerCompleteBooking, { claims: s.trainer, params: { id } });
  assert.deepEqual([done.statusCode, done.body], [409, locked]);
  flagOff();
  assert.deepEqual((await call(trainerCompleteBooking, { claims: s.trainer, params: { id } })).body, locked, 'flag off too');
  flagOn();
  assert.deepEqual((await set(s, id, 'cancelled')).body, locked);
  assert.equal(await statusOf(id), 'confirmed');
});

test('M3: concurrent Complete and No-show — exactly one wins', async () => {
  flagOn();
  const s = await scene();
  for (let i = 0; i < 3; i += 1) {
    const id = await booking(s, { offsetMs: -(i + 1) * HOUR });
    const results = await Promise.all([
      call(trainerCompleteBooking, { claims: s.trainer, params: { id } }),
      call(trainerNoShowBooking, { claims: s.trainer, params: { id } }),
      call(trainerCompleteBooking, { claims: s.trainer, params: { id } }),
    ]);
    const won = results.filter(r => r.statusCode === 200);
    assert.equal(won.length, 1, JSON.stringify(results.map(r => [r.statusCode, r.body?.error])));
    for (const r of results.filter(x => x.statusCode !== 200)) {
      assert.equal(r.statusCode, 409);
      assert.ok(['booking_not_confirmable', 'booking_not_confirmed', 'booking_changed'].includes(r.body.error), r.body.error);
    }
    assert.equal(await statusOf(id), won[0].body.status);
    const audits = await db('AuditLog').where({ target: id }).whereIn('action', ['trainer_booking_completed_by_trainer', 'trainer_booking_no_show']);
    assert.equal(audits.length, 1, 'one outcome, one audit row');
  }
});

test('M3: without the database store, the write is still conditional (booking_changed)', async () => {
  const { createTrainerBookingService } = await import('../src/services/trainer-booking-service.mjs');
  const row = { id: 'tbk_x', trainerId: 'trn_x', memberId: 'm', gymId: 'g', date: '2025-01-06', slot: '09:00', status: 'confirmed' };
  const audits = [];
  const svc = createTrainerBookingService({
    trainerBookings: {
      findAsync: async pred => (pred(row) ? row : null),
      // Someone else changed the row first: the conditional update matches nothing.
      updateByIdWhereAsync: async () => null,
    },
    trainerService: { findProfileByUser: () => ({ id: 'trn_x' }) },
    auditLog: { insertAsync: async r => audits.push(r) },
    trainers: [], gyms: [], users: { findByIdAsync: async () => null }, trainerSessions: {},
  });
  assert.deepEqual(await svc.trainerCompleteBooking({ userId: 'u', bookingId: 'tbk_x' }), { error: 'booking_changed', status: 409 });
  assert.equal(audits.length, 0);
});

test('L5: an unreadable date or slot is refused, never treated as started', async () => {
  flagOn();
  const s = await scene();
  const id = await booking(s, { at: { date: '2025-13-45', slot: 'soon' } });
  const done = await call(trainerCompleteBooking, { claims: s.trainer, params: { id } });
  assert.deepEqual([done.statusCode, done.body.error], [400, 'invalid_booking_time']);
  const noShow = await call(trainerNoShowBooking, { claims: s.trainer, params: { id } });
  assert.deepEqual([noShow.statusCode, noShow.body.error], [400, 'invalid_booking_time']);
  const admin = await set(s, id, 'no_show');
  assert.deepEqual([admin.statusCode, admin.body.error], [400, 'invalid_booking_time']);
  const listed = (await call(trainerMyBookings, { claims: s.trainer })).body.find(b => b.id === id);
  assert.deepEqual(listed.actions, { canComplete: false, canMarkNoShow: false });
  assert.equal(await statusOf(id), 'confirmed');
});

test('L6: an admin-recorded no-show tells the member too', async () => {
  flagOn();
  const s = await scene();
  const id = await booking(s, { offsetMs: -60 * HOUR });
  assert.equal((await set(s, id, 'no_show')).body.status, 'no_show');
  const inbox = await notifications.filterAsync(n => n.userId === s.memberId && n.type === 'trainer_booking_no_show');
  assert.deepEqual(inbox.map(n => n.data.bookingId), [id]);
});

test('new rule: a trainer cannot book their own sessions, from the same account or a linked one', async () => {
  const s = await scene();
  const slot = eatSlot(72 * HOUR);
  const body = { trainerId: s.trainerId, gymId: s.gymId, slots: [{ date: slot.date, slot: slot.slot }] };
  const self = await call(createTrainerBooking, { claims: { sub: s.trainerUserId, userType: 'member' }, body });
  assert.deepEqual([self.statusCode, self.body.error], [403, 'cannot_book_own_sessions']);

  // Two accounts of one person: the member account is linked to the trainer's person (as identity linking does).
  const linkedMember = await user('member');
  const { personId } = await db('User').where({ id: s.trainerUserId }).first('personId');
  assert.ok(personId, 'every account has a person');
  await db.transaction(async (trx) => {
    await trx.raw("SET LOCAL fitflex.identity_relink = 'on'");
    await trx('User').where({ id: linkedMember }).update({ personId });
  });
  const linked = await call(createTrainerBooking, { claims: { sub: linkedMember, userType: 'member' }, body });
  assert.deepEqual([linked.statusCode, linked.body.error], [403, 'cannot_book_own_sessions']);
  assert.equal((await trainerBookingService.quoteBooking({ memberId: linkedMember, body })).error, 'cannot_book_own_sessions');

  // Someone else is not affected by the rule.
  const other = await trainerBookingService.quoteBooking({ memberId: s.memberId, body });
  assert.notEqual(other.error, 'cannot_book_own_sessions');
});

// ── Mobile slice (mobile#209) ───────────────────────────────────────────────

test('GET /trainer/sessions: each booking carries actions with the flag on; none with it off; manual sessions never', async () => {
  const s = await scene();
  const at = eatSlot(-2 * HOUR);
  const later = { date: at.date, slot: at.slot === '23:59' ? '23:58' : '23:59' };
  const started = await booking(s, { at });
  const notYet = await booking(s, { at: later });
  await trainerBookingService.createManualSession({ userId: s.trainerUserId, body: { date: at.date, slot: '06:00', customerName: 'Walk-in', gymId: s.gymId } });

  flagOff();
  const off = await call(trainerSessionsForDate, { claims: s.trainer, query: { date: at.date } });
  assert.equal(off.statusCode, 200, JSON.stringify(off.body));
  assert.ok(off.body.sessions.every(x => !('actions' in x)));

  flagOn();
  const on = await call(trainerSessionsForDate, { claims: s.trainer, query: { date: at.date } });
  const byId = Object.fromEntries(on.body.sessions.map(x => [x.id, x]));
  assert.deepEqual(byId[started].actions, { canComplete: true, canMarkNoShow: true });
  const laterStart = Date.parse(`${later.date}T${later.slot}:00.000+03:00`);
  assert.deepEqual(byId[notYet].actions, laterStart <= Date.now() ? { canComplete: true, canMarkNoShow: true } : { canComplete: false, canMarkNoShow: false });
  const manual = on.body.sessions.find(x => x.source === 'manual');
  assert.ok(manual && !('actions' in manual));
  await db('TrainerSession').where({ trainerId: s.trainerId }).del();
});

test('the no-show push is in the member\'s chosen language; English when none is saved', async () => {
  flagOn();
  const s = await scene();
  const swMember = await user('member');
  const enMember = await user('member');
  await db('CommunicationPreference').insert([{ id: swMember, locale: 'sw' }, { id: enMember, locale: 'en' }]);
  const sent = {};
  for (const [label, memberId] of [['sw', swMember], ['en', enMember], ['none', s.memberId]]) {
    const id = await booking(s, { offsetMs: -1 * HOUR, memberId });
    assert.equal((await trainerBookingService.trainerMarkNoShow({ userId: s.trainerUserId, bookingId: id })).booking.status, 'no_show');
    [sent[label]] = await notifications.filterAsync(n => n.userId === memberId && n.type === 'trainer_booking_no_show');
  }
  assert.deepEqual([sent.sw.title, sent.sw.data.locale], ['Hukuhudhuria kipindi', 'sw']);
  assert.match(sent.sw.body, /hukuhudhuria kipindi chako/);
  assert.deepEqual([sent.en.title, sent.en.data.locale], ['Missed session', 'en']);
  assert.deepEqual([sent.none.title, sent.none.data.locale], ['Missed session', 'en']);
  for (const n of Object.values(sent)) {
    assert.deepEqual([n.data.titleEn, n.data.titleSw], ['Missed session', 'Hukuhudhuria kipindi']);
    assert.ok(n.data.bodyEn && n.data.bodySw);
  }
});

// ── Re-review of #231 (5a0a44b) ─────────────────────────────────────────────

test('finding 2: with the flag OFF an admin still cannot change a session on a submitted statement', async () => {
  flagOff();
  const s = await scene();
  const id = await booking(s, { at: { date: '2025-04-08', slot: '10:00' }, status: 'completed' });
  const statementId = await prepareWeek(s, '2025-04-07');
  assert.equal((await trainerSettlementService.submit({ id: statementId, actorId: s.adminId })).statement.status, 'submitted');
  for (const to of ['cancelled', 'confirmed']) {
    const out = await set(s, id, to);
    assert.deepEqual([out.statusCode, out.body], [409, { error: 'booking_on_trainer_statement', statementId, statementStatus: 'submitted' }], to);
  }
  assert.equal(await statusOf(id), 'completed');
  assert.equal((await db('Refund').where({ bookingId: id })).length, 0, 'no refund raised behind a submitted payout');
});

test('finding 3: approving a shrunk group payment leaves its cancelled slots cancelled; a re-approved rejected slot comes back unless rebooked', async () => {
  const s = await scene();
  const groupId = uid('tbg');
  const mk = async (slot, status, group = groupId) => {
    const id = await booking(s, { at: { date: '2031-05-06', slot }, status });
    await db('TrainerBooking').where({ id }).update({ groupId: group });
    return id;
  };
  const kept = await mk('09:00', 'payment_pending');
  const dropped = await mk('10:00', 'cancelled');
  const updated = await trainerBookingService.applyPaymentToGroup(groupId, 'approved');
  assert.deepEqual(updated.map(b => b.id), [kept]);
  assert.deepEqual(await Promise.all([kept, dropped].map(statusOf)), ['confirmed', 'cancelled']);

  // A whole group's payment rejected, then approved after all, with one slot booked again meanwhile:
  // the approval is refused as a whole and nothing moves (security review of #231, race 1).
  const other = uid('tbg');
  const free = await mk('12:00', 'payment_rejected', other);
  const rebooked = await mk('13:00', 'payment_rejected', other);
  const someoneElse = await mk('13:00', 'confirmed', uid('tbg'));
  const again = await trainerBookingService.applyPaymentToGroup(other, 'approved');
  assert.deepEqual(again, { error: 'group_slot_rebooked', status: 409, bookingIds: [rebooked] });
  assert.deepEqual(await Promise.all([free, rebooked, someoneElse].map(statusOf)), ['payment_rejected', 'payment_rejected', 'confirmed']);
  // Back to pending instead: the free one is held again, the rebooked one stays rejected, on the record.
  const pending = await trainerBookingService.applyPaymentToGroup(other, 'pending', { actorId: s.adminId });
  assert.deepEqual(pending.map(b => b.id), [free]);
  assert.deepEqual(await Promise.all([free, rebooked, someoneElse].map(statusOf)), ['payment_pending', 'payment_rejected', 'confirmed']);
  assert.equal((await auditFor(rebooked, 'trainer_booking_kept_rejected')).length, 1);
});

test('finding 4: a statement line that appears between the two reads stops the change (booking_changed); nothing is written', async () => {
  const s = await scene();
  const id = await booking(s, { at: { date: '2025-04-15', slot: '10:00' } }); // confirmed, long past → took_place candidate
  const { createPgTrainerOutcomeStore } = await import('../src/infra/trainer-outcome-store-pg.mjs');
  let decided = false;
  const store = createPgTrainerOutcomeStore({
    db,
    // Another connection prepares the week right then: the session is now on a draft this transaction never locked.
    beforeBookingLock: async () => { await prepareWeek(s, '2025-04-14'); },
  });
  const out = await store.transition({
    bookingId: id, actorId: s.adminId, action: () => 'trainer_booking_cancelled',
    decide: () => { decided = true; return { to: 'cancelled' }; },
  });
  assert.deepEqual(out, { error: 'booking_changed', status: 409 });
  assert.equal(decided, false);
  assert.equal(await statusOf(id), 'confirmed');
  assert.equal((await db('TrainerSettlementLine').where({ bookingId: id, voided: false })).length, 1, 'the prepared line stands');
  assert.equal((await auditFor(id, 'trainer_booking_cancelled')).length, 0);
});

test('finding 4: a Postgres deadlock or serialization failure answers booking_changed; other errors still throw', async () => {
  const { createPgTrainerOutcomeStore } = await import('../src/infra/trainer-outcome-store-pg.mjs');
  const failing = code => createPgTrainerOutcomeStore({ db: { transaction: async () => { throw Object.assign(new Error('pg'), { code }); } } });
  const args = { bookingId: 'x', actorId: 'a', action: () => 'x', decide: () => ({ to: 'completed' }) };
  assert.deepEqual(await failing('40P01').transition(args), { error: 'booking_changed', status: 409 });
  assert.deepEqual(await failing('40001').transition(args), { error: 'booking_changed', status: 409 });
  await assert.rejects(failing('23505').transition(args), /pg/);
  // Through the service the route answers 409, not 500.
  const { createTrainerBookingService } = await import('../src/services/trainer-booking-service.mjs');
  const svc = createTrainerBookingService({
    outcomeStore: failing('40P01'), trainerService: { findProfileByUser: () => ({ id: 't' }) },
    trainerBookings: {}, auditLog: {}, trainers: [], gyms: [], users: {}, trainerSessions: {},
  });
  assert.deepEqual(await svc.trainerCompleteBooking({ userId: 'u', bookingId: 'x' }), { error: 'booking_changed', status: 409 });
});

test('finding 5: the read-only reconciliation lists outcomes that disagree with statements, usage and refunds', async () => {
  const { createTrainerOutcomeReconciliation } = await import('../src/services/trainer-outcome-reconciliation.mjs');
  const recon = createTrainerOutcomeReconciliation({ db });
  const s = await scene();
  const id = await booking(s, { at: { date: '2025-04-22', slot: '10:00' }, status: 'completed' });
  await prepareWeek(s, '2025-04-21');
  const before = await recon.run({ only: ['cancelled_on_statement'] });
  assert.ok(!before.checks[0].sample.includes(id));
  // Cancelled behind the statement's back (what a failed after-commit step could leave).
  await db('TrainerBooking').where({ id }).update({ status: 'cancelled' });
  const after = await recon.run();
  assert.deepEqual(after.checks.map(c => c.key), recon.keys);
  const found = after.checks.find(c => c.key === 'cancelled_on_statement');
  assert.ok(found.count >= 1 && found.sample.includes(id), JSON.stringify(found));
  assert.equal(after.ok, false);
  // It changed nothing.
  assert.equal(await statusOf(id), 'cancelled');
  assert.equal((await db('TrainerSettlementLine').where({ bookingId: id, voided: false })).length, 1);
});

// ── Owner decisions 2026-10-20 ──────────────────────────────────────────────

test('admin: an unpaid session is never confirmed, completed or no-showed by hand; completion needs the start (flag on or off)', async () => {
  for (const flag of [flagOn, flagOff]) {
    flag();
    const s = await scene();
    const statuses = process.env[FLAG] ? ['confirmed', 'completed', 'no_show'] : ['confirmed', 'completed'];
    for (const from of ['payment_pending', 'payment_rejected']) {
      const id = await booking(s, { offsetMs: -3 * HOUR, status: from });
      for (const to of statuses) {
        const out = await set(s, id, to);
        assert.deepEqual([out.statusCode, out.body], [409, { error: 'invalid_transition', from }], `${from} → ${to}`);
      }
      assert.equal(await statusOf(id), from);
    }
    const future = await booking(s, { offsetMs: 4 * HOUR });
    const early = await set(s, future, 'completed');
    assert.deepEqual([early.statusCode, early.body.error], [409, 'session_not_started']);
    assert.ok(early.body.startsAt);
    const broken = await booking(s, { at: { date: '2025-02-30x', slot: '9' } });
    assert.deepEqual([(await set(s, broken, 'completed')).statusCode, (await set(s, broken, 'completed')).body.error], [400, 'invalid_booking_time']);

    // Still allowed: a paid session that has started, and back to confirmed from an outcome.
    const past = await booking(s, { offsetMs: -2 * HOUR });
    assert.equal((await set(s, past, 'completed')).body.status, 'completed');
    assert.equal((await set(s, past, 'confirmed')).body.status, 'confirmed');
    assert.equal((await set(s, past, 'completed')).body.status, 'completed');
    assert.equal((await set(s, past, 'completed')).statusCode, 200, 'the same status again changes nothing');
    // An unpaid session can still be cancelled by staff.
    const unpaid = await booking(s, { offsetMs: 30 * HOUR, status: 'payment_pending' });
    assert.equal((await set(s, unpaid, 'cancelled')).body.status, 'cancelled');
  }
});

test('group payment: re-approving a rejected group is refused when one of its slots was booked by someone else since', async () => {
  const s = await scene();
  const at = eatSlot(5 * 24 * HOUR);
  const second = { date: at.date, slot: at.slot === '23:00' ? '22:00' : '23:00' };
  const adminClaims = s.admin;
  const book = async (memberId, slots) => {
    const out = await call(createTrainerBooking, { claims: { sub: memberId, userType: 'member' }, body: { trainerId: s.trainerId, gymId: s.gymId, slots } });
    assert.equal(out.statusCode, 201, JSON.stringify(out.body));
    return out.body;
  };
  const first = await book(s.memberId, [at, second]);
  const requestId = first.paymentRequest.id;
  const reject = await call(adminDecidePaymentRequest, { claims: adminClaims, params: { id: requestId }, body: { decision: 'reject', note: 'bounced' } });
  assert.equal(reject.statusCode, 200, JSON.stringify(reject.body));
  assert.deepEqual(await Promise.all(first.bookings.map(b => statusOf(b.id))), ['payment_rejected', 'payment_rejected']);

  // The rejection freed the slots; someone else books one of them.
  const otherMember = await user('member');
  const other = await book(otherMember, [second]);
  const takenId = first.bookings.find(b => b.slot === second.slot).id;

  const approve = await call(adminUpdatePaymentRequest, { claims: adminClaims, params: { id: requestId }, body: { status: 'approved', reference: 'MPESA-B1A-REBOOK' } });
  assert.deepEqual([approve.statusCode, approve.body], [409, { error: 'group_slot_rebooked', bookingIds: [takenId] }]);
  const request = await db('PaymentRequest').where({ id: requestId }).first();
  assert.equal(request.status, 'rejected', 'the payment decision did not change');
  assert.deepEqual(await Promise.all(first.bookings.map(b => statusOf(b.id))), ['payment_rejected', 'payment_rejected']);
  assert.equal(await statusOf(other.bookings[0].id), 'payment_pending', 'the other member keeps the slot');

  // Once the other booking lets the slot go, the same approval goes through and the whole group follows.
  await db('TrainerBooking').where({ id: other.bookings[0].id }).update({ status: 'cancelled' });
  const ok = await call(adminUpdatePaymentRequest, { claims: adminClaims, params: { id: requestId }, body: { status: 'approved', reference: 'MPESA-B1A-REBOOK' } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.deepEqual(await Promise.all(first.bookings.map(b => statusOf(b.id))), ['confirmed', 'confirmed']);
  await db('PaymentRequest').whereIn('memberId', [s.memberId, otherMember]).del();
});
