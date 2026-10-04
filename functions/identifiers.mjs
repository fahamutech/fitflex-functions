// Identity V2 · I6a — the caller's verified identifiers.
// Every route answers 404 unless IDENTITY_V2 + V2_IDENTIFIERS are on.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { identifierService, identifierChangeService, users } from '../src/bootstrap/services.mjs';
import { identityFlag } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();

function send(res, result) {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  res.json(result);
}

async function caller(req, res) {
  if (!identityFlag('V2_IDENTIFIERS')) { res.status(404).json({ error: 'not_found' }); return null; }
  const user = await users.findByIdAsync(req.user.sub);
  if (!user?.personId) { res.status(404).json({ error: 'user_not_found' }); return null; }
  return user;
}

export const myIdentifiers = {
  created, method: 'get', path: '/me/identifiers',
  description: 'The caller\'s verified emails and phone numbers, and the profile values not verified yet.',
  responseSample: { identifiers: [{ type: 'email', value: 'person@example.com', verified: true }], unverified: [{ type: 'phone', value: '+255712345678' }] },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await caller(req, res);
    if (user) send(res, await identifierService.list({ user }));
  },
};

export const requestIdentifierCode = {
  created, method: 'post', path: '/me/identifiers/verify/request',
  description: 'Send a FitFlex verification code to one phone (by SMS) or email (by email) the caller wants to prove is theirs. Limited per identifier and per person. 409 identifier_in_use when another person has already verified that value; 503 sms_not_configured / email_not_configured until a provider is set. Optional locale: en | sw.',
  requestSample: { phone: '0712345678', locale: 'sw' },
  responseSample: { sent: true, channel: 'sms', identifierType: 'phone', identifierValue: '+255712345678', expiresInSeconds: 600, resendAfterSeconds: 60 },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await caller(req, res);
    if (user) send(res, await identifierService.requestCode({ user, body: req.body || {} }));
  },
};

export const confirmIdentifierCode = {
  created, method: 'post', path: '/me/identifiers/verify/confirm',
  description: 'Check the code. On success the phone or email is verified on the caller\'s Person and open invitations addressed to it are claimed. A code expires, and stops working after a few wrong tries.',
  requestSample: { phone: '0712345678', code: '123456' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await caller(req, res);
    if (user) send(res, await identifierService.confirmCode({ user, body: req.body || {} }));
  },
};

// ── Changing an identifier (I7e) — 404 unless IDENTITY_V2 + V2_RECOVERY ─────

const addressOf = req => String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;

async function changer(req, res) {
  if (!identityFlag('V2_RECOVERY')) { res.status(404).json({ error: 'not_found' }); return null; }
  const user = await users.findByIdAsync(req.user.sub);
  if (!user?.personId) { res.status(404).json({ error: 'user_not_found' }); return null; }
  return user;
}

export const requestIdentifierChange = {
  created, method: 'post', path: '/me/identifiers/change/request',
  description: 'Replace the mobile number or email the caller signs in with: their PIN and the new value. FitFlex sends a code to the new value. A wrong PIN counts toward the sign-in lockout. 409 identifier_in_use when someone else signs in with it; 409 nothing_to_change when the caller has none of that kind yet (use the verify routes to add one).',
  requestSample: { phone: '0712345678', pin: '1234', locale: 'sw' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await changer(req, res);
    if (user) send(res, await identifierChangeService.request({ user, body: req.body || {}, ip: addressOf(req) }));
  },
};

export const confirmIdentifierChange = {
  created, method: 'post', path: '/me/identifiers/change/confirm',
  description: 'Check the code sent to the new mobile number or email. It replaces the old one of the same kind, which stops signing in at once and is told about the change.',
  requestSample: { phone: '0712345678', code: '123456', locale: 'sw' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await changer(req, res);
    if (user) send(res, await identifierChangeService.confirm({ user, body: req.body || {} }));
  },
};
