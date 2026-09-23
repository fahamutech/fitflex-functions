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
import {
  users, gyms, subscriptions, checkins, otps, auditLog, paymentRequests,
  trainers, trainerBookings, platformSettings, invoices, gymPayouts, gymOwners, webhookSeen,
  trainerEngagements, trainerSessions, products, shopOrders,
  marketplaceEnquiries, marketplaceNotifications, productReviews,
  gymReviews, trainerReviews,
} from './collections.mjs';

export { isConfiguredAdminEmail, approvalStatusForRole };
export {
  users, gyms, subscriptions, checkins, otps, auditLog, paymentRequests,
  trainers, trainerBookings, platformSettings, invoices, gymPayouts, gymOwners, webhookSeen,
  trainerEngagements, trainerSessions, products, shopOrders,
  marketplaceEnquiries, marketplaceNotifications, productReviews,
  gymReviews, trainerReviews,
};

export const identityService = createIdentityService({ users });
const { resolveRequestUser, publicUserId } = identityService;

export const settingsService = createSettingsService({ platformSettings, auditLog });
export const gymService = createGymService({ gyms, users, checkins, auditLog });
export const trainerService = createTrainerService({ trainers, gyms, trainerBookings, auditLog, gymService });
export const trainerBookingService = createTrainerBookingService({ trainerBookings, trainerSessions, trainers, gyms, users, auditLog, trainerService });
export const trainerEngagementService = createTrainerEngagementService({ trainerEngagements, trainers, users, trainerService });
export const shopService = createShopService({
  products, shopOrders, users, auditLog,
  marketplaceEnquiries, marketplaceNotifications, productReviews,
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
export const adminPaymentService = createAdminPaymentService({ paymentRequests, subscriptions, users, auditLog });
export const adminOwnerService = createAdminOwnerService({ users, gyms, checkins, auditLog, gymService });
export const adminApprovalService = createAdminApprovalService({ users, auditLog });
export const financeService = createFinanceService({ gyms, checkins, invoices, users, gymPayouts, gymOwners, settingsService });
export const invoiceService = createInvoiceService({ invoices, gyms, users, gymPayouts, auditLog });
export const portalUserService = createPortalUserService({ users, auditLog, initFirebaseAdmin, getAdminAuth, isConfiguredAdminEmail });
export const webhookService = createWebhookService({ subscriptions, webhookSeen });
export const gymReviewService = createGymReviewService({ gymReviews, gyms, checkins, subscriptions, users, auditLog });
export const trainerReviewService = createTrainerReviewService({ trainerReviews, trainers, trainerBookings, users, auditLog });

export { resolveRequestUser, publicUserId, signJwt, initFirebaseAdmin, getAdminAuth };
