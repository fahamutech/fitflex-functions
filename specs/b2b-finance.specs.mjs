// B2B Phase 5 against the CI database: commercial agreements, the billing
// account, platform fees, due dates and numbering, payments and allocation,
// credit and debit notes, statements and aging, reconciliation, and who may
// see or do what.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { purgeB2BBilling } from './fixtures/ledger-cleanup.mjs';
import {
  gyms, b2bService, b2bProgramService, b2bConsumptionService as usage, b2bBillingService as billing, b2bFinanceService as finance,
  corporateService, financeService, settingsService, signJwt as sign,
} from '../src/bootstrap/services.mjs';
import { paymentRequests, users } from '../src/bootstrap/collections.mjs';
import { createB2BFinanceService } from '../src/services/b2b-finance-service.mjs';
import { monthBounds } from '../src/shared/b2b-programs.mjs';
import { localDay, addDays } from '../src/shared/member-progress.mjs';
import { agingBucket, dueDateFor, outstandingTzs, readAgreement, DEFAULT_TERMS } from '../src/shared/b2b-billing.mjs';
import {
  adminRecordB2BPayment, adminIssueB2BNote, adminCreateB2BAgreement, adminReverseB2BPayment, adminB2BBillingDashboard,
  getB2BOrganizationBilling, listB2BOrganizationPayments, getB2BOrganizationStatement, listB2BOrganizationInvoices, getB2BOrganizationInvoice,
} from '../functions/b2b.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], gyms: [], corporates: [] };
const TODAY = localDay(new Date());
const PERIOD = TODAY.slice(0, 7);
const LAST = (() => { const [y, m] = PERIOD.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
const PRO = settingsService.priceForTier('pro');
const YEAR = TODAY.slice(0, 4);

async function user(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Finance ${userType} ${id.slice(-4)}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
// Three FitFlex staff: one raises and issues, one approves, one records payments.
const BILLER = await user('admin');
const APPROVER = await user('admin');
const CASHIER = await user('admin');
const ADMIN = { userType: 'admin', userId: BILLER };
const access = (organizationId, who = ADMIN) => b2bService.resolveAccess({ organizationId, ...who });

async function sponsor(name = 'employer') {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Finance ${name} ${uid('o')}`, email: 'office@finance.test' }, actorId: BILLER });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: BILLER });
  return organization.id;
}
async function enrol(orgId) {
  const userId = await user('member');
  const r = await b2bService.enrollBeneficiary({ access: await access(orgId), body: { userId, status: 'active' }, actorId: BILLER });
  return { userId, beneficiary: r.beneficiary };
}
async function programme(orgId, benefitBody) {
  const a = await access(orgId);
  const { program } = await b2bProgramService.createProgram({ access: a, body: { name: 'Finance programme', startDate: '2026-01-01' }, actorId: BILLER });
  const created = await b2bProgramService.createBenefit({ access: a, programId: program.id, body: benefitBody, actorId: BILLER });
  assert.ok(created.benefit, JSON.stringify(created));
  await b2bProgramService.setBenefitStatus({ access: a, programId: program.id, benefitId: created.benefit.id, status: 'active', actorId: BILLER });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'pending', actorId: BILLER });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'active', actorId: BILLER });
  return { programId: program.id, benefitId: created.benefit.id };
}
const PASS = { name: 'Pro pass', benefitType: 'sponsored_pass', passTier: 'pro', fundingType: 'full' };
const VISITS = { name: 'Gym visits', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'unlimited' };

/** An issued fee invoice of `amountTzs` for a month: the simplest invoice to pay against. */
async function feeInvoice(orgId, amountTzs, period = PERIOD, { effectiveFrom = `${period}-01` } = {}) {
  const { agreement } = await finance.createAgreement({ organizationId: orgId, body: { effectiveFrom, platformFeeTzs: amountTzs }, actorId: BILLER });
  const live = await finance.activateAgreement({ agreementId: agreement.id, actorId: BILLER });
  assert.ok(live.agreement, JSON.stringify(live));
  const prepared = await finance.prepareFee({ organizationId: orgId, period, actorId: BILLER });
  assert.ok(prepared.invoice, JSON.stringify(prepared));
  const issued = await billing.issueInvoice({ invoiceId: prepared.invoice.id, vatRateBps: 0, actorId: BILLER });
  assert.equal(issued.invoice?.status, 'issued', JSON.stringify(issued));
  return issued.invoice;
}
const pay = (orgId, body, actorId = CASHIER) => finance.recordPayment({ organizationId: orgId, body: { method: 'bank_transfer', ...body }, actorId });
const invoiceRow = id => db('B2BSponsorInvoice').where({ id }).first();
const months = (n) => { let p = PERIOD; for (let i = 0; i < n; i += 1) p = monthBounds(p).nextPeriod; return p; };

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
  await purgeB2BBilling(db, orgIds);
  if (orgIds.length) await db('B2BOrganization').whereIn('id', orgIds).del();
  if (made.corporates.length) {
    await db('CorporateBill').whereIn('corporateId', made.corporates).del();
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

// ── Rules ────────────────────────────────────────────────────────────────────

test('rules: terms, due dates, what is owed and aging', () => {
  assert.deepEqual(DEFAULT_TERMS, { prepaidTermsDays: 0, usageTermsDays: 14, platformFeeTzs: null, vatRateBps: null });
  assert.equal(dueDateFor({ kind: 'prepaid', issuedDay: '2026-10-28' }), '2026-10-28');
  assert.equal(dueDateFor({ kind: 'fee', issuedDay: '2026-10-28' }), '2026-10-28');
  assert.equal(dueDateFor({ kind: 'usage', issuedDay: '2026-10-28' }), '2026-11-11');
  assert.equal(dueDateFor({ kind: 'debit_note', issuedDay: '2026-12-25', terms: { prepaidTermsDays: 7, usageTermsDays: 30 } }), '2027-01-24');
  assert.equal(outstandingTzs({ status: 'partially_paid', totalTzs: 1000, amountPaidTzs: 400 }), 600);
  assert.equal(outstandingTzs({ status: 'issued', totalTzs: -1000, amountPaidTzs: 250 }), -750);   // credit still to apply
  assert.equal(outstandingTzs({ status: 'draft', totalTzs: 1000, amountPaidTzs: 0 }), 0);
  assert.equal(outstandingTzs({ status: 'paid', totalTzs: 1000, amountPaidTzs: 1000 }), 0);
  const on = '2026-12-01';
  assert.deepEqual(['2026-12-01', '2026-11-30', '2026-11-01', '2026-10-31', '2026-10-02', '2026-10-01', '2026-09-02', '2026-09-01', null].map(d => agingBucket(d, on)),
    ['current', 'days1to30', 'days1to30', 'days31to60', 'days31to60', 'days61to90', 'days61to90', 'over90', 'current']);
  assert.equal(readAgreement({ effectiveFrom: '2026-13-01' }).error, 'invalid_effective_from');
  assert.equal(readAgreement({ effectiveFrom: '2026-10-01', effectiveTo: '2026-09-30' }).error, 'invalid_effective_to');
  assert.equal(readAgreement({ effectiveFrom: '2026-10-01', usageTermsDays: 400 }).error, 'invalid_payment_terms');
  assert.equal(readAgreement({ effectiveFrom: '2026-10-01', platformFeeTzs: 1.5 }).error, 'invalid_platform_fee');
  assert.equal(readAgreement({ effectiveFrom: '2026-10-01', vatRateBps: 10001 }).error, 'invalid_vat_rate');
  assert.equal(readAgreement({ effectiveFrom: '2026-10-01', billingCycle: 'weekly' }).error, 'unsupported_billing_cycle');
  assert.equal(readAgreement({ effectiveFrom: '2026-10-01', currency: 'USD' }).error, 'unsupported_currency');
});

// ── Commercial agreement ─────────────────────────────────────────────────────

test('agreement: drafted, changed while a draft, put in force, replaced without rewriting history', async () => {
  const orgId = await sponsor();
  const other = await sponsor('other');
  assert.equal((await finance.createAgreement({ organizationId: 'b2b_missing', body: { effectiveFrom: '2026-01-01' }, actorId: BILLER })).status, 404);
  assert.equal((await finance.createAgreement({ organizationId: orgId, body: {}, actorId: BILLER })).error, 'invalid_effective_from');

  const { agreement: draft } = await finance.createAgreement({ organizationId: orgId, body: { effectiveFrom: '2026-01-01', contractReference: 'CRDB/FF/01' }, actorId: BILLER });
  assert.match(draft.reference, /^FF-AGR-2026-\d{6}$/);
  assert.deepEqual([draft.status, draft.prepaidTermsDays, draft.usageTermsDays, draft.platformFeeTzs, draft.billingCycle, draft.currency], ['draft', 0, 14, null, 'monthly', 'TZS']);
  // A draft is not in force.
  assert.equal((await finance.listAgreements({ organizationId: orgId })).inForce, null);
  const changed = await finance.updateAgreement({ agreementId: draft.id, body: { usageTermsDays: 30, platformFeeTzs: 500000 }, actorId: BILLER });
  assert.deepEqual([changed.agreement.usageTermsDays, changed.agreement.platformFeeTzs, changed.agreement.contractReference], [30, 500000, 'CRDB/FF/01']);

  const live = await finance.activateAgreement({ agreementId: draft.id, actorId: BILLER });
  assert.deepEqual([live.agreement.status, live.agreement.activatedBy], ['active', BILLER]);
  assert.equal((await finance.listAgreements({ organizationId: orgId })).inForce.id, draft.id);
  // In force: not edited, in the service or in the database.
  assert.equal((await finance.updateAgreement({ agreementId: draft.id, body: { platformFeeTzs: 1 }, actorId: BILLER })).error, 'agreement_in_force');
  await assert.rejects(db('B2BCommercialAgreement').where({ id: draft.id }).update({ platformFeeTzs: 1 }), /cannot be changed/);
  assert.equal((await finance.activateAgreement({ agreementId: draft.id, actorId: BILLER })).error, 'invalid_transition');

  // New terms from a later date: the old agreement closes the day before, and each still answers for its own days.
  const next = months(2);
  const { agreement: second } = await finance.createAgreement({ organizationId: orgId, body: { effectiveFrom: `${next}-01`, usageTermsDays: 7, platformFeeTzs: 650000 }, actorId: BILLER });
  await finance.activateAgreement({ agreementId: second.id, actorId: APPROVER });
  const { agreements, inForce } = await finance.listAgreements({ organizationId: orgId });
  assert.deepEqual(agreements.map(a => [a.id, a.status, a.effectiveTo]), [[second.id, 'active', null], [draft.id, 'ended', addDays(`${next}-01`, -1)]]);
  assert.equal(inForce.id, draft.id);   // today is still under the first
  // History is not rewritten: nothing may start inside a period already covered.
  const { agreement: clash } = await finance.createAgreement({ organizationId: orgId, body: { effectiveFrom: '2026-03-01', effectiveTo: '2026-04-30' }, actorId: BILLER });
  assert.deepEqual([(await finance.activateAgreement({ agreementId: clash.id, actorId: BILLER })).error], ['agreement_dates_overlap']);

  assert.equal((await finance.endAgreement({ agreementId: second.id, effectiveTo: '2020-01-01', actorId: BILLER })).error, 'invalid_effective_to');
  assert.equal((await finance.endAgreement({ agreementId: second.id, effectiveTo: `${next}-28`, actorId: BILLER })).agreement.status, 'ended');
  // Another organisation has none of this.
  assert.deepEqual((await finance.listAgreements({ organizationId: other })).agreements, []);
  const audited = (await db('AuditLog').where({ target: draft.id })).map(a => a.action).sort();
  assert.deepEqual(audited, ['b2b.agreement.activate', 'b2b.agreement.create', 'b2b.agreement.end', 'b2b.agreement.update']);
});

// ── Billing account ──────────────────────────────────────────────────────────

test('billing account: the organisation\'s own contact until one is set; a mapped company uses its Corporate billing contact', async () => {
  const orgId = await sponsor();
  assert.deepEqual([(await finance.getBillingAccount({ organizationId: orgId })).account.email, (await finance.getBillingAccount({ organizationId: orgId })).account.source], ['office@finance.test', 'organization']);
  assert.equal((await finance.setBillingAccount({ organizationId: orgId, body: { email: 'not-an-email' }, actorId: BILLER })).error, 'invalid_email');
  const set = await finance.setBillingAccount({ organizationId: orgId, body: { contactName: 'Asha Mushi', email: 'Accounts@Finance.Test', phone: '+255700000001' }, actorId: BILLER });
  assert.deepEqual([set.account.contactName, set.account.email, set.account.source, set.account.currency], ['Asha Mushi', 'accounts@finance.test', 'billing_account', 'TZS']);
  await finance.setBillingAccount({ organizationId: orgId, body: { contactName: 'Asha M.', email: 'accounts@finance.test' }, actorId: BILLER });
  assert.equal((await db('B2BBillingAccount').where({ organizationId: orgId })).length, 1);

  const { account } = await corporateService.onboard({ body: { companyName: `Finance Corp ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'fully_funded', passTier: 'pro', seatLimit: 5 }, actorId: BILLER });
  made.corporates.push(account.id);
  await db('CorporateAccount').where({ id: account.id }).update({ billingContactName: 'Corp Billing', billingContactEmail: 'bills@corp.test' });
  const mapped = (await b2bService.organizationForCorporate({ corporateId: account.id })).organization.id;
  const fromCorp = (await finance.getBillingAccount({ organizationId: mapped })).account;
  assert.deepEqual([fromCorp.contactName, fromCorp.email, fromCorp.source], ['Corp Billing', 'bills@corp.test', 'corporate_account']);
});

// ── Platform fee, numbering, due date, terms snapshot ────────────────────────

test('platform fee: one invoice per organisation and month, numbered and dated on issue, on the terms then in force', async () => {
  const orgId = await sponsor();
  assert.deepEqual(await finance.prepareFee({ organizationId: orgId, period: PERIOD, actorId: BILLER }), { invoice: null, added: 0, reason: 'no_agreement' });
  const { agreement } = await finance.createAgreement({ organizationId: orgId, body: { effectiveFrom: `${PERIOD}-01`, platformFeeTzs: 500000, vatRateBps: 1800, prepaidTermsDays: 5 }, actorId: BILLER });
  await finance.activateAgreement({ agreementId: agreement.id, actorId: BILLER });

  // Asked for many times at once: one draft.
  const drafts = await Promise.all([1, 2, 3, 4].map(() => finance.prepareFee({ organizationId: orgId, period: PERIOD, actorId: BILLER })));
  assert.equal(new Set(drafts.map(d => d.invoice.id)).size, 1);
  assert.equal(drafts.filter(d => d.added === 1).length, 1);
  const draft = drafts[0].invoice;
  assert.deepEqual([draft.kind, draft.status, draft.totalTzs, draft.programId, draft.dueDate], ['fee', 'draft', 500000, null, null]);
  assert.match(draft.number, /^DRAFT-/);
  assert.equal((await db('B2BSponsorInvoice').where({ organizationId: orgId, kind: 'fee' })).length, 1);
  await assert.rejects(db('B2BSponsorInvoice').insert({ id: uid('b2bi'), number: uid('X'), organizationId: orgId, period: PERIOD, kind: 'fee', status: 'draft' }), err => err.code === '23505');

  // Issued with no rate given: the agreement's rate is used.
  const { invoice } = await billing.issueInvoice({ invoiceId: draft.id, actorId: BILLER });
  assert.match(invoice.number, new RegExp(`^FF-INV-${YEAR}-\\d{6}$`));
  assert.deepEqual([invoice.status, invoice.vatRateBps, invoice.vatTzs, invoice.dueDate, invoice.agreementId], ['issued', 1800, Math.round(500000 * 1800 / 11800), addDays(TODAY, 5), agreement.id]);
  assert.deepEqual([invoice.terms.reference, invoice.terms.prepaidTermsDays, invoice.terms.platformFeeTzs], [agreement.reference, 5, 500000]);
  // Numbers run in order, with no gaps.
  const next = await feeInvoice(await sponsor('seq-a'), 100000);
  const after = await feeInvoice(await sponsor('seq-b'), 100000);
  assert.equal(Number(after.number.slice(-6)) - Number(next.number.slice(-6)), 1);

  // New terms later: the issued invoice keeps its own.
  await finance.endAgreement({ agreementId: agreement.id, effectiveTo: TODAY, actorId: BILLER });
  const kept = await invoiceRow(invoice.id);
  assert.deepEqual([kept.totalTzs, kept.dueDate, kept.terms.platformFeeTzs], [500000, addDays(TODAY, 5), 500000]);
  for (const patch of [{ totalTzs: 1 }, { number: 'FF-INV-0' }, { dueDate: '2030-01-01' }, { terms: JSON.stringify({}) }]) {
    await assert.rejects(db('B2BSponsorInvoice').where({ id: invoice.id }).update(patch), /cannot be changed/, JSON.stringify(patch));
  }
  // A month with no fee on its agreement drafts nothing; a suspended organisation is not invoiced.
  const noFee = await sponsor('nofee');
  const plain = await finance.createAgreement({ organizationId: noFee, body: { effectiveFrom: `${PERIOD}-01` }, actorId: BILLER });
  await finance.activateAgreement({ agreementId: plain.agreement.id, actorId: BILLER });
  assert.equal((await finance.prepareFee({ organizationId: noFee, period: PERIOD, actorId: BILLER })).reason, 'no_platform_fee');
  await b2bService.setOrganizationStatus({ organizationId: orgId, status: 'suspended', actorId: BILLER });
  assert.equal((await finance.prepareFee({ organizationId: orgId, period: months(1), actorId: BILLER })).error, 'organization_not_active');
});

// ── Usage billing ────────────────────────────────────────────────────────────

test('usage billing: only verified sponsor responsibility is invoiced, once, and is due on the usage terms', async () => {
  const g = { id: uid('gym') };
  await gyms.insertAsync({ id: g.id, name: 'Finance Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000 });
  made.gyms.push(g.id);
  const orgId = await sponsor();
  const m = await enrol(orgId);
  const { programId } = await programme(orgId, VISITS);
  const { startDate, endDate } = monthBounds(LAST);
  const visit = (day, extra = {}) => usage.consume({ userId: m.userId, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: g.id, tier: 'standard' }, grossTzs: 5000, at: new Date(`${day}T09:00:00.000Z`), ...extra });
  const a = await visit(startDate);
  const b = await visit(endDate);
  const held = await visit(endDate, { hold: true });                                   // never confirmed
  const undone = await visit(startDate);
  await usage.reverse({ consumptionId: undone.consumption.id, reason: 'Wrong member', actorId: BILLER });   // reversed before invoicing
  await visit(`${PERIOD}-01`);                                                          // this month: not yet billable

  const prepared = await billing.prepareUsage({ programId, period: LAST, actorId: BILLER });
  assert.deepEqual([prepared.added, prepared.invoice.totalTzs], [2, 10000]);
  const lines = await db('B2BSponsorInvoiceLine').where({ invoiceId: prepared.invoice.id });
  assert.deepEqual(lines.map(l => l.consumptionId).sort(), [a.consumption.id, b.consumption.id].sort());
  assert.ok(!lines.some(l => [held.consumption.id, undone.consumption.id].includes(l.consumptionId)));
  // Generated again, and by two jobs at once: nothing is charged twice.
  const again = await Promise.all([billing.prepareUsage({ programId, period: LAST, actorId: BILLER }), billing.prepareUsage({ programId, period: LAST, actorId: BILLER })]);
  assert.deepEqual(again.map(r => r.added), [0, 0]);
  assert.equal((await db('B2BSponsorInvoice').where({ programId, kind: 'usage' })).length, 1);

  const { invoice } = await billing.issueInvoice({ invoiceId: prepared.invoice.id, vatRateBps: 0, actorId: BILLER });
  assert.deepEqual([invoice.dueDate, invoice.terms.source], [addDays(TODAY, 14), 'default']);

  // Every shilling traces back to the ledger; the provider side is shown next to it, not used for it.
  const trace = await finance.reconciliation({ invoiceId: invoice.id });
  assert.deepEqual([trace.checks.linesAddUp, trace.checks.usageMatchesLedger, trace.checks.linesTotalTzs, trace.checks.outstandingTzs], [true, true, 10000, 10000]);
  assert.deepEqual(trace.lines.map(l => [l.kind, l.consumption.sponsorTzs, l.consumption.grossTzs, l.consumption.sourceType, l.provider.outcome]),
    [['usage', 5000, 5000, 'gym_checkin', 'not_settled_yet'], ['usage', 5000, 5000, 'gym_checkin', 'not_settled_yet']]);
  // A visit reversed after it was invoiced is flagged, and comes back as a credit on the next run.
  await usage.reverse({ consumptionId: a.consumption.id, reason: 'Disputed', actorId: BILLER });
  assert.deepEqual((await finance.reconciliation({ invoiceId: invoice.id })).checks.reversedSinceInvoiced, [a.consumption.id]);
  const credit = await billing.prepareUsage({ programId, period: LAST, actorId: BILLER });
  assert.deepEqual([credit.credited, credit.invoice.totalTzs], [1, -5000]);
});

// ── Payments and allocation ──────────────────────────────────────────────────

test('payment: part payment, full payment, the same reference twice, and who may record it', async () => {
  const orgId = await sponsor();
  const inv = await feeInvoice(orgId, 1000000);

  assert.equal((await pay(orgId, { amountTzs: 0, reference: 'X' })).error, 'invalid_amount');
  assert.equal((await pay(orgId, { amountTzs: 100.5, reference: 'X' })).error, 'invalid_amount');
  assert.equal((await pay(orgId, { amountTzs: 100, reference: ' ' })).error, 'payment_reference_required');
  assert.equal((await pay(orgId, { amountTzs: 100, reference: 'X', method: 'barter' })).error, 'invalid_payment_method');
  assert.equal((await finance.recordPayment({ organizationId: orgId, body: { amountTzs: 100, method: 'cash', reference: 'X' } })).error, 'actor_required');
  // Maker-checker: the person who issued the invoice does not record its payment. Nothing is kept.
  const own = await pay(orgId, { amountTzs: 400000, reference: 'CRDB-1', allocations: [{ invoiceId: inv.id, amountTzs: 400000 }] }, BILLER);
  assert.deepEqual([own.error, own.status], ['cannot_settle_own_invoice', 403]);
  assert.equal((await db('B2BPayment').where({ organizationId: orgId })).length, 0);

  const part = await pay(orgId, { amountTzs: 400000, reference: 'CRDB-1', allocations: [{ invoiceId: inv.id, amountTzs: 400000 }] });
  assert.match(part.payment.number, new RegExp(`^FF-RCT-${YEAR}-\\d{6}$`));
  assert.deepEqual([part.payment.amountTzs, part.payment.allocatedTzs, part.payment.unallocatedTzs, part.invoices[0].status, part.invoices[0].amountPaidTzs], [400000, 400000, 0, 'partially_paid', 400000]);
  assert.equal(outstandingTzs(await invoiceRow(inv.id)), 600000);

  // The same bank reference again: one payment, nothing allocated twice.
  const twice = await pay(orgId, { amountTzs: 400000, reference: 'crdb-1', allocations: [{ invoiceId: inv.id, amountTzs: 400000 }] });
  assert.deepEqual([twice.existing, twice.payment.id], [true, part.payment.id]);
  assert.deepEqual(await pay(orgId, { amountTzs: 999, reference: 'CRDB-1' }).then(r => [r.error, r.status]), ['payment_reference_in_use', 409]);
  const racing = await Promise.all([1, 2, 3].map(() => pay(orgId, { amountTzs: 50000, reference: 'CRDB-RACE' })));
  assert.equal(new Set(racing.map(r => r.payment.id)).size, 1);
  assert.equal((await db('B2BPayment').where({ organizationId: orgId })).length, 2);
  assert.equal((await invoiceRow(inv.id)).amountPaidTzs, 400000);
  // A different method with the same reference is a different payment.
  assert.equal((await finance.recordPayment({ organizationId: orgId, body: { amountTzs: 1000, method: 'mobile_money', reference: 'CRDB-1' }, actorId: CASHIER })).existing, undefined);

  // More than is owed on the invoice is refused; the rest settles it.
  assert.equal((await pay(orgId, { amountTzs: 700000, reference: 'CRDB-2', allocations: [{ invoiceId: inv.id, amountTzs: 700000 }] })).error, 'exceeds_outstanding');
  const rest = await pay(orgId, { amountTzs: 600000, reference: 'CRDB-2', allocations: [{ invoiceId: inv.id, amountTzs: 600000 }] });
  const paid = rest.invoices[0];
  assert.deepEqual([paid.status, paid.amountPaidTzs, paid.paidBy, paid.paymentReference], ['paid', 1000000, CASHIER, 'CRDB-2']);
  // Paid is final.
  assert.equal((await pay(orgId, { amountTzs: 1, reference: 'CRDB-3', allocations: [{ invoiceId: inv.id, amountTzs: 1 }] })).error, 'invoice_not_open');
  assert.equal((await billing.voidInvoice({ invoiceId: inv.id, reason: 'x', actorId: BILLER })).error, 'invalid_transition');
  await assert.rejects(db('B2BSponsorInvoice').where({ id: inv.id }).update({ amountPaidTzs: 0, status: 'issued' }), /not allowed|final/);
  const audit = (await db('AuditLog').where({ target: inv.id })).map(x => x.action);
  assert.equal(audit.filter(x => x === 'b2b.payment.allocate').length, 2);
});

test('allocation: one payment over several invoices, an overpayment kept as credit, and never twice', async () => {
  const orgId = await sponsor();
  const a = await feeInvoice(orgId, 1000000, PERIOD);
  // A second month's fee under the same agreement.
  const second = await finance.prepareFee({ organizationId: orgId, period: months(1), actorId: BILLER });
  await db('B2BSponsorInvoiceLine').where({ invoiceId: second.invoice.id }).update({ unitTzs: 500000, amountTzs: 500000 });
  await db('B2BSponsorInvoice').where({ id: second.invoice.id }).update({ totalTzs: 500000 });
  const b = (await billing.issueInvoice({ invoiceId: second.invoice.id, vatRateBps: 0, actorId: BILLER })).invoice;

  // 1,200,000 received against 1,000,000 + 500,000: oldest due first.
  const paid = await pay(orgId, { amountTzs: 1200000, reference: 'NMB-77', autoAllocate: true });
  const state = async () => Object.fromEntries((await db('B2BSponsorInvoice').whereIn('id', [a.id, b.id])).map(i => [i.id, [i.status, i.amountPaidTzs, outstandingTzs(i)]]));
  assert.deepEqual(await state(), { [a.id]: ['paid', 1000000, 0], [b.id]: ['partially_paid', 200000, 300000] });
  assert.deepEqual([paid.payment.allocatedTzs, paid.payment.unallocatedTzs, paid.allocations.length], [1200000, 0, 2]);

  // An overpayment stays on the account as credit, and is applied later.
  const over = await pay(orgId, { amountTzs: 450000, reference: 'NMB-78', allocations: [{ invoiceId: b.id, amountTzs: 100000 }] });
  assert.deepEqual([over.payment.allocatedTzs, over.payment.unallocatedTzs], [100000, 350000]);
  assert.equal((await finance.statement({ organizationId: orgId })).creditTzs, 350000);
  assert.equal((await finance.allocate({ paymentId: over.payment.id, body: { allocations: [{ invoiceId: b.id, amountTzs: 300000 }] }, actorId: CASHIER })).error, 'exceeds_outstanding');
  assert.equal((await finance.allocate({ paymentId: over.payment.id, body: { allocations: [{ invoiceId: b.id, amountTzs: 200000 }, { invoiceId: b.id, amountTzs: 1 }] }, actorId: CASHIER })).error, 'duplicate_invoice_in_allocation');

  // The same allocation sent twice (with the caller's key), and several at once: allocated once.
  const body = { allocations: [{ invoiceId: b.id, amountTzs: 200000 }], requestId: uid('req') };
  const first = await finance.allocate({ paymentId: over.payment.id, body, actorId: CASHIER });
  const repeat = await finance.allocate({ paymentId: over.payment.id, body, actorId: CASHIER });
  assert.deepEqual([first.invoices[0].status, repeat.existing, repeat.allocations[0].id], ['paid', true, first.allocations[0].id]);
  assert.equal((await finance.allocate({ paymentId: over.payment.id, body: { allocations: [{ invoiceId: b.id, amountTzs: 1 }] }, actorId: CASHIER })).error, 'invoice_not_open');
  assert.deepEqual(await state(), { [a.id]: ['paid', 1000000, 0], [b.id]: ['paid', 500000, 0] });
  assert.equal((await finance.getPayment({ paymentId: over.payment.id })).payment.unallocatedTzs, 150000);

  const c = await feeInvoice(await sponsor('race'), 100000);
  const p = await pay(c.organizationId, { amountTzs: 100000, reference: 'RACE-1' });
  const both = await Promise.all([1, 2, 3].map(() => finance.allocate({ paymentId: p.payment.id, body: { allocations: [{ invoiceId: c.id, amountTzs: 100000 }] }, actorId: CASHIER })));
  assert.equal(both.filter(r => !r.error).length, 1, JSON.stringify(both.map(r => r.error)));
  assert.deepEqual([(await invoiceRow(c.id)).amountPaidTzs, (await db('B2BPaymentAllocation').where({ invoiceId: c.id })).length], [100000, 1]);
  // Money can't be allocated to another organisation's invoice, or beyond what the payment holds.
  assert.equal((await finance.allocate({ paymentId: over.payment.id, body: { allocations: [{ invoiceId: c.id, amountTzs: 1 }] }, actorId: CASHIER })).error, 'invoice_not_found');
  const d = await feeInvoice(await sponsor('short'), 100000);
  const small = await pay(d.organizationId, { amountTzs: 40000, reference: 'SMALL-1' });
  assert.equal((await finance.allocate({ paymentId: small.payment.id, body: { allocations: [{ invoiceId: d.id, amountTzs: 50000 }] }, actorId: CASHIER })).error, 'exceeds_unallocated');
});

test('sponsored passes start only when their invoice is paid in full', async () => {
  const orgId = await sponsor();
  const m = await enrol(orgId);
  await enrol(orgId);
  const { programId, benefitId } = await programme(orgId, PASS);
  const prepared = await billing.preparePrepaid({ programId, period: PERIOD, actorId: BILLER });
  const { invoice } = await billing.issueInvoice({ invoiceId: prepared.invoice.id, vatRateBps: 0, actorId: BILLER });
  assert.deepEqual([invoice.totalTzs, invoice.dueDate], [2 * PRO, TODAY]);   // invoiced in advance: due on issue

  // Half is paid: enough for one pass, but nobody's starts.
  const half = await pay(orgId, { amountTzs: PRO, reference: 'PASS-1', allocations: [{ invoiceId: invoice.id, amountTzs: PRO }] });
  assert.deepEqual([half.invoices[0].status, half.activation], ['partially_paid', undefined]);
  assert.deepEqual((await db('B2BPassEntitlement').where({ benefitId })).map(e => e.status), ['invoiced', 'invoiced']);
  assert.equal((await db('Subscription').where({ memberId: m.userId })).length, 0);
  // A part-paid invoice can't be voided out from under the money on it.
  assert.equal((await billing.voidInvoice({ invoiceId: invoice.id, reason: 'x', actorId: BILLER })).error, 'invalid_transition');

  const rest = await pay(orgId, { amountTzs: PRO, reference: 'PASS-2', allocations: [{ invoiceId: invoice.id, amountTzs: PRO }] });
  assert.deepEqual([rest.invoices[0].status, rest.activation[invoice.id].started], ['paid', 2]);
  assert.deepEqual((await db('B2BPassEntitlement').where({ benefitId })).map(e => e.status), ['active', 'active']);
  // The quick "mark paid" on another invoice records a real payment too.
  const late = await enrol(orgId);
  const extra = await billing.preparePrepaid({ programId, period: PERIOD, actorId: BILLER });
  await billing.issueInvoice({ invoiceId: extra.invoice.id, vatRateBps: 0, actorId: BILLER });
  const quick = await billing.markPaid({ invoiceId: extra.invoice.id, paymentReference: 'PASS-3', actorId: CASHIER });
  assert.deepEqual([quick.invoice.status, quick.invoice.amountPaidTzs, quick.payment.amountTzs, quick.activation.started], ['paid', PRO, PRO, 1]);
  assert.equal((await db('Subscription').where({ memberId: late.userId })).length, 1);
  assert.equal((await billing.markPaid({ invoiceId: extra.invoice.id, paymentReference: 'PASS-3', actorId: CASHIER })).unchanged, true);
});

test('payment reversal: what it part-settled opens again; a paid invoice stays paid', async () => {
  const orgId = await sponsor();
  const inv = await feeInvoice(orgId, 300000);
  const part = await pay(orgId, { amountTzs: 100000, method: 'cheque', reference: 'CHQ-9', allocations: [{ invoiceId: inv.id, amountTzs: 100000 }] });
  assert.equal((await finance.reversePayment({ paymentId: part.payment.id, reason: ' ', actorId: APPROVER })).error, 'reason_required');
  const reversed = await finance.reversePayment({ paymentId: part.payment.id, reason: 'Cheque returned unpaid', actorId: APPROVER });
  assert.deepEqual([reversed.payment.status, reversed.payment.allocatedTzs, reversed.payment.reversedBy, reversed.reopened], ['reversed', 0, APPROVER, [inv.id]]);
  assert.deepEqual([(await invoiceRow(inv.id)).status, (await invoiceRow(inv.id)).amountPaidTzs], ['issued', 0]);
  assert.deepEqual((await db('B2BPaymentAllocation').where({ paymentId: part.payment.id })).map(a => [a.active, a.reversedBy]), [[false, APPROVER]]);
  assert.equal((await finance.reversePayment({ paymentId: part.payment.id, reason: 'again', actorId: APPROVER })).unchanged, true);
  assert.equal((await finance.allocate({ paymentId: part.payment.id, body: { allocations: [{ invoiceId: inv.id, amountTzs: 1 }] }, actorId: CASHIER })).error, 'payment_reversed');
  // The cheque is presented again: the same reference is a new payment now.
  const again = await pay(orgId, { amountTzs: 300000, method: 'cheque', reference: 'CHQ-9', allocations: [{ invoiceId: inv.id, amountTzs: 300000 }] });
  assert.notEqual(again.payment.id, part.payment.id);
  // It settled the invoice, and a paid invoice is final: it is not reversed, a debit note says what is owed.
  const refused = await finance.reversePayment({ paymentId: again.payment.id, reason: 'Returned', actorId: APPROVER });
  assert.deepEqual([refused.error, refused.invoices], ['payment_settled_invoices', [inv.number]]);
  // Payments and allocations are never deleted.
  await assert.rejects(db('B2BPayment').where({ id: part.payment.id }).del(), /never deleted/);
  await assert.rejects(db('B2BPaymentAllocation').where({ paymentId: part.payment.id }).del(), /never deleted/);
});

// ── Credit and debit notes ───────────────────────────────────────────────────

test('notes: a correction is a separate document, raised by one person and issued by another', async () => {
  const orgId = await sponsor();
  const inv = await feeInvoice(orgId, 500000);
  const note = body => finance.createNote({ invoiceId: inv.id, body, actorId: BILLER });
  assert.equal((await note({ type: 'refund', amountTzs: 1, reason: 'x' })).error, 'invalid_note_type');
  assert.equal((await note({ type: 'credit', amountTzs: 0, reason: 'x' })).error, 'invalid_amount');
  assert.equal((await note({ type: 'credit', amountTzs: 100 })).error, 'reason_required');
  assert.deepEqual(await note({ type: 'credit', amountTzs: 500001, reason: 'Too much' }).then(r => [r.error, r.creditableTzs]), ['credit_exceeds_invoice', 500000]);

  const { note: draft } = await note({ type: 'credit', amountTzs: 120000, reason: 'Fee agreed lower for the first month' });
  assert.deepEqual([draft.kind, draft.status, draft.totalTzs, draft.relatedInvoiceId, draft.createdBy], ['credit_note', 'draft', -120000, inv.id, BILLER]);
  // The invoice itself is untouched, and the draft changes nothing yet.
  assert.deepEqual([(await invoiceRow(inv.id)).totalTzs, outstandingTzs(await invoiceRow(inv.id))], [500000, 500000]);
  // Its author can't issue it, in the service or in the database.
  assert.deepEqual(await finance.issueNote({ noteId: draft.id, actorId: BILLER }).then(r => [r.error, r.status]), ['cannot_issue_own_note', 403]);
  await assert.rejects(db('B2BSponsorInvoice').where({ id: draft.id }).update({ status: 'issued', issuedAt: new Date(), issuedBy: BILLER, vatRateBps: 0, vatTzs: 0 }), err => err.code === '23514');

  const issued = await finance.issueNote({ noteId: draft.id, actorId: APPROVER });
  assert.match(issued.note.number, new RegExp(`^FF-CN-${YEAR}-\\d{6}$`));
  // Applied to the invoice it corrects, in full: the note is spent, the invoice owes less.
  assert.deepEqual([issued.note.status, issued.note.amountPaidTzs, issued.note.dueDate, issued.applied.length], ['paid', 120000, null, 1]);
  const after = await invoiceRow(inv.id);
  assert.deepEqual([after.totalTzs, after.status, after.amountPaidTzs, outstandingTzs(after)], [500000, 'partially_paid', 120000, 380000]);
  // Credits on one invoice never add up to more than the invoice.
  assert.deepEqual(await note({ type: 'credit', amountTzs: 380001, reason: 'More' }).then(r => r.creditableTzs), 380000);

  // A debit note is a new amount owed, with its own due date.
  const { note: debitDraft } = await note({ type: 'debit', amountTzs: 30000, reason: 'Two more people added mid-month' });
  const debit = (await finance.issueNote({ noteId: debitDraft.id, actorId: APPROVER })).note;
  assert.match(debit.number, new RegExp(`^FF-DN-${YEAR}-\\d{6}$`));
  assert.deepEqual([debit.kind, debit.status, debit.totalTzs, debit.dueDate], ['debit_note', 'issued', 30000, addDays(TODAY, 14)]);
  // No notes on notes, and none on a draft.
  assert.equal((await finance.createNote({ invoiceId: debit.id, body: { type: 'credit', amountTzs: 1, reason: 'x' }, actorId: BILLER })).error, 'note_on_note');

  // A credit on an invoice already paid stays on the account, and is applied to another invoice.
  await pay(orgId, { amountTzs: 380000, reference: 'NOTE-1', allocations: [{ invoiceId: inv.id, amountTzs: 380000 }] });
  const { note: lateDraft } = await note({ type: 'credit', amountTzs: 50000, reason: 'Goodwill' });
  const late = await finance.issueNote({ noteId: lateDraft.id, actorId: APPROVER });
  assert.deepEqual([late.note.status, late.note.amountPaidTzs, late.applied], ['issued', 0, []]);
  assert.equal((await finance.statement({ organizationId: orgId })).unappliedCreditNotesTzs, 50000);
  const applied = await finance.allocate({ creditInvoiceId: late.note.id, body: { allocations: [{ invoiceId: debit.id, amountTzs: 30000 }] }, actorId: CASHIER });
  assert.deepEqual([applied.invoices[0].status, applied.invoices[0].paidBy, applied.invoices[0].paymentReference], ['paid', 'credit_note', late.note.number]);
  assert.deepEqual([(await invoiceRow(late.note.id)).status, (await invoiceRow(late.note.id)).amountPaidTzs], ['partially_paid', 30000]);
  assert.equal((await finance.allocate({ creditInvoiceId: late.note.id, body: { allocations: [{ invoiceId: debit.id, amountTzs: 1 }] }, actorId: CASHIER })).error, 'invoice_not_open');

  // The invoice shows what was raised on it and what settled it.
  const detail = await billing.getInvoice({ invoiceId: inv.id });
  assert.deepEqual(detail.notes.map(n => [n.kind, n.totalTzs]).sort(), [['credit_note', -120000], ['credit_note', -50000], ['debit_note', 30000]].sort());
  assert.deepEqual(detail.settlements.map(s => [s.amountTzs, s.creditNoteNumber ?? s.reference]), [[120000, issued.note.number], [380000, 'NOTE-1']]);
  const audit = (await db('AuditLog').where({ target: draft.id })).map(a => a.action).sort();
  assert.deepEqual(audit, ['b2b.credit_note.create', 'b2b.invoice.issue']);
});

// ── Statement, aging, dashboard ──────────────────────────────────────────────

test('statement and aging: every document in date order with a running balance; what is late, and by how much', async () => {
  const orgId = await sponsor();
  const inv = await feeInvoice(orgId, 800000);
  await pay(orgId, { amountTzs: 300000, reference: 'STM-1', allocations: [{ invoiceId: inv.id, amountTzs: 300000 }] });
  const { note: draft } = await finance.createNote({ invoiceId: inv.id, body: { type: 'credit', amountTzs: 100000, reason: 'Discount' }, actorId: BILLER });
  await finance.issueNote({ noteId: draft.id, actorId: APPROVER });
  const bounced = await pay(orgId, { amountTzs: 50000, method: 'cheque', reference: 'STM-CHQ' });
  await finance.reversePayment({ paymentId: bounced.payment.id, reason: 'Returned', actorId: APPROVER });
  await pay(orgId, { amountTzs: 70000, reference: 'STM-2' });   // unallocated: credit on account

  const s = await finance.statement({ organizationId: orgId });
  assert.deepEqual(s.entries.map(e => [e.type, e.chargeTzs, e.creditTzs, e.balanceTzs]), [
    ['invoice', 800000, 0, 800000], ['payment', 0, 300000, 500000], ['credit_note', 0, 100000, 400000],
    ['payment', 0, 50000, 350000], ['payment_reversal', 50000, 0, 400000], ['payment', 0, 70000, 330000],
  ]);
  assert.deepEqual([s.openingBalanceTzs, s.closingBalanceTzs, s.outstandingTzs, s.overdueTzs, s.creditTzs, s.balanceTzs], [0, 330000, 400000, 0, 70000, 330000]);
  assert.deepEqual(s.aging, { current: 400000, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 });
  // A date range carries what came before as the opening balance.
  const tomorrow = await finance.statement({ organizationId: orgId, query: { from: addDays(TODAY, 1) } });
  assert.deepEqual([tomorrow.openingBalanceTzs, tomorrow.entries.length, tomorrow.closingBalanceTzs], [330000, 0, 330000]);
  assert.equal((await finance.statement({ organizationId: orgId, query: { from: 'yesterday' } })).error, 'invalid_from');

  // Forty-five days on, nothing more paid: it is 31–60 days overdue.
  const later = createB2BFinanceService({ db, users, b2bService, billing, now: () => new Date(Date.now() + 45 * 86_400_000) });
  const aged = await later.statement({ organizationId: orgId });
  assert.deepEqual([aged.overdueTzs, aged.aging.current, aged.aging.days31to60], [400000, 0, 400000]);
  const overview = await later.dashboard();
  const mine = overview.organizations.find(o => o.organizationId === orgId);
  assert.deepEqual([mine.invoicedTzs, mine.creditNotesTzs, mine.collectedTzs, mine.outstandingTzs, mine.overdueTzs, mine.creditTzs], [800000, 100000, 370000, 400000, 400000, 70000]);
  assert.ok(overview.totals.outstandingTzs >= 400000 && overview.totals.overdueTzs >= 400000);
  assert.deepEqual(Object.keys(overview.billedAgainstProviders.providerObligations).sort(), ['gymVisitsTzs', 'sponsoredPassesTzs', 'totalTzs', 'trainerSessionsTzs']);
  const billed = await finance.billedAgainstProviders({ period: PERIOD, organizationId: orgId });
  assert.deepEqual([billed.billedTzs, billed.providerObligations.totalTzs, billed.differenceTzs], [700000, 0, 700000]);   // invoice less its credit note; nothing owed to providers for a fee
  assert.match(billed.note, /Not revenue or profit/);
});

test('a company\'s old seat bills appear on its statement, read only', async () => {
  const { account } = await corporateService.onboard({ body: { companyName: `Finance Seats ${uid('c')}`, industrySector: 'banking', workforceBracket: '50-100', subsidyModel: 'copay_70_30', passTier: 'pro', seatLimit: 5 }, actorId: BILLER });
  made.corporates.push(account.id);
  await corporateService.setStatus({ corporateId: account.id, status: 'active', actorId: BILLER });
  const { employee } = await corporateService.provisionStaff({ corporateId: account.id, body: { displayName: 'Seat Holder', department: 'Ops' }, actorId: BILLER });
  await corporateService.setEmployeeStatus({ corporateId: account.id, employeeId: employee.id, status: 'active', actorId: BILLER });
  const { bill } = await corporateService.generateBill({ corporateId: account.id, period: LAST, actorId: BILLER });
  const orgId = (await b2bService.organizationForCorporate({ corporateId: account.id })).organization.id;

  const s = await finance.statement({ organizationId: orgId });
  assert.deepEqual(s.entries.map(e => [e.type, e.chargeTzs, e.status]), [['seat_bill', bill.employerTzs, 'unpaid']]);
  assert.deepEqual([s.outstandingTzs, s.seatBillsTzs, s.aging.current], [bill.employerTzs, bill.employerTzs, bill.employerTzs]);
  // Still settled where it always was; the statement follows.
  await corporateService.markBillPaid({ billId: bill.id, paymentReference: 'SEAT-1', actorId: BILLER });
  const paid = await finance.statement({ organizationId: orgId });
  assert.deepEqual([paid.entries.map(e => e.type), paid.outstandingTzs, paid.closingBalanceTzs], [['seat_bill', 'seat_bill_payment'], 0, 0]);
  assert.deepEqual(await db('CorporateBill').where({ id: bill.id }).first().then(b => [b.status, b.paymentReference]), ['paid', 'SEAT-1']);
});

// ── Security ─────────────────────────────────────────────────────────────────

test('security: an organisation sees only its own billing, only the right roles see money, and staff grants are separate', async () => {
  const orgA = await sponsor('A');
  const orgB = await sponsor('B');
  const invA = await feeInvoice(orgA, 200000);
  const invB = await feeInvoice(orgB, 900000);
  await pay(orgB, { amountTzs: 100000, reference: 'SEC-B' });
  const role = async (orgId, r) => {
    const sub = await user('member');
    await b2bService.addOrganizationUser({ access: await access(orgId), body: { userId: sub, role: r }, actorId: BILLER });
    return { sub, userType: 'member' };
  };
  const financeA = await role(orgA, 'finance');
  const ownerA = await role(orgA, 'owner');

  for (const claims of [financeA, ownerA]) {
    const overview = await call(getB2BOrganizationBilling, { claims, params: { id: orgA } });
    assert.deepEqual([overview.statusCode, overview.body.outstandingTzs, overview.body.terms.usageTermsDays], [200, 200000, 14]);
  }
  // HR, managers, analysts and viewers don't see money.
  for (const r of ['hr', 'manager', 'analyst', 'viewer']) {
    const claims = await role(orgA, r);
    for (const route of [getB2BOrganizationBilling, listB2BOrganizationInvoices, listB2BOrganizationPayments, getB2BOrganizationStatement]) {
      const out = await call(route, { claims, params: { id: orgA } });
      assert.deepEqual([out.statusCode, out.body.requiredPermission], [403, 'billing.read'], `${r} ${route.path}`);
    }
  }
  // Not another organisation's: not through its id, and not by naming its invoice under one's own.
  for (const route of [getB2BOrganizationBilling, listB2BOrganizationInvoices, listB2BOrganizationPayments, getB2BOrganizationStatement]) {
    assert.equal((await call(route, { claims: financeA, params: { id: orgB } })).statusCode, 404, route.path);
  }
  assert.equal((await call(getB2BOrganizationInvoice, { claims: financeA, params: { id: orgA, invoiceId: invB.id } })).statusCode, 404);
  const mine = await call(listB2BOrganizationInvoices, { claims: financeA, params: { id: orgA } });
  assert.deepEqual(mine.body.items.map(i => [i.id, i.outstandingTzs, i.overdue]), [[invA.id, 200000, false]]);
  assert.equal((await call(listB2BOrganizationPayments, { claims: financeA, params: { id: orgA } })).body.total, 0);
  // What the organisation is shown names no FitFlex staff member.
  const detail = await call(getB2BOrganizationInvoice, { claims: financeA, params: { id: orgA, invoiceId: invA.id } });
  assert.deepEqual(['issuedBy', 'createdBy', 'paidBy'].filter(k => k in detail.body.invoice), []);
  assert.deepEqual(detail.body.lines.map(l => [l.kind, l.amountTzs]), [['fee', 200000]]);
  const theirs = await call(listB2BOrganizationPayments, { claims: await role(orgB, 'finance'), params: { id: orgB } });
  assert.deepEqual(['recordedBy', 'note', 'legacy'].filter(k => k in theirs.body.items[0]), []);

  // An organisation user is not FitFlex staff: no recording, no reading across organisations.
  assert.equal((await call(adminRecordB2BPayment, { claims: ownerA, params: { id: orgA }, body: { amountTzs: 200000, method: 'cash', reference: 'SELF' } })).statusCode, 403);
  assert.equal((await call(adminB2BBillingDashboard, { claims: ownerA })).statusCode, 403);
  // Staff grants are separate: billing raises, approval issues notes and reverses, payments records.
  const staff = scopes => ({ sub: CASHIER, userType: 'admin', portalUser: true, aclPermissions: scopes });
  assert.equal((await call(adminRecordB2BPayment, { claims: staff(['b2b', 'b2b_billing', 'b2b_billing_approve']), params: { id: orgA }, body: {} })).body.requiredScope, 'b2b_payments');
  assert.equal((await call(adminIssueB2BNote, { claims: staff(['b2b', 'b2b_billing', 'b2b_payments']), params: { noteId: 'x' } })).body.requiredScope, 'b2b_billing_approve');
  assert.equal((await call(adminReverseB2BPayment, { claims: staff(['b2b_payments']), params: { paymentId: 'x' } })).body.requiredScope, 'b2b_billing_approve');
  assert.equal((await call(adminCreateB2BAgreement, { claims: staff(['b2b', 'b2b_payments']), params: { id: orgA }, body: {} })).body.requiredScope, 'b2b_billing');
  assert.equal((await call(adminB2BBillingDashboard, { claims: staff(['b2b_payments']) })).statusCode, 200);
  assert.equal((await call(adminB2BBillingDashboard, { claims: staff(['payments']) })).statusCode, 403);
  // Amounts come from the server: what a client sends as a total is ignored.
  const recorded = await call(adminRecordB2BPayment, { claims: staff(['b2b_payments']), params: { id: orgA },
    body: { amountTzs: 50000, method: 'mobile_money', reference: 'SEC-A', allocatedTzs: 999999, status: 'reversed', allocations: [{ invoiceId: invA.id, amountTzs: 50000, outstandingTzs: 0 }] } });
  assert.deepEqual([recorded.statusCode, recorded.body.payment.status, recorded.body.payment.allocatedTzs, recorded.body.invoices[0].amountPaidTzs], [201, 'received', 50000, 50000]);
});

// ── Book-keeping ─────────────────────────────────────────────────────────────

test('book-keeping counts money received from organisations once', async () => {
  const orgId = await sponsor();
  await enrol(orgId);
  const { programId } = await programme(orgId, PASS);
  const prepared = await billing.preparePrepaid({ programId, period: PERIOD, actorId: BILLER });
  await billing.issueInvoice({ invoiceId: prepared.invoice.id, vatRateBps: 0, actorId: BILLER });
  const paid = await pay(orgId, { amountTzs: PRO, reference: 'BOOK-1', allocations: [{ invoiceId: prepared.invoice.id, amountTzs: PRO }] });
  const entries = await financeService.bookKeeping({ paymentRequests, sponsorPayments: () => finance.paymentsForBooks() });
  const mine = entries.filter(e => e.reference === 'BOOK-1' || e.id === paid.payment.id);
  assert.deepEqual(mine.map(e => [e.type, e.category, e.amount]), [['income', 'b2b', PRO]]);
  // The sponsor's share recorded against the member's pass mirrors that money and is not counted again.
  const mirror = await db('PaymentRequest').where({ provider: 'sponsor_invoice', subscriptionId: (await db('B2BPassEntitlement').where({ programId }).first()).subscriptionId }).first();
  assert.ok(mirror);
  assert.equal(entries.some(e => e.id === mirror.id), false);
});
