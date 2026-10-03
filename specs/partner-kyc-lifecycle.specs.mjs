// Partner KYC after verification, per the owner's decisions of 28 Sep 2026:
// - D4: the member-facing "Verified" badge means KYC-approved; existing
//   partners keep their badge until then; gyms show profileComplete apart.
// - Payouts: a new partner's gym is paid only to a verified payout account
//   past its cooling-off period; existing partners' gyms are exempt.
// - Expiry: reminders only (30 days, 7 days, on the day); verified partners
//   can renew a document any time and a reviewer checks it on its own.
process.env.KYC_ENFORCEMENT = 'on';
process.env.KYC_ENFORCEMENT_FROM = '2026-01-01T00:00:00.000Z';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import {
  partnerGate, partnerKycService as svc, invoiceService, gymService, trainerService, trainers, gyms,
} from '../src/bootstrap/services.mjs';
import { getGym } from '../functions/gyms.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const created = { users: [], gyms: [], trainers: [] };
const EXISTING = new Date('2025-06-01T00:00:00Z');
const FILE = { storageProvider: 'zebra', storageKey: 'bafy-life', mimeType: 'application/pdf', sizeBytes: 1000, sha256: 'e'.repeat(64) };
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function makeUser(userType, { existing = false, ...extra } = {}) {
  const id = uid('usr');
  await db('User').insert({
    id, userType, displayName: `KYC life ${userType}`, approvalStatus: 'approved',
    createdAt: existing ? EXISTING : new Date(), updatedAt: new Date(), ...extra,
  });
  created.users.push(id);
  return id;
}

async function makeGym(extra = {}) {
  const id = uid('gym');
  await gyms.upsertAsync(g => g.id === id, gymService.normalizeGymPayload({
    id, name: `Life Gym ${id}`, tier: 'standard', location: 'Masaki', status: 'active', ...extra,
  }, {}));
  created.gyms.push(id);
  return id;
}

async function ownerOf(gymId, opts = {}) {
  return makeUser('gym_operator', { gymId, gymIds: [gymId], ...opts });
}

async function makeCase(userId, partnerType, status = 'approved') {
  const id = uid('kyc');
  await db('PartnerKycCase').insert({ id, partnerType, userId, status, tier: 3, updatedAt: new Date() });
  return id;
}

async function account(caseId, extra = {}) {
  const id = uid('psa');
  await db('PartnerSettlementAccount').insert({
    id, caseId, method: 'mobile_money', provider: 'mpesa', accountName: 'Owner', accountNumber: '0754000999',
    status: 'verified', isPrimary: true, verifiedAt: new Date(), cooldownUntil: new Date(Date.now() - 3_600_000),
    updatedAt: new Date(), ...extra,
  });
  return id;
}

async function invoiceFor(gymId) {
  const { invoice } = await invoiceService.create({ gymId, amount: 150000, periodStart: '2026-09-01', periodEnd: '2026-09-14', actorId: 'usr_admin' });
  return invoice;
}

const pay = (inv) => invoiceService.update({ id: inv.id, status: 'paid', paymentReference: 'MPESA-XYZ', actorId: 'usr_admin' });

async function gymAsMember(gymId) {
  const out = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await getGym.onRequest({ params: { id: gymId }, headers: {} }, out);
  return out.body;
}

after(async () => {
  await db('Invoice').whereIn('gymId', created.gyms).del();
  await db('GymPayout').whereIn('gymId', created.gyms).del();
  for (const id of created.trainers) await trainers.removeAsync(t => t.id === id);
  for (const id of created.gyms) await gyms.removeAsync(g => g.id === id);
  if (created.users.length) {
    await db('AuditLog').whereIn('actor', created.users).del();
    await db('Notification').whereIn('userId', created.users).del();
    await db('User').whereIn('id', created.users).del();
  }
});

// ── D4: the Verified badge ──────────────────────────────────────────────────

test('an existing gym keeps its badge; a new owner\'s gym is verified only once their KYC is approved', async () => {
  const oldGym = await makeGym({ verified: true });
  await ownerOf(oldGym, { existing: true });
  const newGym = await makeGym({ verified: true }); // a stale stored flag doesn't count for new partners
  const newOwner = await ownerOf(newGym);
  const loneGym = await makeGym({ verified: true }); // no owner account: the admin's flag

  const shown = async () => Object.fromEntries((await partnerGate.badgeGyms(await Promise.all(
    [oldGym, newGym, loneGym].map(id => gyms.findByIdAsync(id)),
  ))).map(g => [g.id, g.verified]));
  assert.deepEqual(await shown(), { [oldGym]: true, [newGym]: false, [loneGym]: true });

  await makeCase(newOwner, 'gym_owner');
  assert.deepEqual(await shown(), { [oldGym]: true, [newGym]: true, [loneGym]: true });
  assert.equal((await gymAsMember(newGym)).verified, true);
});

test('a complete profile shows as profileComplete, not as Verified', async () => {
  const gymId = await makeGym({
    coordinates: { lat: -6.75, lng: 39.27 }, images: ['a.webp'], amenities: ['showers'], equipment: ['racks'],
  });
  await ownerOf(gymId);
  const g = await gymAsMember(gymId);
  assert.deepEqual([g.profileComplete, g.verified], [true, false]);
  const bare = await gymAsMember(await makeGym());
  assert.equal(bare.profileComplete, false);
});

test('trainers: existing ones keep their badge, new ones get it from KYC', async () => {
  const mk = async (opts, verified) => {
    const userId = await makeUser('trainer', opts);
    const id = uid('trn');
    created.trainers.push(id);
    await trainers.insertAsync({ id, userId, displayName: 'Life Trainer', status: 'active', verified, specialties: ['yoga'], gymIds: [] });
    return { id, userId };
  };
  const old = await mk({ existing: true }, true);
  const fresh = await mk({}, true);
  await makeCase(fresh.userId, 'trainer');
  const plain = await mk({}, false);
  await makeCase(plain.userId, 'trainer', 'submitted');
  const byId = Object.fromEntries((await trainerService.listPublic({})).map(t => [t.id, t.verified]));
  assert.equal(byId[old.id], true);
  assert.equal(byId[fresh.id], true);
  assert.equal(byId[plain.id], false); // not approved yet: listed, without the badge
  assert.equal((await trainerService.getPublic(fresh.id)).verified, true);
});

// ── Payout gating ───────────────────────────────────────────────────────────

test('an existing partner\'s gym is paid as before', async () => {
  const gymId = await makeGym();
  await ownerOf(gymId, { existing: true });
  const res = await pay(await invoiceFor(gymId));
  assert.equal(res.invoice.status, 'paid');
});

test('a new partner\'s gym is paid only to a verified payout account past its cooling-off', async () => {
  const gymId = await makeGym();
  const owner = await ownerOf(gymId);
  const inv = await invoiceFor(gymId);

  assert.deepEqual(await pay(inv), { error: 'payout_on_hold', status: 409, reason: 'kyc_not_started' });
  const caseId = await makeCase(owner, 'gym_owner');
  await db('PartnerKycCase').where('id', caseId).update({ status: 'suspended', reasonCode: 'document_expired' });
  assert.equal((await pay(inv)).reason, 'kyc_suspended');
  await db('PartnerKycCase').where('id', caseId).update({ status: 'approved', reasonCode: null });
  assert.equal((await pay(inv)).error, 'payout_account_not_verified');

  const accountId = await account(caseId, { cooldownUntil: new Date(Date.now() + 86_400_000) });
  const cooling = await pay(inv);
  assert.equal(cooling.error, 'payout_account_cooling_off');
  assert.ok(cooling.until);
  assert.equal((await db('Invoice').where('id', inv.id).first()).status, 'unpaid');
  assert.equal((await db('GymPayout').where('invoiceId', inv.id)).length, 0);

  await db('PartnerSettlementAccount').where('id', accountId).update({ cooldownUntil: new Date(Date.now() - 1000) });
  const paid = await pay(inv);
  assert.equal(paid.invoice.status, 'paid');
  const audit = await db('AuditLog').where({ target: inv.id, action: 'invoice_updated' }).orderBy('at', 'desc').first();
  assert.deepEqual(audit.after.payoutDestination, { accountId, method: 'mobile_money', provider: 'mpesa', accountLast4: '0999' });
});

// ── Expiry: reminders and renewals ──────────────────────────────────────────

async function verifiedTrainer({ expiresIn }) {
  const userId = await makeUser('trainer');
  const caseId = await makeCase(userId, 'trainer');
  const docId = uid('pdoc');
  await db('PartnerDocument').insert({
    id: docId, caseId, requirementKey: 'liability_insurance', docType: 'liability_insurance', issuer: 'Jubilee',
    documentNumber: 'POL1', expiresOn: day(expiresIn), status: 'accepted', ...FILE, createdAt: new Date(Date.now() - 86_400_000), updatedAt: new Date(),
  });
  return { userId, caseId, docId, partner: await svc.partnerForUser(userId) };
}

const remindersFor = async (userId) => db('Notification').where({ userId, type: 'kyc_document_expiring' }).orderBy('createdAt');

test('reminders go out 30 and 7 days before and on the day, once each, and suspend nothing', async () => {
  const t = await verifiedTrainer({ expiresIn: 25 });
  await svc.sendExpiryReminders();
  await svc.sendExpiryReminders(); // a rerun sends nothing new
  let sent = await remindersFor(t.userId);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /liability cover expires in 25 days/);

  await db('PartnerDocument').where('id', t.docId).update({ expiresOn: day(5) });
  await svc.sendExpiryReminders();
  await db('PartnerDocument').where('id', t.docId).update({ expiresOn: day(-2) });
  await svc.sendExpiryReminders();
  await svc.sendExpiryReminders();
  sent = await remindersFor(t.userId);
  assert.equal(sent.length, 3);
  assert.match(sent[2].title, /has expired/);
  assert.equal((await db('PartnerKycCase').where('id', t.caseId).first()).status, 'approved');
});

test('far-off and long-expired documents get no reminder', async () => {
  const far = await verifiedTrainer({ expiresIn: 90 });
  const gone = await verifiedTrainer({ expiresIn: -60 });
  await svc.sendExpiryReminders();
  assert.equal((await remindersFor(far.userId)).length, 0);
  assert.equal((await remindersFor(gone.userId)).length, 0);
});

test('a verified partner renews a document; a reviewer accepts it without reopening the case', async () => {
  const t = await verifiedTrainer({ expiresIn: 3 });
  const actor = { id: t.userId, role: 'partner' };
  // Identity stays locked once verified; documents can be renewed.
  assert.equal((await svc.upsertPerson(t.partner, 'principal', { fullName: 'Changed' }, actor)).error, 'case_locked');
  const renewed = await svc.upsertDocumentDetails(t.partner, 'liability_insurance', { issuer: 'Jubilee', documentNumber: 'POL2', expiresOn: day(400) }, actor);
  assert.equal(renewed.case.status, 'approved');
  const renewal = renewed.documents.find(d => d.id !== t.docId);
  assert.equal(renewal.supersedesId, t.docId);
  await db('PartnerDocument').where('id', renewal.id).update(FILE);

  // A renewal waiting for review stops the reminders.
  await svc.sendExpiryReminders();
  assert.equal((await remindersFor(t.userId)).length, 0);

  const row = (await svc.listCases({ status: 'approved' })).find(c => c.id === t.caseId);
  assert.equal(row.documentsToReview, 1);

  const reviewer = { id: await makeUser('admin'), role: 'admin', superAdmin: true };
  const done = await svc.reviewDocument(t.caseId, renewal.id, { decision: 'accept' }, reviewer);
  assert.equal(done.case.status, 'approved');
  assert.equal(done.documents.find(d => d.id === t.docId).status, 'superseded');
  assert.equal(done.documents.find(d => d.id === renewal.id).status, 'accepted');
  assert.equal(done.case.reverifyAt.slice(0, 10), day(400));
});
