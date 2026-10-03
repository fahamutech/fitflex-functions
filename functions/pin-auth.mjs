// Identity V2 · I7a — sign in with a mobile number or email and a PIN.
// Both routes answer 404 unless IDENTITY_V2 + V2_PIN_LOGIN are on.
import '../src/bootstrap/init.mjs';
import { pinAuthService, partnerVerifiedFor } from '../src/bootstrap/services.mjs';
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
