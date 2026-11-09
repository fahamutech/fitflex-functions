// Self-service account operations shared across all roles: profile save and
// account deletion (Play Store account-deletion requirement).
import { toSessionUser } from '../shared/session-user.mjs';
import { parseDateOfBirthInput } from '../shared/date-of-birth.mjs';
import { checkMediaFields, storedMedia } from '../shared/media-src.mjs';

export function createAccountService({
  users, trainers, trainerBookings, checkins,
  initFirebaseAdmin, getAdminAuth, approvalStatusForRole,
  // Removes or anonymises everything about the account, in one transaction (src/infra/account-erasure-store-pg.mjs):
  // (userId, { beforeCommit }) → { ok, trainerProfileId } | { missing: true }. Throws and leaves everything as it was on failure.
  eraseAccount,
  // False on a local or CI server with no Firebase project: there is no login to delete.
  firebaseConfigured = () => true,
  // Called once the account is gone, for what cannot share its transaction: (userId, user) => void.
  onAccountDeleted = async () => {},
  // Partner DOB security review M1 (variant 3): ({ user, dateOfBirth }) → null | { error, status }.
  // Refuses a member date of birth under 18 for a person who holds a trainer or gym-owner role.
  memberDobGuard = async () => null,
  // S6 (D53): ({ userId }) → true when the user owns an event organizer (EventOrganizer.ownerUserId is RESTRICT: transfer or close it first).
  ownsEventOrganizer = async () => false,
  // ({ userId }) → true when a paid order of theirs is still on its way: deleting would take the delivery
  // address and the buyer's contact from the vendor (owner decision 2026-10-30).
  hasOpenPaidOrder = async () => false,
}) {
  async function deleteMyAccount(user) {
    if (await ownsEventOrganizer({ userId: user.id })) {
      return {
        error: 'organizer_owner', status: 409,
        message: 'Transfer or close your organizer account first.', messageSw: 'Hamisha au funga akaunti yako ya mwandaaji kwanza.',
      };
    }
    if (await hasOpenPaidOrder({ userId: user.id })) {
      return {
        error: 'open_paid_order', status: 409,
        message: 'You have a paid order that has not been delivered. You can delete your account once it is delivered or cancelled.',
        messageSw: 'Una oda iliyolipiwa ambayo bado haijafikishwa. Unaweza kufuta akaunti yako ikishafikishwa au kughairiwa.',
      };
    }
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

    // The Firebase login goes last, inside the transaction: if Firebase refuses, everything rolls back
    // and the person is still signed in and can try again. If the commit itself then failed the login
    // would be gone but the data not; a retry with the same session finishes it (user-not-found below).
    const deleteFirebaseLogin = async ({ firebaseUid, firebaseShared }) => {
      if (!firebaseUid || firebaseShared || !firebaseConfigured()) return;
      try {
        initFirebaseAdmin();
        await getAdminAuth().deleteUser(firebaseUid);
      } catch (fbErr) {
        if (fbErr?.code === 'auth/user-not-found') return;
        throw fbErr;
      }
    };

    let erased;
    try {
      erased = await eraseAccount(user.id, { beforeCommit: deleteFirebaseLogin });
    } catch (err) {
      console.error('[account-delete] failed, nothing was deleted:', err?.message);
      return {
        error: 'account_deletion_failed', status: 503,
        message: 'We could not delete your account just now. Nothing was removed. Please try again.',
        messageSw: 'Hatukuweza kufuta akaunti yako sasa hivi. Hakuna kilichoondolewa. Tafadhali jaribu tena.',
      };
    }
    if (erased.missing) return { error: 'user_not_found', status: 404 };

    // Only the in-memory copy is left of a trainer profile; the row went in the transaction.
    if (erased.trainerProfileId) {
      try { await trainers.removeAsync(t => t.id === erased.trainerProfileId); } catch (err) { console.warn('[account-delete] trainer cache:', err?.message); }
    }
    // Partner media can only be judged once the account is gone ("does this gym still have an owner?").
    // The account is deleted by now, so this cannot undo it; the nightly media sweep removes what it missed.
    try { await onAccountDeleted(user.id, user); } catch (err) { console.error('[account-delete] follow-up failed, the nightly sweep will retry:', err?.message); }
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
    // The photo is shown to other people (feeds, followers, trainers, gyms): data URI or our own
    // storage path only (media-src.mjs); the stored one (e.g. the sign-in provider's) is kept as is.
    const badMedia = await checkMediaFields({ photoUrl: body.photoUrl }, { kept: { photoUrl: storedMedia(current.photoUrl) }, actor: current.personId || current.id });
    if (badMedia) return badMedia;
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
      return { user: toSessionUser(updated) };
    }

    // Strict YYYY-MM-DD, a real date, 1901-01-01 to today; '' clears it; null / not sent keeps it.
    const dob = parseDateOfBirthInput(body.dateOfBirth);
    if (dob.error) return dob;
    if (!dob.skip && dob.value) {
      const refused = await memberDobGuard({ user: current, dateOfBirth: dob.value });
      if (refused) return refused;
    }
    const memberProfile = {
      ...(current.memberProfile || {}),
      fitnessGoal: body.fitnessGoal ?? current.memberProfile?.fitnessGoal ?? null,
      fitnessGoals: Array.isArray(body.fitnessGoals) ? body.fitnessGoals : (current.memberProfile?.fitnessGoals || []),
      fitnessLevel: body.fitnessLevel ?? current.memberProfile?.fitnessLevel ?? null,
      heightCm: body.heightCm ?? current.memberProfile?.heightCm ?? null,
      weightKg: body.weightKg ?? current.memberProfile?.weightKg ?? null,
      dateOfBirth: dob.skip ? current.memberProfile?.dateOfBirth ?? null : dob.value,
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
    return { user: toSessionUser(updated) };
  }

  return { deleteMyAccount, updateMemberProfile };
}
