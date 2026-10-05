// B2B Phase 6 against the CI database: where to pay, "we have paid" notices
// and their confirmation, payment reminders, the late-payment hold, and who
// may do what.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureInit } from '../functions/index.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { purgeB2BBilling } from './fixtures/ledger-cleanup.mjs';
import {
  gyms, b2bService, b2bProgramService, b2bConsumptionService as usage, b2bBillingService as billing, b2bFinanceService as finance,
  b2bCollectionsService as collections, signJwt as sign,
} from '../src/bootstrap/services.mjs';
import { createB2BCollectionsService, reminderStage } from '../src/services/b2b-collections-service.mjs';
import { ROLE_PERMISSIONS } from '../src/shared/b2b.mjs';
import { monthBounds } from '../src/shared/b2b-programs.mjs';
import { localDay, addDays } from '../src/shared/member-progress.mjs';
import {
  adminB2BCollections, adminSetB2BPaymentInstructions, adminConfirmB2BPaymentNotice, adminRejectB2BPaymentNotice, adminRemindB2BInvoice,
  adminSetB2BBillingHold, getB2BOrganizationPaying, submitB2BPaymentNotice, withdrawB2BPaymentNotice,
} from '../functions/b2b.mjs';
import { deliveredTo } from './fixtures/notification-language.mjs';

await ensureInit();

const uid = p => `${p}_${randomUUID().slice(0, 8)}`;
const made = { users: [], orgs: [], gyms: [] };
const TODAY = localDay(new Date());
const PERIOD = TODAY.slice(0, 7);
const priorInstructions = await db('B2BPaymentInstruction').where({ id: 'default' }).first();

async function user(userType = 'member') {
  const id = uid('usr');
  await db('User').insert({ id, userType, displayName: `Collections ${userType} ${id.slice(-4)}`, updatedAt: new Date() });
  made.users.push(id);
  return id;
}
const BILLER = await user('admin');
const CASHIER = await user('admin');
const ADMIN = { userType: 'admin', userId: BILLER };
const access = (organizationId, who = ADMIN) => b2bService.resolveAccess({ organizationId, ...who });

async function sponsor(name = 'employer') {
  const { organization } = await b2bService.createOrganization({ body: { organizationType: 'employer', legalName: `Collections ${name} ${uid('o')}`, email: 'accounts@collections.test' }, actorId: BILLER });
  made.orgs.push(organization.id);
  await b2bService.setOrganizationStatus({ organizationId: organization.id, status: 'active', actorId: BILLER });
  return organization.id;
}
async function orgUser(orgId, role) {
  const sub = await user('member');
  const out = await b2bService.addOrganizationUser({ access: await access(orgId), body: { userId: sub, role }, actorId: BILLER });
  assert.ok(!out.error, JSON.stringify(out));
  return { sub, userType: 'member' };
}
const as = (orgId, claims) => access(orgId, { userType: claims.userType, userId: claims.sub });

/** An issued fee invoice, due `termsDays` after today. */
async function feeInvoice(orgId, amountTzs, { termsDays = 0, period = PERIOD } = {}) {
  const { agreement } = await finance.createAgreement({ organizationId: orgId, body: { effectiveFrom: `${period}-01`, platformFeeTzs: amountTzs, prepaidTermsDays: termsDays }, actorId: BILLER });
  const live = await finance.activateAgreement({ agreementId: agreement.id, actorId: BILLER });
  assert.ok(live.agreement, JSON.stringify(live));
  const prepared = await finance.prepareFee({ organizationId: orgId, period, actorId: BILLER });
  assert.ok(prepared.invoice, JSON.stringify(prepared));
  const issued = await billing.issueInvoice({ invoiceId: prepared.invoice.id, vatRateBps: 0, actorId: BILLER });
  assert.equal(issued.invoice?.status, 'issued', JSON.stringify(issued));
  return issued.invoice;
}
const invoiceRow = id => db('B2BSponsorInvoice').where({ id }).first();
const notice = (orgId, claims, body) => as(orgId, claims).then(a => collections.submitNotice({ access: a, actorId: claims.sub, body: { method: 'bank_transfer', ...body } }));

/** A collections service on a day of its own, with what it sent kept. */
function onDay(day) {
  const sent = { inbox: [], email: [] };
  const svc = createB2BCollectionsService({
    db, finance, now: () => new Date(`${day}T08:00:00.000Z`),
    notify: async (userId, m) => { sent.inbox.push({ userId, ...m }); },
    email: { configured: true, send: async (to, m) => { sent.email.push({ to, ...m }); return { ok: true }; } },
  });
  return { svc, sent };
}

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
const staff = scopes => ({ sub: CASHIER, userType: 'admin', portalUser: true, aclPermissions: scopes });

after(async () => {
  await purgeB2BBilling(db, made.orgs);
  await db('Notification').whereIn('userId', made.users).del().catch(() => {});
  if (made.orgs.length) {
    await db('B2BOrganizationUser').whereIn('organizationId', made.orgs).del().catch(() => {});
    await db('B2BOrganization').whereIn('id', made.orgs).del();
  }
  for (const id of made.gyms) await gyms.removeAsync(g => g.id === id);
  await db('B2BPaymentInstruction').where({ id: 'default' }).del();
  if (priorInstructions) await db('B2BPaymentInstruction').insert(priorInstructions);
  await db('AuditLog').whereIn('actor', [...made.users, 'system:b2b-billing', 'system:b2b-collections']).del();
  await db('User').whereIn('id', made.users).del();
});

test('rules: which reminder an invoice is due, and who may send a payment notice', () => {
  const due = '2026-11-10';
  assert.deepEqual(
    ['2026-11-06', '2026-11-07', '2026-11-09', '2026-11-10', '2026-11-16', '2026-11-17', '2026-11-23', '2026-11-24', '2026-12-09', '2026-12-10', '2027-03-01'].map(d => reminderStage(due, d)),
    [null, 'before3', 'before3', 'due', 'due', 'plus7', 'plus7', 'plus14', 'plus14', 'plus30', 'plus30']);
  assert.equal(reminderStage(null, due), null);
  assert.deepEqual(Object.entries(ROLE_PERMISSIONS).filter(([, p]) => p.includes('billing.pay')).map(([r]) => r).sort(), ['admin', 'finance', 'owner']);
});

test('payment details: set by staff, shown to the organisation', async () => {
  const orgId = await sponsor();
  const fin = await orgUser(orgId, 'finance');
  const set = await collections.setInstructions({ body: { bankName: 'CRDB Bank', accountName: 'FitFlex Africa Ltd', accountNumber: '0150000000001', lipaNamba: '5550001', somethingElse: 'x' }, actorId: BILLER });
  assert.deepEqual([set.configured, set.instructions.accountNumber, set.instructions.branch, 'somethingElse' in set.instructions], [true, '0150000000001', null, false]);
  const paying = await collections.organizationPaying({ access: await as(orgId, fin) });
  assert.deepEqual([paying.instructions.bankName, paying.instructions.lipaNamba, paying.canPay, paying.onHold, paying.notices], ['CRDB Bank', '5550001', true, false, []]);
});

test('payment notice: sent once, checked by FitFlex, and confirming it records the payment', async () => {
  const orgId = await sponsor();
  const other = await sponsor('other');
  const fin = await orgUser(orgId, 'finance');
  const inv = await feeInvoice(orgId, 300000);
  const theirs = await feeInvoice(other, 100000);

  assert.equal((await notice(orgId, fin, { amountTzs: 0, reference: 'X' })).error, 'invalid_amount');
  assert.equal((await notice(orgId, fin, { amountTzs: 1000, reference: ' ' })).error, 'payment_reference_required');
  assert.equal((await notice(orgId, fin, { amountTzs: 1000, reference: 'X', method: 'barter' })).error, 'invalid_payment_method');
  assert.equal((await notice(orgId, fin, { amountTzs: 1000, reference: 'X', paidOn: addDays(TODAY, 1) })).error, 'paid_on_in_future');
  assert.equal((await notice(orgId, fin, { amountTzs: 1000, reference: 'X', proofUrl: 'javascript:alert(1)' })).error, 'invalid_proof_url');
  assert.equal((await notice(orgId, fin, { amountTzs: 1000, reference: 'X', invoiceIds: [theirs.id] })).error, 'invoice_not_found');

  const ref = uid('TRF');
  const first = await notice(orgId, fin, { amountTzs: 300000, reference: ref, invoiceIds: [inv.id], note: 'Fee' });
  assert.deepEqual([first.notice.status, first.notice.paidOn, first.notice.invoiceIds, 'decidedBy' in first.notice], ['submitted', TODAY, [inv.id], false]);
  // Telling FitFlex again is the same notice; a different amount under the same reference is a mistake.
  const again = await notice(orgId, fin, { amountTzs: 300000, reference: ref.toLowerCase() });
  assert.deepEqual([again.existing, again.notice.id], [true, first.notice.id]);
  assert.equal((await notice(orgId, fin, { amountTzs: 299000, reference: ref })).error, 'payment_reference_in_use');
  // Nothing is settled by the notice itself.
  assert.deepEqual(await invoiceRow(inv.id).then(i => [i.status, i.amountPaidTzs]), ['issued', 0]);
  const q = await collections.queue();
  assert.ok(q.notices.some(n => n.id === first.notice.id && n.organizationName && n.invoices[0].number === inv.number));

  // The person who issued the invoice cannot settle it: the payment is kept as credit for a colleague to allocate.
  const own = await notice(orgId, fin, { amountTzs: 5000, reference: uid('OWN'), invoiceIds: [inv.id] });
  const byIssuer = await collections.confirmNotice({ noticeId: own.notice.id, actorId: BILLER });
  assert.deepEqual([byIssuer.notice.status, byIssuer.allocations.length, byIssuer.skipped.map(s => s.reason), byIssuer.payment.unallocatedTzs], ['confirmed', 0, ['cannot_settle_own_invoice'], 5000]);

  const { sent } = onDay(TODAY);
  const confirmed = await createB2BCollectionsService({ db, finance, notify: async (userId, m) => { sent.inbox.push({ userId, ...m }); } })
    .confirmNotice({ noticeId: first.notice.id, body: { note: 'On the statement' }, actorId: CASHIER });
  assert.deepEqual([confirmed.notice.status, confirmed.notice.decidedBy, confirmed.payment.amountTzs, confirmed.payment.reference, confirmed.settled.length], ['confirmed', CASHIER, 300000, ref, 1]);
  assert.match(confirmed.payment.number, /^FF-RCT-\d{4}-\d{6}$/);
  assert.deepEqual(await invoiceRow(inv.id).then(i => [i.status, i.amountPaidTzs]), ['paid', 300000]);
  assert.deepEqual(sent.inbox.map(m => [m.userId, m.type]), [[fin.sub, 'b2b_payment_confirmed']]);
  // Confirming again changes nothing: one payment.
  assert.equal((await collections.confirmNotice({ noticeId: first.notice.id, actorId: CASHIER })).unchanged, true);
  assert.equal(await db('B2BPayment').where({ organizationId: orgId }).whereRaw('lower("reference") = ?', [ref.toLowerCase()]).then(r => r.length), 1);
  // The organisation sees its notice decided, and not by whom.
  const mine = (await collections.organizationNotices({ access: await as(orgId, fin) })).items.find(n => n.id === first.notice.id);
  assert.deepEqual([mine.status, mine.paymentId, 'decidedBy' in mine], ['confirmed', confirmed.payment.id, false]);
});

test('payment notice: the statement shows another amount, a notice is rejected with a reason, or taken back', async () => {
  const orgId = await sponsor();
  const fin = await orgUser(orgId, 'finance');
  const inv = await feeInvoice(orgId, 500000);

  // The bank shows less than the organisation said: what arrived is what is recorded.
  const short = await notice(orgId, fin, { amountTzs: 500000, reference: uid('SHORT') });
  const confirmed = await collections.confirmNotice({ noticeId: short.notice.id, body: { amountTzs: 450000 }, actorId: CASHIER });
  assert.deepEqual([confirmed.payment.amountTzs, confirmed.allocations.map(a => a.amountTzs)], [450000, [450000]]);
  assert.deepEqual(await invoiceRow(inv.id).then(i => [i.status, i.amountPaidTzs]), ['partially_paid', 450000]);

  const wrong = await notice(orgId, fin, { amountTzs: 50000, reference: uid('WRONG'), invoiceIds: [inv.id] });
  assert.equal((await collections.rejectNotice({ noticeId: wrong.notice.id, reason: ' ', actorId: CASHIER })).error, 'reason_required');
  const { sent } = onDay(TODAY);
  const rejected = await createB2BCollectionsService({ db, finance, notify: async (userId, m) => { sent.inbox.push({ userId, ...m }); } })
    .rejectNotice({ noticeId: wrong.notice.id, reason: 'Not on our statement', actorId: CASHIER });
  assert.deepEqual([rejected.notice.status, rejected.notice.decisionNote, rejected.notice.paymentId], ['rejected', 'Not on our statement', null]);
  assert.match(sent.inbox[0].body, /Not on our statement/);
  // The organisation's people read it in their own language; the reason stays as staff wrote it.
  const swNo = await deliveredTo(sent.inbox[0], 'sw');
  assert.equal(swNo.title, 'Malipo hayajathibitishwa');
  assert.match(swNo.body, /^FitFlex haikuweza kuthibitisha malipo yako ya TZS .*: Not on our statement$/);
  assert.equal((await deliveredTo(sent.inbox[0], null)).title, 'Payment not confirmed');
  assert.equal((await collections.confirmNotice({ noticeId: wrong.notice.id, actorId: CASHIER })).error, 'notice_already_decided');
  assert.deepEqual(await invoiceRow(inv.id).then(i => i.amountPaidTzs), 450000);
  // A rejected reference can be sent again, corrected.
  assert.equal((await notice(orgId, fin, { amountTzs: 50000, reference: wrong.notice.reference })).notice.status, 'submitted');

  const mistaken = await notice(orgId, fin, { amountTzs: 1000, reference: uid('OOPS') });
  const a = await as(orgId, fin);
  assert.equal((await collections.withdrawNotice({ access: a, noticeId: mistaken.notice.id, actorId: fin.sub })).notice.status, 'withdrawn');
  assert.equal((await collections.confirmNotice({ noticeId: mistaken.notice.id, actorId: CASHIER })).error, 'notice_already_decided');
  assert.equal((await collections.withdrawNotice({ access: a, noticeId: short.notice.id, actorId: fin.sub })).error, 'notice_already_decided');
});

test('reminders: each stage once, to owners and finance and the billing email, and never for a paid invoice', async () => {
  const orgId = await sponsor();
  const owner = await orgUser(orgId, 'owner');
  const fin = await orgUser(orgId, 'finance');
  await orgUser(orgId, 'hr');
  const inv = await feeInvoice(orgId, 400000, { termsDays: 5 });
  const due = addDays(TODAY, 5);
  assert.equal(inv.dueDate, due);
  const mine = sent => sent.inbox.filter(m => m.data.invoiceId === inv.id);

  const early = onDay(addDays(due, -4));
  await early.svc.runReminders();
  assert.equal(mine(early.sent).length, 0);

  const before = onDay(addDays(due, -2));
  await before.svc.runReminders();
  assert.deepEqual(mine(before.sent).map(m => [m.userId, m.title]).sort(), [[fin.sub, 'Invoice due soon'], [owner.sub, 'Invoice due soon']].sort());
  assert.deepEqual(before.sent.email.filter(e => e.subject.includes(inv.number)).map(e => e.to), ['accounts@collections.test']);
  // In the app the reminder follows the reader's language; the email stays English.
  const swSoon = await deliveredTo(mine(before.sent)[0], 'sw');
  assert.equal(swSoon.title, 'Ankara inakaribia kulipwa');
  assert.match(swSoon.body, new RegExp(`^Ankara ${inv.number} \\(TZS [\\d,]+\\) inapaswa kulipwa tarehe \\d{4}-\\d\\d-\\d\\d\\.$`));
  const enSoon = await deliveredTo(mine(before.sent)[0], null);
  assert.equal(enSoon.title, 'Invoice due soon');
  assert.match(enSoon.body, new RegExp(`^Invoice ${inv.number} \\(TZS [\\d,]+\\) is due on \\d{4}-\\d\\d-\\d\\d\\.$`));
  assert.match(before.sent.email.find(e => e.subject.includes(inv.number)).subject, /^Invoice due soon: /);
  await before.svc.runReminders();   // a rerun sends nothing more
  assert.equal(mine(before.sent).length, 2);

  const stages = [];
  for (const [offset, title] of [[0, 'Invoice due today'], [3, null], [7, 'Invoice overdue'], [20, 'Invoice overdue'], [45, 'Invoice overdue'], [90, null]]) {
    const d = onDay(addDays(due, offset));
    await d.svc.runReminders();
    stages.push(mine(d.sent).length);
    if (title) assert.equal(mine(d.sent)[0].title, title, `day ${offset}`);
  }
  assert.deepEqual(stages, [2, 0, 2, 2, 2, 0]);
  assert.deepEqual((await db('B2BInvoiceReminder').where({ invoiceId: inv.id }).orderBy('sentAt')).map(r => [r.stage, r.outstandingTzs, r.recipients.length, r.emailedTo, r.sentBy]),
    ['before3', 'due', 'plus7', 'plus14', 'plus30'].map(s => [s, 400000, 2, 'accounts@collections.test', 'system:b2b-collections']));

  // Staff can send one by hand whatever was sent before; the queue shows the last one.
  const late = onDay(addDays(due, 50));
  const manual = await late.svc.remindNow({ invoiceId: inv.id, actorId: BILLER });
  assert.deepEqual([manual.sent, manual.stage, manual.recipients], [true, 'manual', 2]);
  assert.match(mine(late.sent)[0].body, /50 days overdue/);
  const row = (await late.svc.queue()).overdue.find(i => i.id === inv.id);
  assert.deepEqual([row.daysOverdue, row.outstandingTzs, row.lastReminder.stage, row.lastReminder.count, row.onHold], [50, 400000, 'manual', 6, false]);

  // Paid: no more reminders, by schedule or by hand.
  const paidInv = await feeInvoice(await sponsor('paid'), 100000);
  await finance.recordPayment({ organizationId: paidInv.organizationId, body: { amountTzs: 100000, method: 'cash', reference: uid('PAID'), allocations: [{ invoiceId: paidInv.id, amountTzs: 100000 }] }, actorId: CASHIER });
  const after30 = onDay(addDays(TODAY, 40));
  await after30.svc.runReminders();
  assert.equal(after30.sent.inbox.filter(m => m.data.invoiceId === paidInv.id).length, 0);
  assert.equal((await after30.svc.remindNow({ invoiceId: paidInv.id, actorId: BILLER })).error, 'invoice_not_chaseable');
});

test('hold: put on by staff with a reason; no new pass invoices and no funded visits until it is lifted', async () => {
  const g = { id: uid('gym') };
  await gyms.insertAsync({ id: g.id, name: 'Collections Gym', tier: 'standard', location: 'Dar es Salaam', status: 'active', ratePerDay: 5000 });
  made.gyms.push(g.id);
  const orgId = await sponsor();
  const fin = await orgUser(orgId, 'finance');
  const memberId = await user('member');
  await b2bService.enrollBeneficiary({ access: await access(orgId), body: { userId: memberId, status: 'active' }, actorId: BILLER });
  const a = await access(orgId);
  const { program } = await b2bProgramService.createProgram({ access: a, body: { name: 'Collections programme', startDate: '2026-01-01' }, actorId: BILLER });
  for (const body of [{ name: 'Gym visits', benefitType: 'gym_access', fundingType: 'full', usagePeriod: 'unlimited' }, { name: 'Pro pass', benefitType: 'sponsored_pass', passTier: 'pro', fundingType: 'full' }]) {
    const made1 = await b2bProgramService.createBenefit({ access: a, programId: program.id, body, actorId: BILLER });
    assert.ok(made1.benefit, JSON.stringify(made1));
    await b2bProgramService.setBenefitStatus({ access: a, programId: program.id, benefitId: made1.benefit.id, status: 'active', actorId: BILLER });
  }
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'pending', actorId: BILLER });
  await b2bProgramService.setProgramStatus({ access: a, programId: program.id, status: 'active', actorId: BILLER });
  const visit = () => usage.consume({ userId: memberId, sourceType: 'gym_checkin', sourceId: uid('chk'), provider: { type: 'gym', id: g.id, tier: 'standard' }, grossTzs: 5000 });
  const next = monthBounds(PERIOD).nextPeriod;

  assert.equal((await visit()).consumed, true);
  assert.equal((await collections.setHold({ organizationId: orgId, body: { onHold: true }, actorId: BILLER })).error, 'reason_required');
  const held = await collections.setHold({ organizationId: orgId, body: { onHold: true, reason: 'Invoice 45 days overdue' }, actorId: BILLER });
  assert.deepEqual([held.onHold, held.holdReason], [true, 'Invoice 45 days overdue']);
  assert.deepEqual(await collections.onHold([orgId]).then(s => [...s]), [orgId]);

  assert.equal((await visit()).consumed, false);
  const refused = await billing.preparePrepaid({ programId: program.id, period: next, actorId: BILLER });
  assert.deepEqual([refused.error, refused.status, refused.reason], ['organization_on_hold', 409, 'Invoice 45 days overdue']);
  const paying = await collections.organizationPaying({ access: await as(orgId, fin) });
  assert.deepEqual([paying.onHold, paying.holdReason], [true, 'Invoice 45 days overdue']);
  assert.equal((await finance.getBillingAccount({ organizationId: orgId })).account.onHold, true);
  assert.ok((await collections.queue()).onHold.some(h => h.organizationId === orgId && h.organizationName));
  // Changing the billing contact does not lift it.
  await finance.setBillingAccount({ organizationId: orgId, body: { contactName: 'Accounts' }, actorId: BILLER });
  assert.equal((await finance.getBillingAccount({ organizationId: orgId })).account.onHold, true);

  const lifted = await collections.setHold({ organizationId: orgId, body: { onHold: false }, actorId: BILLER });
  assert.deepEqual([lifted.onHold, lifted.holdReason], [false, null]);
  assert.equal((await visit()).consumed, true);
  assert.ok((await billing.preparePrepaid({ programId: program.id, period: next, actorId: BILLER })).invoice);
  assert.deepEqual((await db('AuditLog').where({ target: orgId }).whereIn('action', ['b2b.billing_hold.set', 'b2b.billing_hold.lift']).orderBy('at')).map(r => r.action), ['b2b.billing_hold.set', 'b2b.billing_hold.lift']);
});

test('security: only the right roles send a notice, only their own organisation, and staff grants are separate', async () => {
  const orgA = await sponsor('A');
  const orgB = await sponsor('B');
  const invB = await feeInvoice(orgB, 100000);
  const financeA = await orgUser(orgA, 'finance');
  const body = { amountTzs: 1000, method: 'cash', reference: uid('SEC') };

  const sentA = await call(submitB2BPaymentNotice, { claims: financeA, params: { id: orgA }, body: { ...body, status: 'confirmed', paymentId: 'x', organizationId: orgB } });
  assert.deepEqual([sentA.statusCode, sentA.body.notice.status, sentA.body.notice.organizationId, sentA.body.notice.paymentId], [201, 'submitted', orgA, null]);
  assert.equal((await call(submitB2BPaymentNotice, { claims: financeA, params: { id: orgA }, body })).statusCode, 200);
  for (const r of ['hr', 'manager', 'analyst', 'viewer']) {
    const claims = await orgUser(orgA, r);
    assert.equal((await call(submitB2BPaymentNotice, { claims, params: { id: orgA }, body: { ...body, reference: uid('R') } })).statusCode, 403, r);
    assert.deepEqual((await call(getB2BOrganizationPaying, { claims, params: { id: orgA } })).body.requiredPermission, 'billing.read', r);
  }
  // Not another organisation's: its account, its invoices, or its notices.
  assert.equal((await call(getB2BOrganizationPaying, { claims: financeA, params: { id: orgB } })).statusCode, 404);
  assert.equal((await call(submitB2BPaymentNotice, { claims: financeA, params: { id: orgB }, body })).statusCode, 404);
  assert.equal((await call(submitB2BPaymentNotice, { claims: financeA, params: { id: orgA }, body: { ...body, reference: uid('X'), invoiceIds: [invB.id] } })).body.error, 'invoice_not_found');
  const financeB = await orgUser(orgB, 'finance');
  assert.equal((await call(withdrawB2BPaymentNotice, { claims: financeB, params: { id: orgB, noticeId: sentA.body.notice.id } })).body.error, 'notice_not_found');

  // An organisation user is not FitFlex staff.
  for (const route of [adminConfirmB2BPaymentNotice, adminRejectB2BPaymentNotice, adminB2BCollections, adminSetB2BBillingHold, adminSetB2BPaymentInstructions, adminRemindB2BInvoice]) {
    assert.equal((await call(route, { claims: financeA, params: { id: orgA, noticeId: sentA.body.notice.id, invoiceId: invB.id }, body: { onHold: false } })).statusCode, 403, route.path);
  }
  // Staff grants are separate: payments confirms, billing reminds, approval holds and sets the payment details.
  assert.equal((await call(adminConfirmB2BPaymentNotice, { claims: staff(['b2b', 'b2b_billing', 'b2b_billing_approve']), params: { noticeId: 'x' } })).body.requiredScope, 'b2b_payments');
  assert.equal((await call(adminRejectB2BPaymentNotice, { claims: staff(['b2b_billing']), params: { noticeId: 'x' } })).body.requiredScope, 'b2b_payments');
  assert.equal((await call(adminRemindB2BInvoice, { claims: staff(['b2b', 'b2b_payments']), params: { invoiceId: 'x' } })).body.requiredScope, 'b2b_billing');
  assert.equal((await call(adminSetB2BBillingHold, { claims: staff(['b2b_billing', 'b2b_payments']), params: { id: orgA }, body: {} })).body.requiredScope, 'b2b_billing_approve');
  assert.equal((await call(adminSetB2BPaymentInstructions, { claims: staff(['b2b_billing', 'b2b_payments']), body: {} })).body.requiredScope, 'b2b_billing_approve');
  assert.equal((await call(adminB2BCollections, { claims: staff(['b2b_payments']) })).statusCode, 200);
  assert.equal((await call(adminB2BCollections, { claims: staff(['payments']) })).statusCode, 403);
  const done = await call(adminConfirmB2BPaymentNotice, { claims: staff(['b2b_payments']), params: { noticeId: sentA.body.notice.id }, body: {} });
  assert.deepEqual([done.statusCode, done.body.notice.status, done.body.payment.amountTzs], [200, 'confirmed', 1000]);
});
