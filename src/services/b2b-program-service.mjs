// B2B Phase 2 — wellness programmes, benefits and eligibility.
// Pure DI: receives store collections and b2bService via the factory.
//
// Callers pass the `access` object from b2bService.resolveAccess, so every
// operation is already scoped to one organisation and one role; a programme
// or benefit of another organisation is simply "not found".
//
// Rules only: no usage is counted and no money moves here (Phase 3 and 4).
import { randomUUID } from 'node:crypto';
import {
  PROGRAM_TYPES, PROGRAM_TRANSITIONS, CLOSED_PROGRAM_STATUSES, LIVE_PROGRAM_FIELDS,
  BENEFIT_TYPES, BENEFIT_TRANSITIONS, LIVE_BENEFIT_FIELDS, FUNDING_TYPES, USAGE_PERIODS, ELIGIBILITY_SCOPES,
  isDay, readEligibility, readBenefitEligibility, readFunding, readUsage, readProviderRules,
  programEffectiveStatus, benefitValidity, evaluateEligibility, matchesPopulation, usageWindow, describeFunding,
} from '../shared/b2b-programs.mjs';
import { localDay } from '../shared/member-progress.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const text = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

function page(rows, query = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
  const total = rows.length;
  return { items: rows.slice(offset, offset + limit), total, nextCursor: offset + limit < total ? offset + limit : null };
}

export function createB2BProgramService({
  programs, benefits, gyms, trainers, users, challenges, auditLog, b2bService,
  now = () => new Date(),
}) {
  const stamp = () => now().toISOString();
  const today = () => localDay(now());

  async function audit({ actor, action, target, before = null, after = null }) {
    await auditLog.insertAsync({ id: `aud_${randomUUID().slice(0, 8)}`, at: stamp(), actor, action, target, before, after });
  }

  const can = (access, permission) => access.permissions.includes(permission);
  const forbidden = permission => fail('forbidden', 403, { requiredPermission: permission });

  function reference() {
    return {
      programTypes: PROGRAM_TYPES,
      programStatuses: PROGRAM_TRANSITIONS,
      benefitTypes: BENEFIT_TYPES,
      benefitStatuses: BENEFIT_TRANSITIONS,
      fundingTypes: FUNDING_TYPES,
      usagePeriods: USAGE_PERIODS,
      eligibilityScopes: ELIGIBILITY_SCOPES,
    };
  }

  const programView = p => ({ ...p, effectiveStatus: programEffectiveStatus(p, today()) });
  const benefitView = (b, program) => ({
    ...b, validity: benefitValidity(b, program), fundingSummary: describeFunding(b),
  });

  /** The programme with this id in the caller's organisation. */
  async function findProgram(access, programId) {
    const p = await programs.findByIdAsync(programId);
    return p && p.organizationId === access.org.id ? p : null;
  }

  // ── Programmes ────────────────────────────────────────────────────────────

  /** Validate programme fields present in `body`. `create` makes name and start date required. */
  async function readProgram(access, body, { create = false } = {}) {
    const patch = {};
    if (create || body.name !== undefined) {
      const name = text(body.name, 120);
      if (!name) return fail('name_required', 400);
      patch.name = name;
    }
    if (body.description !== undefined) patch.description = text(body.description, 2000);
    if (create || body.programType !== undefined) {
      const programType = body.programType ?? 'wellness';
      if (!PROGRAM_TYPES[programType]) return fail('invalid_program_type', 400, { allowed: Object.keys(PROGRAM_TYPES) });
      patch.programType = programType;
    }
    if (create || body.startDate !== undefined) {
      if (!isDay(body.startDate)) return fail('invalid_start_date', 400);
      patch.startDate = body.startDate;
    }
    if (body.endDate !== undefined) {
      if (body.endDate !== null && !isDay(body.endDate)) return fail('invalid_end_date', 400);
      patch.endDate = body.endDate;
    }
    if (create || body.eligibility !== undefined) {
      const e = readEligibility(body.eligibility);
      if (e.error) return e;
      if (e.value.beneficiaryIds.length) {
        const known = new Set((await b2bService.allBeneficiaries(access.org)).map(b => b.id));
        const unknown = e.value.beneficiaryIds.filter(id => !known.has(id));
        if (unknown.length) return fail('unknown_beneficiaries', 400, { beneficiaryIds: unknown.slice(0, 20) });
      }
      patch.eligibility = e.value;
    }
    if (body.budgetTzs !== undefined) {
      if (body.budgetTzs !== null && (!Number.isInteger(body.budgetTzs) || body.budgetTzs < 0)) return fail('invalid_budget', 400);
      patch.budgetTzs = body.budgetTzs;
    }
    return { patch };
  }

  async function createProgram({ access, body = {}, actorId }) {
    if (!can(access, 'programs.manage')) return forbidden('programs.manage');
    if (access.org.status !== 'active') return fail('organization_not_active', 409, { organizationStatus: access.org.status });
    const read = await readProgram(access, body, { create: true });
    if (read.error) return read;
    const endDate = read.patch.endDate ?? null;
    if (endDate !== null && endDate < read.patch.startDate) return fail('end_before_start', 400);
    if (endDate !== null && endDate < today()) return fail('ends_in_past', 400);

    const at = stamp();
    const row = {
      id: newId('b2bp'), organizationId: access.org.id, description: null, endDate: null, budgetTzs: null,
      ...read.patch,
      status: 'draft', statusReason: null, statusChangedAt: at, activatedAt: null, activatedBy: null,
      createdBy: actorId ?? null, createdAt: at, updatedAt: at,
    };
    await programs.insertAsync(row);
    await audit({ actor: actorId, action: 'b2b.program.create', target: row.id, after: row });
    return { program: programView(row) };
  }

  async function getProgram({ access, programId }) {
    if (!can(access, 'programs.read')) return forbidden('programs.read');
    const p = await findProgram(access, programId);
    if (!p) return fail('program_not_found', 404);
    const rows = await benefits.filterByColumnAsync('programId', p.id);
    return {
      program: programView(p),
      benefits: rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(b => benefitView(b, p)),
    };
  }

  async function listPrograms({ access, query = {} }) {
    if (!can(access, 'programs.read')) return forbidden('programs.read');
    const rows = (await programs.filterByColumnAsync('organizationId', access.org.id))
      .map(programView)
      .filter(p => (query.status ? p.effectiveStatus === query.status : true))
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
    return page(rows, query);
  }

  /** FitFlex back office: programmes across organisations. */
  async function adminListPrograms({ query = {} } = {}) {
    const rows = (query.organizationId ? await programs.filterByColumnAsync('organizationId', query.organizationId) : await programs.allAsync())
      .map(programView)
      .filter(p => (query.status ? p.effectiveStatus === query.status : true))
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
    return page(rows, query);
  }

  async function updateProgram({ access, programId, body = {}, actorId }) {
    if (!can(access, 'programs.manage')) return forbidden('programs.manage');
    const p = await findProgram(access, programId);
    if (!p) return fail('program_not_found', 404);
    const status = programEffectiveStatus(p, today());
    if (CLOSED_PROGRAM_STATUSES.includes(status)) return fail('program_closed', 409, { programStatus: status });
    if (body.status !== undefined) return fail('use_status_endpoint', 400);

    const live = ['active', 'paused'].includes(status);
    if (live) {
      const locked = Object.keys(body).filter(k => !LIVE_PROGRAM_FIELDS.includes(k));
      if (locked.length) return fail('program_live', 409, { fields: locked, editable: LIVE_PROGRAM_FIELDS });
    }
    const read = await readProgram(access, body);
    if (read.error) return read;
    const next = { ...p, ...read.patch };
    if (next.endDate !== null && next.endDate < next.startDate) return fail('end_before_start', 400);
    if (live) {
      // A live programme may run longer or get more budget, never less.
      if (read.patch.endDate !== undefined && p.endDate !== null && (next.endDate === null ? false : next.endDate < p.endDate)) {
        return fail('cannot_shorten_live_program', 409);
      }
      if (read.patch.budgetTzs !== undefined && p.budgetTzs !== null && (next.budgetTzs === null ? false : next.budgetTzs < p.budgetTzs)) {
        return fail('cannot_reduce_live_budget', 409);
      }
    }
    if (read.patch.endDate !== undefined && next.endDate !== null && next.endDate < today() && next.endDate !== p.endDate) {
      return fail('ends_in_past', 400);
    }
    // Benefits with their own dates must still fit.
    const rows = await benefits.filterByColumnAsync('programId', p.id);
    const outside = rows.filter(b => (b.startDate && b.startDate < next.startDate) || (b.endDate && next.endDate && b.endDate > next.endDate));
    if (outside.length) return fail('benefit_outside_program', 409, { benefitIds: outside.map(b => b.id) });

    const updated = await programs.updateByIdAsync(p.id, { ...read.patch, updatedAt: stamp() });
    await audit({ actor: actorId, action: 'b2b.program.update', target: p.id, before: p, after: updated });
    return { program: programView(updated) };
  }

  /**
   * Lifecycle moves. Organisations draft, submit (pending), withdraw, pause,
   * resume and cancel; activating a pending programme commits sponsor money,
   * so it is FitFlex's call. Expiry happens by date (expireDue).
   */
  async function setProgramStatus({ access, programId, status, reason, actorId }) {
    if (!can(access, 'programs.manage')) return forbidden('programs.manage');
    if (!PROGRAM_TRANSITIONS[status] || status === 'expired') {
      return fail('invalid_status', 400, { allowed: Object.keys(PROGRAM_TRANSITIONS).filter(s => s !== 'expired') });
    }
    const p = await findProgram(access, programId);
    if (!p) return fail('program_not_found', 404);
    const current = programEffectiveStatus(p, today());
    if (current === status) return { program: programView(p), unchanged: true };
    const allowed = PROGRAM_TRANSITIONS[current] || [];
    if (!allowed.includes(status)) return fail('invalid_transition', 409, { from: current, to: status, allowed });
    if (status === 'active' && current === 'pending' && !access.platformAdmin) {
      return fail('forbidden', 403, { requiredRole: 'platform_admin' });
    }
    if (status === 'active') {
      if (access.org.status !== 'active') return fail('organization_not_active', 409, { organizationStatus: access.org.status });
      const live = (await benefits.filterByColumnAsync('programId', p.id)).filter(b => b.status === 'active');
      if (!live.length) return fail('no_active_benefits', 409);
    }

    const at = stamp();
    const patch = { status, statusReason: text(reason, 500), statusChangedAt: at, updatedAt: at };
    if (status === 'active' && !p.activatedAt) Object.assign(patch, { activatedAt: at, activatedBy: actorId ?? null });
    const updated = await programs.updateByIdAsync(p.id, patch);
    await audit({ actor: actorId, action: `b2b.program.${status}`, target: p.id, before: p, after: updated });
    return { program: programView(updated) };
  }

  /** Mark live programmes whose last day has passed as expired. Idempotent (daily job). */
  async function expireDue() {
    const day = today();
    let expired = 0;
    for (const p of await programs.filterAsync(x => ['active', 'paused'].includes(x.status) && x.endDate && x.endDate < day)) {
      const at = stamp();
      const updated = await programs.updateByIdAsync(p.id, { status: 'expired', statusReason: 'end_date_passed', statusChangedAt: at, updatedAt: at });
      await audit({ actor: 'system:b2b-program-expiry', action: 'b2b.program.expired', target: p.id, before: p, after: updated });
      expired += 1;
    }
    return { expired };
  }

  // ── Benefits ──────────────────────────────────────────────────────────────

  /** Every referenced gym, trainer, vendor and challenge must exist (and challenges be usable by this organisation). */
  async function checkProviders(access, rules) {
    const missing = {};
    const check = async (key, lookup) => {
      if (!rules[key]?.length) return;
      const found = new Set((await lookup(rules[key])).map(r => r.id));
      const absent = rules[key].filter(id => !found.has(id));
      if (absent.length) missing[key] = absent;
    };
    await check('gymIds', ids => gyms.filterAsync(g => ids.includes(g.id)));
    await check('trainerIds', ids => trainers.filterAsync(t => ids.includes(t.id)));
    await check('vendorIds', async ids => (await users.filterByColumnInAsync('id', ids)).filter(u => u.userType === 'vendor'));
    await check('challengeIds', async ids => (await challenges.filterByColumnInAsync('id', ids))
      .filter(c => c.creatorType === 'fitflex' || (c.creatorType === 'corporate' && c.creatorId === access.org.legacyCorporateId)));
    return Object.keys(missing).length ? fail('unknown_providers', 400, { missing }) : null;
  }

  /** Validate a whole benefit (create, or an update merged over the stored row). */
  async function readBenefit(access, program, body) {
    const name = text(body.name, 120);
    if (!name) return fail('name_required', 400);
    if (!BENEFIT_TYPES[body.benefitType]) return fail('invalid_benefit_type', 400, { allowed: Object.keys(BENEFIT_TYPES) });
    const funding = readFunding(body);
    if (funding.error) return funding;
    const usage = readUsage(body, body.fundingType);
    if (usage.error) return usage;
    const eligibility = readBenefitEligibility(body.eligibility);
    if (eligibility.error) return eligibility;
    const providers = readProviderRules(body.benefitType, body.providerRules);
    if (providers.error) return providers;
    const missing = await checkProviders(access, providers.value);
    if (missing) return missing;

    for (const k of ['startDate', 'endDate']) {
      if (body[k] !== undefined && body[k] !== null && !isDay(body[k])) return fail(`invalid_${k === 'startDate' ? 'start' : 'end'}_date`, 400);
    }
    const startDate = body.startDate ?? null;
    const endDate = body.endDate ?? null;
    if (startDate && endDate && endDate < startDate) return fail('end_before_start', 400);
    // Benefit validity sits inside the programme's.
    if ((startDate && startDate < program.startDate) || (startDate && program.endDate && startDate > program.endDate)
      || (endDate && program.endDate && endDate > program.endDate) || (endDate && endDate < program.startDate)) {
      return fail('benefit_outside_program', 400, { programStartDate: program.startDate, programEndDate: program.endDate });
    }
    return {
      patch: {
        name, description: text(body.description, 2000), benefitType: body.benefitType,
        ...funding.patch, ...usage.patch,
        eligibility: eligibility.value, providerRules: providers.value,
        startDate, endDate, terms: text(body.terms, 4000),
      },
    };
  }

  async function createBenefit({ access, programId, body = {}, actorId }) {
    if (!can(access, 'programs.manage')) return forbidden('programs.manage');
    const p = await findProgram(access, programId);
    if (!p) return fail('program_not_found', 404);
    const status = programEffectiveStatus(p, today());
    if (CLOSED_PROGRAM_STATUSES.includes(status)) return fail('program_closed', 409, { programStatus: status });
    const read = await readBenefit(access, p, body);
    if (read.error) return read;
    const at = stamp();
    const row = { id: newId('b2bf'), programId: p.id, ...read.patch, status: 'draft', createdBy: actorId ?? null, createdAt: at, updatedAt: at };
    await benefits.insertAsync(row);
    await audit({ actor: actorId, action: 'b2b.benefit.create', target: row.id, after: row });
    return { benefit: benefitView(row, p) };
  }

  /** The benefit with this id in one of the caller's programmes. */
  async function findBenefit(access, programId, benefitId) {
    const p = await findProgram(access, programId);
    if (!p) return null;
    const b = await benefits.findByIdAsync(benefitId);
    return b && b.programId === p.id ? { program: p, benefit: b } : null;
  }

  async function getBenefit({ access, programId, benefitId }) {
    if (!can(access, 'programs.read')) return forbidden('programs.read');
    const found = await findBenefit(access, programId, benefitId);
    if (!found) return fail('benefit_not_found', 404);
    return { benefit: benefitView(found.benefit, found.program), window: usageWindow({ benefit: found.benefit, program: found.program, day: today() }) };
  }

  async function listBenefits({ access, programId }) {
    if (!can(access, 'programs.read')) return forbidden('programs.read');
    const p = await findProgram(access, programId);
    if (!p) return fail('program_not_found', 404);
    const rows = await benefits.filterByColumnAsync('programId', p.id);
    return { benefits: rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(b => benefitView(b, p)) };
  }

  async function updateBenefit({ access, programId, benefitId, body = {}, actorId }) {
    if (!can(access, 'programs.manage')) return forbidden('programs.manage');
    const found = await findBenefit(access, programId, benefitId);
    if (!found) return fail('benefit_not_found', 404);
    const { program: p, benefit: b } = found;
    const status = programEffectiveStatus(p, today());
    if (CLOSED_PROGRAM_STATUSES.includes(status)) return fail('program_closed', 409, { programStatus: status });
    if (body.status !== undefined) return fail('use_status_endpoint', 400);
    if (b.status === 'active' && ['active', 'paused'].includes(status)) {
      const locked = Object.keys(body).filter(k => !LIVE_BENEFIT_FIELDS.includes(k));
      if (locked.length) return fail('benefit_live', 409, { fields: locked, editable: LIVE_BENEFIT_FIELDS });
    }
    // Merge over the stored row so partial updates validate as a whole benefit.
    const read = await readBenefit(access, p, { ...b, ...body });
    if (read.error) return read;
    const updated = await benefits.updateByIdAsync(b.id, { ...read.patch, updatedAt: stamp() });
    await audit({ actor: actorId, action: 'b2b.benefit.update', target: b.id, before: b, after: updated });
    return { benefit: benefitView(updated, p) };
  }

  async function setBenefitStatus({ access, programId, benefitId, status, actorId }) {
    if (!can(access, 'programs.manage')) return forbidden('programs.manage');
    if (!BENEFIT_TRANSITIONS[status]) return fail('invalid_status', 400, { allowed: Object.keys(BENEFIT_TRANSITIONS) });
    const found = await findBenefit(access, programId, benefitId);
    if (!found) return fail('benefit_not_found', 404);
    const { program: p, benefit: b } = found;
    const programStatus = programEffectiveStatus(p, today());
    if (CLOSED_PROGRAM_STATUSES.includes(programStatus)) return fail('program_closed', 409, { programStatus });
    if (b.status === status) return { benefit: benefitView(b, p), unchanged: true };
    const allowed = BENEFIT_TRANSITIONS[b.status] || [];
    if (!allowed.includes(status)) return fail('invalid_transition', 409, { from: b.status, to: status, allowed });
    if (status === 'active') {
      const { endDate } = benefitValidity(b, p);
      if (endDate && endDate < today()) return fail('benefit_ended', 409);
    }
    // A live programme always keeps at least one active benefit (pause it instead).
    if (b.status === 'active' && programStatus === 'active') {
      const others = (await benefits.filterByColumnAsync('programId', p.id)).filter(x => x.status === 'active' && x.id !== b.id);
      if (!others.length) return fail('last_active_benefit', 409);
    }
    const updated = await benefits.updateByIdAsync(b.id, { status, updatedAt: stamp() });
    await audit({ actor: actorId, action: `b2b.benefit.${status}`, target: b.id, before: b, after: updated });
    return { benefit: benefitView(updated, p) };
  }

  // ── Eligibility ───────────────────────────────────────────────────────────

  /**
   * Who a programme (or one benefit) reaches: every organisation beneficiary
   * checked against the population rule. `wouldBeEligible` ignores the
   * programme's own status and dates (useful while drafting); `eligibleToday`
   * is the full check as of today.
   */
  async function listEligibleBeneficiaries({ access, programId, query = {} }) {
    if (!can(access, 'programs.read')) return forbidden('programs.read');
    if (!can(access, 'beneficiaries.read')) return forbidden('beneficiaries.read');
    const p = await findProgram(access, programId);
    if (!p) return fail('program_not_found', 404);
    let benefit = null;
    if (query.benefitId) {
      benefit = await benefits.findByIdAsync(query.benefitId);
      if (!benefit || benefit.programId !== p.id) return fail('benefit_not_found', 404);
    }
    const day = today();
    const rows = (await b2bService.allBeneficiaries(access.org)).map((b) => {
      const mismatch = b.status === 'active' ? matchesPopulation({ program: p, beneficiary: b, benefit }) : 'beneficiary_not_active';
      const now = evaluateEligibility({ program: p, benefit, beneficiary: b, day });
      return {
        beneficiary: { id: b.id, displayName: b.displayName, userId: b.userId, beneficiaryType: b.beneficiaryType, groupName: b.groupName, status: b.status, source: b.source },
        wouldBeEligible: !mismatch, reason: mismatch, eligibleToday: now.eligible, todayReason: now.reason,
      };
    });
    const counts = {
      beneficiaries: rows.length,
      wouldBeEligible: rows.filter(r => r.wouldBeEligible).length,
      eligibleToday: rows.filter(r => r.eligibleToday).length,
    };
    const shown = (query.include === 'all' ? rows : rows.filter(r => r.wouldBeEligible))
      .sort((a, b) => String(a.beneficiary.displayName ?? '').localeCompare(String(b.beneficiary.displayName ?? '')));
    return { ...page(shown, query), counts, program: programView(p) };
  }

  /**
   * A member's benefits today across every organisation that sponsors them —
   * read-only, the base of a future "My wellness benefits" screen. Limits are
   * the configured ones; remaining allowance needs Phase 3 usage.
   */
  async function myBenefits({ userId }) {
    const day = today();
    const out = [];
    for (const { organization, beneficiary } of await b2bService.beneficiaryRelationshipsForUser(userId)) {
      if (organization.status !== 'active') continue;
      const orgPrograms = (await programs.filterByColumnAsync('organizationId', organization.id))
        .filter(p => programEffectiveStatus(p, day) === 'active');
      for (const p of orgPrograms) {
        for (const b of await benefits.filterByColumnAsync('programId', p.id)) {
          if (!evaluateEligibility({ program: p, benefit: b, beneficiary, day }).eligible) continue;
          out.push({
            organization: { id: organization.id, name: organization.tradingName || organization.legalName, organizationType: organization.organizationType },
            program: { id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate },
            benefit: {
              id: b.id, name: b.name, description: b.description, benefitType: b.benefitType, terms: b.terms,
              fundingType: b.fundingType, fundingSummary: describeFunding(b),
              sponsorAmountTzs: b.sponsorAmountTzs, sponsorShareBps: b.sponsorShareBps, sponsorCapTzs: b.sponsorCapTzs,
              beneficiaryAmountTzs: b.beneficiaryAmountTzs, usageLimit: b.usageLimit, usagePeriod: b.usagePeriod,
              providerRules: b.providerRules, validity: benefitValidity(b, p),
            },
            window: usageWindow({ benefit: b, program: p, day }),
            remaining: null, // Phase 3
          });
        }
      }
    }
    return { benefits: out, asOf: day };
  }

  return {
    reference,
    createProgram, getProgram, listPrograms, adminListPrograms, updateProgram, setProgramStatus, expireDue,
    createBenefit, getBenefit, listBenefits, updateBenefit, setBenefitStatus,
    listEligibleBeneficiaries, myBenefits,
  };
}
