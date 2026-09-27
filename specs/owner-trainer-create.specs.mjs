import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerGymService } from '../src/services/owner-gym-service.mjs';
import { createTrainerService } from '../src/services/trainer-service.mjs';
import { verifyPassword } from '../src/auth/password-credentials.mjs';

function store(rows = []) {
  return {
    rows,
    find: predicate => rows.find(predicate) || null,
    filter: predicate => rows.filter(predicate),
    async findAsync(predicate) { return rows.find(predicate) || null; },
    async upsertAsync(predicate, row) {
      const index = rows.findIndex(predicate);
      if (index >= 0) rows[index] = row; else rows.push(row);
      return row;
    },
  };
}

function makeService() {
  const gyms = store([{ id: 'gym_owner', name: 'Owner Gym' }]);
  const users = store();
  const trainers = store();
  const gymService = { slimGym: gym => ({ id: gym.id, name: gym.name }) };
  const trainerService = createTrainerService({
    trainers, gyms, gymService, trainerBookings: store(), auditLog: { insert: () => {}, insertAsync: async () => {} },
  });
  return { users, trainers, service: createOwnerGymService({
    gyms, users, trainers, invoices: store(), auditLog: { insert: () => {}, insertAsync: async () => {} }, gymService, trainerService,
  }) };
}

test('owner can create a trainer account assigned only to their gym', async () => {
  const { service, users, trainers } = makeService();
  const result = await service.createTrainer({
    owner: { id: 'own_1', gymIds: ['gym_owner'] },
    body: { gymId: 'gym_owner', displayName: 'New Coach', email: 'coach@example.test', initialPin: '2468', specialties: ['Yoga'] },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.trainer.displayName, 'New Coach');
  assert.deepEqual(result.trainer.gymIds, ['gym_owner']);
  // The PIN is stored hashed, never as plaintext.
  assert.match(users.rows[0].passwordHash, /^scrypt:/);
  assert.equal(await verifyPassword('2468', users.rows[0].passwordHash), true);
  assert.equal(trainers.rows[0].userId, users.rows[0].id);
});

test('owner trainer creation rejects an invalid PIN and a gym outside their scope', async () => {
  const { service } = makeService();
  const owner = { id: 'own_1', gymIds: ['gym_owner'] };
  const invalidPin = await service.createTrainer({ owner, body: { gymId: 'gym_owner', displayName: 'Coach', email: 'a@test.dev', initialPin: '12' } });
  assert.equal(invalidPin.error, 'invalid_pin');
  const outsideGym = await service.createTrainer({ owner, body: { gymId: 'gym_other', displayName: 'Coach', email: 'a@test.dev', initialPin: '1234' } });
  assert.equal(outsideGym.error, 'not_your_gym');
});
