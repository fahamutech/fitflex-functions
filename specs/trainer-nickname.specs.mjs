// Trainer nickname (10 Oct 2026): a trainer may choose the name clients see.
// The profile's displayName becomes that name everywhere it is read; the
// trainer's own name is kept as fullName and is not shown to the public.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { adminListTrainers, adminUpsertTrainer, trainerMyProfile, trainerUpdateProfile, getTrainer } from '../functions/trainers.mjs';
import { cleanNickname, trainerNames } from '../src/services/trainer-service.mjs';
import { createSocialService } from '../src/services/social-service.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], trainers: [] };

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
async function call(route, req) {
  const out = res();
  await route.onRequest({ params: {}, query: {}, body: {}, headers: {}, ...req }, out);
  return out;
}
const admin = { sub: 'usr_admin_1', userType: 'admin' };

after(async () => {
  if (made.trainers.length) await db('TrainerProfile').whereIn('id', made.trainers).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

test('nickname rules: optional, 2–30 characters, plain characters only', () => {
  assert.equal(cleanNickname(undefined), null);
  assert.equal(cleanNickname('   '), null);
  assert.equal(cleanNickname('  Coach   Asha '), 'Coach Asha');
  assert.equal(cleanNickname("D'Fit_255"), "D'Fit_255");
  assert.equal(cleanNickname('Mwalimu Juma'), 'Mwalimu Juma');
  for (const bad of ['A', 'x'.repeat(31), '@asha', 'Asha <b>', 'http://x.y', '.dot']) {
    assert.equal(cleanNickname(bad), false, bad);
  }
});

test('names: clients see the nickname, otherwise the trainer\'s own name', () => {
  assert.deepEqual(trainerNames({ displayName: 'Asha Mushi' }), { fullName: 'Asha Mushi', nickname: null, displayName: 'Asha Mushi' });
  const prior = { displayName: 'Asha Mushi' }; // a profile from before nicknames
  const withNick = trainerNames({ nickname: 'Coach Asha' }, prior);
  assert.deepEqual(withNick, { fullName: 'Asha Mushi', nickname: 'Coach Asha', displayName: 'Coach Asha' });
  // A form that loaded the profile sends the shown name back: the own name is kept.
  assert.equal(trainerNames({ displayName: 'Coach Asha' }, withNick).fullName, 'Asha Mushi');
  // A new own name keeps the nickname on show.
  assert.deepEqual(trainerNames({ displayName: 'Asha M. Mushi' }, withNick),
    { fullName: 'Asha M. Mushi', nickname: 'Coach Asha', displayName: 'Coach Asha' });
  // Removing the nickname brings the own name back.
  assert.deepEqual(trainerNames({ nickname: '' }, withNick), { fullName: 'Asha Mushi', nickname: null, displayName: 'Asha Mushi' });
  assert.equal(trainerNames({ nickname: null }, withNick).displayName, 'Asha Mushi');
});

test('a trainer sets, changes and removes their nickname; the public sees only the shown name', async () => {
  const email = `${uid('nick')}@example.com`;
  const created = await call(adminUpsertTrainer, { user: admin, body: { displayName: 'Asha Mushi', email } });
  assert.equal(created.statusCode, 201);
  const trainerId = created.body.id;
  made.trainers.push(trainerId);
  assert.deepEqual([created.body.displayName, created.body.fullName, created.body.nickname], ['Asha Mushi', 'Asha Mushi', null]);

  const id = uid('usr');
  await db('User').insert({ id, userType: 'trainer', displayName: 'Asha Mushi', email, updatedAt: new Date() });
  made.users.push(id);
  const me = { sub: id, userType: 'trainer' };

  const bad = await call(trainerUpdateProfile, { user: me, body: { nickname: '@' } });
  assert.deepEqual([bad.statusCode, bad.body.error, bad.body.max], [400, 'invalid_nickname', 30]);

  const set = await call(trainerUpdateProfile, { user: me, body: { nickname: ' Coach  Asha ' } });
  assert.equal(set.statusCode, 200);
  assert.deepEqual([set.body.displayName, set.body.fullName, set.body.nickname], ['Coach Asha', 'Asha Mushi', 'Coach Asha']);

  // What anyone sees: the nickname, and never the trainer's own name.
  const pub = await call(getTrainer, { params: { id: trainerId } });
  assert.equal(pub.statusCode, 200);
  assert.equal(pub.body.displayName, 'Coach Asha');
  assert.equal('fullName' in pub.body, false);
  assert.equal('nickname' in pub.body, false);
  assert.equal(JSON.stringify(pub.body).includes('Asha Mushi'), false);

  // The trainer's own form sends everything back, including the own name.
  const own = (await call(trainerMyProfile, { user: me })).body;
  const resave = await call(trainerUpdateProfile, { user: me, body: { displayName: own.fullName, nickname: own.nickname, bio: 'Hello' } });
  assert.deepEqual([resave.body.displayName, resave.body.fullName], ['Coach Asha', 'Asha Mushi']);

  // An edit that does not mention names leaves them alone.
  const other = await call(trainerUpdateProfile, { user: me, body: { bio: 'Hi' } });
  assert.deepEqual([other.body.displayName, other.body.nickname], ['Coach Asha', 'Coach Asha']);

  // An admin saving the profile as the portal shows it does not lose the own name.
  const adminSave = await call(adminUpsertTrainer, { user: admin, body: { id: trainerId, displayName: 'Coach Asha', bio: 'By admin' } });
  assert.deepEqual([adminSave.body.displayName, adminSave.body.fullName, adminSave.body.nickname], ['Coach Asha', 'Asha Mushi', 'Coach Asha']);

  // Staff lists carry both names.
  const refs = await call(adminListTrainers, { user: admin, query: { refs: 'true' } });
  const ref = refs.body.find(t => t.id === trainerId);
  assert.deepEqual([ref.displayName, ref.fullName, ref.nickname], ['Coach Asha', 'Asha Mushi', 'Coach Asha']);

  const stored = await db('TrainerProfile').where({ id: trainerId }).first('displayName', 'fullName', 'nickname');
  assert.deepEqual({ ...stored }, { displayName: 'Coach Asha', fullName: 'Asha Mushi', nickname: 'Coach Asha' });

  const cleared = await call(trainerUpdateProfile, { user: me, body: { nickname: '' } });
  assert.deepEqual([cleared.body.displayName, cleared.body.fullName, cleared.body.nickname], ['Asha Mushi', 'Asha Mushi', null]);
});

test('posts, comments and groups show a trainer by the name on their trainer profile', async () => {
  const people = {
    usr_t: { id: 'usr_t', userType: 'trainer', displayName: 'Asha Mushi' },
    usr_plain: { id: 'usr_plain', userType: 'trainer', displayName: 'Juma Ali' },
    usr_m: { id: 'usr_m', userType: 'member', displayName: 'Neema' },
  };
  const profilesOf = [{ id: 'trn_1', userId: 'usr_t', displayName: 'Coach Asha' }];
  const none = { findByIdAsync: async () => null, filterAsync: async () => [], findAsync: async () => null };
  const svc = createSocialService({
    users: { findByIdAsync: async id => people[id] || null },
    trainers: { find: fn => profilesOf.find(fn) || null },
    activities: none, follows: none, blocks: none, profiles: none, groups: none,
    groupMembers: none, kudos: none, comments: none, reports: none,
  });
  assert.equal(await svc.nameOf('usr_t'), 'Coach Asha');
  assert.equal(await svc.nameOf('usr_plain'), 'Juma Ali', 'no trainer profile: the account name');
  assert.equal(await svc.nameOf('usr_m'), 'Neema');
});
