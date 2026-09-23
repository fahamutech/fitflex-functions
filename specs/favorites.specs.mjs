// Saved gyms (US017).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFavoriteService } from '../src/services/favorite-service.mjs';

function users(rows) {
  return {
    rows,
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async updateByIdAsync(id, patch) { Object.assign(rows.find(r => r.id === id), patch); },
  };
}
const gyms = [{ id: 'g1', status: 'active' }, { id: 'g2', status: 'active' }, { id: 'gx', status: 'inactive' }];

test('save, list newest first, unsave', async () => {
  const u = users([{ id: 'm1', memberProfile: { fitnessGoal: 'stay_fit' } }]);
  const svc = createFavoriteService({ users: u, gyms });
  await svc.set({ memberId: 'm1', gymId: 'g1', favorite: true });
  await svc.set({ memberId: 'm1', gymId: 'g2', favorite: true });
  assert.deepEqual(await svc.list('m1'), ['g2', 'g1']);
  await svc.set({ memberId: 'm1', gymId: 'g1', favorite: false });
  assert.deepEqual(await svc.list('m1'), ['g2']);
  assert.equal(u.rows[0].memberProfile.fitnessGoal, 'stay_fit', 'other profile fields kept');
});

test('saving twice keeps one entry; unknown gyms are rejected', async () => {
  const svc = createFavoriteService({ users: users([{ id: 'm1' }]), gyms });
  await svc.set({ memberId: 'm1', gymId: 'g1', favorite: true });
  await svc.set({ memberId: 'm1', gymId: 'g1', favorite: true });
  assert.deepEqual(await svc.list('m1'), ['g1']);
  assert.equal((await svc.set({ memberId: 'm1', gymId: 'nope', favorite: true })).status, 404);
});

test('inactive gyms drop out of the list', async () => {
  const svc = createFavoriteService({ users: users([{ id: 'm1', memberProfile: { favoriteGymIds: ['gx', 'g1'] } }]), gyms });
  assert.deepEqual(await svc.list('m1'), ['g1']);
});
