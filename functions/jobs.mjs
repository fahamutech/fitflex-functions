// Scheduled jobs.
import '../src/bootstrap/init.mjs';
import { subscriptions, notificationService, challengeRewardService, deliveryService, automationService, partnerKycService } from '../src/bootstrap/services.mjs';

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
