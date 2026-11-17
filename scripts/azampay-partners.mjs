#!/usr/bin/env node
// Lists this AzamPay app's payment partners (GET /api/v1/Partner/GetPaymentPartners), to find the values for
// AZAMPAY_VENDOR_ID / AZAMPAY_VENDOR_NAME that the checkout page needs. Reads the AzamPay settings from the
// environment (AZAMPAY_APP_NAME, AZAMPAY_CLIENT_ID, AZAMPAY_CLIENT_SECRET, AZAMPAY_ENV and hosts); talks to
// AzamPay only (no database). Prints partner names and ids — never a credential or a token.
//
//   node scripts/azampay-partners.mjs
import 'dotenv/config';
import { azampaySettings, azampayConfigProblem, createAzamPayClient } from '../src/integrations/payments/azampay.mjs';

const problem = azampayConfigProblem();
const settings = azampaySettings();
if (!settings) {
  console.error(problem ? `AzamPay is misconfigured (${problem}).` : 'AzamPay is not configured: set AZAMPAY_APP_NAME, AZAMPAY_CLIENT_ID and AZAMPAY_CLIENT_SECRET.');
  process.exit(1);
}
try {
  const partners = await createAzamPayClient({ settings }).paymentPartners();
  console.log(`AzamPay ${settings.environment}: ${partners.length} payment partner(s)`);
  for (const p of partners) console.log(JSON.stringify(p));
  const vendors = [...new Set(partners.map((p) => `${p.paymentVendorId} | ${p.vendorName}`))];
  console.log(vendors.length === 1 ? `One vendor for all partners: ${vendors[0]}` : `Several vendors (${vendors.length}): ask AzamPay which one the checkout page uses.`);
} catch (err) {
  console.error(`AzamPay did not answer: ${err?.code || 'error'} ${err?.status || ''}`.trim());
  process.exit(1);
}
