// AzamPay "credentials" for specs that need the provider configured. Import this FIRST in a spec (before anything
// that loads src/bootstrap/services.mjs): the client is built from the environment when the services start.
// Nothing here is a secret, the environment is the sandbox, and the hosts point at a closed local port, so a
// stray call fails at once instead of reaching AzamPay. A spec with its own local fake sets the hosts before this.
process.env.AZAMPAY_APP_NAME ||= 'spec-app';
process.env.AZAMPAY_CLIENT_ID ||= 'spec-client';
process.env.AZAMPAY_CLIENT_SECRET ||= 'spec-secret';
process.env.AZAMPAY_AUTH_URL ||= 'http://127.0.0.1:9';
process.env.AZAMPAY_CHECKOUT_URL ||= 'http://127.0.0.1:9';
process.env.AZAMPAY_DISBURSE_URL ||= 'http://127.0.0.1:9';
delete process.env.AZAMPAY_ENV;   // sandbox
if (process.env.NODE_ENV === 'production') delete process.env.NODE_ENV;
