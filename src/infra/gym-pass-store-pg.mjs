// Postgres store for custom gym passes (GYM_CUSTOM_PASSES). Every multi-row change is ONE transaction, and every
// change to a purchase's people first locks the purchase row (SELECT ... FOR UPDATE), so two concurrent adds can
// never take more slots than the sale allows and a retried activation can never run twice.
//
// Child subscriptions are written here, in the same transaction as the beneficiary they belong to: each covered
// person gets their OWN `direct_sub` row (same expiresAt as the sale, no PaymentRequest of its own).
import { randomUUID } from 'node:crypto';
import { SLOT_HOLDING, effectivePurchaseStatus, passExpiry } from '../shared/gym-pass-rules.mjs';

const plain = (row) => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const UNIQUE_VIOLATION = '23505';
const constraintOf = (err) => String(err?.constraint || err?.detail || err?.message || '');

export function createPgGymPassStore({ db, now = () => new Date() }) {
  // ── plans ──────────────────────────────────────────────────────────────────

  async function insertPlan(plan) {
    const [row] = await db('GymPassPlan').insert(plan).returning('*');
    return plain(row);
  }
  async function updatePlan(id, patch) {
    const [row] = await db('GymPassPlan').where({ id }).update({ ...patch, updatedAt: now() }).returning('*');
    return plain(row);
  }
  const getPlan = async (id) => plain(await db('GymPassPlan').where({ id }).first());
  async function listPlans(gymId, { status = null } = {}) {
    const q = db('GymPassPlan').where({ gymId }).orderBy('createdAt', 'desc');
    if (status) q.where({ status });
    return (await q).map(plain);
  }

  // ── purchases ──────────────────────────────────────────────────────────────

  const getPurchase = async (id, q = db) => plain(await q('GymPassPurchase').where({ id }).first());
  const purchaseForPayment = async (paymentRequestId) => plain(await db('GymPassPurchase').where({ paymentRequestId }).first());
  const openPurchase = async (purchaserId, planId) =>
    plain(await db('GymPassPurchase').where({ purchaserId, planId, status: 'pending_payment' }).first());
  const beneficiariesOf = async (purchaseId, q = db) =>
    (await q('GymPassBeneficiary').where({ purchaseId }).orderByRaw('"slot" ASC NULLS LAST').orderBy('createdAt')).map(plain);
  const getBeneficiary = async (id) => plain(await db('GymPassBeneficiary').where({ id }).first());

  /**
   * The sale: the PaymentRequest (one, for the full price), the purchase and its people, together.
   * → { purchase, beneficiaries, payment } | { error, status }
   */
  async function createPurchase({ purchase, beneficiaries, payment }) {
    try {
      return await db.transaction(async (trx) => {
        await trx('PaymentRequest').insert({ ...payment, passPurchaseId: purchase.id });
        await trx('GymPassPurchase').insert({ ...purchase, paymentRequestId: payment.id, snapshot: JSON.stringify(purchase.snapshot) });
        if (beneficiaries.length) await trx('GymPassBeneficiary').insert(beneficiaries);
        return { purchase: await getPurchase(purchase.id, trx), beneficiaries: await beneficiariesOf(purchase.id, trx), payment: plain(await trx('PaymentRequest').where({ id: payment.id }).first()) };
      });
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION) {
        const c = constraintOf(err);
        if (/gympasspurchase_open_unique/.test(c)) return fail('payment_already_pending', 409);
        if (/member_reference_key|memberReferenceKey/.test(c)) return fail('payment_reference_duplicate', 409);
        if (/gympassbeneficiary_/.test(c)) return fail('duplicate_beneficiary', 409);
      }
      throw err;
    }
  }

  /** The member withdraws an unpaid purchase: purchase and its payment request are cancelled together. */
  async function cancelOpen({ purchaseId, purchaserId, at }) {
    return db.transaction(async (trx) => {
      const p = await trx('GymPassPurchase').where({ id: purchaseId }).forUpdate().first();
      if (!p || p.purchaserId !== purchaserId) return fail('not_found', 404);
      if (p.status !== 'pending_payment') return fail('not_cancellable', 409);
      // A mobile-money prompt is on the member's phone: cancelling now would strand the money.
      const live = p.paymentRequestId ? await trx('PaymentRequest').where({ id: p.paymentRequestId, status: 'pending', provider: 'tunzaa' }).whereNotNull('reference').first('id') : null;
      if (live) return fail('payment_in_progress', 409);
      await trx('GymPassPurchase').where({ id: p.id }).update({ status: 'cancelled', updatedAt: at });
      if (p.paymentRequestId) {
        await trx('PaymentRequest').where({ id: p.paymentRequestId, status: 'pending' }).update({ status: 'cancelled', decidedAt: at });
      }
      return { purchase: plain(await getPurchase(p.id, trx)) };
    });
  }

  const childSubscription = ({ memberId, purchase, beneficiaryId, startedAt }) => ({
    id: `sub_${randomUUID().slice(0, 8)}`,
    memberId, type: 'direct_sub', tier: null, plan: null, status: 'active',
    startedAt, cycleStartedAt: startedAt, renewsAt: purchase.expiresAt, expiresAt: purchase.expiresAt,
    homeGymId: purchase.gymId, paymentRef: null,
    passPurchaseId: purchase.id, passBeneficiaryId: beneficiaryId,
  });

  /** Beneficiaries still waiting for an account (the service resolves their contacts before activation). */
  const pendingContactsOf = async (purchaseId) =>
    (await db('GymPassBeneficiary').where({ purchaseId, status: 'pending_registration' })).map(plain);

  /**
   * The payment is approved: the purchase becomes active, dated from NOW (the payment moment), and every covered
   * person who has an account gets their own active child subscription. All in one transaction; running it again
   * for an active purchase changes nothing. A purchase whose payment is not approved is never activated.
   * `resolved` maps beneficiary id → user id for people whose contact now belongs to a verified account.
   * → { outcome: 'activated' | 'already_active' | 'not_approved' | 'not_found' | 'unavailable', purchase, beneficiaries }
   */
  async function activate({ paymentRequestId, resolved = new Map(), at = now() }) {
    return db.transaction(async (trx) => {
      const found = await trx('GymPassPurchase').where({ paymentRequestId }).first('id');
      if (!found) return { outcome: 'not_found' };
      const purchase = await trx('GymPassPurchase').where({ id: found.id }).forUpdate().first();
      if (purchase.status === 'active') return { outcome: 'already_active', purchase: plain(purchase), beneficiaries: await beneficiariesOf(purchase.id, trx) };
      if (!['pending_payment', 'cancelled'].includes(purchase.status)) return { outcome: 'unavailable', purchase: plain(purchase) };
      const pay = await trx('PaymentRequest').where({ id: paymentRequestId }).first('status');
      if (pay?.status !== 'approved') return { outcome: 'not_approved', purchase: plain(purchase) };

      const snap = purchase.snapshot;
      const startsAt = new Date(at);
      const expiresAt = passExpiry(startsAt, snap.durationValue, snap.durationUnit);
      const [active] = await trx('GymPassPurchase').where({ id: purchase.id })
        .update({ status: 'active', startsAt, expiresAt, updatedAt: startsAt }).returning('*');

      const rows = await trx('GymPassBeneficiary').where({ purchaseId: purchase.id }).whereNot({ status: 'removed' }).orderBy('slot').forUpdate();
      const seen = new Set(rows.filter(r => r.userId).map(r => r.userId));
      for (const b of rows) {
        let userId = b.userId;
        if (!userId && resolved.has(b.id) && !seen.has(resolved.get(b.id))) {
          userId = resolved.get(b.id);
          seen.add(userId);
        }
        if (!userId) continue; // stays pending_registration: claimed when they sign up with the verified contact
        const suspended = b.status === 'suspended';
        if (b.subscriptionId) {
          // Re-approval of a payment that was put back: the same child row runs again from now.
          await trx('Subscription').where({ id: b.subscriptionId }).update({
            status: suspended ? 'suspended' : 'active', startedAt: startsAt, cycleStartedAt: startsAt, renewsAt: expiresAt, expiresAt,
          });
          continue;
        }
        const sub = childSubscription({ memberId: userId, purchase: active, beneficiaryId: b.id, startedAt: startsAt });
        if (suspended) sub.status = 'suspended';
        await trx('Subscription').insert(sub);
        await trx('GymPassBeneficiary').where({ id: b.id }).update({
          userId, status: suspended ? 'suspended' : 'active', subscriptionId: sub.id,
          claimedAt: b.isPurchaser ? null : startsAt, inviteTokenHash: null, inviteExpiresAt: null, updatedAt: startsAt,
        });
      }
      return { outcome: 'activated', purchase: plain(active), beneficiaries: await beneficiariesOf(purchase.id, trx) };
    });
  }

  /**
   * The payment was rejected, cancelled or put back to pending. Access stops with it: the purchase is cancelled
   * (or goes back to pending_payment) and every child subscription is cancelled. A later re-approval re-activates it.
   */
  async function reverse({ paymentRequestId, to, at = now() }) {
    return db.transaction(async (trx) => {
      const found = await trx('GymPassPurchase').where({ paymentRequestId }).first('id');
      if (!found) return { outcome: 'not_found' };
      const p = await trx('GymPassPurchase').where({ id: found.id }).forUpdate().first();
      if (!['pending_payment', 'active', 'cancelled'].includes(p.status)) return { outcome: 'unavailable', purchase: plain(p) };
      let next = to === 'pending' ? 'pending_payment' : 'cancelled';
      if (next === 'pending_payment' && p.status !== 'pending_payment') {
        // Back to waiting for payment, unless the member has opened another request for the same plan meanwhile.
        const clash = await trx('GymPassPurchase').where({ purchaserId: p.purchaserId, planId: p.planId, status: 'pending_payment' }).whereNot({ id: p.id }).first('id');
        if (clash) next = 'cancelled';
      }
      if (p.status === next) return { outcome: 'unchanged', purchase: plain(p) };
      await trx('GymPassPurchase').where({ id: p.id }).update({ status: next, updatedAt: at });
      await trx('Subscription').where({ passPurchaseId: p.id }).whereIn('status', ['active', 'suspended']).update({ status: 'cancelled' });
      return { outcome: 'reversed', purchase: plain(await getPurchase(p.id, trx)) };
    });
  }

  // ── people ─────────────────────────────────────────────────────────────────

  const lowestFreeSlot = (held, limit) => {
    const used = new Set(held.map(h => h.slot));
    for (let s = 1; s <= limit; s += 1) if (!used.has(s)) return s;
    return null;
  };

  /**
   * Add one person to an active purchase: someone with an account (`userId`) gets their own subscription at once;
   * otherwise the contact is stored as pending_registration. Locks the purchase, counts the people holding a slot
   * and refuses past the limit the buyer paid for.
   */
  async function addBeneficiary({ purchaseId, userId = null, contact = null, at = now() }) {
    try {
      return await db.transaction(async (trx) => {
        const purchase = await trx('GymPassPurchase').where({ id: purchaseId }).forUpdate().first();
        if (!purchase) return fail('not_found', 404);
        if (effectivePurchaseStatus(purchase, at) !== 'active') return fail('pass_not_active', 409);
        const limit = Number(purchase.snapshot.beneficiaryLimit);
        const held = await trx('GymPassBeneficiary').where({ purchaseId }).whereIn('status', SLOT_HOLDING);
        if (held.length >= limit) return fail('beneficiary_limit_exceeded', 409, { limit });
        if (userId && held.some(h => h.userId === userId)) return fail('already_beneficiary', 409);
        if (contact && held.some(h => h.contactType === contact.type && h.contactValue === contact.value)) return fail('already_beneficiary', 409);
        const slot = lowestFreeSlot(held, limit);
        const id = newId('gpb');
        const row = {
          id, purchaseId, userId, contactType: contact?.type ?? null, contactValue: contact?.value ?? null,
          isPurchaser: false, slot, status: userId ? 'active' : 'pending_registration', claimedAt: userId ? at : null,
          createdAt: at, updatedAt: at,
        };
        if (userId) {
          const sub = childSubscription({ memberId: userId, purchase: plain(purchase), beneficiaryId: id, startedAt: new Date(at) });
          await trx('Subscription').insert(sub);
          row.subscriptionId = sub.id;
        }
        await trx('GymPassBeneficiary').insert(row);
        return { purchase: plain(purchase), beneficiary: plain(await trx('GymPassBeneficiary').where({ id }).first()) };
      });
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION && /gympassbeneficiary_/.test(constraintOf(err))) return fail('already_beneficiary', 409);
      throw err;
    }
  }

  /**
   * suspended | active (resume) | removed, for one person. `role` is who asks: 'owner', 'purchaser' or 'self'.
   * Removing never refunds and never cancels the package: it frees the slot (and cancels that person's own subscription).
   */
  async function changeStatus({ beneficiaryId, to, role, actorId, removalCap = Infinity, at = now() }) {
    return db.transaction(async (trx) => {
      const first = await trx('GymPassBeneficiary').where({ id: beneficiaryId }).first('purchaseId');
      if (!first) return fail('not_found', 404);
      const purchase = await trx('GymPassPurchase').where({ id: first.purchaseId }).forUpdate().first();
      const b = await trx('GymPassBeneficiary').where({ id: beneficiaryId }).forUpdate().first();
      if (effectivePurchaseStatus(purchase, at) !== 'active') return fail('pass_not_active', 409);
      if (b.isPurchaser && (to === 'removed' || role === 'purchaser')) return fail(to === 'removed' ? 'cannot_remove_purchaser' : 'cannot_modify_purchaser', 409);
      if (to === 'suspended') {
        if (b.status !== 'active') return fail('invalid_transition', 409, { from: b.status });
        await trx('Subscription').where({ id: b.subscriptionId }).update({ status: 'suspended' });
        await trx('GymPassBeneficiary').where({ id: b.id }).update({ status: 'suspended', updatedAt: at });
      } else if (to === 'active') {
        if (b.status !== 'suspended') return fail('invalid_transition', 409, { from: b.status });
        await trx('Subscription').where({ id: b.subscriptionId }).update({ status: 'active' });
        await trx('GymPassBeneficiary').where({ id: b.id }).update({ status: 'active', updatedAt: at });
      } else if (to === 'removed') {
        if (!SLOT_HOLDING.includes(b.status)) return fail('invalid_transition', 409, { from: b.status });
        if (role === 'purchaser') {
          const [{ n }] = await trx('GymPassBeneficiary').where({ purchaseId: purchase.id, removedByRole: 'purchaser' }).count({ n: '*' });
          if (Number(n) >= removalCap) return fail('replacement_limit_reached', 409, { limit: removalCap });
        }
        if (b.subscriptionId) await trx('Subscription').where({ id: b.subscriptionId }).update({ status: 'cancelled' });
        await trx('GymPassBeneficiary').where({ id: b.id }).update({
          status: 'removed', slot: null, inviteTokenHash: null, inviteExpiresAt: null,
          removedAt: at, removedBy: actorId, removedByRole: role, updatedAt: at,
        });
      } else {
        return fail('invalid_transition', 409);
      }
      return { purchase: plain(purchase), before: plain(b), beneficiary: plain(await trx('GymPassBeneficiary').where({ id: b.id }).first()) };
    });
  }

  // ── invitations & claiming ─────────────────────────────────────────────────

  async function setInvite(beneficiaryId, { tokenHash, expiresAt, sentAt = null }) {
    await db('GymPassBeneficiary').where({ id: beneficiaryId, status: 'pending_registration' })
      .update({ inviteTokenHash: tokenHash, inviteExpiresAt: expiresAt, ...(sentAt ? { inviteSentAt: sentAt } : {}), updatedAt: now() });
  }
  const findByToken = async (tokenHash) => plain(await db('GymPassBeneficiary').where({ inviteTokenHash: tokenHash }).first());
  async function recordSent(beneficiaryId, via, at = now()) {
    await db('GymPassBeneficiary').where({ id: beneficiaryId }).update({ inviteSentAt: at, notifiedVia: via.join(',') || null, updatedAt: at });
  }
  /** First caller wins the right to notify this person; a retry (or a second approval) finds it taken. */
  async function claimNotice(beneficiaryId, at = now()) {
    const n = await db('GymPassBeneficiary').where({ id: beneficiaryId }).whereNull('notifiedAt').update({ notifiedAt: at });
    return n === 1;
  }
  async function recordNotified(beneficiaryId, via) {
    await db('GymPassBeneficiary').where({ id: beneficiaryId }).update({ notifiedVia: via.join(',') || null });
  }

  /** Pending people (of purchases still running) whose contact is in this verified list. */
  async function pendingForContacts(contacts, at = now()) {
    const phones = contacts.filter(c => c.type === 'phone').map(c => c.value);
    const emails = contacts.filter(c => c.type === 'email').map(c => c.value);
    if (!phones.length && !emails.length) return [];
    const rows = await db('GymPassBeneficiary as b').join('GymPassPurchase as p', 'p.id', 'b.purchaseId')
      .where('b.status', 'pending_registration').where('p.status', 'active').where('p.expiresAt', '>', at)
      .where((w) => {
        if (phones.length) w.orWhere((x) => x.where('b.contactType', 'phone').whereIn('b.contactValue', phones));
        if (emails.length) w.orWhere((x) => x.where('b.contactType', 'email').whereIn('b.contactValue', emails));
      })
      .select('b.*');
    return rows.map(plain);
  }

  /** The person signed up with the verified contact: attach them, with their own subscription, until the sale's end. */
  async function claim({ beneficiaryId, userId, at = now() }) {
    try {
      return await db.transaction(async (trx) => {
        const first = await trx('GymPassBeneficiary').where({ id: beneficiaryId }).first('purchaseId');
        if (!first) return { outcome: 'not_found' };
        const purchase = await trx('GymPassPurchase').where({ id: first.purchaseId }).forUpdate().first();
        const b = await trx('GymPassBeneficiary').where({ id: beneficiaryId }).forUpdate().first();
        if (b.status !== 'pending_registration') return { outcome: 'not_pending' };
        if (effectivePurchaseStatus(purchase, at) !== 'active') return { outcome: 'pass_not_active' };
        const dup = await trx('GymPassBeneficiary').where({ purchaseId: purchase.id, userId }).whereNot({ status: 'removed' }).first('id');
        if (dup) return { outcome: 'already_member' };
        const sub = childSubscription({ memberId: userId, purchase: plain(purchase), beneficiaryId: b.id, startedAt: new Date(at) });
        await trx('Subscription').insert(sub);
        await trx('GymPassBeneficiary').where({ id: b.id }).update({
          userId, status: 'active', subscriptionId: sub.id, claimedAt: at, inviteTokenHash: null, inviteExpiresAt: null, updatedAt: at,
        });
        return { outcome: 'claimed', purchase: plain(purchase), beneficiary: plain(await trx('GymPassBeneficiary').where({ id: b.id }).first()) };
      });
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION) return { outcome: 'already_member' };
      throw err;
    }
  }

  // ── reads for the apps and the owner's reports ─────────────────────────────

  /** Active purchases past their end become expired (their child subscriptions already read as expired by date). */
  async function expireDue({ gymId = null, purchaserId = null, at = now() } = {}) {
    const q = db('GymPassPurchase').where({ status: 'active' }).where('expiresAt', '<=', at);
    if (gymId) q.where({ gymId });
    if (purchaserId) q.where({ purchaserId });
    return q.update({ status: 'expired', updatedAt: at });
  }

  async function purchasesForGym(gymId, { status = null, planId = null, from = null, to = null, limit = 50, before = null } = {}) {
    const q = db('GymPassPurchase as p').leftJoin('PaymentRequest as r', 'r.id', 'p.paymentRequestId')
      .where('p.gymId', gymId).orderBy('p.createdAt', 'desc').limit(limit)
      .select('p.*', 'r.status as paymentStatus', 'r.amountTzs as paymentAmountTzs', 'r.reference as paymentReference');
    if (status) q.where('p.status', status);
    if (planId) q.where('p.planId', planId);
    if (from) q.where('p.createdAt', '>=', from);
    if (to) q.where('p.createdAt', '<', to);
    if (before) q.where('p.createdAt', '<', before);
    return (await q).map(plain);
  }
  async function purchaseWithPayment(id) {
    return plain(await db('GymPassPurchase as p').leftJoin('PaymentRequest as r', 'r.id', 'p.paymentRequestId').where('p.id', id)
      .select('p.*', 'r.status as paymentStatus', 'r.amountTzs as paymentAmountTzs', 'r.reference as paymentReference').first());
  }
  async function purchasesForPurchaser(purchaserId) {
    return (await db('GymPassPurchase as p').leftJoin('PaymentRequest as r', 'r.id', 'p.paymentRequestId')
      .where('p.purchaserId', purchaserId).orderBy('p.createdAt', 'desc').limit(100)
      .select('p.*', 'r.status as paymentStatus', 'r.amountTzs as paymentAmountTzs')).map(plain);
  }
  async function beneficiariesOfMany(purchaseIds) {
    if (!purchaseIds.length) return [];
    return (await db('GymPassBeneficiary').whereIn('purchaseId', purchaseIds).orderByRaw('"slot" ASC NULLS LAST').orderBy('createdAt')).map(plain);
  }
  async function membershipsOfUser(userId) {
    return (await db('GymPassBeneficiary as b').join('GymPassPurchase as p', 'p.id', 'b.purchaseId')
      .where('b.userId', userId).whereNot('b.status', 'removed').orderBy('p.createdAt', 'desc').limit(100)
      .select('b.*', 'p.gymId as gymId', 'p.snapshot as snapshot', 'p.status as purchaseStatus', 'p.startsAt as startsAt', 'p.expiresAt as expiresAt', 'p.purchaserId as purchaserId')).map(plain);
  }
  /** Visit counts and the last visit per person, for these purchases. */
  async function attendanceCounts(purchaseIds) {
    if (!purchaseIds.length) return new Map();
    const rows = await db('Checkin').whereIn('passPurchaseId', purchaseIds).whereNot('status', 'voided')
      .groupBy('beneficiaryId').select('beneficiaryId').count({ visits: '*' }).max({ lastVisitAt: 'timestamp' });
    return new Map(rows.map(r => [r.beneficiaryId, { visits: Number(r.visits), lastVisitAt: r.lastVisitAt ? new Date(r.lastVisitAt).toISOString() : null }]));
  }
  async function attendanceOf({ beneficiaryId, limit = 100 }) {
    return (await db('Checkin').where({ beneficiaryId }).whereNot('status', 'voided').orderBy('timestamp', 'desc').limit(limit)
      .select('id', 'gymId', 'timestamp', 'method', 'status', 'businessDate', 'passPurchaseId', 'beneficiaryId')).map(plain);
  }
  /** Every sale of a gym with the money (approved payment only) and the people, for the aggregates. */
  async function summaryRows(gymId) {
    const purchases = (await db('GymPassPurchase as p').leftJoin('PaymentRequest as r', 'r.id', 'p.paymentRequestId')
      .where('p.gymId', gymId)
      .select('p.id', 'p.status', 'p.expiresAt', 'p.snapshot', 'r.status as paymentStatus', 'r.amountTzs as amountTzs')).map(plain);
    const people = await db('GymPassBeneficiary as b').join('GymPassPurchase as p', 'p.id', 'b.purchaseId')
      .where('p.gymId', gymId).groupBy('b.purchaseId', 'b.status').select('b.purchaseId', 'b.status').count({ n: '*' });
    return { purchases, people: people.map(r => ({ purchaseId: r.purchaseId, status: r.status, n: Number(r.n) })) };
  }

  return {
    insertPlan, updatePlan, getPlan, listPlans,
    getPurchase, purchaseForPayment, openPurchase, beneficiariesOf, getBeneficiary,
    createPurchase, cancelOpen, pendingContactsOf, activate, reverse,
    addBeneficiary, changeStatus,
    setInvite, findByToken, recordSent, claimNotice, recordNotified, pendingForContacts, claim,
    expireDue, purchasesForGym, purchaseWithPayment, purchasesForPurchaser, beneficiariesOfMany, membershipsOfUser, attendanceCounts, attendanceOf, summaryRows,
    newId,
  };
}
