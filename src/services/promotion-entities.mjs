// Moderation & Promotion — finds the entities that can be moderated and promoted.
//
// Gyms, trainers and products are rows of their own tables; a vendor is a User
// with userType 'vendor'. This is the one place that knows that. Adding a
// promotable entity type is one more entry in `resolvers` (and ENTITY_TYPES).
import { entityEligibility } from '../shared/promotion-rules.mjs';

export function createEntityResolver({ gyms, trainers, users, products, partnerGate }) {
  const resolvers = {
    gym: {
      get: id => gyms.findByIdAsync(id),
      all: () => gyms.allAsync(),
      summary: g => ({ id: g.id, name: g.name, subtitle: g.location || null, status: g.status, tier: g.tier || null }),
      ownerUserId: () => null,
    },
    trainer: {
      get: id => trainers.findByIdAsync(id),
      all: () => trainers.allAsync(),
      summary: t => ({ id: t.id, name: t.displayName, subtitle: (t.specialties || []).join(', ') || null, status: t.status }),
      ownerUserId: t => t.userId || null,
    },
    vendor: {
      get: async (id) => {
        const u = await users.findByIdAsync(id);
        return u && u.userType === 'vendor' ? u : null;
      },
      all: () => users.filterAsync(u => u.userType === 'vendor'),
      summary: v => ({ id: v.id, name: v.vendorProfile?.businessName || v.displayName || v.id, subtitle: v.vendorProfile?.businessCategory || null, status: v.accountStatus || 'active' }),
      ownerUserId: v => v.id,
    },
    product: {
      get: id => products.findByIdAsync(id),
      all: () => products.allAsync(),
      summary: p => ({ id: p.id, name: p.name, subtitle: p.category || null, status: p.status }),
      ownerUserId: p => p.vendorId || null,
    },
  };

  const known = type => Object.prototype.hasOwnProperty.call(resolvers, type);

  async function get(type, id) {
    if (!known(type) || !id) return null;
    return (await resolvers[type].get(id)) || null;
  }

  async function listAll(type) {
    return known(type) ? (await resolvers[type].all()) || [] : [];
  }

  const summary = (type, entity) => (entity && known(type) ? resolvers[type].summary(entity) : null);

  /** KYC gate: vendors (and their products) are live only when the vendor is operational. */
  async function operational(type, entity) {
    if (!entity || !partnerGate) return true;
    const owner = resolvers[type]?.ownerUserId(entity);
    if (!owner || !['vendor', 'product'].includes(type)) return true;
    return partnerGate.isOperational(owner);
  }

  /** { ok, reasons } for one entity given its moderation status. */
  async function eligibility(type, entity, moderationStatus) {
    return entityEligibility(type, entity, moderationStatus, { operational: await operational(type, entity) });
  }

  /** The area ids an entity sits in, for targeting. Products and vendors have none yet. */
  function areaIds(type, entity) {
    if (!entity) return [];
    return [entity.cityId, entity.regionId].filter(Boolean);
  }

  return { get, listAll, summary, eligibility, operational, areaIds, types: Object.keys(resolvers) };
}
