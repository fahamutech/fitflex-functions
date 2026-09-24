// Internal product analytics for FitFlex staff. Admin-only: members,
// trainers and gyms never reach this data.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { analyticsService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const adminAnalyticsOverview = {
  created, method: 'get', path: '/admin/analytics',
  description: 'Admin: aggregate engagement metrics (daily actives, logging, workouts, challenges, streaks, goals, trainers, gyms) for ?from=YYYY-MM-DD&to=YYYY-MM-DD (member local days, max 92).',
  onGuard: [requireAuth('admin'), requireAcl('analytics')],
  onRequest: async (req, res) => {
    const result = await analyticsService.overview({ from: req.query?.from, to: req.query?.to });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};
