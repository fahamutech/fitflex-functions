// Auth service — OTP, email/password (dev), Firebase session exchange, and
// dev-only mock login. Owns role/approval-status normalization rules.
import { randomUUID } from 'node:crypto';
import { verifyPassword } from '../auth/password-credentials.mjs';
import { buildDevIdentity, DEV_GYM_ID, DEV_OWNER_GYM_ID } from '../shared/dev-login.mjs';

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
  return 'member';
}

export function approvalStatusForRole(role) {
  return ['gym_operator', 'trainer', 'vendor'].includes(role) ? 'pending_approval' : 'approved';
}

export function createAuthService({
  users, gyms, subscriptions, trainers, otps, products,
  signJwt, verifyFirebaseIdToken, publicUserId, gymService, trainerService,
}) {
  function requestOtp({ phone, userType = 'member' }) {
    if (!phone) return { error: 'phone_required', status: 400 };
    if (!['member', 'trainer', 'gym_operator', 'vendor', 'admin'].includes(userType)) {
      return { error: 'invalid_userType', status: 400 };
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    otps.upsert(o => o.phone === phone, { phone, code, userType, expiresAt: Date.now() + 5 * 60_000 });
    const isProd = process.env.NODE_ENV === 'production';
    return {
      ok: true,
      ...(isProd ? {} : { devOtp: code }),
      message: isProd ? 'OTP sent via SMS' : 'OTP sent (dev mode returns code in payload)',
    };
  }

  async function verifyOtp({ phone, code }) {
    // otps.upsert() (in requestOtp) writes synchronously to the in-memory cache and
    // persists to PG in the background — reading via findAsync() here would bypass that
    // cache and could race the background write, intermittently returning stale/empty data.
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
    return { token, user };
  }

  async function login({ email, password, requestedRole }) {
    if (!email || !password) return { error: 'email_and_password_required', status: 400 };
    const role = requestedRole ? normalizeRequestedRole(requestedRole) : null;
    const matches = await users.filterAsync(u => u.email === email);
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
    if (process.env.NODE_ENV === 'production' && user.userType !== 'vendor_staff') {
      return { error: 'use_firebase_email_password_sign_in', status: 403 };
    }
    const validPassword = user.userType === 'vendor_staff'
      ? await verifyPassword(password, user.passwordHash)
      : user.passwordHash === `demo:${password}`;
    if (!validPassword) return { error: 'invalid_credentials', status: 401 };
    const token = signJwt({
      sub: user.id,
      userType: user.userType,
      gymId: user.gymId,
      portalUser: user.portalUser || false,
      aclPermissions: user.aclPermissions || [],
      vendorId: user.vendorId,
      vendorRole: user.vendorRole,
      vendorPermissions: user.vendorPermissions || [],
    });
    const { passwordHash, ...sessionUser } = user;
    return { token, user: sessionUser };
  }

  async function firebaseSession({ idToken, requestedRole }) {
    const fb = await verifyFirebaseIdToken(idToken);
    if (!fb) return { error: 'invalid_firebase_token', status: 401 };

    // Sign-in deliberately omits requestedRole so an existing account's role
    // is resolved from FitFlex. Sign-up supplies it from the dedicated role
    // choice page. Keep member as the legacy default for a new identity.
    const hasRequestedRole = requestedRole != null && String(requestedRole).trim() !== '';
    const selfRole = hasRequestedRole ? normalizeRequestedRole(requestedRole) : null;
    const isAdminEmail = isConfiguredAdminEmail(fb.email);
    const identityMatches = await users.filterAsync(
      u => u.firebaseUid === fb.uid || Boolean(fb.email && u.email === fb.email),
    );
    const requestedUserType = isAdminEmail ? 'admin' : selfRole;
    let user = requestedUserType
      ? identityMatches.find(u => u.userType === requestedUserType)
      : identityMatches[0];

    if (!hasRequestedRole && !isAdminEmail && identityMatches.length > 1) {
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
        email: user.email || fb.email,
        displayName: fb.name || user.displayName,
        photoUrl: fb.picture || user.photoUrl,
        accountStatus: user.accountStatus || 'active',
        onboardingCompleted: user.onboardingCompleted || false,
        approvalStatus: user.approvalStatus || 'approved',
        ...(isAdminEmail ? { userType: 'admin' } : {})
      };
      user = await users.upsertAsync(u => u.id === user.id, { ...user, ...patch, updatedAt: new Date().toISOString() });
    } else {
      const newUserRole = selfRole || 'member';
      // New user: only allow creation if NOT requesting admin.
      if (newUserRole === 'admin' && !isAdminEmail) return { error: 'admin_self_registration_not_allowed', status: 403 };
      // Gym staff (receptionists etc.) must be pre-created by their gym owner.
      if (newUserRole === 'gym_staff') return { error: 'gym_staff_self_registration_not_allowed', status: 403 };
      const row = {
        id: `usr_${randomUUID().slice(0, 8)}`,
        firebaseUid: fb.uid,
        email: fb.email,
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

    // Block portal-only staff from logging in via the app's Firebase session
    if (user.portalUser === true && requestedRole !== 'admin') return { error: 'portal_user_app_access_denied', status: 403 };
    if (user.accountStatus === 'suspended') return { error: 'account_suspended', status: 403 };
    if (user.approvalStatus === 'rejected') return { error: 'profile_rejected', status: 403, approvalNote: user.approvalNote || null };

    const token = signJwt({
      sub: user.id,
      userType: user.userType,
      email: user.email,
      gymId: user.gymId,
      portalUser: user.portalUser || false,
      aclPermissions: user.aclPermissions || [],
      vendorId: user.vendorId,
      vendorRole: user.vendorRole,
      vendorPermissions: user.vendorPermissions || [],
    });
    return { token, user, pendingApproval: user.approvalStatus === 'pending_approval' };
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
    return { token, user: { ...user, publicId: devPubId, userCode: devPubId }, pendingApproval: false };
  }

  return { requestOtp, verifyOtp, login, firebaseSession, devLogin };
}
