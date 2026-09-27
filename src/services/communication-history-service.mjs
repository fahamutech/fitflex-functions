// Communication history (M8) — a read layer over the CommunicationMessage
// ledger, which already records every message: one row per member, per
// channel, per campaign (or automation run), with its status, timestamps,
// failure or skip reason and the provider's reference. Nothing here writes;
// there is no second history store.
//
// Views:
//   messages      — the flat, filterable log (also what M10 analytics reads)
//   message       — one message in full: template, rendered text, provider
//                   reference, every timestamp
//   memberTimeline— one member's communications, newest first, each with
//                   its channels side by side
//   recipients    — who a campaign reached, one row per member
//   campaignStats — targeted / sent / delivered / opened / clicked / failed
//   summary       — counts by channel, status and day for a filter window
//
// Scope, always enforced here: a gym owner or staff member sees only
// messages their own gyms sent (senderType 'gym', gymId in their gyms);
// FitFlex admins see FitFlex's own messages (senderType 'platform'). Another
// gym's message, campaign or member looks like one that doesn't exist.
import {
  CATEGORIES, CHANNELS, MESSAGE_STATUSES, PURPOSES,
} from '../shared/communications.mjs';
import { ownerGymIds } from '../shared/member-status.mjs';

export const REACHED = ['sent', 'delivered', 'read', 'clicked'];
export const PENDING = ['queued', 'sending'];
const DELIVERED = ['delivered', 'read', 'clicked'];
// Beyond the ledger's own statuses, filters understand these groups.
export const STATUS_GROUPS = { pending: PENDING, reached: REACHED };
const STATUS_FILTERS = [...MESSAGE_STATUSES, ...Object.keys(STATUS_GROUPS), 'opened'];
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;
const SEARCH_MAX = 60;

const iso = (d) => (d ? new Date(d).toISOString() : null);
const encode = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function decode(cursor) {
  if (cursor == null || cursor === '') return null;
  try {
    const o = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return o && typeof o === 'object' ? o : undefined;
  } catch {
    return undefined;
  }
}

/** Date filter: a date alone means the whole day (to = end of that day). */
function parseDate(value, { endOfDay = false } = {}) {
  if (value == null || value === '') return null;
  const s = String(value);
  const d = new Date(s);
  if (Number.isNaN(+d)) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(+d + 86_400_000 - 1);
  return d;
}

/**
 * Validates list filters. Values arrive from query strings, so lists may be
 * comma-separated. Returns { filters } or { error, status, detail }.
 */
export function parseFilters(q = {}) {
  const bad = (detail) => ({ error: 'invalid_filter', status: 400, detail });
  const list = (v) => (v == null || v === '' ? [] : (Array.isArray(v) ? v : String(v).split(',')).map(s => s.trim()).filter(Boolean));
  const f = {};
  for (const key of ['memberId', 'campaignId']) {
    if (q[key] != null && q[key] !== '') {
      if (typeof q[key] !== 'string' || q[key].length > 64) return bad(key);
      f[key] = q[key];
    }
  }
  const channel = list(q.channel);
  if (!channel.every(c => CHANNELS.includes(c))) return bad('channel');
  if (channel.length) f.channel = channel;
  const category = list(q.category);
  if (!category.every(c => CATEGORIES.includes(c))) return bad('category');
  if (category.length) f.category = category;
  const messageType = list(q.messageType ?? q.type);
  if (!messageType.every(t => PURPOSES.includes(t))) return bad('messageType');
  if (messageType.length) f.messageType = messageType;
  const status = list(q.status);
  if (!status.every(s => STATUS_FILTERS.includes(s))) return bad('status');
  if (status.length) f.status = status;
  const from = parseDate(q.from);
  const to = parseDate(q.to, { endOfDay: true });
  if (from === undefined) return bad('from');
  if (to === undefined) return bad('to');
  if (from) f.from = from;
  if (to) f.to = to;
  if (q.search != null && String(q.search).trim()) f.search = String(q.search).trim().slice(0, SEARCH_MAX);
  const limit = q.limit == null || q.limit === '' ? LIMIT_DEFAULT : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1) return bad('limit');
  f.limit = Math.min(limit, LIMIT_MAX);
  const cursor = decode(q.cursor);
  if (cursor === undefined) return bad('cursor');
  f.cursor = cursor;
  return { filters: f };
}

/** How one communication (all its channels) went, most useful first. */
export function outcomeOf(statuses) {
  if (statuses.some(s => REACHED.includes(s))) return 'reached';
  if (statuses.some(s => PENDING.includes(s))) return 'pending';
  if (statuses.some(s => s === 'failed')) return 'failed';
  return 'skipped';
}

function providerOf(r, { detail }) {
  const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
  if (r.channel === 'whatsapp') {
    return {
      name: 'whatsapp', messageId: r.providerMessageId || null,
      templateName: p?.templateName ?? null, language: p?.language ?? null,
      ...(detail && p?.parameters ? { parameters: p.parameters } : {}),
    };
  }
  if (r.channel === 'push') {
    return {
      name: 'fcm', messageId: r.providerMessageId || null,
      devices: p?.fcm?.messageIds?.length ?? null,
      ...(detail && p?.fcm ? { failedDevices: p.fcm.failed ?? 0, errors: p.fcm.errors || [] } : {}),
    };
  }
  return { name: 'inbox', messageId: r.notificationId || null };
}

function messageView(r, { detail = false } = {}) {
  return {
    id: r.id,
    campaignId: r.campaignId || null,
    automationRunId: r.automationRunId || null,
    campaignName: r.campaignName ?? null,
    senderType: r.senderType,
    gymId: r.gymId || null,
    memberId: r.memberId,
    memberName: r.memberName ?? null,
    channel: r.channel,
    category: r.category,
    messageType: r.messageType,
    title: r.title,
    body: r.body,
    locale: r.locale || null,
    deepLink: r.deepLink || null,
    status: r.status,
    skipReason: r.skipReason || null,
    failureReason: r.failureReason || null,
    failurePermanent: Boolean(r.failurePermanent),
    attempts: r.attempts ?? 0,
    provider: providerOf(r, { detail }),
    createdAt: iso(r.createdAt),
    sentAt: iso(r.sentAt),
    deliveredAt: iso(r.deliveredAt),
    openedAt: iso(r.openedAt),
    clickedAt: iso(r.clickedAt),
    failedAt: iso(r.failedAt),
    nextAttemptAt: iso(r.nextAttemptAt),
  };
}

export function createCommunicationHistoryService({ db }) {
  // ── scope ──────────────────────────────────────────────────────────────

  /** Which ledger rows this sender may see; `gymId` narrows to one of theirs. */
  function scopeFor(sender, { gymId = null } = {}) {
    if (sender?.senderType === 'platform') {
      return { senderType: 'platform', apply: (q, t = 'm') => q.where(`${t}.senderType`, 'platform') };
    }
    if (sender?.senderType !== 'gym') return { error: 'forbidden', status: 403 };
    const mine = ownerGymIds(sender.owner);
    if (gymId != null && !mine.includes(gymId)) return { error: 'not_your_gym', status: 403 };
    const gymIds = gymId != null ? [gymId] : mine;
    return {
      senderType: 'gym', gymIds,
      apply: (q, t = 'm') => q.where(`${t}.senderType`, 'gym').whereIn(`${t}.gymId`, gymIds),
    };
  }

  function applyFilters(q, f, { skip = [] } = {}) {
    if (f.memberId && !skip.includes('memberId')) q.where('m.memberId', f.memberId);
    if (f.campaignId && !skip.includes('campaignId')) q.where('m.campaignId', f.campaignId);
    if (f.channel) q.whereIn('m.channel', f.channel);
    if (f.category) q.whereIn('m.category', f.category);
    if (f.messageType) q.whereIn('m.messageType', f.messageType);
    if (f.status) {
      const statuses = new Set();
      let opened = false;
      for (const s of f.status) {
        if (s === 'opened') opened = true;
        else for (const x of STATUS_GROUPS[s] || [s]) statuses.add(x);
      }
      q.where(b => {
        if (statuses.size) b.whereIn('m.status', [...statuses]);
        if (opened) b.orWhereNotNull('m.openedAt');
      });
    }
    if (f.from) q.where('m.createdAt', '>=', f.from);
    if (f.to) q.where('m.createdAt', '<=', f.to);
    if (f.search && !skip.includes('search')) q.whereILike('u.displayName', `%${f.search.replace(/[\\%_]/g, c => `\\${c}`)}%`);
    return q;
  }

  // Timestamps compared at millisecond precision, like the cursors carry them.
  const at = db.raw(`date_trunc('milliseconds', m."createdAt")`);
  const base = () => db('CommunicationMessage as m')
    .leftJoin('User as u', 'u.id', 'm.memberId')
    .leftJoin('CommunicationCampaign as c', 'c.id', 'm.campaignId');
  const columns = ['m.*', 'u.displayName as memberName', 'c.name as campaignName'];

  // ── the flat log ───────────────────────────────────────────────────────

  /** Messages, newest first, filtered and paged with an opaque cursor. */
  async function messages(sender, query = {}) {
    const scope = scopeFor(sender, { gymId: query.gymId ?? null });
    if (scope.error) return scope;
    const p = parseFilters(query);
    if (p.error) return p;
    const f = p.filters;
    const q = applyFilters(scope.apply(base()), f);
    if (f.cursor) {
      q.whereRaw(`(date_trunc('milliseconds', m."createdAt"), m.id) < (?::timestamptz, ?)`, [f.cursor.a, f.cursor.i]);
    }
    const rows = await q.orderBy([{ column: at, order: 'desc' }, { column: 'm.id', order: 'desc' }])
      .limit(f.limit + 1).select(columns);
    const page = rows.slice(0, f.limit);
    const last = page.at(-1);
    return {
      messages: page.map(r => messageView(r)),
      nextCursor: rows.length > f.limit ? encode({ a: iso(last.createdAt), i: last.id }) : null,
    };
  }

  /** One message in full, with its campaign and template. */
  async function message(sender, messageId) {
    const scope = scopeFor(sender);
    if (scope.error) return scope;
    const row = await scope.apply(base()).where('m.id', messageId).first(columns);
    if (!row) return { error: 'not_found', status: 404 };
    const campaign = row.campaignId
      ? await db('CommunicationCampaign as c').leftJoin('CommunicationTemplate as t', 't.id', 'c.templateId')
        .where('c.id', row.campaignId)
        .first('c.id', 'c.name', 'c.purpose', 'c.status', 'c.templateId', 't.key as templateKey', 't.name as templateName', 't.gymId as templateGymId')
      : null;
    return {
      message: {
        ...messageView(row, { detail: true }),
        notificationId: row.notificationId || null,
        campaign: campaign ? { id: campaign.id, name: campaign.name, purpose: campaign.purpose, status: campaign.status } : null,
        template: campaign?.templateId
          ? { id: campaign.templateId, key: campaign.templateKey ?? null, name: campaign.templateName ?? null, system: campaign.templateGymId == null }
          : null,
      },
    };
  }

  // ── one member ─────────────────────────────────────────────────────────

  /**
   * Whether a gym has anything to do with this member: a membership at one
   * of its gyms, a visit, or a message it sent them.
   */
  async function gymKnowsMember(gymIds, memberId) {
    if (!gymIds.length) return false;
    const [sub, visit, msg] = await Promise.all([
      db('Subscription').where({ memberId }).whereIn('homeGymId', gymIds).first('id'),
      db('Checkin').where({ memberId }).whereIn('gymId', gymIds).first('id'),
      db('CommunicationMessage').where({ memberId, senderType: 'gym' }).whereIn('gymId', gymIds).first('id'),
    ]);
    return Boolean(sub || visit || msg);
  }

  const groupKey = db.raw('coalesce(m."campaignId", m."automationRunId", m.id)');

  function groupItems(keys, rows) {
    const byKey = new Map(keys.map(k => [k, []]));
    for (const r of rows) byKey.get(r.k)?.push(r);
    return keys.map(k => {
      const rs = byKey.get(k).sort((a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel));
      const main = rs.find(r => r.channel === 'in_app') || rs[0];
      return {
        key: k,
        campaignId: main.campaignId || null,
        automationRunId: main.automationRunId || null,
        campaignName: main.campaignName ?? null,
        memberId: main.memberId,
        memberName: main.memberName ?? null,
        category: main.category,
        messageType: main.messageType,
        title: main.title,
        body: main.body,
        locale: main.locale || null,
        createdAt: iso(rs.reduce((at, r) => (+new Date(r.createdAt) > +at ? new Date(r.createdAt) : at), new Date(0))),
        outcome: outcomeOf(rs.map(r => r.status)),
        channels: rs.map(r => messageView(r)),
      };
    });
  }

  /** A member's communications from this sender, newest first. */
  async function memberTimeline(sender, memberId, query = {}) {
    const scope = scopeFor(sender, { gymId: query.gymId ?? null });
    if (scope.error) return scope;
    const p = parseFilters({ ...query, memberId });
    if (p.error) return p;
    const f = p.filters;
    if (scope.senderType === 'gym' && !(await gymKnowsMember(scope.gymIds, memberId))) {
      return { error: 'not_your_member', status: 403 };
    }
    const groups = applyFilters(scope.apply(base()), f, { skip: ['search'] })
      .groupBy(groupKey).select({ k: groupKey, at: db.raw(`max(date_trunc('milliseconds', m."createdAt"))`) });
    const q = db.from(groups.as('g'));
    if (f.cursor) q.whereRaw('(g.at, g.k) < (?::timestamptz, ?)', [f.cursor.a, f.cursor.k]);
    const keys = await q.orderBy([{ column: 'g.at', order: 'desc' }, { column: 'g.k', order: 'desc' }])
      .limit(f.limit + 1).select('g.k', 'g.at');
    const page = keys.slice(0, f.limit);
    const rows = page.length
      ? await applyFilters(scope.apply(base()), f, { skip: ['search'] })
        .whereIn(groupKey, page.map(k => k.k)).select([...columns, { k: groupKey }])
      : [];
    const last = page.at(-1);
    return {
      memberId,
      items: groupItems(page.map(k => k.k), rows),
      nextCursor: keys.length > f.limit ? encode({ a: iso(last.at), k: last.k }) : null,
    };
  }

  // ── one campaign ───────────────────────────────────────────────────────

  async function campaignInScope(scope, campaignId) {
    const q = db('CommunicationCampaign as c').where('c.id', campaignId);
    return scope.apply(q, 'c').first('c.id');
  }

  /** Who a campaign went to: one row per member, every channel side by side. */
  async function recipients(sender, campaignId, query = {}) {
    const scope = scopeFor(sender);
    if (scope.error) return scope;
    if (!(await campaignInScope(scope, campaignId))) return { error: 'not_found', status: 404 };
    const p = parseFilters({ ...query, campaignId });
    if (p.error) return p;
    const f = p.filters;
    const name = db.raw(`coalesce(u."displayName", '')`);
    const members = applyFilters(scope.apply(base()), f)
      .groupBy('m.memberId', 'u.displayName').select({ id: 'm.memberId', n: name });
    const q = db.from(members.as('r'));
    if (f.cursor) q.whereRaw('(r.n, r.id) > (?, ?)', [String(f.cursor.n ?? ''), String(f.cursor.i ?? '')]);
    const ids = await q.orderBy([{ column: 'r.n' }, { column: 'r.id' }]).limit(f.limit + 1).select('r.id', 'r.n');
    const page = ids.slice(0, f.limit);
    const rows = page.length
      ? await applyFilters(scope.apply(base()), f, { skip: ['search'] })
        .whereIn('m.memberId', page.map(r => r.id)).select(columns)
      : [];
    const last = page.at(-1);
    return {
      recipients: page.map(({ id }) => {
        const rs = rows.filter(r => r.memberId === id).sort((a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel));
        return {
          memberId: id, memberName: rs[0]?.memberName ?? null,
          outcome: outcomeOf(rs.map(r => r.status)),
          channels: rs.map(r => messageView(r)),
        };
      }),
      nextCursor: ids.length > f.limit ? encode({ n: last.n, i: last.id }) : null,
    };
  }

  /**
   * Delivery numbers per campaign, straight from the ledger:
   * Map(campaignId → { targeted, messages, byChannel, totals }).
   * `delivered` counts what the provider or inbox confirmed; `sent` is
   * everything handed over (push is only "sent" — FCM doesn't confirm).
   */
  async function campaignStats(campaignIds) {
    const out = new Map();
    if (!campaignIds.length) return out;
    const [rows, members] = await Promise.all([
      db('CommunicationMessage').whereIn('campaignId', campaignIds)
        .groupBy('campaignId', 'channel', 'status')
        .select('campaignId', 'channel', 'status')
        .count({ n: '*' }).count({ opened: 'openedAt' }).count({ clicked: 'clickedAt' }),
      db('CommunicationMessage').whereIn('campaignId', campaignIds)
        .groupBy('campaignId').select('campaignId').countDistinct({ n: 'memberId' }),
    ]);
    for (const id of campaignIds) out.set(id, emptyStats());
    for (const m of members) out.get(m.campaignId).targeted = Number(m.n);
    for (const r of rows) add(out.get(r.campaignId), r);
    return out;
  }

  function emptyStats() {
    return { targeted: 0, messages: 0, byChannel: {}, totals: { pending: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, failed: 0, skipped: 0 } };
  }

  function add(stats, r) {
    const n = Number(r.n);
    const ch = stats.byChannel[r.channel] ||= Object.fromEntries([...MESSAGE_STATUSES, 'opened'].map(s => [s, 0]));
    ch[r.status] = (ch[r.status] || 0) + n;
    ch.opened += Number(r.opened || 0);
    stats.messages += n;
    const t = stats.totals;
    if (PENDING.includes(r.status)) t.pending += n;
    if (REACHED.includes(r.status)) t.sent += n;
    if (DELIVERED.includes(r.status)) t.delivered += n;
    if (r.status === 'failed') t.failed += n;
    if (r.status === 'skipped') t.skipped += n;
    t.opened += Number(r.opened || 0);
    t.clicked += Number(r.clicked || 0);
  }

  /**
   * Counts for a filter window — by channel and status, and per day — the
   * raw numbers M10 analytics builds on.
   */
  async function summary(sender, query = {}) {
    const scope = scopeFor(sender, { gymId: query.gymId ?? null });
    if (scope.error) return scope;
    const p = parseFilters(query);
    if (p.error) return p;
    const f = p.filters;
    const scoped = () => applyFilters(scope.apply(base()), f);
    const [rows, days] = await Promise.all([
      scoped().groupBy('m.channel', 'm.status').select({ channel: 'm.channel', status: 'm.status' })
        .count({ n: '*' }).count({ opened: 'm.openedAt' }).count({ clicked: 'm.clickedAt' }),
      scoped().groupBy(db.raw(`date_trunc('day', m."createdAt")`))
        .select({ day: db.raw(`date_trunc('day', m."createdAt")`) })
        .count({ n: '*' }).orderBy('day'),
    ]);
    const stats = emptyStats();
    for (const r of rows) add(stats, r);
    delete stats.targeted;
    return { ...stats, byDay: days.map(d => ({ day: iso(d.day).slice(0, 10), messages: Number(d.n) })) };
  }

  return { scopeFor, messages, message, memberTimeline, recipients, campaignStats, summary };
}
