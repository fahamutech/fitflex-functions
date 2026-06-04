import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOperatorGymSelection } from '../src/shared/operator-gym-selection.mjs';

test('multi-gym operator must explicitly choose a gym for scanned member check-in', () => {
  const result = resolveOperatorGymSelection({ gymId: 'gym_a', gymIds: ['gym_a', 'gym_b'] });

  assert.equal(result.ok, false);
  assert.equal(result.failure, 'gym_required');
  assert.equal(result.requiresGymSelection, true);
});

test('multi-gym operator selection resolves only owned gyms', () => {
  const selected = resolveOperatorGymSelection(
    { gymId: 'gym_a', gymIds: ['gym_a', 'gym_b'] },
    'gym_b',
  );
  const unowned = resolveOperatorGymSelection(
    { gymId: 'gym_a', gymIds: ['gym_a', 'gym_b'] },
    'gym_c',
  );

  assert.equal(selected.ok, true);
  assert.equal(selected.gymId, 'gym_b');
  assert.equal(unowned.ok, false);
  assert.equal(unowned.failure, 'not_your_gym');
});

test('single-gym operator can use server-side gym default', () => {
  const result = resolveOperatorGymSelection({ gymId: 'gym_a' });

  assert.equal(result.ok, true);
  assert.equal(result.gymId, 'gym_a');
});
