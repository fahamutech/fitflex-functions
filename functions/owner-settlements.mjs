// Gym owner settlement statements (settlement Phase 5): what FitFlex owes
// each of the owner's gyms per period, and where each statement stands.
// Read-only. Commercial rules and other gyms' figures are never returned.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireGymAcl } from '../src/auth/jwt.mjs';
import { settlementViewService, resolveRequestUser } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const guard = [requireAuth('gym_operator', 'gym_staff'), requireGymAcl('payments')];

export const ownerSettlements = {
  created, method: 'get', path: '/owner/settlements',
  description: 'Owner: settlement statements for their gyms, newest period first. Optional ?gymId scopes to one owned gym.',
  onGuard: guard,
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    res.json(await settlementViewService.ownerStatements({ owner, gymId: req.query?.gymId ? String(req.query.gymId) : null }));
  }
};

export const ownerSettlement = {
  created, method: 'get', path: '/owner/settlements/:id',
  description: 'Owner: one statement with a line per member (visits, the gym\'s own rate, what was earned) and any adjustments.',
  onGuard: guard,
  onRequest: async (req, res) => {
    const owner = await resolveRequestUser(req);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const result = await settlementViewService.ownerStatement({ owner, id: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};
