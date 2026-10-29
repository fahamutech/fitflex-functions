// A member agrees before an organisation adds them by account id
// (security fix, owner decision 22 Oct 2026; privacy ruling A-02).
//
// An organisation user (beneficiaries.manage / users.manage) or a company's
// HR who names a member only by user id no longer adds them. A user id proves
// nothing: ids show in activity feeds, leaderboards and groups. Instead a
// pending B2BMemberRequest is made and the member is told in the app. Until
// they accept nothing changes for them: no beneficiary row, no staff link, no
// organisation role. So no organisation sees their activity (every A-02 read
// goes through those rows) and no sponsor is charged. Accepting performs the
// add, through the same service call and checks as before, with the
// requester's access as it is at that moment.
//
//   kind     beneficiary    enrol in a B2B organisation   (b2bService.enrollBeneficiary)
//            org_user       a role in its portal           (b2bService.addOrganizationUser)
//            employee_link  link a company staff record    (corporateService.linkEmployeeUser)
//   status   pending → accepted | declined | expired | cancelled
//
// Accept is single use (compare-and-set on status). A request expires after
// B2B_MEMBER_REQUEST_TTL_DAYS days (default 14). FitFlex platform admins keep
// the direct add (see b2b-service / corporate-service); adds by a VERIFIED
// email or number are unchanged.
import { randomUUID } from 'node:crypto';
import { createVendorLimiter } from '../shared/vendor-rate-limit.mjs';

const TABLE = 'B2BMemberRequest';
const SYSTEM = 'system:b2b-member-requests';
export const MEMBER_REQUEST_KINDS = Object.freeze(['beneficiary', 'org_user', 'employee_link']);
export const MEMBER_REQUEST_STATUSES = Object.freeze(['pending', 'accepted', 'declined', 'expired', 'cancelled']);
export const DEFAULT_MEMBER_REQUEST_TTL_DAYS = 14;
const DAY_MS = 86_400_000;

/** Days a request stays open: B2B_MEMBER_REQUEST_TTL_DAYS (1–90), else 14. */
export function memberRequestTtlDays(env = process.env) {
  const n = parseInt(env.B2B_MEMBER_REQUEST_TTL_DAYS, 10);
  return Number.isFinite(n) && n >= 1 && n <= 90 ? n : DEFAULT_MEMBER_REQUEST_TTL_DAYS;
}

/** Days after a decline (or the organisation withdrawing) before the same organisation may ask the same person again: B2B_MEMBER_REQUEST_COOLDOWN_DAYS (0–365), else 30. */
export const DEFAULT_MEMBER_REQUEST_COOLDOWN_DAYS = 30;
export function memberRequestCooldownDays(env = process.env) {
  const n = parseInt(env.B2B_MEMBER_REQUEST_COOLDOWN_DAYS, 10);
  return Number.isFinite(n) && n >= 0 && n <= 365 ? n : DEFAULT_MEMBER_REQUEST_COOLDOWN_DAYS;
}
/** Open requests one organisation / company may have at once: B2B_MEMBER_REQUEST_MAX_PENDING (1–10000), else 200. */
export const DEFAULT_MEMBER_REQUEST_MAX_PENDING = 200;
export function memberRequestMaxPending(env = process.env) {
  const n = parseInt(env.B2B_MEMBER_REQUEST_MAX_PENDING, 10);
  return Number.isFinite(n) && n >= 1 && n <= 10_000 ? n : DEFAULT_MEMBER_REQUEST_MAX_PENDING;
}
/** Adds by user id one requester may make per hour: B2B_MEMBER_REQUEST_RATE_PER_HOUR (1–1000), else 60. */
export const DEFAULT_MEMBER_REQUEST_RATE_PER_HOUR = 60;
export function memberRequestRatePerHour(env = process.env) {
  const n = parseInt(env.B2B_MEMBER_REQUEST_RATE_PER_HOUR, 10);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : DEFAULT_MEMBER_REQUEST_RATE_PER_HOUR;
}
const HOUR_MS = 3_600_000;

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const newId = () => `b2bmr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

// What the organisation will see once the member accepts (A-02), as the
// analytics person view shows it. Swahili texts are DRAFTS for native review.
// Full history (owner decision 22 Oct 2026, stated openly): the organisation
// also sees activity from before the person joined, hence `past_activity`.
export const ACTIVITY_SHOWN = Object.freeze(['gym_visits', 'trainer_sessions', 'workouts', 'steps', 'active_minutes', 'challenge_progress', 'sponsored_benefit_use', 'past_activity']);
export const ACTIVITY_NOT_SHOWN = Object.freeze(['weight', 'height', 'calories', 'notes', 'routes', 'other_sponsors']);

function visibility(kind, name, role) {
  if (kind === 'org_user') {
    return {
      shown: ['name', 'email', 'role'],
      notShown: ['activity'],
      en: `${name} will see your name and email in its list of portal users, and you will be able to sign in to its FitFlex portal as ${role}. Your activity is not shared.`,
      sw: `${name} itaona jina lako na barua pepe yako kwenye orodha ya watumiaji wa portal yake, na utaweza kuingia kwenye portal yake ya FitFlex kama ${role}. Shughuli zako hazishirikiwi.`,
    };
  }
  return {
    shown: [...ACTIVITY_SHOWN],
    notShown: [...ACTIVITY_NOT_SHOWN],
    en: `${name} will see your FitFlex activity, including activity from before you joined: gym visits, trainer sessions, the workouts and steps you record and your progress in its challenges, and how you use the benefits it pays for. It will not see your weight, height, calories, notes, routes, or anything another sponsor gives you.`,
    sw: `${name} itaona shughuli zako za FitFlex, zikiwemo za kabla hujajiunga: ziara za gym, vipindi na trainer, mazoezi na hatua unazorekodi, maendeleo yako kwenye changamoto zake, na jinsi unavyotumia manufaa inayolipia. Haitaona uzito wako, urefu wako, kalori, maelezo, njia zako, wala chochote anachokupa mfadhili mwingine.`,
  };
}

// The in-app / push message. Swahili is a DRAFT for native review.
function message(kind, name, role) {
  if (kind === 'org_user') {
    return {
      en: { title: `${name} wants to add you`, body: `${name} wants to give you the ${role} role in its FitFlex portal. Open to accept or decline.` },
      sw: { title: `${name} inataka kukuongeza`, body: `${name} inataka kukupa nafasi ya ${role} kwenye portal yake ya FitFlex. Fungua ili ukubali au ukatae.` },
    };
  }
  if (kind === 'employee_link') {
    return {
      en: { title: `${name} wants to link your account`, body: `${name} wants to link your FitFlex account to your staff record. If you accept, it will see your FitFlex activity, including activity from before you joined. Open to accept or decline.` },
      sw: { title: `${name} inataka kuunganisha akaunti yako`, body: `${name} inataka kuunganisha akaunti yako ya FitFlex na taarifa zako za mfanyakazi. Ukikubali, itaona shughuli zako za FitFlex, zikiwemo za kabla hujajiunga. Fungua ili ukubali au ukatae.` },
    };
  }
  return {
    en: { title: `${name} wants to add you`, body: `${name} wants to add you to its wellness programme on FitFlex. If you accept, it will see your FitFlex activity, including activity from before you joined. Open to accept or decline.` },
    sw: { title: `${name} inataka kukuongeza`, body: `${name} inataka kukuongeza kwenye mpango wake wa afya kwenye FitFlex. Ukikubali, itaona shughuli zako za FitFlex, zikiwemo za kabla hujajiunga. Fungua ili ukubali au ukatae.` },
  };
}

// A FitFlex platform admin added the person directly by user id (owner
// decision 22 Oct 2026: admins keep the direct add, the person is told who
// added them and what the organisation sees). Swahili is a DRAFT for native review.
function adminAddedMessage(kind, name, role) {
  if (kind === 'org_user') {
    return {
      en: { title: `${name} added you`, body: `FitFlex support gave you the ${role} role in ${name}'s FitFlex portal. ${name} will see your name and email in its list of portal users. Your activity is not shared.` },
      sw: { title: `${name} imekuongeza`, body: `Timu ya FitFlex imekupa nafasi ya ${role} kwenye portal ya FitFlex ya ${name}. ${name} itaona jina lako na barua pepe yako kwenye orodha ya watumiaji wa portal yake. Shughuli zako hazishirikiwi.` },
    };
  }
  if (kind === 'employee_link') {
    return {
      en: { title: `${name} linked your account`, body: `FitFlex support linked your FitFlex account to your staff record at ${name}. ${name} will see your FitFlex activity, including activity from before you joined. It will not see your weight, height, calories, notes or routes. Open Benefits to see what you get.` },
      sw: { title: `${name} imeunganisha akaunti yako`, body: `Timu ya FitFlex imeunganisha akaunti yako ya FitFlex na taarifa zako za mfanyakazi katika ${name}. ${name} itaona shughuli zako za FitFlex, zikiwemo za kabla hujajiunga. Haitaona uzito wako, urefu wako, kalori, maelezo wala njia zako. Fungua Manufaa uone unachopata.` },
    };
  }
  return {
    en: { title: `${name} added you`, body: `FitFlex support added you to ${name}'s wellness programme. ${name} will see your FitFlex activity, including activity from before you joined. It will not see your weight, height, calories, notes or routes. Open Benefits to see what you get.` },
    sw: { title: `${name} imekuongeza`, body: `Timu ya FitFlex imekuongeza kwenye mpango wa afya wa ${name}. ${name} itaona shughuli zako za FitFlex, zikiwemo za kabla hujajiunga. Haitaona uzito wako, urefu wako, kalori, maelezo wala njia zako. Fungua Manufaa uone unachopata.` },
  };
}

// Accepting failed for a reason that will not go away: the request is closed.
const FINAL = new Set(['already_enrolled', 'already_organization_user', 'user_already_linked', 'employee_already_linked',
  'request_no_longer_valid', 'employee_not_found', 'employee_exited', 'organization_not_found', 'managed_by_corporate']);
// The requester no longer has the right to do what they asked.
const LOST_ACCESS = new Set(['forbidden', 'cannot_grant_permissions', 'organization_not_found', 'not_linked_to_corporate_account']);

export function createB2BMemberRequestService({
  db, b2bService, corporateService,
  // ({ organizationId, beneficiary: { groupName, beneficiaryType } }) → [{ program, benefit }]
  previewBenefits = async () => [],
  // (userId, { id, type, title, body, data })
  notify = async () => null,
  // (userId) → 'sw' | 'en' | null: the language the person chose for messages (CommunicationPreference.locale)
  localeOf = async () => null,
  ttlDays = () => memberRequestTtlDays(),
  cooldownDays = () => memberRequestCooldownDays(),
  maxPending = () => memberRequestMaxPending(),
  ratePerHour = () => memberRequestRatePerHour(),
  now = () => new Date(),
}) {
  const stamp = () => new Date(now());
  const audit = (actor, action, target, after = null) => db('AuditLog').insert({
    id: randomUUID(), at: stamp(), actor: actor ?? null, action, target, before: null, after: after == null ? null : JSON.stringify(after),
  });

  /** Who is asking: the organisation, or the company for a staff link. */
  async function scopeOf(row) {
    if (row.kind === 'employee_link') {
      const account = await db('CorporateAccount').where({ id: row.corporateId }).first('id', 'companyName', 'passTier', 'subsidyModel');
      const org = await db('B2BOrganization').where({ legacyCorporateId: row.corporateId }).first('id');
      return { id: org?.id ?? null, corporateId: row.corporateId, name: account?.companyName ?? 'Your employer', organizationType: 'employer', account };
    }
    const org = await db('B2BOrganization').where({ id: row.organizationId }).first('id', 'legalName', 'tradingName', 'organizationType');
    return { id: row.organizationId, corporateId: null, name: org ? (org.tradingName || org.legalName) : 'An organisation', organizationType: org?.organizationType ?? null };
  }

  const displayNames = async (ids) => {
    const rows = ids.length ? await db('User').whereIn('id', [...new Set(ids)]).select('id', 'displayName') : [];
    return new Map(rows.map(u => [u.id, u.displayName ?? null]));
  };

  /**
   * The organisation's view: who was asked, what for, until when. Never the
   * member's contacts, and not even their name until they accept (security
   * review finding 4: an id must not be turned into a name by asking).
   */
  function orgView(row, names = new Map()) {
    const d = row.details || {};
    return {
      id: row.id, kind: row.kind,
      status: row.status === 'pending' ? 'pending_member_acceptance' : row.status,
      organizationId: row.organizationId ?? null, corporateId: row.corporateId ?? null, employeeId: row.employeeId ?? null,
      userId: row.userId, displayName: row.status === 'accepted' ? (names.get(row.userId) ?? null) : null,
      role: d.role ?? null, permissions: d.permissions ?? null,
      beneficiaryType: d.beneficiaryType ?? null, groupName: d.groupName ?? null, externalReference: d.externalReference ?? null,
      beneficiaryStatus: d.beneficiaryStatus ?? null,
      expiresAt: row.expiresAt, createdAt: row.createdAt, decidedAt: row.decidedAt ?? null, reason: row.reason ?? null,
    };
  }

  /** The member's view: who is asking, what they will see, what the member would get. */
  async function memberView(row) {
    const d = row.details || {};
    const scope = await scopeOf(row);
    let benefits = [];
    let sponsor = null;
    if (row.kind === 'beneficiary') {
      benefits = await previewBenefits({ organizationId: row.organizationId, beneficiary: { groupName: d.groupName, beneficiaryType: d.beneficiaryType } }).catch(() => []);
    } else if (row.kind === 'employee_link') {
      const employee = await db('CorporateEmployee').where({ id: row.employeeId }).first('department');
      if (scope.id) benefits = await previewBenefits({ organizationId: scope.id, beneficiary: { groupName: employee?.department ?? null, beneficiaryType: 'employee' } }).catch(() => []);
      sponsor = scope.account ? { passTier: scope.account.passTier ?? null, subsidyModel: scope.account.subsidyModel ?? null } : null;
    }
    return {
      id: row.id, kind: row.kind, status: row.status,
      organization: { id: scope.id, corporateId: scope.corporateId, name: scope.name, organizationType: scope.organizationType },
      role: d.role ?? null, beneficiaryType: d.beneficiaryType ?? null, groupName: d.groupName ?? null,
      visibility: visibility(row.kind, scope.name, d.role),
      benefits, sponsor,
      createdAt: row.createdAt, expiresAt: row.expiresAt, decidedAt: row.decidedAt ?? null,
    };
  }

  async function tell(row) {
    const scope = await scopeOf(row);
    const text = message(row.kind, scope.name, row.details?.role);
    // In the member's chosen language ('sw' → Swahili, otherwise English), both kept in data for the inbox.
    const locale = (await localeOf(row.userId).catch(() => null)) === 'sw' ? 'sw' : 'en';
    await notify(row.userId, {
      id: `b2b_member_request_${row.id}`.slice(0, 120), type: 'b2b_member_request', title: text[locale].title, body: text[locale].body,
      data: {
        requestId: row.id, kind: row.kind, organizationId: scope.id ?? '', open: 'b2b_member_requests', locale,
        titleEn: text.en.title, bodyEn: text.en.body, titleSw: text.sw.title, bodySw: text.sw.body,
      },
    });
  }

  /**
   * Tell someone a FitFlex platform admin added them directly by user id:
   * who (the organisation, by FitFlex support) and what it will see. Logged as
   * b2b.member.admin_added next to the add's own audit entry.
   */
  async function adminAdded({ kind, organizationId = null, corporateId = null, employeeId = null, userId, actorId, role = null, resultId = null }) {
    if (!MEMBER_REQUEST_KINDS.includes(kind) || !userId) return { notified: false };
    const scope = await scopeOf({ kind, organizationId, corporateId });
    const text = adminAddedMessage(kind, scope.name, role);
    const locale = (await localeOf(userId).catch(() => null)) === 'sw' ? 'sw' : 'en';
    const id = `b2b_admin_added_${kind}_${resultId ?? randomUUID()}_${userId}`.slice(0, 120);
    await notify(userId, {
      id, type: 'b2b_admin_added', title: text[locale].title, body: text[locale].body,
      data: {
        kind, organizationId: scope.id ?? '', open: 'b2b_benefits', locale,
        titleEn: text.en.title, bodyEn: text.en.body, titleSw: text.sw.title, bodySw: text.sw.body,
      },
    }).catch(() => null);
    await audit(actorId, 'b2b.member.admin_added', resultId ?? userId, { kind, userId, organizationId: scope.id ?? null, corporateId, employeeId, role, notificationId: id });
    return { notified: true };
  }

  // ── Expiry ────────────────────────────────────────────────────────────────

  /** Close open requests past their expiry (all, one member's, or these ids). */
  async function expireDue({ userId = null, ids = null, limit = 500 } = {}) {
    const at = stamp();
    let q = db(TABLE).where({ status: 'pending' }).where('expiresAt', '<=', at);
    if (userId) q = q.where({ userId });
    if (ids) q = q.whereIn('id', ids);
    const due = await q.orderBy('expiresAt').limit(limit).pluck('id');
    if (!due.length) return { expired: 0 };
    const rows = await db(TABLE).whereIn('id', due).where({ status: 'pending' }).where('expiresAt', '<=', at)
      .update({ status: 'expired', decidedAt: at, decidedBy: SYSTEM, updatedAt: at }).returning(['id', 'kind', 'userId', 'organizationId', 'corporateId', 'employeeId']);
    for (const r of rows) await audit(SYSTEM, 'b2b.member_request.expire', r.id, { kind: r.kind, userId: r.userId, organizationId: r.organizationId, corporateId: r.corporateId, employeeId: r.employeeId });
    return { expired: rows.length };
  }

  // ── Limits (security review finding 3: each request pushes a notification) ─

  // Every add by user id, including those that find nobody: in memory per
  // server (the repo's limiter, vendor-rate-limit.mjs), one window per requester per hour.
  const attemptLimiters = new Map();
  /** null when this requester may try another add by user id now, else 429 rate_limited. */
  function attempt(requestedBy) {
    const limit = ratePerHour();
    if (!attemptLimiters.has(limit)) attemptLimiters.set(limit, createVendorLimiter({ perMinute: limit, windowMs: HOUR_MS }));
    const allowed = attemptLimiters.get(limit).allow(`member-request:${requestedBy ?? 'unknown'}`, +stamp());
    return allowed.ok ? null : fail('rate_limited', 429, { retryAfterSeconds: allowed.retryAfterSeconds });
  }

  /** The checks before a request is stored: hourly rate (durable, all servers), cooldown, open cap. */
  async function refuseNew({ scopeId, userId, requestedBy }) {
    const at = stamp();
    const [{ c: lastHour }] = await db(TABLE).where({ requestedBy }).where('createdAt', '>', new Date(+at - HOUR_MS)).count({ c: '*' });
    if (Number(lastHour) >= ratePerHour()) {
      const [{ first }] = await db(TABLE).where({ requestedBy }).where('createdAt', '>', new Date(+at - HOUR_MS)).min({ first: 'createdAt' });
      return fail('rate_limited', 429, { retryAfterSeconds: Math.max(1, Math.ceil((+new Date(first) + HOUR_MS - +at) / 1000)) });
    }
    const days = cooldownDays();
    if (days > 0) {
      const recent = await db(TABLE).where({ scopeId, userId }).where('decidedAt', '>', new Date(+at - days * DAY_MS))
        .where(b => b.where({ status: 'declined' }).orWhere({ status: 'cancelled', reason: 'cancelled_by_organization' }))
        .max({ last: 'decidedAt' }).first();
      if (recent?.last) {
        const until = new Date(+new Date(recent.last) + days * DAY_MS);
        return fail('member_request_cooldown', 429, { retryAfter: until.toISOString(), retryAfterSeconds: Math.max(1, Math.ceil((+until - +at) / 1000)) });
      }
    }
    const [{ c: open }] = await db(TABLE).where({ scopeId, status: 'pending' }).where('expiresAt', '>', at).count({ c: '*' });
    if (Number(open) >= maxPending()) return fail('member_request_limit', 429, { maxPending: maxPending() });
    return null;
  }

  /**
   * The same 202 answer as a real request, when the id names nobody who can
   * be asked (no such account, or not a member where one is needed). Nothing
   * is stored and nobody is told; `id` is null.
   */
  function stub({ kind, organizationId = null, corporateId = null, employeeId = null, userId, details = {} }) {
    const at = stamp();
    return {
      outcome: 'pending_member_acceptance',
      memberRequest: orgView({
        id: null, kind, status: 'pending', organizationId, corporateId, employeeId, userId: String(userId ?? '').trim(),
        details, expiresAt: new Date(+at + ttlDays() * DAY_MS), createdAt: at,
      }),
    };
  }

  // ── Made by the organisation side ─────────────────────────────────────────

  /**
   * Called by b2bService / corporateService instead of adding someone named by
   * user id. Returns { outcome: 'pending_member_acceptance', memberRequest }.
   */
  async function create({ kind, organizationId = null, corporateId = null, employeeId = null, userId, requestedBy, requestedByType, details = {} }) {
    if (!MEMBER_REQUEST_KINDS.includes(kind)) throw new Error(`unknown member request kind ${kind}`);
    if (!requestedBy) return fail('actor_required', 403);
    const scopeId = kind === 'employee_link' ? corporateId : organizationId;
    if (!scopeId || !userId) throw new Error('member request needs a scope and a user');
    // An expired request must not block a new one.
    await expireDue({ userId });
    const open = await db(TABLE).where({ status: 'pending' })
      .where(b => { b.where({ kind, scopeId, userId }); if (employeeId) b.orWhere({ kind: 'employee_link', employeeId }); }).first();
    if (open) return fail('member_request_pending', 409, { memberRequestId: open.id, expiresAt: open.expiresAt });
    const refused = await refuseNew({ scopeId, userId, requestedBy });
    if (refused) return refused;
    const at = stamp();
    const row = {
      id: newId(), kind, scopeId, organizationId, corporateId, employeeId, userId, requestedBy, requestedByType: requestedByType || 'member',
      details: JSON.stringify(details), status: 'pending', expiresAt: new Date(+at + ttlDays() * DAY_MS), createdAt: at, updatedAt: at,
    };
    try {
      await db(TABLE).insert(row);
    } catch (err) {
      if (err.code !== '23505') throw err;
      const open = await db(TABLE).where({ status: 'pending' })
        .where(b => { b.where({ kind, scopeId, userId }); if (employeeId) b.orWhere({ kind: 'employee_link', employeeId }); }).first();
      return fail('member_request_pending', 409, { memberRequestId: open?.id ?? null, expiresAt: open?.expiresAt ?? null });
    }
    await audit(requestedBy, 'b2b.member_request.create', row.id, { kind, organizationId, corporateId, employeeId, userId, details });
    const saved = await db(TABLE).where({ id: row.id }).first();
    await tell(saved).catch(() => null);
    return { outcome: 'pending_member_acceptance', memberRequest: orgView(saved, await displayNames([userId])) };
  }

  /** Open requests an organisation made, of one kind (org lists show them as pending). */
  async function pendingForOrganization({ organizationId, kind }) {
    const at = stamp();
    const rows = await db(TABLE).where({ organizationId, kind, status: 'pending' }).where('expiresAt', '>', at).orderBy('createdAt', 'desc');
    const names = await displayNames(rows.map(r => r.userId));
    return rows.map(r => orgView(r, names));
  }

  /** Open staff-link requests of a company, by employee id. */
  async function pendingForCorporate({ corporateId }) {
    const at = stamp();
    const rows = await db(TABLE).where({ corporateId, kind: 'employee_link', status: 'pending' }).where('expiresAt', '>', at);
    const names = await displayNames(rows.map(r => r.userId));
    return new Map(rows.map(r => [r.employeeId, orgView(r, names)]));
  }

  async function closeByOrg(row, actorId) {
    const at = stamp();
    const [closed] = await db(TABLE).where({ id: row.id, status: 'pending' })
      .update({ status: 'cancelled', decidedAt: at, decidedBy: actorId ?? null, reason: 'cancelled_by_organization', updatedAt: at }).returning('*');
    if (closed) await audit(actorId, 'b2b.member_request.cancel', row.id, { kind: row.kind, userId: row.userId, organizationId: row.organizationId, corporateId: row.corporateId });
    return closed;
  }

  /** An organisation withdraws a request it made (beneficiaries.manage / users.manage, by kind). */
  async function cancel({ access, requestId, actorId }) {
    const row = await db(TABLE).where({ id: requestId }).first();
    if (!row || row.kind === 'employee_link' || row.organizationId !== access.org.id) return fail('member_request_not_found', 404);
    const permission = row.kind === 'org_user' ? 'users.manage' : 'beneficiaries.manage';
    if (!access.platformAdmin && !access.permissions.includes(permission)) return fail('forbidden', 403, { requiredPermission: permission });
    if (row.status !== 'pending') return fail('member_request_not_pending', 409, { requestStatus: row.status });
    const closed = await closeByOrg(row, actorId);
    if (!closed) return fail('member_request_not_pending', 409);
    return { memberRequest: orgView(closed, await displayNames([row.userId])) };
  }

  /** HR unlinked the staff record (or linked it otherwise): its open link request goes. */
  async function cancelForEmployee({ corporateId, employeeId, actorId }) {
    const rows = await db(TABLE).where({ corporateId, employeeId, kind: 'employee_link', status: 'pending' });
    for (const r of rows) await closeByOrg(r, actorId);
    return { cancelled: rows.length };
  }

  // ── The member ────────────────────────────────────────────────────────────

  async function listForMember({ userId }) {
    await expireDue({ userId });
    const rows = await db(TABLE).where({ userId, status: 'pending' }).orderBy('createdAt', 'desc');
    return { items: await Promise.all(rows.map(memberView)) };
  }

  /** The member's own request, or 404 (someone else's is not revealed). */
  async function own(userId, requestId) {
    const row = await db(TABLE).where({ id: String(requestId ?? '') }).first();
    return row && row.userId === userId ? row : null;
  }

  async function notPending(row) {
    if (row.status === 'pending' && new Date(row.expiresAt) <= stamp()) {
      await expireDue({ ids: [row.id] });
      return fail('member_request_expired', 410);
    }
    if (row.status === 'expired') return fail('member_request_expired', 410);
    if (row.status !== 'pending') return fail('member_request_not_pending', 409, { requestStatus: row.status });
    return null;
  }

  /** Do what was asked, as the requester, with their access as it is now. */
  async function apply(row) {
    const d = row.details || {};
    if (row.kind === 'employee_link') {
      if (row.requestedByType !== 'admin' && row.organizationId) {
        // B5a: asked from the company's organisation (/org). The requester must
        // still manage that company's staff there now (ORG_ONLY_SPONSORS on, org
        // role hr or admin, the organisation still the company's).
        const access = await b2bService.resolveAccess({ organizationId: row.organizationId, userId: row.requestedBy, userType: row.requestedByType });
        if (access.error || access.org.legacyCorporateId !== row.corporateId || !b2bService.companyStaffManage?.(access)) {
          return fail('request_no_longer_valid', 409, access.error ? { reason: access.error } : {});
        }
      } else if (row.requestedByType !== 'admin') {
        const hr = await db('User').where({ id: row.requestedBy }).first('userType', 'corporateId', 'accountStatus');
        if (!hr || hr.userType !== 'corporate_hr' || hr.corporateId !== row.corporateId || (hr.accountStatus ?? 'active') !== 'active') return fail('request_no_longer_valid', 409);
      }
      const employee = await db('CorporateEmployee').where({ id: row.employeeId }).first('id', 'corporateId', 'status', 'userId');
      if (!employee || employee.corporateId !== row.corporateId) return fail('employee_not_found', 404);
      if (employee.status === 'exited') return fail('employee_exited', 409);
      if (employee.userId && employee.userId !== row.userId) return fail('employee_already_linked', 409);
      const out = await corporateService.linkEmployeeUser({
        corporateId: row.corporateId, employeeId: row.employeeId, userId: row.userId, actorId: row.requestedBy, actorType: row.requestedByType, memberRequestId: row.id,
      });
      if (out.error) return out;
      return { resultId: out.employee.id, result: { employee: out.employee } };
    }
    const access = await b2bService.resolveAccess({ organizationId: row.organizationId, userId: row.requestedBy, userType: row.requestedByType });
    if (access.error) return fail('request_no_longer_valid', 409, { reason: access.error });
    if (row.kind === 'org_user') {
      const out = await b2bService.addOrganizationUser({ access, actorId: row.requestedBy, body: { userId: row.userId, role: d.role, permissions: d.permissions ?? [] } }, { memberRequestId: row.id });
      if (out.error) return LOST_ACCESS.has(out.error) ? fail('request_no_longer_valid', 409, { reason: out.error }) : out;
      return { resultId: out.organizationUser.id, result: { organizationUser: out.organizationUser } };
    }
    const out = await b2bService.enrollBeneficiary({
      access, actorId: row.requestedBy,
      body: { userId: row.userId, status: d.beneficiaryStatus ?? 'pending', beneficiaryType: d.beneficiaryType, groupName: d.groupName, externalReference: d.externalReference },
    }, { memberRequestId: row.id });
    if (out.error) return LOST_ACCESS.has(out.error) ? fail('request_no_longer_valid', 409, { reason: out.error }) : out;
    return { resultId: out.beneficiary.id, result: { beneficiary: out.beneficiary } };
  }

  /** Accept: single use. The add happens now; if it can't, the request says why. */
  async function accept({ userId, requestId }) {
    const row = await own(userId, requestId);
    if (!row) return fail('member_request_not_found', 404);
    const refused = await notPending(row);
    if (refused) return refused;
    const at = stamp();
    const [claimed] = await db(TABLE).where({ id: row.id, status: 'pending' }).where('expiresAt', '>', at)
      .update({ status: 'accepted', decidedAt: at, decidedBy: userId, updatedAt: at }).returning('*');
    if (!claimed) {
      const current = await db(TABLE).where({ id: row.id }).first('status');
      return current?.status === 'expired' ? fail('member_request_expired', 410) : fail('member_request_not_pending', 409, { requestStatus: current?.status ?? null });
    }
    const reopen = () => db(TABLE).where({ id: row.id, status: 'accepted' }).whereNull('resultId')
      .update({ status: 'pending', decidedAt: null, decidedBy: null, updatedAt: stamp() });
    let out;
    try {
      out = await apply(claimed);
    } catch (err) {
      await reopen();
      throw err;
    }
    if (out.error) {
      if (FINAL.has(out.error)) {
        const done = stamp();
        await db(TABLE).where({ id: row.id, status: 'accepted' }).update({ status: 'cancelled', reason: out.error, decidedAt: done, decidedBy: SYSTEM, updatedAt: done });
        await audit(SYSTEM, 'b2b.member_request.cancel', row.id, { kind: row.kind, userId, reason: out.error });
      } else {
        await reopen();
      }
      return { ...out, memberRequestId: row.id };
    }
    const [done] = await db(TABLE).where({ id: row.id }).update({ resultId: out.resultId, updatedAt: stamp() }).returning('*');
    await audit(userId, 'b2b.member_request.accept', row.id, { kind: row.kind, organizationId: row.organizationId, corporateId: row.corporateId, employeeId: row.employeeId, resultId: out.resultId });
    return { memberRequest: await memberView(done), ...out.result };
  }

  async function decline({ userId, requestId }) {
    const row = await own(userId, requestId);
    if (!row) return fail('member_request_not_found', 404);
    const refused = await notPending(row);
    if (refused) return refused;
    const at = stamp();
    const [closed] = await db(TABLE).where({ id: row.id, status: 'pending' })
      .update({ status: 'declined', decidedAt: at, decidedBy: userId, updatedAt: at }).returning('*');
    if (!closed) return fail('member_request_not_pending', 409);
    await audit(userId, 'b2b.member_request.decline', row.id, { kind: row.kind, organizationId: row.organizationId, corporateId: row.corporateId, employeeId: row.employeeId });
    return { memberRequest: await memberView(closed) };
  }

  return {
    attempt, stub, adminAdded,
    create, pendingForOrganization, pendingForCorporate, cancel, cancelForEmployee,
    listForMember, accept, decline, expireDue,
  };
}
