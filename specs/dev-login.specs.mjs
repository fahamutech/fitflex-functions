import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDevRole, buildDevIdentity } from '../src/shared/dev-login.mjs';

test('normalizeDevRole maps owner aliases to gym_operator', () => {
  assert.equal(normalizeDevRole('owner'), 'gym_operator');
  assert.equal(normalizeDevRole('gym_owner'), 'gym_operator');
  assert.equal(normalizeDevRole('gym_operator'), 'gym_operator');
  assert.equal(normalizeDevRole('Member'), 'member');
  assert.equal(normalizeDevRole('TRAINER'), 'trainer');
});

test('normalizeDevRole rejects unknown roles', () => {
  assert.equal(normalizeDevRole('admin'), null);
  assert.equal(normalizeDevRole(''), null);
  assert.equal(normalizeDevRole(undefined), null);
});

test('buildDevIdentity returns deterministic identities per role', () => {
  const member = buildDevIdentity('member');
  assert.equal(member.userType, 'member');
  assert.equal(member.id, 'usr_dev_member');
  assert.match(member.email, /@fitflex\.test$/);

  const owner = buildDevIdentity('owner');
  assert.equal(owner.userType, 'gym_operator');
  assert.equal(owner.id, 'usr_dev_owner');

  const trainer = buildDevIdentity('trainer');
  assert.equal(trainer.userType, 'trainer');
  assert.equal(trainer.id, 'usr_dev_trainer');

  // Deterministic across calls (same ids for reuse between blackbox launches).
  assert.deepEqual(buildDevIdentity('member'), member);
});

test('buildDevIdentity returns null for unknown role', () => {
  assert.equal(buildDevIdentity('hacker'), null);
});
