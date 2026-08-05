// Owner member management REST surface (direct + FitFlex roaming members).
import '../src/bootstrap/init.mjs';
import { randomUUID } from 'node:crypto';
import { requireAuth, requireGymAcl } from '../src/auth/jwt.mjs';
import { memberManagement, resolveRequestUser, auditLog } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const ownerCreateMember = {
  created, method: 'post', path: '/owner/members',
  description: 'Owner: register a new member under their gym with payment info and create a gym-linked subscription.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await memberManagement.createMember({ owner, body: req.body || {} });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });

    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: 'owner_created_member',
      target: result.member.id, before: null,
      after: { email: result.member.email, gymId: result.subscription.homeGymId },
    });

    res.status(201).json({ member: result.member, subscription: result.subscription, payment: result.payment });
  }
};

export const ownerListMembers = {
  created, method: 'get', path: '/owner/members',
  description: 'Owner: list direct + FitFlex roaming members across owned gyms with stats and filters (memberType, status, search, gymId).',
  responseSample: {
    members: [{ id: 'usr_x', publicId: 'FM001', displayName: 'Amina Said', memberType: 'direct', tier: 'premium', status: 'active' }],
    stats: { totalMembers: 128, activeToday: 24, expiringSoon: 8 },
  },
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    res.json(await memberManagement.listMembers({ owner, query: req.query || {} }));
  }
};

export const ownerMemberDetail = {
  created, method: 'get', path: '/owner/members/:memberId',
  description: 'Owner: member details — profile, check-in summary, membership plan, recent check-ins and payment history.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await memberManagement.getMemberDetail({ owner, memberId: req.params.memberId });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result.detail);
  }
};

export const ownerMemberCheckInSummary = {
  created, method: 'get', path: '/owner/members/:memberId/checkin-summary',
  description: 'Owner: member check-in summary (visits/lastCheckin/streak) for a period preset (week|month|year) or a custom from/to range.',
  responseSample: { period: 'month', from: '2026-06-01T00:00:00.000Z', to: null, visits: 12, lastCheckinAt: '2026-06-27T08:30:00.000Z', streakDays: 4 },
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const q = req.query || {};
    const result = await memberManagement.getCheckInSummary({
      owner, memberId: req.params.memberId, period: q.period, from: q.from, to: q.to,
    });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result.summary);
  }
};

export const ownerMemberCheckins = {
  created, method: 'get', path: '/owner/members/:memberId/checkins',
  description: 'Owner: paginated member check-in history with optional from/to date range and search. Query: cursor (offset), limit, from, to, search.',
  responseSample: { items: [{ id: 'ci_1', timestamp: '2026-06-27T08:30:00.000Z', gymId: 'gym_1', gymName: 'Vik100 Gym' }], total: 42, nextCursor: 20 },
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await memberManagement.listMemberCheckins({ owner, memberId: req.params.memberId, query: req.query || {} });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  }
};

export const ownerMemberPayments = {
  created, method: 'get', path: '/owner/members/:memberId/payments',
  description: 'Owner: paginated member payment history with optional from/to date range and search. Query: cursor (offset), limit, from, to, search.',
  responseSample: { items: [{ id: 'pay_1', amountTzs: 180000, tier: 'premium', status: 'approved', requestedAt: '2026-01-12T00:00:00.000Z' }], total: 6, nextCursor: 20 },
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await memberManagement.listMemberPayments({ owner, memberId: req.params.memberId, query: req.query || {} });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  }
};

export const ownerCheckInMember = {
  created, method: 'post', path: '/owner/members/:memberId/checkin',
  description: 'Owner: manually check a member in at one of their gyms.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('checkins')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await memberManagement.checkInMember({ owner, memberId: req.params.memberId, gymId: req.body?.gymId });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  }
};

export const ownerRenewMember = {
  created, method: 'post', path: '/owner/members/:memberId/renew',
  description: 'Owner: renew/extend a member subscription and record the payment.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await memberManagement.renewMember({ owner, memberId: req.params.memberId, body: req.body || {} });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  }
};

export const ownerUpdateMember = {
  created, method: 'patch', path: '/owner/members/:memberId',
  description: 'Owner: update a direct member profile fields (displayName, phone, tier).',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await memberManagement.updateMember({ owner, memberId: req.params.memberId, body: req.body || {} });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  }
};

export const ownerSuspendMember = {
  created, method: 'post', path: '/owner/members/:memberId/suspend',
  description: 'Owner: suspend or reactivate a member (body { suspend: true|false }).',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('members')],
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const suspend = req.body?.suspend !== false;
    const result = await memberManagement.setMemberStatus({ owner, memberId: req.params.memberId, suspend });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  }
};
