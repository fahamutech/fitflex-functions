// FR-K01: KPI targets for Programmes & Nutrition and the WhatsApp funnel.
// Admins with the `analytics` scope view and change them; every change is
// written to AuditLog (action kpi_target_updated) with who and when.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { kpiTargetService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();
const guard = [requireAuth('admin'), requireAcl('analytics')];

export const adminKpiTargets = {
  created, method: 'get', path: '/admin/kpi-targets',
  description: 'Admin: every KPI target `{ targets: [{ id, area, sort, unit, baseline, draftTarget, target, assumption, confirmedAt, confirmedBy, updatedAt, updatedBy }] }`. Targets start as owner proposals (assumption: true).',
  onGuard: guard,
  onRequest: async (req, res) => res.json(await kpiTargetService.list()),
};

export const adminUpdateKpiTarget = {
  created, method: 'put', path: '/admin/kpi-targets/:id',
  description: 'Admin: change a KPI target. Body (any of): target (number in the unit\'s range), baseline (text up to 40 characters, or null), confirmed (true = no longer an assumption). 400 invalid_kpi_target + field, 400 nothing_to_change, 404 not_found. Audited.',
  requestSample: { target: 30, confirmed: true },
  onGuard: guard,
  onRequest: async (req, res) => {
    const out = await kpiTargetService.update(req.user.sub, req.params.id, req.body || {});
    if (out.error) return res.status(out.status).json({ error: out.error, ...(out.field ? { field: out.field } : {}) });
    res.json(out);
  },
};
