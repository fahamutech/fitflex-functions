// QR check-in REST surface — member QR issuance + operator scan/verify/dashboard.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireGymAcl, requireAcl } from '../src/auth/jwt.mjs';
import { operatorService, resolveRequestUser } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const myQr = {
  created, method: 'get', path: '/me/qr',
  description: 'Issue a 60-second rotating QR token for the authenticated member.',
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await operatorService.issueMemberQr(req.user.sub);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.qr);
  }
};

export const memberScanGymQr = {
  created, method: 'post', path: '/me/checkins/scan',
  description: 'Member scans the static QR at the gym entrance (member-scans-gym mode). POST { gymQr } → same BL-012 result as a staff scan.',
  requestSample: { gymQr: 'fitflex:gym:gym_001:signature' },
  onGuard: requireAuth('member'),
  onRequest: async (req, res) => {
    const result = await operatorService.memberScanGym({ memberId: req.user.sub, gymQr: req.body?.gymQr });
    res.status(result.status).json(result.body);
  }
};

export const operatorGymEntranceQr = {
  created, method: 'get', path: '/operator/gyms/:gymId/entrance-qr',
  description: 'Owner/staff: the printable static QR for a gym they manage, for member self check-in.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('checkins')],
  onRequest: async (req, res) => {
    const operator = await resolveRequestUser(req);
    const result = operatorService.gymEntranceQr({ operator, gymId: req.params.gymId });
    res.status(result.status).json(result.body);
  }
};

export const adminGymEntranceQr = {
  created, method: 'get', path: '/admin/gyms/:gymId/entrance-qr',
  description: 'Admin: the printable static QR for any gym.',
  onGuard: [requireAuth('admin'), requireAcl('gyms')],
  onRequest: async (req, res) => {
    const result = operatorService.gymEntranceQr({ gymId: req.params.gymId, isAdmin: true });
    res.status(result.status).json(result.body);
  }
};

export const operatorVerifyQr = {
  created, method: 'post', path: '/operator/verify-qr',
  description: 'Operator: verify a member QR and return member details + pass eligibility without check-in.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('checkins')],
  onRequest: async (req, res) => {
    const { qrToken, gymId } = req.body || {};
    const operator = await resolveRequestUser(req);
    const result = await operatorService.verifyQr({ operator, gymId, qrToken });
    res.status(result.status).json(result.body);
  }
};

export const operatorCheckIn = {
  created, method: 'post', path: '/operator/checkins',
  description: 'Operator scans a member QR and triggers BL-012 validation + logging.',
  requestSample: { qrToken: 'usr_x.123456.signature' },
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('checkins')],
  onRequest: async (req, res) => {
    const { qrToken, gymId } = req.body || {};
    const operator = await resolveRequestUser(req);
    const result = await operatorService.checkIn({ operator, gymId, qrToken });
    res.status(result.status).json(result.body);
  }
};

export const operatorRecentCheckIns = {
  created, method: 'get', path: '/operator/checkins',
  description: 'List of recent check-ins at the operator gym.',
  onGuard: [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('checkins')],
  onRequest: async (req, res) => {
    const operator = await resolveRequestUser(req);
    res.json(await operatorService.recentCheckIns(operator));
  }
};

export const operatorDashboard = {
  created, method: 'get', path: '/operator/dashboard',
  description: 'Owner/operator analytics across owned gyms with configurable period and direct/FitFlex split. Basic cross-feature context — visible to any gym_staff regardless of their ACL scopes.',
  onGuard: requireAuth('gym_operator', 'gym_staff'),
  onRequest: async (req, res) => {
    const operator = await resolveRequestUser(req);
    const result = await operatorService.dashboard({ operator, query: req.query || {} });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};
