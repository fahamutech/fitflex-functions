export function operatorGymIds(operator) {
  return operator?.gymIds?.length ? operator.gymIds : (operator?.gymId ? [operator.gymId] : []);
}

export function resolveOperatorGymSelection(operator, requestedGymId) {
  const ids = operatorGymIds(operator);
  const selectedGymId = requestedGymId ? String(requestedGymId) : null;

  if (ids.length === 0) return { ok: false, failure: 'operator_not_assigned_to_gym', ids };
  if (selectedGymId && !ids.includes(selectedGymId)) return { ok: false, failure: 'not_your_gym', ids };
  if (!selectedGymId && ids.length > 1) return { ok: false, failure: 'gym_required', ids, requiresGymSelection: true };

  return { ok: true, gymId: selectedGymId || ids[0], ids, requiresGymSelection: false };
}
