// Challenge engine REST surface. Members see and join challenges; FitFlex
// (admin), trainers, gyms (owner/staff) and corporate HR create them.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireGymAcl } from '../src/auth/jwt.mjs';
import {
  challengeService as svc, corporateService, resolveRequestUser, trainers,
} from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

function send(res, result, ok = 200) {
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(ok).json(result);
}

// ── Member ──────────────────────────────────────────────────────────────────

export const myChallenges = {
  created, method: 'get', path: '/me/challenges',
  description: 'Member: challenges they joined, and ones they can join that have not ended.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.memberChallenges(req.user.sub))
};

export const challengeDetail = {
  created, method: 'get', path: '/challenges/:id',
  description: 'Member: one challenge they can see or have joined.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.memberChallenge(req.user.sub, req.params.id))
};

export const joinChallenge = {
  created, method: 'post', path: '/challenges/:id/join',
  description: 'Member: join a challenge that has not ended. { teamId? (teams mode), gymId? (gym vs gym), leaderboardOptIn? (default false) }',
  requestSample: { leaderboardOptIn: false },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.join(req.user.sub, req.params.id, req.body || {}))
};

export const challengeLeaderboardOptIn = {
  created, method: 'put', path: '/challenges/:id/leaderboard-opt-in',
  description: 'Member: choose whether to appear in this challenge\'s ranking. { optIn: true|false }',
  requestSample: { optIn: true },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.setLeaderboardOptIn(req.user.sub, req.params.id, req.body || {}))
};

export const challengeLeaderboard = {
  created, method: 'get', path: '/challenges/:id/leaderboard',
  description: 'Participant: opted-in ranking, where you would place, and team standings (teams of 3+).',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.leaderboard({ memberId: req.user.sub }, req.params.id))
};

export const leaveChallenge = {
  created, method: 'post', path: '/challenges/:id/leave',
  description: 'Member: leave a challenge.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => send(res, await svc.leave(req.user.sub, req.params.id))
};

// ── Creators ────────────────────────────────────────────────────────────────
// Each resolver returns { creatorType, creatorId, createdBy } or an error.

const CREATE_SAMPLE = {
  name: '50K Step Challenge', description: 'Walk 50,000 steps in two weeks.', type: 'steps',
  target: 50000, startDate: '2026-10-01', endDate: '2026-10-14', rewards: ['Finisher badge'], visibility: 'audience',
};

async function trainerCreator(req) {
  const t = await trainers.findAsync(x => x.userId === req.user.sub);
  return t ? { creatorType: 'trainer', creatorId: t.id, createdBy: req.user.sub } : { error: 'trainer_profile_not_found', status: 404 };
}

async function gymCreator(req, gymId) {
  const owner = await resolveRequestUser(req);
  const mine = owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);
  const id = gymId || (mine.length === 1 ? mine[0] : null);
  if (!id) return { error: 'gymId_required', status: 400 };
  if (!mine.includes(id)) return { error: 'not_your_gym', status: 403 };
  return { creatorType: 'gym', creatorId: id, createdBy: req.user.sub };
}

async function corporateCreator(req) {
  const actor = await corporateService.resolveActorAccount({
    userId: req.user.sub, userType: req.user.userType, corporateIdParam: req.query?.corporateId,
  });
  return actor.error ? actor : { creatorType: 'corporate', creatorId: actor.corporateId, createdBy: req.user.sub };
}

const fitflexCreator = async req => ({ creatorType: 'fitflex', creatorId: null, createdBy: req.user.sub });

/** list / create / cancel / participants for one creator kind. */
function creatorRoutes(prefix, guard, resolve, label) {
  const withCreator = handler => async (req, res) => {
    const creator = await resolve(req, req.body?.gymId ?? req.query?.gymId);
    if (creator.error) return res.status(creator.status).json({ error: creator.error });
    return handler(creator, req, res);
  };
  return {
    leaderboard: {
      created, method: 'get', path: `${prefix}/challenges/:id/leaderboard`,
      description: `${label}: the opt-in ranking and team standings for a challenge you created.`,
      onGuard: guard,
      onRequest: withCreator(async (creator, req, res) => send(res, await svc.leaderboard(creator, req.params.id))),
    },
    list: {
      created, method: 'get', path: `${prefix}/challenges`,
      description: `${label}: challenges you created.`,
      onGuard: guard,
      onRequest: withCreator(async (creator, req, res) => send(res, await svc.creatorList(creator))),
    },
    create: {
      created, method: 'post', path: `${prefix}/challenges`,
      description: `${label}: create a challenge. type steps|distance_km|workouts|active_minutes|consistency|gym_attendance; mode individual|teams (with teams: [names])${label === 'FitFlex admin' ? '|gym_vs_gym' : ''}${label === 'Corporate HR' ? '|department' : ''}.`,
      requestSample: CREATE_SAMPLE,
      onGuard: guard,
      onRequest: withCreator(async (creator, req, res) => send(res, await svc.create(creator, req.body || {}), 201)),
    },
    cancel: {
      created, method: 'post', path: `${prefix}/challenges/:id/cancel`,
      description: `${label}: cancel a challenge you created.`,
      onGuard: guard,
      onRequest: withCreator(async (creator, req, res) => send(res, await svc.cancel(creator, req.params.id))),
    },
    participants: {
      created, method: 'get', path: `${prefix}/challenges/:id/participants`,
      description: `${label}: who joined. ${label === 'Trainer' || label === 'Gym' ? 'Progress only for members who share challenge data with you.' : 'Totals only — never individuals.'}`,
      onGuard: guard,
      onRequest: withCreator(async (creator, req, res) => send(res, await svc.creatorParticipants(creator, req.params.id))),
    },
  };
}

const trainerR = creatorRoutes('/trainer', requireAuth('trainer'), trainerCreator, 'Trainer');
export const trainerChallenges = trainerR.list;
export const trainerCreateChallenge = trainerR.create;
export const trainerCancelChallenge = trainerR.cancel;
export const trainerChallengeParticipants = trainerR.participants;
export const trainerChallengeLeaderboard = trainerR.leaderboard;

const gymR = creatorRoutes('/owner', [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')], gymCreator, 'Gym');
export const ownerChallenges = gymR.list;
export const ownerCreateChallenge = gymR.create;
export const ownerCancelChallenge = gymR.cancel;
export const ownerChallengeParticipants = gymR.participants;
export const ownerChallengeLeaderboard = gymR.leaderboard;

const adminR = creatorRoutes('/admin', requireAuth('admin'), fitflexCreator, 'FitFlex admin');
export const adminChallenges = adminR.list;
export const adminCreateChallenge = adminR.create;
export const adminCancelChallenge = adminR.cancel;
export const adminChallengeParticipants = adminR.participants;
export const adminChallengeLeaderboard = adminR.leaderboard;

const corpR = creatorRoutes('/corporate', requireAuth('corporate_hr', 'admin'), corporateCreator, 'Corporate HR');
export const corporateChallenges = corpR.list;
export const corporateCreateChallenge = corpR.create;
export const corporateCancelChallenge = corpR.cancel;
export const corporateChallengeParticipants = corpR.participants;
export const corporateChallengeLeaderboard = corpR.leaderboard;
