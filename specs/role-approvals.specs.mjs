import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminDecideRoleApproval, adminRoleApprovals } from '../functions/admin-approvals.mjs';
import { authFirebaseSession } from '../functions/auth.mjs';

function devToken(payload) {
  return `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function res() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('admin can list and approve pending owner, trainer or vendor profiles', async () => {
  const email = `approval-${Date.now()}@example.com`;
  const created = res();
  await authFirebaseSession.onRequest({
    body: {
      idToken: devToken({ uid: `fb_approval_${Date.now()}`, email, name: 'Approval User' }),
      requestedRole: 'vendor'
    }
  }, created);
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.user.userType, 'vendor');
  assert.equal(created.body.user.approvalStatus, 'pending_approval');

  const list = res();
  await adminRoleApprovals.onRequest({ query: { status: 'pending_approval' } }, list);
  assert.equal(list.statusCode, 200);
  assert.ok(list.body.some(u => u.email === email));

  const decided = res();
  await adminDecideRoleApproval.onRequest({
    user: { sub: 'usr_admin_1', userType: 'admin' },
    params: { id: created.body.user.id },
    body: { decision: 'approve', note: 'Pilot accepted' }
  }, decided);

  assert.equal(decided.statusCode, 200);
  assert.equal(decided.body.approvalStatus, 'approved');
});
