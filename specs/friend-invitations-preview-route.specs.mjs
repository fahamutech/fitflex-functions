// Public invitation preview: POST /friend-invitations/preview { token } (the
// token stays out of URLs) and the deprecated GET /friend-invitations/preview/:token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { inviteFriend, previewFriendInvitation, previewFriendInvitationByBody } from '../functions/friend-invitations.mjs';

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
const uniq = prefix => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

async function invitationToken() {
  const userId = uniq('usr_fi_prev');
  const made = res();
  await updateMemberProfile.onRequest(
    { user: { sub: userId, userType: 'member' }, body: { displayName: 'Preview Inviter', phone: `+25571${String(Date.now()).slice(-7)}` } },
    made,
  );
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const out = res();
  await inviteFriend.onRequest({ user: { sub: userId, userType: 'member' }, headers: {}, body: { email: `${uniq('new')}@example.com` } }, out);
  assert.equal(out.statusCode, 201, JSON.stringify(out.body));
  const link = new URL(out.body.share.link);
  assert.equal(link.pathname, '/friend-invite/');
  assert.match(link.hash, /^#[A-Za-z0-9_-]{20,}$/);
  return link.hash.slice(1);
}

test('routes: POST preview is public, takes the token in the body', () => {
  assert.equal(previewFriendInvitationByBody.method, 'post');
  assert.equal(previewFriendInvitationByBody.path, '/friend-invitations/preview');
  assert.equal(previewFriendInvitationByBody.onGuard, undefined, 'unauthenticated, like the GET');
  assert.equal(previewFriendInvitation.onGuard, undefined);
  assert.match(previewFriendInvitation.description, /^Deprecated/);
});

test('POST preview: valid token → status and inviter name; same answer as the GET', async () => {
  const token = await invitationToken();
  const post = res();
  await previewFriendInvitationByBody.onRequest({ body: { token } }, post);
  assert.equal(post.statusCode, 200);
  assert.equal(post.body.invitation.status, 'pending');
  assert.equal(post.body.invitation.inviterName, 'Preview Inviter');

  const get = res();
  const req = { params: { token }, originalUrl: `/friend-invitations/preview/${token}` };
  await previewFriendInvitation.onRequest(req, get);
  assert.equal(get.statusCode, 200);
  assert.deepEqual(get.body, post.body, 'GET still works and answers the same');
  assert.ok(!req.originalUrl.includes(token), 'the request logger never sees the token');
});

test('POST preview: unknown or malformed token → 404 invalid_invitation', async () => {
  for (const token of ['x'.repeat(30), 'not a token!']) {
    const out = res();
    await previewFriendInvitationByBody.onRequest({ body: { token } }, out);
    assert.equal(out.statusCode, 404);
    assert.equal(out.body.error, 'invalid_invitation');
  }
  const get = res();
  await previewFriendInvitation.onRequest({ params: { token: 'x'.repeat(30) } }, get);
  assert.equal(get.statusCode, 404);
  assert.equal(get.body.error, 'invalid_invitation');
});

test('POST preview: missing token → 400 token_required', async () => {
  for (const body of [undefined, {}, { token: '' }, { token: '   ' }, { token: 123 }]) {
    const out = res();
    await previewFriendInvitationByBody.onRequest({ body }, out);
    assert.equal(out.statusCode, 400, JSON.stringify(body));
    assert.equal(out.body.error, 'token_required');
  }
});
