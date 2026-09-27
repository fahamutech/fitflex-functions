// Trainer enquiries as conversations: the trainer replies, marks read and
// closes; the member follows up (reopening a closed one); each side is
// notified when the other writes; older single-message enquiries still show.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTrainerEngagementService, engagementThread, unreadFor, ENQUIRY_TEXT_MAX,
} from '../src/services/trainer-engagement-service.mjs';
import { updateMemberProfile } from '../functions/subscriptions.mjs';
import { trainerRegister } from '../functions/trainers.mjs';
import {
  memberEngageTrainer, memberMyTrainerEngagements, memberReplyEngagement, memberReadEngagement,
  trainerMyEngagements, trainerReplyEngagement, trainerReadEngagement, trainerCloseEngagement,
} from '../functions/trainer-engagements.mjs';
import { myNotifications } from '../functions/notifications.mjs';

function memStore(rows = []) {
  return {
    rows,
    async filterAsync(fn) { return rows.filter(fn); },
    async findAsync(fn) { return rows.find(fn) || null; },
    async findByIdAsync(id) { return rows.find(r => r.id === id) || null; },
    async insertAsync(row) { rows.push(row); return row; },
    async updateByIdAsync(id, patch) {
      const i = rows.findIndex(r => r.id === id);
      if (i >= 0) rows[i] = { ...rows[i], ...patch };
      return rows[i] || null;
    },
  };
}

function setup() {
  const trainer = { id: 'trn_1', userId: 'usr_trn', displayName: 'Coach Asha', status: 'active' };
  const sent = [];
  let clock = Date.parse('2026-09-28T08:00:00Z');
  const service = createTrainerEngagementService({
    trainerEngagements: memStore(),
    trainers: { find: fn => [trainer].find(fn) || null },
    users: memStore([{ id: 'usr_m', displayName: 'Neema' }]),
    trainerService: { findProfileByUser: uid => (uid === 'usr_trn' ? trainer : null) },
    notify: async (userId, message) => { sent.push({ userId, ...message }); },
    now: () => new Date((clock += 60_000)),
  });
  return { service, sent };
}

test('an enquiry notifies the trainer and starts a conversation', async () => {
  const { service, sent } = setup();
  const { engagement } = await service.create({ memberId: 'usr_m', trainerId: 'trn_1', type: 'enquiry', message: '  Morning slots?  ' });
  assert.equal(engagement.message, 'Morning slots?');
  assert.deepEqual(engagement.messages.map(m => [m.from, m.text]), [['member', 'Morning slots?']]);
  assert.deepEqual(sent.map(s => [s.userId, s.type, s.title, s.body]), [['usr_trn', 'trainer_enquiry', 'New enquiry from Neema', 'Morning slots?']]);

  const { engagements } = await service.listForTrainer({ userId: 'usr_trn' });
  assert.equal(engagements[0].unread, true);
  assert.equal(engagements[0].member.displayName, 'Neema');
});

test('the trainer reads, replies and closes; the member follows up and reopens', async () => {
  const { service, sent } = setup();
  const { engagement } = await service.create({ memberId: 'usr_m', trainerId: 'trn_1', type: 'enquiry', message: 'Morning slots?' });

  const read = await service.markReadByTrainer({ userId: 'usr_trn', id: engagement.id });
  assert.equal(read.engagement.status, 'read');
  assert.equal(read.engagement.unread, false);

  const reply = await service.replyAsTrainer({ userId: 'usr_trn', id: engagement.id, message: 'Yes, 6am weekdays.' });
  assert.equal(reply.engagement.status, 'replied');
  assert.deepEqual(reply.engagement.messages.map(m => m.from), ['member', 'trainer']);
  const toMember = sent.at(-1);
  assert.deepEqual([toMember.userId, toMember.type, toMember.title], ['usr_m', 'trainer_enquiry_reply', 'Coach Asha replied']);
  assert.equal(toMember.data.trainerId, 'trn_1');

  let mine = (await service.listForMember({ memberId: 'usr_m' })).engagements[0];
  assert.equal(mine.unread, true, 'the member has an unread reply');
  assert.equal(mine.trainer.displayName, 'Coach Asha');
  await service.markReadByMember({ memberId: 'usr_m', id: engagement.id });
  mine = (await service.listForMember({ memberId: 'usr_m' })).engagements[0];
  assert.equal(mine.unread, false);

  assert.equal((await service.closeByTrainer({ userId: 'usr_trn', id: engagement.id })).engagement.status, 'closed');
  const followUp = await service.replyAsMember({ memberId: 'usr_m', id: engagement.id, message: 'Can I start Monday?' });
  assert.equal(followUp.engagement.status, 'new', 'a follow-up reopens the conversation');
  assert.deepEqual(sent.at(-1).userId, 'usr_trn');
  assert.equal((await service.listForTrainer({ userId: 'usr_trn' })).engagements[0].unread, true);
});

test('a trainer can start a conversation from an interest', async () => {
  const { service, sent } = setup();
  const { engagement } = await service.create({ memberId: 'usr_m', trainerId: 'trn_1', type: 'interest' });
  assert.equal(sent[0].type, 'trainer_interest');
  assert.deepEqual(engagement.messages, []);
  const reply = await service.replyAsTrainer({ userId: 'usr_trn', id: engagement.id, message: 'Hi Neema! Want a free intro session?' });
  assert.deepEqual(reply.engagement.messages.map(m => m.from), ['trainer']);
});

test('only the two people in a conversation can use it; messages are checked', async () => {
  const { service } = setup();
  const { engagement } = await service.create({ memberId: 'usr_m', trainerId: 'trn_1', type: 'enquiry', message: 'Hi' });
  assert.equal((await service.replyAsTrainer({ userId: 'usr_other', id: engagement.id, message: 'x' })).error, 'trainer_profile_not_found');
  assert.equal((await service.replyAsMember({ memberId: 'usr_other', id: engagement.id, message: 'x' })).error, 'not_found');
  assert.equal((await service.replyAsTrainer({ userId: 'usr_trn', id: engagement.id, message: '   ' })).error, 'message_required');
  assert.equal((await service.replyAsTrainer({ userId: 'usr_trn', id: engagement.id, message: 'x'.repeat(ENQUIRY_TEXT_MAX + 1) })).error, 'message_too_long');
});

test('older single-message enquiries show as a one-message conversation', () => {
  const legacy = { id: 'tng_old', message: 'Old question', createdAt: '2026-08-01T10:00:00Z', lastMessageAt: '2026-08-01T10:00:00Z', lastMessageFrom: 'member' };
  assert.deepEqual(engagementThread(legacy), [{ id: 'tng_old_0', from: 'member', text: 'Old question', at: '2026-08-01T10:00:00.000Z' }]);
  assert.equal(unreadFor(legacy, 'trainer'), true);
  assert.equal(unreadFor(legacy, 'member'), false);
});

// ── Against the CI database, through the routes ─────────────────────────────

function res() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
const uniq = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const phone = () => `+2557${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
async function call(route, req) {
  const out = res();
  await route.onRequest({ params: {}, query: {}, body: {}, ...req }, out);
  return out;
}

test('routes: a conversation round-trips through the database and notifies both sides', async () => {
  const trainerUser = { sub: uniq('usr_trn_enq'), userType: 'trainer' };
  const member = { sub: uniq('usr_mem_enq'), userType: 'member' };
  await call(updateMemberProfile, { user: trainerUser, body: { displayName: 'Coach Enquiry', phone: phone() } });
  await call(updateMemberProfile, { user: member, body: { displayName: 'Member Enquiry', phone: phone() } });
  const reg = await call(trainerRegister, {
    user: trainerUser, body: { displayName: 'Coach Enquiry', photoUrl: 'https://example.com/c.jpg', gender: 'male', hourlyRateTzs: 15000 },
  });
  assert.equal(reg.statusCode, 200, JSON.stringify(reg.body));

  const sentEnquiry = await call(memberEngageTrainer, { user: member, params: { id: reg.body.id }, body: { type: 'enquiry', message: 'Do you train beginners?' } });
  assert.equal(sentEnquiry.statusCode, 201, JSON.stringify(sentEnquiry.body));
  const id = sentEnquiry.body.engagement.id;

  const inbox = await call(trainerMyEngagements, { user: trainerUser });
  const row = inbox.body.find(e => e.id === id);
  assert.equal(row.unread, true);
  assert.equal(row.messages[0].text, 'Do you train beginners?');
  const trainerBell = await call(myNotifications, { user: trainerUser });
  assert.ok(trainerBell.body.notifications.some(n => n.type === 'trainer_enquiry'));

  assert.equal((await call(trainerReadEngagement, { user: trainerUser, params: { id } })).body.status, 'read');
  const reply = await call(trainerReplyEngagement, { user: trainerUser, params: { id }, body: { message: 'Yes! Start with 2 sessions a week.' } });
  assert.equal(reply.statusCode, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.messages.length, 2);

  const mine = await call(memberMyTrainerEngagements, { user: member });
  const myRow = mine.body.find(e => e.id === id);
  assert.deepEqual(myRow.messages.map(m => m.from), ['member', 'trainer'], 'the thread persisted as jsonb');
  assert.equal(myRow.unread, true);
  assert.equal(myRow.trainer.displayName, 'Coach Enquiry');
  const memberBell = await call(myNotifications, { user: member });
  assert.ok(memberBell.body.notifications.some(n => n.type === 'trainer_enquiry_reply'));

  assert.equal((await call(memberReadEngagement, { user: member, params: { id } })).body.unread, false);
  assert.equal((await call(trainerCloseEngagement, { user: trainerUser, params: { id } })).body.status, 'closed');
  const followUp = await call(memberReplyEngagement, { user: member, params: { id }, body: { message: 'Thanks — booking now.' } });
  assert.equal(followUp.body.status, 'new');
  assert.equal(followUp.body.messages.length, 3);

  const stranger = await call(trainerReplyEngagement, { user: { sub: uniq('usr_x'), userType: 'trainer' }, params: { id }, body: { message: 'hi' } });
  assert.equal(stranger.statusCode, 404);
});
