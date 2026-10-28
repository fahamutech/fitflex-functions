// Scheduled jobs.
import '../src/bootstrap/init.mjs';
import { subscriptions, notificationService, challengeRewardService, deliveryService, automationService, partnerKycService, b2bProgramService, b2bBillingService, b2bConsumptionService, b2bSponsorRefundService, b2bFinanceService, b2bCollectionsService, b2bAnalyticsService, opsService, settlementService, settlementClawbackService, trainerSettlementService, vendorSettlementService, smsService, shopService, shopReconciliationService, friendInvitationService, vendorCustomerService, shopBannerService } from '../src/bootstrap/services.mjs';
import { shopBannersOn, eventsModuleOn } from '../src/shared/feature-flags.mjs';
import { b2bPrograms } from '../src/bootstrap/collections.mjs';
import { trainerStatementDraftsOn, vendorStatementDraftsOn } from '../src/shared/feature-flags.mjs';

const created = new Date().toISOString();

export const renewalNotifier = {
  created, rule: '0 9 * * *', // every day 09:00 UTC
  description: 'Send T-3 / T-1 / T0 renewal notifications (BL-008) to the inbox, push and WhatsApp. Safe to rerun: each reminder is sent once. Gym memberships whose gym has its own expiry reminders switched on are left to the gym (D4).',
  onJob: async () => {
    const now = Date.now();
    const gymsRemind = await automationService.gymsWithReminders();
    for (const s of await subscriptions.filterAsync(s => s.status === 'active')) {
      const days = Math.round((+new Date(s.renewsAt) - now) / 86_400_000);
      if (![3, 1, 0].includes(days)) continue;
      if (s.type === 'direct_sub' && gymsRemind.has(s.homeGymId)) continue;
      const r = await notificationService.notifyRenewal(s, days);
      if (!r?.duplicate) console.log(`[renewal] member=${s.memberId} sub=${s.id} T-${days} renewsAt=${s.renewsAt}`);
    }
  }
};

export const communicationAutomations = {
  created, rule: '10 * * * *', // hourly; scheduled messages go out 08:00–20:00 EAT
  description: 'Communications: gym lifecycle automations — welcome, expiry reminders (7/3/1 days), expired, failed payment, 14 days without a visit. Every send is keyed per member and occurrence, so reruns and overlaps never send twice; only one server runs it at a time.',
  onJob: async () => {
    const r = await automationService.runDue();
    if (r.fired || r.paused || r.errors) console.log(`[automations] gyms=${r.gyms} fired=${r.fired} already=${r.already} deferred=${r.deferred} paused=${r.paused} errors=${r.errors}`);
  }
};

export const smsReminders = {
  created, rule: '20 * * * *', // hourly
  description: 'SMS reminders: a confirmed trainer session starting within 3 hours, and a pass ending in 3 days (a gym membership whose gym sends its own expiry reminders is left to the gym). Only to members who have not switched SMS service messages off. Nothing is sent unless SMS_PROVIDER is set. Safe to rerun: each reminder is sent once, and one that failed is tried again by the next runs.',
  onJob: async () => {
    const r = await smsService.sendDueReminders();
    const n = (x) => x.sent + x.failed;
    if (n(r.bookings) || n(r.renewals)) console.log(`[sms] bookings sent=${r.bookings.sent} failed=${r.bookings.failed} · renewals sent=${r.renewals.sent} failed=${r.renewals.failed}`);
  }
};

export const friendInviteFallback = {
  created, rule: '*/5 * * * *', // every 5 minutes
  description: 'Friend invitations: for invitations WhatsApp accepted, ask the provider whether it was delivered; when the number has no WhatsApp, send the SMS instead (once). Does nothing unless FRIEND_INVITE_WHATSAPP and FRIEND_INVITE_SMS are on. Safe to overlap.',
  onJob: async () => {
    const r = await friendInvitationService.resolveFallbacks();
    if (r.sms) console.log(`[friend-invite] WhatsApp not delivered, SMS sent=${r.sms} of checked=${r.checked}`);
  }
};

export const challengeRewardSettler = {
  created, rule: '30 21 * * *', // every day 21:30 UTC = 00:30 EAT, just after challenges end
  description: 'Record challenge rewards earned by finishers, and settle top-N and winning-team rewards for challenges that have ended.',
  onJob: async () => {
    const r = await challengeRewardService.settleDue();
    console.log(`[rewards] earned=${r.earned} settled=${r.settled}`);
  }
};

export const communicationDispatcher = {
  created, rule: '* * * * *', // every minute
  description: 'Communications: send scheduled campaigns that are due, deliver queued messages (in-app, push) with retries, and close finished campaigns. Safe to overlap — rows are claimed with SKIP LOCKED.',
  onJob: async () => {
    const r = await deliveryService.runOnce();
    if (r.claimed || r.released || r.closed) console.log(`[comms] released=${r.released} claimed=${r.claimed} sent=${r.sent} retry=${r.retry} failed=${r.failed} closed=${r.closed}`);
  }
};

export const kycExpiryReminders = {
  created, rule: '0 6 * * *', // every day 06:00 UTC = 09:00 EAT
  description: 'Partner KYC: remind verified partners 30 days, 7 days and on the day a document (ID, licence, certificate, insurance) expires. Reminders only; nothing is suspended. Safe to rerun: each reminder is sent once.',
  onJob: async () => {
    const r = await partnerKycService.sendExpiryReminders();
    if (r.sent) console.log(`[kyc-expiry] cases=${r.cases} sent=${r.sent} already=${r.already}`);
  }
};

export const trainerSettlementDrafts = {
  created, rule: '0 3 * * 3', // every Wednesday 03:00 UTC = 06:00 EAT, once Sunday's sessions are 48 hours old
  description: 'Trainer payouts: prepare draft statements for the week that ended on Sunday. Drafts only; staff submit, approve and pay. Safe to rerun: drafts are rebuilt, submitted statements are left alone. TRAINER_STATEMENT_DRAFTS=off pauses it (default on); the first run after it is back on picks up every session the paused weeks missed.',
  onJob: async () => {
    if (!trainerStatementDraftsOn()) { console.log('[trainer-statements] paused by TRAINER_STATEMENT_DRAFTS'); return { paused: true }; }
    const r = await trainerSettlementService.prepare({ actorId: 'system:weekly-trainer-statements' });
    if (r.error) console.warn(`[trainer-settlements] ${r.error}`);
    else if (r.prepared || r.rebuilt) console.log(`[trainer-settlements] ${r.periodStartDate}: prepared=${r.prepared} rebuilt=${r.rebuilt} skipped=${r.skipped}`);
  }
};

export const vendorSettlementDrafts = {
  created, rule: '0 3 * * 1', // every Monday 03:00 UTC = 06:00 EAT, once the week has ended
  description: 'Vendor payouts: prepare draft statements for the week that ended on Sunday. Drafts only; staff submit, approve and pay. Safe to rerun: drafts are rebuilt, submitted statements are left alone. VENDOR_STATEMENT_DRAFTS=off pauses it (default on); the first run after it is back on picks up every delivered sale the paused weeks missed.',
  onJob: async () => {
    if (!vendorStatementDraftsOn()) { console.log('[vendor-statements] paused by VENDOR_STATEMENT_DRAFTS'); return { paused: true }; }
    const r = await vendorSettlementService.prepare({ actorId: 'system:weekly-vendor-statements' });
    if (r.error) console.warn(`[vendor-settlements] ${r.error}`);
    else if (r.prepared || r.rebuilt) console.log(`[vendor-settlements] ${r.periodStartDate}: prepared=${r.prepared} rebuilt=${r.rebuilt} skipped=${r.skipped}`);
  }
};

export const vendorCustomersOverdueDigest = {
  created, rule: '0 6 * * *', // every day 06:00 UTC = 09:00 EAT
  description: 'Vendor tools · S4: tell each vendor (the vendor account and active staff with `customers`) about pay-later sales that became overdue today (due yesterday, EAT): push + inbox vendor_customers_overdue { count, totalTzs }, in their language. Once per vendor per EAT day (VendorOverdueDigest); nothing on days with no newly overdue sale. Never to the customer. Does nothing unless VENDOR_TOOLS and VENDOR_CUSTOMERS are on. Safe to rerun.',
  onJob: async () => {
    const r = await vendorCustomerService.sendOverdueDigests();
    if (r.vendors) console.log(`[vendor-customers] overdue digest ${r.day}: vendors=${r.vendors} sent=${r.sent}`);
  }
};

export const shopReservationExpiry = {
  created, rule: '*/10 * * * *', // every 10 minutes
  description: 'Marketplace: cancel unpaid orders whose stock reservation has lapsed (SHOP_RESERVATION_TTL_MINUTES after the order, default 48h) and put their stock back. Does nothing unless SHOP_RESERVATION_EXPIRY=on, so enabling it is a deliberate step. Safe to rerun and to overlap: each order is released once; a payment that arrives later is queued for refund.',
  onJob: async () => {
    if (process.env.SHOP_RESERVATION_EXPIRY !== 'on') return;
    const r = await shopService.expireStaleReservations({});
    if (r.expired) console.log(`[shop] reservations expired=${r.expired} due=${r.due}`);
  }
};

export const shopBannerLifecycle = {
  created, rule: '*/10 * * * *', // every 10 minutes
  description: 'Shop home banners: write down what time has decided — proposals not reviewed within SHOP_PROPOSAL_EXPIRY_DAYS (14) or by their start become expired (the vendor is told), approved banners past their end become ended. Every read already works the state out from the time, so a late run changes nothing anyone sees. Does nothing unless SHOP_BANNERS is on. Idempotent.',
  onJob: async () => {
    if (!shopBannersOn()) return;
    const r = await shopBannerService.runLifecycle();
    if (r.expired || r.ended) console.log(`[shop-banners] expired=${r.expired} ended=${r.ended}`);
  }
};

export const eventHoldExpiry = {
  created, rule: '*/5 * * * *', // every 5 minutes
  description: 'Events: give back the places of unpaid event orders whose hold has lapsed — the order becomes expired, its registrations cancelled, and one outbox row per registration is written. Does nothing unless EVENTS_MODULE is on. Safe to rerun and to overlap: each order is released once (FOR UPDATE SKIP LOCKED, unique inventory movement keys). The work, its run record and lock are in src/bootstrap/services.mjs (event-hold-expiry) and ops-service.mjs.',
  onJob: async () => {
    if (!eventsModuleOn()) return;
    const r = await opsService.runJob('event-hold-expiry');
    const s = r?.stats ?? {};
    if (s.released) console.log(`[events] holds expired: released=${s.released} due=${s.due} skipped=${s.skipped}`);
  }
};

export const eventLifecycle = {
  created, rule: '*/5 * * * *', // every 5 minutes
  description: 'Events: automatic lifecycle moves — published → registration_closed at registrationClosesAt, published / registration_closed → in_progress at startsAt, in_progress → completed at endsAt + EVENT_AUTO_COMPLETE_GRACE_HOURS (default 6). Does nothing unless EVENTS_MODULE is on. Safe to rerun (each move is a guarded transition). The work, its run record and lock are in src/bootstrap/services.mjs (event-lifecycle) and ops-service.mjs.',
  onJob: async () => {
    if (!eventsModuleOn()) return;
    const r = await opsService.runJob('event-lifecycle');
    const s = r?.stats ?? {};
    if (s.moved) console.log(`[events] lifecycle: moved=${s.moved} due=${s.due} skipped=${s.skipped} failed=${s.failed}`);
  }
};

export const shopReconciliation = {
  created, rule: '15 * * * *', // hourly
  description: 'Marketplace: reconcile orders, confirmed payments, refunds, stock and vendor statements. Read-only; logs one line per open finding so an alert can key on "[shop-reconciliation]". The same report is at GET /admin/marketplace/reconciliation.',
  onJob: async () => {
    const r = await shopReconciliationService.report();
    for (const c of r.checks.filter(x => x.count !== 0 && x.severity !== 'P2')) {
      console.warn(`[shop-reconciliation] ${c.severity} ${c.id} count=${c.count} sample=${c.sample.slice(0, 5).map(s => s.id || s.orderId || s.refundId).join(',')}`);
    }
  }
};

export const b2bProgramExpiry = {
  created, rule: '5 21 * * *', // every day 21:05 UTC = 00:05 EAT, the first minute of a new EAT day
  description: 'B2B: mark active or paused wellness programmes whose end date has passed as expired. Idempotent.',
  // The work, its run record, lock and failure handling are in src/services/b2b-jobs.mjs and ops-service.mjs.
  onJob: () => opsService.runJob('b2b-program-expiry'),
};

export const promotionLifecycle = {
  created, rule: '*/5 * * * *', // every 5 minutes
  description: 'Promotions: start scheduled promotions whose start has arrived and expire those whose end has passed (a promotion whose entity was blocked in moderation is held instead of started). Ranking also reads the time window itself, so a late run never lets an expired promotion count. Idempotent.',
  onJob: () => opsService.runJob('promotion-lifecycle'),
};

export const promotionEventsRetention = {
  created, rule: '40 21 * * *', // every day 21:40 UTC = 00:40 EAT
  description: 'Promotions: delete raw analytics events older than 13 months (the retention the owner decided). Idempotent.',
  onJob: () => opsService.runJob('promotion-events-retention'),
};

export const b2bHoldReconciler = {
  created, rule: '*/5 * * * *', // every 5 minutes
  description: 'B2B: settle benefit holds a gym check-in left behind (the hold is written before the visit and approved after it). A hold older than two minutes is approved when its visit exists and cancelled when it does not, so no allowance stays blocked and no recorded visit goes uncharged. Idempotent.',
  // The work, its run record, lock and failure handling are in src/services/b2b-jobs.mjs and ops-service.mjs.
  onJob: () => opsService.runJob('b2b-hold-reconciler'),
};

export const settlementCloser = {
  created, rule: '30 21 * * *', // every day 21:30 UTC = 00:30 EAT
  description: 'Gym settlement: calculate and store the previous EAT month once it has ended (finished Platform Pass cycles only). SETTLEMENT_MODE = shadow (default: stored, never payable), live or off. It never approves or pays. Safe to rerun and to overlap: one server at a time, one run per month, everything in one transaction.',
  onJob: async () => {
    const r = await settlementService.runDue();
    // New live statements can take clawbacks that were waiting for one.
    if (r.run?.mode === 'live' && !r.alreadyRun) await settlementClawbackService.sweepQuietly();
    if (r.run && !r.alreadyRun) console.log(`[settlement] ${r.run.mode} ${r.run.periodStartDate} cycles=${r.stats.settledCycles} skipped=${r.stats.skippedCycles} statements=${r.stats.statements} final=${r.stats.totalFinalTzs}`);
    else if (r.error) console.error(`[settlement] ${r.error}${r.message ? `: ${r.message}` : ''}`);
  }
};

export const b2bSponsorBilling = {
  created, rule: '20 21 * * *', // every day 21:20 UTC = 00:20 EAT
  description: 'B2B sponsor billing: start sponsored passes that can start (sponsor paid, member linked, month begun), and keep draft invoices current — flat fees for this month (and next, from the 25th) and last month\'s per-use charges. Drafts only: FitFlex issues them. Idempotent.',
  // The work, its run record, lock and failure handling are in src/services/b2b-jobs.mjs and ops-service.mjs.
  onJob: () => opsService.runJob('b2b-sponsor-billing'),
};

export const b2bCollections = {
  created, rule: '0 6 * * *', // every day 06:00 UTC = 09:00 EAT
  description: 'B2B collections: payment reminders for issued invoices — 3 days before the due day, on it, and 7, 14 and 30 days after. Each is sent once per invoice, to the organisation\'s owners and finance users (in the app) and its billing email. Reminders only: nothing is suspended and no charge is added. Safe to rerun.',
  // The work, its run record, lock and failure handling are in src/services/b2b-jobs.mjs and ops-service.mjs.
  onJob: () => opsService.runJob('b2b-collections'),
};

export const b2bSponsorVisibilityNotice = {
  created, rule: '0 7 * * *', // every day 07:00 UTC = 10:00 EAT
  description: 'B2B: tell each person an organisation covers, once, that the organisation can see their FitFlex activity (and what it cannot see). New beneficiaries are picked up by the next run. Safe to rerun.',
  // The work, its run record, lock and failure handling are in src/services/b2b-jobs.mjs and ops-service.mjs.
  onJob: () => opsService.runJob('b2b-sponsor-visibility-notice'),
};

export const b2bIntegrityCheck = {
  created, rule: '0 22 * * *', // every day 22:00 UTC = 01:00 EAT
  description: 'B2B: run the financial data-quality checks. Each check that finds something raises one operations exception (count and examples) and clears itself when the check comes back clean. Nothing is repaired.',
  onJob: () => opsService.runJob('b2b-integrity-check'),
};

export const opsSweeper = {
  created, rule: '*/10 * * * *', // every 10 minutes
  description: 'Operations: catch up. A daily B2B job whose run was missed (the server was restarting) or failed is run again, at most three times and further apart each time; after that its exception is left for a person. Safe to overlap: each job takes its own lock.',
  onJob: async () => {
    const r = await opsService.sweep();
    if (r.ran.length || r.gaveUp.length) console.log(`[ops] caught up: ${r.ran.map(x => `${x.job}=${x.status}`).join(', ') || 'none'}; gave up: ${r.gaveUp.join(', ') || 'none'}`);
  },
};

export const b2bBeneficiaryInvites = {
  created, rule: '*/10 * * * *', // every 10 minutes
  description: 'B2B: enrol invited people who have since joined FitFlex with the email or number their organisation listed, and send the invitation messages that are due (email: the invitation, then reminders after 3 and 10 days; SMS to people listed with a mobile number: the invitation and one reminder after 3 days, unless B2B_INVITE_SMS=off). Safe to overlap and to rerun: an invite is enrolled once and each message is claimed before it is sent.',
  onJob: () => opsService.runJob('b2b-beneficiary-invites'),
};

export const b2bLifecycleNotices = {
  created, rule: '0 5 * * *', // every day 05:00 UTC = 08:00 EAT
  description: 'B2B: tell members when a benefit starts tomorrow, ends within 7 days or has ended, and tell an organisation (in the app and at its contact email) when a programme ends within 30 days, within 7, or has ended. Each notice is written once, so reruns and a missed day are safe.',
  onJob: () => opsService.runJob('b2b-lifecycle-notices'),
};

export const b2bAllowanceNotices = {
  created, rule: '*/10 * * * *', // every 10 minutes
  description: 'B2B: tell a member when they have used 80% of a benefit\'s allowance and when they have used all of it. Once each per person, benefit and allowance window.',
  onJob: () => opsService.runJob('b2b-allowance-notices'),
};

export const b2bBillingWatch = {
  created, rule: '30 4 * * *', // every day 04:30 UTC = 07:30 EAT
  description: 'B2B: raise an operations exception for billing work that has waited too long (draft invoices not issued, payment notices not checked, invoices long overdue, money received but not applied, an agreement about to end, an organisation long on hold). Each clears itself when the work is done. Nothing is changed.',
  onJob: () => opsService.runJob('b2b-billing-watch'),
};

export const opsAlerts = {
  created, rule: '*/10 * * * *', // every 10 minutes
  description: 'Operations: email the addresses in OPS_ALERT_EMAILS about high-severity exceptions and ones where retrying was given up. Each is announced once. Nothing is sent when no addresses are set.',
  onJob: () => opsService.runJob('ops-alerts'),
};

export const opsDailySummary = {
  created, rule: '30 5 * * *', // every day 05:30 UTC = 08:30 EAT
  description: 'Operations: email the addresses in OPS_ALERT_EMAILS a summary of the exceptions still waiting. Sent only when something is waiting.',
  onJob: () => opsService.runJob('ops-daily-summary'),
};
