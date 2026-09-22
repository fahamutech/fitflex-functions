// FitFlex Af — Admin Portal REST Endpoints
//
// To wire into index.mjs:
//   import { initAdminPortalEndpoints } from './admin-portal-endpoints.mjs';
//   initAdminPortalEndpoints({ collection, requireAuth, auditLog, users, gyms, trainers, vendors, corporateAccounts });

import { randomUUID } from 'node:crypto';
import { createAdminService } from '../src/services/admin-service.mjs';
import { RUBRIC_PILLARS, TIER_THRESHOLDS, COMMISSION_RANGE, CONTRACT_STATUS } from '../src/shared/admin-constants.mjs';

let svc = null;
let requireAuth = null;
let auditLog = null;
let users = null;
let gyms = null;
let trainers = null;
let vendors = null;
let corporateAccounts = null;

export function initAdminPortalEndpoints({ collection, requireAuth: ra, auditLog: al, users: u, gyms: g, trainers: t, vendors: v, corporateAccounts: ca }) {
  svc = createAdminService({
    gyms: g,
    trainers: t,
    vendors: v,
    corporateAccounts: ca,
    auditLog: al,
    roamingRates: collection('roaming_rates'),
    b2bContracts: collection('b2b_contracts')
  });
  requireAuth = ra;
  auditLog = al;
  users = u;
  gyms = g;
  trainers = t;
  vendors = v;
  corporateAccounts = ca;
}

const created = new Date().toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// 5-PILLAR CLASSIFICATION RUBRIC
// ═══════════════════════════════════════════════════════════════════════════
export const adminRubricPillars = {
  created, method: 'get', path: '/admin/rubric/pillars',
  description: 'Admin: list the 5-pillar classification rubric structure (max scores).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => {
    res.json(svc.getRubricPillars());
  }
};

export const adminScoreGymRubric = {
  created, method: 'post', path: '/admin/gyms/:id/rubric',
  description: 'Admin: score a gym across all 5 pillars. Auto-assigns tier based on total score.',
  requestSample: {
    scores: {
      equipment_modernity: 20,
      hygiene_ventilation: 22,
      safety_emergency: 18,
      staff_professionalism: 15,
      digital_connectivity: 8
    },
    notes: 'Inspected on Sept 16 — equipment well-maintained, AC working, Wi-Fi reliable.'
  },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { scores, notes } = req.body || {};
    if (!scores) return res.status(400).json({ error: 'scores_required' });
    const result = svc.scoreGymRubric({
      gymId: req.params.id,
      scores,
      scoredBy: req.user?.sub,
      notes
    });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const adminGetGymRubric = {
  created, method: 'get', path: '/admin/gyms/:id/rubric',
  description: 'Admin: view a gym\'s current rubric score, tier, and pillar breakdown.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const rubric = svc.getGymRubric(req.params.id);
    if (!rubric) return res.status(404).json({ error: 'gym_not_found' });
    res.json(rubric);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ROAMING COMPENSATION
// ═══════════════════════════════════════════════════════════════════════════
export const adminGetRoamingRates = {
  created, method: 'get', path: '/admin/gyms/:id/roaming-rates',
  description: 'Admin: get roaming compensation rates for a specific gym.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    res.json(svc.getRoamingRates(req.params.id));
  }
};

export const adminSetRoamingRates = {
  created, method: 'post', path: '/admin/gyms/:id/roaming-rates',
  description: 'Admin: set roaming compensation rates (daily scan fee, weekly/monthly pass fee, commission %).',
  requestSample: {
    dailyScanFee: 12000,
    weeklyPassFee: 45000,
    monthlyPassFee: 90000,
    commissionRate: 0.15
  },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { dailyScanFee, weeklyPassFee, monthlyPassFee, commissionRate } = req.body || {};
    const result = svc.setRoamingRates({
      gymId: req.params.id,
      dailyScanFee,
      weeklyPassFee,
      monthlyPassFee,
      commissionRate,
      adminId: req.user?.sub
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// COMMISSION RATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
export const adminSetCommissionRate = {
  created, method: 'post', path: '/admin/commission',
  description: 'Admin: set commission rate for a gym, trainer, or vendor (10-25% range).',
  requestSample: { entityType: 'gym', entityId: 'gym_001', commissionRate: 0.15 },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { entityType, entityId, commissionRate } = req.body || {};
    if (!entityType || !entityId || commissionRate === undefined)
      return res.status(400).json({ error: 'entityType_entityId_and_commissionRate_required' });
    const result = svc.setCommissionRate({
      entityType, entityId,
      commissionRate: Number(commissionRate),
      adminId: req.user?.sub
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const adminCommissionRange = {
  created, method: 'get', path: '/admin/commission/range',
  description: 'Admin: get the allowed commission rate range (min, max, default).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => {
    res.json({ ...COMMISSION_RANGE });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// B2B CONTRACT ADMINISTRATION
// ═══════════════════════════════════════════════════════════════════════════
export const adminListContracts = {
  created, method: 'get', path: '/admin/contracts',
  description: 'Admin: list B2B contracts. ?status=draft|active|expired|terminated',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { status, corporateAccountId, limit } = req.query || {};
    const list = svc.listContracts({
      status,
      corporateAccountId,
      limit: limit ? Number(limit) : 50
    });
    res.json(list);
  }
};

export const adminCreateContract = {
  created, method: 'post', path: '/admin/contracts',
  description: 'Admin: create a new B2B contract for a corporate account.',
  requestSample: {
    corporateAccountId: 'crp_001', contractName: 'CRDB Wellness 2026',
    seatLimit: 500, perSeatCap: 350000,
    domainWhitelist: ['@crdbbank.co.tz'],
    endDate: '2026-12-31'
  },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.createContract({ ...req.body || {}, adminId: req.user?.sub });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  }
};

export const adminActivateContract = {
  created, method: 'post', path: '/admin/contracts/:id/activate',
  description: 'Admin: activate (sign) a B2B contract (draft → active).',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const result = svc.activateContract(req.params.id, req.user?.sub);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const adminTerminateContract = {
  created, method: 'post', path: '/admin/contracts/:id/terminate',
  description: 'Admin: terminate a B2B contract.',
  requestSample: { reason: 'Contract expired — not renewed' },
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { reason } = req.body || {};
    const result = svc.terminateContract(req.params.id, req.user?.sub, reason);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  }
};

export const adminGetContract = {
  created, method: 'get', path: '/admin/contracts/:id',
  description: 'Admin: view a single B2B contract.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const contract = svc.getContract(req.params.id);
    if (!contract) return res.status(404).json({ error: 'contract_not_found' });
    res.json(contract);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════
export const adminAuditLog = {
  created, method: 'get', path: '/admin/audit-log',
  description: 'Admin: immutable audit log. ?action=, ?actor=, ?target=, ?limit=, ?offset=',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (req, res) => {
    const { action, actor, target, limit, offset } = req.query || {};
    const list = svc.getAuditLog({
      action, actor, target,
      limit: limit ? Number(limit) : 100,
      offset: offset ? Number(offset) : 0
    });
    const count = svc.getAuditLogCount({ action, actor, target });
    res.json({ entries: list, total: count });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PARTNER VETTING QUEUES
// ═══════════════════════════════════════════════════════════════════════════
export const adminPendingGyms = {
  created, method: 'get', path: '/admin/pending/gyms',
  description: 'Admin: list unverified gyms awaiting classification.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => res.json(svc.getPendingGyms())
};

export const adminPendingTrainers = {
  created, method: 'get', path: '/admin/pending/trainers',
  description: 'Admin: list unverified trainers awaiting certification review.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => res.json(svc.getPendingTrainers())
};

export const adminPendingVendors = {
  created, method: 'get', path: '/admin/pending/vendors',
  description: 'Admin: list vendors awaiting approval.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => res.json(svc.getPendingVendors())
};

export const adminPendingCorporates = {
  created, method: 'get', path: '/admin/pending/corporates',
  description: 'Admin: list corporate accounts pending activation.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => res.json(svc.getPendingCorporates())
};

// ═══════════════════════════════════════════════════════════════════════════
// PITCH DECK
// ═══════════════════════════════════════════════════════════════════════════
export const adminPitchDeck = {
  created, method: 'get', path: '/admin/pitch-deck',
  description: 'Admin: get the built-in pitch deck slides for presentations.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => res.json(svc.getPitchDeck())
};

// ═══════════════════════════════════════════════════════════════════════════
// PLATFORM OVERVIEW KPIs
// ═══════════════════════════════════════════════════════════════════════════
export const adminPlatformOverview = {
  created, method: 'get', path: '/admin/overview',
  description: 'Admin: platform-wide KPIs — gyms, trainers, vendors, corporates, by status.',
  onGuard: requireAuth ? requireAuth('admin') : undefined,
  onRequest: (_, res) => res.json(svc.getPlatformOverview())
};
