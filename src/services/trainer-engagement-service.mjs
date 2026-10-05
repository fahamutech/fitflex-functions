// A4 — member → trainer engagements: enquiries and "show interest", as
// two-way conversations. The trainer can reply and close; the member can
// follow up (which reopens a closed one). Each side is notified in their
// inbox (and by push) when the other writes.
// Pure DI: receives store collections via the factory.
import { randomUUID } from 'node:crypto';
import { notificationText } from '../shared/notification-texts.mjs';

export const ENQUIRY_TEXT_MAX = 1000;

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const preview = (text) => (text.length > 120 ? `${text.slice(0, 117)}…` : text);

/**
 * The conversation, oldest first. Enquiries from before threads existed have
 * only `message`, which becomes the member's first message.
 */
export function engagementThread(e) {
  const messages = Array.isArray(e?.messages) ? e.messages : [];
  if (messages.length) return messages.map(m => ({ ...m, at: iso(m.at) }));
  return e?.message ? [{ id: `${e.id}_0`, from: 'member', text: e.message, at: iso(e.createdAt) }] : [];
}

/** Unread for `side`: the other side wrote last, after this side last read. */
export function unreadFor(e, side) {
  const last = e?.lastMessageAt ? +new Date(e.lastMessageAt) : null;
  if (!last || e.lastMessageFrom === side) return false;
  const read = side === 'trainer' ? e.trainerReadAt : e.memberReadAt;
  return !read || +new Date(read) < last;
}

export function createTrainerEngagementService({
  trainerEngagements, trainers, users, trainerService, notify = async () => {}, now = () => new Date(),
}) {
  const cleanText = (text) => {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return { error: 'message_required', status: 400 };
    if (t.length > ENQUIRY_TEXT_MAX) return { error: 'message_too_long', status: 400 };
    return { text: t };
  };

  // Notifications are best-effort: a failed push never fails the message.
  const tell = async (userId, message) => {
    if (!userId) return;
    try { await notify(userId, message); } catch { /* best-effort */ }
  };

  async function create({ memberId, trainerId, type, message, gymId }) {
    if (!['enquiry', 'interest'].includes(type)) return { error: 'invalid_type', status: 400 };
    const trainer = trainers.find(t => t.id === trainerId && t.status === 'active');
    if (!trainer) return { error: 'trainer_not_found', status: 404 };
    let text = null;
    if (type === 'enquiry') {
      const c = cleanText(message);
      if (c.error) return c;
      text = c.text;
    }

    // Interest is idempotent — one active interest per member/trainer pair.
    if (type === 'interest') {
      const existing = await trainerEngagements.findAsync(
        e => e.memberId === memberId && e.trainerId === trainerId && e.type === 'interest',
      );
      if (existing) return { engagement: existing, idempotent: true };
    }

    const at = now().toISOString();
    const engagement = await trainerEngagements.insertAsync({
      id: `tng_${randomUUID().slice(0, 8)}`,
      memberId,
      trainerId,
      type,
      message: text,
      messages: text ? [{ id: `tnm_${randomUUID().slice(0, 8)}`, from: 'member', text, at }] : [],
      gymId: gymId || null,
      status: 'new',
      lastMessageAt: at,
      lastMessageFrom: 'member',
      trainerReadAt: null,
      memberReadAt: at,
      createdAt: at,
      updatedAt: at,
    });
    const member = await users.findByIdAsync(memberId);
    const memberName = member?.displayName || null;
    await tell(trainer.userId, type === 'enquiry'
      ? { type: 'trainer_enquiry', ...notificationText('trainer_enquiry', { memberName, preview: preview(text) }), data: { engagementId: engagement.id } }
      : { type: 'trainer_interest', ...notificationText('trainer_interest', { memberName }), data: { engagementId: engagement.id } });
    return { engagement };
  }

  function forTrainer(e, member) {
    return {
      ...e,
      createdAt: iso(e.createdAt), updatedAt: iso(e.updatedAt), lastMessageAt: iso(e.lastMessageAt),
      trainerReadAt: iso(e.trainerReadAt), memberReadAt: iso(e.memberReadAt),
      messages: engagementThread(e),
      unread: unreadFor(e, 'trainer'),
      member: member
        ? { id: member.id, displayName: member.displayName || null, phone: member.phone || null, email: member.email || null, photoUrl: member.photoUrl || null }
        : null,
    };
  }

  function forMember(e, trainer) {
    return {
      ...e,
      createdAt: iso(e.createdAt), updatedAt: iso(e.updatedAt), lastMessageAt: iso(e.lastMessageAt),
      trainerReadAt: iso(e.trainerReadAt), memberReadAt: iso(e.memberReadAt),
      messages: engagementThread(e),
      unread: unreadFor(e, 'member'),
      trainer: trainer ? { id: trainer.id, displayName: trainer.displayName || null, photoUrl: trainer.photoUrl || null } : null,
    };
  }

  const newestFirst = (a, b) => +new Date(b.lastMessageAt || b.createdAt || 0) - +new Date(a.lastMessageAt || a.createdAt || 0);

  async function listForTrainer({ userId }) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const rows = await trainerEngagements.filterAsync(e => e.trainerId === profile.id);
    const engagements = await Promise.all(
      rows.sort(newestFirst).map(async (e) => forTrainer(e, await users.findByIdAsync(e.memberId))),
    );
    return { engagements, unread: engagements.filter(e => e.unread).length };
  }

  async function listForMember({ memberId }) {
    const rows = await trainerEngagements.filterAsync(e => e.memberId === memberId);
    const engagements = rows.sort(newestFirst).map(e => forMember(e, trainers.find(t => t.id === e.trainerId)));
    return { engagements, unread: engagements.filter(e => e.unread).length };
  }

  async function loadForTrainer(userId, id) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const e = await trainerEngagements.findByIdAsync(id);
    if (!e || e.trainerId !== profile.id) return { error: 'not_found', status: 404 };
    return { e, profile };
  }

  async function loadForMember(memberId, id) {
    const e = await trainerEngagements.findByIdAsync(id);
    if (!e || e.memberId !== memberId) return { error: 'not_found', status: 404 };
    return { e };
  }

  /** Append a message; `patch` sets status/read times. */
  async function append(e, from, text, patch = {}) {
    const at = now().toISOString();
    const messages = [...engagementThread(e), { id: `tnm_${randomUUID().slice(0, 8)}`, from, text, at }];
    return trainerEngagements.updateByIdAsync(e.id, {
      messages, lastMessageAt: at, lastMessageFrom: from, updatedAt: at,
      ...(from === 'trainer' ? { trainerReadAt: at } : { memberReadAt: at }),
      ...patch,
    });
  }

  async function replyAsTrainer({ userId, id, message }) {
    const r = await loadForTrainer(userId, id);
    if (r.error) return r;
    const c = cleanText(message);
    if (c.error) return c;
    const updated = await append(r.e, 'trainer', c.text, { status: 'replied' });
    await tell(r.e.memberId, {
      type: 'trainer_enquiry_reply',
      ...notificationText('trainer_enquiry_reply', { trainerName: r.profile.displayName || null, preview: preview(c.text) }),
      data: { engagementId: r.e.id, trainerId: r.profile.id },
    });
    return { engagement: forTrainer(updated, await users.findByIdAsync(r.e.memberId)) };
  }

  async function markReadByTrainer({ userId, id }) {
    const r = await loadForTrainer(userId, id);
    if (r.error) return r;
    const updated = await trainerEngagements.updateByIdAsync(r.e.id, {
      trainerReadAt: now().toISOString(),
      ...(r.e.status === 'new' ? { status: 'read' } : {}),
    });
    return { engagement: forTrainer(updated, await users.findByIdAsync(r.e.memberId)) };
  }

  async function closeByTrainer({ userId, id }) {
    const r = await loadForTrainer(userId, id);
    if (r.error) return r;
    const at = now().toISOString();
    const updated = await trainerEngagements.updateByIdAsync(r.e.id, { status: 'closed', trainerReadAt: at, updatedAt: at });
    return { engagement: forTrainer(updated, await users.findByIdAsync(r.e.memberId)) };
  }

  async function replyAsMember({ memberId, id, message }) {
    const r = await loadForMember(memberId, id);
    if (r.error) return r;
    const c = cleanText(message);
    if (c.error) return c;
    const trainer = trainers.find(t => t.id === r.e.trainerId);
    // A follow-up reopens a closed conversation for the trainer.
    const updated = await append(r.e, 'member', c.text, { status: 'new' });
    const member = await users.findByIdAsync(memberId);
    await tell(trainer?.userId, {
      type: 'trainer_enquiry',
      ...notificationText('trainer_enquiry_member_reply', { memberName: member?.displayName || null, preview: preview(c.text) }),
      data: { engagementId: r.e.id },
    });
    return { engagement: forMember(updated, trainer) };
  }

  async function markReadByMember({ memberId, id }) {
    const r = await loadForMember(memberId, id);
    if (r.error) return r;
    const updated = await trainerEngagements.updateByIdAsync(r.e.id, { memberReadAt: now().toISOString() });
    return { engagement: forMember(updated, trainers.find(t => t.id === r.e.trainerId)) };
  }

  return {
    create, listForTrainer, listForMember,
    replyAsTrainer, markReadByTrainer, closeByTrainer, replyAsMember, markReadByMember,
  };
}
