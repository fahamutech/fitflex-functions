// Identity V2 feature flags (decision C2). IDENTITY_V2 is the umbrella: a
// phase flag is on only when both it and IDENTITY_V2 are on. Everything is
// off unless set, so a deploy never changes behaviour on its own. Writes to
// the new identity tables are not flagged; only reads and behaviour are.
export const IDENTITY_V2_FLAGS = [
  'V2_FOUNDATION', 'V2_LINKING', 'V2_PERSONAS', 'V2_ADD_PERSONA',
  'V2_ORG_WRITE', 'V2_ORG_AUTHZ', 'V2_IDENTIFIERS', 'V2_INVITES', 'V2_RECOVERY',
  // I7 (design confirmed 2 Oct 2026): FitFlex keeps the PIN; sign-in with number or email + PIN.
  'V2_PIN_LOGIN',
];

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);
const on = name => TRUE_VALUES.has(String(process.env[name] ?? '').trim().toLowerCase());

/** True when IDENTITY_V2 and the given phase flag are both enabled. */
export function identityFlag(name) {
  if (!IDENTITY_V2_FLAGS.includes(name)) throw new Error(`unknown Identity V2 flag: ${name}`);
  return on('IDENTITY_V2') && on(name);
}

/**
 * How organisation authorisation is decided (Identity V2 · I5):
 *   'off'     legacy rules only (default)
 *   'shadow'  legacy rules decide; the membership decision is computed
 *             alongside and disagreements are logged (V2_ORG_AUTHZ=shadow)
 *   'enforce' OrgMembership decides (V2_ORG_AUTHZ=true)
 * Both need the IDENTITY_V2 umbrella.
 */
export function orgAuthzMode() {
  if (!on('IDENTITY_V2')) return 'off';
  const value = String(process.env.V2_ORG_AUTHZ ?? '').trim().toLowerCase();
  if (value === 'shadow') return 'shadow';
  return TRUE_VALUES.has(value) ? 'enforce' : 'off';
}

/**
 * Owner check-in lists show who visited by name (GET /owner/gyms/:id/checkins
 * adds `displayName`). Off unless CHECKIN_VISITOR_NAMES is set, so a deploy
 * never changes what owners see on its own.
 */
export function checkinVisitorNamesOn() {
  return on('CHECKIN_VISITOR_NAMES');
}

/**
 * Members may choose a username shown in public places (migration
 * member-usernames, /me/username endpoints, admin clear on reports). Off
 * unless MEMBER_USERNAMES is set: the endpoints answer 404 feature_disabled
 * and /me omits the new fields.
 */
export function memberUsernamesOn() {
  return on('MEMBER_USERNAMES');
}

/**
 * With Identity V2 linking off, a Firebase session also records what it
 * proved (uid, verified email, Firebase phone) as verified LoginIdentifier
 * rows on the signer's own Person, without moving any persona. Contact
 * matching (friend invitations) trusts only those rows, so members verified
 * only by Firebase stay unmatched (fail-closed) until this is on or
 * scripts/identity-reconcile.mjs --firebase --apply has run. Off unless
 * IDENTITY_RECORD_FIREBASE_EVIDENCE is set. Has no effect when V2_LINKING is on.
 */
export function recordFirebaseEvidenceOn() {
  return on('IDENTITY_RECORD_FIREBASE_EVIDENCE');
}


/**
 * Pay by mobile money through Malipo by Tunzaa (POST /me/payments/:id/mobile-money).
 * Off unless TUNZAA_PAYMENTS is set (and the Tunzaa credentials are present):
 * the endpoint answers 404 feature_disabled and /payments/options says
 * `enabled: false`, so members keep the manual flow. Callbacks for payments
 * already in flight are always honoured (see mobile-money-service).
 */
export function tunzaaPaymentsOn() {
  return on('TUNZAA_PAYMENTS');
}

/**
 * Phase B · B6a: trainer products paid by mobile money (Malipo by Tunzaa) —
 * TRAINER_SERVICE (a member paying for trainer sessions) and TRAINER_GYM_PASS
 * (a trainer buying a gym's trainer pass). Off unless TUNZAA_TRAINER_PRODUCTS
 * is set, and effective only while TUNZAA_PAYMENTS is on too. Off: trainers
 * get 403 on the mobile-money routes as before, trainer products answer
 * 409 not_payable_this_way, and /payments/options has no `mobileMoney` key.
 * SHOP_ORDER is never paid this way (marketplace D-9: manual).
 */
export function tunzaaTrainerProductsOn() {
  return on('TUNZAA_TRAINER_PRODUCTS') && tunzaaPaymentsOn();
}

/**
 * Sandbox payments settle real entitlements (an approved sandbox transaction
 * still activates a pass). So against Tunzaa's sandbox, paying is offered only
 * when TUNZAA_SANDBOX_SETTLES is set on purpose: a test server says so, a
 * production server can never do it by accident. Live needs no such flag.
 */
export function tunzaaSandboxSettlesOn() {
  return on('TUNZAA_SANDBOX_SETTLES');
}

/**
 * The Shop home (GET /shop/home). Off unless SHOP_HOME_V2 is set: the
 * endpoint answers 404 feature_disabled and the app
 * keeps today's shop.
 */
export function shopHomeV2On() {
  return on('SHOP_HOME_V2');
}

/**
 * Shop home Phase 2 · slice 1: hero banners (docs/shop-banners-api.md). Off unless SHOP_BANNERS is
 * set: every /vendor/shop-banners, /admin/shop-banners and /admin/shop-merch route answers 404
 * feature_disabled (before sign-in is checked), GET /shop/home has no `banners` key (byte-identical
 * to before), the lifecycle job does nothing, and /vendor/tools/options says merch.banners: false.
 */
export function shopBannersOn() {
  return on('SHOP_BANNERS');
}

/**
 * Manual mobile-money payment (Lipa Namba / till) with a member-supplied
 * transaction ID. Off unless MANUAL_PAY_INSTRUCTIONS is set: /payments/options
 * carries no `manual` block and subscribe / upgrade take no reference, exactly
 * as before. On, it takes effect only once the admin has saved the Lipa Namba
 * and account name in platform settings (`manualPayment`).
 */
export function manualPayInstructionsOn() {
  return on('MANUAL_PAY_INSTRUCTIONS');
}

/**
 * A1 · second approver on money. Off unless MONEY_SECOND_APPROVER is set, so a
 * deploy never changes how payments and refunds are decided on its own. On:
 *   - a manual payment is verified by one admin and approved by a different one
 *     (403 cannot_approve_own_verification);
 *   - an already-decided payment changes status only by request + confirmation
 *     by a different admin (403 cannot_confirm_own_request);
 *   - an admin-raised refund waits for approval by someone other than the raiser
 *     (403 cannot_approve_own_request), and a refund is marked paid by someone
 *     other than its approver (403 cannot_pay_own_approval).
 * Payments a provider confirms (mobile money, Selcom) are not affected.
 */
export function moneySecondApproverOn() {
  return on('MONEY_SECOND_APPROVER');
}

/**
 * Vendor business tools (plan docs/plans/vendor-business-tools-plan.md).
 * VENDOR_TOOLS is the umbrella: a slice flag is on only when both it and
 * VENDOR_TOOLS are on. Everything is off unless set. Writes that are pure
 * bookkeeping (stock ledger rows, order-line cost snapshots) are not flagged.
 */
export const VENDOR_TOOLS_FLAGS = [
  'VENDOR_STOCK_LEDGER', 'VENDOR_PORTAL', 'VENDOR_ORDER_BUYER_CONTACT', 'VENDOR_WALKIN_SALES', 'VENDOR_CUSTOMERS',
  'VENDOR_DOCUMENTS', 'VENDOR_VAT', 'VENDOR_REPORTS', 'VENDOR_REFUNDS', 'VENDOR_BARCODES', 'VENDOR_PURCHASES', 'VENDOR_FISCAL',
];

/** True when VENDOR_TOOLS and the given slice flag are both enabled. */
export function vendorToolsFlag(name) {
  if (!VENDOR_TOOLS_FLAGS.includes(name)) throw new Error(`unknown vendor tools flag: ${name}`);
  return on('VENDOR_TOOLS') && on(name);
}

/** S1: stock history with reasons, per-variant stock, cost price, low stock. */
export function vendorStockLedgerOn() {
  return vendorToolsFlag('VENDOR_STOCK_LEDGER');
}

/**
 * What the vendor apps may show (GET /vendor/tools/options). Fiscal receipts:
 * 'off' unless VENDOR_FISCAL is on; then VENDOR_FISCAL_MODE manual → 'manual',
 * sandbox|live → 'vfd', anything else → 'off'.
 */
export function vendorToolsOptions() {
  const mode = String(process.env.VENDOR_FISCAL_MODE ?? '').trim().toLowerCase();
  const fiscal = !vendorToolsFlag('VENDOR_FISCAL') ? 'off' : mode === 'manual' ? 'manual' : ['sandbox', 'live'].includes(mode) ? 'vfd' : 'off';
  return {
    stockLedger: vendorToolsFlag('VENDOR_STOCK_LEDGER'),
    portal: vendorToolsFlag('VENDOR_PORTAL'),
    buyerContact: vendorToolsFlag('VENDOR_ORDER_BUYER_CONTACT'),
    walkInSales: vendorToolsFlag('VENDOR_WALKIN_SALES'),
    customers: vendorToolsFlag('VENDOR_CUSTOMERS'),
    documents: vendorToolsFlag('VENDOR_DOCUMENTS'),
    vat: vendorToolsFlag('VENDOR_VAT'),
    reports: vendorToolsFlag('VENDOR_REPORTS'),
    refunds: vendorToolsFlag('VENDOR_REFUNDS'),
    barcodes: vendorToolsFlag('VENDOR_BARCODES'),
    purchases: vendorToolsFlag('VENDOR_PURCHASES'),
    fiscal,
    // Shop home Phase 2: what a vendor may propose for the shop home. Not under the VENDOR_TOOLS
    // umbrella (a shop feature, not a vendor tool). Flash sales (slice 4) will add `flashSales`.
    merch: { banners: shopBannersOn() },
  };
}

/** S2: the vendor web portal (GET /vendor/me opens it). */
export function vendorPortalOn() {
  return vendorToolsFlag('VENDOR_PORTAL');
}

/**
 * S2: a vendor sees the buyer's phone (and the contact window's end) on an order while their part
 * is open and paid, and for 7 EAT days after they delivered it (O-3).
 */
export function vendorBuyerContactOn() {
  return vendorToolsFlag('VENDOR_ORDER_BUYER_CONTACT');
}

/**
 * Admin-managed app photos (plan docs/plans/photo-hero-sections-footer-admin-plan.md, slice 4).
 * Off unless HERO_IMAGES_CMS is set: every /admin/hero-images and /admin/hero-slots route answers
 * 404 feature_disabled (before sign-in is checked), and the public GET /app/hero-images answers
 * { version: 0, slots: {} }, which tells the apps to drop saved photos and use the bundled ones.
 */
export function heroImagesCmsOn() {
  return on('HERO_IMAGES_CMS');
}

/**
 * S3: walk-in (counter) sales recorded by the vendor — POS, sales history, void. Off → the
 * /vendor/sales endpoints answer 404 feature_disabled.
 */
export function vendorWalkInSalesOn() {
  return vendorToolsFlag('VENDOR_WALKIN_SALES');
}

/**
 * S4: vendor customers, pay-later (credit) sales, customer payments, balances and aging, and the
 * daily overdue digest. Off → the /vendor/customers and /vendor/receivables endpoints answer 404
 * feature_disabled, POST /vendor/sales refuses a customer or pay later, and the digest job sends nothing.
 */
export function vendorCustomersOn() {
  return vendorToolsFlag('VENDOR_CUSTOMERS');
}

/**
 * Phase B · B1a: trainer session outcomes (Complete + No-show). Off unless
 * TRAINER_SESSION_OUTCOMES is set. Off: POST /trainer/bookings/:id/no-show
 * answers 404 feature_disabled, admins cannot set no_show, and bookings carry
 * no `actions` key. The start-time check on POST /trainer/bookings/:id/complete
 * is NOT behind this flag: completing a session that has not started is
 * always refused (it made a future session payable at once).
 */
export function trainerSessionOutcomesOn() {
  return on('TRAINER_SESSION_OUTCOMES');
}

/**
 * S5: vendor documents — share links (VendorDocumentLink), the public page /d/:token and its PDF,
 * the logged-in document views, order invoices for vendors and the buyer's invoice in json/html/pdf.
 * Off → those endpoints answer 404 feature_disabled, /d/:token answers the same "not available" page as
 * an unknown token, and GET /me/shop-orders/:id/invoice keeps its plain-text answer only.
 * Links are also refused (503 public_url_not_configured) while PUBLIC_API_URL is not set (Q-1).
 */
export function vendorDocumentsOn() {
  return vendorToolsFlag('VENDOR_DOCUMENTS');
}

/**
 * S5: VAT — the vendor tax profile and its KYC review, product VAT codes, admin tax rates (maker ≠
 * checker) and VAT worked out on walk-in sales and on the vendor's part of paid app orders. Off →
 * those endpoints answer 404 feature_disabled and no sale or order gets VAT. Marketplace prices,
 * commission and payouts never change (O-10).
 */
export function vendorVatOn() {
  return vendorToolsFlag('VENDOR_VAT');
}

/**
 * S5 Q-10 (owner pending): also print the vendor's TIN on documents when they are NOT VAT-registered but
 * their KYC TIN certificate is accepted. Off unless VENDOR_DOCUMENTS_TIN_WITHOUT_VAT is set (and documents
 * are on): by default the TIN appears only together with a verified VRN (O-12).
 */
export function vendorDocumentsTinWithoutVatOn() {
  return vendorDocumentsOn() && on('VENDOR_DOCUMENTS_TIN_WITHOUT_VAT');
}

// ── Default-ON switches ──────────────────────────────────────────────────────
// The exception to "off unless set": these switches keep work that already
// runs today running, so a deploy changes nothing. Only an explicit off value
// pauses them; unset, empty or anything else leaves them on.
const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
const onUnlessOff = name => !OFF_VALUES.has(String(process.env[name] ?? '').trim().toLowerCase());

/**
 * Phase B · B2: the weekly trainer statement-draft job (functions/jobs.mjs
 * trainerSettlementDrafts, Wednesdays 03:00 UTC). DEFAULT ON — owner decision
 * 2026-10-20. TRAINER_STATEMENT_DRAFTS=off|false|0|no pauses the scheduled job
 * only; staff can still prepare a week by hand (POST /admin/trainer-settlements/prepare).
 * Turning it back on loses nothing: every payable session not yet on a live
 * statement is picked up by the next run.
 */
export function trainerStatementDraftsOn() {
  return onUnlessOff('TRAINER_STATEMENT_DRAFTS');
}

/**
 * Phase B · B2: the weekly vendor statement-draft job (vendorSettlementDrafts,
 * Mondays 03:00 UTC). DEFAULT ON, same rules as TRAINER_STATEMENT_DRAFTS:
 * VENDOR_STATEMENT_DRAFTS=off|false|0|no pauses the scheduled job only
 * (POST /admin/vendor-settlements/prepare is unaffected), and the next run
 * after turning it back on picks up every delivered sale not yet on a statement.
 */
export function vendorStatementDraftsOn() {
  return onUnlessOff('VENDOR_STATEMENT_DRAFTS');
}
