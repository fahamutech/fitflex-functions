// Self-service account operations shared across all roles: profile save and
// account deletion (Play Store account-deletion requirement).
import { randomUUID } from 'node:crypto';

export function createAccountService({
  users, trainers, trainerBookings, checkins, auditLog,
  initFirebaseAdmin, getAdminAuth, approvalStatusForRole,
}) {
  async function deleteMyAccount(user) {
    if (user.userType === 'gym_operator') {
      const ownedGymIds = user.gymIds || (user.gymId ? [user.gymId] : []);
      let hasGymActivity = false;
      for (const id of ownedGymIds) {
        if (await checkins.findAsync(c => c.gymId === id)) { hasGymActivity = true; break; }
      }
      if (hasGymActivity) {
        return {
          error: 'gym_owner_has_checkin_activity', status: 409,
          message: 'Your gym(s) have check-in activity. Contact support@fitflex.af to transfer or close your gym(s) before deleting your account.'
        };
      }
    }

    const trainerProfile = user.userType === 'trainer' ? trainers.find(t => t.userId === user.id) : null;
    if (trainerProfile && await trainerBookings.findAsync(b => b.trainerId === trainerProfile.id)) {
      return {
        error: 'trainer_has_bookings', status: 409,
        message: 'Your trainer profile has bookings. Contact support@fitflex.af before deleting your account.'
      };
    }

    const sharedIdentity = user.firebaseUid
      ? await users.findAsync(u => u.id !== user.id && u.firebaseUid === user.firebaseUid)
      : null;
    if (user.firebaseUid && !sharedIdentity) {
      try {
        initFirebaseAdmin();
        await getAdminAuth().deleteUser(user.firebaseUid);
      } catch (fbErr) {
        console.warn('[account-delete] Firebase user deletion failed:', fbErr?.message);
      }
    }

    if (trainerProfile) await trainers.removeAsync(t => t.id === trainerProfile.id);
    await users.removeAsync(u => u.id === user.id);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: user.id, action: 'self_account_deleted',
      target: user.id, before: { email: user.email, phone: user.phone, userType: user.userType }, after: null,
    });
    return { ok: true, message: 'Your account and personal data have been deleted.' };
  }

  async function updateMemberProfile({ claims, user, body }) {
    const role = claims.userType || 'member';
    const current = user || {
      id: claims.sub,
      userType: role,
      accountStatus: 'active',
      approvalStatus: approvalStatusForRole(role),
      createdAt: new Date().toISOString()
    };
    const baseProfile = {
      ...current,
      displayName: body.displayName ?? current.displayName,
      phone: body.phone ?? current.phone,
      email: body.email ?? current.email ?? null,
      photoUrl: body.photoUrl ?? current.photoUrl ?? null,
      updatedAt: new Date().toISOString()
    };

    if (current.userType !== 'member') {
      const updated = await users.upsertAsync(u => u.id === current.id, baseProfile);
      return { user: updated };
    }

    const memberProfile = {
      ...(current.memberProfile || {}),
      fitnessGoal: body.fitnessGoal ?? current.memberProfile?.fitnessGoal ?? null,
      fitnessGoals: Array.isArray(body.fitnessGoals) ? body.fitnessGoals : (current.memberProfile?.fitnessGoals || []),
      fitnessLevel: body.fitnessLevel ?? current.memberProfile?.fitnessLevel ?? null,
      heightCm: body.heightCm ?? current.memberProfile?.heightCm ?? null,
      weightKg: body.weightKg ?? current.memberProfile?.weightKg ?? null,
      dateOfBirth: body.dateOfBirth ?? current.memberProfile?.dateOfBirth ?? null,
      gender: body.gender ?? current.memberProfile?.gender ?? null,
      preferredWorkoutTimes: Array.isArray(body.preferredWorkoutTimes)
        ? body.preferredWorkoutTimes
        : (current.memberProfile?.preferredWorkoutTimes || []),
      notificationPreferences: {
        ...(current.memberProfile?.notificationPreferences || {}),
        ...(body.notificationPreferences || {})
      }
    };
    const updated = await users.upsertAsync(u => u.id === current.id, {
      ...baseProfile,
      onboardingCompleted: true,
      memberProfile,
    });
    return { user: updated };
  }

  return { deleteMyAccount, updateMemberProfile };
}
