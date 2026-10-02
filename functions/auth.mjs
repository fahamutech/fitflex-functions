// Auth REST surface — thin controllers delegating to authService.
import '../src/bootstrap/init.mjs';
import { authService } from '../src/bootstrap/services.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { orgAuthzStats } from '../src/auth/org-authz.mjs';

const created = new Date().toISOString();

// The phone OTP endpoints have no SMS delivery and no client uses them. Until
// phone sign-in moves to Firebase (Identity V2), they are closed in production.
function otpDisabled(res) {
  if (process.env.NODE_ENV !== 'production') return false;
  res.status(404).json({ error: 'not_found' });
  return true;
}

export const authRequestOtp = {
  created, method: 'post', path: '/auth/otp/request',
  description: 'Request a phone OTP. Returns the OTP in dev mode (replace with SMS in prod).',
  requestSample: { phone: '+255712345678', userType: 'member' },
  responseSample: { ok: true, devOtp: '123456' },
  onRequest: async (req, res) => {
    if (otpDisabled(res)) return;
    const { phone, userType = 'member' } = req.body || {};
    const result = await authService.requestOtp({ phone, userType });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const authVerifyOtp = {
  created, method: 'post', path: '/auth/otp/verify',
  description: 'Verify OTP, create user if new, return JWT.',
  requestSample: { phone: '+255712345678', code: '123456' },
  responseSample: { token: 'jwt...', user: { id: 'usr_x', userType: 'member' } },
  onRequest: async (req, res) => {
    if (otpDisabled(res)) return;
    const { phone, code } = req.body || {};
    const result = await authService.verifyOtp({ phone, code });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const authLogin = {
  created, method: 'post', path: '/auth/login',
  description: 'Email+password login for portal-only admin users. Uses Firebase idToken verification path for production; demo hash in dev.',
  requestSample: { email: 'staff@fitflex.af', password: 'securepassword' },
  responseSample: { token: 'jwt...', user: { id: 'usr_x', userType: 'admin' } },
  onRequest: async (req, res) => {
    const { email, password, requestedRole } = req.body || {};
    const result = await authService.login({ email, password, requestedRole });
    if (result.error) {
      return res.status(result.status).json({
        error: result.error,
        ...(result.availableRoles ? { availableRoles: result.availableRoles } : {}),
      });
    }
    res.json(result);
  }
};

export const authFirebaseSession = {
  created, method: 'post', path: '/auth/firebase/session',
  description: 'Exchange a Firebase ID token for a FitFlex session. Firebase is identity only; FitFlex stores roles. With existingOnly: true nothing is ever created: 404 profile_not_found when this identity has no profile of the requested role (the portal uses it to sign in gym owners and staff).',
  requestSample: { idToken: 'firebase-id-token', requestedRole: 'member' },
  responseSample: { token: 'jwt...', user: { id: 'usr_x', userType: 'member' } },
  onRequest: async (req, res) => {
    const { idToken, requestedRole, existingOnly } = req.body || {};
    const client = req.headers?.['x-fitflex-client'] || null;
    const result = await authService.firebaseSession({ idToken, requestedRole, client, existingOnly: existingOnly === true });
    if (result.error) {
      const body = { error: result.error };
      if (result.existingRole) { body.existingRole = result.existingRole; body.requestedRole = result.requestedRole; }
      if (result.availableRoles) body.availableRoles = result.availableRoles;
      if (result.approvalNote !== undefined) body.approvalNote = result.approvalNote;
      return res.status(result.status).json(body);
    }
    res.json(result);
  }
};

// ───────────────────────────── Identity V2 · I2: personas ─────────────────────────────────
// Both answer 404 unless IDENTITY_V2 and V2_PERSONAS are on.

function sendResult(res, result) {
  if (result.error) {
    const { error, status, approvalNote } = result;
    return res.status(status).json({ error, ...(approvalNote !== undefined ? { approvalNote } : {}) });
  }
  res.json(result);
}

export const myPersonas = {
  created, method: 'get', path: '/me/personas',
  description: 'Identity V2: the caller\'s Person and personas (User rows).',
  onGuard: requireAuth(),
  onRequest: async (req, res) => sendResult(res, await authService.myPersonas({ claims: req.user })),
};

export const adminOrgAuthzReport = {
  created, method: 'get', path: '/admin/identity/org-authz',
  description: 'Admin: Identity V2 organisation-authorisation mode and, in shadow/enforce, how often the membership decision disagreed with the legacy one since this process started (per route).',
  onGuard: [requireAuth('admin'), requireAcl('settings')],
  onRequest: async (_req, res) => res.json(orgAuthzStats()),
};

export const myMemberships = {
  created, method: 'get', path: '/me/memberships',
  description: 'Identity V2: the caller\'s organisation relationships across gyms, vendors and companies (?includeEnded=1 for history). 404 unless V2_ORG_WRITE is on.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => sendResult(res, await authService.myMemberships({
    claims: req.user, includeEnded: ['1', 'true'].includes(String(req.query?.includeEnded ?? '')),
  })),
};

export const addMyPersona = {
  created, method: 'post', path: '/me/personas',
  description: 'Identity V2: add a persona (member, trainer, gym_operator, vendor) to the caller\'s own Person. 404 unless V2_ADD_PERSONA is on.',
  requestSample: { userType: 'trainer' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const result = await authService.addPersona({ claims: req.user, userType: req.body?.userType });
    if (result.error) {
      const { error, status, allowed } = result;
      return res.status(status).json({ error, ...(allowed ? { allowed } : {}) });
    }
    res.status(result.created ? 201 : 200).json(result);
  },
};

export const authSwitchPersona = {
  created, method: 'post', path: '/auth/switch-persona',
  description: 'Identity V2: mint a session for another persona of the same Person.',
  requestSample: { personaId: 'usr_x' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => sendResult(res, await authService.switchPersona({ claims: req.user, personaId: req.body?.personaId })),
};

// ───────────────────────────── Dev-only test data cleanup (blackbox testing) ──────────────
// Removes E2E-generated test data by email pattern. HARD-BLOCKED in production.
export const authDevCleanup = {
  created, method: 'post', path: '/auth/dev/cleanup',
  description: 'DEV ONLY: remove test users + related data created by E2E runs. Disabled in production.',
  requestSample: { emailPattern: '@example.com' },
  responseSample: { ok: true, removedUsers: 3 },
  onRequest: async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'dev_cleanup_disabled_in_production' });
    }
    try {
      const { emailPattern, emails } = req.body || {};
      const { users, subscriptions, checkins, trainers, trainerBookings,
              trainerEngagements, trainerSessions, shopOrders,
              marketplaceEnquiries, products } = await import('../src/bootstrap/services.mjs');

      // Find E2E users by email pattern or explicit email list
      let e2eUsers = [];
      if (emails && Array.isArray(emails)) {
        for (const email of emails) {
          const user = await users.findAsync(u => u.email === email);
          if (user) e2eUsers.push(user);
        }
      } else if (emailPattern) {
        e2eUsers = await users.filterAsync(u =>
          u.email && u.email.includes(emailPattern) &&
          // Never delete dev seed users or admin
          !u.id.startsWith('usr_dev_') && u.id !== 'usr_admin_1'
        );
      } else {
        return res.status(400).json({ error: 'provide_emailPattern_or_emails' });
      }

      const removedIds = [];
      for (const user of e2eUsers) {
        // Remove related data
        await subscriptions.removeAsync(s => s.memberId === user.id).catch(() => {});
        await checkins.removeAsync(c => c.memberId === user.id).catch(() => {});
        await trainerBookings.removeAsync(b => b.memberId === user.id || b.trainerId === user.id).catch(() => {});
        await trainerEngagements.removeAsync(e => e.memberId === user.id || e.trainerId === user.id).catch(() => {});
        await trainerSessions.removeAsync(s => s.trainerId === user.id).catch(() => {});
        await trainers.removeAsync(t => t.userId === user.id).catch(() => {});
        if (shopOrders) await shopOrders.removeAsync(o => o.memberId === user.id).catch(() => {});
        if (marketplaceEnquiries) await marketplaceEnquiries.removeAsync(e => e.memberId === user.id).catch(() => {});
        // Remove the user record itself
        await users.removeAsync(u => u.id === user.id);
        removedIds.push(user.id);
      }

      console.log(`[dev-cleanup] removed ${removedIds.length} E2E users:`, removedIds);
      res.json({ ok: true, removedUsers: removedIds.length, removedIds });
    } catch (err) {
      console.error('[dev-cleanup] error:', err.message, err.meta || '');
      res.status(500).json({ error: 'dev_cleanup_failed', detail: err.message });
    }
  }
};

// ───────────────────────────── Dev-only mock auth (blackbox testing) ──────────────────────
// Mints a FitFlex session for a deterministic test user without Firebase, and seeds the
// supporting fixtures (gym, subscription, trainer profile) so the role lands fully onboarded.
// HARD-BLOCKED in production.
export const authDevLogin = {
  created, method: 'post', path: '/auth/dev/login',
  description: 'DEV ONLY: mock login as member/trainer/gym_operator for blackbox testing. Disabled in production.',
  requestSample: { role: 'member' },
  responseSample: { token: 'jwt...', user: { id: 'usr_dev_member', userType: 'member' } },
  onRequest: async (req, res) => {
    try {
      const result = await authService.devLogin({ role: req.body?.role });
      if (result.error) {
        const body = { error: result.error };
        if (result.allowed) body.allowed = result.allowed;
        return res.status(result.status).json(body);
      }
      res.json(result);
    } catch (err) {
      console.error('[authDevLogin] error:', err.message, err.meta || '');
      res.status(500).json({ error: 'dev_login_failed', detail: err.message });
    }
  }
};
