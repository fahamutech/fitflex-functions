// Gym staff roster (RBAC) REST surface — owners create receptionists etc.
// scoped to their own gym(s) with a per-feature ACL. Staff log in the same
// way as owner-created trainers used to: the owner sets email + PIN directly
// via Firebase Admin so the staff member can sign in immediately.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { requireGymOwner, effectiveOperator } from '../src/auth/org-authz.mjs';
import { identityFlag, staffPinChangeRequiredOn } from '../src/shared/feature-flags.mjs';
import { ownerStaffService, resolveRequestUser } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const CREDENTIALS_NOT_ACCEPTED = {
  error: 'credentials_not_accepted',
  message: 'Staff are now invited instead of being given a PIN. Update the app and use Invite.',
  use: 'POST /orgs/gym/:gymId/invitations',
};
const ownerGymIdsOf = (owner) => owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);

export const ownerListStaff = {
  created, method: 'get', path: '/owner/staff',
  description: 'Owner: list gym staff (e.g. receptionists) they have created for their gym(s).',
  onGuard: [requireAuth('gym_operator'), requireGymOwner('GET /owner/staff')],
  onRequest: async (req, res) => {
    const owner = effectiveOperator(req, await resolveRequestUser(req));
    res.json(await ownerStaffService.list(ownerGymIdsOf(owner)));
  }
};

export const ownerCreateStaff = {
  created, method: 'post', path: '/owner/staff',
  description: 'Owner: create a gym staff account (e.g. receptionist) with a PIN and a subset of RBAC permissions, scoped to one or more of their gyms.',
  onGuard: [requireAuth('gym_operator'), requireGymOwner('POST /owner/staff')],
  onRequest: async (req, res) => {
    // With invitations on, an organisation no longer sets a person's credentials.
    if (identityFlag('V2_INVITES')) return res.status(400).json(CREDENTIALS_NOT_ACCEPTED);
    const owner = effectiveOperator(req, await resolveRequestUser(req));
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await ownerStaffService.create({ ownerGymIds: ownerGymIdsOf(owner), body: req.body || {}, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error, ...(result.invalid ? { invalid: result.invalid } : {}), ...(result.detail ? { detail: result.detail } : {}) });
    res.status(201).json(result.staff);
  }
};

export const ownerUpdateStaff = {
  created, method: 'put', path: '/owner/staff/:id',
  description: 'Owner: update a gym staff member\u2019s permissions, gym assignment, name or status.',
  onGuard: [requireAuth('gym_operator'), requireGymOwner('PUT /owner/staff/:id')],
  onRequest: async (req, res) => {
    const owner = effectiveOperator(req, await resolveRequestUser(req));
    const result = await ownerStaffService.update({ ownerGymIds: ownerGymIdsOf(owner), staffId: req.params.id, body: req.body || {}, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error, ...(result.invalid ? { invalid: result.invalid } : {}) });
    res.json(result.staff);
  }
};

export const ownerRemoveStaff = {
  created, method: 'post', path: '/owner/staff/:id/remove',
  description: 'Owner: remove a gym staff account entirely (Firebase + database record).',
  onGuard: [requireAuth('gym_operator'), requireGymOwner('POST /owner/staff/:id/remove')],
  onRequest: async (req, res) => {
    const owner = effectiveOperator(req, await resolveRequestUser(req));
    const result = await ownerStaffService.remove({ ownerGymIds: ownerGymIdsOf(owner), staffId: req.params.id, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  }
};

export const ownerResetStaffPin = {
  created, method: 'post', path: '/owner/staff/:id/pin',
  description: 'Owner: give a gym staff member a new start PIN (they forgot theirs). Body { pin } (exactly 4 digits). Signs the staff member out everywhere; at their next sign-in they must choose their own PIN (POST /auth/pin/change) before anything else. Returns the staff row with passwordChangeRequired: true. 400 pin_must_be_4_digits; 403 staff_not_at_your_gym; 404 staff_not_found; 409 staff_identity_shared (the staff profile signs in with the person\u2019s own account, e.g. joined by invitation: they use Forgot PIN instead); 502 firebase_update_failed (the staff member is signed out and still held, the old PIN unchanged). 404 feature_disabled while STAFF_PIN_CHANGE_REQUIRED is off; 400 credentials_not_accepted while invitations (V2_INVITES) are on.',
  requestSample: { pin: '4821' },
  onGuard: [requireAuth('gym_operator'), requireGymOwner('POST /owner/staff/:id/pin')],
  onRequest: async (req, res) => {
    if (!staffPinChangeRequiredOn()) return res.status(404).json({ error: 'feature_disabled' });
    // With invitations on, an organisation no longer sets a person's credentials (as create).
    if (identityFlag('V2_INVITES')) return res.status(400).json(CREDENTIALS_NOT_ACCEPTED);
    const owner = effectiveOperator(req, await resolveRequestUser(req));
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await ownerStaffService.resetPin({ ownerGymIds: ownerGymIdsOf(owner), staffId: req.params.id, body: req.body || {}, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.staff);
  }
};
