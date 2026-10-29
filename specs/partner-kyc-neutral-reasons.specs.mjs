// KYC privacy (owner decision 2026-10-22): a partner never receives a
// sensitive reason code (suspected_fraud, duplicate_partner, or any code that
// isn't a known partner-safe one) nor the reviewer's note that came with it,
// on any path — GET /me/kyc and every /me/kyc write that answers with the
// overview, the progress tracker, notifications, and the approval note shown
// at sign-in. They get reasonCode 'under_review' instead. Admins keep the
// real code and note.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../src/infra/knex-store.mjs';
import { partnerKycService as svc, trainers } from '../src/bootstrap/services.mjs';
import { ensureInit } from '../functions/index.mjs';
import { sign } from '../src/auth/jwt.mjs';
import {
  REASON_CODES, SENSITIVE_REASON_CODES, PARTNER_NEUTRAL_REASON,
  isSensitiveReason, partnerReasonCode, partnerReasonNote, partnerSafeCase,
} from '../src/shared/partner-kyc.mjs';
import { buildProgress } from '../src/shared/partner-progress.mjs';
import {
  myKyc, myKycPerson, myKycBusiness, myKycDocument, myKycAddSettlementAccount, myKycAcceptAgreement,
  myKycSubmit, myKycWithdraw, myKycAgreements,
  adminKycPartner, adminKycCase, adminKycCases, adminKycDecision, adminKycClaim,
} from '../functions/partner-kyc.mjs';

await ensureInit();
const require = createRequire(import.meta.url);
const migration = require('../db/migrations/20270120090000-kyc-partner-neutral-reasons.cjs');

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const users = [];
const cases = [];
const NOTE = 'PRIVATE-REVIEWER-NOTE-7731: the ID photo looks edited';

after(async () => {
  if (cases.length) {
    await db('PartnerSettlementAccount').whereIn('caseId', cases).del();
    await db('PartnerDocument').whereIn('caseId', cases).del();
    await db('PartnerPerson').whereIn('caseId', cases).del();
    await db('PartnerAgreement').whereIn('caseId', cases).del();
    await db('PartnerKycEvent').whereIn('caseId', cases).del();
    await db('PartnerKycCase').whereIn('id', cases).del();
  }
  for (const id of users) await trainers.removeAsync(t => t.userId === id);
  if (users.length) {
    await db('AuditLog').whereIn('actor', users).del();
    await db('Notification').whereIn('userId', users).del();
    await db('User').whereIn('id', users).del();
  }
});

async function makeUser(userType, extra = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Neutral ${userType}`, approvalStatus: 'approved', createdAt: new Date(), updatedAt: new Date(), ...extra });
  users.push(id);
  return id;
}

async function makeCase(userId, partnerType, status, extra = {}) {
  const id = uid('kyc');
  await db('PartnerKycCase').insert({ id, partnerType, userId, status, tier: 2, updatedAt: new Date(), ...extra });
  cases.push(id);
  return id;
}

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { headers: { authorization: `Bearer ${sign(claims)}` }, params, body, query, ip: '127.0.0.1' };
  const out = res();
  for (const guard of [route.onGuard].flat()) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

/** The partner's response has neither a sensitive code nor the note anywhere in it. */
function assertNeutral(body, { note = NOTE } = {}) {
  const text = JSON.stringify(body);
  for (const code of SENSITIVE_REASON_CODES) assert.ok(!text.includes(code), `partner response carries ${code}: ${text.slice(0, 400)}`);
  assert.ok(!text.includes(note), 'partner response carries the reviewer note');
}

// ── The list and the helpers ────────────────────────────────────────────────

test('sensitive list: suspected_fraud and duplicate_partner; every other catalogue code is partner-safe', () => {
  assert.deepEqual([...SENSITIVE_REASON_CODES].sort(), ['duplicate_partner', 'suspected_fraud']);
  for (const code of SENSITIVE_REASON_CODES) assert.ok(REASON_CODES.includes(code), `${code} is in the catalogue`);
  for (const code of REASON_CODES) {
    assert.equal(isSensitiveReason(code), SENSITIVE_REASON_CODES.includes(code), code);
    assert.equal(partnerReasonCode(code), SENSITIVE_REASON_CODES.includes(code) ? 'under_review' : code, code);
  }
  assert.equal(PARTNER_NEUTRAL_REASON, 'under_review');
});

test('fail closed: an unknown code is sensitive; no code stays no code', () => {
  for (const code of ['sanctions_match', 'blacklisted', 'identity_mismatch_fraud', 'under_review']) {
    assert.equal(isSensitiveReason(code), true, code);
    assert.equal(partnerReasonCode(code), 'under_review', code);
  }
  for (const empty of [null, undefined, '']) {
    assert.equal(isSensitiveReason(empty), false);
    assert.equal(partnerReasonCode(empty), null);
  }
  assert.equal(partnerReasonNote('suspected_fraud', NOTE), null);
  assert.equal(partnerReasonNote('document_unreadable', 'Re-upload please'), 'Re-upload please');
  assert.equal(partnerReasonNote(null, 'x'), 'x');
});

test('partnerSafeCase swaps code and drops the note only when sensitive', () => {
  const fraud = { id: 'k', status: 'rejected', reasonCode: 'suspected_fraud', reasonNote: NOTE };
  assert.deepEqual(partnerSafeCase(fraud), { id: 'k', status: 'rejected', reasonCode: 'under_review', reasonNote: null });
  assert.equal(fraud.reasonCode, 'suspected_fraud', 'the stored row is not changed');
  const safe = { id: 'k', status: 'info_requested', reasonCode: 'document_unreadable', reasonNote: 'Blurry' };
  assert.equal(partnerSafeCase(safe), safe);
  assert.equal(partnerSafeCase(null), null);
});

test('the migration keeps the same partner-safe list as the shared catalogue', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../db/migrations/20270120090000-kyc-partner-neutral-reasons.cjs', import.meta.url), 'utf8'));
  const listed = [...src.match(/const PARTNER_SAFE = \[([\s\S]*?)\];/)[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(listed, REASON_CODES.filter(c => !SENSITIVE_REASON_CODES.includes(c)).sort());
});

test('progress builder: sensitive rejection / suspension / changes request read as under_review', () => {
  const user = { id: 'u', userType: 'trainer', approvalStatus: 'approved', createdAt: new Date() };
  const suspended = buildProgress({
    user, kycCase: { status: 'suspended', reasonCode: 'duplicate_partner' }, checklist: { missing: [] },
    eligibility: { ok: false, reason: 'kyc_suspended' },
  });
  assert.deepEqual(suspended.steps[2], { key: 'verified', state: 'blocked', reason: 'under_review' });
  assert.deepEqual(suspended.steps[3], { key: 'payoutReady', state: 'blocked', reason: 'under_review' });
  assert.deepEqual(suspended.nextAction, { code: 'contact_support', reason: 'under_review' });

  const asked = buildProgress({ user, kycCase: { status: 'info_requested', reasonCode: 'suspected_fraud' }, checklist: { missing: [] } });
  assert.deepEqual(asked.nextAction, { code: 'kyc_changes_requested', reasonCode: 'under_review', missing: [] });

  // Partner-safe reasons are unchanged.
  const plain = buildProgress({
    user, kycCase: { status: 'suspended', reasonCode: 'document_expired' }, checklist: { missing: [] },
    eligibility: { ok: false, reason: 'kyc_suspended' },
  });
  assert.deepEqual(plain.nextAction, { code: 'contact_support', reason: 'kyc_suspended' });
});

// ── Partner paths against the database ─────────────────────────────────────

for (const [status, code] of [['rejected', 'suspected_fraud'], ['suspended', 'suspected_fraud'], ['info_requested', 'suspected_fraud'], ['suspended', 'duplicate_partner']]) {
  test(`GET /me/kyc: ${status} with ${code} → under_review, no note (progress on and off)`, async () => {
    const saved = process.env.PARTNER_PROGRESS;
    try {
      for (const flag of ['on', 'off']) {
        process.env.PARTNER_PROGRESS = flag;
        const id = await makeUser('trainer');
        await makeCase(id, 'trainer', status, { reasonCode: code, reasonNote: NOTE });
        const r = await call(myKyc, { claims: { sub: id, userType: 'trainer' } });
        assert.equal(r.statusCode, 200, JSON.stringify(r.body));
        assert.equal(r.body.case.status, status);
        assert.equal(r.body.case.reasonCode, 'under_review');
        assert.equal(r.body.case.reasonNote, null);
        assertNeutral(r.body);
        if (flag === 'on') assert.ok(r.body.progress, 'progress is there with the flag on');
      }
    } finally {
      if (saved === undefined) delete process.env.PARTNER_PROGRESS; else process.env.PARTNER_PROGRESS = saved;
    }
  });
}

test('GET /me/kyc: a partner-safe reason and its note still reach the partner', async () => {
  const id = await makeUser('trainer');
  await makeCase(id, 'trainer', 'info_requested', { reasonCode: 'document_unreadable', reasonNote: 'Please re-upload a sharper photo.' });
  const r = await call(myKyc, { claims: { sub: id, userType: 'trainer' } });
  assert.equal(r.body.case.reasonCode, 'document_unreadable');
  assert.equal(r.body.case.reasonNote, 'Please re-upload a sharper photo.');
});

test('every /me/kyc write that answers with the overview is neutral too', async () => {
  const id = await makeUser('gym_operator');
  // info_requested: the partner may still edit, so every write path answers.
  await makeCase(id, 'gym_owner', 'info_requested', { reasonCode: 'suspected_fraud', reasonNote: NOTE });
  const claims = { sub: id, userType: 'gym_operator' };
  const answers = [
    await call(myKycBusiness, { claims, body: { legalName: 'Neutral Gym Ltd' } }),
    await call(myKycPerson, { claims, params: { role: 'principal' }, body: { fullName: 'Neutral Owner' } }),
    await call(myKycDocument, { claims, params: { requirementKey: 'owner_id' }, body: { docType: 'national_id', documentNumber: '1990-1' } }),
    await call(myKycAddSettlementAccount, { claims, body: { method: 'mobile_money', provider: 'mpesa', accountName: 'Neutral Owner', accountNumber: '0754000777' } }),
    await call(myKycAgreements, { claims }),
    await call(myKycSubmit, { claims }),
  ];
  const agreements = answers[4].body.agreements;
  answers.push(await call(myKycAcceptAgreement, { claims, body: { agreementType: agreements[0].agreementType, version: agreements[0].version } }));
  for (const r of answers) {
    assert.ok(r.body, 'answered');
    assertNeutral(r.body);
    if (r.body.case) assert.equal(r.body.case.reasonCode, 'under_review');
  }
});

test('withdraw answers neutral (and a submitted case carries no reason at all)', async () => {
  const id = await makeUser('trainer');
  await makeCase(id, 'trainer', 'submitted', { reasonCode: 'suspected_fraud', reasonNote: NOTE });
  const r = await call(myKycWithdraw, { claims: { sub: id, userType: 'trainer' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assertNeutral(r.body);
});

// ── A real decision: notification, approval note, admin views ───────────────

async function caseInReview(userType, partnerType) {
  const id = await makeUser(userType, { approvalStatus: userType === 'vendor' ? 'pending_approval' : 'approved' });
  if (userType === 'trainer') await trainers.insertAsync({ id: uid('trn'), userId: id, displayName: 'Neutral Trainer', specialties: ['strength'], approvalStatus: 'approved' });
  const caseId = await makeCase(id, partnerType, 'in_review');
  return { id, caseId };
}

const adminClaims = async () => ({ sub: await makeUser('admin'), userType: 'admin' });
const latestNotification = async userId => db('Notification').where('userId', userId).orderBy('createdAt', 'desc').first();

test('reject for suspected_fraud: partner told "under review — contact support"; no code or note in push, inbox, approval note or sign-in', async () => {
  const { id, caseId } = await caseInReview('vendor', 'vendor');
  const admin = await adminClaims();
  const r = await call(adminKycDecision, { claims: admin, params: { id: caseId }, body: { decision: 'reject', reasonCode: 'suspected_fraud', reasonNote: NOTE } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));

  // Admin keeps the real code and note.
  assert.equal(r.body.case.reasonCode, 'suspected_fraud');
  assert.equal(r.body.case.reasonNote, NOTE);
  const event = r.body.events.find(e => e.toStatus === 'rejected');
  assert.deepEqual([event.reasonCode, event.note], ['suspected_fraud', NOTE]);

  // The notification is neutral, with Swahili.
  const n = await latestNotification(id);
  assert.equal(n.type, 'kyc_rejected');
  assert.equal(n.title, 'Verification under review');
  assert.match(n.body, /contact FitFlex support/);
  assert.equal(n.data.reasonCode, 'under_review');
  assert.equal(n.data.titleSw, 'Uthibitishaji unakaguliwa');
  assert.ok(n.data.bodySw);
  assertNeutral(n);

  // The approval note the partner sees at sign-in carries nothing.
  const user = await db('User').where('id', id).first();
  assert.equal(user.approvalStatus, 'rejected');
  assert.equal(user.approvalNote, null);
});

test('suspend for duplicate_partner and request_info for suspected_fraud: neutral notifications', async () => {
  const admin = await adminClaims();
  const a = await caseInReview('trainer', 'trainer');
  await db('PartnerKycCase').where('id', a.caseId).update({ status: 'approved' });
  const s = await call(adminKycDecision, { claims: admin, params: { id: a.caseId }, body: { decision: 'suspend', reasonCode: 'duplicate_partner', reasonNote: NOTE } });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  const ns = await latestNotification(a.id);
  assert.deepEqual([ns.type, ns.title], ['kyc_suspended', 'Verification under review']);
  assertNeutral(ns);

  const b = await caseInReview('trainer', 'trainer');
  const q = await call(adminKycDecision, { claims: admin, params: { id: b.caseId }, body: { decision: 'request_info', reasonCode: 'suspected_fraud', reasonNote: NOTE } });
  assert.equal(q.statusCode, 200, JSON.stringify(q.body));
  const nq = await latestNotification(b.id);
  assert.deepEqual([nq.type, nq.title], ['kyc_info_requested', 'Verification under review']);
  assertNeutral(nq);

  // The partner's own view afterwards.
  const mine = await call(myKyc, { claims: { sub: b.id, userType: 'trainer' } });
  assert.equal(mine.body.case.reasonCode, 'under_review');
  assertNeutral(mine.body);
});

test('a partner-safe decision keeps today\'s message and note', async () => {
  const { id, caseId } = await caseInReview('trainer', 'trainer');
  const admin = await adminClaims();
  await call(adminKycDecision, { claims: admin, params: { id: caseId }, body: { decision: 'request_info', reasonCode: 'document_unreadable', reasonNote: 'Your certificate is blurry.' } });
  const n = await latestNotification(id);
  assert.deepEqual([n.type, n.title, n.body], ['kyc_info_requested', 'More information needed', 'Your certificate is blurry.']);
});

test('admin reads keep the real code and note: partner view, case detail, case list', async () => {
  const id = await makeUser('trainer');
  const caseId = await makeCase(id, 'trainer', 'suspended', { reasonCode: 'suspected_fraud', reasonNote: NOTE });
  const admin = await adminClaims();
  const view = await call(adminKycPartner, { claims: admin, params: { partnerType: 'trainer', subjectId: id } });
  assert.equal(view.statusCode, 200, JSON.stringify(view.body));
  assert.deepEqual([view.body.case.reasonCode, view.body.case.reasonNote], ['suspected_fraud', NOTE]);
  const detail = await call(adminKycCase, { claims: admin, params: { id: caseId } });
  assert.deepEqual([detail.body.case.reasonCode, detail.body.case.reasonNote], ['suspected_fraud', NOTE]);
  const list = await call(adminKycCases, { claims: admin, query: { status: 'suspended' } });
  assert.equal(list.statusCode, 200);
  // Claiming another case also answers with the admin view.
  const other = await makeUser('trainer');
  const otherCase = await makeCase(other, 'trainer', 'submitted', { reasonCode: null });
  const claimed = await call(adminKycClaim, { claims: admin, params: { id: otherCase } });
  assert.equal(claimed.statusCode, 200, JSON.stringify(claimed.body));
});

test('service default: overview() without an audience is the partner view (fails closed)', async () => {
  const id = await makeUser('trainer');
  await makeCase(id, 'trainer', 'rejected', { reasonCode: 'suspected_fraud', reasonNote: NOTE });
  const partner = await svc.partnerForUser(id);
  const mine = await svc.overview(partner);
  assert.equal(mine.case.reasonCode, 'under_review');
  const theirs = await svc.overview(partner, { audience: 'admin' });
  assert.equal(theirs.case.reasonCode, 'suspected_fraud');
});

test('migration clears approval notes already copied from sensitive rejections; down restores them', async () => {
  const fraud = await makeUser('vendor', { approvalStatus: 'rejected', approvalNote: NOTE });
  await makeCase(fraud, 'vendor', 'rejected', { reasonCode: 'suspected_fraud', reasonNote: NOTE });
  const plain = await makeUser('vendor', { approvalStatus: 'rejected', approvalNote: 'Wrong TIN' });
  await makeCase(plain, 'vendor', 'rejected', { reasonCode: 'tax_unverified', reasonNote: 'Wrong TIN' });

  await migration.up(db);
  assert.equal((await db('User').where('id', fraud).first()).approvalNote, null);
  assert.equal((await db('User').where('id', plain).first()).approvalNote, 'Wrong TIN');

  await migration.down(db);
  assert.equal((await db('User').where('id', fraud).first()).approvalNote, NOTE);
  assert.equal((await db('User').where('id', plain).first()).approvalNote, 'Wrong TIN');
  await migration.up(db); // leave the DB as migrated
});
