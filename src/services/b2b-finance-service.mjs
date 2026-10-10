// B2B billing and financial management (Phase 5): what FitFlex charges an
// organisation, what it has paid, and what it still owes.
//
//   organisation → commercial agreement → programme → benefit → consumption
//     → sponsor responsibility → invoice line → invoice → payment → balance
//
// The invoice engine itself is b2b-billing-service (flat-fee passes and
// per-use charges). This service adds what surrounds it:
//
//   agreements    how one organisation is charged: payment terms, an optional
//                 monthly platform fee, an optional default VAT rate. Dated.
//   payments      money received, with the bank or mobile-money reference;
//                 the same reference is one payment
//   allocation    a payment (or a credit note) settles one or more invoices,
//                 in part or in full; what is left over stays on the
//                 organisation's account as credit
//   notes         a credit or debit note corrects an issued invoice, which is
//                 never edited; raised by one person, issued by another
//   statement     the organisation's account, with aging
//   reconciliation  every invoice amount traced to the usage or the pass it
//                 charges for, and, separately, to what providers are owed
//
// Customer billing and provider settlement stay separate: nothing here reads
// a settlement to work out a charge, and nothing here pays a provider. The
// settlement tables are only read, to show the two side by side.
//
// Every change runs in one transaction with the rows it touches locked, and
// its audit entry is written in the same transaction.
import { randomUUID } from 'node:crypto';
import {
  readAgreement, readPayment, termsSnapshot, documentNumber, outstandingTzs, agingBucket, emptyAging,
  OPEN_STATUSES, BILLED_STATUSES, NOTE_KINDS, DEFAULT_TERMS,
} from '../shared/b2b-billing.mjs';
import { isMonth, monthBounds } from '../shared/b2b-programs.mjs';
import { localDay, addDays } from '../shared/member-progress.mjs';

const AGREEMENT = 'B2BCommercialAgreement';
const ACCOUNT = 'B2BBillingAccount';
const INVOICE = 'B2BSponsorInvoice';
const LINE = 'B2BSponsorInvoiceLine';
const PAYMENT = 'B2BPayment';
const ALLOCATION = 'B2BPaymentAllocation';
const BILLING_READ = 'billing.read';
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const text = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const sum = (rows, key) => rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);

/** The next gap-free number of a series in a year. Call inside the transaction that uses it. */
export async function nextDocumentNumber(trx, series, year) {
  const { rows } = await trx.raw(
    `INSERT INTO "B2BDocumentCounter" ("series", "year", "last") VALUES (?, ?, 1)
     ON CONFLICT ("series", "year") DO UPDATE SET "last" = "B2BDocumentCounter"."last" + 1 RETURNING "last"`, [series, year]);
  return documentNumber(series, year, rows[0].last);
}

/** The agreement in force for an organisation on an EAT day, if any. */
export async function agreementInForce(q, organizationId, day) {
  return (await q(AGREEMENT).where({ organizationId }).whereIn('status', ['active', 'ended'])
    .where('effectiveFrom', '<=', day).where(b => b.whereNull('effectiveTo').orWhere('effectiveTo', '>=', day))
    .orderBy('effectiveFrom', 'desc').first()) ?? null;
}

export function createB2BFinanceService({
  db, users, b2bService,
  // The invoice engine: issue, and what happens when a prepaid invoice is settled.
  billing,
  now = () => new Date(),
}) {
  const stamp = () => new Date(now());
  const today = () => localDay(now());
  const audit = (trx, { actor, action, target, before = null, after = null }) => trx('AuditLog').insert({
    id: randomUUID(), at: stamp(), actor: actor ?? null, action, target,
    before: before == null ? null : JSON.stringify(before), after: after == null ? null : JSON.stringify(after),
  });
  const organizationRow = (q, id) => q('B2BOrganization').where({ id });

  // ── Commercial agreements ─────────────────────────────────────────────────

  async function listAgreements({ organizationId }) {
    const agreements = await db(AGREEMENT).where({ organizationId }).orderBy([{ column: 'effectiveFrom', order: 'desc' }, { column: 'createdAt', order: 'desc' }]);
    return { agreements, inForce: await agreementInForce(db, organizationId, today()) };
  }

  async function createAgreement({ organizationId, body = {}, actorId }) {
    if (!(await organizationRow(db, organizationId).first('id'))) return fail('organization_not_found', 404);
    const read = readAgreement(body);
    if (read.error) return read;
    return db.transaction(async (trx) => {
      const id = newId('b2bag');
      const reference = await nextDocumentNumber(trx, 'AGR', Number(read.patch.effectiveFrom.slice(0, 4)));
      const [agreement] = await trx(AGREEMENT).insert({ id, organizationId, reference, status: 'draft', ...read.patch, createdBy: actorId ?? null }).returning('*');
      await audit(trx, { actor: actorId, action: 'b2b.agreement.create', target: id, after: agreement });
      return { agreement };
    });
  }

  /** A draft can be changed freely; one in force is ended and replaced instead. */
  async function updateAgreement({ agreementId, body = {}, actorId }) {
    return db.transaction(async (trx) => {
      const prior = await trx(AGREEMENT).where({ id: agreementId }).forUpdate().first();
      if (!prior) return fail('agreement_not_found', 404);
      if (prior.status !== 'draft') return fail('agreement_in_force', 409, { hint: 'End it and activate a new agreement.' });
      const read = readAgreement({ ...prior, ...body });
      if (read.error) return read;
      const [agreement] = await trx(AGREEMENT).where({ id: agreementId }).update({ ...read.patch, updatedAt: stamp() }).returning('*');
      await audit(trx, { actor: actorId, action: 'b2b.agreement.update', target: agreementId, before: prior, after: agreement });
      return { agreement };
    });
  }

  /**
   * Put a draft in force. The agreement it replaces is closed the day before
   * the new one starts, so exactly one applies to any day. Dates that overlap
   * an agreement already ended are refused: history is not rewritten.
   */
  async function activateAgreement({ agreementId, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    return db.transaction(async (trx) => {
      const draft = await trx(AGREEMENT).where({ id: agreementId }).first();
      if (!draft) return fail('agreement_not_found', 404);
      await organizationRow(trx, draft.organizationId).forUpdate().first();   // one activation at a time per organisation
      const prior = await trx(AGREEMENT).where({ id: agreementId }).forUpdate().first();
      if (prior.status !== 'draft') return fail('invalid_transition', 409, { from: prior.status, to: 'active' });
      const at = stamp();
      const others = await trx(AGREEMENT).where({ organizationId: prior.organizationId }).whereIn('status', ['active', 'ended']).forUpdate();
      const end = prior.effectiveTo ?? '9999-12-31';
      for (const o of others) {
        const overlaps = o.effectiveFrom <= end && (o.effectiveTo ?? '9999-12-31') >= prior.effectiveFrom;
        if (!overlaps) continue;
        // Only the agreement currently open may be cut short, and only by one that starts after it.
        if (o.status !== 'active' || o.effectiveFrom >= prior.effectiveFrom) return fail('agreement_dates_overlap', 409, { with: o.reference });
        const closeOn = addDays(prior.effectiveFrom, -1);
        await trx(AGREEMENT).where({ id: o.id }).update({ status: 'ended', effectiveTo: closeOn, endedAt: at, endedBy: actorId, updatedAt: at });
        await audit(trx, { actor: actorId, action: 'b2b.agreement.end', target: o.id, before: { status: o.status, effectiveTo: o.effectiveTo }, after: { status: 'ended', effectiveTo: closeOn, replacedBy: prior.reference } });
      }
      const [agreement] = await trx(AGREEMENT).where({ id: agreementId }).update({ status: 'active', activatedAt: at, activatedBy: actorId, updatedAt: at }).returning('*');
      await audit(trx, { actor: actorId, action: 'b2b.agreement.activate', target: agreementId, before: prior, after: agreement });
      return { agreement };
    });
  }

  /** End an agreement in force on a given day (today or later). Invoices already issued keep its terms. */
  async function endAgreement({ agreementId, effectiveTo, actorId }) {
    return db.transaction(async (trx) => {
      const prior = await trx(AGREEMENT).where({ id: agreementId }).forUpdate().first();
      if (!prior) return fail('agreement_not_found', 404);
      if (prior.status !== 'active') return fail('invalid_transition', 409, { from: prior.status, to: 'ended' });
      const on = effectiveTo ?? today();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on < prior.effectiveFrom) return fail('invalid_effective_to', 400);
      const at = stamp();
      const [agreement] = await trx(AGREEMENT).where({ id: agreementId }).update({ status: 'ended', effectiveTo: on, endedAt: at, endedBy: actorId ?? null, updatedAt: at }).returning('*');
      await audit(trx, { actor: actorId, action: 'b2b.agreement.end', target: agreementId, before: prior, after: agreement });
      return { agreement };
    });
  }

  // ── Billing account ───────────────────────────────────────────────────────

  /** Who invoices go to. For a company moved over from Corporate, its billing contact there is used until one is set here. */
  async function getBillingAccount({ organizationId }) {
    const org = await organizationRow(db, organizationId).first();
    if (!org) return fail('organization_not_found', 404);
    const stored = await db(ACCOUNT).where({ organizationId }).first();
    const corporate = org.legacyCorporateId ? await db('CorporateAccount').where({ id: org.legacyCorporateId }).first() : null;
    const account = {
      organizationId,
      contactName: stored?.contactName ?? corporate?.billingContactName ?? null,
      email: stored?.email ?? corporate?.billingContactEmail ?? org.email ?? null,
      phone: stored?.phone ?? corporate?.billingContactPhone ?? org.phone ?? null,
      address: stored?.address ?? org.address ?? null,
      taxIdentificationNumber: org.taxIdentificationNumber ?? null,
      registrationNumber: org.registrationNumber ?? null,
      currency: 'TZS',
      notes: stored?.notes ?? null,
      onHold: stored?.onHold === true, holdReason: stored?.onHold ? stored.holdReason : null, holdAt: stored?.onHold ? stored.holdAt : null,
      source: stored ? 'billing_account' : corporate ? 'corporate_account' : 'organization',
    };
    return { account };
  }

  async function setBillingAccount({ organizationId, body = {}, actorId }) {
    if (!(await organizationRow(db, organizationId).first('id'))) return fail('organization_not_found', 404);
    if (body.email != null && body.email !== '' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email))) return fail('invalid_email', 400);
    const patch = {
      contactName: text(body.contactName, 160), email: text(body.email, 200)?.toLowerCase() ?? null, phone: text(body.phone, 40),
      address: body.address && typeof body.address === 'object' ? JSON.stringify(body.address) : null,
      notes: text(body.notes, 1000), updatedBy: actorId ?? null, updatedAt: stamp(),
    };
    await db.transaction(async (trx) => {
      const prior = await trx(ACCOUNT).where({ organizationId }).forUpdate().first();
      if (prior) await trx(ACCOUNT).where({ organizationId }).update(patch);
      else await trx(ACCOUNT).insert({ id: newId('b2bba'), organizationId, ...patch }).onConflict('organizationId').merge(patch);
      await audit(trx, { actor: actorId, action: 'b2b.billing_account.update', target: organizationId, before: prior ?? null, after: patch });
    });
    return getBillingAccount({ organizationId });
  }

  // ── Platform fee ──────────────────────────────────────────────────────────

  /**
   * The month's platform fee, as a draft invoice of its own, when the
   * agreement in force on the first day of the month carries one. One fee
   * invoice per organisation and month, whoever asks and however often.
   */
  async function prepareFee({ organizationId, period, actorId }) {
    if (!isMonth(period)) return fail('invalid_period', 400);
    const org = await organizationRow(db, organizationId).first();
    if (!org) return fail('organization_not_found', 404);
    if (org.status !== 'active') return fail('organization_not_active', 409);
    const { startDate } = monthBounds(period);
    const agreement = await agreementInForce(db, organizationId, startDate);
    if (!agreement?.platformFeeTzs) return { invoice: null, added: 0, reason: agreement ? 'no_platform_fee' : 'no_agreement' };
    try {
      return await db.transaction(async (trx) => {
        const existing = await trx(INVOICE).where({ organizationId, period, kind: 'fee' }).whereNot({ status: 'void' }).first();
        if (existing) return { invoice: existing, added: 0 };
        const id = newId('b2bi');
        const [invoice] = await trx(INVOICE).insert({
          id, number: `DRAFT-${id.slice(-8).toUpperCase()}`, organizationId, programId: null, period, kind: 'fee', status: 'draft',
          totalTzs: agreement.platformFeeTzs, agreementId: agreement.id, createdBy: actorId ?? null,
        }).returning('*');
        await trx(LINE).insert({
          id: newId('b2bl'), invoiceId: id, kind: 'fee', description: `Wellness platform fee · ${period}`,
          quantity: 1, unitTzs: agreement.platformFeeTzs, amountTzs: agreement.platformFeeTzs,
        });
        await audit(trx, { actor: actorId, action: 'b2b.invoice.prepare', target: id, after: { period, kind: 'fee', totalTzs: agreement.platformFeeTzs, agreement: agreement.reference } });
        return { invoice, added: 1 };
      });
    } catch (err) {
      if (err.code !== '23505') throw err;   // prepared at the same moment by someone else
      return { invoice: await db(INVOICE).where({ organizationId, period, kind: 'fee' }).whereNot({ status: 'void' }).first(), added: 0 };
    }
  }

  /** Daily: draft the platform-fee invoices that are due (this month; next month from the 25th). Drafts only. */
  async function prepareFeesDue({ actorId = 'system:b2b-billing' } = {}) {
    const day = today();
    const periods = [day.slice(0, 7), ...(Number(day.slice(8)) >= 25 ? [monthBounds(day.slice(0, 7)).nextPeriod] : [])];
    const organizationIds = await db(AGREEMENT).whereIn('status', ['active', 'ended']).whereNotNull('platformFeeTzs').distinct('organizationId').pluck('organizationId');
    const stats = { drafted: 0, failed: 0 };
    for (const organizationId of organizationIds) {
      for (const period of periods) {
        try {
          const r = await prepareFee({ organizationId, period, actorId });
          if (r.added) stats.drafted += 1;
        } catch (err) {
          stats.failed += 1;
          console.warn(`[b2b-finance] platform fee ${period} for ${organizationId} failed:`, err?.message);
        }
      }
    }
    return stats;
  }

  // ── Payments and allocation ───────────────────────────────────────────────

  const paymentView = p => ({ ...p, unallocatedTzs: p.status === 'received' ? p.amountTzs - p.allocatedTzs : 0 });

  /**
   * Settle invoices from one source (a payment, or a credit note), inside
   * `trx`. Everything is locked first; amounts are checked against what is
   * left on both sides, so the same allocation sent twice does nothing the
   * second time. Returns { allocations, invoices, settled } or { error }.
   */
  async function allocateIn(trx, { paymentId = null, creditInvoiceId = null, items, actorId, requestId = null }) {
    if (!Array.isArray(items) || !items.length) return fail('allocations_required', 400);
    for (const it of items) {
      if (!it?.invoiceId || !Number.isInteger(it.amountTzs) || it.amountTzs <= 0) return fail('invalid_allocation', 400);
    }
    if (new Set(items.map(i => i.invoiceId)).size !== items.length) return fail('duplicate_invoice_in_allocation', 400);
    if (requestId) {
      const seen = await trx(ALLOCATION).where('requestId', requestId).orWhere('requestId', 'like', `${requestId}:%`);
      if (seen.length) return { allocations: seen, invoices: await trx(INVOICE).whereIn('id', seen.map(a => a.invoiceId)), settled: [], existing: true };
    }

    let source;
    let available;
    if (paymentId) {
      source = await trx(PAYMENT).where({ id: paymentId }).forUpdate().first();
      if (!source) return fail('payment_not_found', 404);
      if (source.status !== 'received') return fail('payment_reversed', 409);
      available = source.amountTzs - source.allocatedTzs;
    } else {
      source = await trx(INVOICE).where({ id: creditInvoiceId }).forUpdate().first();
      if (!source || source.totalTzs >= 0) return fail('credit_not_found', 404);
      if (!OPEN_STATUSES.includes(source.status)) return fail('credit_not_available', 409, { status: source.status });
      available = -outstandingTzs(source);
    }
    const wanted = sum(items, 'amountTzs');
    if (wanted > available) return fail('exceeds_unallocated', 409, { unallocatedTzs: available, requestedTzs: wanted });

    const at = stamp();
    const allocations = [];
    const invoices = [];
    const settled = [];
    const ordered = [...items].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));   // one lock order, whoever allocates
    for (const [n, it] of ordered.entries()) {
      const invoice = await trx(INVOICE).where({ id: it.invoiceId }).forUpdate().first();
      if (!invoice || invoice.organizationId !== source.organizationId) return fail('invoice_not_found', 404, { invoiceId: it.invoiceId });
      if (invoice.totalTzs <= 0) return fail('nothing_to_settle', 409, { invoiceId: invoice.id });
      if (!OPEN_STATUSES.includes(invoice.status)) return fail('invoice_not_open', 409, { invoiceId: invoice.id, status: invoice.status });
      // Maker-checker: whoever issued an invoice does not record its payment.
      if (paymentId && invoice.issuedBy === actorId) return fail('cannot_settle_own_invoice', 403, { invoiceId: invoice.id });
      const owed = outstandingTzs(invoice);
      if (it.amountTzs > owed) return fail('exceeds_outstanding', 409, { invoiceId: invoice.id, outstandingTzs: owed });

      const [allocation] = await trx(ALLOCATION).insert({
        id: newId('b2ba'), organizationId: source.organizationId, paymentId, creditInvoiceId, invoiceId: invoice.id, amountTzs: it.amountTzs,
        requestId: requestId ? (n === 0 ? requestId : `${requestId}:${n}`) : null, allocatedBy: actorId ?? null, createdAt: at,
      }).returning('*');
      const paid = invoice.amountPaidTzs + it.amountTzs;
      const full = paid === invoice.totalTzs;
      const patch = { amountPaidTzs: paid, status: full ? 'paid' : 'partially_paid', updatedAt: at };
      if (full) Object.assign(patch, { paidAt: at, paidBy: paymentId ? actorId : 'credit_note', paymentReference: paymentId ? source.reference : source.number });
      const [updated] = await trx(INVOICE).where({ id: invoice.id }).update(patch).returning('*');
      await audit(trx, { actor: actorId, action: 'b2b.payment.allocate', target: invoice.id,
        before: { status: invoice.status, amountPaidTzs: invoice.amountPaidTzs },
        after: { status: updated.status, amountPaidTzs: paid, allocationId: allocation.id, amountTzs: it.amountTzs, paymentId, creditInvoiceId } });
      allocations.push(allocation);
      invoices.push(updated);
      if (full) settled.push(updated);
    }

    if (paymentId) {
      await trx(PAYMENT).where({ id: paymentId }).update({ allocatedTzs: source.allocatedTzs + wanted, updatedAt: at });
    } else {
      const applied = source.amountPaidTzs + wanted;
      const done = applied === Math.abs(source.totalTzs);
      await trx(INVOICE).where({ id: source.id }).update({
        amountPaidTzs: applied, status: done ? 'paid' : 'partially_paid', updatedAt: at,
        ...(done ? { paidAt: at, paidBy: 'applied', paymentReference: invoices.map(i => i.number).join(', ').slice(0, 200) } : {}),
      });
    }
    return { allocations, invoices, settled };
  }

  /** What follows a settled invoice, after the transaction: the passes a prepaid invoice paid for can start. */
  async function afterSettled(settled, actorId) {
    const out = {};
    for (const inv of settled) {
      if (inv.kind !== 'prepaid' || !billing?.advanceEntitlements) continue;
      try {
        out[inv.id] = await billing.advanceEntitlements({ invoiceId: inv.id, actorId });
      } catch (err) {
        console.warn(`[b2b-finance] passes for ${inv.number} not started (the daily job retries):`, err?.message);
      }
    }
    return out;
  }

  /** Open invoices of an organisation, oldest due first: the order a payment settles them in. */
  const openInvoices = (q, organizationId) => q(INVOICE).where({ organizationId }).whereIn('status', OPEN_STATUSES).where('totalTzs', '>', 0)
    .orderByRaw('"dueDate" ASC NULLS LAST, "issuedAt" ASC, "id" ASC');

  /**
   * Record money received from an organisation. The same reference by the
   * same method is the same payment: recording it again returns the first
   * one. `allocations` settles named invoices; `autoAllocate` settles the
   * oldest due first. Anything left stays on the account as credit.
   */
  async function recordPayment({ organizationId, body = {}, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const read = readPayment(body);
    if (read.error) return read;
    if (!(await organizationRow(db, organizationId).first('id'))) return fail('organization_not_found', 404);
    const same = q => q(PAYMENT).where({ organizationId, method: read.patch.method, status: 'received', legacy: false })
      .whereRaw('lower("reference") = ?', [read.patch.reference.toLowerCase()]).first();
    const existing = p => (p.amountTzs === read.patch.amountTzs
      ? { payment: paymentView(p), existing: true }
      : fail('payment_reference_in_use', 409, { paymentId: p.id, amountTzs: p.amountTzs }));

    let result;
    try {
      result = await db.transaction(async (trx) => {
        const prior = await same(trx);
        if (prior) return existing(prior);
        const at = stamp();
        const received = read.patch.receivedAt ?? at;
        if (received > new Date(+at + 86_400_000)) return fail('received_in_future', 400);
        const id = newId('b2bp');
        const number = await nextDocumentNumber(trx, 'RCT', Number(localDay(at).slice(0, 4)));
        const [payment] = await trx(PAYMENT).insert({
          id, number, organizationId, amountTzs: read.patch.amountTzs, currency: 'TZS', method: read.patch.method, reference: read.patch.reference,
          receivedAt: received, status: 'received', note: read.patch.note, recordedBy: actorId,
        }).returning('*');
        await audit(trx, { actor: actorId, action: 'b2b.payment.record', target: id, after: payment });

        let items = Array.isArray(body.allocations) ? body.allocations : null;
        const skipped = [];
        if (!items && body.autoAllocate) {
          items = [];
          let left = payment.amountTzs;
          for (const inv of await openInvoices(trx, organizationId)) {
            if (left <= 0) break;
            if (inv.issuedBy === actorId) { skipped.push({ invoiceId: inv.id, reason: 'cannot_settle_own_invoice' }); continue; }
            const take = Math.min(left, outstandingTzs(inv));
            items.push({ invoiceId: inv.id, amountTzs: take });
            left -= take;
          }
        }
        if (!items?.length) return { payment: paymentView(payment), allocations: [], invoices: [], settled: [], skipped };
        const allocated = await allocateIn(trx, { paymentId: id, items, actorId });
        if (allocated.error) throw Object.assign(new Error(allocated.error), { refusal: allocated });   // nothing is kept
        return { payment: paymentView(await trx(PAYMENT).where({ id }).first()), ...allocated, skipped };
      });
    } catch (err) {
      if (err.refusal) return err.refusal;
      if (err.code !== '23505') throw err;   // the same reference recorded at the same moment
      const winner = await same(db);
      if (!winner) throw err;
      return existing(winner);
    }
    if (result.settled?.length) result.activation = await afterSettled(result.settled, actorId);
    return result;
  }

  /** Settle invoices from a payment already recorded, or from a credit note. */
  async function allocate({ paymentId = null, creditInvoiceId = null, body = {}, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const result = await db.transaction(async (trx) => {
      const out = await allocateIn(trx, { paymentId, creditInvoiceId, items: body.allocations, actorId, requestId: text(body.requestId, 120) });
      if (out.error) throw Object.assign(new Error(out.error), { refusal: out });
      return out;
    }).catch((err) => {
      if (err.refusal) return err.refusal;
      throw err;
    });
    if (result.error) return result;
    if (paymentId) result.payment = paymentView(await db(PAYMENT).where({ id: paymentId }).first());
    if (result.settled?.length) result.activation = await afterSettled(result.settled, actorId);
    return result;
  }

  /**
   * A payment that did not arrive after all (a bounced cheque, a reference
   * typed against the wrong company). What it had settled is opened again.
   * A paid invoice is final, so a payment that completed one is not reversed:
   * a debit note records what is owed instead.
   */
  async function reversePayment({ paymentId, reason, actorId }) {
    const why = text(reason);
    if (!why) return fail('reason_required', 400);
    if (!actorId) return fail('actor_required', 403);
    return db.transaction(async (trx) => {
      const payment = await trx(PAYMENT).where({ id: paymentId }).forUpdate().first();
      if (!payment) return fail('payment_not_found', 404);
      if (payment.status === 'reversed') return { payment: paymentView(payment), unchanged: true };
      const allocations = await trx(ALLOCATION).where({ paymentId, active: true }).orderBy('invoiceId');
      const invoices = [];
      for (const a of allocations) invoices.push(await trx(INVOICE).where({ id: a.invoiceId }).forUpdate().first());
      const final = invoices.filter(i => i.status === 'paid');
      if (final.length) return fail('payment_settled_invoices', 409, { invoices: final.map(i => i.number), hint: 'A paid invoice is final. Raise a debit note for what is owed.' });
      const at = stamp();
      for (const a of allocations) {
        const inv = await trx(INVOICE).where({ id: a.invoiceId }).first();
        const paid = inv.amountPaidTzs - a.amountTzs;
        await trx(INVOICE).where({ id: inv.id }).update({ amountPaidTzs: paid, status: paid > 0 ? 'partially_paid' : 'issued', updatedAt: at });
        await trx(ALLOCATION).where({ id: a.id }).update({ active: false, reversedAt: at, reversedBy: actorId });
      }
      const [updated] = await trx(PAYMENT).where({ id: paymentId })
        .update({ status: 'reversed', allocatedTzs: 0, reversedAt: at, reversedBy: actorId, reversalReason: why, updatedAt: at }).returning('*');
      await audit(trx, { actor: actorId, action: 'b2b.payment.reverse', target: paymentId, before: payment, after: { ...updated, reopened: invoices.map(i => i.number) } });
      return { payment: paymentView(updated), reopened: invoices.map(i => i.id) };
    });
  }

  async function listPayments({ organizationId = null, query = {} } = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
    const base = () => {
      let q = db(PAYMENT);
      if (organizationId) q = q.where({ organizationId });
      if (query.status) q = q.where({ status: String(query.status) });
      return q;
    };
    const [{ n }] = await base().count({ n: '*' });
    const items = await base().orderBy([{ column: 'receivedAt', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit).offset(offset);
    return { items: items.map(paymentView), total: Number(n), nextCursor: offset + limit < Number(n) ? offset + limit : null };
  }

  async function getPayment({ paymentId, organizationId = null }) {
    const payment = await db(PAYMENT).where({ id: paymentId }).first();
    if (!payment || (organizationId && payment.organizationId !== organizationId)) return fail('payment_not_found', 404);
    const allocations = await db(`${ALLOCATION} as a`).join(`${INVOICE} as i`, 'i.id', 'a.invoiceId').where({ 'a.paymentId': paymentId })
      .orderBy('a.createdAt').select('a.id', 'a.invoiceId', 'a.amountTzs', 'a.active', 'a.createdAt', 'i.number as invoiceNumber', 'i.period', 'i.kind');
    return { payment: paymentView(payment), allocations };
  }

  /** The payments and credits applied to one invoice. */
  async function settlementsOf(invoiceId) {
    return db(`${ALLOCATION} as a`).leftJoin(`${PAYMENT} as p`, 'p.id', 'a.paymentId').leftJoin(`${INVOICE} as c`, 'c.id', 'a.creditInvoiceId')
      .where({ 'a.invoiceId': invoiceId, 'a.active': true }).orderBy('a.createdAt')
      .select('a.id', 'a.amountTzs', 'a.createdAt', 'a.paymentId', 'a.creditInvoiceId', 'p.number as paymentNumber', 'p.method', 'p.reference', 'p.receivedAt', 'c.number as creditNoteNumber');
  }

  // ── Credit and debit notes ────────────────────────────────────────────────

  /**
   * Correct an issued invoice without touching it: a credit note takes
   * something off what the organisation owes, a debit note adds to it. The
   * note is a draft until someone other than its author issues it.
   */
  async function createNote({ invoiceId, body = {}, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const type = body.type;
    if (!['credit', 'debit'].includes(type)) return fail('invalid_note_type', 400, { allowed: ['credit', 'debit'] });
    if (!Number.isInteger(body.amountTzs) || body.amountTzs <= 0) return fail('invalid_amount', 400);
    const reason = text(body.reason);
    if (!reason) return fail('reason_required', 400);
    return db.transaction(async (trx) => {
      const related = await trx(INVOICE).where({ id: invoiceId }).forUpdate().first();
      if (!related) return fail('invoice_not_found', 404);
      if (NOTE_KINDS.includes(related.kind)) return fail('note_on_note', 409);
      if (!BILLED_STATUSES.includes(related.status)) return fail('invoice_not_issued', 409, { status: related.status });
      if (type === 'credit') {
        const [{ credited }] = await trx(INVOICE).where({ relatedInvoiceId: invoiceId, kind: 'credit_note' }).whereNot({ status: 'void' }).sum({ credited: 'totalTzs' });
        const left = related.totalTzs + (Number(credited) || 0);
        if (body.amountTzs > left) return fail('credit_exceeds_invoice', 409, { creditableTzs: Math.max(0, left) });
      }
      const id = newId('b2bi');
      const amount = type === 'credit' ? -body.amountTzs : body.amountTzs;
      const [note] = await trx(INVOICE).insert({
        id, number: `DRAFT-${id.slice(-8).toUpperCase()}`, organizationId: related.organizationId, programId: related.programId, period: related.period,
        kind: type === 'credit' ? 'credit_note' : 'debit_note', status: 'draft', totalTzs: amount, relatedInvoiceId: related.id, reason, createdBy: actorId,
      }).returning('*');
      await trx(LINE).insert({
        id: newId('b2bl'), invoiceId: id, kind: 'note', description: `${type === 'credit' ? 'Credit' : 'Debit'} on ${related.number}: ${reason}`.slice(0, 300),
        quantity: 1, unitTzs: amount, amountTzs: amount,
      });
      await audit(trx, { actor: actorId, action: `b2b.${type}_note.create`, target: id, after: { relatedInvoice: related.number, amountTzs: amount, reason } });
      return { note };
    });
  }

  /**
   * Issue a note (by someone other than its author). A credit note is applied
   * at once to the invoice it corrects, up to what is still owed on it; the
   * rest stays on the organisation's account as credit.
   */
  async function issueNote({ noteId, body = {}, actorId }) {
    const draft = await db(INVOICE).where({ id: noteId }).first();
    if (!draft || !NOTE_KINDS.includes(draft.kind)) return fail('note_not_found', 404);
    const related = await db(INVOICE).where({ id: draft.relatedInvoiceId }).first();
    const issued = await billing.issueInvoice({ invoiceId: noteId, vatRateBps: body.vatRateBps ?? related?.vatRateBps, actorId });
    if (issued.error) return issued;
    if (issued.invoice.kind !== 'credit_note') return { note: issued.invoice };
    const applied = await db.transaction(async (trx) => {
      const target = await trx(INVOICE).where({ id: draft.relatedInvoiceId }).forUpdate().first();
      const owed = outstandingTzs(target);
      if (owed <= 0) return null;
      const out = await allocateIn(trx, { creditInvoiceId: noteId, items: [{ invoiceId: target.id, amountTzs: Math.min(owed, -issued.invoice.totalTzs) }], actorId });
      if (out.error) throw Object.assign(new Error(out.error), { refusal: out });
      return out;
    }).catch((err) => {
      if (!err.refusal) throw err;
      console.warn(`[b2b-finance] credit note ${issued.invoice.number} issued but not applied: ${err.refusal.error}`);
      return null;
    });
    if (applied?.settled?.length) await afterSettled(applied.settled, actorId);
    return { note: await db(INVOICE).where({ id: noteId }).first(), applied: applied?.allocations ?? [] };
  }

  // ── Statement, aging, balances ────────────────────────────────────────────

  /** Seat bills of the company an organisation was mapped from (the older Corporate billing; read only). */
  async function seatBills(q, org) {
    if (!org?.legacyCorporateId) return [];
    return q('CorporateBill').where({ corporateId: org.legacyCorporateId }).orderBy('period');
  }

  /** What one organisation owes, by how late it is. Seat bills carry no due date and count as current. */
  async function balances(q, org, day = today()) {
    const open = await q(INVOICE).where({ organizationId: org.id }).whereIn('status', OPEN_STATUSES);
    const aging = emptyAging();
    let outstanding = 0;
    let overdue = 0;
    let creditNotes = 0;
    for (const inv of open) {
      const owed = outstandingTzs(inv);
      if (owed < 0) { creditNotes += -owed; continue; }
      const bucket = agingBucket(inv.dueDate, day);
      aging[bucket] += owed;
      outstanding += owed;
      if (bucket !== 'current') overdue += owed;
    }
    const [{ unallocated }] = await q(PAYMENT).where({ organizationId: org.id, status: 'received' }).select(q.raw('COALESCE(SUM("amountTzs" - "allocatedTzs"), 0) AS unallocated'));
    const bills = (await seatBills(q, org)).filter(b => b.status !== 'paid');
    const seatBillsTzs = sum(bills, 'employerTzs');
    aging.current += seatBillsTzs;
    const creditTzs = Number(unallocated) + creditNotes;
    return {
      outstandingTzs: outstanding + seatBillsTzs, overdueTzs: overdue, seatBillsTzs, unallocatedPaymentsTzs: Number(unallocated),
      unappliedCreditNotesTzs: creditNotes, creditTzs, balanceTzs: outstanding + seatBillsTzs - creditTzs, aging, asOf: day, currency: 'TZS',
    };
  }

  /**
   * An organisation's account: every invoice, note, payment and reversal in
   * date order with a running balance (positive = owed to FitFlex).
   * `from` / `to` are EAT days; the opening balance carries what came before.
   */
  async function statement({ organizationId, query = {} }) {
    const org = await organizationRow(db, organizationId).first();
    if (!org) return fail('organization_not_found', 404);
    for (const k of ['from', 'to']) if (query[k] && !/^\d{4}-\d{2}-\d{2}$/.test(String(query[k]))) return fail(`invalid_${k}`, 400);
    const invoices = await db(INVOICE).where({ organizationId }).whereIn('status', BILLED_STATUSES);
    const payments = await db(PAYMENT).where({ organizationId });
    const entries = [];
    for (const i of invoices) {
      const type = i.kind === 'credit_note' || i.totalTzs < 0 ? 'credit_note' : i.kind === 'debit_note' ? 'debit_note' : 'invoice';
      entries.push({ at: i.issuedAt, day: localDay(i.issuedAt), type, reference: i.number, description: describe(i), invoiceId: i.id,
        dueDate: i.dueDate ?? null, status: i.status, chargeTzs: Math.max(i.totalTzs, 0), creditTzs: Math.max(-i.totalTzs, 0) });
    }
    for (const p of payments) {
      entries.push({ at: p.receivedAt, day: localDay(p.receivedAt), type: 'payment', reference: p.number, description: `Payment · ${p.method.replace(/_/g, ' ')} · ${p.reference}`,
        paymentId: p.id, status: p.status, chargeTzs: 0, creditTzs: p.amountTzs });
      if (p.status === 'reversed') {
        entries.push({ at: p.reversedAt, day: localDay(p.reversedAt), type: 'payment_reversal', reference: p.number, description: `Payment reversed: ${p.reversalReason}`,
          paymentId: p.id, status: 'reversed', chargeTzs: p.amountTzs, creditTzs: 0 });
      }
    }
    for (const b of await seatBills(db, org)) {
      entries.push({ at: b.createdAt, day: localDay(b.createdAt), type: 'seat_bill', reference: `Seat bill ${b.period}`, description: `Company seats · ${b.period} · ${b.seatCount} seats`,
        seatBillId: b.id, status: b.status, chargeTzs: b.employerTzs, creditTzs: 0 });
      if (b.status === 'paid') {
        entries.push({ at: b.paidAt ?? b.createdAt, day: localDay(b.paidAt ?? b.createdAt), type: 'seat_bill_payment', reference: b.paymentReference ?? `Seat bill ${b.period}`,
          description: `Payment for seat bill ${b.period}`, seatBillId: b.id, status: 'paid', chargeTzs: 0, creditTzs: b.employerTzs });
      }
    }
    entries.sort((a, b) => +new Date(a.at) - +new Date(b.at) || a.reference.localeCompare(b.reference));
    const from = query.from ? String(query.from) : null;
    const to = query.to ? String(query.to) : null;
    let balance = 0;
    let opening = 0;
    const shown = [];
    for (const e of entries) {
      balance += e.chargeTzs - e.creditTzs;
      if (from && e.day < from) { opening = balance; continue; }
      if (to && e.day > to) { balance -= e.chargeTzs - e.creditTzs; continue; }
      shown.push({ ...e, balanceTzs: balance });
    }
    return {
      organization: { id: org.id, name: org.tradingName || org.legalName },
      from, to, openingBalanceTzs: opening, closingBalanceTzs: balance, entries: shown,
      totals: { chargesTzs: sum(shown, 'chargeTzs'), creditsTzs: sum(shown, 'creditTzs') },
      ...(await balances(db, org)),
    };
  }

  const KIND_LABEL = { prepaid: 'Sponsored passes', usage: 'Per-use benefits', fee: 'Platform fee', credit_note: 'Credit note', debit_note: 'Debit note' };
  const describe = i => `${i.totalTzs < 0 && i.kind === 'usage' ? 'Credit for reversed usage' : KIND_LABEL[i.kind] ?? i.kind} · ${i.period}`;

  /** FitFlex finance: receivables across organisations, and for a month, what was billed next to what providers are owed for it. */
  async function dashboard({ query = {} } = {}) {
    const day = today();
    const period = isMonth(query.period) ? query.period : day.slice(0, 7);
    const orgs = await db('B2BOrganization').select('id', 'legalName', 'tradingName', 'status', 'legacyCorporateId');
    const open = await db(INVOICE).whereIn('status', OPEN_STATUSES).select('organizationId', 'totalTzs', 'amountPaidTzs', 'status', 'dueDate');
    const billed = await db(INVOICE).whereIn('status', BILLED_STATUSES).groupBy('organizationId')
      .select('organizationId', db.raw('SUM(GREATEST("totalTzs", 0)) AS invoiced'), db.raw('SUM(LEAST("totalTzs", 0)) AS credited'));
    const paid = await db(PAYMENT).where({ status: 'received' }).groupBy('organizationId')
      .select('organizationId', db.raw('SUM("amountTzs") AS collected'), db.raw('SUM("amountTzs" - "allocatedTzs") AS unallocated'));
    const by = new Map(orgs.map(o => [o.id, {
      organizationId: o.id, name: o.tradingName || o.legalName, status: o.status,
      invoicedTzs: 0, creditNotesTzs: 0, collectedTzs: 0, outstandingTzs: 0, overdueTzs: 0, creditTzs: 0, aging: emptyAging(),
    }]));
    for (const r of billed) { const o = by.get(r.organizationId); if (o) { o.invoicedTzs = Number(r.invoiced); o.creditNotesTzs = -Number(r.credited); } }
    for (const r of paid) { const o = by.get(r.organizationId); if (o) { o.collectedTzs = Number(r.collected); o.creditTzs += Number(r.unallocated); } }
    for (const inv of open) {
      const o = by.get(inv.organizationId);
      if (!o) continue;
      const owed = outstandingTzs(inv);
      if (owed < 0) { o.creditTzs += -owed; continue; }
      const bucket = agingBucket(inv.dueDate, day);
      o.aging[bucket] += owed;
      o.outstandingTzs += owed;
      if (bucket !== 'current') o.overdueTzs += owed;
    }
    const organizations = [...by.values()].filter(o => o.invoicedTzs || o.collectedTzs || o.outstandingTzs || o.creditTzs)
      .sort((a, b) => b.outstandingTzs - a.outstandingTzs || a.name.localeCompare(b.name));
    const aging = emptyAging();
    for (const o of organizations) for (const k of Object.keys(aging)) aging[k] += o.aging[k];
    const [{ drafts, draftTotal }] = await db(INVOICE).where({ status: 'draft', period }).select(db.raw('COUNT(*) AS drafts'), db.raw('COALESCE(SUM("totalTzs"), 0) AS "draftTotal"'));
    return {
      asOf: day, currency: 'TZS',
      totals: {
        invoicedTzs: sum(organizations, 'invoicedTzs'), creditNotesTzs: sum(organizations, 'creditNotesTzs'), collectedTzs: sum(organizations, 'collectedTzs'),
        outstandingTzs: sum(organizations, 'outstandingTzs'), overdueTzs: sum(organizations, 'overdueTzs'), creditTzs: sum(organizations, 'creditTzs'),
      },
      aging, organizations,
      currentPeriod: { period, draftInvoices: Number(drafts), draftTotalTzs: Number(draftTotal) },
      billedAgainstProviders: await billedAgainstProviders({ period }),
    };
  }

  /**
   * For one month: what organisations were billed, next to what gyms and
   * trainers are owed for the same activity. Two separate processes shown
   * side by side; the difference is not revenue or profit (it ignores the
   * members' own shares, VAT, unpaid invoices and unsettled months).
   */
  async function billedAgainstProviders({ period, organizationId = null }) {
    const scope = q => (organizationId ? q.where('organizationId', organizationId) : q);
    const [{ billed }] = await scope(db(INVOICE).whereIn('status', BILLED_STATUSES).where({ period })).select(db.raw('COALESCE(SUM("totalTzs"), 0) AS billed'));
    // Gym visits funded per use: the settlement engine's own figure for each beneficiary's month.
    let visits = db('MemberCycleSettlement as m').where({ 'm.mode': 'live', 'm.active': true, 'm.fundingType': 'b2b_benefit' }).where('m.subscriptionId', 'like', `b2b:%:${period}`);
    // Sponsored passes: the pass each entitlement started, as settled.
    let passes = db('MemberCycleSettlement as m').join('B2BPassEntitlement as e', 'e.subscriptionId', 'm.subscriptionId')
      .where({ 'm.mode': 'live', 'm.active': true, 'e.period': period });
    // Trainer sessions a sponsor covered, as settled to the trainer.
    let trainers = db('TrainerSettlementLine as l').join('B2BBenefitConsumption as c', function on() {
      this.on('c.sourceId', 'l.bookingId').andOn('c.sourceType', db.raw('?', ['trainer_booking']));
    }).where({ 'c.status': 'approved', 'l.voided': false }).where('c.businessDate', 'like', `${period}-%`);
    if (organizationId) {
      visits = visits.whereIn('m.subscriptionId', db('B2BBenefitConsumption').where({ organizationId }).select(db.raw(`'b2b:' || "beneficiaryId" || ':' || left("businessDate", 7)`)));
      passes = passes.where('e.organizationId', organizationId);
      trainers = trainers.where('c.organizationId', organizationId);
    }
    const one = async (q, col) => Number((await q.select(db.raw(`COALESCE(SUM(${col}), 0) AS n`)))[0].n);
    const gymVisitsTzs = await one(visits, 'm."totalFinalTzs"');
    const sponsoredPassesTzs = await one(passes, 'm."totalFinalTzs"');
    const trainerSessionsTzs = await one(trainers, 'l."payoutTzs"');
    const providerObligationsTzs = gymVisitsTzs + sponsoredPassesTzs + trainerSessionsTzs;
    return {
      period, billedTzs: Number(billed),
      providerObligations: { gymVisitsTzs, sponsoredPassesTzs, trainerSessionsTzs, totalTzs: providerObligationsTzs },
      differenceTzs: Number(billed) - providerObligationsTzs,
      note: 'Billed to organisations less what providers are owed for the same month, as settled so far. Not revenue or profit.',
    };
  }

  /**
   * Trace an invoice to what it charges for: each usage line to its
   * consumption and the visit or session behind it, each pass line to the
   * person's entitlement and pass; and, separately, what the provider side
   * of the same activity came to. FitFlex finance only.
   */
  async function reconciliation({ invoiceId }) {
    const invoice = await db(INVOICE).where({ id: invoiceId }).first();
    if (!invoice) return fail('invoice_not_found', 404);
    const lines = await db(LINE).where({ invoiceId }).orderBy('createdAt');
    const consumptionIds = lines.map(l => l.consumptionId).filter(Boolean);
    const entitlementIds = lines.map(l => l.entitlementId).filter(Boolean);
    const consumptions = consumptionIds.length ? await db('B2BBenefitConsumption').whereIn('id', consumptionIds) : [];
    const entitlements = entitlementIds.length ? await db('B2BPassEntitlement').whereIn('id', entitlementIds) : [];
    const cById = new Map(consumptions.map(c => [c.id, c]));
    const eById = new Map(entitlements.map(e => [e.id, e]));
    const checkinIds = consumptions.filter(c => c.sourceType === 'gym_checkin').map(c => c.sourceId);
    const visits = checkinIds.length
      ? await db('SettlementVisit as v').leftJoin('GymSettlementLine as l', 'l.id', 'v.lineId').leftJoin('GymSettlement as s', 's.id', 'l.gymSettlementId')
        .where({ 'v.mode': 'live', 'v.active': true }).whereIn('v.checkinId', checkinIds)
        .select('v.checkinId', 'v.outcome', 'v.eligibility', 'l.id as settlementLineId', 's.id as statementId', 's.status as statementStatus', 's.gymId')
      : [];
    const visitBy = new Map(visits.map(v => [v.checkinId, v]));
    const subs = entitlements.map(e => e.subscriptionId).filter(Boolean);
    const cycles = subs.length ? await db('MemberCycleSettlement').where({ mode: 'live', active: true }).whereIn('subscriptionId', subs) : [];
    const cycleBy = new Map(cycles.map(m => [m.subscriptionId, m]));

    const traced = lines.map((l) => {
      const c = l.consumptionId ? cById.get(l.consumptionId) : null;
      const e = l.entitlementId ? eById.get(l.entitlementId) : null;
      const cycle = e?.subscriptionId ? cycleBy.get(e.subscriptionId) : null;
      return {
        lineId: l.id, kind: l.kind, description: l.description, amountTzs: l.amountTzs, active: l.active,
        consumption: c ? {
          id: c.id, status: c.status, businessDate: c.businessDate, sourceType: c.sourceType, sourceId: c.sourceId, providerType: c.providerType, providerId: c.providerId,
          grossTzs: c.grossTzs, sponsorTzs: c.sponsorTzs, beneficiaryTzs: c.beneficiaryTzs, programId: c.programId, benefitId: c.benefitId, beneficiaryId: c.beneficiaryId,
        } : null,
        entitlement: e ? {
          id: e.id, status: e.status, period: e.period, passTier: e.passTier, listPriceTzs: e.listPriceTzs, discountBps: e.discountBps, feeTzs: e.feeTzs,
          sponsorTzs: e.sponsorTzs, memberTzs: e.memberTzs, subscriptionId: e.subscriptionId, beneficiaryId: e.beneficiaryId,
        } : null,
        // The provider side, where it has been settled. A separate process: shown, never used to work out the charge.
        provider: c?.sourceType === 'gym_checkin' ? (visitBy.get(c.sourceId) ?? { outcome: 'not_settled_yet' })
          : cycle ? { memberCycleSettlementId: cycle.id, gymsOwedTzs: cycle.totalFinalTzs, collectedForPassTzs: cycle.collectedApprovedAmountTzs }
            : e ? { outcome: 'not_settled_yet' } : null,
      };
    });
    const active = traced.filter(t => t.active);
    const linesTotal = sum(active, 'amountTzs');
    const usage = active.filter(t => t.consumption);
    return {
      invoice, lines: traced, settlements: await settlementsOf(invoiceId),
      checks: {
        linesAddUp: linesTotal === invoice.totalTzs || invoice.status === 'void',
        linesTotalTzs: linesTotal, invoiceTotalTzs: invoice.totalTzs,
        // A usage line charges exactly the sponsor's share of its consumption.
        usageMatchesLedger: usage.every(t => t.kind !== 'usage' || t.amountTzs === t.consumption.sponsorTzs),
        reversedSinceInvoiced: usage.filter(t => t.kind === 'usage' && t.consumption.status === 'reversed').map(t => t.consumption.id),
        amountPaidTzs: invoice.amountPaidTzs, outstandingTzs: outstandingTzs(invoice),
      },
    };
  }

  /** Money received from organisations, for FitFlex's book-keeping. */
  async function paymentsForBooks() {
    return db(`${PAYMENT} as p`).join('B2BOrganization as o', 'o.id', 'p.organizationId').where({ 'p.status': 'received' })
      .select('p.id', 'p.number', 'p.amountTzs', 'p.reference', 'p.receivedAt', db.raw('COALESCE(o."tradingName", o."legalName") AS "organizationName"'));
  }

  // ── The organisation's own view ───────────────────────────────────────────

  const canSeeBilling = access => access.platformAdmin || access.permissions.includes(BILLING_READ);
  const refuse = () => fail('forbidden', 403, { requiredPermission: BILLING_READ });

  /** Balance, aging, billing contact and the terms in force. */
  async function organizationOverview({ access }) {
    if (!canSeeBilling(access)) return refuse();
    const org = await organizationRow(db, access.org.id).first();
    const agreement = await agreementInForce(db, org.id, today());
    const recent = await db(INVOICE).where({ organizationId: org.id }).whereIn('status', BILLED_STATUSES).orderBy('issuedAt', 'desc').limit(5);
    return {
      organization: { id: org.id, name: org.tradingName || org.legalName },
      ...(await balances(db, org)),
      account: (await getBillingAccount({ organizationId: org.id })).account,
      terms: agreement
        ? { reference: agreement.reference, contractReference: agreement.contractReference, effectiveFrom: agreement.effectiveFrom, effectiveTo: agreement.effectiveTo,
          billingCycle: agreement.billingCycle, prepaidTermsDays: agreement.prepaidTermsDays, usageTermsDays: agreement.usageTermsDays, platformFeeTzs: agreement.platformFeeTzs }
        : { reference: null, billingCycle: 'monthly', prepaidTermsDays: DEFAULT_TERMS.prepaidTermsDays, usageTermsDays: DEFAULT_TERMS.usageTermsDays, platformFeeTzs: null },
      recentInvoices: recent.map(i => ({ ...i, outstandingTzs: outstandingTzs(i) })),
    };
  }

  async function organizationPayments({ access, query = {} }) {
    if (!canSeeBilling(access)) return refuse();
    const page = await listPayments({ organizationId: access.org.id, query });
    // What FitFlex noted internally and who recorded it are not the organisation's business.
    return { ...page, items: page.items.map(({ note, recordedBy, reversedBy, legacy, ...p }) => p) };
  }

  async function organizationStatement({ access, query = {} }) {
    if (!canSeeBilling(access)) return refuse();
    return statement({ organizationId: access.org.id, query });
  }

  return {
    listAgreements, createAgreement, updateAgreement, activateAgreement, endAgreement,
    getBillingAccount, setBillingAccount, prepareFee, prepareFeesDue,
    recordPayment, allocate, reversePayment, listPayments, getPayment, settlementsOf,
    createNote, issueNote,
    statement, dashboard, billedAgainstProviders, reconciliation, paymentsForBooks,
    organizationOverview, organizationPayments, organizationStatement,
  };
}
