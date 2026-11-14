// Custom gym passes & flexible membership (GYM_CUSTOM_PASSES). Gym owners design passes (individual, couples, group;
// any duration; one price); a member buys one with ONE payment; when it is approved every covered person gets their
// own subscription (own QR eligibility, own check-ins) until the same end date.
//
// Decisions this file implements (owner, 2026-11-14):
//  - D3: people a pass covers do NOT approve it. They are attached directly and NOTIFIED (in-app + push, and
//    WhatsApp, falling back to SMS, to their number). Someone with no account is kept as pending_registration with
//    the contact the buyer typed and gets an invite link; they are attached when they sign up and VERIFY that very
//    contact. Only a verified contact ever links a person (verified-contacts.mjs); the link's token grants nothing.
//  - The buyer pays the full price once. Child subscriptions have no PaymentRequest, so revenue is counted once.
//  - Removing a person never refunds and never cancels the pass: it frees the slot. The owner may remove or replace
//    anyone; the buyer a limited number of times; a person may leave themself.
//
// Privacy: the buyer types contacts, never user ids, and the responses show only masked contacts and masked names.
// After activation the buyer can tell "has an account" (active) from "invited" (pending) for the contacts they
// added; that is the same fact the friend-invitation lookup already tells any member, and nothing else about the
// person is shown (no id, no full name, no unmasked contact).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { gymPassMessage, gymPassNotice } from '../shared/gym-pass-texts.mjs';
import { eatParts } from '../shared/eat-time.mjs';
import { normalizeEmail, normalizePhone } from '../shared/identifiers.mjs';
import {
  validatePlanInput, planSnapshot, checkoutHeadcount, purchaserRemovalCap, maskContact, effectivePurchaseStatus,
  PASS_CATEGORIES, PASS_LIMITS, CURRENCY,
} from '../shared/gym-pass-rules.mjs';
import { parseContact, maskName } from './friend-invitation-service.mjs';

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const isTokenShape = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(t);
const inviteExpiryDays = () => {
  const n = Number(process.env.GYM_PASS_INVITE_EXPIRY_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
};
const RESEND_WAIT_MS = 60 * 60 * 1000;
const untilOf = (v) => eatParts(v)?.date ?? '';

const ownedGymIds = (owner) => owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);

export const GYM_PASS_LIST_MAX = 200;

export function createGymPassService({
  store, gyms, users, auditLog,
  // { findMember({type,value}) → member|null, contactsFor(userId) → [{type,value}] }: VERIFIED contacts only.
  contacts,
  notify = async () => ({}),
  // { whatsapp({ phone, kind, params, locale, reference }) → { status }, sms({ phone, text, reference }) → { status } }.
  // WhatsApp may be dormant (status 'skipped:...'); SMS is then used. Either may be null.
  channels = null,
  localeOf = async () => null,
  // (reference, payerPhone, memberId, product) → { error, status } | { memberReference, memberReferenceKey, payerPhone } | {}
  memberReference = async () => ({}),
  referenceFields = () => ({}),
  baseLink = () => process.env.FRIEND_INVITE_BASE_URL || process.env.APP_DOWNLOAD_LINK || 'https://fitflex-af-app.web.app',
  now = () => new Date(),
}) {
  const iso = (d = now()) => new Date(d).toISOString();
  const gymOf = (id) => gyms.find(g => g.id === id) || null;
  const owns = (owner, gymId) => ownedGymIds(owner).includes(gymId);

  const audit = async (actor, action, target, before, after) => {
    try {
      await auditLog.insertAsync({ id: randomUUID(), at: iso(), actor: actor ?? null, action, target, before, after });
    } catch (err) {
      console.warn(`[gym-pass] audit ${action} failed: ${err?.message}`);
    }
  };

  // ── views ──────────────────────────────────────────────────────────────────

  const planView = (p) => ({
    id: p.id, gymId: p.gymId, name: p.name, description: p.description ?? null, category: p.category,
    durationValue: p.durationValue, durationUnit: p.durationUnit, beneficiaryLimit: p.beneficiaryLimit,
    priceTzs: p.priceTzs, currency: CURRENCY, startPolicy: p.startPolicy,
    terms: p.terms ?? null, termsVersion: p.termsVersion,
  });
  const ownerPlanView = (p) => ({ ...planView(p), status: p.status, createdBy: p.createdBy, createdAt: p.createdAt, updatedAt: p.updatedAt });

  const snapshotView = (s) => ({
    name: s.name, description: s.description ?? null, category: s.category, priceTzs: s.priceTzs, currency: s.currency ?? CURRENCY,
    durationValue: s.durationValue, durationUnit: s.durationUnit, beneficiaryLimit: s.beneficiaryLimit,
    terms: s.terms ?? null, termsVersion: s.termsVersion ?? 1,
  });

  /** Before payment nobody is "in" yet: every row reads awaiting_payment (never hints at who has an account). */
  const shownStatus = (b, purchase) => (purchase.status === 'pending_payment' ? 'awaiting_payment' : b.status);

  async function namesOf(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    const rows = unique.length ? await users.filterByColumnInAsync('id', unique) : [];
    return new Map(rows.map(u => [u.id, u.displayName || null]));
  }

  /** One person as the owner sees them: the person's name (they hold a subscription at this gym), masked contact. */
  const ownerBeneficiary = (b, purchase, names, attendance) => ({
    id: b.id, slot: b.slot, isPurchaser: b.isPurchaser, status: shownStatus(b, purchase),
    userId: b.userId ?? null, displayName: b.userId ? (names.get(b.userId) ?? null) : null,
    contactType: b.contactType ?? null, contact: maskContact(b.contactType, b.contactValue),
    subscriptionId: b.subscriptionId ?? null, notifiedAt: b.notifiedAt ?? null, notifiedVia: b.notifiedVia ? b.notifiedVia.split(',') : [],
    claimedAt: b.claimedAt ?? null, removedAt: b.removedAt ?? null, removedByRole: b.removedByRole ?? null,
    ...(attendance ? { attendance: attendance.get(b.id) ?? { visits: 0, lastVisitAt: null } } : {}),
  });

  /** One person as the BUYER sees them: masked names and contacts, no user ids (the buyer's own row excepted). */
  const buyerBeneficiary = (b, purchase, names, viewerId) => ({
    id: b.id, slot: b.slot, isPurchaser: b.isPurchaser, status: shownStatus(b, purchase),
    you: b.userId === viewerId,
    displayName: b.userId === viewerId ? (names.get(b.userId) ?? null) : maskName(names.get(b.userId)),
    contactType: b.contactType ?? null, contact: maskContact(b.contactType, b.contactValue),
  });

  const slotsOf = (rows, purchase) => ({
    used: rows.filter(r => ['active', 'pending_registration', 'suspended'].includes(r.status)).length,
    limit: Number(purchase.snapshot.beneficiaryLimit),
  });

  const purchaseCore = (p, extra = {}) => ({
    id: p.id, status: effectivePurchaseStatus(p, now()), gymId: p.gymId, planId: p.planId ?? null,
    plan: snapshotView(p.snapshot), priceTzs: p.snapshot.priceTzs, currency: p.snapshot.currency ?? CURRENCY,
    paymentRequestId: p.paymentRequestId ?? null, startsAt: p.startsAt ?? null, expiresAt: p.expiresAt ?? null,
    createdAt: p.createdAt, ...extra,
  });

  // ── plans (gym owner) ──────────────────────────────────────────────────────

  async function ownGym(owner, gymId) {
    if (!owns(owner, gymId)) return { error: 'not_your_gym', status: 403 };
    const gym = gymOf(gymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    return { gym };
  }

  async function listPlans({ owner, gymId }) {
    const g = await ownGym(owner, gymId);
    if (g.error) return g;
    return { plans: (await store.listPlans(gymId)).map(ownerPlanView) };
  }

  async function createPlan({ owner, gymId, body, actorId }) {
    const g = await ownGym(owner, gymId);
    if (g.error) return g;
    const checked = validatePlanInput(body);
    if (checked.error) return checked;
    const status = body?.status === 'inactive' ? 'inactive' : 'active';
    const row = {
      id: store.newId('gpp'), gymId, ...checked.value, status, startPolicy: 'immediate',
      termsVersion: 1, createdBy: actorId, createdAt: iso(), updatedAt: iso(),
    };
    const plan = await store.insertPlan(row);
    await audit(actorId, 'gym_pass_plan_created', plan.id, null, ownerPlanView(plan));
    return { status: 201, plan: ownerPlanView(plan) };
  }

  /** The plan, if it is this owner's gym's. Another gym's plan is "not found" (no probing by id). */
  async function ownPlan(owner, gymId, planId) {
    const g = await ownGym(owner, gymId);
    if (g.error) return g;
    const plan = await store.getPlan(String(planId));
    if (!plan || plan.gymId !== gymId) return { error: 'plan_not_found', status: 404 };
    return { plan };
  }

  async function updatePlan({ owner, gymId, planId, body, actorId }) {
    const p = await ownPlan(owner, gymId, planId);
    if (p.error) return p;
    const checked = validatePlanInput(body, p.plan);
    if (checked.error) return checked;
    // Existing purchases keep their snapshot; the terms version moves so a new buyer must accept the new text.
    const termsChanged = (checked.value.terms ?? null) !== (p.plan.terms ?? null);
    const updated = await store.updatePlan(p.plan.id, { ...checked.value, termsVersion: termsChanged ? p.plan.termsVersion + 1 : p.plan.termsVersion });
    await audit(actorId, 'gym_pass_plan_updated', updated.id, ownerPlanView(p.plan), ownerPlanView(updated));
    return { plan: ownerPlanView(updated) };
  }

  async function setPlanStatus({ owner, gymId, planId, status, actorId }) {
    const p = await ownPlan(owner, gymId, planId);
    if (p.error) return p;
    if (p.plan.status === status) return { plan: ownerPlanView(p.plan), unchanged: true };
    const updated = await store.updatePlan(p.plan.id, { status });
    await audit(actorId, status === 'active' ? 'gym_pass_plan_activated' : 'gym_pass_plan_deactivated', updated.id, { status: p.plan.status }, { status });
    return { plan: ownerPlanView(updated) };
  }

  /** Public: a live gym's active plans. */
  async function publicPlans(gymId) {
    const gym = gymOf(String(gymId));
    if (!gym || (gym.status && gym.status !== 'active')) return { error: 'gym_not_found', status: 404 };
    return { gymId: gym.id, plans: (await store.listPlans(gym.id, { status: 'active' })).map(planView) };
  }

  // ── buying ─────────────────────────────────────────────────────────────────

  /**
   * The people a buyer names, as verified contacts → { people: [{ contact, memberId|null }] } | { error }.
   * Contacts are resolved here only to refuse the buyer's own number or the same person twice; the answer is never
   * sent back as "has an account".
   */
  async function resolvePeople(buyerId, list) {
    if (!Array.isArray(list)) return { error: 'invalid_beneficiaries', status: 400 };
    if (list.length > PASS_LIMITS.groupMax - 1) return { error: 'beneficiary_limit_exceeded', status: 400, limit: PASS_LIMITS.groupMax };
    const mine = (await contacts.contactsFor(buyerId)).map(c => `${c.type}:${c.type === 'email' ? normalizeEmail(c.value) : normalizePhone(c.value)}`);
    const people = [];
    const seenContacts = new Set();
    const seenMembers = new Set();
    for (const [index, entry] of list.entries()) {
      const contact = parseContact({ email: entry?.email, phone: entry?.phone });
      if (!contact) return { error: 'invalid_contact', status: 400, index };
      const key = `${contact.type}:${contact.value}`;
      if (mine.includes(key)) return { error: 'cannot_add_yourself', status: 400, index };
      if (seenContacts.has(key)) return { error: 'duplicate_beneficiary', status: 400, index };
      seenContacts.add(key);
      const member = await contacts.findMember(contact);
      if (member?.id === buyerId) return { error: 'cannot_add_yourself', status: 400, index };
      if (member && seenMembers.has(member.id)) return { error: 'duplicate_beneficiary', status: 400, index };
      if (member) seenMembers.add(member.id);
      people.push({ contact, memberId: member?.id ?? null });
    }
    return { people };
  }

  /**
   * A member buys a pass. The price is the plan's (never the client's). ONE PaymentRequest for the full price;
   * nothing is active until it is approved. Coverage by category: individual = the buyer; couples = the buyer and
   * exactly one other person; group = the buyer and 2 up to (limit - 1) others.
   */
  async function purchase({ memberId, planId, beneficiaries = [], reference, payerPhone, termsVersion }) {
    const member = await users.findByIdAsync(memberId);
    if (!member || member.userType !== 'member' || member.accountStatus === 'suspended') return { error: 'not_allowed', status: 403 };
    const plan = planId ? await store.getPlan(String(planId)) : null;
    if (!plan) return { error: 'plan_not_found', status: 404 };
    if (plan.status !== 'active') return { error: 'plan_not_available', status: 409 };
    const gym = gymOf(plan.gymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };
    if (gym.status && gym.status !== 'active') return { error: 'gym_not_available', status: 409 };
    if (plan.terms) {
      if (termsVersion == null) return { error: 'terms_not_accepted', status: 400, termsVersion: plan.termsVersion };
      if (Number(termsVersion) !== plan.termsVersion) return { error: 'terms_changed', status: 409, termsVersion: plan.termsVersion };
    }
    const snapshot = { ...planSnapshot(plan), ...(plan.terms ? { termsAcceptedVersion: plan.termsVersion } : {}) };

    const resolved = await resolvePeople(memberId, beneficiaries ?? []);
    if (resolved.error) return resolved;
    const headcount = checkoutHeadcount(snapshot, resolved.people.length);
    if (headcount.error) return { status: 400, ...headcount };

    if (await store.openPurchase(memberId, plan.id)) return { error: 'payment_already_pending', status: 409 };
    const ref = await memberReference(reference, payerPhone, memberId, 'gym_pass');
    if (ref.error) return ref;

    const at = iso();
    const purchaseId = store.newId('gpu');
    const payment = {
      id: `pay_${randomUUID().slice(0, 8)}`, memberId, subscriptionId: null, tier: null, plan: null, gymId: gym.id,
      amountTzs: snapshot.priceTzs, status: 'pending', provider: 'admin_approved', reference: null,
      ...referenceFields(ref), requestedAt: at, decidedAt: null, decidedBy: null, note: 'gym_pass',
    };
    const rows = [{
      id: store.newId('gpb'), purchaseId, userId: memberId, isPurchaser: true, slot: 1, status: 'active', createdAt: at, updatedAt: at,
    }, ...resolved.people.map((p, i) => ({
      id: store.newId('gpb'), purchaseId, userId: null, contactType: p.contact.type, contactValue: p.contact.value,
      isPurchaser: false, slot: i + 2, status: 'pending_registration', createdAt: at, updatedAt: at,
    }))];
    const created = await store.createPurchase({
      purchase: { id: purchaseId, planId: plan.id, gymId: gym.id, purchaserId: memberId, status: 'pending_payment', snapshot, createdAt: at, updatedAt: at },
      beneficiaries: rows, payment,
    });
    if (created.error) return created;
    await audit(memberId, 'gym_pass_purchase_created', purchaseId, null, { planId: plan.id, gymId: gym.id, amountTzs: snapshot.priceTzs, people: rows.length, paymentRequestId: payment.id });
    const names = await namesOf([memberId]);
    return {
      status: 202,
      purchase: purchaseCore(created.purchase, {
        beneficiaries: created.beneficiaries.map(b => buyerBeneficiary(b, created.purchase, names, memberId)),
        slots: slotsOf(created.beneficiaries, created.purchase),
      }),
      paymentRequest: created.payment,
    };
  }

  async function cancelPurchase({ memberId, purchaseId }) {
    const out = await store.cancelOpen({ purchaseId: String(purchaseId), purchaserId: memberId, at: iso() });
    if (out.error) return out;
    await audit(memberId, 'gym_pass_purchase_cancelled', out.purchase.id, { status: 'pending_payment' }, { status: 'cancelled' });
    return { status: 200, purchase: purchaseCore(out.purchase) };
  }

  // ── payment → activation ───────────────────────────────────────────────────

  /** Languages first: a known person's own choice; a stranger gets the buyer's, else English. */
  const localeFor = async (userId, fallbackUserId) => {
    try {
      return (await localeOf(userId ?? fallbackUserId)) === 'sw' ? 'sw' : 'en';
    } catch { return 'en'; }
  };

  /** WhatsApp first, SMS when WhatsApp cannot be used (dormant, no approved template, opted out is final). */
  async function deliver({ phone, kind, params, locale, reference }) {
    const via = [];
    if (!channels || !phone) return via;
    let wa = null;
    if (channels.whatsapp) {
      try { wa = await channels.whatsapp({ phone, kind, params, locale, reference }); } catch { wa = { status: 'failed' }; }
      if (wa?.status === 'sent') via.push('whatsapp');
    }
    if (!via.length && channels.sms && wa?.status !== 'skipped:recipient_opted_out') {
      try {
        const r = await channels.sms({ phone, text: gymPassMessage(kind, params, locale), reference });
        if (r?.status === 'sent') via.push('sms');
      } catch { /* a failed text never fails the pass */ }
    }
    return via;
  }

  /** The in-app notice in the reader's language, with both languages kept in `data` (the no-show notice's convention). */
  async function noticeFor(kind, params, userId, purchase) {
    const locale = await localeFor(userId, purchase.purchaserId);
    const en = gymPassNotice(kind, params, 'en');
    const sw = gymPassNotice(kind, params, 'sw');
    const text = locale === 'sw' ? sw : en;
    return {
      title: text.title, body: text.body,
      data: { purchaseId: purchase.id, gymId: purchase.gymId, locale, titleEn: en.title, bodyEn: en.body, titleSw: sw.title, bodySw: sw.body },
    };
  }

  async function phoneOf(b) {
    if (b.contactType === 'phone') return b.contactValue;
    if (!b.userId) return null;
    return (await contacts.contactsFor(b.userId)).find(c => c.type === 'phone')?.value ?? null;
  }

  async function issueInvite(b, purchase) {
    const token = newToken();
    const cap = +now() + inviteExpiryDays() * 86_400_000;
    const expiresAt = new Date(Math.min(cap, +new Date(purchase.expiresAt)));
    await store.setInvite(b.id, { tokenHash: sha256(token), expiresAt });
    return { token, link: `${String(baseLink()).replace(/\/+$/, '')}/gym-pass/#${token}` };
  }

  /**
   * Tell each person the pass covers, once (the first caller to claim a person's notice sends it; a retried approval
   * finds it taken). Buyer: in-app + push. A person with an account: in-app + push and WhatsApp/SMS to their number.
   * A person without: the invite link by WhatsApp/SMS to the number the buyer gave (an email-only contact gets the
   * invite when the buyer or owner asks for the link: there is no email channel for this).
   */
  async function announce(purchase, rows) {
    const gym = gymOf(purchase.gymId);
    const buyer = await users.findByIdAsync(purchase.purchaserId);
    const base = { planName: purchase.snapshot.name, gymName: gym?.name ?? '', until: untilOf(purchase.expiresAt), buyerName: buyer?.displayName ?? null };
    const sent = [];
    for (const b of rows) {
      if (b.status === 'removed') continue;
      try {
        if (!(await store.claimNotice(b.id, now()))) continue;
        if (b.isPurchaser) {
          await notify(b.userId, {
            id: `ntf_gpa_${b.id}`, type: 'gym_pass_active', ...await noticeFor('active', base, b.userId, purchase),
          });
          await store.recordNotified(b.id, ['in_app']);
          sent.push({ beneficiaryId: b.id, kind: 'purchaser', via: ['in_app'] });
        } else if (b.userId) {
          const via = ['in_app'];
          await notify(b.userId, {
            id: `ntf_gpb_${b.id}`, type: 'gym_pass_added', ...await noticeFor('added', base, b.userId, purchase),
          });
          const locale = await localeFor(b.userId, purchase.purchaserId);
          via.push(...await deliver({ phone: await phoneOf(b), kind: 'added', params: base, locale, reference: b.id }));
          await store.recordNotified(b.id, via);
          sent.push({ beneficiaryId: b.id, kind: 'added', via });
        } else {
          const invite = await issueInvite(b, purchase);
          const locale = await localeFor(null, purchase.purchaserId);
          const via = b.contactType === 'phone'
            ? await deliver({ phone: b.contactValue, kind: 'invite', params: { ...base, link: invite.link }, locale, reference: b.id }) : [];
          // The "last sent" stamp (which paces resends) is set only when something actually went out.
          if (via.length) await store.recordSent(b.id, via, now()); else await store.recordNotified(b.id, via);
          sent.push({ beneficiaryId: b.id, kind: 'invite', via });
        }
      } catch (err) {
        console.warn(`[gym-pass] notifying ${b.id} failed: ${err?.message}`);
      }
    }
    return sent;
  }

  /**
   * The hook of the payment service: a pass purchase's payment was decided. Approved → activate (one transaction,
   * dated from now); rejected / cancelled / put back to pending → access stops. Safe to call again.
   * → null | { error, status } (a refusal makes the payment service put the decision back).
   */
  async function onPaymentStatus(request, status, { actorId = null } = {}) {
    if (!request?.passPurchaseId) return null;
    try {
      if (status !== 'approved') {
        const out = await store.reverse({ paymentRequestId: request.id, to: status, at: now() });
        if (out.outcome === 'reversed') await audit(actorId, 'gym_pass_purchase_reversed', out.purchase.id, null, { status: out.purchase.status, payment: status });
        return null;
      }
      const pending = await store.purchaseForPayment(request.id);
      if (!pending) return { error: 'gym_pass_purchase_missing', status: 409 };
      const resolved = new Map();
      for (const b of await store.pendingContactsOf(pending.id)) {
        const member = await contacts.findMember({ type: b.contactType, value: b.contactValue });
        if (member) resolved.set(b.id, member.id);
      }
      const out = await store.activate({ paymentRequestId: request.id, resolved, at: now() });
      if (out.outcome === 'activated') {
        await audit(actorId, 'gym_pass_purchase_activated', out.purchase.id, null, {
          expiresAt: out.purchase.expiresAt, people: out.beneficiaries.filter(b => b.status !== 'removed').length,
        });
      }
      if (out.outcome === 'activated' || out.outcome === 'already_active') await announce(out.purchase, out.beneficiaries);
      if (out.outcome === 'unavailable') return { error: 'gym_pass_not_activatable', status: 409 };
      return null;
    } catch (err) {
      console.error(`[gym-pass] payment ${request.id} (${status}) could not be applied: ${err?.message}`);
      return { error: 'gym_pass_activation_failed', status: 500 };
    }
  }

  // ── claiming (a person signs up) ───────────────────────────────────────────

  async function verifiedContactsOf(userId) {
    const all = (await contacts.contactsFor(userId))
      .map(c => ({ type: c.type, value: c.type === 'email' ? normalizeEmail(c.value) : c.type === 'phone' ? normalizePhone(c.value) : null }))
      .filter(c => c.value);
    return all.filter((c, i) => all.findIndex(x => x.type === c.type && x.value === c.value) === i);
  }

  const memberOk = async (userId) => {
    const u = await users.findByIdAsync(userId);
    return u && u.userType === 'member' && u.accountStatus !== 'suspended' ? u : null;
  };

  /** What an invitation link is for, before anyone signs in. No contact detail. */
  async function previewInvite(token) {
    if (!isTokenShape(token)) return { error: 'invalid_invitation', status: 404 };
    const b = await store.findByToken(sha256(token));
    if (!b) return { error: 'invalid_invitation', status: 404 };
    const p = await store.getPurchase(b.purchaseId);
    const usable = b.status === 'pending_registration' && p && effectivePurchaseStatus(p, now()) === 'active' && +new Date(b.inviteExpiresAt) > +now();
    const buyer = usable ? await users.findByIdAsync(p.purchaserId) : null;
    return {
      invitation: {
        status: usable ? 'pending' : 'expired',
        contactType: b.contactType,
        ...(usable ? { gymName: gymOf(p.gymId)?.name ?? null, planName: p.snapshot.name, until: p.expiresAt, buyerName: buyer?.displayName ?? null } : {}),
      },
    };
  }

  /**
   * Attach this signed-in member to every pass waiting on a contact they have VERIFIED. With a link token the call
   * is also an answer to "is this link for me": it must match one of their verified contacts, else 403
   * contact_mismatch; the token alone attaches nothing. Idempotent.
   */
  async function claimForUser(userId, { token = null } = {}) {
    if (!(await memberOk(userId))) return { error: 'not_allowed', status: 403 };
    const mine = await verifiedContactsOf(userId);
    let wanted = null;
    if (token != null) {
      if (!isTokenShape(token)) return { error: 'invalid_invitation', status: 404 };
      wanted = await store.findByToken(sha256(token));
      if (!wanted) return { error: 'invalid_invitation', status: 404 };
      if (+new Date(wanted.inviteExpiresAt) <= +now()) return { error: 'invitation_expired', status: 410 };
      if (!mine.some(c => c.type === wanted.contactType && c.value === wanted.contactValue)) {
        return { error: 'contact_mismatch', status: 403, contactType: wanted.contactType };
      }
    }
    const claimed = [];
    for (const b of await store.pendingForContacts(mine, now())) {
      const out = await store.claim({ beneficiaryId: b.id, userId, at: now() });
      if (out.outcome === 'claimed') {
        claimed.push(out.beneficiary.id);
        await audit(userId, 'gym_pass_beneficiary_claimed', out.beneficiary.id, { status: 'pending_registration' }, { status: 'active', purchaseId: out.purchase.id });
      }
    }
    return { claimed };
  }

  // ── the member's own view ──────────────────────────────────────────────────

  async function myPasses(userId) {
    await store.expireDue({ purchaserId: userId, at: now() });
    // Passes waiting on this member's verified contacts become theirs the moment they look.
    try { await claimForUser(userId); } catch (err) { console.warn('[gym-pass] claim skipped:', err?.message); }
    const bought = await store.purchasesForPurchaser(userId);
    const people = await store.beneficiariesOfMany(bought.map(p => p.id));
    const names = await namesOf(people.map(b => b.userId));
    const mine = await store.membershipsOfUser(userId);
    return {
      purchased: bought.map(p => {
        const rows = people.filter(b => b.purchaseId === p.id);
        return purchaseCore(p, {
          gym: gymSummary(p.gymId),
          payment: { status: p.paymentStatus ?? null, amountTzs: p.paymentAmountTzs ?? null },
          beneficiaries: rows.map(b => buyerBeneficiary(b, p, names, userId)),
          slots: slotsOf(rows, p),
        });
      }),
      memberships: mine.filter(m => !m.isPurchaser).map(m => ({
        purchaseId: m.purchaseId, beneficiaryId: m.id, status: m.status, gym: gymSummary(m.gymId), plan: snapshotView(m.snapshot),
        purchaseStatus: effectivePurchaseStatus({ status: m.purchaseStatus, expiresAt: m.expiresAt }, now()),
        startsAt: m.startsAt ?? null, expiresAt: m.expiresAt ?? null, subscriptionId: m.subscriptionId ?? null,
      })),
    };
  }
  const gymSummary = (id) => { const g = gymOf(id); return g ? { id: g.id, name: g.name } : null; };

  // ── people on a purchase (buyer or gym owner) ──────────────────────────────

  /** Who is asking: the buyer, or an owner of the gym the pass is for. */
  function roleOn(purchase, { userId = null, owner = null }) {
    if (owner && owns(owner, purchase.gymId)) return 'owner';
    if (userId && purchase.purchaserId === userId) return 'purchaser';
    return null;
  }
  async function purchaseFor(purchaseId, actor) {
    const purchase = purchaseId ? await store.getPurchase(String(purchaseId)) : null;
    // Not found and not yours look the same: ids cannot be probed.
    if (!purchase || !roleOn(purchase, actor)) return { error: 'not_found', status: 404 };
    return { purchase, role: roleOn(purchase, actor) };
  }
  async function personView(role, purchase, b, viewerId) {
    const names = await namesOf([b.userId]);
    return role === 'owner' ? ownerBeneficiary(b, purchase, names) : buyerBeneficiary(b, purchase, names, viewerId);
  }

  async function addBeneficiary({ purchaseId, actor, body }) {
    const p = await purchaseFor(purchaseId, actor);
    if (p.error) return p;
    const contact = parseContact({ email: body?.email, phone: body?.phone });
    if (!contact) return { error: 'invalid_contact', status: 400 };
    const buyerContacts = (await contacts.contactsFor(p.purchase.purchaserId)).map(c => `${c.type}:${c.value}`);
    if (buyerContacts.includes(`${contact.type}:${contact.value}`)) return { error: 'cannot_add_yourself', status: 400 };
    const member = await contacts.findMember(contact);
    if (member?.id === p.purchase.purchaserId) return { error: 'cannot_add_yourself', status: 400 };
    const out = await store.addBeneficiary({ purchaseId: p.purchase.id, userId: member?.id ?? null, contact, at: now() });
    if (out.error) return out;
    await audit(actor.userId ?? actor.owner?.id, 'gym_pass_beneficiary_added', out.beneficiary.id, null, { purchaseId: p.purchase.id, slot: out.beneficiary.slot, role: p.role });
    await announce(out.purchase, [out.beneficiary]);
    const fresh = await store.getBeneficiary(out.beneficiary.id);
    return { status: 201, beneficiary: await personView(p.role, out.purchase, fresh, actor.userId) };
  }

  async function changePerson({ purchaseId, beneficiaryId, actor, to }) {
    const p = await purchaseFor(purchaseId, actor);
    if (p.error) return p;
    const b = await store.getBeneficiary(String(beneficiaryId));
    if (!b || b.purchaseId !== p.purchase.id) return { error: 'not_found', status: 404 };
    const actorId = actor.userId ?? actor.owner?.id ?? null;
    const out = await store.changeStatus({
      beneficiaryId: b.id, to, role: p.role, actorId, removalCap: purchaserRemovalCap(p.purchase.snapshot), at: now(),
    });
    if (out.error) return out;
    const action = { suspended: 'gym_pass_beneficiary_suspended', active: 'gym_pass_beneficiary_resumed', removed: 'gym_pass_beneficiary_removed' }[to];
    await audit(actorId, action, b.id, { status: out.before.status }, { status: out.beneficiary.status, role: p.role, purchaseId: p.purchase.id });
    return { beneficiary: await personView(p.role, out.purchase, out.beneficiary, actor.userId) };
  }
  const suspendBeneficiary = (a) => changePerson({ ...a, to: 'suspended' });
  const resumeBeneficiary = (a) => changePerson({ ...a, to: 'active' });
  const removeBeneficiary = (a) => changePerson({ ...a, to: 'removed' });

  /** A person covered by a pass leaves it themself (never the buyer, who paid). */
  async function leave({ userId, purchaseId }) {
    const rows = await store.beneficiariesOf(String(purchaseId));
    const mine = rows.find(r => r.userId === userId && r.status !== 'removed');
    if (!mine) return { error: 'not_found', status: 404 };
    if (mine.isPurchaser) return { error: 'cannot_remove_purchaser', status: 409 };
    const out = await store.changeStatus({ beneficiaryId: mine.id, to: 'removed', role: 'self', actorId: userId, at: now() });
    if (out.error) return out;
    await audit(userId, 'gym_pass_beneficiary_left', mine.id, { status: mine.status }, { status: 'removed', purchaseId: String(purchaseId) });
    return { ok: true };
  }

  /** A fresh invite link for a person still waiting (the plain token is never stored). Returns the link to share. */
  async function resendInvite({ purchaseId, beneficiaryId, actor }) {
    const p = await purchaseFor(purchaseId, actor);
    if (p.error) return p;
    const b = await store.getBeneficiary(String(beneficiaryId));
    if (!b || b.purchaseId !== p.purchase.id || b.status !== 'pending_registration') return { error: 'not_found', status: 404 };
    if (effectivePurchaseStatus(p.purchase, now()) !== 'active') return { error: 'pass_not_active', status: 409 };
    if (b.inviteSentAt && +now() - +new Date(b.inviteSentAt) < RESEND_WAIT_MS) return { error: 'too_soon', status: 429 };
    const invite = await issueInvite(b, p.purchase);
    const gym = gymOf(p.purchase.gymId);
    const buyer = await users.findByIdAsync(p.purchase.purchaserId);
    const params = { buyerName: buyer?.displayName || 'A FitFlex member', planName: p.purchase.snapshot.name, gymName: gym?.name ?? '', link: invite.link };
    const locale = await localeFor(null, p.purchase.purchaserId);
    const via = b.contactType === 'phone' ? await deliver({ phone: b.contactValue, kind: 'invite', params, locale, reference: `${b.id}:r` }) : [];
    if (via.length) await store.recordSent(b.id, via, now());
    return { share: { link: invite.link, text: gymPassMessage('invite', params, locale) }, delivery: via };
  }

  // ── owner reports ──────────────────────────────────────────────────────────

  const countsOf = (rows) => ({
    total: rows.filter(r => r.status !== 'removed').length,
    active: rows.filter(r => r.status === 'active').length,
    pending: rows.filter(r => r.status === 'pending_registration').length,
    suspended: rows.filter(r => r.status === 'suspended').length,
  });

  async function saleView(p, rows, names, attendance) {
    return purchaseCore(p, {
      purchaser: { id: p.purchaserId, displayName: names.get(p.purchaserId) ?? null },
      payment: { status: p.paymentStatus ?? null, amountTzs: p.paymentAmountTzs ?? null, reference: p.paymentReference ?? null },
      beneficiaryCounts: countsOf(rows),
      slots: slotsOf(rows, p),
      ...(attendance ? { beneficiaries: rows.map(b => ownerBeneficiary(b, p, names, attendance)) } : {}),
    });
  }

  const parseLimit = (v) => Math.min(Math.max(parseInt(v, 10) || 50, 1), GYM_PASS_LIST_MAX);
  const asDate = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(+d) ? d : null; };

  /** Sales: one row per purchase (a group purchase is ONE sale with its people). ?status ?planId ?from ?to ?before ?limit */
  async function sales({ owner, gymId, query = {} }) {
    const g = await ownGym(owner, gymId);
    if (g.error) return g;
    await store.expireDue({ gymId, at: now() });
    const status = ['pending_payment', 'active', 'expired', 'cancelled'].includes(query.status) ? query.status : null;
    const list = await store.purchasesForGym(gymId, {
      status, planId: query.planId || null, from: asDate(query.from), to: asDate(query.to), before: asDate(query.before), limit: parseLimit(query.limit),
    });
    const people = await store.beneficiariesOfMany(list.map(p => p.id));
    const names = await namesOf(list.map(p => p.purchaserId));
    return { sales: await Promise.all(list.map(p => saleView(p, people.filter(b => b.purchaseId === p.id), names))) };
  }

  /** Memberships: purchases that are running (state=active, default) or have ended (state=expired), with their people. */
  async function memberships({ owner, gymId, query = {} }) {
    const g = await ownGym(owner, gymId);
    if (g.error) return g;
    await store.expireDue({ gymId, at: now() });
    const state = query.state === 'expired' ? 'expired' : 'active';
    const list = await store.purchasesForGym(gymId, { status: state, planId: query.planId || null, limit: parseLimit(query.limit), before: asDate(query.before) });
    const people = await store.beneficiariesOfMany(list.map(p => p.id));
    const names = await namesOf([...list.map(p => p.purchaserId), ...people.map(b => b.userId)]);
    const attendance = await store.attendanceCounts(list.map(p => p.id));
    return { state, memberships: await Promise.all(list.map(p => saleView(p, people.filter(b => b.purchaseId === p.id), names, attendance))) };
  }

  async function ownerPurchase(owner, gymId, purchaseId) {
    const g = await ownGym(owner, gymId);
    if (g.error) return g;
    await store.expireDue({ gymId, at: now() });
    const row = purchaseId ? await store.purchaseWithPayment(String(purchaseId)) : null;
    if (!row || row.gymId !== gymId) return { error: 'not_found', status: 404 };
    return { purchase: row };
  }

  async function purchaseDetail({ owner, gymId, purchaseId }) {
    const o = await ownerPurchase(owner, gymId, purchaseId);
    if (o.error) return o;
    const rows = await store.beneficiariesOf(o.purchase.id);
    const names = await namesOf([o.purchase.purchaserId, ...rows.map(b => b.userId)]);
    const attendance = await store.attendanceCounts([o.purchase.id]);
    return { sale: await saleView(o.purchase, rows, names, attendance) };
  }

  async function attendance({ owner, gymId, purchaseId, beneficiaryId, query = {} }) {
    const o = await ownerPurchase(owner, gymId, purchaseId);
    if (o.error) return o;
    const b = await store.getBeneficiary(String(beneficiaryId));
    if (!b || b.purchaseId !== o.purchase.id) return { error: 'not_found', status: 404 };
    const visits = await store.attendanceOf({ beneficiaryId: b.id, limit: parseLimit(query.limit) });
    return { beneficiaryId: b.id, visits };
  }

  /** Counts by category and duration, revenue (approved payments, once per purchase), people, expired. */
  async function summary({ owner, gymId }) {
    const g = await ownGym(owner, gymId);
    if (g.error) return g;
    await store.expireDue({ gymId, at: now() });
    const plans = await store.listPlans(gymId);
    const { purchases, people } = await store.summaryRows(gymId);
    const peopleBy = new Map();
    for (const r of people) peopleBy.set(r.purchaseId, [...(peopleBy.get(r.purchaseId) ?? []), r]);
    const byCategory = Object.fromEntries(PASS_CATEGORIES.map(c => [c, { sales: 0, revenueTzs: 0, beneficiaries: 0 }]));
    const byDuration = new Map();
    const out = {
      gymId, currency: CURRENCY,
      plans: { total: plans.length, active: plans.filter(p => p.status === 'active').length },
      sales: { count: 0, revenueTzs: 0, pendingPayment: 0 },
      beneficiaries: { active: 0, pendingRegistration: 0, suspended: 0 },
      memberships: { active: 0, expired: 0 },
    };
    for (const p of purchases) {
      if (p.status === 'pending_payment') { out.sales.pendingPayment += 1; continue; }
      // A sale is a purchase whose payment is approved; a reversed one (payment rejected later) is not.
      if (p.paymentStatus !== 'approved' || !['active', 'expired'].includes(p.status)) continue;
      const s = p.snapshot;
      const rows = peopleBy.get(p.id) ?? [];
      const covered = rows.filter(r => r.status !== 'removed').reduce((n, r) => n + r.n, 0);
      out.sales.count += 1;
      out.sales.revenueTzs += p.amountTzs ?? 0;
      byCategory[s.category].sales += 1;
      byCategory[s.category].revenueTzs += p.amountTzs ?? 0;
      byCategory[s.category].beneficiaries += covered;
      const key = `${s.durationValue}:${s.durationUnit}`;
      const d = byDuration.get(key) ?? { durationValue: s.durationValue, durationUnit: s.durationUnit, sales: 0, revenueTzs: 0 };
      d.sales += 1; d.revenueTzs += p.amountTzs ?? 0;
      byDuration.set(key, d);
      if (p.status === 'active') {
        out.memberships.active += 1;
        for (const r of rows) {
          if (r.status === 'active') out.beneficiaries.active += r.n;
          if (r.status === 'pending_registration') out.beneficiaries.pendingRegistration += r.n;
          if (r.status === 'suspended') out.beneficiaries.suspended += r.n;
        }
      } else out.memberships.expired += 1;
    }
    return { ...out, byCategory, byDuration: [...byDuration.values()].sort((a, b) => b.sales - a.sales) };
  }

  return {
    // owner: plans
    listPlans, createPlan, updatePlan, setPlanStatus,
    // public + member
    publicPlans, purchase, cancelPurchase, myPasses, previewInvite, claimForUser, leave,
    // buyer or owner
    addBeneficiary, suspendBeneficiary, resumeBeneficiary, removeBeneficiary, resendInvite,
    // owner: reads
    sales, memberships, purchaseDetail, attendance, summary,
    // payment hook
    onPaymentStatus,
  };
}
