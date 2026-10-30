// Marathon & running events · S6 — medal templates (organizer) and the medal / achievement views (member) (spec §7.1, §7.3, §8.1, §8.3).
// A template is rule + names + tier + a built-in design; its rule and category are LOCKED once the scope has an official release (409
// template_locked); names, description, tier, design and status stay editable. Medals go to people only by the award engine, at official
// release, from verified results; there is no medal for a purchase alone (RWD-004).
import { randomUUID } from 'node:crypto';
import { validateMedalRule, medalQualifies, bilingual, defaultArtKey, BUILT_IN_ART, MEDAL_TIERS, categoryStage, SETTLED_VERIFICATIONS } from '../shared/events-results-rules.mjs';
import { createIdempotency } from '../shared/organizer-idempotency.mjs';
import { enqueueAwardTask } from '../shared/events-award-queue.mjs';

const fail = (error, status, extra = {}) => ({ error, status, ...extra });
const plain = row => (row ? JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v))) : null);
const iso = v => (v ? new Date(v).toISOString() : null);
const num = v => (v === null || v === undefined ? null : Number(v));
const STAFF_READ = ['owner', 'admin', 'timing'];
const STAFF_WRITE = ['owner', 'admin'];
const ruleSummary = r => (r.type === 'finish' ? { en: 'Finish the race', sw: 'Maliza mbio' }
  : r.type === 'placing' ? { en: `Finish in the top ${r.top} (${r.scope})`, sw: `Maliza ndani ya ${r.top} bora (${r.scope === 'overall' ? 'jumla' : 'kundi'})` }
    : { en: 'Finish under the set time', sw: 'Maliza chini ya muda uliowekwa' });

export function createEventsMedalService({ db, results, now = () => new Date(), medalArtOn = () => false, artConfirmation = () => null }) {
  const stamp = () => new Date(now());
  const idempotent = createIdempotency({ db, now });
  const { load, audit, lockEvent } = results.internals;

  /** Art block of a template: custom only while EVENTS_MEDAL_ART is on and the live art row exists; otherwise the built-in design. */
  const artOf = (t, art) => {
    const custom = medalArtOn() && t.artId && art && art.status === 'live';
    return custom
      ? { source: 'custom', artId: art.id, revision: art.revision, artKey: t.artKey, altText: art.altText && Object.keys(art.altText).length ? art.altText : null }
      : { source: 'builtin', artId: null, revision: null, artKey: t.artKey, altText: null };
  };

  async function scopeLocked(q, event, categories, categoryId) {
    const rows = (await q('EventResultRelease').where({ eventId: event.id, stage: 'official', action: 'release' })).map(plain);
    if (!rows.length) return false;
    if (rows.some(r => !r.categoryId)) return true;
    return categoryId ? rows.some(r => r.categoryId === categoryId) : true;
  }

  async function view(t, event, categories, { counts, arts, q = db }) {
    return {
      id: t.id, eventId: t.eventId, categoryId: t.categoryId, name: t.name, description: t.description ?? {}, tier: t.tier, rule: t.rule, ruleSummary: ruleSummary(t.rule),
      sortOrder: t.sortOrder, status: t.status, art: artOf(t, arts.get(t.artId)), awardedCount: counts.get(t.id) ?? 0, locked: await scopeLocked(q, event, categories, t.categoryId),
    };
  }

  async function ctxFor({ actor, organizerId, eventId, level }) {
    if (!actor || (level === 'read' ? !STAFF_READ.includes(actor.role) : !STAFF_WRITE.includes(actor.role))) return fail('forbidden_role', 403);
    const ctx = await load({ organizerId, eventId });
    return ctx ?? fail('event_not_found', 404);
  }

  async function list({ actor, organizerId, eventId }) {
    const ctx = await ctxFor({ actor, organizerId, eventId, level: 'read' });
    if (ctx.error) return ctx;
    const templates = (await db('EventMedalTemplate').where({ eventId: ctx.event.id }).orderBy('sortOrder').orderBy('createdAt')).map(plain);
    const counts = new Map((await db('EventMedalAward').where({ eventId: ctx.event.id, awardStatus: 'awarded' }).groupBy('medalTemplateId').select('medalTemplateId').count({ n: '*' })).map(r => [r.medalTemplateId, Number(r.n)]));
    const arts = new Map((await db('EventMedalArt').whereIn('id', templates.map(t => t.artId).filter(Boolean))).map(a => [a.id, plain(a)]));
    return {
      items: await Promise.all(templates.map(t => view(t, ctx.event, ctx.categories, { counts, arts }))),
      builtInArt: [...BUILT_IN_ART], ...(medalArtOn() ? { artConfirmation: artConfirmation() } : {}),
    };
  }

  function parse(body, ctx, { partial }) {
    const fields = []; const out = {};
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const known = ['name', 'description', 'tier', 'rule', 'categoryId', 'sortOrder', 'status', 'artKey'];
    for (const k of Object.keys(b)) if (!known.includes(k)) fields.push({ path: k, code: 'unknown' }); // includes imageUrl: a client never supplies an image address
    if (!partial || 'name' in b) { const v = bilingual(b.name, { max: 60 }); if (v.error) fields.push({ path: 'name', code: v.error }); else out.name = v.value; }
    if ('description' in b) { const v = bilingual(b.description, { max: 140, requireEn: false }); if (v.error) fields.push({ path: 'description', code: v.error }); else out.description = v.value; }
    if (!partial || 'tier' in b) { const t = b.tier ?? 'finisher'; if (!MEDAL_TIERS.includes(t)) fields.push({ path: 'tier', code: 'invalid' }); else out.tier = t; }
    if (!partial || 'rule' in b) { const v = validateMedalRule(b.rule ?? { type: 'finish' }); if (v.fields) fields.push(...v.fields); else out.rule = v.rule; }
    if ('categoryId' in b) {
      if (b.categoryId !== null && !ctx.categories.some(c => c.id === b.categoryId)) fields.push({ path: 'categoryId', code: 'unknown_category' }); else out.categoryId = b.categoryId;
    }
    if ('sortOrder' in b) { if (!Number.isInteger(b.sortOrder) || b.sortOrder < 0 || b.sortOrder > 99) fields.push({ path: 'sortOrder', code: 'out_of_range' }); else out.sortOrder = b.sortOrder; }
    if ('status' in b) { if (!['active', 'inactive'].includes(b.status)) fields.push({ path: 'status', code: 'invalid' }); else out.status = b.status; }
    if ('artKey' in b) { if (!BUILT_IN_ART.includes(b.artKey)) fields.push({ path: 'artKey', code: 'invalid' }); else out.artKey = b.artKey; }
    return fields.length ? { fields } : { values: out };
  }

  async function create({ actor, organizerId, eventId, key, body = {} }) {
    const ctx = await ctxFor({ actor, organizerId, eventId, level: 'write' });
    if (ctx.error) return ctx;
    if (ctx.event.status === 'cancelled') return fail('event_cancelled', 409);
    const p = parse(body, ctx, { partial: false });
    if (p.fields) return fail('validation_failed', 422, { fields: p.fields });
    return idempotent({ actor, route: `medals.create:${ctx.event.id}`, key, body }, async () => db.transaction(async (trx) => {
      const id = `emt_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const v = p.values;
      const [row] = await trx('EventMedalTemplate').insert({
        id, eventId: ctx.event.id, categoryId: v.categoryId ?? null, name: JSON.stringify(v.name), description: JSON.stringify(v.description ?? {}), tier: v.tier, rule: JSON.stringify(v.rule),
        sortOrder: v.sortOrder ?? 0, status: v.status ?? 'active', artKey: v.artKey ?? defaultArtKey(v.tier, ctx.event.eventType), imageUrl: null, createdAt: stamp(), updatedAt: stamp(),
      }).returning('*');
      const released = await scopeLocked(trx, ctx.event, ctx.categories, row.categoryId);
      if (released) await enqueueAwardTask(trx, { eventId: ctx.event.id, reason: 'template_added', at: stamp() });
      await audit(actor, 'events.medal_template_created', ctx.event.id, null, { templateId: id, tier: v.tier, rule: v.rule, retroactive: released }, trx);
      return { template: await view(plain(row), ctx.event, ctx.categories, { counts: new Map(), arts: new Map(), q: trx }), status: 201 };
    }));
  }

  async function patch({ actor, organizerId, eventId, templateId, key, body = {} }) {
    const ctx = await ctxFor({ actor, organizerId, eventId, level: 'write' });
    if (ctx.error) return ctx;
    const p = parse(body, ctx, { partial: true });
    if (p.fields) return fail('validation_failed', 422, { fields: p.fields });
    if (!Object.keys(p.values).length) return fail('validation_failed', 422, { fields: [{ path: 'body', code: 'empty' }] });
    return idempotent({ actor, route: `medals.patch:${templateId}`, key, body }, async () => db.transaction(async (trx) => {
      await lockEvent(trx, ctx.event.id);
      const cur = plain(await trx('EventMedalTemplate').where({ id: String(templateId), eventId: ctx.event.id }).forUpdate().first());
      if (!cur) return fail('template_not_found', 404);
      const v = p.values;
      if (('rule' in v || 'categoryId' in v) && (await scopeLocked(trx, ctx.event, ctx.categories, cur.categoryId))) return fail('template_locked', 409);
      const set = { ...v, updatedAt: stamp() };
      for (const k of ['name', 'description', 'rule']) if (k in set) set[k] = JSON.stringify(set[k]);
      const [row] = await trx('EventMedalTemplate').where({ id: cur.id }).update(set).returning('*');
      await audit(actor, 'events.medal_template_updated', ctx.event.id, { tier: cur.tier, status: cur.status }, { templateId: cur.id, fields: Object.keys(v) }, trx);
      const art = row.artId ? plain(await trx('EventMedalArt').where({ id: row.artId }).first()) : null;
      return { template: await view(plain(row), ctx.event, ctx.categories, { counts: new Map(), arts: new Map(art ? [[art.id, art]] : []), q: trx }), status: 200 };
    }));
  }

  /** "About N people would get this": the template's rule against the current official results of its scope. */
  async function preview({ actor, organizerId, eventId, templateId }) {
    const ctx = await ctxFor({ actor, organizerId, eventId, level: 'read' });
    if (ctx.error) return ctx;
    const t = plain(await db('EventMedalTemplate').where({ id: String(templateId), eventId: ctx.event.id }).first());
    if (!t) return fail('template_not_found', 404);
    const releases = (await db('EventResultRelease').where({ eventId: ctx.event.id }).orderBy('seq')).map(plain);
    const rows = (await db('EventRegistration as r').join('EventResult as e', function join() { this.on('e.registrationId', 'r.id').andOn('e.isCurrent', db.raw('true')); })
      .where('r.eventId', ctx.event.id).where('r.status', 'confirmed').modify((q) => { if (t.categoryId) q.where('r.categoryId', t.categoryId); })
      .select('r.categoryId', 'e.verificationStatus', 'e.finishStatus', 'e.withinCutoff', 'e.elapsedMs', 'e.categoryRank', 'e.overallRank')).map(plain);
    const n = rows.filter(r => medalQualifies(t.rule, {
      base: ctx.event.status !== 'cancelled' && categoryStage(releases, r.categoryId) === 'official' && SETTLED_VERIFICATIONS.includes(r.verificationStatus) && r.finishStatus === 'finished' && r.withinCutoff !== false,
      categoryRank: r.categoryRank, overallRank: r.overallRank, elapsedMs: num(r.elapsedMs),
    })).length;
    return { wouldReceive: n, released: await scopeLocked(db, ctx.event, ctx.categories, t.categoryId) };
  }

  // ── Member views ──────────────────────────────────────────────────────────

  /** MedalAward objects for award rows (joined with template, event, category, art, result). */
  async function awardViews(awardRows) {
    if (!awardRows.length) return [];
    const templates = new Map((await db('EventMedalTemplate').whereIn('id', [...new Set(awardRows.map(a => a.medalTemplateId))])).map(t => [t.id, plain(t)]));
    const evRows = (await db('Event as e').join('EventOrganizer as o', 'o.id', 'e.organizerId').whereIn('e.id', [...new Set(awardRows.map(a => a.eventId))]).select('e.id', 'e.title', 'o.name as organizerName')).map(plain);
    const events = new Map(evRows.map(e => [e.id, e.title]));
    const organizers = new Map(evRows.map(e => [e.id, e.organizerName]));
    const cats = new Map((await db('EventCategory').whereIn('id', [...new Set([...templates.values()].map(t => t.categoryId).filter(Boolean))]).select('id', 'name')).map(c => [c.id, c.name]));
    const regCats = new Map((await db('EventRegistration').whereIn('id', awardRows.map(a => a.registrationId)).select('id', 'categoryId')).map(r => [r.id, r.categoryId]));
    const regCatNames = new Map((await db('EventCategory').whereIn('id', [...new Set(regCats.values())]).select('id', 'name')).map(c => [c.id, c.name]));
    const arts = new Map((await db('EventMedalArt').whereIn('id', [...templates.values()].map(t => t.artId).filter(Boolean))).map(a => [a.id, plain(a)]));
    const results$ = new Map((await db('EventResult').whereIn('id', awardRows.map(a => a.sourceResultId).filter(Boolean)).select('id', 'categoryRank', 'overallRank', 'elapsedMs')).map(r => [r.id, plain(r)]));
    return awardRows.map((a) => {
      const t = templates.get(a.medalTemplateId);
      const r = results$.get(a.sourceResultId);
      return {
        id: a.id, eventId: a.eventId, eventTitle: events.get(a.eventId) ?? null, organizerName: organizers.get(a.eventId) ?? null, categoryName: cats.get(t.categoryId) ?? regCatNames.get(regCats.get(a.registrationId)) ?? null, templateId: t.id, tier: t.tier,
        name: t.name, description: t.description ?? {}, art: artOf(t, arts.get(t.artId)), status: a.awardStatus, awardedAt: iso(a.awardedAt), revokedAt: iso(a.revokedAt), reasonCode: a.reasonCode ?? null,
        resultSummary: { rank: r ? (t.rule?.scope === 'overall' ? r.overallRank : r.categoryRank) : null, elapsedMs: r ? num(r.elapsedMs) : null },
      };
    });
  }

  const forRegistration = async registrationId => awardViews((await db('EventMedalAward').where({ registrationId }).orderBy('awardedAt', 'desc')).map(plain));

  async function achievements({ userId }) {
    const regs = (await db('EventRegistration').where({ participantUserId: userId }).select('id')).map(r => r.id);
    const awards = regs.length ? (await db('EventMedalAward').whereIn('registrationId', regs).orderBy('awardedAt', 'desc')).map(plain) : [];
    const medals = await awardViews(awards);
    const defs = (await db('AchievementDefinition').where({ status: 'active' }).orderBy('key')).map(plain);
    const mine = new Map((await db('UserAchievement').where({ userId })).map(a => [a.achievementDefinitionId, plain(a)]));
    const stats = await finishStats(db, userId);
    const items = defs.map((d) => {
      const m = mine.get(d.id);
      const progress = progressOf(d.criteria, stats);
      return { id: m?.id ?? null, key: d.key, title: d.title, status: m?.status === 'awarded' ? 'awarded' : 'locked', awardedAt: m?.status === 'awarded' ? iso(m.awardedAt) : null, progress };
    });
    const removed = [
      ...medals.filter(x => x.status === 'revoked').map(x => ({ kind: 'medal', id: x.id, title: x.name, reasonCode: x.reasonCode, revokedAt: x.revokedAt })),
      ...[...mine.values()].filter(a => a.status === 'revoked').map(a => ({ kind: 'achievement', id: a.id, title: defs.find(d => d.id === a.achievementDefinitionId)?.title ?? null, reasonCode: a.reasonCode, revokedAt: iso(a.revokedAt) })),
    ];
    return { medals: medals.filter(x => x.status === 'awarded'), achievements: items, removed };
  }

  /** The user's official, settled, finished results with the event's start and the category distance. */
  async function finishStats(q, userId) {
    return (await q('EventRegistration as r').join('EventResult as e', function join() { this.on('e.registrationId', 'r.id').andOn('e.isCurrent', q.raw('true')); })
      .join('EventCategory as c', 'c.id', 'r.categoryId').join('Event as ev', 'ev.id', 'r.eventId')
      .where('r.participantUserId', userId).where('r.status', 'confirmed').whereNot('ev.status', 'cancelled')
      .whereIn('e.verificationStatus', SETTLED_VERIFICATIONS).where('e.finishStatus', 'finished').where(function inTime() { this.whereNull('e.withinCutoff').orWhere('e.withinCutoff', true); })
      .whereExists(function official() { this.select(q.raw('1')).from('EventResultRelease as x').whereRaw('x."eventId" = r."eventId"').where('x.stage', 'official').where('x.action', 'release').where(function scope() { this.whereRaw('x."categoryId" = r."categoryId"').orWhereNull('x.categoryId'); }); })
      .select('c.distanceMeters', 'ev.startsAt')).map(plain);
  }
  function countFor(criteria, stats, at) {
    const rows = criteria.windowDays ? stats.filter(s => +new Date(s.startsAt) >= +at - criteria.windowDays * 86_400_000) : stats;
    if (criteria.type === 'distance_finish') return rows.filter(s => Number(s.distanceMeters) >= criteria.minMeters).length;
    return rows.length;
  }
  const progressOf = (criteria, stats) => ({ current: Math.min(countFor(criteria, stats, stamp()), criteria.count), target: criteria.count });

  results.hooks.medalsForRegistration = forRegistration;
  return { list, create, patch, preview, awardViews, forRegistration, achievements, finishStats, countFor, artOf, scopeLocked };
}
