// Auth service — OTP, email/password (dev), Firebase session exchange, and
// dev-only mock login. Owns role/approval-status normalization rules.
import { randomUUID } from 'node:crypto';
import { verifyPassword } from '../auth/password-credentials.mjs';
import { buildDevIdentity, DEV_GYM_ID, DEV_OWNER_GYM_ID } from '../shared/dev-login.mjs';
import { normalizeEmail, sameEmail } from '../shared/identifiers.mjs';
import { toSessionUser } from '../shared/session-user.mjs';
import { identityFlag } from '../shared/feature-flags.mjs';

const configuredAdminEmails = new Set(
  (process.env.FITFLEX_ADMIN_EMAILS || 'mama27j@gmail.com')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean)
);

export function isConfiguredAdminEmail(email) {
  return Boolean(email && configuredAdminEmails.has(String(email).toLowerCase()));
}

export function normalizeRequestedRole(role) {
  if (role === 'admin') return 'admin';
  if (role === 'gym_owner' || role === 'gym_operator') return 'gym_operator';
  if (role === 'trainer') return 'trainer';
  if (role === 'gym_staff') return 'gym_staff';
  if (role === 'vendor') return 'vendor';
  if (role === 'vendor_staff') return 'vendor_staff';
  if (role === 'corporate_hr') return 'corporate_hr';
  return 'member';
}

// Staff roles created by another account holder rather than self-registered:
// they sign in with a scrypt-hashed password instead of Firebase.
const SCRYPT_PASSWORD_ROLES = new Set(['vendor_staff', 'corporate_hr']);

export function approvalStatusForRole(role) {
  // Trainers and gym owners are active at once and shown as not verified
  // until their KYC is approved (3 Oct 2026). Vendors still wait for approval.
  return role === 'vendor' ? 'pending_approval' : 'approved';
}

// Clients that understand persons and personas identify themselves with this
// header (decision C3b). Everyone else keeps legacy session behaviour.
export const IDENTITY_V2_CLIENT = 'identity-v2';

// Personas a signed-in person may add for themselves (I3). Staff, HR and
// admin roles are organisation or platform roles and are never self-added.
export const ADDABLE_PERSONA_TYPES = ['member', 'trainer', 'gym_operator', 'vendor'];

export function createAuthService({
  users, gyms, subscriptions, trainers, otps, products,
  signJwt, verifyFirebaseIdToken, publicUserId, gymService, trainerService,
  identityLink = null, auditLog = null, orgMemberships = null,
}) {
  /** JWT claims for a persona row. `sub` stays the persona (User) id. */
  function sessionClaims(user) {
    return {
      sub: user.id,
      userType: user.userType,
      email: user.email,
      gymId: user.gymId,
      portalUser: user.portalUser || false,
      aclPermissions: user.aclPermissions || [],
      vendorId: user.vendorId,
      vendorRole: user.vendorRole,
      vendorPermissions: user.vendorPermissions || [],
      corporateId: user.corporateId,
      // Identity V2 · I2 (C3a): the Person rides along; nothing reads it as `sub`.
      ...(identityFlag('V2_PERSONAS') && user.personId ? { pid: user.personId, ver: 2 } : {}),
    };
  }

  /** Person + personas payload for Identity V2 clients. */
  async function personaPayload(user, extra = {}) {
    const [person, personas] = await Promise.all([
      identityLink.personOf(user.personId), identityLink.personasOf(user.personId),
    ]);
    const held = new Set(personas.map(p => p.userType));
    return {
      person: person ? { id: person.id, status: person.status } : null,
      personas,
      activePersonaId: user.id,
      // I3: what this person could still add; empty while V2_ADD_PERSONA is off.
      addablePersonaTypes: identityFlag('V2_ADD_PERSONA')
        ? ADDABLE_PERSONA_TYPES.filter(t => !held.has(t)) : [],
      ...extra,
    };
  }
  async function requestOtp({ phone, userType = 'member' }) {
    if (!phone) return { error: 'phone_required', status: 400 };
    if (!['member', 'trainer', 'gym_operator', 'vendor', 'admin'].includes(userType)) {
      return { error: 'invalid_userType', status: 400 };
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await otps.upsertAsync(o => o.phone === phone, { phone, code, userType, expiresAt: Date.now() + 5 * 60_000 });
    const isProd = process.env.NODE_ENV === 'production';
    return {
      ok: true,
      ...(isProd ? {} : { devOtp: code }),
      message: isProd ? 'OTP sent via SMS' : 'OTP sent (dev mode returns code in payload)',
    };
  }

  async function verifyOtp({ phone, code }) {
    // otps is a primed collection: requestOtp updates the in-memory cache and awaits the
    // PG write, so this cached read always sees the latest code.
    const otp = otps.find(o => o.phone === phone);
    if (!otp || otp.code !== code) return { error: 'invalid_otp', status: 401 };
    if (Date.now() > otp.expiresAt) return { error: 'otp_expired', status: 401 };

    let user = await users.findAsync(u => u.phone === phone && u.userType === otp.userType);
    if (!user) {
      user = {
        id: `usr_${randomUUID().slice(0, 8)}`,
        phone, userType: otp.userType, createdAt: new Date().toISOString()
      };
      await users.upsertAsync(u => u.id === user.id, user);
    }
    await otps.upsertAsync(o => o.phone === phone, { ...otp, code: null });
    const token = signJwt({ sub: user.id, userType: user.userType, phone: user.phone });
    return { token, user: toSessionUser(user) };
  }

  async function login({ email, password, requestedRole }) {
    if (!email || !password) return { error: 'email_and_password_required', status: 400 };
    const role = requestedRole ? normalizeRequestedRole(requestedRole) : null;
    const matches = await users.filterAsync(u => sameEmail(u.email, email));
    const user = role
      ? matches.find(u => u.userType === role) ||
        (role === 'vendor' ? matches.find(u => u.userType === 'vendor_staff') : null)
      : matches[0];
    if (!user) return { error: 'invalid_credentials', status: 401 };
    if (!role && matches.length > 1) {
      return {
        error: 'profile_role_required',
        status: 409,
        availableRoles: [...new Set(matches.map(u => u.userType))],
      };
    }
    if (user.accountStatus === 'suspended') return { error: 'account_suspended', status: 403 };
    // Portal users authenticate via Firebase client SDK (email/password) then hit /auth/firebase/session.
    // This path handles dev-mode demo passwords only.
    if (process.env.NODE_ENV === 'production' && !SCRYPT_PASSWORD_ROLES.has(user.userType)) {
      return { error: 'use_firebase_email_password_sign_in', status: 403 };
    }
    // Hashes are scrypt; `demo:<plaintext>` survives only on rows written
    // before the rehash migration and is accepted for the dev-only roles.
    const storedHash = String(user.passwordHash || '');
    const validPassword = storedHash.startsWith('scrypt:')
      ? await verifyPassword(password, storedHash)
      : !SCRYPT_PASSWORD_ROLES.has(user.userType) && storedHash === `demo:${password}`;
    if (!validPassword) return { error: 'invalid_credentials', status: 401 };
    const token = signJwt(sessionClaims(user));
    return { token, user: toSessionUser(user) };
  }

  async function firebaseSession({ idToken, requestedRole, client = null, existingOnly = false }) {
    const fb = await verifyFirebaseIdToken(idToken);
    if (!fb) return { error: 'invalid_firebase_token', status: 401 };

    // Sign-in deliberately omits requestedRole so an existing account's role
    // is resolved from FitFlex. Sign-up supplies it from the dedicated role
    // choice page. Keep member as the legacy default for a new identity.
    const hasRequestedRole = requestedRole != null && String(requestedRole).trim() !== '';
    const selfRole = hasRequestedRole ? normalizeRequestedRole(requestedRole) : null;
    const fbEmail = normalizeEmail(fb.email);
    // An email proves who someone is only once Firebase has verified it.
    // Unverified, it can still reach rows already tied to this Firebase uid,
    // but it must never claim a row that some other account (or nobody) owns.
    const emailVerified = Boolean(fbEmail && fb.emailVerified);
    const isAdminEmail = emailVerified && isConfiguredAdminEmail(fbEmail);
    const candidates = await users.filterAsync(
      u => u.firebaseUid === fb.uid || Boolean(fbEmail && sameEmail(u.email, fbEmail)),
    );
    const uidMatches = candidates.filter(u => u.firebaseUid === fb.uid);
    const emailOnlyMatches = candidates.filter(u => u.firebaseUid !== fb.uid);
    const requestedUserType = isAdminEmail ? 'admin' : selfRole;

    if (!emailVerified && emailOnlyMatches.length) {
      // Would the old email match have picked a row this uid does not own?
      const claimsEmailOnlyRow = requestedUserType
        ? !uidMatches.some(u => u.userType === requestedUserType)
          && emailOnlyMatches.some(u => u.userType === requestedUserType)
        : uidMatches.length === 0;
      if (claimsEmailOnlyRow) return { error: 'email_verification_required', status: 409 };
    }
    const identityMatches = emailVerified ? candidates : uidMatches;
    const v2Client = client === IDENTITY_V2_CLIENT && identityFlag('V2_PERSONAS') && Boolean(identityLink);
    const operationalMatches = identityMatches.filter(u => u.userType !== 'member');
    let user = requestedUserType
      ? identityMatches.find(u => u.userType === requestedUserType)
      : operationalMatches.length === 1
        ? operationalMatches[0]
        : identityMatches[0];

    // Old app versions could create a member row before an owner, trainer, or
    // vendor registration completed. Prefer that single operational profile
    // on later sign-ins. Only ask for a role when multiple non-member profiles
    // remain genuinely ambiguous.
    // Identity V2 clients get their personas and choose instead (C3b).
    if (!v2Client && !hasRequestedRole && !isAdminEmail && operationalMatches.length > 1) {
      return {
        error: 'profile_role_required',
        status: 409,
        availableRoles: [...new Set(identityMatches.map(u => u.userType))],
      };
    }

    if (user) {
      // Existing user: NEVER change their stored userType via this endpoint.
      // Only exception: configured admin email always stays admin.
      const patch = {
        firebaseUid: user.firebaseUid || fb.uid,
        email: user.email || fbEmail,
        displayName: fb.name || user.displayName,
        photoUrl: fb.picture || user.photoUrl,
        accountStatus: user.accountStatus || 'active',
        onboardingCompleted: user.onboardingCompleted || false,
        approvalStatus: user.approvalStatus || 'approved',
        ...(isAdminEmail ? { userType: 'admin' } : {})
      };
      user = await users.upsertAsync(u => u.id === user.id, { ...user, ...patch, updatedAt: new Date().toISOString() });
    } else {
      // A sign-in that must never register anyone (the portal has no
      // self-registration): no profile of that role means no session.
      if (existingOnly) return { error: 'profile_not_found', status: 404 };
      const newUserRole = selfRole || 'member';
      // New user: only allow creation if NOT requesting admin.
      if (newUserRole === 'admin' && !isAdminEmail) return { error: 'admin_self_registration_not_allowed', status: 403 };
      // Gym staff (receptionists etc.) must be pre-created by their gym owner.
      if (newUserRole === 'gym_staff') return { error: 'gym_staff_self_registration_not_allowed', status: 403 };
      const row = {
        id: `usr_${randomUUID().slice(0, 8)}`,
        firebaseUid: fb.uid,
        email: fbEmail,
        displayName: fb.name,
        photoUrl: fb.picture,
        userType: isAdminEmail ? 'admin' : newUserRole,
        approvalStatus: isAdminEmail ? 'approved' : approvalStatusForRole(newUserRole),
        accountStatus: 'active',
        onboardingCompleted: false,
        createdAt: new Date().toISOString()
      };
      user = await users.upsertAsync(u => u.id === row.id, row);
    }

    // Identity V2 · I2: link this person's personas on verified evidence only.
    // Linking must never block a sign-in, so a failure is logged and skipped.
    if (identityFlag('V2_LINKING') && identityLink) {
      try {
        await identityLink.linkOnVerifiedSignIn({
          anchorUserId: user.id, uid: fb.uid,
          email: emailVerified ? fbEmail : null,
          phone: fb.phoneNumber || null,
          provider: fb.signInProvider || null,
        });
        user = (await users.findByIdAsync(user.id)) || user;
      } catch (err) {
        console.warn('[identity] linking skipped:', err?.message);
      }
    }

    let personaChoiceRequired = false;
    if (v2Client && user.personId && !requestedUserType) {
      // Restore the persona used last; otherwise ask when it's genuinely ambiguous.
      const [person, personas] = await Promise.all([
        identityLink.personOf(user.personId), identityLink.personasOf(user.personId),
      ]);
      const usable = personas.filter(p => !p.portalOnly && p.accountStatus !== 'suspended' && p.approvalStatus !== 'rejected');
      const last = usable.find(p => p.id === person?.lastPersonaId);
      if (last && last.id !== user.id) user = (await users.findByIdAsync(last.id)) || user;
      personaChoiceRequired = !last && usable.filter(p => p.userType !== 'member').length > 1;
    }

    // Block portal-only staff from logging in via the app's Firebase session
    if (user.portalUser === true && requestedRole !== 'admin') return { error: 'portal_user_app_access_denied', status: 403 };
    if (user.accountStatus === 'suspended') return { error: 'account_suspended', status: 403 };
    if (user.approvalStatus === 'rejected') return { error: 'profile_rejected', status: 403, approvalNote: user.approvalNote || null };

    const token = signJwt(sessionClaims(user));
    const session = { token, user: toSessionUser(user), pendingApproval: user.approvalStatus === 'pending_approval' };
    if (!v2Client) return session;
    await identityLink.rememberPersona(user.personId, user.id);
    return { ...session, ...(await personaPayload(user, { personaChoiceRequired })) };
  }

  async function devLogin({ role }) {
    if (process.env.NODE_ENV === 'production') return { error: 'dev_login_disabled_in_production', status: 403 };
    const identity = buildDevIdentity(role);
    if (!identity) return { error: 'invalid_role', status: 400, allowed: ['member', 'trainer', 'owner', 'vendor'] };

    const now = new Date();
    const nowIso = now.toISOString();

    // Shared demo gym (used for member browsing + trainer linkage).
    await gyms.upsertAsync(g => g.id === DEV_GYM_ID, gymService.normalizeGymPayload({
      id: DEV_GYM_ID,
      name: 'Iron Paradise (Dev)',
      tier: 'standard',
      location: 'Masaki, Dar es Salaam',
      perVisitRate: 5000,
      status: 'active',
      images: [
        'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=800',
        'https://images.unsplash.com/photo-1571902943202-507ec2618e8f?w=800',
      ],
      amenities: ['dry sauna', 'lockers', 'showers', 'wifi'],
      equipment: ['treadmills', 'squat racks', 'dumbbell racks'],
    }, {}));

    let user;
    if (identity.userType === 'gym_operator') {
      await gyms.upsertAsync(g => g.id === DEV_OWNER_GYM_ID, gymService.normalizeGymPayload({
        id: DEV_OWNER_GYM_ID,
        name: 'Dev Owner Gym',
        tier: 'standard',
        location: 'Mikocheni, Dar es Salaam',
        perVisitRate: 5000,
        status: 'active',
        images: ['https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=800'],
        amenities: ['lockers', 'showers'],
      }, {}));
      user = await users.upsertAsync(u => u.id === identity.id, {
        id: identity.id, userType: 'gym_operator', email: identity.email, phone: identity.phone,
        displayName: identity.displayName, accountStatus: 'active', approvalStatus: 'approved',
        onboardingCompleted: true, gymId: DEV_OWNER_GYM_ID, gymIds: [DEV_OWNER_GYM_ID],
        createdAt: nowIso, updatedAt: nowIso,
      });
    } else if (identity.userType === 'trainer') {
      user = await users.upsertAsync(u => u.id === identity.id, {
        id: identity.id, userType: 'trainer', email: identity.email, phone: identity.phone,
        displayName: identity.displayName, accountStatus: 'active', approvalStatus: 'approved',
        onboardingCompleted: true, createdAt: nowIso, updatedAt: nowIso,
      });
      await trainers.upsertAsync(t => t.id === 'trn_dev', trainerService.normalizeTrainerPayload({
        id: 'trn_dev', userId: identity.id, email: identity.email, displayName: identity.displayName,
        photoUrl: 'https://images.unsplash.com/photo-1567013127542-490d757e51fc?w=400',
        gender: 'female', specialties: ['strength', 'mobility'], bio: 'Dev trainer profile.',
        hourlyRateTzs: 20000, experienceYears: 5, gymIds: [DEV_GYM_ID],
        availability: [
          'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
        ].map(day => ({ day, gymId: DEV_GYM_ID, slots: ['09:00', '10:00'] })),
        status: 'active', approvalStatus: 'approved',
      }, {}));
    } else if (identity.userType === 'vendor') {
      user = await users.upsertAsync(u => u.id === identity.id, {
        id: identity.id, userType: 'vendor', email: identity.email, phone: identity.phone,
        displayName: identity.displayName, accountStatus: 'active', approvalStatus: 'approved',
        onboardingCompleted: true,
        vendorProfile: {
          vendorId: identity.id,
          businessName: 'FitFlex Performance Store',
          logo: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=300',
          banner: 'https://images.unsplash.com/photo-1599058917212-d750089bc07e?w=900',
          description: 'Trusted fitness equipment and nutrition in Tanzania.',
          businessCategory: 'Fitness equipment',
          contactNumber: identity.phone,
          email: identity.email,
          address: 'Masaki, Dar es Salaam',
          deliveryRegions: ['Dar es Salaam', 'Arusha'],
          businessHours: { summary: 'Mon-Sat 08:00-18:00' },
          settlementAccount: { provider: 'M-Pesa', account: identity.phone },
          status: 'published',
          updatedAt: nowIso,
        },
        createdAt: nowIso, updatedAt: nowIso,
      });
      if (products) {
        await products.upsertAsync(p => p.id === 'prd_dev_marketplace', {
          id: 'prd_dev_marketplace', vendorId: identity.id,
          name: 'FitFlex Resistance Bands', description: 'Five-band training set for home or gym workouts.',
          category: 'Equipment', brand: 'FitFlex', priceTzs: 45000, discountPriceTzs: 39000,
          stock: 25, sku: 'FF-RB-5', weightKg: 0.7, distanceKm: 3.2,
          variants: [{ name: 'Five-band set', stock: 25 }],
          images: ['https://images.unsplash.com/photo-1598289431512-b97b0917affc?w=800'],
          visibility: 'visible', deliveryAvailable: true, status: 'active', approvalStatus: 'approved',
          rating: 4.8, reviewCount: 12, soldCount: 64,
          homepageVisible: true, homepagePriority: 5000, createdAt: nowIso, updatedAt: nowIso,
        });
      }
    } else {
      user = await users.upsertAsync(u => u.id === identity.id, {
        id: identity.id, userType: 'member', email: identity.email, phone: identity.phone,
        displayName: identity.displayName, accountStatus: 'active', approvalStatus: 'approved',
        onboardingCompleted: true, createdAt: nowIso, updatedAt: nowIso,
      });
      // Active premium subscription so QR + check-in journeys work end-to-end.
      const renewsAt = new Date(+now + 30 * 86_400_000).toISOString();
      await subscriptions.upsertAsync(s => s.id === 'sub_dev_member', {
        id: 'sub_dev_member', memberId: identity.id, type: 'platform_pass', tier: 'premium',
        status: 'active', startedAt: nowIso, cycleStartedAt: nowIso, renewsAt, expiresAt: renewsAt,
        paymentRef: 'DEV_MOCK',
      });
    }

    const token = signJwt({ sub: user.id, userType: user.userType, email: user.email, gymId: user.gymId });
    console.log(`[dev-login] minted session for ${user.userType} (${user.id})`);
    const devPubId = await publicUserId(user);
    return { token, user: { ...toSessionUser(user), publicId: devPubId, userCode: devPubId }, pendingApproval: false };
  }

  /** Identity V2 · I2: the caller's Person and personas. */
  async function myPersonas({ claims }) {
    if (!identityFlag('V2_PERSONAS') || !identityLink) return { error: 'not_found', status: 404 };
    const user = await users.findByIdAsync(claims.sub);
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    return personaPayload(user);
  }

  /**
   * Identity V2 · I2: mint a session for another persona of the same Person.
   * No Firebase round trip; the target must be one of the caller's own live,
   * usable personas.
   */
  async function switchPersona({ claims, personaId }) {
    if (!identityFlag('V2_PERSONAS') || !identityLink) return { error: 'not_found', status: 404 };
    if (!personaId) return { error: 'personaId_required', status: 400 };
    const caller = await users.findByIdAsync(claims.sub);
    if (!caller?.personId) return { error: 'user_not_found', status: 404 };
    const target = await users.findByIdAsync(personaId);
    // Same answer whether the persona doesn't exist or belongs to someone else.
    if (!target || target.personId !== caller.personId || target.accountStatus === 'closed') {
      return { error: 'persona_not_found', status: 404 };
    }
    const person = await identityLink.personOf(caller.personId);
    if (person?.status !== 'active') return { error: 'person_not_active', status: 403 };
    if (target.portalUser === true || target.userType === 'admin') return { error: 'portal_persona_not_switchable', status: 403 };
    if (target.accountStatus === 'suspended') return { error: 'account_suspended', status: 403 };
    if (target.approvalStatus === 'rejected') return { error: 'profile_rejected', status: 403, approvalNote: target.approvalNote || null };
    await identityLink.rememberPersona(target.personId, target.id);
    return {
      token: signJwt(sessionClaims(target)),
      user: toSessionUser(target),
      pendingApproval: target.approvalStatus === 'pending_approval',
      ...(await personaPayload(target)),
    };
  }

  /**
   * Identity V2 · I3: add a persona to the caller's own Person. No second
   * Person, no second Firebase account, no duplicated identifiers: the new
   * User row is created under the caller's personId and goes through the
   * role's normal onboarding and approval. Idempotent per type.
   */
  async function addPersona({ claims, userType }) {
    if (!identityFlag('V2_ADD_PERSONA') || !identityLink) return { error: 'not_found', status: 404 };
    const type = userType === 'gym_owner' ? 'gym_operator' : userType;
    if (!ADDABLE_PERSONA_TYPES.includes(type)) {
      return { error: 'persona_type_not_allowed', status: 400, allowed: ADDABLE_PERSONA_TYPES };
    }
    const caller = await users.findByIdAsync(claims.sub);
    if (!caller?.personId) return { error: 'user_not_found', status: 404 };
    const person = await identityLink.personOf(caller.personId);
    if (person?.status !== 'active') return { error: 'person_not_active', status: 403 };

    const existing = (await identityLink.personasOf(caller.personId)).find(p => p.userType === type);
    if (existing) return { created: false, persona: existing, ...(await personaPayload(caller)) };

    const result = await identityLink.createPersona({
      person, source: caller, userType: type, approvalStatus: approvalStatusForRole(type),
    });
    if (result.error) {
      // Another profile of this role already uses the email (for example one a
      // gym created); verifying the email at sign-in links it instead.
      return { error: 'persona_identifier_in_use', status: 409 };
    }
    if (auditLog) {
      await auditLog.insertAsync({
        id: randomUUID(), at: new Date().toISOString(), actor: caller.id, action: 'persona_added',
        target: result.row.id, before: null, after: { personId: caller.personId, userType: type },
      });
    }
    const payload = await personaPayload(caller);
    return { created: true, persona: payload.personas.find(p => p.id === result.row.id), ...payload };
  }

  /**
   * Identity V2 · I4: every organisation relationship of the caller's Person
   * (gyms and vendors from OrgMembership, corporate from the B2B tables).
   */
  async function myMemberships({ claims, includeEnded = false }) {
    if (!identityFlag('V2_ORG_WRITE') || !orgMemberships) return { error: 'not_found', status: 404 };
    const user = await users.findByIdAsync(claims.sub);
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    return { memberships: await orgMemberships.membershipsOfPerson(user.personId, { includeEnded }) };
  }

  return { requestOtp, verifyOtp, login, firebaseSession, devLogin, myPersonas, switchPersona, addPersona, myMemberships };
}
