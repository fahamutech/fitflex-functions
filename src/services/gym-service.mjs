// Gym service — catalogue CRUD + payload normalization/slimming.
// `slimGym` strips heavy fields (images/thumbnails/operatingHours) down to a
// single thumbnail for embedding inside OTHER resources (trainers, owners).
// `slimGymRef` goes further — no thumbnail at all — for list-level embeds
// where even one image per row is enough to balloon payload size; callers
// needing the image fetch the gym directly via getGym.
import { randomUUID } from 'node:crypto';
import { gymProfileGaps } from '../shared/gym-profile.mjs';

export function createGymService({ gyms, users, checkins, auditLog }) {
  function normalizeGymPayload(body = {}, prior) {
    prior = prior || {};
    const images = Array.isArray(body.images)
      ? body.images
      : String(body.images || prior.images?.join('\n') || '')
        .split(/\n|,/)
        .map(url => url.trim())
        .filter(Boolean);
    const thumbnails = Array.isArray(body.thumbnails) ? body.thumbnails : (prior.thumbnails || []);
    const lat = body.coordinates?.lat ?? body.lat ?? prior.coordinates?.lat ?? null;
    const lng = body.coordinates?.lng ?? body.lng ?? prior.coordinates?.lng ?? null;
    const venueType = body.venueType ?? prior.venueType ?? 'physical';
    const accessMode = body.accessMode ?? prior.accessMode ?? 'paid_visit';
    const isOnlineFree = venueType === 'online' || accessMode === 'free_online';
    const amenities = Array.isArray(body.amenities) ? body.amenities : (prior.amenities || []);
    const equipment = Array.isArray(body.equipment) ? body.equipment : (prior.equipment || []);
    // B11: gym classes (Yoga, Aerobics, ...) with schedule/price/location.
    const classes = (Array.isArray(body.classes) ? body.classes : (prior.classes || []))
      .filter(c => c && String(c.name || '').trim())
      .map(c => ({
        id: c.id || `cls_${randomUUID().slice(0, 8)}`,
        name: String(c.name).trim(),
        schedule: c.schedule || null,
        price: c.price == null ? null : Number(c.price),
        location: c.location || null,
      }));
    // B12: trainer pass — fee external trainers pay to train clients here.
    const tpBody = body.trainerPass ?? prior.trainerPass ?? {};
    const trainerPass = {
      enabled: Boolean(tpBody.enabled),
      feeTzs: Number(tpBody.feeTzs ?? 0),
      period: ['daily', 'weekly', 'monthly'].includes(tpBody.period) ? tpBody.period : 'monthly',
    };
    // A6: verified = explicit flag (admin/prior) if set, otherwise derived
    // from profile completeness (location + coordinates + photos + amenities
    // + equipment).
    const explicitVerified = typeof body.verified === 'boolean'
      ? body.verified
      : (typeof prior.verified === 'boolean' ? prior.verified : null);
    const autoVerified = gymProfileGaps({
      name: body.name ?? prior.name,
      location: body.location ?? prior.location,
      coordinates: { lat, lng },
      images, amenities, equipment,
    }).length === 0;
    return {
      id: body.id || prior.id || `gym_${randomUUID().slice(0, 8)}`,
      status: body.status || prior.status || 'active',
      homepageVisible: typeof body.homepageVisible === 'boolean'
        ? body.homepageVisible
        : (prior.homepageVisible ?? true),
      homepagePriority: Number(body.homepagePriority ?? prior.homepagePriority ?? 0),
      commissionRate: Number(body.commissionRate ?? prior.commissionRate ?? 12),
      name: body.name ?? prior.name ?? 'Unnamed Gym',
      tier: isOnlineFree ? 'online' : (body.tier ?? prior.tier ?? 'standard'),
      location: body.location ?? prior.location ?? '',
      perVisitRate: isOnlineFree ? 0 : Number(body.perVisitRate ?? prior.perVisitRate ?? 0),
      accessMode: isOnlineFree ? 'free_online' : accessMode,
      venueType,
      coordinates: {
        lat: lat === null || lat === '' ? null : Number(lat),
        lng: lng === null || lng === '' ? null : Number(lng)
      },
      ratePerDay: Number(body.ratePerDay ?? prior.ratePerDay ?? body.perVisitRate ?? prior.perVisitRate ?? 0),
      ratePerWeek: Number(body.ratePerWeek ?? prior.ratePerWeek ?? 0),
      ratePerMonth: Number(body.ratePerMonth ?? prior.ratePerMonth ?? 0),
      images,
      thumbnails,
      operatingHours: body.operatingHours ?? prior.operatingHours ?? null,
      amenities,
      equipment,
      classes,
      trainerPass,
      verified: explicitVerified ?? autoVerified,
      paymentBank: body.paymentBank ?? prior.paymentBank ?? null,
      paymentNumber: body.paymentNumber ?? prior.paymentNumber ?? null,
      paymentNotes: body.paymentNotes ?? prior.paymentNotes ?? null,
      tinNumber: body.tinNumber ?? prior.tinNumber ?? null,
    };
  }

  /**
   * Embeddable gym summary with a single thumbnail (no full image/thumbnail
   * arrays or hours). Only ever uses a real pre-generated thumbnail — NEVER
   * falls back to a raw `images[0]` entry, since gym images are stored as
   * full-size base64 data URIs (avg ~9KB, up to ~900KB each) and embedding
   * one per row is exactly the kind of payload bloat this helper exists to
   * prevent. Callers needing the actual photo fetch the gym directly via
   * GET /gyms/:id.
   */
  function slimGym(g) {
    if (!g) return g;
    const { images, thumbnails, operatingHours, ...rest } = g;
    return { ...rest, thumbnail: (thumbnails && thumbnails[0]) || null };
  }

  /**
   * Table-level gym summary — only the fields the admin table columns and
   * filters actually use. Strips amenities, equipment, payment details,
   * coordinates, and other heavy fields that are only needed in detail/edit
   * (fetched lazily via GET /gyms/:id).
   */
  function slimGymForTable(g) {
    if (!g) return g;
    return {
      id: g.id,
      name: g.name,
      tier: g.tier,
      verified: g.verified ?? false,
      location: g.location,
      venueType: g.venueType,
      accessMode: g.accessMode,
      perVisitRate: g.perVisitRate,
      ratePerDay: g.ratePerDay,
      ratePerWeek: g.ratePerWeek,
      ratePerMonth: g.ratePerMonth,
      commissionRate: g.commissionRate,
      status: g.status,
      homepageVisible: g.homepageVisible ?? true,
      homepagePriority: Number(g.homepagePriority || 0),
      thumbnail: (g.thumbnails && g.thumbnails[0]) || null,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    };
  }

  /** Leanest possible gym reference for list-level embeds (owners list, member rows, etc.) — no image at all. */
  function slimGymRef(g) {
    if (!g) return g;
    return { id: g.id, name: g.name, tier: g.tier, verified: g.verified ?? false };
  }

  function findById(id) {
    return gyms.find(g => g.id === id) || null;
  }

  function listActive() {
    return gyms
      .filter(g => g.status === 'active' && g.homepageVisible !== false)
      .sort((a, b) => Number(b.homepagePriority || 0) - Number(a.homepagePriority || 0));
  }

  async function listActiveAsync() {
    const rows = await gyms.filterAsync(g => g.status === 'active' && g.homepageVisible !== false);
    return rows.sort((a, b) => Number(b.homepagePriority || 0) - Number(a.homepagePriority || 0));
  }

  /**
   * Admin gym table. Default response is slimmed (single `thumbnail`, no
   * `images`/`thumbnails` arrays or `operatingHours`) — this was previously
   * the single biggest payload on the admin portal (~2.9MB for ~300 gyms,
   * since `images` holds full base64 photos). Pass `?full=true` to fetch
   * everything (used by the edit form); GET /gyms/:id also returns the full
   * gym for the read-only detail view.
   */
  function listAdmin({ full }) {
    if (full === 'true') return gyms.all();
    return gyms.all().map(slimGymForTable);
  }

  async function upsert({ body, actorId }) {
    if (!body?.name || !body?.tier) return { error: 'name_and_tier_required', status: 400 };
    const id = body.id || `gym_${randomUUID().slice(0, 6)}`;
    const prior = findById(id);
    const row = normalizeGymPayload({ ...body, id }, prior);
    await gyms.upsertAsync(g => g.id === id, row);
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: prior ? 'gym_updated' : 'gym_created',
      target: id, before: prior ?? null, after: row
    });
    return { gym: row };
  }

  async function remove({ id, actorId }) {
    const prior = findById(id);
    if (!prior) return { error: 'not_found', status: 404 };
    const assignedOperator = await users.findAsync(u => u.userType === 'gym_operator' && u.gymId === prior.id);
    const hasCheckins = await checkins.findAsync(c => c.gymId === prior.id);
    if (assignedOperator || hasCheckins) return { error: 'gym_has_activity_or_operator', status: 409 };
    const removed = await gyms.removeAsync(g => g.id === prior.id);
    await auditLog.insertAsync({
      id: randomUUID(), at: new Date().toISOString(),
      actor: actorId, action: 'gym_deleted',
      target: prior.id, before: prior, after: null
    });
    return { gym: removed };
  }

  return { normalizeGymPayload, slimGym, slimGymRef, findById, listActive, listActiveAsync, listAdmin, upsert, remove };
}
