// Promotions — admin REST surface.
//
//   promotions              view, create, edit, submit, pause, resume, cancel, complete
//   promotions_approve      approve, reject, schedule, activate (never one's own submission)
//   campaigns               create and run campaigns; set placement limits
//   promotion_analytics     reserved for the analytics phase
//
// Viewing is open to anyone holding any of the promotion scopes.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { promotionService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

// Analytics has its own read routes (functions/promotion-events.mjs); it does not open promotion notes, references or history.
const canView = [requireAuth('admin'), requireAcl('promotions', 'promotions_approve', 'campaigns')];
const seesActivity = req => !req.user?.portalUser || ['promotions', 'promotions_approve', 'moderation', 'moderation_decide'].some(s => (req.user.aclPermissions || []).includes(s));
const isApprover = req => !req.user?.portalUser || (req.user.aclPermissions || []).includes('promotions_approve');
const canManage = [requireAuth('admin'), requireAcl('promotions')];
const canApprove = [requireAuth('admin'), requireAcl('promotions_approve')];
const canCampaign = [requireAuth('admin'), requireAcl('campaigns')];

function send(res, result, okStatus = 200) {
  const { error, status, ...payload } = result;
  if (error) return res.status(status).json({ error, ...payload });
  return res.status(okStatus).json(payload);
}
const actor = req => req.user.sub;

export const promotionReference = {
  created, method: 'get', path: '/admin/promotion-reference',
  description: 'Admin (promotions): promotion types, placements (and which entity types each takes), statuses and allowed transitions, relationship types and the platform defaults.',
  onGuard: canView, onRequest: async (req, res) => res.json(promotionService.reference()),
};

export const promotionOverview = {
  created, method: 'get', path: '/admin/promotion-overview',
  description: 'Admin (promotions): active, scheduled, pending-approval and expiring-soon promotions, moderation counts and recent activity.',
  onGuard: canView, onRequest: async (req, res) => res.json(await promotionService.overview({ includeActivity: seesActivity(req) })),
};

export const promotionLimits = {
  created, method: 'get', path: '/admin/promotion-limits',
  description: 'Admin (promotions): for every placement and promotion type, the slot limit (configured or default), the boost cap, rotation, and how many slots are taken now.',
  onGuard: canView, onRequest: async (req, res) => res.json({ limits: await promotionService.limits() }),
};

export const setPromotionLimit = {
  created, method: 'put', path: '/admin/promotion-limits/:placement/:promotionType',
  description: 'Admin (campaigns): set the slot limit, optional boost cap (0-1 of the score range) and rotation for one placement and promotion type. Audited. Lowering a limit does not remove promotions already holding slots.',
  onGuard: canCampaign,
  onRequest: async (req, res) => send(res, await promotionService.setLimit({
    placement: req.params.placement, promotionType: req.params.promotionType,
    maxSlots: req.body?.maxSlots, maxBoostFraction: req.body?.maxBoostFraction,
    rotationMode: req.body?.rotationMode, rotationWindowMinutes: req.body?.rotationWindowMinutes, actorId: actor(req),
  })),
};

export const promotionPreview = {
  created, method: 'post', path: '/admin/promotion-preview',
  description: 'Admin (promotions): check a promotion before saving it (body: the promotion fields) or an existing one (body: {id}). Reports whether the entity may be promoted and whether each placement has room, without changing anything.',
  onGuard: canManage,
  onRequest: async (req, res) => send(res, await promotionService.preview({ id: req.body?.id, body: req.body?.id ? null : req.body })),
};

export const listPromotions = {
  created, method: 'get', path: '/admin/promotions',
  description: 'Admin (promotions): promotions, newest strongest first. Filter with ?status= (stored), ?effective= (as of now), ?entityType=, ?type=, ?placement=, ?campaignId=, ?q=. Paged with ?limit= and ?cursor=.',
  onGuard: canView,
  onRequest: async (req, res) => res.json(await promotionService.list({
    status: req.query?.status, effective: req.query?.effective, entityType: req.query?.entityType, type: req.query?.type,
    placement: req.query?.placement, campaignId: req.query?.campaignId, q: req.query?.q, limit: req.query?.limit, cursor: req.query?.cursor,
  })),
};

export const createPromotion = {
  created, method: 'post', path: '/admin/promotions',
  description: 'Admin (promotions): create a promotion as a draft. Body: entityType, entityId, type (featured|promoted|sponsored|recommended|campaign), placements[], startsAt, endsAt, priority (1 strongest), boostWeight (0-1), geoScope {areaIds[], radius?}, audience, categories[], campaignId, partnerRef, isCommercial, relationshipType, commercialRef, disclosureLabel, notes. A rejected, suspended or hidden entity cannot be promoted.',
  onGuard: canManage,
  onRequest: async (req, res) => send(res, await promotionService.create({ body: req.body || {}, actorId: actor(req) }), 201),
};

export const getPromotion = {
  created, method: 'get', path: '/admin/promotions/:id',
  description: 'Admin (promotions): one promotion with its entity, eligibility, placement capacity, allowed actions and full history.',
  onGuard: canView, onRequest: async (req, res) => send(res, await promotionService.get(req.params.id)),
};

export const updatePromotion = {
  created, method: 'patch', path: '/admin/promotions/:id',
  description: 'Admin (promotions): edit a draft freely. Once approved, only priority, boostWeight, endsAt, commercialRef and notes can change, and changing priority or boostWeight (how strongly it ranks) needs the promotions_approve scope. A submitted promotion must be reopened first. Audited with before and after.',
  onGuard: canManage,
  onRequest: async (req, res) => send(res, await promotionService.update({ id: req.params.id, body: req.body || {}, actorId: actor(req), canRank: isApprover(req) })),
};

const transition = (name, guard, description, build) => ({
  created, method: 'post', path: `/admin/promotions/:id/${name}`, description, onGuard: guard,
  onRequest: async (req, res) => send(res, await promotionService[build]({ id: req.params.id, actorId: actor(req), reason: req.body?.reason })),
});

export const submitPromotion = transition('submit', canManage, 'Admin (promotions): send a draft for approval.', 'submit');
export const approvePromotion = transition('approve', canApprove, 'Admin (promotions_approve): approve a submitted promotion. It must be someone other than the person who created or submitted it, the entity must be eligible, and every placement needs room.', 'approve');
export const rejectPromotion = transition('reject', canApprove, 'Admin (promotions_approve): reject a submitted promotion. A reason is required.', 'reject');
export const reopenPromotion = transition('reopen', canManage, 'Admin (promotions): take a submitted or rejected promotion back to draft to edit it.', 'reopen');
export const schedulePromotion = transition('schedule', canApprove, 'Admin (promotions_approve): schedule an approved promotion whose start is in the future. It goes live by itself at its start.', 'schedule');
export const activatePromotion = transition('activate', canApprove, 'Admin (promotions_approve): make an approved or scheduled promotion live now. Its period must have started and not ended.', 'activate');
export const pausePromotion = transition('pause', canManage, 'Admin (promotions): pause a live or scheduled promotion. A paused promotion has no effect on ranking.', 'pause');
export const resumePromotion = transition('resume', canManage, 'Admin (promotions): resume a paused promotion if its period has not ended.', 'resume');
export const cancelPromotion = transition('cancel', canManage, 'Admin (promotions): cancel a promotion that has not finished. A reason is required.', 'cancel');
export const completePromotion = transition('complete', canManage, 'Admin (promotions): close a live promotion early, or mark an expired one finished.', 'complete');

// ── Campaigns ───────────────────────────────────────────────────────────────

export const listCampaigns = {
  created, method: 'get', path: '/admin/promotion-campaigns',
  description: 'Admin (promotions): campaigns with how many promotions each holds. Filter with ?status=.',
  onGuard: canView,
  onRequest: async (req, res) => res.json(await promotionService.listCampaigns({ status: req.query?.status, limit: req.query?.limit, cursor: req.query?.cursor })),
};
export const createCampaign = {
  created, method: 'post', path: '/admin/promotion-campaigns',
  description: 'Admin (campaigns): create a campaign. Body: name, description, startsAt, endsAt, geoScope.',
  onGuard: canCampaign, onRequest: async (req, res) => send(res, await promotionService.createCampaign({ body: req.body || {}, actorId: actor(req) }), 201),
};
export const getCampaign = {
  created, method: 'get', path: '/admin/promotion-campaigns/:id',
  description: 'Admin (promotions): a campaign and its promotions.',
  onGuard: canView, onRequest: async (req, res) => send(res, await promotionService.getCampaign(req.params.id)),
};
export const updateCampaign = {
  created, method: 'patch', path: '/admin/promotion-campaigns/:id',
  description: 'Admin (campaigns): edit a campaign. Its period cannot move so that a promotion falls outside it.',
  onGuard: canCampaign,
  onRequest: async (req, res) => send(res, await promotionService.updateCampaign({ id: req.params.id, body: req.body || {}, actorId: actor(req) })),
};
const campaignStatus = (name, to, description) => ({
  created, method: 'post', path: `/admin/promotion-campaigns/:id/${name}`, description, onGuard: canCampaign,
  onRequest: async (req, res) => send(res, await promotionService.setCampaignStatus({ id: req.params.id, to, reason: req.body?.reason, actorId: actor(req) })),
});
export const startCampaign = campaignStatus('start', 'active', 'Admin (campaigns): mark a draft campaign active.');
export const endCampaign = campaignStatus('end', 'ended', 'Admin (campaigns): end an active campaign.');
export const cancelCampaign = campaignStatus('cancel', 'cancelled', 'Admin (campaigns): cancel a campaign. A reason is required. Its promotions are not changed; they are listed in the answer so each can be dealt with.');

// ── Lookups for the create wizard ───────────────────────────────────────────

export const searchPromotionEntities = {
  created, method: 'get', path: '/admin/promotion-entities',
  description: 'Admin (promotions): find entities to promote (?entityType=gym|trainer|vendor|product, ?q= name). Each says whether it can be promoted right now and why not, and which placements suit it.',
  onGuard: canManage,
  onRequest: async (req, res) => send(res, await promotionService.searchEntities({ entityType: req.query?.entityType, q: req.query?.q, limit: req.query?.limit })),
};

export const searchPromotionPartners = {
  created, method: 'get', path: '/admin/promotion-partners',
  description: 'Admin (promotions): find partner organisations (?q= name) to attach to a commercial promotion.',
  onGuard: canManage,
  onRequest: async (req, res) => res.json(await promotionService.searchPartners({ q: req.query?.q, limit: req.query?.limit })),
};

// ── Geography ───────────────────────────────────────────────────────────────

export const listGeoAreas = {
  created, method: 'get', path: '/admin/geo-areas',
  description: 'Admin (promotions): the geographic areas promotions can target (country > region > city > district).',
  onGuard: canView, onRequest: async (req, res) => res.json(await promotionService.listAreas()),
};
export const createGeoArea = {
  created, method: 'post', path: '/admin/geo-areas',
  description: 'Admin (campaigns): add a region, city or district under the right parent. Body: level, name, parentId, optional lat, lng, radiusKm.',
  onGuard: canCampaign, onRequest: async (req, res) => send(res, await promotionService.createArea({ body: req.body || {}, actorId: actor(req) }), 201),
};
