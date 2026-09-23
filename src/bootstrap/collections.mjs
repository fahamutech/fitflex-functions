// Central collection instances — single source of truth for every REST module.
// Domain-specific service files receive these via dependency injection; they
// never call collection() directly.
import { collection } from '../infra/knex-store.mjs';

export const users = collection('users');
export const gyms = collection('gyms');
export const subscriptions = collection('subscriptions');
export const checkins = collection('checkins');
export const otps = collection('otps');
export const auditLog = collection('audit_log');
export const paymentRequests = collection('payment_requests');
export const trainers = collection('trainers');
export const trainerBookings = collection('trainer_bookings');
export const platformSettings = collection('platform_settings');
export const invoices = collection('invoices');
export const gymPayouts = collection('gym_payouts');
export const gymOwners = collection('gym_owners');
export const webhookSeen = collection('webhook_seen');
export const trainerEngagements = collection('trainer_engagements');
export const trainerSessions = collection('trainer_sessions');
export const products = collection('products');
export const shopOrders = collection('shop_orders');
export const marketplaceEnquiries = collection('marketplace_enquiries');
export const marketplaceNotifications = collection('marketplace_notifications');
export const productReviews = collection('product_reviews');
export const gymReviews = collection('gym_reviews');
export const trainerReviews = collection('trainer_reviews');
