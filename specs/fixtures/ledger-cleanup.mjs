// The B2B ledgers refuse deletes (consumptions, sponsor invoices, their lines,
// pass entitlements). A suite that wrote committed rows removes them in one
// transaction that opts in, the same way maintenance would.
export async function withLedgerDelete(db, fn) {
  return db.transaction(async (trx) => {
    await trx.raw("SET LOCAL fitflex.allow_ledger_delete = 'on'");
    return fn(trx);
  });
}

/** Remove everything billing wrote for these organisations, in an order the foreign keys accept. */
export async function purgeB2BBilling(db, organizationIds) {
  if (!organizationIds.length) return;
  await withLedgerDelete(db, async (trx) => {
    const invoiceIds = await trx('B2BSponsorInvoice').whereIn('organizationId', organizationIds).pluck('id');
    const paymentIds = await trx('B2BPayment').whereIn('organizationId', organizationIds).pluck('id');
    await trx('AuditLog').whereIn('target', [...invoiceIds, ...paymentIds]).del();
    await trx('B2BInvoiceReminder').whereIn('organizationId', organizationIds).del();
    await trx('B2BPaymentNotice').whereIn('organizationId', organizationIds).del();
    await trx('B2BPaymentAllocation').whereIn('organizationId', organizationIds).del();
    await trx('B2BPayment').whereIn('organizationId', organizationIds).del();
    await trx('B2BSponsorInvoiceLine').whereIn('invoiceId', invoiceIds).del();
    await trx('B2BPassEntitlement').whereIn('organizationId', organizationIds).del();
    await trx('B2BSponsorInvoice').whereIn('id', invoiceIds).whereNotNull('relatedInvoiceId').del();   // notes before what they correct
    await trx('B2BSponsorInvoice').whereIn('id', invoiceIds).del();
    await trx('AuditLog').whereIn('target', trx('B2BCommercialAgreement').whereIn('organizationId', organizationIds).select('id')).del();
    await trx('B2BCommercialAgreement').whereIn('organizationId', organizationIds).del();
    await trx('B2BBillingAccount').whereIn('organizationId', organizationIds).del();
    await trx('B2BBenefitConsumption').whereIn('organizationId', organizationIds).del();
  });
}
