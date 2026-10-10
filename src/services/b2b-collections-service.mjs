// B2B collections (Phase 6): how an organisation pays an invoice, and how
// FitFlex chases one that is late.
//
//   payment details   where to pay: FitFlex's bank account and Lipa Namba,
//                     shown on every invoice
//   payment notice    the organisation says "we have paid": amount, day,
//                     reference, which invoices. FitFlex checks it against
//                     the bank or mobile-money statement and confirms it,
//                     which records the payment through the finance service
//                     (so the same reference is still one payment, and the
//                     person who issued an invoice still cannot settle it),
//                     or rejects it with a reason
//   reminders         3 days before the due day, on it, and 7, 14 and 30
//                     days after; each sent once per invoice, to the
//                     organisation's owners and finance users and to its
//                     billing email. Staff can also send one by hand.
//   hold              staff put a late payer on hold and lift it. On hold,
//                     no new sponsored-pass invoice is prepared and per-use
//                     benefits are not funded. Passes already paid for carry on.
//
// There is no payment gateway, no interest or penalty, and nothing is put on
// hold automatically (decisions P6-01 to P6-04, 4 Oct 2026).
import { randomUUID } from 'node:crypto';
import { PAYMENT_METHODS, OPEN_STATUSES, outstandingTzs, daysOverdue, isDay } from '../shared/b2b-billing.mjs';
import { localDay, addDays } from '../shared/member-progress.mjs';

const INSTRUCTION = 'B2BPaymentInstruction';
const NOTICE = 'B2BPaymentNotice';
const REMINDER = 'B2BInvoiceReminder';
const ACCOUNT = 'B2BBillingAccount';
const INVOICE = 'B2BSponsorInvoice';
const BILLING_READ = 'billing.read';
const BILLING_PAY = 'billing.pay';
const SYSTEM = 'system:b2b-collections';
/** Who hears about money owed. */
const REMINDER_ROLES = ['owner', 'finance'];
const INSTRUCTION_FIELDS = Object.freeze({ bankName: 120, accountName: 160, accountNumber: 60, branch: 120, swiftCode: 20, lipaNamba: 40, lipaNambaName: 160, notes: 1000 });

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const text = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const tzs = n => `TZS ${Number(n).toLocaleString('en-US')}`;

/**
 * The reminder an invoice is due on `today`, or null. Stages do not pile up:
 * an invoice first seen 15 days late gets the 14-day reminder, not three.
 */
export function reminderStage(dueDate, today) {
  if (!dueDate) return null;
  if (today < dueDate) return today >= addDays(dueDate, -3) ? 'before3' : null;
  const late = daysOverdue(dueDate, today);
  if (late >= 30) return 'plus30';
  if (late >= 14) return 'plus14';
  if (late >= 7) return 'plus7';
  return 'due';
}

function reminderMessage({ stage, invoice, owed, today }) {
  const late = daysOverdue(invoice.dueDate, today);
  const what = `Invoice ${invoice.number} (${tzs(owed)})`;
  if (stage === 'before3') return { title: 'Invoice due soon', body: `${what} is due on ${invoice.dueDate}.` };
  if (late === 0) return { title: 'Invoice due today', body: `${what} is due today.` };
  return { title: 'Invoice overdue', body: `${what} was due on ${invoice.dueDate} and is ${late} day${late === 1 ? '' : 's'} overdue.` };
}

export function createB2BCollectionsService({
  db, finance,
  // Tell one person in the app: (userId, { id, type, title, body, data }) => Promise
  notify = async () => null,
  // { configured, send(to, { subject, text }) }
  email = { configured: false },
  now = () => new Date(),
}) {
  const stamp = () => new Date(now());
  const today = () => localDay(now());
  const audit = (q, { actor, action, target, before = null, after = null }) => q('AuditLog').insert({
    id: randomUUID(), at: stamp(), actor: actor ?? null, action, target,
    before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });
  const can = (access, permission) => access.platformAdmin || access.permissions.includes(permission);
  const refuse = permission => fail('forbidden', 403, { requiredPermission: permission });

  // ── Payment details ───────────────────────────────────────────────────────

  async function getInstructions() {
    const row = await db(INSTRUCTION).where({ id: 'default' }).first();
    const instructions = Object.fromEntries(Object.keys(INSTRUCTION_FIELDS).map(k => [k, row?.[k] ?? null]));
    return { instructions: { ...instructions, updatedAt: row?.updatedAt ?? null }, configured: !!(instructions.accountNumber || instructions.lipaNamba) };
  }

  async function setInstructions({ body = {}, actorId }) {
    const patch = Object.fromEntries(Object.entries(INSTRUCTION_FIELDS).map(([k, max]) => [k, text(body[k], max)]));
    await db.transaction(async (trx) => {
      const prior = await trx(INSTRUCTION).where({ id: 'default' }).forUpdate().first();
      const row = { ...patch, updatedBy: actorId ?? null, updatedAt: stamp() };
      if (prior) await trx(INSTRUCTION).where({ id: 'default' }).update(row);
      else await trx(INSTRUCTION).insert({ id: 'default', ...row }).onConflict('id').merge(row);
      await audit(trx, { actor: actorId, action: 'b2b.payment_instructions.update', target: 'default', before: prior ?? null, after: patch });
    });
    return getInstructions();
  }

  // ── Payment notices ───────────────────────────────────────────────────────

  const noticeView = n => ({ ...n, invoiceIds: Array.isArray(n.invoiceIds) ? n.invoiceIds : JSON.parse(n.invoiceIds || '[]') });
  /** What the organisation sees: not who at FitFlex decided. */
  const noticeForOrganization = ({ decidedBy, ...n }) => n;

  async function withInvoices(notices) {
    const ids = [...new Set(notices.flatMap(n => n.invoiceIds))];
    const rows = ids.length ? await db(INVOICE).whereIn('id', ids).select('id', 'number', 'totalTzs', 'amountPaidTzs', 'status', 'dueDate') : [];
    const byId = new Map(rows.map(i => [i.id, { ...i, outstandingTzs: outstandingTzs(i) }]));
    return notices.map(n => ({ ...n, invoices: n.invoiceIds.map(id => byId.get(id)).filter(Boolean) }));
  }

  /**
   * "We have paid." Nothing is settled until FitFlex confirms it. The same
   * reference by the same method is the same notice: sending it again
   * returns the first one.
   */
  async function submitNotice({ access, body = {}, actorId }) {
    if (!can(access, BILLING_PAY)) return refuse(BILLING_PAY);
    if (!actorId) return fail('actor_required', 403);
    if (!Number.isInteger(body.amountTzs) || body.amountTzs <= 0) return fail('invalid_amount', 400, { hint: 'whole TZS, more than zero' });
    if (!PAYMENT_METHODS.includes(body.method)) return fail('invalid_payment_method', 400, { allowed: PAYMENT_METHODS });
    const reference = text(body.reference, 200);
    if (!reference) return fail('payment_reference_required', 400);
    const paidOn = body.paidOn ?? today();
    if (!isDay(paidOn)) return fail('invalid_paid_on', 400);
    if (paidOn > today()) return fail('paid_on_in_future', 400);
    const proofUrl = text(body.proofUrl, 1000);
    // https, or this machine while developing.
    if (proofUrl && !/^(https:\/\/|http:\/\/localhost[:/])/i.test(proofUrl)) return fail('invalid_proof_url', 400);

    const invoiceIds = [...new Set(Array.isArray(body.invoiceIds) ? body.invoiceIds.filter(x => typeof x === 'string') : [])];
    if (invoiceIds.length > 50) return fail('too_many_invoices', 400);
    if (invoiceIds.length) {
      const rows = await db(INVOICE).whereIn('id', invoiceIds).where({ organizationId: access.org.id });
      if (rows.length !== invoiceIds.length) return fail('invoice_not_found', 404);
      const closed = rows.filter(i => !OPEN_STATUSES.includes(i.status) || i.totalTzs <= 0);
      if (closed.length) return fail('invoice_not_payable', 409, { invoices: closed.map(i => i.number ?? i.id) });
    }

    const same = () => db(NOTICE).where({ organizationId: access.org.id, method: body.method }).whereIn('status', ['submitted', 'confirmed'])
      .whereRaw('lower("reference") = ?', [reference.toLowerCase()]).first();
    const existing = n => (n.amountTzs === body.amountTzs
      ? { notice: noticeForOrganization(noticeView(n)), existing: true }
      : fail('payment_reference_in_use', 409, { noticeId: n.id, amountTzs: n.amountTzs }));
    const prior = await same();
    if (prior) return existing(prior);

    const at = stamp();
    try {
      const [row] = await db(NOTICE).insert({
        id: newId('b2bpn'), organizationId: access.org.id, amountTzs: body.amountTzs, method: body.method, reference, paidOn,
        invoiceIds: JSON.stringify(invoiceIds), note: text(body.note, 1000), proofUrl, status: 'submitted',
        submittedBy: actorId, submittedAt: at, createdAt: at, updatedAt: at,
      }).returning('*');
      await audit(db, { actor: actorId, action: 'b2b.payment_notice.submit', target: row.id, after: row });
      return { notice: noticeForOrganization(noticeView(row)) };
    } catch (err) {
      if (err.code !== '23505') throw err;   // the same reference sent twice at once
      const winner = await same();
      if (!winner) throw err;
      return existing(winner);
    }
  }

  /** The organisation takes back a notice FitFlex has not decided yet. */
  async function withdrawNotice({ access, noticeId, actorId }) {
    if (!can(access, BILLING_PAY)) return refuse(BILLING_PAY);
    return db.transaction(async (trx) => {
      const n = await trx(NOTICE).where({ id: noticeId, organizationId: access.org.id }).forUpdate().first();
      if (!n) return fail('notice_not_found', 404);
      if (n.status === 'withdrawn') return { notice: noticeForOrganization(noticeView(n)), unchanged: true };
      if (n.status !== 'submitted') return fail('notice_already_decided', 409, { noticeStatus: n.status });
      const [row] = await trx(NOTICE).where({ id: n.id }).update({ status: 'withdrawn', updatedAt: stamp() }).returning('*');
      await audit(trx, { actor: actorId, action: 'b2b.payment_notice.withdraw', target: n.id, before: { status: n.status }, after: { status: 'withdrawn' } });
      return { notice: noticeForOrganization(noticeView(row)) };
    });
  }

  async function listNotices({ organizationId = null, query = {} } = {}) {
    let q = db(NOTICE).orderBy('submittedAt', 'desc').limit(Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 200));
    if (organizationId) q = q.where({ organizationId });
    if (query.status) q = q.where({ status: String(query.status) });
    const notices = await withInvoices((await q).map(noticeView));
    if (organizationId) return { items: notices };
    const orgIds = [...new Set(notices.map(n => n.organizationId))];
    const orgs = orgIds.length ? await db('B2BOrganization').whereIn('id', orgIds).select('id', 'legalName', 'tradingName') : [];
    const names = new Map(orgs.map(o => [o.id, o.tradingName || o.legalName]));
    return { items: notices.map(n => ({ ...n, organizationName: names.get(n.organizationId) ?? null })) };
  }

  async function organizationNotices({ access, query = {} }) {
    if (!can(access, BILLING_READ)) return refuse(BILLING_READ);
    const out = await listNotices({ organizationId: access.org.id, query });
    return { items: out.items.map(noticeForOrganization) };
  }

  async function tellOrganization(organizationId, message) {
    const people = await db('B2BOrganizationUser').where({ organizationId, status: 'active' }).whereIn('role', REMINDER_ROLES).select('userId');
    const told = [];
    for (const { userId } of people) {
      const m = message(userId);
      // One inbox row per person: the id makes a resend a no-op.
      try { await notify(userId, { ...m, id: `${m.id}_${userId}`.slice(0, 120) }); told.push(userId); } catch { /* one person's inbox never blocks the rest */ }
    }
    return told;
  }

  /**
   * FitFlex found the money: record the payment. `amountTzs` overrides the
   * amount when the statement shows a different one. The invoices the notice
   * names are settled first, oldest due first; without any, the oldest open
   * invoices are. Invoices the confirming person issued are left for a
   * colleague, and what is not allocated stays on the account as credit.
   */
  async function confirmNotice({ noticeId, body = {}, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const n = await db(NOTICE).where({ id: noticeId }).first();
    if (!n) return fail('notice_not_found', 404);
    if (n.status === 'confirmed') return { notice: noticeView(n), unchanged: true };
    if (n.status !== 'submitted') return fail('notice_already_decided', 409, { noticeStatus: n.status });
    if (n.submittedBy === actorId) return fail('cannot_confirm_own_notice', 403);
    const amountTzs = body.amountTzs ?? n.amountTzs;
    if (!Number.isInteger(amountTzs) || amountTzs <= 0) return fail('invalid_amount', 400);

    const named = noticeView(n).invoiceIds;
    const skipped = [];
    let allocations = null;
    if (named.length) {
      allocations = [];
      let left = amountTzs;
      for (const inv of await db(INVOICE).whereIn('id', named).where({ organizationId: n.organizationId }).orderBy('dueDate').orderBy('issuedAt')) {
        const owed = outstandingTzs(inv);
        if (left <= 0 || owed <= 0) continue;
        if (inv.issuedBy === actorId) { skipped.push({ invoiceId: inv.id, reason: 'cannot_settle_own_invoice' }); continue; }
        const take = Math.min(left, owed);
        allocations.push({ invoiceId: inv.id, amountTzs: take });
        left -= take;
      }
    }
    const paid = await finance.recordPayment({
      organizationId: n.organizationId, actorId,
      body: {
        amountTzs, method: n.method, reference: n.reference, receivedAt: `${n.paidOn}T09:00:00.000Z`,   // midday EAT on the day paid
        note: text(body.note, 1000) ?? `Payment notice ${n.id}`,
        ...(allocations ? { allocations } : { autoAllocate: true }),
      },
    });
    if (paid.error) return paid;

    const at = stamp();
    const [row] = await db(NOTICE).where({ id: n.id, status: 'submitted' })
      .update({ status: 'confirmed', decidedBy: actorId, decidedAt: at, decisionNote: text(body.note, 1000), paymentId: paid.payment.id, updatedAt: at }).returning('*');
    if (!row) return { notice: noticeView(await db(NOTICE).where({ id: n.id }).first()), unchanged: true };   // a colleague confirmed it first; the payment is the same one
    await audit(db, { actor: actorId, action: 'b2b.payment_notice.confirm', target: n.id, before: { status: 'submitted' }, after: { status: 'confirmed', paymentId: paid.payment.id, amountTzs } });
    await tellOrganization(n.organizationId, () => ({
      id: `b2bpn_ok_${n.id}`, type: 'b2b_payment_confirmed', title: 'Payment received',
      body: `FitFlex has confirmed your payment of ${tzs(amountTzs)} (${n.reference}). Receipt ${paid.payment.number}.`,
      data: { organizationId: n.organizationId, noticeId: n.id, paymentId: paid.payment.id },
    }));
    return { notice: noticeView(row), payment: paid.payment, allocations: paid.allocations ?? [], settled: paid.settled ?? [], skipped: [...skipped, ...(paid.skipped ?? [])] };
  }

  /** The money cannot be found, or the notice is wrong. The organisation is told why. */
  async function rejectNotice({ noticeId, reason, actorId }) {
    const why = text(reason);
    if (!why) return fail('reason_required', 400);
    if (!actorId) return fail('actor_required', 403);
    const out = await db.transaction(async (trx) => {
      const n = await trx(NOTICE).where({ id: noticeId }).forUpdate().first();
      if (!n) return fail('notice_not_found', 404);
      if (n.status === 'rejected') return { notice: noticeView(n), unchanged: true };
      if (n.status !== 'submitted') return fail('notice_already_decided', 409, { noticeStatus: n.status });
      const at = stamp();
      const [row] = await trx(NOTICE).where({ id: n.id }).update({ status: 'rejected', decidedBy: actorId, decidedAt: at, decisionNote: why, updatedAt: at }).returning('*');
      await audit(trx, { actor: actorId, action: 'b2b.payment_notice.reject', target: n.id, before: { status: 'submitted' }, after: { status: 'rejected', reason: why } });
      return { notice: noticeView(row) };
    });
    if (out.error || out.unchanged) return out;
    await tellOrganization(out.notice.organizationId, () => ({
      id: `b2bpn_no_${out.notice.id}`, type: 'b2b_payment_not_found', title: 'Payment not confirmed',
      body: `FitFlex could not confirm your payment of ${tzs(out.notice.amountTzs)} (${out.notice.reference}): ${why}`,
      data: { organizationId: out.notice.organizationId, noticeId: out.notice.id },
    }));
    return out;
  }

  // ── Reminders ─────────────────────────────────────────────────────────────

  /** Invoices with money owed and a due day; credit notes are never chased. */
  const chaseable = q => q(INVOICE).whereIn('status', OPEN_STATUSES).where('totalTzs', '>', 0).whereNotNull('dueDate');

  async function sendReminder({ invoice, stage, sentBy }) {
    const owed = outstandingTzs(invoice);
    const day = today();
    const id = newId('b2brm');
    // The row is the claim: a scheduled stage that is already there is not sent again.
    const claimed = await db(REMINDER).insert({
      id, invoiceId: invoice.id, organizationId: invoice.organizationId, stage, outstandingTzs: owed, sentBy, sentAt: stamp(),
    }).onConflict(db.raw('("invoiceId", "stage") WHERE "stage" <> \'manual\'')).ignore().returning('id');
    if (!claimed.length) return { sent: false, reason: 'already_sent' };

    const message = reminderMessage({ stage, invoice, owed, today: day });
    const recipients = await tellOrganization(invoice.organizationId, () => ({
      id: `${id}`, type: 'b2b_invoice_reminder', ...message,
      data: { organizationId: invoice.organizationId, invoiceId: invoice.id, stage },
    }));
    let emailedTo = null;
    if (email.configured) {
      const to = (await finance.getBillingAccount({ organizationId: invoice.organizationId })).account?.email;
      if (to) {
        const pay = (await getInstructions()).instructions;
        const lines = [message.body, '',
          pay.accountNumber ? `Bank: ${[pay.bankName, pay.accountName, pay.accountNumber, pay.branch].filter(Boolean).join(', ')}` : null,
          pay.lipaNamba ? `Lipa Namba: ${[pay.lipaNamba, pay.lipaNambaName].filter(Boolean).join(' · ')}` : null,
          `Please quote ${invoice.number} as the payment reference, then tell us in the FitFlex portal under Billing so we can confirm it.`,
          '', 'If you have already paid, thank you; no further action is needed once we confirm it.'].filter(l => l !== null);
        const sent = await email.send(to, { subject: `${message.title}: ${invoice.number}`, text: lines.join('\n') });
        if (sent?.ok) emailedTo = to;
      }
    }
    await db(REMINDER).where({ id }).update({ recipients: JSON.stringify(recipients), emailedTo });
    return { sent: true, reminderId: id, stage, recipients: recipients.length, emailedTo };
  }

  /** The daily run: every open invoice gets the reminder its age calls for, once. */
  async function runReminders() {
    const day = today();
    const stats = { checked: 0, sent: 0, failed: 0 };
    for (const invoice of await chaseable(db)) {
      stats.checked += 1;
      const stage = reminderStage(invoice.dueDate, day);
      if (!stage) continue;
      try {
        if ((await sendReminder({ invoice, stage, sentBy: SYSTEM })).sent) stats.sent += 1;
      } catch (err) {
        stats.failed += 1;
        console.warn(`[b2b-collections] reminder for ${invoice.id} failed: ${err.message}`);
      }
    }
    return stats;
  }

  /** Staff send a reminder now, whatever has been sent before. */
  async function remindNow({ invoiceId, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const invoice = await chaseable(db).where({ id: invoiceId }).first();
    if (!invoice) return fail('invoice_not_chaseable', 409, { hint: 'Only an issued invoice with money owed and a due date can be chased.' });
    const out = await sendReminder({ invoice, stage: 'manual', sentBy: actorId });
    await audit(db, { actor: actorId, action: 'b2b.invoice.remind', target: invoiceId, after: out });
    return out;
  }

  // ── Hold ──────────────────────────────────────────────────────────────────

  /** Organisations on hold among `organizationIds` (all of them when omitted). */
  async function onHold(organizationIds = null, q = db) {
    let rows = q(ACCOUNT).where({ onHold: true }).select('organizationId');
    if (organizationIds) rows = rows.whereIn('organizationId', organizationIds);
    return new Set((await rows).map(r => r.organizationId));
  }

  async function setHold({ organizationId, body = {}, actorId }) {
    if (typeof body.onHold !== 'boolean') return fail('invalid_hold', 400, { hint: 'onHold: true | false' });
    const why = text(body.reason);
    if (body.onHold && !why) return fail('reason_required', 400);
    if (!actorId) return fail('actor_required', 403);
    if (!(await db('B2BOrganization').where({ id: organizationId }).first('id'))) return fail('organization_not_found', 404);
    const at = stamp();
    const patch = body.onHold
      ? { onHold: true, holdReason: why, holdBy: actorId, holdAt: at, updatedAt: at }
      : { onHold: false, holdReason: null, holdBy: null, holdAt: null, updatedAt: at };
    await db.transaction(async (trx) => {
      const prior = await trx(ACCOUNT).where({ organizationId }).forUpdate().first();
      if (prior) await trx(ACCOUNT).where({ organizationId }).update(patch);
      else await trx(ACCOUNT).insert({ id: newId('b2bba'), organizationId, ...patch }).onConflict('organizationId').merge(patch);
      await audit(trx, { actor: actorId, action: body.onHold ? 'b2b.billing_hold.set' : 'b2b.billing_hold.lift', target: organizationId,
        before: { onHold: prior?.onHold ?? false, holdReason: prior?.holdReason ?? null }, after: { onHold: body.onHold, reason: why } });
    });
    return { organizationId, onHold: body.onHold, holdReason: patch.holdReason, holdAt: patch.holdAt };
  }

  // ── What needs attention ──────────────────────────────────────────────────

  /** FitFlex's collections queue: notices to check, and invoices past due with what has been sent. */
  async function queue() {
    const day = today();
    const notices = (await listNotices({ query: { status: 'submitted' } })).items;
    const overdue = (await chaseable(db).where('dueDate', '<', day).orderBy('dueDate')).map(i => ({ ...i, outstandingTzs: outstandingTzs(i), daysOverdue: daysOverdue(i.dueDate, day) }));
    const orgIds = [...new Set(overdue.map(i => i.organizationId))];
    const orgs = orgIds.length ? await db('B2BOrganization').whereIn('id', orgIds).select('id', 'legalName', 'tradingName') : [];
    const names = new Map(orgs.map(o => [o.id, o.tradingName || o.legalName]));
    const held = await db(ACCOUNT).where({ onHold: true }).select('organizationId', 'holdReason', 'holdAt');
    const heldIds = new Set(held.map(h => h.organizationId));
    const last = new Map();
    if (overdue.length) {
      for (const r of await db(REMINDER).whereIn('invoiceId', overdue.map(i => i.id)).orderBy('sentAt')) {
        last.set(r.invoiceId, { stage: r.stage, sentAt: r.sentAt, count: (last.get(r.invoiceId)?.count ?? 0) + 1 });
      }
    }
    const heldNames = held.filter(h => !names.has(h.organizationId)).map(h => h.organizationId);
    for (const o of heldNames.length ? await db('B2BOrganization').whereIn('id', heldNames).select('id', 'legalName', 'tradingName') : []) names.set(o.id, o.tradingName || o.legalName);
    return {
      today: day,
      notices,
      overdue: overdue.map(i => ({
        id: i.id, number: i.number, kind: i.kind, organizationId: i.organizationId, organizationName: names.get(i.organizationId) ?? null,
        dueDate: i.dueDate, daysOverdue: i.daysOverdue, totalTzs: i.totalTzs, outstandingTzs: i.outstandingTzs,
        lastReminder: last.get(i.id) ?? null, onHold: heldIds.has(i.organizationId),
      })),
      onHold: held.map(h => ({ ...h, organizationName: names.get(h.organizationId) ?? null })),
      totals: { noticesToCheck: notices.length, overdueInvoices: overdue.length, overdueTzs: overdue.reduce((n, i) => n + i.outstandingTzs, 0), organizationsOnHold: held.length },
    };
  }

  /** What an organisation needs in order to pay: where, whether it is on hold, and its notices. */
  async function organizationPaying({ access }) {
    if (!can(access, BILLING_READ)) return refuse(BILLING_READ);
    const account = await db(ACCOUNT).where({ organizationId: access.org.id }).first();
    return {
      ...(await getInstructions()),
      canPay: can(access, BILLING_PAY),
      onHold: account?.onHold === true,
      holdReason: account?.onHold ? account.holdReason : null,
      notices: (await organizationNotices({ access })).items,
    };
  }

  return {
    getInstructions, setInstructions,
    submitNotice, withdrawNotice, listNotices, organizationNotices, confirmNotice, rejectNotice,
    runReminders, remindNow, onHold, setHold, queue, organizationPaying,
  };
}
