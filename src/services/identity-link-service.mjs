// Identity V2 · I2 — link a person's persona rows on a verified sign-in.
//
// Called after /auth/firebase/session has resolved the signing-in User row.
// Only evidence Firebase has verified is used:
//   - the Firebase uid (always verified),
//   - the email, when the ID token says email_verified,
//   - the phone, when the ID token carries phone_number.
//
// Rows found through that evidence move onto the signer's Person (decision
// D1: automatic, no prompt) — but only rows with no Firebase account of their
// own, or this same one. Everything ambiguous becomes an IdentityConflict for
// review, never a merge:
//   - a row on a different Firebase account with the same email/phone (Case D/E)
//   - an email/phone already verified on another Person (Case G)
//   - a move that would give the Person two live personas of one type (Case F)
// Each move is written to the append-only IdentityEvent log with the row's
// previous personId, so a link can be reversed. No User id or history row
// changes: only User.personId and identity-table rows.
import { randomUUID } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';

const shortId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const LIVE = u => u.accountStatus !== 'closed';

export function createIdentityLinkService({ db }) {
  async function recordConflict(trx, conflict) {
    const open = await trx('IdentityConflict').where({
      kind: conflict.kind, identifierType: conflict.identifierType,
      normalizedValue: conflict.normalizedValue, status: 'open',
    }).first('id');
    if (open) {
      await trx('IdentityConflict').where({ id: open.id })
        .update({ personIds: conflict.personIds, userIds: conflict.userIds, details: conflict.details ?? null, updatedAt: trx.fn.now() });
    } else {
      await trx('IdentityConflict').insert({ id: shortId('idc'), status: 'open', ...conflict });
    }
  }

  /** Give `personId` a verified identifier, unless another live Person already holds it verified. */
  async function attachVerified(trx, { personId, type, value, normalizedValue, provider, firebaseUid }, conflicts) {
    const owner = await trx('LoginIdentifier')
      .where({ type, normalizedValue, status: 'active' }).whereNotNull('verifiedAt').first('personId');
    if (owner && owner.personId !== personId) {
      conflicts.push({
        kind: 'verified_identifier_collision', identifierType: type, normalizedValue,
        personIds: [owner.personId, personId].sort(), userIds: [],
      });
      return false;
    }
    if (owner) return true;
    const mine = await trx('LoginIdentifier').where({ personId, type, normalizedValue, status: 'active' }).first('id');
    if (mine) {
      await trx('LoginIdentifier').where({ id: mine.id })
        .update({ verifiedAt: trx.fn.now(), provider, firebaseUid, updatedAt: trx.fn.now() });
    } else {
      await trx('LoginIdentifier').insert({
        id: shortId('lid'), personId, type, value, normalizedValue,
        verifiedAt: trx.fn.now(), provider, firebaseUid, status: 'active',
      });
    }
    return true;
  }

  /**
   * @param {object} p
   * @param {string} p.anchorUserId  the User row this sign-in resolved to
   * @param {string|null} p.uid      Firebase uid (verified by definition); null when the
   *   evidence is a code FitFlex sent itself (I6a), which proves only the email or phone
   * @param {string|null} [p.email]  only when Firebase verified it
   * @param {string|null} [p.phone]  only when Firebase verified it
   * @param {string|null} [p.provider] Firebase sign-in provider
   * @param {boolean} [p.attachOnly]  record the verified identifiers on the
   *   anchor's Person without looking for other rows to link (V2_LINKING off)
   * @returns {Promise<{personId: string|null, linkedUserIds: string[], mergedPersonIds: string[], conflicts: object[]}>}
   */
  async function linkOnVerifiedSignIn({ anchorUserId, uid, email = null, phone = null, provider = null, trigger = 'firebase_session', attachOnly = false }) {
    const verifiedEmail = normalizeEmail(email);
    const verifiedPhone = normalizePhone(phone);
    return db.transaction(async trx => {
      // Only this transaction may move User.personId (see user_person_guard).
      await trx.raw("SET LOCAL fitflex.identity_relink = 'on'");
      const conflicts = [];

      const anchor = await trx('User').where({ id: anchorUserId }).first();
      if (!anchor?.personId) return { personId: null, linkedUserIds: [], mergedPersonIds: [], conflicts };
      const uidOwner = uid ? await trx('LoginIdentifier')
        .where({ type: 'firebase_uid', normalizedValue: uid, status: 'active' }).first('personId') : null;
      const personId = uidOwner?.personId ?? anchor.personId;

      // Rows the verified evidence points at.
      const byUid = attachOnly || !uid ? [] : await trx('User').where({ firebaseUid: uid });
      const byEmail = verifiedEmail && !attachOnly
        ? await trx('User').whereRaw('lower(btrim(email)) = ?', [verifiedEmail]) : [];
      const byPhone = verifiedPhone && !attachOnly
        // Stored phones are free text ("0712 345 678"); narrow on digits, then normalise.
        ? (await trx('User').whereNotNull('phone')
          .whereRaw("regexp_replace(phone, '\\D', '', 'g') LIKE ?", [`%${verifiedPhone.slice(-9)}`]))
          .filter(u => normalizePhone(u.phone) === verifiedPhone)
        : [];

      const candidates = new Map([[anchor.id, anchor]]);
      for (const u of byUid) candidates.set(u.id, u);
      for (const [type, value, rows] of [['email', verifiedEmail, byEmail], ['phone', verifiedPhone, byPhone]]) {
        // Without a uid (a FitFlex code), the person's own rows are not "another account".
        const otherAccounts = rows.filter(u => u.firebaseUid && u.firebaseUid !== uid && (uid || u.personId !== personId));
        if (otherAccounts.length) {
          // Case D/E: same value, a different Firebase account. Never merged silently.
          conflicts.push({
            kind: `${type}_other_firebase_account`, identifierType: type, normalizedValue: value,
            personIds: [...new Set([personId, ...otherAccounts.map(u => u.personId)])].sort(),
            userIds: otherAccounts.map(u => u.id).sort(),
          });
        }
        for (const u of rows) if (!u.firebaseUid || u.firebaseUid === uid) candidates.set(u.id, u);
      }

      // Rows already on another Person that holds this email/phone verified are
      // someone else's proof (Case G): leave them where they are.
      const protectedPersons = new Set();
      for (const [type, value] of [['email', verifiedEmail], ['phone', verifiedPhone]]) {
        if (!value) continue;
        const holders = await trx('LoginIdentifier').where({ type, normalizedValue: value, status: 'active' })
          .whereNotNull('verifiedAt').whereNot({ personId }).select('personId');
        for (const h of holders) protectedPersons.add(h.personId);
      }

      // Personas the target already has, by type (one live persona per type).
      const personas = await trx('User').where({ personId });
      const liveTypes = new Map(personas.filter(LIVE).map(u => [u.userType, u.id]));

      const linkedUserIds = [];
      const fromPersons = new Map();
      for (const u of candidates.values()) {
        if (u.personId === personId) continue;
        if (protectedPersons.has(u.personId) && (!uid || u.firebaseUid !== uid)) continue;
        const existing = liveTypes.get(u.userType);
        if (existing && existing !== u.id && LIVE(u)) {
          // Case F: the Person would hold two live personas of one type.
          conflicts.push({
            kind: 'duplicate_persona', identifierType: 'user_type', normalizedValue: `${personId}:${u.userType}`,
            personIds: [personId, u.personId].sort(), userIds: [existing, u.id].sort(),
          });
          continue;
        }
        await trx('User').where({ id: u.id, personId: u.personId }).update({ personId });
        if (LIVE(u)) liveTypes.set(u.userType, u.id);
        linkedUserIds.push(u.id);
        if (!fromPersons.has(u.personId)) fromPersons.set(u.personId, []);
        fromPersons.get(u.personId).push(u.id);
      }

      const evidence = byUid.some(u => u.id !== anchor.id) || uidOwner
        ? ['firebase_uid', uid]
        : verifiedEmail ? ['email', verifiedEmail] : verifiedPhone ? ['phone', verifiedPhone] : ['firebase_uid', uid];
      const mergedPersonIds = [];
      for (const [fromPersonId, userIds] of fromPersons) {
        await trx('IdentityEvent').insert({
          id: shortId('ide'), kind: 'link', personId, fromPersonId, userIds,
          identifierType: evidence[0], normalizedValue: evidence[1], trigger, actorUserId: anchor.id,
        });
        const left = await trx('User').where({ personId: fromPersonId }).first('id');
        if (left) continue;
        // The old Person is now empty: its identifiers follow, and it becomes a tombstone.
        const ids = await trx('LoginIdentifier').where({ personId: fromPersonId, status: 'active' });
        for (const identifier of ids) {
          const clash = await trx('LoginIdentifier').where({
            personId, type: identifier.type, normalizedValue: identifier.normalizedValue, status: 'active',
          }).first('id', 'verifiedAt');
          if (clash) {
            await trx('LoginIdentifier').where({ id: identifier.id }).update({ status: 'revoked', updatedAt: trx.fn.now() });
            if (identifier.verifiedAt && !clash.verifiedAt) {
              await trx('LoginIdentifier').where({ id: clash.id })
                .update({ verifiedAt: identifier.verifiedAt, provider: identifier.provider, updatedAt: trx.fn.now() });
            }
          } else {
            await trx('LoginIdentifier').where({ id: identifier.id }).update({ personId, updatedAt: trx.fn.now() });
          }
        }
        await trx('Person').where({ id: fromPersonId }).update({ status: 'merged', mergedIntoId: personId, updatedAt: trx.fn.now() });
        await trx('IdentityEvent').insert({
          id: shortId('ide'), kind: 'merge', personId, fromPersonId, userIds,
          identifierType: evidence[0], normalizedValue: evidence[1], trigger, actorUserId: anchor.id,
        });
        mergedPersonIds.push(fromPersonId);
      }

      // Record what this sign-in proved on the Person.
      if (uid) await attachVerified(trx, { personId, type: 'firebase_uid', value: uid, normalizedValue: uid, provider: provider || 'firebase', firebaseUid: uid }, conflicts);
      if (verifiedEmail) {
        await attachVerified(trx, { personId, type: 'email', value: email, normalizedValue: verifiedEmail, provider: provider || 'firebase', firebaseUid: uid }, conflicts);
      }
      if (verifiedPhone) {
        await attachVerified(trx, { personId, type: 'phone', value: phone, normalizedValue: verifiedPhone, provider: uid ? 'phone' : provider || 'phone', firebaseUid: uid }, conflicts);
      }

      for (const conflict of conflicts) await recordConflict(trx, conflict);
      return { personId, linkedUserIds, mergedPersonIds, conflicts };
    });
  }

  /** Live personas of a Person, oldest first, in the shape sessions return. */
  async function personasOf(personId) {
    if (!personId) return [];
    const rows = await db('User').where({ personId }).orderBy([{ column: 'createdAt' }, { column: 'id' }]);
    return rows.filter(LIVE).map(u => ({
      id: u.id,
      userType: u.userType,
      displayName: u.displayName ?? null,
      approvalStatus: u.approvalStatus ?? 'approved',
      accountStatus: u.accountStatus ?? 'active',
      onboardingCompleted: Boolean(u.onboardingCompleted),
      portalOnly: u.portalUser === true,
    }));
  }

  async function personOf(personId) {
    if (!personId) return null;
    const p = await db('Person').where({ id: personId }).first('id', 'status', 'lastPersonaId');
    return p ?? null;
  }

  async function rememberPersona(personId, userId) {
    if (!personId || !userId) return;
    await db('Person').where({ id: personId }).update({ lastPersonaId: userId, updatedAt: db.fn.now() });
  }

  /**
   * Identity V2 · I3: a new persona (User row) for an existing Person. The
   * row is inserted with personId set explicitly, so it can never land on a
   * new Person. Returns { row } or { error } when another profile already
   * holds the email for that role (the per-role unique indexes).
   */
  async function createPersona({ person, source, userType, approvalStatus }) {
    const id = `usr_${randomUUID().slice(0, 8)}`;
    const now = new Date();
    // A phone already used by another profile of this role is left off rather
    // than blocking the persona; it is only a display copy here.
    const phoneTaken = source.phone
      ? await db('User').where({ phone: source.phone, userType }).first('id') : null;
    try {
      await db('User').insert({
        id, personId: person.id, userType,
        firebaseUid: source.firebaseUid ?? null,
        email: source.email ?? null,
        phone: phoneTaken ? null : source.phone ?? null,
        displayName: source.displayName ?? null,
        photoUrl: source.photoUrl ?? null,
        accountStatus: 'active', approvalStatus, onboardingCompleted: false,
        createdAt: now, updatedAt: now,
      });
    } catch (err) {
      if (err?.code === '23505') return { error: 'unique_violation', constraint: err.constraint ?? null };
      throw err;
    }
    return { row: await db('User').where({ id }).first() };
  }

  return { linkOnVerifiedSignIn, personasOf, personOf, rememberPersona, createPersona };
}
