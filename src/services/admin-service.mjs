// FitFlex Af — Admin Portal Service (clean architecture + DI)
//
// Capabilities:
//   - 5-pillar gym classification rubric (score, auto-assign tier, audit)
//   - Roaming compensation controls (set per-gym daily/weekly/monthly rates)
//   - Commission rate management (per gym, trainer, vendor — 10-25% range)
//   - B2B contract administration (create, activate, terminate, whitelist)
//   - Audit log (immutable activity feed with filtering)
//   - Partner vetting queues (gyms, trainers, vendors, corporates)
//   - Pitch deck (static slide data for the built-in presentation)

import { randomUUID } from 'node:crypto';
import {
  RUBRIC_PILLARS,
  TIER_THRESHOLDS,
  assignTierFromScore,
  validateRubricScores,
  ROAMING_DEFAULTS,
  COMMISSION_RANGE,
  CONTRACT_STATUS,
  AUDIT_ACTIONS,
  PITCH_DECK_SLIDES
} from '../shared/admin-constants.mjs';

export function createAdminService({ gyms, trainers, vendors, corporateAccounts, auditLog, roamingRates, b2bContracts }) {

  // ─── 5-Pillar Classification Rubric ──────────────────────────────────────

  function scoreGymRubric({ gymId, scores, scoredBy, notes }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { ok: false, error: 'gym_not_found' };

    const validation = validateRubricScores(scores);
    if (!validation.valid) return { ok: false, error: validation.error };

    const { scores: validatedScores, total } = validation;
    const previousTier = gym.tier || gym.verifiedClassification || 'standard';
    const newTier = assignTierFromScore(total);
    const tierChanged = previousTier !== newTier;

    const rubricRecord = {
      gymId,
      scores: validatedScores,
      totalScore: total,
      previousTier,
      newTier,
      tierChanged,
      scoredBy: scoredBy || 'admin',
      notes: notes || null,
      scoredAt: new Date().toISOString()
    };

    // Update gym record with new tier and score
    gyms.update(g => g.id === gymId, {
      verifiedScore: total,
      verifiedClassification: newTier,
      verifiedAt: new Date().toISOString(),
      verificationRubric: JSON.stringify(validatedScores)
    });

    // Audit log — always log the scoring
    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: scoredBy, action: AUDIT_ACTIONS.RUBRIC_SCORED,
      target: gymId,
      before: { tier: previousTier },
      after: { tier: newTier, score: total, scores: validatedScores }
    });

    // If tier changed, log that too
    if (tierChanged) {
      auditLog?.insert({
        id: randomUUID(), at: new Date().toISOString(),
        actor: scoredBy, action: AUDIT_ACTIONS.GYM_TIER_CHANGED,
        target: gymId,
        before: { tier: previousTier },
        after: { tier: newTier, score: total }
      });
    }

    return { ok: true, rubric: rubricRecord, tierChanged, newTier };
  }

  function getGymRubric(gymId) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return null;
    return {
      gymId,
      name: gym.name,
      currentTier: gym.verifiedClassification || gym.tier || 'standard',
      currentScore: gym.verifiedScore || null,
      verifiedAt: gym.verifiedAt || null,
      rubricScores: gym.verificationRubric ? JSON.parse(gym.verificationRubric) : null,
      pillars: Object.values(RUBRIC_PILLARS)
    };
  }

  function getRubricPillars() {
    return Object.values(RUBRIC_PILLARS);
  }

  // ─── Roaming Compensation Controls ────────────────────────────────────────

  function setRoamingRates({ gymId, dailyScanFee, weeklyPassFee, monthlyPassFee, commissionRate, adminId }) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { ok: false, error: 'gym_not_found' };

    if (commissionRate !== undefined) {
      if (typeof commissionRate !== 'number' || commissionRate < COMMISSION_RANGE.min || commissionRate > COMMISSION_RANGE.max)
        return { ok: false, error: `commissionRate must be between ${COMMISSION_RANGE.min} and ${COMMISSION_RANGE.max}` };
    }

    const rates = {
      id: `rmt_${randomUUID().slice(0, 8)}`,
      gymId,
      dailyScanFee: dailyScanFee ?? ROAMING_DEFAULTS.daily_scan_fee,
      weeklyPassFee: weeklyPassFee ?? ROAMING_DEFAULTS.weekly_pass_fee,
      monthlyPassFee: monthlyPassFee ?? ROAMING_DEFAULTS.monthly_pass_fee,
      commissionRate: commissionRate ?? ROAMING_DEFAULTS.commission_rate,
      updatedAt: new Date().toISOString(),
      updatedBy: adminId || 'admin'
    };

    // Upsert — replace existing rates for this gym
    const existing = roamingRates.find(r => r.gymId === gymId);
    if (existing) {
      roamingRates.update(r => r.gymId === gymId, rates);
    } else {
      roamingRates.insert(rates);
    }

    // Also update gym's commissionRate field
    if (commissionRate !== undefined) {
      gyms.update(g => g.id === gymId, { commissionRate });
    }

    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: adminId, action: AUDIT_ACTIONS.ROAMING_RATE_UPDATED,
      target: gymId, before: existing, after: rates
    });

    return { ok: true, rates };
  }

  function getRoamingRates(gymId) {
    const rates = roamingRates.find(r => r.gymId === gymId);
    if (!rates) return {
      gymId,
      dailyScanFee: ROAMING_DEFAULTS.daily_scan_fee,
      weeklyPassFee: ROAMING_DEFAULTS.weekly_pass_fee,
      monthlyPassFee: ROAMING_DEFAULTS.monthly_pass_fee,
      commissionRate: ROAMING_DEFAULTS.commission_rate,
      note: 'Using defaults — no custom rates set'
    };
    return rates;
  }

  // ─── Commission Rate Management ───────────────────────────────────────────

  function setCommissionRate({ entityType, entityId, commissionRate, adminId }) {
    if (!['gym', 'trainer', 'vendor'].includes(entityType))
      return { ok: false, error: 'invalid_entity_type' };
    if (typeof commissionRate !== 'number' || commissionRate < COMMISSION_RANGE.min || commissionRate > COMMISSION_RANGE.max)
      return { ok: false, error: `commissionRate must be between ${COMMISSION_RANGE.min} and ${COMMISSION_RANGE.max}` };

    let collection, nameField;
    if (entityType === 'gym') { collection = gyms; nameField = 'name'; }
    else if (entityType === 'trainer') { collection = trainers; nameField = 'name'; }
    else { collection = vendors; nameField = 'name'; }

    const entity = collection.find(e => e.id === entityId);
    if (!entity) return { ok: false, error: `${entityType}_not_found` };

    const previous = entity.commissionRate;
    collection.update(e => e.id === entityId, { commissionRate });

    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: adminId, action: AUDIT_ACTIONS.COMMISSION_UPDATED,
      target: entityId,
      before: { commissionRate: previous },
      after: { commissionRate, entityType, entityName: entity[nameField] }
    });

    return { ok: true, entityType, entityId, previousRate: previous, newRate: commissionRate };
  }

  // ─── B2B Contract Administration ─────────────────────────────────────────

  function createContract({ corporateAccountId, contractName, seatLimit, perSeatCap, domainWhitelist, startDate, endDate, adminId }) {
    const account = corporateAccounts.find(a => a.id === corporateAccountId);
    if (!account) return { ok: false, error: 'corporate_account_not_found' };

    const contract = {
      id: `ctr_${randomUUID().slice(0, 8)}`,
      corporateAccountId,
      contractName: contractName || `${account.companyName} Wellness Contract`,
      seatLimit: seatLimit || 100,
      perSeatCap: perSeatCap || 350000,  // max per-seat monthly cost (Executive tier)
      domainWhitelist: domainWhitelist || [],
      startDate: startDate || new Date().toISOString().split('T')[0],
      endDate: endDate || null,
      status: CONTRACT_STATUS.DRAFT,
      signedBy: null,
      signedAt: null,
      createdAt: new Date().toISOString(),
      createdBy: adminId
    };

    b2bContracts.insert(contract);
    return { ok: true, contract };
  }

  function activateContract(contractId, adminId) {
    const contract = b2bContracts.find(c => c.id === contractId);
    if (!contract) return { ok: false, error: 'contract_not_found' };
    if (contract.status === CONTRACT_STATUS.ACTIVE)
      return { ok: false, error: 'already_active' };

    const updated = b2bContracts.update(c => c.id === contractId, {
      status: CONTRACT_STATUS.ACTIVE,
      signedBy: adminId,
      signedAt: new Date().toISOString()
    });

    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: adminId, action: AUDIT_ACTIONS.CONTRACT_SIGNED,
      target: contractId, before: contract, after: updated
    });

    return { ok: true, contract: updated };
  }

  function terminateContract(contractId, adminId, reason) {
    const updated = b2bContracts.update(c => c.id === contractId, {
      status: CONTRACT_STATUS.TERMINATED,
      terminatedAt: new Date().toISOString(),
      terminatedBy: adminId,
      terminationReason: reason || null
    });

    auditLog?.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: adminId, action: AUDIT_ACTIONS.CONTRACT_TERMINATED,
      target: contractId, after: updated
    });

    return { ok: true, contract: updated };
  }

  function listContracts({ status, corporateAccountId, limit = 50 } = {}) {
    let list = b2bContracts.all ? b2bContracts.all() : b2bContracts.filter(() => true);
    if (status) list = list.filter(c => c.status === status);
    if (corporateAccountId) list = list.filter(c => c.corporateAccountId === corporateAccountId);
    return list
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, limit)
      .map(c => {
        const account = corporateAccounts.find(a => a.id === c.corporateAccountId);
        return { ...c, companyName: account?.companyName || null };
      });
  }

  function getContract(contractId) {
    const contract = b2bContracts.find(c => c.id === contractId);
    if (!contract) return null;
    const account = corporateAccounts.find(a => a.id === contract.corporateAccountId);
    return { ...contract, companyName: account?.companyName || null };
  }

  // ─── Audit Log ──────────────────────────────────────────────────────────────

  function getAuditLog({ action, actor, target, limit = 100, offset = 0 } = {}) {
    let list = auditLog?.all ? auditLog.all() : (auditLog?.filter ? auditLog.filter(() => true) : []);
    if (action) list = list.filter(l => l.action === action);
    if (actor) list = list.filter(l => l.actor === actor);
    if (target) list = list.filter(l => l.target === target);
    return list
      .sort((a, b) => +new Date(b.at) - +new Date(a.at))
      .slice(offset, offset + limit);
  }

  function getAuditLogCount({ action, actor, target } = {}) {
    let list = auditLog?.all ? auditLog.all() : (auditLog?.filter ? auditLog.filter(() => true) : []);
    if (action) list = list.filter(l => l.action === action);
    if (actor) list = list.filter(l => l.actor === actor);
    if (target) list = list.filter(l => l.target === target);
    return list.length;
  }

  // ─── Partner Vetting Queues ────────────────────────────────────────────────

  function getPendingGyms() {
    return gyms
      .filter(g => g.status === 'active' && !g.isVerified)
      .map(g => ({
        id: g.id, name: g.name, location: g.location,
        tier: g.tier || g.verifiedClassification || 'standard',
        submittedAt: g.createdAt || null,
        amenities: g.amenities || []
      }));
  }

  function getPendingTrainers() {
    if (!trainers?.filter) return [];
    return trainers
      .filter(t => t.status === 'active' && !t.isVerified)
      .map(t => ({
        id: t.id, name: t.name,
        specializations: t.specializations || [],
        certifications: t.certifications || [],
        yearsExperience: t.yearsExperience || 0
      }));
  }

  function getPendingVendors() {
    if (!vendors?.filter) return [];
    return vendors
      .filter(v => v.status === 'pending')
      .map(v => ({
        id: v.id, name: v.name || v.businessName,
        email: v.email, phone: v.phone,
        city: v.city, taxId: v.taxId
      }));
  }

  function getPendingCorporates() {
    if (!corporateAccounts?.filter) return [];
    return corporateAccounts
      .filter(a => a.status === 'pending')
      .map(a => ({
        id: a.id, companyName: a.companyName,
        industrySector: a.industrySector,
        workforceBracket: a.workforceBracket
      }));
  }

  // ─── Pitch Deck ──────────────────────────────────────────────────────────────

  function getPitchDeck() {
    return PITCH_DECK_SLIDES;
  }

  // ─── Platform Overview KPIs ────────────────────────────────────────────────

  function getPlatformOverview() {
    const allGyms = gyms.all ? gyms.all() : gyms.filter(() => true);
    const allTrainers = trainers?.all ? trainers.all() : (trainers?.filter ? trainers.filter(() => true) : []);
    const allVendors = vendors?.all ? vendors.all() : (vendors?.filter ? vendors.filter(() => true) : []);
    const allCorporates = corporateAccounts?.all ? corporateAccounts.all() : (corporateAccounts?.filter ? corporateAccounts.filter(() => true) : []);

    const gymsByTier = {};
    for (const g of allGyms) {
      const tier = g.verifiedClassification || g.tier || 'standard';
      gymsByTier[tier] = (gymsByTier[tier] || 0) + 1;
    }

    return {
      gyms: {
        total: allGyms.length,
        verified: allGyms.filter(g => g.isVerified).length,
        pending: allGyms.filter(g => !g.isVerified).length,
        byTier: gymsByTier
      },
      trainers: {
        total: allTrainers.length,
        verified: allTrainers.filter(t => t.isVerified).length,
        pending: allTrainers.filter(t => !t.isVerified).length
      },
      vendors: {
        total: allVendors.length,
        active: allVendors.filter(v => v.status === 'active').length,
        pending: allVendors.filter(v => v.status === 'pending').length
      },
      corporates: {
        total: allCorporates.length,
        active: allCorporates.filter(a => a.status === 'active').length,
        pending: allCorporates.filter(a => a.status === 'pending').length
      },
      auditLogCount: getAuditLogCount()
    };
  }

  return {
    // Rubric
    scoreGymRubric, getGymRubric, getRubricPillars,
    // Roaming
    setRoamingRates, getRoamingRates,
    // Commission
    setCommissionRate,
    // Contracts
    createContract, activateContract, terminateContract, listContracts, getContract,
    // Audit log
    getAuditLog, getAuditLogCount,
    // Vetting queues
    getPendingGyms, getPendingTrainers, getPendingVendors, getPendingCorporates,
    // Pitch deck
    getPitchDeck,
    // Overview
    getPlatformOverview,
    // Constants
    _constants: {
      RUBRIC_PILLARS, TIER_THRESHOLDS, assignTierFromScore,
      validateRubricScores, ROAMING_DEFAULTS, COMMISSION_RANGE,
      CONTRACT_STATUS, AUDIT_ACTIONS, PITCH_DECK_SLIDES
    }
  };
}
