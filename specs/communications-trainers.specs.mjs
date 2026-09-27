// Communications — FitFlex messages to trainers (promotions, news) against
// the CI database. Admins pick `recipients: 'trainers'`; the audience is
// built from trainer profiles (status, verification, linked gyms, trainer
// passes) and each trainer's message lands in their own inbox/push. Gyms
// still message only their members.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/knex-store.mjs';
import { communicationPreferences, deviceTokens, communicationCampaigns, gyms } from '../src/bootstrap/collections.mjs';
import { createSegmentService } from '../src/services/segment-service.mjs';
import { createCampaignService } from '../src/services/campaign-service.mjs';
import { audienceScope, buildAudienceFilter, matchesFilter, audienceCatalog } from '../src/shared/audience.mjs';

const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const at = (days) => new Date(Date.now() + days * 86_400_000);
const made = { users: [], gyms: [], trainers: [] };
const w = {};

const segments = createSegmentService({ db, communicationPreferences, deviceTokens, pushAvailable: () => true, whatsappAvailable: () => false });
const campaigns = createCampaignService({
  db, campaigns: communicationCampaigns, gyms, segmentService: segments, auditLog: null,
  largeSendThreshold: 50, marketingWeeklyCap: 5,
});

async function gym(name) {
  const id = uid('gym');
  await db('Gym').insert({ id, name, tier: 'standard', location: uid('Tanga'), updatedAt: new Date() });
  made.gyms.push(id);
  return id;
}
async function user(fields) {
  const id = uid('usr');
  await db('User').insert({ id, userType: 'member', updatedAt: new Date(), ...fields });
  made.users.push(id);
  return id;
}
async function trainer(displayName, { gymIds = [], verified = false, status = 'active', pass = null } = {}) {
  const userId = await user({ userType: 'trainer', displayName });
  const id = uid('trn');
  await db('TrainerProfile').insert({ id, userId, displayName, verified, status, updatedAt: new Date() });
  made.trainers.push(id);
  for (const gymId of gymIds) await db('TrainerProfileGym').insert({ trainerId: id, gymId });
  if (pass) {
    await db('Subscription').insert({
      id: uid('sub'), memberId: userId, type: 'trainer_pass', plan: 'weekly', status: pass, homeGymId: gymIds[0] || null,
      startedAt: at(-1), cycleStartedAt: at(-1), renewsAt: at(6), expiresAt: at(6),
    });
  }
  return userId;
}

before(async () => {
  w.gymT = await gym('Trainer Test Gym');
  w.gymOther = await gym('Trainer Other Gym');
  // Every test trainer is linked to gymT so audiences can be scoped to this run.
  w.asha = await trainer('Coach Asha', { gymIds: [w.gymT], verified: true, pass: 'active' });
  w.baraka = await trainer('Coach Baraka', { gymIds: [w.gymT, w.gymOther] });
  w.chausiku = await trainer('Coach Chausiku', { gymIds: [w.gymT], status: 'inactive' });
  w.member = await user({ displayName: 'Plain Member' });
  await db('Subscription').insert({
    id: uid('sub'), memberId: w.member, type: 'direct_sub', plan: 'monthly', status: 'active', homeGymId: w.gymT,
    startedAt: at(-1), cycleStartedAt: at(-1), renewsAt: at(29), expiresAt: at(29),
  });
  await db('DeviceToken').insert({ id: uid('dvt'), userId: w.asha, token: uid('tok'), platform: 'android' });
  w.admin = await user({ userType: 'admin', displayName: 'FitFlex Admin' });
  w.FF = { senderType: 'platform', actorId: w.admin };
  w.owner = await user({ userType: 'gym_operator', displayName: 'Owner', gymIds: [w.gymT] });
  w.OWNER = { senderType: 'gym', owner: { id: w.owner, gymIds: [w.gymT] }, actorId: w.owner };
});

after(async () => {
  await db('CommunicationCampaign').where('createdBy', w.admin).del();
  await db('Subscription').whereIn('memberId', made.users).del();
  if (made.trainers.length) await db('TrainerProfile').whereIn('id', made.trainers).del();
  if (made.gyms.length) await db('Gym').whereIn('id', made.gyms).del();
  if (made.users.length) await db('User').whereIn('id', made.users).del();
});

const atGymT = () => ({ all: [{ field: 'linkedGymId', op: 'eq', value: w.gymT }] });

test('trainers are a FitFlex-only audience with their own fields', () => {
  assert.equal(audienceScope('platform', 'trainers'), 'trainers');
  assert.equal(audienceScope('platform', 'members'), 'platform');
  assert.equal(audienceScope('gym', 'trainers'), null, 'gyms cannot message trainers');
  assert.equal(audienceScope('platform', 'owners'), null);
  // Member fields don't apply to trainers, and trainer fields don't apply to members.
  assert.equal(buildAudienceFilter({ filter: { all: [{ field: 'status', op: 'eq', value: 'expired' }] } }, 'trainers').error, 'invalid_audience');
  assert.equal(buildAudienceFilter({ filter: { all: [{ field: 'trainerPass', op: 'eq', value: 'active' }] } }, 'platform').error, 'invalid_audience');
  const keys = audienceCatalog('trainers').presets.map(p => p.key);
  assert.deepEqual(keys, ['all', 'verified', 'with_pass', 'no_gym', 'new']);
});

test('list facts (a trainer\'s gyms) match when any entry matches', () => {
  const facts = { linkedGymId: ['g1', 'g2'] };
  const f = (op, value) => matchesFilter(facts, { field: 'linkedGymId', op, value });
  assert.equal(f('eq', 'g2'), true);
  assert.equal(f('in', ['g9', 'g1']), true);
  assert.equal(f('neq', 'g1'), false);
  assert.equal(f('exists', true), true);
  assert.equal(matchesFilter({ linkedGymId: [] }, { field: 'linkedGymId', op: 'exists', value: false }), true);
});

test('preview counts only trainers, with presets for verified and pass holders', async () => {
  const all = await segments.previewAudience({ sender: w.FF, recipients: 'trainers', preset: 'all', filter: atGymT() });
  assert.equal(all.recipients, 'trainers');
  assert.equal(all.count, 2, 'active trainers only — the inactive one and the member are out');
  assert.deepEqual(all.sample.map(s => s.displayName), ['Coach Asha', 'Coach Baraka']);
  const verified = await segments.previewAudience({ sender: w.FF, recipients: 'trainers', preset: 'verified', filter: atGymT() });
  assert.equal(verified.count, 1);
  const withPass = await segments.previewAudience({ sender: w.FF, recipients: 'trainers', preset: 'with_pass', filter: atGymT() });
  assert.equal(withPass.count, 1);
  const other = await segments.previewAudience({
    sender: w.FF, recipients: 'trainers', preset: 'all',
    filter: { all: [{ field: 'linkedGymId', op: 'eq', value: w.gymOther }] },
  });
  assert.deepEqual(other.sample.map(s => s.displayName), ['Coach Baraka']);
  assert.equal(all.channels.push.eligible, 1, 'push reaches trainers with a device');
});

test('a FitFlex promotion to trainers lands in each trainer\'s own inbox', async () => {
  const { campaign, error } = await campaigns.create(w.FF, {
    purpose: 'promotion',
    audience: { recipients: 'trainers', preset: 'all', filter: atGymT() },
    content: { title: '{{offer_name}}', body: 'Hi {{member_name}}, {{discount}} off trainer passes this week.', offerName: 'Trainer Week', discount: '15%' },
    channels: ['in_app', 'push'],
  });
  assert.equal(error, undefined);
  assert.equal(campaign.audience.recipients, 'trainers');
  const sent = await campaigns.send(w.FF, campaign.id, { sendRequestId: uid('req') });
  assert.equal(sent.campaign.counts.targeted, 2);
  const rows = await db('CommunicationMessage').where({ campaignId: campaign.id }).orderBy(['memberId', 'channel']);
  assert.deepEqual([...new Set(rows.map(r => r.memberId))].sort(), [w.asha, w.baraka].sort());
  assert.ok(!rows.some(r => r.memberId === w.member), 'members are never in a trainer campaign');
  const ashaInApp = rows.find(r => r.memberId === w.asha && r.channel === 'in_app');
  assert.equal(ashaInApp.body, 'Hi Coach Asha, 15% off trainer passes this week.');
  const listed = (await campaigns.list(w.FF)).campaigns.find(c => c.id === campaign.id);
  assert.equal(listed.recipients, 'trainers');
});

test('gym owners cannot address trainers; FitFlex overview counts them', async () => {
  const r = await campaigns.create(w.OWNER, {
    purpose: 'announcement', audience: { recipients: 'trainers', preset: 'all' },
    content: { title: 'Hi', body: 'Hello' }, channels: ['in_app'],
  });
  assert.equal(r.error, 'invalid_recipients');
  const overview = await campaigns.overview(w.FF, {});
  assert.equal(typeof overview.trainers, 'number');
  assert.ok(overview.trainers >= 2);
});
