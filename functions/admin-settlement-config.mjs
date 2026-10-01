// Admin gym-settlement configuration REST surface (settlement Phase 3):
// pass tier versions, settlement rules and gym rate cards. Every change is a
// draft first; activating it gives it an EAT start date and needs a different
// admin from the one who drafted it. Active rows are never edited: a change
// is a new version.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { settlementConfigService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const guard = [requireAuth('admin'), requireAcl('payments')];
const KINDS = { 'pass-tiers': 'pass_tier', rules: 'rule', 'rate-cards': 'rate_card' };

const send = (res, result, okStatus = 200) => {
  if (result.error) {
    const { error, status, ...detail } = result;
    return res.status(status || 400).json({ error, ...detail });
  }
  res.status(okStatus).json(result);
};

export const adminSettlementConfig = {
  created, method: 'get', path: '/admin/settlement-config',
  description: 'Admin: pass tier versions, settlement rules and gym rate cards. Optional ?status=draft|active|rejected (default: all).',
  onGuard: guard,
  onRequest: async (req, res) => res.json(await settlementConfigService.listConfiguration({ status: req.query?.status }))
};

export const adminDraftPassTierVersion = {
  created, method: 'post', path: '/admin/settlement-config/pass-tiers',
  description: 'Admin: draft a new pass tier version (price and visit allowance).',
  requestSample: { tierKey: 'pro', priceTzs: 150000, visitAllowance: 18, reason: 'October price review' },
  onGuard: guard,
  onRequest: async (req, res) => send(res, await settlementConfigService.createPassTierVersion({ ...(req.body || {}), actorId: req.user?.sub }), 201)
};

export const adminDraftSettlementRule = {
  created, method: 'post', path: '/admin/settlement-config/rules',
  description: 'Admin: draft a settlement rule. Network % at scope global or pass_tier; discounts and ceilings at global, gym_tier or gym. Leave a field out to inherit it from the level below.',
  requestSample: { scopeType: 'gym', scopeId: 'gym_123', monthlyCeilingTzs: 45000, reason: 'Negotiated rate' },
  onGuard: guard,
  onRequest: async (req, res) => send(res, await settlementConfigService.createRule({ ...(req.body || {}), actorId: req.user?.sub }), 201)
};

export const adminDraftGymRateCard = {
  created, method: 'post', path: '/admin/settlement-config/rate-cards',
  description: 'Admin: draft a gym rate card from its retail daily, weekly and monthly rates. The discounts and ceilings are copied in when it is activated.',
  requestSample: { gymId: 'gym_123', retailDailyTzs: 5000, retailWeeklyTzs: 15000, retailMonthlyTzs: 50000 },
  onGuard: guard,
  onRequest: async (req, res) => send(res, await settlementConfigService.createRateCard({ ...(req.body || {}), actorId: req.user?.sub }), 201)
};

export const adminDraftRateCardsForGyms = {
  created, method: 'post', path: '/admin/settlement-config/rate-cards/draft-missing',
  description: 'Admin: draft a rate card, from its own retail rates, for every gym that has none. Gyms missing a rate are listed, not guessed.',
  onGuard: guard,
  onRequest: async (req, res) => send(res, await settlementConfigService.draftRateCardsForGyms({ actorId: req.user?.sub }), 201)
};

export const adminActivateSettlementConfig = {
  created, method: 'post', path: '/admin/settlement-config/:kind/:id/activate',
  description: 'Admin: activate a draft from an EAT date (kind: pass-tiers, rules or rate-cards). Closes the version it replaces. The approver must not be the drafter; the date can\'t be in the past once a version is live.',
  requestSample: { effectiveFrom: '2026-11-01' },
  onGuard: guard,
  onRequest: async (req, res) => {
    const kind = KINDS[req.params.kind];
    if (!kind) return res.status(404).json({ error: 'unknown_kind' });
    send(res, await settlementConfigService.activate({ kind, id: req.params.id, effectiveFrom: req.body?.effectiveFrom, actorId: req.user?.sub }));
  }
};

export const adminRejectSettlementConfig = {
  created, method: 'post', path: '/admin/settlement-config/:kind/:id/reject',
  description: 'Admin: reject a draft (kind: pass-tiers, rules or rate-cards).',
  requestSample: { reason: 'Wrong monthly rate' },
  onGuard: guard,
  onRequest: async (req, res) => {
    const kind = KINDS[req.params.kind];
    if (!kind) return res.status(404).json({ error: 'unknown_kind' });
    send(res, await settlementConfigService.reject({ kind, id: req.params.id, reason: req.body?.reason, actorId: req.user?.sub }));
  }
};
