// B2B analytics and reporting (Phase 6): a read layer over the ledgers the
// earlier phases write. Nothing here stores a figure or decides one: usage
// comes from B2BBenefitConsumption, money owed and paid from the invoice and
// payment tables through the finance service, provider figures from the
// settlement tables. Every KPI is defined in B2B_ANALYTICS.md.
//
// Rules that hold throughout:
//
//   verified usage   only `approved` consumption counts. A hold not yet
//                    confirmed, a rejection, a cancellation and a reversal
//                    never do, so a correction shows as the final state.
//   active           a beneficiary who used a sponsored benefit in the period:
//                    a funded visit or session, or a check-in on a pass the
//                    organisation paid for (decision A-01, 5 Oct 2026).
//   days             East Africa Time calendar days, inclusive.
//   tenant           every query is scoped to the one organisation `access`
//                    was resolved for. Cross-organisation figures are for
//                    FitFlex staff only.
//   people           an organisation sees its own people individually,
//                    including activity it did not fund (decision A-02).
//                    Never shown: weight, height, calories, notes, routes,
//                    and anything another organisation funds or runs.
//   two sides        what an organisation is billed and what a provider is
//                    owed are separate figures and are never added together.
import { randomUUID } from 'node:crypto';
import { resolvePeriod, bucketOf, bucketsBetween, changePct, ratePct, perUnit, toCsv } from '../shared/b2b-analytics.mjs';
import { eatDayStart, matchesPopulation, programEffectiveStatus, benefitValidity, usageWindow, FLAT_FEE_BENEFIT } from '../shared/b2b-programs.mjs';
import { BILLED_STATUSES } from '../shared/b2b-billing.mjs';
import { localDay, addDays } from '../shared/member-progress.mjs';

const USAGE = 'B2BBenefitConsumption';
const ENTITLEMENT = 'B2BPassEntitlement';
const INVOICE = 'B2BSponsorInvoice';
const PAYMENT = 'B2BPayment';
const READ = 'analytics.read';
const PEOPLE = 'analytics.people';
const BILLING = 'billing.read';
const TZ = 'Africa/Dar_es_Salaam';
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const n = v => Number(v) || 0;
/** The app's own rule (shared/member-progress isWorkout): passive device step counts are not workouts. */
const WORKOUT = `NOT ("type" = 'walking' AND "source" = 'device')`;
/** The EAT day of a timestamp column, in SQL. */
const dayOf = col => `to_char(${col} AT TIME ZONE '${TZ}', 'YYYY-MM-DD')`;

export function createB2BAnalyticsService({
  db, b2bService, finance, programs, benefits, gyms, trainers,
  // (creatorType, creatorId, memberId) => that member's progress on the creator's challenges
  challengeProgress = async () => [],
  // Tell one person in the app: (userId, { id, type, title, body, data })
  notify = async () => null,
  now = () => new Date(),
}) {
  const today = () => localDay(now());
  const can = (access, permission) => access.platformAdmin || access.permissions.includes(permission);
  const refuse = permission => fail('forbidden', 403, { requiredPermission: permission });
  const audit = ({ actor, action, target, after = null }) => db('AuditLog').insert({
    id: randomUUID(), at: new Date(now()), actor: actor ?? null, action, target, before: null, after: after == null ? null : JSON.stringify(after),
  });
  const providerName = (type, id) => (type === 'gym' ? gyms.find(g => g.id === id)?.name : trainers.find(t => t.id === id)?.displayName) ?? null;
  /** [start, end) instants of an inclusive EAT day range. */
  const instants = (from, to) => [eatDayStart(from), eatDayStart(addDays(to, 1))];
  /** The owner key challenges and groups use for this organisation. */
  const companyOf = org => (org.legacyCorporateId ? ['corporate', org.legacyCorporateId] : ['organization', org.id]);

  function periodOf(query) {
    return resolvePeriod(query, today());
  }

  // ── The organisation's people ─────────────────────────────────────────────

  /** Everyone on the organisation's list (native beneficiaries and a mapped company's employees). */
  async function peopleOf(org, { group = null } = {}) {
    const all = await b2bService.allBeneficiaries(org);
    return group ? all.filter(p => (p.groupName ?? '') === group) : all;
  }

  // ── Building blocks (each scoped to one organisation and a day range) ─────

  /** Verified sponsored usage, optionally narrowed. */
  function verified(orgId, from, to, f = {}) {
    let q = db(USAGE).where({ organizationId: orgId, status: 'approved' }).where('businessDate', '>=', from).where('businessDate', '<=', to);
    if (f.programId) q = q.where({ programId: f.programId });
    if (f.benefitId) q = q.where({ benefitId: f.benefitId });
    if (f.providerId) q = q.where({ providerId: f.providerId });
    if (f.beneficiaryIds) q = q.whereIn('beneficiaryId', f.beneficiaryIds);
    return q;
  }
  const sums = q => q.sum({ uses: 'quantity', grossTzs: 'grossTzs', sponsorTzs: 'sponsorTzs', beneficiaryTzs: 'beneficiaryTzs' });
  const money = r => ({ uses: n(r?.uses), grossTzs: n(r?.grossTzs), sponsorTzs: n(r?.sponsorTzs), beneficiaryTzs: n(r?.beneficiaryTzs) });

  /** Valid check-ins on a pass this organisation sponsored. */
  function passCheckins(orgId, from, to, f = {}) {
    const [start, end] = instants(from, to);
    let q = db('Checkin as c').join(`${ENTITLEMENT} as e`, 'e.subscriptionId', 'c.subscriptionId')
      .where('e.organizationId', orgId).where('c.status', 'valid').where('c.timestamp', '>=', start).where('c.timestamp', '<', end);
    if (f.programId) q = q.where('e.programId', f.programId);
    if (f.benefitId) q = q.where('e.benefitId', f.benefitId);
    if (f.providerId) q = q.where('c.gymId', f.providerId);
    if (f.beneficiaryIds) q = q.whereIn('e.beneficiaryId', f.beneficiaryIds);
    return q;
  }

  /** Beneficiary ids that used a sponsored benefit in the range. */
  async function activeIds(orgId, from, to, f = {}) {
    const [a, b] = await Promise.all([
      verified(orgId, from, to, f).distinct('beneficiaryId').pluck('beneficiaryId'),
      passCheckins(orgId, from, to, f).distinct('e.beneficiaryId').pluck('e.beneficiaryId'),
    ]);
    return new Set([...a, ...b]);
  }

  /**
   * What the organisation's linked people did on FitFlex, whoever paid:
   * activities logged, workouts, steps, distance, active minutes, every valid
   * gym check-in and how many of them took part in the organisation's own
   * challenges.
   */
  async function engagement(org, userIds, from, to) {
    const empty = { peopleWithActivity: 0, activities: 0, workouts: 0, steps: 0, distanceKm: 0, activeMinutes: 0, gymCheckins: 0, peopleInChallenges: 0 };
    if (!userIds.length) return empty;
    const [start, end] = instants(from, to);
    const [creatorType, creatorId] = companyOf(org);
    const [[acts], [visits], visitors, actors, joined] = await Promise.all([
      db('Activity').whereIn('userId', userIds).where('startedAt', '>=', start).where('startedAt', '<', end)
        .select(db.raw(`COUNT(*) AS activities, COUNT(*) FILTER (WHERE ${WORKOUT}) AS workouts,
          COALESCE(SUM("steps"), 0) AS steps, COALESCE(SUM("distanceKm"), 0) AS km, COALESCE(SUM(COALESCE("activeMinutes", "durationMinutes")), 0) AS minutes`)),
      db('Checkin').whereIn('memberId', userIds).where({ status: 'valid' }).where('timestamp', '>=', start).where('timestamp', '<', end).count({ c: '*' }),
      db('Checkin').whereIn('memberId', userIds).where({ status: 'valid' }).where('timestamp', '>=', start).where('timestamp', '<', end).distinct('memberId').pluck('memberId'),
      db('Activity').whereIn('userId', userIds).where('startedAt', '>=', start).where('startedAt', '<', end).distinct('userId').pluck('userId'),
      db('ChallengeParticipant as p').join('Challenge as c', 'c.id', 'p.challengeId')
        .where({ 'c.creatorType': creatorType, 'c.creatorId': creatorId, 'p.status': 'joined' }).whereNot('c.status', 'cancelled')
        .where('c.startDate', '<=', to).where('c.endDate', '>=', from).whereIn('p.memberId', userIds).countDistinct({ c: 'p.memberId' }),
    ]);
    return {
      peopleWithActivity: new Set([...visitors, ...actors]).size,
      activities: n(acts.activities), workouts: n(acts.workouts), steps: n(acts.steps), distanceKm: Math.round(n(acts.km) * 10) / 10, activeMinutes: n(acts.minutes),
      gymCheckins: n(visits.c), peopleInChallenges: n(joined[0]?.c),
    };
  }

  /** What was invoiced and collected in the range, and what is owed now (from the finance service). */
  async function billingIn(org, from, to) {
    const [start, end] = instants(from, to);
    const [[inv], [paid], balances] = await Promise.all([
      db(INVOICE).where({ organizationId: org.id }).whereIn('status', BILLED_STATUSES).where('issuedAt', '>=', start).where('issuedAt', '<', end)
        .select(db.raw('COALESCE(SUM("totalTzs"), 0) AS total, COUNT(*) AS c')),
      db(PAYMENT).where({ organizationId: org.id, status: 'received' }).where('receivedAt', '>=', start).where('receivedAt', '<', end)
        .select(db.raw('COALESCE(SUM("amountTzs"), 0) AS total, COUNT(*) AS c')),
      finance.statement({ organizationId: org.id }),
    ]);
    return {
      invoicedTzs: n(inv.total), invoices: n(inv.c), paidTzs: n(paid.total), payments: n(paid.c),
      outstandingTzs: balances.outstandingTzs, overdueTzs: balances.overdueTzs, creditTzs: balances.creditTzs, aging: balances.aging, asOf: balances.asOf,
    };
  }

  /** The flat fees a sponsor committed for passes in months that overlap the range. */
  async function passFees(orgId, from, to, f = {}) {
    let q = db(ENTITLEMENT).where({ organizationId: orgId }).where('period', '>=', from.slice(0, 7)).where('period', '<=', to.slice(0, 7))
      .whereIn('status', ['invoiced', 'scheduled', 'awaiting_link', 'awaiting_member', 'active']);
    if (f.programId) q = q.where({ programId: f.programId });
    if (f.benefitId) q = q.where({ benefitId: f.benefitId });
    if (f.beneficiaryIds) q = q.whereIn('beneficiaryId', f.beneficiaryIds);
    const [row] = await q.select(db.raw(`COUNT(*) AS passes, COUNT(*) FILTER (WHERE "status" = 'active') AS started,
      COALESCE(SUM("sponsorTzs"), 0) AS sponsor, COALESCE(SUM("memberTzs"), 0) AS member`));
    return { passes: n(row.passes), passesStarted: n(row.started), passSponsorTzs: n(row.sponsor), passMemberTzs: n(row.member) };
  }

  async function trend(org, userIds, p, f) {
    const buckets = bucketsBetween(p.from, p.to, p.bucket);
    const [start, end] = instants(p.from, p.to);
    const [usage, usageActive, passActive, acts] = await Promise.all([
      sums(verified(org.id, p.from, p.to, f).groupBy('businessDate').select('businessDate')),
      verified(org.id, p.from, p.to, f).distinct('businessDate', 'beneficiaryId'),
      passCheckins(org.id, p.from, p.to, f).distinct(db.raw(`${dayOf('c."timestamp"')} AS day`), 'e.beneficiaryId'),
      userIds.length
        ? db('Activity').whereIn('userId', userIds).where('startedAt', '>=', start).where('startedAt', '<', end)
          .select(db.raw(`${dayOf('"startedAt"')} AS day, COUNT(*) AS c`)).groupByRaw('1')
        : [],
    ]);
    const by = new Map(buckets.map(b => [b, { bucket: b, uses: 0, sponsorTzs: 0, passCheckins: 0, activities: 0, active: new Set() }]));
    const at = day => by.get(bucketOf(day, p.bucket));
    for (const r of usage) { const b = at(r.businessDate); if (b) { b.uses += n(r.uses); b.sponsorTzs += n(r.sponsorTzs); } }
    for (const r of usageActive) at(r.businessDate)?.active.add(r.beneficiaryId);
    for (const r of passActive) { const b = at(r.day); if (b) { b.active.add(r.beneficiaryId); b.passCheckins += 1; } }
    for (const r of acts) { const b = at(r.day); if (b) b.activities += n(r.c); }
    return [...by.values()].map(({ active, ...b }) => ({ ...b, activeBeneficiaries: active.size }));
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  /** Filters every figure on a screen shares, checked against the organisation. */
  async function filtersOf(org, query) {
    const f = {};
    if (query.programId) {
      const program = await programs.findByIdAsync(String(query.programId));
      if (!program || program.organizationId !== org.id) return fail('program_not_found', 404);
      f.programId = program.id;
    }
    if (query.benefitId) {
      const benefit = await benefits.findByIdAsync(String(query.benefitId));
      const program = benefit ? await programs.findByIdAsync(benefit.programId) : null;
      if (!program || program.organizationId !== org.id) return fail('benefit_not_found', 404);
      f.benefitId = benefit.id;
    }
    if (query.providerId) f.providerId = String(query.providerId);
    if (query.group) f.group = String(query.group);
    return f;
  }

  /**
   * The organisation's wellness programme at a glance for a period, beside
   * the comparable period before it. `?period=` or `?from=&to=`; optional
   * `programId`, `benefitId`, `providerId`, `group` narrow every figure.
   */
  async function dashboard({ access, query = {} }) {
    if (!can(access, READ)) return refuse(READ);
    const p = periodOf(query);
    if (p.error) return p;
    const { org } = access;
    const f = await filtersOf(org, query);
    if (f.error) return f;

    const people = await peopleOf(org, { group: f.group });
    if (f.group) f.beneficiaryIds = people.map(x => x.id);
    const day = today();
    const userIds = people.map(x => x.userId).filter(Boolean);
    const count = status => people.filter(x => x.status === status).length;
    const enrolled = count('active');
    const [start, end] = instants(p.from, p.to);
    const joined = people.filter(x => x.enrolledAt && new Date(x.enrolledAt) >= start && new Date(x.enrolledAt) < end).length;

    const [[use], [prevUse], active, prevActive, [visits], [prevVisits], fees, eng, byProvider, passGyms, series, orgPrograms] = await Promise.all([
      sums(verified(org.id, p.from, p.to, f)),
      sums(verified(org.id, p.previous.from, p.previous.to, f)),
      activeIds(org.id, p.from, p.to, f),
      activeIds(org.id, p.previous.from, p.previous.to, f),
      passCheckins(org.id, p.from, p.to, f).count({ c: '*' }),
      passCheckins(org.id, p.previous.from, p.previous.to, f).count({ c: '*' }),
      passFees(org.id, p.from, p.to, f),
      engagement(org, userIds, p.from, p.to),
      sums(verified(org.id, p.from, p.to, f).groupBy('providerType', 'providerId').select('providerType', 'providerId').countDistinct({ people: 'beneficiaryId' })),
      passCheckins(org.id, p.from, p.to, f).groupBy('c.gymId').select('c.gymId as gymId').count({ c: '*' }).countDistinct({ people: 'e.beneficiaryId' }),
      trend(org, userIds, p, f),
      programs.filterByColumnAsync('organizationId', org.id),
    ]);
    const usage = money(use);
    const previous = money(prevUse);
    const programIds = orgPrograms.filter(x => !f.programId || x.id === f.programId).map(x => x.id);
    const programById = new Map(orgPrograms.map(x => [x.id, x]));
    const orgBenefits = (programIds.length ? await benefits.filterByColumnInAsync('programId', programIds) : []).filter(b => !f.benefitId || b.id === f.benefitId);
    const live = orgBenefits.filter(b => b.status === 'active' && programEffectiveStatus(programById.get(b.programId), day) === 'active');
    const used = await verified(org.id, p.from, p.to, f).distinct('benefitId').pluck('benefitId');
    const usedPass = await passCheckins(org.id, p.from, p.to, f).distinct('e.benefitId').pluck('e.benefitId');
    const ending = live.filter((b) => { const e = benefitValidity(b, programById.get(b.programId)).endDate; return e && e >= day && e <= addDays(day, 30); });

    // Gyms and trainers people actually went to, sponsored either way.
    const providers = new Map();
    for (const r of byProvider) providers.set(`${r.providerType}:${r.providerId}`, { providerType: r.providerType, providerId: r.providerId, uses: n(r.uses), passCheckins: 0, sponsorTzs: n(r.sponsorTzs) });
    for (const r of passGyms) {
      const key = `gym:${r.gymId}`;
      const row = providers.get(key) ?? { providerType: 'gym', providerId: r.gymId, uses: 0, passCheckins: 0, sponsorTzs: 0 };
      row.passCheckins = n(r.c);
      providers.set(key, row);
    }
    const top = [...providers.values()].map(r => ({ ...r, name: providerName(r.providerType, r.providerId), visits: r.uses + r.passCheckins }))
      .sort((a, b) => b.visits - a.visits).slice(0, 5);

    const sponsorSpendTzs = usage.sponsorTzs + fees.passSponsorTzs;
    const sponsoredVisits = usage.uses + n(visits.c);
    const out = {
      organization: { id: org.id, name: org.tradingName || org.legalName },
      period: p, filters: { programId: f.programId ?? null, benefitId: f.benefitId ?? null, providerId: f.providerId ?? null, group: f.group ?? null },
      freshness: 'live', generatedAt: new Date(now()).toISOString(), currency: 'TZS',
      beneficiaries: {
        total: people.length, enrolled, pending: count('pending'), suspended: count('suspended'), inactive: people.length - enrolled - count('pending') - count('suspended'),
        linkedToAccount: userIds.length, enrolledInPeriod: joined,
        groups: [...new Set(people.map(x => x.groupName).filter(Boolean))].sort(),
      },
      participation: {
        activeBeneficiaries: active.size, previousActiveBeneficiaries: prevActive.size, changePct: changePct(active.size, prevActive.size),
        utilisationRatePct: ratePct(active.size, enrolled), inactiveBeneficiaries: Math.max(0, enrolled - active.size),
      },
      usage: {
        ...usage, passCheckins: n(visits.c), sponsoredVisits,
        previous: { ...previous, passCheckins: n(prevVisits.c) }, usesChangePct: changePct(sponsoredVisits, previous.uses + n(prevVisits.c)),
        averagePerActiveBeneficiary: active.size ? Math.round((sponsoredVisits / active.size) * 10) / 10 : null,
      },
      spend: {
        sponsorPerUseTzs: usage.sponsorTzs, sponsorPassFeesTzs: fees.passSponsorTzs, sponsorTotalTzs: sponsorSpendTzs,
        memberPerUseTzs: usage.beneficiaryTzs, memberPassSharesTzs: fees.passMemberTzs, serviceValueTzs: usage.grossTzs,
        passes: fees.passes, passesStarted: fees.passesStarted,
        // Operational indicators, not a return on investment.
        costPerActiveBeneficiaryTzs: perUnit(sponsorSpendTzs, active.size), costPerSponsoredVisitTzs: perUnit(sponsorSpendTzs, sponsoredVisits),
      },
      benefits: { active: live.length, usedInPeriod: new Set([...used, ...usedPass]).size, endingWithin30Days: ending.length, total: orgBenefits.length },
      providers: { used: providers.size, top },
      engagement: eng,
      trend: series,
    };
    // Money owed and paid is for the roles that see billing; filters do not apply to it.
    if (can(access, BILLING)) out.billing = await billingIn(org, p.from, p.to);
    return out;
  }

  // ── People ────────────────────────────────────────────────────────────────

  /**
   * Each person on the organisation's list with what they used and did in the
   * period. `?search=`, `?group=`, `?status=`, `?activity=active|inactive`,
   * `?sort=name|uses|spend|last_active`, `?limit=&cursor=`.
   */
  async function people({ access, query = {} }, { all = false } = {}) {
    if (!can(access, PEOPLE)) return refuse(PEOPLE);
    const p = periodOf(query);
    if (p.error) return p;
    const { org } = access;
    let list = await peopleOf(org, { group: query.group ? String(query.group) : null });
    if (query.status) list = list.filter(x => x.status === String(query.status));
    const needle = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
    if (needle) list = list.filter(x => `${x.displayName ?? ''} ${x.externalReference ?? ''} ${x.groupName ?? ''}`.toLowerCase().includes(needle));

    const ids = list.map(x => x.id);
    const userIds = list.map(x => x.userId).filter(Boolean);
    const [start, end] = instants(p.from, p.to);
    const f = { beneficiaryIds: ids };
    const [usage, passes, acts, visits] = ids.length ? await Promise.all([
      sums(verified(org.id, p.from, p.to, f).groupBy('beneficiaryId').select('beneficiaryId').max({ last: 'businessDate' })),
      passCheckins(org.id, p.from, p.to, f).groupBy('e.beneficiaryId').select('e.beneficiaryId as beneficiaryId').count({ c: '*' }).max({ last: 'c.timestamp' }),
      userIds.length ? db('Activity').whereIn('userId', userIds).where('startedAt', '>=', start).where('startedAt', '<', end).groupBy('userId').select('userId')
        .select(db.raw(`COUNT(*) AS activities, COUNT(*) FILTER (WHERE ${WORKOUT}) AS workouts,
          COALESCE(SUM("steps"), 0) AS steps, COALESCE(SUM(COALESCE("activeMinutes", "durationMinutes")), 0) AS minutes, MAX("startedAt") AS last`)) : [],
      userIds.length ? db('Checkin').whereIn('memberId', userIds).where({ status: 'valid' }).where('timestamp', '>=', start).where('timestamp', '<', end)
        .groupBy('memberId').select('memberId').count({ c: '*' }).max({ last: 'timestamp' }) : [],
    ]) : [[], [], [], []];
    const usageBy = new Map(usage.map(r => [r.beneficiaryId, r]));
    const passBy = new Map(passes.map(r => [r.beneficiaryId, r]));
    const actBy = new Map(acts.map(r => [r.userId, r]));
    const visitBy = new Map(visits.map(r => [r.memberId, r]));
    const latest = (...days) => days.filter(Boolean).sort().pop() ?? null;

    let rows = list.map((x) => {
      const u = usageBy.get(x.id);
      const ps = passBy.get(x.id);
      const a = x.userId ? actBy.get(x.userId) : null;
      const v = x.userId ? visitBy.get(x.userId) : null;
      const sponsoredUses = n(u?.uses);
      const onPass = n(ps?.c);
      return {
        beneficiaryId: x.id, name: x.displayName ?? null, externalReference: x.externalReference ?? null, group: x.groupName ?? null,
        beneficiaryType: x.beneficiaryType, status: x.status, enrolledAt: x.enrolledAt ?? null, linkedToAccount: !!x.userId,
        active: sponsoredUses + onPass > 0,
        sponsoredUses, passCheckins: onPass, sponsorTzs: n(u?.sponsorTzs), memberTzs: n(u?.beneficiaryTzs), serviceValueTzs: n(u?.grossTzs),
        gymCheckins: n(v?.c), activities: n(a?.activities), workouts: n(a?.workouts), steps: n(a?.steps), activeMinutes: n(a?.minutes),
        lastActiveDay: latest(u?.last ?? null, ps?.last ? localDay(ps.last) : null, a?.last ? localDay(a.last) : null, v?.last ? localDay(v.last) : null),
      };
    });
    if (query.activity === 'active') rows = rows.filter(r => r.active);
    if (query.activity === 'inactive') rows = rows.filter(r => !r.active && r.status === 'active');
    const sorters = {
      uses: (a, b) => (b.sponsoredUses + b.passCheckins) - (a.sponsoredUses + a.passCheckins),
      spend: (a, b) => b.sponsorTzs - a.sponsorTzs,
      last_active: (a, b) => (b.lastActiveDay ?? '').localeCompare(a.lastActiveDay ?? ''),
      name: (a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿'),
    };
    rows.sort(sorters[query.sort] ?? sorters.name);
    if (all) return { period: p, items: rows, total: rows.length };
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
    return { period: p, items: rows.slice(offset, offset + limit), total: rows.length, nextCursor: offset + limit < rows.length ? offset + limit : null };
  }

  /**
   * One person in a period: the benefits they used, each sponsored visit and
   * session, their pass check-ins, what else they did on FitFlex, and their
   * progress in the organisation's own challenges.
   *
   * Left out on purpose: weight, height, calories, notes and routes; and any
   * visit, benefit or challenge another organisation funds or runs.
   */
  async function person({ access, beneficiaryId, query = {} }) {
    if (!can(access, PEOPLE)) return refuse(PEOPLE);
    const p = periodOf(query);
    if (p.error) return p;
    const { org } = access;
    const who = (await peopleOf(org)).find(x => x.id === beneficiaryId);
    if (!who) return fail('beneficiary_not_found', 404);
    const [start, end] = instants(p.from, p.to);
    const f = { beneficiaryIds: [who.id] };
    const cap = 300;

    const [usageRows, [use], byBenefit, passRows, passes] = await Promise.all([
      verified(org.id, p.from, p.to, f).orderBy('consumedAt', 'desc').limit(cap)
        .select('id', 'businessDate', 'benefitId', 'programId', 'serviceType', 'providerType', 'providerId', 'quantity', 'grossTzs', 'sponsorTzs', 'beneficiaryTzs'),
      sums(verified(org.id, p.from, p.to, f)),
      sums(verified(org.id, p.from, p.to, f).groupBy('benefitId').select('benefitId')),
      passCheckins(org.id, p.from, p.to, f).orderBy('c.timestamp', 'desc').limit(cap).select('c.id', 'c.timestamp', 'c.gymId', 'c.passTier', 'e.benefitId'),
      db(ENTITLEMENT).where({ organizationId: org.id, beneficiaryId: who.id }).where('period', '>=', p.from.slice(0, 7)).where('period', '<=', p.to.slice(0, 7))
        .orderBy('period', 'desc').select('period', 'passTier', 'status', 'sponsorTzs', 'memberTzs', 'benefitId', 'activatedAt'),
    ]);
    const benefitIds = [...new Set([...usageRows.map(r => r.benefitId), ...byBenefit.map(r => r.benefitId), ...passRows.map(r => r.benefitId), ...passes.map(r => r.benefitId)])];
    const named = benefitIds.length ? await benefits.filterByColumnInAsync('id', benefitIds) : [];
    const benefitName = new Map(named.map(b => [b.id, b.name]));

    let activities = [];
    let otherVisits = [];
    let challenges = [];
    if (who.userId) {
      const sponsoredHere = new Set(passRows.map(r => r.id));
      const [acts, visits, funded, otherPasses] = await Promise.all([
        db('Activity').where({ userId: who.userId }).where('startedAt', '>=', start).where('startedAt', '<', end).orderBy('startedAt', 'desc').limit(cap)
          .select('id', 'type', 'source', 'startedAt', 'durationMinutes', 'distanceKm', 'steps', 'activeMinutes', 'intensity', 'gymId'),
        db('Checkin').where({ memberId: who.userId, status: 'valid' }).where('timestamp', '>=', start).where('timestamp', '<', end).orderBy('timestamp', 'desc').limit(cap)
          .select('id', 'timestamp', 'gymId', 'subscriptionId'),
        // Visits any organisation funded per use: this one's are listed above, another's are not this organisation's business.
        db(USAGE).where({ userId: who.userId, sourceType: 'gym_checkin' }).whereIn('status', ['pending', 'approved']).where('businessDate', '>=', addDays(p.from, -1)).where('businessDate', '<=', addDays(p.to, 1)).pluck('sourceId'),
        db(ENTITLEMENT).where({ userId: who.userId }).whereNot({ organizationId: org.id }).whereNotNull('subscriptionId').pluck('subscriptionId'),
      ]);
      const perUse = new Set(funded);
      const elsewhere = new Set(otherPasses);
      activities = acts.map(a => ({
        id: a.id, day: localDay(a.startedAt), type: a.type, source: a.source, durationMinutes: a.durationMinutes ?? null, distanceKm: a.distanceKm ?? null,
        steps: a.steps ?? null, activeMinutes: a.activeMinutes ?? null, intensity: a.intensity ?? null, gym: a.gymId ? providerName('gym', a.gymId) : null,
      }));
      otherVisits = visits.filter(v => !sponsoredHere.has(v.id) && !perUse.has(v.id) && !(v.subscriptionId && elsewhere.has(v.subscriptionId)))
        .map(v => ({ id: v.id, day: localDay(v.timestamp), gym: providerName('gym', v.gymId) }));
      const [creatorType, creatorId] = companyOf(org);
      challenges = await challengeProgress(creatorType, creatorId, who.userId);
    }

    return {
      period: p,
      beneficiary: {
        id: who.id, name: who.displayName ?? null, externalReference: who.externalReference ?? null, group: who.groupName ?? null,
        beneficiaryType: who.beneficiaryType, status: who.status, enrolledAt: who.enrolledAt ?? null, linkedToAccount: !!who.userId,
      },
      totals: { ...money(use), passCheckins: passRows.length, activities: activities.length, otherGymVisits: otherVisits.length, capped: [usageRows, passRows, activities].some(r => r.length >= cap) },
      byBenefit: byBenefit.map(r => ({ benefitId: r.benefitId, benefitName: benefitName.get(r.benefitId) ?? null, ...money(r) })),
      passes: passes.map(e => ({ period: e.period, passTier: e.passTier, status: e.status, sponsorTzs: e.sponsorTzs, memberTzs: e.memberTzs, benefitName: benefitName.get(e.benefitId) ?? null, startedAt: e.activatedAt ?? null })),
      sponsoredUsage: usageRows.map(r => ({
        id: r.id, day: r.businessDate, benefitName: benefitName.get(r.benefitId) ?? null, serviceType: r.serviceType,
        providerType: r.providerType, provider: providerName(r.providerType, r.providerId), quantity: r.quantity, serviceValueTzs: r.grossTzs, sponsorTzs: r.sponsorTzs, memberTzs: r.beneficiaryTzs,
      })),
      passCheckins: passRows.map(r => ({ id: r.id, day: localDay(r.timestamp), gym: providerName('gym', r.gymId), passTier: r.passTier ?? null, benefitName: benefitName.get(r.benefitId) ?? null })),
      otherGymVisits: otherVisits,
      activities,
      challenges,
      notShown: ['weight', 'height', 'calories', 'notes', 'routes', 'benefits and challenges from other organisations'],
    };
  }

  // ── Programmes and benefits ───────────────────────────────────────────────

  async function benefitRows(org, p, orgPrograms, list) {
    const day = today();
    const enrolledPeople = (await peopleOf(org)).filter(x => x.status === 'active');
    const programById = new Map(orgPrograms.map(x => [x.id, x]));
    const [usage, passUse, fees] = await Promise.all([
      sums(verified(org.id, p.from, p.to).groupBy('benefitId').select('benefitId').countDistinct({ people: 'beneficiaryId' })),
      passCheckins(org.id, p.from, p.to).groupBy('e.benefitId').select('e.benefitId as benefitId').count({ c: '*' }).countDistinct({ people: 'e.beneficiaryId' }),
      db(ENTITLEMENT).where({ organizationId: org.id }).where('period', '>=', p.from.slice(0, 7)).where('period', '<=', p.to.slice(0, 7))
        .whereIn('status', ['invoiced', 'scheduled', 'awaiting_link', 'awaiting_member', 'active']).groupBy('benefitId').select('benefitId')
        .select(db.raw(`COUNT(*) AS passes, COUNT(*) FILTER (WHERE "status" = 'active') AS started, COALESCE(SUM("sponsorTzs"), 0) AS sponsor, COALESCE(SUM("memberTzs"), 0) AS member`)),
    ]);
    const usageBy = new Map(usage.map(r => [r.benefitId, r]));
    const passBy = new Map(passUse.map(r => [r.benefitId, r]));
    const feeBy = new Map(fees.map(r => [r.benefitId, r]));

    const out = [];
    for (const b of list) {
      const program = programById.get(b.programId);
      const eligible = enrolledPeople.filter(x => !matchesPopulation({ program, beneficiary: x, benefit: b }));
      const u = usageBy.get(b.id);
      const ps = passBy.get(b.id);
      const fee = feeBy.get(b.id);
      const pass = b.benefitType === FLAT_FEE_BENEFIT;
      const users = pass ? n(ps?.people) : n(u?.people);
      const uses = pass ? n(ps?.c) : n(u?.uses);
      const row = {
        benefitId: b.id, name: b.name, benefitType: b.benefitType, status: b.status, programId: b.programId, programName: program?.name ?? null,
        fundingType: b.fundingType, usageLimit: b.usageLimit ?? null, usagePeriod: b.usagePeriod ?? null, validity: program ? benefitValidity(b, program) : null,
        eligible: eligible.length, users, uses,
        // Reach: the share of eligible people who used it at all. Defined for every benefit.
        reachPct: ratePct(users, eligible.length), averageUsesPerUser: users ? Math.round((uses / users) * 10) / 10 : null,
        serviceValueTzs: n(u?.grossTzs), sponsorTzs: pass ? n(fee?.sponsor) : n(u?.sponsorTzs), memberTzs: pass ? n(fee?.member) : n(u?.beneficiaryTzs),
        passes: pass ? n(fee?.passes) : null, passesStarted: pass ? n(fee?.started) : null,
        allowance: null,
      };
      // Allowance used: only for a benefit with a limit, and only for the window in force today.
      const window = program && b.usageLimit && b.status === 'active' && programEffectiveStatus(program, day) === 'active' ? usageWindow({ benefit: b, program, day }) : null;
      if (window && window.start <= day && (window.end === null || window.end >= day)) {
        const per = await verified(org.id, window.start, window.end ?? day, { benefitId: b.id }).groupBy('beneficiaryId').select('beneficiaryId').sum({ q: 'quantity' });
        const consumed = per.reduce((t, r) => t + n(r.q), 0);
        const available = eligible.length * b.usageLimit;
        row.allowance = {
          windowStart: window.start, windowEnd: window.end, consumedUnits: consumed, availableUnits: available, usedPct: ratePct(consumed, available),
          peopleAtLimit: per.filter(r => n(r.q) >= b.usageLimit).length, peopleNearLimit: per.filter(r => n(r.q) >= b.usageLimit * 0.8 && n(r.q) < b.usageLimit).length,
        };
      }
      out.push(row);
    }
    return out;
  }

  /** Every benefit of the organisation: who could use it, who did, how much, and what it cost each side. */
  async function benefitAnalytics({ access, query = {} }) {
    if (!can(access, READ)) return refuse(READ);
    const p = periodOf(query);
    if (p.error) return p;
    const { org } = access;
    const orgPrograms = (await programs.filterByColumnAsync('organizationId', org.id)).filter(x => !query.programId || x.id === String(query.programId));
    const list = orgPrograms.length ? await benefits.filterByColumnInAsync('programId', orgPrograms.map(x => x.id)) : [];
    return { period: p, items: await benefitRows(org, p, orgPrograms, list) };
  }

  /** Every programme side by side: people, participation, usage, spend against budget. */
  async function programAnalytics({ access, query = {} }) {
    if (!can(access, READ)) return refuse(READ);
    const p = periodOf(query);
    if (p.error) return p;
    const { org } = access;
    const day = today();
    const orgPrograms = await programs.filterByColumnAsync('organizationId', org.id);
    const enrolledPeople = (await peopleOf(org)).filter(x => x.status === 'active');
    const list = orgPrograms.length ? await benefits.filterByColumnInAsync('programId', orgPrograms.map(x => x.id)) : [];
    const rows = await benefitRows(org, p, orgPrograms, list);
    const [usage, spentEver] = await Promise.all([
      sums(verified(org.id, p.from, p.to).groupBy('programId').select('programId')),
      db(USAGE).where({ organizationId: org.id }).whereIn('status', ['pending', 'approved']).groupBy('programId').select('programId').sum({ t: 'sponsorTzs' }),
    ]);
    const usageBy = new Map(usage.map(r => [r.programId, r]));
    const spentBy = new Map(spentEver.map(r => [r.programId, n(r.t)]));
    const items = [];
    for (const g of orgPrograms) {
      const mine = rows.filter(r => r.programId === g.id);
      const active = await activeIds(org.id, p.from, p.to, { programId: g.id });
      const eligible = enrolledPeople.filter(x => !matchesPopulation({ program: g, beneficiary: x })).length;
      const u = money(usageBy.get(g.id));
      const passSponsor = mine.filter(r => r.benefitType === FLAT_FEE_BENEFIT).reduce((t, r) => t + r.sponsorTzs, 0);
      const passVisits = mine.filter(r => r.benefitType === FLAT_FEE_BENEFIT).reduce((t, r) => t + r.uses, 0);
      const committed = spentBy.get(g.id) ?? 0;
      items.push({
        programId: g.id, name: g.name, programType: g.programType, status: programEffectiveStatus(g, day), startDate: g.startDate, endDate: g.endDate ?? null,
        benefits: mine.length, activeBenefits: mine.filter(r => r.status === 'active').length,
        eligible, activeBeneficiaries: active.size, participationPct: ratePct(active.size, eligible),
        uses: u.uses, passCheckins: passVisits, serviceValueTzs: u.grossTzs, sponsorPerUseTzs: u.sponsorTzs, sponsorPassFeesTzs: passSponsor, sponsorTotalTzs: u.sponsorTzs + passSponsor, memberTzs: u.beneficiaryTzs,
        // The budget counts per-use sponsor money over the programme's whole life, as the consumption engine does.
        budget: { budgetTzs: g.budgetTzs ?? null, committedTzs: committed, remainingTzs: g.budgetTzs == null ? null : Math.max(0, g.budgetTzs - committed), usedPct: g.budgetTzs ? ratePct(committed, g.budgetTzs) : null },
      });
    }
    return { period: p, items };
  }

  // ── Providers ─────────────────────────────────────────────────────────────

  /**
   * Where the organisation's people went: each gym and trainer with visits,
   * people, repeat users and the value of the service. FitFlex staff also get
   * how far settlement of those visits has got; what a provider is paid is
   * not shown to an organisation.
   */
  async function providerAnalytics({ access, query = {} }) {
    if (!can(access, READ)) return refuse(READ);
    const p = periodOf(query);
    if (p.error) return p;
    const { org } = access;
    const f = await filtersOf(org, query);
    if (f.error) return f;
    const [per, perPerson, passGyms, passPerPerson] = await Promise.all([
      sums(verified(org.id, p.from, p.to, f).groupBy('providerType', 'providerId').select('providerType', 'providerId').countDistinct({ people: 'beneficiaryId' })),
      verified(org.id, p.from, p.to, f).groupBy('providerType', 'providerId', 'beneficiaryId').select('providerType', 'providerId', 'beneficiaryId').sum({ q: 'quantity' }),
      passCheckins(org.id, p.from, p.to, f).groupBy('c.gymId').select('c.gymId as gymId').count({ c: '*' }).countDistinct({ people: 'e.beneficiaryId' }),
      passCheckins(org.id, p.from, p.to, f).groupBy('c.gymId', 'e.beneficiaryId').select('c.gymId as gymId', 'e.beneficiaryId as beneficiaryId').count({ c: '*' }),
    ]);
    const rows = new Map();
    const row = (type, id) => {
      const key = `${type}:${id}`;
      if (!rows.has(key)) rows.set(key, { providerType: type, providerId: id, name: providerName(type, id), location: type === 'gym' ? gyms.find(g => g.id === id)?.location ?? null : null,
        uses: 0, passCheckins: 0, serviceValueTzs: 0, sponsorTzs: 0, memberTzs: 0, visitsBy: new Map() });
      return rows.get(key);
    };
    for (const r of per) { const x = row(r.providerType, r.providerId); x.uses = n(r.uses); x.serviceValueTzs = n(r.grossTzs); x.sponsorTzs = n(r.sponsorTzs); x.memberTzs = n(r.beneficiaryTzs); }
    for (const r of perPerson) { const x = row(r.providerType, r.providerId); x.visitsBy.set(r.beneficiaryId, (x.visitsBy.get(r.beneficiaryId) ?? 0) + n(r.q)); }
    for (const r of passGyms) row('gym', r.gymId).passCheckins = n(r.c);
    for (const r of passPerPerson) { const x = row('gym', r.gymId); x.visitsBy.set(r.beneficiaryId, (x.visitsBy.get(r.beneficiaryId) ?? 0) + n(r.c)); }

    let settled = new Map();
    if (access.platformAdmin && rows.size) {
      // How many of the per-use gym visits the settlement engine has taken into a live run.
      const done = await db(`${USAGE} as u`).join('SettlementVisit as v', 'v.checkinId', 'u.sourceId')
        .where({ 'u.organizationId': org.id, 'u.status': 'approved', 'u.sourceType': 'gym_checkin', 'v.mode': 'live', 'v.active': true })
        .where('u.businessDate', '>=', p.from).where('u.businessDate', '<=', p.to).groupBy('u.providerId').select('u.providerId as providerId').count({ c: '*' });
      settled = new Map(done.map(r => [r.providerId, n(r.c)]));
    }
    const items = [...rows.values()].map(({ visitsBy, ...x }) => ({
      ...x, visits: x.uses + x.passCheckins, people: visitsBy.size, repeatPeople: [...visitsBy.values()].filter(c => c >= 2).length,
      ...(access.platformAdmin && x.providerType === 'gym' ? { settlement: { perUseVisits: x.uses, inLiveSettlement: settled.get(x.providerId) ?? 0, notYetSettled: Math.max(0, x.uses - (settled.get(x.providerId) ?? 0)) } } : {}),
    })).sort((a, b) => b.visits - a.visits);
    return { period: p, items, totals: { providers: items.length, visits: items.reduce((t, x) => t + x.visits, 0), serviceValueTzs: items.reduce((t, x) => t + x.serviceValueTzs, 0) } };
  }

  // ── Money ─────────────────────────────────────────────────────────────────

  /**
   * Billing over time for the roles that see billing: invoiced and collected
   * by month, what is owed now with aging, and the sponsor's usage beside it.
   * Invoiced and outstanding come from the invoice and payment tables; they
   * are not recalculated from usage.
   */
  async function financeAnalytics({ access, query = {} }) {
    if (!can(access, BILLING)) return refuse(BILLING);
    const p = periodOf(query);
    if (p.error) return p;
    const { org } = access;
    const [start, end] = instants(p.from, p.to);
    const month = col => `to_char(${col} AT TIME ZONE '${TZ}', 'YYYY-MM')`;
    const [inv, paid, usage, fees, billing] = await Promise.all([
      db(INVOICE).where({ organizationId: org.id }).whereIn('status', BILLED_STATUSES).where('issuedAt', '>=', start).where('issuedAt', '<', end)
        .select(db.raw(`${month('"issuedAt"')} AS m, "kind", COALESCE(SUM("totalTzs"), 0) AS total, COUNT(*) AS c`)).groupByRaw('1, 2'),
      db(PAYMENT).where({ organizationId: org.id, status: 'received' }).where('receivedAt', '>=', start).where('receivedAt', '<', end)
        .select(db.raw(`${month('"receivedAt"')} AS m, COALESCE(SUM("amountTzs"), 0) AS total`)).groupByRaw('1'),
      verified(org.id, p.from, p.to).select(db.raw('left("businessDate", 7) AS m')).sum({ sponsorTzs: 'sponsorTzs', beneficiaryTzs: 'beneficiaryTzs', grossTzs: 'grossTzs' }).groupByRaw('1'),
      db(ENTITLEMENT).where({ organizationId: org.id }).where('period', '>=', p.from.slice(0, 7)).where('period', '<=', p.to.slice(0, 7))
        .whereIn('status', ['invoiced', 'scheduled', 'awaiting_link', 'awaiting_member', 'active']).groupBy('period').select('period').sum({ sponsorTzs: 'sponsorTzs', memberTzs: 'memberTzs' }),
      billingIn(org, p.from, p.to),
    ]);
    const months = bucketsBetween(p.from, p.to, 'month').map(d => d.slice(0, 7));
    const by = new Map(months.map(m => [m, { month: m, invoicedTzs: 0, creditNotesTzs: 0, collectedTzs: 0, sponsorPerUseTzs: 0, sponsorPassFeesTzs: 0, memberTzs: 0, serviceValueTzs: 0 }]));
    for (const r of inv) { const b = by.get(r.m); if (b) { if (r.kind === 'credit_note') b.creditNotesTzs += -n(r.total); else b.invoicedTzs += n(r.total); } }
    for (const r of paid) { const b = by.get(r.m); if (b) b.collectedTzs += n(r.total); }
    for (const r of usage) { const b = by.get(r.m); if (b) { b.sponsorPerUseTzs += n(r.sponsorTzs); b.memberTzs += n(r.beneficiaryTzs); b.serviceValueTzs += n(r.grossTzs); } }
    for (const r of fees) { const b = by.get(r.period); if (b) { b.sponsorPassFeesTzs += n(r.sponsorTzs); b.memberTzs += n(r.memberTzs); } }
    return { period: p, billing, months: [...by.values()], note: 'Invoiced is what FitFlex has issued; sponsor usage is what was used. They differ by timing (usage is invoiced after the month), VAT and platform fees.' };
  }

  // ── FitFlex staff: across organisations ───────────────────────────────────

  /** The whole B2B book for a period: organisations, people, usage, top organisations and providers. */
  async function overview({ query = {} } = {}) {
    const p = periodOf(query);
    if (p.error) return p;
    const [start, end] = instants(p.from, p.to);
    const span = q => q.where('businessDate', '>=', p.from).where('businessDate', '<=', p.to).where({ status: 'approved' });
    const prev = q => q.where('businessDate', '>=', p.previous.from).where('businessDate', '<=', p.previous.to).where({ status: 'approved' });
    const passIn = (from, to) => { const [s, e] = instants(from, to); return db('Checkin as c').join(`${ENTITLEMENT} as e`, 'e.subscriptionId', 'c.subscriptionId').where('c.status', 'valid').where('c.timestamp', '>=', s).where('c.timestamp', '<', e); };
    const [orgs, native, staff, [use], [prevUse], perUseActive, passActive, [visits], byOrg, passByOrg, byProvider, daily, [inv], [paid], created] = await Promise.all([
      db('B2BOrganization').groupBy('status', 'organizationType').select('status', 'organizationType').count({ c: '*' }),
      db('B2BBeneficiary').groupBy('status').select('status').count({ c: '*' }).select(db.raw('COUNT("userId") AS linked')),
      db('CorporateEmployee as e').join('B2BOrganization as o', 'o.legacyCorporateId', 'e.corporateId').groupBy('e.status').select('e.status').count({ c: '*' }).select(db.raw('COUNT(e."userId") AS linked')),
      sums(span(db(USAGE))),
      sums(prev(db(USAGE))),
      span(db(USAGE)).distinct('organizationId', 'beneficiaryId'),
      passIn(p.from, p.to).distinct('e.organizationId as organizationId', 'e.beneficiaryId as beneficiaryId'),
      passIn(p.from, p.to).count({ c: '*' }),
      sums(span(db(USAGE)).groupBy('organizationId').select('organizationId')),
      passIn(p.from, p.to).groupBy('e.organizationId').select('e.organizationId as organizationId').count({ c: '*' }),
      sums(span(db(USAGE)).groupBy('providerType', 'providerId').select('providerType', 'providerId').countDistinct({ people: 'beneficiaryId' }).countDistinct({ orgs: 'organizationId' })),
      sums(span(db(USAGE)).groupBy('businessDate').select('businessDate')),
      db(INVOICE).whereIn('status', BILLED_STATUSES).where('issuedAt', '>=', start).where('issuedAt', '<', end).select(db.raw('COALESCE(SUM("totalTzs"), 0) AS total')),
      db(PAYMENT).where({ status: 'received' }).where('receivedAt', '>=', start).where('receivedAt', '<', end).select(db.raw('COALESCE(SUM("amountTzs"), 0) AS total')),
      db('B2BOrganization').where('createdAt', '>=', start).where('createdAt', '<', end).count({ c: '*' }),
    ]);
    const active = new Set([...perUseActive, ...passActive].map(r => `${r.organizationId}:${r.beneficiaryId}`));
    const activeByOrg = new Map();
    for (const key of active) { const id = key.slice(0, key.indexOf(':')); activeByOrg.set(id, (activeByOrg.get(id) ?? 0) + 1); }
    const passVisits = new Map(passByOrg.map(r => [r.organizationId, n(r.c)]));
    const orgIds = [...new Set([...byOrg.map(r => r.organizationId), ...passVisits.keys()])];
    const names = new Map((orgIds.length ? await db('B2BOrganization').whereIn('id', orgIds).select('id', 'legalName', 'tradingName') : []).map(o => [o.id, o.tradingName || o.legalName]));
    const usageByOrg = new Map(byOrg.map(r => [r.organizationId, money(r)]));
    const enrolled = n(native.find(r => r.status === 'active')?.c) + n(staff.find(r => r.status === 'active')?.c);
    const totalPeople = [...native, ...staff].reduce((t, r) => t + n(r.c), 0);
    const buckets = new Map(bucketsBetween(p.from, p.to, p.bucket).map(b => [b, { bucket: b, uses: 0, sponsorTzs: 0 }]));
    for (const r of daily) { const b = buckets.get(bucketOf(r.businessDate, p.bucket)); if (b) { b.uses += n(r.uses); b.sponsorTzs += n(r.sponsorTzs); } }
    const usage = money(use);
    const previous = money(prevUse);
    return {
      period: p, freshness: 'live', generatedAt: new Date(now()).toISOString(), currency: 'TZS',
      organizations: {
        total: orgs.reduce((t, r) => t + n(r.c), 0), active: orgs.filter(r => r.status === 'active').reduce((t, r) => t + n(r.c), 0), createdInPeriod: n(created[0]?.c),
        withUsage: orgIds.length,
        byStatus: Object.entries(orgs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + n(r.c) }), {})).map(([status, count]) => ({ status, count })),
        byType: Object.entries(orgs.reduce((m, r) => ({ ...m, [r.organizationType]: (m[r.organizationType] ?? 0) + n(r.c) }), {})).map(([organizationType, count]) => ({ organizationType, count })),
      },
      beneficiaries: { total: totalPeople, enrolled, linkedToAccount: [...native, ...staff].reduce((t, r) => t + n(r.linked), 0), active: active.size, utilisationRatePct: ratePct(active.size, enrolled) },
      usage: { ...usage, passCheckins: n(visits.c), previous, usesChangePct: changePct(usage.uses, previous.uses) },
      billing: { invoicedTzs: n(inv.total), collectedTzs: n(paid.total) },
      topOrganizations: orgIds.map(id => ({ organizationId: id, name: names.get(id) ?? null, ...(usageByOrg.get(id) ?? money()), passCheckins: passVisits.get(id) ?? 0, activeBeneficiaries: activeByOrg.get(id) ?? 0 }))
        .sort((a, b) => (b.uses + b.passCheckins) - (a.uses + a.passCheckins)).slice(0, 10),
      topProviders: byProvider.map(r => ({ providerType: r.providerType, providerId: r.providerId, name: providerName(r.providerType, r.providerId), ...money(r), people: n(r.people), organizations: n(r.orgs) }))
        .sort((a, b) => b.uses - a.uses).slice(0, 10),
      trend: [...buckets.values()],
    };
  }

  // ── Data quality ──────────────────────────────────────────────────────────

  /**
   * Records that should not exist, or that are missing their other half.
   * Nothing is repaired here: each check reports how many and a few examples
   * for a person to look into.
   */
  async function dataQuality() {
    const sample = 5;
    const check = async (key, severity, title, query, idColumn = 'id') => {
      const rows = await db.from(query.clone().as('t')).limit(sample).pluck(idColumn);
      const [{ c }] = rows.length < sample ? [{ c: rows.length }] : await db.from(query.clone().as('t')).count({ c: '*' });
      return { key, severity, title, count: n(c), examples: rows };
    };
    const staleDay = addDays(today(), -2);
    const checks = await Promise.all([
      check('usage_without_benefit', 'high', 'Usage whose benefit no longer exists',
        db(`${USAGE} as u`).leftJoin('B2BBenefit as b', 'b.id', 'u.benefitId').whereNull('b.id').select('u.id'), 'id'),
      check('usage_without_person', 'medium', 'Verified usage with no member account behind it',
        db(USAGE).where({ status: 'approved' }).whereNull('userId').select('id')),
      check('gym_usage_without_checkin', 'high', 'Verified gym usage whose check-in is missing or voided',
        db(`${USAGE} as u`).leftJoin('Checkin as c', 'c.id', 'u.sourceId').where({ 'u.status': 'approved', 'u.sourceType': 'gym_checkin' })
          .where(q => q.whereNull('c.id').orWhereNot('c.status', 'valid')).select('u.id'), 'id'),
      check('trainer_usage_without_booking', 'high', 'Verified trainer usage whose booking is missing or not completed',
        db(`${USAGE} as u`).leftJoin('TrainerBooking as t', 't.id', 'u.sourceId').where({ 'u.status': 'approved', 'u.sourceType': 'trainer_booking' })
          .where(q => q.whereNull('t.id').orWhereNot('t.status', 'completed')).select('u.id'), 'id'),
      check('stale_holds', 'medium', 'Usage still on hold after two days',
        db(USAGE).where({ status: 'pending' }).where('businessDate', '<', staleDay).select('id')),
      check('usage_shares_do_not_add_up', 'high', 'Usage where the sponsor and member shares do not add up to the value',
        db(USAGE).whereIn('status', ['pending', 'approved']).whereRaw('"sponsorTzs" + "beneficiaryTzs" <> "grossTzs"').select('id')),
      check('usage_not_invoiced', 'medium', 'Verified sponsor usage from a closed month that is on no invoice',
        db(`${USAGE} as u`).leftJoin('B2BSponsorInvoiceLine as l', function on() { this.on('l.consumptionId', 'u.id').andOn('l.active', db.raw('true')); })
          .where({ 'u.status': 'approved' }).where('u.sponsorTzs', '>', 0).where('u.businessDate', '<', `${addDays(`${today().slice(0, 7)}-01`, -1).slice(0, 7)}-01`).whereNull('l.id').select('u.id'), 'id'),
      check('invoice_lines_do_not_add_up', 'high', 'Invoices whose lines do not add up to the total',
        db(`${INVOICE} as i`).whereIn('i.status', BILLED_STATUSES)
          .whereRaw('i."totalTzs" <> COALESCE((SELECT SUM(l."amountTzs") FROM "B2BSponsorInvoiceLine" l WHERE l."invoiceId" = i."id" AND l."active"), 0)').select('i.id'), 'id'),
      check('invoice_paid_more_than_total', 'high', 'Invoices with more applied to them than they are for',
        db(INVOICE).whereIn('status', BILLED_STATUSES).whereRaw('"amountPaidTzs" > abs("totalTzs")').select('id')),
      check('payment_over_allocated', 'high', 'Payments with more allocated than was received',
        db(PAYMENT).where({ status: 'received' }).whereRaw('"allocatedTzs" > "amountTzs"').select('id')),
      check('allocation_without_payment', 'high', 'Allocations on a reversed payment that are still active',
        db('B2BPaymentAllocation as a').join(`${PAYMENT} as p`, 'p.id', 'a.paymentId').where({ 'a.active': true, 'p.status': 'reversed' }).select('a.id'), 'id'),
      check('pass_started_without_subscription', 'medium', 'Sponsored passes marked started with no pass behind them',
        db(ENTITLEMENT).where({ status: 'active' }).whereNull('subscriptionId').select('id')),
      check('beneficiary_without_account', 'low', 'Active beneficiaries whose member account no longer exists',
        db('B2BBeneficiary as b').leftJoin('User as u', 'u.id', 'b.userId').where({ 'b.status': 'active' }).whereNotNull('b.userId').whereNull('u.id').select('b.id'), 'id'),
    ]);
    return { checkedAt: new Date(now()).toISOString(), issues: checks.filter(c => c.count > 0).length, checks };
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  const REPORTS = Object.freeze({
    beneficiaries: { permission: PEOPLE, title: 'Beneficiaries' },
    usage: { permission: PEOPLE, title: 'Sponsored usage' },
    activity: { permission: PEOPLE, title: 'Member activity' },
    benefits: { permission: READ, title: 'Benefit utilisation' },
    programs: { permission: READ, title: 'Programme performance' },
    providers: { permission: READ, title: 'Provider utilisation' },
    invoices: { permission: BILLING, title: 'Invoices' },
    payments: { permission: BILLING, title: 'Payments' },
  });

  /** A report as CSV for the period. Every export is written to the audit log. */
  async function exportCsv({ access, report, query = {}, actorId }) {
    const spec = REPORTS[report];
    if (!spec) return fail('unknown_report', 404, { allowed: Object.keys(REPORTS) });
    if (!can(access, spec.permission)) return refuse(spec.permission);
    const p = periodOf(query);
    if (p.error) return p;
    const { org } = access;
    const col = (key, label) => ({ key, label });
    let columns;
    let rows;
    if (report === 'beneficiaries') {
      const out = await people({ access, query }, { all: true });
      if (out.error) return out;
      rows = out.items;
      columns = [col('name', 'Name'), col('externalReference', 'Reference'), col('group', 'Group'), col('beneficiaryType', 'Type'), col('status', 'Status'), col('enrolledAt', 'Enrolled'),
        col('active', 'Used a benefit'), col('sponsoredUses', 'Sponsored uses'), col('passCheckins', 'Pass check-ins'), col('sponsorTzs', 'Sponsor paid (TZS)'), col('memberTzs', 'Member paid (TZS)'),
        col('gymCheckins', 'All gym check-ins'), col('activities', 'Activities'), col('workouts', 'Workouts'), col('steps', 'Steps'), col('activeMinutes', 'Active minutes'), col('lastActiveDay', 'Last active')];
      rows = rows.map(r => ({ ...r, active: r.active ? 'yes' : 'no', enrolledAt: r.enrolledAt ? localDay(r.enrolledAt) : '' }));
    } else if (report === 'usage') {
      const list = await peopleOf(org);
      const name = new Map(list.map(x => [x.id, x]));
      const usage = await verified(org.id, p.from, p.to).orderBy('businessDate').limit(50000)
        .select('businessDate', 'beneficiaryId', 'benefitId', 'serviceType', 'providerType', 'providerId', 'quantity', 'grossTzs', 'sponsorTzs', 'beneficiaryTzs');
      const named = new Map((await benefits.filterByColumnInAsync('id', [...new Set(usage.map(r => r.benefitId))])).map(b => [b.id, b.name]));
      rows = usage.map(r => ({ day: r.businessDate, name: name.get(r.beneficiaryId)?.displayName ?? '', group: name.get(r.beneficiaryId)?.groupName ?? '', benefit: named.get(r.benefitId) ?? '', service: r.serviceType,
        provider: providerName(r.providerType, r.providerId) ?? '', quantity: r.quantity, value: r.grossTzs, sponsor: r.sponsorTzs, member: r.beneficiaryTzs }));
      columns = [col('day', 'Date'), col('name', 'Name'), col('group', 'Group'), col('benefit', 'Benefit'), col('service', 'Service'), col('provider', 'Provider'), col('quantity', 'Quantity'),
        col('value', 'Service value (TZS)'), col('sponsor', 'Sponsor paid (TZS)'), col('member', 'Member paid (TZS)')];
    } else if (report === 'activity') {
      const list = (await peopleOf(org)).filter(x => x.userId);
      const name = new Map(list.map(x => [x.userId, x]));
      const [start, end] = instants(p.from, p.to);
      const acts = list.length ? await db('Activity').whereIn('userId', list.map(x => x.userId)).where('startedAt', '>=', start).where('startedAt', '<', end).orderBy('startedAt').limit(50000)
        .select('userId', 'type', 'source', 'startedAt', 'durationMinutes', 'distanceKm', 'steps', 'activeMinutes') : [];
      rows = acts.map(a => ({ day: localDay(a.startedAt), name: name.get(a.userId)?.displayName ?? '', group: name.get(a.userId)?.groupName ?? '', type: a.type, source: a.source,
        minutes: a.durationMinutes, km: a.distanceKm, steps: a.steps, activeMinutes: a.activeMinutes }));
      columns = [col('day', 'Date'), col('name', 'Name'), col('group', 'Group'), col('type', 'Activity'), col('source', 'Recorded by'), col('minutes', 'Minutes'), col('km', 'Distance (km)'), col('steps', 'Steps'), col('activeMinutes', 'Active minutes')];
    } else if (report === 'benefits') {
      const out = await benefitAnalytics({ access, query });
      rows = out.items.map(r => ({ ...r, allowanceUsedPct: r.allowance?.usedPct ?? '', peopleAtLimit: r.allowance?.peopleAtLimit ?? '' }));
      columns = [col('programName', 'Programme'), col('name', 'Benefit'), col('benefitType', 'Type'), col('status', 'Status'), col('eligible', 'Eligible'), col('users', 'Used it'), col('reachPct', 'Reach %'), col('uses', 'Uses'),
        col('averageUsesPerUser', 'Uses per user'), col('serviceValueTzs', 'Service value (TZS)'), col('sponsorTzs', 'Sponsor (TZS)'), col('memberTzs', 'Member (TZS)'), col('allowanceUsedPct', 'Allowance used % (current window)'), col('peopleAtLimit', 'People at limit')];
    } else if (report === 'programs') {
      const out = await programAnalytics({ access, query });
      rows = out.items.map(r => ({ ...r, budgetTzs: r.budget.budgetTzs ?? '', committedTzs: r.budget.committedTzs }));
      columns = [col('name', 'Programme'), col('status', 'Status'), col('startDate', 'Starts'), col('endDate', 'Ends'), col('eligible', 'Eligible'), col('activeBeneficiaries', 'Used a benefit'), col('participationPct', 'Participation %'),
        col('uses', 'Per-use visits'), col('passCheckins', 'Pass check-ins'), col('sponsorTotalTzs', 'Sponsor (TZS)'), col('memberTzs', 'Member (TZS)'), col('budgetTzs', 'Budget (TZS)'), col('committedTzs', 'Budget used (TZS)')];
    } else if (report === 'providers') {
      const out = await providerAnalytics({ access, query });
      if (out.error) return out;
      rows = out.items;
      columns = [col('name', 'Provider'), col('providerType', 'Type'), col('location', 'Location'), col('visits', 'Visits'), col('uses', 'Per-use visits'), col('passCheckins', 'Pass check-ins'), col('people', 'People'), col('repeatPeople', 'Came back'),
        col('serviceValueTzs', 'Service value (TZS)'), col('sponsorTzs', 'Sponsor (TZS)'), col('memberTzs', 'Member (TZS)')];
    } else if (report === 'invoices') {
      const [start, end] = instants(p.from, p.to);
      const list = await db(INVOICE).where({ organizationId: org.id }).whereIn('status', BILLED_STATUSES).where('issuedAt', '>=', start).where('issuedAt', '<', end).orderBy('issuedAt');
      rows = list.map(i => ({ number: i.number, kind: i.kind, period: i.period, issued: localDay(i.issuedAt), due: i.dueDate ?? '', total: i.totalTzs, vat: i.vatTzs ?? '', paid: i.amountPaidTzs ?? 0, owed: Math.max(0, i.totalTzs - (i.amountPaidTzs ?? 0)), status: i.status }));
      columns = [col('number', 'Number'), col('kind', 'Kind'), col('period', 'For'), col('issued', 'Issued'), col('due', 'Due'), col('total', 'Total (TZS)'), col('vat', 'VAT included (TZS)'), col('paid', 'Paid (TZS)'), col('owed', 'Still owed (TZS)'), col('status', 'Status')];
    } else {
      const [start, end] = instants(p.from, p.to);
      const list = await db(PAYMENT).where({ organizationId: org.id }).where('receivedAt', '>=', start).where('receivedAt', '<', end).orderBy('receivedAt');
      rows = list.map(x => ({ number: x.number, received: localDay(x.receivedAt), method: x.method, reference: x.reference, amount: x.amountTzs, applied: x.allocatedTzs, status: x.status }));
      columns = [col('number', 'Receipt'), col('received', 'Received'), col('method', 'How'), col('reference', 'Reference'), col('amount', 'Amount (TZS)'), col('applied', 'Applied (TZS)'), col('status', 'Status')];
    }
    await audit({ actor: actorId, action: 'b2b.analytics.export', target: org.id, after: { report, from: p.from, to: p.to, rows: rows.length } });
    return { filename: `fitflex-${report}-${p.from}-to-${p.to}.csv`, title: spec.title, rows: rows.length, csv: toCsv(columns, rows) };
  }

  // ── Telling members what their sponsor sees ───────────────────────────────

  /**
   * One message, once, to every person an organisation covers: their sponsor
   * can see their FitFlex activity. Safe to rerun; new beneficiaries are
   * picked up by the next run.
   */
  async function notifyVisibility({ limit = 2000 } = {}) {
    const native = await db('B2BBeneficiary as b').join('B2BOrganization as o', 'o.id', 'b.organizationId')
      .where({ 'b.status': 'active', 'o.status': 'active' }).whereNotNull('b.userId').select('b.userId', 'o.id as organizationId', 'o.legalName', 'o.tradingName');
    const staff = await db('CorporateEmployee as e').join('B2BOrganization as o', 'o.legacyCorporateId', 'e.corporateId')
      .where({ 'o.status': 'active' }).whereIn('e.status', ['active']).whereNotNull('e.userId').select('e.userId', 'o.id as organizationId', 'o.legalName', 'o.tradingName');
    const stats = { covered: native.length + staff.length, sent: 0, failed: 0 };
    const idOf = r => `b2b_visibility_v1_${r.organizationId}_${r.userId}`.slice(0, 120);
    const all = [...native, ...staff];
    const ids = all.map(idOf);
    const seen = new Set();
    for (let i = 0; i < ids.length; i += 1000) for (const id of await db('Notification').whereIn('id', ids.slice(i, i + 1000)).pluck('id')) seen.add(id);
    for (const r of all.filter(x => !seen.has(idOf(x))).slice(0, limit)) {
      const name = r.tradingName || r.legalName;
      try {
        await notify(r.userId, {
          id: idOf(r), type: 'b2b_sponsor_visibility', title: `What ${name} can see`,
          body: `${name} gives you benefits through FitFlex and can see your FitFlex activity: gym visits, workouts, steps and challenge progress. It cannot see your weight, height or anything from another sponsor. See Benefits for details.`,
          data: { organizationId: r.organizationId },
        });
        stats.sent += 1;
      } catch (err) {
        stats.failed += 1;
        console.warn(`[b2b-analytics] visibility notice for ${r.userId} failed: ${err.message}`);
      }
    }
    return stats;
  }

  return {
    dashboard, people, person, programAnalytics, benefitAnalytics, providerAnalytics, financeAnalytics,
    overview, dataQuality, exportCsv, notifyVisibility, reports: () => Object.entries(REPORTS).map(([key, r]) => ({ key, ...r })),
  };
}
