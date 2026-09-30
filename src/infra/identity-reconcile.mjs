// Identity V2 · I1 — reconcile email/phone LoginIdentifiers with User rows.
//
// The foundation migration gives every User a Person and records Firebase
// uids. It can't tell whether an email or phone is verified — only Firebase
// knows. This fills that in:
//
//   - every User email / phone becomes a LoginIdentifier on the row's Person,
//     UNVERIFIED unless Firebase confirms it for that row's Firebase account;
//   - a verified value claimed by more than one Person is not given to anyone:
//     it becomes an IdentityConflict for review (never an automatic merge);
//   - rows sharing a Firebase uid but holding different Persons are reported
//     as a firebase_uid_split conflict;
//   - unverified overlaps between Persons are only counted as possible
//     duplicates — I2 links them on a verified sign-in, not here.
//
// Dry run by default. Idempotent: safe to re-run at any time.
import { randomUUID } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';

const lid = () => `lid_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const idc = () => `idc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const key = (type, value) => `${type}\u0000${value}`;

/**
 * @param {object} opts
 * @param {import('knex').Knex} opts.db
 * @param {(uids: string[]) => Promise<Map<string, {email?: string|null, emailVerified?: boolean, phoneNumber?: string|null}>>} [opts.lookupFirebaseUsers]
 *   Firebase evidence per uid. Omit it and nothing is marked verified.
 * @param {boolean} [opts.apply] write changes; otherwise only report.
 */
export async function reconcileIdentities({ db, lookupFirebaseUsers = null, apply = false }) {
  const users = await db('User').select('id', 'personId', 'firebaseUid', 'email', 'phone', 'userType');
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    firebaseChecked: Boolean(lookupFirebaseUsers),
    users: users.length,
    usersWithoutPerson: users.filter(u => !u.personId).length,
    identifiersAdded: { email: 0, phone: 0 },
    identifiersVerified: { email: 0, phone: 0 },
    unparseablePhones: 0,
    possibleDuplicates: { email: 0, phone: 0 },
    conflicts: [],
  };

  const firebase = lookupFirebaseUsers
    ? await lookupFirebaseUsers([...new Set(users.map(u => u.firebaseUid).filter(Boolean))])
    : new Map();

  // What each row can contribute, and whether Firebase proves it.
  const candidates = [];
  for (const u of users) {
    if (!u.personId) continue;
    const fb = u.firebaseUid ? firebase.get(u.firebaseUid) : null;
    const email = normalizeEmail(u.email);
    if (email) {
      const verified = Boolean(fb?.emailVerified && normalizeEmail(fb.email) === email);
      candidates.push({ user: u, type: 'email', value: u.email, normalized: email, verified });
    }
    if (u.phone) {
      const phone = normalizePhone(u.phone);
      if (!phone) report.unparseablePhones += 1;
      else {
        const verified = Boolean(fb?.phoneNumber && normalizePhone(fb.phoneNumber) === phone);
        candidates.push({ user: u, type: 'phone', value: u.phone, normalized: phone, verified });
      }
    }
  }

  const existing = await db('LoginIdentifier')
    .select('id', 'personId', 'type', 'normalizedValue', 'verifiedAt')
    .where({ status: 'active' }).whereIn('type', ['email', 'phone']);
  const existingByPersonValue = new Map(existing.map(r => [`${r.personId}\u0000${key(r.type, r.normalizedValue)}`, r]));

  // Which Persons claim each verified value (already stored or newly proven).
  const verifiedOwners = new Map();
  const claim = (type, value, personId, userId) => {
    const k = key(type, value);
    if (!verifiedOwners.has(k)) verifiedOwners.set(k, { type, value, persons: new Set(), users: new Set() });
    verifiedOwners.get(k).persons.add(personId);
    if (userId) verifiedOwners.get(k).users.add(userId);
  };
  for (const r of existing) if (r.verifiedAt) claim(r.type, r.normalizedValue, r.personId, null);
  for (const c of candidates) if (c.verified) claim(c.type, c.normalized, c.user.personId, c.user.id);

  const collided = new Set();
  for (const [k, owner] of verifiedOwners) {
    if (owner.persons.size < 2) continue;
    collided.add(k);
    report.conflicts.push({
      kind: 'verified_identifier_collision', identifierType: owner.type, normalizedValue: owner.value,
      personIds: [...owner.persons].sort(), userIds: [...owner.users].sort(),
    });
  }

  // Unverified overlaps are evidence only; count them, don't act on them.
  const unverifiedPersons = new Map();
  for (const c of candidates) {
    const k = key(c.type, c.normalized);
    if (!unverifiedPersons.has(k)) unverifiedPersons.set(k, new Set());
    unverifiedPersons.get(k).add(c.user.personId);
  }
  for (const [k, persons] of unverifiedPersons) {
    if (persons.size > 1 && !collided.has(k)) report.possibleDuplicates[k.split('\u0000')[0]] += 1;
  }

  // Same Firebase account, different Persons: must be reviewed, not merged here.
  const uidPersons = new Map();
  for (const u of users) {
    if (!u.firebaseUid || !u.personId) continue;
    if (!uidPersons.has(u.firebaseUid)) uidPersons.set(u.firebaseUid, { persons: new Set(), users: new Set() });
    uidPersons.get(u.firebaseUid).persons.add(u.personId);
    uidPersons.get(u.firebaseUid).users.add(u.id);
  }
  for (const [uid, g] of uidPersons) {
    if (g.persons.size < 2) continue;
    report.conflicts.push({
      kind: 'firebase_uid_split', identifierType: 'firebase_uid', normalizedValue: uid,
      personIds: [...g.persons].sort(), userIds: [...g.users].sort(),
    });
  }

  // Planned writes.
  const inserts = [];
  const verifications = [];
  const seen = new Set();
  for (const c of candidates) {
    const k = key(c.type, c.normalized);
    const verified = c.verified && !collided.has(k);
    const pk = `${c.user.personId}\u0000${k}`;
    const current = existingByPersonValue.get(pk);
    if (current) {
      if (verified && !current.verifiedAt && !seen.has(pk)) {
        verifications.push({ id: current.id, c });
        report.identifiersVerified[c.type] += 1;
      }
      seen.add(pk);
      continue;
    }
    if (seen.has(pk)) continue;
    seen.add(pk);
    inserts.push({ c, verified });
    report.identifiersAdded[c.type] += 1;
    if (verified) report.identifiersVerified[c.type] += 1;
  }

  if (apply) {
    await db.transaction(async trx => {
      for (const { c, verified } of inserts) {
        await trx('LoginIdentifier').insert({
          id: lid(), personId: c.user.personId, type: c.type, value: c.value,
          normalizedValue: c.normalized, verifiedAt: verified ? trx.fn.now() : null,
          provider: verified ? 'firebase' : null, firebaseUid: c.user.firebaseUid ?? null, status: 'active',
        });
      }
      for (const { id, c } of verifications) {
        await trx('LoginIdentifier').where({ id }).whereNull('verifiedAt').update({
          verifiedAt: trx.fn.now(), provider: 'firebase', firebaseUid: c.user.firebaseUid ?? null,
          updatedAt: trx.fn.now(),
        });
      }
      for (const conflict of report.conflicts) {
        const open = await trx('IdentityConflict').where({
          kind: conflict.kind, identifierType: conflict.identifierType,
          normalizedValue: conflict.normalizedValue, status: 'open',
        }).first('id');
        if (open) {
          await trx('IdentityConflict').where({ id: open.id }).update({
            personIds: conflict.personIds, userIds: conflict.userIds, updatedAt: trx.fn.now(),
          });
        } else {
          await trx('IdentityConflict').insert({ id: idc(), ...conflict, status: 'open' });
        }
      }
    });
  }
  return report;
}

/** Firebase Admin evidence for a set of uids (batched at the API's 100 limit). */
export async function firebaseUsersLookup(getAdminAuth, uids) {
  const out = new Map();
  for (let i = 0; i < uids.length; i += 100) {
    const { users } = await getAdminAuth().getUsers(uids.slice(i, i + 100).map(uid => ({ uid })));
    for (const u of users) {
      out.set(u.uid, { email: u.email ?? null, emailVerified: u.emailVerified === true, phoneNumber: u.phoneNumber ?? null });
    }
  }
  return out;
}
