// Composition root — every service is instantiated exactly once here with its
// dependencies injected, then imported by the thin REST modules in functions/.
import { createMobileMoneyService } from '../services/mobile-money-service.mjs';
import { createTunzaaClient, tunzaaSettings } from '../integrations/payments/tunzaa.mjs';
import { sign as signJwt, registerAccountStatusLookup, signPurpose, verifyPurpose, invalidateAccountStatus } from '../auth/jwt.mjs';
import { verifyFirebasePassword } from '../auth/firebase-password.mjs';
import { createPinAuthService } from '../services/pin-auth-service.mjs';
import { createRegistrationService } from '../services/registration-service.mjs';
import { createOnboardingService } from '../services/onboarding-service.mjs';
import { createIdentifierChangeService } from '../services/identifier-change-service.mjs';
import { createAccountRecoveryService } from '../services/account-recovery-service.mjs';
import { randomUUID } from 'node:crypto';
import { verifyFirebaseIdToken, initFirebaseAdmin, getAdminAuth } from '../auth/firebase.mjs';
import { issue as issueQr } from '../auth/qr-token.mjs';
import { createCheckInService } from '../services/check-in-service.mjs';
import { createSettlementConfigService } from '../services/settlement-config-service.mjs';
import { createSettlementService } from '../services/settlement-service.mjs';
import { createSettlementWorkflowService } from '../services/settlement-workflow-service.mjs';
import { createPayoutEligibility } from '../services/payout-eligibility.mjs';
import { createGymPayoutOwner } from '../services/gym-payout-owner.mjs';
import { createSettlementViewService } from '../services/settlement-view-service.mjs';
import { createSettlementClawbackService } from '../services/settlement-clawback-service.mjs';
import { createCheckinStatusService } from '../services/checkin-status-service.mjs';
import { createMemberManagementService } from '../services/member-management-service.mjs';
import { createIdentityService } from '../services/identity-service.mjs';
import { createGymService } from '../services/gym-service.mjs';
import { createTrainerService } from '../services/trainer-service.mjs';
import { createTrainerBookingService } from '../services/trainer-booking-service.mjs';
import { createSettingsService } from '../services/settings-service.mjs';
import { createAuthService, isConfiguredAdminEmail, approvalStatusForRole } from '../services/auth-service.mjs';
import { createIdentityLinkService } from '../services/identity-link-service.mjs';
import { createOrgMembershipService } from '../services/org-membership-service.mjs';
import { createInvitationService } from '../services/invitation-service.mjs';
import { createIdentifierService } from '../services/identifier-service.mjs';
import { identityFlag, tunzaaPaymentsOn, tunzaaTrainerProductsOn, tunzaaSandboxSettlesOn, manualPayInstructionsOn, trainerSessionOutcomesOn, vendorVatOn, eventsModuleOn } from '../shared/feature-flags.mjs';
import { createPgEventStore } from '../infra/event-store-pg.mjs';
import { manualPaymentConfigured, manualPaymentOptions } from '../shared/manual-payment.mjs';
import { createPaymentReferenceStore } from '../infra/payment-reference-store.mjs';
import { smsSender as plainSmsSender, emailSender } from '../infra/verification-senders.mjs';
import { createSmsProvider } from '../integrations/sms/provider.mjs';
import { createSmsService } from '../services/sms-service.mjs';
import { attachOrgMembershipSync } from './org-membership-hooks.mjs';
import { registerOrgMembershipLookup } from '../auth/org-authz.mjs';
import { createSubscriptionService } from '../services/subscription-service.mjs';
import { createAccountService } from '../services/account-service.mjs';
import { createOperatorService } from '../services/operator-service.mjs';
import { createOwnerGymService } from '../services/owner-gym-service.mjs';
import { createOwnerStaffService, GYM_STAFF_ACL_SCOPES } from '../services/owner-staff-service.mjs';
import { createAdminMemberService } from '../services/admin-member-service.mjs';
import { createAdminPaymentService } from '../services/admin-payment-service.mjs';
import { createAdminOwnerService } from '../services/admin-owner-service.mjs';
import { createAdminApprovalService } from '../services/admin-approval-service.mjs';
import { createFinanceService } from '../services/finance-service.mjs';
import { createInvoiceService } from '../services/invoice-service.mjs';
import { createPortalUserService } from '../services/portal-user-service.mjs';
import { createWebhookService } from '../services/webhook-service.mjs';
import { createTrainerEngagementService } from '../services/trainer-engagement-service.mjs';
import { createTermsService } from '../services/terms-service.mjs';
import { createPgShopOrderStore } from '../infra/shop-order-store-pg.mjs';
import { createPgVendorStockStore } from '../infra/vendor-stock-store-pg.mjs';
import { createPgVendorSaleStore } from '../infra/vendor-sale-store-pg.mjs';
import { createVendorSaleService } from '../services/vendor-sale-service.mjs';
import { createPgVendorCustomerStore } from '../infra/vendor-customer-store-pg.mjs';
import { createVendorCustomerService } from '../services/vendor-customer-service.mjs';
import { createPgVendorBuyerRefStore } from '../infra/vendor-buyer-ref-store-pg.mjs';
import { createPgVendorTaxStore } from '../infra/vendor-tax-store-pg.mjs';
import { createVendorTaxService } from '../services/vendor-tax-service.mjs';
import { createPgVendorDocumentStore } from '../infra/vendor-document-store-pg.mjs';
import { createVendorDocumentService } from '../services/vendor-document-service.mjs';
import { renderDocumentHtml, renderDocumentsHtml } from '../shared/vendor-document-html.mjs';
import { renderDocumentPdf } from '../shared/vendor-document-pdf.mjs';
import { createShopReconciliationService } from '../services/shop-reconciliation-service.mjs';
import { createProductStatsRecomputeService } from '../services/product-stats-recompute-service.mjs';
import { createShopService, STAFF_ROLES as VENDOR_STAFF_ROLES, STAFF_PERMISSIONS as VENDOR_STAFF_PERMISSIONS } from '../services/shop-service.mjs';
import { createGymReviewService } from '../services/gym-review-service.mjs';
import { createTrainerReviewService } from '../services/trainer-review-service.mjs';
import { createWhatsAppService } from '../services/whatsapp-service.mjs';
import { createFavoriteService } from '../services/favorite-service.mjs';
import { createActivityService } from '../services/activity-service.mjs';
import { createGoalService } from '../services/goal-service.mjs';
import { createWorkoutService } from '../services/workout-service.mjs';
import { createPartnerNotifier } from '../services/partner-notifier.mjs';
import { createTrainingPreferenceService } from '../services/training/training-preference-service.mjs';
import { createRecommendationEngine } from '../services/training/recommendation-engine.mjs';
import { createRulesRecommendationProvider } from '../services/training/rules-recommendation-provider.mjs';
import { createTrainingPlanService } from '../services/training/training-plan-service.mjs';
import { createWorkoutExerciseService } from '../services/training/workout-exercise-service.mjs';
import { createTrainerPlanService } from '../services/training/trainer-plan-service.mjs';
import { createExerciseAdminService } from '../services/training/exercise-admin-service.mjs';
import { createSocialService } from '../services/social-service.mjs';
import { createUsernameService } from '../services/username-service.mjs';
import { createFriendInvitationService } from '../services/friend-invitation-service.mjs';
import { createVerifiedContacts } from '../shared/verified-contacts.mjs';
import { createTrainerClientService } from '../services/trainer-client-service.mjs';
import { createGymSharingService } from '../services/gym-sharing-service.mjs';
import { createChallengeService } from '../services/challenge-service.mjs';
import { createChallengeRewardService } from '../services/challenge-reward-service.mjs';
import { createAnalyticsService } from '../services/analytics-service.mjs';
import { createNotificationService } from '../services/notification-service.mjs';
import { getMessaging } from 'firebase-admin/messaging';
import { createCorporateService } from '../services/corporate-service.mjs';
import { createB2BService } from '../services/b2b-service.mjs';
import { createB2BMemberRequestService } from '../services/b2b-member-request-service.mjs';
import { createB2BProgramService } from '../services/b2b-program-service.mjs';
import { createB2BConsumptionService } from '../services/b2b-consumption-service.mjs';
import { createB2BBillingService } from '../services/b2b-billing-service.mjs';
import { createB2BCollectionsService } from '../services/b2b-collections-service.mjs';
import { createB2BAnalyticsService } from '../services/b2b-analytics-service.mjs';
import { createOpsService } from '../services/ops-service.mjs';
import { registerB2BJobs } from '../services/b2b-jobs.mjs';
import { createB2BWatchService } from '../services/b2b-watch-service.mjs';
import { createB2BBeneficiaryImportService } from '../services/b2b-beneficiary-import-service.mjs';
import { createB2BLifecycleService } from '../services/b2b-lifecycle-service.mjs';
import { createSegmentService } from '../services/segment-service.mjs';
import { createCampaignService } from '../services/campaign-service.mjs';
import { createTemplateService } from '../services/template-service.mjs';
import { createDeliveryService } from '../services/delivery-service.mjs';
import { createCommunicationPreferenceService } from '../services/communication-preference-service.mjs';
import { createWhatsAppChannelService } from '../services/whatsapp-channel-service.mjs';
import { createCommunicationHistoryService } from '../services/communication-history-service.mjs';
import { createAutomationService } from '../services/automation-service.mjs';
import { createCommunicationAnalyticsService } from '../services/communication-analytics-service.mjs';
import { createCommunicationAccess } from '../services/communication-access.mjs';
import { whatsappParameter } from '../shared/message-render.mjs';
import { createWhatsAppProvider } from '../integrations/whatsapp/provider.mjs';
import { createPartnerKycService } from '../services/partner-kyc-service.mjs';
import { createPartnerProgressService } from '../services/partner-progress-service.mjs';
import { createPartnerGate } from '../services/partner-gate.mjs';
import { createRefundService } from '../services/refund-service.mjs';
import { createTierHolders } from '../services/tier-holders.mjs';
import { createB2BFinanceService } from '../services/b2b-finance-service.mjs';
import { createCompanyDirectory } from '../services/company-directory.mjs';
import { createB2BEngagementAccess } from '../services/b2b-engagement-access.mjs';
import { createTrainerSettlementService } from '../services/trainer-settlement-service.mjs';
import { createVendorSettlementService } from '../services/vendor-settlement-service.mjs';
import { createB2BSponsorRefundService } from '../services/b2b-sponsor-refund-service.mjs';
import { createModerationGate } from '../services/moderation-gate.mjs';
import { createEntityResolver } from '../services/promotion-entities.mjs';
import { createModerationService } from '../services/moderation-service.mjs';
import { createPromotionService } from '../services/promotion-service.mjs';
import { createShopBannerService } from '../services/shop-banner-service.mjs';
import { createPgShopBannerStore } from '../infra/shop-banner-store-pg.mjs';
import { createDiscoveryService } from '../services/discovery-service.mjs';
import { createShopHomeService } from '../services/shop-home-service.mjs';
import { createShopPreferenceService } from '../services/shop-preference-service.mjs';
import { createPgShopPreferenceStore, forgetShopPreference } from '../infra/shop-preference-store-pg.mjs';
import { signServedToken } from '../auth/promotion-token.mjs';
import { createPromotionEventsService } from '../services/promotion-events-service.mjs';
import { createPromotionAnalyticsService } from '../services/promotion-analytics-service.mjs';
import { createZebraDocumentStore, createZebraPublicStore } from '../infra/storage-client.mjs';
import { createPgEventCatalogueStore } from '../infra/event-catalogue-store-pg.mjs';
import { createEventsOrganizerService } from '../services/events-organizer-service.mjs';
import { createEventsAdminService } from '../services/events-admin-service.mjs';
import { createEventsDiscoveryService } from '../services/events-discovery-service.mjs';
import { createEventsRegistrationService } from '../services/events-registration-service.mjs';
import { createEventsRosterService } from '../services/events-roster-service.mjs';
import { createEventsPaymentService, eventOutcomeOf } from '../services/events-payment-service.mjs';
import { createEventsRefundService } from '../services/events-refund-service.mjs';
import { createPgEventMoneyStore } from '../infra/event-money-store-pg.mjs';
import { eventsPaymentsManualOn, eventsPaymentsTunzaaOn } from '../shared/feature-flags.mjs';
import { eventTicketKeyRing, eventsRefundTargetDays } from '../shared/events-config.mjs';
import { eventsMaxParticipantsPerOrder, eventsConsentTextVersion } from '../shared/events-config.mjs';
import { registerOrganizerLookup } from '../auth/events-authz.mjs';
import { eventsFavouritesOn, eventsRegistrationOn, eventsClosingSoonHours, eventAutoCompleteGraceHours } from '../shared/feature-flags.mjs';
import { createHeroImageService } from '../services/hero-image-service.mjs';
import { createPgHeroImageStore } from '../infra/hero-image-store-pg.mjs';
import { db } from '../infra/knex-store.mjs';
import { createPgTrainerOutcomeStore } from '../infra/trainer-outcome-store-pg.mjs';
import { createPersonalDetailsService } from '../services/personal-details-service.mjs';
import { forgetPersonDetails } from '../infra/person-details-store-pg.mjs';
import {
  moderationStates, moderationEvents, geoAreas, promotionCampaigns, promotions, promotionPlacements, placementConfigs,
  refunds,
  users, gyms, subscriptions, checkins, otps, auditLog, paymentRequests,
  trainers, trainerBookings, platformSettings, invoices, gymPayouts, gymOwners, webhookSeen,
  trainerEngagements, trainerSessions, products, shopOrders,
  marketplaceEnquiries, marketplaceNotifications, productReviews,
  gymReviews, trainerReviews,
  corporateAccounts, corporateEmployees, corporateBills,
  b2bOrganizations, b2bOrganizationUsers, b2bBeneficiaries, b2bPrograms, b2bBenefits,
  deviceTokens, notifications, activities, activityRoutes, goals, workouts,
  follows, friendInvitations, blocks, socialProfiles, socialGroups, socialGroupMembers, activityKudos, activityComments, activityViews, socialReports,
  memberUsernames, usernameReleases,
  trainerMemberRelationships, workoutPlans, trainingPlans, trainingExercises, gymMemberSharing, challenges, challengeParticipants,
  challengeTeams, challengeRewards,
  communicationPreferences, communicationCampaigns, communicationTemplates,
  partnerKycCases, partnerPeople, partnerDocuments, partnerChecks,
  partnerSettlementAccounts, partnerAgreements, partnerKycEvents,
} from './collections.mjs';

export { isConfiguredAdminEmail, approvalStatusForRole };
export {
  users, gyms, subscriptions, checkins, otps, auditLog, paymentRequests,
  trainers, trainerBookings, platformSettings, invoices, gymPayouts, gymOwners, webhookSeen,
  trainerEngagements, trainerSessions, products, shopOrders,
  marketplaceEnquiries, marketplaceNotifications, productReviews,
  gymReviews, trainerReviews,
  corporateAccounts, corporateEmployees, corporateBills,
};

// The key PINs (and portal start passwords) are mixed with before hashing. It
// must be set in production and never change afterwards, or every stored PIN
// stops matching. Null in production when unset: callers fail closed.
function pinPepper() {
  return process.env.PIN_PEPPER || (process.env.NODE_ENV === 'production' ? null : 'fitflex-dev-pin-pepper');
}

// requireAuth rejects tokens of suspended accounts (the JWT alone can't know).
// A suspended Person (FitFlex-level only) suspends every persona; a suspended
// persona never suspends the Person (invariant 30).
registerAccountStatusLookup(async id => {
  const user = await users.findByIdAsync(id);
  if (!user) return null;
  if (user.accountStatus === 'suspended') return 'suspended';
  // Sessions issued before this are over: the later of the profile's own cut-off
  // (a portal admin changed their start password) and the Person's (I7a: a PIN
  // reset or change).
  let validAfter = user.sessionsValidAfter ? +new Date(user.sessionsValidAfter) : null;
  if (user.personId) {
    const person = await db('Person').where({ id: user.personId }).first();
    if (person?.status === 'suspended') return 'suspended';
    if (person?.sessionsValidAfter) validAfter = Math.max(validAfter ?? 0, +new Date(person.sessionsValidAfter));
  }
  const passwordChangeRequired = user.passwordChangeRequired === true;
  if (validAfter || passwordChangeRequired) {
    return {
      status: user.accountStatus ?? null,
      sessionsValidAfter: validAfter ? new Date(validAfter) : null,
      // Still on the start password another admin chose: held to the change-password route.
      passwordChangeRequired,
    };
  }
  return user.accountStatus ?? null;
});

export const identityService = createIdentityService({ users });
// KYC enforcement for partners created from the enforcement start; existing ones are exempt.
export const partnerGate = createPartnerGate({ users, partnerKycCases });
/** What moderation keeps out of public lists (pending, rejected, suspended, hidden). */
export const moderationGate = createModerationGate({ states: moderationStates });
/** For a trainer or gym owner: is their own verification approved? Undefined for other roles. */
export const partnerVerifiedFor = async user => (
  ['trainer', 'gym_operator'].includes(user?.userType) ? partnerGate.isOperational(user.id) : undefined
);
const { resolveRequestUser, publicUserId } = identityService;

// A tier members still hold cannot be removed, renamed or switched off in Settings (409 tier_in_use).
export const settingsService = createSettingsService({ platformSettings, auditLog, tierHolders: createTierHolders({ db }) });
export const gymService = createGymService({ gyms, users, checkins, auditLog });
// Who is paid for a gym shared by several owners (GYM_PAYOUT_OWNER, dormant by default).
export const gymPayoutOwner = createGymPayoutOwner({ users, gyms, auditLog });
// Tells gym owners, staff and vendors what happens at their gym or shop (inbox + push).
export const partnerNotifier = createPartnerNotifier({
  usernames: { handleOf: userId => usernameService.handleOf(userId) }, users, gyms, trainers, subscriptions, paymentRequests, preferences: communicationPreferences,
  notify: (userId, message) => notificationService.notify(userId, message),
});
// Partner DOB slice 2 (docs/partner-dob-api.md): a person's own date of birth and gender on their Person.
export const personalDetailsService = createPersonalDetailsService({ db, auditLog, trainers });
export const trainerService = createTrainerService({
  trainers, gyms, trainerBookings, auditLog, gymService, partnerGate,
  onGymRequest: request => partnerNotifier.gymTrainerRequest(request),
  // Partner DOB review L3: the declared date of birth goes once the Person has no personas left
  // (deleting only the profile leaves the trainer's account, so this usually keeps it).
  onTrainerRemoved: async prior => {
    const row = prior?.userId ? await db('User').where({ id: prior.userId }).first('personId') : null;
    await forgetPersonDetails(db, { personId: row?.personId || null });
  },
});
export const trainerBookingService = createTrainerBookingService({
  trainerBookings, trainerSessions, trainers, gyms, users, auditLog, trainerService,
  subscriptions, paymentRequests, partnerGate,
  // The Pass trainer discount only for a tier configured in Settings.
  getTierConfig: settingsService.getTierConfig,
  notify: (event, payload) => notificationService.notifyTrainerBooking(event, payload),
  // Phase B · B1a: no-show, admin no_show and `actions` (dormant unless TRAINER_SESSION_OUTCOMES).
  outcomesOn: trainerSessionOutcomesOn,
  // Outcome changes lock the statement and the booking, write conditionally and keep draft lines in step.
  outcomeStore: createPgTrainerOutcomeStore({ db }),
  // Sessions on a live trainer statement line, with that statement's status.
  statementLines: async (bookingIds) => {
    const rows = await db('TrainerSettlementLine as l').join('TrainerSettlement as s', 's.id', 'l.trainerSettlementId')
      .whereIn('l.bookingId', bookingIds).where('l.voided', false).whereNot('s.status', 'voided')
      .select('l.bookingId', 's.id as statementId', 's.status');
    return new Map(rows.map(r => [r.bookingId, { statementId: r.statementId, status: r.status }]));
  },
  // promotionEventsService is defined at the end of this file; this only runs later.
  onBookingConversion: ({ action, groupId, bookings }) => (action === 'credit' ? promotionEventsService.recordBooking(bookings) : promotionEventsService.reverseBooking(groupId)),
  // refundService is defined below; this only runs later.
  onRefundDue: ({ booking, reasonCode, actorId, role }) => refundService.raise({
    memberId: booking.memberId, kind: 'trainer_booking', sourceId: booking.id, paymentRequestId: booking.paymentRequestId,
    amountTzs: booking.amountTzs, currency: booking.currency || 'TZS', reasonCode,
    requestedBy: actorId, requestedRole: role, approved: true,
  }).then(out => out.refund || null),
  // A completed session may use a B2B trainer benefit; un-completing it gives the benefit back.
  // b2bConsumptionService is defined below; this only runs later.
  // The member paid the booking in full; once a sponsor covers it, that money goes back to the member.
  // A no-show uses the benefit as if the session happened (owner decision 2026-10-20).
  onStatusChanged: async ({ booking, from, actorId }) => {
    const happened = status => status === 'completed' || status === 'no_show';
    if (happened(booking.status)) {
      const used = await b2bConsumptionService.consumeTrainerSession({ booking });
      if (used.consumed) await b2bSponsorRefundService.onSessionConsumed({ booking, consumption: used.consumption });
      return used;
    }
    if (!happened(from)) return null;
    const released = await b2bConsumptionService.releaseForSource({ sourceType: 'trainer_booking', sourceId: booking.id, reason: `booking ${booking.status}`, actorId });
    if (released.released) await b2bSponsorRefundService.onSessionReleased({ booking, actorId });
    return released;
  },
});
export const trainerEngagementService = createTrainerEngagementService({
  trainerEngagements, trainers, users, trainerService,
  // notificationService is created further down; this only runs later.
  notify: (userId, message) => notificationService.notify(userId, message),
});
export const shopService = createShopService({
  products, shopOrders, users, auditLog, paymentRequests,
  // Shop home slice 3: vendor "Based in" / "Delivers to" are checked against usable GeoAreas.
  geoAreas,
  // Stock reservation and cancellation are single database transactions.
  orderStore: createPgShopOrderStore({ db }),
  // Vendor tools · S1: stock ledger, cost price, reorder level (dormant behind VENDOR_TOOLS + VENDOR_STOCK_LEDGER).
  stockLedger: createPgVendorStockStore({ db }),
  // Vendor tools · S2: pickup gym names and vendor-scoped buyer ids on vendor orders.
  gyms, buyerRefs: createPgVendorBuyerRefStore({ db }),
  requireVariantChoice: process.env.SHOP_REQUIRE_VARIANT === 'on',
  reservationTtlMinutes: Number(process.env.SHOP_RESERVATION_TTL_MINUTES) > 0 ? Number(process.env.SHOP_RESERVATION_TTL_MINUTES) : 48 * 60,
  onRefundDue: ({ order, amountTzs, reasonCode, actorId, role }) => refundService.raise({
    memberId: order.buyerId, kind: 'shop_order', sourceId: order.id,
    amountTzs: amountTzs ?? order.totalTzs, reasonCode, requestedBy: actorId, requestedRole: role, approved: true,
  }).then((out) => {
    // A refusal is a failure the shop records, not a quiet "no refund".
    if (out.error) throw new Error(`refund_${out.error}`);
    return out.refund;
  }),
  marketplaceEnquiries, marketplaceNotifications, productReviews, partnerGate, partnerKycCases, publicGate: moderationGate,
  onVendorEvent: (vendorId, event, data) => partnerNotifier.vendorEvent(vendorId, event, data),
  // A paid order is credited to the promotion the buyer opened (promotionEventsService is defined below; this only runs later).
  onOrderPaid: order => promotionEventsService.recordPaidOrder(order),
  onOrderCancelled: order => promotionEventsService.reversePaidOrder(order),
  // Vendor tools · S4: the buyer becomes (or is refreshed as) an app customer of each vendor (defined below; runs later).
  onVendorCustomerOrder: order => vendorCustomerService.marketplaceOrderPaid(order),
  // Vendor tools · S5: each vendor's invoice for the paid order is numbered (defined below; runs later).
  onVendorOrderInvoices: order => vendorDocumentService.orderPaid(order),
  // Vendor tools · S5: product VAT codes (VENDOR_TOOLS + VENDOR_VAT).
  productVat: {
    on: vendorVatOn,
    allowedCodes: async () => (await vendorTaxStore.codes()).filter(c => c.inUse).map(c => c.code),
    set: input => vendorTaxStore.setProductVatCode(input),
    codesOf: (vendorId, ids) => vendorTaxStore.vatCodesOf(vendorId, ids),
    codesById: ids => vendorTaxStore.vatCodesById(ids),
  },
});
// Vendor tools · S5: VAT — tax profile + KYC review, tax rates (maker ≠ checker), product VAT codes
// (dormant behind VENDOR_TOOLS + VENDOR_VAT; the routes check the flag).
const vendorTaxStore = createPgVendorTaxStore({ db });
export const vendorTaxService = createVendorTaxService({
  store: vendorTaxStore,
  notifyVendor: (vendorId, type, data) => shopService.notifyVendor(vendorId, type, data),
});
// Vendor tools · S3: walk-in (counter) sales — no commission, no ShopOrder, no settlement
// (dormant behind VENDOR_TOOLS + VENDOR_WALKIN_SALES; the routes check the flag).
const vendorSaleStore = createPgVendorSaleStore({ db });
export const vendorSaleService = createVendorSaleService({
  store: vendorSaleStore,
  afterStockMoved: productIds => shopService.afterStockMoved(productIds),
  notifyVendor: (vendorId, type, data) => shopService.notifyVendor(vendorId, type, data),
});
// Vendor tools · S4: customers, pay-later balances, customer payments, aging and the overdue digest
// (dormant behind VENDOR_TOOLS + VENDOR_CUSTOMERS; the routes and the digest job check the flag).
const vendorCustomerStore = createPgVendorCustomerStore({ db });
export const vendorCustomerService = createVendorCustomerService({
  store: vendorCustomerStore,
  saleStore: vendorSaleStore,
  saleService: vendorSaleService,
  notifyVendor: (vendorId, type, data) => shopService.notifyVendor(vendorId, type, data),
  // The digest goes to the vendor and to staff: each person gets their own push + inbox, in their language.
  notifyPerson: (userId, type, data) => partnerNotifier.vendorEvent(userId, type, data),
});
// Vendor tools · S5: share links, public page, PDF, order invoices (dormant behind VENDOR_TOOLS +
// VENDOR_DOCUMENTS; order invoice numbering on payment is bookkeeping and runs regardless).
export const vendorDocumentService = createVendorDocumentService({
  store: createPgVendorDocumentStore({ db, customerStore: vendorCustomerStore, vatOn: vendorVatOn }),
  renderHtml: renderDocumentHtml,
  renderManyHtml: renderDocumentsHtml,
  renderPdf: renderDocumentPdf,
});
export const shopReconciliationService = createShopReconciliationService({ db });
export const productStatsRecomputeService = createProductStatsRecomputeService({ db });
// Who an email / number belongs to, by verified LoginIdentifier rows only
// (never the self-editable User.email / User.phone). Used by friend
// invitations, B2B invite matching and import, and add-by-contact.
export const verifiedContacts = createVerifiedContacts(db);
// Requests a member must accept before an organisation adds them by user id
// (b2bMemberRequestService is defined below; these only run later, per request).
const memberRequestsLater = {
  attempt: requestedBy => b2bMemberRequestService.attempt(requestedBy),
  stub: args => b2bMemberRequestService.stub(args),
  adminAdded: args => b2bMemberRequestService.adminAdded(args),
  create: args => b2bMemberRequestService.create(args),
  pendingForOrganization: args => b2bMemberRequestService.pendingForOrganization(args),
  pendingForCorporate: args => b2bMemberRequestService.pendingForCorporate(args),
  cancelForEmployee: args => b2bMemberRequestService.cancelForEmployee(args),
};
export const corporateService = createCorporateService({
  users, checkins, corporateAccounts, corporateEmployees, corporateBills, auditLog, settingsService,
  verifiedContacts, memberRequests: memberRequestsLater,
  // Every new company gets its employer B2B organisation. b2bService is defined
  // below; the hook only runs later, at onboarding.
  onAccountCreated: (account, actorId) => b2bService.ensureOrganizationForCorporate({ corporateId: account.id, actorId }),
  // A company moved onto a programme is invoiced there, not by seat bills.
  billedByProgramme: corporateId => b2bBillingService.billedByProgramme(corporateId),
});
// B2B Foundation V1: generalised organisations next to Corporate (which it reads through).
export const b2bService = createB2BService({
  users, corporateAccounts, corporateEmployees, partnerKycCases,
  organizations: b2bOrganizations, organizationUsers: b2bOrganizationUsers, beneficiaries: b2bBeneficiaries,
  auditLog, verifiedContacts, memberRequests: memberRequestsLater,
});
// B2B Phase 2: wellness programmes and benefit rules (no usage counting or payouts).
export const b2bProgramService = createB2BProgramService({
  programs: b2bPrograms, benefits: b2bBenefits, gyms, trainers, users, challenges, auditLog, b2bService, settingsService,
  // b2bConsumptionService is defined below; these only run later, per request.
  usage: {
    allowanceFor: args => b2bConsumptionService.allowanceFor(args),
    sponsorSpentForProgram: id => b2bConsumptionService.sponsorSpentForProgram(id),
  },
  // Sponsored passes (b2bBillingService is defined below; this only runs later).
  passes: { passFor: args => b2bBillingService.passFor(args) },
});
// A member accepts or declines an organisation's request to add them by user id.
export const b2bMemberRequestService = createB2BMemberRequestService({
  db, b2bService, corporateService,
  previewBenefits: args => b2bProgramService.previewBenefits(args),
  // notificationService is created further down; this only runs later.
  notify: (userId, message) => notificationService.notify(userId, message),
  localeOf: async userId => (await communicationPreferences.findByIdAsync(userId))?.locale ?? null,
});
// B2B Phase 3: benefit evaluation and the consumption ledger (no payouts).
export const b2bConsumptionService = createB2BConsumptionService({
  db, programs: b2bPrograms, benefits: b2bBenefits, users, gyms, trainers, checkins, trainerBookings, auditLog, b2bService,
  // Reversing a gym visit voids its check-in (checkinStatusService is defined below; this only runs later).
  voidCheckin: ({ checkinId, reason, actorId }) => checkinStatusService.setStatus({ checkinId, status: 'voided', reason, actorId }),
});
// B2B sponsor billing: flat-fee sponsored passes, sponsor invoices, member unlock (no provider payouts).
export const b2bBillingService = createB2BBillingService({
  db, programs: b2bPrograms, benefits: b2bBenefits, users, subscriptions, paymentRequests, corporateAccounts, auditLog,
  b2bService, b2bProgramService, settingsService,
  // "Mark paid" records a payment for what is owed and allocates it (b2bFinanceService is defined below; these only run later).
  settleInFull: async ({ invoice, reference, actorId }) => {
    const owed = invoice.totalTzs - (invoice.amountPaidTzs || 0);
    const out = await b2bFinanceService.recordPayment({
      organizationId: invoice.organizationId, actorId,
      body: { amountTzs: owed, method: 'other', reference, allocations: [{ invoiceId: invoice.id, amountTzs: owed }] },
    });
    // The reference is already a recorded payment: it is allocated from there, not recorded twice.
    if (out.existing) return { error: 'payment_reference_in_use', status: 409, paymentId: out.payment.id, hint: 'Allocate that payment to this invoice.' };
    return out;
  },
  settlementsOf: invoiceId => b2bFinanceService.settlementsOf(invoiceId),
});
// Challenges, rewards and groups run by a B2B organisation's own users.
export const b2bEngagementAccess = createB2BEngagementAccess({ b2bService });
// B2B billing and financial management (Phase 5): agreements, payments and allocation, notes, statements, reconciliation.
export const b2bFinanceService = createB2BFinanceService({ db, users, b2bService, billing: b2bBillingService });
// B2B collections: payment details, "we have paid" notices, overdue reminders and the late-payment hold.
export const b2bCollectionsService = createB2BCollectionsService({
  db, finance: b2bFinanceService, email: emailSender(),
  // notificationService is created further down; this only runs later.
  notify: (userId, message) => notificationService.notify(userId, message),
});
// B2B analytics and reporting: a read layer over the ledgers; stores nothing.
export const b2bAnalyticsService = createB2BAnalyticsService({
  db, b2bService, finance: b2bFinanceService, programs: b2bPrograms, benefits: b2bBenefits, gyms, trainers,
  // challengeService and notificationService are created further down; these only run later.
  challengeProgress: (creatorType, creatorId, memberId) => challengeService.memberProgressForCreator(creatorType, creatorId, memberId),
  notify: (userId, message) => notificationService.notify(userId, message),
});
// Operations: job runs, locks, catch-up and exception records; and the recurring B2B jobs it runs.
export const opsService = createOpsService({ db });
// Bulk import of an organisation's people, invites for those who have not joined yet, and their emails.
export const b2bBeneficiaryImportService = createB2BBeneficiaryImportService({
  db, b2bService, emailSender: () => emailSender(), verifiedContacts,
  // Whether FitFlex can send email codes, i.e. whether someone listed by email
  // only can verify that address in the app (same source as emailCodes in GET /auth/options).
  emailCodes: () => emailSender().configured === true,
  // Invitation SMS goes through the shared SMS service (SMS_PROVIDER), so it is logged in SmsLog like every other SMS.
  // smsProvider and smsService are defined further down; this only runs later.
  smsSender: () => ({
    configured: smsProvider.configured === true,
    send: async (to, { text }) => {
      const out = await smsService.send({ category: 'invitation', text, recipients: [{ phone: to }], maxAttempts: 1 });
      const r = out.results[0] ?? {};
      return r.outcome === 'sent' ? { ok: true } : { ok: false, error: r.reason ?? r.error ?? 'not_accepted' };
    },
  }),
  // notificationService is created further down; this only runs later.
  notify: (userId, message) => notificationService.notify(userId, message),
});
// Benefit and programme lifecycle: notices to members and organisations, and renewal drafts.
export const b2bLifecycleService = createB2BLifecycleService({
  db, b2bService, programs: b2bPrograms, benefits: b2bBenefits, b2bProgramService, usage: b2bConsumptionService, emailSender: () => emailSender(),
  // notificationService is created further down; this only runs later.
  notify: (userId, message) => notificationService.notify(userId, message),
});
// Billing work that has waited too long, the provider-side checks, and alert emails to staff.
export const b2bWatchService = createB2BWatchService({ db, emailSender: () => emailSender() });
export const b2bOps = registerB2BJobs({
  ops: opsService, db, programs: b2bPrograms, b2bBeneficiaryImportService, b2bLifecycleService, b2bWatchService, b2bMemberRequestService,
  // Defined at the end of this file; only called when the job runs.
  promotionService: { runLifecycle: args => promotionService.runLifecycle(args) },
  promotionEventsService: { purge: args => promotionEventsService.purge(args) },
  b2bProgramService, b2bConsumptionService, b2bBillingService, b2bFinanceService, b2bCollectionsService, b2bAnalyticsService,
  // Defined further down; only called when the billing job runs.
  b2bSponsorRefundService: { repair: () => b2bSponsorRefundService.repair() },
});

// Marathon & running events · S1 (foundation): persistence, the hold primitive and the hold-expiry job.
// Dormant behind EVENTS_MODULE — nothing here is reachable from a route; the job returns at once while
// the flag is off. Construction is unconditional (like every other store) so the wiring is exercised.
export const eventStore = createPgEventStore({
  db,
  // S3: after an expired order's release commits, the purchaser is told once (eventsRegistrationService is
  // defined further down; the hook only runs later, from the job).
  hooks: { afterExpire: result => eventsRegistrationService.onOrderExpired(result) },
});
// S4: the composable money primitives (confirm / rehold / cancel paid places / refund effects). Dormant with the payment flags.
export const eventMoneyStore = createPgEventMoneyStore({ db, eventStore });
opsService.register({
  name: 'event-hold-expiry', title: 'Event hold expiry', schedule: { type: 'every', minutes: 5 }, quiet: true,
  description: 'Gives back the places of unpaid event orders whose hold has lapsed (order expired, registrations cancelled). Does nothing unless EVENTS_MODULE is on.',
  run: async () => {
    if (!eventsModuleOn()) return { processed: 0, succeeded: 0, failed: 0, skipped: 'flag_off' };
    const r = await eventStore.expireHolds();
    return { processed: r.due, succeeded: r.released, failed: 0, ...r };
  },
});

export const identityLinkService = createIdentityLinkService({ db });

// Identity V2 · I4: OrgMembership follows every write to its sources.
export const orgMembershipService = createOrgMembershipService({ db });
attachOrgMembershipSync({ users, trainers, subscriptions, orgMemberships: orgMembershipService });

// Identity V2 · I5: the gym memberships a persona's organisation authority comes from.
registerOrgMembershipLookup(personaId => db('OrgMembership')
  .where({ personaId, orgType: 'gym' }).whereIn('role', ['owner', 'staff'])
  .select('gymId', 'role', 'status', 'aclPermissions'));
export const authService = createAuthService({
  users, gyms, subscriptions, trainers, otps, products,
  signJwt, verifyFirebaseIdToken, publicUserId, gymService, trainerService,
  identityLink: identityLinkService, auditLog, orgMemberships: orgMembershipService,
  partnerAgeGuard: ({ user }) => personalDetailsService.assertPartnerAge({ user }),
});

/**
 * Slice A3: manual mobile-money payment. Off unless MANUAL_PAY_INSTRUCTIONS is
 * set; on, it applies only once the admin has saved a Lipa Namba and account name.
 */
export const manualPayment = {
  flagOn: () => manualPayInstructionsOn(),
  required: () => manualPayInstructionsOn() && manualPaymentConfigured(settingsService.manualPaymentSettings()),
  options: () => manualPaymentOptions(settingsService.manualPaymentSettings(), manualPayInstructionsOn()),
};
export const paymentReferenceStore = createPaymentReferenceStore({ db });
export const subscriptionService = createSubscriptionService({
  subscriptions, paymentRequests, checkins, gyms, settingsService, publicUserId, manualPayment,
  auditLog, referenceStore: paymentReferenceStore,
  eventLabels: requests => eventsPaymentsService.paymentLabels(requests),
});
export const accountService = createAccountService({
  users, trainers, trainerBookings, checkins, auditLog, initFirebaseAdmin, getAdminAuth, approvalStatusForRole,
  memberDobGuard: args => personalDetailsService.assertMemberProfileAge(args),
  // promotionEventsService is defined at the end of this file; this only runs later.
  // A deleted account lets its username go (held 90 days). usernameService is defined further down.
  // Vendor tools · S4 (review #224 H1): vendors' app-customer records of the buyer lose their name, and
  // their link to the account unless money is owed. Each step runs even if another fails.
  onAccountDeleted: async (userId, deleted = null) => {
    const errors = [];
    for (const step of [
      () => promotionEventsService.forgetUser(userId),
      () => usernameService.forgetUser(userId),
      () => vendorCustomerService.forgetBuyer(userId),
      // The "Personalised shop" switch goes once the Person has no personas left.
      () => forgetShopPreference(db, { userId, personId: deleted?.personId || null }),
      // Partner DOB slice 2: the declared date of birth and gender go with the last persona.
      () => forgetPersonDetails(db, { personId: deleted?.personId || null }),
    ]) {
      try { await step(); } catch (err) { errors.push(err); }
    }
    if (errors.length) throw errors[0];
  },
});

// Until a gym's owner is verified, only the gym's own members check in there.
// One check for the check-in and the scanner preview.
const gymOpenToPass = gymId => partnerGate.isGymOperational(gymId);
export const checkInService = createCheckInService({
  users, gyms, subscriptions, checkins, trainers, getTierConfig: settingsService.getTierConfig,
  onCheckin: checkin => partnerNotifier.gymCheckin(checkin),
  // A sponsor's B2B benefit funds the visit first; the member's own pass is the fallback.
  b2bFunding: b2bConsumptionService,
  gymOpenToPass,
});
// Gym settlement configuration (settlement Phase 2): not used by any payout flow yet.
export const settlementConfigService = createSettlementConfigService();
// Calculates and stores settlements (settlement Phase 3). It never approves or pays.
export const settlementService = createSettlementService({ configService: settlementConfigService });
export const checkinStatusService = createCheckinStatusService({
  checkins, auditLog,
  // Voiding a visit gives its B2B allowance back.
  onVoided: async ({ checkin, reason, actorId }) => {
    await b2bConsumptionService.releaseForSource({
      sourceType: 'gym_checkin', sourceId: checkin.id, reason: `check-in voided: ${reason}`, actorId,
    });
    // If the visit was already settled, raise what the gyms were overpaid.
    await settlementClawbackService.sweepQuietly({ checkinId: checkin.id, actorId });
  },
});
// Lifecycle events for gym automations. automationService is defined further
// down; these only run later, and never throw.
// A pass that becomes active may be a sponsored one waiting on the member's
// share: finish it first. Never let that stop the usual activation events.
async function finishSponsoredPass(sub) {
  try {
    await b2bBillingService.onSubscriptionActivated(sub);
  } catch (err) {
    console.warn('[b2b-billing] could not finish a sponsored pass (the daily job retries):', err?.message);
  }
}
const lifecycle = {
  activated: async (sub, ctx) => {
    await finishSponsoredPass(sub);
    // A gym membership that was paid for counts for the gym promotion the member tapped (never throws).
    await promotionEventsService.recordSubscription(sub, ctx);
    // A first membership at a gym is news for that gym (never throws; renewals are not).
    await partnerNotifier.gymMemberJoined(sub);
    return automationService.handleEvent({ type: 'membership_activated', subscription: sub });
  },
  paymentFailed: (sub, extra) => automationService.handleEvent({ type: 'payment_failed', subscription: sub, ...extra }),
};
// The username service is built further down; these only call it later.
const usernamesLazy = { handleOf: userId => usernameService.handleOf(userId) };
export const memberManagement = createMemberManagementService({
  usernames: usernamesLazy, users, gyms, subscriptions, checkins, paymentRequests, publicUserId, initFirebaseAdmin, getAdminAuth,
  onMembershipActivated: lifecycle.activated,
});
export const operatorService = createOperatorService({
  users, gyms, subscriptions, checkins, checkInService, publicUserId, settingsService, memberManagement,
  b2bFunding: b2bConsumptionService,
  settlementSummary: (args) => settlementViewService.ownerDashboard(args),
  // The scanner preview refuses as the check-in would (gym_not_verified).
  gymOpenToPass,
});

export const ownerGymService = createOwnerGymService({ gyms, users, trainers, invoices, auditLog, gymService, trainerService, partnerGate, gymPayoutOwner });
export const ownerStaffService = createOwnerStaffService({ users, auditLog, initFirebaseAdmin, getAdminAuth });

export const adminMemberService = createAdminMemberService({
  users, subscriptions, paymentRequests, checkins, gyms, auditLog, issueQr,
});
export const adminPaymentService = createAdminPaymentService({
  paymentRequests, subscriptions, users, auditLog, gyms,
  // Slice A3 (review L1): the final reference of an approval is checked for reuse.
  referenceStore: paymentReferenceStore, manualReferenceChecks: manualPayInstructionsOn,
  onSubscriptionActivated: async (sub, ctx) => {
    await finishSponsoredPass(sub);
    await notificationService.notifySubscriptionActivated(sub);
    await lifecycle.activated(sub, ctx);
  },
  onSubscriptionPaymentReversed: sub => promotionEventsService.reverseSubscription(sub),
  // An upgraded pass is the same plan: tell the member, nothing else (it is no new membership or conversion).
  onPassUpgraded: sub => notificationService.notifySubscriptionActivated(sub),
  onPaymentRejected: (sub, request) => lifecycle.paymentFailed(sub, { paymentRequestId: request.id, amountTzs: request.amountTzs }),
  onBookingPayment: (groupId, status) => trainerBookingService.applyPaymentToGroup(groupId, status),
  // 409 group_slot_rebooked { bookingIds } when a rejected session's slot was booked by someone else since.
  beforeBookingPayment: request => trainerBookingService.checkGroupPayment(request.bookingGroupId, 'approved'),
  onOrderPayment: (orderId, status) => shopService.applyPaymentToOrder(orderId, status),
  beforeOrderPayment: (request, opts) => shopService.checkOrderPayment(request, opts),
  // Marathon & Events S4 (EVENT_ORDER; eventsPaymentsService is defined further down, these only run at request time).
  beforeEventOrderPayment: (request, opts) => eventsPaymentsService.beforeEventOrderPayment(request, opts),
  onEventOrderPayment: (request, status) => eventsPaymentsService.onEventOrderPayment(request, status),
  writeEventDecision: (request, patch, guard, meta) => eventsPaymentsService.writeEventDecision(request, patch, guard, meta),
  checkEventRejection: input => eventsPaymentsService.checkRejectInput(input),
  projectEventRequests: requests => eventsPaymentsService.projectRequests(requests),
  listEventRequests: opts => eventsPaymentsService.listRequests(opts),
  eventOutcomeOf,
});
// Pay by mobile money (Malipo by Tunzaa). Dormant unless TUNZAA_PAYMENTS is set; the
// client exists only when MALIPO_API_KEY and MALIPO_API_SECRET are both set.
const tunzaaConfig = tunzaaSettings();
export const tunzaaSecretKey = tunzaaConfig?.secretKey ?? null;
if (tunzaaConfig && tunzaaPaymentsOn() && tunzaaConfig.environment !== 'live') {
  console.warn(`[tunzaa] payments are ON against the SANDBOX${tunzaaSandboxSettlesOn() ? ' and sandbox payments settle real plans (TUNZAA_SANDBOX_SETTLES)' : ' but will not be offered (set TUNZAA_SANDBOX_SETTLES to rehearse)'}`);
}
export const mobileMoneyService = createMobileMoneyService({
  paymentRequests, subscriptions, adminPaymentService, auditLog,
  client: tunzaaConfig ? createTunzaaClient({ settings: tunzaaConfig }) : null,
  enabled: tunzaaPaymentsOn,
  // Sandbox transactions still activate real plans, so against the sandbox this
  // must be asked for (TUNZAA_SANDBOX_SETTLES); live needs nothing extra.
  canSettle: () => tunzaaConfig?.environment === 'live' || tunzaaSandboxSettlesOn(),
  // Sandbox only (the client ignores it on live): 'success' or 'failure' to rehearse an outcome.
  scenario: tunzaaConfig?.environment === 'sandbox' ? (process.env.MALIPO_SANDBOX_SCENARIO || process.env.TUNZAA_SANDBOX_SCENARIO || null) : null,
  // Only tiers configured in Settings are sold (owner decision 2026-10-19).
  tierSellable: settingsService.isTierSellable,
  // B6a: trainer sessions and trainer gym passes (TUNZAA_TRAINER_PRODUCTS, needs TUNZAA_PAYMENTS).
  trainerProducts: tunzaaTrainerProductsOn,
  // A rejected session whose slot was booked by someone else since is not asked for (409 group_slot_rebooked).
  beforeBookingPayment: request => trainerBookingService.checkGroupPayment(request.bookingGroupId, 'approved'),
  // Marathon & Events S4 (EVENTS_PAYMENTS_TUNZAA, off): event orders become payable by mobile money. Built dormant (D1).
  eventOrders: {
    enabled: () => eventsPaymentsTunzaaOn() && Boolean(eventTicketKeyRing()),
    beforePrompt: request => eventsPaymentsService.hooks.beforePrompt(request),
    afterPrompt: (request, transactionId) => eventsPaymentsService.hooks.afterPrompt(request, transactionId),
    onHeld: (request, reason, detail) => eventsPaymentsService.hooks.onHeld(request, reason, detail),
    onFailed: (request, remark) => eventsPaymentsService.hooks.onFailed(request, remark),
  },
  webhookSeen: {
    has: async id => Boolean(await db('WebhookSeen').where({ id }).first('id')),
    mark: async id => { await db('WebhookSeen').insert({ id, at: new Date() }).onConflict('id').ignore(); },
  },
});
export const adminOwnerService = createAdminOwnerService({
  users, gyms, checkins, auditLog, gymService, gymPayoutOwner,
  onOwnerRemoved: prior => forgetPersonDetails(db, { personId: prior?.personId || null }),
});
export const adminApprovalService = createAdminApprovalService({ users, auditLog, partnerKycCases, partnerGate });
export const financeService = createFinanceService({ gyms, checkins, invoices, users, gymPayouts, settingsService });
// Gym settlement workflow (settlement Phase 4): submit, approve, hold, pay.
export const payoutEligibility = createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers, payoutOwner: gymPayoutOwner });
// Trainer payouts: a weekly statement per trainer on the same path as a gym statement.
export const trainerSettlementService = createTrainerSettlementService({
  trainers, users, payoutEligibility,
  // notificationService is created further down; this only runs later.
  notify: (userId, message) => notificationService.notify(userId, message),
});
// Vendor payouts: a weekly statement per vendor for delivered orders, on the same path.
export const vendorSettlementService = createVendorSettlementService({
  users, payoutEligibility,
  notify: (userId, message) => notificationService.notify(userId, message),
});
export const settlementWorkflowService = createSettlementWorkflowService({
  payoutEligibility, onStep: (statement, action) => partnerNotifier.gymStatement(statement, action),
});
export const settlementViewService = createSettlementViewService({ gyms, users, publicUserId, gymPayoutOwner });
// Recalculates a settled member cycle when one of its check-ins is voided and
// raises each gym's difference as an adjustment (settlement Phase 6).
export const settlementClawbackService = createSettlementClawbackService({ configService: settlementConfigService, workflow: settlementWorkflowService });
export const invoiceService = createInvoiceService({
  invoices, gyms, users, gymPayouts, auditLog, partnerGate, partnerSettlementAccounts, gymPayoutOwner,
});
// Replaceable, so specs can stand in for the Firebase admin SDK.
export const portalFirebaseAdmin = { init: initFirebaseAdmin, auth: getAdminAuth };
export const portalUserService = createPortalUserService({
  users, auditLog, isConfiguredAdminEmail, db,
  initFirebaseAdmin: () => portalFirebaseAdmin.init(), getAdminAuth: () => portalFirebaseAdmin.auth(),
  // The start password is checked with the same server key as PINs.
  pepper: () => pinPepper(), forgetSession: invalidateAccountStatus,
});
export const webhookService = createWebhookService({
  subscriptions, webhookSeen, paymentRequests,
  onSubscriptionActivated: lifecycle.activated,
  onPaymentFailed: (sub, paymentId) => lifecycle.paymentFailed(sub, { reference: `selcom:${paymentId}` }),
});
export const gymReviewService = createGymReviewService({
  usernames: usernamesLazy, gymReviews, gyms, checkins, subscriptions, users, auditLog,
  onNewReview: review => partnerNotifier.gymReview(review),
});
export const trainerReviewService = createTrainerReviewService({ usernames: usernamesLazy, trainerReviews, trainers, trainerBookings, users, auditLog });
export const whatsAppService = createWhatsAppService({
  apiKey: process.env.AFRICAS_TALKING_API_KEY,
  apiUrl: process.env.AFRICAS_TALKING_API_URL || undefined,
  username: process.env.AFRICAS_TALKING_USERNAME || undefined,
  users, auditLog, preferences: communicationPreferences,
});

export { resolveRequestUser, publicUserId, signJwt, initFirebaseAdmin, getAdminAuth };
export const favoriteService = createFavoriteService({ users, gyms });
// Sharing activities between members (mutual follows, groups, company).
// Who belongs to a company or organisation: one lookup for challenges, rewards and groups.
export const companyDirectory = createCompanyDirectory({ users, corporateEmployees, beneficiaries: b2bBeneficiaries });
// Member usernames (flag MEMBER_USERNAMES): the endpoints are off until it is set.
export const usernameService = createUsernameService({ memberUsernames, usernameReleases, users, trainers, gyms, auditLog });
export const socialService = createSocialService({
  usernames: usernameService, directory: companyDirectory, trainers,
  users, activities, follows, blocks, profiles: socialProfiles, groups: socialGroups,
  groupMembers: socialGroupMembers, kudos: activityKudos, comments: activityComments, views: activityViews, reports: socialReports,
  auditLog,
  // notificationService is defined further down; it's only called later.
  notify: (userId, message) => notificationService.notify(userId, message),
});
// Friend invitations by email / phone (Friends & Groups → People).
export const friendInvitationService = createFriendInvitationService({
  users, follows, blocks, invites: friendInvitations, notifications,
  notify: (userId, message) => notificationService.notify(userId, message),
  // Verified evidence only (LoginIdentifier.verifiedAt): never User.email /
  // User.phone, which are unverified and self-editable. See src/shared/verified-contacts.mjs.
  findMember: verifiedContacts.findMember, contactsFor: verifiedContacts.contactsFor,
  // FitFlex sends the invitation itself only when these are switched on
  // (FRIEND_INVITE_SMS / FRIEND_INVITE_WHATSAPP = on). SMS goes through the
  // shared SMS service and its registered sender name; WhatsApp needs an
  // approved template (FRIEND_INVITE_WHATSAPP_TEMPLATE) and a configured
  // provider. smsService / whatsApp* are defined further down; this runs later.
  delivery: () => ({
    sms: String(process.env.FRIEND_INVITE_SMS || '').toLowerCase() === 'on',
    whatsapp: String(process.env.FRIEND_INVITE_WHATSAPP || '').toLowerCase() === 'on',
  }),
  handleOf: userId => usernameService.handleOf(userId),
  // WhatsApp first (needs the channel enabled + configured and an approved
  // template); SMS through the shared SMS service when WhatsApp can't be used
  // or the number has no WhatsApp (the job in functions/jobs.mjs asks the
  // provider whether WhatsApp could deliver).
  channels: {
    whatsapp: async ({ phone, inviterName, link, locale, reference }) => {
      if (!whatsappChannelService.available()) return { status: 'skipped:whatsapp_not_available' };
      const language = locale === 'sw' ? 'sw' : 'en';
      const templateName = process.env.FRIEND_INVITE_WHATSAPP_TEMPLATE || 'friend_invitation';
      const approved = await db('WhatsAppTemplate')
        .where({ provider: whatsAppProvider.name, providerTemplateName: templateName, language, approvalStatus: 'approved' }).first('id');
      if (!approved) return { status: 'skipped:whatsapp_template_not_approved' };
      const to = whatsAppProvider.validateRecipient(phone);
      if (!to.ok) return { status: `skipped:${to.reason}` };
      const r = await whatsAppProvider.sendTemplate({
        to: to.to, templateName, language, parameters: [inviterName, link].map(whatsappParameter), category: 'utility', reference,
      });
      if (r.ok) return { status: 'sent', providerMessageId: r.providerMessageId ?? null };
      return { status: r.error === 'recipient_opted_out' ? 'skipped:recipient_opted_out' : 'failed' };
    },
    sms: async ({ phone, text, reference }) => {
      const r = await smsService.send({
        category: 'invitation', text, maxAttempts: 1,
        recipients: [{ phone, dedupeKey: `friend-invite:${reference}:${new Date().toISOString().slice(0, 13)}` }],
      });
      const x = r.results?.[0] ?? {};
      return { status: x.outcome === 'sent' ? 'sent' : (x.outcome === 'skipped' ? `skipped:${x.reason ?? 'not_sent'}` : 'failed') };
    },
    whatsappStatus: async (providerMessageId) => {
      if (!whatsappChannelService.available() || !providerMessageId) return null;
      const r = await whatsAppProvider.getDeliveryStatus(providerMessageId);
      return r?.error ? null : (r?.status ?? null);
    },
  },
  transition: async (id, from, patch, opts = {}) => {
    const q = db('FriendInvitation').where({ id, [opts.column ?? 'status']: from });
    if (opts.whereRecipientNull) q.whereNull('recipientUserId');
    return (await q.update(patch)) === 1;
  },
});
export const activityService = createActivityService({
  activities, users, routes: activityRoutes,
  resolveShare: (memberId, raw) => socialService.resolveShare(memberId, raw),
});
export const goalService = createGoalService({ goals, trainers });
export const workoutService = createWorkoutService({
  workouts, activities, users, defaultShare: memberId => socialService.defaultShareFor(memberId),
});
export const trainingPreferenceService = createTrainingPreferenceService({ users });
// Plans come from rules today; an 'ai' provider can be added beside it later.
// FitFlex's own changes to the exercise library, laid over the built-in one.
export const exerciseAdminService = createExerciseAdminService({ exercises: trainingExercises, auditLog });
export const trainingRecommendationEngine = createRecommendationEngine({
  providers: { rules: createRulesRecommendationProvider() },
  beforeRecommend: () => exerciseAdminService.ensureFresh(),
});
export const workoutExerciseService = createWorkoutExerciseService({
  workouts, plans: trainingPlans, users, ensureLibrary: () => exerciseAdminService.ensureFresh(),
});
export const trainingPlanService = createTrainingPlanService({
  plans: trainingPlans, workouts, users, engine: trainingRecommendationEngine,
  trainers, relationships: trainerMemberRelationships,
  notify: (userId, message) => notificationService.notify(userId, message),
});
export const trainerPlanService = createTrainerPlanService({
  plans: trainingPlans, workouts, users, relationships: trainerMemberRelationships, trainers, workoutPlans,
  engine: trainingRecommendationEngine,
  notify: (userId, message) => notificationService.notify(userId, message),
});
export const gymSharingService = createGymSharingService({
  usernames: usernamesLazy, sharing: gymMemberSharing, gyms, subscriptions, checkins, activities, users,
  challengeProgressFor: (...args) => challengeService.memberProgressForCreator(...args),
});
export const challengeService = createChallengeService({
  usernames: usernamesLazy, challenges, participants: challengeParticipants, users, trainers, gyms,
  relationships: trainerMemberRelationships, gymMemberSharing,
  gymMemberIds: memberId => gymSharingService.memberGymIds(memberId),
  activities, checkins, teams: challengeTeams, corporateEmployees, subscriptions, rewardAwards: challengeRewards,
  directory: companyDirectory,
});

// Internal product analytics (admin portal only).
export const analyticsService = createAnalyticsService({
  users, activities, workouts, goals, checkins, challenges,
  participants: challengeParticipants, relationships: trainerMemberRelationships,
  gymSharing: gymMemberSharing, gyms,
});

// Push is off unless PUSH_NOTIFICATIONS=on, so local dev and tests never call FCM.
export const notificationService = createNotificationService({
  users, deviceTokens, notifications, whatsApp: whatsAppService,
  getMessaging: process.env.PUSH_NOTIFICATIONS === 'on' ? () => { initFirebaseAdmin(); return getMessaging(); } : null,
  // Opens and taps of campaign messages update the communications ledger.
  // deliveryService is defined further down; these only run later.
  onOpened: (rows) => deliveryService.onOpened(rows),
  onClicked: (row, opts) => deliveryService.onClicked(row, opts),
  // The member's chosen message language (trainer_booking_no_show is sent in it).
  localeOf: async userId => (await communicationPreferences.findByIdAsync(userId))?.locale ?? null,
});

// Refunds: raised by cancellations the terms allow or by request; paid by FitFlex staff.
export const refundService = createRefundService({
  refunds, paymentRequests, subscriptions, users, auditLog,
  notify: (userId, message) => notificationService.notify(userId, message),
  onPaid: refund => (refund.kind === 'shop_order' ? shopService.markOrderRefunded(refund.orderId) : refund.kind === 'event_order' ? eventsRefundsService.onPaid(refund) : null),
  // Marathon & Events S4 (kind event_order; eventsRefundsService is defined further down, these only run at request time).
  onApproved: refund => eventsRefundsService.onApproved(refund),
  beforePaid: refund => (refund.kind === 'event_order' ? eventsRefundsService.beforePaid(refund) : null),
  onRejected: refund => eventsRefundsService.onRejected(refund),
  tellEvent: async (refund, type, extra) => eventsRefundsService.tellRefund(refund, await db('Event').where({ id: refund.eventId }).first('title'), type, extra),
  enrichRows: rows => eventsRefundsService.enrich(rows),
  raiseForEventPayment: args => eventsRefundsService.adminRaiseForPayment(args),
});
// A sponsor-covered trainer session returns what the member paid for it (no double charge).
export const b2bSponsorRefundService = createB2BSponsorRefundService({ db, refundService, trainerBookings });

// Identity V2 · I6: invitations (gym staff and trainers; no credentials set by organisations).
export const invitationService = createInvitationService({
  db, users, trainers, auditLog, ownerStaffAclScopes: GYM_STAFF_ACL_SCOPES,
  notify: (userId, message) => notificationService.notify(userId, message),
  activateDirectMembership: args => memberManagement.activateDirectMembership(args),
  createPersona: args => identityLinkService.createPersona(args),
  vendorStaffRoles: [...VENDOR_STAFF_ROLES], vendorStaffPermissions: [...VENDOR_STAFF_PERMISSIONS],
  ensureVendor: vendorUserId => orgMembershipService.syncUser(vendorUserId),
  // The invited person is told directly; someone new to FitFlex gets a start
  // PIN (only while FitFlex keeps PINs). Declared below, so reached lazily.
  senders: { sms: () => smsSender(), email: () => emailSender() },
  startPin: {
    enabled: () => identityFlag('V2_PIN_LOGIN') && pinAuthService.configured(),
    hash: (invitationId, pin) => pinAuthService.startPinHash(invitationId, pin),
  },
  isRegistered: identifier => registrationService.alreadyRegistered(identifier),
  localeOf: async userId => (await communicationPreferences.findByIdAsync(userId))?.locale ?? null,
  // Placeholder until the app is in the stores: the web app.
  appLink: () => process.env.APP_DOWNLOAD_LINK || 'https://fitflex-af-app.web.app',
  newTrainerProfile: async ({ userId, displayName, email, phone }) => {
    const row = trainerService.normalizeTrainerPayload({
      id: `trn_${randomUUID().slice(0, 8)}`, userId, displayName: displayName || email || phone || 'Trainer',
      email, phone, gymIds: [], status: 'active', approvalStatus: 'approved',
    }, {});
    await trainers.upsertAsync(t => t.id === row.id, row);
    return trainers.find(t => t.id === row.id) || row;
  },
});
// Identity V2 · I6a: a person proves an email or phone with a code FitFlex sends.
export const identifierService = createIdentifierService({
  db, users, identityLink: identityLinkService, auditLog,
  senders: { sms: smsSender, email: emailSender },
  // Codes are stored as a keyed hash; the key is the server's signing secret.
  secret: process.env.JWT_SECRET || 'fitflex-dev-secret-change-me',
  claimInvitations: personId => invitationService.claimFor(personId),
  linkingEnabled: () => identityFlag('V2_LINKING'),
});
// Identity V2 · I7a: number or email + PIN, checked by FitFlex.
// Replaceable, so specs can stand in for Firebase.
export const firebasePasswordCheck = { verify: verifyFirebasePassword };
export const pinAuthService = createPinAuthService({
  db, users, codes: identifierService, identityLink: identityLinkService, auditLog,
  sessionForPerson: personId => authService.sessionForPerson(personId),
  verifyFirebasePassword: (...args) => firebasePasswordCheck.verify(...args), signPurpose, verifyPurpose,
  forgetSession: invalidateAccountStatus,
  invitationsFor: async personId => (await invitationService.listMine({ personId })).invitations,
  linkingEnabled: () => identityFlag('V2_LINKING'),
  // The key the PIN is mixed with before hashing. It must be set in production
  // and never change afterwards, or every stored PIN stops matching.
  pepper: () => pinPepper(),
});
// Identity V2 · I7b: register with a number or email, a code, then a PIN.
export const registrationService = createRegistrationService({
  db, users, codes: identifierService, identityLink: identityLinkService, pinAuth: pinAuthService, auditLog,
  sessionForPerson: personId => authService.sessionForPerson(personId),
  approvalStatusForRole, signPurpose, verifyPurpose,
  claimInvitations: personId => invitationService.claimFor(personId),
  linkingEnabled: () => identityFlag('V2_LINKING'),
});
// A person with no profile yet: invited with a start PIN, or still to choose a role.
export const onboardingService = createOnboardingService({
  db, users, pinAuth: pinAuthService, invitations: invitationService, identityLink: identityLinkService, auditLog,
  sessionForPerson: personId => authService.sessionForPerson(personId),
  isRegistered: identifier => registrationService.alreadyRegistered(identifier),
  approvalStatusForRole, verifyPurpose,
});
// Identity V2 · I7e: replace the number or email a person signs in with.
export const identifierChangeService = createIdentifierChangeService({
  db, users, codes: identifierService, pinAuth: pinAuthService, identityLink: identityLinkService, auditLog,
  senders: { sms: smsSender, email: emailSender },
  linkingEnabled: () => identityFlag('V2_LINKING'),
});
// Identity V2 · account recovery for someone who lost every verified number and email (member path).
export const accountRecoveryService = createAccountRecoveryService({
  db, users, codes: identifierService, pinAuth: pinAuthService, identityLink: identityLinkService,
  senders: { sms: smsSender, email: emailSender }, signPurpose, verifyPurpose, partnerGate, auditLog,
  linkingEnabled: () => identityFlag('V2_LINKING'),
});
// SMS for communications and reminders: the provider named by SMS_PROVIDER
// (credentials from the environment only), "not configured" by default.
export const smsProvider = createSmsProvider();
export const smsService = createSmsService({
  db, provider: smsProvider, auditLog,
  // automationService is defined further down; this only runs later.
  gymsWithReminders: () => automationService.gymsWithReminders(),
});
// Verification codes keep their own sender (VERIFICATION_SMS_PROVIDER); each
// send is also written, redacted, to the SMS log. Hoisted: the identity
// services above take it as `senders.sms`.
function smsSender() { return smsService.verificationSender(plainSmsSender()); }
// WhatsApp for communications: the provider named by WHATSAPP_PROVIDER
// (credentials from the environment only), "not configured" by default.
// Available when a provider is configured and the admin kill switch is on.
export const whatsAppProvider = createWhatsAppProvider();
export const whatsappChannelService = createWhatsAppChannelService({ db, provider: whatsAppProvider, auditLog });
whatsappChannelService.isEnabled().catch(() => {});
// Communications audiences: who a gym (its direct members only) or FitFlex
// can message.
export const segmentService = createSegmentService({
  db, communicationPreferences, deviceTokens,
  pushAvailable: () => process.env.PUSH_NOTIFICATIONS === 'on',
  whatsappAvailable: () => whatsappChannelService.available(),
  smsAvailable: () => smsService.available(),
});
const positiveInt = (v, fallback) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
// FitFlex system templates and each gym's own.
export const templateService = createTemplateService({
  db, templates: communicationTemplates, gyms,
  renewalLink: process.env.COMMS_RENEWAL_URL || null,
  whatsappProvider: () => (whatsAppProvider.configured ? whatsAppProvider.name : null),
});
// Communication history: reads the message ledger (campaigns, recipients,
// member timelines, the message log).
export const communicationHistoryService = createCommunicationHistoryService({ db });
// Communication analytics: delivery, engagement and attributed payments.
export const communicationAnalyticsService = createCommunicationAnalyticsService({ db });
// Who may send communications, and for which gyms — checked against the
// account on every request, not just the token.
export const communicationAccess = createCommunicationAccess({ db, resolveRequestUser });
// Lifecycle automations: welcome, expiry reminders, expired, failed
// payment, inactivity — sent through the same ledger and dispatcher.
export const automationService = createAutomationService({
  db, segmentService, templateService, auditLog,
  renewalLink: process.env.COMMS_RENEWAL_URL || null,
  maxPerRun: positiveInt(process.env.COMMS_AUTOMATION_MAX_PER_RUN, 300),
  marketingWeeklyCap: positiveInt(process.env.COMMS_MARKETING_WEEKLY_CAP, 2),
});
export const campaignService = createCampaignService({
  db, campaigns: communicationCampaigns, gyms, segmentService, auditLog, templateService,
  historyService: communicationHistoryService,
  largeSendThreshold: positiveInt(process.env.COMMS_LARGE_SEND_THRESHOLD, 200),
  marketingWeeklyCap: positiveInt(process.env.COMMS_MARKETING_WEEKLY_CAP, 2),
  renewalLink: process.env.COMMS_RENEWAL_URL || null,
});
// Delivers queued campaign messages through the inbox, FCM, WhatsApp and SMS above.
export const deliveryService = createDeliveryService({
  db, notificationService, campaignService, whatsappChannel: whatsappChannelService, smsChannel: smsService,
  batchSize: positiveInt(process.env.COMMS_DISPATCH_BATCH, 200),
});
export const communicationPreferenceService = createCommunicationPreferenceService({
  preferences: communicationPreferences,
  whatsappAvailable: () => whatsappChannelService.available(),
  smsAvailable: () => smsService.available(),
});
export const challengeRewardService = createChallengeRewardService({
  challenges, participants: challengeParticipants, awards: challengeRewards, users, corporateEmployees,
  challengeService, auditLog, directory: companyDirectory,
  notify: (userId, message) => notificationService.notify(userId, message),
});
export const trainerClientService = createTrainerClientService({
  usernames: usernamesLazy, relationships: trainerMemberRelationships, trainers, users, workouts, workoutPlans, activities, goals, partnerGate,
  notify: (userId, message) => notificationService.notify(userId, message),
  challengeProgressFor: (...args) => challengeService.memberProgressForCreator(...args),
  challenges, participants: challengeParticipants,
});
// Partner KYC/KYB: what gym owners, trainers, vendors and companies must provide.
export const partnerKycService = createPartnerKycService({
  users, gyms, trainers, corporateAccounts,
  partnerKycCases, partnerPeople, partnerDocuments, partnerChecks,
  partnerSettlementAccounts, partnerAgreements, partnerKycEvents, auditLog,
  // notificationService is defined earlier in this file; it's only called later.
  notify: (userId, message) => notificationService.notify(userId, message),
  // KYC documents stay private on Zebra; the API streams them after its own checks.
  documentStore: createZebraDocumentStore(),
  // Events · S2: the organizer record its checklist reads, and the hook that keeps EventOrganizer.status
  // derived from the case (eventsOrganizerService is declared below; only called later).
  eventOrganizerOf: userId => eventCatalogueStore.organizerOfOwner(userId),
  onCaseStatusChanged: (kycCase, change) => eventsOrganizerService.syncOrganizerStatus(kycCase, { reasonNote: change?.reasonNote ?? null }),
});
// Phase B · B4a: one partner progress tracker on GET /me/kyc (flag PARTNER_PROGRESS; read-only).
export const partnerProgressService = createPartnerProgressService({ gyms, trainers, partnerGate, payoutEligibility });
export const termsService = createTermsService({ users, partnerKycService, auditLog });

// Moderation & Promotion. Moderation decides what may be shown; promotions decide
// what is highlighted among what may be shown. Neither changes discovery yet.
/**
 * Changes to promotions and moderation decisions are made one at a time across servers: a Postgres advisory lock
 * held for the length of the change (the same technique as the job locks in ops-service). Admin traffic is low,
 * so one lock for all of it is the simple and safe choice.
 */
const withPromotionLock = (key, fn) => db.transaction(async (trx) => {
  await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [key]);
  return fn();
});
export const entityResolver = createEntityResolver({
  gyms, trainers, users, products, partnerGate,
  // Vendors are Users: read only those rows, not every member.
  listVendors: () => db('User').where({ userType: 'vendor' }),
});
export const moderationService = createModerationService({
  states: moderationStates, events: moderationEvents, entities: entityResolver, auditLog,
  // promotionService is defined below; this only runs later, per decision.
  onEntityBlocked: (...args) => promotionService.holdForEntity(...args),
  withLock: withPromotionLock,
});
export const promotionService = createPromotionService({
  promotions, placements: promotionPlacements, campaigns: promotionCampaigns, configs: placementConfigs,
  geoAreas, entities: entityResolver, moderation: moderationService, auditLog, organizations: b2bOrganizations,
  withLock: withPromotionLock,
});
export const discoveryService = createDiscoveryService({
  gymService, trainerService, shopService, partnerGate, moderationGate, promotionService, configs: placementConfigs, geoAreas,
  signToken: signServedToken,
});

// Promotion analytics: events from the apps, purchases the server can verify, and what they add up to.
export const promotionEventsService = createPromotionEventsService({ db, promotions });
export const promotionAnalyticsService = createPromotionAnalyticsService({
  db, promotions, campaigns: promotionCampaigns, entities: entityResolver,
});

// Shop home (GET /shop/home, behind SHOP_HOME_V2): role sections over the same catalogue, Featured system and orders.
// Sales are read from paid, not cancelled orders of the last 30 days only, newest first and capped, so memory stays bounded.
const SHOP_HOME_MAX_ORDERS = 20_000;
// Shop home banners (SHOP_BANNERS, Phase 2 slice 1): vendor proposals, staff approval, the live
// list for GET /shop/home. Photos use the app-photo pipeline: private on Zebra until approved.
export const shopBannerService = createShopBannerService({
  store: createPgShopBannerStore({ db }),
  documentStore: createZebraDocumentStore(),
  publicStore: createZebraPublicStore(),
  partnerGate, moderationGate,
  notifyVendor: (vendorId, type, data) => shopService.notifyVendor(vendorId, type, data),
});
// "Personalised shop" switch (SHOP_PERSONALISATION, Phase 2 slice 2): one row per Person, no row = on.
export const shopPreferenceService = createShopPreferenceService({
  store: createPgShopPreferenceStore({ db }), users, identityLink: identityLinkService,
  trainerProfileOf: userId => trainerService.findProfileByUser(userId),
});
// Purchase history is the person's own orders only, read per request; capped so memory stays bounded.
const SHOP_HISTORY_MAX_ORDERS = 500;
export const shopHomeService = createShopHomeService({
  bannerFeed: args => shopBannerService.feed(args),
  preferences: shopPreferenceService,
  buyerPaidOrders: ({ buyerIds, since }) => (buyerIds.length ? db('ShopOrder')
    .whereIn('buyerId', buyerIds).where({ paymentStatus: 'paid' }).whereNot({ status: 'cancelled' }).where('createdAt', '>=', since)
    .orderBy('createdAt', 'desc').limit(SHOP_HISTORY_MAX_ORDERS)
    .select('id', 'buyerId', 'items', 'status', 'paymentStatus', 'createdAt') : []),
  shopService, discoveryService, promotionService, users, trainerService, identityLink: identityLinkService,
  recentPaidOrders: ({ since }) => db('ShopOrder')
    .where({ paymentStatus: 'paid' }).whereNot({ status: 'cancelled' }).where('createdAt', '>=', since)
    .orderBy('createdAt', 'desc').limit(SHOP_HOME_MAX_ORDERS)
    // pickupGymId + buyerId: slice 3 counts DISTINCT buyers picking up at gyms in a city ("Popular near you",
    // k = 5). Both are dropped from the cached rows once counted (shop-home-service loadNear).
    .select('id', 'buyerRole', 'items', 'status', 'paymentStatus', 'createdAt', 'pickupGymId', 'buyerId'),
  signToken: signServedToken,
  // Slice 3 (SHOP_NEAR_YOU): areas and the pickup gyms' cities. Read only while the flag is on.
  geoAreas,
  gymAreas: () => db('Gym').whereNotNull('cityId').orWhereNotNull('regionId').select('id', 'cityId', 'regionId'),
});

// Admin-managed app photos (HERO_IMAGES_CMS, plan slice 4). Uploads stay private on Zebra (the
// KYC document store); public files are made only on publish.
export const heroImageService = createHeroImageService({
  store: createPgHeroImageStore({ db }),
  documentStore: createZebraDocumentStore(),
  publicStore: createZebraPublicStore(),
});

// Marathon & running events · S2: organizer capability, event management, admin moderation, discovery.
// Dormant behind EVENTS_MODULE (every route but GET /events/options answers 404 feature_disabled).
export const eventCatalogueStore = createPgEventCatalogueStore({ db });
registerOrganizerLookup(userId => eventCatalogueStore.organizerForUser(userId));
export const eventsOrganizerService = createEventsOrganizerService({
  db, eventStore, catalogue: eventCatalogueStore, users, identityLink: identityLinkService, partnerKyc: partnerKycService,
  invitations: invitationService, orgMemberships: orgMembershipService, auditLog,
  notify: (userId, message) => notificationService.notify(userId, message),
  closingSoonHours: eventsClosingSoonHours, autoCompleteGraceHours: eventAutoCompleteGraceHours,
  // S3: the overview counters (eventsRegistrationService is defined below; only called later).
  registrationTotals: organizerId => eventsRegistrationService.organizerTotals(organizerId),
});
export const eventsAdminService = createEventsAdminService({ db, catalogue: eventCatalogueStore, organizerService: eventsOrganizerService, closingSoonHours: eventsClosingSoonHours, getRefunds: () => eventsRefundsService });
export const eventsDiscoveryService = createEventsDiscoveryService({
  catalogue: eventCatalogueStore, closingSoonHours: eventsClosingSoonHours,
  flags: { module: eventsModuleOn, favourites: eventsFavouritesOn, registration: eventsRegistrationOn },
  // S3 (spec §3.1): the registration keys of the probe. payment is 'none' in S3 (S4 derives manual / provider).
  registrationOptions: () => ({
    holdTtlMinutes: eventStore.holdTtlMinutes(), maxParticipantsPerOrder: eventsMaxParticipantsPerOrder(), teams: true, corporate: true,
    claim: { smsCodes: smsSender().configured === true, emailCodes: emailSender().configured === true },
    consentTextVersion: eventsConsentTextVersion(),
    // S4 (§3.1): payment 'none' | 'manual' | 'provider' (fail closed without EVENT_TICKET_SECRET), the quoted targets, hold rules, ticket capabilities.
    ...eventsPaymentsService.optionsBlock(), refundDays: eventsRefundTargetDays(),
  }),
});
// Marathon & running events · S3: registration modes, checkout orders, claims, teams, corporate rosters.
// Dormant behind EVENTS_REGISTRATION (needs EVENTS_MODULE): every route answers 404 feature_disabled otherwise.
// Claim invitations and cancellation notices go through the shared SMS service like B2B invites.
const eventSenders = {
  sms: () => ({
    configured: smsProvider.configured === true,
    send: async (to, { text }) => {
      const out = await smsService.send({ category: 'invitation', text, recipients: [{ phone: to }], maxAttempts: 1 });
      const r = out.results[0] ?? {};
      return r.outcome === 'sent' ? { ok: true } : { ok: false, error: r.reason ?? r.error ?? 'not_accepted' };
    },
  }),
  email: () => emailSender(),
};
const eventsLocaleOf = async userId => (await communicationPreferences.findByIdAsync(userId))?.locale ?? null;
export const eventsRegistrationService = createEventsRegistrationService({
  db, eventStore, catalogue: eventCatalogueStore, users, verifiedContacts, auditLog,
  notify: (userId, message) => notificationService.notify(userId, message),
  localeOf: eventsLocaleOf,
  closingSoonHours: eventsClosingSoonHours,
  claimCodes: () => ({ smsCodes: smsSender().configured === true, emailCodes: emailSender().configured === true }),
  senders: eventSenders,
  // S4: payments and refunds (defined below; read at request time).
  getPayments: () => eventsPaymentsService, getRefunds: () => eventsRefundsService,
});
export const eventsRosterService = createEventsRosterService({ db, registration: eventsRegistrationService, users, closingSoonHours: eventsClosingSoonHours, getRefunds: () => eventsRefundsService });

// Marathon & running events · S4: payments (manual path first; Tunzaa built dormant), tickets, refunds. Dormant behind
// EVENTS_PAYMENTS_MANUAL / EVENTS_PAYMENTS_TUNZAA: with both off GET /events/options.payment is 'none' and S3 is unchanged.
export const eventsPaymentsService = createEventsPaymentService({
  db, eventStore, money: eventMoneyStore, registration: eventsRegistrationService, users, references: paymentReferenceStore, manualPayment,
  flags: { manual: eventsPaymentsManualOn, tunzaa: eventsPaymentsTunzaaOn },
  providerEffective: () => mobileMoneyService.options().enabled === true,
  providerSettle: requestId => mobileMoneyService.settleById(requestId),
  notify: (userId, message) => notificationService.notify(userId, message),
  localeOf: eventsLocaleOf,
  ops: opsService,
});
export const eventsRefundsService = createEventsRefundService({
  db, eventStore, money: eventMoneyStore, registration: eventsRegistrationService,
  getPayments: () => eventsPaymentsService, getRefundService: () => refundService,
  notice: (userId, n) => eventsPaymentsService.internals.notice(userId, n),
  senders: eventSenders, ops: opsService,
});
opsService.register({
  name: 'event-payment-reconciliation', title: 'Event payment reconciliation', schedule: { type: 'every', minutes: 60 }, quiet: true, domain: 'finance',
  description: 'Event payments: re-applies approved payments whose order is not confirmed, settles Tunzaa prompts whose callback was lost (and expires stale ones), retries unsent claim invitations once, and re-applies paid refunds whose places were not updated. Does nothing unless EVENTS_MODULE and EVENTS_REGISTRATION are on. Bounded to 100 rows per step; safe to run twice.',
  run: async () => {
    if (!eventsRegistrationOn()) return { processed: 0, succeeded: 0, failed: 0, skipped: 'flag_off' };
    const r = await eventsPaymentsService.sweep({ refunds: eventsRefundsService });
    const processed = r.repaired + r.settled + r.expired + r.invited + r.refundsApplied + r.batchesResumed + r.failed;
    return { processed, succeeded: processed - r.failed, failed: r.failed, ...r };
  },
});
opsService.register({
  name: 'event-lifecycle', title: 'Event lifecycle', schedule: { type: 'every', minutes: 5 }, quiet: true,
  description: 'Moves events along automatically: published → registration_closed at registrationClosesAt, → in_progress at startsAt, in_progress → completed at endsAt + EVENT_AUTO_COMPLETE_GRACE_HOURS (default 6). Does nothing unless EVENTS_MODULE is on.',
  run: async () => {
    if (!eventsModuleOn()) return { processed: 0, succeeded: 0, failed: 0, skipped: 'flag_off' };
    const r = await eventsOrganizerService.runLifecycle();
    return { processed: r.due, succeeded: r.moved, failed: r.failed, ...r };
  },
});
