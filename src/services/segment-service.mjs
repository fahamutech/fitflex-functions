// Member segments for communications — who a gym or FitFlex can message.
//
// A gym's audience is only its direct members (a direct subscription at one
// of the owner's gyms). FitFlex members who visit on a pass are never in a
// gym audience; FitFlex reaches them through platform audiences (admins).
//
// Facts per member come from the real records, read with scoped SQL, and
// are derived with the same rules the rest of the app uses:
//   status, expiry        → shared/member-status.mjs (the owner Members list)
//   current subscription  → shared/subscription-status.mjs (the member's app)
//   engagement, visits    → engagementFrom (the owner engagement dashboard)
// so an audience count always agrees with what owners and members see.
import { buildAudienceFilter, matchesFilter, audienceCatalog, ageOn, audienceScope } from '../shared/audience.mjs';
import {
  daysLeft, directMembershipStatus, latestDirectSubscriptionsByMember, ownerGymIds,
} from '../shared/member-status.mjs';
import { currentSubscription } from '../shared/subscription-status.mjs';
import { localDay, daysBetween } from '../shared/member-progress.mjs';
import { CHANNELS, categoryForPurpose, channelAllowed } from '../shared/communications.mjs';
import { toE164 } from '../shared/phone.mjs';
import { engagementFrom } from './gym-sharing-service.mjs';

const RECENT_DAYS = 91; // engagementFrom looks back 90 local days
const SAMPLE_SIZE = 5;
const CHUNK = 1000;

const chunks = (ids) => {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
  return out;
};
const iso = (v) => (v == null ? null : new Date(v).toISOString());
const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
};

export function createSegmentService({
  db,
  communicationPreferences,
  deviceTokens,
  now = () => new Date(),
  pushAvailable = () => false,
  whatsappAvailable = () => false,
}) {
  async function inChunks(ids, fetch) {
    const out = [];
    for (const part of chunks(ids)) out.push(...await fetch(part));
    return out;
  }

  async function usersById(ids) {
    const rows = await inChunks(ids, part => db('User')
      .whereIn('id', part)
      .select('id', 'displayName', 'phone', 'accountStatus', 'memberProfile', 'createdAt'));
    return new Map(rows.map(u => [u.id, u]));
  }

  // Latest payment request per subscription → approved | pending | rejected | cancelled.
  async function paymentStatusBySub(subIds) {
    const rows = await inChunks(subIds, part => db('PaymentRequest')
      .whereIn('subscriptionId', part)
      .select('subscriptionId', 'status', 'requestedAt'));
    const out = new Map();
    for (const [subId, list] of groupBy(rows, 'subscriptionId')) {
      list.sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt));
      out.set(subId, list[0].status);
    }
    return out;
  }

  const suspended = (user) => user.accountStatus === 'suspended';

  function facts({ user, sub, joinedAt, visits, recent, paymentStatus, homeGymId, areaGymId, at }) {
    const today = localDay(at);
    const engagement = engagementFrom(recent.map(r => iso(r.timestamp)), at);
    const dl = sub ? daysLeft(iso(sub.expiresAt), at) : null;
    const status = sub
      ? directMembershipStatus({ accountStatus: user.accountStatus, sub: { ...sub, expiresAt: iso(sub.expiresAt) }, now: at })
      : user.accountStatus === 'suspended' ? 'suspended' : 'none';
    const profile = user.memberProfile || {};
    return {
      memberId: user.id,
      displayName: user.displayName || null,
      phone: user.phone || null,
      status,
      subscriptionId: sub?.id ?? null,
      subscriptionStatus: sub?.status ?? null,
      plan: sub?.plan ?? null,
      tier: sub?.tier ?? null,
      subscriptionType: sub?.type ?? null,
      passTier: sub?.type === 'platform_pass' ? sub.tier ?? null : null,
      paymentStatus: sub ? paymentStatus ?? 'none' : null,
      expiresOn: sub?.expiresAt ? localDay(sub.expiresAt) : null,
      daysUntilExpiry: dl,
      daysSinceExpiry: dl != null && dl < 0 ? -dl : null,
      joinedDaysAgo: joinedAt ? daysBetween(localDay(joinedAt), today) : null,
      homeGymId: homeGymId ?? null,
      lastVisitDaysAgo: visits?.last ? daysBetween(localDay(visits.last), today) : null,
      visitsLast30Days: engagement.visits30,
      totalVisits: Number(visits?.total || 0),
      engagement: engagement.status,
      age: ageOn(profile.dateOfBirth, today),
      gender: typeof profile.gender === 'string' && profile.gender ? profile.gender.toLowerCase() : null,
      areaGymId: areaGymId ?? null,
    };
  }

  async function visitStats(query) {
    const rows = await query.clone()
      .groupBy('memberId')
      .select('memberId')
      .max({ last: 'timestamp' })
      .count({ total: '*' });
    return new Map(rows.map(r => [r.memberId, r]));
  }

  /** Facts for a gym's direct members at `gymIds` (optionally only `memberIds`). */
  async function gymMemberFacts(gymIds, { memberIds: only = null } = {}) {
    const at = now();
    const q = db('Subscription').where('type', 'direct_sub').whereIn('homeGymId', gymIds);
    if (only) q.whereIn('memberId', only);
    const subs = await q.select('id', 'memberId', 'type', 'tier', 'plan', 'status', 'startedAt', 'expiresAt', 'homeGymId');
    const latest = latestDirectSubscriptionsByMember(subs, gymIds);
    const memberIds = [...latest.keys()];
    if (!memberIds.length) return [];
    const joined = new Map();
    for (const s of subs) {
      const prev = joined.get(s.memberId);
      if (!prev || +new Date(s.startedAt) < +new Date(prev)) joined.set(s.memberId, s.startedAt);
    }
    const members = new Set(memberIds);
    const atGym = db('Checkin').whereIn('gymId', gymIds);
    if (only) atGym.whereIn('memberId', only);
    const since = new Date(+at - RECENT_DAYS * 86_400_000);
    const [users, visits, recentRows, payments] = await Promise.all([
      usersById(memberIds),
      visitStats(atGym),
      atGym.clone().where('timestamp', '>=', since).select('memberId', 'timestamp'),
      paymentStatusBySub([...latest.values()].map(s => s.id)),
    ]);
    const recent = groupBy(recentRows.filter(r => members.has(r.memberId)), 'memberId');
    const out = [];
    for (const [memberId, sub] of latest) {
      const user = users.get(memberId);
      // Deleted and suspended accounts are never messaged (M11).
      if (!user || suspended(user)) continue;
      out.push(facts({
        user, sub, joinedAt: joined.get(memberId), visits: visits.get(memberId),
        recent: recent.get(memberId) || [], paymentStatus: payments.get(sub.id),
        homeGymId: sub.homeGymId, areaGymId: sub.homeGymId, at,
      }));
    }
    return out;
  }

  /** Facts for every FitFlex member. */
  async function platformMemberFacts() {
    const at = now();
    const users = await db('User').where('userType', 'member')
      .select('id', 'displayName', 'phone', 'accountStatus', 'memberProfile', 'createdAt');
    if (!users.length) return [];
    const members = db('User').where('userType', 'member').select('id');
    const since = new Date(+at - RECENT_DAYS * 86_400_000);
    const [subs, visits, recentRows] = await Promise.all([
      db('Subscription').whereIn('memberId', members)
        .select('id', 'memberId', 'type', 'tier', 'plan', 'status', 'startedAt', 'expiresAt', 'homeGymId'),
      visitStats(db('Checkin').whereIn('memberId', members)),
      db('Checkin').whereIn('memberId', members).where('timestamp', '>=', since).select('memberId', 'gymId', 'timestamp'),
    ]);
    const subsByMember = groupBy(subs, 'memberId');
    const recent = groupBy(recentRows, 'memberId');
    const current = new Map();
    for (const [memberId, list] of subsByMember) {
      const sub = currentSubscription(list.map(s => ({ ...s, startedAt: iso(s.startedAt) })));
      if (sub) current.set(memberId, sub);
    }
    const payments = await paymentStatusBySub([...current.values()].map(s => s.id));
    const allHomeGyms = [...new Set(subs.map(s => s.homeGymId).filter(Boolean))];
    return users.filter(user => !suspended(user)).map(user => {
      const sub = current.get(user.id) || null;
      const mine = recent.get(user.id) || [];
      // Area: the member's home gym, else the gym they visited most lately.
      const home = latestDirectSubscriptionsByMember(subsByMember.get(user.id) || [], allHomeGyms).get(user.id);
      return facts({
        user, sub, joinedAt: user.createdAt, visits: visits.get(user.id), recent: mine,
        paymentStatus: sub ? payments.get(sub.id) : null,
        homeGymId: home?.homeGymId ?? null,
        areaGymId: home?.homeGymId ?? mostVisitedGym(mine),
        at,
      });
    });
  }

  /**
   * Facts for every FitFlex trainer with an account: profile status,
   * verification, linked gyms and whether they hold a trainer pass.
   * `memberId` is the trainer's user id (the message ledger's recipient).
   */
  async function platformTrainerFacts() {
    const at = now();
    const today = localDay(at);
    const profiles = await db('TrainerProfile').whereNotNull('userId')
      .select('id', 'userId', 'displayName', 'phone', 'status', 'approvalStatus', 'verified', 'createdAt');
    if (!profiles.length) return [];
    const userIds = profiles.map(p => p.userId);
    const [users, links, passes] = await Promise.all([
      usersById(userIds),
      inChunks(profiles.map(p => p.id), part => db('TrainerProfileGym').whereIn('trainerId', part).select('trainerId', 'gymId')),
      inChunks(userIds, part => db('Subscription').whereIn('memberId', part).where('type', 'trainer_pass')
        .select('memberId', 'status', 'expiresAt')),
    ]);
    const gymsByTrainer = groupBy(links, 'trainerId');
    const passesByUser = groupBy(passes, 'memberId');
    const passState = (list = []) => {
      if (list.some(p => p.status === 'active' && (!p.expiresAt || new Date(p.expiresAt) > at))) return 'active';
      if (list.some(p => p.status === 'payment_pending')) return 'pending';
      return 'none';
    };
    return profiles.filter(p => users.has(p.userId) && !suspended(users.get(p.userId))).map(p => {
      const user = users.get(p.userId);
      return {
        memberId: p.userId,
        displayName: p.displayName || user?.displayName || null,
        phone: p.phone || user?.phone || null,
        status: p.status || 'active',
        trainerStatus: user?.accountStatus === 'suspended' ? 'suspended' : (p.status || 'active'),
        trainerVerified: p.verified ? 'yes' : 'no',
        trainerApproval: p.approvalStatus || 'approved',
        trainerPass: passState(passesByUser.get(p.userId)),
        linkedGymId: (gymsByTrainer.get(p.id) || []).map(l => l.gymId),
        joinedDaysAgo: p.createdAt ? daysBetween(localDay(p.createdAt), today) : null,
      };
    });
  }

  function mostVisitedGym(rows) {
    const counts = new Map();
    for (const r of rows) counts.set(r.gymId, (counts.get(r.gymId) || 0) + 1);
    let best = null;
    for (const [gymId, n] of counts) if (!best || n > best[1]) best = [gymId, n];
    return best?.[0] ?? null;
  }

  async function gymsContext(filter) {
    // Only area conditions need gym locations.
    if (!JSON.stringify(filter).includes('"area"')) return {};
    const rows = await db('Gym').select('id', 'location', 'coordinates');
    return { gymsById: new Map(rows.map(g => [g.id, g])) };
  }

  /**
   * Members matching an audience. `sender` is { senderType: 'gym', owner,
   * gymId? } or { senderType: 'platform' }. For a gym the scope always
   * comes from the owner's own gyms, never from the request. FitFlex can
   * also address `recipients: 'trainers'` instead of members.
   */
  async function resolveAudience({ sender, recipients = 'members', preset, filter }) {
    let scopeGymIds = null;
    if (sender?.senderType === 'gym') {
      const mine = ownerGymIds(sender.owner);
      if (!mine.length) return { error: 'owner_has_no_gyms', status: 400 };
      if (sender.gymId != null && !mine.includes(sender.gymId)) return { error: 'not_your_gym', status: 403 };
      scopeGymIds = sender.gymId != null ? [sender.gymId] : mine;
    } else if (sender?.senderType !== 'platform') {
      return { error: 'invalid_sender', status: 400 };
    }
    const scope = audienceScope(sender.senderType, recipients);
    if (!scope) return { error: 'invalid_recipients', status: 400 };
    const built = buildAudienceFilter({ preset, filter }, scope);
    if (built.error) return built;
    const all = scope === 'gym'
      ? await gymMemberFacts(scopeGymIds)
      : scope === 'trainers' ? await platformTrainerFacts() : await platformMemberFacts();
    const ctx = await gymsContext(built.filter);
    return {
      senderType: sender.senderType,
      recipients,
      gymIds: scopeGymIds,
      filter: built.filter,
      members: all.filter(f => matchesFilter(f, built.filter, ctx)),
    };
  }

  /** Each member's chosen app language (memberId → 'en' | 'sw'), where known. */
  async function localesByMember(ids) {
    const prefs = await inChunks(ids, part => communicationPreferences.filterByColumnInAsync('id', part));
    return new Map(prefs.filter(p => p.locale).map(p => [p.id, p.locale]));
  }

  /** Channels this server can send on right now. */
  function channelAvailability() {
    return { in_app: true, push: Boolean(pushAvailable()), whatsapp: Boolean(whatsappAvailable()) };
  }

  /**
   * Per member and channel: may a message of `category` go out, and if not,
   * why. Checks what the server has set up, the member's preferences, and
   * whether the member has a device (push) or phone (WhatsApp).
   * @returns {Promise<Map<string, Record<string, string|null>>>} memberId → { channel: null | reason }
   */
  async function reachByMember(members, category, channels = CHANNELS) {
    const ids = members.map(m => m.memberId);
    const [prefs, tokens] = await Promise.all([
      inChunks(ids, part => communicationPreferences.filterByColumnInAsync('id', part)),
      inChunks(ids, part => deviceTokens.filterByColumnInAsync('userId', part)),
    ]);
    const prefById = new Map(prefs.map(p => [p.id, p]));
    const withDevice = new Set(tokens.map(t => t.userId));
    const available = channelAvailability();
    const out = new Map();
    for (const m of members) {
      const decision = {};
      for (const ch of channels) {
        let reason = null;
        if (!available[ch]) reason = ch === 'push' ? 'push_disabled' : 'whatsapp_not_configured';
        else {
          const allowed = channelAllowed(prefById.get(m.memberId), ch, category);
          if (!allowed.allowed) reason = allowed.reason;
          else if (ch === 'push' && !withDevice.has(m.memberId)) reason = 'no_device';
          else if (ch === 'whatsapp' && !m.phone) reason = 'no_phone';
          else if (ch === 'whatsapp' && !toE164(m.phone)) reason = 'invalid_phone';
        }
        decision[ch] = reason;
      }
      out.set(m.memberId, decision);
    }
    return out;
  }

  /** Per channel: how many of `members` a message can reach, and why the rest can't. */
  async function channelReach(members, category) {
    const reach = Object.fromEntries(CHANNELS.map(ch => [ch, { eligible: 0, excluded: {} }]));
    for (const decision of (await reachByMember(members, category)).values()) {
      for (const [ch, reason] of Object.entries(decision)) {
        if (reason) reach[ch].excluded[reason] = (reach[ch].excluded[reason] || 0) + 1;
        else reach[ch].eligible += 1;
      }
    }
    return reach;
  }

  /**
   * "84 members match this audience": the count, what each channel can
   * reach for the message's category, and a few names to sanity-check.
   * Without a purpose the stricter marketing rules apply.
   */
  async function previewAudience({ sender, recipients = 'members', preset, filter, purpose }) {
    let category = 'marketing';
    if (purpose != null) {
      category = categoryForPurpose(purpose);
      if (!category) return { error: 'invalid_purpose', status: 400 };
    }
    const r = await resolveAudience({ sender, recipients, preset, filter });
    if (r.error) return r;
    const sample = [...r.members]
      .sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')))
      .slice(0, SAMPLE_SIZE)
      .map(m => ({ id: m.memberId, displayName: m.displayName, status: m.status }));
    return {
      senderType: r.senderType,
      recipients: r.recipients,
      gymIds: r.gymIds,
      category,
      count: r.members.length,
      channels: await channelReach(r.members, category),
      sample,
      filter: r.filter,
    };
  }

  return {
    catalog: (scope) => audienceCatalog(scope),
    resolveAudience,
    previewAudience,
    channelReach,
    reachByMember,
    channelAvailability,
    localesByMember,
    // Membership facts (status, days to expiry, last visit…) — the same
    // ones audiences use — for lifecycle automations.
    gymMemberFacts,
  };
}
