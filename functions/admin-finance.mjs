// Admin finance REST surface — gym usage/billing, period distribution, book-keeping.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { financeService, paymentRequests } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const adminGymUsage = {
  created, method: 'get', path: '/admin/gym-usage',
  description: 'Admin: gym usage summary with smart day/week/month billing calculation.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => res.json(await financeService.computeGymUsageSummaries())
};

export const adminGymVisitDetails = {
  created, method: 'get', path: '/admin/gym-usage/:gymId/visits',
  description: 'Admin: detailed visit records for a specific gym with billing type per visit.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const result = await financeService.gymVisitDetails(req.params.gymId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.records);
  }
};

export const adminPeriodDistribution = {
  created, method: 'get', path: '/admin/distributions/periods',
  description: 'Admin: legacy period-based distribution — usage per gym per period with any existing legacy invoice. Read-only: it no longer creates invoices.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => res.json(await financeService.periodDistribution())
};

export const adminBookKeeping = {
  created, method: 'get', path: '/admin/book-keeping',
  description: 'Admin: book keeping — money in (subscriptions) vs money out (gym payouts).',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => res.json(await financeService.bookKeeping({ paymentRequests }))
};
