// Terms a user agrees to when they set up an account or add a role.
//
// One surface for every role:
//   member                      → the FitFlex Terms and Conditions; the
//                                 accepted version is kept on the account row
//   gym owner / trainer / vendor → that role's partner agreement, kept with
//                                 the partner's other agreements (the same
//                                 record the verification checklist reads)
//   anyone else (staff, admin)   → nothing to accept
// Each role (persona) accepts its own terms.
import { randomUUID } from 'node:crypto';
import { MEMBER_TERMS } from '../shared/member-terms.mjs';
import { agreementText, requiredAgreements } from '../shared/partner-agreements.mjs';
import { partnerTypeForUserType } from '../shared/partner-kyc.mjs';

const PARTNER_AGREEMENT = 'partner_agreement';
const iso = (v) => (v == null ? null : new Date(v).toISOString());

/** The terms text for a role in a language, or null when the role has none. */
export function termsForRole(userType, lang) {
  if (userType === 'member') return { kind: 'member_terms', ...agreementText(MEMBER_TERMS, lang) };
  const partnerType = partnerTypeForUserType(userType === 'gym_owner' ? 'gym_operator' : userType);
  const agreement = partnerType && requiredAgreements(partnerType).find(a => a.agreementType === PARTNER_AGREEMENT);
  return agreement ? { kind: PARTNER_AGREEMENT, ...agreementText(agreement.text, lang) } : null;
}

export function createTermsService({ users, partnerKycService, auditLog = null, now = () => new Date() }) {
  const none = (userType) => ({ role: userType, required: false, accepted: true, acceptedAt: null });

  /**
   * The signed-in user's terms and whether they have accepted the current
   * version. With `role` (another role they are about to add) it returns that
   * role's text only — nothing can be accepted for a role until it exists.
   */
  async function current({ userId, lang, role = null }) {
    const user = await users.findByIdAsync(userId);
    if (!user) return { error: 'user_not_found', status: 404 };
    if (role && role !== user.userType) {
      const text = termsForRole(role, lang);
      if (!text) return { error: 'invalid_role', status: 400 };
      return { role, required: true, accepted: false, acceptedAt: null, preview: true, ...text };
    }
    const text = termsForRole(user.userType, lang);
    if (!text) return none(user.userType);
    let acceptedAt = null;
    if (text.kind === 'member_terms') {
      acceptedAt = user.termsVersion === text.version ? iso(user.termsAcceptedAt) : null;
    } else {
      const partner = await partnerKycService.partnerForUser(userId);
      if (partner.error) return partner;
      const { agreements } = await partnerKycService.agreements(partner, lang);
      acceptedAt = iso(agreements.find(a => a.agreementType === PARTNER_AGREEMENT)?.acceptedAt);
    }
    return { role: user.userType, required: true, accepted: Boolean(acceptedAt), acceptedAt, ...text };
  }

  /** Accept the current version. Accepting again is a no-op. */
  async function accept({ userId, version, meta = {} }) {
    const user = await users.findByIdAsync(userId);
    if (!user) return { error: 'user_not_found', status: 404 };
    const text = termsForRole(user.userType, 'en');
    if (!text) return none(user.userType);
    if (version !== text.version) return { error: 'terms_version_outdated', status: 409, version: text.version };
    if (text.kind === 'member_terms') {
      if (user.termsVersion !== text.version) {
        const at = now().toISOString();
        await users.updateByIdAsync(user.id, { termsVersion: text.version, termsAcceptedAt: at });
        await auditLog?.insertAsync?.({
          id: randomUUID(), at, actor: user.id, action: 'member_terms_accepted',
          target: user.id, before: null,
          after: { version: text.version, reference: text.reference, ip: meta.ip || null, userAgent: meta.userAgent || null },
        }).catch?.(() => {});
      }
    } else {
      const partner = await partnerKycService.partnerForUser(userId);
      if (partner.error) return partner;
      const r = await partnerKycService.acceptAgreement(
        partner, { agreementType: PARTNER_AGREEMENT, version }, { id: userId, role: 'partner' }, meta,
      );
      if (r?.error) return r.error === 'agreement_version_outdated' ? { ...r, error: 'terms_version_outdated' } : r;
    }
    return current({ userId, lang: 'en' });
  }

  return { current, accept };
}
