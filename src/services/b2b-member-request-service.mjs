// A member agrees before an organisation adds them (security fix, owner
// decisions 22 Oct 2026; privacy ruling A-02).
//
// An organisation user (beneficiaries.manage / users.manage) or a company's
// HR who names a member, by user id OR by a verified email or mobile number,
// no longer adds them; nor does a bulk import or an invite that matches a
// member's verified contact (consent slice (a), owner decision 22 Oct 2026,
// re-confirmed 29 Oct). Instead a pending B2BMemberRequest is made and the
// member is told in the app. Until they accept nothing changes for them: no
// beneficiary row, no staff link, no organisation role. So no organisation
// sees their activity (every A-02 read goes through those rows) and no sponsor
// is charged. Accepting performs the add, through the same service call and
// checks as before, with the requester's access as it is at that moment.
//
//   kind     beneficiary    enrol in a B2B organisation   (b2bService.enrollBeneficiary)
//            org_user       a role in its portal           (b2bService.addOrganizationUser)
//            employee_link  link a company staff record    (corporateService.linkEmployeeUser)
//   source   user_id        named by account id            (create)
//            contact        named by email / number        (createByContact)
//            invite         an invite matched a verified contact (createFromInvite)
//   status   pending → accepted | declined | expired | cancelled
//
// By contact the organisation must not learn whether a member is behind the
// email or number before that member accepts. So every add by contact stores
// a request: with the member when there is one who may be asked, otherwise
// with no member (nobody is told; it expires). The reply, the pending lists
// and the limits are the same either way; a decline shows to the organisation
// as still pending until the request would have expired. Invite matches are
// never listed as requests (the organisation sees the invite, still invited).
//
// Accept is single use (compare-and-set on status). A request expires after
// B2B_MEMBER_REQUEST_TTL_DAYS days (default 14). FitFlex platform admins keep
// the direct add, by id or by contact, and the person is told (b2b_admin_added).
import { randomUUID } from 'node:crypto';
import { createVendorLimiter } from '../shared/vendor-rate-limit.mjs';

const TABLE = 'B2BMemberRequest';
const SYSTEM = 'system:b2b-member-requests';
/** Who asks when an invite matches: FitFlex on the organisation's behalf (checked again on accept). */
export const INVITE_REQUESTER = 'system:b2b-beneficiary-invites';
export const MEMBER_REQUEST_KINDS = Object.freeze(['beneficiary', 'org_user', 'employee_link']);
export const MEMBER_REQUEST_SOURCES = Object.freeze(['user_id', 'contact', 'invite']);
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
    const source = row.source ?? 'user_id';
    // By contact, who is behind it stays hidden until they accept (consent slice (a)),
    // and a decline looks like a request still waiting until it would have expired.
    const byContact = source !== 'user_id';
    const masked = maskedDecline(row);
    const accepted = row.status === 'accepted';
    return {
      id: row.id, kind: row.kind, source,
      status: row.status === 'pending' || masked ? 'pending_member_acceptance' : row.status,
      organizationId: row.organizationId ?? null, corporateId: row.corporateId ?? null, employeeId: row.employeeId ?? null,
      userId: byContact && !accepted ? null : (row.userId ?? null),
      displayName: accepted ? (names.get(row.userId) ?? null) : null,
      contactType: source === 'contact' ? (row.contactType ?? null) : null,
      contact: source === 'contact' ? (row.contactValue ?? null) : null,
      role: d.role ?? null, permissions: d.permissions ?? null,
      beneficiaryType: d.beneficiaryType ?? null, groupName: d.groupName ?? null, externalReference: d.externalReference ?? null,
      beneficiaryStatus: d.beneficiaryStatus ?? null,
      expiresAt: row.expiresAt, createdAt: row.createdAt,
      decidedAt: masked ? null : (row.decidedAt ?? null), reason: masked ? null : (row.reason ?? null),
    };
  }

  /** A member's decline of a request by contact, shown to the organisation as still waiting until it would have expired. */
  function maskedDecline(row) {
    return row.source === 'contact' && row.status === 'declined' && !row.reason && new Date(row.expiresAt) > stamp();
  }
  /** What the organisation sees as waiting: open requests, and masked declines (see maskedDecline). */
  const visibleOpen = (q, at = stamp()) => q
    .where(b => b.where({ status: 'pending' }).orWhere(m => m.where({ status: 'declined', source: 'contact' }).whereNull('reason')))
    .where('expiresAt', '>', at);

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
      id: row.id, kind: row.kind, status: row.status, source: row.source ?? 'user_id',
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
  async function expireDue({ userId = null, scopeId = null, ids = null, limit = 500 } = {}) {
    const at = stamp();
    let q = db(TABLE).where({ status: 'pending' }).where('expiresAt', '<=', at);
    if (userId) q = q.where({ userId });
    if (scopeId) q = q.where({ scopeId });
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

  /** Hourly rate per requester (durable, all servers). */
  async function rateRefusal(requestedBy, at) {
    const [{ c: lastHour }] = await db(TABLE).where({ requestedBy }).where('createdAt', '>', new Date(+at - HOUR_MS)).count({ c: '*' });
    if (Number(lastHour) < ratePerHour()) return null;
    const [{ first }] = await db(TABLE).where({ requestedBy }).where('createdAt', '>', new Date(+at - HOUR_MS)).min({ first: 'createdAt' });
    return fail('rate_limited', 429, { retryAfterSeconds: Math.max(1, Math.ceil((+new Date(first) + HOUR_MS - +at) / 1000)) });
  }

  /** Until when this organisation / company may not ask this member again (a decline, or it withdrew), or null. */
  async function cooldownUntil({ scopeId, userId }, at) {
    const days = cooldownDays();
    if (days <= 0 || !userId) return null;
    const recent = await db(TABLE).where({ scopeId, userId }).where('decidedAt', '>', new Date(+at - days * DAY_MS))
      .where(b => b.where({ status: 'declined' }).orWhere({ status: 'cancelled', reason: 'cancelled_by_organization' }))
      .max({ last: 'decidedAt' }).first();
    return recent?.last ? new Date(+new Date(recent.last) + days * DAY_MS) : null;
  }

  /** Open requests of one organisation / company at their cap? (Masked declines count, as the organisation sees them.) */
  async function capRefusal(scopeId, at) {
    const [{ c: open }] = await visibleOpen(db(TABLE).where({ scopeId }), at).count({ c: '*' });
    return Number(open) >= maxPending() ? fail('member_request_limit', 429, { maxPending: maxPending() }) : null;
  }

  /** The checks before a request by user id is stored: hourly rate, cooldown, open cap. */
  async function refuseNew({ scopeId, userId, requestedBy }) {
    const at = stamp();
    const rate = await rateRefusal(requestedBy, at);
    if (rate) return rate;
    const until = await cooldownUntil({ scopeId, userId }, at);
    if (until) return fail('member_request_cooldown', 429, { retryAfter: until.toISOString(), retryAfterSeconds: Math.max(1, Math.ceil((+until - +at) / 1000)) });
    return capRefusal(scopeId, at);
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
    if (employeeId) await expireDue({ scopeId });
    // Open by user id for this member (requests by contact or invite are separate, so an id can't be matched to a contact this way), or any open link for this staff record.
    const openQuery = () => db(TABLE).where({ status: 'pending' })
      .where(b => { b.where({ kind, scopeId, userId, source: 'user_id' }); if (employeeId) b.orWhere({ kind: 'employee_link', employeeId }); });
    const open = await openQuery().first();
    if (open) return fail('member_request_pending', 409, open.source === 'user_id' ? { memberRequestId: open.id, expiresAt: open.expiresAt } : {});
    // A staff record whose request by contact was declined still shows as waiting (masked): the same 409.
    if (employeeId && await visibleOpen(db(TABLE).where({ kind: 'employee_link', employeeId })).first('id')) return fail('member_request_pending', 409);
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
      const raced = await openQuery().first();
      return fail('member_request_pending', 409, raced?.source === 'user_id' ? { memberRequestId: raced.id, expiresAt: raced.expiresAt } : {});
    }
    await audit(requestedBy, 'b2b.member_request.create', row.id, { kind, organizationId, corporateId, employeeId, userId, details });
    const saved = await db(TABLE).where({ id: row.id }).first();
    await tell(saved).catch(() => null);
    return { outcome: 'pending_member_acceptance', memberRequest: orgView(saved, await displayNames([userId])) };
  }

  /**
   * Called by b2bService / corporateService instead of adding someone named by
   * an email address or mobile number (consent slice (a)). `contact` is
   * readContact's { type, value }; `resolve()` returns the user id of the
   * member who would be asked (verified contact, member account, not already
   * added), or null. The reply is the same whether or not there is one:
   * { outcome: 'pending_member_acceptance', memberRequest } with userId null
   * and a real id (every add by contact is stored). Refusals here never depend
   * on the person: 429 rate_limited / member_request_limit, and for a staff
   * record that already has an open link request, 409 member_request_pending.
   */
  async function createByContact({ kind, organizationId = null, corporateId = null, employeeId = null, contact, requestedBy, requestedByType, details = {}, resolve = async () => null }) {
    if (!MEMBER_REQUEST_KINDS.includes(kind)) throw new Error(`unknown member request kind ${kind}`);
    if (!requestedBy) return fail('actor_required', 403);
    const scopeId = kind === 'employee_link' ? corporateId : organizationId;
    if (!scopeId || !contact?.type || !contact?.value) throw new Error('member request by contact needs a scope and a contact');
    const limited = attempt(requestedBy);
    if (limited) return limited;
    await expireDue({ scopeId });
    const at = stamp();

    // The same contact asked already and still showing as waiting: the same answer again.
    const sameContact = () => visibleOpen(db(TABLE).where({ kind, scopeId, source: 'contact', contactType: contact.type, contactValue: contact.value }), at)
      .where(b => (employeeId ? b.where({ employeeId }) : b.whereNull('employeeId'))).orderBy('createdAt', 'desc').first();
    const same = await sameContact();
    if (same) return { outcome: 'pending_member_acceptance', memberRequest: orgView(same) };
    // Any link request this staff record shows as waiting (a masked decline too, so a decline can't be told from nobody).
    const openForEmployee = () => (employeeId ? visibleOpen(db(TABLE).where({ kind: 'employee_link', employeeId }), at).first() : null);
    if (await openForEmployee()) return fail('member_request_pending', 409);
    const rate = await rateRefusal(requestedBy, at);
    if (rate) return rate;
    const cap = await capRefusal(scopeId, at);
    if (cap) return cap;

    // Who would be asked. Nobody (or someone who may not be asked again yet, or
    // has a request from this organisation open): stored without a member.
    let userId = (await resolve()) || null;
    let unmatched = userId ? null : 'no_member';
    if (userId) {
      await expireDue({ userId });
      if (await cooldownUntil({ scopeId, userId }, at)) unmatched = 'cooldown';
      else if (await db(TABLE).where({ kind, scopeId, userId, status: 'pending' }).first('id')) unmatched = 'already_asked';
      if (unmatched) userId = null;
    }
    const row = {
      id: newId(), kind, scopeId, organizationId, corporateId, employeeId, userId, requestedBy, requestedByType: requestedByType || 'member',
      source: 'contact', contactType: contact.type, contactValue: contact.value,
      details: JSON.stringify({ ...details, ...(unmatched ? { unmatched } : {}) }),
      status: 'pending', expiresAt: new Date(+at + ttlDays() * DAY_MS), createdAt: at, updatedAt: at,
    };
    try {
      await db(TABLE).insert(row);
    } catch (err) {
      if (err.code !== '23505') throw err;
      const raced = await sameContact();
      if (raced) return { outcome: 'pending_member_acceptance', memberRequest: orgView(raced) };
      if (await openForEmployee()) return fail('member_request_pending', 409);
      throw err;
    }
    await audit(requestedBy, 'b2b.member_request.create', row.id, {
      kind, source: 'contact', organizationId, corporateId, employeeId, userId, contactType: contact.type, unmatched, details,
    });
    const saved = await db(TABLE).where({ id: row.id }).first();
    if (userId) await tell(saved).catch(() => null);
    return { outcome: 'pending_member_acceptance', memberRequest: orgView(saved) };
  }

  /**
   * An invite (B2BBeneficiaryInvite) matched a member's verified email or
   * number: ask them (consent slice (a)) instead of enrolling them. Asked by
   * FitFlex on the organisation's behalf (requestedByType 'system'); the
   * organisation is checked again on accept. Never shown to the organisation
   * as a request: its invite simply stays invited until the member accepts.
   * Returns { memberRequest } or { skipped: 'already_asked' | 'cooldown' | 'limit' }.
   */
  async function createFromInvite({ invite, userId }) {
    const scopeId = invite.organizationId;
    if (!scopeId || !userId) throw new Error('member request from invite needs an organisation and a user');
    await expireDue({ userId });
    const at = stamp();
    const open = await db(TABLE).where({ kind: 'beneficiary', scopeId, userId, status: 'pending' }).first('id');
    if (open) return { skipped: 'already_asked', memberRequestId: open.id };
    if (await cooldownUntil({ scopeId, userId }, at)) {
      const last = await db(TABLE).where({ kind: 'beneficiary', scopeId, userId }).whereIn('status', ['declined', 'cancelled']).orderBy('decidedAt', 'desc').first('id');
      return { skipped: 'cooldown', memberRequestId: last?.id ?? null };
    }
    if (await capRefusal(scopeId, at)) return { skipped: 'limit' };
    const details = {
      beneficiaryType: invite.beneficiaryType ?? 'member', groupName: invite.groupName ?? null, externalReference: invite.externalReference ?? null,
      beneficiaryStatus: 'active', invitedBy: invite.invitedBy ?? null,
    };
    const row = {
      id: newId(), kind: 'beneficiary', scopeId, organizationId: scopeId, corporateId: null, employeeId: null, userId,
      requestedBy: INVITE_REQUESTER, requestedByType: 'system',
      source: 'invite', inviteId: invite.id, contactType: invite.email ? 'email' : 'phone', contactValue: invite.email ?? invite.phone,
      details: JSON.stringify(details), status: 'pending', expiresAt: new Date(+at + ttlDays() * DAY_MS), createdAt: at, updatedAt: at,
    };
    try {
      await db(TABLE).insert(row);
    } catch (err) {
      if (err.code === '23505') return { skipped: 'already_asked' };
      throw err;
    }
    await audit(INVITE_REQUESTER, 'b2b.member_request.create', row.id, { kind: 'beneficiary', source: 'invite', inviteId: invite.id, organizationId: scopeId, userId, details });
    const saved = await db(TABLE).where({ id: row.id }).first();
    await tell(saved).catch(() => null);
    return { memberRequest: saved };
  }

  /** Withdraw a request made from an invite (the organisation cancelled the invite). */
  async function cancelForInvite({ inviteId, actorId }) {
    const rows = await db(TABLE).where({ inviteId, source: 'invite', status: 'pending' });
    for (const r of rows) await closeByOrg(r, actorId);
    return { cancelled: rows.length };
  }

  /** Is the request this invite made still open? (So "send again" can ask once more once it is not.) */
  async function inviteRequestOpen(memberRequestId) {
    if (!memberRequestId) return false;
    const row = await db(TABLE).where({ id: memberRequestId }).first('status', 'expiresAt');
    return Boolean(row && row.status === 'pending' && new Date(row.expiresAt) > stamp());
  }

  /** Requests an organisation made that it sees as waiting, of one kind (org lists show them as pending). Never invite matches. */
  async function pendingForOrganization({ organizationId, kind }) {
    const rows = await visibleOpen(db(TABLE).where({ organizationId, kind }).whereNot({ source: 'invite' })).orderBy('createdAt', 'desc');
    const names = await displayNames(rows.map(r => r.userId).filter(Boolean));
    return rows.map(r => orgView(r, names));
  }

  /** Staff-link requests of a company it sees as waiting, by employee id (the open one wins over a masked decline). */
  async function pendingForCorporate({ corporateId }) {
    const rows = await visibleOpen(db(TABLE).where({ corporateId, kind: 'employee_link' })).orderBy('createdAt', 'asc');
    const names = await displayNames(rows.map(r => r.userId).filter(Boolean));
    const out = new Map();
    for (const r of rows) if (r.status === 'pending' || !out.has(r.employeeId)) out.set(r.employeeId, orgView(r, names));
    return out;
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
    const row = await db(TABLE).where({ id: String(requestId ?? '') }).first();
    // Invite matches are the invite's (cancel the invite instead).
    if (!row || row.kind === 'employee_link' || row.source === 'invite' || row.organizationId !== access.org.id) return fail('member_request_not_found', 404);
    const permission = row.kind === 'org_user' ? 'users.manage' : 'beneficiaries.manage';
    if (!access.platformAdmin && !access.permissions.includes(permission)) return fail('forbidden', 403, { requiredPermission: permission });
    // A decline the organisation still sees as waiting: withdrawn, as far as it can tell (the decline and its cooldown stay).
    if (maskedDecline(row)) {
      const at = stamp();
      await hideDecline(row, actorId, at);
      return { memberRequest: orgView({ ...row, status: 'cancelled', reason: 'cancelled_by_organization', decidedAt: at }) };
    }
    if (row.status !== 'pending') return fail('member_request_not_pending', 409, { requestStatus: row.status });
    const closed = await closeByOrg(row, actorId);
    if (!closed) return fail('member_request_not_pending', 409);
    return { memberRequest: orgView(closed, await displayNames([row.userId].filter(Boolean))) };
  }

  async function hideDecline(row, actorId, at = stamp()) {
    await db(TABLE).where({ id: row.id, status: 'declined' }).whereNull('reason').update({ reason: 'hidden_by_organization', updatedAt: at });
    await audit(actorId, 'b2b.member_request.cancel', row.id, { kind: row.kind, organizationId: row.organizationId, corporateId: row.corporateId, afterDecline: true });
  }

  /** HR unlinked the staff record (or linked it otherwise): its open link request goes. */
  async function cancelForEmployee({ corporateId, employeeId, actorId }) {
    const rows = await db(TABLE).where({ corporateId, employeeId, kind: 'employee_link', status: 'pending' });
    for (const r of rows) await closeByOrg(r, actorId);
    const declined = await visibleOpen(db(TABLE).where({ corporateId, employeeId, kind: 'employee_link', status: 'declined' }));
    for (const r of declined) await hideDecline(r, actorId);
    return { cancelled: rows.length + declined.length };
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

  /** Open invites this request answers: the one that matched, and others of the organisation linked to it by matching. */
  const invitesOf = row => db('B2BBeneficiaryInvite').where({ organizationId: row.organizationId, status: 'invited' })
    .where(b => { b.where({ memberRequestId: row.id }); if (row.inviteId) b.orWhere({ id: row.inviteId }); });

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
    // An invite match is asked by FitFlex for the organisation that invited (its status is checked by the add itself).
    const system = row.requestedByType === 'system';
    const access = await b2bService.resolveAccess({ organizationId: row.organizationId, userId: row.requestedBy, userType: system ? 'admin' : row.requestedByType });
    if (access.error) return fail('request_no_longer_valid', 409, { reason: access.error });
    if (row.kind === 'org_user') {
      const out = await b2bService.addOrganizationUser({ access, actorId: row.requestedBy, body: { userId: row.userId, role: d.role, permissions: d.permissions ?? [] } }, { memberRequestId: row.id });
      if (out.error) return LOST_ACCESS.has(out.error) ? fail('request_no_longer_valid', 409, { reason: out.error }) : out;
      return { resultId: out.organizationUser.id, result: { organizationUser: out.organizationUser } };
    }
    const body = { userId: row.userId, status: d.beneficiaryStatus ?? 'pending', beneficiaryType: d.beneficiaryType, groupName: d.groupName, externalReference: d.externalReference };
    let out = await b2bService.enrollBeneficiary({ access, actorId: row.requestedBy, body }, { memberRequestId: row.id });
    // From an invite: the reference went to someone else meanwhile; enrol without it rather than leave the person out (as invite matching did).
    if (out.error === 'external_reference_in_use' && row.source === 'invite') {
      out = await b2bService.enrollBeneficiary({ access, actorId: row.requestedBy, body: { ...body, externalReference: null } }, { memberRequestId: row.id });
    }
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
    if (row.kind === 'beneficiary') {
      // The invites this request answers are done: the organisation now sees the person enrolled.
      const at2 = stamp();
      await invitesOf(row).update({ status: 'enrolled', enrolledAt: at2, beneficiaryId: out.resultId, nextEmailAt: null, nextSmsAt: null, updatedAt: at2 });
    }
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
    // From an invite: no more invitation reminders to someone who said no (the invite itself stays as the organisation sees it).
    if (row.kind === 'beneficiary') await invitesOf(row).update({ nextEmailAt: null, nextSmsAt: null, updatedAt: at });
    await audit(userId, 'b2b.member_request.decline', row.id, { kind: row.kind, organizationId: row.organizationId, corporateId: row.corporateId, employeeId: row.employeeId });
    return { memberRequest: await memberView(closed) };
  }

  return {
    attempt, stub, adminAdded,
    create, createByContact, createFromInvite, cancelForInvite, inviteRequestOpen,
    pendingForOrganization, pendingForCorporate, cancel, cancelForEmployee,
    listForMember, accept, decline, expireDue,
  };
}
