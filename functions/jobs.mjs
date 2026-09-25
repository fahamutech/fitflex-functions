// Scheduled jobs.
import '../src/bootstrap/init.mjs';
import { subscriptions, notificationService, challengeRewardService, deliveryService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const renewalNotifier = {
  created, rule: '0 9 * * *', // every day 09:00 UTC
  description: 'Send T-3 / T-1 / T0 renewal notifications (BL-008) to the inbox, push and WhatsApp.',
  onJob: async () => {
    const now = Date.now();
    for (const s of await subscriptions.filterAsync(s => s.status === 'active')) {
      const days = Math.round((+new Date(s.renewsAt) - now) / 86_400_000);
      if ([3, 1, 0].includes(days)) {
        console.log(`[renewal] member=${s.memberId} sub=${s.id} T-${days} renewsAt=${s.renewsAt}`);
        await notificationService.notifyRenewal(s, days);
      }
    }
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
