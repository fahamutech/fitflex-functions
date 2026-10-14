// Identity V2 feature flags (decision C2). IDENTITY_V2 is the umbrella: a
// phase flag is on only when both it and IDENTITY_V2 are on. Everything is
// off unless set, so a deploy never changes behaviour on its own. Writes to
// the new identity tables are not flagged; only reads and behaviour are.
export const IDENTITY_V2_FLAGS = [
  'V2_FOUNDATION', 'V2_LINKING', 'V2_PERSONAS', 'V2_ADD_PERSONA',
  'V2_ORG_WRITE', 'V2_ORG_AUTHZ', 'V2_IDENTIFIERS', 'V2_INVITES', 'V2_RECOVERY',
  // I7 (design confirmed 2 Oct 2026): FitFlex keeps the PIN; sign-in with number or email + PIN.
  'V2_PIN_LOGIN',
];

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);
const on = name => TRUE_VALUES.has(String(process.env[name] ?? '').trim().toLowerCase());

/** True when IDENTITY_V2 and the given phase flag are both enabled. */
export function identityFlag(name) {
  if (!IDENTITY_V2_FLAGS.includes(name)) throw new Error(`unknown Identity V2 flag: ${name}`);
  return on('IDENTITY_V2') && on(name);
}

/**
 * How organisation authorisation is decided (Identity V2 · I5):
 *   'off'     legacy rules only (default)
 *   'shadow'  legacy rules decide; the membership decision is computed
 *             alongside and disagreements are logged (V2_ORG_AUTHZ=shadow)
 *   'enforce' OrgMembership decides (V2_ORG_AUTHZ=true)
 * Both need the IDENTITY_V2 umbrella.
 */
export function orgAuthzMode() {
  if (!on('IDENTITY_V2')) return 'off';
  const value = String(process.env.V2_ORG_AUTHZ ?? '').trim().toLowerCase();
  if (value === 'shadow') return 'shadow';
  return TRUE_VALUES.has(value) ? 'enforce' : 'off';
}

/**
 * Owner check-in lists show who visited by name (GET /owner/gyms/:id/checkins
 * adds `displayName`). Off unless CHECKIN_VISITOR_NAMES is set, so a deploy
 * never changes what owners see on its own.
 */
export function checkinVisitorNamesOn() {
  return on('CHECKIN_VISITOR_NAMES');
}

/**
 * Members may choose a username shown in public places (migration
 * member-usernames, /me/username endpoints, admin clear on reports). Off
 * unless MEMBER_USERNAMES is set: the endpoints answer 404 feature_disabled
 * and /me omits the new fields.
 */
export function memberUsernamesOn() {
  return on('MEMBER_USERNAMES');
}


/**
 * Pay by mobile money through Malipo by Tunzaa (POST /me/payments/:id/mobile-money).
 * Off unless TUNZAA_PAYMENTS is set (and the Tunzaa credentials are present):
 * the endpoint answers 404 feature_disabled and /payments/options says
 * `enabled: false`, so members keep the manual flow. Callbacks for payments
 * already in flight are always honoured (see mobile-money-service).
 */
export function tunzaaPaymentsOn() {
  return on('TUNZAA_PAYMENTS');
}
