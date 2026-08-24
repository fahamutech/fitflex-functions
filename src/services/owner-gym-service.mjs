// Owner/operator gym management service — self-registration, gym CRUD scoped
// to the owner's own gym(s), invoices/earnings, trainer↔gym linking.
import { randomUUID } from 'node:crypto';

export function createOwnerGymService({ gyms, users, trainers, invoices, auditLog, gymService, trainerService }) {
  const ownerGymIdsOf = (owner) => owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);

  // Sync the trainer↔gym join so a gym's trainerIds list becomes the source of
  // truth: any trainer not in the new list loses this gym, any new one gains it.
  function syncTrainersForGym(gymId, trainerIdList) {
    const desired = new Set(Array.isArray(trainerIdList) ? trainerIdList.filter(Boolean) : []);
    const current = trainers.filter(t => Array.isArray(t.gymIds) && t.gymIds.includes(gymId));
    for (const t of current) {
      if (!desired.has(t.id)) {
        const remaining = (t.gymIds || []).filter(id => id !== gymId);
        trainers.update(x => x.id === t.id, { gymIds: remaining });
      }
    }
    for (const tid of desired) {
      const t = trainers.find(x => x.id === tid);
      if (!t) continue;
      const existing = t.gymIds || [];
      if (!existing.includes(gymId)) {
        trainers.update(x => x.id === tid, { gymIds: [...existing, gymId] });
      }
    }
  }

  async function registerOwner({ user, body }) {
    const gymList = Array.isArray(body.gyms) ? body.gyms : [];
    if (gymList.length === 0) return { error: 'at_least_one_gym_required', status: 400 };
    const createdGyms = [];
    const gymIds = [];
    for (const g of gymList) {
      const gymData = { ...g };
      if (!gymData.images && Array.isArray(gymData.imagePaths)) {
        gymData.images = gymData.imagePaths;
        delete gymData.imagePaths;
      }
      if (!gymData.id) gymData.id = `gym_${randomUUID().slice(0, 8)}`;
      const row = gymService.normalizeGymPayload(gymData, {});
      row.status = 'active';
      await gyms.upsertAsync(x => x.id === row.id, row);
      createdGyms.push(row);
      gymIds.push(row.id);

      const trainerIdList = Array.isArray(g.trainerIds) ? g.trainerIds : [];
      for (const tid of trainerIdList) {
        const trainer = trainers.find(t => t.id === tid);
        if (trainer) {
          const existingGymIds = trainer.gymIds || [];
          if (!existingGymIds.includes(row.id)) {
            trainers.update(t => t.id === tid, { gymIds: [...existingGymIds, row.id] });
          }
        }
      }
    }
    await users.upsertAsync(u => u.id === user.id, {
      ...user,
      displayName: body.displayName || user.displayName,
      phone: body.phone || user.phone,
      gymId: gymIds[0],
      gymIds,
      onboardingCompleted: true,
    });
    return { gyms: createdGyms, gymIds };
  }

  async function myGyms(owner) {
    const ids = ownerGymIdsOf(owner);
    const owned = [];
    for (const id of ids) {
      const gym = await gyms.findByIdAsync(id);
      if (gym) owned.push(gym);
    }
    return owned;
  }

  async function myInvoices(owner) {
    const ids = ownerGymIdsOf(owner);
    const allInv = await invoices.filterAsync(i => ids.includes(i.gymId));
    allInv.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return allInv;
  }

  async function myEarnings({ owner, requestedGymId }) {
    const ownedGymIds = ownerGymIdsOf(owner);
    const ids = requestedGymId && ownedGymIds.includes(requestedGymId) ? [requestedGymId] : ownedGymIds;
    const paid = await invoices.filterAsync(i => ids.includes(i.gymId) && i.status === 'paid');
    const totalPaid = paid.reduce((s, i) => s + (i.amount || 0), 0);
    const pending = await invoices.filterAsync(i => ids.includes(i.gymId) && i.status === 'unpaid');
    const totalPending = pending.reduce((s, i) => s + (i.amount || 0), 0);
    return { totalPaid, totalPending, paidCount: paid.length, pendingCount: pending.length };
  }

  async function gymCheckIns({ owner, gymId, checkins }) {
    const ids = ownerGymIdsOf(owner);
    if (!ids.includes(gymId)) return { error: 'not_your_gym', status: 403 };
    const allGymCheckins = await checkins.filterAsync(c => c.gymId === gymId);
    return { list: allGymCheckins.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp)).slice(0, 100).map(c => ({ ...c })) };
  }

  async function updateGym({ owner, gymId, body }) {
    const ids = ownerGymIdsOf(owner);
    if (!ids.includes(gymId)) return { error: 'not_your_gym', status: 403 };
    const prior = gyms.find(g => g.id === gymId);
    if (!prior) return { error: 'gym_not_found', status: 404 };
    const row = gymService.normalizeGymPayload({ ...body, id: prior.id }, prior);
    row.status = prior.status; // owner can't change status
    await gyms.upsertAsync(g => g.id === row.id, row);
    if (Array.isArray(body.trainerIds)) syncTrainersForGym(row.id, body.trainerIds);
    return { gym: row };
  }

  async function createGym({ owner, body }) {
    if (!body.name) return { error: 'name_required', status: 400 };
    const id = `gym_${randomUUID().slice(0, 8)}`;
    const row = gymService.normalizeGymPayload({ ...body, id }, {});
    row.status = 'active';
    await gyms.upsertAsync(g => g.id === row.id, row);
    if (Array.isArray(body.trainerIds) && body.trainerIds.length) syncTrainersForGym(row.id, body.trainerIds);
    const currentGymIds = ownerGymIdsOf(owner);
    const updatedGymIds = [...currentGymIds, id];
    await users.upsertAsync(u => u.id === owner.id, { ...owner, gymIds: updatedGymIds, gymId: updatedGymIds[0], onboardingCompleted: true });
    return { gym: row };
  }

  async function deleteGym({ owner, gymId }) {
    const ids = ownerGymIdsOf(owner);
    if (!ids.includes(gymId)) return { error: 'not_your_gym', status: 403 };
    gyms.remove(g => g.id === gymId);
    const updatedGymIds = ids.filter(id => id !== gymId);
    await users.updateByIdAsync(owner.id, {
      gymIds: updatedGymIds,
      gymId: updatedGymIds[0] || null,
      onboardingCompleted: updatedGymIds.length > 0,
    });
    return { ok: true };
  }

  function updateTrainer({ owner, trainerId, body }) {
    const ownerGymIds = ownerGymIdsOf(owner);
    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return { error: 'trainer_not_found', status: 404 };
    const tGymIds = trainer.gymIds || [];
    if (!tGymIds.some(id => ownerGymIds.includes(id))) return { error: 'trainer_not_at_your_gym', status: 403 };
    const row = trainerService.normalizeTrainerPayload({ ...body, id: trainer.id, userId: trainer.userId, email: trainer.email }, trainer);
    trainers.upsert(t => t.id === row.id, row);
    return { trainer: trainerService.hydrateTrainer(row) };
  }

  async function createTrainer({ owner, body }) {
    const gymId = String(body.gymId || body.gymIds?.[0] || '');
    const ownerGymIds = ownerGymIdsOf(owner);
    if (!gymId) return { error: 'gym_required', status: 400 };
    if (!ownerGymIds.includes(gymId)) return { error: 'not_your_gym', status: 403 };
    const displayName = String(body.displayName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const initialPin = String(body.initialPin || '');
    if (!displayName) return { error: 'display_name_required', status: 400 };
    if (!email) return { error: 'email_required', status: 400 };
    if (!/^\d{4}$/.test(initialPin)) return { error: 'invalid_pin', status: 400 };
    if (await users.findAsync(u => String(u.email || '').toLowerCase() === email)) {
      return { error: 'email_already_used', status: 409 };
    }
    if (trainers.find(t => String(t.email || '').toLowerCase() === email)) {
      return { error: 'email_already_used', status: 409 };
    }

    const now = new Date().toISOString();
    const userId = `usr_${randomUUID().slice(0, 8)}`;
    const trainerId = `trn_${randomUUID().slice(0, 8)}`;
    const user = {
      id: userId, userType: 'trainer', email, phone: body.phone || null,
      displayName, passwordHash: `demo:${initialPin}`, accountStatus: 'active',
      approvalStatus: 'approved', onboardingCompleted: true, gymId, gymIds: [gymId],
      createdAt: now, updatedAt: now,
    };
    const trainer = trainerService.normalizeTrainerPayload({
      ...body, id: trainerId, userId, email, displayName, gymIds: [gymId],
      status: 'active', approvalStatus: 'approved',
    }, {});
    await users.upsertAsync(u => u.id === userId, user);
    await trainers.upsertAsync(t => t.id === trainerId, trainer);
    auditLog.insert({
      id: randomUUID(), at: now, actor: owner.id, action: 'trainer_created_by_owner',
      target: trainerId, before: null, after: trainer,
    });
    return { trainer: trainerService.hydrateTrainer(trainer) };
  }

  function removeTrainer({ owner, trainerId }) {
    const ownerGymIds = ownerGymIdsOf(owner);
    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return { error: 'trainer_not_found', status: 404 };
    const tGymIds = trainer.gymIds || [];
    const remainingGymIds = tGymIds.filter(id => !ownerGymIds.includes(id));
    trainers.update(t => t.id === trainer.id, { gymIds: remainingGymIds });
    return { ok: true };
  }

  function listTrainers({ owner, requestedGymId }) {
    const ownerGymIds = ownerGymIdsOf(owner);
    const scopeGymIds = requestedGymId && ownerGymIds.includes(requestedGymId) ? [requestedGymId] : ownerGymIds;
    return trainers.filter(t => (t.gymIds || []).some(id => scopeGymIds.includes(id))).map(trainerService.hydrateTrainer);
  }

  function pendingTrainers({ owner }) {
    const ownerGymIds = ownerGymIdsOf(owner);
    return trainers
      .filter(t => (t.pendingGymIds || []).some(id => ownerGymIds.includes(id)))
      .map(t => ({
        ...trainerService.hydrateTrainer(t),
        pendingGyms: (t.pendingGymIds || [])
          .filter(id => ownerGymIds.includes(id))
          .map(id => gyms.find(g => g.id === id))
          .filter(Boolean),
      }));
  }

  function decideTrainerJoin({ owner, trainerId, gymId, decision, actorId }) {
    const ownerGymIds = ownerGymIdsOf(owner);
    if (!gymId) return { error: 'gymId_required', status: 400 };
    if (!['approve', 'reject'].includes(decision)) return { error: 'invalid_decision', status: 400 };
    if (!ownerGymIds.includes(gymId)) return { error: 'not_your_gym', status: 403 };

    const trainer = trainers.find(t => t.id === trainerId);
    if (!trainer) return { error: 'trainer_not_found', status: 404 };
    const pendingGymIds = trainer.pendingGymIds || [];
    if (!pendingGymIds.includes(gymId)) return { error: 'no_pending_request_for_gym', status: 400 };

    const remainingPending = pendingGymIds.filter(id => id !== gymId);
    const patch = { pendingGymIds: remainingPending };
    if (decision === 'approve') {
      const gymIds = trainer.gymIds || [];
      patch.gymIds = gymIds.includes(gymId) ? gymIds : [...gymIds, gymId];
    }
    const updated = trainers.update(t => t.id === trainer.id, patch);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: decision === 'approve' ? 'trainer_join_approved' : 'trainer_join_rejected',
      target: trainer.id, before: { pendingGymIds }, after: patch,
    });
    return { trainer: trainerService.hydrateTrainer(updated) };
  }

  return {
    ownerGymIdsOf, syncTrainersForGym, registerOwner, myGyms, myInvoices, myEarnings, gymCheckIns,
    updateGym, createGym, deleteGym, createTrainer, updateTrainer, removeTrainer, listTrainers, pendingTrainers, decideTrainerJoin,
  };
}
