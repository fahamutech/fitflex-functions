// B2B Phase 3 — benefit evaluation and the consumption ledger.
//
//   existing usage event (Checkin, TrainerBooking)
//     → evaluate: is the member a beneficiary with an active, valid, eligible
//       benefit for this service and provider, with allowance left?
//     → consume: one benefit covers it (never two), split into sponsor and
//       beneficiary responsibility, written to B2BBenefitConsumption
//     → Phase 4 settlement reads approved rows (settlementCandidate)
//
// Everything is decided on the server from stored rules and the ledger; no
// caller supplies a benefit, an amount or a usage count. Nothing here computes
// a provider payout.
//
// Concurrency: each consumption runs in one transaction that locks the
// programme and benefit rows, re-reads usage from the ledger and inserts. The
// unique index on (sourceType, sourceId) for live rows makes a usage event
// consume at most once, whatever the callers do.
//
// Every change of a ledger row and its audit entry are written in the same
// transaction: there is no ledger change without its audit, and no audit
// failure after the fact.
import { randomUUID } from 'node:crypto';
import {
  LIVE_CONSUMPTION_STATUSES, USAGE_SOURCES, programEffectiveStatus, evaluateEligibility, calculateResponsibility,
  usageWindow, providerMatches, orderCandidates, applyAllowance, settlementCandidate, benefitValidity, describeFunding,
  gymVisitValueTzs,
} from '../shared/b2b-programs.mjs';
import { localDay } from '../shared/member-progress.mjs';

const TABLE = 'B2BBenefitConsumption';
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
// Allowance-type refusals are worth keeping for support; "not eligible at all" is not.
const RECORDED_REJECTIONS = new Set(['usage_limit_reached', 'period_sponsor_cap_reached', 'program_budget_exhausted', 'member_share_not_collectable']);

export function createB2BConsumptionService({
  db, programs, benefits, users, gyms, trainers, checkins, trainerBookings, auditLog, b2bService,
  // Voids a gym check-in (and so releases what it used and claws back what a gym was paid for it).
  voidCheckin = null,
  now = () => new Date(),
}) {
  const stamp = () => now().toISOString();

  /** An audit entry that must not fail the caller (the change it describes is already stored). */
  async function audit({ actor, action, target, before = null, after = null }) {
    try {
      await auditLog.insertAsync({ id: randomUUID(), at: stamp(), actor, action, target, before, after });
    } catch (err) {
      console.warn(`[b2b-usage] audit ${action} for ${target} not written:`, err?.message);
    }
  }
  /** An audit entry written in the same transaction as the ledger change it describes. */
  const auditIn = (trx, { actor, action, target, before = null, after = null }) => trx('AuditLog').insert({
    id: randomUUID(), at: new Date(stamp()), actor, action, target,
    before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });

  // ── Ledger reads ──────────────────────────────────────────────────────────

  /** Uses and sponsor money a beneficiary already holds on a benefit inside a window. */
  async function usedInWindow(q, { benefitId, beneficiaryId, window }) {
    let query = q(TABLE).where({ benefitId, beneficiaryId }).whereIn('status', LIVE_CONSUMPTION_STATUSES);
    if (window) {
      query = query.where('businessDate', '>=', window.start);
      if (window.end) query = query.where('businessDate', '<=', window.end);
    }
    const [row] = await query.sum({ quantity: 'quantity', sponsorTzs: 'sponsorTzs' });
    return { quantity: Number(row.quantity) || 0, sponsorTzs: Number(row.sponsorTzs) || 0 };
  }

  /** Sponsor money a programme has committed so far (pending + approved). */
  async function sponsorSpentForProgram(programId, q = db) {
    const [row] = await q(TABLE).where({ programId }).whereIn('status', LIVE_CONSUMPTION_STATUSES).sum({ sponsorTzs: 'sponsorTzs' });
    return Number(row.sponsorTzs) || 0;
  }

  const liveForSource = (q, sourceType, sourceId) =>
    q(TABLE).where({ sourceType, sourceId }).whereIn('status', LIVE_CONSUMPTION_STATUSES).first();

  // ── Evaluation ────────────────────────────────────────────────────────────

  /**
   * Every benefit of this service type the user could draw on, each with the
   * outcome of the eligibility and provider checks. Two queries whatever the
   * number of organisations.
   */
  async function candidatesFor({ userId, serviceType, provider, day }) {
    const active = (await b2bService.beneficiaryRelationshipsForUser(userId))
      .filter(r => r.organization.status === 'active');
    if (!active.length) return [];
    // An organisation FitFlex has put on hold for late payment funds nothing until the hold is lifted.
    const held = new Set((await db('B2BBillingAccount').where({ onHold: true }).whereIn('organizationId', active.map(r => r.organization.id)).select('organizationId')).map(r => r.organizationId));
    const relationships = active.filter(r => !held.has(r.organization.id));
    if (!relationships.length) return [];
    const byOrg = new Map(relationships.map(r => [r.organization.id, r]));
    const orgPrograms = await programs.filterByColumnInAsync('organizationId', [...byOrg.keys()]);
    if (!orgPrograms.length) return [];
    const programById = new Map(orgPrograms.map(p => [p.id, p]));
    const rows = (await benefits.filterByColumnInAsync('programId', [...programById.keys()]))
      .filter(b => b.benefitType === serviceType);

    return rows.map((benefit) => {
      const program = programById.get(benefit.programId);
      const { organization, beneficiary } = byOrg.get(program.organizationId);
      let { eligible, reason } = evaluateEligibility({ program, benefit, beneficiary, day });
      if (eligible && provider && !providerMatches(benefit, provider)) { eligible = false; reason = 'provider_not_eligible'; }
      return { organization, beneficiary, program, benefit, eligible, reason };
    });
  }

  const summary = c => ({
    organization: { id: c.organization.id, name: c.organization.tradingName || c.organization.legalName, organizationType: c.organization.organizationType },
    program: { id: c.program.id, name: c.program.name },
    benefit: { id: c.benefit.id, name: c.benefit.name, benefitType: c.benefit.benefitType, fundingSummary: describeFunding(c.benefit) },
    beneficiaryId: c.beneficiary.id,
  });

  /**
   * Dry run: what would happen if this usage were consumed now. Writes
   * nothing. `chosen` is the benefit the selection rule would apply.
   */
  async function evaluate({ userId, serviceType, provider, grossTzs, quantity = 1, at = now() }) {
    const day = localDay(at);
    const all = await candidatesFor({ userId, serviceType, provider, day });
    const eligible = orderCandidates(all.filter(c => c.eligible).map(c => ({ ...c, split: calculateResponsibility({ benefit: c.benefit, priceTzs: grossTzs }) })));
    const outcomes = [];
    let chosen = null;
    for (const c of eligible) {
      const window = usageWindow({ benefit: c.benefit, program: c.program, day });
      const used = await usedInWindow(db, { benefitId: c.benefit.id, beneficiaryId: c.beneficiary.id, window });
      const applied = applyAllowance({ benefit: c.benefit, split: c.split, quantity, used });
      let outcome = applied.ok
        ? { ...summary(c), eligible: true, reason: null, sponsorTzs: applied.sponsorTzs, beneficiaryTzs: applied.beneficiaryTzs, remaining: applied.remaining, window }
        : { ...summary(c), eligible: false, reason: applied.reason, window };
      if (applied.ok && c.program.budgetTzs !== null && c.program.budgetTzs !== undefined
        && (await sponsorSpentForProgram(c.program.id)) + applied.sponsorTzs > c.program.budgetTzs) {
        outcome = { ...summary(c), eligible: false, reason: 'program_budget_exhausted', window };
      }
      outcomes.push(outcome);
      if (outcome.eligible && !chosen) chosen = outcome;
    }
    for (const c of all.filter(x => !x.eligible)) outcomes.push({ ...summary(c), eligible: false, reason: c.reason });
    return { asOf: day, serviceType, provider: { type: provider.type, id: provider.id }, grossTzs, covered: !!chosen, chosen, candidates: outcomes };
  }

  /** Back-office dry run by ids: the provider and (for a gym) the value come from the stored records. */
  async function adminEvaluate({ body = {} }) {
    const user = body.userId ? await users.findByIdAsync(body.userId) : null;
    if (!user) return fail('user_not_found', 404);
    if (body.serviceType === 'gym_access') {
      const gym = gyms.find(g => g.id === body.providerId);
      if (!gym) return fail('provider_not_found', 404);
      return evaluate({ userId: user.id, serviceType: 'gym_access', provider: { type: 'gym', id: gym.id, tier: gym.tier }, grossTzs: gymVisitValueTzs(gym) });
    }
    if (body.serviceType === 'trainer_session') {
      const trainer = trainers.find(t => t.id === body.providerId);
      if (!trainer) return fail('provider_not_found', 404);
      const grossTzs = Number.isInteger(body.grossTzs) && body.grossTzs >= 0 ? body.grossTzs : Math.max(0, Math.round(Number(trainer.hourlyRateTzs) || 0));
      return evaluate({ userId: user.id, serviceType: 'trainer_session', provider: { type: 'trainer', id: trainer.id }, grossTzs });
    }
    return fail('unsupported_service_type', 400, { allowed: ['gym_access', 'trainer_session'] });
  }

  // ── Consumption ───────────────────────────────────────────────────────────

  async function recordRejection({ c, reason, base }) {
    if (!RECORDED_REJECTIONS.has(reason)) return;
    const same = await db(TABLE).where({
      benefitId: c.benefit.id, beneficiaryId: c.beneficiary.id, sourceType: base.sourceType,
      providerId: base.providerId, businessDate: base.businessDate, status: 'rejected', rejectionReason: reason,
    }).first('id');
    if (same) return;
    await db(TABLE).insert({
      ...base, id: `b2bc_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      organizationId: c.organization.id, programId: c.program.id, benefitId: c.benefit.id,
      beneficiaryId: c.beneficiary.id, beneficiarySource: c.beneficiary.source,
      sponsorTzs: 0, beneficiaryTzs: base.grossTzs, status: 'rejected', rejectionReason: reason,
    });
  }

  /**
   * Try to cover one existing usage event with a B2B benefit.
   *
   * @param {object} args
   * @param {string} args.userId       who used the service
   * @param {'gym_checkin'|'trainer_booking'} args.sourceType
   * @param {string} args.sourceId     the usage event's id (idempotency key)
   * @param {{ type: string, id: string, tier?: string }} args.provider
   * @param {number} args.grossTzs     the service's value, from the server-side record
   * @param {boolean} [args.hold]      true: write `pending` (the caller confirms once the event exists)
   * @returns {{ consumed: true, consumption, remaining } | { consumed: false, reason }}
   */
  async function consume({ userId, sourceType, sourceId, provider, grossTzs, quantity = 1, at = now(), hold = false, actor = 'system', metadata = null }) {
    const source = USAGE_SOURCES[sourceType];
    if (!source) throw new Error(`unknown usage source: ${sourceType}`);
    if (!Number.isInteger(grossTzs) || grossTzs < 0 || !Number.isInteger(quantity) || quantity < 1) throw new Error('invalid usage value');

    const existing = await liveForSource(db, sourceType, sourceId);
    if (existing) return { consumed: true, consumption: existing, idempotent: true };

    const day = localDay(at);
    const all = await candidatesFor({ userId, serviceType: source.serviceType, provider, day });
    const ordered = orderCandidates(all.filter(c => c.eligible)
      .map(c => ({ ...c, split: calculateResponsibility({ benefit: c.benefit, priceTzs: grossTzs }) })));
    if (!ordered.length) return { consumed: false, reason: all[0]?.reason ?? 'no_benefit' };

    const consumedAt = new Date(at).toISOString();
    const base = {
      userId, sourceType, sourceId, serviceType: source.serviceType, providerType: provider.type, providerId: provider.id,
      consumedAt, businessDate: day, quantity, unitValueTzs: Math.round(grossTzs / quantity), grossTzs, initiatedBy: actor,
      metadata: metadata ? JSON.stringify(metadata) : null,
    };

    let firstRefusal = null;
    for (const c of ordered) {
      let outcome;
      try {
        outcome = await db.transaction(async (trx) => {
          // Serialise everything that draws on this programme's budget and this benefit's allowance.
          const program = await trx('B2BWellnessProgram').where({ id: c.program.id }).forUpdate().first();
          const benefit = await trx('B2BBenefit').where({ id: c.benefit.id }).forUpdate().first();
          if (!program || !benefit) return { refused: 'no_benefit' };
          if (programEffectiveStatus(program, day) !== 'active') return { refused: 'program_not_active' };
          if (benefit.status !== 'active') return { refused: 'benefit_not_active' };

          const again = await liveForSource(trx, sourceType, sourceId);
          if (again) return { row: again, idempotent: true };

          const window = usageWindow({ benefit, program, day });
          const used = await usedInWindow(trx, { benefitId: benefit.id, beneficiaryId: c.beneficiary.id, window });
          const applied = applyAllowance({ benefit, split: calculateResponsibility({ benefit, priceTzs: grossTzs }), quantity, used });
          if (!applied.ok) return { refused: applied.reason };

          if (program.budgetTzs !== null && program.budgetTzs !== undefined) {
            const spent = await sponsorSpentForProgram(program.id, trx);
            if (spent + applied.sponsorTzs > program.budgetTzs) {
              // Out of budget: the programme pauses until FitFlex resumes it.
              const pausedAt = stamp();
              await trx('B2BWellnessProgram').where({ id: program.id })
                .update({ status: 'paused', statusReason: 'budget_exhausted', statusChangedAt: new Date(pausedAt), updatedAt: new Date(pausedAt) });
              return { refused: 'program_budget_exhausted', paused: { programId: program.id, budgetTzs: program.budgetTzs, spentTzs: spent } };
            }
          }

          const row = {
            ...base, id: `b2bc_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
            organizationId: c.organization.id, programId: program.id, benefitId: benefit.id,
            beneficiaryId: c.beneficiary.id, beneficiarySource: c.beneficiary.source,
            sponsorTzs: applied.sponsorTzs, beneficiaryTzs: applied.beneficiaryTzs,
            status: hold ? 'pending' : 'approved', verifiedAt: hold ? null : consumedAt,
            rulesSnapshot: JSON.stringify({
              fundingType: benefit.fundingType, sponsorAmountTzs: benefit.sponsorAmountTzs, sponsorShareBps: benefit.sponsorShareBps,
              sponsorCapTzs: benefit.sponsorCapTzs, beneficiaryAmountTzs: benefit.beneficiaryAmountTzs,
              usageLimit: benefit.usageLimit, usagePeriod: benefit.usagePeriod, periodSponsorCapTzs: benefit.periodSponsorCapTzs,
              window, usedBefore: used, remainingAfter: applied.remaining,
              // The other benefits that could have covered it; exactly one is applied.
              alternatives: ordered.filter(o => o.benefit.id !== benefit.id).map(o => o.benefit.id),
            }),
          };
          const [inserted] = await trx(TABLE).insert(row).returning('*');
          await auditIn(trx, { actor, action: hold ? 'b2b.consumption.hold' : 'b2b.consumption.approve', target: inserted.id, after: inserted });
          return { row: inserted, remaining: applied.remaining };
        });
      } catch (err) {
        // Another request covered the same usage event first.
        if (err.code !== '23505') throw err;
        const winner = await liveForSource(db, sourceType, sourceId);
        if (winner) return { consumed: true, consumption: winner, idempotent: true };
        throw err;
      }

      if (outcome.row) {
        return { consumed: true, consumption: outcome.row, remaining: outcome.remaining ?? null, idempotent: !!outcome.idempotent, ...summary(c) };
      }
      if (outcome.paused) {
        await audit({ actor: 'system:b2b-budget', action: 'b2b.program.paused', target: outcome.paused.programId, after: { statusReason: 'budget_exhausted', ...outcome.paused } });
      }
      await recordRejection({ c, reason: outcome.refused, base });
      firstRefusal ??= outcome.refused;
    }
    return { consumed: false, reason: firstRefusal };
  }

  /** The usage event now exists and is verified: pending → approved. */
  async function confirm({ consumptionId, actor = 'system' }) {
    const row = await db(TABLE).where({ id: consumptionId }).first();
    if (!row) return fail('consumption_not_found', 404);
    if (row.status === 'approved') return { consumption: row, unchanged: true };
    if (row.status !== 'pending') return fail('invalid_transition', 409, { from: row.status, to: 'approved' });
    const at = new Date(stamp());
    const updated = await db.transaction(async (trx) => {
      const [u] = await trx(TABLE).where({ id: row.id, status: 'pending' }).update({ status: 'approved', verifiedAt: at, updatedAt: at }).returning('*');
      if (u) await auditIn(trx, { actor, action: 'b2b.consumption.approve', target: row.id, before: { status: 'pending' }, after: { status: 'approved' } });
      return u;
    });
    if (!updated) return fail('invalid_transition', 409, { to: 'approved' });
    return { consumption: updated };
  }

  /** The usage event never happened: pending → cancelled, releasing the allowance. */
  async function cancel({ consumptionId, reason, actor = 'system' }) {
    const row = await db(TABLE).where({ id: consumptionId }).first();
    if (!row) return fail('consumption_not_found', 404);
    if (row.status === 'cancelled') return { consumption: row, unchanged: true };
    if (row.status !== 'pending') return fail('invalid_transition', 409, { from: row.status, to: 'cancelled' });
    const at = new Date(stamp());
    const updated = await db.transaction(async (trx) => {
      const [u] = await trx(TABLE).where({ id: row.id, status: 'pending' })
        .update({ status: 'cancelled', metadata: JSON.stringify({ ...(row.metadata || {}), cancelReason: reason ?? null }), updatedAt: at }).returning('*');
      if (u) await auditIn(trx, { actor, action: 'b2b.consumption.cancel', target: row.id, before: { status: 'pending' }, after: { status: 'cancelled', reason } });
      return u;
    });
    if (!updated) return fail('invalid_transition', 409, { to: 'cancelled' });
    return { consumption: updated };
  }

  /**
   * Undo an approved consumption. The row stays, marked reversed with who,
   * when and why; it stops counting, so the allowance and the programme's
   * budget get it back. (A programme paused for budget stays paused.)
   *
   * A gym visit is undone as a whole: its check-in is voided, which reverses
   * this row and, if a gym was already paid for the visit, raises the
   * clawback. Reversing only the sponsor's charge would leave a visit nobody
   * pays for, or a gym paid for a visit the sponsor was refunded.
   * `mayVoidCheckin: false` refuses that for a caller without the permission.
   */
  async function reverse({ consumptionId, reason, actorId, mayVoidCheckin = true }) {
    const why = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    if (!why) return fail('reason_required', 400);
    const row = await db(TABLE).where({ id: consumptionId }).first();
    if (!row) return fail('consumption_not_found', 404);
    if (row.status === 'reversed') return { consumption: row, unchanged: true };
    if (row.status !== 'approved') return fail('invalid_transition', 409, { from: row.status, to: 'reversed' });

    if (row.sourceType === 'gym_checkin') {
      const checkin = await db('Checkin').where({ id: row.sourceId }).first();
      if (checkin && checkin.status !== 'voided') {
        if (!voidCheckin) return fail('checkin_must_be_voided', 409, { checkinId: checkin.id });
        // Voiding a visit can take money back from a gym: it needs the same permission as voiding it directly.
        if (!mayVoidCheckin) return fail('acl_forbidden', 403, { requiredScope: 'payments', checkinId: checkin.id });
        const voided = await voidCheckin({ checkinId: checkin.id, reason: why, actorId });
        if (voided?.error) return fail('checkin_not_voided', voided.status || 409, { checkinId: checkin.id, reason: voided.error });
        // Voiding released the visit's consumption; make sure of it.
        const after = await db(TABLE).where({ id: row.id }).first();
        if (after.status === 'reversed') return { consumption: after, checkinVoided: true };
      }
    }
    const at = new Date(stamp());
    const updated = await db.transaction(async (trx) => {
      const [u] = await trx(TABLE).where({ id: row.id, status: 'approved' })
        .update({ status: 'reversed', reversedAt: at, reversedBy: actorId, reversalReason: why, updatedAt: at }).returning('*');
      if (u) await auditIn(trx, { actor: actorId, action: 'b2b.consumption.reverse', target: row.id, before: row, after: u });
      return u;
    });
    if (!updated) return fail('invalid_transition', 409, { to: 'reversed' });
    return { consumption: updated };
  }

  /**
   * Settle holds a check-in left behind. A hold is written before the visit
   * and approved after it; if the process stopped in between, the hold would
   * keep an allowance without ever being charged or paid to the gym. A hold
   * older than a couple of minutes is approved when its visit exists, and
   * cancelled when it doesn't. Idempotent.
   */
  async function reconcileHolds({ olderThanMs = 120_000, limit = 500 } = {}) {
    const stale = await db(TABLE).where({ status: 'pending', sourceType: 'gym_checkin' })
      .where('createdAt', '<', new Date(+now() - olderThanMs)).orderBy('createdAt').limit(limit);
    const stats = { found: stale.length, approved: 0, cancelled: 0, failed: 0 };
    for (const row of stale) {
      try {
        const checkin = await db('Checkin').where({ id: row.sourceId }).first();
        const r = checkin && checkin.status !== 'voided'
          ? await confirm({ consumptionId: row.id, actor: 'system:b2b-reconciler' })
          : await cancel({ consumptionId: row.id, reason: checkin ? 'checkin_voided' : 'checkin_not_recorded', actor: 'system:b2b-reconciler' });
        if (r.error) stats.failed += 1;
        else if (r.consumption.status === 'approved') stats.approved += 1;
        else stats.cancelled += 1;
      } catch (err) {
        stats.failed += 1;
        console.warn(`[b2b-usage] could not reconcile hold ${row.id}:`, err?.message);
      }
    }
    return stats;
  }

  /** Reverse (or cancel) whatever covers a usage event that was voided. Never throws. */
  async function releaseForSource({ sourceType, sourceId, reason, actorId }) {
    const row = await liveForSource(db, sourceType, sourceId);
    if (!row) return { released: false };
    const result = row.status === 'pending'
      ? await cancel({ consumptionId: row.id, reason, actor: actorId })
      : await reverse({ consumptionId: row.id, reason: reason || 'usage event voided', actorId });
    return { released: !result.error, consumption: result.consumption };
  }

  // ── Integrations (called by the existing services) ────────────────────────

  /** Does the member hold any usable benefit of this kind today (at any provider)? */
  async function hasBenefit({ userId, serviceType, at = now() }) {
    return (await candidatesFor({ userId, serviceType, provider: null, day: localDay(at) })).some(c => c.eligible);
  }

  /** Would a benefit cover a visit to this gym right now? Dry run; writes nothing. */
  async function wouldCoverGymVisit({ memberId, gym, at = now() }) {
    const grossTzs = gymVisitValueTzs(gym);
    if (grossTzs === 0) return false;
    return (await evaluate({ userId: memberId, serviceType: 'gym_access', provider: { type: 'gym', id: gym.id, tier: gym.tier }, grossTzs, at })).covered;
  }

  /**
   * Gym check-in: reserve a benefit for a visit about to be recorded.
   * Returns the pending consumption, or null when no benefit covers it (the
   * member's own pass is then validated as before).
   */
  async function holdGymVisit({ memberId, gym, checkinId, now: at, method }) {
    // Nothing to fund at a free gym: don't spend an allowance on it.
    if (gymVisitValueTzs(gym) === 0) return null;
    const result = await consume({
      userId: memberId, sourceType: 'gym_checkin', sourceId: checkinId,
      provider: { type: 'gym', id: gym.id, tier: gym.tier }, grossTzs: gymVisitValueTzs(gym), at, hold: true,
      actor: 'system:gym-checkin', metadata: { method },
    });
    return result.consumed ? result : null;
  }

  /** Trainer booking marked completed: the session happened, so it may consume a trainer benefit. */
  async function consumeTrainerSession({ booking }) {
    if (!booking?.memberId || booking.status !== 'completed') return { consumed: false, reason: 'session_not_completed' };
    if (!(Number(booking.amountTzs) > 0)) return { consumed: false, reason: 'nothing_to_fund' };
    return consume({
      userId: booking.memberId, sourceType: 'trainer_booking', sourceId: booking.id,
      provider: { type: 'trainer', id: booking.trainerId }, grossTzs: Math.max(0, Math.round(Number(booking.amountTzs) || 0)),
      at: now(), actor: 'system:trainer-booking',
      // The member paid the booking in full; Phase 4 settles the sponsor's share.
      metadata: { memberPaidTzs: Number(booking.amountTzs) || 0, listPriceTzs: booking.listPriceTzs ?? null, date: booking.date, gymId: booking.gymId ?? null },
    });
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  const FILTERS = ['organizationId', 'programId', 'benefitId', 'beneficiaryId', 'userId', 'providerType', 'providerId', 'serviceType', 'sourceType', 'sourceId', 'status'];
  function filtered(query = {}) {
    let q = db(TABLE);
    for (const k of FILTERS) if (query[k]) q = q.where(k, String(query[k]));
    if (query.from) q = q.where('businessDate', '>=', String(query.from));
    if (query.to) q = q.where('businessDate', '<=', String(query.to));
    return q;
  }

  /** Names for a page of ledger rows, in a handful of batched lookups. */
  async function decorate(rows) {
    if (!rows.length) return [];
    const ids = k => [...new Set(rows.map(r => r[k]).filter(Boolean))];
    const [progs, bens, people, orgRows] = await Promise.all([
      programs.filterByColumnInAsync('id', ids('programId')),
      benefits.filterByColumnInAsync('id', ids('benefitId')),
      users.filterByColumnInAsync('id', ids('userId')),
      db('B2BOrganization').whereIn('id', ids('organizationId')).select('id', 'legalName', 'tradingName'),
    ]);
    const name = (list, f = x => x.name) => new Map(list.map(x => [x.id, f(x)]));
    const programName = name(progs);
    const benefitName = name(bens);
    const userName = name(people, u => u.displayName ?? null);
    const orgName = name(orgRows, o => o.tradingName || o.legalName);
    const providerName = (r) => {
      if (r.providerType === 'gym') return gyms.find(g => g.id === r.providerId)?.name ?? null;
      if (r.providerType === 'trainer') return trainers.find(t => t.id === r.providerId)?.displayName ?? null;
      return null;
    };
    return rows.map(r => ({
      ...r, organizationName: orgName.get(r.organizationId) ?? null, programName: programName.get(r.programId) ?? null,
      benefitName: benefitName.get(r.benefitId) ?? null, beneficiaryName: userName.get(r.userId) ?? null, providerName: providerName(r),
    }));
  }

  /** FitFlex back office: the ledger, filterable, newest first. */
  async function adminList({ query = {} } = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
    const [{ n }] = await filtered(query).count({ n: '*' });
    const total = Number(n);
    const rows = await filtered(query).orderBy([{ column: 'consumedAt', order: 'desc' }, { column: 'id' }]).limit(limit).offset(offset);
    const [sums] = await filtered(query).whereIn('status', LIVE_CONSUMPTION_STATUSES)
      .sum({ grossTzs: 'grossTzs', sponsorTzs: 'sponsorTzs', beneficiaryTzs: 'beneficiaryTzs' });
    return {
      items: await decorate(rows), total, nextCursor: offset + limit < total ? offset + limit : null,
      totals: { grossTzs: Number(sums.grossTzs) || 0, sponsorTzs: Number(sums.sponsorTzs) || 0, beneficiaryTzs: Number(sums.beneficiaryTzs) || 0 },
    };
  }

  /** FitFlex back office: one row, its source usage event and what settlement will read. */
  async function adminGet({ consumptionId }) {
    const row = await db(TABLE).where({ id: consumptionId }).first();
    if (!row) return fail('consumption_not_found', 404);
    const [consumption] = await decorate([row]);
    let sourceEvent = null;
    if (row.sourceType === 'gym_checkin') sourceEvent = await checkins.findByIdAsync(row.sourceId);
    if (row.sourceType === 'trainer_booking') sourceEvent = await trainerBookings.findByIdAsync(row.sourceId);
    return { consumption, sourceEvent, settlementCandidate: settlementCandidate(row) };
  }

  /**
   * Usage of one programme for its organisation: totals and breakdowns by
   * benefit, provider and beneficiary. Aggregates only — where and when an
   * individual used a service stays with FitFlex.
   */
  async function programUsage({ access, programId, query = {} }) {
    if (!access.permissions.includes('usage.read')) return fail('forbidden', 403, { requiredPermission: 'usage.read' });
    const program = await programs.findByIdAsync(programId);
    if (!program || program.organizationId !== access.org.id) return fail('program_not_found', 404);

    const scope = () => {
      let q = db(TABLE).where({ programId: program.id });
      if (query.from) q = q.where('businessDate', '>=', String(query.from));
      if (query.to) q = q.where('businessDate', '<=', String(query.to));
      return q;
    };
    const money = q => q.sum({ uses: 'quantity', grossTzs: 'grossTzs', sponsorTzs: 'sponsorTzs', beneficiaryTzs: 'beneficiaryTzs' });
    const num = r => ({ uses: Number(r.uses) || 0, grossTzs: Number(r.grossTzs) || 0, sponsorTzs: Number(r.sponsorTzs) || 0, beneficiaryTzs: Number(r.beneficiaryTzs) || 0 });
    const live = () => scope().whereIn('status', LIVE_CONSUMPTION_STATUSES);

    const [[totals], byStatus, byBenefit, byProvider, byBeneficiary, programBenefits] = await Promise.all([
      money(live()),
      scope().groupBy('status').select('status').count({ n: '*' }),
      money(live().groupBy('benefitId').select('benefitId')),
      money(live().groupBy('providerType', 'providerId').select('providerType', 'providerId')),
      money(live().groupBy('beneficiaryId', 'userId').select('beneficiaryId', 'userId')),
      benefits.filterByColumnAsync('programId', program.id),
    ]);
    const benefitName = new Map(programBenefits.map(b => [b.id, b.name]));
    const people = byBeneficiary.length ? await users.filterByColumnInAsync('id', byBeneficiary.map(r => r.userId).filter(Boolean)) : [];
    const personName = new Map(people.map(u => [u.id, u.displayName ?? null]));
    const providerName = (r) => (r.providerType === 'gym'
      ? gyms.find(g => g.id === r.providerId)?.name
      : trainers.find(t => t.id === r.providerId)?.displayName) ?? null;

    const spent = await sponsorSpentForProgram(program.id);
    return {
      program: { id: program.id, name: program.name, status: programEffectiveStatus(program, localDay(now())), statusReason: program.statusReason ?? null },
      budget: { budgetTzs: program.budgetTzs ?? null, spentTzs: spent, remainingTzs: program.budgetTzs == null ? null : Math.max(0, program.budgetTzs - spent) },
      totals: num(totals),
      byStatus: Object.fromEntries(byStatus.map(r => [r.status, Number(r.n)])),
      byBenefit: byBenefit.map(r => ({ benefitId: r.benefitId, benefitName: benefitName.get(r.benefitId) ?? null, ...num(r) })),
      byProvider: byProvider.map(r => ({ providerType: r.providerType, providerId: r.providerId, providerName: providerName(r), ...num(r) })),
      byBeneficiary: byBeneficiary.map(r => ({ beneficiaryId: r.beneficiaryId, beneficiaryName: personName.get(r.userId) ?? null, ...num(r) })),
    };
  }

  /** A beneficiary's used / remaining allowance on a benefit today (for "my benefits"). */
  async function allowanceFor({ benefit, program, beneficiaryId, day }) {
    const window = usageWindow({ benefit, program, day });
    const used = await usedInWindow(db, { benefitId: benefit.id, beneficiaryId, window });
    return {
      used: used.quantity,
      remaining: benefit.usageLimit == null ? null : Math.max(0, benefit.usageLimit - used.quantity),
      sponsorUsedTzs: used.sponsorTzs,
      sponsorRemainingTzs: benefit.periodSponsorCapTzs == null ? null : Math.max(0, benefit.periodSponsorCapTzs - used.sponsorTzs),
      validity: benefitValidity(benefit, program),
    };
  }

  return {
    evaluate, adminEvaluate, consume, confirm, cancel, reverse, releaseForSource, reconcileHolds,
    hasBenefit, wouldCoverGymVisit, holdGymVisit, consumeTrainerSession,
    adminList, adminGet, programUsage, allowanceFor, sponsorSpentForProgram,
  };
}
