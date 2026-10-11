// Trainer fixes (9 Oct 2026), against the test database through the routes:
//  - terms: every role accepts its own terms (member terms / partner agreement)
//  - a profile FitFlex created for a trainer's email becomes theirs on sign-in,
//    so "edit professional details" works for them
//  - the trainer's own edit is validated, saves phone and a photo gallery
//  - a gym owner can add a trainer but never edit the trainer's profile

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { myTerms, acceptMyTerms } from '../functions/terms.mjs';
import { myKycAgreements } from '../functions/partner-kyc.mjs';
import { adminUpsertTrainer, trainerMyProfile, trainerUpdateProfile, getTrainer } from '../functions/trainers.mjs';
import { ownerCreateGym, ownerCreateTrainer, ownerUpdateTrainer } from '../functions/owner-gyms.mjs';
import { termsForRole } from '../src/services/terms-service.mjs';
import { createTrainerService } from '../src/services/trainer-service.mjs';
import { MEMBER_TERMS } from '../src/shared/member-terms.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], trainers: [], gyms: [] };

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
async function call(route, req) {
  const out = res();
  await route.onRequest({ params: {}, query: {}, body: {}, headers: {}, ...req }, out);
  return out;
}
async function user(userType, fields = {}) {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Test ${userType}`, updatedAt: new Date(), ...fields });
  made.users.push(id);
  return { sub: id, userType };
}
const admin = { sub: 'usr_admin_1', userType: 'admin' };

after(async () => {
  if (made.trainers.length) await db('TrainerProfile').whereIn('id', made.trainers).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) {
    await db('PartnerKycCase').whereIn('userId', made.users).del().catch(() => {});
    await db('User').whereIn('id', made.users).del();
  }
});

// ── 1. Terms ────────────────────────────────────────────────────────────────

test('terms: each role has its own text; staff have none', () => {
  assert.equal(termsForRole('member', 'en').kind, 'member_terms');
  assert.equal(termsForRole('member', 'sw').title, 'Vigezo na Masharti ya FitFlex');
  assert.equal(termsForRole('trainer', 'en').kind, 'partner_agreement');
  assert.match(termsForRole('trainer', 'en').title, /Trainer/);
  assert.equal(termsForRole('gym_owner', 'en').reference, termsForRole('gym_operator', 'en').reference);
  assert.match(termsForRole('vendor', 'en').title, /Vendor/i);
  assert.equal(termsForRole('gym_staff', 'en'), null);
  assert.equal(termsForRole('admin', 'en'), null);
});

test('terms: a member accepts the FitFlex Terms once; an old version is refused', async () => {
  const member = await user('member');
  const before = await call(myTerms, { user: member, query: { lang: 'en' } });
  assert.equal(before.statusCode, 200, JSON.stringify(before.body));
  assert.deepEqual([before.body.required, before.body.accepted, before.body.kind], [true, false, 'member_terms']);
  assert.equal(before.body.version, MEMBER_TERMS.version);
  assert.ok(before.body.sections.length >= 6);

  const stale = await call(acceptMyTerms, { user: member, body: { version: '2020-01-01' } });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual([stale.body.error, stale.body.version], ['terms_version_outdated', MEMBER_TERMS.version]);

  const ok = await call(acceptMyTerms, { user: member, body: { version: MEMBER_TERMS.version } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.accepted, true);
  const row = await db('User').where({ id: member.sub }).first();
  assert.equal(row.termsVersion, MEMBER_TERMS.version);
  assert.ok(row.termsAcceptedAt);

  const again = await call(acceptMyTerms, { user: member, body: { version: MEMBER_TERMS.version } });
  assert.equal(again.body.acceptedAt, ok.body.acceptedAt, 'accepting again changes nothing');
});

test('terms: a trainer accepts the partner agreement — the same record verification reads', async () => {
  const trainer = await user('trainer');
  const before = await call(myTerms, { user: trainer, query: { lang: 'sw' } });
  assert.deepEqual([before.body.kind, before.body.accepted, before.body.lang], ['partner_agreement', false, 'sw']);

  const ok = await call(acceptMyTerms, { user: trainer, body: { version: before.body.version } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.accepted, true);

  const kyc = await call(myKycAgreements, { user: trainer, query: {} });
  const terms = kyc.body.agreements.find(a => a.agreementType === 'partner_agreement');
  assert.ok(terms.acceptedAt, 'the verification checklist sees it as accepted');
  assert.equal(kyc.body.agreements.find(a => a.agreementType === 'kyc_consent').acceptedAt, null, 'KYC consent stays separate');
});

test('terms: a role about to be added can be previewed; staff need nothing', async () => {
  const member = await user('member');
  const preview = await call(myTerms, { user: member, query: { role: 'trainer' } });
  assert.deepEqual([preview.body.preview, preview.body.role, preview.body.kind], [true, 'trainer', 'partner_agreement']);
  assert.equal((await call(myTerms, { user: member, query: { role: 'pirate' } })).body.error, 'invalid_role');

  const staff = await user('gym_staff');
  const none = await call(myTerms, { user: staff });
  assert.deepEqual([none.body.required, none.body.accepted], [false, true]);
});

// ── 6. Edit professional details ────────────────────────────────────────────

test('a profile FitFlex created for the trainer\'s email becomes theirs, and they can edit it', async () => {
  const email = `${uid('coach')}@example.com`;
  const created = await call(adminUpsertTrainer, {
    user: admin, body: { displayName: 'Portal Made Coach', email, hourlyRateTzs: 15000, specialties: ['Yoga'] },
  });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  made.trainers.push(created.body.id);
  assert.equal(created.body.userId, null, 'made in the portal: no account yet');

  const trainer = await user('trainer', { email });
  const mine = await call(trainerMyProfile, { user: trainer });
  assert.equal(mine.statusCode, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.id, created.body.id);
  assert.equal(mine.body.userId, trainer.sub, 'claimed on first sign-in');

  const edit = await call(trainerUpdateProfile, {
    user: trainer,
    body: { bio: 'Ten years coaching.', hourlyRateTzs: 30000, phone: '+255 700 123 456', socialLinks: { instagram: '@portal.coach' } },
  });
  assert.equal(edit.statusCode, 200, JSON.stringify(edit.body));
  assert.deepEqual(
    [edit.body.bio, edit.body.hourlyRateTzs, edit.body.phone, edit.body.socialLinks.instagram],
    ['Ten years coaching.', 30000, '+255 700 123 456', 'portal.coach'],
  );
});

test('a profile is never claimed by another email, when already linked, or when ambiguous', async () => {
  const rows = [
    { id: 'trn_a', email: 'twin@example.com', userId: null },
    { id: 'trn_b', email: 'Twin@Example.com', userId: null },
    { id: 'trn_c', email: 'solo@example.com', userId: null },
    { id: 'trn_d', email: 'taken@example.com', userId: 'usr_owner_of_d' },
  ];
  const trainers = {
    find: fn => rows.find(fn) || null,
    filter: fn => rows.filter(fn),
    updateAsync: async (fn, patch) => { const r = rows.find(fn); Object.assign(r, patch); return r; },
  };
  const audit = [];
  const svc = createTrainerService({
    trainers, gyms: { find: () => null }, trainerBookings: {}, gymService: { slimGym: g => g },
    auditLog: { insertAsync: async row => { audit.push(row); } },
  });
  assert.equal(await svc.claimProfileForUser({ userId: 'usr_1', email: 'twin@example.com' }), null, 'two profiles share the email: not guessed');
  assert.equal(await svc.claimProfileForUser({ userId: 'usr_2', email: 'taken@example.com' }), null, 'already someone else\'s');
  assert.equal(await svc.claimProfileForUser({ userId: 'usr_3', email: 'nobody@example.com' }), null);
  assert.equal(await svc.claimProfileForUser({ userId: 'usr_4', email: null }), null, 'no verified email: nothing to match');
  const claimed = await svc.claimProfileForUser({ userId: 'usr_5', email: ' SOLO@example.com ' });
  assert.deepEqual([claimed.id, claimed.userId], ['trn_c', 'usr_5']);
  assert.deepEqual(audit.map(a => [a.action, a.target]), [['trainer_profile_claimed', 'trn_c']]);
  assert.equal((await svc.claimProfileForUser({ userId: 'usr_5', email: 'twin@example.com' })).id, 'trn_c', 'an account keeps its own profile');
});

test('the trainer\'s own edit is checked field by field, and keeps a photo gallery', async () => {
  const email = `${uid('gallery')}@example.com`;
  const created = await call(adminUpsertTrainer, { user: admin, body: { displayName: 'Gallery Coach', email } });
  made.trainers.push(created.body.id);
  const trainer = await user('trainer', { email });
  await call(trainerMyProfile, { user: trainer });
  const put = (body) => call(trainerUpdateProfile, { user: trainer, body });

  for (const [body, error] of [
    [{ hourlyRateTzs: 'lots' }, 'invalid_rate'],
    [{ hourlyRateTzs: -5 }, 'invalid_rate'],
    [{ sessionRateCurrency: 'EUR' }, 'invalid_currency'],
    [{ phone: 'call me' }, 'invalid_phone'],
    [{ displayName: '   ' }, 'displayName_required'],
    [{ availability: 'mondays' }, 'invalid_availability'],
    [{ images: Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.webp`) }, 'too_many_images'],
    [{ socialLinks: { instagram: 'not a handle!' } }, 'invalid_social_handle'],
  ]) {
    const r = await put(body);
    assert.deepEqual([r.statusCode, r.body.error], [400, error], JSON.stringify(body));
  }

  const photos = ['https://example.com/a.webp', 'https://example.com/b.webp', 'https://example.com/c.webp'];
  const saved = await put({ images: photos, imageThumbnails: photos.map(p => `${p}?thumb`), specialties: [], bio: null });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.images, photos);
  assert.equal(saved.body.imageThumbnails.length, 3);
  assert.equal(saved.body.photoUrl, photos[0], 'the first photo is the profile picture');
  assert.deepEqual(saved.body.specialties, []);

  const pub = await call(getTrainer, { params: { id: created.body.id } });
  assert.deepEqual(pub.body.images, photos, 'members get the gallery');

  const onlyPhoto = await put({ photoUrl: 'https://example.com/new.webp' });
  assert.equal(onlyPhoto.body.photoUrl, 'https://example.com/new.webp');
  assert.deepEqual(onlyPhoto.body.images, photos, 'changing the picture alone leaves the gallery');
});

// ── 3. Gym owners don't edit trainers ───────────────────────────────────────

test('a gym owner adds a trainer with starting details only, and cannot edit the profile afterwards', async () => {
  const owner = await user('gym_operator');
  const gym = await call(ownerCreateGym, {
    user: owner, body: { name: uid('Owner Gym'), tier: 'standard', location: 'Dar es Salaam', perVisitRate: 5000 },
  });
  assert.equal(gym.statusCode, 201, JSON.stringify(gym.body));
  made.gyms.push(gym.body.id);

  const added = await call(ownerCreateTrainer, {
    user: owner,
    body: {
      gymId: gym.body.id, displayName: 'Added Coach', email: `${uid('added')}@example.com`, initialPin: '1234',
      bio: 'Starting bio', specialties: ['Boxing'],
      // none of these are an owner's to set
      verified: true, rating: 5, reviewCount: 999, homepagePriority: 100, gymIds: ['gym_someone_elses'],
    },
  });
  assert.equal(added.statusCode, 201, JSON.stringify(added.body));
  made.trainers.push(added.body.id);
  if (added.body.userId) made.users.push(added.body.userId);
  assert.deepEqual(
    [added.body.bio, added.body.verified, added.body.rating, added.body.reviewCount, added.body.homepagePriority],
    ['Starting bio', false, 0, 0, 0],
  );
  assert.deepEqual(added.body.gymIds, [gym.body.id]);

  const edit = await call(ownerUpdateTrainer, {
    user: owner, params: { trainerId: added.body.id }, body: { bio: 'Owner rewrote this', phone: '+255700000000' },
  });
  assert.deepEqual([edit.statusCode, edit.body.error], [403, 'trainer_profile_not_editable']);
  const still = await call(getTrainer, { params: { id: added.body.id } });
  assert.equal(still.body.bio, 'Starting bio');

  const stranger = await user('gym_operator');
  const notMine = await call(ownerUpdateTrainer, { user: stranger, params: { trainerId: added.body.id }, body: { bio: 'x' } });
  assert.equal(notMine.body.error, 'trainer_not_at_your_gym');
});
