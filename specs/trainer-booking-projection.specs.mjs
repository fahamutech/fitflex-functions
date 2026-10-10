// The people embedded in trainer bookings, against the CI database: a member
// reads the trainer's public card (no contact details, account id, pending
// gyms or listing controls), a trainer reads a small card of the member (a
// name and a face — never the account row, its password hash or contact
// details), and FitFlex staff read the full trainer plus how to reach the
// member, still without the rest of the account.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { users, gyms, trainers, trainerBookings } from '../src/bootstrap/collections.mjs';
import {
  createTrainerBooking, memberMyBookings, trainerMyBookings, trainerCompleteBooking, trainerMySchedule,
  adminListTrainerBookings, adminUpdateTrainerBooking,
} from '../functions/trainer-bookings.mjs';
import { memberCancelTrainerBooking, trainerCancelBooking } from '../functions/refunds.mjs';
import { trainerSessionsForDate } from '../functions/trainer-engagements.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const created = { users: [], gyms: [], trainers: [], bookings: [], groups: [] };

const MEMBER_CARD = ['displayName', 'id', 'photoUrl'];
const ADMIN_MEMBER_CARD = ['displayName', 'email', 'id', 'phone', 'photoUrl'];
const PRIVATE_TRAINER = ['email', 'phone', 'userId', 'pendingGymIds', 'pendingGyms', 'approvalStatus', 'homepageVisible', 'homepagePriority', 'createdAt', 'updatedAt'];
const MEMBER_SECRETS = ['member-secret@fitflex.test', '+255700111222', '$2b$10$memberPasswordHashNeverLeaves', 'fb_member_uid', 'Mikocheni'];
const TRAINER_SECRETS = ['coach-secret@fitflex.test', '+255700333444'];
const DAY = '2031-04-08';

async function makeGym() {
  await gyms.ready;
  const id = uid('gym');
  await gyms.insertAsync({
    id, name: `Booking Gym ${id}`, tier: 'standard', location: 'Dar es Salaam', status: 'active',
    venueType: 'physical', accessMode: 'paid_visit', perVisitRate: 8000, images: [], thumbnails: [],
    amenities: [], equipment: [], classes: [], createdAt: now(), updatedAt: now(),
  });
  created.gyms.push(id);
  return id;
}

async function makeUser(userType, extra = {}) {
  const id = uid('usr');
  await users.insertAsync({ id, userType, displayName: 'Booking Tester', createdAt: now(), updatedAt: now(), ...extra });
  created.users.push(id);
  return id;
}

const makeMember = () => makeUser('member', {
  displayName: 'Amina Member', photoUrl: 'https://img.test/amina.jpg',
  email: `${uid('m')}-member-secret@fitflex.test`, phone: `+255700111222${Math.floor(Math.random() * 1e6)}`,
  firebaseUid: uid('fb_member_uid'), passwordHash: '$2b$10$memberPasswordHashNeverLeaves',
  memberProfile: { address: 'Mikocheni' }, aclPermissions: [], accountStatus: 'active',
});

async function makeTrainer(userId, gymId, pendingGymId) {
  await trainers.ready;
  const id = uid('trn');
  await trainers.insertAsync({
    id, userId, displayName: `Booking Coach ${id}`, specialties: ['Boxing'], bio: 'Bio', hourlyRateTzs: 30000,
    email: 'coach-secret@fitflex.test', phone: '+255700333444',
    gymIds: [gymId], pendingGymIds: [pendingGymId], status: 'active', approvalStatus: 'approved',
    homepageVisible: true, homepagePriority: 7, availability: [], socialLinks: {},
    createdAt: now(), updatedAt: now(),
  });
  created.trainers.push(id);
  return id;
}

async function makeBooking({ memberId, trainerId, gymId, slot, status = 'confirmed' }) {
  const id = uid('tbk');
  await trainerBookings.insertAsync({
    id, groupId: id, memberId, trainerId, gymId, date: DAY, slot, status, amountTzs: 30000, createdAt: now(), updatedAt: now(),
  });
  created.bookings.push(id);
  return id;
}

/** A member, a trainer with one linked and one pending gym, and who they sign in as. */
async function scene() {
  const gymId = await makeGym();
  const pendingGymId = await makeGym();
  const memberId = await makeMember();
  const trainerUserId = await makeUser('trainer', { email: `${uid('t')}@fitflex.test` });
  const trainerId = await makeTrainer(trainerUserId, gymId, pendingGymId);
  return {
    gymId, pendingGymId, memberId, trainerUserId, trainerId,
    member: { sub: memberId, userType: 'member' },
    trainer: { sub: trainerUserId, userType: 'trainer' },
    admin: { sub: await makeUser('admin'), userType: 'admin' },
  };
}

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** Run a route's guards, then its handler if every guard passes. */
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

/** Nothing of the member's account, anywhere in what was sent. */
function assertNoMemberSecrets(payload, label, secrets = MEMBER_SECRETS) {
  const raw = JSON.stringify(payload);
  for (const secret of secrets) assert.ok(!raw.includes(secret), `${label} must not contain ${secret}`);
  for (const k of ['passwordHash', 'firebaseUid', 'aclPermissions', 'memberProfile', 'personId', 'accountStatus']) {
    assert.ok(!raw.includes(`"${k}"`), `${label} must not carry ${k}`);
  }
}

/** The member is a card: a name and a face, and nothing else. */
function assertMemberCard(member, s, label) {
  assert.ok(member, `${label} carries the member`);
  assert.deepEqual(Object.keys(member).sort(), MEMBER_CARD, `${label} member is only a card`);
  assert.equal(member.id, s.memberId);
  assert.equal(member.displayName, 'Amina Member');
  assert.equal(member.photoUrl, 'https://img.test/amina.jpg');
}

/** The trainer is the public card: named and priced, with nothing private anywhere in it. */
function assertPublicTrainer(trainer, s, label) {
  assert.ok(trainer, `${label} carries the trainer`);
  assert.equal(trainer.id, s.trainerId, `${label} is the right trainer`);
  assert.ok(trainer.displayName, `${label} still carries the trainer's name`);
  assert.equal(trainer.hourlyRateTzs, 30000);
  assert.deepEqual(trainer.gyms.map(g => g.id), [s.gymId], `${label} still lists the trainer's gyms`);
  for (const k of PRIVATE_TRAINER) assert.ok(!(k in trainer), `${label} trainer must not carry ${k}`);
  const raw = JSON.stringify(trainer);
  for (const secret of [...TRAINER_SECRETS, s.trainerUserId, s.pendingGymId]) {
    assert.ok(!raw.includes(secret), `${label} trainer must not contain ${secret}`);
  }
}

/** What either party reads of a booking: a public trainer, a member card, no account details. */
function assertPartyView(booking, s, label) {
  assertPublicTrainer(booking.trainer, s, label);
  assertMemberCard(booking.member, s, label);
  assertNoMemberSecrets(booking, label);
}

after(async () => {
  for (const id of created.bookings) await trainerBookings.removeAsync(b => b.id === id);
  if (created.groups.length) {
    await db('TrainerBooking').whereIn('groupId', created.groups).del();
    await db('PaymentRequest').whereIn('bookingGroupId', created.groups).del();
  }
  if (created.users.length) await db('Notification').whereIn('userId', created.users).del();
  await db('AuditLog').whereIn('target', [...created.bookings, ...created.groups]).del();
  for (const id of created.trainers) await trainers.removeAsync(t => t.id === id);
  for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  if (created.users.length) await db('User').whereIn('id', created.users).del();
  await db.destroy();
});

test("a member's bookings carry the trainer's public card, never the trainer's private details", async () => {
  const s = await scene();
  const bookingId = await makeBooking({ ...s, slot: '09:00' });

  const out = await call(memberMyBookings, { claims: s.member });
  assert.equal(out.statusCode, 200);
  const row = out.body.find(b => b.id === bookingId);
  assert.ok(row, 'the member sees the booking');
  assertPartyView(row, s, 'member booking');
  assert.ok(row.cancellation, 'the member still learns what they can do with the booking');
  assert.equal(row.gym.id, s.gymId);
});

test('booking a trainer answers with the public card', async () => {
  const s = await scene();
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);

  const out = await call(createTrainerBooking, { claims: s.member, body: { trainerId: s.trainerId, gymId: s.gymId, slots: [{ date, slot: '10:00' }] } });
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  created.groups.push(out.body.bookingGroupId);
  assert.equal(out.body.bookings.length, 1);
  assertPublicTrainer(out.body.trainer, s, 'new booking');
});

test("a trainer's bookings and day carry a small card of the member, never the member's account", async () => {
  const s = await scene();
  const bookingId = await makeBooking({ ...s, slot: '09:00' });

  const list = await call(trainerMyBookings, { claims: s.trainer });
  assert.equal(list.statusCode, 200);
  const row = list.body.find(b => b.id === bookingId);
  assert.ok(row, 'the trainer sees the booking');
  assertPartyView(row, s, 'trainer booking');

  const day = await call(trainerSessionsForDate, { claims: s.trainer, query: { date: DAY } });
  assert.equal(day.statusCode, 200);
  assert.deepEqual(day.body.sessions.map(x => x.id), [bookingId]);
  assertMemberCard(day.body.sessions[0].member, s, 'trainer day');
  assertNoMemberSecrets(day.body, 'trainer day');

  const calendar = await call(trainerMySchedule, { claims: s.trainer, query: { from: DAY, days: 1 } });
  assert.equal(calendar.statusCode, 200);
  assertNoMemberSecrets(calendar.body, 'trainer calendar');
});

test('completing and cancelling a booking answer with the same cards', async () => {
  const s = await scene();
  const toComplete = await makeBooking({ ...s, slot: '09:00' });
  const memberCancels = await makeBooking({ ...s, slot: '10:00', status: 'payment_pending' });
  const trainerCancels = await makeBooking({ ...s, slot: '11:00', status: 'payment_pending' });

  const done = await call(trainerCompleteBooking, { claims: s.trainer, params: { id: toComplete } });
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'completed');
  assertPartyView(done.body, s, 'completed booking');

  const byMember = await call(memberCancelTrainerBooking, { claims: s.member, params: { id: memberCancels } });
  assert.equal(byMember.statusCode, 200, JSON.stringify(byMember.body));
  assert.equal(byMember.body.booking.status, 'cancelled');
  assertPartyView(byMember.body.booking, s, 'booking cancelled by the member');

  const byTrainer = await call(trainerCancelBooking, { claims: s.trainer, params: { id: trainerCancels } });
  assert.equal(byTrainer.statusCode, 200, JSON.stringify(byTrainer.body));
  assert.equal(byTrainer.body.booking.status, 'cancelled');
  assertPartyView(byTrainer.body.booking, s, 'booking cancelled by the trainer');
});

test("FitFlex staff read the full trainer and how to reach the member, but not the member's account", async () => {
  const s = await scene();
  const bookingId = await makeBooking({ ...s, slot: '09:00' });
  const account = await users.findByIdAsync(s.memberId);
  const hidden = MEMBER_SECRETS.filter(x => !x.includes('@') && !x.startsWith('+'));

  const list = await call(adminListTrainerBookings, { claims: s.admin });
  assert.equal(list.statusCode, 200);
  const row = list.body.find(b => b.id === bookingId);
  assert.ok(row, 'staff see the booking');
  assert.deepEqual(Object.keys(row.member).sort(), ADMIN_MEMBER_CARD);
  assert.equal(row.member.email, account.email);
  assert.equal(row.member.phone, account.phone);
  assert.equal(row.trainer.email, 'coach-secret@fitflex.test', 'staff still see the trainer in full');
  assert.equal(row.trainer.userId, s.trainerUserId);
  assert.deepEqual(row.trainer.pendingGymIds, [s.pendingGymId]);
  assertNoMemberSecrets(row, 'admin booking', hidden);

  const updated = await call(adminUpdateTrainerBooking, { claims: s.admin, params: { id: bookingId }, body: { status: 'completed' } });
  assert.equal(updated.statusCode, 200, JSON.stringify(updated.body));
  assert.deepEqual(Object.keys(updated.body.member).sort(), ADMIN_MEMBER_CARD);
  assert.equal(updated.body.trainer.userId, s.trainerUserId);
  assertNoMemberSecrets(updated.body, 'admin booking update', hidden);

  for (const who of [s.member, s.trainer]) {
    assert.equal((await call(adminListTrainerBookings, { claims: who })).statusCode, 403, 'only staff read the admin list');
  }
});
