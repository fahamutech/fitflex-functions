// Identity V2 — invitation sign-in with a start PIN, and the step for a
// person who has no profile yet. Every route answers 404 unless
// IDENTITY_V2 + V2_PIN_LOGIN + V2_INVITES are on.
import '../src/bootstrap/init.mjs';
import { onboardingService, partnerVerifiedFor } from '../src/bootstrap/services.mjs';
import { identityFlag } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();
const on = () => identityFlag('V2_PIN_LOGIN') && identityFlag('V2_INVITES');

async function send(res, result) {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  if (!result.token) return res.json(result);
  res.json({ ...result, partnerVerified: await partnerVerifiedFor(result.user) });
}
const route = (path, description, requestSample, run) => ({
  created, method: 'post', path, description, requestSample,
  onRequest: async (req, res) => {
    if (!on()) return res.status(404).json({ error: 'not_found' });
    await send(res, await run({ body: req.body || {} }));
  },
});

export const inviteBegin = route(
  '/auth/invite/begin',
  'After signing in with an invitation\'s start PIN (POST /auth/pin/login answers { startPin, startToken }): the person gives their name and chooses their own four-digit PIN. Only now is anything created for them. Answers { onboarding, onboardingToken, invitations }.',
  { startToken: '…', displayName: 'Neema Abdallah', pin: '1234' },
  args => onboardingService.begin(args),
);

export const onboardingAccept = route(
  '/auth/onboarding/accept',
  'A person with no profile yet accepts an invitation. The invited role is created and a session in it is returned.',
  { onboardingToken: '…', invitationId: 'inv_…' },
  args => onboardingService.accept(args),
);

export const onboardingDecline = route(
  '/auth/onboarding/decline',
  'A person with no profile yet declines an invitation. Nothing is created; answers { onboarding, onboardingToken, invitations } again.',
  { onboardingToken: '…', invitationId: 'inv_…' },
  args => onboardingService.decline(args),
);

export const onboardingRole = route(
  '/auth/onboarding/role',
  'A person with no profile yet chooses how to use FitFlex (member, trainer, gym_owner or vendor), as someone registering would. Returns a session.',
  { onboardingToken: '…', role: 'member' },
  args => onboardingService.chooseRole(args),
);
