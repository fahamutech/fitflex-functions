// Trainer gym access — end-to-end journey against the CI database.
//   owner sells daily/weekly trainer passes → members never see them →
//   trainer buys one → admin approves the payment → owner scans the trainer in
//   (own gym only). Gyms without a trainer pass fall back to member plans, and
//   gyms the trainer is linked to are free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from '../src/auth/jwt.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { getGym, listGyms } from '../functions/gyms.mjs';
import { ownerCreateGym, ownerUpdateGym, ownerDecideTrainerJoin } from '../functions/owner-gyms.mjs';
import { trainerRegister, trainerApplyToGym } from '../functions/trainers.mjs';
import { trainerPurchaseTrainerPass } from '../functions/trainer-engagements.mjs';
import { trainerGyms, trainerMyPasses, trainerCancelPass, trainerBuyMemberPlan } from '../functions/trainer-passes.mjs';
import { adminDecidePaymentRequest, adminPaymentRequests } from '../functions/admin-payments.mjs';
import { myQr, operatorVerifyQr, operatorCheckIn } from '../functions/checkins.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const uniq = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const uniqPhone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const bearer = (sub, userType) => ({ authorization: `Bearer ${sign({ sub, userType })}` });

async function call(route, req) {
  const out = res();
  await route.onRequest({ params: {}, query: {}, body: {}, headers: {}, ...req }, out);
  return out;
}

async function ensureUser(id, userType, displayName) {
  const out = await call(updateMemberProfile, { user: { sub: id, userType }, body: { displayName, phone: uniqPhone() } });
  assert.equal(out.statusCode, 200, JSON.stringify(out.body));
}

async function setup() {
  const ownerId = uniq('usr_owner_tp');
  await ensureUser(ownerId, 'gym_operator', 'Trainer Pass Owner');
  const owner = { sub: ownerId, userType: 'gym_operator' };
  const gym = async (name, extra) => {
    const out = await call(ownerCreateGym, {
      user: owner,
      body: { name: uniq(name), tier: 'standard', location: 'Dar es Salaam', perVisitRate: 5000, ...extra },
    });
    assert.equal(out.statusCode, 201, JSON.stringify(out.body));
    return out.body;
  };
  const passGym = await gym('Pass Gym');
  const planGym = await gym('Plan Gym', { ratePerDay: 5000, ratePerWeek: 25000 });
  const homeGym = await gym('Home Gym');

  // T1/T2: the owner turns on daily + weekly trainer passes themselves.
  const priced = await call(ownerUpdateGym, {
    user: owner,
    params: { gymId: passGym.id },
    body: { trainerPass: { enabled: true, options: { daily: 8000, weekly: 40000 } } },
  });
  assert.equal(priced.statusCode, 200, JSON.stringify(priced.body));
  assert.deepEqual(priced.body.trainerPass.options, { daily: 8000, weekly: 40000 });

  const trainerUserId = uniq('usr_trainer_tp');
  await ensureUser(trainerUserId, 'trainer', 'Pass Trainer');
  const trainer = { sub: trainerUserId, userType: 'trainer' };
  const reg = await call(trainerRegister, {
    user: trainer,
    body: { displayName: 'Pass Trainer', photoUrl: 'https://example.com/t.jpg', gender: 'female', hourlyRateTzs: 20000 },
  });
  assert.equal(reg.statusCode, 200, JSON.stringify(reg.body));
  return { owner, trainer, trainerProfileId: reg.body.id, passGym, planGym, homeGym };
}

test('trainer pass: owner-priced, trainer-only, admin-approved, scanned at its own gym only', async () => {
  const { owner, trainer, passGym, planGym } = await setup();

  // T3: members and anonymous callers never see trainer-pass pricing.
  const asMember = await call(getGym, { params: { id: passGym.id }, headers: bearer(uniq('usr_m'), 'member') });
  assert.equal(asMember.body.trainerPass, undefined);
  const anonymous = await call(listGyms, {});
  assert.equal(anonymous.body.find(g => g.id === passGym.id)?.trainerPass, undefined);
  const asTrainer = await call(getGym, { params: { id: passGym.id }, headers: bearer(trainer.sub, 'trainer') });
  assert.deepEqual(asTrainer.body.trainerPass.options, { daily: 8000, weekly: 40000 });

  // The trainer's gym list explains how they can train at each gym.
  const gyms = await call(trainerGyms, { user: trainer });
  const accessOf = (id) => gyms.body.find(g => g.id === id)?.trainerAccess;
  assert.equal(accessOf(passGym.id).access, 'trainer_pass');
  assert.deepEqual(accessOf(passGym.id).options.map(o => [o.period, o.feeTzs]), [['daily', 8000], ['weekly', 40000]]);
  assert.equal(accessOf(planGym.id).access, 'member_plan');

  // Two periods on sale → the period is required; member plans are not allowed here.
  const noPeriod = await call(trainerPurchaseTrainerPass, { user: trainer, params: { gymId: passGym.id } });
  assert.equal(noPeriod.statusCode, 400);
  assert.equal(noPeriod.body.error, 'period_required');
  const planInstead = await call(trainerBuyMemberPlan, { user: trainer, params: { gymId: passGym.id }, body: { plan: 'daily' } });
  assert.equal(planInstead.statusCode, 409);
  assert.equal(planInstead.body.error, 'use_trainer_pass');

  const bought = await call(trainerPurchaseTrainerPass, { user: trainer, params: { gymId: passGym.id }, body: { period: 'weekly' } });
  assert.equal(bought.statusCode, 202, JSON.stringify(bought.body));
  assert.equal(bought.body.subscription.type, 'trainer_pass');
  assert.equal(bought.body.paymentRequest.amountTzs, 40000);
  const again = await call(trainerPurchaseTrainerPass, { user: trainer, params: { gymId: passGym.id }, body: { period: 'daily' } });
  assert.equal(again.body.error, 'trainer_pass_pending');

  // Unpaid and not linked to any gym → no QR yet.
  const earlyQr = await call(myQr, { user: trainer });
  assert.equal(earlyQr.statusCode, 403);

  // The admin's payment list says what is being paid for, and where.
  const queue = await call(adminPaymentRequests, { user: { sub: 'usr_admin_1', userType: 'admin' } });
  const row = queue.body.find(p => p.id === bought.body.paymentRequest.id);
  assert.equal(row.subscription.type, 'trainer_pass');
  assert.equal(row.subscription.plan, 'weekly');
  assert.deepEqual(row.gym, { id: passGym.id, name: passGym.name });

  // T6: a FitFlex admin approves the payment; the week starts now.
  const approved = await call(adminDecidePaymentRequest, {
    user: { sub: 'usr_admin_1', userType: 'admin' },
    params: { id: bought.body.paymentRequest.id },
    body: { decision: 'approve', reference: 'MPESA-TP-1' },
  });
  assert.equal(approved.statusCode, 200, JSON.stringify(approved.body));
  const passes = await call(trainerMyPasses, { user: trainer });
  const pass = passes.body.find(p => p.id === bought.body.subscription.id);
  assert.equal(pass.status, 'active');
  assert.ok(Math.abs(+new Date(pass.startedAt) - Date.now()) < 60_000, 'pass period restarts at approval');
  assert.equal(Math.round((+new Date(pass.expiresAt) - +new Date(pass.startedAt)) / 86_400_000), 7);

  // The owner scans the trainer in at the pass gym…
  const qr = await call(myQr, { user: trainer });
  assert.equal(qr.statusCode, 200, JSON.stringify(qr.body));
  const verify = await call(operatorVerifyQr, { user: owner, body: { qrToken: qr.body.token, gymId: passGym.id } });
  assert.equal(verify.body.eligible, true, JSON.stringify(verify.body));
  const scan = await call(operatorCheckIn, { user: owner, body: { qrToken: qr.body.token, gymId: passGym.id } });
  assert.equal(scan.statusCode, 200, JSON.stringify(scan.body));
  assert.equal(scan.body.checkin.subscriptionType, 'trainer_pass');

  // …but the pass does not open another gym.
  const elsewhere = await call(operatorCheckIn, { user: owner, body: { qrToken: qr.body.token, gymId: planGym.id } });
  assert.equal(elsewhere.statusCode, 409);
  assert.equal(elsewhere.body.failure, 'wrong_gym');
});

test('trainer access: member plans where no trainer pass is sold; linked gyms are free', async () => {
  const { owner, trainer, trainerProfileId, passGym, planGym, homeGym } = await setup();

  // T4: no trainer pass at this gym → the member plan at member price.
  const plan = await call(trainerBuyMemberPlan, { user: trainer, params: { gymId: planGym.id }, body: { plan: 'daily' } });
  assert.equal(plan.statusCode, 202, JSON.stringify(plan.body));
  assert.equal(plan.body.subscription.type, 'direct_sub');
  assert.equal(plan.body.paymentRequest.amountTzs, 5000);
  const passHere = await call(trainerPurchaseTrainerPass, { user: trainer, params: { gymId: planGym.id }, body: { period: 'daily' } });
  assert.equal(passHere.body.error, 'trainer_pass_not_offered');

  // Unpaid requests can be withdrawn.
  const cancelled = await call(trainerCancelPass, { user: trainer, params: { id: plan.body.subscription.id } });
  assert.equal(cancelled.statusCode, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.subscription.status, 'payment_cancelled');
  const cancelAgain = await call(trainerCancelPass, { user: trainer, params: { id: plan.body.subscription.id } });
  assert.equal(cancelAgain.body.error, 'not_cancellable');

  // T5: once the owner links the trainer to a gym, they train there free.
  const apply = await call(trainerApplyToGym, { user: trainer, params: { gymId: homeGym.id } });
  assert.equal(apply.statusCode, 201, JSON.stringify(apply.body));
  const decide = await call(ownerDecideTrainerJoin, {
    user: owner, params: { trainerId: trainerProfileId }, body: { gymId: homeGym.id, decision: 'approve' },
  });
  assert.equal(decide.statusCode, 200, JSON.stringify(decide.body));

  const gyms = await call(trainerGyms, { user: trainer });
  assert.equal(gyms.body.find(g => g.id === homeGym.id).trainerAccess.access, 'home');
  const passAtHome = await call(trainerPurchaseTrainerPass, { user: trainer, params: { gymId: homeGym.id }, body: { period: 'daily' } });
  assert.equal(passAtHome.body.error, 'home_gym_free');

  const qr = await call(myQr, { user: trainer });
  assert.equal(qr.statusCode, 200, 'a linked trainer gets a QR without buying anything');
  const verify = await call(operatorVerifyQr, { user: owner, body: { qrToken: qr.body.token, gymId: homeGym.id } });
  assert.equal(verify.body.eligible, true);
  assert.equal(verify.body.reason, 'trainer_home_gym');
  const scan = await call(operatorCheckIn, { user: owner, body: { qrToken: qr.body.token, gymId: homeGym.id } });
  assert.equal(scan.statusCode, 200, JSON.stringify(scan.body));
  assert.equal(scan.body.checkin.subscriptionType, 'trainer_home');
  assert.equal(scan.body.checkin.visitConsumed, false);

  // Being linked to one gym does not open the others.
  const notHome = await call(operatorCheckIn, { user: owner, body: { qrToken: qr.body.token, gymId: passGym.id } });
  assert.equal(notHome.statusCode, 409);
});
