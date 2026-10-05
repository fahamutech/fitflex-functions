// Partner agreements accepted in the app: each partner accepts their partner
// terms and the verification consent (current versions) before submitting.
// Acceptance is recorded with who, when, from where and which version.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { partnerKycService as svc, trainers } from '../src/bootstrap/services.mjs';
import { ensureInit } from '../functions/index.mjs';
import { sign } from '../src/auth/jwt.mjs';
import { myKycAgreements, myKycAcceptAgreement } from '../functions/partner-kyc.mjs';
import { requiredAgreements, agreementText } from '../src/shared/partner-agreements.mjs';

await ensureInit();

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const users = [];
const trainerIds = [];

async function makeTrainer() {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'trainer', displayName: 'Agreements Trainer', approvalStatus: 'pending_approval', updatedAt: new Date() });
  users.push(id);
  const trainerId = uid('trn');
  trainerIds.push(trainerId);
  await trainers.insertAsync({ id: trainerId, userId: id, displayName: 'Agreements Trainer', specialties: ['yoga'], approvalStatus: 'pending_approval' });
  return { id, partner: await svc.partnerForUser(id), actor: { id, role: 'partner' } };
}

const rowsFor = async caseId => db('PartnerAgreement').where('caseId', caseId).orderBy('createdAt');

after(async () => {
  for (const id of trainerIds) await trainers.removeAsync(t => t.id === id);
  if (users.length) {
    await db('AuditLog').whereIn('actor', users).del();
    await db('User').whereIn('id', users).del();
  }
});

// ── The texts ───────────────────────────────────────────────────────────────

test('gym owners, trainers and vendors each accept partner terms and the verification consent; companies sign offline', () => {
  for (const type of ['gym_owner', 'trainer', 'vendor']) {
    const list = requiredAgreements(type);
    assert.deepEqual(list.map(a => a.agreementType), ['partner_agreement', 'kyc_consent'], type);
    for (const { text } of list) {
      const en = agreementText(text, 'en');
      const sw = agreementText(text, 'sw');
      assert.match(en.version, /^\d{4}-\d{2}-\d{2}$/);
      assert.notEqual(en.title, sw.title);
      assert.equal(en.sections.length, sw.sections.length, `${type} ${text.reference}: every section is translated`);
      for (const sec of [...en.sections, ...sw.sections]) assert.ok(sec.heading && sec.text.length > 40, sec.heading);
    }
  }
  assert.deepEqual(requiredAgreements('corporate'), []);
  assert.equal(agreementText(requiredAgreements('trainer')[0].text, 'fr').lang, 'en');
  // The gym terms mirror the Gym Partner Agreement v2.0: step-model payouts on
  // the gym's own rates with no commission on Pass visits, commission only on
  // its own plans, verified payout account, messaging limits, 90-day pilot.
  const gymTerms = agreementText(requiredAgreements('gym_owner')[0].text, 'en');
  assert.equal(gymTerms.reference, 'FFA-GPA-001 (online) v2.0');
  const gym = JSON.stringify(gymTerms);
  for (const phrase of [
    'daily, weekly and monthly rates', '8 to 14 visit-days at two weekly rates', 'never exceeds your monthly rate',
    'No commission is deducted from Pass payouts', 'by the 5th day of the following month',
    'between 10% and 15% of the price', 'makes no payout for their visits',
    'forty-eight (48) hours', 'FitFlex will remind you', 'non-exclusive',
    'cannot choose or change your own classification', 'no more than two promotional messages a week',
    'ninety (90) days',
  ]) {
    assert.ok(gym.includes(phrase), phrase);
  }
  assert.ok(!gym.includes('less the platform commission shown in your payout statement'), 'Pass payouts carry no commission');
});

// ── Accepting ───────────────────────────────────────────────────────────────

test('a partner accepts each agreement once, and can\'t submit until both are accepted', async () => {
  const t = await makeTrainer();
  const listed = await svc.agreements(t.partner, 'sw');
  assert.deepEqual(listed.agreements.map(a => [a.agreementType, a.lang, a.acceptedAt]),
    [['partner_agreement', 'sw', null], ['kyc_consent', 'sw', null]]);

  const [terms, consent] = listed.agreements;
  const after1 = await svc.acceptAgreement(t.partner, { agreementType: terms.agreementType, version: terms.version }, t.actor,
    { ip: '41.59.1.10', userAgent: 'FitFlex/1.0 (Android)' });
  const items = after1.checklist.sections.find(s => s.key === 'agreements').items;
  assert.deepEqual(items.map(i => [i.key, i.status]), [['agreements.partner_terms', 'complete'], ['agreements.kyc_consent', 'missing']]);
  assert.ok(after1.checklist.missing.includes('agreements.kyc_consent'));

  // Accepting again changes nothing.
  await svc.acceptAgreement(t.partner, { agreementType: terms.agreementType, version: terms.version }, t.actor);
  await svc.acceptAgreement(t.partner, { agreementType: consent.agreementType, version: consent.version }, t.actor);
  const caseId = after1.case.id;
  const rows = await rowsFor(caseId);
  assert.equal(rows.length, 2);
  const termsRow = rows.find(r => r.agreementType === 'partner_agreement');
  assert.deepEqual([termsRow.status, termsRow.version, termsRow.acceptedBy, termsRow.acceptedIp, termsRow.acceptedUserAgent],
    ['accepted', terms.version, t.id, '41.59.1.10', 'FitFlex/1.0 (Android)']);
  assert.ok((await svc.agreements(t.partner, 'en')).agreements.every(a => a.acceptedAt));

  const events = await db('PartnerKycEvent').where({ caseId, eventType: 'agreement_accepted' });
  assert.equal(events.length, 2);
});

test('only the partner type\'s agreements, at their current version, can be accepted', async () => {
  const t = await makeTrainer();
  const [terms] = (await svc.agreements(t.partner)).agreements;
  assert.deepEqual(
    await svc.acceptAgreement(t.partner, { agreementType: 'corporate_contract', version: terms.version }, t.actor),
    { error: 'invalid_agreement', status: 400, allowed: ['partner_agreement', 'kyc_consent'] },
  );
  assert.deepEqual(
    await svc.acceptAgreement(t.partner, { agreementType: 'partner_agreement', version: '2020-01-01' }, t.actor),
    { error: 'agreement_version_outdated', status: 409, version: terms.version },
  );
});

test('accepting a new version supersedes the earlier one', async () => {
  const t = await makeTrainer();
  const [terms] = (await svc.agreements(t.partner)).agreements;
  const kycCase = await svc.ensureCase(t.partner, t.actor);
  await db('PartnerAgreement').insert({
    id: uid('pagr'), caseId: kycCase.id, agreementType: 'partner_agreement', version: '2026-01-01', status: 'accepted',
    acceptedBy: t.id, acceptedAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date(),
  });
  const before = await svc.overview(t.partner);
  assert.equal(before.checklist.sections.find(s => s.key === 'agreements').items[0].status, 'missing'); // old version doesn't count

  await svc.acceptAgreement(t.partner, { agreementType: 'partner_agreement', version: terms.version }, t.actor);
  const rows = await rowsFor(kycCase.id);
  assert.deepEqual(rows.map(r => [r.version, r.status]).sort(), [['2026-01-01', 'superseded'], [terms.version, 'accepted']].sort());
});

// ── Routes ──────────────────────────────────────────────────────────────────

test('routes: the partner reads the texts in their language and accepts; the IP and device are kept', async () => {
  const t = await makeTrainer();
  const call = async (route, { body = {}, query = {}, headers = {} } = {}) => {
    const req = { headers: { authorization: `Bearer ${sign({ sub: t.id, userType: 'trainer' })}`, ...headers }, params: {}, body, query };
    const out = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    for (const guard of [myKycAgreements.onGuard].flat()) {
      let passed = false;
      await guard(req, out, () => { passed = true; });
      if (!passed) return out;
    }
    await route.onRequest(req, out);
    return out;
  };
  const listed = await call(myKycAgreements, { query: { lang: 'sw' } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.agreements[0].title, 'Masharti ya Ma-trainer Washirika wa FitFlex');

  const consent = listed.body.agreements[1];
  const accepted = await call(myKycAcceptAgreement, {
    body: { agreementType: consent.agreementType, version: consent.version },
    headers: { 'x-forwarded-for': '102.223.4.5, 10.0.0.1', 'user-agent': 'Mozilla/5.0' },
  });
  assert.equal(accepted.statusCode, 200);
  const row = await db('PartnerAgreement').where({ caseId: accepted.body.case.id, agreementType: 'kyc_consent' }).first();
  assert.deepEqual([row.acceptedIp, row.acceptedUserAgent], ['102.223.4.5', 'Mozilla/5.0']);

  const stale = await call(myKycAcceptAgreement, { body: { agreementType: 'kyc_consent', version: '2000-01-01' } });
  assert.equal(stale.statusCode, 409);
});
