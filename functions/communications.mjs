// Communications REST surface — audiences (segments) for gym and FitFlex
// messages to members.
//
// Owners and gym staff with the `communications` scope work with their own
// gyms' direct members only; the gym scope comes from the signed-in owner,
// never from the request. FitFlex admins with the `communications` portal
// scope work with all members.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl, requireGymAcl } from '../src/auth/jwt.mjs';
import { segmentService, campaignService, templateService, whatsappChannelService, communicationHistoryService, automationService, resolveRequestUser } from '../src/bootstrap/services.mjs';

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
  description: 'Admin: preset audiences and filter fields (including area) for FitFlex-wide messages. ?recipients=trainers returns the trainer audiences instead.',
  onGuard: adminGuard,
  onRequest: async (req, res) => res.json(segmentService.catalog(req.query?.recipients === 'trainers' ? 'trainers' : 'platform')),
};

export const adminAudiencePreview = {
  created, method: 'post', path: '/admin/communications/audience/preview',
  description: 'Admin: how many FitFlex members (or, with recipients: "trainers", trainers) match an audience, what each channel can reach, and a few names. POST { recipients?, preset?, filter?, purpose? }.',
  requestSample: { preset: 'pass_holders', filter: { all: [{ field: 'area', op: 'contains', value: 'Arusha' }] }, purpose: 'promotion' },
  onGuard: adminGuard,
  onRequest: async (req, res) => {
    const { recipients, preset, filter, purpose } = req.body || {};
    send(res, await segmentService.previewAudience({ sender: { senderType: 'platform' }, recipients, preset, filter, purpose }));
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
    list: route('get', '/campaigns', 'campaign history, newest first, each with who created it and its delivery numbers (stats). ?gymId&status (comma list)&purpose&channel&from&to&search&cursor&limit',
      async (s, req, res) => {
        const { gymId, status, purpose, channel, from, to, search, cursor, limit } = q(req);
        send(res, await campaignService.list(s, { gymId: gymId ?? null, status: status || null, purpose: purpose || null, channel: channel || null, from: from || null, to: to || null, search: search || null, cursor: cursor || null, limit }));
      }),
    recipients: route('get', '/campaigns/:id/recipients', 'who a campaign went to — one row per member with each channel\'s status, delivery times, failure or skip reason and provider reference. ?channel&status&search&cursor&limit',
      async (s, req, res) => send(res, await communicationHistoryService.recipients(s, req.params.id, q(req)))),
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
    schedule: route('post', '/campaigns/:id/schedule', 'schedule a draft. POST { scheduledAt, confirmLargeSend? } (5 minutes to 90 days ahead; large audiences need confirmLargeSend like sending now).',
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
export const ownerCampaignRecipients = owner.recipients;
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
export const adminCampaignRecipients = admin.recipients;
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

// ── Templates (M6) ──────────────────────────────────────────────────────────
// FitFlex system templates for everyone sending; gyms also keep their own.
// Only gyms create, edit, copy or archive templates.

function templateRoutes(prefix, guard, senderOf, who) {
  const route = (method, path, description, handler) => ({
    created, method, path: `${prefix}${path}`, description: `${who}: ${description}`, onGuard: guard,
    onRequest: async (req, res) => {
      const sender = await senderOf(req, res);
      if (sender) await handler(sender, req, res);
    },
  });
  const q = (req) => req.query || {};
  return {
    list: route('get', '/templates', 'templates to start a message from — the gym\'s own first, then FitFlex\'s. ?group&purpose&gymId',
      async (s, req, res) => send(res, await templateService.list(s, { group: q(req).group || null, purpose: q(req).purpose || null, gymId: q(req).gymId ?? null }))),
    get: route('get', '/templates/:id', 'one template, with whether it can go out on WhatsApp in each language.',
      async (s, req, res) => send(res, await templateService.get(s, req.params.id))),
    previewNew: route('post', '/templates/preview', 'preview an unsaved template on each channel and language. POST { name, purpose, group?, deepLink?, bodies: { en?: {title, body, ctaLabel?}, sw?: {…} }, values?: { offerName?, discount?, amountTzs? } }',
      async (s, req, res) => send(res, await templateService.preview(s, { body: req.body || {}, gymId: req.body?.gymId ?? null, values: req.body?.values || {} }))),
    preview: route('post', '/templates/:id/preview', 'preview a template on each channel and language, for a sample member. POST { gymId?, values? }',
      async (s, req, res) => send(res, await templateService.preview(s, { templateId: req.params.id, gymId: req.body?.gymId ?? null, values: req.body?.values || {} }))),
    create: route('post', '/templates', 'save a gym template. POST { gymId?, name, purpose, group?, deepLink?, bodies }',
      async (s, req, res) => send(res, await templateService.create(s, req.body || {}), 201)),
    update: route('patch', '/templates/:id', 'edit a gym template (FitFlex templates are read-only — copy them).',
      async (s, req, res) => send(res, await templateService.update(s, req.params.id, req.body || {}))),
    duplicate: route('post', '/templates/:id/duplicate', 'copy a template into the gym\'s own to adapt it. POST { gymId?, name? }',
      async (s, req, res) => send(res, await templateService.duplicate(s, req.params.id, req.body || {}), 201)),
    archive: route('post', '/templates/:id/archive', 'hide a gym template. Campaigns keep their own copy of its text.',
      async (s, req, res) => send(res, await templateService.archive(s, req.params.id))),
  };
}

const ownerTpl = templateRoutes('/owner/communications', ownerGuard, gymSender, 'Owner/staff');
export const ownerTemplateList = ownerTpl.list;
export const ownerTemplateGet = ownerTpl.get;
export const ownerTemplatePreviewNew = ownerTpl.previewNew;
export const ownerTemplatePreview = ownerTpl.preview;
export const ownerTemplateCreate = ownerTpl.create;
export const ownerTemplateUpdate = ownerTpl.update;
export const ownerTemplateDuplicate = ownerTpl.duplicate;
export const ownerTemplateArchive = ownerTpl.archive;

const adminTpl = templateRoutes('/admin/communications', adminGuard, platformSender, 'Admin (FitFlex-wide)');
export const adminTemplateList = adminTpl.list;
export const adminTemplateGet = adminTpl.get;
export const adminTemplatePreviewNew = adminTpl.previewNew;
export const adminTemplatePreview = adminTpl.preview;

// ── WhatsApp (M7) ───────────────────────────────────────────────────────────
// FitFlex admins only: the provider's status, the kill switch, the registry
// of provider-approved templates, and a test send. Credentials never pass
// through here — they live in the server's environment.

const waRoute = (method, path, description, handler, extra = {}) => ({
  created, method, path: `/admin/communications/whatsapp${path}`, description: `Admin: ${description}`,
  onGuard: adminGuard, ...extra,
  onRequest: async (req, res) => handler(req.user?.sub || null, req, res),
});

export const adminWhatsAppStatus = waRoute('get', '', 'WhatsApp status — provider (never its credentials), kill switch, webhook, opted-in members, template approvals, last 7 days of WhatsApp messages.',
  async (_actor, _req, res) => send(res, await whatsappChannelService.status()));

export const adminWhatsAppSetEnabled = waRoute('put', '', 'the WhatsApp kill switch. PUT { enabled: boolean } — off stops all WhatsApp sending within about 30 seconds; queued messages are skipped.',
  async (actor, req, res) => send(res, await whatsappChannelService.setEnabled(actor, req.body?.enabled)),
  { requestSample: { enabled: false } });

export const adminWhatsAppTemplates = waRoute('get', '/templates', 'the provider template registry, and the provider template each FitFlex template needs per language (name, category, variables in order).',
  async (_actor, _req, res) => send(res, await whatsappChannelService.registry()));

export const adminWhatsAppTemplateRegister = waRoute('post', '/templates', 'register a provider template (or update it). POST { providerTemplateName, language: en|sw, category: utility|marketing|authentication, variables: [..in order], approvalStatus?, provider? }',
  async (actor, req, res) => send(res, await whatsappChannelService.registerTemplate(actor, req.body || {}), 201),
  { requestSample: { providerTemplateName: 'fitflex_renewal_reminder', language: 'en', category: 'utility', variables: ['member_name', 'gym_name', 'expiry_date'], approvalStatus: 'approved' } });

export const adminWhatsAppTemplateUpdate = waRoute('patch', '/templates/:id', 'change a registered provider template\'s approval status, category or variables.',
  async (actor, req, res) => send(res, await whatsappChannelService.updateTemplate(actor, req.params.id, req.body || {})));

export const adminWhatsAppTemplateSync = waRoute('post', '/templates/sync', 'pull template approval statuses from the provider into the registry.',
  async (actor, _req, res) => send(res, await whatsappChannelService.syncTemplates(actor)));

export const adminWhatsAppTest = waRoute('post', '/test', 'send one approved template to a phone number — the go-live check. POST { phone, templateName, language, parameters: [..] }',
  async (actor, req, res) => send(res, await whatsappChannelService.sendTest(actor, req.body || {})));

// ── History (M8) ────────────────────────────────────────────────────────────
// Every message is already in the CommunicationMessage ledger; these routes
// read it. Owners and staff see only what their own gyms sent; admins see
// FitFlex's own messages. Enforced in the history service.

const HISTORY_FILTERS = 'memberId&campaignId&channel&category&messageType&status (a status, or pending|reached|opened; comma list)&from&to&search (member name)&gymId&cursor&limit';

function historyRoutes(prefix, guard, senderOf, who) {
  const route = (method, path, description, handler) => ({
    created, method, path: `${prefix}${path}`, description: `${who}: ${description}`, onGuard: guard,
    onRequest: async (req, res) => {
      const sender = await senderOf(req, res);
      if (sender) await handler(sender, req, res);
    },
  });
  return {
    messages: route('get', '/communications/messages', `the message log, newest first: one row per member per channel, with status, delivery and engagement times, failure or skip reason and provider reference. ?${HISTORY_FILTERS}`,
      async (s, req, res) => send(res, await communicationHistoryService.messages(s, req.query || {}))),
    summary: route('get', '/communications/summary', `counts by channel and status, and per day, for the same filters as the log. ?${HISTORY_FILTERS}`,
      async (s, req, res) => send(res, await communicationHistoryService.summary(s, req.query || {}))),
    message: route('get', '/communications/messages/:id', 'one message in full — campaign, template, rendered text, provider reference and every timestamp.',
      async (s, req, res) => send(res, await communicationHistoryService.message(s, req.params.id))),
    member: route('get', '/members/:memberId/communications', `one member's communications, newest first, each with its channels side by side. ?channel&category&messageType&status&from&to&gymId&cursor&limit`,
      async (s, req, res) => send(res, await communicationHistoryService.memberTimeline(s, req.params.memberId, req.query || {}))),
  };
}

const ownerHistory = historyRoutes('/owner', ownerGuard, gymSender, 'Owner/staff');
export const ownerCommunicationMessages = ownerHistory.messages;
export const ownerCommunicationSummary = ownerHistory.summary;
export const ownerCommunicationMessage = ownerHistory.message;
export const ownerMemberCommunications = ownerHistory.member;

const adminHistory = historyRoutes('/admin', adminGuard, platformSender, 'Admin (FitFlex\'s own messages)');
export const adminCommunicationMessages = adminHistory.messages;
export const adminCommunicationSummary = adminHistory.summary;
export const adminCommunicationMessage = adminHistory.message;
export const adminMemberCommunications = adminHistory.member;

// ── Automations (M9) ────────────────────────────────────────────────────────
// A gym's lifecycle messages: welcome, expiry reminders, expired, failed
// payment, inactivity. Every gym has the defaults, switched off until the
// owner turns them on.

const autoRoute = (path, description, handler, extra = {}) => ({
  created, method: 'get', path: `/owner/communications/automations${path}`, description: `Owner/staff: ${description}`,
  onGuard: ownerGuard, ...extra,
  onRequest: async (req, res) => {
    const sender = await gymSender(req, res);
    if (sender) await handler(sender, req, res);
  },
});

export const ownerAutomationList = autoRoute('', 'the gym\'s automations (defaults created on first look, switched off), each with its trigger, template, channels, status and last-30-days numbers. ?gymId',
  async (s, req, res) => send(res, await automationService.list(s, { gymId: req.query?.gymId ?? null })));
export const ownerAutomationGet = autoRoute('/:id', 'one automation.',
  async (s, req, res) => send(res, await automationService.get(s, req.params.id)));
export const ownerAutomationUpdate = autoRoute('/:id', 'switch an automation on or off, or change its channels or template. PATCH { status?: enabled|disabled, channels?: [in_app|push|whatsapp], templateId? }. Turning it on clears an automatic pause.',
  async (s, req, res) => send(res, await automationService.update(s, req.params.id, req.body || {})),
  { method: 'patch', requestSample: { status: 'enabled', channels: ['in_app', 'whatsapp'] } });
export const ownerAutomationRuns = autoRoute('/:id/runs', 'recent firings: which member, for what, and how each channel went. ?limit&before',
  async (s, req, res) => send(res, await automationService.runs(s, req.params.id, { limit: req.query?.limit, before: req.query?.before || null })));
export const ownerAutomationPreview = autoRoute('/:id/preview', 'the automation\'s message as a sample member would see it, in each language and channel.',
  async (s, req, res) => send(res, await automationService.preview(s, req.params.id)),
  { method: 'post' });
