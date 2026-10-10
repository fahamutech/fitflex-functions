// Who belongs to a company or an organisation.
//
// Challenges, challenge rewards and groups can be run by a company (the
// Corporate module: `corporate`, keyed by CorporateAccount id) or by a B2B
// organisation that was never a Corporate account (`organization`, keyed by
// B2BOrganization id). Both mean the same thing to those features: a body
// with a list of people, some of them in named groups (departments).
//
//   corporate     people = CorporateEmployee rows; group = department
//   organization  people = B2BBeneficiary rows;    group = groupName
//
// A member belongs once their person row is linked to their FitFlex account
// (`userId`). Membership used to be read from `User.corporateId`, which
// nothing ever set for a member, so no member could see a company-only
// challenge or join a company group. That field is still honoured where a
// row has it, and never required.
//
// A person is returned in one shape whatever the source:
//   { id, userId, displayName, department, status }
export const COMPANY_TYPES = Object.freeze(['corporate', 'organization']);
export const isCompanyType = type => COMPANY_TYPES.includes(type);
export const companyKey = (type, id) => `${type}:${id}`;

// Who counts: an employee not yet activated is still on the company's list
// (as before); a beneficiary has to be active.
const COUNTS = { corporate: new Set(['active', 'pending']), organization: new Set(['active']) };
const counts = (type, status) => status == null || COUNTS[type].has(status);

export function createCompanyDirectory({ users, corporateEmployees = null, beneficiaries = null }) {
  const employee = e => ({ id: e.id, userId: e.userId ?? null, displayName: e.displayName ?? null, department: e.department ?? null, status: e.status });

  /** The people of one company or organisation who count. */
  async function peopleOf(type, id) {
    if (type === 'corporate') {
      if (!corporateEmployees) return [];
      return (await corporateEmployees.filterByColumnAsync('corporateId', id)).filter(e => counts('corporate', e.status)).map(employee);
    }
    if (type === 'organization') {
      if (!beneficiaries) return [];
      const rows = (await beneficiaries.filterByColumnAsync('organizationId', id)).filter(b => counts('organization', b.status));
      const ids = [...new Set(rows.map(b => b.userId).filter(Boolean))];
      const named = new Map((ids.length ? await users.filterByColumnInAsync('id', ids) : []).map(u => [u.id, u.displayName ?? null]));
      return rows.map(b => ({ id: b.id, userId: b.userId ?? null, displayName: named.get(b.userId) ?? null, department: b.groupName ?? null, status: b.status }));
    }
    return [];
  }

  /**
   * The companies and organisations a member belongs to, each with their
   * person row there (null when only the legacy `User.corporateId` says so).
   */
  async function membershipsOf(userId, { membersOnly = true } = {}) {
    const user = await users.findByIdAsync(userId);
    if (!user) return [];
    // Sharing between colleagues is for members only: never HR or staff.
    if (membersOnly && user.userType !== 'member') return [];
    const out = [];
    if (corporateEmployees) {
      for (const e of await corporateEmployees.filterByColumnAsync('userId', userId)) {
        if (counts('corporate', e.status)) out.push({ type: 'corporate', id: e.corporateId, person: employee(e) });
      }
    }
    if (user.corporateId && !out.some(m => m.type === 'corporate' && m.id === user.corporateId)) {
      out.push({ type: 'corporate', id: user.corporateId, person: null });
    }
    if (beneficiaries) {
      for (const b of await beneficiaries.filterByColumnAsync('userId', userId)) {
        if (counts('organization', b.status)) {
          out.push({ type: 'organization', id: b.organizationId, person: { id: b.id, userId, displayName: user.displayName ?? null, department: b.groupName ?? null, status: b.status } });
        }
      }
    }
    return out;
  }

  /** "corporate:<id>" / "organization:<id>" for everything the member belongs to. */
  async function keysOf(userId) {
    return new Set((await membershipsOf(userId)).map(m => companyKey(m.type, m.id)));
  }

  /** The member accounts of everyone who shares a company or organisation with this member. */
  async function colleaguesOf(userId) {
    const out = new Set();
    for (const m of await membershipsOf(userId)) {
      for (const p of await peopleOf(m.type, m.id)) if (p.userId) out.add(p.userId);
      if (m.type === 'corporate') {
        for (const u of await users.filterByColumnAsync('corporateId', m.id)) if (u.userType === 'member') out.add(u.id);
      }
    }
    out.delete(userId);
    return out;
  }

  return { peopleOf, membershipsOf, keysOf, colleaguesOf };
}
