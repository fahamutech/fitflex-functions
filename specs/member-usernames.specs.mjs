// Member usernames against the CI database: choosing, the 30-day change limit,
// case-insensitive uniqueness, the 90-day hold on released handles, admin
// clearing a reported username, and the feature flag.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { users, trainers, memberUsernames } from '../src/bootstrap/collections.mjs';
import { usernameService, socialService } from '../src/bootstrap/services.mjs';
import { usernameAvailable, setUsername, clearUsername } from '../functions/member-usernames.mjs';
import { me } from '../functions/subscriptions.mjs';
import { cleanUsername } from '../src/shared/username.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
// Letters only, so a random tag can never look like a phone number.
const tag = () => randomUUID().replace(/-/g, '').slice(0, 8).replace(/[0-9]/g, (d) => 'ghijklmnop'[d]);
const now = () => new Date().toISOString();
const made = { users: [], trainers: [], reports: [] };

async function member(extra = {}) {
  const id = uid('usr');
  await users.insertAsync({ id, userType: 'member', displayName: 'Amina Said', createdAt: now(), updatedAt: now(), ...extra });
  made.users.push(id);
  return id;
}

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call(route, userId, { body = {}, query = {}, userType = 'member' } = {}) {
  const req = { headers: { authorization: `Bearer ${sign({ sub: userId, userType })}` }, params: {}, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}
const on = () => { process.env.MEMBER_USERNAMES = '1'; };
const off = () => { delete process.env.MEMBER_USERNAMES; };
beforeEach(on);

test('the flag off: endpoints say feature_disabled and /me has no username', async () => {
  off();
  const id = await member();
  assert.equal((await call(setUsername, id, { body: { username: `x${tag()}` } })).statusCode, 404);
  assert.equal((await call(usernameAvailable, id, { query: { handle: 'abcdef' } })).body.error, 'feature_disabled');
  const mine = await call(me, id);
  assert.ok(!('username' in (mine.body ?? {})), 'no username field while off');
});

test('validation: shape, reserved and blocked words, contact details', () => {
  assert.equal(cleanUsername('Amina_K').ok, true);
  assert.equal(cleanUsername('@amina.k').handle, 'amina.k');
  for (const bad of ['ab', 'a'.repeat(21), 'ama..k', '_ama', 'amina k', '0712345678', 'x@y.co']) {
    assert.equal(cleanUsername(bad).error, 'invalid_username', bad);
  }
  assert.equal(cleanUsername('Admin').error, 'username_reserved');
  assert.equal(cleanUsername('fit.flex').error, 'username_reserved');
  assert.equal(cleanUsername('xshitx').error, 'username_reserved');
});

test('choose, read back on /me, and change within the limit is refused', async () => {
  const id = await member();
  const handle = `Amina_${tag()}`;
  const set = await call(setUsername, id, { body: { username: handle } });
  assert.equal(set.statusCode, 200, JSON.stringify(set.body));
  assert.equal(set.body.username, handle);
  const mine = await call(me, id);
  assert.equal(mine.body.username, handle);
  assert.ok(mine.body.usernameChangeableAt, 'next change date is given');

  const again = await call(setUsername, id, { body: { username: `other_${tag()}` } });
  assert.equal(again.statusCode, 429);
  assert.equal(again.body.error, 'username_cooldown');
  assert.ok(again.body.nextChangeAt);
});

test('after 30 days the member may change it, and the old handle is held 90 days', async () => {
  const id = await member();
  const first = `first_${tag()}`;
  await call(setUsername, id, { body: { username: first } });
  await memberUsernames.updateByIdAsync(id, { changedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() });
  const second = `second_${tag()}`;
  assert.equal((await call(setUsername, id, { body: { username: second } })).statusCode, 200);

  // Someone else cannot take the old handle for 90 days; the former owner can.
  const other = await member();
  const blocked = await call(setUsername, other, { body: { username: first } });
  assert.equal(blocked.body.error, 'username_released_recently');
  assert.equal((await call(usernameAvailable, other, { query: { handle: first } })).body.reason, 'username_released_recently');
  // …until the hold is over.
  await db('UsernameRelease').where({ handleLower: first.toLowerCase() }).update({ releasedAt: new Date(Date.now() - 91 * 86_400_000).toISOString() });
  assert.equal((await call(setUsername, other, { body: { username: first } })).statusCode, 200);
});

test('handles are unique ignoring case', async () => {
  const a = await member(); const b = await member();
  const h = `Juma${tag()}`;
  assert.equal((await call(setUsername, a, { body: { username: h } })).statusCode, 200);
  const clash = await call(setUsername, b, { body: { username: h.toUpperCase() } });
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.body.error, 'username_taken');
});

test('a trainer nickname or gym name cannot be taken as a username', async () => {
  const t = `Coach${tag()}`;
  const trainerId = uid('trn');
  const trainerUser = await member({ userType: 'trainer', displayName: 'Real Name' });
  await trainers.insertAsync({ id: trainerId, userId: trainerUser, displayName: t, nickname: t, status: 'active', createdAt: now(), updatedAt: now() });
  made.trainers.push(trainerId);
  const id = await member();
  const out = await call(setUsername, id, { body: { username: t.toLowerCase() } });
  assert.equal(out.body.error, 'username_reserved');
});

test('clearing counts as a change; the member shows by name again', async () => {
  const id = await member();
  await call(setUsername, id, { body: { username: `gone_${tag()}` } });
  await memberUsernames.updateByIdAsync(id, { changedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
  const cleared = await call(clearUsername, id);
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.body.username, null);
  const next = await call(setUsername, id, { body: { username: `again_${tag()}` } });
  assert.equal(next.body.error, 'username_cooldown', 'clearing started the clock');
});

test('only members may choose one', async () => {
  const id = uid('usr');
  await users.insertAsync({ id, userType: 'gym_operator', displayName: 'Owner', createdAt: now(), updatedAt: now() });
  made.users.push(id);
  const out = await usernameService.set({ id, userType: 'gym_operator' }, 'owner_handle');
  assert.equal(out.error, 'not_a_member');
});

test('an admin clears a reported username; the member may pick another but never the same', async () => {
  const id = await member(); const reporter = await member();
  const h = `rude_${tag()}`;
  await call(setUsername, id, { body: { username: h } });
  const filed = await socialService.report(reporter, { targetType: 'user', targetId: id, reason: 'offensive' });
  made.reports.push(filed.report.id);
  const resolved = await socialService.resolveReport('adm_1', filed.report.id, { action: 'clear_username' });
  assert.equal(resolved.resolved, true);
  const row = await memberUsernames.findByIdAsync(id);
  assert.equal(row.handle, null);
  assert.equal(row.status, 'cleared');
  const same = await call(setUsername, id, { body: { username: h } });
  assert.equal(same.body.error, 'username_not_allowed');
  const other = await call(setUsername, id, { body: { username: `fresh_${tag()}` } });
  assert.equal(other.statusCode, 200, 'an admin clear resets the 30-day clock');
});

test('a deleted account frees its handle into the 90-day hold', async () => {
  const id = await member();
  const h = `bye_${tag()}`;
  await call(setUsername, id, { body: { username: h } });
  await usernameService.forgetUser(id);
  assert.ok((await memberUsernames.findByIdAsync(id)) == null, 'row removed');
  const other = await member();
  assert.equal((await call(setUsername, other, { body: { username: h } })).body.error, 'username_released_recently');
});

after(async () => {
  off();
  for (const id of made.reports) await db('SocialReport').where({ id }).del().catch(() => {});
  for (const id of made.trainers) await db('TrainerProfile').where({ id }).del().catch(() => {});
  for (const id of made.users) {
    await db('UsernameRelease').where({ userId: id }).del().catch(() => {});
    await db('MemberUsername').where({ id }).del().catch(() => {});
    await db('User').where({ id }).del().catch(() => {});
  }
});
