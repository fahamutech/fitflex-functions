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
 * Shop home Phase 2 · slice 2: personalisation (docs/shop-personalisation-api.md). Off unless
 * SHOP_PERSONALISATION is set: GET /shop/home is byte-identical to before (no `personalisation`
 * key, no purchase history, gender or age), PUT /shop/preferences answers 404 feature_disabled,
 * GET /shop/preferences says available: false and /vendor/tools/options says
 * merch.productTargets: false. Vendor product tags (targetGender, targetAgeBands) are stored either way.
 */
export function shopPersonalisationOn() {
  return on('SHOP_PERSONALISATION');
}

/**
 * Shop home Phase 2 · slice 3: "Popular near you" (docs/shop-near-you-api.md). Off unless SHOP_NEAR_YOU
 * is set: GET /shop/home is byte-identical to before (no `nearYou` key, no popular_near_you section,
 * `areaId` ignored), GET /shop/areas answers 404 feature_disabled, /shop/preferences never lists
 * `location`, and /vendor/tools/options says merch.shopAreas: false. Even on, near-you applies only when
 * personalisation is available and switched on for the person (so SHOP_PERSONALISATION must be on too).
 * Vendor area fields (cityId, regionId, deliveryAreaIds) are validated and stored either way.
 */
export function shopNearYouOn() {
  return on('SHOP_NEAR_YOU');
}

/**
 * Shop home Phase 2 · slice 4: flash sales (docs/shop-flash-sales-api.md). PRICING PATH. Off unless
 * SHOP_FLASH_SALES is set: every /vendor/flash-sales and /admin/flash-sales route answers 404
 * feature_disabled before sign-in, and every price, product list, store, home and checkout answer is
 * byte-identical to before (no sale fields, no flash_sale section, items[].expectedPriceTzs ignored,
 * no price lock). Approved sales stay stored and apply again when it is back on.
 */
export function shopFlashSalesOn() {
  return on('SHOP_FLASH_SALES');
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
    // umbrella (a shop feature, not a vendor tool).
    merch: { banners: shopBannersOn(), productTargets: shopPersonalisationOn(), shopAreas: shopNearYouOn(), flashSales: shopFlashSalesOn() },
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
 * Partner hero photo and logo (plan partner-hero-media-plan.md slice 1). Off unless PARTNER_MEDIA is
 * set: every /partner/media* and /admin/partner-media* route (file serving included) answers 404
 * feature_disabled before sign-in is checked.
 */
export function partnerMediaOn() {
  return on('PARTNER_MEDIA');
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
 * S6: vendor reports and their CSV / PDF exports (/vendor/reports/*). Off → every /vendor/reports route
 * answers 404 feature_disabled. GET /vendor/tools/options says reports: false.
 */
export function vendorReportsOn() {
  return vendorToolsFlag('VENDOR_REPORTS');
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

/**
 * Phase B · B4a: one partner progress tracker (registered → approved →
 * verified → payoutReady) on GET /me/kyc as `progress`. Off unless
 * PARTNER_PROGRESS is set: the field is absent and nothing else changes.
 * Read-only: built from approvalStatus, the KYC case/checklist and payout
 * eligibility (src/shared/partner-progress.mjs).
 */
export function partnerProgressOn() {
  return on('PARTNER_PROGRESS');
}

/**
 * Phase B · B3a: gym staff whose PIN an owner chose must change it before
 * anything else (owner decisions 2026-10-20). Off unless
 * STAFF_PIN_CHANGE_REQUIRED is set: a gym_staff row's passwordChangeRequired
 * is then ignored (no `pwc` on its sessions, no 403 password_change_required),
 * POST /auth/pin/change and POST /owner/staff/:id/pin answer 404
 * feature_disabled, and staff responses are unchanged. Portal admins (#219)
 * are held regardless of this flag. See src/shared/credential-change.mjs.
 */
export function staffPinChangeRequiredOn() {
  return on('STAFF_PIN_CHANGE_REQUIRED');
}

/**
 * A gym shared by several owners has ONE named payout owner (owner decision
 * 2026-10-22; Gym.payoutOwnerId). Off unless GYM_PAYOUT_OWNER is set: payout
 * eligibility, settlement payout gating and invoice payouts keep using the
 * first owner account found for the gym, as before. On: the named payout
 * owner; a gym with exactly one owner uses that owner without any admin step;
 * a gym with two or more owners and none named is not payable
 * (payout_owner_required). See src/services/gym-payout-owner.mjs.
 */
export function gymPayoutOwnerOn() {
  return on('GYM_PAYOUT_OWNER');
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

/**
 * Marathon & running events module (docs/marathon/PRD-v1.0-2026-10-21.md; reuse map §9). EVENTS_MODULE is
 * the umbrella: off unless set, so a deploy changes nothing. S1 ships only persistence, the domain rules
 * and the eventHoldExpiry job; the job returns at once while this is off. Later slices add their own
 * flags (EVENTS_DISCOVERY, EVENTS_REGISTRATION, EVENTS_PAYMENTS_MANUAL …), each on only together with this one.
 */
export function eventsModuleOn() {
  return on('EVENTS_MODULE');
}

/**
 * Phase B · B5a: company sponsors move from the legacy HR area (/hr) to the
 * organisation area (/org). Off unless ORG_ONLY_SPONSORS is set; off, nothing
 * changes. On:
 *  - a company HR login's session (POST /auth/login, Firebase, PIN, switch)
 *    carries organizationUser / organizationRoles / organizationIds, so the
 *    portal opens /org for it;
 *  - people of a company's organisation are added, changed, linked and
 *    imported through /b2b/organizations/:id/beneficiaries..., which write
 *    through the company staff list (no managed_by_corporate dead end);
 *  - a company HR login only ever reaches its own company's organisation;
 *  - new HR logins are also made organisation users (role hr).
 * The conversion of existing HR logins is scripts/hr-to-org.mjs.
 */
export function orgOnlySponsorsOn() {
  return on('ORG_ONLY_SPONSORS');
}

/** S2: saving events and the Saved filter (GET /events/options.favourites). Needs EVENTS_MODULE too. */
export function eventsFavouritesOn() {
  return eventsModuleOn() && on('EVENTS_FAVOURITES');
}

/** S3 (read here for the options probe only): member registration. Needs EVENTS_MODULE too. */
export function eventsRegistrationOn() {
  return eventsModuleOn() && on('EVENTS_REGISTRATION');
}

/**
 * S4: payment intake on the labelled manual confirmation path (D1). Needs EVENTS_MODULE and EVENTS_REGISTRATION.
 * Off: GET /events/options.payment stays 'none' and S3 behaviour is unchanged.
 */
export function eventsPaymentsManualOn() {
  return eventsRegistrationOn() && on('EVENTS_PAYMENTS_MANUAL');
}

/**
 * S4: event orders payable by mobile money (Malipo by Tunzaa). Built dormant; stays off until the owner confirms
 * Tunzaa as the launch provider (D1). Needs EVENTS_MODULE and EVENTS_REGISTRATION (the client, TUNZAA_PAYMENTS and
 * canSettle() are checked where the provider is used).
 */
export function eventsPaymentsTunzaaOn() {
  return eventsRegistrationOn() && on('EVENTS_PAYMENTS_TUNZAA');
}

/**
 * S4 launch gate (security review M4): event payments are taken only with two admins on money (MONEY_SECOND_APPROVER) unless the
 * owner explicitly accepts a single approver with EVENTS_ALLOW_SINGLE_APPROVER=1 (default off).
 */
export function eventsApproverGateOpen() {
  return moneySecondApproverOn() || on('EVENTS_ALLOW_SINGLE_APPROVER');
}

/** S4: payment intake (initiate, provider prompt, corporate notice) is on in either mode. */
export function eventsPaymentIntakeOn() {
  return eventsPaymentsManualOn() || eventsPaymentsTunzaaOn();
}

const positiveNumber = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** S2: an open event is "closing soon" this many hours before registration closes (default 72). */
export const EVENTS_CLOSING_SOON_HOURS_DEFAULT = 72;
export function eventsClosingSoonHours() {
  return positiveNumber('EVENTS_CLOSING_SOON_HOURS', EVENTS_CLOSING_SOON_HOURS_DEFAULT);
}

/** S2: the eventLifecycle job marks an in-progress event completed this many hours after endsAt (default 6). */
export const EVENT_AUTO_COMPLETE_GRACE_HOURS_DEFAULT = 6;
export function eventAutoCompleteGraceHours() {
  const n = Number(process.env.EVENT_AUTO_COMPLETE_GRACE_HOURS);
  return Number.isFinite(n) && n >= 0 ? n : EVENT_AUTO_COMPLETE_GRACE_HOURS_DEFAULT;
}

/** The route guard every events route but GET /events/options uses: 404 feature_disabled while the module is off. */
export function requireEventsModule(req, res, next) {
  if (!eventsModuleOn()) return res.status(404).json({ error: 'feature_disabled' });
  next();
}

/** S3: the guard of every registration route (quote, orders, registrations, claims, teams, corporate, organizer / admin order reads): 404 feature_disabled unless EVENTS_MODULE and EVENTS_REGISTRATION are both on. */
export function requireEventsRegistration(req, res, next) {
  if (!eventsRegistrationOn()) return res.status(404).json({ error: 'feature_disabled' });
  next();
}

/** S4: the guard of payment INTAKE routes: 404 feature_disabled unless an events payment flag is on (reads, tickets, cancel and refunds need only EVENTS_REGISTRATION). */
export function requireEventsPaymentIntake(req, res, next) {
  if (!eventsPaymentIntakeOn()) return res.status(404).json({ error: 'feature_disabled' });
  next();
}

/**
 * S5 (docs/design/events-s5-venue-api-and-webhooks.md §11.1): three dormant flags, each on only together with
 * EVENTS_MODULE and EVENTS_REGISTRATION. KIT_OPS: ticket verification, kit handover, bibs, lookup, export and the
 * live ticket wording. ORGANIZER_API: API clients and /v1/organizer. WEBHOOKS: endpoints, deliveries and the
 * dispatcher jobs (which additionally need EVENTS_WEBHOOK_SECRET_KEY; see webhook-signing.mjs).
 */
export const eventsKitOpsOn = () => eventsRegistrationOn() && on('EVENTS_KIT_OPS');
export const eventsOrganizerApiOn = () => eventsRegistrationOn() && on('EVENTS_ORGANIZER_API');
export const eventsWebhooksOn = () => eventsRegistrationOn() && on('EVENTS_WEBHOOKS');
const gate = test => (_req, res, next) => (test() ? next() : res.status(404).json({ error: 'feature_disabled' }));
export const requireEventsKitOps = gate(eventsKitOpsOn);
export const requireEventsOrganizerApi = gate(eventsOrganizerApiOn);
export const requireEventsWebhooks = gate(eventsWebhooksOn);

/**
 * Partner date of birth · slice 2 (docs/partner-dob-api.md). Off unless PARTNER_DOB_REQUIRED is set:
 * GET/PUT /me/personal-details and the admin GET /admin/trainers/:id/personal-details and
 * /admin/gym-owners/:id/personal-details answer 404 feature_disabled, and /trainer/register and
 * /gym-owner/register ignore `dateOfBirth` (and the owner's `gender`) exactly as before. On: a date of
 * birth sent there is checked (400 invalid_field, 400 partner_under_18) and saved on the Person. The
 * server never refuses a registration for leaving it out (old app builds keep working); the app asks.
 */
export function partnerDobRequiredOn() {
  return on('PARTNER_DOB_REQUIRED');
}

/**
 * Admin-portal audit M3. Off unless SELCOM_STRICT_AMOUNT is set. On: a Selcom
 * "success" callback activates a waiting subscription only when it carries an
 * `amount` AND an open payment request exists AND the amount equals the request's.
 * Otherwise it is refused (409 amount_required / no_open_request / amount_mismatch)
 * before the payment_id is claimed, so a corrected redelivery still works.
 * Off: the old rule (amount compared only when both sides are present).
 */
export function selcomStrictAmountOn() {
  return on('SELCOM_STRICT_AMOUNT');
}

/**
 * Admin-portal audit S4. Off unless ADMIN_EMAILS_STRICT is set. On, in production
 * with FITFLEX_ADMIN_EMAILS unset or blank: no email is trusted as a configured
 * super-admin (the built-in fallback address is not used). Off: the fallback
 * stays in use and a one-time warning is logged. Set FITFLEX_ADMIN_EMAILS before
 * switching this on, or nobody signs in as an env super-admin. Note: with strict on and the
 * variable unset, isConfiguredAdminEmail() is false for everyone, so the `env_admin_immutable`
 * protection (env super-admins cannot be edited or deleted in the portal) also stops applying.
 * A variable that is set but blank trusts nobody whether or not this flag is on.
 */
export function adminEmailsStrictOn(env = process.env) {
  return TRUE_VALUES.has(String(env.ADMIN_EMAILS_STRICT ?? '').trim().toLowerCase());
}

/**
 * Browser gym profile: the open, read-only gym page behind the printed gym QR (POST /public/gyms/resolve).
 * Off unless WEB_GYM_PROFILE is set: the route answers 404 not_found, as if it did not exist.
 */
export function webGymProfileOn() {
  return on('WEB_GYM_PROFILE');
}

/**
 * Browser gym QR check-in (S2): the intent / preview / confirm routes and the short-lived web check-in session.
 * Off unless WEB_QR_CHECKIN is set: every one of those routes answers 404 not_found, as if it did not exist.
 * Also needs QR_HMAC_SECRET (without it the routes stay 404).
 */
export function webQrCheckinOn() {
  return on('WEB_QR_CHECKIN');
}

/**
 * Browser check-in security alert (S3): a push + inbox message to the member when a gym check-in was made from a web
 * browser, and the "Security activity" list. Off unless WEB_CHECKIN_ALERTS is set, and only effective while
 * WEB_QR_CHECKIN is also on. With it off the SecurityEvent record is still written but nothing is sent.
 * Launch gate: keep OFF until the app's security-activity screen (S4) is live.
 */
export function webCheckinAlertsOn() {
  return webQrCheckinOn() && on('WEB_CHECKIN_ALERTS');
}
