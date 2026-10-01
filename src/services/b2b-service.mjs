// B2B Foundation V1 — organisations, organisation users and beneficiaries.
// Pure DI: receives store collections via the factory.
//
// Corporate compatibility: a CorporateAccount is represented by one employer
// organisation (B2BOrganization.legacyCorporateId). For such an organisation
// Corporate stays the source of truth — name, sector, contact and status are
// read from CorporateAccount, registration/TIN and KYB from its
// PartnerKycCase, its HR logins appear as `hr` users and its CorporateEmployee
// rows appear as `employee` beneficiaries. Those read-through rows are
// read-only here; they change through the existing corporate routes, so seat
// limits and billing can't be bypassed.
import { createHash, randomUUID } from 'node:crypto';
import {
  ORGANIZATION_TYPES, ORGANIZATION_TRANSITIONS, ORGANIZATION_USER_ROLES, ORGANIZATION_USER_STATUS,
  BENEFICIARY_TYPES, BENEFICIARY_TRANSITIONS, PERMISSIONS, READ_PERMISSIONS, effectivePermissions,
  CORPORATE_TO_ORGANIZATION_STATUS, EMPLOYEE_TO_BENEFICIARY_STATUS,
} from '../shared/b2b.mjs';
import { INDUSTRY_SECTORS } from '../shared/corporate-constants.mjs';
import { normalizeIdentifier } from '../shared/partner-kyc.mjs';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'region', 'country', 'postalCode'];
// Fields Corporate owns for a mapped organisation.
const CORPORATE_MANAGED_FIELDS = Object.freeze([
  'organizationType', 'legalName', 'industrySector', 'email', 'phone', 'status',
  'registrationNumber', 'taxIdentificationNumber',
]);

/** Deterministic organisation id for a CorporateAccount (matches the backfill migration). */
export function corporateOrganizationId(corporateId) {
  return `b2bo_${createHash('md5').update(`corporate:${corporateId}`).digest('hex').slice(0, 12)}`;
}

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const text = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Offset pagination, same shape as member-management-service. */
function page(rows, query = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
  const total = rows.length;
  return { items: rows.slice(offset, offset + limit), total, nextCursor: offset + limit < total ? offset + limit : null };
}

export function createB2BService({
  users, corporateAccounts, corporateEmployees, partnerKycCases,
  organizations, organizationUsers, beneficiaries, auditLog,
  now = () => new Date(),
}) {
  const stamp = () => now().toISOString();

  async function audit({ actor, action, target, before = null, after = null }) {
    await auditLog.insertAsync({
      id: `aud_${randomUUID().slice(0, 8)}`, at: stamp(), actor, action, target, before, after,
    });
  }

  function reference() {
    return {
      organizationTypes: ORGANIZATION_TYPES,
      organizationStatuses: ORGANIZATION_TRANSITIONS,
      organizationUserRoles: ORGANIZATION_USER_ROLES,
      organizationUserStatuses: ORGANIZATION_USER_STATUS,
      permissions: PERMISSIONS,
      beneficiaryTypes: BENEFICIARY_TYPES,
      beneficiaryStatuses: BENEFICIARY_TRANSITIONS,
      industrySectors: INDUSTRY_SECTORS,
    };
  }

  // ── Organisation views ────────────────────────────────────────────────────

  /** Stored rows → API views, with Corporate and KYB fields read through for mapped rows. */
  async function present(rows) {
    const legacyIds = rows.map(o => o.legacyCorporateId).filter(Boolean);
    const [accounts, cases] = legacyIds.length
      ? await Promise.all([
        corporateAccounts.filterByColumnInAsync('id', legacyIds),
        partnerKycCases.filterByColumnInAsync('corporateId', legacyIds),
      ])
      : [[], []];
    const accountById = new Map(accounts.map(a => [a.id, a]));
    const caseByCorporate = new Map(cases.map(c => [c.corporateId, c]));

    return rows.map((org) => {
      if (!org.legacyCorporateId) {
        return { ...org, source: 'b2b', managedFields: [], kyc: { supported: false, caseId: null, status: null } };
      }
      const account = accountById.get(org.legacyCorporateId);
      const kycCase = caseByCorporate.get(org.legacyCorporateId);
      const view = {
        ...org,
        source: 'corporate',
        managedFields: CORPORATE_MANAGED_FIELDS,
        kyc: { supported: true, caseId: kycCase?.id ?? null, status: kycCase?.status ?? 'not_started' },
      };
      if (account) {
        Object.assign(view, {
          organizationType: 'employer',
          legalName: account.companyName,
          industrySector: account.industrySector,
          email: account.hrContactEmail ?? null,
          phone: account.hrContactPhone ?? null,
          status: CORPORATE_TO_ORGANIZATION_STATUS[account.status] ?? 'pending',
        });
      }
      if (kycCase) {
        view.registrationNumber = kycCase.registrationNumber ?? null;
        view.taxIdentificationNumber = kycCase.tin ?? null;
      }
      return view;
    });
  }

  const presentOne = async org => (await present([org]))[0];

  /**
   * Validate an organisation profile. Returns { patch } or an error.
   * `create` makes type and legal name required.
   */
  function readProfile(body, { create = false } = {}) {
    const patch = {};
    if (create || body.organizationType !== undefined) {
      if (!ORGANIZATION_TYPES[body.organizationType]) return fail('invalid_organization_type', 400, { allowed: Object.keys(ORGANIZATION_TYPES) });
      patch.organizationType = body.organizationType;
    }
    if (create || body.legalName !== undefined) {
      const legalName = text(body.legalName);
      if (!legalName) return fail('legal_name_required', 400);
      patch.legalName = legalName;
    }
    if (body.tradingName !== undefined) patch.tradingName = text(body.tradingName);
    if (body.industrySector !== undefined) {
      if (body.industrySector !== null && body.industrySector !== '' && !INDUSTRY_SECTORS[body.industrySector]) {
        return fail('invalid_industry_sector', 400);
      }
      patch.industrySector = body.industrySector || null;
    }
    if (body.registrationNumber !== undefined) patch.registrationNumber = normalizeIdentifier(body.registrationNumber);
    if (body.taxIdentificationNumber !== undefined) patch.taxIdentificationNumber = normalizeIdentifier(body.taxIdentificationNumber);
    if (body.email !== undefined) {
      const email = normalizeEmail(body.email);
      if (email && !EMAIL_RE.test(email)) return fail('invalid_email', 400);
      patch.email = email;
    }
    if (body.phone !== undefined) {
      if (body.phone === null || String(body.phone).trim() === '') patch.phone = null;
      else {
        const phone = normalizePhone(body.phone);
        if (!phone) return fail('invalid_phone', 400);
        patch.phone = phone;
      }
    }
    if (body.address !== undefined) {
      if (body.address !== null && (typeof body.address !== 'object' || Array.isArray(body.address))) return fail('invalid_address', 400);
      const address = body.address
        ? Object.fromEntries(ADDRESS_FIELDS.map(k => [k, text(body.address[k])]).filter(([, v]) => v))
        : null;
      patch.address = address && Object.keys(address).length ? address : null;
    }
    return { patch };
  }

  /** Another organisation already holds this registration or tax number? */
  async function registryClash(patch, selfId = null) {
    for (const field of ['registrationNumber', 'taxIdentificationNumber']) {
      if (!patch[field]) continue;
      const other = (await organizations.filterByColumnAsync(field, patch[field])).find(o => o.id !== selfId);
      if (other) return fail(field === 'registrationNumber' ? 'registration_number_in_use' : 'tax_number_in_use', 409);
    }
    return null;
  }

  // ── Organisation lifecycle ────────────────────────────────────────────────

  async function createOrganization({ body = {}, actorId }) {
    const read = readProfile(body, { create: true });
    if (read.error) return read;
    const clash = await registryClash(read.patch);
    if (clash) return clash;

    const at = stamp();
    const row = {
      id: `b2bo_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      tradingName: null, industrySector: null, registrationNumber: null, taxIdentificationNumber: null,
      email: null, phone: null, address: null,
      ...read.patch,
      status: 'pending', statusReason: null, statusChangedAt: at,
      legacyCorporateId: null, createdBy: actorId ?? null, createdAt: at, updatedAt: at,
    };
    try {
      await organizations.insertAsync(row);
    } catch (err) {
      if (err.code === '23505') return fail('organization_exists', 409);
      throw err;
    }
    await audit({ actor: actorId, action: 'b2b.organization.create', target: row.id, after: row });
    return { organization: await presentOne(row) };
  }

  async function getOrganization({ organizationId }) {
    const org = await organizations.findByIdAsync(organizationId);
    if (!org) return fail('organization_not_found', 404);
    return { organization: await presentOne(org) };
  }

  async function listOrganizations({ query = {} } = {}) {
    const needle = text(query.search)?.toLowerCase();
    const views = (await present(await organizations.allAsync()))
      .filter(o => (query.type ? o.organizationType === query.type : true))
      .filter(o => (query.status ? o.status === query.status : true))
      .filter(o => (needle
        ? [o.legalName, o.tradingName, o.registrationNumber].some(v => v?.toLowerCase().includes(needle))
        : true))
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
    return page(views, query);
  }

  /** Profile edit. Only FitFlex admins may change an organisation's type. */
  async function updateOrganization({ organizationId, body = {}, actorId, platformAdmin = false }) {
    const org = await organizations.findByIdAsync(organizationId);
    if (!org) return fail('organization_not_found', 404);
    if (body.status !== undefined) return fail('use_status_endpoint', 400);
    if (org.legacyCorporateId) {
      const fields = CORPORATE_MANAGED_FIELDS.filter(f => body[f] !== undefined);
      if (fields.length) return fail('managed_by_corporate', 409, { fields, corporateId: org.legacyCorporateId });
    }
    if (body.organizationType !== undefined && body.organizationType !== org.organizationType && !platformAdmin) {
      return fail('forbidden', 403, { requiredRole: 'platform_admin' });
    }
    const read = readProfile(body);
    if (read.error) return read;
    const clash = await registryClash(read.patch, org.id);
    if (clash) return clash;

    let updated;
    try {
      updated = await organizations.updateByIdAsync(org.id, { ...read.patch, updatedAt: stamp() });
    } catch (err) {
      if (err.code === '23505') return fail('organization_exists', 409);
      throw err;
    }
    await audit({ actor: actorId, action: 'b2b.organization.update', target: org.id, before: org, after: updated });
    return { organization: await presentOne(updated) };
  }

  async function setOrganizationStatus({ organizationId, status, reason, actorId }) {
    if (!ORGANIZATION_TRANSITIONS[status]) return fail('invalid_status', 400, { allowed: Object.keys(ORGANIZATION_TRANSITIONS) });
    const org = await organizations.findByIdAsync(organizationId);
    if (!org) return fail('organization_not_found', 404);
    if (org.legacyCorporateId) return fail('managed_by_corporate', 409, { fields: ['status'], corporateId: org.legacyCorporateId });
    if (org.status === status) return { organization: await presentOne(org), unchanged: true };
    const allowed = ORGANIZATION_TRANSITIONS[org.status] || [];
    if (!allowed.includes(status)) return fail('invalid_transition', 409, { from: org.status, to: status, allowed });

    const at = stamp();
    const updated = await organizations.updateByIdAsync(org.id, {
      status, statusReason: text(reason, 500), statusChangedAt: at, updatedAt: at,
    });
    await audit({ actor: actorId, action: `b2b.organization.${status}`, target: org.id, before: org, after: updated });
    return { organization: await presentOne(updated) };
  }

  // ── Corporate compatibility ───────────────────────────────────────────────

  /** The employer organisation for a CorporateAccount, creating it if missing. Idempotent. */
  async function ensureOrganizationForCorporate({ corporateId, actorId = 'system:b2b-corporate-sync' }) {
    const existing = (await organizations.filterByColumnAsync('legacyCorporateId', corporateId))[0];
    if (existing) return { organization: existing, created: false };
    const account = await corporateAccounts.findByIdAsync(corporateId);
    if (!account) return fail('corporate_not_found', 404);

    const at = stamp();
    const row = {
      id: corporateOrganizationId(corporateId),
      organizationType: 'employer',
      legalName: account.companyName,
      tradingName: null,
      industrySector: account.industrySector ?? null,
      registrationNumber: null,
      taxIdentificationNumber: null,
      email: account.hrContactEmail ?? null,
      phone: account.hrContactPhone ?? null,
      address: null,
      status: CORPORATE_TO_ORGANIZATION_STATUS[account.status] ?? 'pending',
      statusReason: null,
      statusChangedAt: at,
      legacyCorporateId: corporateId,
      createdBy: actorId,
      createdAt: at,
      updatedAt: at,
    };
    try {
      await organizations.insertAsync(row);
    } catch (err) {
      // Created concurrently (or by the backfill): return the winner.
      if (err.code !== '23505') throw err;
      const winner = (await organizations.filterByColumnAsync('legacyCorporateId', corporateId))[0];
      if (winner) return { organization: winner, created: false };
      throw err;
    }
    await audit({ actor: actorId, action: 'b2b.organization.map_corporate', target: row.id, after: row });
    return { organization: row, created: true };
  }

  /** Map every CorporateAccount that has no organisation yet. Safe to run repeatedly. */
  async function syncCorporateOrganizations({ actorId }) {
    let created = 0;
    let existing = 0;
    for (const account of await corporateAccounts.allAsync()) {
      const result = await ensureOrganizationForCorporate({ corporateId: account.id, actorId });
      if (result.error) continue;
      if (result.created) created += 1; else existing += 1;
    }
    return { created, existing };
  }

  /** Which organisation represents this CorporateAccount (null when not mapped yet)? */
  async function organizationForCorporate({ corporateId }) {
    const org = (await organizations.filterByColumnAsync('legacyCorporateId', corporateId))[0];
    return { organization: org ? await presentOne(org) : null };
  }

  // ── Access ────────────────────────────────────────────────────────────────

  /**
   * What the caller may do in an organisation. FitFlex admins (already past
   * requireAcl('b2b')) may do everything; anyone else needs an active
   * B2BOrganizationUser row — or, for a mapped organisation, to be one of the
   * company's active HR logins (role `hr`). Non-members get 404, so an
   * organisation's existence isn't revealed.
   */
  async function resolveAccess({ organizationId, userId, userType }) {
    const org = await organizations.findByIdAsync(organizationId);
    if (!org) return fail('organization_not_found', 404);
    const view = await presentOne(org);
    if (userType === 'admin') {
      return { org: view, platformAdmin: true, role: 'platform_admin', permissions: [...PERMISSIONS] };
    }

    let role = null;
    let grants = [];
    let orgUserId = null;
    const membership = (await organizationUsers.filterByColumnAsync('userId', userId))
      .find(m => m.organizationId === org.id && m.status === 'active');
    if (membership) {
      ({ role } = membership);
      grants = membership.permissions || [];
      orgUserId = membership.id;
    } else if (org.legacyCorporateId && userType === 'corporate_hr') {
      const user = await users.findByIdAsync(userId);
      if (user?.corporateId === org.legacyCorporateId && (user.accountStatus ?? 'active') === 'active') role = 'hr';
    }
    if (!role) return fail('organization_not_found', 404);

    let permissions = effectivePermissions(role, grants);
    if (view.status === 'pending') permissions = permissions.filter(p => READ_PERMISSIONS.includes(p));
    else if (view.status !== 'active') return fail('organization_not_active', 403, { organizationStatus: view.status });
    return { org: view, platformAdmin: false, role, orgUserId, permissions };
  }

  const can = (access, permission) => access.permissions.includes(permission);
  const forbidden = permission => fail('forbidden', 403, { requiredPermission: permission });

  /** Organisations the caller belongs to (native memberships and corporate HR). */
  async function listMyOrganizations({ userId, userType }) {
    const memberships = (await organizationUsers.filterByColumnAsync('userId', userId)).filter(m => m.status === 'active');
    const orgIds = new Set(memberships.map(m => m.organizationId));
    const rows = orgIds.size ? await organizations.filterByColumnInAsync('id', [...orgIds]) : [];
    if (userType === 'corporate_hr') {
      const user = await users.findByIdAsync(userId);
      if (user?.corporateId && (user.accountStatus ?? 'active') === 'active') {
        const mapped = (await organizations.filterByColumnAsync('legacyCorporateId', user.corporateId))[0];
        if (mapped && !orgIds.has(mapped.id)) rows.push(mapped);
      }
    }
    const roleOf = new Map(memberships.map(m => [m.organizationId, m.role]));
    return {
      organizations: (await present(rows))
        .filter(o => o.status === 'active' || o.status === 'pending')
        .map(o => ({ ...o, role: roleOf.get(o.id) ?? 'hr' })),
    };
  }

  // ── Organisation users ────────────────────────────────────────────────────

  const userSummary = u => (u ? { displayName: u.displayName ?? null, email: u.email ?? null, userType: u.userType } : null);

  async function listOrganizationUsers({ access, query = {} }) {
    if (!can(access, 'users.read')) return forbidden('users.read');
    const rows = (await organizationUsers.filterByColumnAsync('organizationId', access.org.id))
      .filter(r => (query.status ? r.status === query.status : r.status !== 'removed'));
    const people = rows.length ? await users.filterByColumnInAsync('id', rows.map(r => r.userId)) : [];
    const byId = new Map(people.map(u => [u.id, u]));
    const views = rows.map(r => ({ ...r, source: 'b2b', readOnly: false, user: userSummary(byId.get(r.userId)) }));

    // A mapped company's HR logins, read through from User (managed in /admin/corporate).
    if (access.org.legacyCorporateId && query.status !== 'removed') {
      const hr = (await users.filterByColumnAsync('corporateId', access.org.legacyCorporateId))
        .filter(u => u.userType === 'corporate_hr')
        .map(u => ({
          id: u.id, organizationId: access.org.id, userId: u.id, role: 'hr', permissions: [],
          status: (u.accountStatus ?? 'active') === 'active' ? 'active' : 'suspended',
          createdAt: u.createdAt, updatedAt: u.updatedAt,
          source: 'corporate_hr', readOnly: true, user: userSummary(u),
        }))
        .filter(v => (query.status ? v.status === query.status : true));
      views.push(...hr);
    }
    views.sort((a, b) => String(a.user?.displayName ?? '').localeCompare(String(b.user?.displayName ?? '')));
    return page(views, query);
  }

  /** Grants an actor may hand out: never more than they hold; owners only by owners. */
  function checkGrant(access, { role, permissions = [] }) {
    if (access.platformAdmin) return null;
    if (role === 'owner' && access.role !== 'owner') return fail('forbidden', 403, { requiredRole: 'owner' });
    const beyond = effectivePermissions(role, permissions).filter(p => !access.permissions.includes(p));
    if (beyond.length) return fail('cannot_grant_permissions', 403, { permissions: beyond });
    return null;
  }

  function readGrants(permissions) {
    if (permissions === undefined) return { permissions: undefined };
    if (!Array.isArray(permissions)) return fail('invalid_permissions', 400);
    const unknown = permissions.filter(p => !PERMISSIONS.includes(p));
    if (unknown.length) return fail('invalid_permissions', 400, { invalid: unknown });
    return { permissions: [...new Set(permissions)] };
  }

  async function addOrganizationUser({ access, body = {}, actorId }) {
    if (!can(access, 'users.manage')) return forbidden('users.manage');
    if (!ORGANIZATION_USER_ROLES.includes(body.role)) return fail('invalid_role', 400, { allowed: ORGANIZATION_USER_ROLES });
    const grants = readGrants(body.permissions);
    if (grants.error) return grants;
    const permissions = grants.permissions ?? [];
    const refused = checkGrant(access, { role: body.role, permissions });
    if (refused) return refused;

    const user = body.userId ? await users.findByIdAsync(body.userId) : null;
    if (!user) return fail('user_not_found', 404);
    const live = (await organizationUsers.filterByColumnAsync('userId', user.id))
      .find(m => m.organizationId === access.org.id && m.status !== 'removed');
    if (live) return fail('already_organization_user', 409, { organizationUserId: live.id });

    const at = stamp();
    const row = {
      id: `b2bu_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      organizationId: access.org.id, userId: user.id, role: body.role, permissions,
      status: 'active', removedAt: null, createdBy: actorId ?? null, createdAt: at, updatedAt: at,
    };
    try {
      await organizationUsers.insertAsync(row);
    } catch (err) {
      if (err.code === '23505') return fail('already_organization_user', 409);
      throw err;
    }
    await audit({ actor: actorId, action: 'b2b.org_user.add', target: row.id, after: row });
    return { organizationUser: { ...row, source: 'b2b', readOnly: false, user: userSummary(user) } };
  }

  /** Change role, status (active | suspended | removed) or extra permissions. */
  async function updateOrganizationUser({ access, organizationUserId, body = {}, actorId }) {
    if (!can(access, 'users.manage')) return forbidden('users.manage');
    const row = await organizationUsers.findByIdAsync(organizationUserId);
    if (!row || row.organizationId !== access.org.id) {
      // A mapped company's HR login is listed here but managed in /admin/corporate.
      if (access.org.legacyCorporateId) {
        const hr = await users.findByIdAsync(organizationUserId);
        if (hr?.userType === 'corporate_hr' && hr.corporateId === access.org.legacyCorporateId) {
          return fail('managed_by_corporate', 409, { corporateId: access.org.legacyCorporateId });
        }
      }
      return fail('organization_user_not_found', 404);
    }
    if (row.status === 'removed') return fail('organization_user_removed', 409);

    const patch = {};
    if (body.role !== undefined) {
      if (!ORGANIZATION_USER_ROLES.includes(body.role)) return fail('invalid_role', 400, { allowed: ORGANIZATION_USER_ROLES });
      patch.role = body.role;
    }
    if (body.status !== undefined) {
      if (!ORGANIZATION_USER_STATUS.includes(body.status)) return fail('invalid_status', 400, { allowed: ORGANIZATION_USER_STATUS });
      patch.status = body.status;
    }
    const grants = readGrants(body.permissions);
    if (grants.error) return grants;
    if (grants.permissions !== undefined) patch.permissions = grants.permissions;
    if (!Object.keys(patch).length) return fail('nothing_to_update', 400);

    if (!access.platformAdmin) {
      // Only an owner touches an owner's seat, and grants stay within the actor's own.
      if (row.role === 'owner' && access.role !== 'owner') return fail('forbidden', 403, { requiredRole: 'owner' });
      const refused = checkGrant(access, { role: patch.role ?? row.role, permissions: patch.permissions ?? row.permissions ?? [] });
      if (refused) return refused;
      // Don't let an organisation lose its last active owner.
      const losesOwner = row.role === 'owner' && row.status === 'active'
        && ((patch.role && patch.role !== 'owner') || (patch.status && patch.status !== 'active'));
      if (losesOwner) {
        const owners = (await organizationUsers.filterByColumnAsync('organizationId', access.org.id))
          .filter(m => m.role === 'owner' && m.status === 'active');
        if (owners.length <= 1) return fail('last_owner', 409);
      }
    }

    const at = stamp();
    if (patch.status === 'removed') patch.removedAt = at;
    const updated = await organizationUsers.updateByIdAsync(row.id, { ...patch, updatedAt: at });
    const action = patch.status && patch.status !== row.status ? `b2b.org_user.${patch.status}` : 'b2b.org_user.update';
    await audit({ actor: actorId, action, target: row.id, before: row, after: updated });
    const user = await users.findByIdAsync(updated.userId);
    return { organizationUser: { ...updated, source: 'b2b', readOnly: false, user: userSummary(user) } };
  }

  const removeOrganizationUser = ({ access, organizationUserId, actorId }) =>
    updateOrganizationUser({ access, organizationUserId, body: { status: 'removed' }, actorId });

  // ── Beneficiaries ─────────────────────────────────────────────────────────

  /** CorporateEmployee → read-only beneficiary view. */
  const employeeView = (e, organizationId) => ({
    id: e.id,
    organizationId,
    userId: e.userId ?? null,
    externalReference: null,
    beneficiaryType: 'employee',
    groupName: e.department ?? null,
    status: EMPLOYEE_TO_BENEFICIARY_STATUS[e.status] ?? 'pending',
    enrolledAt: e.activatedAt ?? null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    displayName: e.displayName,
    source: 'corporate_employee',
    legacyCorporateEmployeeId: e.id,
    readOnly: true,
  });

  async function nativeViews(rows) {
    const ids = rows.map(r => r.userId).filter(Boolean);
    const people = ids.length ? await users.filterByColumnInAsync('id', ids) : [];
    const nameOf = new Map(people.map(u => [u.id, u.displayName ?? null]));
    return rows.map(r => ({ ...r, displayName: nameOf.get(r.userId) ?? null, source: 'b2b', readOnly: false }));
  }

  /** Every beneficiary of an organisation view: native rows plus a mapped company's employees. */
  async function allBeneficiaries(org) {
    const views = await nativeViews(await beneficiaries.filterByColumnAsync('organizationId', org.id));
    if (org.legacyCorporateId) {
      const staff = await corporateEmployees.filterByColumnAsync('corporateId', org.legacyCorporateId);
      views.push(...staff.map(e => employeeView(e, org.id)));
    }
    return views;
  }

  /** A member's beneficiary relationships across organisations (native and corporate), with their organisation views. */
  async function beneficiaryRelationshipsForUser(userId) {
    const native = await beneficiaries.filterByColumnAsync('userId', userId);
    const staff = await corporateEmployees.filterByColumnAsync('userId', userId);
    const mapped = staff.length ? await organizations.filterByColumnInAsync('legacyCorporateId', staff.map(e => e.corporateId)) : [];
    const orgIds = [...new Set([...native.map(b => b.organizationId), ...mapped.map(o => o.id)])];
    const orgs = new Map((await present(orgIds.length ? await organizations.filterByColumnInAsync('id', orgIds) : [])).map(o => [o.id, o]));
    const orgForCorporate = new Map(mapped.map(o => [o.legacyCorporateId, o.id]));
    const out = (await nativeViews(native)).map(b => ({ organization: orgs.get(b.organizationId), beneficiary: b }));
    for (const e of staff) {
      const orgId = orgForCorporate.get(e.corporateId);
      if (orgId) out.push({ organization: orgs.get(orgId), beneficiary: employeeView(e, orgId) });
    }
    return out.filter(r => r.organization);
  }

  async function listBeneficiaries({ access, query = {} }) {
    if (!can(access, 'beneficiaries.read')) return forbidden('beneficiaries.read');
    const views = await allBeneficiaries(access.org);
    const needle = text(query.search)?.toLowerCase();
    const filtered = views
      .filter(b => (query.status ? b.status === query.status : true))
      .filter(b => (query.type ? b.beneficiaryType === query.type : true))
      .filter(b => (query.group ? b.groupName === query.group : true))
      .filter(b => (needle ? [b.displayName, b.externalReference].some(v => v?.toLowerCase().includes(needle)) : true))
      .sort((a, b) => String(a.displayName ?? '').localeCompare(String(b.displayName ?? '')));
    return page(filtered, query);
  }

  /** The beneficiary with this id in the caller's organisation, native or read-through. */
  async function findBeneficiary(access, beneficiaryId) {
    const row = await beneficiaries.findByIdAsync(beneficiaryId);
    if (row) return row.organizationId === access.org.id ? { row } : null;
    if (access.org.legacyCorporateId) {
      const e = await corporateEmployees.findByIdAsync(beneficiaryId);
      if (e && e.corporateId === access.org.legacyCorporateId) return { employee: e };
    }
    return null;
  }

  async function getBeneficiary({ access, beneficiaryId }) {
    if (!can(access, 'beneficiaries.read')) return forbidden('beneficiaries.read');
    const found = await findBeneficiary(access, beneficiaryId);
    if (!found) return fail('beneficiary_not_found', 404);
    return {
      beneficiary: found.employee
        ? employeeView(found.employee, access.org.id)
        : (await nativeViews([found.row]))[0],
    };
  }

  const corporateManaged = access => fail('managed_by_corporate', 409, {
    corporateId: access.org.legacyCorporateId, use: '/corporate/staff',
  });

  async function enrollBeneficiary({ access, body = {}, actorId }) {
    if (!can(access, 'beneficiaries.manage')) return forbidden('beneficiaries.manage');
    // Employer seats are billed and seat-limited by Corporate; enrol there.
    if (access.org.legacyCorporateId) return corporateManaged(access);
    if (access.org.status !== 'active') return fail('organization_not_active', 409, { organizationStatus: access.org.status });

    const beneficiaryType = body.beneficiaryType ?? 'member';
    if (!BENEFICIARY_TYPES[beneficiaryType]) return fail('invalid_beneficiary_type', 400, { allowed: Object.keys(BENEFICIARY_TYPES) });
    const status = body.status ?? 'pending';
    if (!['pending', 'active'].includes(status)) return fail('invalid_status', 400, { allowed: ['pending', 'active'] });

    const user = body.userId ? await users.findByIdAsync(body.userId) : null;
    if (!user) return fail('user_not_found', 404);
    if (user.userType !== 'member') return fail('beneficiary_must_be_member', 400);

    const existing = (await beneficiaries.filterByColumnAsync('userId', user.id)).find(b => b.organizationId === access.org.id);
    if (existing) return fail('already_enrolled', 409, { beneficiaryId: existing.id, beneficiaryStatus: existing.status });
    const externalReference = text(body.externalReference, 100);
    if (externalReference) {
      const taken = (await beneficiaries.filterByColumnAsync('organizationId', access.org.id))
        .some(b => b.externalReference === externalReference);
      if (taken) return fail('external_reference_in_use', 409);
    }

    const at = stamp();
    const row = {
      id: `b2bb_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      organizationId: access.org.id, userId: user.id, externalReference, beneficiaryType,
      groupName: text(body.groupName, 100), status,
      enrolledAt: status === 'active' ? at : null, statusChangedAt: at,
      createdBy: actorId ?? null, createdAt: at, updatedAt: at,
    };
    try {
      await beneficiaries.insertAsync(row);
    } catch (err) {
      if (err.code === '23505') return fail('already_enrolled', 409);
      throw err;
    }
    await audit({ actor: actorId, action: 'b2b.beneficiary.enroll', target: row.id, after: row });
    return { beneficiary: (await nativeViews([row]))[0] };
  }

  async function setBeneficiaryStatus({ access, beneficiaryId, status, actorId }) {
    if (!can(access, 'beneficiaries.manage')) return forbidden('beneficiaries.manage');
    if (!BENEFICIARY_TRANSITIONS[status]) return fail('invalid_status', 400, { allowed: Object.keys(BENEFICIARY_TRANSITIONS) });
    const found = await findBeneficiary(access, beneficiaryId);
    if (!found) return fail('beneficiary_not_found', 404);
    if (found.employee) return corporateManaged(access);

    const { row } = found;
    if (row.status === status) return { beneficiary: (await nativeViews([row]))[0], unchanged: true };
    const allowed = BENEFICIARY_TRANSITIONS[row.status] || [];
    if (!allowed.includes(status)) return fail('invalid_transition', 409, { from: row.status, to: status, allowed });
    if (status === 'active' && access.org.status !== 'active') {
      return fail('organization_not_active', 409, { organizationStatus: access.org.status });
    }

    const at = stamp();
    const patch = { status, statusChangedAt: at, updatedAt: at };
    if (status === 'active' && !row.enrolledAt) patch.enrolledAt = at;
    const updated = await beneficiaries.updateByIdAsync(row.id, patch);
    await audit({ actor: actorId, action: `b2b.beneficiary.${status}`, target: row.id, before: row, after: updated });
    return { beneficiary: (await nativeViews([updated]))[0] };
  }

  const deactivateBeneficiary = ({ access, beneficiaryId, actorId }) =>
    setBeneficiaryStatus({ access, beneficiaryId, status: 'inactive', actorId });

  return {
    reference,
    createOrganization, getOrganization, listOrganizations, updateOrganization, setOrganizationStatus,
    ensureOrganizationForCorporate, syncCorporateOrganizations, organizationForCorporate,
    resolveAccess, listMyOrganizations,
    listOrganizationUsers, addOrganizationUser, updateOrganizationUser, removeOrganizationUser,
    allBeneficiaries, beneficiaryRelationshipsForUser,
    listBeneficiaries, getBeneficiary, enrollBeneficiary, setBeneficiaryStatus, deactivateBeneficiary,
  };
}
