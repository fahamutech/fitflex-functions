// The B2B ledgers refuse deletes (consumptions, sponsor invoices, their lines,
// pass entitlements). A suite that wrote committed rows removes them in one
// transaction that opts in, the same way maintenance would.
export async function withLedgerDelete(db, fn) {
  return db.transaction(async (trx) => {
    await trx.raw("SET LOCAL fitflex.allow_ledger_delete = 'on'");
    return fn(trx);
  });
}
