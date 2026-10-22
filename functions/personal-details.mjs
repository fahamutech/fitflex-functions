// Partner date of birth · slice 2 (docs/partner-dob-api.md): a person's own date of birth and gender.
//   GET/PUT /me/personal-details                       — the signed-in person
//   GET /admin/trainers/:id/personal-details           — admin, view only (ACL scope `trainers`)
//   GET /admin/gym-owners/:id/personal-details         — admin, view only (ACL scope `owners`)
// All of it answers 404 feature_disabled until PARTNER_DOB_REQUIRED is set.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { partnerDobRequiredOn } from '../src/shared/feature-flags.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { personalDetailsService, resolveRequestUser } from '../src/bootstrap/services.mjs';
import { users, trainers } from '../src/bootstrap/collections.mjs';

const created = new Date().toISOString();

// A form saved a handful of times at most; per person (user id), in memory per server.
export const PERSONAL_DETAILS_WRITES_PER_MINUTE = 10;
const writes = createVendorLimiter({ perMinute: PERSONAL_DETAILS_WRITES_PER_MINUTE });
/** Specs only. */
export const resetPersonalDetailsLimits = () => writes.reset();

const off = res => res.status(404).json({ error: 'feature_disabled' });
const fail = (res, r) => res.status(r.status ?? 400).json({ error: r.error, ...(r.field ? { field: r.field } : {}) });

export const getMyPersonalDetails = {
  created, method: 'get', path: '/me/personal-details',
  description: 'Signed-in person: my date of birth and gender → { dateOfBirth ("YYYY-MM-DD"|null), gender (male|female|other|null), source ("person"|"member"|null), ask, required, genderFrom ("trainer_profile"|"person"|null) }. The date of birth given here (on the Person) wins over a member-profile one. ask: holds a trainer or gym-owner role and has no valid date of birth. Needs PARTNER_DOB_REQUIRED (else 404 feature_disabled).',
  onGuard: routeGuard('get', requireAuth()),
  onRequest: async (req, res) => {
    if (!partnerDobRequiredOn()) return off(res);
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    res.json(await personalDetailsService.mine(user));
  }
};

export const putMyPersonalDetails = {
  created, method: 'put', path: '/me/personal-details',
  description: 'Signed-in person: save my date of birth and/or gender { dateOfBirth?, gender? }. dateOfBirth: "YYYY-MM-DD", a real date from 1901-01-01 to today (East Africa day); null or left out keeps it, "" clears it; else 400 { error: "invalid_field", field: "dateOfBirth" }. gender: male | female | other; null or "" = not given ("prefer not to say"); left out keeps it; else 400 { error: "invalid_field", field: "gender" }. A person holding a trainer or gym-owner role must be 18 or older: 400 { error: "partner_under_18" }. 429 rate_limited { retryAfterSeconds }. Answers the same body as GET. Needs PARTNER_DOB_REQUIRED.',
  requestSample: { dateOfBirth: '1994-03-21', gender: 'female' },
  onGuard: routeGuard('put', requireAuth()),
  onRequest: async (req, res) => {
    if (!partnerDobRequiredOn()) return off(res);
    const user = await resolveRequestUser(req);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (limitOrNull(writes, user.id, res)) return;
    const result = await personalDetailsService.update({ user, body: req.body || {} });
    if (result.error) return fail(res, result);
    res.json(result);
  }
};

export const adminTrainerPersonalDetails = {
  created, method: 'get', path: '/admin/trainers/:id/personal-details',
  description: 'Admin, view only: the date of birth a trainer gave (never KYC). :id is the trainer profile id (as in DELETE /admin/trainers/:id). → { trainerId, userId, personalDetails: { dateOfBirth, age, gender, genderFrom, source } }. Each view is audit-logged (personal_details_viewed, no values). ACL scope `trainers`. Needs PARTNER_DOB_REQUIRED.',
  onGuard: routeGuard('get', [requireAuth('admin'), requireAcl('trainers')]),
  onRequest: async (req, res) => {
    if (!partnerDobRequiredOn()) return off(res);
    const profile = await trainers.findAsync(t => t.id === req.params.id);
    if (!profile) return res.status(404).json({ error: 'not_found' });
    const personalDetails = await personalDetailsService.adminView({
      userId: profile.userId || null, actorId: req.user?.sub, subject: { type: 'trainer', id: profile.id },
    });
    res.json({ trainerId: profile.id, userId: profile.userId || null, personalDetails });
  }
};

export const adminGymOwnerPersonalDetails = {
  created, method: 'get', path: '/admin/gym-owners/:id/personal-details',
  description: 'Admin, view only: the date of birth and gender a gym owner gave (never KYC). :id is the owner user id (as in DELETE /admin/gym-owners/:id). → { ownerId, personalDetails: { dateOfBirth, age, gender, genderFrom, source } }. Each view is audit-logged (personal_details_viewed, no values). ACL scope `owners`. Needs PARTNER_DOB_REQUIRED.',
  onGuard: routeGuard('get', [requireAuth('admin'), requireAcl('owners')]),
  onRequest: async (req, res) => {
    if (!partnerDobRequiredOn()) return off(res);
    const owner = await users.findByIdAsync(req.params.id);
    if (!owner || owner.userType !== 'gym_operator') return res.status(404).json({ error: 'not_found' });
    const personalDetails = await personalDetailsService.adminView({
      userId: owner.id, actorId: req.user?.sub, subject: { type: 'gym_owner', id: owner.id },
    });
    res.json({ ownerId: owner.id, personalDetails });
  }
};
