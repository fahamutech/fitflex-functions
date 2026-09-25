// Trainer service — catalogue CRUD, self-service profile + gym applications.
import { randomUUID } from 'node:crypto';
import { parseStringList } from '../shared/parse-list.mjs';

export function createTrainerService({ trainers, gyms, trainerBookings, auditLog, gymService }) {
  function normalizeTrainerPayload(body = {}, prior = {}) {
    const gymIds = parseStringList(body.gymIds, prior.gymIds || []);
    const pendingGymIds = parseStringList(body.pendingGymIds, prior.pendingGymIds || []);
    const specialties = parseStringList(body.specialties, prior.specialties || []);
    const images = parseStringList(body.images, prior.images || (prior.photoUrl ? [prior.photoUrl] : []));
    const imageThumbnails = parseStringList(body.imageThumbnails, prior.imageThumbnails || []);
    return {
      id: body.id || prior.id || `trn_${randomUUID().slice(0, 8)}`,
      userId: body.userId ?? prior.userId ?? null,
      email: body.email ?? prior.email ?? null,
      phone: body.phone ?? prior.phone ?? null,
      displayName: body.displayName ?? prior.displayName,
      photoUrl: body.photoUrl ?? images[0] ?? prior.photoUrl ?? null,
      images,
      imageThumbnails,
      gender: body.gender ?? prior.gender ?? null,
      specialties,
      bio: body.bio ?? prior.bio ?? '',
      rating: Number(body.rating ?? prior.rating ?? 0),
      reviewCount: Number(body.reviewCount ?? prior.reviewCount ?? 0),
      hourlyRateTzs: Number(body.hourlyRateTzs ?? prior.hourlyRateTzs ?? 0),
      sessionRateCurrency: body.sessionRateCurrency ?? prior.sessionRateCurrency ?? 'TZS',
      experienceYears: Number(body.experienceYears ?? prior.experienceYears ?? 0),
      gymIds,
      pendingGymIds,
      status: ['active', 'inactive', 'suspended'].includes(body.status) ? body.status : (prior.status ?? 'active'),
      approvalStatus: body.approvalStatus ?? prior.approvalStatus ?? 'approved',
      verified: typeof body.verified === 'boolean'
        ? body.verified
        : (prior.verified ?? false),
      homepageVisible: typeof body.homepageVisible === 'boolean'
        ? body.homepageVisible
        : (prior.homepageVisible ?? true),
      homepagePriority: Number(body.homepagePriority ?? prior.homepagePriority ?? 0),
      availability: Array.isArray(body.availability) ? body.availability : (prior.availability || []),
      createdAt: prior.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  function hydrateTrainer(row) {
    const linkedGyms = (row.gymIds || [])
      .map(id => gyms.find(g => g.id === id))
      .filter(Boolean)
      .map(gymService.slimGym);
    const pendingGyms = (row.pendingGymIds || [])
      .map(id => gyms.find(g => g.id === id))
      .filter(Boolean)
      .map(gymService.slimGym);
    return { ...row, gyms: linkedGyms, pendingGyms };
  }

  function findProfileByUser(userId) {
    return trainers.find(t => t.userId === userId || t.id === userId) || null;
  }

  function list({ q, specialty }) {
    const query = String(q || '').toLowerCase();
    const spec = String(specialty || '').toLowerCase();
    return trainers
      .filter(t => (t.status === 'active' || t.status === 'inactive') && t.homepageVisible !== false)
      .filter(t => !query || t.displayName.toLowerCase().includes(query) || t.specialties.join(' ').toLowerCase().includes(query))
      .filter(t => !spec || t.specialties.some(s => s.toLowerCase().includes(spec)))
      .map(hydrateTrainer)
      .sort((a, b) => Number(b.homepagePriority || 0) - Number(a.homepagePriority || 0));
  }

  function getActive(id) {
    const trainer = trainers.find(t => t.id === id && t.status === 'active');
    return trainer ? hydrateTrainer(trainer) : null;
  }

  /** Admin list uses slimGymRef (id/name/tier only) for embedded gyms to keep payload lean. */
  function adminList() {
    return trainers.all().map(row => {
      const linkedGyms = (row.gymIds || [])
        .map(id => gyms.find(g => g.id === id))
        .filter(Boolean)
        .map(gymService.slimGymRef);
      const pendingGyms = (row.pendingGymIds || [])
        .map(id => gyms.find(g => g.id === id))
        .filter(Boolean)
        .map(gymService.slimGymRef);
      return { ...row, gyms: linkedGyms, pendingGyms };
    }).sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')));
  }

  /**
   * Lightweight reference list — just enough to render a trainer-select
   * dropdown and resolve gym assignments (id/displayName/email/gymIds).
   * Used by pages (like the gyms table) that only need trainer *names* and
   * gym links, not full profiles (specialties, bio, availability, etc.).
   */
  function adminListRefs() {
    return trainers.all()
      .map(row => ({
        id: row.id,
        displayName: row.displayName || null,
        email: row.email || null,
        gymIds: row.gymIds || [],
      }))
      .sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')));
  }

  async function adminUpsert({ body, actorId }) {
    if (!body?.id && !body?.displayName) return { error: 'displayName_required', status: 400 };
    const id = body.id || `trn_${randomUUID().slice(0, 8)}`;
    const prior = trainers.find(t => t.id === id);
    const duplicateEmail = body.email && trainers.find(t => t.email === body.email && t.id !== id);
    if (duplicateEmail) return { error: 'email_already_used', status: 409 };
    const row = normalizeTrainerPayload({ ...body, id }, prior || {});
    await trainers.upsertAsync(t => t.id === id, row);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: prior ? 'trainer_updated' : 'trainer_created',
      target: id, before: prior ?? null, after: row
    });
    return { trainer: row, created: !prior };
  }

  async function adminRemove({ id, actorId }) {
    const prior = trainers.find(t => t.id === id);
    if (!prior) return { error: 'not_found', status: 404 };
    if (await trainerBookings.findAsync(b => b.trainerId === prior.id)) return { error: 'trainer_has_bookings', status: 409 };
    const removed = trainers.remove(t => t.id === prior.id);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'trainer_deleted',
      target: prior.id, before: prior, after: null
    });
    return { trainer: removed };
  }

  async function register({ userId, user, body }) {
    if (!body.photoUrl) return { error: 'photoUrl_required', status: 400 };
    const validGenders = ['male', 'female', 'other'];
    if (!body.gender || !validGenders.includes(body.gender)) {
      return { error: 'gender_required', status: 400, validValues: validGenders };
    }
    const profile = findProfileByUser(userId);
    const row = normalizeTrainerPayload({
      ...body,
      id: profile?.id || undefined,
      userId,
      email: user.email,
      displayName: body.displayName || user.displayName,
      photoUrl: body.photoUrl || user.photoUrl,
      status: 'active',
      approvalStatus: 'pending_approval',
    }, profile || {});
    await trainers.upsertAsync(t => t.id === row.id, row);
    return { trainer: hydrateTrainer(row), displayName: body.displayName || user.displayName };
  }

  function myProfile(userId) {
    const profile = findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    return { trainer: hydrateTrainer(profile) };
  }

  function applyToGym({ userId, gymId }) {
    const profile = findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const gym = gyms.find(g => g.id === gymId && g.status === 'active');
    if (!gym) return { error: 'gym_not_found', status: 404 };
    const gymIds = profile.gymIds || [];
    if (gymIds.includes(gym.id)) return { error: 'already_linked_to_gym', status: 409 };
    const pendingGymIds = profile.pendingGymIds || [];
    if (pendingGymIds.includes(gym.id)) return { error: 'application_already_pending', status: 409 };
    const updated = trainers.update(t => t.id === profile.id, { pendingGymIds: [...pendingGymIds, gym.id] });
    return { trainer: hydrateTrainer(updated) };
  }

  function cancelGymApplication({ userId, gymId }) {
    const profile = findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const pendingGymIds = profile.pendingGymIds || [];
    if (!pendingGymIds.includes(gymId)) return { error: 'no_pending_request_for_gym', status: 400 };
    const updated = trainers.update(t => t.id === profile.id, {
      pendingGymIds: pendingGymIds.filter(id => id !== gymId),
    });
    return { trainer: hydrateTrainer(updated) };
  }

  function updateProfile({ userId, body }) {
    const profile = findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const allowed = [
      'bio',
      'specialties',
      'hourlyRateTzs',
      'sessionRateCurrency',
      'experienceYears',
      'availability',
      'photoUrl',
      'images',
      'imageThumbnails',
    ];
    const updates = {};
    for (const k of allowed) {
      if (body[k] !== undefined) updates[k] = body[k];
    }
    if (body.specialties) updates.specialties = parseStringList(body.specialties, profile.specialties);
    updates.updatedAt = new Date().toISOString();
    const updated = trainers.update(t => t.id === profile.id, updates);
    return { trainer: hydrateTrainer(updated) };
  }

  return {
    normalizeTrainerPayload,
    hydrateTrainer,
    parseStringList,
    findProfileByUser,
    list,
    getActive,
    adminList,
    adminListRefs,
    adminUpsert,
    adminRemove,
    register,
    myProfile,
    applyToGym,
    cancelGymApplication,
    updateProfile,
  };
}
