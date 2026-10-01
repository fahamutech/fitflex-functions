// Identity V2 · I6 (slice A) — invitations REST surface.
// Every route answers 404 unless IDENTITY_V2 + V2_INVITES are on.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { requireGymOwner, effectiveOperator } from '../src/auth/org-authz.mjs';
import { invitationService, resolveRequestUser, users } from '../src/bootstrap/services.mjs';
import { identityFlag } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();
const gymIdsOf = operator => operator?.gymIds || (operator?.gymId ? [operator.gymId] : []);

function send(res, result, okStatus = 200) {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  res.status(okStatus).json(result);
}

/** Flag, then the operator and their authority over :gymId (via the I5 layer). */
async function gymOwnerContext(req, res) {
  if (!identityFlag('V2_INVITES')) { res.status(404).json({ error: 'not_found' }); return null; }
  const actor = effectiveOperator(req, await resolveRequestUser(req));
  if (!actor) { res.status(404).json({ error: 'user_not_found' }); return null; }
  if (!gymIdsOf(actor).includes(req.params.gymId)) { res.status(403).json({ error: 'not_your_gym' }); return null; }
  return { actor, orgType: 'gym', orgId: req.params.gymId };
}

/** Flag, then the signed-in persona and its Person. */
async function personContext(req, res) {
  if (!identityFlag('V2_INVITES')) { res.status(404).json({ error: 'not_found' }); return null; }
  const user = await users.findByIdAsync(req.user.sub);
  if (!user?.personId) { res.status(404).json({ error: 'user_not_found' }); return null; }
  return user;
}

const ownerGuard = route => [requireAuth('gym_operator'), requireGymOwner(route)];

// ── Organisation side (gym owners) ─────────────────────────────────────────

export const gymPeopleLookup = {
  created, method: 'post', path: '/orgs/gym/:gymId/people/lookup',
  description: 'Gym owner: does this exact phone or email belong to a FitFlex person? Answers { found, maskedName } only, for verified identifiers only. Rate-limited and logged.',
  requestSample: { phone: '0712345678' },
  responseSample: { found: true, maskedName: 'N**** A*******' },
  onGuard: ownerGuard('POST /orgs/gym/:gymId/people/lookup'),
  onRequest: async (req, res) => {
    const ctx = await gymOwnerContext(req, res);
    if (ctx) send(res, await invitationService.lookup({ ...ctx, body: req.body || {} }));
  },
};

export const gymCreateInvitation = {
  created, method: 'post', path: '/orgs/gym/:gymId/invitations',
  description: 'Gym owner: invite a person (by one phone or email) to join as staff or trainer. No account or credentials are created. Returns the link token once.',
  requestSample: { role: 'staff', email: 'reception@example.com', aclPermissions: ['members', 'checkins'] },
  onGuard: ownerGuard('POST /orgs/gym/:gymId/invitations'),
  onRequest: async (req, res) => {
    const ctx = await gymOwnerContext(req, res);
    if (!ctx) return;
    const result = await invitationService.create({ ...ctx, body: req.body || {} });
    send(res, result, result.created ? 201 : 200);
  },
};

export const gymListInvitations = {
  created, method: 'get', path: '/orgs/gym/:gymId/invitations',
  description: 'Gym owner: invitations sent by this gym, newest first.',
  onGuard: ownerGuard('GET /orgs/gym/:gymId/invitations'),
  onRequest: async (req, res) => {
    const ctx = await gymOwnerContext(req, res);
    if (ctx) send(res, await invitationService.listForOrg(ctx));
  },
};

export const gymCancelInvitation = {
  created, method: 'post', path: '/orgs/gym/:gymId/invitations/:invitationId/cancel',
  description: 'Gym owner: cancel an open invitation.',
  onGuard: ownerGuard('POST /orgs/gym/:gymId/invitations/:invitationId/cancel'),
  onRequest: async (req, res) => {
    const ctx = await gymOwnerContext(req, res);
    if (ctx) send(res, await invitationService.cancel({ ...ctx, invitationId: req.params.invitationId }));
  },
};

export const gymResendInvitation = {
  created, method: 'post', path: '/orgs/gym/:gymId/invitations/:invitationId/resend',
  description: 'Gym owner: issue a fresh link for an open invitation (the old link stops working). Limited per invitation.',
  onGuard: ownerGuard('POST /orgs/gym/:gymId/invitations/:invitationId/resend'),
  onRequest: async (req, res) => {
    const ctx = await gymOwnerContext(req, res);
    if (ctx) send(res, await invitationService.resend({ ...ctx, invitationId: req.params.invitationId }));
  },
};

// ── Invited person's side ──────────────────────────────────────────────────

export const myInvitations = {
  created, method: 'get', path: '/me/invitations',
  description: 'The open invitations addressed to the caller\'s Person, including ones sent to an email or phone they have since verified.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await personContext(req, res);
    if (user) send(res, await invitationService.listMine({ personId: user.personId }));
  },
};

export const openMyInvitation = {
  created, method: 'post', path: '/me/invitations/open',
  description: 'Open an invitation from its link token. Works only when the caller has verified the identifier it was sent to.',
  requestSample: { token: '…' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await personContext(req, res);
    if (user) send(res, await invitationService.open({ personId: user.personId, token: req.body?.token }));
  },
};

export const acceptMyInvitation = {
  created, method: 'post', path: '/me/invitations/:invitationId/accept',
  description: 'Accept an invitation addressed to the caller\'s Person.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await personContext(req, res);
    if (user) send(res, await invitationService.accept({ user, invitationId: req.params.invitationId }));
  },
};

export const declineMyInvitation = {
  created, method: 'post', path: '/me/invitations/:invitationId/decline',
  description: 'Decline an invitation addressed to the caller\'s Person.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await personContext(req, res);
    if (user) send(res, await invitationService.decline({ user, invitationId: req.params.invitationId }));
  },
};
