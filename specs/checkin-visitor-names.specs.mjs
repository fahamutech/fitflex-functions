// GET /owner/gyms/:gymId/checkins against the CI database: owners see who
// visited by name when CHECKIN_VISITOR_NAMES is on, a trainer by the name on
// their trainer profile, and a display name that is really an email or a phone
// number is withheld. With the flag off the response is exactly as before.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { users, gyms, checkins, trainers } from '../src/bootstrap/collections.mjs';
import { ownerGymCheckins } from '../functions/owner-gyms.mjs';
import { visitorName } from '../src/shared/visitor-name.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const created = { users: [], gyms: [], checkins: [], trainers: [] };

async function makeUser(userType, extra = {}) {
  const id = uid('usr');
  await users.insertAsync({ id, userType, displayName: null, createdAt: now(), updatedAt: now(), ...extra });
  created.users.push(id);
  return id;
}

async function makeGym() {
  await gyms.ready;
  const id = uid('gym');
  await gyms.insertAsync({ id, name: `Names Gym ${id}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', createdAt: now(), updatedAt: now() });
  created.gyms.push(id);
  return id;
}

let minute = 0;
async function checkIn(memberId, gymId, subscriptionType = 'platform_pass') {
  const id = uid('ck');
  const timestamp = new Date(Date.now() - (minute += 1) * 60_000).toISOString();
  await checkins.insertAsync({
    id, memberId, gymId, timestamp, method: 'qr', subscriptionType, passTier: 'pro',
    gymTier: 'standard', visitConsumed: true, status: 'valid',
  });
  created.checkins.push(id);
  return id;
}

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function call(route, { claims, params = {} } = {}) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body: {}, query: {} };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

async function setup() {
  const gymId = await makeGym();
  const ownerId = await makeUser('gym_operator', { gymId, gymIds: [gymId], displayName: 'Owner' });
  const amina = await makeUser('member', { displayName: 'Amina Said' });
  const mailish = await makeUser('member', { displayName: 'someone@example.com' });
  const phoneish = await makeUser('member', { displayName: '+255 712 345 678' });
  const coachUser = await makeUser('trainer', { displayName: 'Amani Mushi' });
  const trainerRow = { id: uid('trn'), userId: coachUser, displayName: 'Coach Amani', fullName: 'Amani Mushi', nickname: 'Coach Amani', status: 'active', createdAt: now(), updatedAt: now() };
  await trainers.insertAsync(trainerRow);
  created.trainers.push(trainerRow.id);
  const rows = {
    amina: await checkIn(amina, gymId),
    mailish: await checkIn(mailish, gymId),
    phoneish: await checkIn(phoneish, gymId),
    coach: await checkIn(coachUser, gymId, 'trainer_home'),
  };
  return { gymId, ownerId, ids: { amina, mailish, phoneish, coachUser }, rows };
}

const claimsOf = (ownerId) => ({ sub: ownerId, userType: 'gym_operator' });

test('flag off: no display names, public IDs as before', async () => {
  delete process.env.CHECKIN_VISITOR_NAMES;
  const { gymId, ownerId } = await setup();
  const out = await call(ownerGymCheckins, { claims: claimsOf(ownerId), params: { gymId } });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.length, 4);
  for (const row of out.body) {
    assert.ok(!('displayName' in row), 'no displayName while the flag is off');
    assert.match(row.memberPublicId, /^F[MT]\d+/);
    assert.equal(row.memberName, row.memberPublicId);
  }
});

test('flag on: members by name, trainers by profile name, contact details withheld', async () => {
  process.env.CHECKIN_VISITOR_NAMES = 'true';
  try {
    const { gymId, ownerId, rows } = await setup();
    const out = await call(ownerGymCheckins, { claims: claimsOf(ownerId), params: { gymId } });
    assert.equal(out.statusCode, 200);
    const by = (id) => out.body.find(r => r.id === id);
    assert.equal(by(rows.amina).displayName, 'Amina Said');
    assert.equal(by(rows.coach).displayName, 'Coach Amani');
    assert.equal(by(rows.mailish).displayName, null, 'an email is not a name');
    assert.equal(by(rows.phoneish).displayName, null, 'a phone number is not a name');
    for (const row of out.body) {
      assert.match(row.memberPublicId, /^F[MT]\d+/, 'public ID kept');
      assert.ok(!JSON.stringify(row).includes('example.com'), 'no email in the row');
    }
  } finally {
    delete process.env.CHECKIN_VISITOR_NAMES;
  }
});

test('another gym’s owner is refused, names or not', async () => {
  process.env.CHECKIN_VISITOR_NAMES = 'true';
  try {
    const { gymId } = await setup();
    const otherGym = await makeGym();
    const stranger = await makeUser('gym_operator', { gymId: otherGym, gymIds: [otherGym] });
    const out = await call(ownerGymCheckins, { claims: claimsOf(stranger), params: { gymId } });
    assert.equal(out.statusCode, 403);
  } finally {
    delete process.env.CHECKIN_VISITOR_NAMES;
  }
});

test('visitorName: trims, prefers the trainer profile, withholds contact details', () => {
  assert.equal(visitorName({ user: { displayName: '  Amina   Said ' } }), 'Amina Said');
  assert.equal(visitorName({ user: { userType: 'trainer', displayName: 'Own Name' }, trainer: { displayName: 'Nick' } }), 'Nick');
  assert.equal(visitorName({ user: { userType: 'member', displayName: 'Plain' }, trainer: { displayName: 'Nick' } }), 'Plain');
  assert.equal(visitorName({ user: { displayName: 'a@b.co' } }), null);
  assert.equal(visitorName({ user: { displayName: '0712345678' } }), null);
  assert.equal(visitorName({ user: { displayName: '   ' } }), null);
  assert.equal(visitorName({}), null);
});

after(async () => {
  for (const id of created.checkins) await db('Checkin').where({ id }).del().catch(() => {});
  for (const id of created.trainers) await db('Trainer').where({ id }).del().catch(() => {});
  for (const id of created.gyms) await db('Gym').where({ id }).del().catch(() => {});
  for (const id of created.users) await db('User').where({ id }).del().catch(() => {});
});
