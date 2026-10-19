// Friend invitations — Friends & Groups → People.
//
// A member asks another person to connect by email address or mobile number.
//   • The person is a member: a pending invitation lands in their
//     Notifications (inbox) with Approve / Reject on the card, and a push.
//   • The person is not on FitFlex: the inviter gets a personal link and a
//     ready-made message and shares it themselves from the device's share
//     sheet. FitFlex sends nothing by SMS, email or WhatsApp, and never
//     claims a message was delivered — creating the invitation is the only
//     thing it knows. When that person signs up and has verified the same
//     email or number, the invitation attaches to them and shows in their
//     Notifications like any other.
//
// A friendship (a follow each way, as everywhere in Friends & Groups) is
// created only when the recipient approves. Opening a link or a
// notification never creates one. Approving or rejecting is a single
// compare-and-set on the pending status, so a double tap or two devices
// can't create two friendships or two outcomes.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';

export const FRIEND_INVITATION_TYPE = 'friend_invitation';

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const isTokenShape = t => typeof t === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(t);

export const friendInvitationLimits = () => ({
  expiryDays: num('FRIEND_INVITE_EXPIRY_DAYS', 30),
  createPerHour: num('FRIEND_INVITE_CREATE_PER_HOUR', 20),
  lookupPerHour: num('FRIEND_INVITE_LOOKUP_PER_HOUR', 40),
  redeclineDays: num('FRIEND_INVITE_REINVITE_AFTER_DAYS', 30),
  sendsPerDay: num('FRIEND_INVITE_SEND_PER_DAY', 10),
  resendWaitHours: num('FRIEND_INVITE_RESEND_WAIT_HOURS', 24),
});

/** "Neema Abdallah" → "N**** A*******": enough to recognise, not to identify. */
export function maskName(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean)
    .map(part => part[0].toUpperCase() + '*'.repeat(Math.max(part.length - 1, 1))).join(' ') || null;
}

/** { type, value } for exactly one valid email or phone, or null. */
export function parseContact({ email, phone } = {}) {
  if (email && phone) return null;
  if (email) {
    const value = normalizeEmail(email);
    return value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? { type: 'email', value } : null;
  }
  if (phone) {
    const value = normalizePhone(phone);
    return value ? { type: 'phone', value } : null;
  }
  return null;
}

export function createFriendInvitationService({
  users, follows, blocks, invites, notifications,
  notify = async () => {},
  // ({ type, value }) → the member who owns that VERIFIED email / phone, or null.
  // Must never match on User.email / User.phone (unverified, self-editable).
  findMember,
  // (userId) → [{ type, value }] VERIFIED contacts of the person behind that
  // member. The only source of contacts for attaching and claiming invitations.
  contactsFor = async () => [],
  // Sending the invitation ourselves, only when the flags are on. WhatsApp
  // first; SMS when the number has no WhatsApp (or WhatsApp can't be used).
  //   delivery() → { sms: boolean, whatsapp: boolean }  what is switched on right now
  //   channels.whatsapp({ phone, inviterName, link, locale, reference })
  //        → { status: 'sent', providerMessageId } | { status: 'skipped:<why>' } | { status: 'failed' }
  //   channels.sms({ phone, text, reference }) → { status: 'sent' | 'failed' | 'skipped:<why>' }
  //   channels.whatsappStatus(providerMessageId) → 'delivered' | 'read' | 'sent' | 'failed' | null
  //   handleOf(userId) → the member's @username, or null
  delivery = () => ({ sms: false, whatsapp: false }),
  channels = null,
  handleOf = async () => null,
  // (id, fromStatus, patch) → true when that row was in `fromStatus` and is now patched. Atomic.
  transition,
  // Public base URL the invitation link lives under.
  baseLink = () => process.env.FRIEND_INVITE_BASE_URL || process.env.APP_DOWNLOAD_LINK || 'https://fitflex-af-app.web.app',
  now = () => new Date(),
}) {
  const iso = (d = now()) => new Date(d).toISOString();
  const limits = friendInvitationLimits;
  // Per-instance lookup throttle (the create limit is counted from the table).
  const lookups = new Map();

  const nameOf = async userId => {
    const u = userId ? await users.findByIdAsync(userId) : null;
    return u?.displayName?.trim() || null;
  };
  const isBlocked = async (a, b) => {
    const mine = await blocks.filterByColumnAsync('blockerId', a);
    if (mine.some(x => x.blockedId === b)) return true;
    return (await blocks.filterByColumnAsync('blockerId', b)).some(x => x.blockedId === a);
  };
  const connection = async (a, b) => {
    const [out, inc] = await Promise.all([follows.filterByColumnAsync('followerId', a), follows.filterByColumnAsync('followeeId', a)]);
    const f = out.some(x => x.followeeId === b), r = inc.some(x => x.followerId === b);
    return f && r ? 'friends' : f ? 'following' : r ? 'follows_you' : 'none';
  };
  const expired = inv => +new Date(inv.expiresAt) <= +now();

  function throttleLookups(userId) {
    const hour = Math.floor(+now() / 3600e3);
    const rec = lookups.get(userId);
    const count = rec && rec.hour === hour ? rec.count + 1 : 1;
    lookups.set(userId, { hour, count });
    return count > limits().lookupPerHour;
  }

  /** The invitation as the inviter / recipient see it — never any contact detail. */
  async function view(inv, viewerId) {
    const mine = inv.inviterId === viewerId;
    const otherId = mine ? inv.recipientUserId : inv.inviterId;
    return {
      id: inv.id,
      status: inv.status === 'pending' && expired(inv) ? 'expired' : inv.status,
      direction: mine ? 'outgoing' : 'incoming',
      userId: otherId ?? null,
      // Whoever you invited stays masked until they accept, as in search.
      name: otherId
        ? (mine && inv.status !== 'accepted' ? maskName(await nameOf(otherId)) : await nameOf(otherId))
        : null,
      // The inviter typed this contact themselves, so they may see it again;
      // the recipient never gets it, and no notification carries it.
      contactType: mine ? inv.identifierType : null,
      contact: mine ? inv.identifierValue ?? null : null,
      // How FitFlex itself sent it (inviter only): 'whatsapp', 'sms' or both,
      // and whether WhatsApp could not deliver so SMS was used instead.
      sentBy: mine && inv.sentAt ? String(inv.sentVia || '').split(',').filter(Boolean) : [],
      sentAt: mine && inv.sentAt ? iso(inv.sentAt) : null,
      whatsappFailed: mine ? inv.waState === 'failed' : false,
      createdAt: iso(inv.createdAt),
      expiresAt: iso(inv.expiresAt),
      respondedAt: inv.respondedAt ? iso(inv.respondedAt) : null,
    };
  }

  async function writeNotification(inv) {
    const name = (await nameOf(inv.inviterId)) ?? 'Someone';
    const res = await notify(inv.recipientUserId, {
      id: `ntf_fi_${inv.id}`,
      type: FRIEND_INVITATION_TYPE,
      title: 'Friend invitation',
      body: `${name} wants to connect with you on FitFlex Africa.`,
      data: { invitationId: inv.id, inviterId: inv.inviterId, inviterName: name, status: 'pending' },
    });
    const notificationId = res?.notification?.id ?? `ntf_fi_${inv.id}`;
    await invites.updateByIdAsync(inv.id, { notificationId, updatedAt: iso() });
    return notificationId;
  }

  /** Mirror the invitation's outcome on its inbox card and mark it read. */
  async function settleNotification(inv, status) {
    const id = inv.notificationId ?? `ntf_fi_${inv.id}`;
    try {
      const row = await notifications.findByIdAsync(id);
      if (!row || row.userId !== inv.recipientUserId) return;
      await notifications.updateByIdAsync(id, { data: { ...(row.data || {}), status }, readAt: row.readAt ?? iso() });
    } catch { /* the card is a convenience; the invitation is the record */ }
  }

  async function message(inv, token, inviterName, locale) {
    // The token rides in the fragment (after '#'): browsers and the app read
    // it, but it is never sent to Firebase Hosting / the CDN, so it stays out
    // of their request logs. The path stays /friend-invite/ so the Android
    // App Link (pathPrefix /friend-invite/) still opens the app.
    const link = `${String(baseLink()).replace(/\/+$/, '')}/friend-invite/#${token}`;
    const sw = locale === 'sw';
    const text = sw
      ? `Habari! ${inviterName} amekualika uungane kwenye FitFlex Africa. Jiunge na FitFlex ili uungane na jumuiya yako ya mazoezi na ugundue fursa za mazoezi. Jisajili hapa: ${link}`
      : `Hi! ${inviterName} has invited you to connect on FitFlex Africa. Join FitFlex to connect with your fitness community and explore fitness opportunities. Register here: ${link}`;
    return { link, text, subject: sw ? `${inviterName} amekualika kwenye FitFlex Africa` : `${inviterName} invited you to FitFlex Africa` };
  }

  // ── Search by email / phone ────────────────────────────────────────────

  /**
   * What exists for that email or phone: a member (shown by a masked name
   * unless they're already connected), or nobody (so the inviter can share
   * a link). Reveals no more than the contact search of organisations does.
   */
  async function lookup(userId, query) {
    const contact = parseContact(query);
    if (!contact) return { error: 'invalid_contact', status: 400 };
    if (throttleLookups(userId)) return { error: 'too_many_requests', status: 429 };
    const member = await findMember(contact);
    if (member && member.id === userId) return { error: 'cannot_invite_yourself', status: 400 };
    if (!member || await isBlocked(userId, member.id)) {
      // A blocked member looks like nobody: no way to probe around a block.
      const d = delivery();
      return { result: { kind: 'unregistered', contactType: contact.type, delivery: contact.type === 'phone' ? { sms: d.sms, whatsapp: d.whatsapp } : { sms: false, whatsapp: false } } };
    }
    const relationship = await connection(userId, member.id);
    const open = (await invites.filterByColumnAsync('inviterId', userId))
      .find(i => i.recipientUserId === member.id && i.status === 'pending' && !expired(i));
    const known = relationship !== 'none';
    return {
      result: {
        kind: 'member',
        userId: member.id,
        name: known ? member.displayName : maskName(member.displayName),
        relationship,
        request: open ? { id: open.id, status: 'pending' } : null,
      },
    };
  }

  // ── Create ─────────────────────────────────────────────────────────────

  async function recentCreates(userId) {
    const since = +now() - 3600e3;
    return (await invites.filterByColumnAsync('inviterId', userId)).filter(i => +new Date(i.createdAt) >= since).length;
  }

  /**
   * Invite a person by { userId } (a member already found), or by
   * { email } / { phone }. Returns the invitation; for someone not on
   * FitFlex it also returns the one-time link and message to share.
   */
  async function invite(userId, body = {}, { locale = 'en' } = {}) {
    const inviter = await users.findByIdAsync(userId);
    if (!inviter || inviter.userType !== 'member' || inviter.accountStatus === 'suspended') return { error: 'not_allowed', status: 403 };
    if (await recentCreates(userId) >= limits().createPerHour) return { error: 'too_many_requests', status: 429 };

    let target = null; // member user
    let contact = null;
    if (body.userId) {
      const u = await users.findByIdAsync(String(body.userId));
      if (u && u.userType === 'member' && u.accountStatus !== 'suspended') target = u;
      else return { error: 'not_found', status: 404 };
    } else {
      contact = parseContact(body);
      if (!contact) return { error: 'invalid_contact', status: 400 };
      target = await findMember(contact);
    }
    if (target?.id === userId) return { error: 'cannot_invite_yourself', status: 400 };
    if (target && await isBlocked(userId, target.id)) return { error: 'not_found', status: 404 };

    const mine = await invites.filterByColumnAsync('inviterId', userId);
    const t = iso();
    const expiresAt = iso(+now() + limits().expiryDays * 86400e3);

    if (target) {
      if (await connection(userId, target.id) === 'friends') return { error: 'already_friends', status: 409 };
      // They already asked you: say so rather than crossing requests.
      const theirs = (await invites.filterByColumnAsync('inviterId', target.id))
        .find(i => i.recipientUserId === userId && i.status === 'pending' && !expired(i));
      if (theirs) return { error: 'they_invited_you', status: 409, invitationId: theirs.id };
      const open = mine.find(i => i.recipientUserId === target.id && i.status === 'pending' && !expired(i));
      if (open) return { invitation: await view(open, userId), duplicate: true };
      const declined = mine.find(i => i.recipientUserId === target.id && i.status === 'rejected'
        && +now() - +new Date(i.respondedAt ?? i.updatedAt) < limits().redeclineDays * 86400e3);
      if (declined) return { error: 'recently_declined', status: 409 };
      const row = {
        id: newId('fri'), inviterId: userId, recipientUserId: target.id, identifierType: null, identifierValue: null,
        tokenHash: null, status: 'pending', notificationId: null, expiresAt, respondedAt: null, createdAt: t, updatedAt: t,
      };
      try {
        await invites.insertAsync(row);
      } catch (err) {
        if (!/unique|duplicate/i.test(err.message ?? '')) throw err;
        const again = (await invites.filterByColumnAsync('inviterId', userId))
          .find(i => i.recipientUserId === target.id && i.status === 'pending');
        return again ? { invitation: await view(again, userId), duplicate: true } : { error: 'conflict', status: 409 };
      }
      await writeNotification(row);
      return { invitation: await view(row, userId) };
    }

    // Not on FitFlex: a tokenised invitation to share.
    const open = mine.find(i => !i.recipientUserId && i.identifierType === contact.type
      && i.identifierValue === contact.value && i.status === 'pending' && !expired(i));
    const token = newToken();
    // The message names the inviter by their FitFlex @username when they have one.
    const handle = await handleOf(userId);
    const inviterName = handle ? `@${handle}` : ((await nameOf(userId)) ?? 'A FitFlex member');
    if (open) {
      // The plain token is never stored, so sharing again issues a fresh link.
      await invites.updateByIdAsync(open.id, { tokenHash: sha256(token), updatedAt: t });
      const share = await message(open, token, inviterName, locale);
      const sent = await sendIt(open, contact, share, inviterName, locale, mine);
      return { invitation: await view({ ...open }, userId), share, ...(sent ? { delivery: sent } : {}), duplicate: true };
    }
    const declined = mine.find(i => i.identifierType === contact.type && i.identifierValue === contact.value
      && i.status === 'rejected' && +now() - +new Date(i.respondedAt ?? i.updatedAt) < limits().redeclineDays * 86400e3);
    if (declined) return { error: 'recently_declined', status: 409 };
    const row = {
      id: newId('fri'), inviterId: userId, recipientUserId: null, identifierType: contact.type, identifierValue: contact.value,
      tokenHash: sha256(token), status: 'pending', notificationId: null, expiresAt, respondedAt: null, createdAt: t, updatedAt: t,
    };
    try {
      await invites.insertAsync(row);
    } catch (err) {
      if (!/unique|duplicate/i.test(err.message ?? '')) throw err;
      return { error: 'conflict', status: 409 };
    }
    const share = await message(row, token, inviterName, locale);
    const sent = await sendIt(row, contact, share, inviterName, locale, mine);
    return { invitation: await view(row, userId), share, ...(sent ? { delivery: sent } : {}) };
  }

  /**
   * FitFlex sends the invitation itself when the flags are on and the contact
   * is a mobile number: WhatsApp first; if WhatsApp can't be used right now
   * (not set up, template not approved, rejected) SMS goes at once; if
   * WhatsApp accepts it but later reports the number isn't on WhatsApp,
   * resolveFallbacks() sends the SMS. A number that opted out of WhatsApp
   * gets nothing. Capped per inviter per day and not repeated within the
   * resend wait. A failure never fails the invitation: the member can still
   * use the share sheet.
   */
  async function sendIt(inv, contact, share, inviterName, locale, mine) {
    const on = delivery();
    if (!channels || contact.type !== 'phone' || (!on.sms && !on.whatsapp)) return null;
    const lim = limits();
    const since = +now() - 24 * 3600e3;
    const sentToday = mine.filter(i => i.sentAt && +new Date(i.sentAt) >= since).length;
    if (sentToday >= lim.sendsPerDay) return { sms: 'skipped:daily_limit', whatsapp: 'skipped:daily_limit' };
    const fresh = await invites.findByIdAsync(inv.id);
    if (fresh?.sentAt && +now() - +new Date(fresh.sentAt) < lim.resendWaitHours * 3600e3) {
      return { sms: 'skipped:recently_sent', whatsapp: 'skipped:recently_sent' };
    }
    const out = {};
    const via = [];
    let patch = {};
    if (on.whatsapp) {
      let wa;
      try {
        wa = await channels.whatsapp({ phone: contact.value, inviterName, link: share.link, locale, reference: inv.id });
      } catch { wa = { status: 'failed' }; }
      out.whatsapp = wa.status;
      if (wa.status === 'sent') {
        via.push('whatsapp');
        patch = { waMessageId: wa.providerMessageId ?? null, waState: wa.providerMessageId ? 'pending' : 'unknown' };
      }
    }
    // A number that opted out of WhatsApp from FitFlex hears nothing from us by SMS either.
    const optedOut = out.whatsapp === 'skipped:recipient_opted_out';
    if (on.sms && out.whatsapp !== 'sent' && !optedOut) {
      out.sms = await smsOnce(inv, share.text);
      if (out.sms === 'sent') via.push('sms');
    } else if (on.sms) {
      out.sms = optedOut ? 'skipped:recipient_opted_out' : 'skipped:whatsapp_sent';
    }
    if (via.length) await invites.updateByIdAsync(inv.id, { sentAt: iso(), sentVia: via.join(','), ...patch, updatedAt: iso() });
    return out;
  }

  async function smsOnce(inv, text) {
    try {
      const r = await channels.sms({ phone: inv.identifierValue, text, reference: inv.id });
      return r.status;
    } catch { return 'failed'; }
  }

  /**
   * Job: for invitations WhatsApp accepted, ask the provider what became of
   * them. 'failed' means the number has no WhatsApp (or can't receive it):
   * send the SMS instead, once. Delivered / read: done. Anything else waits;
   * after a day it is left alone. Safe to run often and to overlap.
   */
  async function resolveFallbacks() {
    if (!channels?.whatsappStatus) return { checked: 0, sms: 0 };
    const pending = (await invites.filterByColumnAsync('waState', 'pending')).filter(i => i.waMessageId);
    let checked = 0, sms = 0;
    for (const inv of pending) {
      checked += 1;
      const age = +now() - +new Date(inv.sentAt ?? inv.createdAt);
      let status = null;
      try { status = await channels.whatsappStatus(inv.waMessageId); } catch { status = null; }
      if (status === 'delivered' || status === 'read') {
        await transition(inv.id, 'pending', { waState: 'delivered', updatedAt: iso() }, { column: 'waState', from: 'pending' });
      } else if (status === 'failed') {
        // Claim the fallback first, so two runs never send two SMS.
        const won = await transition(inv.id, 'pending', { waState: 'failed', updatedAt: iso() }, { column: 'waState', from: 'pending' });
        if (!won) continue;
        const fresh = await invites.findByIdAsync(inv.id);
        if (fresh?.status !== 'pending' || !delivery().sms) continue;
        const text = await fallbackText(fresh);
        if (!text) continue;
        if (await smsOnce(fresh, text) === 'sent') {
          sms += 1;
          const via = new Set(String(fresh.sentVia || '').split(',').filter(Boolean)); via.add('sms');
          await invites.updateByIdAsync(inv.id, { sentVia: [...via].join(','), updatedAt: iso() });
        }
      } else if (age > 24 * 3600e3) {
        await transition(inv.id, 'pending', { waState: 'unknown', updatedAt: iso() }, { column: 'waState', from: 'pending' });
      }
    }
    return { checked, sms };
  }

  /** The SMS text for an invitation: a fresh link (the old token is hashed, so a new one is issued). */
  async function fallbackText(inv) {
    const token = newToken();
    await invites.updateByIdAsync(inv.id, { tokenHash: sha256(token), updatedAt: iso() });
    const handle = await handleOf(inv.inviterId);
    const inviterName = handle ? `@${handle}` : ((await nameOf(inv.inviterId)) ?? 'A FitFlex member');
    return (await message(inv, token, inviterName, 'en')).text;
  }

  // ── Link: preview, claim, attach ───────────────────────────────────────

  async function byToken(token) {
    if (!isTokenShape(token)) return null;
    const hash = sha256(token);
    return (await invites.filterByColumnAsync('tokenHash', hash))[0] ?? null;
  }

  /** What an invitation link is for, before anyone signs in. No contact detail. */
  async function preview(token) {
    const inv = await byToken(token);
    if (!inv) return { error: 'invalid_invitation', status: 404 };
    const status = inv.status === 'pending' && expired(inv) ? 'expired' : inv.status;
    return { invitation: { status, inviterName: status === 'pending' ? await nameOf(inv.inviterId) : null, contactType: inv.identifierType } };
  }

  /** Attach an invitation to the member it was meant for and tell them. */
  async function attach(inv, memberId) {
    if (!(await transition(inv.id, 'pending', { recipientUserId: memberId, tokenHash: null, updatedAt: iso() }, { whereRecipientNull: true }))) return false;
    const fresh = await invites.findByIdAsync(inv.id);
    if (fresh) await writeNotification(fresh);
    return true;
  }

  /**
   * The signed-in member opened a link. Attaches the invitation to them only
   * if they have verified the very email / number it was made for — the
   * token alone grants nothing. Idempotent.
   */
  async function claim(userId, token) {
    const inv = await byToken(token);
    if (!inv) return { error: 'invalid_invitation', status: 404 };
    if (inv.recipientUserId && inv.recipientUserId !== userId) return { error: 'invalid_invitation', status: 404 };
    if (inv.inviterId === userId) return { error: 'cannot_invite_yourself', status: 400 };
    if (inv.status !== 'pending') return { error: `invitation_${inv.status}`, status: 410 };
    if (expired(inv)) return { error: 'invitation_expired', status: 410 };
    if (inv.recipientUserId === userId) return { invitation: await view(inv, userId) };
    const me = await users.findByIdAsync(userId);
    const mine = me && me.userType === 'member' ? await contactsOf(me) : [];
    if (!mine.some(c => c.type === inv.identifierType && c.value === inv.identifierValue)) {
      return { error: 'contact_mismatch', status: 403, contactType: inv.identifierType };
    }
    if (await isBlocked(inv.inviterId, userId)) return { error: 'invalid_invitation', status: 404 };
    await attach(inv, userId);
    const now2 = await invites.findByIdAsync(inv.id);
    return { invitation: await view(now2, userId) };
  }

  // Only contacts the person has PROVEN: verified LoginIdentifier rows, via
  // contactsFor. User.email / User.phone are never used here: an unverified
  // Firebase sign-up stores its email there, and POST /me/profile lets anyone
  // type any email or number into their own row, so neither proves anything.
  const contactsOf = async u => {
    const all = (await contactsFor(u.id))
      .map(c => ({ type: c.type, value: c.type === 'email' ? normalizeEmail(c.value) : c.type === 'phone' ? normalizePhone(c.value) : null }))
      .filter(c => c.value);
    return all.filter((c, i) => all.findIndex(x => x.type === c.type && x.value === c.value) === i);
  };

  /**
   * Called when a member's inbox or invitations are opened: invitations made
   * for an email / number this member has verified become theirs. This is
   * how someone who registered after being invited finds the request under
   * Notifications without needing the link at all.
   */
  async function attachFor(userId) {
    const me = await users.findByIdAsync(userId);
    if (!me || me.userType !== 'member') return 0;
    let attached = 0;
    for (const c of await contactsOf(me)) {
      const open = (await invites.filterAsync(i => !i.recipientUserId && i.status === 'pending'
        && i.identifierType === c.type && i.identifierValue === c.value));
      for (const inv of open) {
        if (inv.inviterId === userId || expired(inv)) continue;
        if (await isBlocked(inv.inviterId, userId)) continue;
        if (await attach(inv, userId)) attached += 1;
      }
    }
    return attached;
  }

  // ── Respond ────────────────────────────────────────────────────────────

  async function respond(userId, invitationId, accept) {
    const inv = await invites.findByIdAsync(String(invitationId));
    if (!inv || inv.recipientUserId !== userId) return { error: 'not_found', status: 404 };
    const wanted = accept ? 'accepted' : 'rejected';
    // Already answered (a double tap, another device, a stale card).
    if (inv.status === wanted) return { invitation: await view(inv, userId), already: true };
    if (inv.status !== 'pending') return { error: `invitation_${inv.status}`, status: 409, invitation: await view(inv, userId) };
    if (expired(inv)) {
      await transition(inv.id, 'pending', { status: 'expired', updatedAt: iso() });
      await settleNotification(inv, 'expired');
      return { error: 'invitation_expired', status: 410 };
    }
    if (accept && await isBlocked(inv.inviterId, userId)) {
      await transition(inv.id, 'pending', { status: 'revoked', respondedAt: iso(), updatedAt: iso() });
      await settleNotification(inv, 'revoked');
      return { error: 'not_found', status: 404 };
    }
    const won = await transition(inv.id, 'pending', { status: wanted, respondedAt: iso(), updatedAt: iso() });
    if (!won) {
      const current = await invites.findByIdAsync(inv.id);
      if (current?.status === wanted) return { invitation: await view(current, userId), already: true };
      return { error: `invitation_${current?.status ?? 'unavailable'}`, status: 409, invitation: current ? await view(current, userId) : undefined };
    }
    if (accept) {
      await makeFriends(inv.inviterId, userId);
      const name = (await nameOf(userId)) ?? 'Someone';
      await notify(inv.inviterId, {
        type: 'social_friends', title: 'You\'re friends', body: `${name} accepted your friend invitation.`, data: { userId },
      });
    }
    await settleNotification(inv, wanted);
    return { invitation: await view(await invites.findByIdAsync(inv.id), userId) };
  }

  /** A follow each way — what "friends" means everywhere in Friends & Groups. */
  async function makeFriends(a, b) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const have = (await follows.filterByColumnAsync('followerId', from)).some(f => f.followeeId === to);
      if (have) continue;
      try {
        await follows.insertAsync({ id: newId('flw'), followerId: from, followeeId: to, createdAt: iso() });
      } catch (err) {
        if (!/unique|duplicate/i.test(err.message ?? '')) throw err;
      }
    }
  }

  const approve = (userId, id) => respond(userId, id, true);
  const reject = (userId, id) => respond(userId, id, false);

  /** The inviter withdraws a pending invitation. */
  async function revoke(userId, invitationId) {
    const inv = await invites.findByIdAsync(String(invitationId));
    if (!inv || inv.inviterId !== userId) return { error: 'not_found', status: 404 };
    if (inv.status === 'revoked') return { invitation: await view(inv, userId), already: true };
    if (inv.status !== 'pending') return { error: `invitation_${inv.status}`, status: 409 };
    const won = await transition(inv.id, 'pending', { status: 'revoked', respondedAt: iso(), updatedAt: iso(), tokenHash: null });
    if (won && inv.recipientUserId) await settleNotification(inv, 'revoked');
    return { invitation: await view(await invites.findByIdAsync(inv.id), userId) };
  }

  /** Invitations to answer, and the ones this member sent. */
  async function list(userId) {
    await attachFor(userId);
    const [incoming, outgoing] = await Promise.all([
      invites.filterByColumnAsync('recipientUserId', userId),
      invites.filterByColumnAsync('inviterId', userId),
    ]);
    const sort = rows => rows.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return {
      incoming: await Promise.all(sort(incoming.filter(i => i.status === 'pending' && !expired(i))).map(i => view(i, userId))),
      outgoing: await Promise.all(sort(outgoing.filter(i => i.status !== 'revoked')).slice(0, 100).map(i => view(i, userId))),
    };
  }

  return { lookup, invite, preview, claim, attachFor, approve, reject, revoke, list, resolveFallbacks };
}
