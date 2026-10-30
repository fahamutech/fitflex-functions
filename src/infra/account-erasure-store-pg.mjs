// Account deletion: what happens to each table (owner decision 2026-10-30).
//
//   KEPT, ANONYMISED  financial and access records. Amounts, dates, statuses and ids never change, so no
//                     statement, payout, invoice total or check-in count moves. Direct identifiers and
//                     free text go. `memberId` / `buyerId` stay as a reference to an account that no
//                     longer exists: an opaque id with nothing left to resolve it to.
//   REMOVED           sign-in material, contacts, messages, personal activity. Many of these go through
//                     ON DELETE CASCADE when the User row is removed; those are marked below.
//   LEFT ALONE        issued invoices, partner KYC files and other rows waiting for counsel: see the
//                     table in the pull request for this change.
//
// Everything here runs in one transaction with the removal of the User row, and `beforeCommit` runs
// last, inside it. Any failure rolls everything back, so the account is untouched and the person can
// simply try again.
//
// Two kinds of step:
//  - persona steps always run; each User row is one role of a person, and only this one is deleted.
//  - person steps run only for the last persona (the sign-in, PIN and contact details are shared).
import { randomUUID } from 'node:crypto';
import { UPGRADE_NOTE_PREFIX } from '../shared/pass-upgrade.mjs';
import { DELETED_PERSON_FIRST_NAME, DELETED_PERSON_LABEL, DELETED_PERSON_LAST_NAME } from '../shared/deleted-person.mjs';

// Older audit rows copied these out of the account; the deleted person's rows lose them.
const AUDIT_PERSONAL_KEYS = ['email', 'phone', 'displayName', 'photoUrl', 'firebaseUid', 'name', 'fullName',
  'payerPhone', 'identifierValue', 'contactValue', 'memberProfileFields', 'vendorProfileFields'];
const ERASED = 'erased';

const SMS_PHONE_FORMS = phone => [phone, phone.replace(/^\+/, '')];

/** Contact details this person alone used: rows keyed by them (not by account) can then go. */
async function ownContacts(trx, user) {
  const known = new Set([user.phone, user.email, user.email?.toLowerCase()].filter(Boolean));
  if (user.personId) {
    const rows = await trx('LoginIdentifier').where({ personId: user.personId }).whereIn('type', ['phone', 'email']).select('value', 'normalizedValue');
    for (const r of rows) { known.add(r.value); known.add(r.normalizedValue); }
  }
  const all = [...known].filter(Boolean);
  if (!all.length) return { contacts: [], phones: [] };
  const others = await trx('User').whereNot({ id: user.id })
    .where(q => q.whereIn('phone', all).orWhereIn('email', all)).select('phone', 'email');
  const shared = new Set(others.flatMap(o => [o.phone, o.email]));
  const contacts = all.filter(v => !shared.has(v));
  return { contacts, phones: contacts.filter(v => !v.includes('@')).flatMap(SMS_PHONE_FORMS) };
}

async function anonymisePayments(trx, id) {
  await trx('PaymentRequest').where({ memberId: id }).update({
    payerPhone: null,
    changeRequestReason: null,
    // Two notes are data, not free text: settlement reads what a payment was for from them.
    note: trx.raw(`CASE WHEN note = 'trainer_pass' OR note LIKE ? THEN note END`, [`${UPGRADE_NOTE_PREFIX}%`]),
  });
  // A rejected refund must have a decision note (refund_ck).
  await trx('Refund').where({ memberId: id }).update({
    note: null, decisionNoteSw: null, paidTo: null,
    decisionNote: trx.raw(`CASE WHEN status = 'rejected' THEN ? END`, [ERASED]),
  });
}

async function anonymiseAccess(trx, id) {
  await trx('Checkin').where({ memberId: id }).update({ clientMeta: null, authSessionId: null });
  await trx('TrainerSession').where({ memberId: id })
    .update({ customerName: DELETED_PERSON_LABEL, customerEmail: null, customerPhone: null });
}

async function anonymiseOrders(trx, id) {
  await trx('ShopOrder').where({ buyerId: id }).update({ deliveryAddress: null, note: null });
}

/** Stars stay, so gym, trainer and product ratings do not move; the words go. Names were never stored. */
async function detachReviews(trx, id) {
  await trx('GymReview').where({ memberId: id }).update({ text: null });
  await trx('TrainerReview').where({ memberId: id }).update({ text: null });
  await trx('ProductReview').where({ buyerId: id }).update({ comment: null });
}

async function anonymiseEvents(trx, id, at) {
  const own = () => trx('EventRegistration').where(q => q.where({ participantUserId: id }).orWhere({ purchaserUserId: id, consentBasis: 'self' }));
  const ids = (await own().select('id')).map(r => r.id);
  if (ids.length) {
    await own().update({
      firstName: DELETED_PERSON_FIRST_NAME, lastName: DELETED_PERSON_LAST_NAME,
      phone: null, email: null, phoneNormalized: null, emailNormalized: null, dateOfBirth: null, gender: null,
      emergencyContact: null, groupLabel: null, claimTokenHash: null, claimTokenExpiresAt: null, claimedAt: null,
      participantUserId: null, resultsVisibility: 'hidden', resultsVisibilitySetAt: at, updatedAt: at,
    });
    await trx('EventKitCollection').whereIn('registrationId', ids).update({ note: null });
  }
  await trx('EventResultDispute').where({ raisedByUserId: id }).update({ note: null });
  await trx('EventOrder').where({ purchaserUserId: id }).update({ purchaserReference: null });
}

/** The person leaves the sponsor's list: past consumption and invoices stay, the next period does not bill them. */
async function leaveSponsors(trx, id, contacts, at) {
  const beneficiaries = (await trx('B2BBeneficiary').where({ userId: id })
    .update({ externalReference: null, status: 'inactive', statusChangedAt: at, updatedAt: at }, ['id'])).map(r => r.id);
  await trx('B2BBeneficiaryInvite').where(q => {
    if (beneficiaries.length) q.whereIn('beneficiaryId', beneficiaries);
    if (contacts.length) q.orWhereIn('email', contacts).orWhereIn('phone', contacts);
    if (!beneficiaries.length && !contacts.length) q.whereRaw('false');
  }).del();

  await trx('B2BMemberRequest').where(q => {
    q.where({ userId: id });
    if (contacts.length) q.orWhereIn('contactValue', contacts);
  }).update({
    contactValue: null, details: '{}', updatedAt: at,
    status: trx.raw(`CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END`),
    reason: trx.raw(`CASE WHEN status = 'pending' THEN 'account_deleted' ELSE reason END`),
  });

  // Same as an employee who left: the seat goes back to the company's pool.
  const employees = await trx('CorporateEmployee').where({ userId: id }).select('id', 'corporateId', 'status');
  for (const e of employees) {
    if (e.status !== 'exited') {
      await trx('CorporateAccount').where({ id: e.corporateId }).where('seatsUsed', '>', 0).decrement('seatsUsed', 1);
    }
    await trx('CorporateEmployee').where({ id: e.id }).update({
      userId: null, displayName: DELETED_PERSON_LABEL, phone: null, email: null, department: null, pinHash: null, status: 'exited', updatedAt: at,
    });
  }
}

/** A closed shop leaves the catalogue, as if each product had been deleted. Past orders keep their own copy of the items. */
async function takeVendorOffSale(trx, vendorId, at) {
  await trx('Product').where({ vendorId }).whereNull('deletedAt').update({ deletedAt: at, status: 'archived', updatedAt: at });
}

/** Not financial: the conversation itself. Both sides' copy is one row. */
async function removeConversations(trx, id) {
  await trx('TrainerEngagement').where({ memberId: id }).del();
  await trx('MarketplaceEnquiry').where({ buyerId: id }).del();
  await trx('MarketplaceNotification').where({ userId: id }).del();
}

async function removePersonaRows(trx, id, at) {
  await trx('SmsLog').where({ userId: id }).del();
  await trx('PartnerMediaUploadAttempt').where({ userId: id }).del();
  await trx('EventMedalArtUploadAttempt').where({ userId: id }).del();
  // A deleted account lets its username go; the handle stays held for the usual period.
  const username = await trx('MemberUsername').where({ id }).first('handleLower');
  if (username?.handleLower) {
    await trx('UsernameRelease').insert({ id: `rel_${randomUUID().slice(0, 12)}`, handleLower: username.handleLower, userId: id, reason: 'account_deleted', releasedAt: at });
  }
  await trx('MemberUsername').where({ id }).del();
  await trx('OrgMembership').where({ personaId: id }).whereIn('status', ['requested', 'invited', 'active', 'suspended'])
    .update({ status: 'removed', endedAt: at, endReason: 'persona_removed', updatedAt: at });
}

async function removeTrainerProfile(trx, userId) {
  const profile = await trx('TrainerProfile').where({ userId }).first('id');
  if (!profile) return null;
  // An account with bookings never gets here. What is left is about this trainer only.
  await trx('TrainerEngagement').where({ trainerId: profile.id }).del();
  await trx('TrainerSession').where({ trainerId: profile.id }).del();
  await trx('TrainerReview').where({ trainerId: profile.id }).del();
  await trx('TrainerProfile').where({ id: profile.id }).del();   // TrainerProfileGym, WorkoutPlan, relationships cascade
  return profile.id;
}

async function scrubAuditTrail(trx, id) {
  await trx.raw(`UPDATE "AuditLog"
       SET before = CASE WHEN jsonb_typeof(before) = 'object' THEN before - ?::text[] ELSE before END,
           after  = CASE WHEN jsonb_typeof(after)  = 'object' THEN after  - ?::text[] ELSE after  END
     WHERE (target = ? OR actor = ?) AND (before IS NOT NULL OR after IS NOT NULL)`,
  [AUDIT_PERSONAL_KEYS, AUDIT_PERSONAL_KEYS, id, id]);
}

/** Only for the last persona. Runs before the User row goes, while the identifiers can still be read. */
async function removeContactKeyedRows(trx, { contacts, phones }) {
  if (phones.length) {
    await trx('SmsLog').whereIn('phone', phones).del();
    await trx('Otp').whereIn('phone', phones).del();
  }
  if (!contacts.length) return;
  await trx('FriendInvitation').whereIn('identifierValue', contacts).del();
  await trx('Invitation').whereIn('identifierValue', contacts).del();
  await trx('VerificationCode').whereIn('identifierValue', contacts).del();
}

/** Only for the last persona. The Person row stays closed and empty: append-only logs point at it. */
async function closePerson(trx, personId, at) {
  await trx('LoginIdentifier').where({ personId }).del();
  await trx('VerificationCode').where({ personId }).del();
  await trx('AuthAttempt').where({ personId }).del();
  await trx('Invitation').where({ targetPersonId: personId }).del();
  await trx('IdentityConflict').whereRaw('? = ANY("personIds")', [personId]).del();

  const recoveries = await trx('AccountRecovery').where({ personId }).select('id');
  if (recoveries.length) {
    await trx('AccountRecovery').where({ personId }).update({
      status: trx.raw(`CASE WHEN status = 'open' THEN 'cancelled' ELSE status END`),
      oldIdentifierValue: ERASED, newIdentifierValue: ERASED, claimedName: null, evidence: '{}',
      cancelKeyHash: null, requestIp: null, decisionNote: null, updatedAt: at,
    });
    await trx('AccountRecoveryEvent').whereIn('recoveryId', recoveries.map(r => r.id)).whereNotNull('detail').update({ detail: null });
  }
  await trx('IdentityEvent').where(q => q.where({ personId }).orWhere({ fromPersonId: personId }))
    .where(q => q.whereNotNull('normalizedValue').orWhereNotNull('details')).update({ normalizedValue: null, details: null });

  await trx('Person').where({ id: personId }).whereNot({ status: 'merged' }).update({
    status: 'closed', displayName: null, dateOfBirth: null, gender: null, declaredProfileUpdatedAt: null,
    pinHash: null, pinSetAt: null, pinFailedCount: 0, pinLockedUntil: null, lastPersonaId: null, sessionsValidAfter: at, updatedAt: at,
  });
}

/**
 * @param {object} deps
 * @param {import('knex').Knex} deps.db
 * @param {Array<(trx, ctx: { userId, personId, lastPersona }) => Promise<void>>} [deps.steps] other modules' own forget steps, run after the User row is gone
 * @param {() => Date} [deps.now]
 */
export function createAccountErasure({ db, steps = [], now = () => new Date() }) {
  /**
   * Deletes one persona. `beforeCommit({ firebaseShared })` runs last inside the transaction, so a
   * failure there (Firebase) undoes everything. → { ok, trainerProfileId } | { missing: true } when
   * the row has already gone (a second press, or a retry after a lost answer).
   */
  async function erase(userId, { beforeCommit = async () => {} } = {}) {
    return db.transaction(async (trx) => {
      const user = await trx('User').where({ id: userId }).forUpdate().first('id', 'personId', 'firebaseUid', 'phone', 'email', 'userType');
      if (!user) return { missing: true };
      const at = now();
      const lastPersona = !user.personId || !(await trx('User').where({ personId: user.personId }).whereNot({ id: user.id }).first('id'));
      const contacts = lastPersona ? await ownContacts(trx, user) : { contacts: [], phones: [] };

      await anonymisePayments(trx, user.id);
      await anonymiseAccess(trx, user.id);
      await anonymiseOrders(trx, user.id);
      await detachReviews(trx, user.id);
      await anonymiseEvents(trx, user.id, at);
      await leaveSponsors(trx, user.id, contacts.contacts, at);
      await removeConversations(trx, user.id);
      await removePersonaRows(trx, user.id, at);
      const trainerProfileId = user.userType === 'trainer' ? await removeTrainerProfile(trx, user.id) : null;
      if (user.userType === 'vendor') await takeVendorOffSale(trx, user.id, at);
      await scrubAuditTrail(trx, user.id);
      if (lastPersona) await removeContactKeyedRows(trx, contacts);

      // The rest goes with the row (ON DELETE CASCADE): device tokens, notifications, messages and
      // preferences, activity and routes, comments, kudos, follows, blocks, social profile and group
      // memberships, goals, workouts, plans, challenge entries and rewards, friend invitations, company
      // and organizer staff links. Partner KYC cases also go this way; see the open question in the PR.
      await trx('User').where({ id: user.id }).del();

      if (lastPersona && user.personId) await closePerson(trx, user.personId, at);
      for (const step of steps) await step(trx, { userId: user.id, personId: user.personId, lastPersona });

      await trx('AuditLog').insert({
        id: randomUUID(), at, actor: user.id, action: 'self_account_deleted', target: user.id,
        before: JSON.stringify({ userType: user.userType }), after: null,
      });

      const firebaseShared = Boolean(user.firebaseUid)
        && Boolean(await trx('User').where({ firebaseUid: user.firebaseUid }).first('id'));
      // Another persona stays on a different sign-in: this one's Firebase link goes with its login.
      if (!lastPersona && user.firebaseUid && !firebaseShared) {
        await trx('LoginIdentifier').where({ personId: user.personId, type: 'firebase_uid', normalizedValue: user.firebaseUid }).del();
      }
      await beforeCommit({ firebaseUid: user.firebaseUid || null, firebaseShared });
      return { ok: true, trainerProfileId };
    });
  }

  return { erase };
}
