// Moderation — admin REST surface. Seeing the queue needs the `moderation` scope;
// approving, rejecting, suspending, hiding and restoring needs `moderation_decide`.
// KYC remains the authority on verification and payouts (see /admin/kyc); this
// decides whether an entity may be shown and promoted.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { moderationService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

const canView = [requireAuth('admin'), requireAcl('moderation', 'moderation_decide')];
const canDecide = [requireAuth('admin'), requireAcl('moderation_decide')];

function send(res, result, okStatus = 200) {
  const { error, status, ...payload } = result;
  if (error) return res.status(status).json({ error, ...payload });
  return res.status(okStatus).json(payload);
}

export const moderationReference = {
  created, method: 'get', path: '/admin/moderation/reference',
  description: 'Admin (moderation): entity types, moderation statuses and the actions that move between them.',
  onGuard: canView,
  onRequest: async (req, res) => res.json(moderationService.reference()),
};

export const moderationQueue = {
  created, method: 'get', path: '/admin/moderation',
  description: 'Admin (moderation): entities of one type (?entityType=gym|trainer|vendor|product) with their moderation status. Filter with ?status=pending|approved|rejected|suspended|hidden and ?q=. An entity with no decision yet is approved. Paged with ?limit= and ?cursor=; the counts per status come with it.',
  onGuard: canView,
  onRequest: async (req, res) => send(res, await moderationService.list({
    entityType: req.query?.entityType, status: req.query?.status, q: req.query?.q, limit: req.query?.limit, cursor: req.query?.cursor,
  })),
};

export const moderationCounts = {
  created, method: 'get', path: '/admin/moderation/counts',
  description: 'Admin (moderation): how many entities are in each moderation status, across all types or one (?entityType=).',
  onGuard: canView,
  onRequest: async (req, res) => res.json({ counts: await moderationService.counts({ entityType: req.query?.entityType }) }),
};

export const moderationDetail = {
  created, method: 'get', path: '/admin/moderation/:entityType/:entityId',
  description: 'Admin (moderation): one entity\'s summary, moderation status, whether it is eligible to be listed or promoted (and why not), the actions open to it, and its decision history.',
  onGuard: canView,
  onRequest: async (req, res) => send(res, await moderationService.detail(req.params.entityType, req.params.entityId)),
};

const decision = action => async (req, res) => send(res, await moderationService.decide({
  entityType: req.params.entityType, entityId: req.params.entityId, action, reason: req.body?.reason, actorId: req.user.sub,
}));

export const moderationApprove = {
  created, method: 'post', path: '/admin/moderation/:entityType/:entityId/approve',
  description: 'Admin (moderation_decide): approve an entity that is pending review.',
  onGuard: canDecide, onRequest: decision('approve'),
};
export const moderationReject = {
  created, method: 'post', path: '/admin/moderation/:entityType/:entityId/reject',
  description: 'Admin (moderation_decide): reject an entity that is pending review. A reason is required.',
  onGuard: canDecide, onRequest: decision('reject'),
};
export const moderationSuspend = {
  created, method: 'post', path: '/admin/moderation/:entityType/:entityId/suspend',
  description: 'Admin (moderation_decide): suspend an approved or hidden entity. A reason is required. Its running promotions are paused.',
  onGuard: canDecide, onRequest: decision('suspend'),
};
export const moderationHide = {
  created, method: 'post', path: '/admin/moderation/:entityType/:entityId/hide',
  description: 'Admin (moderation_decide): hide an approved or suspended entity from public discovery. A reason is required. Its running promotions are paused.',
  onGuard: canDecide, onRequest: decision('hide'),
};
export const moderationRestore = {
  created, method: 'post', path: '/admin/moderation/:entityType/:entityId/restore',
  description: 'Admin (moderation_decide): restore a suspended or hidden entity to approved. Its paused promotions are not resumed automatically.',
  onGuard: canDecide, onRequest: decision('restore'),
};
export const moderationReopen = {
  created, method: 'post', path: '/admin/moderation/:entityType/:entityId/reopen',
  description: 'Admin (moderation_decide): send a rejected entity back to pending review.',
  onGuard: canDecide, onRequest: decision('reopen'),
};
export const moderationRequireReview = {
  created, method: 'post', path: '/admin/moderation/:entityType/:entityId/require-review',
  description: 'Admin (moderation_decide): hold an approved entity for a fresh review. A reason is required. Its running promotions are paused.',
  onGuard: canDecide, onRequest: decision('require_review'),
};
