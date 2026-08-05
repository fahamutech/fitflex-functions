// Scheduled jobs.
import '../src/bootstrap/init.mjs';
import { subscriptions } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const renewalNotifier = {
  created, rule: '0 9 * * *', // every day 09:00 UTC
  description: 'Send T-3 / T-1 / T0 renewal notifications (BL-008). Currently logs only — push/SMS pending US-020.',
  onJob: async () => {
    const now = Date.now();
    (await subscriptions.filterAsync(s => s.status === 'active')).forEach(s => {
      const days = Math.round((+new Date(s.renewsAt) - now) / 86_400_000);
      if ([3, 1, 0].includes(days)) {
        console.log(`[renewal] member=${s.memberId} sub=${s.id} T-${days} renewsAt=${s.renewsAt}`);
      }
    });
  }
};
