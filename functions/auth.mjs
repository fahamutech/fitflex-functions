// Auth REST surface — thin controllers delegating to authService.
import '../src/bootstrap/init.mjs';
import { authService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const authRequestOtp = {
  created, method: 'post', path: '/auth/otp/request',
  description: 'Request a phone OTP. Returns the OTP in dev mode (replace with SMS in prod).',
  requestSample: { phone: '+255712345678', userType: 'member' },
  responseSample: { ok: true, devOtp: '123456' },
  onRequest: (req, res) => {
    const { phone, userType = 'member' } = req.body || {};
    const result = authService.requestOtp({ phone, userType });
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
    const { email, password } = req.body || {};
    const result = await authService.login({ email, password });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const authFirebaseSession = {
  created, method: 'post', path: '/auth/firebase/session',
  description: 'Exchange a Firebase ID token for a FitFlex session. Firebase is identity only; FitFlex stores roles.',
  requestSample: { idToken: 'firebase-id-token', requestedRole: 'member' },
  responseSample: { token: 'jwt...', user: { id: 'usr_x', userType: 'member' } },
  onRequest: async (req, res) => {
    const { idToken, requestedRole } = req.body || {};
    const result = await authService.firebaseSession({ idToken, requestedRole });
    if (result.error) {
      const body = { error: result.error };
      if (result.existingRole) { body.existingRole = result.existingRole; body.requestedRole = result.requestedRole; }
      if (result.approvalNote !== undefined) body.approvalNote = result.approvalNote;
      return res.status(result.status).json(body);
    }
    res.json(result);
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
