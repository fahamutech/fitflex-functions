// One Firebase account can back several FitFlex profiles (a member who is also
// gym staff, say). Removing one profile must not delete the login the others
// still use, so the Firebase user goes only when no other row references it.
import { existsSync } from 'node:fs';

/** True when another User row (not `exceptUserId`) still uses `firebaseUid`. */
export async function isFirebaseUidShared(users, firebaseUid, exceptUserId) {
  if (!firebaseUid) return false;
  const other = await users.findAsync(u => u.id !== exceptUserId && u.firebaseUid === firebaseUid);
  return Boolean(other);
}

/**
 * Deletes the Firebase user behind `row` unless another profile shares it.
 * Returns { deleted, shared }. Firebase failures are logged, not thrown, so
 * the caller's own cleanup still runs.
 */
export async function deleteFirebaseUserIfUnshared({ users, row, initFirebaseAdmin, getAdminAuth, logTag }) {
  if (!row?.firebaseUid) return { deleted: false, shared: false };
  if (await isFirebaseUidShared(users, row.firebaseUid, row.id)) return { deleted: false, shared: true };
  try {
    initFirebaseAdmin();
    await getAdminAuth().deleteUser(row.firebaseUid);
    return { deleted: true, shared: false };
  } catch (fbErr) {
    console.warn(`[${logTag}] Firebase user deletion failed:`, fbErr?.message);
    return { deleted: false, shared: false };
  }
}

/**
 * Should this server expect Firebase Admin to work? Local and CI runs have no credentials and account
 * deletion must still work there. In production the answer is always yes: missing credentials are a
 * fault, not a reason to skip. Same sources as initFirebaseAdmin (src/auth/firebase.mjs).
 */
export function firebaseAdminConfigured(env = process.env) {
  return Boolean(env.FIREBASE_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS)
    || existsSync(new URL('../../firebase-service-account.json', import.meta.url))
    || env.NODE_ENV === 'production';
}
