// Security fix (20 Oct 2026): a Firebase sign-in with a verified email must
// never land on, or link, a row that some other account only typed that email
// into. Such a row is ignored and, when it blocks the verified owner's new
// profile, the email is released from it (decision D-5) with an AuditLog entry
// and an IdentityConflict. Organisation-made rows nobody has claimed are still
// claimed by a verified email (decision O7). Every case runs with linking off,
// with Firebase evidence recording only, and with V2_LINKING on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { authFirebaseSession } from '../functions/auth.mjs';
import { users, identityLinkService } from '../src/bootstrap/services.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { isConfiguredAdminEmail } from '../src/services/auth-service.mjs';
import { isUnclaimed } from '../src/shared/unclaimed-row.mjs';

const uniq = p => `${p}_${randomUUID().slice(0, 8)}`;
const devToken = payload => `dev:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
const FLAG_NAMES = ['IDENTITY_V2', 'V2_LINKING', 'V2_PERSONAS', 'IDENTITY_RECORD_FIREBASE_EVIDENCE'];
const MODES = {
  'linking off': [],
  'evidence recording': ['IDENTITY_RECORD_FIREBASE_EVIDENCE'],
  'V2_LINKING on': ['IDENTITY_V2', 'V2_LINKING'],
};

async function withFlags(flags, fn) {
  const saved = Object.fromEntries(FLAG_NAMES.map(n => [n, process.env[n]]));
  for (const n of FLAG_NAMES) delete process.env[n];
  for (const f of flags) process.env[f] = 'true';
  try { return await fn(); } finally {
    for (const n of FLAG_NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}

function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function signIn(fbPayload, role) {
  const out = res();
  await authFirebaseSession.onRequest({ body: { idToken: devToken(fbPayload), ...(role ? { requestedRole: role } : {}) }, headers: {} }, out);
  return out;
}

async function makeUser(overrides = {}) {
  const row = {
    id: uniq('usr_s2'), userType: 'member', accountStatus: 'active', approvalStatus: 'approved',
    createdAt: new Date().toISOString(), ...overrides,
  };
  await users.upsertAsync(u => u.id === row.id, row);
  return db('User').where({ id: row.id }).first();
}
const fresh = id => db('User').where({ id }).first();
const victimEmail = () => `${uniq('victim')}@example.com`;
const verifiedOn = (personId, normalizedValue) => db('LoginIdentifier')
  .where({ personId, normalizedValue, status: 'active' }).whereNotNull('verifiedAt').first('id');

/** The attacker's Person picked up nothing this sign-in proved. */
async function assertNoEvidenceOn(personId, { email, uid }) {
  assert.equal(await verifiedOn(personId, email), undefined, 'victim email must not be verified on the attacker Person');
  assert.equal(await verifiedOn(personId, uid), undefined, 'victim uid must not land on the attacker Person');
}

for (const [mode, flags] of Object.entries(MODES)) {
  test(`[${mode}] a row another Firebase account typed the email into is not chosen; the email is released`, async () => {
    await withFlags(flags, async () => {
      const email = victimEmail();
      const attacker = await makeUser({ firebaseUid: uniq('fb_att'), email });
      const uid = uniq('fb_vic');

      const out = await signIn({ uid, email, email_verified: true });
      assert.equal(out.statusCode, 200);
      assert.notEqual(out.body.user.id, attacker.id);
      assert.equal(out.body.user.email, email);
      assert.ok(out.body.token);

      const mine = await fresh(out.body.user.id);
      assert.equal(mine.firebaseUid, uid);
      assert.notEqual(mine.personId, attacker.personId);
      const planted = await fresh(attacker.id);
      assert.equal(planted.email, null, 'email released from the planted row');
      assert.equal(planted.firebaseUid, attacker.firebaseUid);
      assert.equal(planted.personId, attacker.personId);
      await assertNoEvidenceOn(attacker.personId, { email, uid });

      const audit = await db('AuditLog').where({ action: 'contact_released_to_verified_owner', target: attacker.id }).first();
      assert.ok(audit, 'audit entry written');
      assert.equal(audit.actor, mine.id);
      const conflict = await db('IdentityConflict')
        .where({ kind: 'unverified_contact_released', normalizedValue: email, status: 'open' }).first();
      assert.ok(conflict, 'IdentityConflict opened');
      assert.ok(conflict.userIds.includes(attacker.id) && conflict.userIds.includes(mine.id));

      // Next time the victim lands on their own row again, by uid.
      const again = await signIn({ uid, email, email_verified: true });
      assert.equal(again.statusCode, 200);
      assert.equal(again.body.user.id, mine.id);
    });
  });

  test(`[${mode}] a case variant of the email does not get round it`, async () => {
    await withFlags(flags, async () => {
      const email = victimEmail();
      const attacker = await makeUser({ firebaseUid: uniq('fb_att'), email: email.toUpperCase() });
      const uid = uniq('fb_vic');

      const out = await signIn({ uid, email, email_verified: true });
      assert.equal(out.statusCode, 200);
      assert.notEqual(out.body.user.id, attacker.id);
      assert.equal((await fresh(attacker.id)).email, null);
      assert.equal((await fresh(out.body.user.id)).email, email);
      await assertNoEvidenceOn(attacker.personId, { email, uid });
    });
  });

  test(`[${mode}] a planted row of another role is ignored and left alone`, async () => {
    await withFlags(flags, async () => {
      const email = victimEmail();
      const attacker = await makeUser({ firebaseUid: uniq('fb_att'), email, userType: 'trainer' });
      const uid = uniq('fb_vic');

      const out = await signIn({ uid, email, email_verified: true });
      assert.equal(out.statusCode, 200);
      assert.equal(out.body.user.userType, 'member');
      assert.notEqual(out.body.user.id, attacker.id);
      const after = await fresh(attacker.id);
      assert.equal(after.email, email, 'no collision, so nothing is released');
      assert.equal(after.personId, attacker.personId);
      await assertNoEvidenceOn(attacker.personId, { email, uid });
    });
  });

  test(`[${mode}] a PIN-registered row with a planted email is neither claimed nor linked`, async () => {
    await withFlags(flags, async () => {
      const email = victimEmail();
      const sameRole = await makeUser({ email });
      const otherRole = await makeUser({ email, userType: 'trainer' });
      for (const row of [sameRole, otherRole]) {
        await db('Person').where({ id: row.personId }).update({ pinHash: 'scrypt:test:pin', pinSetAt: db.fn.now() });
        assert.equal(await isUnclaimed(db, row), false);
      }
      const uid = uniq('fb_vic');

      const out = await signIn({ uid, email, email_verified: true });
      assert.equal(out.statusCode, 200);
      assert.notEqual(out.body.user.id, sameRole.id);
      for (const row of [sameRole, otherRole]) {
        const after = await fresh(row.id);
        assert.equal(after.firebaseUid ?? null, null, 'never given the Firebase uid');
        assert.equal(after.personId, row.personId, 'never moved onto the signer');
        await assertNoEvidenceOn(row.personId, { email, uid });
      }
      assert.equal((await fresh(sameRole.id)).email, null, 'the blocking row releases the email');
    });
  });

  test(`[${mode}] an organisation-made row nobody has claimed is still claimed (O7)`, async () => {
    await withFlags(flags, async () => {
      const email = victimEmail();
      const orgMade = await makeUser({ email, userType: 'gym_operator' });
      assert.equal(await isUnclaimed(db, orgMade), true);
      const uid = uniq('fb_owner');

      const out = await signIn({ uid, email: email.toUpperCase(), email_verified: true });
      assert.equal(out.statusCode, 200);
      assert.equal(out.body.user.id, orgMade.id);
      const after = await fresh(orgMade.id);
      assert.equal(after.firebaseUid, uid);
      assert.equal(after.email, email);
    });
  });

  test(`[${mode}] the same person on a second Firebase account still reaches their row`, async () => {
    await withFlags(flags, async () => {
      const email = victimEmail();
      const own = await makeUser({ firebaseUid: uniq('fb_first'), email, userType: 'trainer' });
      await db('LoginIdentifier').insert({
        id: uniq('lid'), personId: own.personId, type: 'email', value: email, normalizedValue: email,
        verifiedAt: db.fn.now(), provider: 'firebase', status: 'active',
      });

      const out = await signIn({ uid: uniq('fb_second'), email, email_verified: true });
      assert.equal(out.statusCode, 200);
      assert.equal(out.body.user.id, own.id);
      assert.equal((await fresh(own.id)).email, email);
      assert.equal(await db('AuditLog').where({ action: 'contact_released_to_verified_owner', target: own.id }).first(), undefined);
    });
  });

  test(`[${mode}] an unverified email never releases anyone's email and still signs in`, async () => {
    await withFlags(flags, async () => {
      const email = victimEmail();
      const real = await makeUser({ firebaseUid: uniq('fb_real'), email });
      const out = await signIn({ uid: uniq('fb_new'), email, email_verified: false });
      assert.equal(out.statusCode, 200);
      assert.notEqual(out.body.user.id, real.id);
      assert.equal((await fresh(real.id)).email, email, 'untouched');
      assert.equal((await fresh(out.body.user.id)).email ?? null, null, 'the new row goes in without the email');
    });
  });

  test(`[${mode}] an unverified email naming an unclaimed row still asks for verification`, async () => {
    await withFlags(flags, async () => {
      const email = victimEmail();
      const orgMade = await makeUser({ email, userType: 'trainer' });
      const out = await signIn({ uid: uniq('fb_x'), email, email_verified: false });
      assert.equal(out.statusCode, 409);
      assert.equal(out.body.error, 'email_verification_required');
      assert.equal((await fresh(orgMade.id)).firebaseUid ?? null, null);
    });
  });
}

test('the configured admin email still reaches the admin row from another Firebase account', async () => {
  const adminEmail = (process.env.FITFLEX_ADMIN_EMAILS || 'mama27j@gmail.com').split(',')[0].trim().toLowerCase();
  assert.equal(isConfiguredAdminEmail(adminEmail), true);
  await withFlags([], async () => {
    let admins = await db('User').whereRaw('lower(btrim(email)) = ?', [adminEmail]).where({ userType: 'admin' });
    if (!admins.length) {
      await makeUser({ firebaseUid: uniq('fb_admin'), email: adminEmail, userType: 'admin' });
      admins = await db('User').whereRaw('lower(btrim(email)) = ?', [adminEmail]).where({ userType: 'admin' });
    }
    const out = await signIn({ uid: uniq('fb_admin2'), email: adminEmail, email_verified: true });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.user.userType, 'admin');
    assert.ok(admins.some(a => a.id === out.body.user.id), 'an existing admin row, not a new one');
    const after = await db('User').whereRaw('lower(btrim(email)) = ?', [adminEmail]).where({ userType: 'admin' });
    assert.equal(after.length, admins.length);
  });
});

test('registration linking (FitFlex code, no uid) moves only unclaimed rows found by the email', async () => {
  const email = victimEmail();
  const anchor = await makeUser({ email: null });
  const pinRow = await makeUser({ email, userType: 'trainer' });
  await db('Person').where({ id: pinRow.personId }).update({ pinHash: 'scrypt:test:pin', pinSetAt: db.fn.now() });
  const provedPhone = await makeUser({ email, userType: 'vendor' });
  const phone = `+2557${String(Date.now()).slice(-8)}`;
  await db('LoginIdentifier').insert({
    id: uniq('lid'), personId: provedPhone.personId, type: 'phone', value: phone, normalizedValue: phone,
    verifiedAt: db.fn.now(), provider: 'phone', status: 'active',
  });
  const orgMade = await makeUser({ email, userType: 'gym_operator' });

  const out = await identityLinkService.linkOnVerifiedSignIn({
    anchorUserId: anchor.id, uid: null, email, provider: 'fitflex_sms', trigger: 'registration',
  });
  assert.deepEqual(out.linkedUserIds, [orgMade.id]);
  assert.equal((await fresh(orgMade.id)).personId, anchor.personId);
  assert.equal((await fresh(pinRow.id)).personId, pinRow.personId);
  assert.equal((await fresh(provedPhone.id)).personId, provedPhone.personId);
});
