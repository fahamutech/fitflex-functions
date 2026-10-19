// Gym ↔ member activity sharing. Gyms always see their own check-in
// records and visit patterns; class attendance, gym workouts and challenge
// progress are shared by default, and the member can switch each off per gym.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireGymAcl } from '../src/auth/jwt.mjs';
import { requireGymAccess } from '../src/auth/org-authz.mjs';
import { gymSharingService as svc, resolveRequestUser } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

function send(res, result) {
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
}

export const myGymSharing = {
  created, method: 'get', path: '/me/gym-sharing',
  description: 'Member: gyms they belong to or visit, and what each can see beyond check-ins.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.memberSharing(req.user.sub))
};

export const updateMyGymSharing = {
  created, method: 'put', path: '/me/gym-sharing/:gymId',
  description: 'Member: set what a gym can see. { permissions: { classAttendance, gymWorkouts, challenges } } — keys left out keep their value; a gym the member never changed has all three on.',
  requestSample: { permissions: { classAttendance: true } },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.updateMemberSharing(req.user.sub, req.params.gymId, req.body || {}))
};

export const ownerMemberActivity = {
  created, method: 'get', path: '/owner/members/:memberId/activity',
  description: 'Owner/staff: per managed gym, the member\'s visit patterns and only the activity they share with that gym.',
  // requireGymAccess keeps what this route always had in effect: under V2_ORG_AUTHZ enforce it also
  // needs an active `members` membership (until #199 that came from owner-members' guard leaking
  // onto this sub-path). With org-authz off it decides exactly as requireGymAcl('members').
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members'), requireGymAccess('members', 'GET /owner/members/:memberId/activity')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    send(res, await svc.ownerMemberActivity(owner, req.params.memberId));
  }
};

export const ownerEngagement = {
  created, method: 'get', path: '/owner/engagement',
  description: 'Owner/staff: membership engagement from check-ins — active, slipping, at risk, lapsed, new this month, and who to check in with. Optional ?gymId.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    send(res, await svc.ownerEngagement(owner, req.query?.gymId || null));
  }
};
