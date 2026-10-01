// Identity V2 · I6a — a signed-in person proves an email or phone is theirs.
//
// The proof is always Firebase's (decision O4): the app verifies the phone
// with Firebase Phone Authentication (linking it to the Firebase account the
// person is already signed in with) or the email with Firebase's verification
// link, then sends a fresh ID token here. Nothing is verified by this backend
// itself and no code or SMS is sent from it.
//
// What the token proves is recorded on the caller's Person, exactly as a
// verified sign-in records it (I2), and invitations addressed to a newly
// verified identifier are claimed. A value already verified by another Person
// is never moved: it is refused and left as an IdentityConflict for review.
import { randomUUID } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';

export function createIdentifierService({ db, users, verifyFirebaseIdToken, identityLink, claimInvitations = null, linkingEnabled = () => false, auditLog = null }) {
  /** The Person's emails and phones, plus profile values that are not verified yet. */
  async function list({ user }) {
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    const rows = await db('LoginIdentifier')
      .where({ personId: user.personId, status: 'active' }).whereIn('type', ['email', 'phone'])
      .orderBy('createdAt').select('type', 'value', 'normalizedValue', 'verifiedAt');
    const identifiers = rows.map(r => ({
      type: r.type, value: r.normalizedValue, verified: Boolean(r.verifiedAt), verifiedAt: r.verifiedAt ?? null,
    }));
    // What the person typed into a profile but has not proved: offered for verification.
    const verified = new Set(identifiers.filter(i => i.verified).map(i => `${i.type}:${i.value}`));
    const personas = await db('User').where({ personId: user.personId }).whereNot({ accountStatus: 'closed' }).select('email', 'phone');
    const unverified = new Map();
    for (const p of personas) {
      for (const [type, value] of [['email', normalizeEmail(p.email)], ['phone', normalizePhone(p.phone)]]) {
        if (value && !verified.has(`${type}:${value}`)) unverified.set(`${type}:${value}`, { type, value });
      }
    }
    return { identifiers: identifiers.filter(i => i.verified), unverified: [...unverified.values()] };
  }

  /** Record what a fresh Firebase ID token proves about the caller. */
  async function verify({ user, idToken }) {
    if (!user?.personId) return { error: 'user_not_found', status: 404 };
    if (!idToken) return { error: 'idToken_required', status: 400 };
    const fb = await verifyFirebaseIdToken(idToken);
    if (!fb?.uid) return { error: 'invalid_token', status: 401 };

    // The token must be for the Firebase account this person signs in with.
    const mine = user.firebaseUid === fb.uid || Boolean(await db('LoginIdentifier')
      .where({ personId: user.personId, type: 'firebase_uid', normalizedValue: fb.uid, status: 'active' }).first('id'));
    if (!mine) return { error: 'token_not_yours', status: 403 };

    const email = fb.emailVerified ? normalizeEmail(fb.email) : null;
    const phone = normalizePhone(fb.phoneNumber);
    if (!email && !phone) return { error: 'nothing_verified', status: 409 };

    const result = await identityLink.linkOnVerifiedSignIn({
      anchorUserId: user.id, uid: fb.uid, email, phone,
      provider: fb.signInProvider || null, trigger: 'identifier_verify', attachOnly: !linkingEnabled(),
    });
    // The transaction may have moved the caller onto the Person that owns the uid.
    const fresh = (await users.findByIdAsync(user.id)) || user;
    const taken = result.conflicts
      .filter(c => c.kind === 'verified_identifier_collision' && ['email', 'phone'].includes(c.identifierType))
      .map(c => c.identifierType);
    if (auditLog) {
      await auditLog.insertAsync({
        id: randomUUID(), at: new Date().toISOString(),
        actor: user.id, action: 'identifier_verified', target: fresh.personId, before: null,
        after: { email: Boolean(email) && !taken.includes('email'), phone: Boolean(phone) && !taken.includes('phone'), refused: taken },
      });
    }
    if (claimInvitations) await claimInvitations(fresh.personId);
    const listed = await list({ user: fresh });
    // A value someone else has already proved is theirs is never taken over.
    if (taken.length) return { error: 'identifier_in_use', status: 409, identifierTypes: taken, ...listed };
    return listed;
  }

  return { list, verify };
}
