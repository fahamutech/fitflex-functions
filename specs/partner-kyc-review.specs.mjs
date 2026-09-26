// Partner KYC submission and review against the CI database: a partner
// submits once ready, a reviewer claims the case, reviews documents and
// payout accounts, and decides. The decision drives the approval flags the
// apps already read, and the partner hears about it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { partnerKycService as svc, adminApprovalService, trainers } from '../src/bootstrap/services.mjs';
import { ensureInit } from '../functions/index.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { myKycSubmit, adminKycDecision } from '../functions/partner-kyc.mjs';

// Trainer profiles are a primed collection; create them through it, as the app does.
await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const users = [];

async function makeUser(userType) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `KYC review ${userType}`, approvalStatus: 'pending_approval', updatedAt: new Date() });
  users.push(id);
  return id;
}

const reviewer = async (extra = {}) => ({ id: await makeUser('admin'), role: 'admin', superAdmin: true, ...extra });

const FILE = { storageProvider: 'zebra', storageKey: 'bafy-review', mimeType: 'application/pdf', sizeBytes: 2048, sha256: 'f'.repeat(64) };

/** A trainer who has provided everything: identity, three documents with files, specialties, a payout account. */
async function readyTrainer() {
  const id = await makeUser('trainer');
  await trainers.insertAsync({ id: uid('trn'), userId: id, displayName: 'Review Trainer', specialties: ['strength'], approvalStatus: 'pending_approval' });
  const partner = await svc.partnerForUser(id);
  const actor = { id, role: 'partner' };
  await svc.upsertPerson(partner, 'principal', {
    fullName: 'Review Trainer', idType: 'nida', idNumber: '19900101-12345-00001-12', phone: '+255754000222',
    email: 'review.trainer@example.com', address: { line1: 'Mbezi Beach', city: 'Dar es Salaam' },
  }, actor);
  await svc.upsertDocumentDetails(partner, 'trainer_id', { docType: 'national_id', documentNumber: '19900101-12345-00001-12', expiresOn: '2030-01-01' }, actor);
  await svc.upsertDocumentDetails(partner, 'certification', { issuer: 'ACE', documentNumber: 'ACE-1', issuedOn: '2024-01-01', expiresOn: '2027-03-31' }, actor);
  await svc.upsertDocumentDetails(partner, 'liability_insurance', { issuer: 'Jubilee', documentNumber: 'POL-9', expiresOn: '2027-01-15' }, actor);
  const kycCase = await svc.findCase(partner);
  // Files arrive with private storage (a later phase); attach them directly here.
  await db('PartnerDocument').where('caseId', kycCase.id).update(FILE);
  const { account } = await svc.addSettlementAccount(partner, { method: 'mobile_money', provider: 'mpesa', accountName: 'Review Trainer', accountNumber: '0754000222' }, actor);
  return { id, partner, actor, caseId: kycCase.id, accountId: account.id };
}

const userRow = id => db('User').where('id', id).first();
const inbox = async userId => (await db('Notification').where('userId', userId).orderBy('createdAt')).map(n => n.type);

async function acceptAllDocuments(caseId, admin) {
  for (const doc of await db('PartnerDocument').where({ caseId, status: 'pending' })) {
    const r = await svc.reviewDocument(caseId, doc.id, { decision: 'accept' }, admin);
    assert.equal(r.error, undefined, r.error);
  }
}

after(async () => {
  if (users.length) {
    await db('AuditLog').whereIn('actor', users).del();
    await db('Notification').whereIn('userId', users).del();
    await db('User').whereIn('id', users).del();
  }
});

test('a partner cannot submit until everything they provide is in', async () => {
  const id = await makeUser('trainer');
  const partner = await svc.partnerForUser(id);
  const none = await svc.submit(partner, { id, role: 'partner' });
  assert.equal(none.error, 'kyc_incomplete');
  assert.ok(none.missing.includes('identity.fullName'));
  await svc.upsertPerson(partner, 'principal', { fullName: 'Half Done' }, { id, role: 'partner' });
  const some = await svc.submit(partner, { id, role: 'partner' });
  assert.equal(some.error, 'kyc_incomplete');
  assert.ok(!some.missing.includes('identity.fullName'));
});

test('the full path: submit, claim, review documents and payout account, approve', async () => {
  const t = await readyTrainer();
  const admin = await reviewer();

  const submitted = await svc.submit(t.partner, t.actor);
  assert.equal(submitted.case.status, 'submitted');
  assert.ok(submitted.case.submittedAt);
  assert.equal((await svc.upsertPerson(t.partner, 'principal', { phone: '1' }, t.actor)).error, 'case_locked');

  const claimed = await svc.claim(t.caseId, admin);
  assert.equal(claimed.case.status, 'in_review');
  assert.equal(claimed.case.reviewerId, admin.id);

  const early = await svc.decide(t.caseId, { decision: 'approve' }, admin);
  assert.equal(early.error, 'kyc_incomplete');
  assert.ok(early.outstanding.includes('professional.certification'));
  assert.ok(early.outstanding.includes('settlement.payout_account'));

  await acceptAllDocuments(t.caseId, admin);
  const verified = await svc.reviewSettlementAccount(t.caseId, t.accountId, { decision: 'verify' }, admin);
  const account = verified.settlementAccounts.find(a => a.id === t.accountId);
  assert.deepEqual([account.status, account.isPrimary], ['verified', true]);
  const stored = await db('PartnerSettlementAccount').where('id', t.accountId).first();
  assert.ok(stored.cooldownUntil > new Date(Date.now() + 47 * 3_600_000));

  const approved = await svc.decide(t.caseId, { decision: 'approve' }, admin);
  assert.equal(approved.case.status, 'approved');
  assert.equal(approved.case.decidedBy, admin.id);
  assert.equal(approved.checklist.complete, true);
  // Review again when the first document expires.
  assert.equal(approved.case.reverifyAt.slice(0, 10), '2027-01-15');

  assert.equal((await userRow(t.id)).approvalStatus, 'approved');
  assert.equal((await db('TrainerProfile').where('userId', t.id).first()).approvalStatus, 'approved');
  assert.deepEqual(await inbox(t.id), ['kyc_submitted', 'kyc_approved']);
  const statuses = approved.events.filter(e => e.eventType === 'status_changed').map(e => e.toStatus).reverse();
  assert.deepEqual(statuses, ['draft', 'submitted', 'in_review', 'approved']);
});

test('a partner can take a submitted case back until a reviewer claims it', async () => {
  const t = await readyTrainer();
  await svc.submit(t.partner, t.actor);
  const back = await svc.withdraw(t.partner, t.actor);
  assert.equal(back.case.status, 'draft');
  await svc.submit(t.partner, t.actor);
  await svc.claim(t.caseId, await reviewer());
  assert.equal((await svc.withdraw(t.partner, t.actor)).error, 'invalid_transition');
});

test('asking for more information lets the partner fix and resubmit', async () => {
  const t = await readyTrainer();
  const admin = await reviewer();
  await svc.submit(t.partner, t.actor);
  await svc.claim(t.caseId, admin);
  const noReason = await svc.decide(t.caseId, { decision: 'request_info' }, admin);
  assert.equal(noReason.error, 'reason_code_required');
  const asked = await svc.decide(t.caseId, {
    decision: 'request_info', reasonCode: 'document_unreadable', reasonNote: 'Your certificate number is not readable.',
  }, admin);
  assert.deepEqual([asked.case.status, asked.case.reasonCode], ['info_requested', 'document_unreadable']);
  assert.equal((await userRow(t.id)).approvalStatus, 'pending_approval');
  const notice = await db('Notification').where({ userId: t.id, type: 'kyc_info_requested' }).first();
  assert.equal(notice.body, 'Your certificate number is not readable.');

  const fixed = await svc.upsertDocumentDetails(t.partner, 'certification', { documentNumber: 'ACE-2' }, t.actor);
  assert.equal(fixed.case.status, 'info_requested');
  const again = await svc.submit(t.partner, t.actor);
  assert.equal(again.case.status, 'submitted');
  assert.equal(again.case.reasonCode, null);
});

test('rejection closes the role; reopening starts a new round', async () => {
  const t = await readyTrainer();
  const admin = await reviewer();
  await svc.submit(t.partner, t.actor);
  await svc.claim(t.caseId, admin);
  await svc.decide(t.caseId, { decision: 'reject', reasonCode: 'suspected_fraud', reasonNote: 'The certificate is not genuine.' }, admin);
  const user = await userRow(t.id);
  assert.deepEqual([user.approvalStatus, user.approvalNote], ['rejected', 'The certificate is not genuine.']);
  assert.equal((await db('TrainerProfile').where('userId', t.id).first()).approvalStatus, 'rejected');

  const reopened = await svc.decide(t.caseId, { decision: 'reopen' }, admin);
  assert.deepEqual([reopened.case.status, reopened.case.round], ['draft', 2]);
  assert.equal((await userRow(t.id)).approvalStatus, 'pending_approval');
  assert.deepEqual((await inbox(t.id)).slice(-2), ['kyc_rejected', 'kyc_reopened']);
});

test('suspension keeps the role approved; reinstating needs a complete checklist again', async () => {
  const t = await readyTrainer();
  const admin = await reviewer();
  await svc.submit(t.partner, t.actor);
  await svc.claim(t.caseId, admin);
  await acceptAllDocuments(t.caseId, admin);
  await svc.reviewSettlementAccount(t.caseId, t.accountId, { decision: 'verify' }, admin);
  await svc.decide(t.caseId, { decision: 'approve' }, admin);

  const suspended = await svc.decide(t.caseId, { decision: 'suspend', reasonCode: 'document_expired', reasonNote: 'Insurance lapsed.' }, admin);
  assert.equal(suspended.case.status, 'suspended');
  assert.equal((await userRow(t.id)).approvalStatus, 'approved');

  await db('PartnerDocument').where({ caseId: t.caseId, requirementKey: 'liability_insurance' }).update({ expiresOn: '2020-01-01' });
  const blocked = await svc.decide(t.caseId, { decision: 'reinstate' }, admin);
  assert.deepEqual([blocked.error, blocked.outstanding], ['kyc_incomplete', ['professional.liability_cover']]);
  await db('PartnerDocument').where({ caseId: t.caseId, requirementKey: 'liability_insurance' }).update({ expiresOn: '2028-01-01' });
  const back = await svc.decide(t.caseId, { decision: 'reinstate' }, admin);
  assert.equal(back.case.status, 'approved');
  assert.equal(back.case.reasonCode, null);
});

test('only a super-admin can approve an incomplete case, and only with a written reason', async () => {
  const t = await readyTrainer();
  const staff = await reviewer({ superAdmin: false });
  await svc.submit(t.partner, t.actor);
  await svc.claim(t.caseId, staff);
  assert.equal((await svc.decide(t.caseId, { decision: 'approve', override: true, reasonNote: 'x' }, staff)).error, 'override_requires_super_admin');
  const boss = await reviewer();
  assert.equal((await svc.decide(t.caseId, { decision: 'approve', override: true }, boss)).error, 'override_reason_required');
  const done = await svc.decide(t.caseId, { decision: 'approve', override: true, reasonNote: 'Pilot partner, documents seen in person.' }, boss);
  assert.equal(done.case.status, 'approved');
  const event = done.events.find(e => e.toStatus === 'approved');
  assert.equal(event.data.override, true);
  assert.ok(event.data.outstanding.includes('settlement.payout_account'));
  assert.equal(event.note, 'Pilot partner, documents seen in person.');
});

test('reviewers never review their own case or verify an account they added', async () => {
  const t = await readyTrainer();
  await svc.submit(t.partner, t.actor);
  assert.equal((await svc.claim(t.caseId, { id: t.id, role: 'admin', superAdmin: true })).error, 'cannot_review_own_case');
  const admin = await reviewer();
  const { account } = await svc.addSettlementAccount(t.partner, { method: 'bank', provider: 'NMB', accountName: 'Review Trainer', accountNumber: '2010001234' }, admin);
  assert.equal((await svc.reviewSettlementAccount(t.caseId, account.id, { decision: 'verify' }, admin)).error, 'cannot_verify_own_request');
  const other = await reviewer();
  assert.equal((await svc.reviewSettlementAccount(t.caseId, account.id, { decision: 'reject' }, other)).error, 'note_required');
  const rejected = await svc.reviewSettlementAccount(t.caseId, account.id, { decision: 'reject', note: 'Name does not match.' }, other);
  assert.equal(rejected.settlementAccounts.find(a => a.id === account.id).status, 'rejected');
});

test('documents are reviewed only while the case is in review, and need their file to be accepted', async () => {
  const t = await readyTrainer();
  const admin = await reviewer();
  const [doc] = await db('PartnerDocument').where({ caseId: t.caseId, requirementKey: 'certification' });
  assert.equal((await svc.reviewDocument(t.caseId, doc.id, { decision: 'accept' }, admin)).error, 'case_not_in_review');
  await svc.submit(t.partner, t.actor);
  await svc.claim(t.caseId, admin);
  assert.equal((await svc.reviewDocument(t.caseId, doc.id, { decision: 'reject' }, admin)).error, 'note_required');
  await db('PartnerDocument').where('id', doc.id).update({ storageProvider: null, storageKey: null, mimeType: null, sizeBytes: null, sha256: null });
  assert.equal((await svc.reviewDocument(t.caseId, doc.id, { decision: 'accept' }, admin)).error, 'document_has_no_file');
  const rejected = await svc.reviewDocument(t.caseId, doc.id, { decision: 'reject', note: 'No file attached.' }, admin);
  assert.equal(rejected.documents.find(d => d.id === doc.id).status, 'rejected');
  assert.equal((await svc.reviewDocument(t.caseId, doc.id, { decision: 'accept' }, admin)).error, 'document_already_reviewed');
});

test('a second reviewer can take over a case in review', async () => {
  const t = await readyTrainer();
  const first = await reviewer();
  const second = await reviewer();
  await svc.submit(t.partner, t.actor);
  await svc.claim(t.caseId, first);
  const taken = await svc.claim(t.caseId, second);
  assert.equal(taken.case.reviewerId, second.id);
  assert.ok(taken.events.some(e => e.eventType === 'reviewer_assigned'));
});

test('the old role-approval screen defers to KYC once a partner has a case', async () => {
  const t = await readyTrainer();
  const result = await adminApprovalService.decide({ id: t.id, decision: 'approve', actorId: 'usr_admin' });
  assert.deepEqual(result, { error: 'use_kyc_review', status: 409 });
  const legacy = await makeUser('vendor');
  assert.equal((await adminApprovalService.decide({ id: legacy, decision: 'approve', actorId: 'usr_admin' })).user.approvalStatus, 'approved');
});

test('routes: a partner submits; portal staff need the kyc scope to decide', async () => {
  const t = await readyTrainer();
  const call = async (route, claims, params = {}, body = {}) => {
    const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body, query: {} };
    const out = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    for (const guard of [route.onGuard].flat()) {
      let passed = false;
      guard(req, out, () => { passed = true; });
      if (!passed) return out;
    }
    await route.onRequest(req, out);
    return out;
  };
  const submitted = await call(myKycSubmit, { sub: t.id, userType: 'trainer' });
  assert.equal(submitted.body.case.status, 'submitted');
  const staff = { sub: (await reviewer()).id, userType: 'admin', portalUser: true, aclPermissions: ['approvals'] };
  assert.equal((await call(adminKycDecision, staff, { id: t.caseId }, { decision: 'approve' })).statusCode, 403);
  const withScope = { ...staff, aclPermissions: ['kyc'] };
  const notClaimed = await call(adminKycDecision, withScope, { id: t.caseId }, { decision: 'approve' });
  assert.deepEqual([notClaimed.statusCode, notClaimed.body.error], [409, 'invalid_transition']);
});
