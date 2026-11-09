// Phase B · B5a — company HR logins become organisation users.
//
// Each CorporateAccount is mirrored as an employer B2BOrganization
// (legacyCorporateId). A company HR login (User.userType corporate_hr) has so
// far reached that organisation only by a read-through rule in
// b2b-service.resolveAccess. This turns it into an explicit
// B2BOrganizationUser row with role `hr` on its own company's organisation
// (creating the mirror the same way onboarding does, when it is missing), so
// the login keeps working when the legacy /hr area goes.
//
// Additive and re-runnable: nothing is changed or removed on the User row, the
// corporate_hr login keeps working, an existing live row is left as it is, and
// a row that someone removed on purpose is never brought back. Every row added
// writes an AuditLog entry. Dry run (the default) only says what it would do.
import { randomUUID } from 'node:crypto';

export const HR_CONVERSION_ACTOR = 'system:hr-to-org';
export const HR_CONVERSION_ACTION = 'b2b.org_user.convert_corporate_hr';

/** What can happen to one HR login. */
export const HR_CONVERSION_OUTCOMES = Object.freeze([
  'added',                 // row created (or would be, in a dry run)
  'already_member',        // a live row already exists: nothing to do
  'skipped_removed',       // a row exists but was removed: left alone on purpose
  'skipped_no_company',    // the HR login has no corporateId
  'skipped_company_missing', // its CorporateAccount does not exist
  'skipped_deleted',       // the HR login itself is deleted
]);

export function createHrOrgConversionService({
  users, corporateAccounts, organizations, organizationUsers, auditLog, b2bService, now = () => new Date(),
}) {
  const stamp = () => now().toISOString();

  /** The HR logins to look at, oldest first so output is stable. */
  async function hrLogins({ corporateId = null, userId = null } = {}) {
    const rows = userId
      ? [await users.findByIdAsync(userId)].filter(Boolean)
      : await users.filterByColumnAsync('userType', 'corporate_hr');
    return rows
      .filter(u => u.userType === 'corporate_hr')
      .filter(u => (corporateId ? u.corporateId === corporateId : true))
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id));
  }

  async function convertOne(user, { dryRun, actorId }) {
    const base = { userId: user.id, email: user.email ?? null, corporateId: user.corporateId ?? null };
    if (user.accountStatus === 'deleted') return { ...base, outcome: 'skipped_deleted' };
    if (!user.corporateId) return { ...base, outcome: 'skipped_no_company' };

    let org = (await organizations.filterByColumnAsync('legacyCorporateId', user.corporateId))[0] ?? null;
    let mirrorCreated = false;
    if (!org) {
      // The same mirror onboarding makes; it needs the CorporateAccount.
      if (dryRun) {
        if (!(await corporateAccounts.findByIdAsync(user.corporateId))) return { ...base, outcome: 'skipped_company_missing' };
        return { ...base, outcome: 'added', organizationId: null, organizationUserId: null, mirrorCreated: true };
      }
      const made = await b2bService.ensureOrganizationForCorporate({ corporateId: user.corporateId, actorId });
      if (made.error) return { ...base, outcome: 'skipped_company_missing' };
      org = made.organization;
      mirrorCreated = made.created === true;
    }

    const rows = (await organizationUsers.filterByColumnAsync('userId', user.id)).filter(r => r.organizationId === org.id);
    const live = rows.find(r => r.status !== 'removed');
    if (live) return { ...base, outcome: 'already_member', organizationId: org.id, organizationUserId: live.id, role: live.role, mirrorCreated };
    if (rows.length) return { ...base, outcome: 'skipped_removed', organizationId: org.id, organizationUserId: rows[0].id, mirrorCreated };

    const status = user.accountStatus === 'suspended' ? 'suspended' : 'active';
    if (dryRun) return { ...base, outcome: 'added', organizationId: org.id, organizationUserId: null, status, mirrorCreated };

    const at = stamp();
    const row = {
      id: `b2bu_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      organizationId: org.id, userId: user.id, role: 'hr', permissions: [],
      status, removedAt: null, createdBy: actorId, createdAt: at, updatedAt: at,
    };
    try {
      await organizationUsers.insertAsync(row);
    } catch (err) {
      // Another run (or the createHrUser hook) got there first.
      if (err.code !== '23505') throw err;
      const winner = (await organizationUsers.filterByColumnAsync('userId', user.id))
        .find(r => r.organizationId === org.id && r.status !== 'removed');
      return { ...base, outcome: 'already_member', organizationId: org.id, organizationUserId: winner?.id ?? null, role: winner?.role ?? null, mirrorCreated };
    }
    await auditLog.insertAsync({
      id: randomUUID(), at, actor: actorId, action: HR_CONVERSION_ACTION, target: row.id,
      before: null, after: { ...row, corporateId: user.corporateId, hrUserId: user.id, mirrorCreated },
    });
    return { ...base, outcome: 'added', organizationId: org.id, organizationUserId: row.id, status, mirrorCreated };
  }

  /**
   * Convert every HR login (or those of one company). `dryRun` defaults to
   * true: nothing is written and the report says what would happen.
   */
  async function run({ dryRun = true, actorId = HR_CONVERSION_ACTOR, corporateId = null } = {}) {
    const logins = await hrLogins({ corporateId });
    const items = [];
    for (const user of logins) items.push(await convertOne(user, { dryRun, actorId }));
    const counts = Object.fromEntries(HR_CONVERSION_OUTCOMES.map(o => [o, items.filter(i => i.outcome === o).length]));
    const mirrorsCreated = new Set(items.filter(i => i.mirrorCreated).map(i => i.corporateId)).size;
    const report = { dryRun, total: logins.length, counts, mirrorsCreated, items };
    if (!dryRun && (counts.added || mirrorsCreated)) {
      await auditLog.insertAsync({
        id: randomUUID(), at: stamp(), actor: actorId, action: 'b2b.hr_to_org.run',
        target: corporateId ?? 'all', before: null, after: { counts, mirrorsCreated },
      });
    }
    return report;
  }

  /** One HR login, written at once (used when a new HR login is created with the flag on). */
  async function convertHrUser({ userId, actorId = HR_CONVERSION_ACTOR }) {
    const [user] = await hrLogins({ userId });
    if (!user) return { error: 'hr_user_not_found', status: 404 };
    return convertOne(user, { dryRun: false, actorId });
  }

  return { run, convertHrUser };
}
