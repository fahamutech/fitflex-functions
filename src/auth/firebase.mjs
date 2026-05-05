import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_SERVICE_ACCOUNT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'firebase-service-account.json'
);

function initFirebaseAdmin() {
  if (getApps().length) return;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) {
    initializeApp({ credential: cert(JSON.parse(json)) });
    return;
  }
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || LOCAL_SERVICE_ACCOUNT;
  if (credentialsPath && existsSync(credentialsPath)) {
    initializeApp({ credential: cert(JSON.parse(readFileSync(credentialsPath, 'utf8'))) });
    return;
  }
  initializeApp();
}

export async function verifyFirebaseIdToken(idToken) {
  if (!idToken) return null;

  // Dev-only bypass — disabled in production
  if (idToken.startsWith('dev:') && process.env.NODE_ENV !== 'production') {
    try {
      const payload = JSON.parse(Buffer.from(idToken.slice(4), 'base64url').toString('utf8'));
      if (!payload.uid) return null;
      return {
        uid: payload.uid,
        email: payload.email ?? null,
        name: payload.name ?? null,
        picture: payload.picture ?? null
      };
    } catch {
      return null;
    }
  }

  try {
    initFirebaseAdmin();
    const decoded = await getAuth().verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      name: decoded.name ?? null,
      picture: decoded.picture ?? null
    };
  } catch (err) {
    console.warn('[firebase-auth] ID token verification failed:', err?.code || err?.message || err);
    return null;
  }
}
