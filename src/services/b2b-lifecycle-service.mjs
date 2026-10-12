// Benefit and programme lifecycle (Phase 7, slice 3): telling people what is
// about to happen, and preparing a programme's renewal.
//
//   member notices     in the app, once each:
//                        a benefit starts tomorrow
//                        a benefit ends within 7 days
//                        a benefit has ended
//                        80% of an allowance is used; all of it is used
//   organisation       to the organisation's owners, admins and managers in
//   notices            the app, and to its contact email:
//                        a programme ends within 30 days, and within 7
//                        a programme has ended
//   renewal            a draft copy of a programme for the period that
//                      follows it: same benefits, same people, new dates.
//                      Prepared when someone asks, never by itself, and it
//                      changes nothing until the organisation submits it and
//                      FitFlex activates it, exactly like a new programme.
//
// Nothing here decides who is eligible, what counts as used or when a
// programme expires: those come from the programme and consumption services.
// When a notice goes out is set in NOTICE below, in one place.
//
// Every notice has an id made of what it is about, so it is written once
// however often the job runs, and a day the job missed is made up the next.
import { randomUUID } from 'node:crypto';
import { benefitValidity, matchesPopulation, programEffectiveStatus, usageWindow, FLAT_FEE_BENEFIT } from '../shared/b2b-programs.mjs';
import { localDay, addDays, daysBetween } from '../shared/member-progress.mjs';

/** When notices go out. */
export const NOTICE = Object.freeze({
  benefitStartsWithinDays: 1,
  benefitEndsWithinDays: 7,
  /** How long after the end the "has ended" notice may still go, if the job was not running. */
  endedGraceDays: 3,
  programEndsWithinDays: Object.freeze([30, 7]),
  allowanceWarnPct: 80,
});
const PROGRAM = 'B2BWellnessProgram';
const MANAGE = 'programs.manage';
const READ = 'programs.read';
const ORG_ROLES = ['owner', 'admin', 'manager'];
const SYSTEM = 'system:b2b-lifecycle';
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const names = list => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`);
const dayText = n => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

/**
 * The period that follows [start, end]. Whole calendar months stay whole
 * calendar months (1 Jan – 31 Dec is followed by 1 Jan – 31 Dec); anything
 * else is followed by the same number of days.
 */
export function followingPeriod(startDate, endDate) {
  const start = addDays(endDate, 1);
  const firstOfMonth = d => d.slice(8) === '01';
  const lastOfMonth = d => addDays(d, 1).slice(8) === '01';
  if (firstOfMonth(startDate) && lastOfMonth(endDate)) {
    const months = (+endDate.slice(0, 4) - +startDate.slice(0, 4)) * 12 + (+endDate.slice(5, 7) - +startDate.slice(5, 7)) + 1;
    const i = +start.slice(0, 4) * 12 + (+start.slice(5, 7) - 1) + months;
    const next = `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;
    return { startDate: start, endDate: addDays(next, -1) };
  }
  return { startDate: start, endDate: addDays(start, daysBetween(startDate, endDate)) };
}

export function createB2BLifecycleService({
  db, b2bService, programs, benefits, b2bProgramService,
  // { allowanceFor({ benefit, program, beneficiaryId, day }) } from the consumption service
  usage,
  // Tell one person in the app: (userId, { id, type, title, body, data })
  notify = async () => null,
  // { configured, send(to, { subject, text }) }
  emailSender = () => ({ configured: false }),
  now = () => new Date(),
}) {
  const today = () => localDay(now());
  const stamp = () => new Date(now());
  const can = (access, permission) => access.platformAdmin || access.permissions.includes(permission);
  const refuse = permission => fail('forbidden', 403, { requiredPermission: permission });
  const orgName = org => org.tradingName || org.legalName;

  /** Write notices that are not already there. Returns how many were new. */
  async function deliver(notices) {
    const stats = { due: notices.length, sent: 0, failed: 0 };
    if (!notices.length) return stats;
    const seen = new Set();
    for (let i = 0; i < notices.length; i += 1000) {
      for (const id of await db('Notification').whereIn('id', notices.slice(i, i + 1000).map(n => n.id)).pluck('id')) seen.add(id);
    }
    for (const n of notices) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      try {
        await notify(n.userId, { id: n.id, type: n.type, title: n.title, body: n.body, data: n.data });
        stats.sent += 1;
      } catch (err) {
        stats.failed += 1;
        console.warn(`[b2b-lifecycle] notice ${n.id} failed: ${err.message}`);
      }
    }
    return stats;
  }

  /** Active organisations with their running programmes and those programmes' active benefits. */
  async function running() {
    const day = today();
    const orgs = new Map((await db('B2BOrganization').where({ status: 'active' })).map(o => [o.id, o]));
    const recent = addDays(day, -NOTICE.endedGraceDays);
    // Programmes that ended longer ago than the grace period have nothing left to say.
    const live = (await programs.filterByColumnInAsync('status', ['active', 'paused', 'expired']))
      .filter(p => orgs.has(p.organizationId) && (!p.endDate || p.endDate >= recent));
    const rows = live.length ? await benefits.filterByColumnInAsync('programId', live.map(p => p.id)) : [];
    const byProgram = new Map();
    for (const b of rows) { if (!byProgram.has(b.programId)) byProgram.set(b.programId, []); byProgram.get(b.programId).push(b); }
    return { day, orgs, programs: live, benefitsOf: p => byProgram.get(p.id) ?? [] };
  }

  // ── Members: a benefit is starting, ending, has ended ─────────────────────

  async function benefitNotices() {
    const { day, orgs, programs: live, benefitsOf } = await running();
    const notices = [];
    const peopleByOrg = new Map();
    const peopleOf = async (org) => {
      if (!peopleByOrg.has(org.id)) peopleByOrg.set(org.id, (await b2bService.allBeneficiaries(org)).filter(b => b.status === 'active' && b.userId));
      return peopleByOrg.get(org.id);
    };
    for (const p of live) {
      const org = orgs.get(p.organizationId);
      const status = programEffectiveStatus(p, day);
      // What is happening, per date, to which benefits.
      const groups = new Map();   // `${kind}:${date}` → benefits
      for (const b of benefitsOf(p)) {
        if (b.status !== 'active') continue;
        const v = benefitValidity(b, p);
        const add = (kind, date) => { const k = `${kind}:${date}`; if (!groups.has(k)) groups.set(k, { kind, date, benefits: [] }); groups.get(k).benefits.push(b); };
        if (status === 'active' && v.startDate > day && daysBetween(day, v.startDate) <= NOTICE.benefitStartsWithinDays) add('starting', v.startDate);
        if (status === 'active' && v.endDate && v.endDate >= day && v.startDate <= day && daysBetween(day, v.endDate) <= NOTICE.benefitEndsWithinDays) add('ending', v.endDate);
        if (v.endDate && v.endDate < day && daysBetween(v.endDate, day) <= NOTICE.endedGraceDays && ['active', 'expired'].includes(status)) add('ended', v.endDate);
      }
      if (!groups.size) continue;
      const people = await peopleOf(org);
      for (const g of groups.values()) {
        for (const person of people) {
          const mine = g.benefits.filter(b => !matchesPopulation({ program: p, beneficiary: person, benefit: b }));
          if (!mine.length) continue;
          const what = names(mine.map(b => b.name));
          const one = mine.length === 1;
          const left = daysBetween(day, g.date);
          const text = {
            starting: { title: one ? 'A benefit starts soon' : 'Benefits start soon', body: `${what} from ${orgName(org)} ${one ? 'starts' : 'start'} ${dayText(left)}.` },
            ending: { title: one ? 'A benefit is ending' : 'Benefits are ending', body: `${what} from ${orgName(org)} ${one ? 'ends' : 'end'} ${dayText(left)} (${g.date}). Use ${one ? 'it' : 'them'} before then.` },
            ended: { title: one ? 'A benefit has ended' : 'Benefits have ended', body: `${what} from ${orgName(org)} ended on ${g.date}.` },
          }[g.kind];
          notices.push({ id: `b2bn_${g.kind}_${p.id}_${g.date}_${person.userId}`.slice(0, 120), userId: person.userId, type: `b2b_benefit_${g.kind}`, ...text,
            data: { organizationId: org.id, programId: p.id, benefitIds: mine.map(b => b.id), date: g.date } });
        }
      }
    }
    return deliver(notices);
  }

  // ── Members: an allowance is nearly or fully used ─────────────────────────

  /**
   * People whose usage changed in the last `sinceMinutes` are checked against
   * their benefit's limit. One notice at 80%, one when it is all used, per
   * person, benefit and window.
   */
  async function allowanceNotices({ sinceMinutes = 45 } = {}) {
    const day = today();
    const touched = await db('B2BBenefitConsumption').whereIn('status', ['pending', 'approved']).whereNotNull('userId')
      .where('updatedAt', '>', new Date(+stamp() - sinceMinutes * 60_000)).distinct('benefitId', 'beneficiaryId', 'userId', 'programId', 'organizationId');
    if (!touched.length) return { due: 0, sent: 0, failed: 0 };
    const benefitRows = new Map((await benefits.filterByColumnInAsync('id', [...new Set(touched.map(t => t.benefitId))])).map(b => [b.id, b]));
    const programRows = new Map((await programs.filterByColumnInAsync('id', [...new Set(touched.map(t => t.programId))])).map(p => [p.id, p]));
    const orgRows = new Map((await db('B2BOrganization').whereIn('id', [...new Set(touched.map(t => t.organizationId))])).map(o => [o.id, o]));
    const notices = [];
    for (const t of touched) {
      const benefit = benefitRows.get(t.benefitId);
      const program = programRows.get(t.programId);
      const org = orgRows.get(t.organizationId);
      if (!benefit?.usageLimit || !program || !org || benefit.benefitType === FLAT_FEE_BENEFIT) continue;
      const window = usageWindow({ benefit, program, day });
      if (!window) continue;
      const { used } = await usage.allowanceFor({ benefit, program, beneficiaryId: t.beneficiaryId, day });
      const pct = (used / benefit.usageLimit) * 100;
      const kind = used >= benefit.usageLimit ? 'used_up' : pct >= NOTICE.allowanceWarnPct ? 'nearly_used' : null;
      if (!kind) continue;
      const until = window.end ? ` It renews after ${window.end}.` : '';
      const text = kind === 'used_up'
        ? { title: 'Benefit allowance used', body: `You have used all ${benefit.usageLimit} of ${benefit.name} from ${orgName(org)}.${benefit.usagePeriod === 'program' ? '' : until}` }
        : { title: 'Benefit allowance running low', body: `You have used ${used} of ${benefit.usageLimit} of ${benefit.name} from ${orgName(org)}. ${benefit.usageLimit - used} left.` };
      notices.push({ id: `b2bn_${kind}_${benefit.id}_${t.beneficiaryId}_${window.start}`.slice(0, 120), userId: t.userId, type: `b2b_allowance_${kind}`, ...text,
        data: { organizationId: org.id, programId: program.id, benefitId: benefit.id, used, limit: benefit.usageLimit } });
    }
    return deliver(notices);
  }

  // ── Organisations: a programme is ending, has ended ───────────────────────

  async function renewalOf(programId, q = db) {
    return (await q(PROGRAM).where({ renewedFromProgramId: programId }).whereNot({ status: 'cancelled' }).first()) ?? null;
  }

  async function programNotices() {
    const { day, orgs, programs: live } = await running();
    const notices = [];
    const emails = [];
    for (const p of live) {
      if (!p.endDate) continue;
      const org = orgs.get(p.organizationId);
      const status = programEffectiveStatus(p, day);
      let kind = null;
      const left = daysBetween(day, p.endDate);
      if (status === 'active' && left >= 0) {
        const stage = [...NOTICE.programEndsWithinDays].sort((a, b) => a - b).find(d => left <= d);
        if (stage) kind = `ending_${stage}`;
      } else if (status === 'expired' && left < 0 && -left <= NOTICE.endedGraceDays) kind = 'ended';
      if (!kind) continue;
      const renewal = await renewalOf(p.id);
      const next = renewal
        ? (renewal.status === 'draft' ? ' A renewal has been prepared and is with FitFlex to review.' : renewal.status === 'pending' ? ' Its renewal is with FitFlex for activation.' : ' Its renewal is in place.')
        : ' To carry on without a gap, prepare its renewal under Programmes.';
      const text = kind === 'ended'
        ? { title: 'Programme ended', body: `${p.name} ended on ${p.endDate}. Its benefits can no longer be used.${renewal ? next : ' Prepare a renewal under Programmes to start a new period.'}` }
        : { title: 'Programme ending', body: `${p.name} ends ${dayText(left)} (${p.endDate}).${next}` };
      const users = await db('B2BOrganizationUser').where({ organizationId: org.id, status: 'active' }).whereIn('role', ORG_ROLES).pluck('userId');
      for (const userId of users) {
        notices.push({ id: `b2bn_prog_${kind}_${p.id}_${p.endDate}_${userId}`.slice(0, 120), userId, type: `b2b_program_${kind === 'ended' ? 'ended' : 'ending'}`, ...text,
          data: { organizationId: org.id, programId: p.id, endDate: p.endDate, renewalProgramId: renewal?.id ?? null } });
      }
      if (org.email) emails.push({ key: `b2bn_prog_mail_${kind}_${p.id}_${p.endDate}`, to: org.email, subject: `${text.title}: ${p.name}`, text: `${text.body}\n\nOpen the FitFlex portal, Programmes, to see it.`, organizationId: org.id });
    }
    const stats = await deliver(notices);
    // Email once per programme and stage; the claim is an audit row, which is also the record that it went.
    const sender = emailSender();
    stats.emailed = 0;
    if (sender.configured) {
      for (const m of emails) {
        if (await db('AuditLog').where({ action: 'b2b.program.notice_emailed', target: m.key }).first('id')) continue;
        const out = await sender.send(m.to, { subject: m.subject, text: m.text }).catch(() => ({ ok: false }));
        if (out?.ok) {
          await db('AuditLog').insert({ id: randomUUID(), at: stamp(), actor: SYSTEM, action: 'b2b.program.notice_emailed', target: m.key, before: null, after: JSON.stringify({ to: m.to, organizationId: m.organizationId }) });
          stats.emailed += 1;
        }
      }
    }
    return stats;
  }

  // ── Renewal ───────────────────────────────────────────────────────────────

  /**
   * A draft programme for the period after this one: the same name, people,
   * budget and benefits, with the dates moved on. It is a draft like any
   * other: nothing is charged and nobody is covered until the organisation
   * submits it and FitFlex activates it. Asking twice returns the same draft.
   *
   * A price concession FitFlex gave (`discountBps`) is carried over only when
   * FitFlex staff prepare the renewal; an organisation cannot renew its own
   * discount.
   */
  async function prepareRenewal({ access, programId, actorId }) {
    if (!can(access, MANAGE)) return refuse(MANAGE);
    if (!actorId) return fail('actor_required', 403);
    const source = await programs.findByIdAsync(programId);
    if (!source || source.organizationId !== access.org.id) return fail('program_not_found', 404);
    if (!source.endDate) return fail('program_has_no_end_date', 409, { hint: 'A programme with no end date does not need renewing.' });
    if (!['active', 'paused', 'expired'].includes(source.status)) return fail('program_not_renewable', 409, { programStatus: source.status });

    return db.transaction(async (lock) => {
      // One renewal at a time per programme.
      await lock.raw('select pg_advisory_xact_lock(hashtext(?))', [`fitflex:renew:${source.id}`]);
      const existing = await renewalOf(source.id);
      if (existing) return { program: existing, existing: true, benefits: [], skipped: [] };

      const period = followingPeriod(source.startDate, source.endDate);
      const shift = daysBetween(source.startDate, period.startDate);
      const body = {
        name: source.name, description: source.description ?? undefined, programType: source.programType, startDate: period.startDate, endDate: period.endDate,
        eligibility: source.eligibility ?? undefined, budgetTzs: source.budgetTzs ?? undefined,
        ...(access.platformAdmin && source.discountBps ? { discountBps: source.discountBps } : {}),
      };
      const created = await b2bProgramService.createProgram({ access, body, actorId });
      if (created.error) return created;
      await db(PROGRAM).where({ id: created.program.id }).update({ renewedFromProgramId: source.id });

      const copied = [];
      const skipped = [];
      const sourceBenefits = (await benefits.filterByColumnAsync('programId', source.id)).filter(b => ['draft', 'active', 'paused'].includes(b.status))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      for (const b of sourceBenefits) {
        const moved = d => (d ? addDays(d, shift) : undefined);
        const out = await b2bProgramService.createBenefit({ access, programId: created.program.id, actorId, body: {
          name: b.name, description: b.description ?? undefined, benefitType: b.benefitType, fundingType: b.fundingType,
          sponsorAmountTzs: b.sponsorAmountTzs ?? undefined, sponsorShareBps: b.sponsorShareBps ?? undefined, sponsorCapTzs: b.sponsorCapTzs ?? undefined, beneficiaryAmountTzs: b.beneficiaryAmountTzs ?? undefined,
          usageLimit: b.usageLimit ?? undefined, usagePeriod: b.usagePeriod ?? undefined, periodSponsorCapTzs: b.periodSponsorCapTzs ?? undefined,
          eligibility: b.eligibility ?? undefined, providerRules: b.providerRules ?? undefined, terms: b.terms ?? undefined, passTier: b.passTier ?? undefined,
          // A custom fee is FitFlex's to set: carried over only when FitFlex prepares the renewal.
          fixedFeeTzs: access.platformAdmin ? (b.fixedFeeTzs ?? undefined) : undefined,
          // A benefit with dates of its own keeps its place inside the new period, clipped to it.
          startDate: b.startDate ? moved(b.startDate) : undefined,
          endDate: b.endDate ? (moved(b.endDate) > period.endDate ? period.endDate : moved(b.endDate)) : undefined,
        } });
        if (out.error) skipped.push({ benefitId: b.id, name: b.name, reason: out.error });
        else copied.push(out.benefit);
      }
      await db('AuditLog').insert({ id: randomUUID(), at: stamp(), actor: actorId, action: 'b2b.program.renewal_prepared', target: created.program.id,
        before: null, after: JSON.stringify({ renewedFromProgramId: source.id, ...period, benefits: copied.length, skipped }) });
      return {
        program: { ...created.program, renewedFromProgramId: source.id }, benefits: copied, skipped,
        discountNotCarriedOver: !access.platformAdmin && !!source.discountBps,
      };
    });
  }

  /** For each of the organisation's programmes: how long it has left, and its renewal if one is prepared. */
  async function programLifecycle({ access }) {
    if (!can(access, READ)) return refuse(READ);
    const day = today();
    const rows = await db(PROGRAM).where({ organizationId: access.org.id });
    const renewals = new Map(rows.filter(r => r.renewedFromProgramId && r.status !== 'cancelled').map(r => [r.renewedFromProgramId, r]));
    return {
      today: day,
      items: rows.map((p) => {
        const status = programEffectiveStatus(p, day);
        const renewal = renewals.get(p.id) ?? null;
        return {
          programId: p.id, status, endDate: p.endDate ?? null, daysLeft: p.endDate ? daysBetween(day, p.endDate) : null,
          endingSoon: status === 'active' && !!p.endDate && daysBetween(day, p.endDate) <= Math.max(...NOTICE.programEndsWithinDays),
          canRenew: !!p.endDate && ['active', 'paused', 'expired'].includes(p.status) && !renewal,
          renewal: renewal ? { programId: renewal.id, status: renewal.status, startDate: renewal.startDate, endDate: renewal.endDate } : null,
          renewalOf: p.renewedFromProgramId ?? null,
        };
      }),
    };
  }

  return { benefitNotices, allowanceNotices, programNotices, prepareRenewal, programLifecycle };
}
