// Promotions — the record of every promotion FitFlex runs, its approval, its
// schedule and its lifecycle; the campaigns they belong to; how many a
// placement can hold; and the geography they target.
//
// This service never touches discovery. It answers "which promotions are live
// for this placement, entity type and viewer?" (listLive) and leaves ranking to
// the pure scorer in promotion-rules.mjs, so promotion cannot bypass the
// filters a search applies before it looks at a single promotion.
//
// Every state is read through effectiveStatus(), so an expired, paused or not
// yet started promotion cannot influence anything even if the job is late.
import { randomUUID } from 'node:crypto';
import {
  ENTITY_TYPES, PROMOTION_TYPES, PROMOTION_STATUSES, PROMOTION_TRANSITIONS, PLACEMENTS, RELATIONSHIP_TYPES,
  SLOT_HOLDING_STATUSES, LIVE_EDITABLE_FIELDS, CAMPAIGN_STATUSES, CAMPAIGN_TRANSITIONS, ROTATION_MODES,
  DEFAULT_PLACEMENT_LIMITS, DEFAULT_MAX_BOOST_FRACTION, DEFAULT_ROTATION, MAX_PRIORITY,
} from '../shared/promotion-config.mjs';
import {
  validatePromotionInput, checkPromotionRules, effectiveStatus, canTransition, capacityCheck, slotLimit,
  normaliseGeoScope, geoMatches, disclosureLabel, placementsFor, isModerationBlocking,
} from '../shared/promotion-rules.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const text = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const newId = prefix => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const ms = v => new Date(v).getTime();
const DAY = 86_400_000;
/** One lock for all capacity decisions: they are rare admin actions, so simple beats clever. */
const CAPACITY_LOCK = 'promotion-capacity';
const AREA_PARENT_LEVEL = { region: 'country', city: 'region', district: 'city' };

function page(rows, query = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
  return { items: rows.slice(offset, offset + limit), total: rows.length, nextCursor: offset + limit < rows.length ? offset + limit : null };
}

export function createPromotionService({
  promotions, placements, campaigns, configs, geoAreas, entities, moderation, auditLog,
  organizations = null,
  // Serialises the steps that claim placement capacity, across servers: (key, fn) => fn's result. The default
  // runs fn at once, which is right for one process and for unit specs.
  withLock = (_key, fn) => fn(),
  now = () => new Date(),
}) {
  const stamp = () => now().toISOString();
  const audit = ({ actor, action, target, before = null, after = null }) =>
    auditLog.insertAsync({ id: randomUUID(), at: stamp(), actor, action, target, before, after });

  // ── Reads ──────────────────────────────────────────────────────────────────

  const areasById = async () => new Map((await geoAreas.allAsync()).map(a => [a.id, a]));

  async function withPlacements(rows) {
    const links = await placements.filterAsync(l => rows.some(r => r.id === l.promotionId));
    const by = new Map();
    for (const l of links) by.set(l.promotionId, [...(by.get(l.promotionId) || []), l.placement]);
    return rows.map(r => ({ ...r, placements: (by.get(r.id) || []).sort() }));
  }

  async function load(id) {
    const row = await promotions.findByIdAsync(id);
    if (!row) return null;
    return (await withPlacements([row]))[0];
  }

  async function syncPlacements(promotionId, wanted) {
    const existing = await placements.filterAsync(l => l.promotionId === promotionId);
    const have = new Set(existing.map(l => l.placement));
    for (const placement of wanted) {
      if (!have.has(placement)) await placements.insertAsync({ id: `${promotionId}:${placement}`, promotionId, placement });
    }
    for (const l of existing) {
      if (!wanted.includes(l.placement)) await placements.removeAsync(x => x.id === l.id);
    }
  }

  const view = (p, summary = null) => ({
    ...p,
    effectiveStatus: effectiveStatus(p, now()),
    label: PROMOTION_TYPES[p.type] ? disclosureLabel(p) : null,
    entity: summary,
  });

  async function summaryFor(p) {
    const e = await entities.get(p.entityType, p.entityId);
    return e ? entities.summary(p.entityType, e) : null;
  }

  function reference() {
    return {
      entityTypes: Object.keys(ENTITY_TYPES),
      promotionTypes: Object.fromEntries(Object.entries(PROMOTION_TYPES).map(([k, v]) => [k, { label: v.label, disclosure: v.disclosure, commercial: v.commercial }])),
      relationshipTypes: RELATIONSHIP_TYPES,
      statuses: PROMOTION_STATUSES,
      transitions: PROMOTION_TRANSITIONS,
      placements: Object.fromEntries(Object.entries(PLACEMENTS).map(([k, v]) => [k, { label: v.label, entityTypes: v.entityTypes }])),
      defaultLimits: DEFAULT_PLACEMENT_LIMITS,
      defaultMaxBoostFraction: DEFAULT_MAX_BOOST_FRACTION,
      defaultRotation: DEFAULT_ROTATION,
      maxPriority: MAX_PRIORITY,
      campaignStatuses: CAMPAIGN_STATUSES,
    };
  }

  async function list({ status, effective, entityType, placement, campaignId, type, q, limit, cursor } = {}) {
    let rows = await withPlacements(await promotions.allAsync());
    if (status) rows = rows.filter(r => r.status === status);
    if (effective) rows = rows.filter(r => effectiveStatus(r, now()) === effective);
    if (entityType) rows = rows.filter(r => r.entityType === entityType);
    if (type) rows = rows.filter(r => r.type === type);
    if (placement) rows = rows.filter(r => r.placements.includes(placement));
    if (campaignId) rows = rows.filter(r => r.campaignId === campaignId);
    rows.sort((a, b) => a.priority - b.priority || ms(b.createdAt) - ms(a.createdAt));
    const pageOut = page(rows, { limit, cursor });
    const items = [];
    for (const p of pageOut.items) items.push(view(p, await summaryFor(p)));
    const needle = text(q, 100)?.toLowerCase();
    return { ...pageOut, items: needle ? items.filter(i => `${i.entity?.name || ''} ${i.commercialRef || ''}`.toLowerCase().includes(needle)) : items };
  }

  async function history(id) {
    const rows = await auditLog.filterAsync(a => a.target === id && String(a.action).startsWith('promotion.'));
    return rows.sort((a, b) => ms(b.at) - ms(a.at));
  }

  async function get(id) {
    const p = await load(id);
    if (!p) return fail('promotion_not_found', 404);
    const entity = await entities.get(p.entityType, p.entityId);
    const modStatus = await moderation.statusOf(p.entityType, p.entityId);
    return {
      promotion: view(p, entity ? entities.summary(p.entityType, entity) : null),
      eligibility: await entities.eligibility(p.entityType, entity, modStatus),
      capacity: (await capacityFor(p)).results,
      history: await history(id),
      allowedActions: allowedActions(p),
    };
  }

  function allowedActions(p) {
    const eff = effectiveStatus(p, now());
    const out = [];
    if (p.status === 'draft') out.push('edit', 'submit', 'cancel');
    if (p.status === 'pending_approval') out.push('approve', 'reject', 'reopen', 'cancel');
    if (p.status === 'rejected') out.push('reopen');
    if (p.status === 'approved' && eff !== 'expired') out.push('schedule', 'activate', 'cancel', 'edit_live');
    if (p.status === 'scheduled' && eff !== 'expired') out.push('activate', 'pause', 'cancel', 'edit_live');
    if (p.status === 'active' && eff !== 'expired') out.push('pause', 'complete', 'cancel', 'edit_live');
    if (p.status === 'paused' && eff !== 'expired') out.push('resume', 'cancel', 'edit_live');
    if (eff === 'expired' || p.status === 'expired') out.push('complete');
    return [...new Set(out)];
  }

  // ── Capacity ───────────────────────────────────────────────────────────────

  async function capacityFor(p) {
    const others = await withPlacements((await promotions.allAsync()).filter(o => o.id !== p.id && o.type === p.type));
    return capacityCheck(p, others, await configs.allAsync(), await areasById());
  }

  /** Every placement × type with its limit, where it comes from, and how many slots are taken now. */
  async function limits() {
    const cfg = await configs.allAsync();
    const holders = (await withPlacements(await promotions.allAsync()))
      .filter(p => SLOT_HOLDING_STATUSES.includes(p.status) && effectiveStatus(p, now()) !== 'expired');
    const out = [];
    for (const [placement, def] of Object.entries(PLACEMENTS)) {
      for (const type of Object.keys(PROMOTION_TYPES)) {
        const row = cfg.find(c => c.placement === placement && c.promotionType === type);
        out.push({
          placement, label: def.label, promotionType: type, entityTypes: def.entityTypes,
          maxSlots: slotLimit(cfg, placement, type), source: row ? 'config' : 'default',
          maxBoostFraction: row?.maxBoostFraction ?? DEFAULT_MAX_BOOST_FRACTION,
          rotationMode: row?.rotationMode ?? DEFAULT_ROTATION.mode,
          rotationWindowMinutes: row?.rotationWindowMinutes ?? DEFAULT_ROTATION.windowMinutes,
          used: holders.filter(p => p.type === type && p.placements.includes(placement)).length,
        });
      }
    }
    return out;
  }

  async function setLimit({ placement, promotionType, maxSlots, maxBoostFraction, rotationMode, rotationWindowMinutes, actorId }) {
    if (!PLACEMENTS[placement]) return fail('invalid_placement', 400);
    if (!PROMOTION_TYPES[promotionType]) return fail('invalid_promotion_type', 400);
    if (!Number.isInteger(maxSlots) || maxSlots < 0 || maxSlots > 1000) return fail('invalid_max_slots', 400);
    if (maxBoostFraction != null && !(Number(maxBoostFraction) >= 0 && Number(maxBoostFraction) <= 1)) return fail('invalid_boost_fraction', 400);
    if (rotationMode != null && !ROTATION_MODES.includes(rotationMode)) return fail('invalid_rotation_mode', 400);
    if (rotationWindowMinutes != null && !(Number.isInteger(rotationWindowMinutes) && rotationWindowMinutes >= 1)) return fail('invalid_rotation_window', 400);
    const id = `${placement}:${promotionType}`;
    const before = await configs.findByIdAsync(id);
    const row = {
      id, placement, promotionType, maxSlots,
      maxBoostFraction: maxBoostFraction == null ? null : Number(maxBoostFraction),
      rotationMode: rotationMode ?? before?.rotationMode ?? DEFAULT_ROTATION.mode,
      rotationWindowMinutes: rotationWindowMinutes ?? before?.rotationWindowMinutes ?? DEFAULT_ROTATION.windowMinutes,
      updatedBy: actorId, updatedAt: stamp(),
    };
    if (before) await configs.updateByIdAsync(id, row); else await configs.insertAsync(row);
    await audit({ actor: actorId, action: 'promotion.placement_limit_set', target: id, before: before || null, after: row });
    return { limit: row };
  }

  // ── Create and edit ────────────────────────────────────────────────────────

  /** The entity must exist under that type, and not be rejected, suspended or hidden. */
  async function checkEntity(p, { live }) {
    const entity = await entities.get(p.entityType, p.entityId);
    if (!entity) {
      for (const other of entities.types.filter(t => t !== p.entityType)) {
        if (await entities.get(other, p.entityId)) return fail('entity_type_mismatch', 422, { field: 'entityType', foundAs: other });
      }
      return fail('entity_not_found', 404, { field: 'entityId' });
    }
    const modStatus = await moderation.statusOf(p.entityType, p.entityId);
    if (isModerationBlocking(modStatus) && (live || modStatus !== 'pending')) {
      return fail('entity_not_promotable', 409, { reasons: [`moderation_${modStatus}`], moderationStatus: modStatus });
    }
    if (live) {
      const e = await entities.eligibility(p.entityType, entity, modStatus);
      if (!e.ok) return fail('entity_not_promotable', 409, { reasons: e.reasons });
    }
    return { entity };
  }

  async function checkLinks(p) {
    if (p.campaignId) {
      const c = await campaigns.findByIdAsync(p.campaignId);
      if (!c) return fail('campaign_not_found', 404, { field: 'campaignId' });
      if (['ended', 'cancelled'].includes(c.status)) return fail('campaign_closed', 409, { field: 'campaignId' });
      if (ms(p.startsAt) < ms(c.startsAt) || ms(p.endsAt) > ms(c.endsAt)) return fail('outside_campaign_period', 422, { field: 'startsAt' });
    }
    if (p.type === 'campaign' && !p.campaignId) return fail('campaign_required', 422, { field: 'campaignId' });
    if (p.partnerRef && organizations) {
      if (!(await organizations.findByIdAsync(p.partnerRef))) return fail('partner_not_found', 404, { field: 'partnerRef' });
    }
    const areas = await areasById();
    const missing = (p.geoScope?.areaIds || []).filter(id => !areas.has(id));
    if (missing.length) return fail('unknown_geo_area', 422, { field: 'geoScope', areaIds: missing });
    return {};
  }

  async function create({ body, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const v = validatePromotionInput(body, { now: now() });
    if (v.error) return fail(v.error, 422, { field: v.field });
    const draft = { ...v.value, id: newId('promo') };
    // A promotion that is Sponsored is paid by definition; Recommended never is. Unset means "by type".
    if (draft.isCommercial === undefined) draft.isCommercial = PROMOTION_TYPES[draft.type].commercial === 'required';
    const rules = checkPromotionRules(draft, { now: now(), requireFuture: true });
    if (rules.error) return fail(rules.error, 422, rules);
    const entityCheck = await checkEntity(draft, { live: false });
    if (entityCheck.error) return entityCheck;
    const links = await checkLinks(draft);
    if (links.error) return links;

    const at = stamp();
    const { placements: wanted, ...fields } = draft;
    await promotions.insertAsync({
      ...fields, status: 'draft', statusChangedAt: at, createdBy: actorId, createdAt: at, updatedAt: at,
      relationshipType: fields.relationshipType ?? null, partnerRef: fields.partnerRef ?? null, campaignId: fields.campaignId ?? null,
      commercialRef: fields.commercialRef ?? null, disclosureLabel: fields.disclosureLabel ?? null, notes: fields.notes ?? null,
    });
    await syncPlacements(draft.id, wanted);
    const saved = await load(draft.id);
    await audit({ actor: actorId, action: 'promotion.created', target: saved.id, after: snapshot(saved) });
    return { promotion: view(saved, await summaryFor(saved)) };
  }

  const snapshot = p => ({
    entityType: p.entityType, entityId: p.entityId, type: p.type, status: p.status, placements: p.placements, priority: p.priority,
    boostWeight: p.boostWeight, startsAt: p.startsAt, endsAt: p.endsAt, geoScope: p.geoScope, campaignId: p.campaignId,
    partnerRef: p.partnerRef, isCommercial: p.isCommercial, relationshipType: p.relationshipType, commercialRef: p.commercialRef,
  });

  /** Moving the end date of a held promotion can take a slot in a later period, so it takes the capacity lock too. */
  const update = args => (args?.body?.endsAt !== undefined ? withLock(CAPACITY_LOCK, () => updateUnlocked(args)) : updateUnlocked(args));

  async function updateUnlocked({ id, body, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const current = await load(id);
    if (!current) return fail('promotion_not_found', 404);
    const sent = Object.keys(body || {});
    if (current.status !== 'draft') {
      if (['pending_approval', 'rejected', 'expired', 'completed', 'cancelled'].includes(current.status)) {
        return fail('not_editable', 409, { currentStatus: current.status, hint: current.status === 'pending_approval' ? 'reopen it first' : undefined });
      }
      const locked = sent.filter(k => !LIVE_EDITABLE_FIELDS.includes(k));
      if (locked.length) return fail('field_locked', 409, { fields: locked, editable: LIVE_EDITABLE_FIELDS });
    }
    const v = validatePromotionInput(body, { partial: true, now: now() });
    if (v.error) return fail(v.error, 422, { field: v.field });
    const merged = { ...current, ...v.value };
    const rules = checkPromotionRules(merged, { now: now(), requireFuture: current.status !== 'draft' || v.value.endsAt !== undefined });
    if (rules.error) return fail(rules.error, 422, rules);
    if (current.status === 'draft') {
      const entityCheck = await checkEntity(merged, { live: false });
      if (entityCheck.error) return entityCheck;
    }
    const links = await checkLinks(merged);
    if (links.error) return links;
    // Extending or moving a held promotion must still fit its placements.
    if (current.status !== 'draft' && (v.value.endsAt !== undefined)) {
      const cap = await capacityFor(merged);
      if (!cap.ok) return fail('placement_full', 409, { capacity: cap.results.filter(r => r.full) });
    }
    const { placements: wanted, ...fields } = v.value;
    const patch = { ...fields, updatedAt: stamp() };
    await promotions.updateByIdAsync(id, patch);
    if (wanted) await syncPlacements(id, wanted);
    const saved = await load(id);
    await audit({ actor: actorId, action: 'promotion.updated', target: id, before: snapshot(current), after: snapshot(saved) });
    return { promotion: view(saved, await summaryFor(saved)) };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async function move(p, to, { actorId, action, reason = null, extra = {} }) {
    const at = stamp();
    await promotions.updateByIdAsync(p.id, { status: to, statusReason: reason, statusChangedAt: at, updatedAt: at, ...extra });
    const saved = await load(p.id);
    await audit({
      actor: actorId, action: `promotion.${action}`, target: p.id,
      before: { status: p.status }, after: { status: to, reason, ...(extra.priority ? { priority: extra.priority } : {}) },
    });
    return { promotion: view(saved, await summaryFor(saved)) };
  }

  async function act(id, actorId, fn, { capacity = false } = {}) {
    if (!actorId) return fail('actor_required', 403);
    const run = async () => {
      const p = await load(id);
      if (!p) return fail('promotion_not_found', 404);
      return fn(p);
    };
    // Whatever claims a slot checks the room and then takes it; two at once must not both see the last slot free.
    return capacity ? withLock(CAPACITY_LOCK, run) : run();
  }

  const invalid = (p, to) => fail('invalid_transition', 409, { from: p.status, to });

  const submit = ({ id, actorId }) => act(id, actorId, async (p) => {
    if (!canTransition(p.status, 'pending_approval')) return invalid(p, 'pending_approval');
    const rules = checkPromotionRules(p, { now: now(), requireFuture: true });
    if (rules.error) return fail(rules.error, 422, rules);
    const e = await checkEntity(p, { live: false });
    if (e.error) return e;
    if (p.isCommercial && !p.commercialRef && !p.partnerRef) return fail('commercial_reference_required', 422, { field: 'commercialRef' });
    const at = stamp();
    const out = await move(p, 'pending_approval', { actorId, action: 'submitted', extra: { submittedBy: actorId, submittedAt: at } });
    // Tell the submitter now if the placement is already full; approval will enforce it.
    const cap = await capacityFor(p);
    return cap.ok ? out : { ...out, warnings: [{ code: 'placement_full', capacity: cap.results.filter(r => r.full) }] };
  });

  /** Approval needs a different person from the one who made or submitted it. */
  const approve = ({ id, actorId }) => act(id, actorId, async (p) => {
    if (!canTransition(p.status, 'approved')) return invalid(p, 'approved');
    if (actorId === p.createdBy || actorId === p.submittedBy) return fail('cannot_approve_own_submission', 403);
    const rules = checkPromotionRules(p, { now: now(), requireFuture: true });
    if (rules.error) return fail(rules.error === 'period_in_past' ? 'promotion_expired' : rules.error, 409, rules);
    const e = await checkEntity(p, { live: true });
    if (e.error) return e;
    const cap = await capacityFor(p);
    if (!cap.ok) return fail('placement_full', 409, { capacity: cap.results.filter(r => r.full) });
    return move(p, 'approved', { actorId, action: 'approved', extra: { approvedBy: actorId, approvedAt: stamp() } });
  }, { capacity: true });

  const reject = ({ id, actorId, reason }) => act(id, actorId, async (p) => {
    if (!canTransition(p.status, 'rejected')) return invalid(p, 'rejected');
    if (!text(reason, 1000)) return fail('reason_required', 400);
    return move(p, 'rejected', { actorId, action: 'rejected', reason: text(reason, 1000) });
  });

  /** Back to draft so it can be edited again (after a rejection, or to withdraw a submission). */
  const reopen = ({ id, actorId }) => act(id, actorId, async (p) => {
    if (!canTransition(p.status, 'draft')) return invalid(p, 'draft');
    return move(p, 'draft', { actorId, action: 'reopened', extra: { submittedBy: null, submittedAt: null } });
  });

  async function guardLive(p, { needsWindow }) {
    if (effectiveStatus(p, now()) === 'expired') return fail('promotion_expired', 409);
    const e = await checkEntity(p, { live: true });
    if (e.error) return e;
    const cap = await capacityFor(p);
    if (!cap.ok) return fail('placement_full', 409, { capacity: cap.results.filter(r => r.full) });
    if (needsWindow === 'open' && ms(p.startsAt) > now().getTime()) return fail('start_in_future', 409, { hint: 'schedule it instead' });
    if (needsWindow === 'future' && ms(p.startsAt) <= now().getTime()) return fail('start_not_in_future', 409, { hint: 'activate it instead' });
    return null;
  }

  const schedule = ({ id, actorId }) => act(id, actorId, async (p) => {
    if (p.status !== 'approved') return invalid(p, 'scheduled');
    const problem = await guardLive(p, { needsWindow: 'future' });
    if (problem) return problem;
    return move(p, 'scheduled', { actorId, action: 'scheduled' });
  }, { capacity: true });

  const activate = ({ id, actorId }) => act(id, actorId, async (p) => {
    if (!['approved', 'scheduled'].includes(p.status)) return invalid(p, 'active');
    const problem = await guardLive(p, { needsWindow: 'open' });
    if (problem) return problem;
    return move(p, 'active', { actorId, action: 'activated', extra: { activatedAt: stamp(), pausedAt: null } });
  }, { capacity: true });

  const pause = ({ id, actorId, reason }) => act(id, actorId, async (p) => {
    if (!['active', 'scheduled'].includes(p.status)) return invalid(p, 'paused');
    if (effectiveStatus(p, now()) === 'expired') return fail('promotion_expired', 409);
    return move(p, 'paused', { actorId, action: 'paused', reason: text(reason, 1000), extra: { pausedAt: stamp() } });
  });

  const resume = ({ id, actorId }) => act(id, actorId, async (p) => {
    if (p.status !== 'paused') return invalid(p, 'active');
    if (effectiveStatus(p, now()) === 'expired') {
      await move(p, 'expired', { actorId, action: 'expired', reason: 'End date passed while paused' });
      return fail('promotion_expired', 409);
    }
    const problem = await guardLive(p, {});
    if (problem) return problem;
    // Before its start it goes back to being scheduled; otherwise it is live again.
    const to = ms(p.startsAt) > now().getTime() ? 'scheduled' : 'active';
    return move(p, to, { actorId, action: 'resumed', extra: { pausedAt: null, ...(to === 'active' ? { activatedAt: stamp() } : {}) } });
  }, { capacity: true });

  const cancel = ({ id, actorId, reason }) => act(id, actorId, async (p) => {
    if (!canTransition(p.status, 'cancelled')) return invalid(p, 'cancelled');
    if (!text(reason, 1000)) return fail('reason_required', 400);
    return move(p, 'cancelled', { actorId, action: 'cancelled', reason: text(reason, 1000) });
  });

  /** Close an active promotion early, or acknowledge an expired one as finished. */
  const complete = ({ id, actorId }) => act(id, actorId, async (p) => {
    const eff = effectiveStatus(p, now());
    if (!(p.status === 'expired' || eff === 'expired' || p.status === 'active')) return invalid(p, 'completed');
    return move(p, 'completed', { actorId, action: 'completed' });
  });

  /** What approving or activating this would hit, without changing anything. */
  async function preview({ id, body }) {
    let p;
    if (id) { p = await load(id); if (!p) return fail('promotion_not_found', 404); }
    else {
      const v = validatePromotionInput(body, { now: now() });
      if (v.error) return fail(v.error, 422, { field: v.field });
      p = { ...v.value, id: '(preview)', isCommercial: v.value.isCommercial ?? PROMOTION_TYPES[v.value.type].commercial === 'required' };
      const rules = checkPromotionRules(p, { now: now(), requireFuture: true });
      if (rules.error) return fail(rules.error, 422, rules);
    }
    const entity = await entities.get(p.entityType, p.entityId);
    if (!entity) return fail('entity_not_found', 404);
    const modStatus = await moderation.statusOf(p.entityType, p.entityId);
    const eligibility = await entities.eligibility(p.entityType, entity, modStatus);
    const cap = await capacityFor(p);
    return {
      entity: entities.summary(p.entityType, entity), eligibility, capacity: cap.results,
      canApprove: eligibility.ok && cap.ok,
      warnings: [
        ...(!eligibility.ok ? [{ code: 'entity_not_promotable', reasons: eligibility.reasons }] : []),
        ...(!cap.ok ? [{ code: 'placement_full', capacity: cap.results.filter(r => r.full) }] : []),
      ],
    };
  }

  // ── Automatic work (the scheduled job) ────────────────────────────────────

  /**
   * Moves promotions through time: scheduled → active when their start arrives,
   * anything that holds a slot → expired when its end passes. Safe to run twice.
   * An entity that has since been blocked in moderation holds the promotion
   * instead of activating it.
   */
  async function runLifecycle({ actor = 'system:promotion-lifecycle' } = {}) {
    const out = { processed: 0, activated: 0, expired: 0, held: 0, failed: 0 };
    const rows = (await promotions.allAsync()).filter(p => ['approved', 'scheduled', 'active', 'paused'].includes(p.status));
    for (const row of rows) {
      out.processed += 1;
      try {
        const p = await load(row.id);
        const eff = effectiveStatus(p, now());
        if (eff === 'expired') {
          await move(p, 'expired', { actorId: actor, action: 'expired', reason: 'End date passed' });
          out.expired += 1;
        } else if (p.status === 'scheduled' && eff === 'active') {
          const mod = await moderation.statusOf(p.entityType, p.entityId);
          if (isModerationBlocking(mod)) {
            await move(p, 'paused', { actorId: actor, action: 'paused', reason: `Entity ${mod} in moderation`, extra: { pausedAt: stamp() } });
            out.held += 1;
          } else {
            await move(p, 'active', { actorId: actor, action: 'activated', reason: 'Scheduled start reached', extra: { activatedAt: stamp() } });
            out.activated += 1;
          }
        }
      } catch (err) {
        out.failed += 1;
        console.error(`[promotion-lifecycle] ${row.id}:`, err.message);
      }
    }
    return out;
  }

  /** An entity was suspended, hidden, rejected or sent back for review: stop its running promotions. */
  async function holdForEntity(entityType, entityId, { actor, reason }) {
    const rows = (await promotions.allAsync())
      .filter(p => p.entityType === entityType && p.entityId === entityId && ['scheduled', 'active'].includes(p.status));
    let held = 0;
    for (const row of rows) {
      const p = await load(row.id);
      await move(p, 'paused', { actorId: actor, action: 'paused', reason: `Held: ${reason}`, extra: { pausedAt: stamp() } });
      held += 1;
    }
    return { held };
  }

  /**
   * Promotions that may influence a placement right now: active in time, on an
   * entity that is still approved and eligible, reaching this viewer. This is
   * the only thing discovery should ask; ranking applies the (bounded) boost.
   */
  async function listLive({ placement, entityType, viewer = {}, type, checkEntities = true } = {}) {
    const areas = await areasById();
    const rows = (await withPlacements(await promotions.allAsync())).filter(p => p.status === 'scheduled' || p.status === 'active');
    const out = [];
    for (const p of rows) {
      if (effectiveStatus(p, now()) !== 'active') continue;
      if (placement && !p.placements.includes(placement)) continue;
      if (entityType && p.entityType !== entityType) continue;
      if (type && p.type !== type) continue;
      if (!geoMatches(p.geoScope, viewer, areas)) continue;
      // Discovery already holds the listings it may show, so it checks them itself and skips these lookups.
      if (checkEntities) {
        const entity = await entities.get(p.entityType, p.entityId);
        const mod = await moderation.statusOf(p.entityType, p.entityId);
        const el = await entities.eligibility(p.entityType, entity, mod);
        if (!el.ok) continue;
      }
      out.push({ ...p, entityKey: `${p.entityType}:${p.entityId}`, label: disclosureLabel(p), commercial: p.isCommercial });
    }
    return out.sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
  }

  async function overview() {
    const all = await withPlacements(await promotions.allAsync());
    const eff = p => effectiveStatus(p, now());
    const t = now().getTime();
    const mod = await moderation.counts();
    const recent = (await auditLog.filterAsync(a => /^(promotion|moderation|campaign)\./.test(String(a.action))))
      .sort((a, b) => ms(b.at) - ms(a.at)).slice(0, 15);
    return {
      active: all.filter(p => eff(p) === 'active').length,
      scheduled: all.filter(p => eff(p) === 'scheduled').length,
      paused: all.filter(p => p.status === 'paused').length,
      drafts: all.filter(p => p.status === 'draft').length,
      pendingPromotionRequests: all.filter(p => p.status === 'pending_approval').length,
      pendingModeration: mod.pending,
      moderation: mod,
      expiringSoon: all.filter(p => ['active', 'scheduled', 'paused'].includes(eff(p)) && ms(p.endsAt) - t <= 7 * DAY && ms(p.endsAt) > t)
        .sort((a, b) => ms(a.endsAt) - ms(b.endsAt)).slice(0, 10).map(p => ({ id: p.id, entityType: p.entityType, entityId: p.entityId, type: p.type, endsAt: p.endsAt })),
      recent,
    };
  }

  // ── Campaigns ──────────────────────────────────────────────────────────────

  async function createCampaign({ body, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const name = text(body?.name, 120);
    if (!name) return fail('name_required', 422, { field: 'name' });
    const startsAt = new Date(body?.startsAt);
    const endsAt = new Date(body?.endsAt);
    if (Number.isNaN(startsAt.getTime())) return fail('invalid_start', 422, { field: 'startsAt' });
    if (Number.isNaN(endsAt.getTime())) return fail('invalid_end', 422, { field: 'endsAt' });
    if (endsAt <= startsAt) return fail('end_before_start', 422, { field: 'endsAt' });
    const geo = normaliseGeoScope(body?.geoScope);
    if (geo.error) return fail(geo.error, 422, { field: 'geoScope' });
    const areas = await areasById();
    const missing = geo.value.areaIds.filter(id => !areas.has(id));
    if (missing.length) return fail('unknown_geo_area', 422, { field: 'geoScope', areaIds: missing });
    const at = stamp();
    const row = {
      id: newId('camp'), name, description: text(body?.description, 1000), status: 'draft', statusReason: null,
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), geoScope: geo.value, createdBy: actorId, createdAt: at, updatedAt: at,
    };
    await campaigns.insertAsync(row);
    await audit({ actor: actorId, action: 'campaign.created', target: row.id, after: row });
    return { campaign: row };
  }

  async function updateCampaign({ id, body, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const c = await campaigns.findByIdAsync(id);
    if (!c) return fail('campaign_not_found', 404);
    if (['ended', 'cancelled'].includes(c.status)) return fail('not_editable', 409, { currentStatus: c.status });
    const patch = { updatedAt: stamp() };
    if (body?.name !== undefined) { patch.name = text(body.name, 120); if (!patch.name) return fail('name_required', 422, { field: 'name' }); }
    if (body?.description !== undefined) patch.description = text(body.description, 1000);
    if (body?.startsAt !== undefined || body?.endsAt !== undefined) {
      const s = new Date(body.startsAt ?? c.startsAt);
      const e = new Date(body.endsAt ?? c.endsAt);
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return fail('invalid_period', 422, { field: 'startsAt' });
      if (e <= s) return fail('end_before_start', 422, { field: 'endsAt' });
      // Moving the period must not strand a promotion outside it.
      const linked = (await promotions.allAsync()).filter(p => p.campaignId === id && !['cancelled', 'completed', 'rejected'].includes(p.status));
      const stranded = linked.filter(p => ms(p.startsAt) < s.getTime() || ms(p.endsAt) > e.getTime());
      if (stranded.length) return fail('promotions_outside_period', 409, { promotionIds: stranded.map(p => p.id) });
      patch.startsAt = s.toISOString(); patch.endsAt = e.toISOString();
    }
    if (body?.geoScope !== undefined) {
      const geo = normaliseGeoScope(body.geoScope);
      if (geo.error) return fail(geo.error, 422, { field: 'geoScope' });
      patch.geoScope = geo.value;
    }
    await campaigns.updateByIdAsync(id, patch);
    const saved = await campaigns.findByIdAsync(id);
    await audit({ actor: actorId, action: 'campaign.updated', target: id, before: c, after: saved });
    return { campaign: saved };
  }

  async function setCampaignStatus({ id, to, reason, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const c = await campaigns.findByIdAsync(id);
    if (!c) return fail('campaign_not_found', 404);
    if (!(CAMPAIGN_TRANSITIONS[c.status] || []).includes(to)) return fail('invalid_transition', 409, { from: c.status, to });
    if (to === 'cancelled' && !text(reason, 1000)) return fail('reason_required', 400);
    const linked = (await promotions.allAsync()).filter(p => p.campaignId === id && !['cancelled', 'completed', 'rejected', 'expired'].includes(p.status));
    await campaigns.updateByIdAsync(id, { status: to, statusReason: text(reason, 1000), updatedAt: stamp() });
    await audit({ actor: actorId, action: `campaign.${to}`, target: id, before: { status: c.status }, after: { status: to, reason: text(reason, 1000), openPromotions: linked.length } });
    // Promotions are not changed behind the admin's back: they are listed so each can be dealt with.
    return { campaign: await campaigns.findByIdAsync(id), openPromotions: linked.map(p => p.id) };
  }

  async function listCampaigns({ status, limit, cursor } = {}) {
    let rows = await campaigns.allAsync();
    if (status) rows = rows.filter(c => c.status === status);
    rows.sort((a, b) => ms(b.startsAt) - ms(a.startsAt));
    const all = await promotions.allAsync();
    const pageOut = page(rows, { limit, cursor });
    return { ...pageOut, items: pageOut.items.map(c => ({ ...c, promotionCount: all.filter(p => p.campaignId === c.id).length })) };
  }

  async function getCampaign(id) {
    const c = await campaigns.findByIdAsync(id);
    if (!c) return fail('campaign_not_found', 404);
    const linked = await withPlacements((await promotions.allAsync()).filter(p => p.campaignId === id));
    const items = [];
    for (const p of linked) items.push(view(p, await summaryFor(p)));
    return { campaign: c, promotions: items };
  }


  // ── Lookups for the admin wizard ──────────────────────────────────────────

  /** Entities of a type matching a name, with whether each can be promoted right now. */
  async function searchEntities({ entityType, q, limit } = {}) {
    if (!ENTITY_TYPES[entityType]) return fail('invalid_entity_type', 400);
    const needle = text(q, 100)?.toLowerCase();
    const max = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);
    const out = [];
    for (const e of await entities.listAll(entityType)) {
      const summary = entities.summary(entityType, e);
      if (needle && !`${summary.name} ${summary.subtitle || ''}`.toLowerCase().includes(needle)) continue;
      const mod = await moderation.statusOf(entityType, e.id);
      const el = await entities.eligibility(entityType, e, mod);
      out.push({ entityType, ...summary, moderationStatus: mod, promotable: el.ok, reasons: el.reasons, placements: placementsFor(entityType) });
    }
    // Promotable first, then by name; the page is cut after sorting so the best matches are never lost.
    out.sort((a, b) => Number(b.promotable) - Number(a.promotable) || a.name.localeCompare(b.name));
    return { items: out.slice(0, max), total: out.length };
  }

  /** Partner organisations a commercial promotion can be attached to. */
  async function searchPartners({ q, limit } = {}) {
    if (!organizations) return { items: [], total: 0 };
    const needle = text(q, 100)?.toLowerCase();
    const max = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);
    const rows = (await organizations.allAsync())
      .filter(o => !needle || `${o.legalName || ''} ${o.tradingName || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => String(a.legalName).localeCompare(String(b.legalName)));
    return { items: rows.slice(0, max).map(o => ({ id: o.id, name: o.tradingName || o.legalName, legalName: o.legalName, type: o.organizationType, status: o.status })), total: rows.length };
  }

  // ── Geography ──────────────────────────────────────────────────────────────

  async function listAreas() {
    return { areas: (await geoAreas.allAsync()).sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async function createArea({ body, actorId }) {
    if (!actorId) return fail('actor_required', 403);
    const level = body?.level;
    if (!['region', 'city', 'district'].includes(level)) return fail('invalid_level', 422, { field: 'level' });
    const name = text(body?.name, 120);
    if (!name) return fail('name_required', 422, { field: 'name' });
    const parent = await geoAreas.findByIdAsync(body?.parentId);
    if (!parent || parent.level !== AREA_PARENT_LEVEL[level]) return fail('invalid_parent', 422, { field: 'parentId', expectedLevel: AREA_PARENT_LEVEL[level] });
    const coords = ['lat', 'lng', 'radiusKm'].map(k => (body?.[k] == null ? null : Number(body[k])));
    if (coords.some(c => c !== null && !Number.isFinite(c))) return fail('invalid_coordinates', 422);
    const id = text(body?.id, 80) || `${parent.id}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    if (await geoAreas.findByIdAsync(id)) return fail('area_exists', 409);
    const at = stamp();
    const row = { id, level, name, parentId: parent.id, lat: coords[0], lng: coords[1], radiusKm: coords[2], active: true, createdAt: at, updatedAt: at };
    await geoAreas.insertAsync(row);
    await audit({ actor: actorId, action: 'promotion.geo_area_created', target: id, after: row });
    return { area: row };
  }

  return {
    reference, list, get, create, update, submit, approve, reject, reopen, schedule, activate, pause, resume, cancel, complete,
    preview, runLifecycle, holdForEntity, listLive, overview, limits, setLimit,
    createCampaign, updateCampaign, setCampaignStatus, listCampaigns, getCampaign, listAreas, createArea,
    placementsFor, searchEntities, searchPartners,
  };
}
