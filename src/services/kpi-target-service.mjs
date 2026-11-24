// FR-K01: KPI targets for Programmes & Nutrition and the WhatsApp funnel,
// viewed and changed by admins in the portal. Targets start as owner
// proposals (assumption = true, D-07); an admin can change a target or its
// baseline and confirm it. Every change is written to AuditLog with who and
// when (action `kpi_target_updated`).
import { randomUUID } from 'node:crypto';

/** What a target may be, per unit. */
const RANGE = {
  percent: { min: 0, max: 100 },
  percent_lower: { min: 0, max: 100 },
  percent_change: { min: -100, max: 1000 },
  points: { min: -100, max: 100 },
  count: { min: 0, max: 1_000_000 },
};
const MAX_BASELINE = 40;

const num = v => (v == null ? null : Number(v));
const iso = v => (v == null ? null : new Date(v).toISOString());

/** A row as the portal reads it (pg returns decimals as strings). */
function shape(r) {
  return {
    id: r.id,
    area: r.area,
    sort: r.sort,
    unit: r.unit,
    baseline: r.baseline ?? null,
    draftTarget: num(r.draftTarget),
    target: num(r.target),
    assumption: r.assumption !== false,
    confirmedAt: iso(r.confirmedAt),
    confirmedBy: r.confirmedBy ?? null,
    updatedAt: iso(r.updatedAt),
    updatedBy: r.updatedBy ?? null,
  };
}

const audited = t => ({ target: t.target, baseline: t.baseline, assumption: t.assumption });

export function createKpiTargetService({ db, auditLog, now = () => new Date(), logger = console }) {
  async function list() {
    const rows = await db('KpiTarget').select('*').orderBy('sort');
    return { targets: rows.map(shape) };
  }

  /**
   * Body (all optional): `target` (a number in the unit's range), `baseline`
   * (text up to 40 characters, or null), `confirmed` (true: no longer an
   * assumption; false: back to an assumption). 400 `invalid_kpi_target` +
   * `field`; 404 `not_found`; 400 `nothing_to_change`.
   */
  async function update(actorId, id, body = {}) {
    const row = await db('KpiTarget').where({ id }).first();
    if (!row) return { error: 'not_found', status: 404 };
    const before = shape(row);
    const patch = {};
    if (body.target !== undefined) {
      const range = RANGE[row.unit] ?? RANGE.count;
      const t = body.target;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < range.min || t > range.max
        || Math.round(t * 100) !== t * 100) {
        return { error: 'invalid_kpi_target', status: 400, field: 'target' };
      }
      patch.target = t;
    }
    if (body.baseline !== undefined) {
      if (body.baseline !== null && typeof body.baseline !== 'string') {
        return { error: 'invalid_kpi_target', status: 400, field: 'baseline' };
      }
      const b = typeof body.baseline === 'string' ? body.baseline.trim() : '';
      if (b.length > MAX_BASELINE) return { error: 'invalid_kpi_target', status: 400, field: 'baseline' };
      patch.baseline = b || null;
    }
    if (body.confirmed !== undefined) {
      if (typeof body.confirmed !== 'boolean') return { error: 'invalid_kpi_target', status: 400, field: 'confirmed' };
      patch.assumption = !body.confirmed;
      patch.confirmedAt = body.confirmed ? now().toISOString() : null;
      patch.confirmedBy = body.confirmed ? actorId : null;
    }
    if (!Object.keys(patch).length) return { error: 'nothing_to_change', status: 400 };
    const at = now().toISOString();
    const [updated] = await db('KpiTarget').where({ id }).update({ ...patch, updatedAt: at, updatedBy: actorId }).returning('*');
    const after = shape(updated);
    try {
      await auditLog.insertAsync({
        id: `aud_${randomUUID().slice(0, 12)}`, at, actor: actorId, action: 'kpi_target_updated', target: id,
        before: audited(before), after: audited(after),
      });
    } catch (err) {
      // The change is saved; a failed audit write is logged, never silent.
      logger.warn?.('[kpi-targets] audit log write failed:', err?.message);
    }
    return { target: after };
  }

  return { list, update };
}
