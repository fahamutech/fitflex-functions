// Admin gym-owner/operator management. List rows embed a lean gym REFERENCE
// only (id/name/tier — no thumbnail) since a single owner can be linked to
// many gyms and every embedded thumbnail multiplies payload size; the portal
// fetches the full gym (with image) on demand via GET /gyms/:id when needed.
import { randomUUID } from 'node:crypto';
import { normalizeEmail, sameEmail } from '../shared/identifiers.mjs';

export function createAdminOwnerService({ users, gyms, checkins, auditLog, gymService }) {
  /** Strip internal/sensitive fields from owner records for list responses. */
  function slimOwnerRow(row) {
    if (!row) return row;
    const { passwordHash, firebaseUid, aclPermissions, memberProfile, portalUser, onboardingCompleted, ...rest } = row;
    return rest;
  }

  function hydrateGymOwner(row) {
    const ids = row.gymIds || (row.gymId ? [row.gymId] : []);
    const linkedGyms = ids.map(id => gyms.find(g => g.id === id)).filter(Boolean).map(gymService.slimGymRef);
    return { ...slimOwnerRow(row), gymIds: ids, accountStatus: row.accountStatus || 'active', gym: linkedGyms[0] || null, gyms: linkedGyms };
  }

  async function list() {
    // Pushed-down SQL WHERE instead of loading + JS-filtering the entire
    // users table (this endpoint was previously the slowest owner-facing
    // list on the portal — a single indexed column lookup vs. scanning and
    // JSON-round-tripping every user row on every request).
    const allOwners = await users.filterByColumnAsync('userType', 'gym_operator');
    return allOwners
      .map(hydrateGymOwner)
      .sort((a, b) => String(a.displayName || a.email || '').localeCompare(String(b.displayName || b.email || '')));
  }

  /**
   * Lightweight reference list — just enough to render an owner-select
   * dropdown and map gym -> owner (id/displayName/email/gymIds). Used by
   * pages (like the gyms table) that only need owner *names*, not full
   * profiles, to avoid pulling the full ~200KB owner payload.
   */
  async function listRefs() {
    const allOwners = await users.filterByColumnAsync('userType', 'gym_operator');
    return allOwners
      .map(row => ({
        id: row.id,
        displayName: row.displayName || null,
        email: row.email || null,
        gymId: row.gymId || null,
        gymIds: row.gymIds || (row.gymId ? [row.gymId] : []),
      }))
      .sort((a, b) => String(a.displayName || a.email || '').localeCompare(String(b.displayName || b.email || '')));
  }

  async function upsert({ body, actorId }) {
    if (!body.id && !body.email) return { error: 'email_required', status: 400 };
    if (body.gymId && !gyms.find(g => g.id === body.gymId)) return { error: 'gym_not_found', status: 400 };
    const id = body.id || `usr_${randomUUID().slice(0, 8)}`;
    const prior = await users.findByIdAsync(id);
    const email = normalizeEmail(body.email);
    const duplicateEmail = email && await users.findAsync(
      u => sameEmail(u.email, email) && u.userType === 'gym_operator' && u.id !== id,
    );
    if (duplicateEmail) return { error: 'email_already_used', status: 409, existingRole: duplicateEmail.userType };

    const gymIds = Array.isArray(body.gymIds) ? body.gymIds : (prior?.gymIds || (body.gymId ? [body.gymId] : (prior?.gymId ? [prior.gymId] : [])));
    const row = {
      id,
      userType: 'gym_operator',
      email: email ?? prior?.email,
      displayName: body.displayName ?? prior?.displayName ?? null,
      phone: body.phone ?? prior?.phone ?? null,
      photoUrl: body.photoUrl ?? prior?.photoUrl ?? null,
      gymId: gymIds[0] || body.gymId || prior?.gymId || null,
      gymIds,
      onboardingCompleted: body.onboardingCompleted ?? prior?.onboardingCompleted ?? false,
      accountStatus: body.accountStatus ?? prior?.accountStatus ?? 'active',
      approvalStatus: body.approvalStatus ?? prior?.approvalStatus ?? 'approved',
      createdAt: prior?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await users.upsertAsync(u => u.id === id, row);
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: prior ? 'gym_owner_updated' : 'gym_owner_created',
      target: id, before: prior ?? null, after: row
    });
    return { created: !prior, owner: hydrateGymOwner(row) };
  }

  async function remove({ id, actorId }) {
    const prior = await users.findAsync(u => u.id === id && u.userType === 'gym_operator');
    if (!prior) return { error: 'not_found', status: 404 };
    if (prior.gymId && await checkins.findAsync(c => c.gymId === prior.gymId)) return { error: 'gym_owner_has_checkin_activity', status: 409 };
    const removed = await users.removeAsync(u => u.id === prior.id);
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'gym_owner_deleted',
      target: prior.id, before: prior, after: null
    });
    return { owner: removed };
  }

  return { hydrateGymOwner, list, listRefs, upsert, remove };
}
