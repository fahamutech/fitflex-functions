// Communications REST surface — audiences (segments) for gym and FitFlex
// messages to members.
//
// Owners and gym staff with the `communications` scope work with their own
// gyms' direct members only; the gym scope comes from the signed-in owner,
// never from the request. FitFlex admins with the `communications` portal
// scope work with all members.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl, requireGymAcl } from '../src/auth/jwt.mjs';
import { segmentService, campaignService, resolveRequestUser } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

const ownerGuard = [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('communications')];
const adminGuard = [requireAuth('admin'), requireAcl('communications')];

function send(res, result, okStatus = 200) {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  res.status(okStatus).json(result);
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

// ── Campaigns (M4) ──────────────────────────────────────────────────────────
// The same use cases for a gym (owner/staff → their direct members) and for
// FitFlex (admins → all members). Who is sending is always taken from the
// signed-in user, never from the request body.

async function gymSender(req, res) {
  const owner = await resolveRequestUser(req);
  if (!owner) { res.status(404).json({ error: 'user_not_found' }); return null; }
  return { senderType: 'gym', owner, actorId: owner.id };
}
async function platformSender(req) {
  return { senderType: 'platform', actorId: req.user?.sub || null };
}

function campaignRoutes(prefix, guard, senderOf, who) {
  const route = (method, path, description, handler, extra = {}) => ({
    created, method, path: `${prefix}${path}`, description: `${who}: ${description}`, onGuard: guard, ...extra,
    onRequest: async (req, res) => {
      const sender = await senderOf(req, res);
      if (sender) await handler(sender, req, res);
    },
  });
  const q = (req) => req.query || {};
  return {
    overview: route('get', '/overview', 'communication overview — members reachable, campaigns by status, recent campaigns, channels available. ?gymId',
      async (s, req, res) => send(res, await campaignService.overview(s, { gymId: q(req).gymId ?? null }))),
    list: route('get', '/campaigns', 'campaigns, newest first. ?gymId&status&limit',
      async (s, req, res) => send(res, await campaignService.list(s, { gymId: q(req).gymId ?? null, status: q(req).status || null, limit: q(req).limit }))),
    create: route('post', '/campaigns', 'save a draft campaign. POST { gymId?, name?, purpose, audience?: { preset?, filter? }, content?: { title, body, ctaLabel?, deepLink?, offerName?, discount?, amountTzs? }, channels? }',
      async (s, req, res) => send(res, await campaignService.create(s, req.body || {}), 201)),
    previewNew: route('post', '/campaigns/preview', 'preview an unsaved campaign: who it reaches on each channel, an example message, warnings. Same body as create.',
      async (s, req, res) => send(res, await campaignService.preview(s, { body: req.body || {} }))),
    get: route('get', '/campaigns/:id', 'one campaign with delivery progress per channel.',
      async (s, req, res) => send(res, await campaignService.get(s, req.params.id))),
    update: route('patch', '/campaigns/:id', 'edit a draft. Any of the create fields except gymId.',
      async (s, req, res) => send(res, await campaignService.update(s, req.params.id, req.body || {}))),
    remove: route('delete', '/campaigns/:id', 'delete a draft.',
      async (s, req, res) => send(res, await campaignService.remove(s, req.params.id))),
    preview: route('post', '/campaigns/:id/preview', 'preview a saved campaign.',
      async (s, req, res) => send(res, await campaignService.preview(s, { campaignId: req.params.id }))),
    schedule: route('post', '/campaigns/:id/schedule', 'schedule a draft. POST { scheduledAt } (5 minutes to 90 days ahead).',
      async (s, req, res) => send(res, await campaignService.schedule(s, req.params.id, req.body || {}))),
    unschedule: route('post', '/campaigns/:id/unschedule', 'turn a scheduled campaign back into a draft.',
      async (s, req, res) => send(res, await campaignService.unschedule(s, req.params.id))),
    cancel: route('post', '/campaigns/:id/cancel', 'cancel a draft or scheduled campaign.',
      async (s, req, res) => send(res, await campaignService.cancel(s, req.params.id))),
    send: route('post', '/campaigns/:id/send', 'send now. POST { sendRequestId, confirmLargeSend? }. Repeating the same sendRequestId returns the same result; large audiences need confirmLargeSend: true (409 confirm_large_send otherwise).',
      async (s, req, res) => send(res, await campaignService.send(s, req.params.id, req.body || {}))),
  };
}

const owner = campaignRoutes('/owner/communications', ownerGuard, gymSender, 'Owner/staff');
export const ownerCommunicationOverview = owner.overview;
export const ownerCampaignList = owner.list;
export const ownerCampaignCreate = owner.create;
export const ownerCampaignPreviewNew = owner.previewNew;
export const ownerCampaignGet = owner.get;
export const ownerCampaignUpdate = owner.update;
export const ownerCampaignDelete = owner.remove;
export const ownerCampaignPreview = owner.preview;
export const ownerCampaignSchedule = owner.schedule;
export const ownerCampaignUnschedule = owner.unschedule;
export const ownerCampaignCancel = owner.cancel;
export const ownerCampaignSend = owner.send;

const admin = campaignRoutes('/admin/communications', adminGuard, platformSender, 'Admin (FitFlex-wide)');
export const adminCommunicationOverview = admin.overview;
export const adminCampaignList = admin.list;
export const adminCampaignCreate = admin.create;
export const adminCampaignPreviewNew = admin.previewNew;
export const adminCampaignGet = admin.get;
export const adminCampaignUpdate = admin.update;
export const adminCampaignDelete = admin.remove;
export const adminCampaignPreview = admin.preview;
export const adminCampaignSchedule = admin.schedule;
export const adminCampaignUnschedule = admin.unschedule;
export const adminCampaignCancel = admin.cancel;
export const adminCampaignSend = admin.send;
