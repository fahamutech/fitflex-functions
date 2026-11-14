// Custom gym passes & flexible membership (GYM_CUSTOM_PASSES) — REST surface. Contract: docs/custom-gym-passes-api.md.
// Every route is behind the flag, checked FIRST (before any token check): off → 404 { error: 'feature_disabled' }.
// Owner routes: the owner or gym staff with the scope (`gyms` for plans, `payments` for sales and revenue, `members`
// for people), and only for a gym they own: another gym's id answers 403 not_your_gym, its plan/purchase 404.
// New endpoints only; no existing route or response changes.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { requireGymAccess, effectiveOperator } from '../src/auth/org-authz.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { gymCustomPassesOn } from '../src/shared/feature-flags.mjs';
import { createVendorLimiter, limitOrNull } from '../src/shared/vendor-rate-limit.mjs';
import { gymPassService, resolveRequestUser } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

function requireGymCustomPasses(req, res, next) {
  if (!gymCustomPassesOn()) return res.status(404).json({ error: 'feature_disabled' });
  return next();
}
const publicGuard = (method) => routeGuard(method, requireGymCustomPasses);
const memberGuard = (method) => routeGuard(method, [requireGymCustomPasses, requireAuth('member')]);
const ownerGuard = (method, scope, label) => routeGuard(method, [requireGymCustomPasses, requireAuth('gym_operator', 'gym_staff'), requireGymAccess(scope, label)]);

const send = (res, result, okStatus = 200) => {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status || 400).json({ error, ...extra });
  }
  const { status, ...rest } = result;
  return res.status(status || okStatus).json(rest);
};
const ownerOf = async (req) => effectiveOperator(req, await resolveRequestUser(req));
const memberActor = (req) => ({ userId: req.user.sub });
const ownerActor = async (req) => ({ owner: await ownerOf(req) });

// The invite preview is public (the link is a random 256-bit token): per-address limit on top.
const previewLimiter = createVendorLimiter({ perMinute: 30 });
export const resetGymPassLimits = () => previewLimiter.reset();

const FLAG = 'Needs GYM_CUSTOM_PASSES (off → 404 feature_disabled, checked before sign-in).';
const PLAN_SHAPE = '{ id, gymId, name, description|null, category: individual|couples|group, durationValue, durationUnit: days|weeks|months, beneficiaryLimit (individual 1, couples 2, group 3..50), priceTzs, currency: "TZS", startPolicy: "immediate", terms|null, termsVersion }';
const PERSON_NOTE = 'Buyer view: masked name and contact, no user id (your own row excepted). Owner view: the person\'s name and user id, masked contact.';

// ── public ──────────────────────────────────────────────────────────────────

export const gymPassPublicPlans = {
  created, method: 'get', path: '/gyms/:id/pass-plans',
  description: `Public: a live gym's ACTIVE custom passes → { gymId, plans:[${PLAN_SHAPE}] }. 404 gym_not_found (unknown or not live). ${FLAG}`,
  onGuard: publicGuard('get'),
  onRequest: async (req, res) => send(res, await gymPassService.publicPlans(req.params.id)),
};

export const gymPassInvitePreview = {
  created, method: 'post', path: '/gym-pass-invitations/preview',
  description: `Public: what an invitation link is for, before sign-in. Body { token } (the part after # in the link). → { invitation: { status: pending|expired, contactType, gymName?, planName?, until?, buyerName? } } — never the contact itself. 404 invalid_invitation; 429 rate_limited. ${FLAG}`,
  onGuard: publicGuard('post'),
  onRequest: async (req, res) => {
    if (limitOrNull(previewLimiter, String(req.ip || req.headers?.['x-forwarded-for'] || 'unknown'), res)) return undefined;
    const token = req.body?.token;
    if (typeof token !== 'string' || !token.trim()) return res.status(400).json({ error: 'token_required' });
    return send(res, await gymPassService.previewInvite(token.trim()));
  },
};

// ── member: buy and manage ──────────────────────────────────────────────────

export const gymPassPurchase = {
  created, method: 'post', path: '/me/gym-pass-purchases',
  description: `Member: buy a custom pass. Body { planId, beneficiaries?: [{ phone } | { email }], reference?, payerPhone?, termsVersion? }. The price is the plan's, never the client's. ONE payment request for the full price; nothing is active until staff approve it. Headcount: individual — no beneficiaries; couples — exactly 1; group — 2 up to limit-1 (3..limit people with you). You are always the first person covered. Contacts are typed, never ids; the same person (or you) twice is refused. While manual payment is on, reference + payerPhone are required as for POST /me/subscribe. If the plan has terms, termsVersion must be the version shown. → 202 { purchase { id, status: pending_payment, gymId, plan (snapshot), priceTzs, currency, beneficiaries (statuses read awaiting_payment), slots { used, limit } }, paymentRequest }. 400 invalid_contact { index } | cannot_add_yourself | duplicate_beneficiary | beneficiaries_not_allowed | couples_needs_two_people | group_needs_minimum | beneficiary_limit_exceeded | terms_not_accepted; 404 plan_not_found | gym_not_found; 409 plan_not_available | gym_not_available | payment_already_pending | terms_changed | payment_reference_duplicate; 403 not_allowed; 429 too_many_attempts. ${FLAG}`,
  requestSample: { planId: 'gpp_abc123abc123', beneficiaries: [{ phone: '0712345678' }], reference: 'QGH7XK2L9P', payerPhone: '0712345678' },
  onGuard: memberGuard('post'),
  onRequest: async (req, res) => {
    const { planId, beneficiaries, reference, payerPhone, termsVersion } = req.body || {};
    send(res, await gymPassService.purchase({ memberId: req.user.sub, planId, beneficiaries: beneficiaries ?? [], reference, payerPhone, termsVersion }));
  },
};

export const gymPassCancelPurchase = {
  created, method: 'post', path: '/me/gym-pass-purchases/:purchaseId/cancel',
  description: `Member: withdraw a pass that is still waiting for payment (the payment request is cancelled with it). → { purchase }. 404 not_found; 409 not_cancellable | payment_in_progress. ${FLAG}`,
  onGuard: memberGuard('post'),
  onRequest: async (req, res) => send(res, await gymPassService.cancelPurchase({ memberId: req.user.sub, purchaseId: req.params.purchaseId })),
};

export const gymPassMine = {
  created, method: 'get', path: '/me/gym-passes',
  description: `Member: the passes I bought (with the people they cover and free slots) and the passes I am covered by. Opening it also attaches me to passes waiting on a contact I have VERIFIED (the app should call it after sign-in). → { purchased:[{ id, status, gym, plan, payment, startsAt, expiresAt, beneficiaries:[…], slots }], memberships:[{ purchaseId, beneficiaryId, status: active|suspended|pending_registration, purchaseStatus, gym, plan, startsAt, expiresAt, subscriptionId }] }. ${PERSON_NOTE} ${FLAG}`,
  onGuard: memberGuard('get'),
  onRequest: async (req, res) => send(res, await gymPassService.myPasses(req.user.sub)),
};

export const gymPassClaim = {
  created, method: 'post', path: '/me/gym-passes/claim',
  description: `Member: attach me to passes waiting for a contact I have VERIFIED. Body { token? } (the invite link's token): with a token the call also checks the link is for one of my verified contacts — 403 contact_mismatch, 404 invalid_invitation, 410 invitation_expired. The token alone grants nothing. → { claimed: [beneficiaryId] }. Idempotent. ${FLAG}`,
  onGuard: memberGuard('post'),
  onRequest: async (req, res) => send(res, await gymPassService.claimForUser(req.user.sub, { token: req.body?.token ?? null })),
};

export const gymPassLeave = {
  created, method: 'post', path: '/me/gym-passes/:purchaseId/leave',
  description: `Member: leave a pass I was added to (the buyer cannot: 409 cannot_remove_purchaser). The slot is freed; nothing is refunded. → { ok: true }. 404 not_found. ${FLAG}`,
  onGuard: memberGuard('post'),
  onRequest: async (req, res) => send(res, await gymPassService.leave({ userId: req.user.sub, purchaseId: req.params.purchaseId })),
};

// ── buyer: people on a purchase ─────────────────────────────────────────────

const BENEFICIARY_ERRORS = '400 invalid_contact | cannot_add_yourself; 404 not_found; 409 pass_not_active | beneficiary_limit_exceeded { limit } | already_beneficiary | invalid_transition | cannot_remove_purchaser | cannot_modify_purchaser | replacement_limit_reached { limit }';

export const gymPassBuyerAddPerson = {
  created, method: 'post', path: '/me/gym-pass-purchases/:purchaseId/beneficiaries',
  description: `Buyer: add a person to an ACTIVE pass (free slot needed: the sale's limit is never exceeded, even by concurrent adds). Body { phone } | { email }. No approval is asked: a person with an account gets their own subscription at once and is notified (in-app, push, WhatsApp/SMS); anyone else is kept as pending_registration and gets an invite link, attached when they sign up and verify that contact. → 201 { beneficiary }. ${PERSON_NOTE} ${BENEFICIARY_ERRORS}. ${FLAG}`,
  requestSample: { phone: '0712345678' },
  onGuard: memberGuard('post'),
  onRequest: async (req, res) => send(res, await gymPassService.addBeneficiary({ purchaseId: req.params.purchaseId, actor: memberActor(req), body: req.body || {} }), 201),
};
const buyerChange = (action, fn, text) => ({
  created, method: 'post', path: `/me/gym-pass-purchases/:purchaseId/beneficiaries/:beneficiaryId/${action}`,
  description: `Buyer: ${text} → { beneficiary }. ${BENEFICIARY_ERRORS}. ${FLAG}`,
  onGuard: memberGuard('post'),
  onRequest: async (req, res) => send(res, await gymPassService[fn]({ purchaseId: req.params.purchaseId, beneficiaryId: req.params.beneficiaryId, actor: memberActor(req) })),
});
export const gymPassBuyerSuspend = buyerChange('suspend', 'suspendBeneficiary', 'stop one person\'s entry for now (their subscription is suspended; the slot stays theirs).');
export const gymPassBuyerResume = buyerChange('resume', 'resumeBeneficiary', 'let a suspended person in again.');
export const gymPassBuyerRemove = buyerChange('remove', 'removeBeneficiary', 'take a person off the pass. Never refunds or cancels the pass; frees the slot so someone else can be added (a replacement). The buyer cannot be removed; a buyer may remove at most beneficiaryLimit people per purchase (409 replacement_limit_reached), the gym owner without limit.');
export const gymPassBuyerResendInvite = {
  created, method: 'post', path: '/me/gym-pass-purchases/:purchaseId/beneficiaries/:beneficiaryId/invite',
  description: `Buyer: a fresh invite link for a person still waiting for an account (sent to their number by WhatsApp/SMS where possible). → { share { link, text }, delivery:[in whatsapp|sms] }. 429 too_soon (once an hour). ${BENEFICIARY_ERRORS}. ${FLAG}`,
  onGuard: memberGuard('post'),
  onRequest: async (req, res) => send(res, await gymPassService.resendInvite({ purchaseId: req.params.purchaseId, beneficiaryId: req.params.beneficiaryId, actor: memberActor(req) })),
};

// ── owner: plans ────────────────────────────────────────────────────────────

export const ownerGymPassPlans = {
  created, method: 'get', path: '/owner/gyms/:gymId/pass-plans',
  description: `Owner (scope gyms): all of my gym's custom passes, active and inactive → { plans:[${PLAN_SHAPE} + status, createdBy, createdAt, updatedAt] }. 403 not_your_gym. ${FLAG}`,
  onGuard: ownerGuard('get', 'gyms', 'GET /owner/gyms/:gymId/pass-plans'),
  onRequest: async (req, res) => send(res, await gymPassService.listPlans({ owner: await ownerOf(req), gymId: req.params.gymId })),
};

export const ownerGymPassPlanCreate = {
  created, method: 'post', path: '/owner/gyms/:gymId/pass-plans',
  description: `Owner (scope gyms): design a pass. Body { name (2–80), description?, category: individual|couples|group, durationValue (≥1; max 730 days / 104 weeks / 24 months), durationUnit: days|weeks|months, beneficiaryLimit (individual 1, couples 2, group 3..50), priceTzs (whole TZS, 1..100,000,000), terms? (≤ 4000), status?: active (default)|inactive }. Months are calendar months. Audited. → 201 { plan }. 400 invalid_field { field, reason? }; 403 not_your_gym. ${FLAG}`,
  requestSample: { name: 'Couples 3 months', category: 'couples', durationValue: 3, durationUnit: 'months', priceTzs: 240000 },
  onGuard: ownerGuard('post', 'gyms', 'POST /owner/gyms/:gymId/pass-plans'),
  onRequest: async (req, res) => send(res, await gymPassService.createPlan({ owner: await ownerOf(req), gymId: req.params.gymId, body: req.body || {}, actorId: req.user.sub }), 201),
};

export const ownerGymPassPlanUpdate = {
  created, method: 'put', path: '/owner/gyms/:gymId/pass-plans/:planId',
  description: `Owner (scope gyms): edit a pass (partial; same fields and checks as create). Passes already bought keep what the buyer saw and paid (snapshot); a changed terms text raises termsVersion. Audited. → { plan }. 400 invalid_field; 403 not_your_gym; 404 plan_not_found (also another gym's plan). ${FLAG}`,
  onGuard: ownerGuard('put', 'gyms', 'PUT /owner/gyms/:gymId/pass-plans/:planId'),
  onRequest: async (req, res) => send(res, await gymPassService.updatePlan({ owner: await ownerOf(req), gymId: req.params.gymId, planId: req.params.planId, body: req.body || {}, actorId: req.user.sub })),
};

export const ownerGymPassPlanActivate = {
  created, method: 'post', path: '/owner/gyms/:gymId/pass-plans/:planId/activate',
  description: `Owner (scope gyms): put a pass on sale → { plan }. Audited. ${FLAG}`,
  onGuard: ownerGuard('post', 'gyms', 'POST /owner/gyms/:gymId/pass-plans/:planId/activate'),
  onRequest: async (req, res) => send(res, await gymPassService.setPlanStatus({ owner: await ownerOf(req), gymId: req.params.gymId, planId: req.params.planId, status: 'active', actorId: req.user.sub })),
};

export const ownerGymPassPlanDeactivate = {
  created, method: 'post', path: '/owner/gyms/:gymId/pass-plans/:planId/deactivate',
  description: `Owner (scope gyms): take a pass off sale (no new purchases; passes already bought keep running) → { plan }. Audited. ${FLAG}`,
  onGuard: ownerGuard('post', 'gyms', 'POST /owner/gyms/:gymId/pass-plans/:planId/deactivate'),
  onRequest: async (req, res) => send(res, await gymPassService.setPlanStatus({ owner: await ownerOf(req), gymId: req.params.gymId, planId: req.params.planId, status: 'inactive', actorId: req.user.sub })),
};

// ── owner: sales, memberships, people, attendance, aggregates ───────────────

export const ownerGymPassSales = {
  created, method: 'get', path: '/owner/gyms/:gymId/pass-sales',
  description: `Owner (scope payments): sales of custom passes, newest first. ONE row per purchase (a group purchase is one sale with N people). Query: status (pending_payment|active|expired|cancelled), planId, from, to, before (ISO), limit (≤ 200). → { sales:[{ id, status, plan (snapshot), priceTzs, currency, purchaser { id, displayName }, payment { status, amountTzs, reference }, startsAt, expiresAt, beneficiaryCounts { total, active, pending, suspended }, slots { used, limit } }] }. ${FLAG}`,
  onGuard: ownerGuard('get', 'payments', 'GET /owner/gyms/:gymId/pass-sales'),
  onRequest: async (req, res) => send(res, await gymPassService.sales({ owner: await ownerOf(req), gymId: req.params.gymId, query: req.query || {} })),
};

export const ownerGymPassMemberships = {
  created, method: 'get', path: '/owner/gyms/:gymId/pass-memberships',
  description: `Owner (scope members): running (state=active, default) or ended (state=expired) pass purchases with their people and each person's visits. Query: state, planId, before, limit. → { state, memberships:[sale + beneficiaries:[{ id, slot, isPurchaser, status, userId, displayName, contact (masked), subscriptionId, notifiedAt, notifiedVia, claimedAt, attendance { visits, lastVisitAt } }]] }. ${FLAG}`,
  onGuard: ownerGuard('get', 'members', 'GET /owner/gyms/:gymId/pass-memberships'),
  onRequest: async (req, res) => send(res, await gymPassService.memberships({ owner: await ownerOf(req), gymId: req.params.gymId, query: req.query || {} })),
};

export const ownerGymPassPurchase = {
  created, method: 'get', path: '/owner/gyms/:gymId/pass-purchases/:purchaseId',
  description: `Owner (scope members): one sale with all its people (removed ones included, with who removed them) and their visit counts → { sale }. 404 not_found. ${FLAG}`,
  onGuard: ownerGuard('get', 'members', 'GET /owner/gyms/:gymId/pass-purchases/:purchaseId'),
  onRequest: async (req, res) => send(res, await gymPassService.purchaseDetail({ owner: await ownerOf(req), gymId: req.params.gymId, purchaseId: req.params.purchaseId })),
};

export const ownerGymPassAttendance = {
  created, method: 'get', path: '/owner/gyms/:gymId/pass-purchases/:purchaseId/beneficiaries/:beneficiaryId/attendance',
  description: `Owner (scope members): one person's check-ins on this pass, newest first (?limit ≤ 200) → { beneficiaryId, visits:[{ id, gymId, timestamp, method, status, businessDate }] }. 404 not_found. ${FLAG}`,
  onGuard: ownerGuard('get', 'members', 'GET /owner/gyms/:gymId/pass-purchases/:purchaseId/beneficiaries/:beneficiaryId/attendance'),
  onRequest: async (req, res) => send(res, await gymPassService.attendance({ owner: await ownerOf(req), gymId: req.params.gymId, purchaseId: req.params.purchaseId, beneficiaryId: req.params.beneficiaryId, query: req.query || {} })),
};

export const ownerGymPassSummary = {
  created, method: 'get', path: '/owner/gyms/:gymId/pass-summary',
  description: `Owner (scope payments): totals for my gym's custom passes → { gymId, currency, plans { total, active }, sales { count, revenueTzs, pendingPayment }, byCategory { individual|couples|group: { sales, revenueTzs, beneficiaries } }, byDuration:[{ durationValue, durationUnit, sales, revenueTzs }], beneficiaries { active, pendingRegistration, suspended } (running passes), memberships { active, expired } }. Revenue is the approved payment, counted ONCE per purchase however many people it covers. ${FLAG}`,
  onGuard: ownerGuard('get', 'payments', 'GET /owner/gyms/:gymId/pass-summary'),
  onRequest: async (req, res) => send(res, await gymPassService.summary({ owner: await ownerOf(req), gymId: req.params.gymId })),
};

const ownerChange = (action, fn, text) => ({
  created, method: 'post', path: `/owner/gyms/:gymId/pass-purchases/:purchaseId/beneficiaries/:beneficiaryId/${action}`,
  description: `Owner (scope members): ${text} → { beneficiary }. ${BENEFICIARY_ERRORS}. ${FLAG}`,
  onGuard: ownerGuard('post', 'members', `POST /owner/gyms/:gymId/pass-purchases/:purchaseId/beneficiaries/:beneficiaryId/${action}`),
  onRequest: async (req, res) => {
    const o = await ownerActor(req);
    // The purchase must belong to the gym in the path (and the gym to the owner).
    const detail = await gymPassService.purchaseDetail({ owner: o.owner, gymId: req.params.gymId, purchaseId: req.params.purchaseId });
    if (detail.error) return send(res, detail);
    return send(res, await gymPassService[fn]({ purchaseId: req.params.purchaseId, beneficiaryId: req.params.beneficiaryId, actor: { ...o, userId: null } }));
  },
});
export const ownerGymPassSuspend = ownerChange('suspend', 'suspendBeneficiary', 'stop one person\'s entry (their subscription is suspended; check-in is refused as subscription_inactive).');
export const ownerGymPassResume = ownerChange('resume', 'resumeBeneficiary', 'let a suspended person in again.');
export const ownerGymPassRemove = ownerChange('remove', 'removeBeneficiary', 'take a person off the pass (no refund, the pass keeps running; the slot is freed for a replacement).');
export const ownerGymPassAddPerson = {
  created, method: 'post', path: '/owner/gyms/:gymId/pass-purchases/:purchaseId/beneficiaries',
  description: `Owner (scope members): add a person to an ACTIVE pass of my gym (free slot needed). Body { phone } | { email }. Same behaviour as the buyer's add (attached at once and notified, or invited). → 201 { beneficiary }. ${BENEFICIARY_ERRORS}. ${FLAG}`,
  onGuard: ownerGuard('post', 'members', 'POST /owner/gyms/:gymId/pass-purchases/:purchaseId/beneficiaries'),
  onRequest: async (req, res) => {
    const o = await ownerActor(req);
    const detail = await gymPassService.purchaseDetail({ owner: o.owner, gymId: req.params.gymId, purchaseId: req.params.purchaseId });
    if (detail.error) return send(res, detail);
    return send(res, await gymPassService.addBeneficiary({ purchaseId: req.params.purchaseId, actor: { ...o, userId: null }, body: req.body || {} }), 201);
  },
};
