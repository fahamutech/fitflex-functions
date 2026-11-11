import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerGymService } from '../src/services/owner-gym-service.mjs';

// An owner's trainerIds list on register / create gym / update gym must never link a trainer who
// did not ask to join. Only a pending join request for that gym is linked (as an approval);
// removals from the owner's own gym still work.

function store(rows = []) {
  return {
    rows,
    find: predicate => rows.find(predicate) || null,
    filter: predicate => rows.filter(predicate),
    async findAsync(predicate) { return rows.find(predicate) || null; },
    async filterAsync(predicate) { return rows.filter(predicate); },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async upsertAsync(predicate, row) {
      const index = rows.findIndex(predicate);
      if (index >= 0) rows[index] = row; else rows.push(row);
      return row;
    },
    async updateAsync(predicate, patch) {
      const row = rows.find(predicate);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
  };
}

function makeService() {
  const gyms = store([{ id: 'gym_mine', name: 'Mine' }, { id: 'gym_other', name: 'Other' }]);
  const users = store([{ id: 'own_1', userType: 'gym_owner', gymIds: ['gym_mine'], gymId: 'gym_mine' }]);
  const trainers = store([
    { id: 'trn_unrelated', gymIds: ['gym_other'] },
    { id: 'trn_free', gymIds: [] },
    { id: 'trn_mine', gymIds: ['gym_mine', 'gym_other'] },
    { id: 'trn_pending', gymIds: [], pendingGymIds: ['gym_mine'] },
  ]);
  const audit = [];
  const auditLog = { insert: row => audit.push(row), insertAsync: async row => { audit.push(row); } };
  const gymService = { normalizeGymPayload: (payload, prior) => ({ ...prior, ...payload }) };
  const service = createOwnerGymService({ gyms, users, trainers, invoices: store(), auditLog, gymService, trainerService: {} });
  const owner = users.rows[0];
  const gymIdsOf = id => trainers.rows.find(t => t.id === id).gymIds;
  return { service, owner, trainers, audit, gymIdsOf };
}

test('updateGym: an owner cannot link an unrelated trainer through trainerIds', async () => {
  const { service, owner, gymIdsOf } = makeService();
  const result = await service.updateGym({
    owner, gymId: 'gym_mine', body: { name: 'Mine', trainerIds: ['trn_mine', 'trn_unrelated', 'trn_free', 'trn_ghost'] },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(gymIdsOf('trn_unrelated'), ['gym_other']);
  assert.deepEqual(gymIdsOf('trn_free'), []);
  assert.deepEqual(gymIdsOf('trn_mine'), ['gym_mine', 'gym_other']);
  assert.deepEqual(result.trainersNotLinked.sort(), ['trn_free', 'trn_ghost', 'trn_unrelated']);
});

test('updateGym: an owner can still remove a trainer from their own gym, and only from it', async () => {
  const { service, owner, gymIdsOf } = makeService();
  const result = await service.updateGym({ owner, gymId: 'gym_mine', body: { name: 'Mine', trainerIds: [] } });
  assert.equal(result.error, undefined);
  assert.deepEqual(gymIdsOf('trn_mine'), ['gym_other']);
  assert.deepEqual(gymIdsOf('trn_unrelated'), ['gym_other']);
});

test('updateGym: a trainer with a pending join request is linked as an approval and audited', async () => {
  const { service, owner, trainers, audit, gymIdsOf } = makeService();
  const result = await service.updateGym({ owner, gymId: 'gym_mine', body: { name: 'Mine', trainerIds: ['trn_mine', 'trn_pending'] } });
  assert.deepEqual(result.trainersNotLinked, []);
  assert.deepEqual(gymIdsOf('trn_pending'), ['gym_mine']);
  assert.deepEqual(trainers.rows.find(t => t.id === 'trn_pending').pendingGymIds, []);
  assert.equal(audit.filter(a => a.action === 'trainer_join_approved' && a.target === 'trn_pending').length, 1);
});

test('updateGym: an owner cannot link a trainer onto a gym that is not theirs', async () => {
  const { service, owner, gymIdsOf } = makeService();
  const result = await service.updateGym({ owner, gymId: 'gym_other', body: { trainerIds: ['trn_free'] } });
  assert.equal(result.error, 'not_your_gym');
  assert.deepEqual(gymIdsOf('trn_free'), []);
});

test('createGym: trainerIds never link a trainer to the new gym', async () => {
  const { service, owner, trainers } = makeService();
  const result = await service.createGym({ owner, body: { name: 'New', trainerIds: ['trn_unrelated', 'trn_free'] } });
  assert.equal(result.error, undefined);
  const newId = result.gym.id;
  assert.ok(trainers.rows.every(t => !(t.gymIds || []).includes(newId)));
  assert.deepEqual(result.trainersNotLinked.sort(), ['trn_free', 'trn_unrelated']);
});

test('registerOwner: trainerIds never link a trainer to the registered gyms', async () => {
  const { service, trainers } = makeService();
  const user = { id: 'own_new', userType: 'gym_owner', phone: null };
  const result = await service.registerOwner({ user, body: { gyms: [{ name: 'Fresh', trainerIds: ['trn_unrelated', 'trn_free'] }] } });
  assert.equal(result.error, undefined);
  const [newId] = result.gymIds;
  assert.ok(trainers.rows.every(t => !(t.gymIds || []).includes(newId)));
  assert.deepEqual(result.trainersNotLinked.sort(), ['trn_free', 'trn_unrelated']);
});
