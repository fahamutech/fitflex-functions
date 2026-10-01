// Admin gym-settlement REST surface (settlement Phase 3): see what the
// settlement service calculated, and run a month by hand. Read and calculate
// only — approving and paying statements come with the workflow phase.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { settlementService } from '../src/bootstrap/services.mjs';
import { periodForMonth } from '../src/services/settlement-service.mjs';

const created = new Date().toISOString();
const guard = [requireAuth('admin'), requireAcl('payments')];

export const adminSettlementRuns = {
  created, method: 'get', path: '/admin/settlements/runs',
  description: 'Admin: settlement runs, newest first. Optional ?mode=live|shadow.',
  onGuard: guard,
  onRequest: async (req, res) => res.json(await settlementService.listRuns({ mode: req.query?.mode, limit: req.query?.limit }))
};

export const adminSettlementRun = {
  created, method: 'get', path: '/admin/settlements/runs/:id',
  description: 'Admin: one settlement run with its gym statements, totals and skipped cycles.',
  onGuard: guard,
  onRequest: async (req, res) => {
    const result = await settlementService.getRun(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};

export const adminRunSettlement = {
  created, method: 'post', path: '/admin/settlements/runs',
  description: 'Admin: calculate and store one EAT month. mode "shadow" (default) stores a run that can never be paid; "live" stores the real one (once per month, only after the month has ended). Nothing is approved or paid.',
  requestSample: { month: '2026-10', mode: 'shadow' },
  onGuard: guard,
  onRequest: async (req, res) => {
    const { month, mode = 'shadow' } = req.body || {};
    const period = periodForMonth(month);
    if (!period) return res.status(400).json({ error: 'invalid_month' });
    const result = await settlementService.run({ ...period, mode, actorId: req.user?.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (result.skipped) return res.status(409).json({ error: 'settlement_run_in_progress' });
    res.status(result.alreadyRun ? 200 : 201).json(result);
  }
};

export const adminSettlementStatement = {
  created, method: 'get', path: '/admin/settlements/statements/:id',
  description: 'Admin: one gym statement with its lines (member cycle at the gym), the check-ins behind each line, and adjustments.',
  onGuard: guard,
  onRequest: async (req, res) => {
    const result = await settlementService.getStatement(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }
};
