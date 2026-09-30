// Composition root — every service is instantiated exactly once here with its
// dependencies injected, then imported by the thin REST modules in functions/.
import { sign as signJwt, registerAccountStatusLookup } from '../auth/jwt.mjs';
import { verifyFirebaseIdToken, initFirebaseAdmin, getAdminAuth } from '../auth/firebase.mjs';
import { issue as issueQr } from '../auth/qr-token.mjs';
import { createCheckInService } from '../services/check-in-service.mjs';
import { createSettlementConfigService } from '../services/settlement-config-service.mjs';
import { createCheckinStatusService } from '../services/checkin-status-service.mjs';
import { createMemberManagementService } from '../services/member-management-service.mjs';
import { createIdentityService } from '../services/identity-service.mjs';
import { createGymService } from '../services/gym-service.mjs';
import { createTrainerService } from '../services/trainer-service.mjs';
import { createTrainerBookingService } from '../services/trainer-booking-service.mjs';
import { createSettingsService } from '../services/settings-service.mjs';
import { createAuthService, isConfiguredAdminEmail, approvalStatusForRole } from '../services/auth-service.mjs';
import { createIdentityLinkService } from '../services/identity-link-service.mjs';
import { createSubscriptionService } from '../services/subscription-service.mjs';
import { createAccountService } from '../services/account-service.mjs';
import { createOperatorService } from '../services/operator-service.mjs';
import { createOwnerGymService } from '../services/owner-gym-service.mjs';
import { createOwnerStaffService } from '../services/owner-staff-service.mjs';
import { createAdminMemberService } from '../services/admin-member-service.mjs';
import { createAdminPaymentService } from '../services/admin-payment-service.mjs';
import { createAdminOwnerService } from '../services/admin-owner-service.mjs';
import { createAdminApprovalService } from '../services/admin-approval-service.mjs';
import { createFinanceService } from '../services/finance-service.mjs';
import { createInvoiceService } from '../services/invoice-service.mjs';
import { createPortalUserService } from '../services/portal-user-service.mjs';
import { createWebhookService } from '../services/webhook-service.mjs';
import { createTrainerEngagementService } from '../services/trainer-engagement-service.mjs';
import { createShopService } from '../services/shop-service.mjs';
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
import { createZebraDocumentStore } from '../infra/storage-client.mjs';
import { db } from '../infra/knex-store.mjs';
import {
  users, gyms, subscriptions, checkins, otps, auditLog, paymentRequests,
  trainers, trainerBookings, platformSettings, invoices, gymPayouts, gymOwners, webhookSeen,
  trainerEngagements, trainerSessions, products, shopOrders,
  marketplaceEnquiries, marketplaceNotifications, productReviews,
  gymReviews, trainerReviews,
  corporateAccounts, corporateEmployees, corporateBills,
  b2bOrganizations, b2bOrganizationUsers, b2bBeneficiaries,
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
    const person = await db('Person').where({ id: user.personId }).first('status');
    if (person?.status === 'suspended') return 'suspended';
  }
  return user.accountStatus ?? null;
});

export const identityService = createIdentityService({ users });
// KYC enforcement for partners created from the enforcement start; existing ones are exempt.
export const partnerGate = createPartnerGate({ users, partnerKycCases });
const { resolveRequestUser, publicUserId } = identityService;

export const settingsService = createSettingsService({ platformSettings, auditLog });
export const gymService = createGymService({ gyms, users, checkins, auditLog });
export const trainerService = createTrainerService({ trainers, gyms, trainerBookings, auditLog, gymService, partnerGate });
export const trainerBookingService = createTrainerBookingService({
  trainerBookings, trainerSessions, trainers, gyms, users, auditLog, trainerService,
  subscriptions, paymentRequests, partnerGate,
  notify: (event, payload) => notificationService.notifyTrainerBooking(event, payload),
});
export const trainerEngagementService = createTrainerEngagementService({
  trainerEngagements, trainers, users, trainerService,
  // notificationService is created further down; this only runs later.
  notify: (userId, message) => notificationService.notify(userId, message),
});
export const shopService = createShopService({
  products, shopOrders, users, auditLog, paymentRequests,
  marketplaceEnquiries, marketplaceNotifications, productReviews, partnerGate, partnerKycCases,
});
export const whatsAppNotifier = createWhatsAppNotifier();
export const corporateService = createCorporateService({
  users, checkins, corporateAccounts, corporateEmployees, corporateBills, auditLog, settingsService,
  // Every new company gets its employer B2B organisation. b2bService is defined
  // below; the hook only runs later, at onboarding.
  onAccountCreated: (account, actorId) => b2bService.ensureOrganizationForCorporate({ corporateId: account.id, actorId }),
});
// B2B Foundation V1: generalised organisations next to Corporate (which it reads through).
export const b2bService = createB2BService({
  users, corporateAccounts, corporateEmployees, partnerKycCases,
  organizations: b2bOrganizations, organizationUsers: b2bOrganizationUsers, beneficiaries: b2bBeneficiaries,
  auditLog,
});

export const identityLinkService = createIdentityLinkService({ db });
export const authService = createAuthService({
  users, gyms, subscriptions, trainers, otps, products,
  signJwt, verifyFirebaseIdToken, publicUserId, gymService, trainerService,
  identityLink: identityLinkService,
});

export const subscriptionService = createSubscriptionService({ subscriptions, paymentRequests, checkins, gyms, settingsService, publicUserId });
export const accountService = createAccountService({
  users, trainers, trainerBookings, checkins, auditLog, initFirebaseAdmin, getAdminAuth, approvalStatusForRole,
});

export const checkInService = createCheckInService({ users, gyms, subscriptions, checkins, trainers, getTierConfig: settingsService.getTierConfig });
// Gym settlement configuration (settlement Phase 2): not used by any payout flow yet.
export const settlementConfigService = createSettlementConfigService();
export const checkinStatusService = createCheckinStatusService({ checkins, auditLog });
// Lifecycle events for gym automations. automationService is defined further
// down; these only run later, and never throw.
const lifecycle = {
  activated: (sub) => automationService.handleEvent({ type: 'membership_activated', subscription: sub }),
  paymentFailed: (sub, extra) => automationService.handleEvent({ type: 'payment_failed', subscription: sub, ...extra }),
};
export const memberManagement = createMemberManagementService({
  users, gyms, subscriptions, checkins, paymentRequests, publicUserId, initFirebaseAdmin, getAdminAuth,
  onMembershipActivated: lifecycle.activated,
});
export const operatorService = createOperatorService({
  users, gyms, subscriptions, checkins, checkInService, publicUserId, settingsService, memberManagement,
});

export const ownerGymService = createOwnerGymService({ gyms, users, trainers, invoices, auditLog, gymService, trainerService, partnerGate });
export const ownerStaffService = createOwnerStaffService({ users, auditLog, initFirebaseAdmin, getAdminAuth });

export const adminMemberService = createAdminMemberService({
  users, subscriptions, paymentRequests, checkins, gyms, auditLog, issueQr,
});
export const adminPaymentService = createAdminPaymentService({
  paymentRequests, subscriptions, users, auditLog, gyms,
  onSubscriptionActivated: async (sub) => {
    await notificationService.notifySubscriptionActivated(sub);
    await lifecycle.activated(sub);
  },
  onPaymentRejected: (sub, request) => lifecycle.paymentFailed(sub, { paymentRequestId: request.id, amountTzs: request.amountTzs }),
  onBookingPayment: (groupId, status) => trainerBookingService.applyPaymentToGroup(groupId, status),
  onOrderPayment: (orderId, status) => shopService.applyPaymentToOrder(orderId, status),
});
export const adminOwnerService = createAdminOwnerService({ users, gyms, checkins, auditLog, gymService });
export const adminApprovalService = createAdminApprovalService({ users, auditLog, partnerKycCases, partnerGate });
export const financeService = createFinanceService({ gyms, checkins, invoices, users, gymPayouts, gymOwners, settingsService });
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
export const socialService = createSocialService({
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
// Delivers queued campaign messages through the inbox, FCM and WhatsApp above.
export const deliveryService = createDeliveryService({
  db, notificationService, campaignService, whatsappChannel: whatsappChannelService,
  batchSize: positiveInt(process.env.COMMS_DISPATCH_BATCH, 200),
});
export const communicationPreferenceService = createCommunicationPreferenceService({
  preferences: communicationPreferences,
  whatsappAvailable: () => whatsappChannelService.available(),
});
export const challengeRewardService = createChallengeRewardService({
  challenges, participants: challengeParticipants, awards: challengeRewards, users, corporateEmployees,
  challengeService, auditLog,
  notify: (userId, message) => notificationService.notify(userId, message),
});
export const trainerClientService = createTrainerClientService({
  relationships: trainerMemberRelationships, trainers, users, workouts, workoutPlans, activities, goals,
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
