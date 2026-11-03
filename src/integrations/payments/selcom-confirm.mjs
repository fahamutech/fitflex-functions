// Server-side confirmation of a Selcom transaction (audit M2, flag
// SELCOM_WEBHOOK_SERVER_CONFIRM).
//
// Interface: confirm({ paymentId, subscriptionId, amount }) resolves to
//   { confirmed: boolean, amount?: number|string }
// and throws (or rejects) when Selcom cannot be asked. Callers treat a throw as
// "could not confirm" and fail closed.
//
// There is NO real Selcom status client in this repo: no documented status
// endpoint, no verified signing scheme (OI-004), and the payment provider is
// changing (D34). So the only implementation shipped is "not configured", which
// always throws. Do not invent one; replace this when a real client is agreed.
export class SelcomConfirmNotConfigured extends Error {
  constructor() { super('selcom_confirm_not_configured'); this.code = 'selcom_confirm_not_configured'; }
}

export function createNotConfiguredSelcomClient() {
  return { configured: false, confirm: async () => { throw new SelcomConfirmNotConfigured(); } };
}
