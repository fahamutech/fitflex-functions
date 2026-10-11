// Booking and subscription conversions: when they are recorded, which promotion is
// credited, when they are taken back, and that the real approval paths do it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { promotionEventsService, promotionAnalyticsService, adminPaymentService, webhookService } from '../src/bootstrap/services.mjs';

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const made = { users: [], promotions: [], subs: [], pays: [], gyms: [] };

after(async () => {
  if (made.promotions.length) {
    await db('PromotionEvent').whereIn('promotionId', made.promotions).del();
    await db('PromotionPlacement').whereIn('promotionId', made.promotions).del();
    await db('Promotion').whereIn('id', made.promotions).del();
  }
  if (made.pays.length) await db('PaymentRequest').whereIn('id', made.pays).del();
  if (made.subs.length) await db('Subscription').whereIn('id', made.subs).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) { await db('PromotionEvent').whereIn('userId', made.users).del(); await db('AuditLog').whereIn('actor', made.users).del(); await db('User').whereIn('id', made.users).del(); }
});

/** A promotion row (no lifecycle needed: attribution only reads the events that point at it). */
async function promotion(entityType, entityId, over = {}) {
  const id = uid('promo');
  await db('Promotion').insert({ id, entityType, entityId, type: 'featured', status: 'active', startsAt: new Date(Date.now() - 30 * DAY), endsAt: new Date(Date.now() + 30 * DAY), createdBy: 'conv_spec', updatedAt: new Date(), ...over });
  made.promotions.push(id);
  return id;
}
async function member() { const id = uid('usr'); await db('User').insert({ id, userType: 'member', displayName: 'Conversion member', updatedAt: new Date() }); made.users.push(id); return id; }
/** A tap on the promoted card, `ago` ms before now. */
const tap = (promotionId, userId, entityType, entityId, ago, over = {}) => db('PromotionEvent').insert({
  id: randomUUID(), at: new Date(Date.now() - ago), event: 'click', entityType, entityId, promotionId, placement: entityType === 'trainer' ? 'trainer_discovery' : 'gym_discovery',
  userId, sessionId: `sess-${randomUUID().slice(0, 10)}`, source: 'mobile', verified: true, ...over,
});
const conversions = (promotionId, event) => db('PromotionEvent').where({ promotionId, event });
const booking = (member, trainer, over = {}) => ({ id: uid('tbk'), groupId: over.groupId || 'tbg_x', memberId: member, trainerId: trainer, amountTzs: 20000, currency: 'TZS', createdAt: new Date().toISOString(), status: 'confirmed', ...over });

// ── Bookings ────────────────────────────────────────────────────────────────

test('a confirmed booking is credited once to the trainer promotion the member tapped, with its value', async () => {
  const trainer = uid('tr'); const m = await member();
  const p = await promotion('trainer', trainer);
  await tap(p, m, 'trainer', trainer, 2 * DAY);
  const group = [booking(m, trainer, { groupId: 'tbg_a', amountTzs: 20000 }), booking(m, trainer, { groupId: 'tbg_a', amountTzs: 20000 })];
  assert.deepEqual(await promotionEventsService.recordBooking(group), { credited: 1 });
  assert.deepEqual(await promotionEventsService.recordBooking(group), { credited: 0 });          // approved twice, or a second session: still one booking
  const [row] = await conversions(p, 'booking');
  assert.deepEqual([row.valueTzs, row.userId, row.source, row.verified, row.entityType, row.entityId, row.placement], [40000, m, 'server', true, 'trainer', trainer, 'trainer_discovery']);
  const d = await promotionAnalyticsService.detail(p, {});
  assert.deepEqual([d.totals.bookings, d.totals.conversions, d.totals.clicks, d.totals.conversionRate, d.totals.bookingValueTzs], [1, 1, 1, 1, 40000]);
  assert.deepEqual(d.notTracked, []);
});

test('a booking is credited only to a verified tap by that member on that trainer, in the week before they asked', async () => {
  const trainer = uid('tr'); const other = uid('tr'); const m = await member(); const stranger = await member();
  const p = await promotion('trainer', trainer);
  const asked = new Date().toISOString();
  const attempt = async (over, label) => {
    const out = await promotionEventsService.recordBooking([booking(m, trainer, { groupId: uid('tbg'), createdAt: asked, ...over })]);
    assert.equal(out.credited, 0, label);
  };
  await attempt({}, 'no tap at all');
  await tap(p, m, 'trainer', trainer, HOUR, { verified: false });
  await attempt({}, 'an unverified tap (forged or an old build)');
  await tap(p, m, 'trainer', trainer, 8 * DAY);
  await attempt({}, 'a tap more than a week before');
  await tap(p, stranger, 'trainer', trainer, HOUR);
  await attempt({}, 'someone else\'s tap');
  await tap(p, m, 'trainer', other, HOUR);
  await attempt({}, 'a tap on another trainer');
  await tap(p, m, 'trainer', trainer, -HOUR);                                                    // a tap an hour AFTER they asked cannot have caused it
  await attempt({ createdAt: new Date(Date.now() - 2 * HOUR).toISOString() }, 'a tap after the request');
  await tap(p, m, 'trainer', trainer, 3 * HOUR, { event: 'detail_view' });
  await attempt({}, 'a page view is not a tap');
  assert.deepEqual(await promotionEventsService.recordBooking([]), { credited: 0 });
  assert.equal((await conversions(p, 'booking')).length, 0);
});

test('the week is counted from when the member asked, not from when staff approved the payment', async () => {
  const trainer = uid('tr'); const m = await member();
  const p = await promotion('trainer', trainer);
  await tap(p, m, 'trainer', trainer, 9 * DAY);                                                   // tapped 9 days ago...
  const asked = new Date(Date.now() - 3 * DAY).toISOString();                                       // ...asked 3 days ago (6 days later), approved just now
  assert.deepEqual(await promotionEventsService.recordBooking([booking(m, trainer, { groupId: uid('tbg'), createdAt: asked })]), { credited: 1 });
});

test('the latest tap wins, and a booking in another currency counts without a TZS value', async () => {
  const trainer = uid('tr'); const m = await member();
  const older = await promotion('trainer', trainer); const newer = await promotion('trainer', trainer, { type: 'promoted' });
  await tap(older, m, 'trainer', trainer, 4 * DAY); await tap(newer, m, 'trainer', trainer, DAY);
  await promotionEventsService.recordBooking([booking(m, trainer, { groupId: uid('tbg'), currency: 'USD', amountTzs: 15 })]);
  assert.equal((await conversions(older, 'booking')).length, 0);
  const [row] = await conversions(newer, 'booking');
  assert.equal(row.valueTzs, null);
});

test('a booking that is rejected, cancelled or refunded is taken back, and taking back twice is harmless', async () => {
  const trainer = uid('tr'); const m = await member();
  const p = await promotion('trainer', trainer);
  await tap(p, m, 'trainer', trainer, DAY);
  await promotionEventsService.recordBooking([booking(m, trainer, { groupId: 'tbg_rev' })]);
  assert.equal((await conversions(p, 'booking')).length, 1);
  assert.deepEqual(await promotionEventsService.reverseBooking('tbg_rev'), { reversed: 1 });
  assert.deepEqual(await promotionEventsService.reverseBooking('tbg_rev'), { reversed: 0 });
  assert.equal((await promotionAnalyticsService.detail(p, {})).totals.bookings, 0);
  assert.deepEqual(await promotionEventsService.reverseBooking(undefined), { reversed: 0 });
});

// ── Subscriptions ───────────────────────────────────────────────────────────

const sub = (m, gymId, over = {}) => ({ id: uid('sub'), memberId: m, type: 'direct_sub', homeGymId: gymId, status: 'active', ...over });

test('a paid gym membership is credited to the gym promotion the member tapped; a pass with no home gym, or a trainer pass, is not', async () => {
  const gymId = uid('gym'); const m = await member();
  const p = await promotion('gym', gymId);
  await tap(p, m, 'gym', gymId, DAY);
  const direct = sub(m, gymId);
  assert.deepEqual(await promotionEventsService.recordSubscription(direct, { amountTzs: 80000 }), { credited: 1 });
  assert.deepEqual(await promotionEventsService.recordSubscription(direct, { amountTzs: 80000 }), { credited: 0 });       // activated twice
  const [row] = await conversions(p, 'subscription');
  assert.deepEqual([row.valueTzs, row.entityId, row.userId, row.verified], [80000, gymId, m, true]);
  assert.equal((await promotionEventsService.recordSubscription(sub(m, gymId, { type: 'platform_pass' }))).credited, 1);   // a pass with a home gym is about that gym
  assert.equal((await promotionEventsService.recordSubscription(sub(m, null, { type: 'platform_pass' }))).credited, 0);    // a network pass is about no one gym
  assert.equal((await promotionEventsService.recordSubscription(sub(m, gymId, { type: 'trainer_pass' }))).credited, 0);
  assert.equal((await promotionEventsService.recordSubscription(null)).credited, 0);
  assert.equal((await promotionEventsService.recordSubscription(sub(await member(), gymId))).credited, 0);                  // another member never tapped it
  const d = await promotionAnalyticsService.detail(p, {});
  assert.deepEqual([d.totals.subscriptions, d.totals.conversions, d.totals.subscriptionValueTzs], [2, 2, 80000]);
});

test('a membership is credited from when it was asked for, and an unverified or old tap earns nothing', async () => {
  const gymId = uid('gym'); const m = await member();
  const p = await promotion('gym', gymId);
  await tap(p, m, 'gym', gymId, 9 * DAY);
  const asked = new Date(Date.now() - 4 * DAY).toISOString();                                       // asked 4 days ago, approved now: the tap was 5 days before asking
  assert.equal((await promotionEventsService.recordSubscription(sub(m, gymId), { requestedAt: asked })).credited, 1);
  const m2 = await member();
  await tap(p, m2, 'gym', gymId, DAY, { verified: false });
  assert.equal((await promotionEventsService.recordSubscription(sub(m2, gymId))).credited, 0);
  const m3 = await member();
  await tap(p, m3, 'gym', gymId, 8 * DAY);
  assert.equal((await promotionEventsService.recordSubscription(sub(m3, gymId))).credited, 0);
});

test('a membership whose payment is reversed is taken back', async () => {
  const gymId = uid('gym'); const m = await member();
  const p = await promotion('gym', gymId);
  await tap(p, m, 'gym', gymId, DAY);
  const s = sub(m, gymId);
  await promotionEventsService.recordSubscription(s);
  assert.deepEqual(await promotionEventsService.reverseSubscription(s), { reversed: 1 });
  assert.deepEqual(await promotionEventsService.reverseSubscription(s), { reversed: 0 });
  assert.deepEqual(await promotionEventsService.reverseSubscription(null), { reversed: 0 });
});

// ── Through the real approval paths ─────────────────────────────────────────

async function pendingMembership(m, gymId, { requestedAt = new Date(), amountTzs = 60000 } = {}) {
  const id = uid('sub'); const pay = uid('pay');
  await db('Subscription').insert({ id, memberId: m, type: 'direct_sub', status: 'payment_pending', homeGymId: gymId, startedAt: new Date(), cycleStartedAt: new Date(), renewsAt: new Date(Date.now() + 30 * DAY), expiresAt: new Date(Date.now() + 30 * DAY), plan: 'monthly' });
  await db('PaymentRequest').insert({ id: pay, memberId: m, subscriptionId: id, amountTzs, status: 'pending', provider: 'admin_approved', requestedAt, plan: 'monthly', gymId });
  made.subs.push(id); made.pays.push(pay);
  return { subscriptionId: id, paymentId: pay };
}

test('approving a payment records the conversion with what was paid; changing it afterwards takes it back; rejecting records nothing', async () => {
  const gymId = uid('gym'); const m = await member(); const staff = await member();
  const p = await promotion('gym', gymId);
  await tap(p, m, 'gym', gymId, 3 * DAY);
  const a = await pendingMembership(m, gymId, { amountTzs: 60000 });
  assert.equal((await adminPaymentService.decide({ id: a.paymentId, decision: 'approve', actorId: staff })).error, undefined);
  const [row] = await conversions(p, 'subscription');
  assert.deepEqual([row.valueTzs, row.dedupeKey], [60000, `subscription:${a.subscriptionId}`]);
  // Staff then mark the payment rejected (it bounced): the conversion goes with it.
  assert.equal((await adminPaymentService.update({ id: a.paymentId, status: 'rejected', actorId: staff })).error, undefined);
  assert.equal((await conversions(p, 'subscription')).length, 0);
  // Put back to approved: it counts again, once.
  await adminPaymentService.update({ id: a.paymentId, status: 'approved', actorId: staff });
  await adminPaymentService.update({ id: a.paymentId, status: 'approved', actorId: staff });
  assert.equal((await conversions(p, 'subscription')).length, 1);
  // A payment that is rejected outright never counted.
  const b = await pendingMembership(m, gymId);
  await adminPaymentService.decide({ id: b.paymentId, decision: 'reject', actorId: staff });
  assert.equal((await conversions(p, 'subscription')).length, 1);
});

test('the provider webhook that activates a membership records the conversion too', async () => {
  const gymId = uid('gym'); const m = await member();
  const p = await promotion('gym', gymId);
  await tap(p, m, 'gym', gymId, DAY);
  const a = await pendingMembership(m, gymId);
  const out = await webhookService.handleSelcom({ payment_id: uid('selcom'), status: 'success', subscription_id: a.subscriptionId });
  assert.equal(out.ok, true);
  assert.equal((await conversions(p, 'subscription')).length, 1);
});
