// Moderation — approve, reject, suspend, hide and restore the entities FitFlex lists.
//
// This is an overlay. KYC stays the authority on whether a partner is verified
// and may be paid; moderation decides whether an entity may be shown and
// promoted. An entity with no ModerationState row is approved, so nothing that
// exists today changes. Every decision is recorded twice: in ModerationEvent
// (the entity's history) and in AuditLog (the platform's).
import { randomUUID } from 'node:crypto';
import { ENTITY_TYPES, MODERATION_STATUSES, MODERATION_ACTIONS, IMPLICIT_MODERATION_STATUS } from '../shared/promotion-config.mjs';
import { planModeration } from '../shared/promotion-rules.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const text = (v, max = 1000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function page(rows, query = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
  return { items: rows.slice(offset, offset + limit), total: rows.length, nextCursor: offset + limit < rows.length ? offset + limit : null };
}

export function createModerationService({
  states, events, entities, auditLog,
  // Called after an entity becomes blocked, so live promotions on it are held: (type, id, { actor, reason }).
  onEntityBlocked = null,
  now = () => new Date(),
}) {
  const stamp = () => now().toISOString();
  const key = (type, id) => `${type}:${id}`;

  const audit = ({ actor, action, target, before = null, after = null }) =>
    auditLog.insertAsync({ id: randomUUID(), at: stamp(), actor, action, target, before, after });

  async function statusOf(type, id) {
    const row = await states.findByIdAsync(key(type, id));
    return row ? row.status : IMPLICIT_MODERATION_STATUS;
  }

  function reference() {
    return { entityTypes: Object.keys(ENTITY_TYPES), statuses: MODERATION_STATUSES, actions: MODERATION_ACTIONS, implicitStatus: IMPLICIT_MODERATION_STATUS };
  }

  /** Counts per status for the dashboard. Entities without a row count as approved. */
  async function counts({ entityType } = {}) {
    const types = entityType ? [entityType] : Object.keys(ENTITY_TYPES);
    const out = Object.fromEntries(MODERATION_STATUSES.map(s => [s, 0]));
    for (const type of types) {
      const all = await entities.listAll(type);
      const rows = await states.filterAsync(r => r.entityType === type);
      const explicit = new Map(rows.map(r => [r.entityId, r.status]));
      for (const e of all) out[explicit.get(e.id) || IMPLICIT_MODERATION_STATUS] += 1;
    }
    return out;
  }

  /** Entities of a type with their moderation status, filtered by status and a name search. */
  async function list({ entityType, status, q, limit, cursor } = {}) {
    if (!ENTITY_TYPES[entityType]) return fail('invalid_entity_type', 400);
    if (status && !MODERATION_STATUSES.includes(status)) return fail('invalid_status', 400);
    const all = await entities.listAll(entityType);
    const rows = await states.filterAsync(r => r.entityType === entityType);
    const byId = new Map(rows.map(r => [r.entityId, r]));
    const needle = text(q, 100)?.toLowerCase();
    const out = [];
    for (const e of all) {
      const row = byId.get(e.id);
      const s = row?.status || IMPLICIT_MODERATION_STATUS;
      if (status && s !== status) continue;
      const summary = entities.summary(entityType, e);
      if (needle && !`${summary.name} ${summary.subtitle || ''}`.toLowerCase().includes(needle)) continue;
      out.push({ entityType, ...summary, moderationStatus: s, reason: row?.reason || null, decidedBy: row?.decidedBy || null, decidedAt: row?.decidedAt || null });
    }
    // Pending first, then by name, so the queue reads oldest-decision-last.
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { ...page(out, { limit, cursor }), counts: await counts({ entityType }) };
  }

  async function history(type, id) {
    const rows = await events.filterAsync(e => e.entityType === type && e.entityId === id);
    return rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  }

  async function detail(type, id) {
    if (!ENTITY_TYPES[type]) return fail('invalid_entity_type', 400);
    const entity = await entities.get(type, id);
    if (!entity) return fail('entity_not_found', 404);
    const status = await statusOf(type, id);
    const row = await states.findByIdAsync(key(type, id));
    return {
      // The summary only: a vendor is a User row and must not leak its account fields.
      entityType: type, summary: entities.summary(type, entity), moderationStatus: status,
      reason: row?.reason || null, decidedBy: row?.decidedBy || null, decidedAt: row?.decidedAt || null,
      eligibility: await entities.eligibility(type, entity, status),
      history: await history(type, id),
      allowedActions: Object.entries(MODERATION_ACTIONS).filter(([, r]) => r.from.includes(status)).map(([a, r]) => ({ action: a, reasonRequired: r.reason })),
    };
  }

  /** Run one moderation action. Validates the transition server-side; the UI only offers what is allowed. */
  async function decide({ entityType, entityId, action, reason, actorId }) {
    if (!ENTITY_TYPES[entityType]) return fail('invalid_entity_type', 400);
    if (!actorId) return fail('actor_required', 403);
    const entity = await entities.get(entityType, entityId);
    if (!entity) return fail('entity_not_found', 404);
    const row = await states.findByIdAsync(key(entityType, entityId));
    const plan = planModeration(row?.status, action, reason);
    if (plan.error) return fail(plan.error, plan.error === 'unknown_action' ? 400 : plan.error === 'reason_required' ? 400 : 409, plan.from ? { from: plan.from, action } : {});

    const at = stamp();
    const note = text(reason);
    const next = {
      id: key(entityType, entityId), entityType, entityId, status: plan.to,
      reason: note, decidedBy: actorId, decidedAt: at, updatedAt: at,
    };
    if (row) await states.updateByIdAsync(next.id, next);
    else await states.insertAsync({ ...next, createdAt: at });
    await events.insertAsync({
      id: randomUUID(), entityType, entityId, action, fromStatus: plan.from, toStatus: plan.to, reason: note, actor: actorId, at,
    });
    await audit({
      actor: actorId, action: `moderation.${action}`, target: key(entityType, entityId),
      before: { status: plan.from }, after: { status: plan.to, reason: note },
    });

    // An entity that just stopped being listable can no longer carry a live promotion.
    let heldPromotions = 0;
    if (plan.blocking && onEntityBlocked) {
      const held = await onEntityBlocked(entityType, entityId, { actor: actorId, reason: note || `Entity ${plan.to}` });
      heldPromotions = held?.held ?? 0;
    }
    return { entityType, entityId, from: plan.from, to: plan.to, heldPromotions };
  }

  return { reference, statusOf, counts, list, detail, history, decide };
}
