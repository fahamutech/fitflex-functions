// Identity V2 · account recovery (member path): someone who lost every
// verified number and email and forgot the PIN asks FitFlex to move the
// account to a new number or email. Every route answers 404 unless
// IDENTITY_V2 + V2_RECOVERY are on.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { accountRecoveryService, users } from '../src/bootstrap/services.mjs';
import { identityFlag } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();

const addressOf = req => String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || null;

function send(res, result) {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  res.json(result);
}
const off = res => res.status(404).json({ error: 'not_found' });

export const recoveryStart = {
  created, method: 'post', path: '/auth/recovery/start',
  description: 'Account recovery, step 1: the mobile number or email the person used to sign in ("old") and a NEW number or email ("new"). FitFlex sends a code to the new one. 404 account_not_found; 409 recovery_not_available / staff_recovery_not_available / partner_recovery_not_available (those accounts do not use this path), recovery_already_open, identifier_in_use; 429 recovery_blocked (a cancelled or refused request blocks a new one for 7 days).',
  requestSample: { old: { email: 'old@example.com' }, new: { phone: '0712345678' }, locale: 'sw' },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_RECOVERY')) return off(res);
    send(res, await accountRecoveryService.start({ body: req.body || {}, ip: addressOf(req) }));
  },
};

export const recoveryConfirm = {
  created, method: 'post', path: '/auth/recovery/confirm',
  description: 'Account recovery, step 2: the code sent to the new value and the name on the account. Records the request, tells every old number and email (with a link to cancel), and returns a requestToken and the questions to answer. A member waits 24 hours before FitFlex staff can decide.',
  requestSample: { old: { email: 'old@example.com' }, new: { phone: '0712345678' }, code: '123456', name: 'Asha Mushi' },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_RECOVERY')) return off(res);
    send(res, await accountRecoveryService.confirm({ body: req.body || {}, ip: addressOf(req) }));
  },
};

export const recoveryEvidence = {
  created, method: 'post', path: '/auth/recovery/evidence',
  description: 'Account recovery, step 3: short answers (homeGym, plan, lastCheckin, paymentRef, other) that only the owner is likely to know. Can be added while the request is open.',
  requestSample: { requestToken: '…', answers: { homeGym: 'Fit Zone Mikocheni', plan: 'Standard' } },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_RECOVERY')) return off(res);
    send(res, await accountRecoveryService.addEvidence({ body: req.body || {} }));
  },
};

export const recoveryStatus = {
  created, method: 'post', path: '/auth/recovery/status',
  description: 'Where the request stands: open (with waitUntil), refused (with a general reason), cancelled, or completed (then use Forgot PIN with the new number or email).',
  requestSample: { requestToken: '…' },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_RECOVERY')) return off(res);
    send(res, await accountRecoveryService.status({ body: req.body || {} }));
  },
};

export const recoveryCancel = {
  created, method: 'post', path: '/auth/recovery/cancel',
  description: 'The person who asked cancels their own request.',
  requestSample: { requestToken: '…' },
  onRequest: async (req, res) => {
    if (!identityFlag('V2_RECOVERY')) return off(res);
    send(res, await accountRecoveryService.cancelAsRequester({ body: req.body || {} }));
  },
};

// The link in the message sent to the old number and email. A page, not an
// API: opening it only asks; pressing the button cancels (so a link preview
// cannot cancel by accident).
const page = (title, body, form = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>FitFlex</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 20px;color:#111}
button{font-size:16px;padding:12px 20px;border:0;border-radius:10px;background:#c62828;color:#fff;width:100%}
p{line-height:1.5}</style></head><body><h2>${title}</h2>${body}${form}</body></html>`;
const html = (res, status, content) => {
  res.status(status);
  res.set?.('Content-Type', 'text/html; charset=utf-8');
  res.send(content);
};

export const recoveryCancelPage = {
  created, method: 'get', path: '/auth/recovery/cancel/:link',
  description: 'Page opened from the link in the message: asks the owner to confirm cancelling the recovery request.',
  onRequest: async (req, res) => {
    if (!identityFlag('V2_RECOVERY')) return off(res);
    html(res, 200, page(
      'Cancel the recovery request?',
      '<p>Someone asked to recover your FitFlex account and move it to a new number or email. If this was not you, cancel it.</p>'
      + '<p>Kuna mtu ameomba kurejesha akaunti yako ya FitFlex. Kama si wewe, ighairi.</p>',
      `<form method="post"><button type="submit">Cancel the request / Ighairi</button></form>`,
    ));
  },
};

export const recoveryCancelByLink = {
  created, method: 'post', path: '/auth/recovery/cancel/:link',
  description: 'The owner cancels the recovery request using the link they were sent.',
  onRequest: async (req, res) => {
    if (!identityFlag('V2_RECOVERY')) return off(res);
    const result = await accountRecoveryService.cancelWithLink(req.params.link);
    if (result.error) return html(res, 404, page('This link is not valid', '<p>It may have been mistyped.</p>'));
    html(res, 200, result.cancelled
      ? page('Request cancelled', '<p>The recovery request was cancelled. Your account was not changed.</p><p>Ombi limeghairiwa. Akaunti yako haijabadilishwa.</p>')
      : page('Nothing to cancel', '<p>This request was already finished.</p>'));
  },
};

async function caller(req, res) {
  if (!identityFlag('V2_RECOVERY')) { off(res); return null; }
  const user = await users.findByIdAsync(req.user.sub);
  if (!user?.personId) { res.status(404).json({ error: 'user_not_found' }); return null; }
  return user;
}

export const myRecovery = {
  created, method: 'get', path: '/me/recovery',
  description: 'Is a recovery request open on the caller\'s account? Shown as a banner on a device that is still signed in, with a way to cancel.',
  responseSample: { open: true, waitUntil: '2026-10-06T08:00:00.000Z', newIdentifierType: 'phone', newIdentifier: '+255•••••678' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await caller(req, res);
    if (user) send(res, await accountRecoveryService.mine({ user }));
  },
};

export const cancelMyRecovery = {
  created, method: 'post', path: '/me/recovery/cancel',
  description: 'The owner, signed in, cancels an open recovery request on their account.',
  onGuard: requireAuth(),
  onRequest: async (req, res) => {
    const user = await caller(req, res);
    if (user) send(res, await accountRecoveryService.cancelAsOwner({ user }));
  },
};

// ── FitFlex admin ───────────────────────────────────────────────────────────

const guard = [requireAuth('admin'), requireAcl('account_recovery')];
const adminOn = (req, res) => (identityFlag('V2_RECOVERY') ? true : (off(res), false));

export const adminRecoveries = {
  created, method: 'get', path: '/admin/account-recoveries',
  description: 'Admin: account recovery requests. ?status=open (default) | cancelled | refused | completed | all.',
  onGuard: guard,
  onRequest: async (req, res) => {
    if (adminOn(req, res)) send(res, await accountRecoveryService.list({ status: req.query?.status || 'open' }));
  },
};

export const adminRecovery = {
  created, method: 'get', path: '/admin/account-recoveries/:id',
  description: 'Admin: one request with the answers given, facts about the account to compare them with (plan, home gym, recent check-ins and payments, masked numbers and emails) and its trail. Viewing is recorded.',
  onGuard: guard,
  onRequest: async (req, res) => {
    if (adminOn(req, res)) send(res, await accountRecoveryService.detail({ id: req.params.id, actorId: req.user.sub }));
  },
};

export const adminRecoveryNote = {
  created, method: 'post', path: '/admin/account-recoveries/:id/note',
  description: 'Admin: add a note to the trail, for example that the member\'s gym confirmed they know them.',
  requestSample: { note: 'Home gym front desk confirmed by phone.' },
  onGuard: guard,
  onRequest: async (req, res) => {
    if (adminOn(req, res)) send(res, await accountRecoveryService.addNote({ id: req.params.id, note: req.body?.note, actorId: req.user.sub }));
  },
};

export const adminDecideRecovery = {
  created, method: 'post', path: '/admin/account-recoveries/:id/decision',
  description: 'Admin: approve or refuse. Approve only after the waiting period (409 waiting_period_not_over) and once the person has answered (409 evidence_missing); it moves the account to the new number or email, removes the old PIN and ends every session. Refuse needs a reason: evidence_insufficient | details_do_not_match | other. Nobody sets or sees a PIN.',
  requestSample: { decision: 'refuse', reason: 'evidence_insufficient', note: 'Could not match the payment reference.' },
  onGuard: guard,
  onRequest: async (req, res) => {
    if (!adminOn(req, res)) return;
    const { decision, reason, note } = req.body || {};
    send(res, await accountRecoveryService.decide({ id: req.params.id, decision, reason, note, actorId: req.user.sub }));
  },
};
