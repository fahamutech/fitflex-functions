// What moderation keeps out of public view. An entity with no decision is
// approved, so with nothing recorded this changes nothing; a listing that is
// pending, rejected, suspended or hidden is out of every public list.
import { BLOCKING_MODERATION_STATUSES } from '../shared/promotion-config.mjs';

/** Lets everything through: the default for services built without moderation (unit specs). */
export const OPEN_PUBLIC_GATE = Object.freeze({ blocked: async () => new Set(), isBlocked: async () => false });

export function createModerationGate({ states }) {
  /** Ids of one entity type that must not be shown publicly. */
  async function blocked(entityType) {
    const rows = await states.filterAsync(r => r.entityType === entityType && BLOCKING_MODERATION_STATUSES.includes(r.status));
    return new Set(rows.map(r => r.entityId));
  }
  const isBlocked = async (entityType, id) => (await blocked(entityType)).has(id);
  return { blocked, isBlocked };
}
