// Corporate wellness (B2B) — account onboarding, seat provisioning, telemetry
// dashboard and seat billing. Pure DI: receives store collections via the factory.
import { randomUUID, randomInt } from 'node:crypto';
import { hashPassword } from '../auth/password-credentials.mjs';
import {
  INDUSTRY_SECTORS, WORKFORCE_BRACKETS, SUBSIDY_MODELS, HR_OBJECTIVES,
  CORPORATE_STATUS, EMPLOYEE_STATUS, BILLING_CYCLES, DASHBOARD_MODES,
  ENGAGEMENT_TARGET_PCT, calculateAbsenteeismDrop, calculateEngagementRate, calculateBill,
} from '../shared/corporate-constants.mjs';
import { sameEmail } from '../shared/identifiers.mjs';

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

export function createCorporateService({
  users, checkins, corporateAccounts, corporateEmployees, corporateBills, auditLog, settingsService,
}) {
  const now = () => new Date().toISOString();

  async function audit({ actor, action, target, before = null, after = null }) {
    await auditLog.insertAsync({
      id: `aud_${randomUUID().slice(0, 8)}`, at: now(), actor, action, target, before, after,
    });
  }

  function reference() {
    return {
      industrySectors: INDUSTRY_SECTORS,
      workforceBrackets: WORKFORCE_BRACKETS,
      subsidyModels: Object.keys(SUBSIDY_MODELS),
      hrObjectives: HR_OBJECTIVES,
      billingCycles: BILLING_CYCLES,
      engagementTargetPct: ENGAGEMENT_TARGET_PCT,
    };
  }

  // ── Account lifecycle ─────────────────────────────────────────────────────

  async function onboard({ body = {}, actorId }) {
    const {
      companyName, industrySector, workforceBracket, subsidyModel, passTier,
      hrContactName, hrContactPhone, hrContactEmail, objectives, domainWhitelist,
      billingCycle = 'monthly', seatLimit = 0, baselineSickDays = 7, lipaNamba,
    } = body;

    if (!companyName?.trim()) return { error: 'company_name_required', status: 400 };
    if (!INDUSTRY_SECTORS[industrySector]) return { error: 'invalid_industry_sector', status: 400 };
    if (!WORKFORCE_BRACKETS[workforceBracket]) return { error: 'invalid_workforce_bracket', status: 400 };
    if (SUBSIDY_MODELS[subsidyModel] === undefined) return { error: 'invalid_subsidy_model', status: 400 };
    if (!BILLING_CYCLES.includes(billingCycle)) return { error: 'invalid_billing_cycle', status: 400 };
    if (!settingsService.getTierConfig(passTier)) return { error: 'invalid_pass_tier', status: 400 };

    const unknownObjectives = (objectives || []).filter(o => !HR_OBJECTIVES.includes(o));
    if (unknownObjectives.length) {
      return { error: 'invalid_objectives', status: 400, invalid: unknownObjectives };
    }

    const account = await corporateAccounts.insertAsync({
      id: `corp_${randomUUID().slice(0, 8)}`,
      companyName: companyName.trim(),
      industrySector,
      workforceBracket,
      hrContactName: hrContactName ?? null,
      hrContactPhone: hrContactPhone ?? null,
      hrContactEmail: hrContactEmail ?? null,
      objectives: objectives || [],
      domainWhitelist: (domainWhitelist || []).map(d => String(d).trim().toLowerCase()),
      subsidyModel,
      passTier,
      billingCycle,
      seatLimit: Number(seatLimit) || 0,
      seatsUsed: 0,
      baselineSickDays: Number(baselineSickDays) || 7,
      lipaNamba: lipaNamba ?? null,
      status: 'pending',
      createdAt: now(),
      updatedAt: now(),
    });
    await audit({ actor: actorId, action: 'corporate.onboard', target: account.id, after: account });
    return { account };
  }

  async function setStatus({ corporateId, status, actorId }) {
    if (!CORPORATE_STATUS.includes(status)) return { error: 'invalid_status', status: 400 };
    const account = await corporateAccounts.findByIdAsync(corporateId);
    if (!account) return { error: 'account_not_found', status: 404 };
    if (account.status === status) return { account, unchanged: true };

    const updated = await corporateAccounts.updateByIdAsync(corporateId, { status, updatedAt: now() });
    await audit({ actor: actorId, action: `corporate.${status}`, target: corporateId, before: account, after: updated });
    return { account: updated };
  }

  async function update({ corporateId, body = {}, actorId }) {
    const account = await corporateAccounts.findByIdAsync(corporateId);
    if (!account) return { error: 'account_not_found', status: 404 };

    const patch = { updatedAt: now() };
    if (body.subsidyModel !== undefined) {
      if (SUBSIDY_MODELS[body.subsidyModel] === undefined) return { error: 'invalid_subsidy_model', status: 400 };
      patch.subsidyModel = body.subsidyModel;
    }
    if (body.passTier !== undefined) {
      if (!settingsService.getTierConfig(body.passTier)) return { error: 'invalid_pass_tier', status: 400 };
      patch.passTier = body.passTier;
    }
    if (body.billingCycle !== undefined) {
      if (!BILLING_CYCLES.includes(body.billingCycle)) return { error: 'invalid_billing_cycle', status: 400 };
      patch.billingCycle = body.billingCycle;
    }
    if (body.seatLimit !== undefined) {
      const seatLimit = Number(body.seatLimit);
      if (!Number.isInteger(seatLimit) || seatLimit < 0) return { error: 'invalid_seat_limit', status: 400 };
      if (seatLimit > 0 && seatLimit < account.seatsUsed) {
        return { error: 'seat_limit_below_seats_used', status: 409, seatsUsed: account.seatsUsed };
      }
      patch.seatLimit = seatLimit;
    }
    for (const field of ['hrContactName', 'hrContactPhone', 'hrContactEmail', 'lipaNamba',
      'billingContactName', 'billingContactPhone', 'billingContactEmail']) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (body.domainWhitelist !== undefined) {
      patch.domainWhitelist = (body.domainWhitelist || []).map(d => String(d).trim().toLowerCase());
    }
    if (body.baselineSickDays !== undefined) patch.baselineSickDays = Number(body.baselineSickDays) || 7;

    const updated = await corporateAccounts.updateByIdAsync(corporateId, patch);
    await audit({ actor: actorId, action: 'corporate.update', target: corporateId, before: account, after: updated });
    return { account: updated };
  }

  async function adminList({ status } = {}) {
    const rows = status
      ? await corporateAccounts.filterByColumnAsync('status', status)
      : await corporateAccounts.allAsync();
    return { accounts: rows.sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0)) };
  }

  /** Does `email` fall under an account's whitelisted domains? */
  async function verifyDomain({ corporateId, email }) {
    const account = await corporateAccounts.findByIdAsync(corporateId);
    if (!account) return { error: 'account_not_found', status: 404 };
    const domain = String(email || '').split('@')[1]?.toLowerCase();
    if (!domain) return { error: 'invalid_email', status: 400 };
    const whitelist = account.domainWhitelist || [];
    return { matched: whitelist.includes(domain), domain, whitelist };
  }

  // ── Seat provisioning ─────────────────────────────────────────────────────

  // 4-digit activation PIN. crypto.randomInt (not Math.random) because this is
  // a credential; only the scrypt hash is stored.
  const generatePin = () => String(randomInt(1000, 10000));

  async function requireActiveAccount(corporateId) {
    const account = await corporateAccounts.findByIdAsync(corporateId);
    if (!account) return { error: 'account_not_found', status: 404 };
    if (account.status !== 'active') return { error: 'account_not_active', status: 409, accountStatus: account.status };
    return { account };
  }

  async function buildEmployee({ corporateId, displayName, phone, email, department }) {
    const pin = generatePin();
    return {
      row: {
        id: `cemp_${randomUUID().slice(0, 8)}`,
        corporateId,
        userId: null,
        displayName: String(displayName).trim(),
        phone: phone?.trim() || null,
        email: email?.trim()?.toLowerCase() || null,
        department: department?.trim() || null,
        pinHash: await hashPassword(pin),
        status: 'pending',
        activatedAt: null,
        createdAt: now(),
        updatedAt: now(),
      },
      pin,
    };
  }

  async function provisionStaff({ corporateId, body = {}, actorId }) {
    const guard = await requireActiveAccount(corporateId);
    if (guard.error) return guard;
    const { account } = guard;

    if (!body.displayName?.trim()) return { error: 'display_name_required', status: 400 };
    if (account.seatLimit > 0 && account.seatsUsed >= account.seatLimit) {
      return { error: 'seat_limit_reached', status: 409, seatLimit: account.seatLimit };
    }

    const { row, pin } = await buildEmployee({ corporateId, ...body });
    const employee = await corporateEmployees.insertAsync(row);
    await corporateAccounts.updateByIdAsync(corporateId, {
      seatsUsed: account.seatsUsed + 1, updatedAt: now(),
    });
    await audit({ actor: actorId, action: 'corporate.staff.provision', target: employee.id, after: employee });

    // PIN is returned exactly once so HR can distribute it; it is never re-readable.
    return { employee, pin };
  }

  /**
   * Bulk provision from pasted CSV: `name,phone,email,department` per line.
   * Rows are validated first — the import is all-or-nothing so a typo halfway
   * down a paste cannot leave an account half-provisioned.
   */
  async function bulkProvisionStaff({ corporateId, body = {}, actorId }) {
    const guard = await requireActiveAccount(corporateId);
    if (guard.error) return guard;
    const { account } = guard;

    const lines = String(body.rawText || '')
      .split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { error: 'no_rows', status: 400 };

    const parsed = [];
    const errors = [];
    lines.forEach((line, index) => {
      const [displayName, phone, email, department] = line.split(',').map(c => c?.trim() ?? '');
      if (!displayName) return errors.push({ line: index + 1, error: 'display_name_required' });
      if (email && !email.includes('@')) return errors.push({ line: index + 1, error: 'invalid_email' });
      parsed.push({ displayName, phone, email, department: department || body.defaultDepartment });
    });
    if (errors.length) return { error: 'invalid_rows', status: 400, errors };

    const seatsAvailable = account.seatLimit > 0 ? account.seatLimit - account.seatsUsed : Infinity;
    if (parsed.length > seatsAvailable) {
      return { error: 'seat_limit_reached', status: 409, seatsAvailable, requested: parsed.length };
    }

    const built = await Promise.all(parsed.map(p => buildEmployee({ corporateId, ...p })));
    const employees = await Promise.all(built.map(b => corporateEmployees.insertAsync(b.row)));
    await corporateAccounts.updateByIdAsync(corporateId, {
      seatsUsed: account.seatsUsed + employees.length, updatedAt: now(),
    });
    await audit({
      actor: actorId, action: 'corporate.staff.bulk_provision', target: corporateId,
      after: { imported: employees.length },
    });

    return {
      imported: employees.length,
      // Paired with each employee so HR can hand out PINs after a bulk import.
      credentials: built.map(b => ({ employeeId: b.row.id, displayName: b.row.displayName, pin: b.pin })),
    };
  }

  async function setEmployeeStatus({ corporateId, employeeId, status, actorId }) {
    if (!EMPLOYEE_STATUS.includes(status)) return { error: 'invalid_status', status: 400 };
    const employee = await corporateEmployees.findByIdAsync(employeeId);
    if (!employee || employee.corporateId !== corporateId) return { error: 'employee_not_found', status: 404 };
    if (employee.status === status) return { employee, unchanged: true };

    const patch = { status, updatedAt: now() };
    if (status === 'active' && !employee.activatedAt) patch.activatedAt = now();
    const updated = await corporateEmployees.updateByIdAsync(employeeId, patch);

    // Exiting frees the seat back to the account's pool.
    if (status === 'exited' && employee.status !== 'exited') {
      const account = await corporateAccounts.findByIdAsync(corporateId);
      if (account) {
        await corporateAccounts.updateByIdAsync(corporateId, {
          seatsUsed: Math.max(0, account.seatsUsed - 1), updatedAt: now(),
        });
      }
    }
    await audit({ actor: actorId, action: `corporate.staff.${status}`, target: employeeId, before: employee, after: updated });
    return { employee: updated };
  }

  async function listStaff({ corporateId, search, department, status }) {
    const rows = await corporateEmployees.filterByColumnAsync('corporateId', corporateId);
    const needle = search?.trim().toLowerCase();
    const employees = rows
      .filter(e => (status ? e.status === status : true))
      .filter(e => (department ? e.department === department : true))
      .filter(e => (needle
        ? [e.displayName, e.email, e.phone].some(v => v?.toLowerCase().includes(needle))
        : true))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      // pinHash must never leave the service.
      .map(({ pinHash, ...rest }) => rest);
    return { employees };
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  async function dashboard({ corporateId, mode = 'employer' }) {
    if (!DASHBOARD_MODES.includes(mode)) return { error: 'invalid_mode', status: 400 };
    const account = await corporateAccounts.findByIdAsync(corporateId);
    if (!account) return { error: 'account_not_found', status: 404 };

    const roster = await corporateEmployees.filterByColumnAsync('corporateId', corporateId);
    const enrolled = roster.filter(e => e.status !== 'exited');
    const activeCount = roster.filter(e => e.status === 'active').length;
    const engagementRatePct = calculateEngagementRate({ activeCount, totalCount: enrolled.length });

    const linkedUserIds = enrolled.map(e => e.userId).filter(Boolean);
    const visits = linkedUserIds.length
      ? await checkins.filterByColumnInAsync('memberId', linkedUserIds)
      : [];

    // Average weekly visits per active employee across the observed window.
    const timestamps = visits.map(v => +new Date(v.timestamp)).filter(Number.isFinite);
    const spanWeeks = timestamps.length
      ? Math.max(1, (Date.now() - Math.min(...timestamps)) / MS_PER_WEEK)
      : 1;
    const avgVisitsPerWeek = activeCount ? visits.length / spanWeeks / activeCount : 0;

    const absenteeism = calculateAbsenteeismDrop({
      avgVisitsPerWeek, baselineSickDays: account.baselineSickDays,
    });

    const shared = {
      companyName: account.companyName,
      mode,
      seats: {
        limit: account.seatLimit,
        used: account.seatsUsed,
        enrolled: enrolled.length,
        active: activeCount,
      },
      engagement: {
        ratePct: engagementRatePct,
        targetPct: ENGAGEMENT_TARGET_PCT,
        onTrack: engagementRatePct >= ENGAGEMENT_TARGET_PCT,
      },
      visits: {
        total: visits.length,
        avgPerWeekPerActiveEmployee: Number(avgVisitsPerWeek.toFixed(2)),
      },
    };

    if (mode === 'insurer') {
      return {
        dashboard: {
          ...shared,
          absenteeism,
          estimatedSickDaysAvoided: absenteeism.estimatedDaysReduced * activeCount,
        },
      };
    }

    const byDepartment = {};
    for (const e of enrolled) {
      const key = e.department || 'unassigned';
      byDepartment[key] ??= { enrolled: 0, active: 0 };
      byDepartment[key].enrolled += 1;
      if (e.status === 'active') byDepartment[key].active += 1;
    }
    return { dashboard: { ...shared, absenteeism, byDepartment } };
  }

  // ── Billing ───────────────────────────────────────────────────────────────

  async function generateBill({ corporateId, period, actorId }) {
    const account = await corporateAccounts.findByIdAsync(corporateId);
    if (!account) return { error: 'account_not_found', status: 404 };
    const billingPeriod = period || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(billingPeriod)) return { error: 'invalid_period', status: 400 };

    const existing = await corporateBills.findAsync(
      b => b.corporateId === corporateId && b.period === billingPeriod,
    );
    if (existing) return { bill: existing, idempotent: true };

    const roster = await corporateEmployees.filterByColumnAsync('corporateId', corporateId);
    const seatCount = roster.filter(e => e.status === 'active').length;

    let breakdown;
    try {
      breakdown = calculateBill({
        perSeatMonthlyTzs: settingsService.priceForTier(account.passTier),
        seatCount,
        subsidyModel: account.subsidyModel,
        billingCycle: account.billingCycle,
      });
    } catch (err) {
      return { error: 'bill_calculation_failed', status: 422, detail: err.message };
    }

    const bill = await corporateBills.insertAsync({
      id: `cbill_${randomUUID().slice(0, 8)}`,
      corporateId,
      period: billingPeriod,
      passTier: account.passTier,
      subsidyModel: breakdown.subsidyModel,
      billingCycle: breakdown.billingCycle,
      seatCount: breakdown.seatCount,
      perSeatMonthlyTzs: breakdown.perSeatMonthlyTzs,
      grossTzs: breakdown.grossTzs,
      employerTzs: breakdown.employerTzs,
      employeeTzs: breakdown.employeeTzs,
      status: 'unpaid',
      paymentReference: null,
      paidAt: null,
      createdAt: now(),
    });
    await audit({ actor: actorId, action: 'corporate.bill.generate', target: bill.id, after: bill });
    return { bill };
  }

  async function listBills({ corporateId }) {
    const rows = await corporateBills.filterByColumnAsync('corporateId', corporateId);
    return { bills: rows.sort((a, b) => b.period.localeCompare(a.period)) };
  }

  async function markBillPaid({ billId, paymentReference, actorId }) {
    if (!paymentReference?.trim()) return { error: 'payment_reference_required', status: 400 };
    const bill = await corporateBills.findByIdAsync(billId);
    if (!bill) return { error: 'bill_not_found', status: 404 };
    if (bill.status === 'paid') return { bill, idempotent: true };

    const updated = await corporateBills.updateByIdAsync(billId, {
      status: 'paid', paymentReference: paymentReference.trim(), paidAt: now(),
    });
    await audit({ actor: actorId, action: 'corporate.bill.paid', target: billId, before: bill, after: updated });
    return { bill: updated };
  }

  /** Resolve the corporate account a request actor is scoped to. */
  // ── HR logins (created by FitFlex admins) ─────────────────────────────────
  // HR users sign in to the portal with email + password (scrypt hash, see
  // auth-service SCRYPT_PASSWORD_ROLES). They act on their own company only.

  const HR_MIN_PASSWORD = 10;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const hrView = u => ({
    id: u.id, displayName: u.displayName, email: u.email,
    accountStatus: u.accountStatus ?? 'active', createdAt: u.createdAt,
  });

  async function listHrUsers({ corporateId }) {
    const account = await corporateAccounts.findByIdAsync(corporateId);
    if (!account) return { error: 'corporate_not_found', status: 404 };
    const rows = (await users.filterByColumnAsync('corporateId', corporateId)).filter(u => u.userType === 'corporate_hr');
    return { hrUsers: rows.map(hrView) };
  }

  async function createHrUser({ corporateId, body = {}, actorId }) {
    const account = await corporateAccounts.findByIdAsync(corporateId);
    if (!account) return { error: 'corporate_not_found', status: 404 };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 80) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!EMAIL_RE.test(email)) return { error: 'invalid_email', status: 400 };
    if (!displayName) return { error: 'name_required', status: 400 };
    if (password.length < HR_MIN_PASSWORD) return { error: 'password_too_short', status: 400, minLength: HR_MIN_PASSWORD };
    const taken = (await users.filterAsync(u => sameEmail(u.email, email))).some(u => u.userType === 'corporate_hr');
    if (taken) return { error: 'email_in_use', status: 409 };
    const stamp = now();
    const row = {
      id: `usr_${randomUUID().slice(0, 12)}`,
      userType: 'corporate_hr', corporateId, email, displayName,
      passwordHash: await hashPassword(password),
      accountStatus: 'active', approvalStatus: 'approved', onboardingCompleted: true,
      createdAt: stamp, updatedAt: stamp,
    };
    await users.insertAsync(row);
    await audit({ actor: actorId, action: 'corporate.hr.create', target: row.id, after: hrView(row) });
    return { hrUser: hrView(row) };
  }

  async function setHrUserStatus({ corporateId, userId, status, actorId }) {
    if (!['active', 'suspended'].includes(status)) return { error: 'invalid_status', status: 400 };
    const u = await users.findByIdAsync(userId);
    if (!u || u.userType !== 'corporate_hr' || u.corporateId !== corporateId) return { error: 'hr_user_not_found', status: 404 };
    const updated = await users.updateByIdAsync(userId, { accountStatus: status, updatedAt: now() });
    await audit({ actor: actorId, action: `corporate.hr.${status}`, target: userId, before: hrView(u), after: hrView(updated ?? { ...u, accountStatus: status }) });
    return { hrUser: hrView(updated ?? { ...u, accountStatus: status }) };
  }

  async function resolveActorAccount({ userId, userType, corporateIdParam }) {
    if (userType === 'admin') {
      if (!corporateIdParam) return { error: 'corporate_id_required', status: 400 };
      return { corporateId: corporateIdParam };
    }
    const user = await users.findByIdAsync(userId);
    if (!user?.corporateId) return { error: 'not_linked_to_corporate_account', status: 403 };
    return { corporateId: user.corporateId };
  }

  return {
    reference, onboard, setStatus, update, adminList, verifyDomain,
    provisionStaff, bulkProvisionStaff, setEmployeeStatus, listStaff,
    dashboard, generateBill, listBills, markBillPaid, resolveActorAccount,
    listHrUsers, createHrUser, setHrUserStatus,
  };
}
