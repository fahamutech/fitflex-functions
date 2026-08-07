// A4 — member → trainer engagements: enquiries and "show interest".
// Pure DI: receives store collections via the factory.
import { randomUUID } from 'node:crypto';

export function createTrainerEngagementService({ trainerEngagements, trainers, users, trainerService }) {
  async function create({ memberId, trainerId, type, message, gymId }) {
    if (!['enquiry', 'interest'].includes(type)) return { error: 'invalid_type', status: 400 };
    const trainer = trainers.find(t => t.id === trainerId && t.status === 'active');
    if (!trainer) return { error: 'trainer_not_found', status: 404 };
    if (type === 'enquiry' && !message?.trim()) return { error: 'message_required', status: 400 };

    // Interest is idempotent — one active interest per member/trainer pair.
    if (type === 'interest') {
      const existing = await trainerEngagements.findAsync(
        e => e.memberId === memberId && e.trainerId === trainerId && e.type === 'interest',
      );
      if (existing) return { engagement: existing, idempotent: true };
    }

    const engagement = await trainerEngagements.insertAsync({
      id: `tng_${randomUUID().slice(0, 8)}`,
      memberId,
      trainerId,
      type,
      message: message?.trim() || null,
      gymId: gymId || null,
      status: 'new',
      createdAt: new Date().toISOString(),
    });
    return { engagement };
  }

  async function listForTrainer({ userId }) {
    const profile = trainerService.findProfileByUser(userId);
    if (!profile) return { error: 'trainer_profile_not_found', status: 404 };
    const rows = await trainerEngagements.filterAsync(e => e.trainerId === profile.id);
    const engagements = await Promise.all(
      rows
        .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
        .map(async (e) => {
          const member = await users.findByIdAsync(e.memberId);
          return {
            ...e,
            member: member
              ? { id: member.id, displayName: member.displayName || null, phone: member.phone || null, email: member.email || null }
              : null,
          };
        }),
    );
    return { engagements };
  }

  async function listForMember({ memberId }) {
    const rows = await trainerEngagements.filterAsync(e => e.memberId === memberId);
    return {
      engagements: rows.sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0)),
    };
  }

  return { create, listForTrainer, listForMember };
}
