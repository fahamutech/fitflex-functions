// Checks an email + password against Firebase, on the server.
//
// Used once per existing user (Identity V2 · I7a): their PIN has only ever
// lived in Firebase, as the password `fitflex-pin:<pin>`. Proving it here lets
// FitFlex adopt it without the person choosing a new one. It needs the
// project's web API key (FIREBASE_WEB_API_KEY), the same public key the apps
// ship with. Without it, adoption is simply unavailable.

export async function verifyFirebasePassword(email, password) {
  const key = process.env.FIREBASE_WEB_API_KEY;
  if (!key) return { configured: false, ok: false };
  try {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: false }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.localId) return { configured: true, ok: false };
    return { configured: true, ok: true, uid: body.localId };
  } catch (err) {
    console.warn('[pin] Firebase password check failed:', err?.message);
    return { configured: true, ok: false, unreachable: true };
  }
}
