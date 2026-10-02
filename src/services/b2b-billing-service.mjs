// B2B sponsor billing — what organisations and their beneficiaries are charged.
//
// Flat fee (a `sponsored_pass` benefit):
//   nominate   every active, eligible beneficiary gets an entitlement for the
//              month and a line on a prepaid invoice — whether or not they
//              ever use it (the sponsor pays for everyone it nominates)
//   pay        when FitFlex records the sponsor's payment, a fully sponsored
//              member's pass starts; a member who owes a share must unlock
//   unlock     the member pays their share once; when that payment is
//              approved the pass starts and runs to the end of the month
// The pass is an ordinary platform pass. Its approved payments are the
// sponsor's share plus the member's share, so gym settlement treats it exactly
// like a pass bought by the member. Nothing here pays a provider.
//
// Per use (every other benefit): the sponsor's share of each approved
// consumption in a month goes on a usage invoice after the month ends; a
// consumption reversed after it was invoiced comes back as a credit.
//
// Invoices are raised and settled by FitFlex admins. Amounts are VAT-inclusive
// whole TZS; the VAT rate is stated when an invoice is issued.
import { randomUUID } from 'node:crypto';
import {
  FLAT_FEE_BENEFIT, programEffectiveStatus, matchesPopulation, benefitValidity, calculateResponsibility,
  discountedFeeTzs, vatContainedTzs, isMonth, monthBounds, eatDayStart,
} from '../shared/b2b-programs.mjs';
import { SUBSIDY_MODELS } from '../shared/corporate-constants.mjs';
import { PASS_TIERS } from '../shared/constants.mjs';
import { localDay } from '../shared/member-progress.mjs';

const INVOICE = 'B2BSponsorInvoice';
const LINE = 'B2BSponsorInvoiceLine';
const ENTITLEMENT = 'B2BPassEntitlement';
const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

export function createB2BBillingService({
  db, programs, benefits, users, subscriptions, paymentRequests, corporateAccounts, auditLog,
  b2bService, b2bProgramService, settingsService,
  now = () => new Date(),
}) {
  const stamp = () => now().toISOString();
  const currentPeriod = () => localDay(now()).slice(0, 7);

  async function audit({ actor, action, target, before = null, after = null }) {
    await auditLog.insertAsync({ id: randomUUID(), at: stamp(), actor, action, target, before, after });
  }

  /** A programme's sponsor fee for one person on a tier: tier price less the discount, split by the benefit's funding. */
  function feeFor(program, benefit) {
    const listPriceTzs = settingsService.priceForTier(benefit.passTier);
    const discountBps = program.discountBps || 0;
    const feeTzs = discountedFeeTzs(listPriceTzs, discountBps);
    const split = calculateResponsibility({ benefit, priceTzs: feeTzs });
    return { listPriceTzs, discountBps, feeTzs, sponsorTzs: split.sponsorTzs, memberTzs: split.beneficiaryTzs };
  }

  /** The open draft for a programme, month and kind, creating it if there is none. */
  async function draftInvoice(trx, { program, period, kind, actorId }) {
    const open = await trx(INVOICE).where({ programId: program.id, period, kind, status: 'draft' }).first();
    if (open) return open;
    const id = newId('b2bi');
    const [row] = await trx(INVOICE).insert({
      id, number: `SI-${period.replace('-', '')}-${id.slice(-6).toUpperCase()}`,
      organizationId: program.organizationId, programId: program.id, period, kind, status: 'draft', createdBy: actorId ?? null,
    }).returning('*');
    return row;
  }

  const retotal = async (trx, invoiceId) => {
    const [{ total }] = await trx(LINE).where({ invoiceId, active: true }).sum({ total: 'amountTzs' });
    const [row] = await trx(INVOICE).where({ id: invoiceId }).update({ totalTzs: Number(total) || 0, updatedAt: new Date(stamp()) }).returning('*');
    return row;
  };

  async function liveProgram(programId) {
    const program = await programs.findByIdAsync(programId);
    if (!program) return fail('program_not_found', 404);
    if (programEffectiveStatus(program, localDay(now())) !== 'active') return fail('program_not_active', 409, { programStatus: program.status });
    const org = (await b2bService.getOrganization({ organizationId: program.organizationId })).organization;
    if (!org || org.status !== 'active') return fail('organization_not_active', 409);
    return { program, org };
  }

  // ── Flat fee: nominate and invoice ────────────────────────────────────────

  /**
   * Put every nominated person who isn't covered yet for `period` on the
   * programme's prepaid draft invoice. Safe to run again: only people added
   * since the last run are picked up.
   */
  /** The Corporate seat bill, if any, already raised for this organisation's company and month. */
  async function seatBillFor(organizationId, period) {
    const org = await db('B2BOrganization').where({ id: organizationId }).first('legacyCorporateId');
    if (!org?.legacyCorporateId) return null;
    return (await db('CorporateBill').where({ corporateId: org.legacyCorporateId, period }).first()) ?? null;
  }

  async function preparePrepaid({ programId, period, actorId }) {
    if (!isMonth(period)) return fail('invalid_period', 400);
    const here = currentPeriod();
    if (period < here || period > monthBounds(here).nextPeriod) return fail('period_not_open', 409, { allowed: [here, monthBounds(here).nextPeriod] });
    const live = await liveProgram(programId);
    if (live.error) return live;
    const { program, org } = live;
    const { startDate, endDate } = monthBounds(period);

    const passBenefits = (await benefits.filterByColumnAsync('programId', program.id)).filter((b) => {
      if (b.benefitType !== FLAT_FEE_BENEFIT || b.status !== 'active') return false;
      const v = benefitValidity(b, program);
      return v.startDate <= endDate && (v.endDate === null || v.endDate >= startDate);   // valid at some point in the month
    });
    if (!passBenefits.length) return fail('no_sponsored_pass', 409);
    // A month the company was already sent a seat bill for is not invoiced here as well.
    const seatBill = await seatBillFor(program.organizationId, period);
    if (seatBill) return fail('period_seat_billed', 409, { billId: seatBill.id, billStatus: seatBill.status, period });
    const people = (await b2bService.allBeneficiaries(org)).filter(b => b.status === 'active');

    const result = await db.transaction(async (trx) => {
      await trx('B2BWellnessProgram').where({ id: program.id }).forUpdate().first();   // one preparation at a time
      let invoice = null;
      let added = 0;
      for (const benefit of passBenefits) {
        const fee = feeFor(program, benefit);
        const covered = new Set(await trx(ENTITLEMENT).where({ benefitId: benefit.id, period }).whereNot({ status: 'void' }).pluck('beneficiaryId'));
        for (const person of people) {
          if (covered.has(person.id) || matchesPopulation({ program, beneficiary: person, benefit })) continue;
          invoice ??= await draftInvoice(trx, { program, period, kind: 'prepaid', actorId });
          const entitlementId = newId('b2be');
          await trx(ENTITLEMENT).insert({
            id: entitlementId, organizationId: org.id, programId: program.id, benefitId: benefit.id,
            beneficiaryId: person.id, beneficiarySource: person.source, userId: person.userId ?? null,
            period, passTier: benefit.passTier, ...fee, status: 'invoiced',
          });
          await trx(LINE).insert({
            id: newId('b2bl'), invoiceId: invoice.id, kind: 'pass', benefitId: benefit.id, beneficiaryId: person.id,
            userId: person.userId ?? null, entitlementId,
            description: `${benefit.name} · ${person.displayName ?? person.id}`,
            quantity: 1, unitTzs: fee.sponsorTzs, amountTzs: fee.sponsorTzs,
          });
          added += 1;
        }
      }
      return { invoice: invoice ? await retotal(trx, invoice.id) : null, added };
    });
    if (result.invoice) await audit({ actor: actorId, action: 'b2b.invoice.prepare', target: result.invoice.id, after: { period, kind: 'prepaid', added: result.added, totalTzs: result.invoice.totalTzs } });
    return result;
  }

  // ── Per use: invoice the month's consumption ──────────────────────────────

  /**
   * Put the sponsor's share of every approved, not yet invoiced consumption of
   * `period` on the programme's usage draft, and credit any consumption that
   * was invoiced before and has since been reversed. Only for a month that has ended.
   */
  async function prepareUsage({ programId, period, actorId }) {
    if (!isMonth(period)) return fail('invalid_period', 400);
    if (period >= currentPeriod()) return fail('period_not_ended', 409);
    const program = await programs.findByIdAsync(programId);
    if (!program) return fail('program_not_found', 404);
    const { startDate, endDate } = monthBounds(period);

    const result = await db.transaction(async (trx) => {
      await trx('B2BWellnessProgram').where({ id: program.id }).forUpdate().first();
      const billed = trx(LINE).where({ kind: 'usage', active: true }).whereNotNull('consumptionId').select('consumptionId');
      const usage = await trx('B2BBenefitConsumption').where({ programId: program.id, status: 'approved' })
        .where('businessDate', '>=', startDate).where('businessDate', '<=', endDate).where('sponsorTzs', '>', 0)
        .whereNotIn('id', billed).orderBy('consumedAt');
      // Invoiced earlier (on an issued or paid invoice), reversed since, and not yet credited.
      const credited = trx(LINE).where({ kind: 'credit', active: true }).select('creditOfLineId');
      const reversed = await trx(`${LINE} as l`)
        .join(`${INVOICE} as i`, 'i.id', 'l.invoiceId')
        .join('B2BBenefitConsumption as c', 'c.id', 'l.consumptionId')
        .where({ 'l.kind': 'usage', 'l.active': true, 'i.programId': program.id, 'c.status': 'reversed' })
        .whereIn('i.status', ['issued', 'paid']).whereNotIn('l.id', credited)
        .select('l.*');
      if (!usage.length && !reversed.length) return { invoice: null, added: 0, credited: 0 };

      const invoice = await draftInvoice(trx, { program, period, kind: 'usage', actorId });
      const names = new Map((await benefits.filterByColumnAsync('programId', program.id)).map(b => [b.id, b.name]));
      for (const c of usage) {
        await trx(LINE).insert({
          id: newId('b2bl'), invoiceId: invoice.id, kind: 'usage', benefitId: c.benefitId, beneficiaryId: c.beneficiaryId,
          userId: c.userId, consumptionId: c.id, description: `${names.get(c.benefitId) ?? c.serviceType} · ${c.businessDate}`,
          quantity: 1, unitTzs: c.sponsorTzs, amountTzs: c.sponsorTzs,
        });
      }
      for (const l of reversed) {
        await trx(LINE).insert({
          id: newId('b2bl'), invoiceId: invoice.id, kind: 'credit', benefitId: l.benefitId, beneficiaryId: l.beneficiaryId,
          userId: l.userId, consumptionId: l.consumptionId, creditOfLineId: l.id, description: `Credit: ${l.description} (reversed)`,
          quantity: 1, unitTzs: -l.amountTzs, amountTzs: -l.amountTzs,
        });
      }
      return { invoice: await retotal(trx, invoice.id), added: usage.length, credited: reversed.length };
    });
    if (result.invoice) await audit({ actor: actorId, action: 'b2b.invoice.prepare', target: result.invoice.id, after: { period, kind: 'usage', added: result.added, credited: result.credited, totalTzs: result.invoice.totalTzs } });
    return result;
  }

  // ── Invoice lifecycle (FitFlex admin) ─────────────────────────────────────

  /**
   * draft → issued: the figures freeze and the VAT contained in the total is
   * stated. A total below zero (credits only) is a credit note; it is issued
   * and settled the same way.
   */
  async function issueInvoice({ invoiceId, vatRateBps, actorId }) {
    if (!Number.isInteger(vatRateBps) || vatRateBps < 0 || vatRateBps > 10000) return fail('vat_rate_required', 400, { hint: 'basis points, e.g. 1800 for 18%; 0 for none' });
    if (!actorId) return fail('actor_required', 403);
    const at = new Date(stamp());
    // The row is locked so the VAT is worked out on the total that is frozen, not one a concurrent preparation is still changing.
    const result = await db.transaction(async (trx) => {
      const invoice = await trx(INVOICE).where({ id: invoiceId }).forUpdate().first();
      if (!invoice) return fail('invoice_not_found', 404);
      if (invoice.status !== 'draft') return fail('invalid_transition', 409, { from: invoice.status, to: 'issued' });
      const [updated] = await trx(INVOICE).where({ id: invoiceId }).update({
        status: 'issued', vatRateBps, vatTzs: vatContainedTzs(invoice.totalTzs, vatRateBps), issuedAt: at, issuedBy: actorId, updatedAt: at,
      }).returning('*');
      return { invoice, updated };
    });
    if (result.error) return result;
    await audit({ actor: actorId, action: 'b2b.invoice.issue', target: invoiceId, before: result.invoice, after: result.updated });
    return { invoice: result.updated };
  }

  /**
   * issued → paid, against the sponsor's payment reference. Paying a prepaid
   * invoice starts the passes it covers.
   *
   * Maker-checker: the person who issued the invoice cannot record it as paid,
   * whoever they are. Recording a payment starts passes and counts as money
   * collected, so it takes a second person. The database refuses it as well.
   */
  async function markPaid({ invoiceId, paymentReference, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const reference = typeof paymentReference === 'string' ? paymentReference.trim().slice(0, 200) : '';
    if (!reference) return fail('payment_reference_required', 400);
    const invoice = await db(INVOICE).where({ id: invoiceId }).first();
    if (!invoice) return fail('invoice_not_found', 404);
    if (invoice.status === 'paid') return { invoice, unchanged: true };
    if (invoice.status !== 'issued') return fail('invalid_transition', 409, { from: invoice.status, to: 'paid' });
    if (invoice.issuedBy === actorId) return fail('cannot_settle_own_invoice', 403);
    const at = new Date(stamp());
    const [updated] = await db(INVOICE).where({ id: invoiceId, status: 'issued' })
      .update({ status: 'paid', paidAt: at, paidBy: actorId, paymentReference: reference, updatedAt: at }).returning('*');
    if (!updated) return fail('invalid_transition', 409, { to: 'paid' });   // someone else settled or voided it meanwhile
    await audit({ actor: actorId, action: 'b2b.invoice.paid', target: invoiceId, before: invoice, after: updated });
    const activation = invoice.kind === 'prepaid' ? await advanceEntitlements({ invoiceId, actorId }) : null;
    return { invoice: updated, activation };
  }

  /** draft or issued → void. Its lines stop counting, so the people and usage on it can be invoiced again. */
  async function voidInvoice({ invoiceId, reason, actorId }) {
    const why = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    if (!why) return fail('reason_required', 400);
    const invoice = await db(INVOICE).where({ id: invoiceId }).first();
    if (!invoice) return fail('invoice_not_found', 404);
    if (!['draft', 'issued'].includes(invoice.status)) return fail('invalid_transition', 409, { from: invoice.status, to: 'void' });
    const at = new Date(stamp());
    const updated = await db.transaction(async (trx) => {
      const [row] = await trx(INVOICE).where({ id: invoiceId }).whereIn('status', ['draft', 'issued'])
        .update({ status: 'void', voidedAt: at, voidedBy: actorId, voidReason: why, updatedAt: at }).returning('*');
      const entitlementIds = await trx(LINE).where({ invoiceId, kind: 'pass' }).pluck('entitlementId');
      await trx(LINE).where({ invoiceId }).update({ active: false });
      if (entitlementIds.length) await trx(ENTITLEMENT).whereIn('id', entitlementIds).update({ status: 'void', updatedAt: at });
      return row;
    });
    await audit({ actor: actorId, action: 'b2b.invoice.void', target: invoiceId, before: invoice, after: updated });
    return { invoice: updated };
  }

  // ── Passes ────────────────────────────────────────────────────────────────

  /** Insert a row whose id is derived from what it stands for; if it is already there, return that one. */
  async function insertOnce(collection, row) {
    try {
      await collection.insertAsync(row);
      return row;
    } catch (err) {
      if (err?.code !== '23505') throw err;
      const existing = await collection.findByIdAsync(row.id);
      if (!existing) throw err;
      return existing;
    }
  }

  /**
   * A member's sponsored pass for the month: an ordinary platform pass, paid
   * for in part or in full by the sponsor.
   *
   * One pass and one sponsor payment per entitlement, however often and
   * however concurrently it is started (a payment recorded while the daily job
   * runs, or a retry after a failure half-way): the pass and the payment take
   * their ids from the entitlement, so a second start finds what the first
   * one wrote instead of writing it again.
   */
  async function startPass({ entitlement, invoice, subscription = null, actorId }) {
    const { startDate, nextStartDate } = monthBounds(entitlement.period);
    const periodEnd = eatDayStart(nextStartDate).toISOString();
    const at = stamp();
    const from = at > eatDayStart(startDate).toISOString() ? at : eatDayStart(startDate).toISOString();
    let sub = subscription;
    if (sub) {
      // Unlocked by the member: keep the month as the pass's length, whenever the payment was approved.
      sub = await subscriptions.updateByIdAsync(sub.id, { renewsAt: periodEnd, expiresAt: periodEnd });
    } else {
      sub = await insertOnce(subscriptions, {
        id: `sub_${entitlement.id}`, memberId: entitlement.userId, type: 'platform_pass', tier: entitlement.passTier,
        status: 'active', startedAt: from, cycleStartedAt: from, renewsAt: periodEnd, expiresAt: periodEnd,
        homeGymId: null, paymentRef: `B2B_${invoice.number}`,
      });
    }
    // The sponsor's share, recorded against the pass so settlement sees the whole fee as collected.
    if (entitlement.sponsorTzs > 0) {
      await insertOnce(paymentRequests, {
        id: `pay_${entitlement.id}`, memberId: entitlement.userId, subscriptionId: sub.id, tier: entitlement.passTier,
        amountTzs: entitlement.sponsorTzs, status: 'approved', provider: 'sponsor_invoice', reference: invoice.number,
        requestedAt: at, decidedAt: at, decidedBy: actorId ?? 'system:b2b-billing', note: `Sponsor share, ${invoice.number}`,
      });
    }
    const [updated] = await db(ENTITLEMENT).where({ id: entitlement.id }).whereNotIn('status', ['active', 'void'])
      .update({ status: 'active', subscriptionId: sub.id, activatedAt: new Date(at), updatedAt: new Date(at) }).returning('*');
    if (!updated) return db(ENTITLEMENT).where({ id: entitlement.id }).first();   // another start finished it first
    await audit({ actor: actorId ?? 'system:b2b-billing', action: 'b2b.pass.start', target: entitlement.id, after: { subscriptionId: sub.id, period: entitlement.period, passTier: entitlement.passTier } });
    return updated;
  }

  /**
   * Move paid-for entitlements as far as they can go: not linked to a member
   * account yet → awaiting_link; month not started → scheduled; a share owed
   * by the member → awaiting_member; otherwise the pass starts. Idempotent;
   * also run daily, so a link made or a month reached later is picked up.
   */
  async function advanceEntitlements({ invoiceId = null, actorId = 'system:b2b-billing' } = {}) {
    let q = db(`${ENTITLEMENT} as e`).join(`${LINE} as l`, function on() { this.on('l.entitlementId', 'e.id').andOn('l.kind', db.raw('?', ['pass'])).andOn('l.active', db.raw('true')); })
      .join(`${INVOICE} as i`, 'i.id', 'l.invoiceId').where('i.status', 'paid')
      .whereIn('e.status', ['invoiced', 'scheduled', 'awaiting_link']).select('e.*', 'i.number as invoiceNumber', 'i.id as invoiceId');
    if (invoiceId) q = q.where('i.id', invoiceId);
    const stats = { started: 0, awaitingMember: 0, awaitingLink: 0, scheduled: 0, lapsed: 0 };
    const today = localDay(now());
    for (const e of await q) {
      const { startDate, endDate } = monthBounds(e.period);
      const set = status => db(ENTITLEMENT).where({ id: e.id }).update({ status, updatedAt: new Date(stamp()) });
      // Corporate employees can be linked after they were nominated.
      let userId = e.userId;
      if (!userId && e.beneficiarySource === 'corporate_employee') {
        userId = (await db('CorporateEmployee').where({ id: e.beneficiaryId }).first('userId'))?.userId ?? null;
        if (userId) await db(ENTITLEMENT).where({ id: e.id }).update({ userId });
      }
      if (today > endDate) { stats.lapsed += 1; continue; }                 // the month is over: nothing to start
      if (!userId) { if (e.status !== 'awaiting_link') await set('awaiting_link'); stats.awaitingLink += 1; continue; }
      if (today < startDate) { if (e.status !== 'scheduled') await set('scheduled'); stats.scheduled += 1; continue; }
      if (e.memberTzs > 0) { await set('awaiting_member'); stats.awaitingMember += 1; continue; }
      await startPass({ entitlement: { ...e, userId }, invoice: { number: e.invoiceNumber }, actorId });
      stats.started += 1;
    }
    return stats;
  }

  /**
   * The member pays their share to unlock the month's pass. Creates the pass
   * as awaiting payment and a payment request for the member's share; the
   * existing payment approval then activates it (see onSubscriptionActivated).
   */
  async function unlock({ userId, entitlementId }) {
    const e = await db(ENTITLEMENT).where({ id: entitlementId }).first();
    if (!e || e.userId !== userId) return fail('entitlement_not_found', 404);
    if (e.status === 'active') return fail('already_unlocked', 409);
    if (e.status !== 'awaiting_member') return fail('not_ready_to_unlock', 409, { entitlementStatus: e.status });
    const { nextStartDate, endDate } = monthBounds(e.period);
    if (localDay(now()) > endDate) return fail('period_ended', 409);

    // One open request at a time: return it if the member asks again.
    if (e.memberPaymentRequestId) {
      const open = await paymentRequests.findByIdAsync(e.memberPaymentRequestId);
      if (open?.status === 'pending') return { entitlement: e, paymentRequest: open, existing: true };
    }
    const at = stamp();
    const periodEnd = eatDayStart(nextStartDate).toISOString();
    // One pass per entitlement, and one request per attempt: both take their
    // ids from the entitlement, so two taps at once make one request.
    let sub = await insertOnce(subscriptions, {
      id: `sub_${e.id}`, memberId: userId, type: 'platform_pass', tier: e.passTier, status: 'payment_pending',
      startedAt: at, cycleStartedAt: at, renewsAt: periodEnd, expiresAt: periodEnd, homeGymId: null, paymentRef: null,
    });
    if (sub.status === 'active') return fail('already_unlocked', 409);
    // Asking again after a rejected payment reopens the same pass.
    if (sub.status !== 'payment_pending') sub = await subscriptions.updateByIdAsync(sub.id, { status: 'payment_pending', startedAt: at, cycleStartedAt: at });
    const earlier = (await paymentRequests.filterByColumnAsync('subscriptionId', sub.id)).filter(p => p.provider !== 'sponsor_invoice');
    const open = earlier.find(p => p.status === 'pending');
    const paymentRequest = open ?? await insertOnce(paymentRequests, {
      id: `pay_${e.id}_m${earlier.length + 1}`, memberId: userId, subscriptionId: sub.id, tier: e.passTier, amountTzs: e.memberTzs,
      status: 'pending', provider: 'admin_approved', reference: null, requestedAt: at, decidedAt: null, decidedBy: null,
      note: 'Your share of a sponsored pass',
    });
    const [updated] = await db(ENTITLEMENT).where({ id: e.id })
      .update({ subscriptionId: sub.id, memberPaymentRequestId: paymentRequest.id, updatedAt: new Date(at) }).returning('*');
    await audit({ actor: userId, action: 'b2b.pass.unlock_requested', target: e.id, after: { paymentRequestId: paymentRequest.id, amountTzs: e.memberTzs } });
    return { entitlement: updated, paymentRequest };
  }

  /**
   * Called when any subscription becomes active (payment approved). If it is a
   * sponsored pass waiting on the member's share, finish it: run it to the end
   * of the month and record the sponsor's share against it.
   */
  async function onSubscriptionActivated(sub) {
    if (!sub?.id) return null;
    const e = await db(ENTITLEMENT).where({ subscriptionId: sub.id, status: 'awaiting_member' }).first();
    if (!e) return null;
    const line = await db(`${LINE} as l`).join(`${INVOICE} as i`, 'i.id', 'l.invoiceId')
      .where({ 'l.entitlementId': e.id, 'l.kind': 'pass', 'l.active': true }).first('i.number');
    return startPass({ entitlement: e, invoice: { number: line?.number ?? 'sponsor' }, subscription: sub, actorId: 'system:b2b-billing' });
  }

  /** Daily: start what can start, and finish any unlock whose payment was approved without the hook running. */
  async function runDaily() {
    const stats = await advanceEntitlements();
    let repaired = 0;
    const waiting = await db(ENTITLEMENT).where({ status: 'awaiting_member' }).whereNotNull('subscriptionId');
    for (const e of waiting) {
      const sub = await subscriptions.findByIdAsync(e.subscriptionId);
      if (sub?.status === 'active' && await onSubscriptionActivated(sub)) repaired += 1;
    }
    return { ...stats, repaired };
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** A member's sponsored-pass state for a benefit this month (for "my benefits"). */
  async function passFor({ benefitId, beneficiaryId, period = currentPeriod() }) {
    const e = await db(ENTITLEMENT).where({ benefitId, beneficiaryId, period }).whereNot({ status: 'void' }).first();
    if (!e) return null;
    return {
      entitlementId: e.id, period: e.period, passTier: e.passTier, status: e.status,
      feeTzs: e.feeTzs, sponsorTzs: e.sponsorTzs, memberTzs: e.memberTzs,
      canUnlock: e.status === 'awaiting_member',
      paymentPending: !!e.memberPaymentRequestId && e.status === 'awaiting_member',
    };
  }

  function invoiceFilter(query = {}) {
    let q = db(INVOICE);
    for (const k of ['organizationId', 'programId', 'period', 'kind', 'status']) if (query[k]) q = q.where(k, String(query[k]));
    return q;
  }

  async function page(base, query) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
    const [{ n }] = await base().count({ n: '*' });
    const items = await base().orderBy([{ column: 'period', order: 'desc' }, { column: 'createdAt', order: 'desc' }]).limit(limit).offset(offset);
    return { items, total: Number(n), nextCursor: offset + limit < Number(n) ? offset + limit : null };
  }

  /** FitFlex back office: sponsor invoices across organisations. */
  const adminListInvoices = ({ query = {} } = {}) => page(() => invoiceFilter(query), query);

  /** An organisation's own invoices (usage.read). Drafts are FitFlex working papers and stay hidden. */
  async function listInvoices({ access, query = {} }) {
    if (!access.permissions.includes('usage.read')) return fail('forbidden', 403, { requiredPermission: 'usage.read' });
    const mine = { ...query, organizationId: access.org.id };
    return page(() => (access.platformAdmin ? invoiceFilter(mine) : invoiceFilter(mine).whereNot({ status: 'draft' })), query);
  }

  /**
   * One invoice with its lines. FitFlex sees every line; an organisation sees
   * pass lines per person (people it nominated) and usage as totals per
   * benefit and person — never the date or place of an individual visit.
   */
  async function getInvoice({ access = null, invoiceId }) {
    const invoice = await db(INVOICE).where({ id: invoiceId }).first();
    const admin = !access || access.platformAdmin;
    if (!invoice || (access && invoice.organizationId !== access.org.id)) return fail('invoice_not_found', 404);
    if (access && !access.permissions.includes('usage.read')) return fail('forbidden', 403, { requiredPermission: 'usage.read' });
    if (!admin && invoice.status === 'draft') return fail('invoice_not_found', 404);
    const lines = await db(LINE).where({ invoiceId }).orderBy('createdAt');
    const people = lines.length ? await users.filterByColumnInAsync('id', [...new Set(lines.map(l => l.userId).filter(Boolean))]) : [];
    const nameOf = new Map(people.map(u => [u.id, u.displayName ?? null]));
    if (admin) return { invoice, lines: lines.map(l => ({ ...l, beneficiaryName: nameOf.get(l.userId) ?? null })) };

    const grouped = new Map();
    for (const l of lines) {
      const key = l.kind === 'pass' ? l.id : `${l.benefitId}:${l.beneficiaryId}`;
      const g = grouped.get(key) ?? { kind: l.kind === 'pass' ? 'pass' : 'usage', benefitId: l.benefitId, beneficiaryId: l.beneficiaryId, beneficiaryName: nameOf.get(l.userId) ?? null, quantity: 0, amountTzs: 0 };
      g.quantity += l.kind === 'credit' ? 0 : l.quantity;
      g.amountTzs += l.amountTzs;
      grouped.set(key, g);
    }
    return { invoice, lines: [...grouped.values()] };
  }

  /** Who is covered for a month under a programme, and where each pass stands. */
  async function listEntitlements({ programId, period = currentPeriod() }) {
    const rows = await db(ENTITLEMENT).where({ programId, period }).whereNot({ status: 'void' }).orderBy('createdAt');
    const people = rows.length ? await users.filterByColumnInAsync('id', rows.map(r => r.userId).filter(Boolean)) : [];
    const nameOf = new Map(people.map(u => [u.id, u.displayName ?? null]));
    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    return { period, counts, entitlements: rows.map(r => ({ ...r, beneficiaryName: nameOf.get(r.userId) ?? null })) };
  }

  // ── Corporate seats → programme ───────────────────────────────────────────

  /** Is this company billed through a programme (so seat bills must stop)? */
  async function billedByProgramme(corporateId) {
    const { organization } = await b2bService.organizationForCorporate({ corporateId });
    if (!organization) return false;
    const live = (await programs.filterByColumnAsync('organizationId', organization.id)).filter(p => ['pending', 'active', 'paused'].includes(p.status));
    if (!live.length) return false;
    const rows = await benefits.filterByColumnInAsync('programId', live.map(p => p.id));
    return rows.some(b => b.benefitType === FLAT_FEE_BENEFIT && b.status === 'active');
  }

  /**
   * Express a company's seat arrangement as a programme: one sponsored pass on
   * the company's pass tier, with the sponsor's share from its subsidy model.
   * The programme is created as a draft for FitFlex to review and activate;
   * once it is live, seat bills for the company are refused.
   */
  async function convertCorporate({ corporateId, actorId }) {
    const account = await corporateAccounts.findByIdAsync(corporateId);
    if (!account) return fail('corporate_not_found', 404);
    const share = SUBSIDY_MODELS[account.subsidyModel];
    if (share === undefined || !PASS_TIERS[account.passTier]) return fail('corporate_not_convertible', 409);
    const ensured = await b2bService.ensureOrganizationForCorporate({ corporateId, actorId });
    if (ensured.error) return ensured;
    const access = await b2bService.resolveAccess({ organizationId: ensured.organization.id, userId: actorId, userType: 'admin' });
    if (access.error) return access;
    const existing = (await programs.filterByColumnAsync('organizationId', access.org.id)).filter(p => !['expired', 'cancelled'].includes(p.status));
    for (const p of existing) {
      const rows = await benefits.filterByColumnAsync('programId', p.id);
      if (rows.some(b => b.benefitType === FLAT_FEE_BENEFIT)) return fail('already_converted', 409, { programId: p.id });
    }

    const created = await b2bProgramService.createProgram({
      access, actorId,
      body: { name: `${account.companyName} wellness`, programType: 'employee_wellness', startDate: localDay(now()), description: 'Created from the company\'s seat arrangement.' },
    });
    if (created.error) return created;
    const funding = share === 1 ? { fundingType: 'full' } : { fundingType: 'sponsor_percentage', sponsorShareBps: Math.round(share * 10000) };
    const benefit = await b2bProgramService.createBenefit({
      access, actorId, programId: created.program.id,
      body: { name: `${account.passTier.charAt(0).toUpperCase()}${account.passTier.slice(1)} pass`, benefitType: FLAT_FEE_BENEFIT, passTier: account.passTier, ...funding },
    });
    if (benefit.error) return benefit;
    await b2bProgramService.setBenefitStatus({ access, actorId, programId: created.program.id, benefitId: benefit.benefit.id, status: 'active' });
    await audit({ actor: actorId, action: 'b2b.corporate.convert', target: corporateId, after: { programId: created.program.id, benefitId: benefit.benefit.id, passTier: account.passTier, subsidyModel: account.subsidyModel } });
    return { organizationId: access.org.id, program: created.program, benefit: benefit.benefit };
  }

  return {
    feeFor, preparePrepaid, prepareUsage, issueInvoice, markPaid, voidInvoice,
    advanceEntitlements, unlock, onSubscriptionActivated, runDaily, passFor,
    adminListInvoices, listInvoices, getInvoice, listEntitlements,
    billedByProgramme, convertCorporate,
  };
}
