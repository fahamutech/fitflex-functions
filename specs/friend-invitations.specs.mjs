// Friend invitations: search by email / phone, request to a member, share
// link for someone not on FitFlex, Approve / Reject from Notifications.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFriendInvitationService } from '../src/services/friend-invitation-service.mjs';

function store(rows = []) {
  const clone = r => JSON.parse(JSON.stringify(r));
  return {
    rows,
    async allAsync() { return rows.map(clone); },
    async filterAsync(pred) { return rows.filter(pred).map(clone); },
    async filterByColumnAsync(col, v) { return rows.filter(r => r[col] === v).map(clone); },
    async findByIdAsync(id) { const r = rows.find(x => x.id === id); return r ? clone(r) : null; },
    async insertAsync(row) {
      if (rows.some(r => r.id === row.id)) throw new Error('duplicate key');
      rows.push(clone(row)); return row;
    },
    async updateByIdAsync(id, patch) { const r = rows.find(x => x.id === id); Object.assign(r, clone(patch)); return clone(r); },
  };
}

const NOW = new Date('2026-10-10T09:00:00.000Z');

function setup() {
  const u = (id, name, extra = {}) => ({ id, userType: 'member', displayName: name, accountStatus: 'active', ...extra });
  const s = {
    users: store([
      u('neema', 'Neema Star', { email: 'neema@example.com', phone: '+255712000001' }),
      u('juma', 'Juma Fan', { email: 'Juma@Example.com', phone: '+255712000002' }),
      u('asha', 'Asha Other', { phone: '+255712000003' }),
    ]),
    follows: store(), blocks: store(), invites: store(), notifications: store(), sent: [], delivered: [],
  };
  s.clock = { now: NOW };
  s.svc = createFriendInvitationService({
    users: s.users, follows: s.follows, blocks: s.blocks, invites: s.invites, notifications: s.notifications,
    notify: async (to, m) => {
      s.sent.push({ to, ...m });
      if (!m.id) return { ok: true };
      const row = { id: m.id, userId: to, type: m.type, title: m.title, body: m.body, data: { ...m.data, type: m.type }, readAt: null };
      s.notifications.rows.push(row);
      return { ok: true, notification: row };
    },
    findMember: async ({ type, value }) => {
      const m = s.users.rows.find(x => (type === 'email' ? x.email?.toLowerCase() === value : x.phone === value));
      return m ? { id: m.id, displayName: m.displayName } : null;
    },
    transition: async (id, from, patch, opts = {}) => {
      const r = s.invites.rows.find(x => x.id === id);
      if (!r || r[opts.column ?? 'status'] !== from || (opts.whereRecipientNull && r.recipientUserId)) return false;
      Object.assign(r, patch); return true;
    },
    contactsFor: async (userId) => s.extraContacts?.[userId] ?? [],
    delivery: () => s.on ?? { sms: false, whatsapp: false },
    handleOf: async (id) => (id === 'neema' ? 'neema_star' : null),
    channels: {
      whatsapp: async (a) => { s.delivered.push({ channel: 'whatsapp', ...a }); return s.wa ?? { status: 'skipped:whatsapp_not_available' }; },
      sms: async (a) => { s.delivered.push({ channel: 'sms', ...a }); return { status: s.smsStatus ?? 'sent' }; },
      whatsappStatus: async () => s.waStatus ?? null,
    },
    baseLink: () => 'https://app.example',
    now: () => s.clock.now,
  });
  return s;
}

test('search: finds members by email and phone (masked unless connected), nobody otherwise', async () => {
  const s = setup();
  const byEmail = await s.svc.lookup('neema', { email: ' JUMA@example.com ' });
  assert.equal(byEmail.result.kind, 'member');
  assert.equal(byEmail.result.userId, 'juma');
  assert.equal(byEmail.result.name, 'J*** F**');
  const byPhone = await s.svc.lookup('neema', { phone: '0712 000 003' });
  assert.equal(byPhone.result.userId, 'asha');
  assert.equal((await s.svc.lookup('neema', { email: 'nobody@example.com' })).result.kind, 'unregistered');
  assert.equal((await s.svc.lookup('neema', { email: 'not-an-email' })).error, 'invalid_contact');
  assert.equal((await s.svc.lookup('neema', { email: 'neema@example.com' })).error, 'cannot_invite_yourself');
});

test('member: request lands in Notifications with the inviter name and no contact details; no friendship yet', async () => {
  const s = setup();
  const r = await s.svc.invite('neema', { email: 'juma@example.com' });
  assert.equal(r.invitation.status, 'pending');
  assert.equal(r.share, undefined, 'a member needs no link');
  const card = s.notifications.rows[0];
  assert.equal(card.userId, 'juma');
  assert.equal(card.type, 'friend_invitation');
  assert.equal(card.data.status, 'pending');
  assert.equal(card.data.inviterName, 'Neema Star');
  assert.ok(!JSON.stringify(card).includes('example.com'));
  assert.equal(s.follows.rows.length, 0);
  // duplicates collapse
  const again = await s.svc.invite('neema', { userId: 'juma' });
  assert.equal(again.duplicate, true);
  assert.equal(s.invites.rows.length, 1);
});

test('approve: one friendship; repeated taps and other people change nothing', async () => {
  const s = setup();
  const { invitation } = await s.svc.invite('neema', { userId: 'juma' });
  assert.equal((await s.svc.approve('asha', invitation.id)).status, 404, 'not theirs');
  assert.equal((await s.svc.approve('neema', invitation.id)).status, 404, 'inviter cannot approve');
  const a = await s.svc.approve('juma', invitation.id);
  assert.equal(a.invitation.status, 'accepted');
  const b = await s.svc.approve('juma', invitation.id);
  assert.equal(b.already, true);
  assert.equal(s.follows.rows.length, 2, 'a follow each way, once');
  assert.equal(s.notifications.rows[0].data.status, 'accepted');
  assert.equal((await s.svc.reject('juma', invitation.id)).error, 'invitation_accepted');
  assert.equal((await s.svc.invite('neema', { userId: 'juma' })).error, 'already_friends');
});

test('reject: no friendship; inviter sees declined and cannot re-invite straight away', async () => {
  const s = setup();
  const { invitation } = await s.svc.invite('neema', { userId: 'juma' });
  const r = await s.svc.reject('juma', invitation.id);
  assert.equal(r.invitation.status, 'rejected');
  assert.equal(s.follows.rows.length, 0);
  assert.equal(s.notifications.rows[0].data.status, 'rejected');
  assert.equal((await s.svc.approve('juma', invitation.id)).error, 'invitation_rejected');
  assert.equal((await s.svc.invite('neema', { userId: 'juma' })).error, 'recently_declined');
  const out = (await s.svc.list('neema')).outgoing;
  assert.equal(out[0].status, 'rejected');
  assert.equal(out[0].name, 'J*** F**', 'masked until accepted');
});

test('not on FitFlex: share link + message, token only hashed, attaches after the contact is verified', async () => {
  const s = setup();
  const r = await s.svc.invite('neema', { email: 'new.person@example.com' });
  assert.equal(r.invitation.status, 'pending');
  assert.match(r.share.link, /^https:\/\/app\.example\/friend-invite\/[A-Za-z0-9_-]{20,}$/);
  assert.ok(r.share.text.includes('@neema_star') && r.share.text.includes(r.share.link));
  const token = r.share.link.split('/').pop();
  assert.ok(!JSON.stringify(s.invites.rows).includes(token), 'plain token is not stored');
  assert.equal(s.sent.length, 0, 'nothing sent by FitFlex');

  const pv = await s.svc.preview(token);
  assert.equal(pv.invitation.inviterName, 'Neema Star');
  assert.equal((await s.svc.preview('x'.repeat(30))).error, 'invalid_invitation');

  // Someone else (different verified contact) can't use the link.
  assert.equal((await s.svc.claim('juma', token)).error, 'contact_mismatch');
  assert.equal(s.notifications.rows.length, 0);

  // The invited person registers with that verified email.
  s.users.rows.push({ id: 'newbie', userType: 'member', displayName: 'New Person', accountStatus: 'active', email: 'new.person@example.com' });
  assert.equal(await s.svc.attachFor('newbie'), 1);
  assert.equal(s.notifications.rows[0].userId, 'newbie');
  assert.equal(s.follows.rows.length, 0, 'still needs approval');
  const inc = (await s.svc.list('newbie')).incoming;
  assert.equal(inc.length, 1);
  assert.equal((await s.svc.approve('newbie', inc[0].id)).invitation.status, 'accepted');
  assert.equal(s.follows.rows.length, 2);
  // claim is idempotent / safe afterwards
  assert.equal((await s.svc.claim('newbie', token)).error, 'invalid_invitation');
});

test('expired, revoked and blocked invitations are handled safely', async () => {
  const s = setup();
  const a = await s.svc.invite('neema', { userId: 'juma' });
  s.clock.now = new Date(+NOW + 31 * 86400e3);
  const r = await s.svc.approve('juma', a.invitation.id);
  assert.equal(r.error, 'invitation_expired');
  assert.equal(s.follows.rows.length, 0);

  s.clock.now = NOW;
  const b = await s.svc.invite('neema', { userId: 'asha' });
  assert.equal((await s.svc.revoke('neema', b.invitation.id)).invitation.status, 'revoked');
  assert.equal((await s.svc.approve('asha', b.invitation.id)).error, 'invitation_revoked');

  s.blocks.rows.push({ id: 'b1', blockerId: 'juma', blockedId: 'neema' });
  assert.equal((await s.svc.invite('neema', { userId: 'juma' })).status, 404);
  assert.equal((await s.svc.lookup('neema', { email: 'juma@example.com' })).result.kind, 'unregistered');
});

test('rate limit on creating invitations', async () => {
  const s = setup();
  process.env.FRIEND_INVITE_CREATE_PER_HOUR = '2';
  try {
    assert.ok((await s.svc.invite('neema', { email: 'a1@example.com' })).invitation);
    assert.ok((await s.svc.invite('neema', { email: 'a2@example.com' })).invitation);
    assert.equal((await s.svc.invite('neema', { email: 'a3@example.com' })).status, 429);
  } finally { delete process.env.FRIEND_INVITE_CREATE_PER_HOUR; }
});

test('a number held only as a verified login identifier still attaches the invitation', async () => {
  const s = setup();
  // The recipient's User row has no phone (another persona holds it).
  s.users.rows.push({ id: 'zed', userType: 'member', displayName: 'Zed', accountStatus: 'active', phone: null, email: null });
  s.extraContacts = { zed: [{ type: 'phone', value: '+255650387211' }] };
  const r = await s.svc.invite('neema', { phone: '0650387211' });
  assert.ok(r.share, 'looked unregistered, so a link was made');
  assert.equal(await s.svc.attachFor('zed'), 1);
  const inc = (await s.svc.list('zed')).incoming;
  assert.equal(inc.length, 1);
  assert.equal(s.notifications.rows.at(-1).userId, 'zed');
});

test('the inviter sees the contact they invited; the recipient never does', async () => {
  const s = setup();
  const r = await s.svc.invite('neema', { phone: '0650387211' });
  const mine = (await s.svc.list('neema')).outgoing[0];
  assert.equal(mine.contact, '+255650387211');
  assert.equal(mine.contactType, 'phone');
  s.users.rows.push({ id: 'zed', userType: 'member', displayName: 'Zed', accountStatus: 'active', phone: '+255650387211' });
  await s.svc.attachFor('zed');
  const theirs = (await s.svc.list('zed')).incoming[0];
  assert.equal(theirs.contact, null);
  assert.ok(!JSON.stringify(s.notifications.rows).includes('650387211'));
});

test('sending is off by default: nothing is delivered by FitFlex', async () => {
  const s = setup();
  const r = await s.svc.invite('neema', { phone: '0650387211' });
  assert.equal(r.delivery, undefined);
  assert.equal(s.delivered.length, 0);
  assert.deepEqual((await s.svc.lookup('neema', { phone: '0650387211' })).result.delivery, { sms: false, whatsapp: false });
});

test('with only SMS on, FitFlex sends the SMS once, naming the inviter by @username', async () => {
  const s = setup();
  s.on = { sms: true, whatsapp: false };
  const r = await s.svc.invite('neema', { phone: '0650387211' });
  assert.deepEqual(r.delivery, { sms: 'sent' });
  assert.equal(s.delivered.length, 1);
  assert.equal(s.delivered[0].phone, '+255650387211');
  assert.ok(s.delivered[0].text.includes('@neema_star'));
  assert.ok(s.delivered[0].text.includes(r.share.link));
  const again = await s.svc.invite('neema', { phone: '0650387211' });
  assert.deepEqual(again.delivery, { sms: 'skipped:recently_sent', whatsapp: 'skipped:recently_sent' });
  assert.equal(s.delivered.length, 1);
  const mine = (await s.svc.list('neema')).outgoing[0];
  assert.deepEqual(mine.sentBy, ['sms']);
  assert.ok(mine.sentAt);
});

test('WhatsApp first: when it accepts the message, no SMS goes', async () => {
  const s = setup();
  s.on = { sms: true, whatsapp: true };
  s.wa = { status: 'sent', providerMessageId: 'wamid.1' };
  const r = await s.svc.invite('neema', { phone: '0650387211' });
  assert.equal(r.delivery.whatsapp, 'sent');
  assert.equal(r.delivery.sms, 'skipped:whatsapp_sent');
  assert.deepEqual(s.delivered.map(d => d.channel), ['whatsapp']);
  const row = s.invites.rows[0];
  assert.equal(row.waState, 'pending');
  assert.equal(row.waMessageId, 'wamid.1');
});

test('WhatsApp not usable (not set up / template not approved): SMS goes at once', async () => {
  const s = setup();
  s.on = { sms: true, whatsapp: true };
  s.wa = { status: 'skipped:whatsapp_template_not_approved' };
  const r = await s.svc.invite('neema', { phone: '0650387211' });
  assert.deepEqual(r.delivery, { whatsapp: 'skipped:whatsapp_template_not_approved', sms: 'sent' });
  assert.deepEqual(s.delivered.map(d => d.channel), ['whatsapp', 'sms']);
});

test('a number that opted out of WhatsApp gets neither', async () => {
  const s = setup();
  s.on = { sms: true, whatsapp: true };
  s.wa = { status: 'skipped:recipient_opted_out' };
  const r = await s.svc.invite('neema', { phone: '0650387211' });
  assert.equal(r.delivery.sms, 'skipped:recipient_opted_out');
  assert.deepEqual(s.delivered.map(d => d.channel), ['whatsapp']);
});

test('no WhatsApp on the number: WhatsApp reports failed, the job sends one SMS with a fresh link', async () => {
  const s = setup();
  s.on = { sms: true, whatsapp: true };
  s.wa = { status: 'sent', providerMessageId: 'wamid.2' };
  const r = await s.svc.invite('neema', { phone: '0650387211' });
  assert.equal(s.delivered.length, 1);

  s.waStatus = 'sent'; // not delivered yet: wait
  assert.deepEqual(await s.svc.resolveFallbacks(), { checked: 1, sms: 0 });
  assert.equal(s.delivered.length, 1);

  s.waStatus = 'failed';
  assert.deepEqual(await s.svc.resolveFallbacks(), { checked: 1, sms: 1 });
  const sms = s.delivered.at(-1);
  assert.equal(sms.channel, 'sms');
  assert.match(sms.text, /friend-invite\/[A-Za-z0-9_-]{20,}/);
  assert.notEqual(sms.text.match(/friend-invite\/(\S+)/)[1], r.share.link.split('/').pop(), 'a new link, the old token is gone');
  // running again sends nothing more
  assert.deepEqual(await s.svc.resolveFallbacks(), { checked: 0, sms: 0 });
  assert.equal(s.delivered.length, 2);
  const mine = (await s.svc.list('neema')).outgoing[0];
  assert.deepEqual(mine.sentBy, ['whatsapp', 'sms']);
  assert.equal(mine.whatsappFailed, true);
  // the new link works
  const token = sms.text.match(/friend-invite\/(\S+)/)[1];
  assert.equal((await s.svc.preview(token)).invitation.status, 'pending');
});

test('WhatsApp delivered: no SMS; a withdrawn invitation gets no fallback SMS', async () => {
  const s = setup();
  s.on = { sms: true, whatsapp: true };
  s.wa = { status: 'sent', providerMessageId: 'wamid.3' };
  await s.svc.invite('neema', { phone: '0650387211' });
  s.waStatus = 'delivered';
  assert.deepEqual(await s.svc.resolveFallbacks(), { checked: 1, sms: 0 });
  assert.equal(s.invites.rows[0].waState, 'delivered');

  const s2 = setup();
  s2.on = { sms: true, whatsapp: true };
  s2.wa = { status: 'sent', providerMessageId: 'wamid.4' };
  const r2 = await s2.svc.invite('neema', { phone: '0650387299' });
  await s2.svc.revoke('neema', r2.invitation.id);
  s2.waStatus = 'failed';
  assert.deepEqual(await s2.svc.resolveFallbacks(), { checked: 1, sms: 0 });
  assert.equal(s2.delivered.length, 1);
});

test('email invitations and members are never sent by FitFlex; a failed send keeps the link', async () => {
  const s = setup();
  s.on = { sms: true, whatsapp: true };
  assert.equal((await s.svc.invite('neema', { email: 'someone@example.com' })).delivery, undefined);
  assert.equal((await s.svc.invite('neema', { userId: 'juma' })).delivery, undefined);
  s.wa = { status: 'failed' };
  s.smsStatus = 'failed';
  const r = await s.svc.invite('neema', { phone: '0650387299' });
  assert.ok(r.share.link, 'the share link is still returned');
  assert.deepEqual(r.delivery, { whatsapp: 'failed', sms: 'failed' });
  const row = s.invites.rows.find(i => i.identifierValue === '+255650387299');
  assert.equal(row.sentAt ?? null, null, 'nothing counted as sent');
});

test('daily cap on messages FitFlex sends', async () => {
  const s = setup();
  s.on = { sms: true, whatsapp: false };
  process.env.FRIEND_INVITE_SEND_PER_DAY = '1';
  process.env.FRIEND_INVITE_CREATE_PER_HOUR = '50';
  try {
    assert.deepEqual((await s.svc.invite('neema', { phone: '0650000001' })).delivery, { sms: 'sent' });
    assert.equal((await s.svc.invite('neema', { phone: '0650000002' })).delivery.sms, 'skipped:daily_limit');
    assert.equal(s.delivered.length, 1);
  } finally { delete process.env.FRIEND_INVITE_SEND_PER_DAY; delete process.env.FRIEND_INVITE_CREATE_PER_HOUR; }
});
