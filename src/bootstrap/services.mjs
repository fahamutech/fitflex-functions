// Composition root — every service is instantiated exactly once here with its
// dependencies injected, then imported by the thin REST modules in functions/.
import { sign as signJwt } from '../auth/jwt.mjs';
import { verifyFirebaseIdToken, initFirebaseAdmin, getAdminAuth } from '../auth/firebase.mjs';
import { issue as issueQr } from '../auth/qr-token.mjs';
import { createCheckInService } from '../services/check-in-service.mjs';
import { createMemberManagementService } from '../services/member-management-service.mjs';
import { createIdentityService } from '../services/identity-service.mjs';
import { createGymService } from '../services/gym-service.mjs';
import { createTrainerService } from '../services/trainer-service.mjs';
import { createTrainerBookingService } from '../services/trainer-booking-service.mjs';
import { createSettingsService } from '../services/settings-service.mjs';
import { createAuthService, isConfiguredAdminEmail, approvalStatusForRole } from '../services/auth-service.mjs';
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
import { createTrainerClientService } from '../services/trainer-client-service.mjs';
import { createGymSharingService } from '../services/gym-sharing-service.mjs';
import { createChallengeService } from '../services/challenge-service.mjs';
import { createAnalyticsService } from '../services/analytics-service.mjs';
import { createNotificationService } from '../services/notification-service.mjs';
import { getMessaging } from 'firebase-admin/messaging';
import { createCorporateService } from '../services/corporate-service.mjs';
import { createWhatsAppNotifier } from '../integrations/whatsapp-hooks.mjs';
import {
  users, gyms, subscriptions, checkins, otps, auditLog, paymentRequests,
  trainers, trainerBookings, platformSettings, invoices, gymPayouts, gymOwners, webhookSeen,
  trainerEngagements, trainerSessions, products, shopOrders,
  marketplaceEnquiries, marketplaceNotifications, productReviews,
  gymReviews, trainerReviews,
  corporateAccounts, corporateEmployees, corporateBills,
  deviceTokens, notifications, activities, goals, workouts,
  trainerMemberRelationships, workoutPlans, gymMemberSharing, challenges, challengeParticipants,
  challengeTeams,
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

export const identityService = createIdentityService({ users });
const { resolveRequestUser, publicUserId } = identityService;

export const settingsService = createSettingsService({ platformSettings, auditLog });
export const gymService = createGymService({ gyms, users, checkins, auditLog });
export const trainerService = createTrainerService({ trainers, gyms, trainerBookings, auditLog, gymService });
export const trainerBookingService = createTrainerBookingService({
  trainerBookings, trainerSessions, trainers, gyms, users, auditLog, trainerService,
  subscriptions, paymentRequests,
  notify: (event, payload) => notificationService.notifyTrainerBooking(event, payload),
});
export const trainerEngagementService = createTrainerEngagementService({ trainerEngagements, trainers, users, trainerService });
export const shopService = createShopService({
  products, shopOrders, users, auditLog,
  marketplaceEnquiries, marketplaceNotifications, productReviews,
});
export const whatsAppNotifier = createWhatsAppNotifier();
export const corporateService = createCorporateService({
  users, checkins, corporateAccounts, corporateEmployees, corporateBills, auditLog, settingsService,
});

export const authService = createAuthService({
  users, gyms, subscriptions, trainers, otps, products,
  signJwt, verifyFirebaseIdToken, publicUserId, gymService, trainerService,
});

export const subscriptionService = createSubscriptionService({ subscriptions, paymentRequests, checkins, gyms, settingsService, publicUserId });
export const accountService = createAccountService({
  users, trainers, trainerBookings, checkins, auditLog, initFirebaseAdmin, getAdminAuth, approvalStatusForRole,
});

export const checkInService = createCheckInService({ users, gyms, subscriptions, checkins, getTierConfig: settingsService.getTierConfig });
export const memberManagement = createMemberManagementService({
  users, gyms, subscriptions, checkins, paymentRequests, publicUserId, initFirebaseAdmin, getAdminAuth,
});
export const operatorService = createOperatorService({
  users, gyms, subscriptions, checkins, checkInService, publicUserId, settingsService, memberManagement,
});

export const ownerGymService = createOwnerGymService({ gyms, users, trainers, invoices, auditLog, gymService, trainerService });
export const ownerStaffService = createOwnerStaffService({ users, auditLog, initFirebaseAdmin, getAdminAuth });

export const adminMemberService = createAdminMemberService({
  users, subscriptions, paymentRequests, checkins, gyms, auditLog, issueQr,
});
export const adminPaymentService = createAdminPaymentService({
  paymentRequests, subscriptions, users, auditLog,
  onSubscriptionActivated: sub => notificationService.notifySubscriptionActivated(sub),
  onBookingPayment: (groupId, status) => trainerBookingService.applyPaymentToGroup(groupId, status),
});
export const adminOwnerService = createAdminOwnerService({ users, gyms, checkins, auditLog, gymService });
export const adminApprovalService = createAdminApprovalService({ users, auditLog });
export const financeService = createFinanceService({ gyms, checkins, invoices, users, gymPayouts, gymOwners, settingsService });
export const invoiceService = createInvoiceService({ invoices, gyms, users, gymPayouts, auditLog });
export const portalUserService = createPortalUserService({ users, auditLog, initFirebaseAdmin, getAdminAuth, isConfiguredAdminEmail });
export const webhookService = createWebhookService({ subscriptions, webhookSeen });
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
export const activityService = createActivityService({ activities });
export const goalService = createGoalService({ goals, trainers });
export const workoutService = createWorkoutService({ workouts, activities });
export const gymSharingService = createGymSharingService({
  sharing: gymMemberSharing, gyms, subscriptions, checkins, activities, users,
  challengeProgressFor: (...args) => challengeService.memberProgressForCreator(...args),
});
export const challengeService = createChallengeService({
  challenges, participants: challengeParticipants, users, trainers, gyms,
  relationships: trainerMemberRelationships, gymMemberSharing,
  gymMemberIds: memberId => gymSharingService.memberGymIds(memberId),
  activities, checkins, teams: challengeTeams, corporateEmployees, subscriptions,
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
});
export const trainerClientService = createTrainerClientService({
  relationships: trainerMemberRelationships, trainers, users, workouts, workoutPlans, activities, goals,
  notify: (userId, message) => notificationService.notify(userId, message),
  challengeProgressFor: (...args) => challengeService.memberProgressForCreator(...args),
  challenges, participants: challengeParticipants,
});
