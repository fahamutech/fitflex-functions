// Who may run challenges, rewards and groups for a B2B organisation, and
// which company or organisation those then belong to.
//
// An organisation user with `engagement.manage` (owner, admin, manager, hr)
// runs them; `engagement.read` (also analyst) may look. A company that came
// from the Corporate module keeps its challenges and groups under its
// Corporate id, so its HR login and its organisation users see the same ones;
// an organisation that never was a company owns them under its own id.
export function createB2BEngagementAccess({ b2bService }) {
  /**
   * @returns {{ type: 'corporate'|'organization', id: string, access } | { error, status }}
   */
  async function resolve(req, { write = req.method ? req.method.toUpperCase() !== 'GET' : true } = {}) {
    const access = await b2bService.resolveAccess({
      organizationId: req.params.organizationId, userId: req.user.sub, userType: req.user.userType,
    });
    if (access.error) return access;
    const needed = write ? 'engagement.manage' : 'engagement.read';
    if (!access.permissions.includes(needed)) return { error: 'forbidden', status: 403, requiredPermission: needed };
    if (write && access.org.status !== 'active') return { error: 'organization_not_active', status: 409, organizationStatus: access.org.status };
    return access.org.legacyCorporateId
      ? { type: 'corporate', id: access.org.legacyCorporateId, access }
      : { type: 'organization', id: access.org.id, access };
  }
  return { resolve };
}
