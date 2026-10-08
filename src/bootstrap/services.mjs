// Composition root — every service is instantiated exactly once here with its
// dependencies injected, then imported by the thin REST modules in functions/.
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
import { identityFlag } from '../shared/feature-flags.mjs';
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
import { createShopService, STAFF_ROLES as VENDOR_STAFF_ROLES, STAFF_PERMISSIONS as VENDOR_STAFF_PERMISSIONS } from '../services/shop-service.mjs';
import { createGymReviewService } from '../services/gym-review-service.mjs';
import { createTrainerReviewService } from '../services/trainer-review-service.mjs';
import { createWhatsAppService } from '../services/whatsapp-service.mjs';
import { createFavoriteService } from '../services/favorite-service.mjs';
import { createActivityService } from '../services/activity-service.mjs';
import { createGoalService } from '../services/goal-service.mjs';
import { createWorkoutService } from '../services/workout-service.mjs';
import { createSocialService } from '../services/social-service.mjs';
import { createTrainerClientService } from '../services/trainer-client-service.mjs';
import { createGymSharingService } from '../services/gym-sharing-service.mjs';
import { createChallengeService } from '../services/challenge-service.mjs';
import { createChallengeRewardService } from '../services/challenge-reward-service.mjs';
import { createAnalyticsService } from '../services/analytics-service.mjs';
import { createNotificationService } from '../services/notification-service.mjs';
import { getMessaging } from 'firebase-admin/messaging';
import { createCorporateService } from '../services/corporate-service.mjs';
import { createB2BService } from '../services/b2b-service.mjs';
import { createB2BProgramService } from '../services/b2b-program-service.mjs';
import { createB2BConsumptionService } from '../services/b2b-consumption-service.mjs';
import { createB2BBillingService } from '../services/b2b-billing-service.mjs';
import { createB2BCollectionsService } from '../services/b2b-collections-service.mjs';
import { createB2BAnalyticsService } from '../services/b2b-analytics-service.mjs';
import { createOpsService } from '../services/ops-service.mjs';
import { registerB2BJobs } from '../services/b2b-jobs.mjs';
import { createWhatsAppNotifier } from '../integrations/whatsapp-hooks.mjs';
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
import { createWhatsAppProvider } from '../integrations/whatsapp/provider.mjs';
import { createPartnerKycService } from '../services/partner-kyc-service.mjs';
import { createPartnerGate } from '../services/partner-gate.mjs';
import { createRefundService } from '../services/refund-service.mjs';
import { createB2BFinanceService } from '../services/b2b-finance-service.mjs';
import { createCompanyDirectory } from '../services/company-directory.mjs';
import { createB2BEngagementAccess } from '../services/b2b-engagement-access.mjs';
import { createTrainerSettlementService } from '../services/trainer-settlement-service.mjs';
import { createB2BSponsorRefundService } from '../services/b2b-sponsor-refund-service.mjs';
import { createModerationGate } from '../services/moderation-gate.mjs';
import { createEntityResolver } from '../services/promotion-entities.mjs';
import { createModerationService } from '../services/moderation-service.mjs';
import { createPromotionService } from '../services/promotion-service.mjs';
import { createDiscoveryService } from '../services/discovery-service.mjs';
import { createZebraDocumentStore } from '../infra/storage-client.mjs';
import { db } from '../infra/knex-store.mjs';
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
  follows, blocks, socialProfiles, socialGroups, socialGroupMembers, activityKudos, activityComments, activityViews, socialReports,
  trainerMemberRelationships, workoutPlans, gymMemberSharing, challenges, challengeParticipants,
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

// requireAuth rejects tokens of suspended accounts (the JWT alone can't know).
// A suspended Person (FitFlex-level only) suspends every persona; a suspended
// persona never suspends the Person (invariant 30).
registerAccountStatusLookup(async id => {
  const user = await users.findByIdAsync(id);
  if (!user) return null;
  if (user.accountStatus === 'suspended') return 'suspended';
  if (user.personId) {
    const person = await db('Person').where({ id: user.personId }).first();
    if (person?.status === 'suspended') return 'suspended';
    // I7a: sessions issued before a PIN reset or change are over.
    if (person?.sessionsValidAfter) return { status: user.accountStatus ?? null, sessionsValidAfter: person.sessionsValidAfter };
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

export const settingsService = createSettingsService({ platformSettings, auditLog });
export const gymService = createGymService({ gyms, users, checkins, auditLog });
export const trainerService = createTrainerService({ trainers, gyms, trainerBookings, auditLog, gymService, partnerGate });
export const trainerBookingService = createTrainerBookingService({
  trainerBookings, trainerSessions, trainers, gyms, users, auditLog, trainerService,
  subscriptions, paymentRequests, partnerGate,
  notify: (event, payload) => notificationService.notifyTrainerBooking(event, payload),
  // refundService is defined below; this only runs later.
  onRefundDue: ({ booking, reasonCode, actorId, role }) => refundService.raise({
    memberId: booking.memberId, kind: 'trainer_booking', sourceId: booking.id, paymentRequestId: booking.paymentRequestId,
    amountTzs: booking.amountTzs, currency: booking.currency || 'TZS', reasonCode,
    requestedBy: actorId, requestedRole: role, approved: true,
  }).then(out => out.refund || null),
  // A completed session may use a B2B trainer benefit; un-completing it gives the benefit back.
  // b2bConsumptionService is defined below; this only runs later.
  // The member paid the booking in full; once a sponsor covers it, that money goes back to the member.
  onStatusChanged: async ({ booking, from, actorId }) => {
    if (booking.status === 'completed') {
      const used = await b2bConsumptionService.consumeTrainerSession({ booking });
      if (used.consumed) await b2bSponsorRefundService.onSessionConsumed({ booking, consumption: used.consumption });
      return used;
    }
    if (from !== 'completed') return null;
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
  onRefundDue: ({ order, reasonCode, actorId, role }) => refundService.raise({
    memberId: order.buyerId, kind: 'shop_order', sourceId: order.id,
    amountTzs: order.totalTzs, reasonCode, requestedBy: actorId, requestedRole: role, approved: true,
  }).then(out => out.refund || null),
  marketplaceEnquiries, marketplaceNotifications, productReviews, partnerGate, partnerKycCases, publicGate: moderationGate,
});
export const whatsAppNotifier = createWhatsAppNotifier();
export const corporateService = createCorporateService({
  users, checkins, corporateAccounts, corporateEmployees, corporateBills, auditLog, settingsService,
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
  auditLog,
});
// B2B Phase 2: wellness programmes and benefit rules (no usage counting or payouts).
export const b2bProgramService = createB2BProgramService({
  programs: b2bPrograms, benefits: b2bBenefits, gyms, trainers, users, challenges, auditLog, b2bService,
  // b2bConsumptionService is defined below; these only run later, per request.
  usage: {
    allowanceFor: args => b2bConsumptionService.allowanceFor(args),
    sponsorSpentForProgram: id => b2bConsumptionService.sponsorSpentForProgram(id),
  },
  // Sponsored passes (b2bBillingService is defined below; this only runs later).
  passes: { passFor: args => b2bBillingService.passFor(args) },
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
export const b2bOps = registerB2BJobs({
  ops: opsService, db, programs: b2bPrograms,
  // Defined at the end of this file; only called when the job runs.
  promotionService: { runLifecycle: args => promotionService.runLifecycle(args) },
  b2bProgramService, b2bConsumptionService, b2bBillingService, b2bFinanceService, b2bCollectionsService, b2bAnalyticsService,
  // Defined further down; only called when the billing job runs.
  b2bSponsorRefundService: { repair: () => b2bSponsorRefundService.repair() },
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
});

export const subscriptionService = createSubscriptionService({ subscriptions, paymentRequests, checkins, gyms, settingsService, publicUserId });
export const accountService = createAccountService({
  users, trainers, trainerBookings, checkins, auditLog, initFirebaseAdmin, getAdminAuth, approvalStatusForRole,
});

export const checkInService = createCheckInService({
  users, gyms, subscriptions, checkins, trainers, getTierConfig: settingsService.getTierConfig,
  // A sponsor's B2B benefit funds the visit first; the member's own pass is the fallback.
  b2bFunding: b2bConsumptionService,
  // Until a gym's owner is verified, only the gym's own members check in there.
  gymOpenToPass: gymId => partnerGate.isGymOperational(gymId),
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
  activated: async (sub) => {
    await finishSponsoredPass(sub);
    return automationService.handleEvent({ type: 'membership_activated', subscription: sub });
  },
  paymentFailed: (sub, extra) => automationService.handleEvent({ type: 'payment_failed', subscription: sub, ...extra }),
};
export const memberManagement = createMemberManagementService({
  users, gyms, subscriptions, checkins, paymentRequests, publicUserId, initFirebaseAdmin, getAdminAuth,
  onMembershipActivated: lifecycle.activated,
});
export const operatorService = createOperatorService({
  users, gyms, subscriptions, checkins, checkInService, publicUserId, settingsService, memberManagement,
  b2bFunding: b2bConsumptionService,
});

export const ownerGymService = createOwnerGymService({ gyms, users, trainers, invoices, auditLog, gymService, trainerService, partnerGate });
export const ownerStaffService = createOwnerStaffService({ users, auditLog, initFirebaseAdmin, getAdminAuth });

export const adminMemberService = createAdminMemberService({
  users, subscriptions, paymentRequests, checkins, gyms, auditLog, issueQr,
});
export const adminPaymentService = createAdminPaymentService({
  paymentRequests, subscriptions, users, auditLog, gyms,
  onSubscriptionActivated: async (sub) => {
    await finishSponsoredPass(sub);
    await notificationService.notifySubscriptionActivated(sub);
    await lifecycle.activated(sub);
  },
  onPaymentRejected: (sub, request) => lifecycle.paymentFailed(sub, { paymentRequestId: request.id, amountTzs: request.amountTzs }),
  onBookingPayment: (groupId, status) => trainerBookingService.applyPaymentToGroup(groupId, status),
  onOrderPayment: (orderId, status) => shopService.applyPaymentToOrder(orderId, status),
});
export const adminOwnerService = createAdminOwnerService({ users, gyms, checkins, auditLog, gymService });
export const adminApprovalService = createAdminApprovalService({ users, auditLog, partnerKycCases, partnerGate });
export const financeService = createFinanceService({ gyms, checkins, invoices, users, gymPayouts, settingsService });
// Gym settlement workflow (settlement Phase 4): submit, approve, hold, pay.
export const payoutEligibility = createPayoutEligibility({ users, gyms, partnerGate, partnerSettlementAccounts, trainers });
// Trainer payouts: a weekly statement per trainer on the same path as a gym statement.
export const trainerSettlementService = createTrainerSettlementService({
  trainers, users, payoutEligibility,
  // notificationService is created further down; this only runs later.
  notify: (userId, message) => notificationService.notify(userId, message),
});
export const settlementWorkflowService = createSettlementWorkflowService({ payoutEligibility });
export const settlementViewService = createSettlementViewService({ gyms, users, publicUserId });
// Recalculates a settled member cycle when one of its check-ins is voided and
// raises each gym's difference as an adjustment (settlement Phase 6).
export const settlementClawbackService = createSettlementClawbackService({ configService: settlementConfigService, workflow: settlementWorkflowService });
export const invoiceService = createInvoiceService({
  invoices, gyms, users, gymPayouts, auditLog, partnerGate, partnerSettlementAccounts,
});
export const portalUserService = createPortalUserService({ users, auditLog, initFirebaseAdmin, getAdminAuth, isConfiguredAdminEmail });
export const webhookService = createWebhookService({
  subscriptions, webhookSeen,
  onSubscriptionActivated: lifecycle.activated,
  onPaymentFailed: (sub, paymentId) => lifecycle.paymentFailed(sub, { reference: `selcom:${paymentId}` }),
});
export const gymReviewService = createGymReviewService({ gymReviews, gyms, checkins, subscriptions, users, auditLog });
export const trainerReviewService = createTrainerReviewService({ trainerReviews, trainers, trainerBookings, users, auditLog });
export const whatsAppService = createWhatsAppService({
  apiKey: process.env.AFRICAS_TALKING_API_KEY,
  apiUrl: process.env.AFRICAS_TALKING_API_URL || undefined,
  username: process.env.AFRICAS_TALKING_USERNAME || undefined,
  users, auditLog,
});

export { resolveRequestUser, publicUserId, signJwt, initFirebaseAdmin, getAdminAuth };
export const favoriteService = createFavoriteService({ users, gyms });
// Sharing activities between members (mutual follows, groups, company).
// Who belongs to a company or organisation: one lookup for challenges, rewards and groups.
export const companyDirectory = createCompanyDirectory({ users, corporateEmployees, beneficiaries: b2bBeneficiaries });
export const socialService = createSocialService({
  directory: companyDirectory,
  users, activities, follows, blocks, profiles: socialProfiles, groups: socialGroups,
  groupMembers: socialGroupMembers, kudos: activityKudos, comments: activityComments, views: activityViews, reports: socialReports,
  auditLog,
  // notificationService is defined further down; it's only called later.
  notify: (userId, message) => notificationService.notify(userId, message),
});
export const activityService = createActivityService({
  activities, users, routes: activityRoutes,
  resolveShare: (memberId, raw) => socialService.resolveShare(memberId, raw),
});
export const goalService = createGoalService({ goals, trainers });
export const workoutService = createWorkoutService({
  workouts, activities, defaultShare: memberId => socialService.defaultShareFor(memberId),
});
export const gymSharingService = createGymSharingService({
  sharing: gymMemberSharing, gyms, subscriptions, checkins, activities, users,
  challengeProgressFor: (...args) => challengeService.memberProgressForCreator(...args),
});
export const challengeService = createChallengeService({
  challenges, participants: challengeParticipants, users, trainers, gyms,
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
});

// Refunds: raised by cancellations the terms allow or by request; paid by FitFlex staff.
export const refundService = createRefundService({
  refunds, paymentRequests, subscriptions, users, auditLog,
  notify: (userId, message) => notificationService.notify(userId, message),
  onPaid: refund => (refund.kind === 'shop_order' ? shopService.markOrderRefunded(refund.orderId) : null),
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
  pepper: () => process.env.PIN_PEPPER || (process.env.NODE_ENV === 'production' ? null : 'fitflex-dev-pin-pepper'),
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
  relationships: trainerMemberRelationships, trainers, users, workouts, workoutPlans, activities, goals, partnerGate,
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
});

// Moderation & Promotion. Moderation decides what may be shown; promotions decide
// what is highlighted among what may be shown. Neither changes discovery yet.
export const entityResolver = createEntityResolver({ gyms, trainers, users, products, partnerGate });
export const moderationService = createModerationService({
  states: moderationStates, events: moderationEvents, entities: entityResolver, auditLog,
  // promotionService is defined below; this only runs later, per decision.
  onEntityBlocked: (...args) => promotionService.holdForEntity(...args),
});
export const promotionService = createPromotionService({
  promotions, placements: promotionPlacements, campaigns: promotionCampaigns, configs: placementConfigs,
  geoAreas, entities: entityResolver, moderation: moderationService, auditLog, organizations: b2bOrganizations,
});
export const discoveryService = createDiscoveryService({
  gymService, trainerService, shopService, partnerGate, moderationGate, promotionService, configs: placementConfigs, geoAreas,
});
