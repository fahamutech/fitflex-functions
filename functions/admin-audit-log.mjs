// Admin: read-only audit log viewer (admin-portal audit S2). Scope `audit`.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { routeGuard } from '../src/shared/route-guard.mjs';
import { db } from '../src/infra/knex-store.mjs';
import { createAuditLogService } from '../src/services/audit-log-service.mjs';

const created = new Date().toISOString();
const auditLogService = createAuditLogService({ db });

export const adminListAuditLog = {
  created, method: 'get', path: '/admin/audit-log',
  description: 'Admin: read the audit log, newest first. Query: actor, action, target (exact match), from, to (ISO date-times, inclusive), limit (default 50, at most 200), cursor (nextCursor of the previous page). Answers { items: [{ id, at, actor, action, target, before, after, reason }], nextCursor } with nextCursor null on the last page. Credentials are removed from before/after; user rows are cut down to account fields. 400 invalid_filter { field } for a bad from/to/cursor. Scope: audit.',
  onGuard: routeGuard('get', [requireAuth('admin'), requireAcl('audit')]),
  onRequest: async (req, res) => {
    const result = await auditLogService.list(req.query || {});
    if (result.error) return res.status(result.status).json({ error: result.error, field: result.field });
    res.json(result);
  }
};
