// Settlement views (settlement Phase 5): what the admin screens and a gym
// owner see of a statement. Read-only.
//
// Admin: everything, with gym and member names added.
// Owner: their own gyms' live statements only — the period, visits, what was
// earned at the gym's own rates, the network adjustment as an amount,
// applied adjustments with their reasons, the net, where it stands and how it
// was paid. Never the commercial rules behind it (discounts, ceilings,
// network %), a member's subscription value or cap, another gym's figures,
// who prepared or approved it, or the wording of an internal hold.
import { db as defaultDb } from '../infra/knex-store.mjs';
import { ownerGymIds } from '../shared/member-status.mjs';

const fail = (error, status) => ({ error, status });

/** Where a statement stands, in the owner's terms. */
export const OWNER_STATEMENT_STATUS = Object.freeze({
  draft: 'preparing', submitted: 'in_review', approved: 'approved', payable: 'payment_due', paid: 'paid',
});
const OWNER_VISIBLE = Object.keys(OWNER_STATEMENT_STATUS);

export function createSettlementViewService({ db = defaultDb, gyms, users, publicUserId }) {
  const gymName = (gymId) => gyms.find((g) => g.id === gymId)?.name ?? null;

  /** memberId → { publicId, displayName } for the members behind some lines. */
  async function membersFor(lines) {
    const ids = [...new Set(lines.map((l) => l.memberId))];
    const rows = ids.length ? await users.filterByColumnInAsync('id', ids) : [];
    const out = new Map();
    for (const u of rows) out.set(u.id, { publicId: await publicUserId(u), displayName: u.displayName ?? null });
    return out;
  }

  async function fundingByCycle(lines) {
    const ids = [...new Set(lines.map((l) => l.memberCycleSettlementId))];
    const rows = ids.length ? await db('MemberCycleSettlement').whereIn('id', ids).select('id', 'fundingType') : [];
    return new Map(rows.map((r) => [r.id, r.fundingType]));
  }

  async function detail(id) {
    const statement = await db('GymSettlement').where({ id }).first();
    if (!statement) return null;
    const lines = await db('GymSettlementLine').where({ gymSettlementId: id }).orderBy('memberId');
    const visits = lines.length ? await db('SettlementVisit').whereIn('lineId', lines.map((l) => l.id)).orderBy(['businessDate', 'checkinId']) : [];
    const adjustments = await db('SettlementAdjustment').where({ gymSettlementId: id }).orderBy('createdAt');
    return { statement, lines, visits, adjustments, members: await membersFor(lines), funding: await fundingByCycle(lines) };
  }

  // ── admin ──────────────────────────────────────────────────────────────────

  const withGym = (s) => ({ ...s, gymName: gymName(s.gymId) });

  async function adminRun(id) {
    const run = await db('SettlementRun').where({ id }).first();
    if (!run) return fail('run_not_found', 404);
    const statements = await db('GymSettlement').where({ runId: id }).orderBy('gymId');
    return { run, statements: statements.map(withGym) };
  }

  async function adminStatement(id) {
    const d = await detail(id);
    if (!d) return fail('statement_not_found', 404);
    return {
      statement: withGym(d.statement),
      lines: d.lines.map((l) => ({ ...l, member: d.members.get(l.memberId) ?? null, fundingType: d.funding.get(l.memberCycleSettlementId) ?? null })),
      visits: d.visits,
      adjustments: d.adjustments,
    };
  }

  // ── owner ──────────────────────────────────────────────────────────────────

  function ownerSummary(s) {
    return {
      id: s.id, gymId: s.gymId, gymName: gymName(s.gymId),
      periodStartDate: s.periodStartDate, periodEndDate: s.periodEndDate,
      status: OWNER_STATEMENT_STATUS[s.status],
      onHold: !!s.holdReason,
      members: s.memberCycleCount, visits: s.qualifyingVisitCount,
      earnedTzs: s.preliminaryTzs, networkAdjustmentTzs: s.networkAdjustmentTzs, adjustmentsTzs: s.adjustmentsTzs,
      carriedForwardTzs: s.carryForwardTzs, payableTzs: s.finalNetTzs,
      paidAt: s.paidAt ?? null, paymentReference: s.status === 'paid' ? s.paymentReference : null,
      receiptUrl: s.status === 'paid' ? (s.receiptUrl ?? null) : null,
      payoutAccountLast4: s.status === 'paid' || s.status === 'payable' ? (s.destinationSnapshot?.accountLast4 ?? null) : null,
    };
  }

  /** The owner's (or their staff's) gyms' statements, newest period first. */
  async function ownerStatements({ owner, gymId = null }) {
    const owned = ownerGymIds(owner);
    const ids = gymId ? owned.filter((g) => g === gymId) : owned;
    if (!ids.length) return [];
    const rows = await db('GymSettlement').where({ mode: 'live' }).whereIn('gymId', ids).whereIn('status', OWNER_VISIBLE)
      .orderBy([{ column: 'periodStartDate', order: 'desc' }, { column: 'gymId' }]);
    return rows.map(ownerSummary);
  }

  async function ownerStatement({ owner, id }) {
    const d = await detail(id);
    // Not theirs, a shadow run or a voided statement all look the same: not found.
    if (!d || d.statement.mode !== 'live' || !OWNER_VISIBLE.includes(d.statement.status) || !ownerGymIds(owner).includes(d.statement.gymId)) {
      return fail('statement_not_found', 404);
    }
    const datesByLine = new Map();
    for (const v of d.visits) {
      if (v.outcome !== 'payable') continue;
      (datesByLine.get(v.lineId) || datesByLine.set(v.lineId, []).get(v.lineId)).push(v.businessDate);
    }
    return {
      statement: ownerSummary(d.statement),
      lines: d.lines.map((l) => {
        const sponsored = d.funding.get(l.memberCycleSettlementId) === 'b2b_benefit';
        return {
          memberCode: d.members.get(l.memberId)?.publicId ?? null,
          funding: sponsored ? 'sponsored' : 'pass',
          visits: l.qualifyingVisitCount,
          visitDates: datesByLine.get(l.id) || [],
          bracket: l.bracket,
          // The gym's own rates for this member's cycle, as agreed on its rate card.
          rates: l.rateCardSnapshot
            ? { dailyTzs: l.rateCardSnapshot.wholesaleDailyTzs, weeklyTzs: l.rateCardSnapshot.wholesaleWeeklyTzs, monthlyTzs: l.rateCardSnapshot.wholesaleMonthlyTzs }
            : null,
          earnedTzs: l.preliminaryTzs, networkAdjustmentTzs: l.networkAdjustmentTzs, finalTzs: l.finalTzs,
        };
      }),
      adjustments: d.adjustments.filter((a) => a.status === 'applied')
        .map((a) => ({ amountTzs: a.amountTzs, type: a.type, reason: a.reason, appliedAt: a.appliedAt ?? null })),
    };
  }

  return { adminRun, adminStatement, withGym, ownerStatements, ownerStatement };
}
