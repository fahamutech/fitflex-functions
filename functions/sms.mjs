// SMS REST surface — FitFlex admins only.
// Members get SMS through the Communication Center (campaigns and
// automations with the `sms` channel), the reminder job and verification
// codes; none of those are started from here. These routes are for checking
// the provider: is it set up, does a real message go through, what happened
// to the ones that were sent.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { smsService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const adminGuard = [requireAuth('admin'), requireAcl('communications')];

function send(res, result) {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  res.json(result);
}

export const adminSmsStatus = {
  created, method: 'get', path: '/admin/sms/status',
  description: 'Admin (communications): the SMS provider (SMS_PROVIDER), whether it is configured, the sender name, why it is off if it is (names of missing settings, never values), the verification-code provider, and how many SMS were accepted or failed in the last 24 hours.',
  responseSample: { provider: 'beem', configured: true, sender: 'INFO', verificationProvider: 'beem', last24h: { queued: 0, accepted: 12, failed: 1 } },
  onGuard: adminGuard,
  onRequest: async (_req, res) => send(res, await smsService.status()),
};

export const adminSmsTest = {
  created, method: 'post', path: '/admin/sms/test',
  description: 'Admin (communications): send one real test SMS to a number, to check the provider end to end. POST { phone }. On failure returns what the provider said (e.g. Beem 120 "Invalid Authentication Parameters"). Logged and audited.',
  requestSample: { phone: '0712345678' },
  responseSample: { ok: true, to: '+2557•• ••• 678', provider: 'beem', sender: 'INFO', providerMessageId: '4821' },
  onGuard: adminGuard,
  onRequest: async (req, res) => send(res, await smsService.testSend({ phone: req.body?.phone, actorId: req.user?.sub ?? null })),
};

export const adminSmsLogs = {
  created, method: 'get', path: '/admin/sms/logs',
  description: 'Admin (communications): the SMS log, newest first — kind (otp, reminder, campaign, test), masked number, text (verification codes are redacted), status and what the provider answered. ?status (queued|accepted|failed)&category&before (ISO time, from nextBefore)&limit (max 200)',
  onGuard: adminGuard,
  onRequest: async (req, res) => send(res, await smsService.logs(req.query || {})),
};
