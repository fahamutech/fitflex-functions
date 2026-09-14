// Identity service — resolves the authenticated DB user from JWT claims and
// mints masked public-facing IDs (FM/FT/FO + sequence). Used across nearly
// every domain, so it is composed once and injected wherever needed.
export function createIdentityService({ users }) {
  /** Resolve the authenticated user from JWT claims — handles stale sub IDs via email/phone fallback. */
  async function resolveRequestUser(req) {
    let user = await users.findByIdAsync(req.user.sub);
    if (!user && req.user.email) {
      user = await users.findAsync(u => u.email === req.user.email && u.userType === req.user.userType);
    }
    if (!user && req.user.phone) {
      user = await users.findAsync(u => u.phone === req.user.phone && u.userType === req.user.userType);
    }
    return user;
  }

  async function publicUserId(userOrId, role) {
    const id = typeof userOrId === 'string' ? userOrId : userOrId?.id;
    const user = typeof userOrId === 'object' ? userOrId : await users.findByIdAsync(id);
    const userType = role || user?.userType;
    const prefix = userType === 'trainer' ? 'FT' : userType === 'gym_operator' ? 'FO' : 'FM';
    const roleUsers = await users.filterByColumnAsync('userType', userType || 'member');
    roleUsers.sort((a, b) => String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id)));
    const index = roleUsers.findIndex(u => u.id === id);
    if (index >= 0) return `${prefix}${String(index + 1).padStart(3, '0')}`;
    const seed = String(id || prefix);
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 999;
    return `${prefix}${String(hash + 1).padStart(3, '0')}`;
  }

  return { resolveRequestUser, publicUserId };
}
