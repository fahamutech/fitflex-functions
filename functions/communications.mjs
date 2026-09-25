// Communications REST surface — audiences (segments) for gym and FitFlex
// messages to members.
//
// Owners and gym staff with the `communications` scope work with their own
// gyms' direct members only; the gym scope comes from the signed-in owner,
// never from the request. FitFlex admins with the `communications` portal
// scope work with all members.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl, requireGymAcl } from '../src/auth/jwt.mjs';
import { segmentService, resolveRequestUser } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

const ownerGuard = [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('communications')];
const adminGuard = [requireAuth('admin'), requireAcl('communications')];

function send(res, result) {
  if (result.error) {
    return res.status(result.status).json({ error: result.error, ...(result.detail ? { detail: result.detail } : {}) });
  }
  res.json(result);
}

const previewSample = {
  senderType: 'gym', gymIds: ['gym_1'], category: 'transactional', count: 84,
  channels: {
    in_app: { eligible: 84, excluded: {} },
    push: { eligible: 51, excluded: { no_device: 33 } },
    whatsapp: { eligible: 0, excluded: { whatsapp_not_configured: 84 } },
  },
  sample: [{ id: 'usr_x', displayName: 'Amina Said', status: 'expiring_soon' }],
};

export const ownerCommunicationSegments = {
  created, method: 'get', path: '/owner/communications/segments',
  description: 'Owner/staff: preset audiences and filter fields for messaging their gym\'s direct members.',
  onGuard: ownerGuard,
  onRequest: async (_req, res) => res.json(segmentService.catalog('gym')),
};

export const ownerAudiencePreview = {
  created, method: 'post', path: '/owner/communications/audience/preview',
  description: 'Owner/staff: how many of their direct members match an audience, what each channel can reach, and a few names. POST { gymId?, preset?, filter?, purpose? }.',
  requestSample: { preset: 'active', filter: { all: [{ field: 'daysUntilExpiry', op: 'lte', value: 7 }] }, purpose: 'renewal' },
  responseSample: previewSample,
  onGuard: ownerGuard,
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const { gymId, preset, filter, purpose } = req.body || {};
    send(res, await segmentService.previewAudience({
      sender: { senderType: 'gym', owner, gymId: gymId ?? null }, preset, filter, purpose,
    }));
  },
};

export const adminCommunicationSegments = {
  created, method: 'get', path: '/admin/communications/segments',
  description: 'Admin: preset audiences and filter fields (including area) for FitFlex-wide messages.',
  onGuard: adminGuard,
  onRequest: async (_req, res) => res.json(segmentService.catalog('platform')),
};

export const adminAudiencePreview = {
  created, method: 'post', path: '/admin/communications/audience/preview',
  description: 'Admin: how many FitFlex members match an audience, what each channel can reach, and a few names. POST { preset?, filter?, purpose? }.',
  requestSample: { preset: 'pass_holders', filter: { all: [{ field: 'area', op: 'contains', value: 'Arusha' }] }, purpose: 'promotion' },
  onGuard: adminGuard,
  onRequest: async (req, res) => {
    const { preset, filter, purpose } = req.body || {};
    send(res, await segmentService.previewAudience({ sender: { senderType: 'platform' }, preset, filter, purpose }));
  },
};
