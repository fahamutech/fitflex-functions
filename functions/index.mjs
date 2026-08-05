// FitFlex Af — module index.
//
// All REST/SCHEDULE endpoints now live in domain-specific files under this
// directory (auth.mjs, gyms.mjs, trainers.mjs, trainer-bookings.mjs,
// subscriptions.mjs, checkins.mjs, owner-gyms.mjs, owner-members.mjs,
// owner-staff.mjs, admin-members.mjs, admin-payments.mjs, admin-owners.mjs,
// admin-approvals.mjs, admin-finance.mjs, admin-invoices.mjs,
// admin-settings.mjs, admin-portal-users.mjs, jobs.mjs, webhooks.mjs,
// health.mjs) — bfast-functions discovers every exported endpoint object
// across all files in functions/, so no central re-export is required.
//
// This file only re-exports `ensureInit` for backward compatibility with
// existing test specs that import it directly.
export { ensureInit } from '../src/bootstrap/init.mjs';
