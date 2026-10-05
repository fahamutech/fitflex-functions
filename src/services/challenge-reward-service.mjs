// Challenge rewards — earned is not the same as handed out.
//
//   Challenge → Participation → Progress → Completion
//   Completion → Reward earned → Pending → Approved → Issued
//                                        ↘ Rejected (can be reopened)
//
// When a reward is earned (one row per member per reward, never twice):
//   finishers — as soon as the member reaches the target, while the
//               challenge is running or just ended
//   top N     — once the challenge has ended: the top N by progress among
//               everyone taking part (progress above zero; ties go to who
//               joined first)
//   team      — once it has ended: everyone on the winning team
// After the end, one settling pass decides top N and team rewards, catches
// any finishers not yet recorded, and stamps Challenge.rewardsSettledAt;
// nothing is earned after that. Cancelled challenges earn nothing.
//
// Who hands rewards out (the fulfilment queues):
//   FitFlex admin — rewards funded by FitFlex or a partner, and trainer and
//                   gym challenge rewards (for now)
//   company HR    — their own company-funded challenge rewards
// Issuing records what was handed over (a reference such as a voucher code,
// pass or booking id, and a note). Nothing is provisioned automatically:
// no subscription, booking, balance or payment changes.
//
// Privacy: fulfilling a reward needs to know who earned it, so the queues
// show the member's name (and department, for HR) with the reward and why
// it was earned (finished / top N place / winning team) — never their
// activity, progress numbers or health information.
import { randomUUID } from 'node:crypto';
import { challengePhase, rewardItemsOf } from './challenge-service.mjs';
import { localDay } from '../shared/member-progress.mjs';
import { createCompanyDirectory, isCompanyType } from './company-directory.mjs';
import { notificationText } from '../shared/notification-texts.mjs';

/** The company or organisation a scope is for: { kind: 'corporate', corporateId } or { kind: 'organization', organizationId }. */
const companyIdOf = scope => (scope.kind === 'corporate' ? scope.corporateId : scope.organizationId);

export const REWARD_STATUSES = ['pending', 'approved', 'issued', 'rejected'];
const TRANSITIONS = {
  pending: ['approved', 'rejected'],
  approved: ['issued', 'rejected'],
  rejected: ['pending'],
  issued: [],
};

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Who pays: the challenge's funder, else its creator (trainer / gym). */
function funderOf(c) {
  return c.rewardFunding ?? (isCompanyType(c.creatorType) ? 'company' : c.creatorType);
}

/** Does this queue handle the reward? */
function inScope(scope, a) {
  if (scope.kind === 'admin') return a.funder !== 'company';
  // A company's HR, or an organisation's own users: their company-funded rewards only.
  if (isCompanyType(scope.kind)) return a.creatorType === scope.kind && a.creatorId === companyIdOf(scope) && a.funder === 'company';
  return false;
}

export function createChallengeRewardService({
  challenges, participants, awards, users, corporateEmployees = null, challengeService, auditLog = null,
  directory = createCompanyDirectory({ users, corporateEmployees }),
  notify = async () => {}, now = () => new Date(),
}) {
  const isEnded = c => challengePhase(c, now()) === 'ended';

  async function existingKeys(challengeId) {
    return new Set((await awards.filterByColumnAsync('challengeId', challengeId)).map(a => `${a.rewardId}|${a.memberId}`));
  }

  async function earn(c, item, memberId, extra, keys) {
    const key = `${item.id}|${memberId}`;
    if (keys.has(key)) return null;
    keys.add(key);
    const stamp = now().toISOString();
    const row = {
      id: `rwa_${randomUUID().slice(0, 12)}`,
      challengeId: c.id, rewardId: item.id, memberId,
      creatorType: c.creatorType, creatorId: c.creatorId ?? null, funder: funderOf(c),
      type: item.type, label: item.label, value: item.value ?? null, rule: item.rule,
      rank: extra.rank ?? null, teamId: extra.teamId ?? null,
      status: 'pending', earnedAt: stamp,
      reference: null, note: null, decidedBy: null, decidedAt: null, issuedBy: null, issuedAt: null,
      history: [{ status: 'pending', at: stamp, by: null, note: 'Earned' }],
      createdAt: stamp, updatedAt: stamp,
    };
    try {
      await awards.insertAsync(row);
    } catch (err) {
      // Unique (challenge, reward, member): another pass got there first.
      if (/unique|duplicate/i.test(err.message ?? '')) return null;
      throw err;
    }
    await notify(memberId, {
      type: 'challenge_reward_earned',
      ...notificationText('challenge_reward_earned', { challengeName: c.name, label: item.label }),
      data: { challengeId: c.id, rewardAwardId: row.id },
    });
    return row;
  }

  /**
   * Record what has been earned on one challenge. With `memberId`, only that
   * member's finisher rewards while it's running; once it has ended, a full
   * settling pass (which also covers that member).
   */
  async function evaluate(c, { memberId = null } = {}) {
    if (!c || c.status === 'cancelled' || c.rewardsSettledAt) return { earned: 0 };
    const items = rewardItemsOf(c);
    const phase = challengePhase(c, now());
    if (!items.length || phase === 'upcoming') return { earned: 0 };
    const ended = isEnded(c);
    const keys = await existingKeys(c.id);
    let earned = 0;
    const finishers = items.filter(i => i.rule === 'finishers');

    if (!ended && memberId) {
      if (!finishers.length) return { earned: 0 };
      const progress = await challengeService.progressFor(c, memberId);
      if (progress < c.target) return { earned: 0 };
      for (const item of finishers) if (await earn(c, item, memberId, {}, keys)) earned += 1;
      return { earned };
    }

    const { scored, winningTeamId } = await challengeService.scoreboard(c);
    for (const s of scored) {
      if (s.progress < c.target) continue;
      for (const item of finishers) if (await earn(c, item, s.memberId, {}, keys)) earned += 1;
    }
    if (!ended) return { earned };

    const ranked = scored.filter(s => s.progress > 0);
    for (const item of items.filter(i => i.rule === 'top')) {
      for (const [i, s] of ranked.slice(0, item.topN).entries()) {
        if (await earn(c, item, s.memberId, { rank: i + 1 }, keys)) earned += 1;
      }
    }
    if (winningTeamId) {
      for (const item of items.filter(i => i.rule === 'team')) {
        for (const s of scored.filter(x => x.teamId === winningTeamId)) {
          if (await earn(c, item, s.memberId, { teamId: winningTeamId }, keys)) earned += 1;
        }
      }
    }
    await challenges.updateByIdAsync(c.id, { rewardsSettledAt: now().toISOString() });
    return { earned, settled: true };
  }

  /** Challenges still earning rewards (started, not settled, not cancelled). */
  async function unsettled(pred = () => true) {
    const today = localDay(now());
    return (await challenges.allAsync()).filter(c => c.status !== 'cancelled' && !c.rewardsSettledAt
      && c.startDate <= today && rewardItemsOf(c).length && pred(c));
  }

  /** Daily job: record new finishers and settle challenges that have ended. */
  async function settleDue() {
    let earned = 0, settled = 0;
    for (const c of await unsettled()) {
      const r = await evaluate(c);
      earned += r.earned;
      if (r.settled) settled += 1;
    }
    return { earned, settled };
  }

  /** Bring one member's rewards up to date on the challenges they're in. */
  async function syncMember(memberId) {
    const joined = new Set((await participants.filterByColumnAsync('memberId', memberId)).filter(p => p.status === 'joined').map(p => p.challengeId));
    for (const c of await unsettled(x => joined.has(x.id))) await evaluate(c, { memberId });
  }

  /** History with who did each step by name (ids stay for the audit trail). */
  async function named(history = []) {
    const names = new Map();
    for (const h of history) {
      if (h.by && !names.has(h.by)) names.set(h.by, (await users.findByIdAsync(h.by))?.displayName ?? null);
    }
    return history.map(h => ({ ...h, byName: h.by ? names.get(h.by) ?? null : null }));
  }

  const view = (a, c) => ({
    id: a.id,
    challenge: { id: a.challengeId, name: c?.name ?? null, endDate: c?.endDate ?? null },
    reward: { id: a.rewardId, type: a.type, label: a.label, value: a.value ?? null, rule: a.rule },
    rank: a.rank ?? null,
    status: a.status,
    earnedAt: a.earnedAt,
    issuedAt: a.issuedAt ?? null,
    reference: a.reference ?? null,
    note: a.note ?? null,
  });

  /** Member: every reward they've earned and where it stands. */
  async function memberRewards(memberId) {
    await syncMember(memberId);
    const mine = await awards.filterByColumnAsync('memberId', memberId);
    const cache = new Map();
    const out = [];
    for (const a of mine.sort((x, y) => +new Date(y.earnedAt) - +new Date(x.earnedAt))) {
      if (!cache.has(a.challengeId)) cache.set(a.challengeId, await challenges.findByIdAsync(a.challengeId));
      // A rejected reward stays visible to the member, with the reason.
      out.push(view(a, cache.get(a.challengeId)));
    }
    return { rewards: out };
  }

  /** Fulfilment queue for FitFlex admin or one company's HR. */
  async function queue(scope, { status = null, challengeId = null } = {}) {
    if (status && !REWARD_STATUSES.includes(status)) return { error: 'invalid_status', status: 400 };
    const mine = isCompanyType(scope.kind)
      ? x => x.creatorType === scope.kind && x.creatorId === companyIdOf(scope)
      : x => funderOf(x) !== 'company';
    for (const c of await unsettled(mine)) await evaluate(c);

    const all = (await awards.allAsync()).filter(a => inScope(scope, a) && (!challengeId || a.challengeId === challengeId));
    const counts = Object.fromEntries(REWARD_STATUSES.map(s => [s, 0]));
    for (const a of all) counts[a.status] = (counts[a.status] ?? 0) + 1;

    const staff = isCompanyType(scope.kind)
      ? new Map((await directory.peopleOf(scope.kind, companyIdOf(scope))).filter(e => e.userId).map(e => [e.userId, e]))
      : new Map();
    const cache = new Map();
    const out = [];
    for (const a of all.filter(x => !status || x.status === status).sort((x, y) => +new Date(x.earnedAt) - +new Date(y.earnedAt))) {
      if (!cache.has(a.challengeId)) cache.set(a.challengeId, await challenges.findByIdAsync(a.challengeId));
      const u = await users.findByIdAsync(a.memberId);
      out.push({
        ...view(a, cache.get(a.challengeId)),
        member: {
          id: a.memberId,
          displayName: staff.get(a.memberId)?.displayName ?? u?.displayName ?? null,
          ...(isCompanyType(scope.kind) && { department: staff.get(a.memberId)?.department ?? null }),
        },
        funder: a.funder,
        history: await named(a.history ?? []),
        decidedAt: a.decidedAt ?? null,
      });
    }
    return { rewards: out, counts };
  }

  /**
   * Move a reward along: pending → approved → issued, or reject (a reason
   * is required) — a rejected one can be reopened as pending. Issued is
   * final. Every step is kept in the reward's history and the audit log.
   */
  async function setStatus(scope, actorId, id, body = {}) {
    const a = await awards.findByIdAsync(id);
    if (!a || !inScope(scope, a)) return { error: 'not_found', status: 404 };
    const next = body.status;
    if (!REWARD_STATUSES.includes(next)) return { error: 'invalid_status', status: 400 };
    if (!TRANSITIONS[a.status].includes(next)) return { error: 'invalid_transition', status: 409 };
    const note = text(body.note, 300);
    const reference = text(body.reference, 120);
    if (next === 'rejected' && !note) return { error: 'reason_required', status: 400 };

    const stamp = now().toISOString();
    const patch = {
      status: next,
      note: note ?? (next === 'pending' ? null : a.note),
      history: [...(a.history ?? []), { status: next, at: stamp, by: actorId, ...(note && { note }), ...(reference && { reference }) }],
      updatedAt: stamp,
    };
    if (next === 'approved' || next === 'rejected') Object.assign(patch, { decidedBy: actorId, decidedAt: stamp });
    if (next === 'issued') Object.assign(patch, { issuedBy: actorId, issuedAt: stamp, reference: reference ?? a.reference ?? null });
    const updated = (await awards.updateByIdAsync(id, patch)) ?? { ...a, ...patch };

    await auditLog?.insertAsync({
      id: `aud_${randomUUID().slice(0, 12)}`, at: stamp, actor: actorId, action: `challenge_reward.${next}`, target: id,
      before: { status: a.status }, after: { status: next, reference: patch.reference ?? null, note },
    });
    const c = await challenges.findByIdAsync(a.challengeId);
    if (next === 'issued') {
      await notify(a.memberId, {
        type: 'challenge_reward_issued',
        ...notificationText('challenge_reward_issued', { label: a.label, challengeName: c?.name ?? null, reference: patch.reference || null }),
        data: { challengeId: a.challengeId, rewardAwardId: id },
      });
    } else if (next === 'rejected') {
      await notify(a.memberId, {
        type: 'challenge_reward_rejected',
        ...notificationText('challenge_reward_rejected', { label: a.label, challengeName: c?.name ?? null, note }),
        data: { challengeId: a.challengeId, rewardAwardId: id },
      });
    }
    return { reward: { ...view(updated, c), funder: updated.funder, history: await named(updated.history) } };
  }

  /** Reward counts for one challenge, for its creator's detail view. */
  async function challengeCounts(challengeId) {
    const counts = Object.fromEntries(REWARD_STATUSES.map(s => [s, 0]));
    for (const a of await awards.filterByColumnAsync('challengeId', challengeId)) counts[a.status] += 1;
    return counts;
  }

  return { evaluate, settleDue, syncMember, memberRewards, queue, setStatus, challengeCounts };
}
