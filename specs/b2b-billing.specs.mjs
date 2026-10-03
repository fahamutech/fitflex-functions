// B2B sponsor billing against the CI database: flat-fee sponsored passes
// (nominate, invoice in advance, pay, unlock), per-use invoices with credits,
// VAT, voiding, organisation views and the Corporate seat conversion.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { withLedgerDelete } from './fixtures/ledger-cleanup.mjs';
import { sign } from '../src/auth/jwt.mjs';
import {
  gyms, b2bService, b2bProgramService, b2bConsumptionService as usage, b2bBillingService as billing,
  checkInService, adminPaymentService, corporateService, settingsService,
} from '../src/bootstrap/services.mjs';
import { monthBounds, eatDayStart, vatContainedTzs, discountedFeeTzs } from '../src/shared/b2b-programs.mjs';
import { localDay } from '../src/shared/member-progress.mjs';
import {
  adminPrepareB2BInvoice, adminListB2BInvoices, adminIssueB2BInvoice, adminMarkB2BInvoicePaid, adminVoidB2BInvoice,
  adminListB2BEntitlements, adminConvertCorporateToProgram, listB2BOrganizationInvoices, getB2BOrganizationInvoice, unlockMyB2BPass,
} from '../functions/b2b.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], gyms: [], corporates: [] };
const ADMIN = { userType: 'admin' };
const PERIOD = localDay(new Date()).slice(0, 7);
const { startDate: MONTH_START, nextStartDate } = monthBounds(PERIOD);
const PERIOD_END = eatDayStart(nextStartDate).toISOString();
const PRO = settingsService.priceForTier('pro');
// A month that has ended, for per-use invoices.
const LAST = (() => { const [y, m] = PERIOD.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();

async function user(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Billing ${userType} ${id.slice(-4)}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
ADMIN.userId = await user('admin');
// Invoices are issued by one person and settled by another.
const FINANCE = { userType: 'admin', userId: await user('admin') };
const access = (organizationId, who = ADMIN) => b2bService.resolveAccess({ organizationId, ...who });

async function gym() {
  const id = uid('gym');
  await gyms.insertAsync({ id, name: `Billing Gym ${id.slice(-4)}`, tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000 });
  made.gyms.push(id);
  return gyms.find(g => g.id === id);
}

async function sponsor(organizationType = 'insurer') {
  const { organization } = await b2bService.createOrganization({ body: { organizationType, legalName: `Billing ${organizationType} ${uid('o')}` }, actorId: ADMIN.userId });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: ADMIN.userId });
  return organization.id;
}
async function enrol(orgId, extra = {}) {
  const userId = await user('member');
  const r = await b2bService.enrollBeneficiary({ access: await access(orgId), body: { userId, status: 'active', ...extra }, actorId: ADMIN.userId });
  return { userId, beneficiary: r.beneficiary };
}

const PASS = { name: 'Pro pass', benefitType: 'sponsored_pass', passTier: 'pro', fundingType: 'full' };

async function programme(orgId, benefitBody = PASS, programBody = {}) {
  const a = await access(orgId);
  const { program } = await b2bProgramService.createProgram({ access: a, body: { name: 'Billing programme', startDate: '2026-01-01', ...programBody }, actorId: ADMIN.userId });
  const created = await b2bProgramService.createBenefit({ access: a, programId: program.id, body: benefitBody, actorId: ADMIN.userId });
  assert.ok(created.benefit, JSON.stringify(created));
  await b2bProgramService.setBenefitStatus({ access: a, programId: program.id, benefitId: created.benefit.id, status: 'active', actorId: ADMIN.userId });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'pending', actorId: ADMIN.userId });
  const live = await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'active', actorId: ADMIN.userId });
  assert.equal(live.program?.status, 'active', JSON.stringify(live));
  return { programId: program.id, benefitId: created.benefit.id };
}

/** Prepare, issue and pay this month's prepaid invoice. */
async function paidPrepaid(programId, vatRateBps = 1800) {
  const prepared = await billing.preparePrepaid({ programId, period: PERIOD, actorId: ADMIN.userId });
  assert.ok(prepared.invoice, JSON.stringify(prepared));
  await billing.issueInvoice({ invoiceId: prepared.invoice.id, vatRateBps, actorId: ADMIN.userId });
  return billing.markPaid({ invoiceId: prepared.invoice.id, paymentReference: 'BANK-TRF-1', actorId: FINANCE.userId });
}
const entitlements = where => db('B2BPassEntitlement').where(where).orderBy('createdAt');
const payments = subscriptionId => db('PaymentRequest').where({ subscriptionId }).orderBy('requestedAt');

function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(route, { claims, params = {}, body = {}, query = {} }) {
  const req = { headers: claims ? { authorization: `Bearer ${sign(claims)}` } : {}, params, body, query };
  const out = res();
  for (const guard of [route.onGuard].flat().filter(Boolean)) {
    let passed = false;
    await guard(req, out, () => { passed = true; });
    if (!passed) return out;
  }
  await route.onRequest(req, out);
  return out;
}

after(async () => {
  const orgIds = [...made.orgs, ...(made.corporates.length ? await db('B2BOrganization').whereIn('legacyCorporateId', made.corporates).pluck('id') : [])];
  if (orgIds.length) {
    const invoiceIds = await db('B2BSponsorInvoice').whereIn('organizationId', orgIds).pluck('id');
    await withLedgerDelete(db, async (trx) => {
      await trx('B2BSponsorInvoiceLine').whereIn('invoiceId', invoiceIds).del();
      await trx('B2BPassEntitlement').whereIn('organizationId', orgIds).del();
      await trx('B2BSponsorInvoice').whereIn('id', invoiceIds).del();
      await trx('B2BBenefitConsumption').whereIn('organizationId', orgIds).del();
    });
    await db('B2BOrganization').whereIn('id', orgIds).del();
  }
  if (made.corporates.length) {
    await db('CorporateEmployee').whereIn('corporateId', made.corporates).del();
    await db('CorporateAccount').whereIn('id', made.corporates).del();
  }
  await db('Checkin').whereIn('memberId', made.users).del();
  await db('PaymentRequest').whereIn('memberId', made.users).del();
  await db('Subscription').whereIn('memberId', made.users).del();
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('AuditLog').whereIn('actor', [...made.users, 'system:b2b-billing']).del();
  await db('User').whereIn('id', made.users).del();
});

// ── Flat fee, fully sponsored ────────────────────────────────────────────────

test('a fully sponsored pass: everyone nominated is invoiced in advance; paying starts each pass', async () => {
  const g = await gym();
  const orgId = await sponsor();
  const a = await enrol(orgId);
  const b = await enrol(orgId);
  const suspended = await enrol(orgId);
  await b2bService.setBeneficiaryStatus({ access: await access(orgId), beneficiaryId: suspended.beneficiary.id, status: 'suspended', actorId: ADMIN.userId });
  const { programId, benefitId } = await programme(orgId);

  // No pass yet: the member can't check in.
  assert.equal((await checkInService.perform({ memberId: a.userId, gymId: g.id })).failure, 'subscription_inactive');

  const prepared = await billing.preparePrepaid({ programId, period: PERIOD, actorId: ADMIN.userId });
  assert.deepEqual([prepared.added, prepared.invoice.status, prepared.invoice.kind, prepared.invoice.totalTzs], [2, 'draft', 'prepaid', 2 * PRO]);
  assert.deepEqual((await entitlements({ benefitId })).map(e => [e.status, e.feeTzs, e.sponsorTzs, e.memberTzs, e.passTier]), [['invoiced', PRO, PRO, 0, 'pro'], ['invoiced', PRO, PRO, 0, 'pro']]);
  // Running it again adds nobody; someone enrolled later joins the same draft.
  assert.equal((await billing.preparePrepaid({ programId, period: PERIOD, actorId: ADMIN.userId })).added, 0);
  const late = await enrol(orgId);
  const again = await billing.preparePrepaid({ programId, period: PERIOD, actorId: ADMIN.userId });
  assert.deepEqual([again.added, again.invoice.id, again.invoice.totalTzs], [1, prepared.invoice.id, 3 * PRO]);

  // Issuing needs a VAT rate and freezes the figures.
  assert.equal((await billing.issueInvoice({ invoiceId: prepared.invoice.id, actorId: ADMIN.userId })).error, 'vat_rate_required');
  assert.equal((await billing.markPaid({ invoiceId: prepared.invoice.id, paymentReference: 'X', actorId: ADMIN.userId })).error, 'invalid_transition');
  const issued = await billing.issueInvoice({ invoiceId: prepared.invoice.id, vatRateBps: 1800, actorId: ADMIN.userId });
  assert.deepEqual([issued.invoice.status, issued.invoice.vatRateBps, issued.invoice.vatTzs], ['issued', 1800, vatContainedTzs(3 * PRO, 1800)]);
  await assert.rejects(db('B2BSponsorInvoice').where({ id: prepared.invoice.id }).update({ totalTzs: 1 }), /cannot be changed/);
  // Someone enrolled after the invoice was issued goes on a new draft.
  await enrol(orgId);
  const supplementary = await billing.preparePrepaid({ programId, period: PERIOD, actorId: ADMIN.userId });
  assert.notEqual(supplementary.invoice.id, prepared.invoice.id);
  assert.equal(supplementary.invoice.totalTzs, PRO);

  assert.equal((await billing.markPaid({ invoiceId: prepared.invoice.id, paymentReference: ' ', actorId: ADMIN.userId })).error, 'payment_reference_required');
  // Maker-checker: the issuer can't settle it, whoever they are; the database refuses it too.
  assert.deepEqual(await billing.markPaid({ invoiceId: prepared.invoice.id, paymentReference: 'BANK-TRF-77', actorId: ADMIN.userId }), { error: 'cannot_settle_own_invoice', status: 403 });
  assert.equal((await billing.markPaid({ invoiceId: prepared.invoice.id, paymentReference: 'BANK-TRF-77' })).error, 'actor_required');
  await assert.rejects(db('B2BSponsorInvoice').where({ id: prepared.invoice.id }).update({ status: 'paid', paidAt: new Date(), paidBy: ADMIN.userId, paymentReference: 'BANK-TRF-77' }), err => err.code === '23514');
  assert.equal((await db('B2BSponsorInvoice').where({ id: prepared.invoice.id }).first()).status, 'issued');
  const paid = await billing.markPaid({ invoiceId: prepared.invoice.id, paymentReference: 'BANK-TRF-77', actorId: FINANCE.userId });
  assert.deepEqual([paid.invoice.status, paid.invoice.paymentReference, paid.activation.started], ['paid', 'BANK-TRF-77', 3]);
  assert.equal((await billing.markPaid({ invoiceId: prepared.invoice.id, paymentReference: 'again', actorId: FINANCE.userId })).unchanged, true);

  // Each covered member now holds an ordinary platform pass to the end of the month…
  const [e] = await entitlements({ benefitId, userId: a.userId });
  const sub = await db('Subscription').where({ id: e.subscriptionId }).first();
  assert.deepEqual([e.status, sub.type, sub.tier, sub.status, new Date(sub.expiresAt).toISOString()], ['active', 'platform_pass', 'pro', 'active', PERIOD_END]);
  // …with the sponsor's share recorded as an approved payment, which is what gym settlement caps against.
  assert.deepEqual((await payments(sub.id)).map(p => [p.status, p.amountTzs, p.provider, p.reference]), [['approved', PRO, 'sponsor_invoice', paid.invoice.number]]);
  // The supplementary draft is unpaid, so that member has no pass yet.
  assert.equal((await entitlements({ benefitId, status: 'invoiced' })).length, 1);

  // The pass works at the gym like any other, and the member sees it.
  const visit = await checkInService.perform({ memberId: a.userId, gymId: g.id });
  assert.deepEqual([visit.ok, visit.checkin.subscriptionType, visit.checkin.subscriptionId, visit.b2b], [true, 'platform_pass', sub.id, undefined]);
  const mine = await b2bProgramService.myBenefits({ userId: late.userId });
  assert.deepEqual(mine.benefits.map(x => [x.benefit.benefitType, x.pass.status, x.pass.canUnlock, x.pass.memberTzs]), [['sponsored_pass', 'active', false, 0]]);
  // A member who never visits was still invoiced (the sponsor pays for everyone it nominates).
  assert.equal((await db('B2BSponsorInvoiceLine').where({ invoiceId: prepared.invoice.id, kind: 'pass' })).length, 3);
  assert.equal((await billing.listEntitlements({ programId, period: PERIOD })).counts.active, 3);
});

test('a pass is started once, however often and however concurrently it is started', async () => {
  const orgId = await sponsor('employer');
  const m = await enrol(orgId);
  const { programId, benefitId } = await programme(orgId);
  const prepared = await billing.preparePrepaid({ programId, period: PERIOD, actorId: ADMIN.userId });
  await billing.issueInvoice({ invoiceId: prepared.invoice.id, vatRateBps: 0, actorId: ADMIN.userId });
  // The sponsor's payment is recorded while the daily run is going.
  const [paid] = await Promise.all([
    billing.markPaid({ invoiceId: prepared.invoice.id, paymentReference: 'BANK-RACE', actorId: FINANCE.userId }),
    db('B2BSponsorInvoice').where({ id: prepared.invoice.id }).then(() => billing.runDaily()),
    billing.runDaily(),
  ]);
  assert.equal(paid.invoice.status, 'paid');
  await billing.runDaily();
  const one = async () => {
    const [e] = await entitlements({ benefitId });
    const subs = await db('Subscription').where({ memberId: m.userId });
    const pays = await db('PaymentRequest').where({ memberId: m.userId });
    return [e.status, subs.length, subs[0]?.id === e.subscriptionId, pays.map(p => [p.provider, p.status, p.amountTzs])];
  };
  assert.deepEqual(await one(), ['active', 1, true, [['sponsor_invoice', 'approved', PRO]]]);

  // A start that failed half-way (the pass and payment were written, the entitlement was not) is finished, not repeated.
  await db('B2BPassEntitlement').where({ benefitId }).update({ status: 'invoiced', subscriptionId: null, activatedAt: null });
  await Promise.all([billing.advanceEntitlements({ invoiceId: prepared.invoice.id }), billing.advanceEntitlements({ invoiceId: prepared.invoice.id })]);
  assert.deepEqual(await one(), ['active', 1, true, [['sponsor_invoice', 'approved', PRO]]]);
});

test('unlocking twice at once makes one pass and one payment request', async () => {
  const orgId = await sponsor('employer');
  const m = await enrol(orgId);
  const { programId, benefitId } = await programme(orgId, { ...PASS, fundingType: 'sponsor_percentage', sponsorShareBps: 7000 });
  await paidPrepaid(programId);
  const [e] = await entitlements({ benefitId });
  const asked = await Promise.all([1, 2, 3].map(() => billing.unlock({ userId: m.userId, entitlementId: e.id })));
  assert.equal(new Set(asked.map(a => a.paymentRequest.id)).size, 1, JSON.stringify(asked.map(a => a.error ?? a.paymentRequest.id)));
  assert.equal((await db('Subscription').where({ memberId: m.userId })).length, 1);
  assert.deepEqual((await db('PaymentRequest').where({ memberId: m.userId })).map(p => [p.status, p.amountTzs]), [['pending', PRO - Math.round(PRO * 0.7)]]);
});

// ── Flat fee with a member share ─────────────────────────────────────────────

test('a split pass: the sponsor pays its share upfront; the member unlocks by paying theirs', async () => {
  const g = await gym();
  const orgId = await sponsor('employer');
  const m = await enrol(orgId);
  const { programId, benefitId } = await programme(orgId, { ...PASS, fundingType: 'sponsor_percentage', sponsorShareBps: 7000 });
  const sponsorShare = Math.round(PRO * 0.7);
  const memberShare = PRO - sponsorShare;

  const paid = await paidPrepaid(programId);
  assert.deepEqual([paid.invoice.totalTzs, paid.activation.awaitingMember, paid.activation.started], [sponsorShare, 1, 0]);
  const [e] = await entitlements({ benefitId });
  assert.deepEqual([e.status, e.sponsorTzs, e.memberTzs, e.subscriptionId], ['awaiting_member', sponsorShare, memberShare, null]);
  assert.equal((await checkInService.perform({ memberId: m.userId, gymId: g.id })).failure, 'subscription_inactive');   // locked until they pay
  const before = (await b2bProgramService.myBenefits({ userId: m.userId })).benefits[0].pass;
  assert.deepEqual([before.status, before.canUnlock, before.memberTzs, before.entitlementId], ['awaiting_member', true, memberShare, e.id]);

  // Only the member themselves can unlock.
  assert.equal((await billing.unlock({ userId: await user('member'), entitlementId: e.id })).status, 404);
  const asked = await billing.unlock({ userId: m.userId, entitlementId: e.id });
  assert.deepEqual([asked.paymentRequest.status, asked.paymentRequest.amountTzs], ['pending', memberShare]);
  assert.equal((await billing.unlock({ userId: m.userId, entitlementId: e.id })).existing, true);   // one open request
  assert.equal((await checkInService.perform({ memberId: m.userId, gymId: g.id })).failure, 'subscription_inactive');   // not paid yet

  // FitFlex approves the member's payment the usual way; the pass starts.
  const approved = await adminPaymentService.decide({ id: asked.paymentRequest.id, decision: 'approve', reference: 'MPESA-1', actorId: ADMIN.userId });
  assert.equal(approved.paymentRequest.status, 'approved');
  const [done] = await entitlements({ benefitId });
  const sub = await db('Subscription').where({ id: done.subscriptionId }).first();
  assert.deepEqual([done.status, sub.status, new Date(sub.expiresAt).toISOString()], ['active', 'active', PERIOD_END]);   // runs to month end, not 30 days
  // Both shares are approved payments against the pass: together, the whole fee.
  const rows = await payments(sub.id);
  assert.deepEqual(rows.map(p => [p.status, p.amountTzs]).sort((x, y) => x[1] - y[1]), [['approved', memberShare], ['approved', sponsorShare]]);
  assert.equal(rows.reduce((s, p) => s + p.amountTzs, 0), PRO);
  assert.equal((await checkInService.perform({ memberId: m.userId, gymId: g.id })).ok, true);
  assert.equal((await billing.unlock({ userId: m.userId, entitlementId: e.id })).error, 'already_unlocked');

  // A rejected payment leaves the pass locked and lets the member try again.
  const other = await enrol(orgId);
  const supplementary = await paidPrepaid(programId);
  assert.equal(supplementary.activation.awaitingMember, 1);
  const [e2] = await entitlements({ benefitId, userId: other.userId });
  const first = await billing.unlock({ userId: other.userId, entitlementId: e2.id });
  await adminPaymentService.decide({ id: first.paymentRequest.id, decision: 'reject', actorId: ADMIN.userId });
  assert.equal((await entitlements({ id: e2.id }))[0].status, 'awaiting_member');
  const second = await billing.unlock({ userId: other.userId, entitlementId: e2.id });
  assert.notEqual(second.paymentRequest.id, first.paymentRequest.id);
});

test('if the activation hook is missed, the daily run finishes the pass', async () => {
  const orgId = await sponsor('employer');
  const m = await enrol(orgId);
  const { programId, benefitId } = await programme(orgId, { ...PASS, fundingType: 'beneficiary_fixed', beneficiaryAmountTzs: 20000 });
  await paidPrepaid(programId);
  const [e] = await entitlements({ benefitId });
  const asked = await billing.unlock({ userId: m.userId, entitlementId: e.id });
  // Payment approved straight in the tables, as if the hook never ran.
  await db('PaymentRequest').where({ id: asked.paymentRequest.id }).update({ status: 'approved' });
  await db('Subscription').where({ id: asked.entitlement.subscriptionId }).update({ status: 'active' });
  const run = await billing.runDaily();
  assert.ok(run.repaired >= 1);
  const [done] = await entitlements({ benefitId });
  assert.equal(done.status, 'active');
  assert.equal((await payments(done.subscriptionId)).reduce((s, p) => s + p.amountTzs, 0), PRO);
});

// ── Discount ─────────────────────────────────────────────────────────────────

test('a programme discount is set by FitFlex only and lowers the fee for both sides', async () => {
  const orgId = await sponsor('employer');
  const ownerId = await user('member');
  await b2bService.addOrganizationUser({ access: await access(orgId), body: { userId: ownerId, role: 'owner' }, actorId: ADMIN.userId });
  await enrol(orgId);
  const { programId, benefitId } = await programme(orgId, { ...PASS, fundingType: 'sponsor_percentage', sponsorShareBps: 5000 });

  const owner = await access(orgId, { userId: ownerId, userType: 'member' });
  const refused = await b2bProgramService.updateProgram({ access: owner, programId, body: { discountBps: 1000 } });
  assert.deepEqual([refused.status, refused.field], [403, 'discountBps']);
  assert.equal((await b2bProgramService.updateProgram({ access: await access(orgId), programId, body: { discountBps: 10000 } })).error, 'invalid_discount');
  const set = await b2bProgramService.updateProgram({ access: await access(orgId), programId, body: { discountBps: 1000 }, actorId: ADMIN.userId });
  assert.equal(set.program.discountBps, 1000);

  const fee = discountedFeeTzs(PRO, 1000);
  const prepared = await billing.preparePrepaid({ programId, period: PERIOD, actorId: ADMIN.userId });
  const [e] = await entitlements({ benefitId });
  assert.deepEqual([e.listPriceTzs, e.discountBps, e.feeTzs, e.sponsorTzs + e.memberTzs], [PRO, 1000, fee, fee]);
  assert.equal(prepared.invoice.totalTzs, e.sponsorTzs);
  assert.equal(fee, Math.round(PRO * 0.9));
});

// ── Per use ──────────────────────────────────────────────────────────────────

test('per-use benefits are invoiced after the month; a later reversal comes back as a credit', async () => {
  const g = await gym();
  const orgId = await sponsor();
  const m = await enrol(orgId);
  const { programId } = await programme(orgId, { name: 'Gym visits', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'unlimited' });
  const lastMonth = monthBounds(LAST);
  const at = d => new Date(`${d}T09:00:00.000Z`);
  const visit = extra => usage.consume({ userId: m.userId, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: g.id, tier: g.tier }, grossTzs: 5000, ...extra });
  const v1 = await visit({ at: at(lastMonth.startDate) });
  await visit({ at: at(lastMonth.endDate) });
  await visit({ at: at(MONTH_START) });   // this month: not invoiced yet

  assert.equal((await billing.prepareUsage({ programId, period: PERIOD, actorId: ADMIN.userId })).error, 'period_not_ended');
  const prepared = await billing.prepareUsage({ programId, period: LAST, actorId: ADMIN.userId });
  assert.deepEqual([prepared.added, prepared.credited, prepared.invoice.kind, prepared.invoice.totalTzs], [2, 0, 'usage', 10000]);
  assert.deepEqual(await billing.prepareUsage({ programId, period: LAST, actorId: ADMIN.userId }).then(r => [r.added, r.invoice]), [0, null]);
  const issued = await billing.issueInvoice({ invoiceId: prepared.invoice.id, vatRateBps: 0, actorId: ADMIN.userId });
  assert.deepEqual([issued.invoice.vatRateBps, issued.invoice.vatTzs], [0, 0]);
  await billing.markPaid({ invoiceId: prepared.invoice.id, paymentReference: 'BANK-2', actorId: FINANCE.userId });

  // A visit already invoiced is reversed: the sponsor is credited on the next invoice.
  await usage.reverse({ consumptionId: v1.consumption.id, reason: 'Wrong gym', actorId: ADMIN.userId });
  const credit = await billing.prepareUsage({ programId, period: LAST, actorId: ADMIN.userId });
  assert.deepEqual([credit.added, credit.credited, credit.invoice.totalTzs], [0, 1, -5000]);
  assert.equal((await billing.prepareUsage({ programId, period: LAST, actorId: ADMIN.userId })).credited, 0);   // credited once
  // The database refuses to invoice one consumption twice.
  const [line] = await db('B2BSponsorInvoiceLine').where({ invoiceId: prepared.invoice.id, kind: 'usage' });
  await assert.rejects(db('B2BSponsorInvoiceLine').insert({ ...line, id: uid('b2bl'), invoiceId: credit.invoice.id, createdAt: new Date() }), err => err.code === '23505');
});

// ── Voiding and guards ───────────────────────────────────────────────────────

test('a voided invoice is kept, and what was on it can be invoiced again; a paid one is final', async () => {
  const orgId = await sponsor();
  await enrol(orgId);
  const { programId, benefitId } = await programme(orgId);
  const first = await billing.preparePrepaid({ programId, period: PERIOD, actorId: ADMIN.userId });
  await billing.issueInvoice({ invoiceId: first.invoice.id, vatRateBps: 1800, actorId: ADMIN.userId });
  assert.equal((await billing.voidInvoice({ invoiceId: first.invoice.id, actorId: ADMIN.userId })).error, 'reason_required');
  const voided = await billing.voidInvoice({ invoiceId: first.invoice.id, reason: 'Wrong programme', actorId: ADMIN.userId });
  assert.deepEqual([voided.invoice.status, voided.invoice.voidedBy, voided.invoice.totalTzs], ['void', ADMIN.userId, PRO]);
  assert.deepEqual((await entitlements({ benefitId })).map(e => e.status), ['void']);
  assert.equal((await billing.markPaid({ invoiceId: first.invoice.id, paymentReference: 'x', actorId: ADMIN.userId })).error, 'invalid_transition');

  const second = await billing.preparePrepaid({ programId, period: PERIOD, actorId: ADMIN.userId });
  assert.deepEqual([second.added, second.invoice.id !== first.invoice.id], [1, true]);
  await billing.issueInvoice({ invoiceId: second.invoice.id, vatRateBps: 1800, actorId: ADMIN.userId });
  await billing.markPaid({ invoiceId: second.invoice.id, paymentReference: 'BANK-3', actorId: FINANCE.userId });
  assert.equal((await billing.voidInvoice({ invoiceId: second.invoice.id, reason: 'too late', actorId: ADMIN.userId })).error, 'invalid_transition');
  await assert.rejects(db('B2BSponsorInvoice').where({ id: second.invoice.id }).update({ status: 'issued', paidAt: null, paidBy: null, paymentReference: null }), /not allowed/);

  // Other refusals.
  assert.equal((await billing.preparePrepaid({ programId, period: '2020-01', actorId: ADMIN.userId })).error, 'period_not_open');
  assert.equal((await billing.preparePrepaid({ programId, period: 'October', actorId: ADMIN.userId })).error, 'invalid_period');
  const perUseOnly = await programme(orgId, { name: 'Custom', benefitType: 'custom', fundingType: 'full' });
  assert.equal((await billing.preparePrepaid({ programId: perUseOnly.programId, period: PERIOD, actorId: ADMIN.userId })).error, 'no_sponsored_pass');
  const a = await access(orgId);
  assert.equal((await b2bProgramService.createBenefit({ access: a, programId, body: { ...PASS, passTier: 'gold' } })).error, 'invalid_pass_tier');
  assert.equal((await b2bProgramService.createBenefit({ access: a, programId, body: { ...PASS, fundingType: 'none' } })).error, 'pass_needs_funding');
});

// ── Who sees what ────────────────────────────────────────────────────────────

test('routes: FitFlex raises and settles invoices; an organisation reads only its own issued ones', async () => {
  const admin = { sub: ADMIN.userId, userType: 'admin' };
  const orgA = await sponsor();
  const orgB = await sponsor();
  const ownerA = { sub: await user('member'), userType: 'member' };
  const viewerA = { sub: await user('member'), userType: 'member' };
  await b2bService.addOrganizationUser({ access: await access(orgA), body: { userId: ownerA.sub, role: 'owner' }, actorId: ADMIN.userId });
  await b2bService.addOrganizationUser({ access: await access(orgA), body: { userId: viewerA.sub, role: 'viewer' }, actorId: ADMIN.userId });
  const m = await enrol(orgA);
  await enrol(orgB);
  const a = await programme(orgA, { ...PASS, fundingType: 'sponsor_percentage', sponsorShareBps: 5000 });
  const b = await programme(orgB);

  // Only FitFlex admins (with the b2b scope) raise, issue, settle or void.
  for (const [route, params] of [[adminPrepareB2BInvoice, { programId: a.programId }], [adminListB2BInvoices, {}], [adminIssueB2BInvoice, { invoiceId: 'x' }],
    [adminMarkB2BInvoicePaid, { invoiceId: 'x' }], [adminVoidB2BInvoice, { invoiceId: 'x' }], [adminListB2BEntitlements, { programId: a.programId }], [adminConvertCorporateToProgram, { corporateId: 'x' }]]) {
    assert.equal((await call(route, { claims: ownerA, params, body: { kind: 'prepaid', period: PERIOD } })).statusCode, 403, route.path);
  }
  assert.equal((await call(adminListB2BInvoices, { claims: { ...admin, portalUser: true, aclPermissions: ['corporate'] } })).body.requiredScope, 'b2b');
  assert.equal((await call(adminPrepareB2BInvoice, { claims: admin, params: { programId: a.programId }, body: { kind: 'weekly', period: PERIOD } })).body.error, 'invalid_kind');

  const prepared = await call(adminPrepareB2BInvoice, { claims: admin, params: { programId: a.programId }, body: { kind: 'prepaid', period: PERIOD } });
  assert.equal(prepared.statusCode, 200, JSON.stringify(prepared.body));
  const invoiceId = prepared.body.invoice.id;
  const otherInvoice = (await call(adminPrepareB2BInvoice, { claims: admin, params: { programId: b.programId }, body: { kind: 'prepaid', period: PERIOD } })).body.invoice.id;

  // A draft is FitFlex's working paper: the organisation doesn't see it.
  assert.equal((await call(listB2BOrganizationInvoices, { claims: ownerA, params: { id: orgA } })).body.total, 0);
  assert.equal((await call(getB2BOrganizationInvoice, { claims: ownerA, params: { id: orgA, invoiceId } })).statusCode, 404);
  assert.equal((await call(adminIssueB2BInvoice, { claims: admin, params: { invoiceId }, body: { vatRateBps: 1800 } })).body.invoice.status, 'issued');

  const mine = await call(listB2BOrganizationInvoices, { claims: ownerA, params: { id: orgA } });
  assert.deepEqual(mine.body.items.map(i => [i.id, i.status]), [[invoiceId, 'issued']]);
  const detail = await call(getB2BOrganizationInvoice, { claims: ownerA, params: { id: orgA, invoiceId } });
  assert.deepEqual(detail.body.lines.map(l => [l.kind, l.beneficiaryId, l.amountTzs]), [['pass', m.beneficiary.id, Math.round(PRO * 0.5)]]);
  // Not another organisation's, not through its own id either; a viewer has no usage.read.
  assert.equal((await call(getB2BOrganizationInvoice, { claims: ownerA, params: { id: orgA, invoiceId: otherInvoice } })).statusCode, 404);
  assert.equal((await call(listB2BOrganizationInvoices, { claims: ownerA, params: { id: orgB } })).statusCode, 404);
  assert.equal((await call(listB2BOrganizationInvoices, { claims: viewerA, params: { id: orgA } })).statusCode, 403);

  // The admin who issued it can't also record it as paid; a second admin does.
  const own = await call(adminMarkB2BInvoicePaid, { claims: admin, params: { invoiceId }, body: { paymentReference: 'BANK-9' } });
  assert.deepEqual([own.statusCode, own.body.error], [403, 'cannot_settle_own_invoice']);
  assert.equal((await call(adminMarkB2BInvoicePaid, { claims: { sub: FINANCE.userId, userType: 'admin' }, params: { invoiceId }, body: { paymentReference: 'BANK-9' } })).body.invoice.status, 'paid');
  const covered = await call(adminListB2BEntitlements, { claims: admin, params: { programId: a.programId } });
  assert.deepEqual(covered.body.counts, { awaiting_member: 1 });
  const entitlementId = covered.body.entitlements[0].id;

  // The member unlocks through the route; staff and other members can't do it for them.
  assert.equal((await call(unlockMyB2BPass, { claims: admin, params: { entitlementId } })).statusCode, 403);
  assert.equal((await call(unlockMyB2BPass, { claims: ownerA, params: { entitlementId } })).statusCode, 404);
  const unlocked = await call(unlockMyB2BPass, { claims: { sub: m.userId, userType: 'member' }, params: { entitlementId } });
  assert.deepEqual([unlocked.statusCode, unlocked.body.paymentRequest.amountTzs], [201, PRO - Math.round(PRO * 0.5)]);
});

// ── Corporate seats ──────────────────────────────────────────────────────────

test('a company\'s seats become a programme: same tier and split, real passes, and seat bills stop', async () => {
  const g = await gym();
  const { account } = await corporateService.onboard({
    body: { companyName: `Billing Corp ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'copay_70_30', passTier: 'pro', seatLimit: 5 }, actorId: ADMIN.userId,
  });
  made.corporates.push(account.id);
  await corporateService.setStatus({ corporateId: account.id, status: 'active', actorId: ADMIN.userId });
  const { employee } = await corporateService.provisionStaff({ corporateId: account.id, body: { displayName: 'Billing Employee', department: 'Finance' }, actorId: ADMIN.userId });
  await corporateService.setEmployeeStatus({ corporateId: account.id, employeeId: employee.id, status: 'active', actorId: ADMIN.userId });
  // Before conversion, seat billing works as it always has.
  assert.ok((await corporateService.generateBill({ corporateId: account.id, period: LAST, actorId: ADMIN.userId })).bill);

  const converted = await billing.convertCorporate({ corporateId: account.id, actorId: ADMIN.userId });
  assert.deepEqual([converted.program.status, converted.benefit.benefitType, converted.benefit.passTier, converted.benefit.fundingType, converted.benefit.sponsorShareBps],
    ['draft', 'sponsored_pass', 'pro', 'sponsor_percentage', 7000]);
  assert.equal((await billing.convertCorporate({ corporateId: account.id, actorId: ADMIN.userId })).error, 'already_converted');
  assert.equal((await billing.convertCorporate({ corporateId: 'corp_missing', actorId: ADMIN.userId })).status, 404);
  // Still a draft: seat bills continue until FitFlex makes the programme live.
  const nextMonth = monthBounds(PERIOD).nextPeriod;
  assert.ok((await corporateService.generateBill({ corporateId: account.id, period: nextMonth, actorId: ADMIN.userId })).bill);

  const a = await access(converted.organizationId);
  await b2bProgramService.setProgramStatus({ access: a, programId: converted.program.id, status: 'pending', actorId: ADMIN.userId });
  await b2bProgramService.setProgramStatus({ access: a, programId: converted.program.id, status: 'active', actorId: ADMIN.userId });
  assert.deepEqual(await corporateService.generateBill({ corporateId: account.id, period: PERIOD, actorId: ADMIN.userId }), { error: 'billed_by_programme', status: 409 });
  // A month the company already has a seat bill for is not invoiced a second time as a programme.
  const clash = await billing.preparePrepaid({ programId: converted.program.id, period: nextMonth, actorId: ADMIN.userId });
  assert.deepEqual([clash.error, clash.status, clash.billStatus, clash.period], ['period_seat_billed', 409, 'unpaid', nextMonth]);
  assert.equal((await db('B2BSponsorInvoice').where({ programId: converted.program.id })).length, 0);

  // The employee is nominated and invoiced even before being linked to a member account…
  const paid = await paidPrepaid(converted.program.id);
  assert.deepEqual([paid.invoice.totalTzs, paid.activation.awaitingLink], [Math.round(PRO * 0.7), 1]);
  // …and once linked, the daily run moves them on to pay their 30%.
  const memberId = await user('member');
  await corporateService.linkEmployeeUser({ corporateId: account.id, employeeId: employee.id, userId: memberId, actorId: ADMIN.userId });
  assert.equal((await billing.advanceEntitlements()).awaitingMember >= 1, true);
  const [e] = await entitlements({ programId: converted.program.id });
  assert.deepEqual([e.status, e.userId, e.beneficiarySource, e.memberTzs], ['awaiting_member', memberId, 'corporate_employee', PRO - Math.round(PRO * 0.7)]);
  const asked = await billing.unlock({ userId: memberId, entitlementId: e.id });
  await adminPaymentService.decide({ id: asked.paymentRequest.id, decision: 'approve', actorId: ADMIN.userId });
  assert.equal((await checkInService.perform({ memberId, gymId: g.id })).checkin.subscriptionType, 'platform_pass');
  // Corporate's own records are untouched.
  assert.equal((await db('CorporateBill').where({ corporateId: account.id })).length, 2);
  await db('CorporateBill').where({ corporateId: account.id }).del();
});
