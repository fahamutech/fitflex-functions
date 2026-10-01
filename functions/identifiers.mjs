// Identity V2 · I6a — the caller's verified identifiers.
// Every route answers 404 unless IDENTITY_V2 + V2_IDENTIFIERS are on.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { identifierService, users } from '../src/bootstrap/services.mjs';
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

export const verifyMyIdentifier = {
  created, method: 'post', path: '/me/identifiers/verify',
  description: 'Record what Firebase has verified for the caller. The app verifies the phone (Firebase Phone Authentication, linked to the signed-in Firebase account) or the email, then sends a fresh ID token. Open invitations addressed to a newly verified identifier are claimed. 409 identifier_in_use when another person has already verified that value.',
  requestSample: { idToken: '<fresh Firebase ID token>' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await caller(req, res);
    if (user) send(res, await identifierService.verify({ user, idToken: req.body?.idToken }));
  },
};
