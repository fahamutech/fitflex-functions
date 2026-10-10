// Scheduled jobs.
import '../src/bootstrap/init.mjs';
import { subscriptions, notificationService, challengeRewardService, deliveryService, automationService, partnerKycService, b2bProgramService, b2bBillingService, b2bConsumptionService, b2bSponsorRefundService, b2bFinanceService, b2bCollectionsService, b2bAnalyticsService, opsService, settlementService, settlementClawbackService, trainerSettlementService, vendorSettlementService, smsService } from '../src/bootstrap/services.mjs';
import { b2bPrograms } from '../src/bootstrap/collections.mjs';

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
  description: 'Trainer payouts: prepare draft statements for the week that ended on Sunday. Drafts only; staff submit, approve and pay. Safe to rerun: drafts are rebuilt, submitted statements are left alone.',
  onJob: async () => {
    const r = await trainerSettlementService.prepare({ actorId: 'system:weekly-trainer-statements' });
    if (r.error) console.warn(`[trainer-settlements] ${r.error}`);
    else if (r.prepared || r.rebuilt) console.log(`[trainer-settlements] ${r.periodStartDate}: prepared=${r.prepared} rebuilt=${r.rebuilt} skipped=${r.skipped}`);
  }
};

export const vendorSettlementDrafts = {
  created, rule: '0 3 * * 1', // every Monday 03:00 UTC = 06:00 EAT, once the week has ended
  description: 'Vendor payouts: prepare draft statements for the week that ended on Sunday. Drafts only; staff submit, approve and pay. Safe to rerun: drafts are rebuilt, submitted statements are left alone.',
  onJob: async () => {
    const r = await vendorSettlementService.prepare({ actorId: 'system:weekly-vendor-statements' });
    if (r.error) console.warn(`[vendor-settlements] ${r.error}`);
    else if (r.prepared || r.rebuilt) console.log(`[vendor-settlements] ${r.periodStartDate}: prepared=${r.prepared} rebuilt=${r.rebuilt} skipped=${r.skipped}`);
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
