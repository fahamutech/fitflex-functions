// Settlement rows — pure mapping from a settlement-engine result to the rows
// of the settlement tables (settlement Phase 2, PR 3). No I/O: the future
// settlement writer inserts what these return, inside one transaction.
//
//   calculateMemberSettlement(...) result
//     → one MemberCycleSettlement row
//     → one GymSettlementLine per gym the member used
//     → one SettlementVisit per check-in considered
//
// Ids come from the caller's `newId()` so the mapping stays deterministic in
// tests and replayable in shadow runs.

/**
 * @param {Object} result   calculateMemberSettlement() output
 * @param {Object} ctx
 * @param {string} ctx.runId
 * @param {'live'|'shadow'} ctx.mode
 * @param {(gymId: string) => string} ctx.gymSettlementIdFor  the gym's statement in this run
 * @param {() => string} ctx.newId
 * @param {{ passTierVersion?: number|null, catalogPriceTzs?: number|null }} [ctx.terms]  pass snapshot (resolveMemberCycleTerms)
 */
export function settlementRowsFromResult(result, { runId, mode, gymSettlementIdFor, newId, terms = {} }) {
  const m = result.member;
  const memberCycle = {
    id: newId(), runId, mode,
    memberId: m.memberId,
    subscriptionId: m.subscriptionId ?? m.cycleId,
    cycleStart: m.cycleStart,
    cycleEnd: m.cycleEnd,
    passTier: m.passTier,
    passTierVersion: terms.passTierVersion ?? null,
    catalogPriceTzs: terms.catalogPriceTzs ?? null,
    visitAllowance: m.visitAllowance,
    collectedApprovedAmountTzs: m.collectedApprovedAmountTzs,
    networkPayoutBps: m.networkPayoutBps,
    networkCapTzs: m.networkCapTzs,
    totalPreliminaryTzs: m.totalPreliminaryTzs,
    totalFinalTzs: m.totalFinalTzs,
    networkAdjustmentTzs: m.networkAdjustmentTzs,
    capApplied: m.capApplied,
    payableVisitCount: m.payableVisitCount,
    heldVisitCount: m.heldVisitCount,
    excludedVisitCount: m.excludedVisitCount,
    engineVersion: result.engineVersion,
    explanation: {
      cycleStartDate: m.cycleStartDate, cycleEndDate: m.cycleEndDate, finalizableAt: m.finalizableAt,
      retainedHeadroomTzs: m.retainedHeadroomTzs, settleable: m.settleable, warnings: result.warnings
    },
    active: true
  };

  const lineIdByGym = new Map();
  const lines = result.gyms.map(g => {
    const id = newId();
    lineIdByGym.set(g.gymId, id);
    return {
      id, runId, mode,
      gymSettlementId: gymSettlementIdFor(g.gymId),
      memberCycleSettlementId: memberCycle.id,
      memberId: m.memberId,
      gymId: g.gymId,
      qualifyingVisitCount: g.qualifyingVisitCount,
      heldVisitCount: g.heldVisitCount,
      bracket: g.bracket,
      rawPreliminaryTzs: g.rawPreliminaryTzs,
      preliminaryTzs: g.preliminaryTzs,
      monotonicGuardApplied: g.monotonicGuardApplied,
      networkAdjustmentTzs: g.networkAdjustmentTzs,
      finalTzs: g.finalTzs,
      rateCardSnapshot: g.rateCardSnapshot,
      calculationBasis: g.calculationBasis
    };
  });

  const visits = result.visits.map(v => ({
    id: newId(), runId, mode,
    memberCycleSettlementId: memberCycle.id,
    // Payable and held visits hang off their gym's line; excluded ones don't.
    lineId: v.outcome === 'excluded' ? null : (lineIdByGym.get(v.gymId) ?? null),
    checkinId: v.checkinId,
    gymId: v.gymId,
    businessDate: v.businessDate,
    outcome: v.outcome,
    eligibility: v.eligibility,
    allowanceSlot: v.allowanceSlot,
    active: true
  }));

  return { memberCycle, lines, visits };
}

/**
 * DR-20: a statement's net is never negative. A shortfall (for example a
 * clawback bigger than the month's earnings) is carried forward instead.
 */
export function statementNet({ preliminaryTzs, networkAdjustmentTzs, adjustmentsTzs = 0 }) {
  const sum = preliminaryTzs + networkAdjustmentTzs + adjustmentsTzs;
  return { finalNetTzs: Math.max(0, sum), carryForwardTzs: Math.min(0, sum) };
}

/** A gym statement's totals from its lines (and any applied adjustments). */
export function gymStatementTotals(lines, { adjustmentsTzs = 0 } = {}) {
  const sum = (f) => lines.reduce((s, l) => s + l[f], 0);
  const preliminaryTzs = sum('preliminaryTzs');
  const networkAdjustmentTzs = sum('networkAdjustmentTzs');
  return {
    memberCycleCount: new Set(lines.map(l => l.memberCycleSettlementId)).size,
    qualifyingVisitCount: sum('qualifyingVisitCount'),
    heldVisitCount: sum('heldVisitCount'),
    preliminaryTzs,
    networkAdjustmentTzs,
    adjustmentsTzs,
    ...statementNet({ preliminaryTzs, networkAdjustmentTzs, adjustmentsTzs })
  };
}
