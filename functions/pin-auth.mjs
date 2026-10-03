// Identity V2 · I7a — sign in with a mobile number or email and a PIN.
// And (I7b) register with a number or email: a code, then a PIN.
// Every route answers 404 unless IDENTITY_V2 + V2_PIN_LOGIN are on.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { pinAuthService, registrationService, partnerVerifiedFor, users } from '../src/bootstrap/services.mjs';
import { identityFlag } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();

/** The caller's network address, for the per-address limit. */
function addressOf(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || null;
}

async function send(res, result) {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  if (!result.token) return res.json(result);
  res.json({ ...result, partnerVerified: await partnerVerifiedFor(result.user) });
}

export const pinLogin = {
  created, method: 'post', path: '/auth/pin/login',
  description: 'Sign in with one verified mobile number or email and the PIN. No code is sent. Wrong PINs are counted: sign-in pauses after 5 in a row (429 too_many_attempts with retryAfterSeconds) and the PIN is switched off after 10 (403 pin_reset_required). An existing user whose PIN is still only in Firebase gets { setupRequired, setupToken, verificationRequired, pinChangeRequired } and finishes with /auth/pin/setup.',
  requestSample: { phone: '0712345678', pin: '1234' },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_PIN_LOGIN')) return res.status(404).json({ error: 'not_found' });
    await send(res, await pinAuthService.login({ body: req.body || {}, ip: addressOf(req) }));
  },
};

export const pinSetup = {
  created, method: 'post', path: '/auth/pin/setup',
  description: 'Finish moving an existing user to a FitFlex-held PIN: the setup token from /auth/pin/login, the code sent to their email when one was required, and the four-digit PIN to keep. Signs them in.',
  requestSample: { setupToken: '…', code: '123456', pin: '1234' },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_PIN_LOGIN')) return res.status(404).json({ error: 'not_found' });
    await send(res, await pinAuthService.setup({ body: req.body || {} }));
  },
};

// ── Registration (I7b) ──────────────────────────────────────────────────────

export const registerStart = {
  created, method: 'post', path: '/auth/register/start',
  description: 'Start registering with one mobile number or email: FitFlex sends it a code (SMS or email). 409 already_registered when someone already signs in with it. Limited per network address and capped per day.',
  requestSample: { phone: '0712345678', locale: 'sw' },
  responseSample: { sent: true, channel: 'sms', identifierType: 'phone', identifierValue: '+255712345678', expiresInSeconds: 600, resendAfterSeconds: 60 },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_PIN_LOGIN')) return res.status(404).json({ error: 'not_found' });
    await send(res, await registrationService.start({ body: req.body || {}, ip: addressOf(req) }));
  },
};

export const registerConfirm = {
  created, method: 'post', path: '/auth/register/confirm',
  description: 'Check the code. Returns a registration token (15 minutes) that completes the registration.',
  requestSample: { phone: '0712345678', code: '123456' },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_PIN_LOGIN')) return res.status(404).json({ error: 'not_found' });
    await send(res, await registrationService.confirm({ body: req.body || {} }));
  },
};

export const registerComplete = {
  created, method: 'post', path: '/auth/register/complete',
  description: 'Finish registering: the registration token, the role (member, trainer, gym_owner or vendor) and a four-digit PIN. Creates the account with the verified number or email and signs the person in.',
  requestSample: { registrationToken: '…', role: 'member', pin: '1234', displayName: 'Neema Abdallah' },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_PIN_LOGIN')) return res.status(404).json({ error: 'not_found' });
    await send(res, await registrationService.complete({ body: req.body || {} }));
  },
};

// ── Forgot PIN and change PIN (I7c) ─────────────────────────────────────────
// Forgot PIN answers 404 unless IDENTITY_V2 + V2_RECOVERY are on; change PIN
// follows V2_PIN_LOGIN.

export const pinResetStart = {
  created, method: 'post', path: '/auth/pin/reset/start',
  description: 'Forgot PIN: send a code to the mobile number or email the person signs in with. The answer is the same whether or not an account uses it. Limited per network address.',
  requestSample: { phone: '0712345678', locale: 'sw' },
  responseSample: { sent: true, channel: 'sms', identifierType: 'phone', identifierValue: '+255712345678', expiresInSeconds: 600, resendAfterSeconds: 60 },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_RECOVERY')) return res.status(404).json({ error: 'not_found' });
    await send(res, await pinAuthService.resetStart({ body: req.body || {}, ip: addressOf(req) }));
  },
};

export const pinResetConfirm = {
  created, method: 'post', path: '/auth/pin/reset/confirm',
  description: 'Forgot PIN: check the code. Returns a reset token (15 minutes) that sets the new PIN once.',
  requestSample: { phone: '0712345678', code: '123456' },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_RECOVERY')) return res.status(404).json({ error: 'not_found' });
    await send(res, await pinAuthService.resetConfirm({ body: req.body || {} }));
  },
};

export const pinResetComplete = {
  created, method: 'post', path: '/auth/pin/reset/complete',
  description: 'Forgot PIN: set the new four-digit PIN. Clears any lockout, signs every other device out, and signs the person in.',
  requestSample: { resetToken: '…', pin: '1234' },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_RECOVERY')) return res.status(404).json({ error: 'not_found' });
    await send(res, await pinAuthService.resetComplete({ body: req.body || {} }));
  },
};

export const changeMyPin = {
  created, method: 'post', path: '/me/pin',
  description: 'Change the PIN: the current one and a new four-digit one. Wrong current PINs count toward the sign-in lockout. Every earlier session ends; the response carries a new one for this device.',
  requestSample: { currentPin: '1234', newPin: '5678' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    if (!identityFlag('V2_PIN_LOGIN')) return res.status(404).json({ error: 'not_found' });
    const user = await users.findByIdAsync(req.user.sub);
    await send(res, await pinAuthService.changePin({ user, body: req.body || {}, ip: addressOf(req) }));
  },
};
