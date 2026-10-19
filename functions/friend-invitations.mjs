// Friend invitations: find someone by email / phone, invite them (a request
// for a member, a share link for someone not on FitFlex yet), and answer
// requests from Notifications. FitFlex sends nothing outside the app.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { friendInvitationService as svc } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const member = requireAuth('member');
const me = req => req.user.sub;
const locale = req => (String(req.headers?.['accept-language'] || req.body?.locale || '').toLowerCase().startsWith('sw') ? 'sw' : 'en');

function send(res, result, ok = 200) {
  if (result.error) return res.status(result.status).json({ error: result.error, ...(result.invitation ? { invitation: result.invitation } : {}), ...(result.contactType ? { contactType: result.contactType } : {}) });
  res.status(ok).json(result);
}
const route = (method, path, description, handler, guard = member, okStatus = 200) => ({
  created, method, path, description, onGuard: guard,
  onRequest: async (req, res) => send(res, await handler(req), okStatus),
});

export const friendLookup = route('get', '/me/friend-invitations/lookup', 'Member: what exists for an email or phone (?email= | ?phone=): a member or nobody.', req => svc.lookup(me(req), { email: req.query?.email, phone: req.query?.phone }));
export const friendInvitations = route('get', '/me/friend-invitations', 'Member: requests to answer (incoming) and the ones you sent (outgoing).', req => svc.list(me(req)));
export const inviteFriend = route('post', '/me/friend-invitations', 'Member: invite by { userId } | { email } | { phone }. For someone not on FitFlex returns { share: { link, text, subject } } to open the share sheet with — nothing is sent by FitFlex.', req => svc.invite(me(req), req.body || {}, { locale: locale(req) }), member, 201);
export const approveFriendInvitation = route('post', '/me/friend-invitations/:id/approve', 'Member: approve a request addressed to you — creates the friendship. Idempotent.', req => svc.approve(me(req), req.params.id));
export const rejectFriendInvitation = route('post', '/me/friend-invitations/:id/reject', 'Member: reject a request addressed to you. Creates no friendship. Idempotent.', req => svc.reject(me(req), req.params.id));
export const revokeFriendInvitation = route('delete', '/me/friend-invitations/:id', 'Member: withdraw an invitation you sent.', req => svc.revoke(me(req), req.params.id));
export const claimFriendInvitation = route('post', '/me/friend-invitations/claim', 'Member: opened an invitation link. { token } — attaches it to you only if you have verified the email / phone it was made for.', req => svc.claim(me(req), req.body?.token));
// Invitation links carry the token in the URL fragment (/friend-invite/#<token>),
// so it never reaches the hosting/CDN logs. The app reads it and asks here.
// POST keeps the token in the body: bfast-function's request logger (morgan
// 'dev') prints method + URL only, never the body.
export const previewFriendInvitationByBody = {
  created, method: 'post', path: '/friend-invitations/preview',
  description: 'Public: what an invitation link is for (status and inviter name only). Body { token }. Preferred over GET /friend-invitations/preview/:token so the token stays out of URL logs.',
  onRequest: async (req, res) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || !token.trim()) return res.status(400).json({ error: 'token_required' });
    return send(res, await svc.preview(token.trim()));
  },
};
// Deprecated: kept for installed app builds that still call it. The token is
// in the path, so hide it from the in-process request logger (it logs
// req.originalUrl when the response finishes; routing is already done).
export const previewFriendInvitation = {
  created, method: 'get', path: '/friend-invitations/preview/:token',
  description: 'Deprecated (use POST /friend-invitations/preview with { token }). Public: what an invitation link is for (status and inviter name only).',
  onRequest: async (req, res) => {
    const token = req.params?.token;
    if (typeof req.originalUrl === 'string') req.originalUrl = '/friend-invitations/preview/[redacted]';
    return send(res, await svc.preview(token));
  },
};
