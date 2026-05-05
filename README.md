# fitflex-functions

FitFlex Af backend — bfast-functions (Node.js, ESM). Firebase Authentication is identity-only; FitFlex roles and business state stay in this API.

## Layout (clean architecture)

```
functions/index.mjs        REST/SCHEDULE/SOCKET surface (named exports)
src/
  shared/                  Pure business logic — single source of truth
    constants.mjs          Pass tiers, gym tiers, payout bands, rates
    check-in-rules.mjs     BL-010, BL-011, BL-012 (pure)
    payout-engine.mjs      5-band payout calc
    credits.mjs            90-day rolling expiry
  services/                Use-case orchestrators (DI)
    check-in-service.mjs
  auth/
    jwt.mjs                JWT sign/verify, requireAuth(...roles)
    qr-token.mjs           60-second rotating HMAC member QR
  infra/
    json-store.mjs         File-backed repo (swap for Prisma later)
    seed.mjs               Demo data
specs/                     Node test runner unit + service tests
```

## Run

```bash
npm install
npm test          # 28 tests
npm start         # bfast fs server --port 3000
```

## Firebase Auth

`POST /auth/firebase/session` exchanges a Firebase ID token for a FitFlex JWT. For production, provide Firebase Admin credentials via one of:

```bash
export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
# or use GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

Tests and local E2E can use `dev:<base64url-json>` ID tokens.

## Pilot payments

`POST /me/subscribe` now creates a `payment_pending` subscription and a pending `payment_request`. Admin approval at `/admin/payment-requests/:id/decision` activates the subscription. `/me/qr` refuses to issue QR tokens until a subscription is active.

## Prisma/Postgres

The pilot data model is captured in `prisma/schema.prisma`.

```bash
export DATABASE_URL=postgresql://user:pass@host:5432/fitflex
npm run prisma:generate
npm run prisma:migrate
```

## Demo credentials (dev only)

| Role          | Email                          | Password      |
|---------------|--------------------------------|---------------|
| Gym operator  | `operator@iron-paradise.tz`    | `operator123` |
| FitFlex admin | `mama27j@gmail.com`            | `admin123`    |

Members, operators, and admins sign in with Firebase Google auth through `/auth/firebase/session`. The legacy OTP endpoints remain available for development compatibility only.

## Open Items blocking full implementation

- OI-004 Selcom STK push + webhook signature verification (`/webhooks/selcom`); admin-approved payment requests are used for pilot activation
- OI-008 Selcom BaaS GL-account ledger for credits
- OI-009 Credits forfeiture T&C (expiry enforcement)
# fitflex-functions
# fitflex-functions
