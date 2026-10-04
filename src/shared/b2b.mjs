// B2B Foundation V1 — organisation types, lifecycles, roles and permissions.
//
// Pure data and functions only; the service enforces them. Adding an
// organisation type, role or beneficiary type is a change here — the database
// only checks the shape of a type and the closed lifecycle status sets.

export const ORGANIZATION_TYPES = Object.freeze({
  employer: 'Employer / corporate',
  insurer: 'Insurance company',
  club: 'Club',
  association: 'Association',
  bank: 'Bank / financial institution',
  ngo: 'NGO',
  institution: 'Institution',
  other: 'Other',
});

// Allowed next statuses. `inactive` can be reopened (to active) by FitFlex.
export const ORGANIZATION_TRANSITIONS = Object.freeze({
  pending: ['active', 'inactive'],
  active: ['suspended', 'inactive'],
  suspended: ['active', 'inactive'],
  inactive: ['active'],
});
export const ORGANIZATION_STATUS = Object.freeze(Object.keys(ORGANIZATION_TRANSITIONS));

export const ORGANIZATION_USER_STATUS = Object.freeze(['active', 'suspended', 'removed']);

export const BENEFICIARY_TRANSITIONS = Object.freeze({
  pending: ['active', 'inactive'],
  active: ['suspended', 'inactive'],
  suspended: ['active', 'inactive'],
  inactive: ['active'],
});
export const BENEFICIARY_STATUS = Object.freeze(Object.keys(BENEFICIARY_TRANSITIONS));

export const BENEFICIARY_TYPES = Object.freeze({
  employee: 'Employee',
  dependant: 'Dependant',
  policyholder: 'Policyholder',
  member: 'Member',
  customer: 'Customer',
  beneficiary: 'Beneficiary',
  other: 'Other',
});

export const PERMISSIONS = Object.freeze([
  'organization.read',
  'organization.update',
  'users.read',
  'users.manage',
  'beneficiaries.read',
  'beneficiaries.manage',
  'programs.read',
  'programs.manage',
  'usage.read',
  // Invoices, payments, balances and statements (Phase 5).
  'billing.read',
  // Tell FitFlex a payment has been made (Phase 6).
  'billing.pay',
  // Challenges, their rewards, and groups for the organisation's people.
  'engagement.read',
  'engagement.manage',
]);

export const ROLE_PERMISSIONS = Object.freeze({
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  manager: ['organization.read', 'users.read', 'beneficiaries.read', 'beneficiaries.manage', 'programs.read', 'programs.manage', 'usage.read', 'engagement.read', 'engagement.manage'],
  hr: ['organization.read', 'beneficiaries.read', 'beneficiaries.manage', 'programs.read', 'engagement.read', 'engagement.manage'],
  finance: ['organization.read', 'programs.read', 'usage.read', 'billing.read', 'billing.pay'],
  analyst: ['organization.read', 'beneficiaries.read', 'programs.read', 'usage.read', 'engagement.read'],
  viewer: ['organization.read', 'programs.read'],
});
export const ORGANIZATION_USER_ROLES = Object.freeze(Object.keys(ROLE_PERMISSIONS));

// Read-only permissions stay usable while an organisation is still pending.
export const READ_PERMISSIONS = Object.freeze(PERMISSIONS.filter(p => p.endsWith('.read')));

/** Everything a role plus its explicit grants allows. */
export function effectivePermissions(role, grants = []) {
  return [...new Set([...(ROLE_PERMISSIONS[role] || []), ...grants.filter(p => PERMISSIONS.includes(p))])];
}

// ── Corporate compatibility ────────────────────────────────────────────────

/** CorporateAccount.status → B2BOrganization.status. */
export const CORPORATE_TO_ORGANIZATION_STATUS = Object.freeze({
  pending: 'pending', active: 'active', suspended: 'suspended', terminated: 'inactive',
});

/** CorporateEmployee.status → B2BBeneficiary.status. */
export const EMPLOYEE_TO_BENEFICIARY_STATUS = Object.freeze({
  pending: 'pending', active: 'active', suspended: 'suspended', exited: 'inactive',
});
